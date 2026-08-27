# Specification 0016: Repository snapshot and graph contract

## Status and scope

Status: **v0.3-S02 Contract for GitHub issue #40, with diagnostic policy amended by GitHub issue #42; production implementation is deferred.**

This specification defines a future repository snapshot handle, in-memory graph, and Resolver v1. It does not claim that `RepositorySnapshotHandle`, `capture()`, `captureCurrent()`, graph construction, graph persistence, or a resolver exists in production today. This slice changes no production API, persisted schema, query/tool schema, package metadata, configuration, or release default.

Current-fact sections are descriptive and cite source. Required-contract sections are normative future decisions. Reports under `docs/reports/` are non-normative.

## Current code evidence

The current repository map is schema-1 and file-centric:

- `RepoMapFile` carries a path, language/kind, content hash, lexical terms, imports, exports, symbol rows, dependencies, optional Java package, and degradation reason. Symbol rows have no ID, column/end span, occurrence ordinal, qualified name, or symbol space (`src/repo-map/index.ts:35-100`).
- Current paths are usually project-relative outputs from Git or `relative()` and are converted from the host separator to `/` (`src/repo-map/index.ts:184-186`, `src/repo-map/index.ts:285-313`). Admission rejects empty, absolute, leading-slash, or any `..` segment, but it does **not** produce a fully canonical path: `./a.ts`, `a//b.ts`, and `a/./b.ts` can pass the current `normalizedRepoMapPath` and exclusion checks when supplied by an adapter/watcher (`src/repo-map/index.ts:207-212`, `src/repo-map/index.ts:281-283`, `src/repo-map/index.ts:604-615`). Runtime notification similarly slash-converts and rejects only empty, leading `../`, and excluded input (`src/repo-map/runtime.ts:585-592`). Therefore “current normalized path” must not be treated as a canonical graph identity.
- TS/JS uses `createSourceFile`, not a `Program` or `TypeChecker` (`src/repo-map/index.ts:431-450`). It visits top-level statements. Imports retain raw string sources and local binding names; export aliases retain only the exported side; dependencies are raw, first-seen deduplicated strings (`src/repo-map/index.ts:455-587`).
- Narrow CommonJS import evidence exists only for a top-level variable initialized by literal `require("...")`; CommonJS export recognition is syntactic and lossy (`src/repo-map/index.ts:398-428`, `src/repo-map/index.ts:561-574`). Dynamic/template import and nonliteral `require` produce no schema-1 row.
- Anonymous default TS/JS function/class declarations use symbol name `"default"`. Named defaults retain the local name and also emit default export evidence. Default expressions and `export =` emit an export row without a symbol (`src/repo-map/index.ts:489-556`).
- TS/JS overloads and ordinary repeated declarations are indistinguishable rows. TS/JS emits no containers or heritage clauses.
- Java emits packages, import rows with optional `static`/`wildcard` fields, declarations/members, immediate simple-name containers, modifiers, type parameters, and textual `extends`/`implements`/`permits` arrays (`src/repo-map/java.ts:254-320`, `src/repo-map/java.ts:330-410`). Relationships are strings, not bindings. Recursive descendant use can misclassify an enclosing declaration or duplicate nested record components (`src/repo-map/java.ts:51-64`, `src/repo-map/java.ts:224-239`).
- Java dependency strings mix imports, relationships, crudely erased relationships, and selected type-parameter bounds, so the original role can already be lost (`src/repo-map/java.ts:280-318`, `src/repo-map/java.ts:350-352`).
- Parse/analyzer failure yields a lexical file with empty semantic arrays and warning/degradation evidence (`src/repo-map/index.ts:590-601`, `src/repo-map/index.ts:656-696`). Java additionally rejects source over 2 MiB or raw brace nesting over 512 (`src/repo-map/java.ts:242-251`).
- Initial enumeration uses JavaScript default sort while incremental replacement uses `localeCompare` (`src/repo-map/index.ts:327-333`, `src/repo-map/runtime.ts:287-299`). Neither is the graph ordering contract.
- `workspaceRevision` is the existing SHA-256 over Git HEAD and path-sorted dirty outcome/content entries. It is not full snapshot identity (`src/repo-map/runtime.ts:282-285`, `src/repo-map/runtime.ts:844-898`).
- The private effective-content version is runtime-local and compares complete ordered `snapshot.files`; warnings, pending paths, freshness, generation, and provenance do not affect it (`src/repo-map/runtime.ts:509-527`, `src/repo-map/runtime.ts:900-912`).
- `query()` calls `ensureFresh()`; `queryCurrent()` does not (`src/repo-map/runtime.ts:691-715`). Reconciliation is bounded to 64 watcher events per pass, eight passes, and 1,000 ms observed between passes, so it can return stale/pending (`src/repo-map/runtime.ts:27-33`, `src/repo-map/runtime.ts:606-668`).
- Flush/rebuild reconciliation work is chained through `#flushChain` (`src/repo-map/runtime.ts:599-604`, `src/repo-map/runtime.ts:682-689`), but `notify()` directly mutates pending paths, freshness, the watcher queue, and mutation epoch outside that chain and can interleave (`src/repo-map/runtime.ts:585-592`). Current runtime state is therefore not globally serialized. Rebuild also assigns head/base/effective/dirty/pending before dirty reconciliation, freshness, and activation complete (`src/repo-map/runtime.ts:1088-1117`). Future atomic checkpoint publication remains required; capture cannot safely clone the mutable fields independently.
- Current query metadata is selected before fallback awaits, but nested symbol/dependency arrays returned from search are not ownership-isolated (`src/repo-map/runtime.ts:717-737`, `src/repo-map/index.ts:762-785`).
- Git-head failure becomes `"no-head"`, Git-status failure falls back to non-Git reconciliation, and watcher errors are logged. Those failures are not all represented by freshness/diagnostics (`src/repo-map/runtime.ts:144-170`, `src/repo-map/runtime.ts:205-277`).
- `generation` means latest successfully activated/adopted durable generation and can lag pending/in-memory evidence or an activation failure (`src/repo-map/runtime.ts:575-592`, `src/repo-map/runtime.ts:1123-1182`). It is not capture identity.

Tests corroborate split freshness/interleaving (`tests/repo-map-runtime.test.ts:182-314`, `tests/extension.test.ts:530-579`), raw `.js` TS imports (`tests/repo-map.test.ts:141-179`), named defaults (`tests/repo-map.test.ts:226-272`), and Java imports/overloads (`tests/java-repo-map.test.ts:44-194`).

