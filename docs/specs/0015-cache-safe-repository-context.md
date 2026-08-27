# Specification 0015: Cache-safe repository context

Status: S00 specification and S01a implemented behavior for GitHub issue #39.

This specification records the staged v0.3 direction without claiming a v0.3 release. Only S00 and S01a are implemented by this slice. Every S02+ contract below is future work.

## Implementation baseline

Issue #39 started from branch `main`; local `main` and `origin/main` were both at `2420c8378626ec1121626b1eb00b69793dd6541d`. The package version was `0.2.0`, with Node `v24.11.1` and npm `11.6.2`. The initial working tree contained only the two pre-existing untracked user files under `docs/reports/`; they are not part of this specification and were not used as normative inputs.

The baseline commands `npm ci`, `npm run check`, `npm test`, `npm run test:package`, `npm run test:watcher`, and `npm run test:coverage` all exited with status 0. The baseline full suite was 23 files / 297 tests, and the watcher suite was 1 file / 3 tests. Baseline V8 coverage was 89.53% statements, 83.8% branches, 93.14% functions, and 92.64% lines.

At this implementation baseline and throughout S01a, the effective default is `"once-per-user-turn"`. Its automatic path is `before_agent_start` → `ensureFresh`, followed by `context` → `queryCurrent` (or the backward-compatible `query` fallback for injected controllers without `queryCurrent`). The explicit `context_vault_repo_map` tool follows `query` → `ensureFresh`, so it remains the live query path. Explicit `"off"` changes only the automatic path as specified below.

The default automatic-capsule hard budget is 6144 bytes. Actual capsule size depends on the query and captured repository state; no single representative byte value is asserted. Tests enforce a size of at most 6144 bytes under the default budget and exercise the valid minimal form under a configured 512-byte budget.

Relevant session-local telemetry fields include `repoMapAutomaticQueryCount`, `capsuleBuildCount`, `capsuleBytes`, `capsuleHashChangeCount`, `capsuleInsertionIndex`, `repoMapQueryCount`, `repoMapQueryDurationMsTotal`, `ensureFreshCount`, `ensureFreshDurationMsTotal`, `searchIndexBuildCount`, and `searchIndexBuildDurationMsTotal`. They attribute extension/runtime attempts, totals, or last values: for example, the automatic counter is distinct from general Repo Map queries, while capsule bytes and insertion index are last-value scalars. They are not per-provider request traces and cannot attribute provider cache admission, token billing, latency, quality, or causality.

## Problem and current behavior

Context Vault has several distinct caches and freshness boundaries. Treating all of them as a single “prompt cache” obscures correctness and can overstate what local telemetry proves. Automatic Repo Map injection also needs an explicit tool-only mode that is transparent to the model message list while leaving repository indexing and Observation reduction independent.

The implemented S01a behavior is:

- `DEFAULT_CONFIG.mapInjectionMode` remains `"once-per-user-turn"`. Existing configurations that omit the key therefore retain one automatic turn-start capsule by default.
- `"once-per-user-turn"` refreshes in `before_agent_start`, builds at most one automatic capsule from the current coherent map snapshot, inserts it after the latest user message, and reuses the complete frozen custom message byte-for-byte for later LLM calls in the turn.
- `"every-llm-call"` preserves the compatibility path: each context hook queries/renders a new context-call snapshot and places it at index 0.
- Explicit `"off"` is tool-only for automatic injection. The Repo Map runtime still starts, builds, watches, maintains generations, and serves `context_vault_repo_map` when `repoMapEnabled` is true and the runtime is available. The explicit tool continues to use the live `query` path.
- In `"off"`, `before_agent_start` still advances `turnSequence` and clears any frozen capsule, but it skips automatic `ensureFresh`. The context hook performs no Repo Map query, build, render, insertion, deletion, replacement, or movement of map capsules.
- Old map capsules are managed only while automatic injection is enabled and the Repo Map is currently available. When `repoMapEnabled` is false, initialization is unavailable, startup fails, or a failed rebuild marks the runtime unavailable, inbound messages remain Repo Map-transparent.
- Observation archival and context reduction remain separate controls. Reduction may still return a changed model view in `"off"`; such a change is not Repo Map capsule management.
- Query failures while an otherwise available automatic path is active retain the existing honest bounded stale-capsule fallback. Watcher, generation, freshness, fallback-evidence, and retention semantics are unchanged.

## Cache taxonomy

These mechanisms have different identities and proof obligations:

1. **Frozen automatic capsule** — an extension-memory reuse record keyed by `turnSequence`. It avoids repeat automatic queries/renders within one user turn and preserves the complete custom message object.
2. **Repository search cache** — `RepoMapRuntime` reuses a `RepoMapSearch` while its effective ordered file-content version is unchanged. It is invalidated by searchable-content changes, not by every generation or warning change.
3. **Dirty-file outcome cache** — stable filesystem fingerprints can reuse path indexing outcomes during reconciliation. Watcher events and admission changes retain their conservative invalidation rules.
4. **Durable map generations** — revisioned snapshots and the active pointer provide coherent persisted state and bounded retention; they are not a provider prompt cache.
5. **Provider prompt/prefix cache** — provider-owned behavior outside this repository. Byte-identical local capsule reuse is a necessary observable input property, not proof of a provider cache hit, lower token billing, or latency improvement.
6. **Future Graph, Planner/Renderer, and Projection Cache** — S02+ concepts only. No such cache, cache key, graph, planner, renderer, or eviction policy is implemented in S01a.

## Staged rollout

