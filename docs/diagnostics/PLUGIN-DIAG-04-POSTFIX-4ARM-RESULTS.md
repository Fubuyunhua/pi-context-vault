# POSTFIX-4ARM-01 results

Date: 2026-08-30  
Model: `openai-codex/gpt-5.6-sol`, thinking `medium`  
Plugin source: Vault `6b0667e`, Repo Context source equivalent to `212e1b7`  
Judge: deterministic affected-module tests; no model judge

## Design and integrity

- Initial diagnostic matrix: 4 tasks × 4 arms = 16 evaluable runs.
- The only differentiating task (`sphinx-8265`) was then repeated twice across all four arms: +8 evaluable runs.
- Total: 24 evaluable runs, the preregistered ceiling.
- One additional pre-inference attempt failed with `unknown certificate verification error`; it produced no result and was replaced as infrastructure.
- Fresh isolated agentDir per run; same model/thinking/tasks within each paired comparison.

### Scorer correction

Three historical task JSONs contained malformed test identifiers:

- truncated pytest parameter IDs for `sphinx-8265`;
- a non-test expression as Django-12209 F2P;
- natural-language descriptions mixed into Django-12774 P2P labels.

No model calls were repeated for this. Existing patches were rescored offline by applying the agent diff, reverting agent-authored tests, applying the official test patch, and running the complete affected test module. `sphinx-10435/repoctx` had one remote-image DNS failure; the exact test passed on isolated replay and was classified as test infrastructure.

## Corrected outcomes

### Initial four tasks

| Task | NONE | VAULT | REPO | BOTH |
|---|---:|---:|---:|---:|
| sphinx-10435 | PASS | PASS | PASS | PASS |
| sphinx-8265 | FAIL | PASS | FAIL | PASS |
| django-12209 | PASS | PASS | PASS | PASS |
| django-12774 | PASS | PASS | PASS | PASS |
| **Total** | **3/4** | **4/4** | **3/4** | **4/4** |

### Three paired observations for sphinx-8265

| Arm | Repeat 1 | Repeat 2 | Repeat 3 | Total |
|---|---:|---:|---:|---:|
| NONE | FAIL | PASS | FAIL | 1/3 |
| VAULT | PASS | PASS | FAIL | 2/3 |
| REPO | FAIL | FAIL | PASS | 1/3 |
| BOTH | PASS | PASS | PASS | 3/3 |

### All 24 evaluable runs

| Arm | Pass | Avg wall time | Avg total tokens | Relative time vs NONE | Relative tokens vs NONE |
|---|---:|---:|---:|---:|---:|
| NONE | 4/6 | 121s | 231k | baseline | baseline |
| VAULT | 5/6 | 150s | 361k | +24% | +56% |
| REPO | 4/6 | 175s | 284k | +45% | +23% |
| BOTH | 6/6 | 132s | 256k | +9% | +11% |

`total tokens` includes cache-read tokens. Average cache hit rates were about 80–83%. Uncached input+output was also higher for every plugin arm, so the difference is not solely cache accounting.

The sample is adaptive and tiny. In particular, BOTH versus NONE has only two discordant paired outcomes, both favoring BOTH; this is not statistically decisive and must not be reported as broad superiority.

## Tool adoption and cold-start finding

Across six repo-only and six both runs:

```text
repo_context_search calls: 12
non-empty indexed results:  0
warming empty responses:   12
model retries:               0
```

All calls returned `lifecycle=warming`, `generation=0`, and `results=[]`. The model then used direct filesystem tools. This confirms that lazy session startup removed blocking but made the first cold search ineffective for actual agents. Repo Context still built about 15.8MB of state per isolated run on average.

Created: [pi-repo-context#15](https://github.com/Fubuyunhua/pi-repo-context/issues/15).

Post-experiment update: #15 was fixed at `d058a69`. Deterministic acceptance now returns non-empty cold first-search evidence in 6/6 surrogate runs within 28–37ms. This does not retroactively change the 24-run results, which used the pre-fix implementation.

Context Vault:

```text
context_vault_obs_search calls: 5
non-empty searches:              5
average search payload:       15.5KB
context_vault_obs_get calls:      0
compactions across all arms:      0
```

Vault state averaged roughly 137KB/run in vault-only and 95KB/run in both. These tasks did not create context-window pressure, so this experiment does not measure compaction benefit. The absence of `obs_get` means successful Vault-arm outcomes cannot be attributed to full Observation retrieval.

The 8.8–19.0KB search previews have no aggregate total-byte contract and may weaken the intended search→get handoff. Created: [pi-context-vault#66](https://github.com/Fubuyunhua/pi-context-vault/issues/66).

## Issue #55 performance acceptance

Latest deterministic benchmark after the persistent bounded index fix:

| Observations | Miss | Oldest hit | Newest hit |
|---:|---:|---:|---:|
| 100 | 33ms | 15ms | 15ms |
| 500 | 43ms | 17ms | 16ms |
| 1,000 | 70ms | 19ms | 25ms |

At 1,000 observations this is roughly 94–98% faster than the prior 1.15–1.17s scan. Historical query recall remains 38/39, duplicate collapse remains correct, and full Vault CI passed with 203 tests plus one skip.

## Conclusions

1. **No broad ranking is justified.** Three of four initial tasks were ties across every arm.
2. **BOTH was the most stable arm on the one repeated differentiating task (3/3), but n=3 remains too small for causality.**
3. **Repo-only did not improve over NONE and cost more time/tokens in this cold-isolated setup.** Its search returned no evidence in 12/12 calls, so this is primarily a startup/handoff diagnosis rather than a ranking evaluation.
4. **Vault-only had one additional success but substantially higher token/time cost.** Five non-empty searches were used, but no get/compaction occurred.
5. **The repaired plugins are operational, but benefit/cost depends on fixing cold first-search behavior and separately testing real memory/context pressure.**

No further model calls should be added to this batch. The next model experiment should occur only after #15 is fixed, or as a separately preregistered post-fix EXP-MEM-02 study.
