import { createHash } from "node:crypto";
import {
  canonicalGraphPath,
  canonicalizeGraphPaths,
  compareUtf8,
  GraphCanonicalizationError,
  writeJcs,
} from "./canonical.js";
import type {
  RepoMapExport,
  RepoMapFile,
  RepoMapImport,
  RepoMapSnapshot,
  RepoMapSymbol,
  RepoMapWarning,
} from "./index.js";
import type { RepoMapFreshness } from "./runtime.js";

export const REPOSITORY_SNAPSHOT_CONTRACT_VERSION = "repository-snapshot/v1" as const;
export const REPO_MAP_ANALYZER_CAPABILITY_VERSION = "repo-map-capabilities/v1" as const;

const MAX_PATH_BYTES = 4_096;
const MAX_STRING_BYTES = 16_384;
const MAX_CANONICAL_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 100_000;
const MAX_WARNINGS = 100_000;
const MAX_DIRTY_ENTRIES = 100_000;
const MAX_PENDING_INPUTS = 100_000;
const MAX_SYMBOLS = 1_000_000;
const MAX_EVIDENCE_ROWS = 1_000_000;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export type SnapshotDiagnosticCode = "parse-error" | "read-error" | "runtime-operation-error" | "diagnostics-truncated";
export type SnapshotDiagnosticPhase = "analyzer" | "indexing" | "runtime";

export interface RepositorySnapshotDiagnostic {
  readonly severity: "error" | "warning";
  readonly code: SnapshotDiagnosticCode;
  readonly phase: SnapshotDiagnosticPhase;
  readonly path?: string;
  readonly message: string;
  readonly occurrenceCount: number;
  readonly omittedCount?: number;
}

export interface RepositorySnapshotHandle {
  readonly contractVersion: typeof REPOSITORY_SNAPSHOT_CONTRACT_VERSION;
  readonly analyzerCapabilityVersion: typeof REPO_MAP_ANALYZER_CAPABILITY_VERSION;
  readonly snapshotContentIdentity: `sha256:${string}`;
  readonly workspaceRevision: string;
  readonly gitHead: string;
  readonly generation: number;
  readonly freshness: RepoMapFreshness;
  readonly dirtyFiles: readonly Readonly<{ path: string; contentHash: string }>[];
  readonly pendingPaths: readonly string[];
  readonly errors: readonly RepositorySnapshotDiagnostic[];
  readonly warnings: readonly RepositorySnapshotDiagnostic[];
  readonly snapshot: DeepReadonly<RepoMapSnapshot>;
}

export interface RepositorySnapshotProvider {
  capture(): Promise<RepositorySnapshotHandle>;
  captureCurrent(): RepositorySnapshotHandle;
}

export interface RepositorySnapshotContentIdentityResult {
  readonly identity: `sha256:${string}`;
  readonly canonicalBytes: number;
}

/** Shared exact Spec 0016 snapshot-content identity implementation. */
export function computeRepositorySnapshotContentIdentity(
  snapshot: DeepReadonly<Pick<RepoMapSnapshot, "schemaVersion" | "provenance" | "files">>,
  canonicalByteLimit = MAX_CANONICAL_INPUT_BYTES,
): RepositorySnapshotContentIdentityResult {
  if (!Number.isSafeInteger(canonicalByteLimit) || canonicalByteLimit < 0)
    throw new RangeError("invalid canonical limit");
  const digest = createHash("sha256");
  let canonicalBytes = 0;
  writeJcs(
    {
      identitySchema: "repository-snapshot-content/v1",
      analyzerCapabilityVersion: REPO_MAP_ANALYZER_CAPABILITY_VERSION,
      repositoryMapSchemaVersion: snapshot.schemaVersion,
      analyzers: {
        typescriptVersion: snapshot.provenance.typescriptVersion,
        javaParser: snapshot.provenance.javaParser ?? null,
      },
      files: snapshot.files,
    },
    {
      write(chunk) {
        canonicalBytes += Buffer.byteLength(chunk, "utf8");
        if (!Number.isSafeInteger(canonicalBytes) || canonicalBytes > canonicalByteLimit) {
          throw new RepositorySnapshotContentIdentityBoundError(canonicalByteLimit, canonicalBytes);
        }
        digest.update(chunk, "utf8");
      },
    },
  );
  return { identity: `sha256:${digest.digest("hex")}`, canonicalBytes };
}