## Current capability matrix

“Observed” means present in schema 1, not compiler/linker validated.

| Capability | TS/JS today | Java today | Graph v1 decision |
| --- | --- | --- | --- |
| File plus content hash | Observed | Observed | File node supported after graph canonicalization. |
| File declares symbol row | Top-level only | Types and selected members | Exact row-containment edge; not logical-symbol identity. |
| Import source | Static ES plus narrow literal CommonJS | Explicit/static/wildcard import rows | Preserve as typed reference; conditionally resolve file target. |
| Re-export source | Named/star export source | Not represented | Preserve TS/JS source reference; conditionally resolve. |
| Aggregate dependency | Deduplicated raw module strings | Mixed-role deduplicated strings | Preserve as unresolved raw-dependency reference. |
| Exported name | Lossy ES/CommonJS rows | Exported type rows only | Preserve name reference; no symbol binding. |
| Analyzer export flag | Modifier-derived/lossy | Approximate accessibility | Exact edge only to state the recorded flag. |
| Containers | Absent | Immediate unqualified simple name | Preserve raw evidence; no exact scope chain. |
| Overload/merge groups | Indistinguishable rows | Separate signature rows | Preserve every row; grouping unavailable. |
| Module/type resolution | None | None | Resolver v1 pure snapshot rules only. |
| Imported/exported name binding | Alias/role facts lost | Classpath/owner facts incomplete | Unavailable. |
| `extends`/`implements` | **Not emitted** | Textual names | TS/JS explicitly deferred; Java unresolved reference edges. |
| `permits` | Not emitted | Textual names | Java unresolved reference edges. |
| Calls/references/overrides/type uses | Not emitted | Not emitted | Unavailable. |
| Degraded semantic facts | Empty | Empty | No invented semantic edges. |

## Required snapshot-handle contract

### Handle types

```ts
interface RepositorySnapshotHandle {
  readonly contractVersion: "repository-snapshot/v1";
  readonly analyzerCapabilityVersion: "repo-map-capabilities/v1";
  readonly snapshotContentIdentity: `sha256:${string}`;
  readonly workspaceRevision: string;
  readonly gitHead: string;
  readonly generation: number;
  readonly freshness: "fresh" | "dirty" | "stale" | "unsupported";
  readonly dirtyFiles: readonly Readonly<{ path: string; contentHash: string }>[];
  readonly pendingPaths: readonly string[];
  readonly errors: readonly RepositorySnapshotDiagnostic[];
  readonly warnings: readonly RepositorySnapshotDiagnostic[];
  readonly snapshot: DeepReadonly<RepoMapSnapshot>;
}

type SnapshotDiagnosticCode =
  | "parse-error"
  | "read-error"
  | "runtime-operation-error"
  | "diagnostics-truncated";
type SnapshotDiagnosticPhase = "analyzer" | "indexing" | "runtime";

interface RepositorySnapshotDiagnostic {
  readonly severity: "error" | "warning";
  readonly code: SnapshotDiagnosticCode;
  readonly phase: SnapshotDiagnosticPhase;
  readonly path?: string;
  readonly message: string;
  readonly occurrenceCount: number;
  readonly omittedCount?: number;
}

interface RepositorySnapshotProvider {
  capture(): Promise<RepositorySnapshotHandle>;
  captureCurrent(): RepositorySnapshotHandle;
}
```

`generation` is zero only before adoption/activation of a durable generation. It may lag all other fields and is never content identity. `dirtyFiles` retains current hash/outcome values, including `"deleted"`; `workspaceRevision` retains legacy semantics. Dirty and pending paths are graph-canonicalized as specified below, deduplicated, byte-sorted, and collisions fail capture rather than select a winner.

### Atomic publication and immutability

The runtime must atomically replace one immutable checkpoint containing snapshot, warnings, Git head, dirty overlay, workspace revision, freshness, pending paths, runtime error, durable generation, analyzer versions, and content identity. Capture selects one checkpoint and reads no mutable runtime field afterward.

A rebuild publishes either the prior checkpoint or a fully reconciled new checkpoint, never new files/head with old freshness. A watcher event may atomically publish old content/generation plus a new pending path and stale freshness.

Handles are recursively detached and immutable. Later runtime activity cannot mutate a handle; caller mutation cannot affect runtime state or another handle. A deep clone plus deep freeze, immutable persistent structure, or equivalently tested ownership boundary is required. TypeScript `readonly` alone is insufficient.

### Capture paths and concurrency

`capture()` must:

1. invoke `ensureFresh()` exactly once;
2. after successful settlement, synchronously clone/freeze the then-current published checkpoint; and
3. perform no second Git, filesystem, watcher, activation, query-fallback, or reconciliation operation.

`await ensureFresh(); return captureCurrent();` is valid only because strict `captureCurrent()` performs zero reconciliation. It must not route through `query()` or a compatibility fallback to a live path.

`captureCurrent()` is synchronous, performs no I/O, starts no task, and does not wait for or join an in-progress flush. Racing capture returns either the complete checkpoint before publication or after publication, never a tuple mixture. It must return promptly while a flush is blocked.

Automatic turn start is one explicit `ensureFresh()` followed by `captureCurrent()`. An explicit future live tool may call `capture()`. Bounded reconciliation can still yield stale/pending; a notification after reconciliation can also make the selected checkpoint stale. Activation failure may publish coherent newer in-memory evidence with the old generation and a runtime error.

Freshness precedence remains stale for known pending/watcher/read-failure/operational degradation, otherwise unsupported for any degraded effective file, otherwise dirty for nonempty overlay, otherwise fresh. “Fresh” covers successfully observed inputs only; it is not proof of Git/watcher health.

### Bounded unavailable error

With no valid published checkpoint, or when handle identity/path validation exceeds its bounds, capture throws only this public shape:

```ts
interface RepositorySnapshotUnavailableError extends Error {
  readonly name: "RepositorySnapshotUnavailableError";
  readonly code: "repository-snapshot-unavailable";
  readonly reason:
    | "no-published-checkpoint"
    | "ensure-fresh-failed"
    | "invalid-checkpoint"
    | "snapshot-bound-exceeded";
  readonly retryable: boolean;
  readonly message: string; // fixed by reason, <= 256 UTF-8 bytes
}
```

