import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants, type Dirent } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { atomicWriteFile, durableMkdir, syncParentDirectory, withFileLock } from "../state/atomic.js";
import type { Telemetry } from "../telemetry.js";
import { redactSecrets } from "./redaction.js";

const METADATA_FILE = "observations.jsonl";
const SEARCH_INDEX_FILE = "observation-search-index-v1.json";
const SEARCH_INDEX_ALGORITHM = "cv-search-bloom-v1";
const ACTIVE_SESSIONS_FILE = "active-sessions.json";
const LOCK_FILE = "artifacts.lock";
const DEFAULT_COMPACTION_BYTES = 4 * 1024 * 1024;
const DEFAULT_COMPACTION_OBSOLETE_RECORDS = 1024;
const DEFAULT_COMPACTION_OBSOLETE_RATIO = 0.25;
const METADATA_READ_CHUNK_BYTES = 64 * 1024;
export const MAX_METADATA_RECORD_BYTES = 1024 * 1024;
const SEARCH_GRAM_LENGTH = 3;
const SEARCH_BLOOM_BYTES = 2_048;
const SEARCH_BLOOM_HASHES = 3;
const SEARCH_INDEX_MAX_ENTRIES = 10_000;
const MAX_SEARCH_INDEX_BYTES = 32 * 1024 * 1024;
const SEARCH_IDENTIFIER_SEPARATOR_PATTERN = /[_./\\\p{Pd}]+/gu;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type ArtifactStoreFaultPoint =
  | "after-artifact-publication"
  | "after-metadata-sync"
  | "after-gc-tombstone-sync"
  | "after-gc-unlink"
  | "before-compaction-replace"
  | "after-compaction-replace"
  | "before-search-index-load"
  | "before-search-index-publication";

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
  /** Test-only bound override for the derived search index. */
  searchIndexMaxEntries?: number;
  /** Test-only instrumentation for verified artifact reads. */
  onArtifactRead?: (artifactId: string) => void;
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

export interface ArtifactStorageUsage {
  artifactCount: number;
  usedBytes: number;
}

export interface ArtifactSearchNeedle {
  value: string;
  collapseIdentifierSeparators: boolean;
  conservativeFallback?: boolean;
}

export interface ArtifactSearchBatch {
  candidateArtifactIds: Set<string>;
  metadata: ArtifactMetadata[];
  contentByArtifact: Map<string, string>;
  partial: boolean;
}

interface ArtifactSearchEntry {
  bloom: Uint8Array;
}

interface SerializedArtifactSearchEntry {
  artifactId: string;
  bloom: string;
}

interface ArtifactSearchIndexSnapshot {
  schemaVersion: 1;
  algorithm: typeof SEARCH_INDEX_ALGORITHM;
  gramLength: number;
  bloomBytes: number;
  hashCount: number;
  maxEntries: number;
  entries: SerializedArtifactSearchEntry[];
  checksum: string;
}

interface OwnedDirectoryIdentity {
  path: string;
  canonicalPath: string;
  dev: bigint;
  ino: bigint;
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

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? "";
}

function isUnsafeStateError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Unsafe|escapes its root|replaced Context Vault/u.test(message);
}

function noFollowFlags(flags: number): number {
  if (process.platform === "win32") return flags;
  let result = flags | constants.O_NONBLOCK;
  if (typeof constants.O_NOFOLLOW === "number") result |= constants.O_NOFOLLOW;
  return result;
}

function searchForm(value: string, collapseIdentifierSeparators: boolean): string {
  const normalized = value.toLocaleLowerCase("en-US");
  return collapseIdentifierSeparators ? normalized.replace(SEARCH_IDENTIFIER_SEPARATOR_PATTERN, "") : normalized;
}

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

function searchGrams(value: string, prefix: "collapsed" | "normalized"): string[] {
  const characters = Array.from(value);
  if (characters.length === 0) return [];
  const width = Math.min(SEARCH_GRAM_LENGTH, characters.length);
  const grams = new Set<string>();
  for (let index = 0; index <= characters.length - width; index += 1) {
    grams.add(`${prefix}:${characters.slice(index, index + width).join("")}`);
  }
  return [...grams];
}

function forEachSearchGram(value: string, prefix: "collapsed" | "normalized", visitor: (gram: string) => void): void {
  const previous: string[] = [];
  for (const character of value) {
    previous.push(character);
    if (previous.length > SEARCH_GRAM_LENGTH) previous.shift();
    if (previous.length === SEARCH_GRAM_LENGTH) visitor(`${prefix}:${previous.join("")}`);
  }
}

