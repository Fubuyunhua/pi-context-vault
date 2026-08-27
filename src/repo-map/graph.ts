import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import {
  canonicalGraphPath,
  canonicalizeJcs,
  compareUtf8,
  createDomainSeparatedId,
  GraphCanonicalizationError,
  writeJcs,
} from "./canonical.js";
import type { RepoMapFile, RepoMapFileKind, RepoMapImport, RepoMapLanguage, RepoMapSymbol } from "./index.js";
import {
  computeRepositorySnapshotContentIdentity,
  type DeepReadonly,
  REPO_MAP_ANALYZER_CAPABILITY_VERSION,
  REPOSITORY_SNAPSHOT_CONTRACT_VERSION,
  RepositorySnapshotContentIdentityBoundError,
  type RepositorySnapshotDiagnostic,
  type RepositorySnapshotHandle,
} from "./snapshot.js";

export const REPOSITORY_GRAPH_SCHEMA_VERSION = "repository-graph/v1" as const;

export type FileId = `file:sha256:${string}`;
export type SymbolId = `symbol:sha256:${string}`;
export type ExternalModuleId = `external-module:sha256:${string}`;
export type GraphNodeId = FileId | SymbolId | ExternalModuleId;
export type ReferenceId = `reference:sha256:${string}`;
export type EvidenceId = `evidence:sha256:${string}`;
export type EdgeId = `edge:sha256:${string}`;

export interface FileDescriptor {
  readonly canonicalPath: string;
}
export interface FileNode {
  readonly nodeKind: "file";
  readonly id: FileId;
  readonly descriptor: FileDescriptor;
  readonly language: RepoMapLanguage;
  readonly fileKind: RepoMapFileKind;
  readonly contentHash: string;
  readonly sizeBytes: number;
}

export interface SymbolDescriptor {
  readonly fileId: FileId;
  readonly language: RepoMapLanguage;
  readonly symbolKind: RepoMapSymbol["kind"];
  readonly container: string | null;
  readonly name: string;
  readonly signature: string;
  readonly occurrenceOrdinal: number;
}
export interface SymbolNode {
  readonly nodeKind: "symbol";
  readonly id: SymbolId;
  readonly descriptor: SymbolDescriptor;
  readonly recordedRowOrdinal: number;
  readonly row: DeepReadonly<RepoMapSymbol>;
}

/** Literal-reference external module created by Resolver v1. */
export interface ExternalModuleDescriptor {
  readonly language: "typescript" | "javascript";
  readonly moduleKind: "bare" | "node-builtin";
  readonly literalSpecifier: string;
}
export interface ExternalModuleNode {
  readonly nodeKind: "external-module";
  readonly id: ExternalModuleId;
  readonly descriptor: ExternalModuleDescriptor;
}

export type GraphReferenceDescriptor =
  | {
      readonly kind: "module-specifier";
      readonly language: "typescript" | "javascript";
      readonly raw: string;
    }
  | { readonly kind: "export-name"; readonly language: RepoMapLanguage; readonly raw: string }
  | { readonly kind: "raw-dependency"; readonly language: RepoMapLanguage; readonly raw: string }
  | {
      readonly kind: "java-import-name";
      readonly raw: string;
      readonly static: boolean | null;
      readonly wildcard: boolean | null;
    }
  | {
      readonly kind: "java-relationship-name";
      readonly relationship: "extends" | "implements" | "permits";
      readonly raw: string;
    };
export interface GraphReference {
  readonly id: ReferenceId;
  readonly descriptor: GraphReferenceDescriptor;
}

export type EvidenceRowKind = "import" | "export" | "symbol" | "dependency" | "java-relationship";
export type GraphEvidenceDescriptor =
  | {
      readonly sourceFileId: FileId;
      readonly rowKind: "import";
      readonly recordedRowOrdinal: number;
      readonly recordedNestedOrdinal: null;
      readonly canonicalRowDigest: `sha256:${string}`;
      readonly occurrenceOrdinal: number;
    }
  | {
      readonly sourceFileId: FileId;
      readonly rowKind: "export";
      readonly recordedRowOrdinal: number;
      readonly recordedNestedOrdinal: null;
      readonly canonicalRowDigest: `sha256:${string}`;
      readonly occurrenceOrdinal: number;
    }
  | {
      readonly sourceFileId: FileId;
      readonly rowKind: "symbol";
      readonly recordedRowOrdinal: number;
      readonly recordedNestedOrdinal: null;
      readonly canonicalRowDigest: `sha256:${string}`;
      readonly occurrenceOrdinal: number;
    }
  | {
      readonly sourceFileId: FileId;
      readonly rowKind: "dependency";
      readonly recordedRowOrdinal: number;
      readonly recordedNestedOrdinal: null;
      readonly canonicalRowDigest: `sha256:${string}`;
      readonly occurrenceOrdinal: number;
    }
  | {
      readonly sourceFileId: FileId;
      readonly rowKind: "java-relationship";
      readonly recordedRowOrdinal: number;
      readonly recordedNestedOrdinal: number;
      readonly canonicalRowDigest: `sha256:${string}`;
      readonly occurrenceOrdinal: number;
    };
export type GraphEvidenceExplanation =
  | {
      readonly rowKind: "import";
      readonly source: string;
      readonly names: readonly string[];
      readonly typeOnly: boolean;
      readonly static: boolean | null;
      readonly wildcard: boolean | null;
    }
  | { readonly rowKind: "export"; readonly name: string; readonly source: string | null; readonly typeOnly: boolean }
  | {
      readonly rowKind: "symbol";
      readonly symbolId: SymbolId;
      readonly name: string;
      readonly symbolKind: RepoMapSymbol["kind"];
      readonly line: number;
    }
  | { readonly rowKind: "dependency"; readonly raw: string }
  | {
      readonly rowKind: "java-relationship";
      readonly symbolId: SymbolId;
      readonly relationship: "extends" | "implements" | "permits";
      readonly raw: string;
    };
export interface GraphEvidence {
  readonly id: EvidenceId;
  readonly descriptor: GraphEvidenceDescriptor;
  readonly explanation: GraphEvidenceExplanation;
}

export type ResolutionStatus = "exact" | "heuristic" | "unresolved";
export type ResolverRuleCode =
  | "direct-declares"
  | "direct-analyzer-export-flag"
  | "tsjs-relative-literal"
  | "tsjs-js-family-substitution"
  | "tsjs-extensionless-file"
  | "tsjs-extensionless-index"
  | "tsjs-external-bare"
  | "tsjs-external-node-builtin"
  | "java-explicit-top-level-fqn"
  | "java-explicit-static-owner-fqn"
  | "java-immediate-container-heuristic"
  | "unresolved-export-name"
  | "unresolved-raw-dependency"
  | "unresolved-java-relationship"
  | "unresolved-tsjs-module-reference"
  | "unresolved-java-import";
export type ResolverReasonCode =
  | "none"
  | "no-candidate"
  | "ambiguous-highest-precedence"
  | "invalid-specifier"
  | "nul-specifier"
  | "query-or-fragment-unsupported"
  | "project-root-escape"
  | "absolute-specifier-unsupported"
  | "url-scheme-unsupported"
  | "node-builtin-name-missing"
  | "java-import-flags-missing"
  | "java-wildcard-unsupported"
  | "java-static-owner-missing"
  | "java-duplicate-fqn"
  | "java-deep-nested-unsupported"
  | "export-symbol-binding-unavailable"
  | "raw-dependency-role-unavailable"
  | "java-relationship-binding-deferred";
export interface ResolutionCandidate {
  readonly id: FileId | ExternalModuleId;
  readonly precedence: number;
  readonly rule: ResolverRuleCode;
}
export interface GraphResolution {
  readonly status: ResolutionStatus;
  readonly rule: ResolverRuleCode;
  readonly reason: ResolverReasonCode;
  readonly candidates: readonly ResolutionCandidate[];
  readonly omittedCandidateCount: number;
}

export type RelationKind =
  | "DECLARES"
  | "ANALYZER_EXPORT_FLAG"
  | "IMPORTS_FILE"
  | "IMPORTS_EXTERNAL"
  | "IMPORT_REFERENCE"
  | "REEXPORTS_FILE"
  | "REEXPORTS_EXTERNAL"
  | "REEXPORT_REFERENCE"
  | "JAVA_IMPORTS_TYPE"
  | "JAVA_IMPORTS_STATIC_OWNER"
  | "JAVA_IMPORT_NAME"
  | "EXPORTS_NAME"
  | "DEPENDS_ON_RAW"
  | "JAVA_EXTENDS_NAME"
  | "JAVA_IMPLEMENTS_NAME"
  | "JAVA_PERMITS_NAME";
export type GraphEdgeDescriptor =
  | {
      readonly descriptorKind: "direct";
      readonly sourceId: FileId;
      readonly relation: "DECLARES" | "ANALYZER_EXPORT_FLAG";
      readonly targetId: SymbolId;
    }
  | {
      readonly descriptorKind: "reference";
      readonly sourceId: FileId | SymbolId;
      readonly relation: Exclude<RelationKind, "DECLARES" | "ANALYZER_EXPORT_FLAG">;
      readonly referenceId: ReferenceId;
    };
export interface GraphEdgeBase {
  readonly id: EdgeId;
  readonly descriptor: GraphEdgeDescriptor;
  readonly evidence: readonly GraphEvidence[];
  readonly evidenceCount: number;
  readonly omittedEvidenceCount: number;
}
export type DirectSymbolEdge = GraphEdgeBase & {
  readonly relation: "DECLARES" | "ANALYZER_EXPORT_FLAG";
  readonly sourceId: FileId;
  readonly targetId: SymbolId;
  readonly referenceId?: never;
  readonly resolution: GraphResolution & { readonly status: "exact" };
};
export type ResolvedFileEdge = GraphEdgeBase & {
  readonly relation: "IMPORTS_FILE" | "REEXPORTS_FILE" | "JAVA_IMPORTS_TYPE" | "JAVA_IMPORTS_STATIC_OWNER";
  readonly sourceId: FileId;
  readonly targetId: FileId;
  readonly referenceId: ReferenceId;
  readonly resolution: GraphResolution & { readonly status: "exact" | "heuristic" };
};
export type ExternalModuleEdge = GraphEdgeBase & {
  readonly relation: "IMPORTS_EXTERNAL" | "REEXPORTS_EXTERNAL";
  readonly sourceId: FileId;
  readonly targetId: ExternalModuleId;
  readonly referenceId: ReferenceId;
  readonly resolution: GraphResolution & { readonly status: "exact" };
};
export type UnresolvedReferenceEdge = GraphEdgeBase & {
  readonly relation:
    | "IMPORTS_FILE"
    | "IMPORT_REFERENCE"
    | "REEXPORTS_FILE"
    | "REEXPORT_REFERENCE"
    | "JAVA_IMPORTS_TYPE"
    | "JAVA_IMPORTS_STATIC_OWNER"
    | "JAVA_IMPORT_NAME"
    | "EXPORTS_NAME"
    | "DEPENDS_ON_RAW"
    | "JAVA_EXTENDS_NAME"
    | "JAVA_IMPLEMENTS_NAME"
    | "JAVA_PERMITS_NAME";
  readonly sourceId: FileId | SymbolId;
  readonly targetId?: never;
  readonly referenceId: ReferenceId;
  readonly resolution: GraphResolution & { readonly status: "unresolved" };
};
export type GraphEdge = DirectSymbolEdge | ResolvedFileEdge | ExternalModuleEdge | UnresolvedReferenceEdge;

