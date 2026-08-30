# Focused post-fix test verification 03

Date: 2026-08-31  
Model calls: 0

## Context Vault #70

Verified source: `cba6f87797fa4c3821f7571bb001fb25150cec89`

### Focused project tests

```text
redaction-performance.test.ts
redaction-compatibility.test.ts
artifact-store.test.ts

39/39 passed
```

### External scaling replay

| Input | Before | After |
|---:|---:|---:|
| 16KB single line | 244ms | 0.62ms |
| 64KB | 4.02s | 0.86ms |
| 128KB | 16.40s | 0.83ms |
| 256KB | 65.75s | 1.68ms |

### Formerly blocked 1MB gate

```text
unique archive:       476.54ms
first duplicate:      446.40ms
repeated duplicate:    25.21ms
deduplicated:         true
second state growth:  491 bytes
secret persisted:     false
reduction target:     reached
```

### Full CI

```text
typecheck:      pass
Biome:          pass
tests:          223 passed, 1 skipped
coverage:       pass
package smoke:  pass
```

Result: #70 independently accepted.

## Repo Context #17

Verified source: `e086f39a602d540bf5811a67cee0ab3518bffd3a`

### Shipped focused tests

```text
repo-map-issue-17.test.ts
repo-map-lexical-fallback.test.ts
repo-map-runtime.test.ts

77 passed, 1 failed
```

Failure:

```text
repo-map-issue-17.test.ts
expected freshness stale; received dirty
```

The new test uses `path.includes("/src/file-")` to arm an injected deadline. Windows supplies backslash-separated paths, so the deadline never activates. Temporarily normalizing separators makes the focused issue test pass 1/1.

### External default-scheduler replay

The original clean 5,000-file/100-change reproduction still fails on the first query:

```text
first top:         file-00019.ts
expected:          file-00099.ts
pending:           34
fallback evidence: empty
lexical attempts:  0
identical retry:   file-00099.ts
```

The manual-scheduler test does not cover the production scheduler race. Remaining work is rescheduled after the bounded flush; a concurrent activation can retire the captured generation before the pending lexical scan starts, returning the stale pre-scan result.

Result: #17 reopened. Full Repo CI is not accepted until both the Windows focused test and default-scheduler external reproduction pass.

## Infrastructure

One GitHub push failed with an SSL/TLS handshake error and succeeded on the single permitted retry. It was not counted as a product/test failure.
