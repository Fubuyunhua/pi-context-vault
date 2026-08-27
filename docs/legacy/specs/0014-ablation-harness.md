# Spec 0014: No-token ablation harness

Status: implemented for synthetic/local validation. This spec re-scopes GitHub issue #31 to harness implementation; provider-backed execution remains [issue #36](https://github.com/Fubuyunhua/pi-context-vault/issues/36).

> **No generated fixture, dry run, fake-Pi result, or statistic in this repository is benchmark evidence.**

## Arm contract

All values are explicit and validated. Unknown config keys fail closed.

| Arm | Extension | Archive | Reduction | Repo Map | Injection |
| --- | --- | --- | --- | --- | --- |
| A | absent (`--no-extensions`) | off | off | absent | off |
| B | present | all | off | disabled | off |
| C | present | all | on | disabled | off |
| D | present | off | off | enabled/tool | off |
| E | present | all | on | enabled | once per user turn |
| F | present | all | on | enabled | every LLM call |

`repoMapEnabled: false` prevents construction, start/build/watch, freshness checks, automatic queries, and registration of an available Repo Map tool. `reductionEnabled: false` bypasses `reduceContext` and reduction telemetry. Archive behavior remains independently controlled by `archivePolicy`.

## Immutable inputs and planning

The harness accepts versioned, strictly validated experiment JSON, task JSONL, and plan JSON. Canonical JSON recursively sorts object keys and SHA-256 hashes the result. A plan embeds experiment/task hashes. Run IDs are the first 128 bits of a hash of the immutable experiment/task identity and schedule position; changing any input makes resume fail.

A seeded balanced six-treatment Williams schedule supplies each task/repeat block with A–F exactly once and balances ordered carryover. Planning requires `task count × repeat count` to be a multiple of six; partial cycles are rejected because they do not balance ordered carryover. Task/repeat blocks and sequence assignment are shuffled separately before results exist. The complete schedule is persisted before execution. E–F is confirmatory; A–D comparisons are exploratory.

## Isolation and execution

Each attempt uses a fresh cloned repository at the exact base commit plus fresh `HOME`, session directory, and `PI_CODING_AGENT_DIR`. Arms B–F get only the explicit arm config. Pi receives `--no-extensions`, and B–F add only the pinned extension; skills, prompt templates, and themes are disabled. Credentials may enter only through named, allowlisted environment variables and never argv or result JSON. Evaluators operate after the agent and should be placed in a separately isolated, network-disabled container for real tasks. The local command adapter validates mechanics only.

The fake-Pi executor contract is `execute(AgentCommandPlan) -> AgentExecution`. It exposes the exact argv/environment/workspace and returns process status, lifecycle output, session JSONL, and monotonic duration. The production adapter kills a detached process group on timeout. Agent timeout is a treatment outcome; evaluator/clone/process failures are classified separately.

## Accounting and integrity

Session JSONL is authoritative. Aggregation matches Pi by summing assistant usage and auxiliary usage-bearing compaction, branch-summary, and tool-result records while retaining them separately. Tool calls and tool results are counted. The harness reports:

- `uncachedPrompt = input + cacheWrite`;
- `promptTokens = input + cacheRead + cacheWrite`;
- cache hit ratio `cacheRead / promptTokens`, null for zero denominator or any capability other than `reported`;
- first assistant request and continuation usage separately;
- requested model and every observed response model.

Any response-model mismatch is an integrity failure, not a task result. Provider cache isolation is not claimed.

The headless `/context-vault status-json` command emits one length- and SHA-256-framed status snapshot before shutdown. Durations are reported individually and are never summed as “plugin time.” Disk state is scanned after shutdown with `lstat`; symlinks are counted but never followed. Logical and allocated bytes, current map generation files, active pointer, artifact count, and metadata bytes remain distinct.

## Journal, retry, and collection

The append-only journal uses fsynced JSONL events with a sequence, plan hash, previous-event hash, and event hash:

`planned -> provisioned -> running -> agent-finished -> evaluating -> collected -> complete`

A failure transition records only a sanitized stage code and retryability. Resume validates the complete hash chain, skips checksum-valid completed runs, and creates a numbered fresh attempt. Only predeclared infrastructure failures may retry; ordinary task failure and agent timeout do not. Every attempt is retained. Partial workspaces are quarantined/deleted rather than resumed.

Raw attempts are immutable exclusive-create JSON plus SHA-256 sidecars. They contain metrics/hashes, never transcript, source, tool output, arbitrary stderr, task prompt, credentials, or vault artifacts.

## Analysis

E–F analysis reports paired pass difference, discordant counts, exact two-sided McNemar probability, paired metric differences/ratios, seeded task-cluster bootstrap intervals, missing-pair attrition, and lexical/semantic/mixed strata. Ratios with a zero E denominator are null. First-request/continuation data permits cache sensitivity analysis. Real sample size, minimum detectable effect, corpus, provider/model, and budget must be preregistered in issue #36.

## Publication

Publication is a projection through a fixed allowlist. Transcript, prompt, source, arbitrary output, host paths, and failure text are excluded structurally. Verification rejects unknown fields, credential-like strings, absolute host paths, private keys, and planted secret/path/source markers. Sensitive local run directories should use restrictive permissions and an explicit retention policy.

## CLI

```text
npm run bench:plan -- --experiment experiment.json --tasks tasks.jsonl --output plan.json
npm run bench:run -- --experiment experiment.json --tasks tasks.jsonl --plan plan.json --output results --fake-pi-command ./fake-pi
npm run bench:analyze -- --tasks tasks.jsonl --plan plan.json --results results --output analysis.json
npm run bench:verify -- --results results
```

The local suite uses no provider token. `bench run` is categorically a fake-provider/fake-command harness: it requires `provider: "fake"`, an empty credential-environment allowlist, and an explicit `--fake-pi-command`. It rejects `--approval` and `--pi-command`; no approval artifact can launch Pi or any provider from this issue-#31 harness. The built-in command evaluator is recorded as `local-unisolated` and validates mechanics only.

Real execution, extension provenance checks (including repository containment, tracked-file status, and symlink-escape rejection), approval, and provider-side hard request/token/USD budget enforcement will be implemented and approved in issue #36. A provider run remains outside the evidence scope of this spec and cannot be described as cold-cache, statistically meaningful, or benchmark evidence until issue #36's assets, isolation, budgets, and power gates are satisfied.
