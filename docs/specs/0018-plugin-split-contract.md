# Specification 0018: Context Vault / Repo Context plugin split contract

## Status, authority, and scope

**Status:** Phase 1 contract for review. No production extraction is authorized by this document until the user
approves it and explicitly starts Phase 2.

This specification is the normative split authority for issue #47. It defines how the current modular
monolith is separated into two independently installable, configurable, runnable, testable, publishable, and
maintainable Pi plugins:

- `Fubuyunhua/pi-context-vault`, retained as the Observation and context-pressure product; and
- the future public repository `Fubuyunhua/pi-repo-context`, created only after Phase 1 approval.

The second GitHub repository does **not** exist merely because this contract names it. GitHub CLI
authentication was verified during Phase 0, but Phase 2 must verify it again immediately before repository
creation. This contract creates no repository, release, package, tag, or remote branch.

The safety anchor is local branch `checkpoint/pre-plugin-split`, commit
`7111dcf7d7e7753bfdcf97f6ec51cf3072930fed` (`checkpoint: preserve accepted repository graph foundation
before plugin split`). It contains the accepted S00/S01a and S02 Contract/Snapshot/Graph/Resolver work. The
checkpoint excludes pre-existing `docs/reports/**` and the paused S03 files. It must not be rewritten,
force-pushed, rebased away, cleaned, or used as a reason to delete untracked user material.

Specifications 0001–0016 remain evidence for existing behavior within their owned domains. Where an older
mixed-product specification conflicts with the split boundary, this specification governs ownership and
migration; it does not silently change the underlying behavioral contract. Persisted Repo Map remains schema
1. Repository Graph v1 remains derived and in-memory.

Normative terms **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are used in their usual requirements sense.

## Phase 1 deliverable and non-goals

Phase 1 creates only this file. It MUST NOT:

- move, delete, rename, or modify production code or tests;
- create `Fubuyunhua/pi-repo-context` or a second `.git` directory;
- edit either package manifest, lockfile, CI workflow, configuration loader, state, extension hook, or Tool;
- stage, commit, push, open a PR, publish, or release this contract automatically;
- continue S03 Planner, Renderer, Projection Cache, gold-task evaluation, Provider experiments, architecture
  recovery, project slicing, conformance, or requirements-traceability work;
- create a shared-core package, plugin event bus, service registry, or cross-plugin protocol; or
- delete, move, rewrite, or automatically migrate Observation or legacy Repo Map data.

Approval of this contract authorizes only the next explicitly approved phase, not the whole split.

## Current architecture and split seam

The current checkout is a modular monolith with one Pi entrypoint and one mixed composition root:

```text
extensions/index.ts
  -> src/extension.ts
       -> Vault domain
          src/artifacts/**
          src/observations/**
          src/context/**
       -> Repository domain
          src/repo-map/**
       -> mixed infrastructure
          src/state/config.ts
          src/state/project-state.ts
          src/state/atomic.ts
          src/telemetry.ts
```

There are no production imports from `src/repo-map/**` into `src/artifacts/**`, `src/observations/**`, or
`src/context/**`, and no repository-domain import of those Vault domains. Coupling is concentrated in
`src/extension.ts`, the combined configuration/state/telemetry modules, and small durable-filesystem helpers.
This is the extraction seam.

The extraction is **copy before delete**, not an in-place move. Phase 3 copies repository-owned code and
locally needed helpers into an independent directory/repository. No repository production file is removed
from Context Vault until Repo Context passes Phase 4 independent acceptance. Git history MUST NOT be
rewritten merely to manufacture a cleaner split history.

## Product identities

| Surface | `pi-context-vault` | `pi-repo-context` |
| --- | --- | --- |
| GitHub repository | existing `Fubuyunhua/pi-context-vault` | future public `Fubuyunhua/pi-repo-context` |
| npm/Pi package name | `pi-context-vault` | `pi-repo-context` |
| Product purpose | Observation storage, recovery, and context compression | Revision-aware repository indexing and code navigation |
| First split version | existing release line; exact release version requires approval | `0.1.0` |
| License | MIT | MIT |
| Required README description | Observation storage, recovery, and context compression for Pi | `Repository-aware code navigation extension for Pi.` |
| Extension ID / UI key | `context-vault` | `repo-context` |
| UI text | `vault v<version>` | `repo-context v<version>` |
| Command namespace | `/context-vault` | `/repo-context` |
| Configuration | `.pi/context-vault.json` | `.pi/repo-context.json` |
| State root | `${PI_CODING_AGENT_DIR}/context-vault/projects/<projectId>` | `${PI_CODING_AGENT_DIR}/pi-repo-context/projects/<projectId>` |
| Initial interaction model | Observation hooks and explicit Tools | Tool-first; no automatic context injection |

The two package names, extension IDs, UI keys, command namespaces, configuration files, and state roots are
intentionally distinct. Neither package depends on the other package being installed or started first.

## Exhaustive production ownership and migration matrix

