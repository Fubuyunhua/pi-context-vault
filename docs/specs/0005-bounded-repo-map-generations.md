# Spec 0005: Bounded repository-map generations

## Status

Accepted for implementation by GitHub issue #26.

## Problem

A repository-map activation currently writes a pretty-printed full snapshot to a new file. Repeated equivalent activations and the absence of generation cleanup allow map state to grow without a bound. Artifact garbage collection does not address this state.

## Configuration

Context Vault adds two project options:

- `mapGenerationRetention`: positive safe integer, default `3`. It is the maximum number of generation files retained when the quota permits.
- `mapQuotaBytes`: positive safe integer, default `134217728` (128 MiB). It bounds generation-file bytes. The active generation is exempt from deletion, so this can be an unsatisfied soft bound.

Unknown-option handling and the existing project configuration merge rules remain unchanged.

## Activation and semantic no-ops

Generation JSON is encoded as compact JSON with only an optional final newline. Activation is serialized by `activation.lock`, shared by every runtime using the same map state root.

Under that lock, a candidate is compared with the currently active durable generation. The comparison includes every durable or model-visible field (`schemaVersion`, Git head, dirty-file hashes, workspace revision, freshness, pending files, and snapshot), but excludes the generation number, activation timestamp, and snapshot `provenance.generatedAt`. The provenance timestamp records when an equivalent in-memory snapshot was assembled and is intentionally nondurable; freshness and revision fields carry the model-visible state. If these semantic fields are equal, no generation or pointer is written and generation telemetry is not incremented. The runtime adopts the durable active generation number.

For a changed candidate, the generation file is written first and `active.json` is atomically replaced second. A pointer-write failure therefore leaves the previous active generation readable. Generation-created telemetry is recorded only after the pointer update succeeds.

## Maintenance

Maintenance acquires the same `activation.lock` as activation. It reads and validates the active pointer before deleting anything and never deletes the active generation.

After each successful pointer update, and when explicitly requested, maintenance:

1. loads and validates the referenced active generation before deleting anything;
2. defers every numeric generation newer than the active pointer because it may belong to an activation whose pointer update has not yet become visible;
3. removes oldest generations below the active generation until at most `mapGenerationRetention` files remain or no safely removable generation remains;
4. removes additional oldest generations below the active generation until total generation-file bytes are at most `mapQuotaBytes` or no safely removable generation remains.

Files that are temporary, non-numeric, or outside the generation directory are ignored. The active generation and all newer generations are protected, so the quota can remain unsatisfied. A later successful activation advances the pointer beyond abandoned candidates and may then prune them as older generations. Cleanup executes only after a valid active generation has been loaded, preserving crash consistency. Cleanup failures update runtime maintenance status and maintenance-failure telemetry but remain non-fatal to the readable active map on both changed and semantic-no-op activation paths.

The maintenance result reports the active generation, deleted generation numbers, bytes freed, remaining generation count and bytes, and whether quota is satisfied. Runtime status exposes the latest result. `/context-vault gc` runs artifact GC and repository-map maintenance and reports both results.

## Concurrency and telemetry

Generation allocation, semantic comparison, pointer replacement, and pruning occur under one filesystem lock. Allocation considers all numeric generation filenames as well as the active and local generation numbers, preventing concurrent runtimes from overwriting an orphan. Runtimes sharing `stateRoot` therefore converge on a single active pointer without deleting one another's active data. Pruning also skips every generation whose number is greater than or equal to the active generation, so an in-progress generation written before its pointer update is not deleted.

The existing `withFileLock` stale-lock recovery remains unchanged and has a known time-of-check/time-of-use race between inspecting a stale lock and unlinking it: concurrent recovery can unlink a replacement owner's lock. Issue #26 does not claim to fix that pre-existing race; a separate follow-up must track and redesign stale recovery without coupling it to generation retention.

Existing generation counts and bytes-written metrics count only successful activations. This change does not add pruning counters; maintenance results provide exact per-operation cleanup evidence without introducing ambiguous running byte estimates.

## Regression coverage

Tests cover configuration defaults/validation, semantic no-op events (including the nondurable provenance timestamp), compact JSON, retention, quota and active preservation, corrupt-active fail-closed behavior, deferred newer-generation cleanup, shared-state concurrency, maintenance status and failures, and command-level artifact-plus-map GC integration.
