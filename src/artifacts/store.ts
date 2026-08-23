import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, withFileLock } from "../state/atomic.js";
import type { Telemetry } from "../telemetry.js";
import { redactSecrets } from "./redaction.js";

const METADATA_FILE = "observations.jsonl";
const ACTIVE_SESSIONS_FILE = "active-sessions.json";
const LOCK_FILE = "artifacts.lock";

export interface ArtifactStoreOptions {
  artifactsRoot: string;
  metadataRoot: string;
  now?: () => Date;
  telemetry?: Telemetry;
  /** Test seam for determining whether a local lease-owning process demonstrably exists. */
  isProcessAlive?: (pid: number) => boolean;
}

export interface ArchiveObservationInput {
  observationId: string;
  toolCallId?: string;
  toolName: string;
  sessionId: string;
  content: string;
}

export interface ArtifactMetadata {
  schemaVersion: 1;
  artifactId: string;
  observationId: string;
  /** Present for records produced by the Pi runtime; optional for v0.1 records written before S04. */
  toolCallId?: string;
  toolName: string;
  sessionId: string;
  contentHash: string;
  originalBytes: number;
  sanitizedBytes: number;
  redactionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArchivedArtifact {
  artifactId: string;
  metadata: ArtifactMetadata;
  deduplicated: boolean;
}

export interface ActiveSessionLease {
  sessionId: string;
  ownerId: string;
}

interface ActiveSessionLeaseRecord extends ActiveSessionLease {
  pid: number;
  registeredAt: string;
}

interface ActiveSessionRegistry {
  schemaVersion: 1;
  leases: ActiveSessionLeaseRecord[];
}

export interface GarbageCollectOptions {
  retentionDays: number;
  quotaBytes: number;
  referencedArtifactIds?: ReadonlySet<string>;
}

export interface GarbageCollectResult {
  deletedArtifactIds: string[];
  bytesFreed: number;
  remainingBytes: number;
  quotaSatisfied: boolean;
}

function assertArtifactId(artifactId: string): void {
  if (!/^[a-f0-9]{64}$/.test(artifactId)) throw new Error(`Invalid artifact ID: ${artifactId}`);
}

function encodeMetadata(entries: readonly ArtifactMetadata[]): string {
  return entries.length === 0 ? "" : `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function parseActiveSessions(source: string): ActiveSessionRegistry {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Invalid active session registry: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (value === null || typeof value !== "object") throw new Error("Invalid active session registry");
  const registry = value as Partial<ActiveSessionRegistry>;
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.leases)) {
    throw new Error("Invalid active session registry");
  }
  const owners = new Set<string>();
  for (const lease of registry.leases) {
    if (
      lease === null ||
      typeof lease !== "object" ||
      typeof lease.sessionId !== "string" ||
      lease.sessionId.length === 0 ||
      typeof lease.ownerId !== "string" ||
      lease.ownerId.length === 0 ||
      !Number.isSafeInteger(lease.pid) ||
      lease.pid <= 0 ||
      typeof lease.registeredAt !== "string" ||
      !Number.isFinite(Date.parse(lease.registeredAt)) ||
      owners.has(lease.ownerId)
    ) {
      throw new Error("Invalid active session registry");
    }
    owners.add(lease.ownerId);
  }
  return registry as ActiveSessionRegistry;
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH is the only result that demonstrates the local process is gone.
    // Permission and other failures retain the lease and therefore fail safe.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function parseMetadata(source: string): ArtifactMetadata[] {
  const entries: ArtifactMetadata[] = [];
  for (const [index, line] of source.split("\n").entries()) {
    if (line.trim() === "") continue;
    try {
      const entry = JSON.parse(line) as ArtifactMetadata;
      if (
        entry.schemaVersion !== 1 ||
        typeof entry.artifactId !== "string" ||
        typeof entry.observationId !== "string" ||
        (entry.toolCallId !== undefined && typeof entry.toolCallId !== "string") ||
        typeof entry.toolName !== "string" ||
        typeof entry.sessionId !== "string" ||
        entry.contentHash !== entry.artifactId ||
        !Number.isSafeInteger(entry.originalBytes) ||
        !Number.isSafeInteger(entry.sanitizedBytes) ||
        !Number.isSafeInteger(entry.redactionCount) ||
        !Number.isFinite(Date.parse(entry.createdAt)) ||
        !Number.isFinite(Date.parse(entry.updatedAt))
      ) {
        throw new Error("unsupported metadata record");
      }
      assertArtifactId(entry.artifactId);
      entries.push(entry);
    } catch (error) {
      throw new Error(
        `Invalid artifact metadata at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return entries;
}

export class ArtifactStore {
  readonly #artifactsRoot: string;
  readonly #metadataPath: string;
  readonly #activeSessionsPath: string;
  readonly #lockPath: string;
  readonly #now: () => Date;
  readonly #telemetry?: Telemetry;
  readonly #isProcessAlive: (pid: number) => boolean;