| Current file or symbol | Context Vault action | Repo Context action | Compatibility/removal phase |
| --- | --- | --- | --- |
| `extensions/index.ts` | Keep, but make it register only the Vault adapter | Create an independent entrypoint in the new repository | Phase 3 creates Repo entrypoint; Phase 5 simplifies Vault |
| `src/extension.ts` / `registerContextVault` | Retain only Artifact/Observation/reduction lifecycle, Vault Tools, Vault commands, Vault status/UI, and migration stubs | Reimplement a repository-only adapter using copied repository runtime; do not import this file | Repo adapter Phase 3; mixed repo wiring removed Phase 5 |
| `src/artifacts/redaction.ts` | Own unchanged in purpose | MUST NOT copy or import | Permanent Vault ownership |
| `src/artifacts/store.ts` / `ArtifactStore` / leases / GC | Own artifacts, metadata, active-session leases, retention, and redaction | MUST NOT access or mutate | Permanent Vault ownership |
| `src/observations/virtualization.ts` / `ObservationRuntime` | Own receipts, archival, retrieval, and search | MUST NOT copy or import; define repository Tool bounds locally | Permanent Vault ownership |
| `src/context/reduction.ts` / `reduceContext` | Own context-pressure reduction | MUST NOT copy or call | Permanent Vault ownership |
| `src/repo-map/index.ts` | Remove only after Phase 4 | Copy; own TS/JS indexing, Git snapshot facts, MiniSearch, schema-1 Repo Map | Copy Phase 3; delete from Vault Phase 5 |
| `src/repo-map/java.ts` | Remove only after Phase 4 | Copy; own Java indexing | Copy Phase 3; delete from Vault Phase 5 |
| `src/repo-map/runtime.ts` / `RepoMapRuntime` | Remove runtime wiring and file only after Phase 4 | Copy; own watcher, freshness, Git HEAD/dirty/diff, generations, query, capture publication | Copy Phase 3; delete from Vault Phase 5 |
| `src/repo-map/canonical.ts` | Remove only after Phase 4 | Copy; own graph-local canonical path, JCS, comparator, and hashing utilities | Copy Phase 3; delete from Vault Phase 5 |
| `src/repo-map/snapshot.ts` / `RepositorySnapshotHandle` | Remove only after Phase 4 | Copy; own `capture()`, `captureCurrent()`, atomic checkpoint, and `snapshotContentIdentity` | Copy Phase 3; delete from Vault Phase 5 |
| `src/repo-map/graph.ts` / `RepositoryGraphV1` | Remove only after Phase 4 | Copy; own Graph nodes/edges/references/evidence/bounds, Resolver v1, ExternalModule, exact/heuristic/unresolved | Copy Phase 3; delete from Vault Phase 5 |
| `src/state/config.ts` | Split into Vault-only config plus temporary inert legacy-key tolerance | Create a new independent Repo config; never import/read Vault config | Phase 3 Repo copy; Phase 5 Vault split |
| `src/state/project-state.ts` | Preserve existing Vault root and only create Vault directories | Copy project-ID algorithm locally and use the new Repo root | Phase 3 Repo copy; Phase 5 Vault split |
| `src/state/atomic.ts` | Keep a package-local copy for artifacts, metadata, and locks | Copy only needed atomic-write/file-lock behavior locally | Copy Phase 3; never shared as package |
| `src/telemetry.ts` / `Telemetry` | Split to Vault-only counters | Create Repo-only counters | Phase 3 Repo copy; Phase 5 Vault split |
| `src/bench/telemetry-frame.ts` imported by production | Remove production-to-bench import; keep a tiny Vault-local framing helper if status-json needs it | Implement a distinct product-local frame only if Repo status-json needs it | Phases 3/5; no shared helper |
| `src/bench/**`, `scripts/bench.mjs` | Preserve as frozen legacy/experimental source in old history, but exclude from published Vault package | MUST NOT copy into published Repo package | Packaging exclusion in Phase 5; no bench v2 now |
| `src/repo-context/contracts.ts` | Preserve untracked as paused research; not Vault production | Do not include in Phase 3 or initial package | Separate future review only |
| Embedded helpers `errorMessage`, `utf8Prefix`, `toolResponse`, `notify`, relevant path helpers | Keep/copy locally only as needed by Vault | Copy/reimplement minimal package-local equivalents | Phases 3/5; no shared core |
| `package.json`, `package-lock.json`, TS/Biome/Vitest configs, CI, package smoke | Rewrite for Vault-only publication after Repo passes | Create independent equivalents and independent lockfile | Repo Phase 3/4; Vault Phase 5/6 |
| `README.md`, `README.zh-CN.md`, release docs | Rewrite to Vault-only claims and migration instructions | Create Repo-only README/release notes | Phases 3/5; no cross-repo doc import |

Observation artifacts, receipts, metadata logs, leases, and retention records are evidence, not extraction
inputs. They never move to Repo Context. Repo Map generations are derived state, but this does not authorize
deleting them.

## Extension lifecycle and hooks