function bloomSeeds(value: string): [number, number] {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = (Math.imul(second ^ code, 0x85ebca6b) + 0xc2b2ae35) >>> 0;
  }
  return [first, second | 1];
}

function addToBloom(bloom: Uint8Array, gram: string): void {
  const [first, second] = bloomSeeds(gram);
  const bitCount = SEARCH_BLOOM_BYTES * 8;
  for (let index = 0; index < SEARCH_BLOOM_HASHES; index += 1) {
    const position = ((first + Math.imul(index, second)) >>> 0) % bitCount;
    bloom[Math.floor(position / 8)] |= 1 << (position % 8);
  }
}

function bloomHas(bloom: Uint8Array, gram: string): boolean {
  const [first, second] = bloomSeeds(gram);
  const bitCount = SEARCH_BLOOM_BYTES * 8;
  for (let index = 0; index < SEARCH_BLOOM_HASHES; index += 1) {
    const position = ((first + Math.imul(index, second)) >>> 0) % bitCount;
    if ((bloom[Math.floor(position / 8)] & (1 << (position % 8))) === 0) return false;
  }
  return true;
}

function buildSearchBloom(content: string): Uint8Array {
  const bloom = new Uint8Array(SEARCH_BLOOM_BYTES);
  const normalized = searchForm(content, false);
  const collapsed = searchForm(content, true);
  forEachSearchGram(normalized, "normalized", (gram) => addToBloom(bloom, gram));
  if (collapsed !== normalized) forEachSearchGram(collapsed, "collapsed", (gram) => addToBloom(bloom, gram));
  else forEachSearchGram(normalized, "collapsed", (gram) => addToBloom(bloom, gram));
  return bloom;
}

function artifactSearchSnapshotPayload(entries: SerializedArtifactSearchEntry[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    algorithm: SEARCH_INDEX_ALGORITHM,
    gramLength: SEARCH_GRAM_LENGTH,
    bloomBytes: SEARCH_BLOOM_BYTES,
    hashCount: SEARCH_BLOOM_HASHES,
    maxEntries: SEARCH_INDEX_MAX_ENTRIES,
    entries,
  });
}

function artifactSearchSnapshotChecksum(entries: SerializedArtifactSearchEntry[]): string {
  return createHash("sha256").update(artifactSearchSnapshotPayload(entries), "utf8").digest("hex");
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function parseArtifactSearchSnapshot(
  source: string,
  maximumEntries: number,
): { entries: Map<string, ArtifactSearchEntry>; needsRewrite: boolean } {
  const value = JSON.parse(source) as Partial<ArtifactSearchIndexSnapshot>;
  if (
    value === null ||
    typeof value !== "object" ||
    !hasExactKeys(value, [
      "algorithm",
      "bloomBytes",
      "checksum",
      "entries",
      "gramLength",
      "hashCount",
      "maxEntries",
      "schemaVersion",
    ]) ||
    value.schemaVersion !== 1 ||
    value.algorithm !== SEARCH_INDEX_ALGORITHM ||
    value.gramLength !== SEARCH_GRAM_LENGTH ||
    value.bloomBytes !== SEARCH_BLOOM_BYTES ||
    value.hashCount !== SEARCH_BLOOM_HASHES ||
    value.maxEntries !== SEARCH_INDEX_MAX_ENTRIES ||
    !Array.isArray(value.entries) ||
    value.entries.length > maximumEntries ||
    typeof value.checksum !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.checksum) ||
    artifactSearchSnapshotChecksum(value.entries as SerializedArtifactSearchEntry[]) !== value.checksum
  ) {
    throw new Error("unsupported derived search index");
  }
  const entries = new Map<string, ArtifactSearchEntry>();
  for (const candidate of value.entries) {
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      !hasExactKeys(candidate, ["artifactId", "bloom"]) ||
      !/^[a-f0-9]{64}$/.test(candidate.artifactId) ||
      typeof candidate.bloom !== "string" ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(candidate.bloom)
    ) {
      throw new Error("invalid derived search index entry");
    }
    const bloom = Buffer.from(candidate.bloom, "base64");
    if (
      bloom.length !== SEARCH_BLOOM_BYTES ||
      bloom.toString("base64") !== candidate.bloom ||
      entries.has(candidate.artifactId)
    ) {
      throw new Error("invalid derived search index entry");
    }
    entries.set(candidate.artifactId, { bloom: new Uint8Array(bloom) });
  }
  return { entries, needsRewrite: false };
}

