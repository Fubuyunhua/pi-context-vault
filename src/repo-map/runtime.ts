import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import chokidar, { type FSWatcher } from "chokidar";
import { atomicWriteFile, withFileLock } from "../state/atomic.js";
import type { Telemetry } from "../telemetry.js";
import {
  buildRepoMap,
  indexRepoMapFile,
  isRepoMapPathExcluded,
  type RepoMapFile,
  type RepoMapQueryOptions,
  type RepoMapQueryResult,
  RepoMapSearch,
  type RepoMapSnapshot,
  type RepoMapWarning,
} from "./index.js";

const execFileAsync = promisify(execFile);
const DELETED_HASH = "deleted";

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
  now?: () => Date;
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

const IGNORED_DIR_NAMES = new Set([".git", ".pi", ".gradle", "node_modules", "dist", "build", "target"]);

/**
 * True when any path segment is an ignored directory name.
 *
 * chokidar normalizes every path to forward slashes before invoking `ignored`
 * (matchPatterns -> normalizePath), so splitting on the platform `sep` alone
 * would miss `.git` on Windows and watch volatile git internals (lock files),
 * which previously crashed the host with EPERM. Normalize explicitly so both
 * separators match on every platform.
 */
export function isWatcherIgnoredPath(path: string): boolean {
  const parts = path.replaceAll("\\", "/").split("/");
  return parts.some((part) => IGNORED_DIR_NAMES.has(part));
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

async function gitHead(projectRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" });
    return stdout.trim();
  } catch {
    return "no-head";
  }
}

async function gitDiff(projectRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--no-ext-diff", "--unified=1", "--"], {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return stdout.slice(0, 16 * 1024);
  } catch {
    return "";
  }
}

