# Specification 0002: Per-user-turn Repo Map capsule injection

Status: Accepted for implementation

## Problem

The Pi `context` hook fires before **every** LLM call, including every tool-loop
iteration inside a single user turn. The Context Vault `context` handler currently
performs the following work on every invocation:

1. Removes the previous `context-vault-repo-map` capsule.
2. Runs `repoMap.query()` (which itself runs `ensureFresh()` → `flush()` → up to two
   Git subprocesses, dirty-file re-indexing, and possibly a new generation write).
3. Rebuilds the capsule with fresh `query`, `freshness`, `generation`, `gitHead`,
   `workspaceRevision`, and `pendingFiles` fields.
4. Inserts the capsule at `messages[0]`, i.e. at the very front of the message
   history, immediately after the system prompt.

Because the capsule bytes change between consecutive LLM requests within one user
turn (generation counter, workspace revision, pending files, query text), and
because it sits at the head of the history, the provider-side prompt prefix cache
is invalidated on every request. Measured aggregate impact in a 20-task SWE-bench
run: fresh input tokens 2.28M → 19.14M, cacheRead 54.91M → 44.73M, wall time +38%.

## Goals

- Within one user turn, the automatically injected Repo Map capsule must be
  byte-for-byte identical across every LLM request, and must be re-inserted
  without re-querying the repository map or re-rendering the capsule.
- The capsule must not be placed at the head of the long stable history. It must
  be placed directly after the latest user message, so that the stable history
  (system prompt + prior turns) remains a cacheable prefix.
- A new user prompt must trigger exactly one refresh (query + render + freeze).
- Users must be able to choose the injection policy and to disable automatic
  injection entirely.

## Non-goals

- This Spec does not change `before_agent_start` behavior (it still calls
  `ensureFresh()` once per user turn).
- This Spec does not add telemetry counters (separate Spec).
- This Spec does not change `RepoMapRuntime.query()` internals, MiniSearch reuse,
  generation retention, or the `context_vault_repo_map` tool.
- This Spec does not change the `context` hook's `reduceContext` behavior or the
  capsule payload schema itself.
- This Spec does not remove the `context-vault-repo-map` custom message type or
  its `display: false` / `details` shape.

## Current behavior

In `src/extension.ts`, the `context` handler (registered via `pi.on("context", ...)`):

1. Removes any previous capsule (`role === "custom" && customType === "context-vault-repo-map"`).
2. If the map is available, derives `query` from the last non-empty user message,
   calls `runtime.repoMap.query(query, { limit: 8 })`, and renders a bounded capsule.
3. Builds a new custom message with `timestamp = messages[0].timestamp - 1` and
   prepends it: `[capsule, ...messages]`.
4. Falls through to `reduceContext` with the capsule already in place.

There is no configuration for injection frequency; every LLM call re-queries and
re-renders, and the capsule always lands at index 0.

## Required behavior

### Configuration

Add `mapInjectionMode` to `ContextVaultConfig` with allowed values:

- `"once-per-user-turn"` (default): inject at most one frozen capsule per user
  turn; reuse it for every later LLM call in the same turn.
- `"every-llm-call"`: preserve current behavior (re-query and re-render before
  every LLM call, capsule at index 0).
- `"off"`: never inject an automatic capsule. The explicit
  `context_vault_repo_map` tool remains available.

`loadConfig` must accept the three literals and reject any other value.

### Capsule freeze key

The freeze key is the SHA-256 of the normalized text of the **last** user message
in `event.messages` (after removing any previous capsule). Normalization: extract
text blocks exactly like `messageText`, no trimming changes beyond that function's
behavior. If there is no user message, no freeze occurs and the handler falls back
to current per-call behavior (query + render + prepend), preserving today's
behavior for degenerate message arrays.

### Freeze record

On the first `context` invocation of a turn (no record, or record key differs
from the current last-user-message key), the handler:

1. Runs the existing query + `boundedMapCapsule` render path unchanged.
2. Records `{ key, message }` in extension runtime state, where `message` is the
   complete custom message object (`role`, `customType`, `content`, `display`,
   `details`, `timestamp`) with `timestamp` copied from the last user message and
   `index` set to the insertion position: immediately **after** the last user
   message (i.e. `lastUserIndex + 1`, clamped to the message count).

### Reuse path

On later `context` invocations in the same turn (record exists and key matches):

1. Remove any previous capsule (existing filter).
2. Re-insert the **identical** frozen message object (same `content`, `details`,
   `timestamp`) at the same index (clamped to current message count).
3. Do **not** call `repoMap.query`, do not call `boundedMapCapsule`, do not touch
   `runtime.mapCapsule`.

The inserted bytes must be identical across calls so that the provider payload
prefix (system prompt + stable history + capsule + messages up to the frozen
index) stays byte-identical.