export interface RepositoryGraphV1 {
  readonly graphSchemaVersion: typeof REPOSITORY_GRAPH_SCHEMA_VERSION;
  readonly analyzerCapabilityVersion: typeof REPO_MAP_ANALYZER_CAPABILITY_VERSION;
  readonly snapshotContentIdentity: RepositorySnapshotHandle["snapshotContentIdentity"];
  readonly complete: true;
  readonly files: readonly FileNode[];
  readonly symbols: readonly SymbolNode[];
  readonly externalModules: readonly ExternalModuleNode[];
  readonly references: readonly GraphReference[];
  readonly edges: readonly GraphEdge[];
}
export interface GraphBuildSuccess {
  readonly ok: true;
  readonly graph: RepositoryGraphV1;
  readonly serializedBytes: number;
}
export type GraphBuildErrorCode =
  | "invalid-snapshot"
  | "invalid-path"
  | "path-collision"
  | "invalid-unicode"
  | "invalid-enum"
  | "invalid-hash"
  | "nested-bound-exceeded"
  | "count-bound-exceeded"
  | "canonical-input-bound-exceeded"
  | "serialized-graph-bound-exceeded"
  | "identity-collision";
export interface GraphBuildError {
  readonly code: GraphBuildErrorCode;
  readonly phase: "validate" | "canonicalize" | "identify" | "resolve" | "serialize";
  readonly message: string;
  readonly path?: string;
  readonly limit?: number;
  readonly observed?: number;
}
export interface GraphBuildUnavailable {
  readonly ok: false;
  readonly error: GraphBuildError;
}
export type GraphBuildResult = GraphBuildSuccess | GraphBuildUnavailable;

/** Module-private capability: assemblies are valid only in the process/module instance that built them. */
const TRUSTED_GRAPH_ASSEMBLIES = new WeakSet<object>();

type AssemblyDirectRelation = "DECLARES" | "ANALYZER_EXPORT_FLAG";
type AssemblyFileReferenceRelation = "EXPORTS_NAME" | "DEPENDS_ON_RAW";
type AssemblySymbolReferenceRelation = "JAVA_EXTENDS_NAME" | "JAVA_IMPLEMENTS_NAME" | "JAVA_PERMITS_NAME";

type AssemblyDirectEdge<R extends AssemblyDirectRelation> = R extends AssemblyDirectRelation
  ? Omit<GraphEdgeBase, "descriptor"> & {
      readonly descriptor: {
        readonly descriptorKind: "direct";
        readonly sourceId: FileId;
        readonly relation: R;
        readonly targetId: SymbolId;
      };
      readonly relation: R;
      readonly sourceId: FileId;
      readonly targetId: SymbolId;
      readonly referenceId?: never;
    }
  : never;
type AssemblyFileReferenceEdge<R extends AssemblyFileReferenceRelation> = R extends AssemblyFileReferenceRelation
  ? Omit<GraphEdgeBase, "descriptor"> & {
      readonly descriptor: {
        readonly descriptorKind: "reference";
        readonly sourceId: FileId;
        readonly relation: R;
        readonly referenceId: ReferenceId;
      };
      readonly relation: R;
      readonly sourceId: FileId;
      readonly targetId?: never;
      readonly referenceId: ReferenceId;
    }
  : never;
type AssemblySymbolReferenceEdge<R extends AssemblySymbolReferenceRelation> = R extends AssemblySymbolReferenceRelation
  ? Omit<GraphEdgeBase, "descriptor"> & {
      readonly descriptor: {
        readonly descriptorKind: "reference";
        readonly sourceId: SymbolId;
        readonly relation: R;
        readonly referenceId: ReferenceId;
      };
      readonly relation: R;
      readonly sourceId: SymbolId;
      readonly targetId?: never;
      readonly referenceId: ReferenceId;
    }
  : never;

/** Resolver-independent edge assembled in S02b. Descriptor and top-level endpoints are statically correlated. */
export type GraphAssemblyEdge =
  | AssemblyDirectEdge<AssemblyDirectRelation>
  | AssemblyFileReferenceEdge<AssemblyFileReferenceRelation>
  | AssemblySymbolReferenceEdge<AssemblySymbolReferenceRelation>;

/** @internal Stable resolver input. It is not a Graph v1 edge and has no provisional relation or status. */
export type GraphResolverWorkItem =
  | {
      readonly workKind: "tsjs-import" | "tsjs-reexport";
      readonly sourceFileId: FileId;
      readonly referenceId: ReferenceId;
      readonly evidence: GraphEvidence;
    }
  | {
      readonly workKind: "java-import";
      readonly sourceFileId: FileId;
      readonly referenceId: ReferenceId;
      readonly evidence: GraphEvidence;
    };

export interface GraphFileResolverMetadata {
  readonly fileId: FileId;
  readonly packageName: string | null;
  readonly degradedReason: string | null;
}

/** @internal Resolver-independent S02b assembly; never expose as a complete RepositoryGraphV1. */
export interface RepositoryGraphAssembly {
  readonly analyzerCapabilityVersion: typeof REPO_MAP_ANALYZER_CAPABILITY_VERSION;
  readonly snapshotContentIdentity: RepositorySnapshotHandle["snapshotContentIdentity"];
  readonly canonicalInputBytesUsed: number;
  readonly files: readonly FileNode[];
  readonly fileResolverMetadata: readonly GraphFileResolverMetadata[];
  readonly symbols: readonly SymbolNode[];
  readonly references: readonly GraphReference[];
  readonly edges: readonly GraphAssemblyEdge[];
  readonly resolverWorkItems: readonly GraphResolverWorkItem[];
}
export interface GraphAssemblyBuildSuccess {
  readonly ok: true;
  readonly assembly: RepositoryGraphAssembly;
}
export type GraphAssemblyBuildResult = GraphAssemblyBuildSuccess | GraphBuildUnavailable;

/** @internal Production graph resource limits, exposed only for typed test seams. */
export interface GraphBuildLimits {
  readonly pathBytes: number;
  readonly stringBytes: number;
  readonly files: number;
  readonly warnings: number;
  readonly dirtyEntries: number;
  readonly pendingPaths: number;
  readonly symbols: number;
  readonly references: number;
  readonly externalModules: number;
  readonly edges: number;
  readonly evidence: number;
  readonly importsPerFile: number;
  readonly exportsPerFile: number;
  readonly symbolsPerFile: number;
  readonly dependenciesPerFile: number;
  readonly lexicalTermsPerFile: number;
  readonly importNames: number;
  readonly symbolNestedEntries: number;
  readonly relationships: number;
  readonly retainedEvidence: number;
  readonly retainedCandidates: number;
  readonly canonicalInputBytes: number;
  readonly serializedGraphBytes: number;
}
const DEFAULT_LIMITS: GraphBuildLimits = {
  pathBytes: 4_096,
  stringBytes: 16_384,
  files: 100_000,
  warnings: 100_000,
  dirtyEntries: 100_000,
  pendingPaths: 100_000,
  symbols: 1_000_000,
  references: 1_000_000,
  externalModules: 250_000,
  edges: 1_000_000,
  evidence: 1_000_000,
  importsPerFile: 10_000,
  exportsPerFile: 10_000,
  symbolsPerFile: 50_000,
  dependenciesPerFile: 20_000,
  lexicalTermsPerFile: 2_000,
  importNames: 1_024,
  symbolNestedEntries: 1_024,
  relationships: 10_000,
  retainedEvidence: 64,
  retainedCandidates: 32,
  canonicalInputBytes: 256 * 1024 * 1024,
  serializedGraphBytes: 256 * 1024 * 1024,
};

/** @internal Practical limit and collision seams for focused tests only. */
export interface GraphAssemblyBuildOptions {
  readonly limits?: Partial<GraphBuildLimits>;
  readonly createId?: (prefix: string, domain: string, payload: unknown) => string;
}

/** @internal Resolver/final-graph options, exposed for focused tests only. */
export type GraphBuildOptions = GraphAssemblyBuildOptions;

interface NormalizedBuildContext {
  readonly limits: GraphBuildLimits;
  readonly idFactory: (prefix: string, domain: string, payload: unknown) => string;
}

const ERROR_MESSAGES: Record<GraphBuildErrorCode, string> = {
  "invalid-snapshot": "repository graph build failed: invalid snapshot",
  "invalid-path": "repository graph build failed: invalid path",
  "path-collision": "repository graph build failed: path collision",
  "invalid-unicode": "repository graph build failed: invalid Unicode",
  "invalid-enum": "repository graph build failed: invalid enum value",
  "invalid-hash": "repository graph build failed: invalid content hash",
  "nested-bound-exceeded": "repository graph build failed: nested bound exceeded",
  "count-bound-exceeded": "repository graph build failed: count bound exceeded",
  "canonical-input-bound-exceeded": "repository graph build failed: canonical input bound exceeded",
  "serialized-graph-bound-exceeded": "repository graph build failed: serialized graph bound exceeded",
  "identity-collision": "repository graph build failed: identity collision",
};

class BuildFailure extends Error {
  readonly graphError: GraphBuildError;

  constructor(
    code: GraphBuildErrorCode,
    phase: GraphBuildError["phase"],
    details: Pick<GraphBuildError, "path" | "limit" | "observed"> = {},
  ) {
    super(code);
    this.name = "BuildFailure";
    this.graphError = { code, phase, message: ERROR_MESSAGES[code], ...details };
  }
}

interface BuildCounts {
  symbols: number;
  references: number;
  edges: number;
  evidence: number;
  canonicalBytes: number;
}
interface NormalizedFile extends Omit<RepoMapFile, "path"> {
  path: string;
}
interface ValidatedInput {
  readonly snapshotContentIdentity: `sha256:${string}`;
  readonly files: readonly NormalizedFile[];
}

const HASH = /^[a-f0-9]{64}$/u;
const SNAPSHOT_HASH = /^sha256:[a-f0-9]{64}$/u;
const FILE_KINDS = new Set<RepoMapFileKind>(["semantic", "lexical"]);
const LANGUAGES = new Set<RepoMapLanguage>(["typescript", "javascript", "java", "text"]);
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

function record(
  value: unknown,
  allowedFields: readonly string[],
  requiredFields: readonly string[] = allowedFields,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new BuildFailure("invalid-snapshot", "validate");
  }
  const allowed = new Set(allowedFields);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Object.getOwnPropertyNames(value);
  if (names.some((name) => !allowed.has(name)) || requiredFields.some((name) => descriptors[name] === undefined)) {
    throw new BuildFailure("invalid-snapshot", "validate");
  }
  const output: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = descriptors[name];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new BuildFailure("invalid-snapshot", "validate");
    }
    output[name] = descriptor.value;
  }
  return output;
}
function array(value: unknown, limit: number, countKind: "nested" | "count" = "nested"): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new BuildFailure("invalid-snapshot", "validate");
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) {
    throw new BuildFailure("invalid-snapshot", "validate");
  }
  const length = lengthDescriptor.value as number;
  if (length > limit) {
    throw new BuildFailure(countKind === "count" ? "count-bound-exceeded" : "nested-bound-exceeded", "validate", {
      limit,
      observed: length,
    });
  }
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== length + 1) throw new BuildFailure("invalid-snapshot", "validate");
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new BuildFailure("invalid-snapshot", "validate");
    }
    output.push(descriptor.value);
  }
  return output;
}
function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}
function string(value: unknown, limits: GraphBuildLimits, maximum = limits.stringBytes): string {
  if (typeof value !== "string") throw new BuildFailure("invalid-snapshot", "validate");
  if (!validUnicode(value)) throw new BuildFailure("invalid-unicode", "validate");
  const observed = Buffer.byteLength(value, "utf8");
  if (observed > maximum) {
    throw new BuildFailure("nested-bound-exceeded", "validate", { limit: maximum, observed });
  }
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new BuildFailure("invalid-snapshot", "validate");
  return value;
}
function safeInteger(value: unknown, positive = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0)) {
    throw new BuildFailure("invalid-snapshot", "validate");
  }
  return value as number;
}
function knownEnum<T extends string>(value: unknown, values: ReadonlySet<T>): T {
  if (typeof value !== "string" || !values.has(value as T)) throw new BuildFailure("invalid-enum", "validate");
  return value as T;
}
function stringList(value: unknown, limit: number, limits: GraphBuildLimits): string[] {
  return array(value, limit).map((entry) => string(entry, limits));
}
function canonicalPath(value: unknown, limits: GraphBuildLimits): string {
  const raw = string(value, limits, limits.pathBytes);
  try {
    return canonicalGraphPath(raw);
  } catch (error) {
    if (error instanceof GraphCanonicalizationError) {
      const code = error.code === "invalid-unicode" ? "invalid-unicode" : "invalid-path";
      throw new BuildFailure(code, "canonicalize");
    }
    throw error;
  }
}
function addCount(counts: BuildCounts, field: "symbols" | "references" | "edges" | "evidence", limit: number): void {
  const observed = counts[field] + 1;
  if (!Number.isSafeInteger(observed) || observed > limit) {
    throw new BuildFailure("count-bound-exceeded", "validate", { limit, observed });
  }
  counts[field] = observed;
}

