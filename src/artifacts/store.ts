import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile, withFileLock } from "../state/atomic.js";
import { redactSecrets } from "./redaction.js";

const METADATA_FILE = "observations.jsonl";
const LOCK_FILE = "artifacts.lock";

export interface ArtifactStoreOptions {
  artifactsRoot: string;
  metadataRoot: string;
  now?: () => Date;
}

export interface ArchiveObservationInput {
  observationId: string;
  toolName: string;
  sessionId: string;
  content: string;
}

export interface ArtifactMetadata {
  schemaVersion: 1;
  artifactId: string;
  observationId: string;
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
  readonly #lockPath: string;
  readonly #now: () => Date;

  constructor(options: ArtifactStoreOptions) {
    this.#artifactsRoot = options.artifactsRoot;
    this.#metadataPath = join(options.metadataRoot, METADATA_FILE);
    this.#lockPath = join(options.metadataRoot, LOCK_FILE);
    this.#now = options.now ?? (() => new Date());
  }

  artifactPath(artifactId: string): string {
    assertArtifactId(artifactId);
    return join(this.#artifactsRoot, artifactId.slice(0, 2), `${artifactId}.txt`);
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
      await atomicWriteFile(this.#metadataPath, encodeMetadata(entries));
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

  async garbageCollect(options: GarbageCollectOptions): Promise<GarbageCollectResult> {
    if (!Number.isFinite(options.retentionDays) || options.retentionDays < 0) {
      throw new Error("retentionDays must not be negative");
    }
    if (!Number.isFinite(options.quotaBytes) || options.quotaBytes < 0) {
      throw new Error("quotaBytes must not be negative");
    }
    const referenced = options.referencedArtifactIds ?? new Set<string>();

    return withFileLock(this.#lockPath, async () => {
      const entries = await this.#readMetadataUnlocked();
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
        .filter((artifactId) => !referenced.has(artifactId))
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

  async #readMetadataUnlocked(): Promise<ArtifactMetadata[]> {
    try {
      return parseMetadata(await readFile(this.#metadataPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
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
