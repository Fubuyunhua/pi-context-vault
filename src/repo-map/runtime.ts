import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import chokidar, { type FSWatcher } from "chokidar";
import { atomicWriteFile, withFileLock } from "../state/atomic.js";
import type { Telemetry } from "../telemetry.js";
import {
  buildRepoMap,
  indexRepoMapFile,
  isRepoMapFileAdmitted,
  isRepoMapPathExcluded,
  loadRootGitignorePatterns,
  type RepoMapFile,
  type RepoMapFileSystem,
  type RepoMapIndexOptions,
  type RepoMapIndexOutcome,
  type RepoMapQueryOptions,
  type RepoMapQueryResult,
  RepoMapSearch,
  type RepoMapSnapshot,
  type RepoMapWarning,
} from "./index.js";

const execFileAsync = promisify(execFile);
const DELETED_HASH = "deleted";
// A freshness request performs at most this many complete reconciliation
// passes and consumes at most this many already-queued watcher updates per pass.
// Remaining work is kept stale/pending and rescheduled rather than starving a turn.
const MAX_FLUSH_PASSES = 8;
const MAX_WATCHER_UPDATES_PER_PASS = 64;
const MAX_FLUSH_DURATION_MS = 1_000;

export type RepoMapFreshness = "fresh" | "dirty" | "stale" | "unsupported";
export type RepoMapChangeEvent = "add" | "change" | "unlink";

export interface RepoMapWatcher {
  on(event: RepoMapChangeEvent, listener: (path: string) => void): RepoMapWatcher;
  ready?(): Promise<void>;
  close(): Promise<void>;
}

export interface RepoMapScheduler {
  schedule(delayMs: number, task: () => void): unknown;
  cancel(handle: unknown): void;
}

export interface RepoMapGeneration {
  schemaVersion: 1;
  generation: number;
  gitHead: string;
  dirtyFiles: Array<{ path: string; contentHash: string }>;
  workspaceRevision: string;
  freshness: RepoMapFreshness;
  pendingFiles: string[];
  snapshot: RepoMapSnapshot;
  activatedAt: string;
}

export interface RepoMapFallbackEvidence {
  kind: "source" | "git-diff";
  path?: string;
  excerpt: string;
}

export interface RepoMapMaintenanceResult {
  activeGeneration: number;
  deletedGenerations: number[];
  bytesFreed: number;
  remainingGenerations: number;
  remainingBytes: number;
  quotaSatisfied: boolean;
}

export interface RepoMapRuntimeQuery {
  results: RepoMapQueryResult[];
  freshness: RepoMapFreshness;
  generation: number;
  gitHead: string;
  workspaceRevision: string;
  pendingFiles: string[];
  fallbackEvidence: RepoMapFallbackEvidence[];
  error?: string;
}

export type RepoMapGitRunner = (
  projectRoot: string,
  args: readonly string[],
  encoding: "utf8" | "buffer",
  maxBuffer?: number,
) => Promise<{ stdout: string | Buffer }>;

export interface RepoMapRuntimeOptions {
  projectRoot: string;
  stateRoot: string;
  exclude?: string[];
  mapDebounceMs?: number;
  mapGenerationRetention?: number;
  mapQuotaBytes?: number;
  watch?: boolean;
  watcherFactory?: (root: string) => RepoMapWatcher;
  scheduler?: RepoMapScheduler;
  atomicWriter?: typeof atomicWriteFile;
  /** Injectable file operations used by incremental indexing. */
  indexFileSystem?: RepoMapFileSystem;
  /** Injectable Git subprocess dependency used by deterministic telemetry tests. */
  gitRunner?: RepoMapGitRunner;
  /** Injectable MiniSearch construction dependency used by deterministic telemetry tests. */
  searchFactory?: (snapshot: RepoMapSnapshot) => RepoMapSearch;
  now?: () => Date;
  /** Injectable monotonic clock used for deterministic telemetry tests. */
  monotonicNow?: () => number;
  telemetry?: Telemetry;
}