export class RepositorySnapshotContentIdentityBoundError extends Error {
  constructor(
    readonly limit: number,
    readonly observed: number,
  ) {
    super("repository snapshot content identity bound exceeded");
    this.name = "RepositorySnapshotContentIdentityBoundError";
  }
}

export type RepositorySnapshotUnavailableReason =
  | "no-published-checkpoint"
  | "ensure-fresh-failed"
  | "invalid-checkpoint"
  | "snapshot-bound-exceeded";

const UNAVAILABLE_MESSAGES: Record<RepositorySnapshotUnavailableReason, string> = {
  "no-published-checkpoint": "repository snapshot unavailable: no published checkpoint",
  "ensure-fresh-failed": "repository snapshot unavailable: refresh failed",
  "invalid-checkpoint": "repository snapshot unavailable: invalid checkpoint",
  "snapshot-bound-exceeded": "repository snapshot unavailable: snapshot bound exceeded",
};

export class RepositorySnapshotUnavailableError extends Error {
  readonly code = "repository-snapshot-unavailable" as const;
  readonly reason: RepositorySnapshotUnavailableReason;
  readonly retryable: boolean;

  constructor(reason: RepositorySnapshotUnavailableReason) {
    super(UNAVAILABLE_MESSAGES[reason]);
    this.name = "RepositorySnapshotUnavailableError";
    this.reason = reason;
    this.retryable = reason === "no-published-checkpoint" || reason === "ensure-fresh-failed";
    delete this.stack;
  }
}

export interface RepositoryCheckpointInput {
  readonly snapshot: RepoMapSnapshot;
  readonly gitHead: string;
  readonly dirtyFiles: readonly Readonly<{ path: string; contentHash: string }>[];
  readonly workspaceRevision: string;
  readonly freshness: RepoMapFreshness;
  readonly pendingPaths: readonly string[];
  readonly runtimeError?: unknown;
  readonly generation: number;
}

class CheckpointValidationError extends Error {
  readonly bound: boolean;

  constructor(bound = false) {
    super(bound ? "bound" : "invalid");
    this.bound = bound;
  }
}

interface ValidationCounts {
  symbols: number;
  evidence: number;
  symbolLimit: number;
  evidenceLimit: number;
}

interface ValidatedWarning {
  readonly path: string;
  readonly code: RepoMapWarning["code"];
}

interface NormalizedSnapshot {
  readonly snapshot: RepoMapSnapshot;
  readonly diagnosticWarnings: readonly ValidatedWarning[];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new CheckpointValidationError();
  return value as Record<string, unknown>;
}

function assertString(value: unknown, maximum = MAX_STRING_BYTES): asserts value is string {
  if (typeof value !== "string") throw new CheckpointValidationError();
  try {
    compareUtf8(value, value);
  } catch {
    throw new CheckpointValidationError();
  }
  if (Buffer.byteLength(value, "utf8") > maximum) throw new CheckpointValidationError(true);
}

function canonicalPath(value: unknown): string {
  assertString(value, MAX_PATH_BYTES);
  try {
    return canonicalGraphPath(value);
  } catch (error) {
    if (error instanceof GraphCanonicalizationError && error.code === "path-bound-exceeded") {
      throw new CheckpointValidationError(true);
    }
    throw new CheckpointValidationError();
  }
}

function mapBounded<T>(value: unknown, maximum: number, map: (entry: unknown, index: number) => T): T[] {
  if (!Array.isArray(value)) throw new CheckpointValidationError();
  const output: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (index >= maximum) throw new CheckpointValidationError(true);
    if (!(index in value)) throw new CheckpointValidationError();
    output.push(map(value[index], index));
  }
  return output;
}

function stringArray(value: unknown, maximum: number): string[] {
  return mapBounded(value, maximum, (entry) => {
    assertString(entry);
    return entry;
  });
}

function addCount(counts: ValidationCounts, field: "symbols" | "evidence", amount = 1): void {
  counts[field] += amount;
  const maximum = field === "symbols" ? counts.symbolLimit : counts.evidenceLimit;
  if (!Number.isSafeInteger(counts[field]) || counts[field] > maximum) throw new CheckpointValidationError(true);
}