It exposes no stack, nested cause, absolute path, source, diff, environment data, or text copied from an analyzer, read failure, runtime exception, or Git command across the public boundary. `capture()` rejects on `ensureFresh()` rejection; it does not silently return success. `retryable` is true only for `no-published-checkpoint` and `ensure-fresh-failed`. Its message is determined only by `reason`:

| `reason` | Exact public `message` |
|---|---|
| `no-published-checkpoint` | `repository snapshot unavailable: no published checkpoint` |
| `ensure-fresh-failed` | `repository snapshot unavailable: refresh failed` |
| `invalid-checkpoint` | `repository snapshot unavailable: invalid checkpoint` |
| `snapshot-bound-exceeded` | `repository snapshot unavailable: snapshot bound exceeded` |

### Exact diagnostic mapping and bounds

Mapping occurs after checkpoint selection and before handle return in this order:

1. Each snapshot `parse-error` becomes `{severity:"warning", code:"parse-error", phase:"analyzer", message:"repository snapshot parse failed", occurrenceCount:1}`.
2. Each snapshot `read-error` becomes `{severity:"error", code:"read-error", phase:"indexing", message:"repository snapshot read failed", occurrenceCount:1}`.
3. When the selected checkpoint has a runtime error, append `{severity:"error", code:"runtime-operation-error", phase:"runtime", message:"repository snapshot runtime operation failed", occurrenceCount:1}`. The public row is based only on the presence of the internal error, never its text or type.
4. Canonicalize every source path with graph path canonicalization. Omit the path when canonicalization fails; never substitute, relativize, or expose the rejected input. A present path is therefore always canonical, project-relative, and at most 4,096 UTF-8 bytes.
5. Collapse exact duplicate `(severity, code, phase, path-or-absent, message)` rows, sum `occurrenceCount`, then byte-sort by severity, code, path absent-first, phase, and message.
6. Split errors/warnings and apply each class bound.

The fixed messages above are the only ordinary snapshot diagnostic messages. In particular, mapping never copies or transforms arbitrary analyzer messages, read/runtime exception text, exception names, stacks, nested causes, Git stderr, source text, absolute host paths, or environment data. The detached handle's compatibility `snapshot.warnings` rows are normalized to the same fixed message for their code and the same canonical-path rule; original detailed warning/error values remain only in existing internal runtime, status, and log paths. Heuristic sanitization or redaction may still be applied before publication as defense in depth, but it is not the confidentiality guarantee: the guarantee comes from constructing public diagnostics solely from the allowlisted code, phase, severity, fixed message, canonical path, and bounded counts.

At most 32 errors and 128 warnings are returned. On overflow, retain the first `limit - 1` ordinary sorted rows and append exactly:

```ts
{
  severity: "error" | "warning", // matching the bounded class
  code: "diagnostics-truncated",
  phase: "runtime",
  message: "<N> additional error diagnostics omitted" |
           "<N> additional warning diagnostics omitted",
  occurrenceCount: 1,
  omittedCount: N
}
```

For an error summary, the exact message is the ASCII decimal rendering of `N` followed by ` additional error diagnostics omitted`; for a warning summary, it is the ASCII decimal rendering of `N` followed by ` additional warning diagnostics omitted`. `N` is the number of omitted collapsed rows, not occurrences. Summary rows have no `path`. The detached schema-1 snapshot retains normalized compatibility warning rows, but bounded top-level arrays are authoritative for display.

## Graph canonical paths, strings, ordering, and encoding

### Graph path canonicalization

The Graph v1 canonicalizer is independent of current admission. Given a current path string:

1. reject unpaired surrogates, NUL, C0/C1 controls, backslash, an absolute/drive/UNC form, or more than 4,096 UTF-8 bytes;
2. split on `/`, remove empty and `.` segments, and reject every `..` segment rather than resolving it;
3. require at least one remaining segment; and
4. join remaining segments with one `/`, preserving Unicode code points and case exactly.

Thus `./a.ts`, `a//b.ts`, and `a/./b.ts` canonicalize to `a.ts`, `a/b.ts`, and `a/b.ts`. If two snapshot files, dirty entries, or pending paths canonicalize to the same value, validation fails with a collision error. Unicode normalization and case folding are forbidden. Case identity is logical and case-sensitive even on a case-insensitive filesystem.

Any non-diagnostic graph input string with an unpaired surrogate fails closed as `invalid-unicode`; it is not replacement-normalized. Model strings preserve valid Unicode exactly.

### Comparator and JCS

All normative string ordering is unsigned lexicographic order of UTF-8 bytes. Implementations must not use `localeCompare`, host locale, filesystem order, or object insertion order. Numeric fields use safe-integer order; optional fields sort absent before present.

Canonical structured encoding is RFC 8785 JCS encoded as UTF-8. Arrays are contract-sorted before JCS. The JCS and domain-separation rules below apply to new snapshot-content and graph identities only. They do not redefine or make claims about legacy `RepoMapFile.contentHash`, dirty hashes, or `workspaceRevision`, whose existing algorithms remain unchanged.

### Snapshot content identity

`snapshotContentIdentity` is lowercase hex SHA-256 with `sha256:` prefix over UTF-8 JCS of:

```json
{
  "identitySchema": "repository-snapshot-content/v1",
  "analyzerCapabilityVersion": "repo-map-capabilities/v1",
  "repositoryMapSchemaVersion": 1,
  "analyzers": {
    "typescriptVersion": "<recorded string>",
    "javaParser": "<recorded string or null>"
  },
  "files": ["<complete schema-1 file records with canonical paths, byte-sorted by path>"]
}
```

The actual payload contains objects/null, not placeholders. Complete file rows preserve recorded import/export/symbol/dependency/lexical-term order; JCS orders object properties.

Identity excludes warnings, normalized diagnostics, freshness, pending/dirty paths, runtime error, Git head, workspace revision, generation, timestamps, project root, maintenance, telemetry, search/fallback output, and object identity. Warning/freshness-only changes retain it; HEAD-only changes may alter workspace revision without altering it. Consumers depending on trust axes must key those axes separately. Semantic interpretation changes require a new identity schema and/or analyzer capability version.

## Compact domain-separated graph identities

Every Graph v1 ID hashes a domain-separated UTF-8 JCS envelope:

```ts
const digest = SHA256(UTF8(JCS({ domain: DOMAIN, version: 1, payload })));
const id = `${PREFIX}${base64urlNoPadding(digest)}`; // 32-byte digest => 43 chars
```

