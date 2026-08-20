# Specification 0003: Runtime Telemetry Baseline

Status: Accepted for implementation

## Problem

The Context Vault currently exposes almost no runtime observability. The SWE-bench
experiment report and the maintenance brief both identify suspected hot paths
(per-LLM-call capsule rebuild, full-snapshot generations, MiniSearch rebuilds,
archive metadata rewrites) but there is no way to confirm them from inside the
plugin. `context_vault_status` and `/context-vault status` report lifecycle and
degradation state only; nothing reports how many capsules were built, how long
queries took, how many generations were written, or whether reduction ever ran.
Without counters, fixes cannot be validated and regressions cannot be detected.

## Goals

- Add a bounded, low-overhead runtime telemetry summary covering capsule
  injection, repo-map queries, generation writes, observation archiving, and
  context reduction.
- Expose the summary through `runtimeStatus()` and `/context-vault status`.
- Use monotonic timing (`performance.now()`).
- Keep every metric as a plain number or a last-value scalar; never accumulate
  per-request detail records.
- Ensure telemetry cannot change model-visible messages, archiving decisions,
  repo-map query results, or persisted output.
- Ensure telemetry failures can never degrade the extension.

## Non-goals

- This Spec does not change the capsule generation frequency or insertion
  position (Spec 0002 governs that).
- This Spec does not change the observation archiving policy.
- This Spec does not change generation retention.
- This Spec does not add per-message content fingerprints. A
  `debugRequestFingerprints` config option is reserved for a later Spec and
  defaults to `false`; this Spec only adds the (inert) option, it does not
  implement fingerprint recording.
- This Spec does not add query latency histograms, per-operation log files, or
  any unbounded storage.

## Current behavior

`runtimeStatus()` returns `{ extension, initialized, degraded, project,
components: { observations, repoMap }, failures }`. `ObservationRuntime.status()`
returns `{ projectId, projectRoot, sessionId, archived, replaced, degraded,
failures }`. `RepoMapRuntime.status()` returns freshness/generation/revision
state. There are no timing counters anywhere, and `reduceContext` results
(`triggered`, `reducedCount`, token estimates) are computed but discarded by the
`context` hook.

## Required behavior

### Telemetry store

Add `src/telemetry.ts` exporting:

- `TelemetrySnapshot` — an interface of plain number fields (all counters and
  duration totals; `capsuleBytes` and `capsuleInsertionIndex` are last-value
  scalars).
- `Telemetry` — a class whose `snapshot()` returns a fresh shallow copy of all
  fields. The class exposes typed record methods; no method returns the
  snapshot (the extension calls `snapshot()` when building status).

Fields (names fixed by this Spec):

| Group | Fields |
|---|---|
| Capsule | `capsuleBuildCount`, `capsuleBytes`, `capsuleHashChangeCount`, `capsuleInsertionIndex`, `repoMapAutomaticQueryCount` |
| Repo Map | `repoMapQueryCount`, `repoMapQueryDurationMsTotal`, `ensureFreshCount`, `ensureFreshDurationMsTotal`, `filesReindexed`, `searchIndexBuildCount` |
| Generation | `generationCreatedCount`, `generationBytesWritten`, `repoMapTotalBytes`, `maintenanceFailureCount` |
| Observation | `archiveAttemptCount`, `archiveSuccessCount`, `archiveFailureCount`, `archiveDeduplicatedCount`, `archiveDurationMsTotal`, `metadataReadDurationMsTotal`, `metadataWriteDurationMsTotal` |
| Reduction | `reductionInvocationCount`, `reductionTriggeredCount`, `reducedObservationCount`, `estimatedTokensBeforeTotal`, `estimatedTokensAfterTotal`, `targetReachedCount`, `reductionDurationMsTotal` |

Definitions:

- `capsuleBuildCount` — number of times the automatic capsule was built
  (not reused).
- `capsuleBytes` — size in bytes of the most recently built capsule (last value).
- `capsuleHashChangeCount` — number of builds whose SHA-256 of the capsule
  content differs from the previous build (first build never counts).
- `capsuleInsertionIndex` — insertion index of the most recently built capsule
  (last value).
- `repoMapAutomaticQueryCount` — queries issued by the automatic `context` hook
  build path (excludes explicit `context_vault_repo_map` tool calls).
- `repoMapQueryCount` / `repoMapQueryDurationMsTotal` — all `RepoMapRuntime.query`
  invocations and their total wall time.
- `ensureFreshCount` / `ensureFreshDurationMsTotal` — all `ensureFresh()`
  invocations (explicit and query-internal) and total wall time.
- `filesReindexed` — total number of single-file indexing operations
  (`indexRepoMapFile` calls in the fast-update and dirty-reconciliation paths).
- `searchIndexBuildCount` — number of `RepoMapSearch` (MiniSearch) builds.
- `generationCreatedCount` — number of successfully activated generations.
- `generationBytesWritten` — cumulative bytes of generation files written.
- `repoMapTotalBytes` — running estimate of generation bytes on disk (incremented
  on writes; never scanned recursively).
- `maintenanceFailureCount` — number of `#degrade` transitions (flush/rebuild
  failures).
- `archiveAttemptCount` — archiving attempts (one per `virtualize` call).
- `archiveSuccessCount` / `archiveFailureCount` — outcomes of those attempts.
- `archiveDeduplicatedCount` — attempts where the artifact already existed.
- `archiveDurationMsTotal` — total wall time of `ArtifactStore.archive` calls
  (successes and failures).
- `metadataReadDurationMsTotal` / `metadataWriteDurationMsTotal` — total wall
  time spent reading and rewriting `observations.jsonl` inside `archive`.