function normalizeImport(value: unknown, limits: GraphBuildLimits): RepoMapImport {
  const row = record(value, ["source", "names", "typeOnly", "static", "wildcard"], ["source", "names", "typeOnly"]);
  const source = string(row.source, limits);
  const names = stringList(row.names, limits.importNames, limits);
  const typeOnly = boolean(row.typeOnly);
  const staticFlag = Object.hasOwn(row, "static") ? boolean(row.static) : undefined;
  const wildcard = Object.hasOwn(row, "wildcard") ? boolean(row.wildcard) : undefined;
  return {
    source,
    names,
    typeOnly,
    ...(staticFlag === undefined ? {} : { static: staticFlag }),
    ...(wildcard === undefined ? {} : { wildcard }),
  };
}
function normalizeExport(value: unknown, limits: GraphBuildLimits): RepoMapFile["exports"][number] {
  const row = record(value, ["name", "source", "typeOnly"], ["name", "typeOnly"]);
  const name = string(row.name, limits);
  const source = Object.hasOwn(row, "source") ? string(row.source, limits) : undefined;
  const typeOnly = boolean(row.typeOnly);
  return { name, ...(source === undefined ? {} : { source }), typeOnly };
}
function normalizeSymbol(value: unknown, limits: GraphBuildLimits): RepoMapSymbol {
  const row = record(
    value,
    [
      "name",
      "kind",
      "signature",
      "exported",
      "line",
      "container",
      "annotations",
      "modifiers",
      "typeParameters",
      "relationships",
    ],
    ["name", "kind", "signature", "exported", "line"],
  );
  const name = string(row.name, limits);
  const kind = knownEnum(row.kind, SYMBOL_KINDS);
  const signature = string(row.signature, limits);
  const exported = boolean(row.exported);
  const line = safeInteger(row.line, true);
  const container = Object.hasOwn(row, "container") ? string(row.container, limits) : undefined;
  const annotations = Object.hasOwn(row, "annotations")
    ? stringList(row.annotations, limits.symbolNestedEntries, limits)
    : undefined;
  const modifiers = Object.hasOwn(row, "modifiers")
    ? stringList(row.modifiers, limits.symbolNestedEntries, limits)
    : undefined;
  const typeParameters = Object.hasOwn(row, "typeParameters")
    ? stringList(row.typeParameters, limits.symbolNestedEntries, limits)
    : undefined;
  let relationships: RepoMapSymbol["relationships"];
  if (Object.hasOwn(row, "relationships")) {
    const source = record(row.relationships, ["extends", "implements", "permits"]);
    relationships = {
      extends: stringList(source.extends, limits.relationships, limits),
      implements: stringList(source.implements, limits.relationships, limits),
      permits: stringList(source.permits, limits.relationships, limits),
    };
  }
  return {
    name,
    kind,
    signature,
    exported,
    line,
    ...(container === undefined ? {} : { container }),
    ...(annotations === undefined ? {} : { annotations }),
    ...(modifiers === undefined ? {} : { modifiers }),
    ...(typeParameters === undefined ? {} : { typeParameters }),
    ...(relationships === undefined ? {} : { relationships }),
  };
}

function validateDiagnostic(value: unknown, limits: GraphBuildLimits): RepositorySnapshotDiagnostic {
  const row = record(
    value,
    ["severity", "code", "phase", "path", "message", "occurrenceCount", "omittedCount"],
    ["severity", "code", "phase", "message", "occurrenceCount"],
  );
  const severity = knownEnum(row.severity, new Set(["error", "warning"] as const));
  const code = knownEnum(
    row.code,
    new Set(["parse-error", "read-error", "runtime-operation-error", "diagnostics-truncated"] as const),
  );
  const phase = knownEnum(row.phase, new Set(["analyzer", "indexing", "runtime"] as const));
  const message = string(row.message, limits, 512);
  const occurrenceCount = safeInteger(row.occurrenceCount, true);
  const path = Object.hasOwn(row, "path") ? canonicalPath(row.path, limits) : undefined;
  const omittedCount = Object.hasOwn(row, "omittedCount") ? safeInteger(row.omittedCount, true) : undefined;
  if (
    (path !== undefined && path !== row.path) ||
    (code === "parse-error" &&
      (severity !== "warning" || phase !== "analyzer" || message !== "repository snapshot parse failed")) ||
    (code === "read-error" &&
      (severity !== "error" || phase !== "indexing" || message !== "repository snapshot read failed")) ||
    (code === "runtime-operation-error" &&
      (severity !== "error" ||
        phase !== "runtime" ||
        path !== undefined ||
        message !== "repository snapshot runtime operation failed")) ||
    (code !== "diagnostics-truncated" && omittedCount !== undefined)
  ) {
    throw new BuildFailure("invalid-snapshot", "validate");
  }
  if (code === "diagnostics-truncated") {
    const expected = `${omittedCount} additional ${severity} diagnostics omitted`;
    if (
      phase !== "runtime" ||
      path !== undefined ||
      occurrenceCount !== 1 ||
      omittedCount === undefined ||
      message !== expected
    ) {
      throw new BuildFailure("invalid-snapshot", "validate");
    }
  }
  return {
    severity,
    code,
    phase,
    ...(path === undefined ? {} : { path }),
    message,
    occurrenceCount,
    ...(omittedCount === undefined ? {} : { omittedCount }),
  };
}

function validateHandle(handle: unknown, limits: GraphBuildLimits, counts: BuildCounts): ValidatedInput {
  const input = record(handle, [
    "contractVersion",
    "analyzerCapabilityVersion",
    "snapshotContentIdentity",
    "workspaceRevision",
    "gitHead",
    "generation",
    "freshness",
    "dirtyFiles",
    "pendingPaths",
    "errors",
    "warnings",
    "snapshot",
  ]);
  if (input.contractVersion !== REPOSITORY_SNAPSHOT_CONTRACT_VERSION) {
    throw new BuildFailure("invalid-snapshot", "validate");
  }
  if (input.analyzerCapabilityVersion !== REPO_MAP_ANALYZER_CAPABILITY_VERSION) {
    throw new BuildFailure("invalid-enum", "validate");
  }
  const snapshotContentIdentity = string(input.snapshotContentIdentity, limits);
  if (!SNAPSHOT_HASH.test(snapshotContentIdentity)) throw new BuildFailure("invalid-hash", "validate");
  string(input.workspaceRevision, limits);
  string(input.gitHead, limits);
  safeInteger(input.generation);
  knownEnum(input.freshness, new Set(["fresh", "dirty", "stale", "unsupported"]));

  const dirtyPaths = new Map<string, string>();
  for (const item of array(input.dirtyFiles, limits.dirtyEntries, "count")) {
    const dirty = record(item, ["path", "contentHash"]);
    const raw = string(dirty.path, limits, limits.pathBytes);
    const path = canonicalPath(raw, limits);
    if (path !== raw) throw new BuildFailure("invalid-snapshot", "validate");
    if (dirtyPaths.has(path)) throw new BuildFailure("path-collision", "canonicalize", { path });
    dirtyPaths.set(path, raw);
    const hash = string(dirty.contentHash, limits);
    if (hash !== "deleted" && !HASH.test(hash)) throw new BuildFailure("invalid-hash", "validate", { path });
  }
  const pendingPaths = new Map<string, string>();
  for (const item of array(input.pendingPaths, limits.pendingPaths, "count")) {
    const raw = string(item, limits, limits.pathBytes);
    const path = canonicalPath(raw, limits);
    if (path !== raw) throw new BuildFailure("invalid-snapshot", "validate");
    if (pendingPaths.has(path)) throw new BuildFailure("path-collision", "canonicalize", { path });
    pendingPaths.set(path, raw);
  }
  for (const item of array(input.errors, 32)) {
    if (validateDiagnostic(item, limits).severity !== "error") throw new BuildFailure("invalid-snapshot", "validate");
  }
  for (const item of array(input.warnings, 128)) {
    if (validateDiagnostic(item, limits).severity !== "warning") throw new BuildFailure("invalid-snapshot", "validate");
  }

  const snapshot = record(input.snapshot, ["schemaVersion", "provenance", "files", "warnings"]);
  if (snapshot.schemaVersion !== 1) throw new BuildFailure("invalid-snapshot", "validate");
  const provenance = record(
    snapshot.provenance,
    ["generator", "generatorVersion", "parser", "typescriptVersion", "javaParser", "generatedAt", "projectRoot"],
    ["generator", "generatorVersion", "parser", "typescriptVersion", "generatedAt", "projectRoot"],
  );
  if (
    provenance.generator !== "pi-context-vault" ||
    provenance.generatorVersion !== "0.1.0" ||
    provenance.parser !== "typescript-compiler-api"
  ) {
    throw new BuildFailure("invalid-snapshot", "validate");
  }
  const typescriptVersion = string(provenance.typescriptVersion, limits);
  if (Object.hasOwn(provenance, "javaParser") && provenance.javaParser !== "java-parser@3.0.1") {
    throw new BuildFailure("invalid-enum", "validate");
  }
  const generatedAt = string(provenance.generatedAt, limits);
  if (!Number.isFinite(Date.parse(generatedAt))) throw new BuildFailure("invalid-snapshot", "validate");
  const projectRoot = string(provenance.projectRoot, limits);
  for (const value of array(snapshot.warnings, limits.warnings, "count")) {
    const warning = record(value, ["path", "code", "message"]);
    const warningPath = canonicalPath(warning.path, limits);
    if (warningPath !== warning.path) throw new BuildFailure("invalid-snapshot", "validate");
    const code = knownEnum(warning.code, new Set(["parse-error", "read-error"] as const));
    const message = string(warning.message, limits, 512);
    const expected = code === "parse-error" ? "repository snapshot parse failed" : "repository snapshot read failed";
    if (message !== expected) throw new BuildFailure("invalid-snapshot", "validate");
  }

  const files: NormalizedFile[] = [];
  const paths = new Map<string, string>();
  for (const value of array(snapshot.files, limits.files, "count")) {
    const source = record(
      value,
      [
        "path",
        "kind",
        "language",
        "contentHash",
        "sizeBytes",
        "lexicalTerms",
        "imports",
        "exports",
        "symbols",
        "dependencies",
        "packageName",
        "degradedReason",
      ],
      [
        "path",
        "kind",
        "language",
        "contentHash",
        "sizeBytes",
        "lexicalTerms",
        "imports",
        "exports",
        "symbols",
        "dependencies",
      ],
    );
    const rawPath = string(source.path, limits, limits.pathBytes);
    const path = canonicalPath(rawPath, limits);
    if (path !== rawPath) throw new BuildFailure("invalid-snapshot", "validate");
    const prior = paths.get(path);
    if (prior !== undefined) throw new BuildFailure("path-collision", "canonicalize", { path });
    paths.set(path, rawPath);
    const kind = knownEnum(source.kind, FILE_KINDS);
    const language = knownEnum(source.language, LANGUAGES);
    const contentHash = string(source.contentHash, limits);
    if (!HASH.test(contentHash)) throw new BuildFailure("invalid-hash", "validate", { path });
    const sizeBytes = safeInteger(source.sizeBytes);
    const lexicalTerms = stringList(source.lexicalTerms, limits.lexicalTermsPerFile, limits);
    const imports = array(source.imports, limits.importsPerFile).map((entry) => normalizeImport(entry, limits));
    const exports = array(source.exports, limits.exportsPerFile).map((entry) => normalizeExport(entry, limits));
    const symbols = array(source.symbols, limits.symbolsPerFile).map((entry) => {
      addCount(counts, "symbols", limits.symbols);
      return normalizeSymbol(entry, limits);
    });
    const dependencies = stringList(source.dependencies, limits.dependenciesPerFile, limits);
    const packageName = Object.hasOwn(source, "packageName") ? string(source.packageName, limits) : undefined;
    const degradedReason = Object.hasOwn(source, "degradedReason") ? string(source.degradedReason, limits) : undefined;
    files.push({
      path,
      kind,
      language,
      contentHash,
      sizeBytes,
      lexicalTerms,
      imports,
      exports,
      symbols,
      dependencies,
      ...(packageName === undefined ? {} : { packageName }),
      ...(degradedReason === undefined ? {} : { degradedReason }),
    });
  }
  files.sort((left, right) => compareUtf8(left.path, right.path));
  const normalizedSnapshot = {
    schemaVersion: 1 as const,
    provenance: {
      generator: "pi-context-vault" as const,
      generatorVersion: "0.1.0" as const,
      parser: "typescript-compiler-api" as const,
      typescriptVersion,
      ...(Object.hasOwn(provenance, "javaParser") ? { javaParser: "java-parser@3.0.1" as const } : {}),
      generatedAt,
      projectRoot,
    },
    files,
  };
  let identityResult: ReturnType<typeof computeRepositorySnapshotContentIdentity>;
  try {
    identityResult = computeRepositorySnapshotContentIdentity(normalizedSnapshot, limits.canonicalInputBytes);
  } catch (error) {
    if (error instanceof RepositorySnapshotContentIdentityBoundError) {
      throw new BuildFailure("canonical-input-bound-exceeded", "identify", {
        limit: error.limit,
        observed: error.observed,
      });
    }
    throw error;
  }
  if (identityResult.identity !== snapshotContentIdentity) throw new BuildFailure("invalid-snapshot", "validate");
  counts.canonicalBytes = identityResult.canonicalBytes;
  return {
    snapshotContentIdentity: snapshotContentIdentity as `sha256:${string}`,
    files,
  };
}