Payload JCS is never embedded reversibly in an ID. Descriptors remain on records for explanation/verification. Before accepting a repeated ID, the builder compares its domain and canonical payload bytes; equal ID with unequal domain/payload fails closed as `identity-collision`. This check applies across all files, symbols, external modules, references, evidence, and edges.

| ID | Prefix | Domain |
| --- | --- | --- |
| `FileId` | `file:sha256:` | `repository-graph/file` |
| `SymbolId` | `symbol:sha256:` | `repository-graph/symbol` |
| `ExternalModuleId` | `external-module:sha256:` | `repository-graph/external-module` |
| `ReferenceId` | `reference:sha256:` | `repository-graph/reference` |
| `EvidenceId` | `evidence:sha256:` | `repository-graph/evidence` |
| `EdgeId` | `edge:sha256:` | `repository-graph/edge` |

## Node and reference taxonomy

Only file, symbol, and external-module records are nodes.

```ts
type FileId = `file:sha256:${string}`;
type SymbolId = `symbol:sha256:${string}`;
type ExternalModuleId = `external-module:sha256:${string}`;
type GraphNodeId = FileId | SymbolId | ExternalModuleId;
type ReferenceId = `reference:sha256:${string}`;
type EvidenceId = `evidence:sha256:${string}`;
type EdgeId = `edge:sha256:${string}`;

interface FileDescriptor {
  readonly canonicalPath: string;
}
interface FileNode {
  readonly nodeKind: "file";
  readonly id: FileId;
  readonly descriptor: FileDescriptor;
  readonly language: RepoMapLanguage;
  readonly fileKind: RepoMapFileKind;
  readonly contentHash: string;
  readonly sizeBytes: number;
}

interface SymbolDescriptor {
  readonly fileId: FileId;
  readonly language: RepoMapLanguage;
  readonly symbolKind: RepoMapSymbol["kind"];
  readonly container: string | null;
  readonly name: string;
  readonly signature: string;
  readonly occurrenceOrdinal: number;
}
interface SymbolNode {
  readonly nodeKind: "symbol";
  readonly id: SymbolId;
  readonly descriptor: SymbolDescriptor;
  readonly recordedRowOrdinal: number;
  readonly row: DeepReadonly<RepoMapSymbol>;
}

interface ExternalModuleDescriptor {
  readonly language: "typescript" | "javascript";
  readonly moduleKind: "bare" | "node-builtin";
  readonly literalSpecifier: string;
}
interface ExternalModuleNode {
  readonly nodeKind: "external-module";
  readonly id: ExternalModuleId;
  readonly descriptor: ExternalModuleDescriptor;
}
```

`FileId` payload is `FileDescriptor`. `SymbolId` payload is `SymbolDescriptor`. A symbol occurrence ordinal is one-based among prior symbol rows with equal descriptor fields other than ordinal, in recorded `symbols` order. Lines, `exported`, global indexes, and resolution targets are excluded. Repeated builds are stable, but stateless v1 does not promise stability across path/name/signature changes or insertion/reordering of indistinguishable duplicates.

Every symbol row is retained. TS/JS overloads, declaration merges, and same-name declarations are not grouped. Java distinct signatures create distinct descriptors; identical signatures use occurrence ordinal. TS/JS container is null; Java’s immediate simple-name container is retained without qualification. Anonymous default rows retain name `"default"`; named defaults retain their local name; default expressions have no symbol. Export rows are never guessed onto symbols.

`ExternalModuleNode` is restricted to actual represented literal TS/JS bare modules or `node:<nonempty>` builtin references. `node:fs` is `node-builtin`; exact `node:` is invalid and never creates an ExternalModule node. Any valid non-relative, non-absolute, non-scheme literal such as `react` or `@scope/pkg/subpath` is `bare`. The node represents the literal external module reference, not proof an artifact/package exists. It must never represent export names, raw dependencies, Java imports/types, or Java relationships.

Non-node references preserve all other evidence:

```ts
type GraphReferenceDescriptor =
  | { readonly kind: "module-specifier"; readonly language: "typescript" | "javascript"; readonly raw: string }
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

interface GraphReference {
  readonly id: ReferenceId;
  readonly descriptor: GraphReferenceDescriptor;
}
```

`ReferenceId` payload is its descriptor. References are not nodes. An unresolved relative or Java reference has no target node.

## Concrete graph evidence

```ts
type EvidenceRowKind = "import" | "export" | "symbol" | "dependency" | "java-relationship";

type GraphEvidenceDescriptor =
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

type GraphEvidenceExplanation =
  | { readonly rowKind: "import"; readonly source: string; readonly names: readonly string[]; readonly typeOnly: boolean; readonly static: boolean | null; readonly wildcard: boolean | null }
  | { readonly rowKind: "export"; readonly name: string; readonly source: string | null; readonly typeOnly: boolean }
  | { readonly rowKind: "symbol"; readonly symbolId: SymbolId; readonly name: string; readonly symbolKind: RepoMapSymbol["kind"]; readonly line: number }
  | { readonly rowKind: "dependency"; readonly raw: string }
  | { readonly rowKind: "java-relationship"; readonly symbolId: SymbolId; readonly relationship: "extends" | "implements" | "permits"; readonly raw: string };

interface GraphEvidence {
  readonly id: EvidenceId;
  readonly descriptor: GraphEvidenceDescriptor;
  readonly explanation: GraphEvidenceExplanation;
}
```

`canonicalRowDigest` is lowercase hex SHA-256 over UTF-8 JCS of `{rowDigestSchema:"repo-map-row/v1", rowKind, row}`. For Java relationship evidence, `row` is `{symbolRow, relationship, raw}`. This digest is explanatory integrity data, not an ID.

`recordedRowOrdinal` is the zero-based index in `imports`, `exports`, `symbols`, or `dependencies`; Java relationship evidence uses the symbol index there and `recordedNestedOrdinal` for the zero-based relationship-array index. Other evidence has `recordedNestedOrdinal:null`. `occurrenceOrdinal` is one-based among identical `(sourceFileId, rowKind, canonicalRowDigest)` rows encountered up through that recorded position. `EvidenceId` hashes the complete descriptor, including both recorded ordinals and the occurrence ordinal; the redundancy is deliberate, explanation-friendly, and collision-checked.

All explanation strings/arrays obey graph nested/string bounds. No span, alias side, module role, overload group, or lost dependency role is invented.

## Resolver result, candidate, rule, and reason types

