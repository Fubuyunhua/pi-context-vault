import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats, Dirent } from "node:fs";
import { type FileHandle, mkdir, open, readdir, readFile, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteFile, syncParentDirectory, withFileLock } from "../state/atomic.js";
import type { Telemetry } from "../telemetry.js";
import { redactSecrets } from "./redaction.js";

const METADATA_FILE = "observations.jsonl";
const ACTIVE_SESSIONS_FILE = "active-sessions.json";
const LOCK_FILE = "artifacts.lock";
const DEFAULT_COMPACTION_BYTES = 4 * 1024 * 1024;
const DEFAULT_COMPACTION_OBSOLETE_RECORDS = 1024;
const DEFAULT_COMPACTION_OBSOLETE_RATIO = 0.25;
const METADATA_READ_CHUNK_BYTES = 64 * 1024;
export const MAX_METADATA_RECORD_BYTES = 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type ArtifactStoreFaultPoint =
  | "after-artifact-publication"
  | "after-metadata-sync"
  | "after-gc-tombstone-sync"
  | "after-gc-unlink"
  | "before-compaction-replace"
  | "after-compaction-replace";

export interface ArtifactStoreOptions {
  artifactsRoot: string;
  metadataRoot: string;
  now?: () => Date;
  telemetry?: Telemetry;
  /** Test seam for determining whether a local lease-owning process demonstrably exists. */
  isProcessAlive?: (pid: number) => boolean;
  /** Test-only compaction seams. All three thresholds must be met. */
  metadataCompactionThresholdBytes?: number;
  metadataCompactionThresholdObsoleteRecords?: number;
  metadataCompactionThresholdObsoleteRatio?: number;
  /** Test-only durability-boundary fault hook. */
  faultHook?: (point: ArtifactStoreFaultPoint) => void | Promise<void>;
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

interface MetadataUpsertRecordV2 {
  schemaVersion: 2;
  recordType: "upsert";
  metadata: ArtifactMetadata;
}

interface MetadataTombstoneRecordV2 {
  schemaVersion: 2;
  recordType: "tombstone";
  observationId: string;
  artifactId: string;
  deletedAt: string;
  reason: "garbage-collection";
}

type MetadataLogRecord = ArtifactMetadata | MetadataUpsertRecordV2 | MetadataTombstoneRecordV2;

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

interface MetadataIndex {
  dev?: bigint;
  ino?: bigint;
  completeOffset: number;
  logBytes: number;
  committedRecords: number;
  obsoleteRecords: number;
  live: Map<string, ArtifactMetadata>;
  byArtifact: Map<string, Map<string, ArtifactMetadata>>;
  bySession: Map<string, Set<string>>;
  byToolCall: Map<string, Map<string, ArtifactMetadata>>;
}

function emptyIndex(): MetadataIndex {
  return {
    completeOffset: 0,
    logBytes: 0,
    committedRecords: 0,
    obsoleteRecords: 0,
    live: new Map(),
    byArtifact: new Map(),
    bySession: new Map(),
    byToolCall: new Map(),
  };
}

function cloneIndex(index: MetadataIndex): MetadataIndex {
  return {
    ...index,
    live: new Map(index.live),
    byArtifact: new Map([...index.byArtifact].map(([key, values]) => [key, new Map(values)])),
    bySession: new Map([...index.bySession].map(([key, values]) => [key, new Set(values)])),
    byToolCall: new Map([...index.byToolCall].map(([key, values]) => [key, new Map(values)])),
  };
}

function assertArtifactId(artifactId: string): void {
  if (!/^[a-f0-9]{64}$/.test(artifactId)) throw new Error(`Invalid artifact ID: ${artifactId}`);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validateMetadata(value: unknown): ArtifactMetadata {
  if (value === null || typeof value !== "object") throw new Error("unsupported metadata record");
  const entry = value as Partial<ArtifactMetadata>;
  if (
    entry.schemaVersion !== 1 ||
    !isNonemptyString(entry.artifactId) ||
    !isNonemptyString(entry.observationId) ||
    (entry.toolCallId !== undefined && !isNonemptyString(entry.toolCallId)) ||
    !isNonemptyString(entry.toolName) ||
    !isNonemptyString(entry.sessionId) ||
    entry.contentHash !== entry.artifactId ||
    !isCount(entry.originalBytes) ||
    !isCount(entry.sanitizedBytes) ||
    !isCount(entry.redactionCount) ||
    !isTimestamp(entry.createdAt) ||
    !isTimestamp(entry.updatedAt)
  ) {
    throw new Error("unsupported metadata record");
  }
  assertArtifactId(entry.artifactId);
  return entry as ArtifactMetadata;
}

function validateRecord(value: unknown): MetadataLogRecord {
  if (value === null || typeof value !== "object") throw new Error("unsupported metadata record");
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion === 1) return validateMetadata(value);
  if (candidate.schemaVersion !== 2) throw new Error("unsupported metadata record");
  if (candidate.recordType === "upsert") {
    return { schemaVersion: 2, recordType: "upsert", metadata: validateMetadata(candidate.metadata) };
  }
  if (
    candidate.recordType !== "tombstone" ||
    !isNonemptyString(candidate.observationId) ||
    !isNonemptyString(candidate.artifactId) ||
    !isTimestamp(candidate.deletedAt) ||
    candidate.reason !== "garbage-collection"
  ) {
    throw new Error("unsupported metadata record");
  }
  assertArtifactId(candidate.artifactId);
  return candidate as unknown as MetadataTombstoneRecordV2;
}

function encodeRecord(record: MetadataLogRecord): Buffer {
  return Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
}

function encodeValidatedRecord(record: MetadataLogRecord): Buffer {
  validateRecord(record);
  const encoded = encodeRecord(record);
  // The reader bounds record content while treating LF as the commit delimiter.
  if (encoded.length - 1 > MAX_METADATA_RECORD_BYTES) {
    throw new Error(`Artifact metadata record exceeds ${MAX_METADATA_RECORD_BYTES} bytes`);
  }
  return encoded;
}

function encodeValidatedRecords(records: readonly MetadataLogRecord[]): Buffer[] {
  return records.map(encodeValidatedRecord);
}

function toolCallKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}\u0000${toolCallId}`;
}

function removeFromIndexes(index: MetadataIndex, metadata: ArtifactMetadata): void {
  const artifacts = index.byArtifact.get(metadata.artifactId);
  artifacts?.delete(metadata.observationId);
  if (artifacts?.size === 0) index.byArtifact.delete(metadata.artifactId);
  const sessions = index.bySession.get(metadata.sessionId);
  sessions?.delete(metadata.observationId);
  if (sessions?.size === 0) index.bySession.delete(metadata.sessionId);
  if (metadata.toolCallId !== undefined) {
    const tools = index.byToolCall.get(toolCallKey(metadata.sessionId, metadata.toolCallId));
    tools?.delete(metadata.observationId);
    if (tools?.size === 0) index.byToolCall.delete(toolCallKey(metadata.sessionId, metadata.toolCallId));
  }
}

function applyRecord(index: MetadataIndex, record: MetadataLogRecord): void {
  index.committedRecords += 1;
  if (record.schemaVersion === 2 && record.recordType === "tombstone") {
    const previous = index.live.get(record.observationId);
    if (previous !== undefined) {
      removeFromIndexes(index, previous);
      index.live.delete(record.observationId);
    }
  } else {
    const metadata = record.schemaVersion === 1 ? record : record.metadata;
    const previous = index.live.get(metadata.observationId);
    if (previous !== undefined) removeFromIndexes(index, previous);
    index.live.delete(metadata.observationId);
    index.live.set(metadata.observationId, metadata);
    const artifacts = index.byArtifact.get(metadata.artifactId) ?? new Map<string, ArtifactMetadata>();
    artifacts.set(metadata.observationId, metadata);
    index.byArtifact.set(metadata.artifactId, artifacts);
    const sessions = index.bySession.get(metadata.sessionId) ?? new Set<string>();
    sessions.add(metadata.observationId);
    index.bySession.set(metadata.sessionId, sessions);
    if (metadata.toolCallId !== undefined) {
      const key = toolCallKey(metadata.sessionId, metadata.toolCallId);
      const tools = index.byToolCall.get(key) ?? new Map<string, ArtifactMetadata>();
      tools.delete(metadata.observationId);
      tools.set(metadata.observationId, metadata);
      index.byToolCall.set(key, tools);
    }
  }
  index.obsoleteRecords = index.committedRecords - index.live.size;
}

function validateRecordSequence(index: MetadataIndex, records: readonly MetadataLogRecord[]): void {
  const changed = new Map<string, string | undefined>();
  for (const record of records) {
    if (record.schemaVersion === 2 && record.recordType === "tombstone") {
      const current = changed.has(record.observationId)
        ? changed.get(record.observationId)
        : index.live.get(record.observationId)?.artifactId;
      if (current !== undefined && current !== record.artifactId) {
        throw new Error("tombstone artifact does not match live observation");
      }
      changed.set(record.observationId, undefined);
    } else {
      const metadata = record.schemaVersion === 1 ? record : record.metadata;
      changed.set(metadata.observationId, metadata.artifactId);
    }
  }
}

function parseMetadataRecord(buffer: Buffer, line: number): MetadataLogRecord {
  try {
    const source = UTF8_DECODER.decode(buffer);
    if (source.length === 0) throw new Error("empty metadata record");
    return validateRecord(JSON.parse(source) as unknown);
  } catch (error) {
    throw new Error(
      `Invalid artifact metadata at line ${line}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function sameFileVersion(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
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
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.leases))
    throw new Error("Invalid active session registry");
  const owners = new Set<string>();
  for (const lease of registry.leases) {
    if (
      lease === null ||
      typeof lease !== "object" ||
      !isNonemptyString(lease.sessionId) ||
      !isNonemptyString(lease.ownerId) ||
      !Number.isSafeInteger(lease.pid) ||
      lease.pid <= 0 ||
      !isTimestamp(lease.registeredAt) ||
      owners.has(lease.ownerId)
    )
      throw new Error("Invalid active session registry");
    owners.add(lease.ownerId);
  }
  return registry as ActiveSessionRegistry;
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export class ArtifactStore {
  readonly #artifactsRoot: string;
  readonly #metadataPath: string;
  readonly #activeSessionsPath: string;
  readonly #lockPath: string;
  readonly #now: () => Date;
  readonly #telemetry?: Telemetry;
  readonly #isProcessAlive: (pid: number) => boolean;
  readonly #compactionBytes: number;
  readonly #compactionObsoleteRecords: number;
  readonly #compactionObsoleteRatio: number;
  readonly #faultHook?: (point: ArtifactStoreFaultPoint) => void | Promise<void>;
  #index = emptyIndex();
  #indexMutex = Promise.resolve();

  constructor(options: ArtifactStoreOptions) {
    this.#artifactsRoot = options.artifactsRoot;
    this.#metadataPath = join(options.metadataRoot, METADATA_FILE);
    this.#activeSessionsPath = join(options.metadataRoot, ACTIVE_SESSIONS_FILE);
    this.#lockPath = join(options.metadataRoot, LOCK_FILE);
    this.#now = options.now ?? (() => new Date());
    this.#telemetry = options.telemetry;
    this.#isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
    this.#compactionBytes = options.metadataCompactionThresholdBytes ?? DEFAULT_COMPACTION_BYTES;
    this.#compactionObsoleteRecords =
      options.metadataCompactionThresholdObsoleteRecords ?? DEFAULT_COMPACTION_OBSOLETE_RECORDS;
    this.#compactionObsoleteRatio =
      options.metadataCompactionThresholdObsoleteRatio ?? DEFAULT_COMPACTION_OBSOLETE_RATIO;
    this.#faultHook = options.faultHook;
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
      const leases = registry.leases.filter((candidate) => this.#isProcessAlive(candidate.pid));
      leases.push(lease);
      await atomicWriteFile(
        this.#activeSessionsPath,
        JSON.stringify({ schemaVersion: 1, leases } satisfies ActiveSessionRegistry),
      );
    });
    return { sessionId: lease.sessionId, ownerId: lease.ownerId };
  }

  async releaseActiveSession(lease: ActiveSessionLease): Promise<void> {
    await withFileLock(this.#lockPath, async () => {
      const registry = await this.#readActiveSessionsUnlocked();
      const leases = registry.leases.filter(
        (candidate) => candidate.ownerId !== lease.ownerId || candidate.sessionId !== lease.sessionId,
      );
      if (leases.length !== registry.leases.length) {
        await atomicWriteFile(
          this.#activeSessionsPath,
          JSON.stringify({ schemaVersion: 1, leases } satisfies ActiveSessionRegistry),
        );
      }
    });
  }

  async archive(input: ArchiveObservationInput): Promise<ArchivedArtifact> {
    if (input.observationId.length === 0) throw new Error("observationId must not be empty");
    if (input.toolCallId !== undefined && input.toolCallId.length === 0)
      throw new Error("toolCallId must not be empty");
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
    const record: MetadataUpsertRecordV2 = { schemaVersion: 2, recordType: "upsert", metadata };
    // Reject an unpublishable record before the artifact or metadata index can change.
    encodeValidatedRecord(record);

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
      await this.#faultHook?.("after-artifact-publication");
      await this.#withIndexMutex(async () => {
        await this.#appendRecordsUnlocked([record]);
        await this.#faultHook?.("after-metadata-sync");
        try {
          await this.#compactIfNeededUnlocked();
        } catch {
          this.#telemetry?.recordMetadataCompactionFailure();
          this.#telemetry?.recordMaintenanceFailure();
        }
      });
      return { artifactId: contentHash, metadata, deduplicated };
    });
  }

  async read(artifactId: string): Promise<string> {
    return readFile(this.artifactPath(artifactId), "utf8");
  }

  async listMetadata(): Promise<ArtifactMetadata[]> {
    return this.#withIndexMutex(async () => {
      await this.#synchronizePathUnlocked();
      return [...this.#index.live.values()];
    });
  }

  async getMetadata(observationId: string): Promise<ArtifactMetadata | undefined> {
    return this.#withIndexMutex(async () => {
      await this.#synchronizePathUnlocked();
      return this.#index.live.get(observationId);
    });
  }

  async getMetadataByToolCallId(sessionId: string, toolCallId: string): Promise<ArtifactMetadata | undefined> {
    return this.#withIndexMutex(async () => {
      await this.#synchronizePathUnlocked();
      const values = this.#index.byToolCall.get(toolCallKey(sessionId, toolCallId));
      if (values === undefined) return undefined;
      let latest: ArtifactMetadata | undefined;
      for (const value of values.values()) latest = value;
      return latest;
    });
  }

  async garbageCollect(options: GarbageCollectOptions): Promise<GarbageCollectResult> {
    if (!Number.isFinite(options.retentionDays) || options.retentionDays < 0)
      throw new Error("retentionDays must not be negative");
    if (!Number.isFinite(options.quotaBytes) || options.quotaBytes < 0)
      throw new Error("quotaBytes must not be negative");
    const referenced = options.referencedArtifactIds ?? new Set<string>();

    return withFileLock(this.#lockPath, async () =>
      this.#withIndexMutex(async () => {
        const registry = await this.#readActiveSessionsUnlocked();
        const leases = registry.leases.filter((lease) => this.#isProcessAlive(lease.pid));
        if (leases.length !== registry.leases.length) {
          await atomicWriteFile(
            this.#activeSessionsPath,
            JSON.stringify({ schemaVersion: 1, leases } satisfies ActiveSessionRegistry),
          );
        }
        await this.#synchronizePathUnlocked();
        const protectedHashes = new Set(referenced);
        const activeSessions = new Set(leases.map((lease) => lease.sessionId));
        for (const metadata of this.#index.live.values()) {
          if (activeSessions.has(metadata.sessionId)) protectedHashes.add(metadata.artifactId);
        }
        const artifacts = await this.#listArtifactsUnlocked();
        const sizes = new Map([...artifacts].map(([id, info]) => [id, info.size]));
        let remainingBytes = [...sizes.values()].reduce((sum, size) => sum + size, 0);
        const cutoff = this.#now().getTime() - options.retentionDays * 86_400_000;
        const ids = new Set([...this.#index.byArtifact.keys(), ...artifacts.keys()]);
        const candidates = [...ids]
          .filter((id) => !protectedHashes.has(id))
          .map((id) => ({
            artifactId: id,
            newestTimestamp: Math.max(
              artifacts.get(id)?.modifiedAt ?? 0,
              ...[...(this.#index.byArtifact.get(id)?.values() ?? [])].map((entry) => Date.parse(entry.updatedAt)),
            ),
          }))
          .sort((left, right) => left.newestTimestamp - right.newestTimestamp);
        const selected = new Set<string>();
        for (const candidate of candidates) {
          if (candidate.newestTimestamp < cutoff) {
            selected.add(candidate.artifactId);
            remainingBytes -= sizes.get(candidate.artifactId) ?? 0;
          }
        }
        for (const candidate of candidates) {
          if (remainingBytes <= options.quotaBytes) break;
          if (!selected.has(candidate.artifactId)) {
            selected.add(candidate.artifactId);
            remainingBytes -= sizes.get(candidate.artifactId) ?? 0;
          }
        }

        const tombstones: MetadataTombstoneRecordV2[] = [];
        const deletedAt = this.#now().toISOString();
        for (const artifactId of selected) {
          for (const metadata of this.#index.byArtifact.get(artifactId)?.values() ?? []) {
            tombstones.push({
              schemaVersion: 2,
              recordType: "tombstone",
              observationId: metadata.observationId,
              artifactId,
              deletedAt,
              reason: "garbage-collection",
            });
          }
        }
        if (tombstones.length > 0) {
          await this.#appendRecordsUnlocked(tombstones);
          await this.#faultHook?.("after-gc-tombstone-sync");
        }
        let bytesFreed = 0;
        for (const artifactId of selected) {
          try {
            await unlink(this.artifactPath(artifactId));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          bytesFreed += sizes.get(artifactId) ?? 0;
          await this.#faultHook?.("after-gc-unlink");
        }
        await this.#fullRebuildUnlocked();
        try {
          await this.#compactIfNeededUnlocked();
        } catch {
          this.#telemetry?.recordMetadataCompactionFailure();
          this.#telemetry?.recordMaintenanceFailure();
        }
        return {
          deletedArtifactIds: [...selected],
          bytesFreed,
          remainingBytes: Math.max(0, remainingBytes),
          quotaSatisfied: remainingBytes <= options.quotaBytes,
        };
      }),
    );
  }

  async #withIndexMutex<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#indexMutex;
    let release = (): void => undefined;
    this.#indexMutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #readActiveSessionsUnlocked(): Promise<ActiveSessionRegistry> {
    try {
      return parseActiveSessions(await readFile(this.#activeSessionsPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, leases: [] };
      throw error;
    }
  }

  async #parseRangeIntoIndex(
    handle: FileHandle,
    position: number,
    length: number,
    startingLine: number,
    index: MetadataIndex,
  ): Promise<{ completeBytes: number; bytesRead: number }> {
    let bytesRead = 0;
    let completeBytes = 0;
    let line = startingLine;
    let recordBytes = 0;
    let oversized = false;
    let pieces: Buffer[] = [];

    while (bytesRead < length) {
      const requested = Math.min(METADATA_READ_CHUNK_BYTES, length - bytesRead);
      const chunk = Buffer.allocUnsafe(requested);
      const result = await handle.read(chunk, 0, requested, position + bytesRead);
      if (result.bytesRead === 0) break;
      const available = chunk.subarray(0, result.bytesRead);
      let cursor = 0;
      while (cursor < available.length) {
        const newline = available.indexOf(0x0a, cursor);
        const end = newline === -1 ? available.length : newline;
        const segment = available.subarray(cursor, end);
        if (!oversized) {
          if (recordBytes + segment.length > MAX_METADATA_RECORD_BYTES) {
            oversized = true;
            pieces = [];
          } else if (segment.length > 0) {
            pieces.push(segment);
          }
        }
        recordBytes += segment.length;
        if (newline === -1) break;
        if (oversized) {
          throw new Error(
            `Invalid artifact metadata at line ${line}: record exceeds ${MAX_METADATA_RECORD_BYTES} bytes`,
          );
        }
        const source = pieces.length === 1 ? (pieces[0] as Buffer) : Buffer.concat(pieces, recordBytes);
        const record = parseMetadataRecord(source, line);
        validateRecordSequence(index, [record]);
        applyRecord(index, record);
        line += 1;
        completeBytes = bytesRead + newline + 1;
        recordBytes = 0;
        pieces = [];
        cursor = newline + 1;
      }
      bytesRead += result.bytesRead;
    }
    return { completeBytes, bytesRead };
  }

  async #synchronizePathUnlocked(): Promise<void> {
    const startedAt = performance.now();
    let handle: FileHandle;
    try {
      handle = await open(this.#metadataPath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.#index = emptyIndex();
        return;
      }
      throw error;
    }
    try {
      await this.#synchronizeHandleUnlocked(handle);
    } finally {
      await handle.close();
      this.#telemetry?.recordMetadataRead(performance.now() - startedAt);
    }
  }

  async #synchronizeHandleUnlocked(handle: FileHandle): Promise<void> {
    while (true) {
      const before = await handle.stat({ bigint: true });
      const size = Number(before.size);
      const identityMatches =
        this.#index.dev === before.dev && this.#index.ino === before.ino && size >= this.#index.completeOffset;
      // A same-size file is only unchanged when the cached file had no
      // uncommitted suffix. Otherwise another store may have replaced that
      // suffix in place with an equally-sized committed record.
      if (identityMatches && size === this.#index.logBytes && this.#index.completeOffset === this.#index.logBytes) {
        return;
      }

      const rebuilding = !identityMatches;
      const startedAt = performance.now();
      const position = rebuilding ? 0 : this.#index.completeOffset;
      const replacement = rebuilding ? emptyIndex() : cloneIndex(this.#index);
      let parsed: { completeBytes: number; bytesRead: number };
      try {
        parsed = await this.#parseRangeIntoIndex(
          handle,
          position,
          size - position,
          rebuilding ? 1 : this.#index.committedRecords + 1,
          replacement,
        );
      } catch (error) {
        const afterFailure = await handle.stat({ bigint: true });
        if (!sameFileVersion(before, afterFailure)) continue;
        throw error;
      }
      const after = await handle.stat({ bigint: true });
      if (!sameFileVersion(before, after)) continue;

      replacement.dev = after.dev;
      replacement.ino = after.ino;
      replacement.completeOffset = position + parsed.completeBytes;
      replacement.logBytes = size;
      this.#index = replacement;
      if (rebuilding) {
        this.#telemetry?.recordMetadataFullRebuild(performance.now() - startedAt);
      } else {
        this.#telemetry?.recordMetadataTailSync(parsed.bytesRead);
      }
      return;
    }
  }

  async #fullRebuildUnlocked(): Promise<void> {
    this.#index.dev = undefined;
    this.#index.ino = undefined;
    await this.#synchronizePathUnlocked();
  }

  async #appendRecordsUnlocked(records: readonly MetadataLogRecord[]): Promise<void> {
    if (records.length === 0) return;
    const encodedRecords = encodeValidatedRecords(records);
    await mkdir(dirname(this.#metadataPath), { recursive: true, mode: 0o700 });
    const existed = await stat(this.#metadataPath).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    const handle = await open(this.#metadataPath, "a+", 0o600);
    const startedAt = performance.now();
    try {
      const readStartedAt = performance.now();
      try {
        await this.#synchronizeHandleUnlocked(handle);
      } finally {
        this.#telemetry?.recordMetadataRead(performance.now() - readStartedAt);
      }
      const info = await handle.stat();
      validateRecordSequence(this.#index, records);
      if (info.size > this.#index.completeOffset) {
        const discarded = info.size - this.#index.completeOffset;
        await handle.truncate(this.#index.completeOffset);
        this.#index.logBytes = this.#index.completeOffset;
        this.#telemetry?.recordMetadataTornTailRecovery(discarded);
      }
      const encoded = Buffer.concat(encodedRecords);
      let written = 0;
      while (written < encoded.length) {
        const result = await handle.write(
          encoded,
          written,
          encoded.length - written,
          this.#index.completeOffset + written,
        );
        if (result.bytesWritten === 0) throw new Error("Unable to append artifact metadata");
        written += result.bytesWritten;
      }
      await handle.sync();
      if (!existed) await syncParentDirectory(this.#metadataPath);
      for (const record of records) applyRecord(this.#index, record);
      const opened = await handle.stat({ bigint: true });
      this.#index.dev = opened.dev;
      this.#index.ino = opened.ino;
      this.#index.completeOffset += encoded.length;
      this.#index.logBytes = this.#index.completeOffset;
      this.#telemetry?.recordMetadataAppend(
        encoded.length,
        records.filter((record) => record.schemaVersion === 2 && record.recordType === "tombstone").length,
      );
    } finally {
      await handle.close();
      this.#telemetry?.recordMetadataWrite(performance.now() - startedAt);
    }
  }

  async #compactIfNeededUnlocked(): Promise<void> {
    const index = this.#index;
    if (
      index.logBytes < this.#compactionBytes ||
      index.obsoleteRecords < this.#compactionObsoleteRecords ||
      index.committedRecords === 0 ||
      index.obsoleteRecords / index.committedRecords < this.#compactionObsoleteRatio
    )
      return;
    const startedAt = performance.now();
    const before = index.logBytes;
    const records = [...index.live.values()].map(
      (metadata): MetadataUpsertRecordV2 => ({ schemaVersion: 2, recordType: "upsert", metadata }),
    );
    const content = Buffer.concat(encodeValidatedRecords(records));
    await this.#faultHook?.("before-compaction-replace");
    await atomicWriteFile(this.#metadataPath, content);
    this.#index = emptyIndex();
    await this.#faultHook?.("after-compaction-replace");
    await this.#synchronizePathUnlocked();
    this.#telemetry?.recordMetadataCompaction(performance.now() - startedAt, before, content.length);
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