const defaultScheduler: RepoMapScheduler = {
  schedule(delayMs, task) {
    const handle = setTimeout(task, delayMs);
    handle.unref();
    return handle;
  },
  cancel(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

function slash(path: string): string {
  return path.split(sep).join("/");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** True when a complete path segment is excluded from repository maps and watching. */
export function isWatcherIgnoredPath(path: string): boolean {
  return isRepoMapPathExcluded(path.replaceAll("\\", "/"));
}

/** Error codes that are expected during normal operation (e.g. git lock files on Windows). */
const WATCHER_TRANSIENT_CODES = new Set(["EPERM", "EACCES", "ENOENT", "ENOTDIR"]);

function watcher(root: string): RepoMapWatcher {
  const fsWatcher = chokidar.watch(root, {
    ignoreInitial: true,
    // On Windows, transient entries such as git lock files (`.git/t88JaC0`) are
    // held exclusively by other processes and fs.watch throws EPERM/EACCES for
    // them. chokidar suppresses those errors when this option is set.
    ignorePermissionErrors: true,
    ignored: isWatcherIgnoredPath,
  }) as FSWatcher;
  // chokidar emits `error` for watch failures (EMFILE, ELOOP, ...). Without a
  // listener, EventEmitter rethrows, which previously crashed the host process
  // as an uncaughtException when Windows reported EPERM for a git lock file.
  fsWatcher.on("error", (error: unknown) => {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === undefined || !WATCHER_TRANSIENT_CODES.has(code)) {
      console.error("[context-vault] repo map watcher error:", error);
    }
  });
  const ready = new Promise<void>((resolveReady) => fsWatcher.once("ready", () => resolveReady()));
  return {
    on(event, listener) {
      fsWatcher.on(event, listener);
      return this;
    },
    ready: () => ready,
    close: () => fsWatcher.close(),
  };
}

const defaultGitRunner: RepoMapGitRunner = async (projectRoot, args, encoding, maxBuffer) => {
  const result = await execFileAsync("git", [...args], {
    cwd: projectRoot,
    encoding,
    ...(maxBuffer === undefined ? {} : { maxBuffer }),
  });
  return { stdout: result.stdout };
};

function recordTelemetry(telemetry: Telemetry | undefined, record: (telemetry: Telemetry) => void): void {
  if (!telemetry) return;
  try {
    record(telemetry);
  } catch {
    // Telemetry is best-effort and must never affect runtime behavior.
  }
}

function monotonicReading(now: () => number): number | undefined {
  try {
    const value = now();
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function monotonicDuration(now: () => number, startedAt: number | undefined): number {
  const finishedAt = monotonicReading(now);
  return startedAt === undefined || finishedAt === undefined ? 0 : Math.max(0, finishedAt - startedAt);
}

async function gitHead(
  projectRoot: string,
  runner: RepoMapGitRunner,
  telemetry?: Telemetry,
  now = performance.now.bind(performance),
): Promise<string> {
  const startedAt = monotonicReading(now);
  try {
    const { stdout } = await runner(projectRoot, ["rev-parse", "HEAD"], "utf8");
    return stdout.toString().trim();
  } catch {
    return "no-head";
  } finally {
    recordTelemetry(telemetry, (target) => target.recordGitHead(monotonicDuration(now, startedAt)));
  }
}

async function gitDiff(
  projectRoot: string,
  runner: RepoMapGitRunner,
  telemetry?: Telemetry,
  now = performance.now.bind(performance),
): Promise<string> {
  const startedAt = monotonicReading(now);
  try {
    const { stdout } = await runner(projectRoot, ["diff", "--no-ext-diff", "--unified=1", "--"], "utf8", 1024 * 1024);
    return stdout.toString().slice(0, 16 * 1024);
  } catch {
    return "";
  } finally {
    recordTelemetry(telemetry, (target) => target.recordGitDiff(monotonicDuration(now, startedAt)));
  }
}

interface GitDirtyPath {
  path: string;
  tracked: boolean;
}

async function gitDirtyPaths(
  projectRoot: string,
  runner: RepoMapGitRunner,
  telemetry?: Telemetry,
  now = performance.now.bind(performance),
): Promise<GitDirtyPath[] | undefined> {
  const startedAt = monotonicReading(now);
  try {
    const { stdout } = await runner(
      projectRoot,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      "buffer",
      16 * 1024 * 1024,
    );
    const records = stdout.toString("utf8").split("\0").filter(Boolean);
    const paths = new Map<string, boolean>();
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index] as string;
      const status = record.slice(0, 2);
      const tracked = status !== "??";
      const path = record.slice(3);
      if (path) paths.set(slash(path), tracked);
      if (status.includes("R") || status.includes("C")) {
        const source = records[index + 1] ?? "";
        if (source) paths.set(slash(source), true);
        index += 1;
      }
    }
    return [...paths]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, tracked]) => ({ path, tracked }));
  } catch {
    return undefined;
  } finally {
    recordTelemetry(telemetry, (target) => target.recordGitDirty(monotonicDuration(now, startedAt)));
  }
}

function revision(head: string, dirtyFiles: ReadonlyMap<string, string>): string {
  const entries = [...dirtyFiles].sort(([left], [right]) => left.localeCompare(right));
  return hash([head, ...entries.map(([path, contentHash]) => `${path}\0${contentHash}`)].join("\0"));
}

function replaceFile(snapshot: RepoMapSnapshot, path: string, file?: RepoMapFile, warning?: RepoMapWarning): void {
  snapshot.files = snapshot.files.filter((candidate) => candidate.path !== path);
  snapshot.warnings = snapshot.warnings.filter((candidate) => candidate.path !== path);
  if (file) snapshot.files.push(file);
  if (warning) snapshot.warnings.push(warning);
  snapshot.files.sort((left, right) => left.path.localeCompare(right.path));
  snapshot.warnings.sort((left, right) => left.path.localeCompare(right.path));
}

function replaceWarning(snapshot: RepoMapSnapshot, path: string, warning?: RepoMapWarning): void {
  snapshot.warnings = snapshot.warnings.filter((candidate) => candidate.path !== path);
  if (warning) snapshot.warnings.push(warning);
  snapshot.warnings.sort((left, right) => left.path.localeCompare(right.path));
}

function cloneSnapshot(snapshot: RepoMapSnapshot): RepoMapSnapshot {
  return structuredClone(snapshot);
}

function semanticGeneration(generation: RepoMapGeneration): string {
  const { activatedAt: _activatedAt, generation: _generation, snapshot, ...durable } = generation;
  const { generatedAt: _generatedAt, ...provenance } = snapshot.provenance;
  return JSON.stringify({
    ...durable,
    snapshot: { ...snapshot, provenance },
  });
}

const REPO_MAP_FILE_KINDS = new Set(["semantic", "lexical"]);
const REPO_MAP_LANGUAGES = new Set(["typescript", "javascript", "java", "text"]);
const REPO_MAP_SYMBOL_KINDS = new Set([
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "variable",
  "namespace",
  "record",
  "annotation",
  "constructor",
  "method",
  "field",
  "enum-constant",
]);
const REPO_MAP_WARNING_CODES = new Set(["parse-error", "read-error"]);
const REPO_MAP_FRESHNESS = new Set(["fresh", "dirty", "stale", "unsupported"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const INVALID_GENERATION_MESSAGE = "invalid active repository map generation metadata";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isRepoMapImport(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.source === "string" &&
    isStringArray(value.names) &&
    typeof value.typeOnly === "boolean" &&
    isOptionalBoolean(value.static) &&
    isOptionalBoolean(value.wildcard)
  );
}

function isRepoMapExport(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    isOptionalString(value.source) &&
    typeof value.typeOnly === "boolean"
  );
}

function isRepoMapRelationships(value: unknown): boolean {
  return (
    isRecord(value) && isStringArray(value.extends) && isStringArray(value.implements) && isStringArray(value.permits)
  );
}

function isRepoMapSymbol(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.kind === "string" &&
    REPO_MAP_SYMBOL_KINDS.has(value.kind) &&
    typeof value.signature === "string" &&
    typeof value.exported === "boolean" &&
    Number.isSafeInteger(value.line) &&
    (value.line as number) > 0 &&
    isOptionalString(value.container) &&
    (value.annotations === undefined || isStringArray(value.annotations)) &&
    (value.modifiers === undefined || isStringArray(value.modifiers)) &&
    (value.typeParameters === undefined || isStringArray(value.typeParameters)) &&
    (value.relationships === undefined || isRepoMapRelationships(value.relationships))
  );
}