### Injection position

- `once-per-user-turn`: capsule index = position after the last user message.
- `every-llm-call`: index 0 (unchanged legacy behavior).

## State transitions

```
turn begins (new user message)
  └─ context #1: key A → no match → query+render → freeze {key:A, msg} → insert after last user msg
       context #2..n (same turn, key A): match → remove old capsule → re-insert frozen msg at frozen index
  └─ next turn (user message B): key B ≠ A → query+render → re-freeze {key:B} → insert
```

- Session start / shutdown resets runtime state; the freeze record is discarded
  with the rest of `RuntimeState` (existing `dispose()` behavior).
- If the repository map becomes unavailable mid-turn (`repoMapAvailable` flips),
  the handler no longer enters the injection branch; the stale freeze record is
  ignored and overwritten on the next successful build.

## Failure behavior

- If `repoMap.query()` throws, the existing catch path renders the honest stale
  capsule with `error` metadata; the result is frozen exactly like a success so
  the same turn keeps a stable capsule.
- If rendering or freezing fails (exception in the injection branch), the handler
  must not crash the LLM request: fall through to `reduceContext` with messages
  minus capsule, mirroring today's exception behavior (none expected; the render
  path is pure string work already exercised in production).
- Reuse must never resurrect a capsule whose key no longer matches; a mismatch
  always triggers a rebuild.
- Freeze state must not survive into a session where the map is unavailable:
  `mapCapsule` is only consulted when `repoMapAvailable` is true.

## Backward compatibility

- The default injection policy **changes** from implicit per-LLM-call to
  `once-per-user-turn`. This is the intended fix; existing deployments that
  require the old cadence can set `mapInjectionMode: "every-llm-call"`.
- Existing config files without `mapInjectionMode` remain valid (default applies).
- `context-vault-repo-map` custom message type, `display: false`, `details`
  shape, and capsule payload schema are unchanged.
- Tool names, artifact IDs, observation IDs, state directory layout, and
  generation file formats are untouched.
- In `every-llm-call` mode, behavior (including index-0 placement) is
  byte-compatible with today.

## Acceptance criteria

1. With the default config, two consecutive `context` invocations in one user
   turn (second invocation includes tool-call/tool-result messages appended after
   the first) return a capsule whose `content` and `details` are identical, and
   the map runtime's `query` is invoked exactly once.
2. A third invocation with a new user message invokes `query` again and produces
   a new freeze.
3. The capsule is not at index 0 when the history contains a user message; it
   sits directly after the last user message, and non-capsule messages before it
   are untouched and in original order.
4. `mapInjectionMode: "every-llm-call"` reproduces today's behavior: query per
   call, capsule at index 0.
5. `mapInjectionMode: "off"` injects no capsule and returns the message array
   unchanged (or `undefined`) when no reduction occurs.
6. `loadConfig` rejects invalid values for `mapInjectionMode` with a clear error
   and accepts the three literals.
7. All existing tests pass except assertions that specifically pin the capsule to
   index 0, which are updated to the new position.

## Test cases

In `tests/extension.test.ts` (harness with a mocked `repoMapRuntimeFactory` so
`query` calls are countable):

1. `freezes the map capsule within one user turn and refreshes on the next prompt`
   — default config; query called once for two same-turn invocations, twice after
   a new user message; frozen content identical across the same-turn calls.
2. `re-inserts the frozen capsule at its original index as the turn grows` —
   messages appended between calls do not move the capsule, and message order
   before the capsule is preserved.
3. `keeps a capsule per LLM call in every-llm-call mode` — project config
   `{ mapInjectionMode: "every-llm-call" }`; query called per invocation; capsule
   at index 0.
4. `injects no automatic capsule in off mode` — project config
   `{ mapInjectionMode: "off" }`; no capsule in the returned messages.
5. `recovers when the repo map becomes unavailable mid-turn` — after freezing,
   flip `repoMapAvailable` off (map close/dispose path) and assert no capsule is
   injected and no stale record resurrects later.

Updated assertions:

- `reduces archived old results through the context hook without persisting a
  capsule` — capsule now at index 1 (after the user message), user message stays
  at index 0; the repeated invocation still yields exactly one capsule.
- `keeps repository-map capsules ephemeral, bounded, revisioned, and honest when
  stale` — capsule at index 1; add an assertion that a second same-turn
  invocation does not call `query` again.
- `uses a valid minimal stale capsule when the configured 512-byte budget is
  exhausted` — capsule at index 1.

In `tests/state.test.ts`:

6. `loadConfig` accepts `off` / `once-per-user-turn` / `every-llm-call` and
   rejects `"sometimes"` with `mapInjectionMode must be one of ...`.
