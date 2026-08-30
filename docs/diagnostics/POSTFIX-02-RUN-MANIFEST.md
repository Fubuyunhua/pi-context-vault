# POSTFIX-02 fixed 24-run manifest

Frozen: 2026-08-30 after G1–G3 acceptance.

## Configuration

- Model: `openai-codex/gpt-5.6-sol`
- Thinking: medium
- Arms: NONE / VAULT / REPO / BOTH
- Runs: 3 tasks × 2 independent repeats × 4 arms = 24 evaluable
- Judge: deterministic tests only
- Vault source: `5e30ddf4024af9c68269d11ff6b99354a34b6382`
- Repo source: `d058a69`
- Fresh agentDir per run
- No adaptive additions

## Tasks

1. `neutral`: django-12039, exact tests, network-disabled base-fail/gold-pass preflight.
2. `repo-navigation`: sphinx-9461, exact tests, network-disabled base-fail/gold-pass preflight.
3. `context-pressure`: synthetic fixture on the sphinx-10466 image, complete-module exit-code scoring.

Context-pressure injects 12 paired synthetic `pressure_log` results of 65,536 bytes before the user task:

- original evidence: 786,432 bytes;
- NONE/REPO retain 786,432 bytes;
- VAULT/BOTH retain 49,152 model-visible receipt bytes in preflight;
- Vault search result: 1,772 bytes;
- search→get recovers the authoritative contract.

Base fixture: two hidden failures and one visible pass. Gold patch: 3/3 pass.

## Seed-42 block order and arm rotation

| Block | Task | Repeat | Arm order |
|---:|---|---:|---|
| 1 | repo-navigation | 2 | NONE → VAULT → REPO → BOTH |
| 2 | neutral | 2 | VAULT → REPO → BOTH → NONE |
| 3 | repo-navigation | 1 | REPO → BOTH → NONE → VAULT |
| 4 | context-pressure | 1 | BOTH → NONE → VAULT → REPO |
| 5 | neutral | 1 | NONE → VAULT → REPO → BOTH |
| 6 | context-pressure | 2 | VAULT → REPO → BOTH → NONE |

## Failure policy

- Provider/auth/TLS failure before a usable result: one replacement, not counted.
- Repeated infrastructure failure: stop batch.
- Ordinary task failure: no retry.
- Test mismatch/unmatched ID: invalidate batch; no post-hoc scorer changes.