| Current hook/surface | Context Vault after split | Repo Context after split | Migration rule |
| --- | --- | --- | --- |
| `session_start` | Load only Vault config/state; start ArtifactStore, lease, and ObservationRuntime | Load only Repo config/state; start RepoMapRuntime | Failures remain product-local |
| `before_agent_start` | No Repo refresh; retain only genuinely Vault-owned work if any | **Do not register** for automatic freshness | Explicit Repo Tool/command reconciles freshness live |
| `tool_result` | Archive eligible non-plugin results; skip names beginning `context_vault_` or `repo_context_` | No Observation processing | Fixed-prefix exclusion; no event bus |
| `context` | Run only Observation/context reduction | **Do not register** a map injection hook | Removes hook-order dependency entirely |
| `session_shutdown` | Close Vault lease/store resources and clear only `context-vault` UI | Close Repo watcher/runtime and clear only `repo-context` UI | One shutdown cannot affect the other |
| automatic Repo capsule | Remove `FrozenMapCapsule`, map query/render/insertion/removal code, and turn-freeze state | Do not copy | No compatibility capsule in split plugins |
| `MAP_CAPSULE_TYPE = "context-vault-repo-map"` | Do not emit or manage | Do not emit or manage | Stale old-session messages are left untouched |

Repo Context v0.1.x registers no automatic capsule, no `before_agent_start` refresh, and no repository `context`
hook. It never emits `context-vault-repo-map`. This is the resolution of the prior hook-order risk: no
coordination mechanism or ordering contract is invented because there are not two competing context hooks.
Neither plugin edits stale capsules already present in a transcript created by the monolith. Migration
requires a Pi restart/new session.

The fixed Vault `tool_result` skip condition is:

```ts
toolName.startsWith("context_vault_") || toolName.startsWith("repo_context_")
```

The deprecated `context_vault_repo_map` alias is already covered by the first prefix. This filtering is the
only intentionally coordinated behavior in v1; it is a fixed name convention, not a plugin API.

## Tools, commands, status, and compatibility aliases

| Current/public surface | Context Vault action | Repo Context action | Compatibility/removal phase |
| --- | --- | --- | --- |
| `context_vault_obs_get` | Keep with current Observation semantics | MUST NOT register | Permanent Vault surface |
| `context_vault_obs_search` | Keep with current Observation semantics | MUST NOT register | Permanent Vault surface |
| `context_vault_status` | Keep, but return only Vault component/config/migration warnings/telemetry | MUST NOT aggregate or call it | Vault split release |
| `context_vault_repo_map` | Stop registering after extraction | Repo alone registers as deprecated alias to `repo_context_search` | Present only in Repo `0.1.x`; remove in `0.2.0` unless separately extended |
| `repo_context_search` | MUST NOT register | Register as primary live Repo Map search Tool | Repo `0.1.0` |
| `repo_context_status` | MUST NOT register | Register as primary repository status Tool | Repo `0.1.0` |
| `/context-vault status` | Vault-only status | No action | Permanent Vault surface |
| `/context-vault status-json` | Vault-only deterministic status/telemetry frame | No action | Permanent Vault surface |
| `/context-vault gc` | GC artifacts/metadata/leases/Observation retention only | No action; cannot touch Vault | Vault split release changes scope explicitly |
| `/context-vault doctor` | Vault-only diagnostics plus legacy-config migration warning | No action | Permanent Vault surface |
| `/context-vault rebuild` | Keep only a non-executing migration stub | No registration in this namespace | First post-split Vault compatibility release only; later removal requires approval |
| `/repo-context status` | No action | Repository-only status | Repo `0.1.0` |
| `/repo-context rebuild` | No action | Live repository rebuild into Repo-owned state | Repo `0.1.0` |
| `/repo-context doctor` | No action | Repository-only diagnostics/config/state checks | Repo `0.1.0` |
| UI key `context-vault` | Keep; text `vault v<version>` | MUST NOT set/clear | Permanent Vault surface |
| UI key `repo-context` | MUST NOT set/clear | Own; text `repo-context v<version>` | Repo `0.1.0` |

The primary and deprecated repository search Tools MUST share one handler and input schema. The primary Tool
preserves the existing bounded MiniSearch query behavior while using Repo-owned constants rather than
importing Observation constants. Existing current bounds are query length 512 and at most 20 results; the
configured response-byte limit is `searchMaxBytes`. The alias result `details` MUST add exactly:

```json
{
  "deprecated": true,
  "replacement": "repo_context_search"
}
```

Only Repo Context owns the alias. Context Vault MUST stop registering it before the two final plugins are
considered coexistence-safe. Alias removal is committed for Repo Context `0.2.0` unless a separately reviewed
compatibility decision changes that schedule.

The `/context-vault rebuild` stub returns exactly:

```text
Repository rebuild has moved to pi-repo-context.
Install pi-repo-context and use /repo-context rebuild.
```

It MUST NOT start a watcher, query a Repo runtime, mutate either state root, or attempt cross-plugin dispatch.
`context_vault_status` is not a compatibility aggregator and contains no live Repo component after the split.
The changed `/context-vault gc` scope and moved rebuild command MUST be prominent in both READMEs and release
notes before publication.