- Reduction fields — accumulate the `ReductionResult` values:
  `reductionInvocationCount` increments on every `reduceContext` call;
  `reductionTriggeredCount` when `triggered`; `reducedObservationCount` adds
  `reducedCount`; `estimatedTokensBeforeTotal` / `estimatedTokensAfterTotal` add
  the estimates; `targetReachedCount` when `targetReached`;
  `reductionDurationMsTotal` adds the call duration.

### Wiring

- `RuntimeState` gains a `telemetry: Telemetry` instance created at extension
  registration (per `session_start` lifecycle; discarded by `dispose` like the
  rest of the state).
- `ArtifactStoreOptions`, `ObservationRuntimeOptions`, and
  `RepoMapRuntimeOptions` each gain an optional `telemetry?: Telemetry`. When
  absent, the components behave exactly as today (no-op).
- `ObservationRuntime.virtualize` records archive attempts/outcomes/durations.
- `ArtifactStore.archive` records metadata read/write durations around
  `#readMetadataUnlocked()` and the metadata `atomicWriteFile`.
- `RepoMapRuntime` records query counts/durations, `ensureFresh`
  counts/durations, search-index builds, `filesReindexed`, generation creation
  and bytes, and maintenance failures.
- The `context` hook records capsule builds (bytes, index, hash change),
  automatic queries, and reduction results/durations.
- `runtimeStatus()` includes `telemetry: runtime.telemetry.snapshot()`.

### Status exposure

`context_vault_status` and `/context-vault status` include the telemetry summary
as a plain object of numbers. `doctor` output inherits it via `runtimeStatus()`.

### Boundedness and privacy

- All metrics are JS numbers; there are no arrays, logs, or per-request
  records. `snapshot()` returns a fresh copy so callers can never mutate the
  live counters.
- No raw user text, tool output, source code, secrets, message hashes, or
  payload content is recorded. The only string-like state is the internal
  last capsule content hash used to detect change; it is never exposed.

### Failure behavior

- Telemetry recording is best-effort: record methods are plain arithmetic that
  cannot throw; telemetry is optional in every component so a missing instance
  is a no-op. No telemetry path may call `#degrade`, throw into the agent loop,
  or flip `degraded`.
- `snapshot()` must never throw (no recursion, no I/O).

### Backward compatibility

- All new options are optional; existing constructors and configs keep working.
- `debugRequestFingerprints` is added to `ContextVaultConfig` with default
  `false` and boolean validation; it has no behavioral effect in this Spec.
- Status gains a new `telemetry` field (additive); existing fields and shapes
  are unchanged.
- Model-visible messages, archiving decisions, query results, and persisted
  state are byte-for-byte unchanged.

### State transitions

- Telemetry counters reset on `session_start` (new `Telemetry` instance).
- Counter lifetimes follow the session: monotonic within a session, discarded
  on shutdown/restart.
- No persistence of telemetry anywhere.

## Acceptance criteria

1. With default config, the `context` hook returns exactly the same message
   structure (capsule content/position, reduction behavior) as before
   telemetry, and the capsule/automatic-query/reduction counters increase by
   the expected amounts.
2. `tool_result` replacement behavior is unchanged; archive counters increase
   correctly (attempt/success/failure/dedup/duration).
3. `RepoMapRuntime.query` returns identical results; query/ensureFresh/search-
   index counters increase.
4. `runtimeStatus().telemetry` is a copy: mutating the returned object does not
   change later snapshots.
5. All telemetry fields are finite numbers (bounded, no arrays).
6. Telemetry failures or anomalies never set `degraded` and never throw into
   the hook chain.
7. Status output contains no raw tool output or message content.
8. `debugRequestFingerprints` accepts only booleans and defaults to `false`.
9. Full CI (`npm run check`, `npm test`, `npm run test:package`) passes.

## Test cases

In `tests/extension.test.ts`:

1. `telemetry: context hook message structure is unchanged and capsule counters
   increase` — mock runtime; one same-turn build + reuse; assert capsule
   placement/content identical to the pre-telemetry expectations,
   `capsuleBuildCount === 1`, `repoMapAutomaticQueryCount === 1` after build and
   unchanged after reuse.
2. `telemetry: capsule hash change increments across user turns` — two prompts;
   `capsuleHashChangeCount === 1`.
3. `telemetry: reduction counters accumulate` — small context (no trigger) then
   a large context (trigger); assert invocation/triggered/token totals/target/
   duration fields.
4. `telemetry: status snapshot is a copy, bounded, and free of raw content` —
   mutate returned telemetry, re-read status, counters unchanged; all fields
   finite numbers; status JSON does not contain a sample tool-output marker.
5. `telemetry: degraded state is unaffected` — status with telemetry present is
   not degraded when components are healthy.

In `tests/observation-virtualization.test.ts`:

6. `telemetry: archive counters track attempts and outcomes without changing
   replacement` — small text (no replacement, attempt/success 1), large text
   (replacement present, attempt/success 2), duplicate content (dedup 1),
   failure path (invalid store) increments `archiveFailureCount`.

In `tests/artifact-store.test.ts`:

7. `telemetry: metadata read/write timers accumulate` — archive twice; both
   totals ≥ 0, finite, and monotonically increasing.

In `tests/repo-map-runtime.test.ts`:

8. `telemetry: query, ensureFresh, search index, and generation counters` —
   start runtime, query → `repoMapQueryCount === 1`, `ensureFreshCount ≥ 1`,
   `searchIndexBuildCount ≥ 1`; flush with a change → `generationCreatedCount`
   and `generationBytesWritten > 0`, `repoMapTotalBytes` grows; notify a file
   change → `filesReindexed ≥ 1`.