| Stage | Contract | Implementation status |
| --- | --- | --- |
| S00 | Specify taxonomy, compatibility, proof limits, migration, and staged activation. | Implemented by this document. |
| S01a | Add effective injection-mode handling and strict transparent `off` semantics while retaining the public once-per-user-turn default. | Implemented. |
| S02 | Repository Graph contract and implementation. | **Future; not implemented.** |
| S03 | Planner/Renderer and Projection Cache, including bounded keys/eviction. | **Future; not implemented.** |
| S04 | New explicit `repo_context`-style tool contract and implementation. | **Future; not implemented.** |
| S05 | Evaluation, including approved provider-facing cache/quality measurements. | **Future; not implemented.** |
| S06 | Change the public default to `"off"` only after Graph, Planner/Renderer, explicit Tool, and evaluation gates are complete and reviewed. | **Future; not implemented.** |

S06 is not implied by this specification’s presence. Until that later activation lands, documentation, code, and config defaults must continue to say `"once-per-user-turn"`.

## Normative amendments to accepted specifications

Where the following accepted specifications conflict with this document, these amendments are authoritative for S01a.

### Amendment to Specification 0002

The `"off"` mode is stronger than “do not inject.” It is Repo Map-transparent: the context hook must not remove a pre-existing `context-vault-repo-map` message or otherwise rewrite messages because of Repo Map. Its earlier statement that `before_agent_start` is unchanged is amended: automatic turn-start `ensureFresh` is skipped in explicit `"off"`. The explicit tool remains available when the map component is enabled and available.

### Amendment to Specification 0004

`before_agent_start` still unconditionally increments `turnSequence` and clears `mapCapsule`. Its subsequent freshness call is conditional on the effective injection mode not being `"off"` and on the runtime being available. The effective mode is the loaded value or `DEFAULT_CONFIG.mapInjectionMode`; no separate string fallback is permitted.

### Amendment to Specification 0007

The automatic freshness/queryCurrent sequence applies only when automatic injection is enabled. Explicit `"off"` skips turn-start `ensureFresh` and performs no automatic `queryCurrent`/`query`, while `context_vault_repo_map` continues to call live `query`, which performs its own freshness reconciliation. Search-index and dirty-outcome cache behavior is otherwise unchanged.

### Amendment to Specification 0009

The capture-time schema and snapshot descriptions remain unchanged for enabled automatic modes. In `"off"`, no automatic snapshot exists and inbound old capsules are not interpreted, refreshed, deleted, or moved. Unavailable runtime paths have the same message transparency. An available automatic path may still render the specified bounded honest stale snapshot when a query itself fails.

## Compatibility and migration

- No config migration is required. Omitted `mapInjectionMode` still resolves to `"once-per-user-turn"` in S01a.
- Users wanting the legacy cadence can continue to select `"every-llm-call"`.
- Users wanting tool-only repository context can set `"mapInjectionMode": "off"`. This does not disable map construction, watching, maintenance, or the explicit tool. Set `"repoMapEnabled": false` to disable the entire Repo Map component.
- `reductionEnabled` and `archivePolicy` remain independent. Choosing tool-only map behavior does not disable Observation reduction or archival.
- Tool names and schemas, automatic capsule schema, custom type, state layout, generation formats, watcher behavior, freshness values, fallback evidence, and telemetry field names do not change in S01a.
- A future S06 default change will require separate release notes and migration guidance; it is not part of this slice.

## Telemetry and proof limits

Existing counters can demonstrate extension-local events such as automatic query count, capsule build count, insertion index, byte size, hash changes, freshness reconciliation, search-index builds, and reduction invocations. Tests can prove that a frozen message is byte-identical and that `"off"` avoids automatic work.

Those counters cannot prove provider prompt-cache admission, cache-hit ratio, cache isolation, token or billing reduction, end-to-end latency improvement, quality parity, or causality. Synthetic/fake-provider runs and the local ablation harness are not provider benchmark evidence. No Graph, Planner, Projection Cache, or provider-cache improvement is claimed by S01a.

## Required tests

S01a is covered by tests that establish:

1. the omitted/public default remains once per user turn;
2. explicit once-per-user-turn compatibility and byte-identical within-turn reuse;
3. explicit every-LLM-call compatibility;
4. explicit `"off"` leaves an inbound capsule untouched and performs no automatic query/render/insertion/removal/movement;
5. `"off"` skips turn-start `ensureFresh`;
6. `"off"` does not prevent Observation reduction;
7. the explicit Repo Map tool still calls live `query` in `"off"`;
8. `repoMapEnabled: false` does not manage inbound capsules; and
9. unavailable/degraded runtime paths do not manage inbound capsules.

The full type/lint, unit, package, watcher, and coverage suites remain required. Tests whose purpose is once-per-turn freeze/placement compatibility configure `mapInjectionMode` explicitly; a dedicated test alone pins the omitted default.

## Future contracts (S02+) — not implemented

Future work may define a repository Graph, task-aware Planner, bounded Renderer, Projection Cache, and a new explicit repository-context tool. Those specifications must define provenance, cache identity, invalidation, bounds, freshness axes, fallback behavior, telemetry, and migrations before implementation. Evaluation must include quality and safety gates as well as any approved provider-cache study. Only after all of those prerequisites may S06 propose activating default `"off"`.

## Non-goals

S01a does not implement a Graph, Planner, Renderer, Projection Cache, `repo_context` tool, provider benchmark, multi-axis freshness model, cache LRU, or default-off activation. It does not change dependencies, package version, watcher/runtime algorithms, generation/fallback semantics, the explicit tool result schema, Observation policies, or provider behavior.