## Configuration ownership and migration

### Context Vault configuration

Context Vault continues to read only `.pi/context-vault.json`. Its active fields are:

```text
reductionEnabled
archivePolicy
archiveMinBytes
replacementThresholdBytes
archiveErrorsAlways
archiveThresholdBytes          deprecated alias retained under its existing rule
receiptMaxBytes
hotObservationCount
softContextRatio
targetContextRatio
projectQuotaBytes
retentionDays
```

Existing defaults and validation remain authoritative unless a separate Vault contract changes them:

| Field | Default | Existing bound/rule |
| --- | ---: | --- |
| `reductionEnabled` | `true` | boolean |
| `archivePolicy` | `"all"` | `all`, `errors-and-large`, or `off` |
| `archiveMinBytes` | 16 KiB | non-negative safe integer |
| `replacementThresholdBytes` | 16 KiB | positive safe integer |
| `archiveErrorsAlways` | `true` | boolean |
| `archiveThresholdBytes` | 16 KiB | deprecated; cannot coexist with `replacementThresholdBytes`; normalized to it |
| `receiptMaxBytes` | 4 KiB | positive integer and at least 512 bytes |
| `hotObservationCount` | 6 | positive integer |
| `softContextRatio` | 0.75 | finite, strictly between 0 and 1 |
| `targetContextRatio` | 0.60 | finite, strictly between 0 and 1 and below `softContextRatio` |
| `projectQuotaBytes` | 512 MiB | positive integer |
| `retentionDays` | 30 | positive integer |

For the first post-split Context Vault compatibility release, its loader MUST recognize and ignore any value
or type for these exact legacy repository keys:

```text
repoMapEnabled
mapInjectionMode
mapContextMaxBytes
mapDebounceMs
mapGenerationRetention
mapQuotaBytes
mapExcludePatterns
debugRequestFingerprints
```

Their presence MUST NOT fail initialization and MUST NOT activate repository behavior. Unknown keys outside
the active and legacy lists remain errors. If any legacy key is present, `context_vault_status` and
`/context-vault doctor` emit this fixed warning once in their structured warning list:

```text
Repository Map configuration has moved to pi-repo-context.
```

This tolerance lasts for at least the first post-split compatibility release. Its removal is not automatic;
it requires a separately approved compatibility decision and release note.

### Repo Context configuration

Repo Context reads and writes only `.pi/repo-context.json`. It MUST NOT read, import, merge, fallback to, or
write `.pi/context-vault.json`.

| New field | Legacy source | Default | Bound/rule |
| --- | --- | ---: | --- |
| `enabled` | `repoMapEnabled` | `true` | boolean |
| `searchMaxBytes` | `mapContextMaxBytes` | 6 KiB | integer, at least 512 bytes |
| `debounceMs` | `mapDebounceMs` | 300 | positive integer |
| `generationRetention` | `mapGenerationRetention` | 3 | positive safe integer |
| `quotaBytes` | `mapQuotaBytes` | 128 MiB | positive safe integer |
| `excludePatterns` | `mapExcludePatterns` | `[]` | array of non-empty strings |

These defaults and bounds are intentionally inherited from the current loader; the rename removes product-
internal `map` prefixes. Unknown keys are errors. `mapInjectionMode` has no new equivalent because automatic
injection does not exist. `debugRequestFingerprints` remains inert legacy/research state and is not a Repo
Context v1 option.

The mapping table is documentation for manual migration and release tooling only; it does not authorize Repo
Context to read the old file. Examples in the Repo README MUST show users how to create the new file.

### Pre-split monolith coexistence guard

A pre-split map-capable monolith and the new Repo plugin MUST NOT run concurrently. Before enabling Repo
Context beside the checkpointed/pre-split plugin, the user must set in the legacy file:

```json
{
  "repoMapEnabled": false,
  "mapInjectionMode": "off"
}
```

and restart Pi into a new session. This prevents duplicate legacy Tool ownership, watchers, and independent
writers. In-session config drift is not a migration mechanism. Unsupported concurrent activation is a
migration error; neither plugin attempts lock-based service discovery or automatic coordination.

## State roots, identity, provenance, and deletion rights

Both products independently copy the existing project identity algorithm:

```text
projectRoot = realpath(resolve(cwd))
projectId = first 32 lowercase hex characters of SHA-256(projectRoot)
```

They do not import the algorithm from each other. The exact roots are:

```text
Context Vault:
${PI_CODING_AGENT_DIR}/context-vault/projects/<projectId>/
  artifacts/
  metadata/
  (Vault-owned lease/GC files)

Repo Context:
${PI_CODING_AGENT_DIR}/pi-repo-context/projects/<projectId>/
  repo-map/
  (Repo-owned generation and active-pointer files)
```

Context Vault preserves its current root rather than renaming it. It MUST NOT eagerly create a Repo Map
directory after Phase 5. Repo Context MUST NOT access the Vault root.