export class ArtifactStore {
  readonly #artifactsRoot: string;
  readonly #metadataPath: string;
  readonly #searchIndexPath: string;
  readonly #activeSessionsPath: string;
  readonly #lockPath: string;
  readonly #now: () => Date;
  readonly #telemetry?: Telemetry;
  readonly #isProcessAlive: (pid: number) => boolean;
  readonly #compactionBytes: number;
  readonly #compactionObsoleteRecords: number;
  readonly #compactionObsoleteRatio: number;
  readonly #faultHook?: (point: ArtifactStoreFaultPoint) => void | Promise<void>;
  readonly #searchIndexMaxEntries: number;
  readonly #onArtifactRead?: (artifactId: string) => void;
  #ownedDirectories?: OwnedDirectoryIdentity[];
  #namespaceInitialization?: Promise<void>;
  #index = emptyIndex();
  #indexMutex = Promise.resolve();
  #artifactSearch = new Map<string, ArtifactSearchEntry>();
  readonly #unavailableSearchArtifacts = new Set<string>();
  readonly #operatorDiagnostics: string[] = [];
  #searchIndexLoaded = false;
  #searchIndexDirty = false;

  constructor(options: ArtifactStoreOptions) {
    this.#artifactsRoot = resolve(options.artifactsRoot);
    const metadataRoot = resolve(options.metadataRoot);
    this.#metadataPath = join(metadataRoot, METADATA_FILE);
    this.#searchIndexPath = join(metadataRoot, SEARCH_INDEX_FILE);
    this.#activeSessionsPath = join(metadataRoot, ACTIVE_SESSIONS_FILE);
    this.#lockPath = join(metadataRoot, LOCK_FILE);
    this.#now = options.now ?? (() => new Date());
    this.#telemetry = options.telemetry;
    this.#isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
    this.#compactionBytes = options.metadataCompactionThresholdBytes ?? DEFAULT_COMPACTION_BYTES;
    this.#compactionObsoleteRecords =
      options.metadataCompactionThresholdObsoleteRecords ?? DEFAULT_COMPACTION_OBSOLETE_RECORDS;
    this.#compactionObsoleteRatio =
      options.metadataCompactionThresholdObsoleteRatio ?? DEFAULT_COMPACTION_OBSOLETE_RATIO;
    this.#faultHook = options.faultHook;
    this.#searchIndexMaxEntries = options.searchIndexMaxEntries ?? SEARCH_INDEX_MAX_ENTRIES;
    if (!Number.isSafeInteger(this.#searchIndexMaxEntries) || this.#searchIndexMaxEntries <= 0) {
      throw new Error("searchIndexMaxEntries must be a positive safe integer");
    }
    this.#onArtifactRead = options.onArtifactRead;
  }

  operatorDiagnostics(): string[] {
    return [...this.#operatorDiagnostics];
  }

  #recordOperatorDiagnostic(error: unknown): void {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 512);
    this.#operatorDiagnostics.push(message);
    this.#operatorDiagnostics.splice(0, Math.max(0, this.#operatorDiagnostics.length - 20));
  }

  artifactPath(artifactId: string): string {
    assertArtifactId(artifactId);
    return join(this.#artifactsRoot, artifactId.slice(0, 2), `${artifactId}.txt`);
  }

  #ownedDirectoryPaths(): string[] {
    const metadataRoot = dirname(this.#metadataPath);
    const stateRoot = dirname(this.#artifactsRoot);
    if (dirname(metadataRoot) !== stateRoot || basename(this.#artifactsRoot) !== "artifacts") {
      throw new Error("Artifact and metadata roots must be sibling Vault state directories");
    }
    if (basename(metadataRoot) !== "metadata") {
      throw new Error("Artifact and metadata roots must be sibling Vault state directories");
    }

    const ancestors = [stateRoot];
    let cursor = stateRoot;
    while (basename(cursor) !== "context-vault") {
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    if (basename(cursor) === "context-vault") {
      ancestors.length = 0;
      let child = stateRoot;
      while (true) {
        ancestors.unshift(child);
        if (child === cursor) break;
        child = dirname(child);
      }
    }
    return [...ancestors, this.#artifactsRoot, metadataRoot];
  }

  async #captureOwnedDirectory(path: string, parent?: OwnedDirectoryIdentity): Promise<OwnedDirectoryIdentity> {
    const info = await lstat(path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe Context Vault state directory: ${path}`);
    const canonicalPath = await realpath(path);
    if (parent !== undefined && canonicalPath !== join(parent.canonicalPath, basename(path))) {
      throw new Error(`Context Vault state directory escapes its root: ${path}`);
    }
    return { path, canonicalPath, dev: info.dev, ino: info.ino };
  }

  async #initializeNamespace(): Promise<void> {
    const paths = this.#ownedDirectoryPaths();
    const stateRoot = dirname(this.#artifactsRoot);
    const identities = new Map<string, OwnedDirectoryIdentity>();
    for (const path of paths) {
      if (path === this.#artifactsRoot || path === dirname(this.#metadataPath)) {
        await durableMkdir(path);
      }
      const parent = identities.get(dirname(path));
      const identity = await this.#captureOwnedDirectory(path, parent);
      identities.set(path, identity);
    }
    if (!identities.has(stateRoot)) throw new Error(`Unsafe Context Vault state directory: ${stateRoot}`);
    this.#ownedDirectories = paths.map((path) => identities.get(path) as OwnedDirectoryIdentity);
  }

  async #validateNamespace(): Promise<void> {
    if (this.#ownedDirectories === undefined) {
      this.#namespaceInitialization ??= this.#initializeNamespace();
      await this.#namespaceInitialization;
    }
    const expectedDirectories = this.#ownedDirectories as OwnedDirectoryIdentity[];
    for (const expected of expectedDirectories) {
      let info: BigIntStats;
      try {
        info = await lstat(expected.path, { bigint: true });
      } catch {
        throw new Error(`Unsafe or replaced Context Vault state directory: ${expected.path}`);
      }
      if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== expected.dev || info.ino !== expected.ino) {
        throw new Error(`Unsafe or replaced Context Vault state directory: ${expected.path}`);
      }
    }
  }

  async #openRegularFile(
    path: string,
    flags: number,
    mode?: number,
    validateNamespace = true,
  ): Promise<{ handle: FileHandle; existed: boolean }> {
    if (validateNamespace) await this.#validateNamespace();
    let before: BigIntStats | undefined;
    try {
      before = await lstat(path, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Unsafe Context Vault state file: ${path}`);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }

    const handle = await open(path, noFollowFlags(flags), mode);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || (before !== undefined && (opened.dev !== before.dev || opened.ino !== before.ino))) {
        throw new Error(`Unsafe or replaced Context Vault state file: ${path}`);
      }
      return { handle, existed: before !== undefined };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async #readRegularFile(
    path: string,
    missing: "throw" | "undefined" = "throw",
    validateNamespace = true,
  ): Promise<string | undefined> {
    let opened: { handle: FileHandle; existed: boolean };
    try {
      opened = await this.#openRegularFile(path, constants.O_RDONLY, undefined, validateNamespace);
    } catch (error) {
      if (missing === "undefined" && errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
    try {
      return await opened.handle.readFile({ encoding: "utf8" });
    } finally {
      await opened.handle.close();
    }
  }

  async #readRegularFileBounded(path: string, maximumBytes: number): Promise<string | undefined> {
    let opened: { handle: FileHandle; existed: boolean };
    try {
      opened = await this.#openRegularFile(path, constants.O_RDONLY);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
    try {
      const info = await opened.handle.stat();
      if (info.size > maximumBytes) return "";
      return await opened.handle.readFile({ encoding: "utf8" });
    } finally {
      await opened.handle.close();
    }
  }

  async #atomicWriteFixedFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.#validateNamespace();
    try {
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Unsafe Context Vault state file: ${path}`);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    await atomicWriteFile(path, content);
    const opened = await this.#openRegularFile(path, constants.O_RDONLY);
    await opened.handle.close();
  }

  async #validateArtifactShard(artifactId: string, create: boolean): Promise<string> {
    await this.#validateNamespace();
    const shardPath = join(this.#artifactsRoot, artifactId.slice(0, 2));
    try {
      const info = await lstat(shardPath);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe artifact shard: ${shardPath}`);
    } catch (error) {
      if (!create || errorCode(error) !== "ENOENT") throw error;
      await mkdir(shardPath, { mode: 0o700 });
      await syncParentDirectory(shardPath);
      const info = await lstat(shardPath);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe artifact shard: ${shardPath}`);
    }
    const artifactsIdentity = (this.#ownedDirectories as OwnedDirectoryIdentity[]).find(
      (entry) => entry.path === this.#artifactsRoot,
    );
    if (
      artifactsIdentity === undefined ||
      (await realpath(shardPath)) !== join(artifactsIdentity.canonicalPath, artifactId.slice(0, 2))
    ) {
      throw new Error(`Artifact shard escapes its root: ${shardPath}`);
    }
    return shardPath;
  }

  async #readArtifactVerified(artifactId: string): Promise<string> {
    assertArtifactId(artifactId);
    this.#onArtifactRead?.(artifactId);
    await this.#validateArtifactShard(artifactId, false);
    const source = await this.#readRegularFile(this.artifactPath(artifactId), "throw", false);
    const hash = createHash("sha256")
      .update(source as string, "utf8")
      .digest("hex");
    if (hash !== artifactId) throw new Error(`Artifact content hash mismatch: ${artifactId}`);
    return source as string;
  }

  async #withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.#validateNamespace();
    try {
      const lock = await lstat(this.#lockPath);
      if (!lock.isDirectory() || lock.isSymbolicLink()) {
        throw new Error(`Unsafe Context Vault state lock: ${this.#lockPath}`);
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    return withFileLock(this.#lockPath, async () => {
      await this.#validateNamespace();
      return operation();
    });
  }

  async registerActiveSession(sessionId: string): Promise<ActiveSessionLease> {
    if (sessionId.length === 0) throw new Error("sessionId must not be empty");
    const lease: ActiveSessionLeaseRecord = {
      sessionId,
      ownerId: randomUUID(),
      pid: process.pid,
      registeredAt: this.#now().toISOString(),
    };
    await this.#withStoreLock(async () => {
      const registry = await this.#readActiveSessionsUnlocked();
      const leases = registry.leases.filter((candidate) => this.#isProcessAlive(candidate.pid));
      leases.push(lease);
      await this.#atomicWriteFixedFile(
        this.#activeSessionsPath,
        JSON.stringify({ schemaVersion: 1, leases } satisfies ActiveSessionRegistry),
      );
    });
    return { sessionId: lease.sessionId, ownerId: lease.ownerId };
  }

  async releaseActiveSession(lease: ActiveSessionLease): Promise<void> {
    await this.#withStoreLock(async () => {
      const registry = await this.#readActiveSessionsUnlocked();
      const leases = registry.leases.filter(
        (candidate) => candidate.ownerId !== lease.ownerId || candidate.sessionId !== lease.sessionId,
      );
      if (leases.length !== registry.leases.length) {
        await this.#atomicWriteFixedFile(
          this.#activeSessionsPath,
          JSON.stringify({ schemaVersion: 1, leases } satisfies ActiveSessionRegistry),
        );
      }
    });
  }

  async flushSearchIndex(): Promise<void> {
    try {
      await this.#withStoreLock(async () =>
        this.#withIndexMutex(async () => {
          await this.#synchronizePathUnlocked();
          await this.#loadArtifactSearchIndexUnlocked();
          for (const artifactId of this.#artifactSearch.keys()) {
            if (!this.#index.byArtifact.has(artifactId)) this.#removeArtifactSearch(artifactId);
          }
          await this.#publishArtifactSearchIndexUnlocked();
        }),
      );
    } catch {
      // The snapshot is disposable; shutdown must never affect durable evidence.
    }
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

    return this.#withStoreLock(async () => {
      const artifactPath = this.artifactPath(contentHash);
      await this.#validateArtifactShard(contentHash, true);
      let deduplicated = false;
      try {
        await this.#readArtifactVerified(contentHash);
        deduplicated = true;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        await this.#atomicWriteFixedFile(artifactPath, sanitized.content);
        await this.#readArtifactVerified(contentHash);
      }
      await this.#faultHook?.("after-artifact-publication");
      await this.#withIndexMutex(async () => {
        await this.#appendRecordsUnlocked([record]);
        this.#indexArtifactSearch(contentHash, sanitized.content);
        await this.#faultHook?.("after-metadata-sync");
        try {
          await this.#compactIfNeededUnlocked();
        } catch {
          this.#telemetry?.recordMetadataCompactionFailure();
        }
      });
      return { artifactId: contentHash, metadata, deduplicated };
    });
  }

  async read(artifactId: string): Promise<string> {
    await this.#validateNamespace();
    return this.#readArtifactVerified(artifactId);
  }

  async listMetadata(): Promise<ArtifactMetadata[]> {
    await this.#validateNamespace();
    return this.#withIndexMutex(async () => {
      await this.#synchronizePathUnlocked();
      return [...this.#index.live.values()];
    });
  }

  async searchArtifacts(needles: readonly ArtifactSearchNeedle[]): Promise<ArtifactSearchBatch> {
    const startedAt = performance.now();
    let hydrationReads = 0;
    await this.#validateNamespace();
    return this.#withStoreLock(async () =>
      this.#withIndexMutex(async () => {
        await this.#synchronizePathUnlocked();
        await this.#loadArtifactSearchIndexUnlocked();
        const desiredArtifactIds = new Set(
          this.#liveArtifactIdsByRecencyUnlocked().slice(0, this.#searchIndexMaxEntries),
        );
        for (const artifactId of this.#artifactSearch.keys()) {
          if (!desiredArtifactIds.has(artifactId)) this.#removeArtifactSearch(artifactId);
        }
        for (const artifactId of this.#unavailableSearchArtifacts) {
          if (!desiredArtifactIds.has(artifactId)) this.#unavailableSearchArtifacts.delete(artifactId);
        }
        for (const artifactId of desiredArtifactIds) {
          if (this.#artifactSearch.has(artifactId) || this.#unavailableSearchArtifacts.has(artifactId)) continue;
          try {
            hydrationReads += 1;
            this.#indexArtifactSearch(artifactId, await this.#readArtifactVerified(artifactId));
          } catch (error) {
            if (isUnsafeStateError(error)) throw error;
            this.#unavailableSearchArtifacts.add(artifactId);
          }
        }
        const orderedEntries = [...desiredArtifactIds]
          .map((artifactId) => [artifactId, this.#artifactSearch.get(artifactId)] as const)
          .filter((entry): entry is readonly [string, ArtifactSearchEntry] => entry[1] !== undefined);
        if ([...this.#artifactSearch.keys()].some((artifactId, index) => orderedEntries[index]?.[0] !== artifactId)) {
          this.#searchIndexDirty = true;
        }
        this.#artifactSearch = new Map(orderedEntries);
        await this.#publishArtifactSearchIndexUnlocked();

        const liveArtifactIds = new Set(this.#index.byArtifact.keys());
        const candidates = new Set<string>();
        const fallbackArtifacts = new Set<string>();
        for (const artifactId of liveArtifactIds) {
          if (this.#unavailableSearchArtifacts.has(artifactId)) continue;
          const entry = this.#artifactSearch.get(artifactId);
          if (entry === undefined) {
            candidates.add(artifactId);
            fallbackArtifacts.add(artifactId);
            continue;
          }
          for (const needle of needles) {
            const form = searchForm(needle.value, needle.collapseIdentifierSeparators);
            if (needle.conservativeFallback || !isAscii(form) || Array.from(form).length < SEARCH_GRAM_LENGTH) {
              candidates.add(artifactId);
              fallbackArtifacts.add(artifactId);
              break;
            }
            const prefix = needle.collapseIdentifierSeparators ? "collapsed" : "normalized";
            const grams = searchGrams(form, prefix);
            if (grams.every((gram) => bloomHas(entry.bloom, gram))) {
              candidates.add(artifactId);
              break;
            }
          }
        }
        const contentByArtifact = new Map<string, string>();
        let partial = [...this.#unavailableSearchArtifacts].some((artifactId) => liveArtifactIds.has(artifactId));
        for (const artifactId of candidates) {
          try {
            contentByArtifact.set(artifactId, await this.#readArtifactVerified(artifactId));
          } catch (error) {
            if (isUnsafeStateError(error)) throw error;
            partial = true;
          }
        }
        this.#telemetry?.recordObservationSearch({
          durationMs: performance.now() - startedAt,
          candidates: candidates.size,
          artifactReads: candidates.size,
          unavailable: partial ? candidates.size - contentByArtifact.size + this.#unavailableSearchArtifacts.size : 0,
          hydrationReads,
          fallbacks: fallbackArtifacts.size,
        });
        return {
          candidateArtifactIds: candidates,
          metadata: [...this.#index.live.values()],
          contentByArtifact,
          partial,
        };
      }),
    );
  }

  async getMetadata(observationId: string): Promise<ArtifactMetadata | undefined> {
    await this.#validateNamespace();
    return this.#withIndexMutex(async () => {
      await this.#synchronizePathUnlocked();
      return this.#index.live.get(observationId);
    });
  }

  async getMetadataByToolCallId(sessionId: string, toolCallId: string): Promise<ArtifactMetadata | undefined> {
    await this.#validateNamespace();
    return this.#withIndexMutex(async () => {
      await this.#synchronizePathUnlocked();
      const values = this.#index.byToolCall.get(toolCallKey(sessionId, toolCallId));
      if (values === undefined) return undefined;
      let latest: ArtifactMetadata | undefined;
      for (const value of values.values()) latest = value;
      return latest;
    });
  }

  async storageUsage(): Promise<ArtifactStorageUsage> {
    return this.#withStoreLock(async () => {
      const artifacts = await this.#listArtifactsUnlocked();
      return {
        artifactCount: artifacts.size,
        usedBytes: [...artifacts.values()].reduce((sum, artifact) => sum + artifact.size, 0),
      };
    });
  }

  async garbageCollect(options: GarbageCollectOptions): Promise<GarbageCollectResult> {
    if (!Number.isFinite(options.retentionDays) || options.retentionDays < 0)
      throw new Error("retentionDays must not be negative");
    if (!Number.isFinite(options.quotaBytes) || options.quotaBytes < 0)
      throw new Error("quotaBytes must not be negative");
    const referenced = options.referencedArtifactIds ?? new Set<string>();

    return this.#withStoreLock(async () =>
      this.#withIndexMutex(async () => {
        const registry = await this.#readActiveSessionsUnlocked();
        const leases = registry.leases.filter((lease) => this.#isProcessAlive(lease.pid));
        if (leases.length !== registry.leases.length) {
          await this.#atomicWriteFixedFile(
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
            await this.#validateArtifactShard(artifactId, false);
            const artifactPath = this.artifactPath(artifactId);
            const info = await lstat(artifactPath);
            if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe artifact entry: ${artifactPath}`);
            await this.#validateNamespace();
            await unlink(artifactPath);
          } catch (error) {
            if (errorCode(error) !== "ENOENT") {
              this.#telemetry?.recordArtifactGcFailure();
              throw error;
            }
          }
          bytesFreed += sizes.get(artifactId) ?? 0;
          await this.#faultHook?.("after-gc-unlink");
        }
        await this.#fullRebuildUnlocked();
        try {
          await this.#compactIfNeededUnlocked();
        } catch {
          this.#telemetry?.recordMetadataCompactionFailure();
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
    const source = await this.#readRegularFile(this.#activeSessionsPath, "undefined");
    return source === undefined ? { schemaVersion: 1, leases: [] } : parseActiveSessions(source);
  }

  async #readArtifactSearchIndexUnlocked(): Promise<
    { entries: Map<string, ArtifactSearchEntry>; needsRewrite: boolean } | undefined
  > {
    let source: string | undefined;
    try {
      await this.#faultHook?.("before-search-index-load");
      source = await this.#readRegularFileBounded(this.#searchIndexPath, MAX_SEARCH_INDEX_BYTES);
    } catch (error) {
      this.#telemetry?.recordObservationSearchIndexLoadFailure();
      this.#recordOperatorDiagnostic(error);
      if (isUnsafeStateError(error)) throw error;
      return { entries: new Map(), needsRewrite: true };
    }
    if (source === undefined) return undefined;
    try {
      return parseArtifactSearchSnapshot(source, this.#searchIndexMaxEntries);
    } catch (error) {
      this.#telemetry?.recordObservationSearchIndexLoadFailure();
      this.#recordOperatorDiagnostic(error);
      return { entries: new Map(), needsRewrite: true };
    }
  }

  async #loadArtifactSearchIndexUnlocked(): Promise<void> {
    if (this.#searchIndexLoaded) return;
    const pending = new Map(this.#artifactSearch);
    const persisted = await this.#readArtifactSearchIndexUnlocked();
    this.#searchIndexDirty ||= persisted === undefined || persisted.needsRewrite;
    this.#artifactSearch = new Map();
    for (const [artifactId, entry] of pending) {
      if (this.#artifactSearch.size >= this.#searchIndexMaxEntries) break;
      this.#artifactSearch.set(artifactId, entry);
    }
    for (const [artifactId, entry] of persisted?.entries ?? []) {
      if (this.#artifactSearch.size >= this.#searchIndexMaxEntries) break;
      if (!this.#artifactSearch.has(artifactId)) this.#artifactSearch.set(artifactId, entry);
    }
    this.#searchIndexLoaded = true;
  }

  #liveArtifactIdsByRecencyUnlocked(): string[] {
    const newest = new Map<string, number>();
    for (const metadata of this.#index.live.values()) {
      newest.set(metadata.artifactId, Math.max(newest.get(metadata.artifactId) ?? 0, Date.parse(metadata.updatedAt)));
    }
    return [...newest]
      .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
      .map(([artifactId]) => artifactId);
  }

  async #publishArtifactSearchIndexUnlocked(): Promise<void> {
    if (!this.#searchIndexDirty) return;
    const merged = new Map((await this.#readArtifactSearchIndexUnlocked())?.entries ?? []);
    for (const [artifactId, entry] of this.#artifactSearch) merged.set(artifactId, entry);
    let entries = this.#liveArtifactIdsByRecencyUnlocked()
      .map((artifactId) => [artifactId, merged.get(artifactId)] as const)
      .filter((entry): entry is readonly [string, ArtifactSearchEntry] => entry[1] !== undefined)
      .slice(0, this.#searchIndexMaxEntries)
      .map(([artifactId, entry]) => ({ artifactId, bloom: Buffer.from(entry.bloom).toString("base64") }));
    let serialized = "";
    while (true) {
      const checksum = artifactSearchSnapshotChecksum(entries);
      const snapshot: ArtifactSearchIndexSnapshot = {
        schemaVersion: 1,
        algorithm: SEARCH_INDEX_ALGORITHM,
        gramLength: SEARCH_GRAM_LENGTH,
        bloomBytes: SEARCH_BLOOM_BYTES,
        hashCount: SEARCH_BLOOM_HASHES,
        maxEntries: SEARCH_INDEX_MAX_ENTRIES,
        entries,
        checksum,
      };
      serialized = JSON.stringify(snapshot);
      if (Buffer.byteLength(serialized, "utf8") <= MAX_SEARCH_INDEX_BYTES) break;
      entries = entries.slice(0, -1);
    }
    this.#artifactSearch = new Map(
      entries.map((entry) => [entry.artifactId, { bloom: new Uint8Array(Buffer.from(entry.bloom, "base64")) }]),
    );
    try {
      await this.#faultHook?.("before-search-index-publication");
      await this.#atomicWriteFixedFile(this.#searchIndexPath, serialized);
      this.#searchIndexDirty = false;
    } catch (error) {
      if (isUnsafeStateError(error)) throw error;
      this.#telemetry?.recordObservationSearchIndexWriteFailure();
      this.#recordOperatorDiagnostic(error);
      this.#searchIndexDirty = true;
    }
  }

  #removeArtifactSearch(artifactId: string): void {
    if (this.#artifactSearch.delete(artifactId)) this.#searchIndexDirty = true;
  }

  #indexArtifactSearch(artifactId: string, content: string): void {
    if (this.#artifactSearch.has(artifactId)) return;
    this.#artifactSearch.set(artifactId, { bloom: buildSearchBloom(content) });
    const allowed = new Set(this.#liveArtifactIdsByRecencyUnlocked().slice(0, this.#searchIndexMaxEntries));
    for (const indexedArtifactId of this.#artifactSearch.keys()) {
      if (!allowed.has(indexedArtifactId)) this.#artifactSearch.delete(indexedArtifactId);
    }
    this.#unavailableSearchArtifacts.delete(artifactId);
    this.#searchIndexDirty = true;
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
      handle = (await this.#openRegularFile(this.#metadataPath, constants.O_RDONLY)).handle;
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
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
    await this.#validateNamespace();
    const openedFile = await this.#openRegularFile(
      this.#metadataPath,
      constants.O_RDWR | constants.O_CREAT,
      0o600,
      false,
    );
    const { handle, existed } = openedFile;
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
    await this.#atomicWriteFixedFile(this.#metadataPath, content);
    this.#index = emptyIndex();
    await this.#faultHook?.("after-compaction-replace");
    await this.#synchronizePathUnlocked();
    this.#telemetry?.recordMetadataCompaction(performance.now() - startedAt, before, content.length);
  }

  async #listArtifactsUnlocked(): Promise<Map<string, { modifiedAt: number; size: number }>> {
    const artifacts = new Map<string, { modifiedAt: number; size: number }>();
    await this.#validateNamespace();
    const shards: Dirent[] = await readdir(this.#artifactsRoot, { withFileTypes: true });
    for (const shard of shards) {
      if (!/^[a-f0-9]{2}$/.test(shard.name)) continue;
      const shardPath = join(this.#artifactsRoot, shard.name);
      if (!shard.isDirectory() || shard.isSymbolicLink()) throw new Error(`Unsafe artifact shard: ${shardPath}`);
      await this.#validateArtifactShard(`${shard.name}${"0".repeat(62)}`, false);
      for (const entry of await readdir(shardPath, { withFileTypes: true })) {
        const match = /^([a-f0-9]{64})\.txt$/.exec(entry.name);
        if (match?.[1] === undefined) continue;
        const artifactId = match[1];
        const artifactPath = join(shardPath, entry.name);
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Unsafe artifact entry: ${artifactPath}`);
        await this.#validateArtifactShard(artifactId, false);
        const opened = await this.#openRegularFile(artifactPath, constants.O_RDONLY, undefined, false);
        try {
          const info = await opened.handle.stat();
          artifacts.set(artifactId, { modifiedAt: info.mtimeMs, size: info.size });
        } finally {
          await opened.handle.close();
        }
      }
    }
    return artifacts;
  }
}
