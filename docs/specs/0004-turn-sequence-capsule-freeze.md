# Specification 0004: Turn-sequence driven capsule freeze

Status: Accepted for implementation

Supersedes the freeze-key mechanism of Specification 0002.

## Problem

Specification 0002 freezes the automatic Repo Map capsule for one user turn by
deriving a freeze key from the SHA-256 of the last user message. That key is an
indirect inference of the turn boundary and has a correctness gap: if a user
sends the exact same message text in two consecutive turns (retry, re-run of a
command, same question after edits), the hash matches and the stale capsule from
the previous turn is reused — the repository map shown to the model may be
out of date for the entire turn.

The authoritative turn boundary already exists in the Pi lifecycle:
`before_agent_start` fires exactly once per user prompt. The freeze should be
driven by that event and by a plugin-owned turn counter, not by message content.

## Goals

- The plugin maintains its own `turnSequence` counter, incremented in
  `before_agent_start`.
- `before_agent_start` clears the frozen capsule so the next turn always builds
  a fresh capsule from a fresh repo-map query.
- The first `context` invocation of a turn queries the map once, renders the
  capsule once, and stores the final byte string.
- Later `context` invocations of the same turn re-insert the identical byte
  string and never call the automatic `repoMap.query()`.
- The freeze is immune to repeated user message text across turns.

## Non-goals

- This Spec does not change the capsule payload schema, insertion position
  rules (after the latest user message), `mapInjectionMode` values, or the
  `every-llm-call` / `off` modes.
- This Spec does not change `before_agent_start`'s existing `ensureFresh()`
  behavior (it still refreshes the map once per turn).
- This Spec does not touch telemetry fields or add new counters.
- This Spec does not change the explicit `context_vault_repo_map` tool.

## Current behavior

`src/extension.ts`:

- `before_agent_start` only calls `ensureFresh()` when the map is available.
- `FrozenMapCapsule` is `{ key, index, message }` where `key` is the SHA-256 of
  the last user message text.
- The `context` hook reuses the frozen capsule when
  `mode === "once-per-user-turn" && key !== undefined && frozen.key === key`.
- The freeze key is recomputed (and a new message text detected) only by
  scanning messages; there is no turn counter.

## Required behavior

### State

`RuntimeState` gains:

- `turnSequence: number` — plugin-owned turn counter, starts at 0, reset with
  the session lifecycle (same places `telemetry` is reset).

`FrozenMapCapsule` becomes:

- `{ turn: number, index: number, message }` where `turn` is the
  `runtime.turnSequence` value at freeze time. The `key` field is removed.

The `lastUserMessageKey` helper is removed. `lastUserMessageIndex` remains
(build-time insertion position only).

### before_agent_start

On every `before_agent_start` event, unconditionally:

1. `runtime.turnSequence += 1`.
2. `runtime.mapCapsule = undefined` (clear the frozen capsule).

Then keep the existing behavior: `ensureFresh()` when the map is available.

### context hook (once-per-user-turn mode)

- **Reuse branch**: `mode === "once-per-user-turn"` and
  `runtime.mapCapsule !== undefined` and
  `runtime.mapCapsule.turn === runtime.turnSequence`. Re-insert the identical
  frozen message at `min(frozen.index, messages.length)`; do not query the map,
  do not render, do not touch the frozen record.
- **Build branch**: otherwise. Query the map once, render the capsule, and
  freeze with `{ turn: runtime.turnSequence, index: insertIndex, message }`.
  `insertIndex` follows the Spec 0002 rules (after the latest user message;
  index 0 for degenerate empty histories).

`every-llm-call` and `off` modes behave exactly as before (no freezing).

## State transitions

```
session_start → turnSequence = 0, mapCapsule = undefined
before_agent_start (turn 1) → turnSequence = 1, mapCapsule = undefined
  context #1 (turn 1) → no frozen record → build → freeze {turn: 1, ...}
  context #2..n (turn 1) → frozen.turn === 1 → reuse, no query
before_agent_start (turn 2) → turnSequence = 2, mapCapsule = undefined
  context #1 (turn 2) → frozen cleared → build → freeze {turn: 2, ...}
session_shutdown / dispose → turnSequence = 0, mapCapsule = undefined
```

Identical user message text across turns now correctly triggers a rebuild,
because the freeze record was cleared by `before_agent_start`.

## Failure behavior

- If the map becomes unavailable mid-turn, the injection branch is skipped; the
  stale frozen record (if any) is cleared at the next `before_agent_start`.
- If `repoMap.query()` throws, the existing honest stale capsule is rendered and
  frozen, keeping the turn stable.
- `before_agent_start` must clear the freeze even when the map is unavailable
  (the clear is unconditional, before the `repoMapAvailable` check).

## Backward compatibility

- Config surface (`mapInjectionMode`) is unchanged.
- Behavior is identical for the normal turn flow (one `before_agent_start` per
  user prompt) except that repeated identical user messages now rebuild instead
  of reusing — the intended fix.
- Tests that simulated a "new turn" by changing the user message text must now
  invoke `before_agent_start` to advance the turn.
- Capsule payload, insertion position, telemetry fields, tool names, and
  persisted state are unchanged.

## Acceptance criteria

1. `before_agent_start` increments `turnSequence` and clears the frozen capsule.
2. Within one turn, the first `context` call builds (one `query`), later calls
   reuse the byte-identical capsule and do not call `query`.
3. After `before_agent_start`, the next `context` call rebuilds even when the
   user message text is identical to the previous turn.
4. Session reset (shutdown/start) resets `turnSequence` and the freeze.
5. `every-llm-call` and `off` modes are unchanged.
6. Telemetry counters continue to reflect builds (capsuleBuildCount) and reuse
   (no extra automatic query count).

## Test cases

In `tests/extension.test.ts`:

1. `advances the turn sequence and clears the frozen capsule on before_agent_start`
   — build in turn 1, fire `before_agent_start`, assert the next `context`
   rebuilds (query called twice) even though the user message text is
   byte-identical.
2. `reuses the frozen capsule within one turn without re-querying` — build,
   then a second `context` in the same turn (no `before_agent_start` in
   between): identical capsule bytes, `query` still called once.
3. `resets the turn sequence and freeze on session lifecycle` — after
   `session_shutdown` + `session_start`, a `before_agent_start` + `context`
   sequence behaves as a fresh session (build happens; no stale reuse).

Updated tests:

- `freezes the map capsule within one user turn and refreshes on the next
  prompt` — the "next prompt" step now fires `before_agent_start` before the
  third `context` call.
- `telemetry: capsule hash change increments across user turns` — fire
  `before_agent_start` between the two turns.