Observation artifacts, metadata, receipts, active-session leases, and GC/retention records are authoritative
evidence. They MUST NOT be moved, copied to Repo Context, automatically rewritten, or deleted as part of the
split. Context Vault alone may mutate or collect them under existing safety rules.

Legacy Repo Map state under
`${PI_CODING_AGENT_DIR}/context-vault/projects/<projectId>/repo-map` is derived but MUST remain untouched. Repo
Context never moves, copies, adopts, validates, activates, prunes, or deletes it. Initial startup cold-builds
from source into the new root. A future cleanup may only provide manual instructions; the first split release
performs no automatic deletion.

Repo Context keeps `REPO_MAP_SCHEMA_VERSION = 1` for the persisted structural format and writes new
provenance:

```text
generator = "pi-repo-context"
generatorVersion = "0.1.0"
```

Its validators accept only Repo-owned new-root generations with that new provenance. They do not accept old
`generator = "pi-context-vault"` generations. Tests MUST prove old-root state is never loaded, even when
structurally valid. Repository Graph v1, its resolver assembly, and checkpoints remain derived in-memory
views; no persisted Graph schema is introduced.

Each product may unlink, prune, or garbage-collect only paths beneath its own exact root. Startup, shutdown,
uninstall, rollback, and degradation of one product MUST leave the other root byte-for-byte unchanged.
Uninstall does not delete either state root.

## Telemetry ownership

The current mixed `Telemetry` object is split into two independent classes/frames. No mutable telemetry
object or frame identifier is shared.

| Current metric family/field | Final owner | Action |
| --- | --- | --- |
| `archiveAttemptCount`, `archiveSuccessCount`, `archiveFailureCount`, `archiveDeduplicatedCount`, `archiveDurationMsTotal` | Context Vault | Keep |
| all `metadata*` counters/totals | Context Vault | Keep |
| all `reduction*`, `reducedObservationCount`, `estimatedTokens*`, `targetReachedCount` | Context Vault | Keep |
| future Artifact/Observation/GC metrics | Context Vault | Product-local only |
| `repoMapQueryCount`, `repoMapQueryDurationMsTotal` | Repo Context | Move/copy |
| `ensureFreshCount`, `ensureFreshDurationMsTotal`, `filesReindexed` | Repo Context | Move/copy |
| all `gitHead*`, `gitDirty*`, `gitDiff*` | Repo Context | Move/copy |
| all `searchIndexBuild*` | Repo Context | Move/copy |
| all `generation*`, `repoMapTotalBytes`, `maintenanceFailureCount` | Repo Context | Move/copy |
| future watcher/graph/resolver metrics | Repo Context | Product-local only |
| `capsuleBuildCount`, `capsuleBytes`, `capsuleHashChangeCount`, `capsuleInsertionIndex`, `repoMapAutomaticQueryCount` | Neither production plugin | Retire with automatic injection; retain only in frozen historical bench schemas/results |

Status and telemetry failures are local to their product. There is no unified cross-plugin telemetry. The
current production import from `src/bench/telemetry-frame.ts` must be replaced with a small product-local
framing helper where needed. Frame IDs MUST be distinct so one parser cannot attribute Repo metrics to Vault
or vice versa.

## Dependencies, packaging, and copied helpers

Repo Context owns these runtime dependencies because its repository implementation imports them:

```text
chokidar
java-parser
minisearch
typescript
```

After repository code and the bench are removed/excluded, Context Vault drops all four from **runtime**
dependencies. It MUST retain `typescript` explicitly as a development dependency because its `typecheck` script
uses `tsc`; this build-only dependency does not confer repository-analysis ownership. Repo Context retains
`typescript` as a runtime dependency and may use the same installation for typechecking. Both plugins keep
`@earendil-works/pi-coding-agent` and `typebox` as peer dependencies and development dependencies for testing
their own Tool/command adapters. Each also declares its own build/test development tools—Biome, Vitest, V8
coverage, and Node type declarations—rather than relying on a sibling installation. Repo Context begins at
`0.1.0`, uses MIT, Node compatibility no weaker than the current `>=22.19.0`, and has its own
`package-lock.json`.

Each repository independently owns:

```text
package.json
package-lock.json
tsconfig.json
biome.json
vitest.config.ts
.github/workflows/ci.yml
scripts/package-smoke.mjs
extensions/index.ts
LICENSE
README.md
```

Each defines `check`, `typecheck`, `lint`, `test`, `test:coverage`, `test:package`, and `ci`. Repo Context also
defines `test:watcher`. Vault MUST NOT retain a watcher script that depends on Repo code. Coverage thresholds
remain at least 85% lines and 80% branches unless separately approved. CI keeps Node 22.19.0/24 coverage and
relevant macOS/Windows smoke. Package smoke MUST inspect only that product's published surface.

Small infrastructure is copied locally rather than factored into a third package:

```text
atomic write and file lock
canonical-realpath project identity
product-local telemetry and framing
errorMessage
utf8Prefix
toolResponse
notify
relevant path helpers
```

The copies may diverge according to product needs. There is no `pi-plugin-core`, private source-path import,
workspace package dependency, synchronized version constraint, or coordinated release requirement.

