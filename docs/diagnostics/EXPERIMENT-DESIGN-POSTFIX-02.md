# EXPERIMENT-DESIGN-POSTFIX-02

Status: preregistration draft; do not start model runs until entry gates pass.

## Goals

Measure plugin impact along four separate dimensions instead of collapsing everything into one pass rate:

1. task correctness;
2. model token/tool behavior;
3. local startup/CPU/memory/disk cost;
4. retrieval usefulness under cold, warm, and context-pressure conditions.

The study must distinguish Context Vault, Repo Context, dual-install interaction, infrastructure errors, and scorer failures.

## Entry gates

### G1 — task/scorer integrity

Every selected task must pass an automated preflight before any model call:

1. Apply official test patch to the unmodified base: at least one F2P assertion fails.
2. Apply known gold diff plus official test patch: all F2P and P2P pass.
3. Every declared node ID is collected exactly, or the task uses a preregistered complete-module command with exit-code scoring.
4. No test requires public network access.
5. Zero unmatched test IDs and zero natural-language labels interpreted as module names.
6. Record container image digest and exact command.

A task failing any gate is replaced before the task list is frozen. No post-result scorer redesign is allowed.

### G2 — plugin deterministic acceptance

- Vault 39-query recall ≥95%.
- Vault search duplicate and index-fallback tests pass.
- Vault search preview has a documented total-byte contract (#66).
- Repo cold first search returns useful evidence/fallback without a second model call (#15).
- Repo ranking gold tests, warm reuse, Windows heartbeat, tool wrapper, and audit pass.
- Dual lifecycle/tool-surface smoke passes.

### G3 — harness integrity

- Result `arm` equals actual plugin group.
- `.pi` controls are excluded from agent diff.
- provider transport failures become `INFRA_ERROR`.
- startup time is measured separately from provider/model time.
- A scripted fake-provider test verifies all result and metric paths.

## Phase A — zero-model performance suite

### A1 Repo Context lifecycle

Synthetic Git and non-Git projects at 100, 1,000, and 5,000 files; five process-isolated repetitions:

- extension `session_start` latency;
- first search wall time and whether evidence is non-empty;
- time until index ready;
- unchanged warm hydration;
- one-file and 100-file incremental update convergence;
- peak/steady RSS and CPU user/system time;
- index bytes, file count, and write amplification;
- warming-empty/fallback/indexed-result telemetry.

Cold first-search acceptance: 0/5 empty-only responses at each reference scale, unless the same call returns a useful direct fallback.

### A2 Context Vault lifecycle

Tool outputs at 1KB, 16KB, 64KB, 256KB, and 1MB; unique and duplicate content:

- tool-result hook p50/p95;
- redaction/hash/write phase time;
- archive/dedup bytes;
- receipt reduction bytes;
- search p50/p95 at 100/1,000/5,000 observations;
- cold/warm persistent-index behavior and fallback correctness;
- model-visible search payload bytes under 1/5/10 result requests;
- quota used/target/over-budget and GC behavior.

### A3 Dual-install and project integrity

- combined startup, RSS, CPU, handles/watchers, state bytes;
- active tool list and schema bytes;
- no tool-name collision;
- no plugin state or control file in Git diff;
- no Vault recursive archival of plugin-owned results;
- clean shutdown/crash recovery.

## Phase B — fixed 24-run model matrix

Only after G1–G3 pass.

### Arms

- NONE
- VAULT
- REPO
- BOTH

### Tasks

Freeze exactly three preflighted tasks, each run twice independently:

1. **Neutral/local control:** small direct implementation where repository search and context reduction should not be needed. Measures pure plugin overhead/regression.
2. **Repository navigation:** large-project symbol/location task with a preregistered gold query/path and known vendor/locale distractors. Measures first-search usefulness and ranking.
3. **Context pressure:** deterministic custom task producing large test/log evidence and requiring recovery of an earlier detail. Measures archive/reduction/search/get rather than generic coding ability.

Total: 3 tasks × 2 repeats × 4 arms = 24 evaluable runs. No adaptive additions.

### Ordering

- Seed 42 task/repeat block order.
- Latin-square arm rotation so every arm appears equally in each ordinal position.
- Same model, thinking level, prompt, container, timeout, and test command.
- Fresh isolated agentDir for the cold matrix.
- Warm behavior remains a separate zero-model suite; do not mix cold/warm states inside this endpoint.

### Primary endpoint

- deterministic hidden F2P + P2P pass.

### Secondary endpoints

- extension/session startup time;
- model wall time and test time separately;
- input/output/cache-read/cache-write tokens;
- tool calls and result bytes;
- first repo search lifecycle, result count, gold-path rank, later adoption;
- Observation archive/search/get and payload bytes;
- compaction/reduction and recovered evidence;
- peak RSS/CPU and state bytes;
- source-file integrity.

### Infrastructure policy

- Provider/TLS/WebSocket/auth failure is not FAIL.
- One replacement is allowed only when no usable model result was produced.
- Repeated backend failure stops the batch.
- Ordinary task failure is never retried.
- Test-network access is prohibited, preventing remote-image false failures.

## Analysis

Report both initial task-level outcomes and all fixed repeats. Do not pool adaptively selected tasks.

For each arm versus NONE:

- paired success discordance and exact McNemar/permutation result;
- raw risk difference with interval;
- median/mean duration and token ratios;
- gold-path Recall@1/5 and MRR;
- first-search non-empty rate;
- Observation search→get adoption;
- local resource/disk deltas.

With n=6 per arm, this is diagnostic rather than a population benchmark. “Best arm” language is prohibited unless replicated in a larger preregistered study.

## Phase C — memory experiment, separate authorization

Strict EXP-MEM-02 requires 5 arms × 5 repetitions = 25 model runs and therefore exceeds the standing 24-run cap. Do not silently reduce or combine it with Phase B.

If separately authorized, retain:

- A_BASELINE
- B_CORRECT_PASSIVE
- C_CORRECT_HINT
- D_WRONG_PASSIVE
- E_WRONG_HINT

Same workspace/container across phase sessions, separate sessions, sealed tools, seed-42 order, hidden tests, and explicit search/get/integrity metrics. The key endpoints are correct-memory benefit, wrong-memory harm, hint interaction, and actual evidence retrieval.

## Current blockers

- Repo Context #15 is now closed at `d058a69`. Deterministic acceptance passed: 326 tests, package smoke, and 6/6 non-empty cold first searches in 28–37ms with 715–797-byte payloads.
- [pi-context-vault#66](https://github.com/Fubuyunhua/pi-context-vault/issues/66) remains open: Observation search previews need a total byte budget.

Until #66 passes deterministic acceptance, run Phase A only and make no further model calls.