function isRepoMapFile(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.kind === "string" &&
    REPO_MAP_FILE_KINDS.has(value.kind) &&
    typeof value.language === "string" &&
    REPO_MAP_LANGUAGES.has(value.language) &&
    typeof value.contentHash === "string" &&
    SHA256_PATTERN.test(value.contentHash) &&
    Number.isSafeInteger(value.sizeBytes) &&
    (value.sizeBytes as number) >= 0 &&
    isStringArray(value.lexicalTerms) &&
    Array.isArray(value.imports) &&
    value.imports.every(isRepoMapImport) &&
    Array.isArray(value.exports) &&
    value.exports.every(isRepoMapExport) &&
    Array.isArray(value.symbols) &&
    value.symbols.every(isRepoMapSymbol) &&
    isStringArray(value.dependencies) &&
    isOptionalString(value.packageName) &&
    isOptionalString(value.degradedReason)
  );
}

function isRepoMapWarning(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.code === "string" &&
    REPO_MAP_WARNING_CODES.has(value.code) &&
    typeof value.message === "string"
  );
}

function isRepoMapSnapshot(value: unknown): value is RepoMapSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.provenance)) return false;
  const provenance = value.provenance;
  return (
    provenance.generator === "pi-context-vault" &&
    // This is a persisted-format compatibility version, not the package version. Keep compatible generations valid.
    provenance.generatorVersion === "0.1.0" &&
    provenance.parser === "typescript-compiler-api" &&
    typeof provenance.typescriptVersion === "string" &&
    (provenance.javaParser === undefined || provenance.javaParser === "java-parser@3.0.1") &&
    typeof provenance.generatedAt === "string" &&
    Number.isFinite(Date.parse(provenance.generatedAt)) &&
    typeof provenance.projectRoot === "string" &&
    Array.isArray(value.files) &&
    value.files.every(isRepoMapFile) &&
    Array.isArray(value.warnings) &&
    value.warnings.every(isRepoMapWarning)
  );
}

function isRepoMapGeneration(value: unknown, expectedGeneration: number): value is RepoMapGeneration {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    Number.isSafeInteger(value.generation) &&
    (value.generation as number) > 0 &&
    value.generation === expectedGeneration &&
    typeof value.gitHead === "string" &&
    Array.isArray(value.dirtyFiles) &&
    value.dirtyFiles.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.path === "string" &&
        typeof entry.contentHash === "string" &&
        (SHA256_PATTERN.test(entry.contentHash) || entry.contentHash === DELETED_HASH),
    ) &&
    typeof value.workspaceRevision === "string" &&
    SHA256_PATTERN.test(value.workspaceRevision) &&
    typeof value.freshness === "string" &&
    REPO_MAP_FRESHNESS.has(value.freshness) &&
    isStringArray(value.pendingFiles) &&
    isRepoMapSnapshot(value.snapshot) &&
    typeof value.activatedAt === "string" &&
    Number.isFinite(Date.parse(value.activatedAt))
  );
}

interface GenerationFile {
  generation: number;
  path: string;
  bytes: number;
}

interface CachedFileOutcome {
  fingerprint: string;
  outcome: RepoMapIndexOutcome;
}

interface FileFingerprint {
  value: string;
  reusable: boolean;
}

interface PendingWatcherUpdate {
  event: RepoMapChangeEvent;
  path: string;
}

function searchableContent(snapshot: RepoMapSnapshot | undefined): string {
  return JSON.stringify(snapshot?.files ?? []);
}

export class RepoMapRuntime {
  readonly #options: Required<
    Pick<RepoMapRuntimeOptions, "mapDebounceMs" | "mapGenerationRetention" | "mapQuotaBytes" | "watch">
  > &
    RepoMapRuntimeOptions;
  readonly #scheduler: RepoMapScheduler;
  readonly #atomicWriter: typeof atomicWriteFile;
  readonly #telemetry?: Telemetry;
  readonly #monotonicNow: () => number;
  readonly #gitRunner: RepoMapGitRunner;
  readonly #searchFactory: (snapshot: RepoMapSnapshot) => RepoMapSearch;
  #projectRoot = "";
  #base?: RepoMapSnapshot;
  #effective?: RepoMapSnapshot;
  #head = "no-head";
  #generation = 0;
  #dirty = new Map<string, string>();
  #pending = new Set<string>();
  #readFailures = new Map<string, RepoMapWarning>();
  #fileOutcomes = new Map<string, CachedFileOutcome>();
  /** Monotonic runtime-local version of snapshot.files, independent of object and generation identity. */
  #effectiveContentVersion = 0;
  #searchVersion = -1;
  #search?: RepoMapSearch;
  #gitWorkspace?: boolean;
  #nonGitIgnorePatterns: string[] = [];
  #freshness: RepoMapFreshness = "stale";
  #error?: string;
  #maintenance?: RepoMapMaintenanceResult | { error: string };
  #watcher?: RepoMapWatcher;
  #scheduled?: unknown;
  #watcherUpdates: PendingWatcherUpdate[] = [];
  #mutationEpoch = 0;
  #started = false;
  #flushChain: Promise<void> = Promise.resolve();

