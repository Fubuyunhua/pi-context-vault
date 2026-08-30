# Deterministic comparison 03

Date: 2026-08-31  
Model calls: 0

## Scope

Latest accepted Context Vault source includes #69/#70. Repo Context includes both attempted #17 fixes through `cd711f6`; #17 is reopened because its two external acceptance gates still fail.

Tests cover startup, active tools, concurrent archives/searches, multi-process state sharing, repeated incremental churn, default-scheduler stale pending behavior, crash recovery, disk state, RSS, and full/focused project suites.

## Five-repeat startup comparison

Fixture: fresh Git repository with 1,000 TypeScript files; separate process and agentDir for every repeat.

| Arm | Startup median / max | First repo search median / max | Peak RSS median | Post-shutdown RSS median | Heap median | State median | Active tools |
|---|---:|---:|---:|---:|---:|---:|---:|
| NONE | 46.5 / 47.9ms | — | 197.7MB | 183.7MB | 19.4MB | ~0 | 4 |
| VAULT | 199.9 / 211.4ms | — | 199.1MB | 193.8MB | 21.0MB | ~0 | 7 |
| REPO | 56.3 / 62.1ms | 2.409 / 2.441s | 352.5MB | 323.0MB | 53.8MB | 0.44MB | 6 |
| BOTH | 216.2 / 224.7ms | 2.474 / 2.503s | 355.2MB | 331.3MB | 55.3MB | 0.44MB | 9 |

All 20 startup runs returned the expected behavior. Median startup CPU was 47ms NONE, 204ms VAULT, 109ms REPO, and 265ms BOTH. Median first-search CPU was about 4.05s REPO and 4.00s BOTH (CPU exceeds wall because indexing uses concurrent work). Repo remains lazy at startup; most of its cost is paid on first search. BOTH approximately combines Vault bind overhead with Repo first-search/RSS cost.

The deprecated `context_vault_repo_map` alias is registered for compatibility but inactive. Active tool counts are exactly native 4 + Vault 3 + Repo 2; there are no active duplicate names.

## Context Vault

### Project suite and payload gate

```text
focused redaction/artifact: 39/39
full CI:                    223 passed, 1 skipped
package smoke:              pass
1MB unique archive:         477ms
1MB repeated duplicate:      25ms
```

### In-process concurrency

64 unique + 16 duplicate archives issued concurrently:

```text
metadata:               80/80
unique Observation IDs: 80
shared duplicate artifact IDs: 1
duplicate occurrence count:   16
sample searches:         4/4
status degraded:         false
```

### Multi-process concurrency

Four processes archived 20 Observations each into the same state root:

```text
workers:                 4/4 exit 0
metadata:                80/80
unique Observation IDs: 80
cross-process searches:  4/4
wall time:               4.74s
```

No lost metadata, corrupt log, duplicate Observation ID, or search miss was observed.

## Repo Context

### Project suite isolation

On `cd711f6`:

```text
typecheck / Biome: pass
all tests except issue-17 Windows gate: 361 passed, 1 skipped
package smoke: pass
cold-first-search surrogate: 6/6 non-empty
```

The shipped `npm run test:issue-17` still fails on Windows because its injected deadline uses a POSIX-only path predicate.

### Repeated incremental churn

1,000-file non-Git fixture, 10 cycles × 20 changed files:

```text
exact first-query result: 10/10
pending after query:      0 in every cycle
generation files retained: 3
state:                    1.30MB
heap last/first ratio:    0.77
```

All 200 changed files were reindexed. Generation retention stayed bounded and no monotonic heap growth was observed.

### Multi-process shared state

Four simultaneous cold processes shared one state root:

```text
workers:          4/4 exit 0
correct top file: 4/4
freshness:        fresh
final verifier:   correct, fresh, no pending/dirty/error
wall time:        3.90s
```

Locking and generation activation remained coherent.

### Unresolved default-scheduler burst

5,000-file non-Git fixture, 100 changed files, exact query targets the final pending file:

```text
first top:        file-00019.ts
expected:         file-00099.ts
pending:          33
fallback evidence: empty
lexical attempts:  0
identical retry:  file-00099.ts
```

This persists after `e086f39` and `cd711f6`. Repo #17 has been reopened for the second time with raw evidence. The current fix works under its normalized manual-scheduler test but does not reach the real default-scheduler retirement race.

## BOTH

Concurrent BOTH test issued 32 Vault archives while Repo performed a 1,000-file first search:

```text
Vault replacements:   32/32
Repo lifecycle:       ready
Repo results:         10
Repo top:             file-0999.ts
Vault marker search:  1 result
active/registered conflict: none
combined state:       1.06MB
wall time:            3.85s
```

Forced crash/restart also remains accepted: archived Vault evidence was recovered, Repo returned correct warming fallback, Vault was not degraded, and all six extension tools remained unique.

## Comparison conclusions

1. Vault's corrected redaction removes the previous large-payload blocker and preserves concurrency/dedup integrity.
2. Repo's normal 20-file churn and multi-process locking are healthy; its resource cost is primarily first-search CPU/RSS.
3. BOTH shows additive startup/resource behavior without tool or state collision.
4. Repo's large default-scheduler stale-pending burst remains a correctness gap despite two attempted fixes. It is the only open deterministic product gate in this round.
5. No new model experiment should start while #17 remains unresolved; all comparisons in this report are deterministic and zero-model.
