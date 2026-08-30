# POSTFIX-03 fixed four-arm manifest

Frozen before model calls: 2026-08-31.

## Budget and design

- Maximum wall budget: 5 hours
- Fixed runs: 3 tasks × 2 independent repeats × 4 arms = 24 evaluable runs
- No adaptive additions
- Ordinary task failures are not retried
- One replacement is allowed only for a pre-result provider/TLS infrastructure failure
- Per-run timeout: 12 minutes
- Model: `openai-codex/gpt-5.6-sol`, thinking medium
- Deterministic F2P/P2P scoring; no model judge
- Fresh workspace and agentDir per run

## Plugin sources

- Context Vault HEAD: `7d60f1f3727004ac5c0b313150cbfa87397d7ac8`
- Repo Context HEAD: `cbf572b74d18cf365d6d07bae1614fe9e370c209`
- Repo #17 independent acceptance: Windows 2/2, external first-query correct, full CI 371 passed/1 skipped

## Tasks

### Repo localization

- Task: `sphinx-doc__sphinx-8035`
- Role: find and modify the autodoc private-member filtering/option path in an unfamiliar repository
- Task SHA-256: `ab1b29c2446a21eaadca5a3e48fd08c577d442cac35fdb0ddb61d31c1f8ba8f2`
- Image: `sha256:7b1d256a32894419f0701347a4e9b744da45332c34ed332c97b2258993291d19`
- Network-none preflight: base fail, gold pass

### Local control

- Task: `django__django-12262`
- Role: small local template argument-validation fix where the prompt nearly identifies the condition
- Task SHA-256: `e010e37dc654f112ec121d401ff6c3d99d737a5e8ef0989be6ed1da41bce426d`
- Image: `sha256:0a3b5b6661c9f71808d85b86a52189939d64d2e83e6ad5cf925ed3f0c5823290`
- Network-none preflight: base fail, gold pass

### Retrieval-required pressure v2

- Task image ID: `sphinx-doc__sphinx-10466`
- Role: recover a contract hidden beyond Vault receipt preview under 768KB of evidence pressure
- Task SHA-256: `88455d236d52e6cda29003af24bc252daad677b58945e8aa9aef4176b42ac5dc`
- Image: `sha256:9ded73178cc502f508908d2063f3fbcf604ed7b0187d32fcd47e371b1d341711`
- Base: 2 hidden failures/1 visible pass; gold: 3/3 pass
- Zero-model gate: Vault receipt contract occurrences 0; exact search nextAction retrieves contract; accepted

## Seed-42 order

| Block | Task | Repeat | Arm order |
|---:|---|---:|---|
| 1 | repo-localization | 2 | NONE → VAULT → REPO → BOTH |
| 2 | local-control | 2 | VAULT → REPO → BOTH → NONE |
| 3 | repo-localization | 1 | REPO → BOTH → NONE → VAULT |
| 4 | context-pressure-v2 | 1 | BOTH → NONE → VAULT → REPO |
| 5 | local-control | 1 | NONE → VAULT → REPO → BOTH |
| 6 | context-pressure-v2 | 2 | VAULT → REPO → BOTH → NONE |

## Predeclared interpretation

- Report task strata first; aggregate pass rate is secondary.
- Repo usefulness is evaluated by success plus search adoption, result relevance, later edited-file hits, native navigation calls, time, and tokens.
- Vault usefulness is evaluated primarily on pressure success, receipt bytes, search→get adoption, time, and tokens.
- Local control checks correctness regressions and overhead.
- A 2-repeat difference is diagnostic, not a general population estimate.