class IdentityRegistry {
  constructor(
    private readonly counts: BuildCounts,
    private readonly limits: GraphBuildLimits,
    private readonly factory: (prefix: string, domain: string, payload: unknown) => string,
    private readonly accepted: Map<string, string> = new Map<string, string>(),
  ) {}

  create<T extends string>(prefix: string, domain: string, payload: unknown): T {
    const envelope = { domain, payload, version: 1 };
    const chunks: string[] = [];
    let bytes = 0;
    writeJcs(envelope, {
      write: (chunk) => {
        bytes += Buffer.byteLength(chunk, "utf8");
        const observed = this.counts.canonicalBytes + bytes;
        if (!Number.isSafeInteger(observed) || observed > this.limits.canonicalInputBytes) {
          throw new BuildFailure("canonical-input-bound-exceeded", "identify", {
            limit: this.limits.canonicalInputBytes,
            observed,
          });
        }
        chunks.push(chunk);
      },
    });
    this.counts.canonicalBytes += bytes;
    const canonicalEnvelope = chunks.join("");
    const id = this.factory(prefix, domain, payload);
    if (
      typeof id !== "string" ||
      !validUnicode(id) ||
      !id.startsWith(prefix) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(id.slice(prefix.length)) ||
      id.length !== prefix.length + 43
    ) {
      throw new BuildFailure("identity-collision", "identify");
    }
    const prior = this.accepted.get(id);
    if (prior !== undefined && prior !== canonicalEnvelope) throw new BuildFailure("identity-collision", "identify");
    this.accepted.set(id, canonicalEnvelope);
    return id as T;
  }
}

function rowDigest(
  rowKind: EvidenceRowKind,
  row: unknown,
  counts: BuildCounts,
  limits: GraphBuildLimits,
): `sha256:${string}` {
  const payload = { rowDigestSchema: "repo-map-row/v1", rowKind, row };
  const digest = createHash("sha256");
  let bytes = 0;
  writeJcs(payload, {
    write: (chunk) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      const observed = counts.canonicalBytes + bytes;
      if (!Number.isSafeInteger(observed) || observed > limits.canonicalInputBytes) {
        throw new BuildFailure("canonical-input-bound-exceeded", "identify", {
          limit: limits.canonicalInputBytes,
          observed,
        });
      }
      digest.update(chunk, "utf8");
    },
  });
  counts.canonicalBytes += bytes;
  return `sha256:${digest.digest("hex")}`;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
  return Object.freeze(value);
}
function compareOptional(left: string | undefined, right: string | undefined): number {
  if (left === undefined) return right === undefined ? 0 : -1;
  if (right === undefined) return 1;
  return compareUtf8(left, right);
}
function compareEdges(left: GraphAssemblyEdge, right: GraphAssemblyEdge): number {
  return (
    compareUtf8(left.sourceId, right.sourceId) ||
    compareUtf8(left.relation, right.relation) ||
    compareOptional(left.referenceId, right.referenceId) ||
    compareOptional(left.targetId, right.targetId) ||
    compareUtf8(left.id, right.id)
  );
}
function compareWork(left: GraphResolverWorkItem, right: GraphResolverWorkItem): number {
  return (
    compareUtf8(left.sourceFileId, right.sourceFileId) ||
    compareUtf8(left.workKind, right.workKind) ||
    compareUtf8(left.referenceId, right.referenceId) ||
    compareUtf8(left.evidence.id, right.evidence.id)
  );
}

interface PendingEdge {
  readonly descriptor: GraphAssemblyEdge["descriptor"];
  readonly evidence: GraphEvidence[];
  evidenceCount: number;
}

function finalizeAssemblyEdge(id: EdgeId, pending: PendingEdge, retained: GraphEvidence[]): GraphAssemblyEdge {
  const common = {
    id,
    evidence: retained,
    evidenceCount: pending.evidenceCount,
    omittedEvidenceCount: pending.evidenceCount - retained.length,
  };
  const descriptor = pending.descriptor;
  switch (descriptor.relation) {
    case "DECLARES":
      return {
        ...common,
        descriptor,
        sourceId: descriptor.sourceId,
        relation: "DECLARES",
        targetId: descriptor.targetId,
      };
    case "ANALYZER_EXPORT_FLAG":
      return {
        ...common,
        descriptor,
        sourceId: descriptor.sourceId,
        relation: "ANALYZER_EXPORT_FLAG",
        targetId: descriptor.targetId,
      };
    case "EXPORTS_NAME":
      return {
        ...common,
        descriptor,
        sourceId: descriptor.sourceId,
        relation: "EXPORTS_NAME",
        referenceId: descriptor.referenceId,
      };
    case "DEPENDS_ON_RAW":
      return {
        ...common,
        descriptor,
        sourceId: descriptor.sourceId,
        relation: "DEPENDS_ON_RAW",
        referenceId: descriptor.referenceId,
      };
    case "JAVA_EXTENDS_NAME":
      return {
        ...common,
        descriptor,
        sourceId: descriptor.sourceId,
        relation: "JAVA_EXTENDS_NAME",
        referenceId: descriptor.referenceId,
      };
    case "JAVA_IMPLEMENTS_NAME":
      return {
        ...common,
        descriptor,
        sourceId: descriptor.sourceId,
        relation: "JAVA_IMPLEMENTS_NAME",
        referenceId: descriptor.referenceId,
      };
    case "JAVA_PERMITS_NAME":
      return {
        ...common,
        descriptor,
        sourceId: descriptor.sourceId,
        relation: "JAVA_PERMITS_NAME",
        referenceId: descriptor.referenceId,
      };
  }
}

function normalizeBuildOptions(options: GraphBuildOptions): NormalizedBuildContext {
  const optionFields = record(options, ["limits", "createId"], []);
  const limitKeys = Object.keys(DEFAULT_LIMITS) as (keyof GraphBuildLimits)[];
  const overrides = Object.hasOwn(optionFields, "limits") ? record(optionFields.limits, limitKeys, []) : {};
  const limits = { ...DEFAULT_LIMITS };
  for (const key of limitKeys) {
    if (!Object.hasOwn(overrides, key)) continue;
    const value = overrides[key];
    const minimum = key === "retainedCandidates" ? 1 : 0;
    if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > DEFAULT_LIMITS[key]) {
      throw new BuildFailure("invalid-snapshot", "validate");
    }
    limits[key] = value as number;
  }
  const idFactory = Object.hasOwn(optionFields, "createId") ? optionFields.createId : createDomainSeparatedId;
  if (typeof idFactory !== "function") throw new BuildFailure("invalid-snapshot", "validate");
  return { limits, idFactory: idFactory as NormalizedBuildContext["idFactory"] };
}

function unavailable(error: unknown, fallbackPhase: GraphBuildError["phase"] = "validate"): GraphBuildUnavailable {
  if (error instanceof BuildFailure) return { ok: false, error: error.graphError };
  return {
    ok: false,
    error: {
      code: "invalid-snapshot",
      phase: fallbackPhase,
      message: ERROR_MESSAGES["invalid-snapshot"],
    },
  };
}

/**
 * Builds the bounded resolver-independent S02b assembly. It intentionally cannot return
 * RepositoryGraphV1: import/re-export/Java-import endpoint selection belongs to Resolver S02c.
 */
export function buildRepositoryGraphAssembly(
  handle: RepositorySnapshotHandle | unknown,
  options: GraphAssemblyBuildOptions = {},
): GraphAssemblyBuildResult {
  try {
    return buildRepositoryGraphAssemblyWithContext(handle, normalizeBuildOptions(options));
  } catch (error) {
    return unavailable(error);
  }
}