## Test ownership and extraction matrix

| Current test | Context Vault | Repo Context | Required action |
| --- | --- | --- | --- |
| `artifact-store.test.ts`, `artifact-metadata-log.test.ts` | Keep | No | Vault-only |
| `observation-archive-policy.test.ts`, `observation-virtualization.test.ts` | Keep | No | Vault-only |
| `context-reduction.test.ts` | Keep | No | Vault-only |
| `file-lock.test.ts`, `file-lock-subprocess.test.ts` | Keep Vault copy | Copy relevant lock coverage | Product-local helper tests; no shared test import |
| `atomic-durability.test.ts` | Keep Artifact/metadata cases | Extract Repo generation/write cases if applicable | Split cases by state owner |
| `repo-map.test.ts` | Remove only after Phase 4 | Copy | Repo-only |
| `java-repo-map.test.ts`, `java-repo-map-runtime.test.ts` | Remove only after Phase 4 | Copy | Repo-only |
| `repo-map-runtime.test.ts`, `repo-map-runtime-capture.test.ts` | Remove only after Phase 4 | Copy | Repo-only |
| `repo-map-canonical.test.ts`, `repo-map-snapshot.test.ts` | Remove only after Phase 4 | Copy | Repo-only |
| `repo-map-graph.test.ts`, `repo-map-graph-types.test.ts`, `repo-map-graph-resolver.test.ts` | Remove only after Phase 4 | Copy | Repo-only |
| `watcher-smoke.test.ts` | Remove after Phase 4 | Copy and retain cross-platform smoke | Repo-only |
| `extension.test.ts` | Extract Vault lifecycle/Observation/reduction/commands/status | Extract Repo startup/search/status/rebuild/alias/no-injection | Replace mixed fixtures with independent adapters |
| `extension-gates.test.ts` | Keep Vault-disabled/degraded independence cases | Extract Repo enabled/disabled/config/tool registration cases | Add coexistence tests separately |
| `hardening.test.ts` | Keep artifact corruption/GC/lease cases | Extract Repo activation/concurrency/state validation cases | Do not share state roots |
| `state.test.ts` | Keep Vault config/root/legacy-tolerance cases | Extract new Repo config/root/provenance cases | Add old-root non-adoption assertions |
| `telemetry.test.ts` | Keep archive/metadata/reduction cases | Extract query/freshness/Git/search/generation cases | Assert distinct frames |
| all `bench-*.test.ts` | Frozen legacy only | No | Exclude from both published packages |
| `repo-context-contract.test.ts` and `tests/fixtures/repo-context/**` | Paused research | Not initial package | Excluded from Phase 3/4 evidence |

Repo independent acceptance MUST cover build, watcher, query, capture, snapshot identity, Graph, Resolver,
commands, status, deprecated alias, configuration, state provenance, and package loading without Context
Vault installed. Vault independent acceptance MUST cover archival, receipt recovery, retrieval/search,
reduction, GC/retention, leases, status/doctor, legacy-key tolerance, and package loading without Repo Context.

## Specifications, documentation, S03, and bench disposition

| Current material | Vault action | Repo action | Disposition phase |
| --- | --- | --- | --- |
| Specs 0008, 0011, 0012, 0013 | Keep as Vault authority | No | Phase 5 docs audit |
| Specs 0002, 0004, 0005, 0006, 0007, 0009, 0015, 0016 | Remove repo claims from final Vault docs as appropriate | Copy and rewrite product identity/provenance/injection history | Phase 3 copy; Phase 5 Vault cleanup |
| Mixed Specs 0001, 0003, 0010 | Keep rewritten Vault-owned portions | Copy/rewrite Repo-owned portions | No cross-repository doc dependency |
| Spec 0014 and A–F bench docs/results | Preserve frozen historical/experimental material outside published product | Do not copy to published package | Phase 5 publish exclusion |
| Spec 0018 | Keep as split authority | MAY copy for provenance | After approval only |
| `deepResearch.md`, `docs/reports/**` | Preserve; do not overwrite or infer shipped behavior | No initial package copy | User/research material |
| Spec 0017, `src/repo-context/contracts.ts`, `tests/repo-context-contract.test.ts`, `tests/fixtures/repo-context/**` | Preserve untracked as paused research | Exclude from checkpoint, Phase 3, and initial package | Separate future issue/review only |
| README and release docs | Rewrite to Observation-only product and migration warnings | Create repository-navigation README and alias/config/state migration notes | Before either release |

The S03 material does not prove a shipped Planner, Renderer, Projection Cache, Body/Envelope framework, gold-
task evaluator, Tool, or benchmark. It remains recoverable only in the current untracked worktree until the
user separately approves a research checkpoint or migration. Phase 1 MUST NOT stage it.

The current bench crosses both product boundaries. It remains frozen legacy/experimental material in the
old repository/history and is excluded from both published packages. No bench v2, third repository, or shared
benchmark package is created in this split. Existing historical results MUST NOT be reinterpreted as evidence
for the split deployment.

