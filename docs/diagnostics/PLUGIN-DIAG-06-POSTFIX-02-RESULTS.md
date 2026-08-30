# POSTFIX-02 results

Date: 2026-08-30  
Model: `openai-codex/gpt-5.6-sol`, thinking medium  
Runs: 24 evaluable; no model judge

## Integrity

- Fixed before execution: 3 tasks × 2 repeats × 4 arms.
- All tasks passed network-disabled base-fail/gold-pass preflight.
- All recorded F2P/P2P checks matched; unmatched IDs: 0.
- One pre-result `unknown certificate verification error` was replaced and excluded.
- No ordinary task failure was retried.
- Fresh agentDir per run.

## Primary outcomes

| Task stratum | NONE | VAULT | REPO | BOTH |
|---|---:|---:|---:|---:|
| Neutral/local | 2/2 | 2/2 | 2/2 | 2/2 |
| Repository navigation | 0/2 | 0/2 | 0/2 | 0/2 |
| Context pressure | 0/2 | 2/2 | 0/2 | 2/2 |
| **Total** | **2/6** | **4/6** | **2/6** | **4/6** |

The aggregate difference is entirely from the preregistered context-pressure stratum. The navigation task was too difficult to distinguish arms even though Repo Context returned relevant paths.

## Context-pressure mechanism

Each run received 12 paired synthetic tool results before the user task:

- original evidence: 786,432 bytes;
- authoritative contract only in the oldest chunk;
- complete hidden-test command fixed before model calls.

| Arm | Model-visible prelude | Pass | Avg wall | Avg total tokens | Obs search/get |
|---|---:|---:|---:|---:|---:|
| NONE | 768KB raw | 0/2 | 170s | 226k | 0/0 |
| VAULT | 48KB receipts | 2/2 | 92s | 41k | 2/2 |
| REPO | 768KB raw | 0/2 | 227s | 102k | 0/0 |
| BOTH | 48KB receipts | 2/2 | 36s | 54k | 2/2 |

Every arm edited the intended `pressurelib/parser.py`. VAULT and BOTH searched and fetched the archived contract in both repeats and passed all hidden tests. NONE and REPO retained the raw prelude, guessed status-counting APIs, and failed the exact contract tests.

Relative to NONE in this stratum:

- VAULT reduced average total tokens about 82% and wall time about 46%;
- BOTH reduced average total tokens about 76% and wall time about 79%.

No Pi compaction occurred. The measured mechanism is immediate Observation archival/receipt virtualization plus explicit search→get, not automatic compaction.

This is strong treatment-specific evidence but only two independent repeats; it is not a general SWE-bench effect estimate.

### Post-run integrity caveat

A deeper replay found one occurrence of the contract still present in the first Vault receipt preview. Therefore the 4/4 search→get sequence was real, but this v1 task does **not** establish that get was strictly necessary to see the contract. The supported interpretation is the joint effect of receipt virtualization and the observed retrieval behavior, not retrieval-only causality.

A zero-model v2 gate moved the contract beyond the receipt preview. That gate exposed a separate deterministic handoff problem: search finds the deep contract, but executing its returned `{id}` next action fetches only bytes 0–8192 and misses the matched evidence. An explicit query-targeted get succeeds. This was tracked as Context Vault #69 and fixed on main `357274d`; the post-fix zero-model v2 gate passes with a match-centered get offset. No post-hoc model runs were added.

## Repo Context behavior

Across all repo-only/both runs:

```text
repo_context_search calls: 14
non-empty:                  14
warming with useful fallback: 4
```

This directly improves on the pre-fix 12/12 warming-empty result. In the repository-navigation task all four Repo/Both searches were `ready` with 10 results:

- repo-only ranked the relevant test at #1 and implementation at #2;
- both ranked `sphinx/ext/autodoc/__init__.py` at #1;
- returned results included subsequently edited files in 4/4 runs.

Nevertheless all four arms failed both repeats, so localization was not the limiting factor. Repo Context averaged roughly 14.2MB of state per run and did not improve aggregate success over NONE in this small study.

## Context Vault behavior

Across Vault/Both runs:

```text
obs_search calls: 8, all non-empty
average search payload: 7.6KB
obs_get calls: 7
pressure-contract get: 4/4
```

The new 12KB default payload budget held in real runs. Vault state averaged roughly 362KB/run in vault-only and 357KB/run in both; pressure runs intentionally archived about 786KB of source evidence each.

## Aggregate resource observations

| Arm | Pass | Avg wall | Avg total tokens | Avg Vault state | Avg Repo state |
|---|---:|---:|---:|---:|---:|
| NONE | 2/6 | 184s | 360k | 0 | 0 |
| VAULT | 4/6 | 166s | 276k | 362KB | 0 |
| REPO | 2/6 | 169s | 342k | 0 | 14.2MB |
| BOTH | 4/6 | 164s | 257k | 357KB | 14.2MB |

Aggregate averages mix very different strata and should not replace the task-level results. One BOTH neutral run was a large duration outlier.

## Conclusions

1. The neutral task showed no correctness regression: 8/8 across arms.
2. Context Vault produced a replicated treatment-specific benefit under scripted evidence pressure: VAULT/BOTH 4/4 versus NONE/REPO 0/4, with much lower tokens and wall time. Receipt virtualization and retrieval-only causality are not separated in v1.
3. Repo Context now returns useful cold fallback/indexed evidence, but the selected navigation task remained 0/8; relevant localization alone did not solve the implementation challenge.
4. BOTH inherited the Vault pressure benefit and did not show a dual-install regression in this matrix.
5. These results justify a larger context-pressure replication, not a claim that Vault or BOTH broadly improves arbitrary coding tasks.

The post-run v2 deterministic gate identified Context Vault #69 (deep search hit → returned get action missed the evidence); the focused post-fix gate now passes. No adaptive model runs should be added to POSTFIX-02.