  constructor(options: ArtifactStoreOptions) {
    this.#artifactsRoot = options.artifactsRoot;
    this.#metadataPath = join(options.metadataRoot, METADATA_FILE);
    this.#activeSessionsPath = join(options.metadataRoot, ACTIVE_SESSIONS_FILE);
    this.#lockPath = join(options.metadataRoot, LOCK_FILE);
    this.#now = options.now ?? (() => new Date());
    this.#telemetry = options.telemetry;
    this.#isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
  }

  artifactPath(artifactId: string): string {
    assertArtifactId(artifactId);
    return join(this.#artifactsRoot, artifactId.slice(0, 2), `${artifactId}.txt`);
  }

  async registerActiveSession(sessionId: string): Promise<ActiveSessionLease> {
    if (sessionId.length === 0) throw new Error("sessionId must not be empty");
    const lease: ActiveSessionLeaseRecord = {
      sessionId,
      ownerId: randomUUID(),
      pid: process.pid,
      registeredAt: this.#now().toISOString(),
    };
    await withFileLock(this.#lockPath, async () => {
      const registry = await this.#readActiveSessionsUnlocked();
      const liveLeases = registry.leases.filter((candidate) => this.#isProcessAlive(candidate.pid));
      liveLeases.push(lease);
      await atomicWriteFile(
        this.#activeSessionsPath,
        JSON.stringify({ schemaVersion: 1, leases: liveLeases } satisfies ActiveSessionRegistry),
      );
    });
    return { sessionId: lease.sessionId, ownerId: lease.ownerId };
  }

  async releaseActiveSession(lease: ActiveSessionLease): Promise<void> {
    await withFileLock(this.#lockPath, async () => {
      const registry = await this.#readActiveSessionsUnlocked();
      const remaining = registry.leases.filter(
        (candidate) => candidate.ownerId !== lease.ownerId || candidate.sessionId !== lease.sessionId,
      );
      if (remaining.length === registry.leases.length) return;
      await atomicWriteFile(
        this.#activeSessionsPath,
        JSON.stringify({ schemaVersion: 1, leases: remaining } satisfies ActiveSessionRegistry),
      );
    });
  }

  async archive(input: ArchiveObservationInput): Promise<ArchivedArtifact> {
    if (input.observationId.length === 0) throw new Error("observationId must not be empty");
    if (input.toolName.length === 0) throw new Error("toolName must not be empty");
    if (input.sessionId.length === 0) throw new Error("sessionId must not be empty");

    const sanitized = redactSecrets(input.content);
    const contentHash = createHash("sha256").update(sanitized.content, "utf8").digest("hex");
    const createdAt = this.#now().toISOString();
    const metadata: ArtifactMetadata = {
      schemaVersion: 1,
      artifactId: contentHash,
      observationId: input.observationId,
      ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      toolName: input.toolName,
      sessionId: input.sessionId,
      contentHash,
      originalBytes: Buffer.byteLength(input.content),
      sanitizedBytes: Buffer.byteLength(sanitized.content),
      redactionCount: sanitized.redactionCount,
      createdAt,
      updatedAt: createdAt,
    };

    return withFileLock(this.#lockPath, async () => {
      const artifactPath = this.artifactPath(contentHash);
      let deduplicated = false;
      try {
        await stat(artifactPath);
        deduplicated = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await atomicWriteFile(artifactPath, sanitized.content);
      }

      const entries = await this.#readMetadataUnlocked();
      const existingIndex = entries.findIndex((entry) => entry.observationId === input.observationId);
      if (existingIndex === -1) entries.push(metadata);
      else entries[existingIndex] = metadata;
      const metadataWriteStartedAt = performance.now();
      try {
        await atomicWriteFile(this.#metadataPath, encodeMetadata(entries));
      } finally {
        this.#telemetry?.recordMetadataWrite(performance.now() - metadataWriteStartedAt);
      }
      return { artifactId: contentHash, metadata, deduplicated };
    });
  }

  async read(artifactId: string): Promise<string> {
    return readFile(this.artifactPath(artifactId), "utf8");
  }

  async listMetadata(): Promise<ArtifactMetadata[]> {
    return this.#readMetadataUnlocked();
  }

  async getMetadata(observationId: string): Promise<ArtifactMetadata | undefined> {
    const entries = await this.#readMetadataUnlocked();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.observationId === observationId) return entry;
    }
    return undefined;
  }