## Repo Context first-version functional boundary

The mechanical split version exposes only the already implemented repository capabilities plus the explicit
adapter surfaces required here:

```text
TS/JS index
Java index
MiniSearch query
Git HEAD and dirty workspace
workspaceRevision
watcher, generation, freshness, and maintenance
capture() and captureCurrent()
snapshotContentIdentity
Repository Graph v1 and Resolver v1
exact / heuristic / unresolved
repo_context_search and repo_context_status
/repo-context status, rebuild, and doctor
0.1.x deprecated context_vault_repo_map alias
```

It is Tool-first and does not add automatic injection. It MUST NOT implement Planner, Renderer, Projection
Cache, provider benchmarking, architecture recovery, project slicing, conformance, requirements tracing,
embeddings, or a semantic `repo_context` MVP during Phases 2–7.

Only after all split/coexistence gates pass may Phase 8 separately add the bounded minimal `repo_context` MVP:
MiniSearch seeds, one Graph hop, at most six files, key Symbols/relation reasons, at most 6 KiB, and same-
snapshot/request determinism. Phase 8 is not authorized by approval of this contract.

## Phase sequence and phase gates

Every phase starts with a written declaration of current goal, allowed files, non-goals, test plan, and stop
condition. Every phase ends with changed files, behavior changes, test results, incomplete work, risks, and a
next-step recommendation. No phase starts merely because the previous implementation exists; its acceptance
must be explicit.

### Phase 0 — safety checkpoint (complete)

- **Allowed:** Git audit, checkpoint branch, commit of accepted S00/S01a/S02 code and formal Specs.
- **Forbidden:** reports/S03 staging, cleanup, rewrite, push.
- **Gate:** `7111dcf` exists on `checkpoint/pre-plugin-split`; reports and S03 remain untracked.
- **Rollback:** return to the checkpoint without cleaning user files.

### Phase 1 — split contract (current)

- **Allowed:** only this Spec and issue discussion.
- **Forbidden:** all production/package/state changes and new repository creation.
- **Tests:** source/ownership audit, independent contract reviews, `git diff --check`, status/no-staged check.
- **Stop:** user approves Spec 0018. Otherwise revise only the Spec.

### Phase 2 — create public Repo Context repository

- **Allowed after approval:** recheck `gh auth status`; create public `Fubuyunhua/pi-repo-context` with the
  approved description; prepare an independent local directory without nesting `.git` in this worktree.
- **Forbidden:** production extraction or deletion until repository creation/path safety is verified; no
  remote README initialization when local content will provide it; no release.
- **Tests:** visibility/owner/empty-remote verification and path separation.
- **Stop:** public empty repository and safe local extraction directory exist. Authentication failure stops
  immediately; it must not be bypassed.

### Phase 3 — copy Repo Map / Graph / Resolver without new features

- **Allowed:** copy repository modules, required local helpers, repo-owned tests/Specs, independent package,
  Repo config/state/telemetry/adapter, primary Tools/commands, and deprecated alias.
- **Forbidden:** deleting any Repo production file from Context Vault; S03/MVP; automatic injection; old-state
  adoption; shared package; Observation code.
- **Tests:** focused copied core tests continuously; config/provenance/adapter/package tests.
- **Stop:** extraction complete enough for Phase 4; old repository implementation remains intact.

### Phase 4 — Repo Context independent acceptance

Run in the new repository with no Context Vault package installed:

```bash
npm ci
npm run check
npm test
npm run test:package
npm run test:watcher
npm run test:coverage
git diff --check
```

Acceptance additionally proves plugin startup, build, watcher, query, Graph, Resolver, commands/status,
deprecated alias, new-root writes, old-root non-access, and shutdown. Package contents contain no Vault source
or S03/bench assets. Failure stops the split and leaves Context Vault untouched.

### Phase 5 — simplify Context Vault

- **Allowed only after Phase 4:** delete/migrate Repo-owned production code/tests/dependencies/wiring from the
  Vault package; split config/state/telemetry; add legacy-key tolerance/rebuild stub; rewrite docs/package
  smoke; exclude frozen bench from publication.
- **Forbidden:** deleting legacy state, Observation evidence, reports, checkpoint, or new Repo source; adding a
  cross-plugin dependency or S03 feature.
- **Tests:** focused Vault tests after each seam removal plus legacy config and command migration tests.
- **Stop:** source/package scan finds no Repo runtime/parser/watcher/Graph/Resolver/import/dependency.

### Phase 6 — Context Vault independent acceptance

Run with no Repo Context package installed:

```bash
npm ci
npm run check
npm test
npm run test:package
npm run test:coverage
git diff --check
```

Acceptance proves Observation archive, receipt recovery, get/search, reduction, GC/retention, leases,
status/doctor, legacy map-key tolerance, rebuild stub, independent degradation, and no Repo state creation or
dependency. Failure is repaired or rolled back before coexistence work.

### Phase 7 — real dual-plugin coexistence acceptance

Install packed artifacts for both plugins in a clean Pi environment and run both load orders. Prove:

