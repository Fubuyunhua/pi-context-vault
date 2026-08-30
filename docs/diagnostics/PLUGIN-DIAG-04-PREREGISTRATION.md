# POSTFIX-4ARM-01 preregistration

Date: 2026-08-30

## Purpose

Run a bounded, hypothesis-driven post-fix comparison after all critical plugin issues reached deterministic acceptance. This is not a population SWE-bench estimate; it targets previously observed search-ranking and dual-install behavior.

## Fixed configuration

- Model: `openai-codex/gpt-5.6-sol`
- Thinking: `medium`
- Judge: disabled; official F2P+P2P tests are the primary endpoint
- Arms: `none`, `vault`, `repoctx`, `both`
- Runs: 4 tasks × 4 arms = 16 evaluable runs
- Agent state: isolated fresh `PI_CODING_AGENT_DIR` per run
- Plugin source commits:
  - Context Vault: `6b0667e0d082d1f8822c642bb217708fd117ea90`
  - Repo Context: `212e1b7e9b647c36a09186d2371b9f242d399f1f`
- Task order: seed-42 permutation of the four selected tasks
- Arm order: Latin rotation; each arm runs first exactly once

## Tasks and rationale

1. `sphinx-doc__sphinx-10435`: prior positive navigation/control case; old both failure was provider TLS infrastructure.
2. `sphinx-doc__sphinx-8265`: prior locale/vendor ranking-noise failure.
3. `django__django-12209`: deep Django model-save localization; old search found the edited implementation only at low rank.
4. `django__django-12774`: `QuerySet.in_bulk`; old search ranked vendored xregexp above `django/db/models/query.py`.

This selection is intentionally diagnostic and must not be reported as an unbiased success-rate benchmark.

## Execution order

| Task | Arm order |
|---|---|
| sphinx-10435 | none → vault → repoctx → both |
| sphinx-8265 | vault → repoctx → both → none |
| django-12209 | repoctx → both → none → vault |
| django-12774 | both → none → vault → repoctx |

## Endpoints

Primary:

- exact F2P all pass
- exact P2P all remain green
- `finalStatus=PASS`

Secondary:

- wall duration
- input/output/cache tokens
- cache hit rate
- tool calls by name
- Observation archive/search/get/reduction metrics
- Repo Context search adoption and returned/edited paths
- plugin state bytes
- provider failures

## Infrastructure handling

- TLS, certificate, WebSocket/provider transport failures are `INFRA_ERROR`, not task failures.
- One immediate replacement run is allowed for an infrastructure error and is stored separately.
- No ordinary task failure is retried.
- Stop the batch if authentication/backend failures repeat.

## Interpretation

- Compare arms only within the same task.
- Report exact counts and paired task outcomes; do not infer broad superiority from n=4.
- A model experiment for EXP-MEM-02 remains separate because this batch does not seed cross-session memories.
