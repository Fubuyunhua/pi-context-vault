# POSTFIX-02 entry-gate report

Date: 2026-08-30  
Model calls: 0

## Plugin gates

### Context Vault #66

Commit `5e30ddf4024af9c68269d11ff6b99354a34b6382`:

- CI: 205 passed, 1 skipped
- package smoke: pass
- search payload: default 12KB; configurable 4–32KB
- historical query recall: 38/39
- 1,000 observations: 60ms miss, 20ms oldest hit, 23ms newest hit
- duplicate collapse and quota status: pass

#66 is closed and accepted.

### Repo Context #15

Commit `d058a69`:

- CI product tests: 326 passed, 1 skipped
- package smoke: pass after one npm-registry TLS retry
- six cold-first-search surrogate runs: 6/6 non-empty
- first-call latency: 27–36ms
- payload: 715–797 bytes

#15 is closed and accepted.

## Scorer/task gate

Static validation of 50 `verified-mini` tasks found:

- valid exact metadata: 33
- invalid/malformed metadata: 17

Invalid cases include truncated pytest parameter IDs, non-test expressions, and natural-language labels that the old runner interpreted as Django modules. These tasks are excluded unless assigned an explicit preflighted complete-module command.

Two candidate tasks passed network-disabled base/gold preflight:

| Task | Role candidate | Base + tests | Gold + tests |
|---|---|---:|---:|
| django-12039 | neutral/local | FAIL as required | PASS |
| sphinx-9461 | repository navigation | FAIL as required | PASS |

The preflight applied the official test patch in a clean container with `--network none`, ran every selected test exactly, and recorded container-specific logs.

## Remaining preparation

The third Phase-B task must be a deterministic context-pressure task. It still needs:

- a scripted large-evidence prelude rather than relying on the model to generate pressure;
- hidden F2P/P2P tests;
- base-fail/gold-pass preflight;
- proof that NONE retains full evidence while VAULT archives/reduces/retrieves it under the intended condition;
- no public network or environment probes.

No further model calls should begin until that task and the startup/resource metric collector pass G1/G3.