function buildRepositoryGraphAssemblyWithContext(
  handle: RepositorySnapshotHandle | unknown,
  context: NormalizedBuildContext,
): GraphAssemblyBuildResult {
  try {
    const { limits, idFactory } = context;
    const counts: BuildCounts = { symbols: 0, references: 0, edges: 0, evidence: 0, canonicalBytes: 0 };
    const input = validateHandle(handle, limits, counts);
    const identities = new IdentityRegistry(counts, limits, idFactory);
    const files: FileNode[] = [];
    const fileResolverMetadata: GraphFileResolverMetadata[] = [];
    const symbols: SymbolNode[] = [];
    const references = new Map<ReferenceId, GraphReference>();
    const pendingEdges = new Map<EdgeId, PendingEdge>();
    const resolverWorkItems: GraphResolverWorkItem[] = [];

    const addReference = (descriptor: GraphReferenceDescriptor): GraphReference => {
      addCount(counts, "references", limits.references);
      const id = identities.create<ReferenceId>("reference:sha256:", "repository-graph/reference", descriptor);
      const existing = references.get(id);
      if (existing !== undefined) return existing;
      const reference = { id, descriptor } satisfies GraphReference;
      references.set(id, reference);
      return reference;
    };
    const addEvidence = (descriptor: GraphEvidenceDescriptor, explanation: GraphEvidenceExplanation): GraphEvidence => {
      addCount(counts, "evidence", limits.evidence);
      const id = identities.create<EvidenceId>("evidence:sha256:", "repository-graph/evidence", descriptor);
      return { id, descriptor, explanation };
    };
    const contributeEdge = (descriptor: GraphAssemblyEdge["descriptor"], evidence: GraphEvidence): void => {
      addCount(counts, "edges", limits.edges);
      const id = identities.create<EdgeId>("edge:sha256:", "repository-graph/edge", descriptor);
      const existing = pendingEdges.get(id);
      if (existing === undefined) {
        pendingEdges.set(id, { descriptor, evidence: [evidence], evidenceCount: 1 });
      } else {
        existing.evidenceCount += 1;
        existing.evidence.push(evidence);
      }
    };

    for (const file of input.files) {
      const fileDescriptor: FileDescriptor = { canonicalPath: file.path };
      const fileId = identities.create<FileId>("file:sha256:", "repository-graph/file", fileDescriptor);
      files.push({
        nodeKind: "file",
        id: fileId,
        descriptor: fileDescriptor,
        language: file.language,
        fileKind: file.kind,
        contentHash: file.contentHash,
        sizeBytes: file.sizeBytes,
      });
      fileResolverMetadata.push({
        fileId,
        packageName: file.packageName ?? null,
        degradedReason: file.degradedReason ?? null,
      });
      const evidenceOccurrences = new Map<string, number>();
      const evidence = (
        rowKind: EvidenceRowKind,
        row: unknown,
        recordedRowOrdinal: number,
        recordedNestedOrdinal: number | null,
        explanation: GraphEvidenceExplanation,
      ): GraphEvidence => {
        const digest = rowDigest(rowKind, row, counts, limits);
        const key = `${rowKind}\0${digest}`;
        const occurrenceOrdinal = (evidenceOccurrences.get(key) ?? 0) + 1;
        evidenceOccurrences.set(key, occurrenceOrdinal);
        const common = {
          sourceFileId: fileId,
          recordedRowOrdinal,
          canonicalRowDigest: digest,
          occurrenceOrdinal,
        };
        switch (rowKind) {
          case "import":
          case "export":
          case "symbol":
          case "dependency": {
            if (recordedNestedOrdinal !== null) throw new BuildFailure("invalid-snapshot", "validate");
            const descriptor: GraphEvidenceDescriptor = { ...common, rowKind, recordedNestedOrdinal: null };
            return addEvidence(descriptor, explanation);
          }
          case "java-relationship": {
            if (recordedNestedOrdinal === null) throw new BuildFailure("invalid-snapshot", "validate");
            const descriptor: GraphEvidenceDescriptor = { ...common, rowKind, recordedNestedOrdinal };
            return addEvidence(descriptor, explanation);
          }
        }
      };

      for (let ordinal = 0; ordinal < file.imports.length; ordinal += 1) {
        const row = file.imports[ordinal] as RepoMapImport;
        const itemEvidence = evidence("import", row, ordinal, null, {
          rowKind: "import",
          source: row.source,
          names: [...row.names],
          typeOnly: row.typeOnly,
          static: row.static ?? null,
          wildcard: row.wildcard ?? null,
        });
        if (file.language === "java") {
          const reference = addReference({
            kind: "java-import-name",
            raw: row.source,
            static: row.static ?? null,
            wildcard: row.wildcard ?? null,
          });
          resolverWorkItems.push({
            workKind: "java-import",
            sourceFileId: fileId,
            referenceId: reference.id,
            evidence: itemEvidence,
          });
        } else if (file.language === "typescript" || file.language === "javascript") {
          const reference = addReference({ kind: "module-specifier", language: file.language, raw: row.source });
          resolverWorkItems.push({
            workKind: "tsjs-import",
            sourceFileId: fileId,
            referenceId: reference.id,
            evidence: itemEvidence,
          });
        }
      }

      for (let ordinal = 0; ordinal < file.exports.length; ordinal += 1) {
        const row = file.exports[ordinal] as RepoMapFile["exports"][number];
        const itemEvidence = evidence("export", row, ordinal, null, {
          rowKind: "export",
          name: row.name,
          source: row.source ?? null,
          typeOnly: row.typeOnly,
        });
        const nameReference = addReference({ kind: "export-name", language: file.language, raw: row.name });
        const descriptor: AssemblyFileReferenceEdge<"EXPORTS_NAME">["descriptor"] = {
          descriptorKind: "reference",
          sourceId: fileId,
          relation: "EXPORTS_NAME",
          referenceId: nameReference.id,
        };
        contributeEdge(descriptor, itemEvidence);
        if (row.source !== undefined && (file.language === "typescript" || file.language === "javascript")) {
          const moduleReference = addReference({ kind: "module-specifier", language: file.language, raw: row.source });
          resolverWorkItems.push({
            workKind: "tsjs-reexport",
            sourceFileId: fileId,
            referenceId: moduleReference.id,
            evidence: itemEvidence,
          });
        }
      }

      const symbolOccurrences = new Map<string, number>();
      const symbolIds: SymbolId[] = [];
      for (let ordinal = 0; ordinal < file.symbols.length; ordinal += 1) {
        const row = file.symbols[ordinal] as RepoMapSymbol;
        const base = {
          fileId,
          language: file.language,
          symbolKind: row.kind,
          container: file.language === "java" ? (row.container ?? null) : null,
          name: row.name,
          signature: row.signature,
        };
        const occurrenceKey = canonicalizeJcs(base);
        const occurrenceOrdinal = (symbolOccurrences.get(occurrenceKey) ?? 0) + 1;
        symbolOccurrences.set(occurrenceKey, occurrenceOrdinal);
        const descriptor: SymbolDescriptor = { ...base, occurrenceOrdinal };
        const symbolId = identities.create<SymbolId>("symbol:sha256:", "repository-graph/symbol", descriptor);
        symbolIds.push(symbolId);
        symbols.push({ nodeKind: "symbol", id: symbolId, descriptor, recordedRowOrdinal: ordinal, row });
        const symbolEvidence = evidence("symbol", row, ordinal, null, {
          rowKind: "symbol",
          symbolId,
          name: row.name,
          symbolKind: row.kind,
          line: row.line,
        });
        const declares: AssemblyDirectEdge<"DECLARES">["descriptor"] = {
          descriptorKind: "direct",
          sourceId: fileId,
          relation: "DECLARES",
          targetId: symbolId,
        };
        contributeEdge(declares, symbolEvidence);
        if (row.exported) {
          const exportFlag: AssemblyDirectEdge<"ANALYZER_EXPORT_FLAG">["descriptor"] = {
            descriptorKind: "direct",
            sourceId: fileId,
            relation: "ANALYZER_EXPORT_FLAG",
            targetId: symbolId,
          };
          contributeEdge(exportFlag, symbolEvidence);
        }
      }

      if (file.language === "java") {
        const relationshipData = [
          ["extends", "JAVA_EXTENDS_NAME"],
          ["implements", "JAVA_IMPLEMENTS_NAME"],
          ["permits", "JAVA_PERMITS_NAME"],
        ] as const;
        for (let symbolOrdinal = 0; symbolOrdinal < file.symbols.length; symbolOrdinal += 1) {
          const row = file.symbols[symbolOrdinal] as RepoMapSymbol;
          const symbolId = symbolIds[symbolOrdinal] as SymbolId;
          for (const [relationship, relation] of relationshipData) {
            const values = row.relationships?.[relationship] ?? [];
            for (let nestedOrdinal = 0; nestedOrdinal < values.length; nestedOrdinal += 1) {
              const raw = values[nestedOrdinal] as string;
              const relationshipEvidence = evidence(
                "java-relationship",
                { symbolRow: row, relationship, raw },
                symbolOrdinal,
                nestedOrdinal,
                { rowKind: "java-relationship", symbolId, relationship, raw },
              );
              const reference = addReference({ kind: "java-relationship-name", relationship, raw });
              const descriptor: AssemblySymbolReferenceEdge<typeof relation>["descriptor"] = {
                descriptorKind: "reference",
                sourceId: symbolId,
                relation,
                referenceId: reference.id,
              };
              contributeEdge(descriptor, relationshipEvidence);
            }
          }
        }
      }

      for (let ordinal = 0; ordinal < file.dependencies.length; ordinal += 1) {
        const raw = file.dependencies[ordinal] as string;
        const dependencyEvidence = evidence("dependency", raw, ordinal, null, { rowKind: "dependency", raw });
        const reference = addReference({ kind: "raw-dependency", language: file.language, raw });
        const descriptor: AssemblyFileReferenceEdge<"DEPENDS_ON_RAW">["descriptor"] = {
          descriptorKind: "reference",
          sourceId: fileId,
          relation: "DEPENDS_ON_RAW",
          referenceId: reference.id,
        };
        contributeEdge(descriptor, dependencyEvidence);
      }
    }

    const edges: GraphAssemblyEdge[] = [];
    for (const [id, pending] of pendingEdges) {
      pending.evidence.sort((left, right) => compareUtf8(left.id, right.id));
      const retained = pending.evidence.slice(0, limits.retainedEvidence);
      edges.push(finalizeAssemblyEdge(id, pending, retained));
    }
    files.sort((left, right) => compareUtf8(left.id, right.id));
    fileResolverMetadata.sort((left, right) => compareUtf8(left.fileId, right.fileId));
    symbols.sort((left, right) => compareUtf8(left.id, right.id));
    const orderedReferences = [...references.values()].sort((left, right) => compareUtf8(left.id, right.id));
    edges.sort(compareEdges);
    resolverWorkItems.sort(compareWork);
    const assembly: RepositoryGraphAssembly = {
      analyzerCapabilityVersion: REPO_MAP_ANALYZER_CAPABILITY_VERSION,
      snapshotContentIdentity: input.snapshotContentIdentity,
      canonicalInputBytesUsed: counts.canonicalBytes,
      files,
      fileResolverMetadata,
      symbols,
      references: orderedReferences,
      edges,
      resolverWorkItems,
    };
    deepFreeze(assembly);
    TRUSTED_GRAPH_ASSEMBLIES.add(assembly);
    return { ok: true, assembly };
  } catch (error) {
    return unavailable(error);
  }
}

class AssemblyVerificationFailure extends Error {}

interface VerifiedAssembly {
  readonly acceptedIdentities: Map<string, string>;
  readonly fileById: Map<FileId, FileNode>;
  readonly metadataByFile: Map<FileId, GraphFileResolverMetadata>;
  readonly symbolById: Map<SymbolId, SymbolNode>;
  readonly referenceById: Map<ReferenceId, GraphReference>;
  readonly existingEdgeContributions: number;
  readonly existingEvidence: number;
}