- both extensions load with distinct IDs and UI keys;
- `context_vault_obs_get`, `context_vault_obs_search`, `context_vault_status`, `repo_context_search`, and
  `repo_context_status` have exactly one owner;
- deprecated `context_vault_repo_map` has exactly one owner in Repo `0.1.x`;
- `/context-vault` and `/repo-context` commands operate independently;
- there is one Repo watcher/writer and no automatic Repo capsule/context hook;
- config files and exact state roots do not overlap;
- Repo Tool results are not pointlessly archived/replaced by Vault;
- shutting down or disabling Repo leaves Vault archival/retrieval/reduction working;
- Repo degradation leaves Vault working;
- Vault degradation leaves Repo search/status/rebuild working;
- starting/shutting down either product leaves the other's state tree byte-for-byte unchanged;
- no direct imports, package dependencies, runtime calls, shared mutable state, or startup-order requirements
  exist; and
- the unsafe pre-split monolith coexistence path is rejected/documented unless its map behavior is disabled
  and Pi restarted first.

Failure blocks Phase 8 and all release claims of independent coexistence.

### Phase 8 — separately approved minimal Repo Context MVP

Only after Phase 7 acceptance, a new issue/contract may implement the bounded MVP described above and 8–10
simple code-location tasks not weaker than old MiniSearch. It is not part of this split contract's current
execution. After its gate, feature development stops for 2–4 weeks of dogfooding.

## Independent acceptance and release gates

No release is authorized by this specification. Before a user-approved release, each product must have:

1. its own clean install from packed artifact and no dependency on the sibling package;
2. its own config, root, extension ID, UI key, Tools, commands, telemetry, README, license, lockfile, CI, and
   package smoke;
3. no unpublished cross-repository source import or startup-order dependency;
4. deterministic status/error behavior under sibling absence and degradation;
5. documented legacy config, Tool alias, command, state, GC, and rollback behavior;
6. no automatic deletion of any legacy or authoritative state; and
7. user approval for commit/push/PR/release actions not otherwise explicitly granted.

A+B coexistence does not mean either calls the other. It means their independently owned surfaces do not
collide.

## Rollback and failure policy

On a Phase 2–4 failure, abandon or revert only the new extraction work. Do not remove repository code from
Context Vault. On a Phase 5–7 failure, restore the affected product from reviewed commits/checkpoint while
preserving both state roots and every Observation artifact.

Operational rollback from the new Repo plugin is:

1. stop/disable/remove Repo Context;
2. restart Pi;
3. if needed, re-enable the checkpointed monolith's Repo behavior in `.pi/context-vault.json`;
4. restart again before using the legacy Tool/watcher.

No state conversion is needed because new and legacy roots never overlap. Rollback MUST NOT clean untracked
reports/S03 files, rewrite history, force-push, or delete either root.

## Forbidden coupling and explicit non-goals

The final plugins MUST have no:

```text
cross-package import or package dependency
shared RuntimeState or Telemetry instance
shared configuration file or loader
shared generation/state root
startup or shutdown ordering dependency
direct API call
formal inter-plugin API/event bus/service discovery/shared registry
third production shared-core package
automatic Repo Map capsule or context injection
Provider experiment or cache claim
automatic legacy-state migration/deletion
Observation artifact movement into Repo Context
Graph persistence or persisted schema upgrade
```

The first split does not implement complex S03, the Phase 8 MVP, a new benchmark, architecture recovery,
Project Slice, conformance, change-impact analysis, full call graphs, embeddings, or release automation.

## Migration and release-note requirements

Before any split release, both products document:

- the new Repo package/repository name and installation;
- manual old-to-new config field mapping and the fact that Repo never reads the old file;
- required pre-split monolith disablement and Pi restart;
- Tool rename, `context_vault_repo_map` deprecation details, and planned `0.2.0` removal;
- moved rebuild command and exact Vault stub response;
- Vault-only GC scope;
- separate state roots, cold rebuild, new provenance, and non-deletion of legacy state;
- absence of automatic repository injection in Repo `0.1.x`;
- independent status/UI/telemetry surfaces;
- rollback procedure; and
- S03/bench non-shipping status.

Release notes MUST NOT claim the legacy Repo Map state was migrated, Planner/Renderer/Cache exists, Provider
cache performance improved, or Graph is persisted.

## Open questions and deferred decisions

No unresolved technical decision blocks Phase 2 after user approval of this contract. The following are
explicitly deferred and require later user decisions rather than implementation inference:

1. the exact Context Vault post-split release number and release dates;
2. whether compatibility tolerance or the rebuild stub lasts longer than the first post-split release;
3. whether the Repo alias removal commitment is extended beyond `0.2.0`;
4. whether/when paused S03 research receives its own checkpoint or moves to Repo Context research docs;
5. whether any future bench v2 or third research repository is desirable; and
6. authorization for each commit, push, PR, or release after the checkpoint.

None of these permits Phase 2 to begin without explicit user approval. This document's stop condition is
reviewed Contract acceptance, followed by waiting.