```ts
type ResolutionStatus = "exact" | "heuristic" | "unresolved";

type ResolverRuleCode =
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

type ResolverReasonCode =
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

interface ResolutionCandidate {
  readonly id: FileId | ExternalModuleId;
  readonly precedence: number;
  readonly rule: ResolverRuleCode;
}

interface GraphResolution {
  readonly status: ResolutionStatus;
  readonly rule: ResolverRuleCode;
  readonly reason: ResolverReasonCode;
  readonly candidates: readonly ResolutionCandidate[];
  readonly omittedCandidateCount: number;
}
```

Candidates include the chosen candidate plus every other existing candidate from applicable current and lower precedence rules, deduplicated by `(id, precedence, rule)`, sorted by numeric precedence, rule byte order, then ID. Retain the first 32; because a chosen candidate is necessarily first at its winning precedence, it is always retained. `omittedCandidateCount` counts remaining existing candidate records. Resolver never lists nonexistent probes. Exact/heuristic resolution must use reason `none`; unresolved resolution must use a non-`none` reason and has no chosen target.

At the highest applicable precedence, one target selects; multiple distinct targets are unresolved ambiguity. Lower-precedence candidates remain explanatory and never conflict with or displace the winner. Duplicate normalized file paths fail graph validation before resolution. Java candidates deduplicate repeated declarations by file ID; distinct files with the same highest-precedence FQN are ambiguous.

## Relation vocabulary and enforceable endpoint matrix

```ts
type RelationKind =
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

type GraphEdgeDescriptor =
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

type DirectSymbolEdge = GraphEdgeBase & {
  readonly relation: "DECLARES" | "ANALYZER_EXPORT_FLAG";
  readonly sourceId: FileId;
  readonly targetId: SymbolId;
  readonly referenceId?: never;
  readonly resolution: GraphResolution & { readonly status: "exact" };
};
type ResolvedFileEdge = GraphEdgeBase & {
  readonly relation: "IMPORTS_FILE" | "REEXPORTS_FILE" | "JAVA_IMPORTS_TYPE" | "JAVA_IMPORTS_STATIC_OWNER";
  readonly sourceId: FileId;
  readonly targetId: FileId;
  readonly referenceId: ReferenceId;
  readonly resolution: GraphResolution & { readonly status: "exact" | "heuristic" };
};
type ExternalModuleEdge = GraphEdgeBase & {
  readonly relation: "IMPORTS_EXTERNAL" | "REEXPORTS_EXTERNAL";
  readonly sourceId: FileId;
  readonly targetId: ExternalModuleId;
  readonly referenceId: ReferenceId;
  readonly resolution: GraphResolution & { readonly status: "exact" };
};
type UnresolvedReferenceEdge = GraphEdgeBase & {
  readonly relation:
    | "IMPORTS_FILE" | "IMPORT_REFERENCE"
    | "REEXPORTS_FILE" | "REEXPORT_REFERENCE"
    | "JAVA_IMPORTS_TYPE" | "JAVA_IMPORTS_STATIC_OWNER" | "JAVA_IMPORT_NAME"
    | "EXPORTS_NAME" | "DEPENDS_ON_RAW"
    | "JAVA_EXTENDS_NAME" | "JAVA_IMPLEMENTS_NAME" | "JAVA_PERMITS_NAME";
  readonly sourceId: FileId | SymbolId;
  readonly targetId?: never;
  readonly referenceId: ReferenceId;
  readonly resolution: GraphResolution & { readonly status: "unresolved" };
};
type GraphEdge = DirectSymbolEdge | ResolvedFileEdge | ExternalModuleEdge | UnresolvedReferenceEdge;

interface GraphEdgeBase {
  readonly id: EdgeId;
  readonly descriptor: GraphEdgeDescriptor;
  readonly evidence: readonly GraphEvidence[];
  readonly evidenceCount: number;
  readonly omittedEvidenceCount: number;
}
```

The union is further constrained by this endpoint matrix:

| Relation | Source | Resolved target | Unresolved allowed |
| --- | --- | --- | --- |
| `DECLARES` | File | Symbol, exact | No |
| `ANALYZER_EXPORT_FLAG` | File | Symbol, exact | No |
| `IMPORTS_FILE` | File | File, exact/heuristic | Yes, no target |
| `IMPORTS_EXTERNAL` | File | ExternalModule, exact literal-reference node | No |
| `IMPORT_REFERENCE` | File | Never in v1 | Yes, no target for represented invalid/unsupported TS/JS import source |
| `REEXPORTS_FILE` | File | File, exact/heuristic | Yes, no target |
| `REEXPORTS_EXTERNAL` | File | ExternalModule, exact literal-reference node | No |
| `REEXPORT_REFERENCE` | File | Never in v1 | Yes, no target for represented invalid/unsupported TS/JS re-export source |
| `JAVA_IMPORTS_TYPE` | File | File, exact/heuristic | Yes, no target |
| `JAVA_IMPORTS_STATIC_OWNER` | File | File, exact | Yes, no target |
| `JAVA_IMPORT_NAME` | File | Never in v1 | Yes, no target |
| `EXPORTS_NAME` | File | Never in v1 | Yes, no target |
| `DEPENDS_ON_RAW` | File | Never in v1 | Yes, no target |
| Java heritage-name relations | Symbol | Never in v1 | Yes, no target |

For unresolved heritage, `sourceId` must be Symbol. For every other unresolved relation it must be File. Exact/heuristic resolution requires the allowed target; unresolved forbids `targetId`. Every edge’s top-level source/relation/reference/target must agree with its descriptor and matrix; mismatch is an invalid graph, not a second interpretation. There are no `may-*` relations and no fourth resolution status.

Direct and always-unresolved mappings are exact: `DECLARES` and `ANALYZER_EXPORT_FLAG` use reason `none`, their corresponding direct rule, and an empty candidate list because symbol targets are endpoints rather than resolver candidates. `ANALYZER_EXPORT_FLAG` is emitted if and only if the source `RepoMapSymbol` row has `exported === true`; `exported === false` emits no such edge. Every represented export row creates `EXPORTS_NAME` with rule `unresolved-export-name`, reason `export-symbol-binding-unavailable`, and no candidates. Every represented dependency row creates `DEPENDS_ON_RAW` with rule `unresolved-raw-dependency`, reason `raw-dependency-role-unavailable`, and no candidates. Each Java relationship entry creates its matching heritage relation with rule `unresolved-java-relationship`, reason `java-relationship-binding-deferred`, and no candidates.