function failAssembly(): never {
  throw new AssemblyVerificationFailure();
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !isProxy(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function verifyAssemblyIdentity(
  id: unknown,
  prefix: string,
  domain: string,
  payload: unknown,
  context: NormalizedBuildContext,
  accepted: Map<string, string>,
): string {
  if (
    typeof id !== "string" ||
    !id.startsWith(prefix) ||
    id.length !== prefix.length + 43 ||
    !/^[A-Za-z0-9_-]{43}$/u.test(id.slice(prefix.length))
  ) {
    return failAssembly();
  }
  const envelope = canonicalizeJcs({ domain, payload, version: 1 });
  const prior = accepted.get(id);
  if (prior !== undefined && prior !== envelope) return failAssembly();
  if (prior === undefined) {
    let expected: unknown;
    try {
      expected = context.idFactory(prefix, domain, payload);
    } catch {
      return failAssembly();
    }
    if (expected !== id) return failAssembly();
    accepted.set(id, envelope);
  }
  return id;
}

function verifyRepositoryGraphAssembly(
  value: RepositoryGraphAssembly | unknown,
  context: NormalizedBuildContext,
): VerifiedAssembly {
  if (!plainObject(value)) return failAssembly();
  const assembly = value as unknown as RepositoryGraphAssembly;
  if (
    assembly.analyzerCapabilityVersion !== REPO_MAP_ANALYZER_CAPABILITY_VERSION ||
    !SNAPSHOT_HASH.test(assembly.snapshotContentIdentity ?? "") ||
    !Number.isSafeInteger(assembly.canonicalInputBytesUsed) ||
    assembly.canonicalInputBytesUsed < 0 ||
    assembly.canonicalInputBytesUsed > context.limits.canonicalInputBytes ||
    !Array.isArray(assembly.files) ||
    !Array.isArray(assembly.fileResolverMetadata) ||
    !Array.isArray(assembly.symbols) ||
    !Array.isArray(assembly.references) ||
    !Array.isArray(assembly.edges) ||
    !Array.isArray(assembly.resolverWorkItems)
  ) {
    return failAssembly();
  }
  if (
    assembly.files.length > context.limits.files ||
    assembly.fileResolverMetadata.length !== assembly.files.length ||
    assembly.symbols.length > context.limits.symbols ||
    assembly.references.length > context.limits.references
  ) {
    return failAssembly();
  }

  const acceptedIdentities = new Map<string, string>();
  const fileById = new Map<FileId, FileNode>();
  for (const file of assembly.files) {
    if (
      !plainObject(file as unknown) ||
      file.nodeKind !== "file" ||
      !plainObject(file.descriptor as unknown) ||
      typeof file.descriptor.canonicalPath !== "string" ||
      !LANGUAGES.has(file.language) ||
      !FILE_KINDS.has(file.fileKind) ||
      !HASH.test(file.contentHash) ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0
    ) {
      return failAssembly();
    }
    verifyAssemblyIdentity(
      file.id,
      "file:sha256:",
      "repository-graph/file",
      file.descriptor,
      context,
      acceptedIdentities,
    );
    if (fileById.has(file.id)) return failAssembly();
    fileById.set(file.id, file);
  }

  const metadataByFile = new Map<FileId, GraphFileResolverMetadata>();
  for (const metadata of assembly.fileResolverMetadata) {
    if (
      !plainObject(metadata as unknown) ||
      !fileById.has(metadata.fileId) ||
      (metadata.packageName !== null && typeof metadata.packageName !== "string") ||
      (metadata.degradedReason !== null && typeof metadata.degradedReason !== "string") ||
      metadataByFile.has(metadata.fileId)
    ) {
      return failAssembly();
    }
    metadataByFile.set(metadata.fileId, metadata);
  }

  const symbolById = new Map<SymbolId, SymbolNode>();
  for (const symbol of assembly.symbols) {
    if (
      !plainObject(symbol as unknown) ||
      symbol.nodeKind !== "symbol" ||
      !plainObject(symbol.descriptor as unknown) ||
      !fileById.has(symbol.descriptor.fileId) ||
      symbol.descriptor.language !== fileById.get(symbol.descriptor.fileId)?.language ||
      !SYMBOL_KINDS.has(symbol.descriptor.symbolKind) ||
      typeof symbol.descriptor.name !== "string" ||
      typeof symbol.descriptor.signature !== "string" ||
      (symbol.descriptor.container !== null && typeof symbol.descriptor.container !== "string") ||
      !Number.isSafeInteger(symbol.descriptor.occurrenceOrdinal) ||
      symbol.descriptor.occurrenceOrdinal < 1 ||
      !Number.isSafeInteger(symbol.recordedRowOrdinal) ||
      symbol.recordedRowOrdinal < 0 ||
      !plainObject(symbol.row as unknown)
    ) {
      return failAssembly();
    }
    verifyAssemblyIdentity(
      symbol.id,
      "symbol:sha256:",
      "repository-graph/symbol",
      symbol.descriptor,
      context,
      acceptedIdentities,
    );
    if (symbolById.has(symbol.id)) return failAssembly();
    symbolById.set(symbol.id, symbol);
  }

  const referenceById = new Map<ReferenceId, GraphReference>();
  for (const reference of assembly.references) {
    if (!plainObject(reference as unknown) || !plainObject(reference.descriptor as unknown)) failAssembly();
    verifyAssemblyIdentity(
      reference.id,
      "reference:sha256:",
      "repository-graph/reference",
      reference.descriptor,
      context,
      acceptedIdentities,
    );
    if (referenceById.has(reference.id)) return failAssembly();
    referenceById.set(reference.id, reference);
  }

  const evidenceById = new Map<EvidenceId, string>();
  const verifyEvidence = (evidence: GraphEvidence): void => {
    if (
      !plainObject(evidence as unknown) ||
      !plainObject(evidence.descriptor as unknown) ||
      !plainObject(evidence.explanation as unknown)
    ) {
      failAssembly();
    }
    if (!fileById.has(evidence.descriptor.sourceFileId)) failAssembly();
    verifyAssemblyIdentity(
      evidence.id,
      "evidence:sha256:",
      "repository-graph/evidence",
      evidence.descriptor,
      context,
      acceptedIdentities,
    );
    const serialized = canonicalizeJcs(evidence);
    const prior = evidenceById.get(evidence.id);
    if (prior !== undefined && prior !== serialized) failAssembly();
    evidenceById.set(evidence.id, serialized);
  };

  let existingEdgeContributions = 0;
  const edgeIds = new Set<EdgeId>();
  const directRelations = new Set<RelationKind>(["DECLARES", "ANALYZER_EXPORT_FLAG"]);
  const fileReferenceRelations = new Set<RelationKind>(["EXPORTS_NAME", "DEPENDS_ON_RAW"]);
  const symbolReferenceRelations = new Set<RelationKind>([
    "JAVA_EXTENDS_NAME",
    "JAVA_IMPLEMENTS_NAME",
    "JAVA_PERMITS_NAME",
  ]);
  for (const edge of assembly.edges) {
    if (
      !plainObject(edge as unknown) ||
      !plainObject(edge.descriptor as unknown) ||
      !Array.isArray(edge.evidence) ||
      !Number.isSafeInteger(edge.evidenceCount) ||
      !Number.isSafeInteger(edge.omittedEvidenceCount) ||
      edge.evidenceCount < edge.evidence.length ||
      edge.omittedEvidenceCount !== edge.evidenceCount - edge.evidence.length ||
      edge.evidence.length > context.limits.retainedEvidence ||
      edgeIds.has(edge.id)
    ) {
      return failAssembly();
    }
    edgeIds.add(edge.id);
    existingEdgeContributions += edge.evidenceCount;
    if (!Number.isSafeInteger(existingEdgeContributions) || existingEdgeContributions > context.limits.edges) {
      return failAssembly();
    }
    verifyAssemblyIdentity(
      edge.id,
      "edge:sha256:",
      "repository-graph/edge",
      edge.descriptor,
      context,
      acceptedIdentities,
    );
    if (
      edge.descriptor.sourceId !== edge.sourceId ||
      edge.descriptor.relation !== edge.relation ||
      (directRelations.has(edge.relation)
        ? edge.descriptor.descriptorKind !== "direct" ||
          !fileById.has(edge.sourceId as FileId) ||
          !symbolById.has(edge.targetId as SymbolId) ||
          edge.descriptor.targetId !== edge.targetId ||
          symbolById.get(edge.targetId as SymbolId)?.descriptor.fileId !== edge.sourceId ||
          edge.referenceId !== undefined
        : edge.descriptor.descriptorKind !== "reference" ||
          edge.descriptor.referenceId !== edge.referenceId ||
          !referenceById.has(edge.referenceId as ReferenceId) ||
          edge.targetId !== undefined ||
          (fileReferenceRelations.has(edge.relation)
            ? !fileById.has(edge.sourceId as FileId)
            : !symbolReferenceRelations.has(edge.relation) || !symbolById.has(edge.sourceId as SymbolId)))
    ) {
      return failAssembly();
    }
    const expectedEvidenceFile =
      directRelations.has(edge.relation) || fileReferenceRelations.has(edge.relation)
        ? (edge.sourceId as FileId)
        : (symbolById.get(edge.sourceId as SymbolId)?.descriptor.fileId as FileId);
    const edgeReference = edge.referenceId === undefined ? undefined : referenceById.get(edge.referenceId);
    if (
      (edge.relation === "EXPORTS_NAME" && edgeReference?.descriptor.kind !== "export-name") ||
      (edge.relation === "DEPENDS_ON_RAW" && edgeReference?.descriptor.kind !== "raw-dependency") ||
      (symbolReferenceRelations.has(edge.relation) && edgeReference?.descriptor.kind !== "java-relationship-name")
    ) {
      return failAssembly();
    }
    let previous: string | undefined;
    for (const evidence of edge.evidence) {
      verifyEvidence(evidence);
      if (
        evidence.descriptor.sourceFileId !== expectedEvidenceFile ||
        (directRelations.has(edge.relation) &&
          (evidence.descriptor.rowKind !== "symbol" ||
            evidence.explanation.rowKind !== "symbol" ||
            evidence.explanation.symbolId !== edge.targetId)) ||
        (edge.relation === "EXPORTS_NAME" && evidence.descriptor.rowKind !== "export") ||
        (edge.relation === "DEPENDS_ON_RAW" && evidence.descriptor.rowKind !== "dependency") ||
        (symbolReferenceRelations.has(edge.relation) && evidence.descriptor.rowKind !== "java-relationship")
      ) {
        return failAssembly();
      }
      if (previous !== undefined && compareUtf8(previous, evidence.id) > 0) return failAssembly();
      previous = evidence.id;
    }
  }

  for (const work of assembly.resolverWorkItems) {
    if (!plainObject(work as unknown) || !fileById.has(work.sourceFileId) || !referenceById.has(work.referenceId)) {
      return failAssembly();
    }
    const reference = referenceById.get(work.referenceId) as GraphReference;
    const file = fileById.get(work.sourceFileId) as FileNode;
    if (
      ((work.workKind === "tsjs-import" || work.workKind === "tsjs-reexport") &&
        (reference.descriptor.kind !== "module-specifier" ||
          reference.descriptor.language !== file.language ||
          (file.language !== "typescript" && file.language !== "javascript"))) ||
      (work.workKind === "java-import" &&
        (reference.descriptor.kind !== "java-import-name" || file.language !== "java")) ||
      (work.workKind !== "tsjs-import" && work.workKind !== "tsjs-reexport" && work.workKind !== "java-import")
    ) {
      return failAssembly();
    }
    verifyEvidence(work.evidence);
    if (
      work.evidence.descriptor.sourceFileId !== work.sourceFileId ||
      (work.workKind === "tsjs-reexport"
        ? work.evidence.descriptor.rowKind !== "export" || work.evidence.explanation.rowKind !== "export"
        : work.evidence.descriptor.rowKind !== "import" || work.evidence.explanation.rowKind !== "import")
    ) {
      return failAssembly();
    }
  }
  if (evidenceById.size > context.limits.evidence) return failAssembly();

  return {
    acceptedIdentities,
    fileById,
    metadataByFile,
    symbolById,
    referenceById,
    existingEdgeContributions,
    existingEvidence: evidenceById.size,
  };
}

interface ResolutionDecision {
  readonly resolution: GraphResolution;
  readonly targetId?: FileId | ExternalModuleId;
}

function compareCandidates(left: ResolutionCandidate, right: ResolutionCandidate): number {
  return left.precedence - right.precedence || compareUtf8(left.rule, right.rule) || compareUtf8(left.id, right.id);
}

function retainedResolution(
  status: ResolutionStatus,
  rule: ResolverRuleCode,
  reason: ResolverReasonCode,
  candidates: readonly ResolutionCandidate[],
  limit: number,
): GraphResolution {
  const unique = new Map<string, ResolutionCandidate>();
  for (const candidate of candidates) {
    unique.set(`${candidate.id}\0${candidate.precedence}\0${candidate.rule}`, candidate);
  }
  const ordered = [...unique.values()].sort(compareCandidates);
  const retained = ordered.slice(0, limit);
  return {
    status,
    rule,
    reason,
    candidates: retained,
    omittedCandidateCount: ordered.length - retained.length,
  };
}

function decideCandidates(
  candidates: readonly ResolutionCandidate[],
  limit: number,
  unresolvedRule: ResolverRuleCode,
  noCandidateReason: ResolverReasonCode,
  duplicateExactReason: ResolverReasonCode = "ambiguous-highest-precedence",
): ResolutionDecision {
  if (candidates.length === 0) {
    return {
      resolution: retainedResolution("unresolved", unresolvedRule, noCandidateReason, [], limit),
    };
  }
  const ordered = [...candidates].sort(compareCandidates);
  const precedence = ordered[0]?.precedence as number;
  const winning = ordered.filter((candidate) => candidate.precedence === precedence);
  const targets = [...new Set(winning.map((candidate) => candidate.id))];
  if (targets.length !== 1) {
    return {
      resolution: retainedResolution(
        "unresolved",
        unresolvedRule,
        precedence === 0 ? duplicateExactReason : "ambiguous-highest-precedence",
        ordered,
        limit,
      ),
    };
  }
  const winner = winning[0] as ResolutionCandidate;
  return {
    resolution: retainedResolution(precedence === 0 ? "exact" : "heuristic", winner.rule, "none", ordered, limit),
    targetId: targets[0] as FileId | ExternalModuleId,
  };
}

function fixedResolution(
  status: ResolutionStatus,
  rule: ResolverRuleCode,
  reason: ResolverReasonCode,
): GraphResolution {
  return { status, rule, reason, candidates: [], omittedCandidateCount: 0 };
}

function unresolvedDecision(reason: ResolverReasonCode, limit: number): ResolutionDecision {
  return {
    resolution: retainedResolution("unresolved", "unresolved-tsjs-module-reference", reason, [], limit),
  };
}

function resolveRelativePath(importerPath: string, literal: string): { path?: string; escaped: boolean } {
  const importerSegments = importerPath.split("/");
  importerSegments.pop();
  for (const segment of literal.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (importerSegments.length === 0) return { escaped: true };
      importerSegments.pop();
    } else {
      importerSegments.push(segment);
    }
  }
  return { path: importerSegments.join("/"), escaped: false };
}

const TSJS_SUFFIXES = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;
const JS_FAMILY_REPLACEMENTS: Readonly<Record<string, readonly string[]>> = {
  ".js": [".ts", ".tsx", ".d.ts"],
  ".jsx": [".tsx", ".d.ts"],
  ".mjs": [".mts", ".d.mts"],
  ".cjs": [".cts", ".d.cts"],
};

function tsjsFileDecision(
  importer: FileNode,
  literal: string,
  filesByPath: ReadonlyMap<string, FileNode>,
  limit: number,
): ResolutionDecision {
  const normalized = resolveRelativePath(importer.descriptor.canonicalPath, literal);
  if (normalized.escaped) return unresolvedDecision("project-root-escape", limit);
  const base = normalized.path as string;
  const directoryIntent = literal.endsWith("/");
  const candidates: ResolutionCandidate[] = [];
  const addFile = (path: string, precedence: number, rule: ResolverRuleCode): void => {
    const file = filesByPath.get(path);
    if (file !== undefined) candidates.push({ id: file.id, precedence, rule });
  };
  const lastSegment = base.slice(base.lastIndexOf("/") + 1);
  const extensionless = lastSegment.length > 0 && !lastSegment.includes(".");
  let literalPresent = false;
  if (!directoryIntent) {
    const literalFile = filesByPath.get(base);
    literalPresent = literalFile !== undefined;
    if (literalFile !== undefined)
      candidates.push({ id: literalFile.id, precedence: 0, rule: "tsjs-relative-literal" });
    if (!literalPresent) {
      for (const [suffix, replacements] of Object.entries(JS_FAMILY_REPLACEMENTS)) {
        if (!base.endsWith(suffix)) continue;
        const stem = base.slice(0, -suffix.length);
        for (let index = 0; index < replacements.length; index += 1) {
          addFile(`${stem}${replacements[index]}`, 100 + index, "tsjs-js-family-substitution");
        }
        break;
      }
    }
    if (extensionless) {
      for (let index = 0; index < TSJS_SUFFIXES.length; index += 1) {
        addFile(`${base}${TSJS_SUFFIXES[index]}`, 200 + index, "tsjs-extensionless-file");
      }
    }
  }
  if (extensionless || directoryIntent) {
    const directory = base.length === 0 ? "" : `${base}/`;
    for (let index = 0; index < TSJS_SUFFIXES.length; index += 1) {
      addFile(`${directory}index${TSJS_SUFFIXES[index]}`, 300 + index, "tsjs-extensionless-index");
    }
  }
  return decideCandidates(candidates, limit, "unresolved-tsjs-module-reference", "no-candidate");
}

function classifyTsjsLiteral(literal: string): ResolverReasonCode | null {
  if (literal.length === 0) return "invalid-specifier";
  if (literal.includes("\0")) return "nul-specifier";
  if (literal.includes("?") || literal.includes("#")) return "query-or-fragment-unsupported";
  if (/^(?:\/|\\|[A-Za-z]:[\\/])/u.test(literal)) return "absolute-specifier-unsupported";
  if (literal.includes("\\")) return "invalid-specifier";
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(literal) && !literal.startsWith("node:")) {
    return "url-scheme-unsupported";
  }
  if (literal === "node:") return "node-builtin-name-missing";
  return null;
}