  async getMetadataByToolCallId(sessionId: string, toolCallId: string): Promise<ArtifactMetadata | undefined> {
    const entries = await this.#readMetadataUnlocked();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.sessionId === sessionId && entry.toolCallId === toolCallId) return entry;
    }
    return undefined;
  }

  async garbageCollect(options: GarbageCollectOptions): Promise<GarbageCollectResult> {
    if (!Number.isFinite(options.retentionDays) || options.retentionDays < 0) {
      throw new Error("retentionDays must not be negative");
    }
    if (!Number.isFinite(options.quotaBytes) || options.quotaBytes < 0) {
      throw new Error("quotaBytes must not be negative");
    }
    const referenced = options.referencedArtifactIds ?? new Set<string>();

    return withFileLock(this.#lockPath, async () => {
      // Lease enumeration and metadata enumeration share the artifact lock with
      // deletion. A concurrent archive/register/release therefore cannot open a
      // gap between determining active sessions and removing their evidence.
      const registry = await this.#readActiveSessionsUnlocked();
      const liveLeases = registry.leases.filter((lease) => this.#isProcessAlive(lease.pid));
      if (liveLeases.length !== registry.leases.length) {
        // Persist dead-lease cleanup before deleting evidence. A registry write
        // failure consequently fails closed with no artifact deletion.
        await atomicWriteFile(
          this.#activeSessionsPath,
          JSON.stringify({ schemaVersion: 1, leases: liveLeases } satisfies ActiveSessionRegistry),
        );
      }
      const activeSessionIds = new Set(liveLeases.map((lease) => lease.sessionId));
      const entries = await this.#readMetadataUnlocked();
      const protectedArtifactIds = new Set(referenced);
      for (const entry of entries) {
        if (activeSessionIds.has(entry.sessionId)) protectedArtifactIds.add(entry.artifactId);
      }
      const groups = new Map<string, ArtifactMetadata[]>();
      for (const entry of entries) {
        const group = groups.get(entry.artifactId) ?? [];
        group.push(entry);
        groups.set(entry.artifactId, group);
      }

      const artifacts = await this.#listArtifactsUnlocked();
      const sizes = new Map([...artifacts].map(([artifactId, info]) => [artifactId, info.size]));

      let remainingBytes = [...sizes.values()].reduce((total, size) => total + size, 0);
      const deleted = new Set<string>();
      let bytesFreed = 0;
      const cutoff = this.#now().getTime() - options.retentionDays * 24 * 60 * 60 * 1000;
      const artifactIds = new Set([...groups.keys(), ...artifacts.keys()]);
      const candidates = [...artifactIds]
        .filter((artifactId) => !protectedArtifactIds.has(artifactId))
        .map((artifactId) => ({
          artifactId,
          newestTimestamp: Math.max(
            artifacts.get(artifactId)?.modifiedAt ?? 0,
            ...(groups.get(artifactId) ?? []).map((record) => Date.parse(record.updatedAt)),
          ),
        }))
        .sort((left, right) => left.newestTimestamp - right.newestTimestamp);

      const remove = async (artifactId: string): Promise<void> => {
        if (deleted.has(artifactId)) return;
        try {
          await unlink(this.artifactPath(artifactId));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const size = sizes.get(artifactId) ?? 0;
        deleted.add(artifactId);
        bytesFreed += size;
        remainingBytes -= size;
      };

      for (const candidate of candidates) {
        if (candidate.newestTimestamp < cutoff) await remove(candidate.artifactId);
      }
      for (const candidate of candidates) {
        if (remainingBytes <= options.quotaBytes) break;
        await remove(candidate.artifactId);
      }

      if (deleted.size > 0) {
        await atomicWriteFile(
          this.#metadataPath,
          encodeMetadata(entries.filter((entry) => !deleted.has(entry.artifactId))),
        );
      }
      return {
        deletedArtifactIds: [...deleted],
        bytesFreed,
        remainingBytes,
        quotaSatisfied: remainingBytes <= options.quotaBytes,
      };
    });
  }

  async #readActiveSessionsUnlocked(): Promise<ActiveSessionRegistry> {
    try {
      return parseActiveSessions(await readFile(this.#activeSessionsPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, leases: [] };
      throw error;
    }
  }

  async #readMetadataUnlocked(): Promise<ArtifactMetadata[]> {
    const startedAt = performance.now();
    try {
      return parseMetadata(await readFile(this.#metadataPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    } finally {
      this.#telemetry?.recordMetadataRead(performance.now() - startedAt);
    }
  }

  async #listArtifactsUnlocked(): Promise<Map<string, { modifiedAt: number; size: number }>> {
    const artifacts = new Map<string, { modifiedAt: number; size: number }>();
    let shards: Dirent[];
    try {
      shards = await readdir(this.#artifactsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return artifacts;
      throw error;
    }
    for (const shard of shards) {
      if (!shard.isDirectory() || !/^[a-f0-9]{2}$/.test(shard.name)) continue;
      const shardPath = join(this.#artifactsRoot, shard.name);
      for (const entry of await readdir(shardPath, { withFileTypes: true })) {
        const match = /^([a-f0-9]{64})\.txt$/.exec(entry.name);
        if (!entry.isFile() || match?.[1] === undefined) continue;
        const info = await stat(join(shardPath, entry.name));
        artifacts.set(match[1], { modifiedAt: info.mtimeMs, size: info.size });
      }
    }
    return artifacts;
  }
}
