# Spec 0010: Hot-path telemetry

## Status

Accepted for implementation by GitHub issue #34.

## Problem

The runtime telemetry baseline cannot attribute repository-map time to Git
subprocesses, MiniSearch construction, generation activation, or generation
pruning. Its repository-map byte total also starts at zero each session rather
than reflecting generations already on disk.

## Metrics

All fields are bounded, process-local numeric scalars. Existing fields retain
their meanings and the following fields are additive:

| Operation | Attempt count | Total duration |
|---|---|---|
| Git `rev-parse HEAD` | `gitHeadCount` | `gitHeadDurationMsTotal` |
| Git dirty/status | `gitDirtyCount` | `gitDirtyDurationMsTotal` |
| Git diff fallback | `gitDiffCount` | `gitDiffDurationMsTotal` |
| MiniSearch construction | existing `searchIndexBuildCount` | `searchIndexBuildDurationMsTotal` |
| Generation file and active-pointer write | `generationWriteCount` | `generationWriteDurationMsTotal` |
| Generation pruning | `generationPruneCount` | `generationPruneDurationMsTotal` |

Pruning also accumulates `generationPrunedFiles` and
`generationPrunedBytes`. `generationCreatedCount` counts generation files whose
active pointers were successfully persisted. `generationBytesWritten` counts
bytes for every successfully persisted generation file, including a file left
orphaned when its subsequent active-pointer write fails. The existing
`recordGenerationCreated(bytes)` method remains as a backward-compatible
combined file-write-and-activation recorder; runtime wiring records the two
success points separately. A semantic no-op performs no generation write and
therefore does not increment generation-write or generation-created metrics.

Each operation count increments exactly once per attempt. Its duration is
recorded in a `finally` path, including when the subprocess, constructor, write,
or prune fails. Successful operations do not receive a second outcome count.
Every initial and final injected monotonic-clock read is guarded: a throwing or
invalid clock cannot affect the operation, and the attempt is still counted
with a safe zero duration. Invalid duration or byte inputs are normalized to
finite nonnegative values.

## Repository-map bytes

At startup, telemetry seeds `repoMapTotalBytes` by listing and statting only the
flat `generations` directory. A successful generation-file persistence
immediately adds its bytes, before active-pointer persistence is attempted, so
an activation failure leaves the total equal to the active files plus orphan on
disk. Maintenance reconciles the same total from the already-required flat
generation listing before pruning. Each successfully removed generation
decrements the running total and increments the pruning file and byte totals.
No recursive filesystem traversal is introduced, and no per-generation
telemetry records are retained.

The startup seed is best-effort. A telemetry-only listing or recording failure
must not prevent repository-map startup. Maintenance keeps its existing
failure and crash-consistency behavior.

## Privacy and boundedness

Telemetry stores only counts, cumulative durations, cumulative byte/file
amounts, and the current byte total. It stores no queries, paths, Git output,
source text, user text, tool text, arrays, or per-request/per-operation records.
`snapshot()` returns a fresh plain object of finite numbers.

## Behavioral compatibility

Telemetry remains optional. Recording is guarded so a missing or throwing
telemetry dependency cannot alter freshness, degradation, persisted state,
query results, fallback evidence, or any other model-visible output. Existing
status fields and telemetry fields are unchanged; the new fields are additive.
Generation allocation, activation, retention, and quota decisions remain those
of Spec 0005.

## Verification

Tests use injected monotonic clocks and Git/search/write dependencies to cover
successful and failed attempts deterministically, including clocks that throw
on every read. Regression coverage also checks activation-failure orphan bytes,
later prune reconciliation, concurrent runtimes sharing one state root and
telemetry accumulator, startup seeding, snapshot copying and boundedness,
privacy, and byte-identical query output with telemetry absent versus failing.