interface JavaResolverIndex {
  readonly topLevelByFqn: Map<string, Set<FileId>>;
  readonly immediateByPackageAndName: Map<string, Set<FileId>>;
  readonly packages: Set<string>;
}

function buildJavaResolverIndex(assembly: RepositoryGraphAssembly, verified: VerifiedAssembly): JavaResolverIndex {
  const topLevelByFqn = new Map<string, Set<FileId>>();
  const immediateByPackageAndName = new Map<string, Set<FileId>>();
  const packages = new Set<string>();
  const eligibleKinds = new Set<RepoMapSymbol["kind"]>(["class", "interface", "enum", "record", "annotation"]);
  const symbolsByFile = new Map<FileId, SymbolNode[]>();
  for (const symbol of assembly.symbols) {
    const symbols = symbolsByFile.get(symbol.descriptor.fileId) ?? [];
    symbols.push(symbol);
    symbolsByFile.set(symbol.descriptor.fileId, symbols);
  }
  for (const file of assembly.files) {
    const metadata = verified.metadataByFile.get(file.id) as GraphFileResolverMetadata;
    if (file.language !== "java" || file.fileKind !== "semantic" || metadata.degradedReason !== null) continue;
    const packageName = metadata.packageName ?? "";
    packages.add(packageName);
    for (const symbol of symbolsByFile.get(file.id) ?? []) {
      if (!eligibleKinds.has(symbol.descriptor.symbolKind)) continue;
      if (symbol.descriptor.container === null) {
        const fqn = packageName === "" ? symbol.descriptor.name : `${packageName}.${symbol.descriptor.name}`;
        const matches = topLevelByFqn.get(fqn) ?? new Set<FileId>();
        matches.add(file.id);
        topLevelByFqn.set(fqn, matches);
      } else {
        const spelling = `${symbol.descriptor.container}.${symbol.descriptor.name}`;
        const key = `${packageName}\0${spelling}`;
        const matches = immediateByPackageAndName.get(key) ?? new Set<FileId>();
        matches.add(file.id);
        immediateByPackageAndName.set(key, matches);
      }
    }
  }
  return { topLevelByFqn, immediateByPackageAndName, packages };
}

function javaDecision(
  descriptor: Extract<GraphReferenceDescriptor, { kind: "java-import-name" }>,
  index: JavaResolverIndex,
  limit: number,
): ResolutionDecision {
  if (descriptor.static === null || descriptor.wildcard === null) {
    return { resolution: fixedResolution("unresolved", "unresolved-java-import", "java-import-flags-missing") };
  }
  if (descriptor.wildcard) {
    return { resolution: fixedResolution("unresolved", "unresolved-java-import", "java-wildcard-unsupported") };
  }
  const segments = descriptor.raw.split(".");
  if (descriptor.raw.length === 0 || segments.some((segment) => segment.length === 0)) {
    return { resolution: fixedResolution("unresolved", "unresolved-java-import", "invalid-specifier") };
  }
  if (descriptor.raw.includes("\0")) {
    return { resolution: fixedResolution("unresolved", "unresolved-java-import", "nul-specifier") };
  }
  if (descriptor.static) {
    const owner = segments.slice(0, -1).join(".");
    const candidates = [...(index.topLevelByFqn.get(owner) ?? [])].map(
      (id): ResolutionCandidate => ({ id, precedence: 0, rule: "java-explicit-static-owner-fqn" }),
    );
    return decideCandidates(
      candidates,
      limit,
      "unresolved-java-import",
      "java-static-owner-missing",
      "java-duplicate-fqn",
    );
  }
  const exact = [...(index.topLevelByFqn.get(descriptor.raw) ?? [])].map(
    (id): ResolutionCandidate => ({ id, precedence: 0, rule: "java-explicit-top-level-fqn" }),
  );
  if (exact.length > 0) {
    return decideCandidates(exact, limit, "unresolved-java-import", "no-candidate", "java-duplicate-fqn");
  }
  const heuristic: ResolutionCandidate[] = [];
  let deepNested = false;
  for (const packageName of index.packages) {
    let remainder: string | undefined;
    if (packageName === "") remainder = descriptor.raw;
    else if (descriptor.raw.startsWith(`${packageName}.`)) remainder = descriptor.raw.slice(packageName.length + 1);
    if (remainder === undefined) continue;
    const remainderSegments = remainder.split(".");
    if (remainderSegments.length > 2) deepNested = true;
    if (remainderSegments.length !== 2) continue;
    for (const id of index.immediateByPackageAndName.get(`${packageName}\0${remainder}`) ?? []) {
      heuristic.push({ id, precedence: 100, rule: "java-immediate-container-heuristic" });
    }
  }
  return decideCandidates(
    heuristic,
    limit,
    "unresolved-java-import",
    deepNested ? "java-deep-nested-unsupported" : "no-candidate",
  );
}

interface PendingFinalEdge {
  readonly id: EdgeId;
  readonly descriptor: GraphEdgeDescriptor;
  readonly relation: RelationKind;
  readonly sourceId: FileId | SymbolId;
  readonly referenceId?: ReferenceId;
  readonly targetId?: FileId | SymbolId | ExternalModuleId;
  readonly resolution: GraphResolution;
  readonly evidence: GraphEvidence[];
  evidenceCount: number;
  omittedEvidenceCount: number;
}

function compareFinalEdges(left: GraphEdge, right: GraphEdge): number {
  return (
    compareUtf8(left.sourceId, right.sourceId) ||
    compareUtf8(left.relation, right.relation) ||
    compareOptional(left.referenceId, right.referenceId) ||
    compareOptional(left.targetId, right.targetId) ||
    compareUtf8(left.id, right.id)
  );
}

function assemblyEdgeResolution(edge: GraphAssemblyEdge): GraphResolution {
  switch (edge.relation) {
    case "DECLARES":
      return fixedResolution("exact", "direct-declares", "none");
    case "ANALYZER_EXPORT_FLAG":
      return fixedResolution("exact", "direct-analyzer-export-flag", "none");
    case "EXPORTS_NAME":
      return fixedResolution("unresolved", "unresolved-export-name", "export-symbol-binding-unavailable");
    case "DEPENDS_ON_RAW":
      return fixedResolution("unresolved", "unresolved-raw-dependency", "raw-dependency-role-unavailable");
    case "JAVA_EXTENDS_NAME":
    case "JAVA_IMPLEMENTS_NAME":
    case "JAVA_PERMITS_NAME":
      return fixedResolution("unresolved", "unresolved-java-relationship", "java-relationship-binding-deferred");
  }
}