Support classification is normative:

- **Supported:** direct declarations/export flags and represented export/dependency references.
- **Conditional:** represented imports/re-exports and Java relationship rows; file targets require Resolver v1 eligibility.
- **Heuristic:** only TS/JS filename conventions and Java immediate-container matching.
- **Unavailable:** TS/JS heritage, calls, references, overrides, type uses, TS/JS containment, wildcard expansion, alias/name binding, and CommonJS member binding.

## Resolver v1

Resolver v1 is pure over one validated handle. General graph input pre-validation is authoritative and runs before any reference, evidence, or edge is emitted: an unpaired surrogate anywhere in non-diagnostic captured input fails the whole build as `GraphBuildUnavailable` with code `invalid-unicode` and phase `validate`. Resolver v1 therefore never receives such input and never converts it into an unresolved edge. Invalid diagnostic source strings are never copied to public output; fixed diagnostic messages need no replacement-normalization. Resolver performs no filesystem, Git, package, network, compiler-program, classpath, or watcher I/O and resolves file/reference targets only, never compilation or imported names.

### Represented versus unobserved constructs

An unresolved edge exists only for represented schema-1 evidence. Dynamic/template `import()` and nonliteral `require` have no import row, so Graph v1 emits **no edge**, not an unresolved edge. A Java/TS/JS dependency row always maps to `DEPENDS_ON_RAW` plus a `raw-dependency` reference because its occurrence/role may already be lost.

### TS/JS specifier classification and precedence

Process only represented TS/JS import rows and export rows with `source`, applying classification checks in this order: empty literal is `invalid-specifier`; NUL is `nul-specifier`; any `?` or `#` is `query-or-fragment-unsupported` with no stripping; leading `/`, `\\`, or drive-prefix `^[A-Za-z]:[\\/]` is `absolute-specifier-unsupported`; any remaining backslash is `invalid-specifier`; and a scheme matching `^[A-Za-z][A-Za-z0-9+.-]*:` is `url-scheme-unsupported`, except `node:`. These invalid/unsupported represented sources use `IMPORT_REFERENCE` or `REEXPORT_REFERENCE`, rule `unresolved-tsjs-module-reference`, and no target; they are not mislabeled as file or external-module imports.

The exact literal `node:` is represented but invalid/unsupported: emit `IMPORT_REFERENCE` or `REEXPORT_REFERENCE` with rule `unresolved-tsjs-module-reference`, reason `node-builtin-name-missing`, an empty candidate list, and no target. `node:<nonempty>` creates an exact `IMPORTS_EXTERNAL`/`REEXPORTS_EXTERNAL` target with rule `tsjs-external-node-builtin`. Any other nonempty literal not beginning `./` or `../`, having no prohibited scheme/absolute form, creates an exact bare ExternalModule target with rule `tsjs-external-bare`. Its resolution contains exactly one precedence-0 candidate for that ExternalModule ID, reason `none`, and zero omitted candidates. External exactness means exact literal-reference node, not artifact existence.

For `./` or `../`, normalize lexically against the canonical importer directory: split `/`, remove empty and `.`, apply `..` by popping; trying to pop above project root is `project-root-escape`. Backslash is an ordinary invalid specifier character, not a separator. Percent escapes are not decoded. Non-diagnostic invalid Unicode has already failed authoritative graph pre-validation and cannot reach this step.

A final segment is extensionless only when it contains no `.` at all. Dotfiles such as `.config` and trailing-dot names such as `name.` are not extensionless. A raw trailing `/` is directory intent: skip literal/direct-file and substitution probes and apply only index probing to the normalized directory. Otherwise apply every rule in this exact order and retain all existing candidates:

1. normalized literal file, precedence `0`, rule `tsjs-relative-literal`, exact if unique;
2. only when literal is absent, JS-family replacement candidates:
   - `.js`: `.ts` at 100, `.tsx` at 101, `.d.ts` at 102;
   - `.jsx`: `.tsx` at 100, `.d.ts` at 101;
   - `.mjs`: `.mts` at 100, `.d.mts` at 101;
   - `.cjs`: `.cts` at 100, `.d.cts` at 101;
3. for an extensionless final segment, append `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` at precedence 200–207;
4. for an extensionless final segment or directory intent, probe `index.ts`, `index.tsx`, `index.mts`, `index.cts`, `index.js`, `index.jsx`, `index.mjs`, `index.cjs` at 300–307.

Suffix and extension comparisons are ASCII case-sensitive and no case-folded probe is added. Each ordered suffix is its own precedence, so multiple different convention candidates do not create same-precedence ambiguity; the first selects heuristic and later existing candidates remain listed. Literal exact wins over all. If none exists, emit unresolved rule `unresolved-tsjs-module-reference`, reason `no-candidate`. Substitutions/index/extensions are heuristic because schema 1 has no tsconfig/module mode.

Path aliases, `baseUrl`, package exports/imports, workspace links, custom loaders, bare artifact lookup, and runtime-computed loading are not attempted. Bare represented literals still receive an ExternalModule literal-reference node as above.

### Java explicit import precedence

A Java import reference records `static` and `wildcard` as true/false/null. If either optional schema field is absent (`null`), emit `JAVA_IMPORT_NAME` unresolved with rule `unresolved-java-import` and reason `java-import-flags-missing`; never coerce absence to false. A wildcard emits `JAVA_IMPORT_NAME` unresolved with the same rule and reason `java-wildcard-unsupported`. Empty sources or empty dot-separated segments create `JAVA_IMPORT_NAME` with rule `unresolved-java-import`, reason `invalid-specifier`, and no target; NUL uses reason `nul-specifier`. Non-diagnostic invalid Unicode cannot reach Java resolution because it fails the authoritative graph pre-validation.

Index only non-degraded semantic Java files. A top-level type is kind class/interface/enum/record/annotation with absent container. Its FQN descriptor is `(packageName-or-empty, symbol.name)`; absent `packageName` means the default package, not missing evidence. Candidate identity is file ID.

For non-static, non-wildcard explicit imports:

1. every exact complete top-level FQN file gets precedence 0/rule `java-explicit-top-level-fqn`; one resolves `JAVA_IMPORTS_TYPE` exact, multiple resolve unresolved `java-duplicate-fqn`;
2. only without a top-level candidate, test the immediate-container heuristic: for candidate file package `P`, the source after removing exact prefix `P + "."` (or the complete source for the default package) must contain exactly two segments `C.N`; a type row must have `container === C` and `name === N`. Such files get precedence 100/rule `java-immediate-container-heuristic`; one resolves heuristic, multiple are `ambiguous-highest-precedence`;
3. otherwise `JAVA_IMPORTS_TYPE` is unresolved with rule `unresolved-java-import` and reason `no-candidate`; use reason `java-deep-nested-unsupported` only when a captured package prefix matches but the remaining spelling requires more than the one representable immediate container plus final type.

For static, non-wildcard import, drop exactly the final member segment and look up the remaining top-level owner FQN at precedence 0/rule `java-explicit-static-owner-fqn`. One resolves `JAVA_IMPORTS_STATIC_OWNER` exact, multiple are `java-duplicate-fqn`, none `java-static-owner-missing`. Matching direct static members may be explanatory evidence but do not change target or claim accessibility/legality. Overloaded members remain a set.

`exported` is not a Java resolver filter. Same-package/`java.lang`, classpath/JDK absence, inherited members, deep nesting, source-set order, JPMS, reflection, service loading, injection, and generated/runtime types remain unresolved or unobserved as applicable.

Java `extends`/`implements`/`permits` always produce Symbol-to-unresolved-reference edges in v1 with `unresolved-java-relationship` and `java-relationship-binding-deferred`; textual names are never promoted to a binding. TS/JS heritage remains absent/deferred.

## Edge identity, aggregation, conflicts, and ordering

Reference-edge descriptor/payload is `{descriptorKind:"reference", sourceId, relation, referenceId}`. Direct-edge descriptor/payload is `{descriptorKind:"direct", sourceId, relation, targetId}`. `EdgeId` hashes the complete descriptor under its domain; a later resolved target is intentionally excluded from reference-edge identity. `GraphEdge.descriptor` is serialized and supplies collision-verification/explanation bytes; it may not be omitted from Graph v1.

All evidence with the same semantic edge payload collapses. Evidence is byte-sorted by EvidenceId before truncation; `evidenceCount` is total rows, the first 64 are retained, and `omittedEvidenceCount` is the remainder. Because dependency `Set` construction already discarded duplicate occurrences, graph evidence never reconstructs them.

Resolution contributions aggregate in this order:

1. one unique exact target wins over heuristic/unresolved;
2. distinct exact targets at the same winning precedence become unresolved `ambiguous-highest-precedence`;
3. without exact, one unique heuristic target at the lowest numeric precedence wins;
4. distinct heuristic targets at that precedence become unresolved `ambiguous-highest-precedence`;
5. otherwise unresolved with the applicable closed reason code.

Lower precedence cannot create conflict with a winner. No path/name tie-breaker resolves ambiguity.

Serialization arrays use:

1. files, symbols, external modules, and references by ID;
2. edges by source ID, relation, reference absent-first/ID, target absent-first/ID, then edge ID; and
3. evidence by ID; candidates by precedence, rule, ID.

Normalized snapshot diagnostics belong to `RepositorySnapshotHandle` and checkpoint coherence only. They are not a field of `RepositoryGraphV1`, are not graph topology, and do not participate in deterministic graph ordering or serialization. Graph build/unavailable errors remain the separate bounded failure result defined below and retain their fixed code-specific generic messages; they do not add a dynamic diagnostics field to stable Graph v1.

Graph serialization is UTF-8 JCS of the graph arrays above. Repeated builds, equivalent initial/incremental snapshots, and different locales must be byte-identical.

## Complete graph result and bounded failures

```ts
interface RepositoryGraphV1 {
  readonly graphSchemaVersion: "repository-graph/v1";
  readonly analyzerCapabilityVersion: "repo-map-capabilities/v1";
  readonly snapshotContentIdentity: RepositorySnapshotHandle["snapshotContentIdentity"];
  readonly complete: true;
  readonly files: readonly FileNode[];
  readonly symbols: readonly SymbolNode[];
  readonly externalModules: readonly ExternalModuleNode[];
  readonly references: readonly GraphReference[];
  readonly edges: readonly GraphEdge[];
}

interface GraphBuildSuccess {
  readonly ok: true;
  readonly graph: RepositoryGraphV1;
  readonly serializedBytes: number;
}

type GraphBuildErrorCode =
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

interface GraphBuildError {
  readonly code: GraphBuildErrorCode;
  readonly phase: "validate" | "canonicalize" | "identify" | "resolve" | "serialize";
  readonly message: string; // fixed by code, <= 256 UTF-8 bytes
  readonly path?: string;   // canonical project-relative, <= 4,096 UTF-8 bytes
  readonly limit?: number;
  readonly observed?: number;
}

interface GraphBuildUnavailable {
  readonly ok: false;
  readonly error: GraphBuildError;
}

type GraphBuildResult = GraphBuildSuccess | GraphBuildUnavailable;
```

Graph v1 never returns partial topology; `complete` can only be true. A failure has no graph, stack, cause, source, arbitrary exception text, Git stderr, or absolute host path. Its exact public message is determined only by `code`:

| `code` | Exact public `message` |
|---|---|
| `invalid-snapshot` | `repository graph build failed: invalid snapshot` |
| `invalid-path` | `repository graph build failed: invalid path` |
| `path-collision` | `repository graph build failed: path collision` |
| `invalid-unicode` | `repository graph build failed: invalid Unicode` |
| `invalid-enum` | `repository graph build failed: invalid enum value` |
| `invalid-hash` | `repository graph build failed: invalid content hash` |
| `nested-bound-exceeded` | `repository graph build failed: nested bound exceeded` |
| `count-bound-exceeded` | `repository graph build failed: count bound exceeded` |
| `canonical-input-bound-exceeded` | `repository graph build failed: canonical input bound exceeded` |
| `serialized-graph-bound-exceeded` | `repository graph build failed: serialized graph bound exceeded` |
| `identity-collision` | `repository graph build failed: identity collision` |

An error includes `path` only when the implementation already has a valid graph-canonical project-relative path for the failing item; an invalid, absolute, or otherwise noncanonical input path is omitted rather than copied or partially sanitized. `phase`, `limit`, and `observed` are deterministic structured fields, not exception-derived text. As with snapshot diagnostics, optional heuristic sanitization/redaction is defense in depth and is not the guarantee; allowlisted construction is.

## Trust, validation, and resource bounds

