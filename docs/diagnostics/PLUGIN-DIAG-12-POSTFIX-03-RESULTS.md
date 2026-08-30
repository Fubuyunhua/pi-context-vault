# POSTFIX-03 four-arm results

Date: 2026-08-31  
Model: `openai-codex/gpt-5.6-sol`, thinking medium  
Runs: 24 evaluable, completed in about 68 minutes  
Model judge: disabled

## Integrity

- Fixed before execution: 3 tasks × 2 repeats × 4 arms.
- No adaptive additions or ordinary-failure retries.
- Network-disabled base-fail/gold-pass preflight passed for both real tasks.
- Retrieval-required pressure v2 zero-model gate passed before execution.
- All 24 results have correct arm/plugin metadata.
- F2P/P2P unmatched IDs: 0.
- Four pre-result `unknown certificate verification error` attempts were replaced and excluded under the preregistered infrastructure rule.
- No Pi compaction occurred; pressure behavior is Observation virtualization/search, not automatic compaction.

## Primary correctness outcomes

| Task stratum | NONE | VAULT | REPO | BOTH |
|---|---:|---:|---:|---:|
| Local control | 2/2 | 2/2 | 2/2 | 2/2 |
| Repo localization | 2/2 | 2/2 | 2/2 | 2/2 |
| Context pressure v2 | 0/2 | 2/2 | 0/2 | 2/2 |
| **Total** | **4/6** | **6/6** | **4/6** | **6/6** |

The aggregate difference is entirely the pressure stratum. The two normal coding tasks were correctness ceilings and do not distinguish final pass rates.

## Repo Context: what it changed

### Localization quality

Repo Context was used in all four Repo/Both repo-localization runs. Six searches were issued:

- 6/6 returned indexed `ready` results;
- 6/6 included the subsequently edited implementation/test/document paths;
- the target `sphinx/ext/autodoc/__init__.py` was always present;
- the top result was either the target implementation or its exact focused test.

On the pressure task, all four Repo/Both searches returned `pressurelib/parser.py` as top result. Repo Context therefore consistently answered **where the relevant code is**.

### Navigation behavior

Repo-localization averages/totals over two repeats:

| Arm | First edit | Pre-edit calls | Total bash | Total read | Repo searches |
|---|---:|---:|---:|---:|---:|
| NONE | 55.5s | 20.0 | 28 | 26 | 0 |
| REPO | 44.0s | 17.5 | 18 | 26 | 3 |
| BOTH | 48.5s | 20.5 | 22 | 30 | 3 |

Relative to NONE, REPO reached the first edit about 21% sooner and used 36% fewer bash calls. This is direct evidence of navigation assistance.

### End-to-end cost

| Arm | Pass | Avg wall | Avg tokens |
|---|---:|---:|---:|
| NONE | 2/2 | 178s | 330k |
| VAULT | 2/2 | 167s | 393k |
| REPO | 2/2 | 204s | 460k |
| BOTH | 2/2 | 197s | 533k |

The faster initial localization did not produce lower total cost. REPO spent more time/tokens in later implementation and test iterations; with two repeats this cannot be cleanly attributed to the plugin, but there is no measured end-to-end saving.

The appropriate conclusion is: Repo Context improves the intermediate localization path, while this round still does not show a final correctness or total-token advantage.

## New large-repository cold-search issue

The Django local-control task exposed a scale gap:

```text
repository files: 4,885
Repo/Both first calls: 4
warming + results=[]:  4/4
model retries:         0/4
call duration:         5.0–16.2s (mean 8.7s)
fallback:              No lexical match found
```

Queries contained exact target identifiers such as `parse_bits` and `simple_tag`. All tasks passed only after the model switched to native tools.

Small cold-search surrogates remain 6/6, so this is specifically a realistic large-repository enumeration/index-contention gap. It is tracked as Repo Context #21.

## Context Vault: retrieval-required pressure v2

The v2 task placed the authoritative contract beyond the receipt preview:

- raw prelude: 768KB;
- Vault/Both visible receipts: 48KB;
- receipt contract occurrences in the gate: 0;
- all Vault/Both runs searched archived evidence;
- search results contained the contract in 4/4 runs;
- models issued five get calls in total; three get payloads contained the contract;
- all Vault/Both runs passed, while NONE/REPO failed.

| Arm | Pass | Avg wall | Avg tokens | Obs search/get | Visible prelude |
|---|---:|---:|---:|---:|---:|
| NONE | 0/2 | 160s | 133k | 0/0 | 768KB |
| VAULT | 2/2 | 40s | 65k | 2/3 | 48KB |
| REPO | 0/2 | 76s | 64k | 0/0 | 768KB |
| BOTH | 2/2 | 42s | 97k | 2/2 | 48KB |

Relative to NONE, VAULT reduced average wall time about 75% and total tokens about 51%; BOTH reduced wall time about 74% and tokens about 27%.

This is stronger than v1 because the receipts no longer expose the contract. Search was necessary to reveal it. However, bounded search previews sometimes contained enough contract text before get, so this still demonstrates **Vault search/virtualization treatment**, not strict get-only causality.

Repo Context correctly located `parser.py` but could not recover the missing behavior contract, illustrating the plugins' different roles.

## Local control

All eight runs passed.

| Arm | Avg wall | Avg tokens |
|---|---:|---:|
| NONE | 112s | 91k |
| VAULT | 91s | 96k |
| REPO | 70s | 94k |
| BOTH | 94s | 138k |

With only two repeats and a correctness ceiling, these timing differences are descriptive. The important finding is no correctness regression. The four empty Repo cold searches mean the faster Repo averages cannot be credited to successful Repo navigation.

## Aggregate cost

| Arm | Pass | Avg wall | Avg total tokens | Avg Vault state | Avg Repo state |
|---|---:|---:|---:|---:|---:|
| NONE | 4/6 | 150s | 185k | 0 | 0 |
| VAULT | 6/6 | 99s | 185k | 337KB | 0 |
| REPO | 4/6 | 117s | 206k | 0 | 14.2MB |
| BOTH | 6/6 | 111s | 256k | 341KB | 14.2MB |

Aggregate averages mix three very different tasks. Vault's pressure savings are offset by higher normal-task usage, leaving aggregate tokens nearly equal to NONE. BOTH has the highest aggregate token cost because it combines both tool surfaces and states.

## Conclusions

1. Context Vault again produced a replicated pressure-specific correctness and efficiency benefit under a stricter receipt-hidden design.
2. Repo Context reliably located relevant code and reduced early native navigation, but did not improve final success or total cost on the selected localization task because every arm already passed.
3. Repo and Vault are complementary: Repo answers where the code is; Vault recovers behavior/evidence no longer visible in context.
4. BOTH inherited the Vault pressure benefit without correctness or tool-surface conflicts, at additive token/state cost.
5. Repo's small-fixture cold fallback does not generalize to this 4,885-file Django first-call workload; #21 is the only new product issue from this experiment.
6. Results remain diagnostic because there are only two repeats per task. No broad plugin ranking is justified.