function finalizeGraphEdge(pending: PendingFinalEdge, retainedEvidence: GraphEvidence[]): GraphEdge {
  const common = {
    id: pending.id,
    descriptor: pending.descriptor,
    sourceId: pending.sourceId,
    relation: pending.relation,
    evidence: retainedEvidence,
    evidenceCount: pending.evidenceCount,
    omittedEvidenceCount: pending.evidenceCount - retainedEvidence.length,
    resolution: pending.resolution,
  };
  if (pending.referenceId === undefined) {
    return { ...common, targetId: pending.targetId as SymbolId } as DirectSymbolEdge;
  }
  if (pending.targetId === undefined) {
    return { ...common, referenceId: pending.referenceId } as UnresolvedReferenceEdge;
  }
  if (pending.targetId.startsWith("external-module:")) {
    return { ...common, referenceId: pending.referenceId, targetId: pending.targetId } as ExternalModuleEdge;
  }
  return { ...common, referenceId: pending.referenceId, targetId: pending.targetId } as ResolvedFileEdge;
}

function finalizeRepositoryGraphAssemblyWithContext(
  assemblyValue: RepositoryGraphAssembly | unknown,
  context: NormalizedBuildContext,
): GraphBuildResult {
  // This capability check intentionally precedes every property read, proxy test, or structural inspection.
  if (
    (typeof assemblyValue !== "object" && typeof assemblyValue !== "function") ||
    assemblyValue === null ||
    !TRUSTED_GRAPH_ASSEMBLIES.has(assemblyValue)
  ) {
    return {
      ok: false,
      error: {
        code: "invalid-snapshot",
        phase: "resolve",
        message: ERROR_MESSAGES["invalid-snapshot"],
      },
    };
  }
  let verified: VerifiedAssembly;
  let assembly: RepositoryGraphAssembly;
  try {
    verified = verifyRepositoryGraphAssembly(assemblyValue, context);
    assembly = assemblyValue as RepositoryGraphAssembly;
  } catch {
    return {
      ok: false,
      error: {
        code: "invalid-snapshot",
        phase: "resolve",
        message: ERROR_MESSAGES["invalid-snapshot"],
      },
    };
  }

  try {
    const { limits } = context;
    const counts: BuildCounts = {
      symbols: assembly.symbols.length,
      references: assembly.references.length,
      edges: verified.existingEdgeContributions,
      evidence: verified.existingEvidence,
      canonicalBytes: assembly.canonicalInputBytesUsed,
    };
    let externalContributions = 0;
    const identities = new IdentityRegistry(counts, limits, context.idFactory, verified.acceptedIdentities);
    const filesByPath = new Map(assembly.files.map((file) => [file.descriptor.canonicalPath, file]));
    const javaIndex = buildJavaResolverIndex(assembly, verified);
    const externalModules = new Map<ExternalModuleId, ExternalModuleNode>();
    const pendingEdges = new Map<EdgeId, PendingFinalEdge>();

    for (const edge of assembly.edges) {
      pendingEdges.set(edge.id, {
        id: edge.id,
        descriptor: edge.descriptor,
        relation: edge.relation,
        sourceId: edge.sourceId,
        ...(edge.referenceId === undefined ? {} : { referenceId: edge.referenceId }),
        ...(edge.targetId === undefined ? {} : { targetId: edge.targetId }),
        resolution: assemblyEdgeResolution(edge),
        evidence: [...edge.evidence],
        evidenceCount: edge.evidenceCount,
        omittedEvidenceCount: edge.omittedEvidenceCount,
      });
    }

    const incrementResolveCount = (kind: "edge" | "external"): void => {
      if (kind === "edge") {
        const observed = counts.edges + 1;
        if (!Number.isSafeInteger(observed) || observed > limits.edges) {
          throw new BuildFailure("count-bound-exceeded", "resolve", { limit: limits.edges, observed });
        }
        counts.edges = observed;
      } else {
        const observed = externalContributions + 1;
        if (!Number.isSafeInteger(observed) || observed > limits.externalModules) {
          throw new BuildFailure("count-bound-exceeded", "resolve", { limit: limits.externalModules, observed });
        }
        externalContributions = observed;
      }
    };

    const addExternal = (descriptor: ExternalModuleDescriptor): ExternalModuleId => {
      incrementResolveCount("external");
      const id = identities.create<ExternalModuleId>(
        "external-module:sha256:",
        "repository-graph/external-module",
        descriptor,
      );
      if (!externalModules.has(id)) externalModules.set(id, { nodeKind: "external-module", id, descriptor });
      return id;
    };

    const contributeResolvedEdge = (
      descriptor: Extract<GraphEdgeDescriptor, { descriptorKind: "reference" }>,
      evidence: GraphEvidence,
      resolution: GraphResolution,
      targetId?: FileId | ExternalModuleId,
    ): void => {
      incrementResolveCount("edge");
      const id = identities.create<EdgeId>("edge:sha256:", "repository-graph/edge", descriptor);
      const existing = pendingEdges.get(id);
      if (existing === undefined) {
        pendingEdges.set(id, {
          id,
          descriptor,
          relation: descriptor.relation,
          sourceId: descriptor.sourceId,
          referenceId: descriptor.referenceId,
          ...(targetId === undefined ? {} : { targetId }),
          resolution,
          evidence: [evidence],
          evidenceCount: 1,
          omittedEvidenceCount: 0,
        });
        return;
      }
      if (
        canonicalizeJcs(existing.descriptor) !== canonicalizeJcs(descriptor) ||
        existing.targetId !== targetId ||
        canonicalizeJcs(existing.resolution) !== canonicalizeJcs(resolution)
      ) {
        failAssembly();
      }
      existing.evidenceCount += 1;
      existing.evidence.push(evidence);
    };

    for (const work of assembly.resolverWorkItems) {
      const sourceFile = verified.fileById.get(work.sourceFileId) as FileNode;
      const reference = verified.referenceById.get(work.referenceId) as GraphReference;
      let relation: Exclude<RelationKind, "DECLARES" | "ANALYZER_EXPORT_FLAG">;
      let decision: ResolutionDecision;

      if (work.workKind === "java-import") {
        const descriptor = reference.descriptor as Extract<GraphReferenceDescriptor, { kind: "java-import-name" }>;
        decision = javaDecision(descriptor, javaIndex, limits.retainedCandidates);
        if (decision.targetId === undefined) {
          relation =
            decision.resolution.reason === "java-import-flags-missing" ||
            decision.resolution.reason === "java-wildcard-unsupported" ||
            decision.resolution.reason === "invalid-specifier" ||
            decision.resolution.reason === "nul-specifier"
              ? "JAVA_IMPORT_NAME"
              : descriptor.static === true
                ? "JAVA_IMPORTS_STATIC_OWNER"
                : "JAVA_IMPORTS_TYPE";
        } else {
          relation = descriptor.static ? "JAVA_IMPORTS_STATIC_OWNER" : "JAVA_IMPORTS_TYPE";
        }
      } else {
        const descriptor = reference.descriptor as Extract<GraphReferenceDescriptor, { kind: "module-specifier" }>;
        const literal = descriptor.raw;
        const reason = classifyTsjsLiteral(literal);
        const importing = work.workKind === "tsjs-import";
        if (reason !== null) {
          decision = unresolvedDecision(reason, limits.retainedCandidates);
          relation = importing ? "IMPORT_REFERENCE" : "REEXPORT_REFERENCE";
        } else if (literal.startsWith("./") || literal.startsWith("../")) {
          decision = tsjsFileDecision(sourceFile, literal, filesByPath, limits.retainedCandidates);
          relation =
            decision.resolution.reason === "project-root-escape"
              ? importing
                ? "IMPORT_REFERENCE"
                : "REEXPORT_REFERENCE"
              : importing
                ? "IMPORTS_FILE"
                : "REEXPORTS_FILE";
        } else {
          const moduleKind = literal.startsWith("node:") ? "node-builtin" : "bare";
          const externalDescriptor: ExternalModuleDescriptor = {
            language: descriptor.language,
            moduleKind,
            literalSpecifier: literal,
          };
          const targetId = addExternal(externalDescriptor);
          const rule = moduleKind === "node-builtin" ? "tsjs-external-node-builtin" : "tsjs-external-bare";
          decision = {
            targetId,
            resolution: retainedResolution(
              "exact",
              rule,
              "none",
              [{ id: targetId, precedence: 0, rule }],
              limits.retainedCandidates,
            ),
          };
          relation = importing ? "IMPORTS_EXTERNAL" : "REEXPORTS_EXTERNAL";
        }
      }

      const edgeDescriptor: Extract<GraphEdgeDescriptor, { descriptorKind: "reference" }> = {
        descriptorKind: "reference",
        sourceId: work.sourceFileId,
        relation,
        referenceId: work.referenceId,
      };
      contributeResolvedEdge(edgeDescriptor, work.evidence, decision.resolution, decision.targetId);
    }

    const edges: GraphEdge[] = [];
    for (const pending of pendingEdges.values()) {
      pending.evidence.sort((left, right) => compareUtf8(left.id, right.id));
      const retained = pending.evidence.slice(0, limits.retainedEvidence);
      edges.push(finalizeGraphEdge(pending, retained));
    }
    edges.sort(compareFinalEdges);
    const orderedExternalModules = [...externalModules.values()].sort((left, right) => compareUtf8(left.id, right.id));
    const graph: RepositoryGraphV1 = {
      graphSchemaVersion: REPOSITORY_GRAPH_SCHEMA_VERSION,
      analyzerCapabilityVersion: REPO_MAP_ANALYZER_CAPABILITY_VERSION,
      snapshotContentIdentity: assembly.snapshotContentIdentity,
      complete: true,
      files: [...assembly.files].sort((left, right) => compareUtf8(left.id, right.id)),
      symbols: [...assembly.symbols].sort((left, right) => compareUtf8(left.id, right.id)),
      externalModules: orderedExternalModules,
      references: [...assembly.references].sort((left, right) => compareUtf8(left.id, right.id)),
      edges,
    };

    let serializedBytes = 0;
    writeJcs(graph, {
      write: (chunk) => {
        serializedBytes += Buffer.byteLength(chunk, "utf8");
        if (!Number.isSafeInteger(serializedBytes) || serializedBytes > limits.serializedGraphBytes) {
          throw new BuildFailure("serialized-graph-bound-exceeded", "serialize", {
            limit: limits.serializedGraphBytes,
            observed: serializedBytes,
          });
        }
      },
    });
    deepFreeze(graph);
    return { ok: true, graph, serializedBytes };
  } catch (error) {
    if (error instanceof AssemblyVerificationFailure) {
      return {
        ok: false,
        error: {
          code: "invalid-snapshot",
          phase: "resolve",
          message: ERROR_MESSAGES["invalid-snapshot"],
        },
      };
    }
    return unavailable(error, "resolve");
  }
}

/** @internal Finalizes a validated resolver-independent assembly into complete Graph v1. */
export function finalizeRepositoryGraphAssembly(
  assembly: RepositoryGraphAssembly | unknown,
  options: GraphBuildOptions = {},
): GraphBuildResult {
  try {
    return finalizeRepositoryGraphAssemblyWithContext(assembly, normalizeBuildOptions(options));
  } catch (error) {
    return unavailable(error);
  }
}

/** Builds a complete, bounded Repository Graph v1 from one immutable snapshot handle. */
export function buildRepositoryGraph(
  handle: RepositorySnapshotHandle | unknown,
  options: GraphBuildOptions = {},
): GraphBuildResult {
  let context: NormalizedBuildContext;
  try {
    context = normalizeBuildOptions(options);
  } catch (error) {
    return unavailable(error);
  }
  const assembled = buildRepositoryGraphAssemblyWithContext(handle, context);
  if (!assembled.ok) return assembled;
  return finalizeRepositoryGraphAssemblyWithContext(assembled.assembly, context);
}