The snapshot/graph is untrusted derived navigation evidence, not authoritative source. Consumers preserve freshness, pending paths, diagnostics, and capability version and must not claim compilation, reachability, accessibility, runtime behavior, security, or completeness beyond this contract.

Validation occurs incrementally before copying/canonicalizing large arrays or allocating node/edge indexes. The implementation maintains checked safe-integer counters and UTF-8 byte totals while walking input; it stops at first deterministic validation-order failure (files by recorded order, then fields in interface order). It does not stringify the whole unvalidated snapshot.

Required bounds are mutually cumulative:

- canonical path: 4,096 UTF-8 bytes; every other schema/provenance or graph-carried string/signature/specifier/name/relationship: 16,384 UTF-8 bytes;
- fixed snapshot diagnostic/summary message and fixed unavailable/graph-error message: 512/256 UTF-8 bytes respectively;
- files: 100,000; snapshot warnings: 100,000; dirty entries: 100,000; pending paths: 100,000; symbol rows: 1,000,000; references: 1,000,000; external modules: 250,000; edges: 1,000,000;
- per file: 2,000 lexical terms, 10,000 imports, 10,000 exports, 50,000 symbols, 20,000 dependencies;
- per import: 1,024 names; per symbol: 1,024 annotations, 1,024 modifiers, 1,024 type parameters, and 10,000 entries in each relationship array;
- total import + export + symbol + dependency + Java relationship evidence rows: 1,000,000;
- per collapsed edge: 64 retained evidence rows; per resolution: 32 retained candidates;
- total UTF-8 JCS bytes of validated canonical identity input: 256 MiB; final serialized graph: 256 MiB.

All counts and byte totals include nested entries even if later deduplicated. The canonical-input byte counter accounts for JCS punctuation/escaping and is checked during streaming/canonical assembly before a single aggregate allocation. The serialized graph is emitted through a counting sink/spool and rejected before exposing bytes above its limit. Candidate/evidence prefixes are bounded as specified; topology arrays are never silently truncated.

Validation also requires schema 1, known enum values, lowercase 64-hex content hashes, finite safe nonnegative sizes, positive safe lines, correct optional Java field types, and graph-canonical unique paths. Any unpaired surrogate in non-diagnostic input is `invalid-unicode`. Loaded snapshots receive full validation even though current `loadRepoMapSnapshot()` is lightweight.

No graph field contains source content, Git diff, absolute root, timestamp, environment data, telemetry, or unbounded parser text. Graph building is pure and resource-bounded by captured data plus the limits above.

## Compatibility and migration

No persisted-schema migration is required. Graph v1 consumes schema-1 snapshots and is in-memory only. It does not modify generation files/pointers, workspace revision, config, package metadata, current query/tool schemas, injection defaults, watcher behavior, or historical specifications.

The handle/provider is additive. Existing `query`/`queryCurrent` may remain until separately deprecated. A compatibility adapter outside the strict provider may exist, but strict `captureCurrent()` must never fall back to live `capture()`.

A persisted graph, richer symbol/span schema, compiler/classpath resolver, graph cache, planner/renderer, or tool requires a separately versioned contract and migration decision. Analyzer capability/graph schema versions are independent of package and persisted generator versions.

## Open questions for later slices

These do not alter v1 and must not be answered implicitly:

1. Should capability v2 add spans, alias roles, symbol spaces, qualified containers, anonymous/default roles, and logical overload/merge groups?
2. Should Resolver v2 use TypeScript programs/tsconfig/package metadata or Java source roots/classpaths/JPMS, and what I/O/cache boundary contains it?
3. Does rename/move stability require persisted cross-generation matching with confidence/provenance?
4. Should Git/watcher health become independent freshness axes?
5. If graphs become durable, what schema, activation, retention, quota, and migration rules apply?
6. Should projections define a full-checkpoint identity in addition to content identity?
7. Should current Java recursive kind/component defects be fixed before richer Java binding?

## Proposed future S02 implementation slice

A separate future implementation should be limited to:

1. atomically published immutable runtime checkpoints;
2. strict `capture()` and synchronous `captureCurrent()`;
3. canonical path/JCS/byte-comparator/domain-hash utilities;
4. pure schema-1 Graph v1 construction with bounded validation and discriminated results;
5. Resolver v1 file/literal-external targets only; and
6. focused exports/tests, without persistence, planner, renderer, projection cache, new tool, or richer parser extraction.

## Definition of Done for future implementation

The implementation is not done until tests establish:

- exactly one reconciliation for `capture()`, and one total for explicit `ensureFresh()` plus `captureCurrent()`;
- synchronous non-I/O `captureCurrent()` returns old/new complete checkpoint while a flush is blocked;
- deep ownership isolation in both caller-to-runtime and later-runtime-to-handle directions;
- bounded watcher storms can return stale with canonical byte-sorted pending paths;
- warning-only changes retain content identity; HEAD-only changes can alter workspace revision alone; activation failure demonstrates generation lag;
- current accepted noncanonical path forms canonicalize, collisions/root escape/control/unpaired-surrogate inputs fail closed;
- domain-separated IDs are compact digest IDs, descriptor collisions are checked, and no payload is reversibly embedded;
- every node/reference/evidence/edge interface and endpoint matrix is enforced; unresolved edges have no target;
- overload/same-name/container/default rules preserve rows without invented facts;
- evidence descriptors, aggregation, canonical row digest, truncation, and conflict rules match this contract;
- candidate retention includes the winner and all other existing bounded candidates with stable precedence/rule codes;
- TS/JS tests pin literal, JS-family substitution, extensionless, index, dotfile, trailing-dot/slash, query/fragment/NUL, root escape, absolute/scheme, bare and `node:` behavior;
- Java tests pin missing optional flags, wildcard unresolved, unique/duplicate FQNs, static owners, immediate-container heuristic, degraded/relationship behavior;
- dynamic/template import and nonliteral require produce no edge, while every represented dependency maps to raw unresolved evidence;
- diagnostic severity/phase mapping, fixed code-specific messages, canonical-or-absent project-relative paths, deterministic deduplication, exact summary rows, and unavailable errors are bounded and leak no arbitrary source/error text;
- every count/nested/string/canonical-input/serialization bound is exercised without partial topology or large pre-validation allocation;
- repeated serialization is byte-identical across locale and equivalent initial/incremental snapshots;
- TS/JS heritage and all other unavailable relations remain uninferred; and
- existing type/lint, unit, package, watcher, and coverage suites remain green with no persisted-schema or compatibility change.