function normalizeImport(value: unknown, counts: ValidationCounts): RepoMapImport {
  const row = asRecord(value);
  assertString(row.source);
  const names = stringArray(row.names, 1_024);
  if (typeof row.typeOnly !== "boolean") throw new CheckpointValidationError();
  if (row.static !== undefined && typeof row.static !== "boolean") throw new CheckpointValidationError();
  if (row.wildcard !== undefined && typeof row.wildcard !== "boolean") throw new CheckpointValidationError();
  addCount(counts, "evidence");
  return {
    source: row.source,
    names,
    typeOnly: row.typeOnly,
    ...(row.static === undefined ? {} : { static: row.static }),
    ...(row.wildcard === undefined ? {} : { wildcard: row.wildcard }),
  };
}

function normalizeExport(value: unknown, counts: ValidationCounts): RepoMapExport {
  const row = asRecord(value);
  assertString(row.name);
  if (row.source !== undefined) assertString(row.source);
  if (typeof row.typeOnly !== "boolean") throw new CheckpointValidationError();
  addCount(counts, "evidence");
  return {
    name: row.name,
    ...(row.source === undefined ? {} : { source: row.source }),
    typeOnly: row.typeOnly,
  };
}

function normalizeRelationships(value: unknown, counts: ValidationCounts): NonNullable<RepoMapSymbol["relationships"]> {
  const relationships = asRecord(value);
  const extended = stringArray(relationships.extends, 10_000);
  const implemented = stringArray(relationships.implements, 10_000);
  const permitted = stringArray(relationships.permits, 10_000);
  addCount(counts, "evidence", extended.length + implemented.length + permitted.length);
  return { extends: extended, implements: implemented, permits: permitted };
}

