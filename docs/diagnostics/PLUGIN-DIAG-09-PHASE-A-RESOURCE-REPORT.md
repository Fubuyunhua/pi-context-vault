# Phase A deterministic resource report

Date: 2026-08-30  
Model calls: 0

## Method

All measurements use generated local fixtures and direct plugin/runtime APIs. Network access is not required. CPU/RSS numbers are single-run diagnostics, not stable cross-machine benchmarks.

Two timed-out Windows Bun children were discovered after the first 1MB Vault attempt. They were terminated and all resource tables below were rerun in a clean process environment. Peak RSS is process `maxRSS`; steady values are sampled after forced Bun GC. Baselines include the loaded Bun/Pi framework.

## Plugin startup and dual-install surface

Git fixture: 1,000 TypeScript files, fresh process and agentDir per arm.

| Arm | Bind/session startup | First repo search | First results | Peak RSS | Post-shutdown RSS | Heap | State | Tools |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| NONE | 46ms | — | — | 201MB | 192MB | 19MB | ~0 | 0 |
| VAULT | 215ms | — | — | 204MB | 200MB | 21MB | ~0 | 3 |
| REPO | 61ms | 2.35s | 10, ready | 357MB | 327MB | 54MB | 0.44MB | 3 |
| BOTH | 220ms | 2.30s | 10, ready | 358MB | 327MB | 55MB | 0.44MB | 6 |

No duplicate tool names occurred. BOTH exposed exactly the three Vault and three Repo tools. The 1,000-file Repo index completed within the first-search warmup interval, so the first result was indexed/ready rather than warming fallback.

The Repo process retains a high native RSS watermark after shutdown, while post-GC JS heap is much lower. This is observable resource cost, but this single-run fixture does not establish a leak.

## Repo Context scale

Synthetic non-Git TypeScript workspaces:

| Files | Cold start | Warm start | Warm query | 1-file update/query | 100-file update/first query | State | Peak RSS |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 304ms | 263ms | 70ms | 146ms | 405ms | 0.19MB | 210MB |
| 1,000 | 542ms | 570ms | 162ms | 249ms | 894ms | 1.43MB | 347MB |
| 5,000 | 1.87s | 2.23s | 647ms | 852ms | 1.92s | 7.01MB | 903MB |

Cold/warm/exact 1-file queries returned the expected file at every scale. Non-Git warm startup must still verify the workspace and was not faster at 1,000/5,000 files. A separate Git plugin-repo fixture improved from 861ms cold to 336ms warm.

### Stale incremental defect

At 5,000 files, the first query after a 100-file burst stopped with 33 pending files:

```text
query:       BATCH_MARKER_99
first top:   file-00019.ts / BATCH_MARKER_19
fallback:    unrelated file-00000.ts
retry top:   file-00099.ts / BATCH_MARKER_99
```

The bounded reconciliation behavior is intentional, but the live fallback does not search pending non-Git paths. Tracked as Repo Context #17.

The 903MB peak includes native allocator high-water behavior during successive immutable generations; final post-GC heap was about 346MB. This warrants continued measurement after #17 but is not filed as a separate defect yet.

## Context Vault search scale

Each archived Observation contains roughly 1KB of unique text.

| Observations | Sequential archive | Per archive | Search miss | Oldest hit | Newest hit | State | Peak RSS |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 3.31s | 33.1ms | 34ms | 18ms | 16ms | 0.41MB | 80MB |
| 1,000 | 31.72s | 31.7ms | 63ms | 30ms | 28ms | 4.10MB | 113MB |
| 5,000 | 166.68s | 33.3ms | 144ms | 56ms | 49ms | 20.50MB | 238MB |

All oldest/newest searches returned one result. Search payloads were roughly 1.4KB; misses were roughly 231 bytes. Search remains bounded and substantially cheaper than archive creation at these sizes.

## Vault archive, deduplication, redaction, and reduction

Clean 1KB–64KB results:

| Unique payload | Archive time | Receipt | State growth |
|---:|---:|---:|---:|
| 1KB | 52ms | 512B | 1.5KB |
| 16KB | 311ms | 512B | 16.9KB |
| 64KB | 4.19s | 512B | 66.0KB |

Two identical 64KB archives shared the same artifact ID. The first grew state by 66.0KB and the duplicate by only 487 bytes. Both still spent about 4.2s in preprocessing, so deduplication saves disk but not redaction/hash latency.

Secret persistence check:

```text
redactionCount:          1
persisted secret:        false
non-secret marker kept:  true
```

Reduction fixture: 12 raw 64KB paired results, 100K context window, two hot results:

```text
triggered:       true
reduced:         10
estimated before: 263,966 tokens
estimated after:   47,336 tokens
target reached: true
reduction time: 25ms
```

### 1MB archive blocker

The planned 1MB gate could not complete because no-match secret redaction is quadratic on long lines. Clean direct timings:

| Single-line bytes | Redaction time |
|---:|---:|
| 16KB | 244ms |
| 64KB | 4.02s |
| 128KB | 16.40s |
| 256KB | 65.75s |
| 256KB split into 1KB lines | 280ms |

A 1MB archive exceeded both 300s and 600s attempts. Tracked as Context Vault #70. The 1MB/duplicate Phase A gate remains blocked until this is fixed.

## Search→get handoff follow-up

A strengthened pressure gate placed the contract beyond the 4KB receipt preview. Initially, search found the deep marker but its returned `{id}` action fetched bytes 0–8192 and missed the evidence. Context Vault #69 fixed this on main `357274d` by adding a match-centered offset.

Post-fix deterministic verification:

```text
nextAction offset:       14,605
get byte range:          14,605–18,761
get contains marker:     true
receipt contains marker: false
pressure v2 gate:        accepted
```

The v2 preflight now has zero contract occurrences in Vault session receipts and the exact returned search action retrieves the contract. No model runs were added.

POSTFIX-02 v1 interpretation remains narrower: v1 demonstrates the Vault treatment, but not retrieval-only necessity because one contract occurrence remained in its receipt preview.

## Current status

Passed:

- 100/1,000/5,000 Repo cold/warm/1-file scale;
- Repo/BOTH first-search startup and exact tool surface;
- 100/1,000/5,000 Vault archive/search scale;
- Vault redaction correctness, 64KB deduplication, and context reduction;
- dual shutdown without duplicate tools or process hang after explicit lifecycle shutdown;
- retrieval-required pressure v2 and exact deep search→get handoff after Context Vault #69.

Open deterministic defects:

- Context Vault #70: quadratic long-line secret redaction;
- Repo Context #17: first stale incremental search misses exact pending-file evidence.

Remaining gates:

- rerun 1MB unique/duplicate Vault archive after #70;
- rerun 5,000-file/100-change first query after #17;
- add a separate forced-crash/restart state recovery test.
