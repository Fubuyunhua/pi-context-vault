import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import chokidar, { type FSWatcher } from "chokidar";
import { atomicWriteFile, withFileLock } from "../state/atomic.js";
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
  watch?: boolean;
  watcherFactory?: (root: string) => RepoMapWatcher;
  scheduler?: RepoMapScheduler;
  atomicWriter?: typeof atomicWriteFile;
  now?: () => Date;
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

function watcher(root: string): RepoMapWatcher {
  const fsWatcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored: (path) =>
      path
        .split(sep)
        .some((part) => [".git", ".pi", ".gradle", "node_modules", "dist", "build", "target"].includes(part)),
  }) as FSWatcher;
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

export class RepoMapRuntime {
  readonly #options: Required<Pick<RepoMapRuntimeOptions, "mapDebounceMs" | "watch">> & RepoMapRuntimeOptions;
  readonly #scheduler: RepoMapScheduler;
  readonly #atomicWriter: typeof atomicWriteFile;
  #projectRoot = "";
  #base?: RepoMapSnapshot;
  #effective?: RepoMapSnapshot;
  #head = "no-head";
  #generation = 0;
  #dirty = new Map<string, string>();
  #pending = new Set<string>();
  #freshness: RepoMapFreshness = "stale";
  #error?: string;
  #watcher?: RepoMapWatcher;
  #scheduled?: unknown;
  #updateChain: Promise<void> = Promise.resolve();
  #flushChain: Promise<void> = Promise.resolve();

  constructor(options: RepoMapRuntimeOptions) {
    if (!Number.isInteger(options.mapDebounceMs ?? 300) || (options.mapDebounceMs ?? 300) <= 0) {
      throw new Error("mapDebounceMs must be a positive integer");
    }
    this.#options = { ...options, mapDebounceMs: options.mapDebounceMs ?? 300, watch: options.watch ?? true };
    this.#scheduler = options.scheduler ?? defaultScheduler;
    this.#atomicWriter = options.atomicWriter ?? atomicWriteFile;
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
    await this.flush();
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
    await this.ensureFresh();
    const fallbackEvidence: RepoMapFallbackEvidence[] = [];
    let results: RepoMapQueryResult[] = [];
    if (this.#effective) results = new RepoMapSearch(this.#effective).query(query, options);
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

  status(): Omit<RepoMapRuntimeQuery, "results" | "fallbackEvidence"> & { dirtyFiles: string[] } {
    return {
      freshness: this.#freshness,
      generation: this.#generation,
      gitHead: this.#head,
      workspaceRevision: revision(this.#head, this.#dirty),
      pendingFiles: [...this.#pending].sort(),
      dirtyFiles: [...this.#dirty.keys()].sort(),
      ...(this.#error ? { error: this.#error } : {}),
    };
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
      const activeGeneration = await readActiveGenerationNumber(this.#options.stateRoot).catch(() => 0);
      const nextGeneration = Math.max(this.#generation, activeGeneration) + 1;
      const generation: RepoMapGeneration = {
        schemaVersion: 1,
        generation: nextGeneration,
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
      const generationPath = join(this.#options.stateRoot, "generations", `${nextGeneration}.json`);
      await this.#atomicWriter(generationPath, `${JSON.stringify(generation, null, 2)}\n`);
      await this.#atomicWriter(
        join(this.#options.stateRoot, "active.json"),
        `${JSON.stringify({ generation: nextGeneration, path: slash(relative(this.#options.stateRoot, generationPath)) })}\n`,
      );
      this.#generation = nextGeneration;
    });
  }

  #degrade(error: unknown): void {
    this.#freshness = "stale";
    this.#error = error instanceof Error ? error.message : String(error);
  }
}

export async function loadActiveRepoMapGeneration(stateRoot: string): Promise<RepoMapGeneration> {
  const pointer = await readActivePointer(stateRoot);
  const generationPath = resolve(stateRoot, pointer.path);
  const value = JSON.parse(await readFile(generationPath, "utf8")) as RepoMapGeneration;
  if (
    value.schemaVersion !== 1 ||
    value.generation !== pointer.generation ||
    typeof value.gitHead !== "string" ||
    !Array.isArray(value.dirtyFiles) ||
    value.dirtyFiles.some(
      (entry) =>
        !entry ||
        typeof entry.path !== "string" ||
        typeof entry.contentHash !== "string" ||
        (!/^[a-f0-9]{64}$/u.test(entry.contentHash) && entry.contentHash !== DELETED_HASH),
    ) ||
    !/^[a-f0-9]{64}$/u.test(value.workspaceRevision) ||
    !(["fresh", "dirty", "stale", "unsupported"] as const).includes(value.freshness) ||
    !Array.isArray(value.pendingFiles) ||
    value.pendingFiles.some((path) => typeof path !== "string") ||
    !value.snapshot ||
    value.snapshot.schemaVersion !== 1 ||
    !value.snapshot.provenance ||
    !Array.isArray(value.snapshot.files) ||
    !Array.isArray(value.snapshot.warnings) ||
    !Number.isFinite(Date.parse(value.activatedAt))
  ) {
    throw new Error("invalid active repository map generation metadata");
  }
  return value;
}

interface ActiveGenerationPointer {
  generation: number;
  path: string;
}

async function readActivePointer(stateRoot: string): Promise<ActiveGenerationPointer> {
  const pointer = JSON.parse(
    await readFile(join(stateRoot, "active.json"), "utf8"),
  ) as Partial<ActiveGenerationPointer>;
  if (!Number.isSafeInteger(pointer.generation) || (pointer.generation ?? 0) <= 0 || typeof pointer.path !== "string") {
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
  return pointer as ActiveGenerationPointer;
}

async function readActiveGenerationNumber(stateRoot: string): Promise<number> {
  return (await readActivePointer(stateRoot)).generation;
}