const SYMBOL_KINDS = new Set<RepoMapSymbol["kind"]>([
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

function normalizeSymbol(value: unknown, counts: ValidationCounts): RepoMapSymbol {
  const row = asRecord(value);
  assertString(row.name);
  if (typeof row.kind !== "string" || !SYMBOL_KINDS.has(row.kind as RepoMapSymbol["kind"])) {
    throw new CheckpointValidationError();
  }
  assertString(row.signature);
  if (typeof row.exported !== "boolean") throw new CheckpointValidationError();
  if (!Number.isSafeInteger(row.line) || (row.line as number) <= 0) throw new CheckpointValidationError();
  if (row.container !== undefined) assertString(row.container);
  const annotations = row.annotations === undefined ? undefined : stringArray(row.annotations, 1_024);
  const modifiers = row.modifiers === undefined ? undefined : stringArray(row.modifiers, 1_024);
  const typeParameters = row.typeParameters === undefined ? undefined : stringArray(row.typeParameters, 1_024);
  const relationships = row.relationships === undefined ? undefined : normalizeRelationships(row.relationships, counts);
  addCount(counts, "symbols");
  addCount(counts, "evidence");
  return {
    name: row.name,
    kind: row.kind as RepoMapSymbol["kind"],
    signature: row.signature,
    exported: row.exported,
    line: row.line as number,
    ...(row.container === undefined ? {} : { container: row.container }),
    ...(annotations === undefined ? {} : { annotations }),
    ...(modifiers === undefined ? {} : { modifiers }),
    ...(typeParameters === undefined ? {} : { typeParameters }),
    ...(relationships === undefined ? {} : { relationships }),
  };
}

function normalizeFile(
  value: unknown,
  counts: ValidationCounts,
  registerPath: (canonical: string, raw: string) => void,
): RepoMapFile {
  const row = asRecord(value);
  assertString(row.path, MAX_PATH_BYTES);
  const path = canonicalPath(row.path);
  registerPath(path, row.path);
  if (row.kind !== "semantic" && row.kind !== "lexical") throw new CheckpointValidationError();
  if (
    row.language !== "typescript" &&
    row.language !== "javascript" &&
    row.language !== "java" &&
    row.language !== "text"
  ) {
    throw new CheckpointValidationError();
  }
  if (typeof row.contentHash !== "string" || !HASH_PATTERN.test(row.contentHash)) throw new CheckpointValidationError();
  if (!Number.isSafeInteger(row.sizeBytes) || (row.sizeBytes as number) < 0) throw new CheckpointValidationError();
  const lexicalTerms = stringArray(row.lexicalTerms, 2_000);
  const imports = mapBounded(row.imports, 10_000, (entry) => normalizeImport(entry, counts));
  const exports = mapBounded(row.exports, 10_000, (entry) => normalizeExport(entry, counts));
  const symbols = mapBounded(row.symbols, 50_000, (entry) => normalizeSymbol(entry, counts));
  const dependencies = mapBounded(row.dependencies, 20_000, (entry) => {
    assertString(entry);
    addCount(counts, "evidence");
    return entry;
  });
  if (row.packageName !== undefined) assertString(row.packageName);
  if (row.degradedReason !== undefined) assertString(row.degradedReason);
  return {
    path,
    kind: row.kind,
    language: row.language,
    contentHash: row.contentHash,
    sizeBytes: row.sizeBytes as number,
    lexicalTerms,
    imports,
    exports,
    symbols,
    dependencies,
    ...(row.packageName === undefined ? {} : { packageName: row.packageName }),
    ...(row.degradedReason === undefined ? {} : { degradedReason: row.degradedReason }),
  };
}

function canonicalPathOrAbsent(path: string): string | undefined {
  try {
    return canonicalGraphPath(path);
  } catch {
    return undefined;
  }
}

function normalizeSnapshot(value: unknown, limits: { symbolLimit: number; evidenceLimit: number }): NormalizedSnapshot {
  const input = asRecord(value);
  if (input.schemaVersion !== 1) throw new CheckpointValidationError();

  const provenanceInput = asRecord(input.provenance);
  if (
    provenanceInput.generator !== "pi-context-vault" ||
    provenanceInput.generatorVersion !== "0.1.0" ||
    provenanceInput.parser !== "typescript-compiler-api"
  ) {
    throw new CheckpointValidationError();
  }
  assertString(provenanceInput.typescriptVersion);
  if (provenanceInput.javaParser !== undefined && provenanceInput.javaParser !== "java-parser@3.0.1") {
    throw new CheckpointValidationError();
  }
  assertString(provenanceInput.generatedAt);
  if (!Number.isFinite(Date.parse(provenanceInput.generatedAt))) throw new CheckpointValidationError();
  assertString(provenanceInput.projectRoot);
  const provenance: RepoMapSnapshot["provenance"] = {
    generator: "pi-context-vault",
    generatorVersion: "0.1.0",
    parser: "typescript-compiler-api",
    typescriptVersion: provenanceInput.typescriptVersion,
    ...(provenanceInput.javaParser === undefined ? {} : { javaParser: provenanceInput.javaParser }),
    generatedAt: provenanceInput.generatedAt,
    projectRoot: provenanceInput.projectRoot,
  };

  const counts: ValidationCounts = { symbols: 0, evidence: 0, ...limits };
  const filePaths = new Map<string, string>();
  const files = mapBounded(input.files, MAX_FILES, (entry) =>
    normalizeFile(entry, counts, (canonical, raw) => {
      if (filePaths.has(canonical)) throw new CheckpointValidationError();
      filePaths.set(canonical, raw);
    }),
  ).sort((left, right) => compareUtf8(left.path, right.path));

  const diagnosticWarnings: ValidatedWarning[] = [];
  const warnings = mapBounded(input.warnings, MAX_WARNINGS, (entry) => {
    const warning = asRecord(entry);
    if (typeof warning.path !== "string" || typeof warning.message !== "string") throw new CheckpointValidationError();
    if (warning.code !== "parse-error" && warning.code !== "read-error") throw new CheckpointValidationError();
    diagnosticWarnings.push({ path: warning.path, code: warning.code });
    const path = canonicalPathOrAbsent(warning.path);
    if (path === undefined) return undefined;
    return {
      path,
      code: warning.code,
      message: warning.code === "parse-error" ? "repository snapshot parse failed" : "repository snapshot read failed",
    } satisfies RepoMapWarning;
  }).filter((warning): warning is RepoMapWarning => warning !== undefined);

  return {
    diagnosticWarnings,
    snapshot: { schemaVersion: 1, provenance, files, warnings },
  };
}

function diagnosticForWarning(warning: ValidatedWarning): RepositorySnapshotDiagnostic {
  const parse = warning.code === "parse-error";
  const path = canonicalPathOrAbsent(warning.path);
  return {
    severity: parse ? "warning" : "error",
    code: warning.code,
    phase: parse ? "analyzer" : "indexing",
    ...(path === undefined ? {} : { path }),
    message: parse ? "repository snapshot parse failed" : "repository snapshot read failed",
    occurrenceCount: 1,
  };
}

function compareDiagnostic(left: RepositorySnapshotDiagnostic, right: RepositorySnapshotDiagnostic): number {
  return (
    compareUtf8(left.severity, right.severity) ||
    compareUtf8(left.code, right.code) ||
    (left.path === undefined
      ? right.path === undefined
        ? 0
        : -1
      : right.path === undefined
        ? 1
        : compareUtf8(left.path, right.path)) ||
    compareUtf8(left.phase, right.phase) ||
    compareUtf8(left.message, right.message)
  );
}

function collapseDiagnostics(rows: RepositorySnapshotDiagnostic[]): RepositorySnapshotDiagnostic[] {
  const collapsed = new Map<string, RepositorySnapshotDiagnostic>();
  for (const row of rows) {
    const key = JSON.stringify([row.severity, row.code, row.phase, row.path ?? null, row.message]);
    const prior = collapsed.get(key);
    collapsed.set(key, prior ? { ...prior, occurrenceCount: prior.occurrenceCount + row.occurrenceCount } : row);
  }
  return [...collapsed.values()].sort(compareDiagnostic);
}

function boundDiagnostics(
  rows: RepositorySnapshotDiagnostic[],
  severity: "error" | "warning",
  limit: number,
): RepositorySnapshotDiagnostic[] {
  if (rows.length <= limit) return rows;
  const omitted = rows.length - (limit - 1);
  return [
    ...rows.slice(0, limit - 1),
    {
      severity,
      code: "diagnostics-truncated",
      phase: "runtime",
      message: `${omitted} additional ${severity} diagnostics omitted`,
      occurrenceCount: 1,
      omittedCount: omitted,
    },
  ];
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function detachedFrozen<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

interface PublishedCheckpoint {
  readonly handle: RepositorySnapshotHandle;
  readonly pendingSources: readonly string[];
  readonly pendingInputCount: number;
}

type PublishedState = PublishedCheckpoint | RepositorySnapshotUnavailableReason | undefined;

const CHECKPOINT_PUBLICATION_DIAGNOSTIC: RepositorySnapshotDiagnostic = {
  severity: "error",
  code: "runtime-operation-error",
  phase: "runtime",
  message: "repository snapshot runtime operation failed",
  occurrenceCount: 1,
};

function checkpointFallbackErrors(
  existing: readonly RepositorySnapshotDiagnostic[],
): readonly RepositorySnapshotDiagnostic[] {
  if (existing.some((row) => row.code === "runtime-operation-error")) return existing;
  const priorOmitted = existing
    .filter((row) => row.code === "diagnostics-truncated")
    .reduce((total, row) => total + (row.omittedCount ?? 0), 0);
  const combined = [
    ...existing.filter((row) => row.code !== "diagnostics-truncated"),
    CHECKPOINT_PUBLICATION_DIAGNOSTIC,
  ].sort(compareDiagnostic);
  if (priorOmitted === 0 && combined.length <= 32) return combined;
  if (combined.length <= 31) {
    return [
      ...combined,
      {
        severity: "error",
        code: "diagnostics-truncated",
        phase: "runtime",
        message: `${priorOmitted} additional error diagnostics omitted`,
        occurrenceCount: 1,
        omittedCount: priorOmitted,
      },
    ];
  }
  let retained = combined.slice(0, 31);
  if (!retained.includes(CHECKPOINT_PUBLICATION_DIAGNOSTIC)) {
    retained = [...combined.slice(0, 30), CHECKPOINT_PUBLICATION_DIAGNOSTIC].sort(compareDiagnostic);
  }
  const omitted = priorOmitted + combined.length - retained.length;
  return [
    ...retained,
    {
      severity: "error",
      code: "diagnostics-truncated",
      phase: "runtime",
      message: `${omitted} additional error diagnostics omitted`,
      occurrenceCount: 1,
      omittedCount: omitted,
    },
  ];
}

function checkpointPublicationFallback(prior: PublishedCheckpoint): PublishedCheckpoint {
  return detachedFrozen({
    handle: {
      ...prior.handle,
      freshness: "stale" as const,
      errors: checkpointFallbackErrors(prior.handle.errors),
    },
    pendingSources: prior.pendingSources,
    pendingInputCount: prior.pendingInputCount,
  });
}

export class RepositoryCheckpointStore {
  #published: PublishedState;
  readonly #pendingInputLimit: number;
  readonly #canonicalInputByteLimit: number;
  readonly #evidenceRowLimit: number;

  /** @internal Optional lower limits are deterministic test seams; runtime always uses production defaults. */
  constructor(
    options: { pendingPathInputLimit?: number; canonicalInputByteLimit?: number; evidenceRowLimit?: number } = {},
  ) {
    const pendingLimit = options.pendingPathInputLimit ?? MAX_PENDING_INPUTS;
    if (!Number.isSafeInteger(pendingLimit) || pendingLimit <= 0 || pendingLimit > MAX_PENDING_INPUTS) {
      throw new RangeError("pendingPathInputLimit must be a positive safe integer within the production bound");
    }
    const canonicalLimit = options.canonicalInputByteLimit ?? MAX_CANONICAL_INPUT_BYTES;
    if (!Number.isSafeInteger(canonicalLimit) || canonicalLimit <= 0 || canonicalLimit > MAX_CANONICAL_INPUT_BYTES) {
      throw new RangeError("canonicalInputByteLimit must be a positive safe integer within the production bound");
    }
    const evidenceLimit = options.evidenceRowLimit ?? MAX_EVIDENCE_ROWS;
    if (!Number.isSafeInteger(evidenceLimit) || evidenceLimit <= 0 || evidenceLimit > MAX_EVIDENCE_ROWS) {
      throw new RangeError("evidenceRowLimit must be a positive safe integer within the production bound");
    }
    this.#pendingInputLimit = pendingLimit;
    this.#canonicalInputByteLimit = canonicalLimit;
    this.#evidenceRowLimit = evidenceLimit;
  }

  publish(input: RepositoryCheckpointInput): boolean {
    const prior = this.#published;
    try {
      this.#published = this.#build(input);
      return true;
    } catch (error) {
      this.#published =
        prior && typeof prior !== "string"
          ? checkpointPublicationFallback(prior)
          : error instanceof CheckpointValidationError && error.bound
            ? "snapshot-bound-exceeded"
            : "invalid-checkpoint";
      return false;
    }
  }

  /** Publish watcher staleness using only the last immutable checkpoint plus the new path. */
  publishWatcherPath(path: string): boolean {
    const prior = this.#published;
    if (!prior || typeof prior === "string") return true;
    if (prior.pendingInputCount >= this.#pendingInputLimit) {
      this.#published = checkpointPublicationFallback(prior);
      return false;
    }
    try {
      const nextCount = prior.pendingInputCount + 1;
      if (prior.pendingSources.includes(path)) {
        const handle =
          prior.handle.freshness === "stale"
            ? prior.handle
            : detachedFrozen({ ...prior.handle, freshness: "stale" as const });
        this.#published = { handle, pendingSources: prior.pendingSources, pendingInputCount: nextCount };
        return true;
      }
      const pendingSources = [...prior.pendingSources, path];
      const pendingPaths = canonicalizeGraphPaths(pendingSources);
      const handle = detachedFrozen({ ...prior.handle, freshness: "stale" as const, pendingPaths });
      this.#published = { handle, pendingSources: detachedFrozen(pendingSources), pendingInputCount: nextCount };
      return true;
    } catch {
      this.#published = checkpointPublicationFallback(prior);
      return false;
    }
  }

  captureCurrent(): RepositorySnapshotHandle {
    const published = this.#published;
    if (published === undefined) throw new RepositorySnapshotUnavailableError("no-published-checkpoint");
    if (typeof published === "string") throw new RepositorySnapshotUnavailableError(published);
    return detachedFrozen(published.handle);
  }

  #build(input: RepositoryCheckpointInput): PublishedCheckpoint {
    assertString(input.gitHead);
    assertString(input.workspaceRevision);
    if (!Number.isSafeInteger(input.generation) || input.generation < 0) throw new CheckpointValidationError();
    if (
      input.freshness !== "fresh" &&
      input.freshness !== "dirty" &&
      input.freshness !== "stale" &&
      input.freshness !== "unsupported"
    ) {
      throw new CheckpointValidationError();
    }

    const normalized = normalizeSnapshot(input.snapshot, {
      symbolLimit: MAX_SYMBOLS,
      evidenceLimit: this.#evidenceRowLimit,
    });
    const dirtyByCanonical = new Map<string, { rawPath: string; contentHash: string }>();
    mapBounded(input.dirtyFiles, MAX_DIRTY_ENTRIES, (entry) => {
      const row = asRecord(entry);
      assertString(row.path, MAX_PATH_BYTES);
      const path = canonicalPath(row.path);
      const prior = dirtyByCanonical.get(path);
      if (prior && prior.rawPath !== row.path) throw new CheckpointValidationError();
      if (
        typeof row.contentHash !== "string" ||
        (row.contentHash !== "deleted" && !HASH_PATTERN.test(row.contentHash))
      ) {
        throw new CheckpointValidationError();
      }
      if (prior && prior.contentHash !== row.contentHash) throw new CheckpointValidationError();
      if (!prior) dirtyByCanonical.set(path, { rawPath: row.path, contentHash: row.contentHash });
      return undefined;
    });
    const dirtyFiles = [...dirtyByCanonical]
      .sort(([left], [right]) => compareUtf8(left, right))
      .map(([path, entry]) => ({ path, contentHash: entry.contentHash }));
    const pendingByCanonical = new Map<string, string>();
    const pendingSources = mapBounded(input.pendingPaths, this.#pendingInputLimit, (entry) => {
      assertString(entry, MAX_PATH_BYTES);
      const path = canonicalPath(entry);
      const prior = pendingByCanonical.get(path);
      if (prior !== undefined && prior !== entry) throw new CheckpointValidationError();
      if (prior === undefined) pendingByCanonical.set(path, entry);
      return entry;
    });
    const pendingPaths = [...pendingByCanonical.keys()].sort(compareUtf8);

    let snapshotContentIdentity: `sha256:${string}`;
    try {
      snapshotContentIdentity = computeRepositorySnapshotContentIdentity(
        normalized.snapshot,
        this.#canonicalInputByteLimit,
      ).identity;
    } catch (error) {
      if (error instanceof RepositorySnapshotContentIdentityBoundError) throw new CheckpointValidationError(true);
      throw error;
    }

    const diagnosticRows = normalized.diagnosticWarnings.map(diagnosticForWarning);
    if (input.runtimeError !== undefined) {
      diagnosticRows.push({
        severity: "error",
        code: "runtime-operation-error",
        phase: "runtime",
        message: "repository snapshot runtime operation failed",
        occurrenceCount: 1,
      });
    }
    const collapsed = collapseDiagnostics(diagnosticRows);
    const errors = boundDiagnostics(
      collapsed.filter((row) => row.severity === "error"),
      "error",
      32,
    );
    const warnings = boundDiagnostics(
      collapsed.filter((row) => row.severity === "warning"),
      "warning",
      128,
    );
    const handle: RepositorySnapshotHandle = {
      contractVersion: REPOSITORY_SNAPSHOT_CONTRACT_VERSION,
      analyzerCapabilityVersion: REPO_MAP_ANALYZER_CAPABILITY_VERSION,
      snapshotContentIdentity,
      workspaceRevision: input.workspaceRevision,
      gitHead: input.gitHead,
      generation: input.generation,
      freshness: input.freshness,
      dirtyFiles,
      pendingPaths,
      errors,
      warnings,
      snapshot: normalized.snapshot,
    };
    return detachedFrozen({
      handle,
      pendingSources: [...new Set(pendingSources)],
      pendingInputCount: pendingSources.length,
    });
  }
}