  constructor(options: RepoMapRuntimeOptions) {
    if (!Number.isInteger(options.mapDebounceMs ?? 300) || (options.mapDebounceMs ?? 300) <= 0) {
      throw new Error("mapDebounceMs must be a positive integer");
    }
    if (!Number.isSafeInteger(options.mapGenerationRetention ?? 3) || (options.mapGenerationRetention ?? 3) <= 0) {
      throw new Error("mapGenerationRetention must be a positive safe integer");
    }
    if (
      !Number.isSafeInteger(options.mapQuotaBytes ?? 128 * 1024 * 1024) ||
      (options.mapQuotaBytes ?? 128 * 1024 * 1024) <= 0
    ) {
      throw new Error("mapQuotaBytes must be a positive safe integer");
    }
    this.#options = {
      ...options,
      mapDebounceMs: options.mapDebounceMs ?? 300,
      mapGenerationRetention: options.mapGenerationRetention ?? 3,
      mapQuotaBytes: options.mapQuotaBytes ?? 128 * 1024 * 1024,
      watch: options.watch ?? true,
    };
    this.#scheduler = options.scheduler ?? defaultScheduler;
    this.#atomicWriter = options.atomicWriter ?? atomicWriteFile;
    this.#telemetry = options.telemetry;
    this.#monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
    this.#gitRunner = options.gitRunner ?? defaultGitRunner;
    this.#searchFactory = options.searchFactory ?? ((snapshot) => new RepoMapSearch(snapshot));
  }

  async start(): Promise<void> {
    this.#projectRoot = await realpath(resolve(this.#options.projectRoot));
    await mkdir(this.#options.stateRoot, { recursive: true, mode: 0o700 });
    await this.#reconcileGenerationBytes();
    await this.#hydratePriorGeneration();
    if (this.#options.watch) {
      this.#watcher = (this.#options.watcherFactory ?? watcher)(this.#projectRoot);
      for (const event of ["add", "change", "unlink"] as const) {
        this.#watcher.on(event, (path) => this.notify(event, path));
      }
      await this.#watcher.ready?.();
    }
    await this.#rebuildBase();
    this.#started = true;
    await this.flush();
  }

  notify(event: RepoMapChangeEvent, changedPath: string): void {
    const path = slash(isAbsolute(changedPath) ? relative(this.#projectRoot, changedPath) : changedPath);
    if (!path || path.startsWith("../") || isRepoMapPathExcluded(path, this.#options.exclude)) return;
    this.#pending.add(path);
    this.#freshness = "stale";
    this.#watcherUpdates.push({ event, path });
    this.#mutationEpoch += 1;
    if (this.#started) this.#scheduleFlush();
  }

  #scheduleFlush(): void {
    if (this.#scheduled !== undefined) this.#scheduler.cancel(this.#scheduled);
    this.#scheduled = this.#scheduler.schedule(this.#options.mapDebounceMs, () => {
      this.#scheduled = undefined;
      void this.flush();
    });
  }

  async flush(): Promise<void> {
    const operation = this.#flushChain.then(() => this.#flush());
    this.#flushChain = operation.catch(() => undefined);
    await operation;
  }

  async #drainWatcherUpdates(): Promise<void> {
    // Snapshot a bounded batch. Notifications received while it is processed
    // belong to a later pass, preventing an event producer from extending this
    // drain indefinitely.
    const updates = this.#watcherUpdates.splice(0, MAX_WATCHER_UPDATES_PER_PASS);
    for (const update of updates) {
      try {
        await this.#fastUpdate(update.event, update.path);
      } catch (error) {
        this.#degrade(error);
      }
    }
    // An older update for a path can clear pending while a newer one is queued.
    // Reassert every queued path as explicit stale evidence.
    for (const { path } of this.#watcherUpdates) this.#pending.add(path);
  }

  #deferRemainingFlushWork(): void {
    for (const { path } of this.#watcherUpdates) this.#pending.add(path);
    this.#freshness = "stale";
    if (this.#started && this.#watcherUpdates.length > 0) this.#scheduleFlush();
  }

  async #flush(): Promise<void> {
    if (this.#scheduled !== undefined) {
      this.#scheduler.cancel(this.#scheduled);
      this.#scheduled = undefined;
    }
    const startedAt = performance.now();
    for (let pass = 1; ; pass += 1) {
      const epoch = this.#mutationEpoch;
      await this.#drainWatcherUpdates();
      const currentHead = await gitHead(this.#projectRoot, this.#gitRunner, this.#telemetry, this.#monotonicNow);
      if (currentHead !== this.#head) {
        await this.#rebuildBase();
      } else {
        const reconciled = await this.#reconcileDirtyOverlay();
        const previousFreshness = this.#freshness;
        this.#freshness = this.#computedFreshness();
        if (this.#pending.size > 0 || previousFreshness !== this.#freshness || reconciled) {
          try {
            await this.#activate();
            if (this.#readFailures.size === 0) this.#error = undefined;
          } catch (error) {
            this.#degrade(error);
          }
        }
      }
      // No notification can interleave between this synchronous check and
      // promise resolution. A notification observed during any awaited phase
      // changes the epoch and normally forces another complete pass.
      if (epoch === this.#mutationEpoch && this.#watcherUpdates.length === 0) return;
      if (pass >= MAX_FLUSH_PASSES || performance.now() - startedAt >= MAX_FLUSH_DURATION_MS) {
        this.#deferRemainingFlushWork();
        return;
      }
    }
  }

  async ensureFresh(): Promise<void> {
    const startedAt = monotonicReading(this.#monotonicNow);
    try {
      await this.flush();
    } finally {
      recordTelemetry(this.#telemetry, (telemetry) =>
        telemetry.recordEnsureFresh(monotonicDuration(this.#monotonicNow, startedAt)),
      );
    }
  }

  /** Rebuild the base snapshot and atomically activate it as a new generation. */
  async rebuild(): Promise<void> {
    const operation = this.#flushChain.then(async () => {
      await this.#rebuildBase();
      await this.#flush();
    });
    this.#flushChain = operation.catch(() => undefined);
    await operation;
  }

  /** Live query path used by the explicit tool: reconcile Git and watcher work first. */
  async query(query: string, options: RepoMapQueryOptions = {}): Promise<RepoMapRuntimeQuery> {
    const startedAt = monotonicReading(this.#monotonicNow);
    try {
      await this.ensureFresh();
      return await this.#queryCurrentUninstrumented(query, options, true);
    } finally {
      recordTelemetry(this.#telemetry, (telemetry) =>
        telemetry.recordRepoMapQuery(monotonicDuration(this.#monotonicNow, startedAt)),
      );
    }
  }

  /** Query the current coherent snapshot without another freshness reconciliation. */
  async queryCurrent(query: string, options: RepoMapQueryOptions = {}): Promise<RepoMapRuntimeQuery> {
    const startedAt = monotonicReading(this.#monotonicNow);
    try {
      return await this.#queryCurrentUninstrumented(query, options, false);
    } finally {
      recordTelemetry(this.#telemetry, (telemetry) =>
        telemetry.recordRepoMapQuery(monotonicDuration(this.#monotonicNow, startedAt)),
      );
    }
  }

  async #queryCurrentUninstrumented(
    query: string,
    options: RepoMapQueryOptions,
    liveFallback: boolean,
  ): Promise<RepoMapRuntimeQuery> {
    // Capture all query-visible state before the first await. Automatic
    // queryCurrent calls derive fallback excerpts only from this indexed
    // snapshot; explicit live queries may additionally read source/Git bytes.
    const files = this.#effective?.files ?? [];
    const freshness = this.#freshness;
    const generation = this.#generation;
    const gitHead = this.#head;
    const workspaceRevision = revision(gitHead, this.#dirty);
    const pendingFiles = [...this.#pending].sort();
    const error = this.#error;
    const fallbackEvidence: RepoMapFallbackEvidence[] = [];
    let results: RepoMapQueryResult[] = [];
    if (this.#effective) {
      if (!this.#search || this.#searchVersion !== this.#effectiveContentVersion) {
        const startedAt = monotonicReading(this.#monotonicNow);
        try {
          this.#search = this.#searchFactory(this.#effective);
          this.#searchVersion = this.#effectiveContentVersion;
        } finally {
          recordTelemetry(this.#telemetry, (telemetry) =>
            telemetry.recordSearchIndexBuild(monotonicDuration(this.#monotonicNow, startedAt)),
          );
        }
      }
      results = this.#search.query(query, options);
    }
    if (freshness === "stale") {
      const terms = query.toLowerCase().match(/[\p{L}\p{N}_$-]{2,}/gu) ?? [];
      for (const file of files) {
        if (terms.some((term) => file.lexicalTerms.includes(term))) {
          let excerpt = file.lexicalTerms.slice(0, 40).join(" ");
          if (liveFallback) {
            try {
              const content = this.#options.indexFileSystem
                ? await this.#options.indexFileSystem.readFile(join(this.#projectRoot, file.path))
                : await readFile(join(this.#projectRoot, file.path));
              excerpt = content.toString("utf8").slice(0, 4 * 1024);
            } catch {
              // Indexed terms remain useful when a live source read fails.
            }
          }
          fallbackEvidence.push({ kind: "source", path: file.path, excerpt });
          if (fallbackEvidence.length >= 3) break;
        }
      }
      if (liveFallback) {
        const diff = await gitDiff(this.#projectRoot, this.#gitRunner, this.#telemetry, this.#monotonicNow);
        if (diff) fallbackEvidence.push({ kind: "git-diff", excerpt: diff });
      }
      if (fallbackEvidence.length === 0) {
        const firstFile = files[0];
        if (firstFile) {
          let excerpt = firstFile.lexicalTerms.slice(0, 40).join(" ");
          if (liveFallback) {
            try {
              const content = this.#options.indexFileSystem
                ? await this.#options.indexFileSystem.readFile(join(this.#projectRoot, firstFile.path))
                : await readFile(join(this.#projectRoot, firstFile.path));
              excerpt = content.toString("utf8").slice(0, 4 * 1024);
            } catch {
              // Indexed terms remain useful when a live source read fails.
            }
          }
          fallbackEvidence.push({ kind: "source", path: firstFile.path, excerpt });
        } else {
          fallbackEvidence.push({
            kind: "source",
            excerpt: "No indexed source file is available; use direct filesystem search.",
          });
        }
      }
    }
    return {
      results,
      freshness,
      generation,
      gitHead,
      workspaceRevision,
      pendingFiles,
      fallbackEvidence,
      ...(error ? { error } : {}),
    };
  }

  status(): Omit<RepoMapRuntimeQuery, "results" | "fallbackEvidence"> & {
    dirtyFiles: string[];
    maintenance?: RepoMapMaintenanceResult | { error: string };
  } {
    return {
      freshness: this.#freshness,
      generation: this.#generation,
      gitHead: this.#head,
      workspaceRevision: revision(this.#head, this.#dirty),
      pendingFiles: [...this.#pending].sort(),
      dirtyFiles: [...this.#dirty.keys()].sort(),
      ...(this.#maintenance ? { maintenance: this.#maintenance } : {}),
      ...(this.#error ? { error: this.#error } : {}),
    };
  }

  async maintenance(): Promise<RepoMapMaintenanceResult> {
    try {
      const result = await withFileLock(join(this.#options.stateRoot, "activation.lock"), async () => {
        const active = await loadActiveRepoMapGeneration(this.#options.stateRoot);
        return this.#pruneUnlocked(active.generation);
      });
      this.#maintenance = result;
      return result;
    } catch (error) {
      this.#maintenance = { error: error instanceof Error ? error.message : String(error) };
      recordTelemetry(this.#telemetry, (telemetry) => telemetry.recordMaintenanceFailure());
      throw error;
    }
  }

  async close(): Promise<void> {
    this.#started = false;
    if (this.#scheduled !== undefined) this.#scheduler.cancel(this.#scheduled);
    this.#scheduled = undefined;
    await this.#watcher?.close();
    this.#watcher = undefined;
    await this.flush();
  }

  async #fastUpdate(event: RepoMapChangeEvent, path: string): Promise<void> {
    if (!this.#effective) throw new Error("repository map runtime has not started");
    if (path === ".gitignore") this.#fileOutcomes.clear();
    if (path === ".gitignore" && this.#gitWorkspace === false) {
      await this.#refreshNonGitIgnorePatterns();
      await this.#rebuildBase();
      return;
    }
    this.#fileOutcomes.delete(path);
    if (event === "unlink") {
      this.#mutateEffective(() => replaceFile(this.#effective as RepoMapSnapshot, path));
      this.#readFailures.delete(path);
      this.#pending.delete(path);
      if (this.#base?.files.some((file) => file.path === path)) this.#dirty.set(path, DELETED_HASH);
      else this.#dirty.delete(path);
      this.#fileOutcomes.set(path, { fingerprint: "missing", outcome: { kind: "missing" } });
      return;
    }
    const outcome = await this.#indexPath(path, this.#indexOptions(), false);
    this.#applyOutcome(path, outcome);
  }

  #applyOutcome(path: string, outcome: RepoMapIndexOutcome): void {
    if (!this.#effective) return;
    const baseHash = this.#base?.files.find((file) => file.path === path)?.contentHash;
    if (outcome.kind === "read-error") {
      this.#mutateEffective(() => replaceWarning(this.#effective as RepoMapSnapshot, path, outcome.warning));
      this.#readFailures.set(path, outcome.warning);
      this.#pending.add(path);
      this.#error = outcome.warning.message;
      return;
    }

    this.#readFailures.delete(path);
    this.#pending.delete(path);
    if (outcome.kind === "indexed") {
      this.#mutateEffective(() => replaceFile(this.#effective as RepoMapSnapshot, path, outcome.file, outcome.warning));
      if (outcome.file.contentHash !== baseHash) this.#dirty.set(path, outcome.file.contentHash);
      else this.#dirty.delete(path);
      return;
    }
    if (outcome.kind === "ignored") {
      this.#mutateEffective(() => replaceFile(this.#effective as RepoMapSnapshot, path));
      this.#dirty.delete(path);
      return;
    }

    this.#mutateEffective(() => replaceFile(this.#effective as RepoMapSnapshot, path));
    if (!baseHash) {
      this.#dirty.delete(path);
    } else if (outcome.kind === "missing") {
      this.#dirty.set(path, DELETED_HASH);
    } else if (outcome.kind === "non-text") {
      this.#dirty.set(path, outcome.contentHash);
    } else {
      this.#dirty.set(path, hash(`non-regular\0${path}`));
    }
  }

  #mutateEffective(mutation: () => void): void {
    const before = searchableContent(this.#effective);
    mutation();
    if (searchableContent(this.#effective) !== before) this.#effectiveContentVersion += 1;
  }

  #replaceEffective(snapshot: RepoMapSnapshot): void {
    const before = searchableContent(this.#effective);
    this.#effective = snapshot;
    if (searchableContent(snapshot) !== before) this.#effectiveContentVersion += 1;
  }

  async #fileFingerprint(path: string): Promise<FileFingerprint | undefined> {
    try {
      const info = this.#options.indexFileSystem
        ? await this.#options.indexFileSystem.lstat(join(this.#projectRoot, path))
        : await lstat(join(this.#projectRoot, path), { bigint: true });
      const size = info.size;
      const mtime = info.mtimeNs ?? info.mtimeMs;
      const ctime = info.ctimeNs ?? info.ctimeMs;
      if ((typeof size !== "number" && typeof size !== "bigint") || mtime === undefined || ctime === undefined) {
        return undefined;
      }
      const highPrecision =
        typeof info.mtimeNs === "bigint" &&
        typeof info.ctimeNs === "bigint" &&
        info.ino !== undefined &&
        info.dev !== undefined;
      return {
        value: [
          info.isFile() ? "file" : "non-regular",
          size.toString(),
          mtime.toString(),
          ctime.toString(),
          info.mode?.toString() ?? "",
          info.ino?.toString() ?? "",
          info.dev?.toString() ?? "",
        ].join(":"),
        // Millisecond-only or identity-poor metadata can alias after a rapid,
        // same-size rewrite, so it is evidence for change but never for reuse.
        reusable: highPrecision,
      };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? { value: "missing", reusable: true } : undefined;
    }
  }

  async #indexPath(path: string, options: RepoMapIndexOptions, useCache = true): Promise<RepoMapIndexOutcome> {
    const before = await this.#fileFingerprint(path);
    const cached = this.#fileOutcomes.get(path);
    if (
      useCache &&
      before?.reusable === true &&
      cached?.fingerprint === before.value &&
      cached.outcome.kind !== "read-error"
    ) {
      // Fingerprints establish content stability, not current admission. Git
      // ignore sources and supplied root patterns can change without touching
      // this path or its watcher. Static built-in/config excludes were already
      // authoritative when this cache entry was created.
      const admissionCanChange = (options.checkGitIgnore ?? true) || options.gitignorePatterns !== undefined;
      if (admissionCanChange && !(await isRepoMapFileAdmitted(this.#projectRoot, path, options))) {
        this.#fileOutcomes.delete(path);
        return { kind: "ignored" };
      }
      return cached.outcome;
    }

    const outcome = await indexRepoMapFile(this.#projectRoot, path, options);
    recordTelemetry(this.#telemetry, (telemetry) => telemetry.recordFileReindexed());
    const after = await this.#fileFingerprint(path);
    // A stable high-precision metadata fingerprint makes the outcome reusable.
    // Read failures are retried so recovery is never hidden; ignored admission
    // can change independently of file metadata and is therefore not cached.
    if (
      before?.reusable === true &&
      after?.reusable === true &&
      before.value === after.value &&
      outcome.kind !== "read-error" &&
      outcome.kind !== "ignored"
    ) {
      this.#fileOutcomes.set(path, { fingerprint: before.value, outcome });
    } else {
      this.#fileOutcomes.delete(path);
    }
    return outcome;
  }

  #retainFileOutcomes(paths: Iterable<string>): void {
    const retained = new Set(paths);
    for (const path of this.#fileOutcomes.keys()) {
      if (!retained.has(path)) this.#fileOutcomes.delete(path);
    }
  }

  #indexOptions(): RepoMapIndexOptions {
    return {
      exclude: this.#options.exclude ?? [],
      checkGitIgnore: this.#gitWorkspace !== false,
      ...(this.#gitWorkspace === false ? { gitignorePatterns: this.#nonGitIgnorePatterns } : {}),
      ...(this.#options.indexFileSystem ? { fileSystem: this.#options.indexFileSystem } : {}),
    };
  }

  async #refreshNonGitIgnorePatterns(): Promise<void> {
    this.#nonGitIgnorePatterns = await loadRootGitignorePatterns(this.#projectRoot);
  }

  async #hydratePriorGeneration(): Promise<void> {
    let active: RepoMapGeneration;
    try {
      active = await loadActiveRepoMapGeneration(this.#options.stateRoot);
    } catch {
      // Rebuild remains authoritative when there is no valid persisted prior.
      return;
    }
    if (resolve(active.snapshot.provenance.projectRoot) !== this.#projectRoot) return;
    this.#generation = active.generation;
    this.#head = active.gitHead;
    this.#dirty = new Map(active.dirtyFiles.map(({ path, contentHash }) => [path, contentHash]));
    this.#pending = new Set(active.pendingFiles);
    this.#base = cloneSnapshot(active.snapshot);
    this.#effective = cloneSnapshot(active.snapshot);
    this.#freshness = active.freshness;
  }

  async #reconcileDirtyOverlay(): Promise<boolean> {
    if (!this.#effective) return false;
    const discovered = await gitDirtyPaths(this.#projectRoot, this.#gitRunner, this.#telemetry, this.#monotonicNow);
    this.#gitWorkspace = discovered !== undefined;
    if (!discovered) {
      await this.#refreshNonGitIgnorePatterns();
      const previous = new Map(this.#dirty);
      const pathsToRefresh = new Set([...this.#dirty.keys(), ...this.#readFailures.keys()]);
      for (const path of pathsToRefresh) {
        const outcome = await this.#indexPath(path, this.#indexOptions());
        this.#applyOutcome(path, outcome);
      }
      this.#retainFileOutcomes([...this.#dirty.keys(), ...this.#readFailures.keys()]);
      return JSON.stringify([...previous].sort()) !== JSON.stringify([...this.#dirty].sort());
    }
    this.#nonGitIgnorePatterns = [];
    const admitted = discovered.filter(({ path }) => !isRepoMapPathExcluded(path, this.#options.exclude));
    const dirtyPaths = new Map(admitted.map(({ path, tracked }) => [path, tracked]));
    const previous = new Map(this.#dirty);
    const pathsToRefresh = new Set([...dirtyPaths.keys(), ...previous.keys(), ...this.#readFailures.keys()]);
    const next = new Map<string, string>();
    for (const path of pathsToRefresh) {
      const outcome = await this.#indexPath(path, {
        exclude: this.#options.exclude,
        checkGitIgnore: !dirtyPaths.has(path),
        ...(this.#options.indexFileSystem ? { fileSystem: this.#options.indexFileSystem } : {}),
      });
      this.#applyOutcome(path, outcome);
      if (outcome.kind === "read-error" && previous.has(path)) {
        next.set(path, previous.get(path) as string);
        continue;
      }
      if (!dirtyPaths.has(path)) continue;
      if (outcome.kind === "indexed") next.set(path, outcome.file.contentHash);
      else if (outcome.kind === "missing") next.set(path, DELETED_HASH);
      else if (outcome.kind === "non-text" && dirtyPaths.get(path)) next.set(path, outcome.contentHash);
      else if (outcome.kind === "non-regular" && dirtyPaths.get(path)) next.set(path, hash(`non-regular\0${path}`));
    }
    this.#dirty = next;
    this.#retainFileOutcomes([...next.keys(), ...this.#readFailures.keys()]);
    return JSON.stringify([...previous].sort()) !== JSON.stringify([...next].sort());
  }

  #computedFreshness(): RepoMapFreshness {
    if (this.#pending.size > 0 || this.#watcherUpdates.length > 0 || this.#readFailures.size > 0) return "stale";
    if (this.#effective?.files.some((file) => file.degradedReason)) return "unsupported";
    return this.#dirty.size > 0 ? "dirty" : "fresh";
  }

  async #rebuildBase(): Promise<void> {
    try {
      // Full enumeration and admission are authoritative; no per-path outcome
      // from an older admission context may be overlaid onto the new base.
      this.#fileOutcomes.clear();
      const previousBase = this.#base;
      const previousEffective = this.#effective;
      const previousDirty = new Map(this.#dirty);
      const head = await gitHead(this.#projectRoot, this.#gitRunner, this.#telemetry, this.#monotonicNow);
      const snapshot = await buildRepoMap({ projectRoot: this.#projectRoot, exclude: this.#options.exclude });
      const nextBase = cloneSnapshot(snapshot);
      const nextEffective = cloneSnapshot(snapshot);
      const nextDirty = new Map<string, string>();
      const nextReadFailures = new Map<string, RepoMapWarning>();
      const nextPending = new Set<string>();
      for (const warning of snapshot.warnings.filter((candidate) => candidate.code === "read-error")) {
        const priorBaseFile = previousBase?.files.find((file) => file.path === warning.path);
        const priorEffectiveFile = previousEffective?.files.find((file) => file.path === warning.path);
        if (priorBaseFile) replaceFile(nextBase, warning.path, priorBaseFile, warning);
        if (priorEffectiveFile) replaceFile(nextEffective, warning.path, priorEffectiveFile, warning);
        if (previousDirty.has(warning.path)) nextDirty.set(warning.path, previousDirty.get(warning.path) as string);
        nextReadFailures.set(warning.path, warning);
        nextPending.add(warning.path);
      }
      this.#head = head;
      this.#base = nextBase;
      this.#replaceEffective(nextEffective);
      this.#dirty = nextDirty;
      this.#readFailures = nextReadFailures;
      this.#pending = nextPending;
      await this.#reconcileDirtyOverlay();
      this.#freshness = this.#computedFreshness();
      await this.#activate();
      if (this.#readFailures.size === 0) this.#error = undefined;
      else this.#error = [...this.#readFailures.values()][0]?.message;
    } catch (error) {
      this.#degrade(error);
    }
  }

  async #activate(): Promise<void> {
    if (!this.#effective) throw new Error("repository map is unavailable");
    await withFileLock(join(this.#options.stateRoot, "activation.lock"), async () => {
      let active: RepoMapGeneration | undefined;
      try {
        active = await loadActiveRepoMapGeneration(this.#options.stateRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const files = await this.#listGenerationFiles();
      const candidateGeneration =
        Math.max(this.#generation, active?.generation ?? 0, ...files.map((file) => file.generation)) + 1;
      const candidate: RepoMapGeneration = {
        schemaVersion: 1,
        generation: candidateGeneration,
        gitHead: this.#head,
        dirtyFiles: [...this.#dirty]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([path, contentHash]) => ({ path, contentHash })),
        workspaceRevision: revision(this.#head, this.#dirty),
        freshness: this.#freshness,
        pendingFiles: [...this.#pending].sort(),
        snapshot: this.#effective as RepoMapSnapshot,
        activatedAt: (this.#options.now ?? (() => new Date()))().toISOString(),
      };
      if (active && semanticGeneration(active) === semanticGeneration(candidate)) {
        this.#generation = active.generation;
        await this.#maintainUnlockedNonFatal();
        return;
      }

      const generationPath = join(this.#options.stateRoot, "generations", `${candidateGeneration}.json`);
      const serialized = `${JSON.stringify(candidate)}\n`;
      const generationBytes = Buffer.byteLength(serialized, "utf8");
      const writeStartedAt = monotonicReading(this.#monotonicNow);
      try {
        await this.#atomicWriter(generationPath, serialized);
        recordTelemetry(this.#telemetry, (telemetry) => telemetry.recordGenerationFileWritten(generationBytes));
        await this.#atomicWriter(
          join(this.#options.stateRoot, "active.json"),
          `${JSON.stringify({
            generation: candidateGeneration,
            path: slash(relative(this.#options.stateRoot, generationPath)),
          })}\n`,
        );
        recordTelemetry(this.#telemetry, (telemetry) => telemetry.recordGenerationActivated());
      } finally {
        recordTelemetry(this.#telemetry, (telemetry) =>
          telemetry.recordGenerationWrite(monotonicDuration(this.#monotonicNow, writeStartedAt)),
        );
      }
      this.#generation = candidateGeneration;
      await this.#maintainUnlockedNonFatal();
    });
  }

  async #maintainUnlockedNonFatal(): Promise<void> {
    try {
      const active = await loadActiveRepoMapGeneration(this.#options.stateRoot);
      this.#maintenance = await this.#pruneUnlocked(active.generation);
    } catch (error) {
      this.#maintenance = { error: error instanceof Error ? error.message : String(error) };
      recordTelemetry(this.#telemetry, (telemetry) => telemetry.recordMaintenanceFailure());
    }
  }

  async #reconcileGenerationBytes(): Promise<void> {
    if (!this.#telemetry) return;
    try {
      const files = await this.#listGenerationFiles();
      const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
      recordTelemetry(this.#telemetry, (telemetry) => telemetry.recordRepoMapTotalBytes(totalBytes));
    } catch {
      // Seeding telemetry must not make startup fail or alter runtime state.
    }
  }

  async #listGenerationFiles(): Promise<GenerationFile[]> {
    const generationsRoot = join(this.#options.stateRoot, "generations");
    let names: string[];
    try {
      names = await readdir(generationsRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const files: GenerationFile[] = [];
    for (const name of names) {
      const match = /^(\d+)\.json$/u.exec(name);
      if (!match) continue;
      const generation = Number(match[1]);
      if (!Number.isSafeInteger(generation) || generation <= 0) continue;
      const path = join(generationsRoot, name);
      const info = await stat(path);
      if (info.isFile()) files.push({ generation, path, bytes: info.size });
    }
    return files.sort((left, right) => left.generation - right.generation);
  }

  async #pruneUnlocked(activeGeneration: number): Promise<RepoMapMaintenanceResult> {
    const startedAt = monotonicReading(this.#monotonicNow);
    const pruned = { files: 0, bytes: 0 };
    try {
      return await this.#pruneUnlockedInstrumented(activeGeneration, pruned);
    } finally {
      recordTelemetry(this.#telemetry, (telemetry) =>
        telemetry.recordGenerationPrune(monotonicDuration(this.#monotonicNow, startedAt), pruned.files, pruned.bytes),
      );
    }
  }

  async #pruneUnlockedInstrumented(
    activeGeneration: number,
    pruned: { files: number; bytes: number },
  ): Promise<RepoMapMaintenanceResult> {
    let files = await this.#listGenerationFiles();
    const initialBytes = files.reduce((total, file) => total + file.bytes, 0);
    recordTelemetry(this.#telemetry, (telemetry) => telemetry.recordRepoMapTotalBytes(initialBytes));
    const active = files.find((file) => file.generation === activeGeneration);
    if (!active) throw new Error(`active repository map generation ${activeGeneration} is missing`);
    const deletedGenerations: number[] = [];
    let bytesFreed = 0;
    const remove = async (file: GenerationFile): Promise<void> => {
      if (file.generation === activeGeneration) return;
      try {
        await unlink(file.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      deletedGenerations.push(file.generation);
      bytesFreed += file.bytes;
      pruned.files += 1;
      pruned.bytes += file.bytes;
      files = files.filter((candidate) => candidate.generation !== file.generation);
    };

    for (const file of [...files]) {
      if (files.length <= this.#options.mapGenerationRetention) break;
      if (file.generation >= activeGeneration) continue;
      await remove(file);
    }
    let remainingBytes = files.reduce((total, file) => total + file.bytes, 0);
    for (const file of [...files]) {
      if (remainingBytes <= this.#options.mapQuotaBytes) break;
      if (file.generation >= activeGeneration) continue;
      await remove(file);
      remainingBytes -= file.bytes;
    }
    remainingBytes = files.reduce((total, file) => total + file.bytes, 0);
    deletedGenerations.sort((left, right) => left - right);
    return {
      activeGeneration,
      deletedGenerations,
      bytesFreed,
      remainingGenerations: files.length,
      remainingBytes,
      quotaSatisfied: remainingBytes <= this.#options.mapQuotaBytes,
    };
  }

  #degrade(error: unknown): void {
    recordTelemetry(this.#telemetry, (telemetry) => telemetry.recordMaintenanceFailure());
    this.#freshness = "stale";
    this.#error = error instanceof Error ? error.message : String(error);
  }
}

export async function loadActiveRepoMapGeneration(stateRoot: string): Promise<RepoMapGeneration> {
  const pointer = await readActivePointer(stateRoot);
  const generationPath = resolve(stateRoot, pointer.path);
  const serialized = await readFile(generationPath, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error(INVALID_GENERATION_MESSAGE);
  }
  if (!isRepoMapGeneration(value, pointer.generation)) throw new Error(INVALID_GENERATION_MESSAGE);
  return value;
}

interface ActiveGenerationPointer {
  generation: number;
  path: string;
}

async function readActivePointer(stateRoot: string): Promise<ActiveGenerationPointer> {
  const serialized = await readFile(join(stateRoot, "active.json"), "utf8");
  let pointer: unknown;
  try {
    pointer = JSON.parse(serialized);
  } catch {
    throw new Error("invalid active repository map generation");
  }
  if (
    !isRecord(pointer) ||
    !Number.isSafeInteger(pointer.generation) ||
    (pointer.generation as number) <= 0 ||
    typeof pointer.path !== "string"
  ) {
    throw new Error("invalid active repository map generation");
  }
  const expectedPath = `generations/${pointer.generation}.json`;
  const generationPath = resolve(stateRoot, pointer.path);
  if (
    slash(pointer.path) !== expectedPath ||
    dirname(generationPath) !== resolve(stateRoot, "generations") ||
    basename(generationPath) !== `${pointer.generation}.json`
  ) {
    throw new Error("invalid active repository map generation path");
  }
  return { generation: pointer.generation as number, path: pointer.path };
}