async function gitDirtyPaths(projectRoot: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: projectRoot,
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
    });
    const records = stdout.toString("utf8").split("\0").filter(Boolean);
    const paths: string[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index] as string;
      const status = record.slice(0, 2);
      const path = record.slice(3);
      if (status.includes("R") || status.includes("C")) {
        paths.push(path, records[index + 1] ?? "");
        index += 1;
      } else paths.push(path);
    }
    return [...new Set(paths.filter(Boolean).map(slash))].sort();
  } catch {
    return undefined;
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

export class RepoMapRuntime {
  readonly #options: Required<
    Pick<RepoMapRuntimeOptions, "mapDebounceMs" | "mapGenerationRetention" | "mapQuotaBytes" | "watch">
  > &
    RepoMapRuntimeOptions;
  readonly #scheduler: RepoMapScheduler;
  readonly #atomicWriter: typeof atomicWriteFile;
  readonly #telemetry?: Telemetry;
  #projectRoot = "";
  #base?: RepoMapSnapshot;
  #effective?: RepoMapSnapshot;
  #head = "no-head";
  #generation = 0;
  #dirty = new Map<string, string>();
  #pending = new Set<string>();
  #freshness: RepoMapFreshness = "stale";
  #error?: string;
  #maintenance?: RepoMapMaintenanceResult | { error: string };
  #watcher?: RepoMapWatcher;
  #scheduled?: unknown;
  #updateChain: Promise<void> = Promise.resolve();
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
  }

  async start(): Promise<void> {
    this.#projectRoot = await realpath(resolve(this.#options.projectRoot));
    await mkdir(this.#options.stateRoot, { recursive: true, mode: 0o700 });
    await this.#rebuildBase();
    if (this.#options.watch) {
      this.#watcher = (this.#options.watcherFactory ?? watcher)(this.#projectRoot);
      for (const event of ["add", "change", "unlink"] as const) {
        this.#watcher.on(event, (path) => this.notify(event, path));
      }
      await this.#watcher.ready?.();
    }
  }

  notify(event: RepoMapChangeEvent, changedPath: string): void {
    const path = slash(isAbsolute(changedPath) ? relative(this.#projectRoot, changedPath) : changedPath);
    if (!path || path.startsWith("../") || isRepoMapPathExcluded(path, this.#options.exclude)) return;
    this.#pending.add(path);
    this.#freshness = "stale";
    this.#updateChain = this.#updateChain
      .then(() => this.#fastUpdate(event, path))
      .catch((error) => this.#degrade(error));
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

  async #flush(): Promise<void> {
    if (this.#scheduled !== undefined) {
      this.#scheduler.cancel(this.#scheduled);
      this.#scheduled = undefined;
    }
    await this.#updateChain;
    const currentHead = await gitHead(this.#projectRoot);
    if (currentHead !== this.#head) {
      await this.#rebuildBase();
      return;
    }
    const reconciled = await this.#reconcileDirtyOverlay();
    if (this.#pending.size === 0 && this.#freshness !== "stale" && !reconciled) return;
    try {
      this.#pending.clear();
      this.#freshness = this.#effective?.files.some((file) => file.degradedReason)
        ? "unsupported"
        : this.#dirty.size > 0
          ? "dirty"
          : "fresh";
      await this.#activate();
      this.#error = undefined;
    } catch (error) {
      this.#degrade(error);
    }
  }

  async ensureFresh(): Promise<void> {
    const startedAt = performance.now();
    try {
      await this.flush();
    } finally {
      this.#telemetry?.recordEnsureFresh(performance.now() - startedAt);
    }
  }

  /** Rebuild the base snapshot and atomically activate it as a new generation. */
  async rebuild(): Promise<void> {
    const operation = this.#flushChain.then(async () => {
      await this.#updateChain;
      await this.#rebuildBase();
    });
    this.#flushChain = operation.catch(() => undefined);
    await operation;
  }

  async query(query: string, options: RepoMapQueryOptions = {}): Promise<RepoMapRuntimeQuery> {
    const startedAt = performance.now();
    try {
      return await this.#queryUninstrumented(query, options);
    } finally {
      this.#telemetry?.recordRepoMapQuery(performance.now() - startedAt);
    }
  }

  async #queryUninstrumented(query: string, options: RepoMapQueryOptions = {}): Promise<RepoMapRuntimeQuery> {
    await this.ensureFresh();
    const fallbackEvidence: RepoMapFallbackEvidence[] = [];
    let results: RepoMapQueryResult[] = [];
    if (this.#effective) {
      this.#telemetry?.recordSearchIndexBuild();
      results = new RepoMapSearch(this.#effective).query(query, options);
    }
    if (this.#freshness === "stale") {
      const terms = query.toLowerCase().match(/[\p{L}\p{N}_$-]{2,}/gu) ?? [];
      for (const file of this.#effective?.files ?? []) {
        if (terms.some((term) => file.lexicalTerms.includes(term))) {
          let excerpt = file.lexicalTerms.slice(0, 40).join(" ");
          try {
            excerpt = (await readFile(join(this.#projectRoot, file.path), "utf8")).slice(0, 4 * 1024);
          } catch {
            // The indexed lexical terms remain useful evidence when a file disappeared mid-query.
          }
          fallbackEvidence.push({ kind: "source", path: file.path, excerpt });
          if (fallbackEvidence.length >= 3) break;
        }
      }
      const diff = await gitDiff(this.#projectRoot);
      if (diff) fallbackEvidence.push({ kind: "git-diff", excerpt: diff });
      if (fallbackEvidence.length === 0) {
        const firstFile = this.#effective?.files[0];
        if (firstFile) {
          let excerpt = firstFile.lexicalTerms.slice(0, 40).join(" ");
          try {
            excerpt = (await readFile(join(this.#projectRoot, firstFile.path), "utf8")).slice(0, 4 * 1024);
          } catch {
            // Lexical terms from the last coherent generation remain an explicit degraded fallback.
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
      freshness: this.#freshness,
      generation: this.#generation,
      gitHead: this.#head,
      workspaceRevision: revision(this.#head, this.#dirty),
      pendingFiles: [...this.#pending].sort(),
      fallbackEvidence,
      ...(this.#error ? { error: this.#error } : {}),
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
      this.#telemetry?.recordMaintenanceFailure();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#scheduled !== undefined) this.#scheduler.cancel(this.#scheduled);
    this.#scheduled = undefined;
    await this.#updateChain;
    await this.#flushChain;
    await this.#watcher?.close();
    this.#watcher = undefined;
  }

  async #fastUpdate(event: RepoMapChangeEvent, path: string): Promise<void> {
    if (!this.#effective) throw new Error("repository map runtime has not started");
    if (event === "unlink") {
      replaceFile(this.#effective, path);
      if (this.#base?.files.some((file) => file.path === path)) this.#dirty.set(path, DELETED_HASH);
      else this.#dirty.delete(path);
      return;
    }
    const indexed = await indexRepoMapFile(this.#projectRoot, path);
    this.#telemetry?.recordFileReindexed();
    replaceFile(this.#effective, path, indexed.file, indexed.warning);
    const baseHash = this.#base?.files.find((file) => file.path === path)?.contentHash;
    if (indexed.file && indexed.file.contentHash !== baseHash) this.#dirty.set(path, indexed.file.contentHash);
    else if (indexed.file) this.#dirty.delete(path);
    else this.#dirty.set(path, DELETED_HASH);
  }

  async #reconcileDirtyOverlay(): Promise<boolean> {
    if (!this.#effective) return false;
    const discoveredDirtyPaths = await gitDirtyPaths(this.#projectRoot);
    if (!discoveredDirtyPaths) return false;
    const dirtyPaths = discoveredDirtyPaths.filter((path) => !isRepoMapPathExcluded(path, this.#options.exclude));
    const previous = new Map(this.#dirty);
    const pathsToRefresh = new Set([...dirtyPaths, ...previous.keys()]);
    const next = new Map<string, string>();
    for (const path of pathsToRefresh) {
      const indexed = await indexRepoMapFile(this.#projectRoot, path);
      this.#telemetry?.recordFileReindexed();
      replaceFile(this.#effective, path, indexed.file, indexed.warning);
      if (dirtyPaths.includes(path)) next.set(path, indexed.file?.contentHash ?? DELETED_HASH);
    }
    this.#dirty = next;
    return JSON.stringify([...previous].sort()) !== JSON.stringify([...next].sort());
  }

  async #rebuildBase(): Promise<void> {
    try {
      const head = await gitHead(this.#projectRoot);
      const snapshot = await buildRepoMap({ projectRoot: this.#projectRoot, exclude: this.#options.exclude });
      this.#head = head;
      this.#base = cloneSnapshot(snapshot);
      this.#effective = cloneSnapshot(snapshot);
      this.#dirty.clear();
      for (const path of (await gitDirtyPaths(this.#projectRoot)) ?? []) {
        this.#dirty.set(path, snapshot.files.find((file) => file.path === path)?.contentHash ?? DELETED_HASH);
      }
      this.#pending.clear();
      this.#freshness = snapshot.files.some((file) => file.degradedReason)
        ? "unsupported"
        : this.#dirty.size > 0
          ? "dirty"
          : "fresh";
      await this.#activate();
      this.#error = undefined;
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
      await this.#atomicWriter(generationPath, serialized);
      await this.#atomicWriter(
        join(this.#options.stateRoot, "active.json"),
        `${JSON.stringify({
          generation: candidateGeneration,
          path: slash(relative(this.#options.stateRoot, generationPath)),
        })}\n`,
      );
      this.#generation = candidateGeneration;
      this.#telemetry?.recordGenerationCreated(Buffer.byteLength(serialized, "utf8"));
      await this.#maintainUnlockedNonFatal();
    });
  }

  async #maintainUnlockedNonFatal(): Promise<void> {
    try {
      const active = await loadActiveRepoMapGeneration(this.#options.stateRoot);
      this.#maintenance = await this.#pruneUnlocked(active.generation);
    } catch (error) {
      this.#maintenance = { error: error instanceof Error ? error.message : String(error) };
      this.#telemetry?.recordMaintenanceFailure();
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
    let files = await this.#listGenerationFiles();
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
    this.#telemetry?.recordRepoMapTotalBytes(remainingBytes);
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
    this.#telemetry?.recordMaintenanceFailure();
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
