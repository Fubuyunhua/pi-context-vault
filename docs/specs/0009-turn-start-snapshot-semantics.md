# Specification 0009: Turn-start snapshot semantics

Status: Accepted for implementation by GitHub issue #33.

## Problem

The automatic Repo Map capsule is frozen for a user turn, but its payload uses
unqualified fields such as `freshness`, `workspaceRevision`, and `gitHead`.
After a tool edits the workspace, the byte-identical capsule is deliberately
reused for prompt-cache stability. The unqualified names can then be read as a
claim about live workspace state even though they describe only the snapshot
captured before the model began the turn.

The explicit `context_vault_repo_map` tool is different: it follows the live
query path and can be used after edits to obtain current state.

## Required automatic capsule semantics

A frozen automatic capsule has:

- `captureSemantics: "turn-start-snapshot"`;
- a description that says the data was captured at turn start and does not
  reflect later tool edits;
- `freshnessAtCapture`, `workspaceRevisionAtCapture`,
  `generationAtCapture`, `gitHeadAtCapture`, and `pendingFilesAtCapture` in
  place of unqualified live-sounding field names.

The custom message `details` use the same capture marker and capture-time field
names. They must not retain unqualified `freshness` or `workspaceRevision`
fields.

The first context hook invocation in a turn renders these fields from one
coherent Repo Map query. Later context hook invocations in that user turn
reinsert the already-frozen custom message. They do not rerender it, query the
map, or update any capture-time field after tool edits.

At the next `before_agent_start`, the existing turn-sequence behavior clears
the frozen capsule. The first context invocation for the new turn builds a new
snapshot from the then-current Repo Map state.

The legacy `every-llm-call` automatic mode does not freeze at turn start. Its
capsules use the same capture-time field naming but identify themselves as
`context-call-snapshot`, avoiding a false turn-start claim.

## Bounded, minimal, and error capsules

All automatic rendering paths use capture semantics:

- Normal bounded capsules include all five capture-time state fields.
- Capsules whose query result carries an error retain the capture marker,
  capture-time state fields, fallback evidence, and bounded error text.
- A query exception is represented as a stale turn-start snapshot whose
  generation is `0`, whose Git head and workspace revision are `unavailable`,
  and whose pending-file list is empty; these are explicitly capture-time
  values rather than live claims.
- The 512-byte minimal form retains `captureSemantics`, a compact non-live
  description, freshness, workspace revision, generation, and Git head at
  capture. Because file paths cannot be retained safely at that budget, it
  reports `pendingFileCountAtCapture`. It also retains a bounded query error
  whenever one was captured.

The existing maximum-byte limit remains authoritative. Result entries,
pending paths, fallback excerpts, query/error text, revision, and Git head are
reduced before or within the valid minimal form. After all reductions,
`truncatedFields` names every affected field, including revision, head, query,
error, evidence, and results.

## Freeze and prompt-cache invariants

This specification does not change:

- insertion immediately after the latest user message in
  `once-per-user-turn` mode;
- byte-identical custom-message reuse within a turn;
- the one-query/one-render freeze behavior;
- automatic capsule telemetry and size limits;
- head-of-history placement in `every-llm-call` mode; or
- `off` mode.

Thus the automatic capsule remains in the same prompt-cache-friendly position
and within the configured `mapContextMaxBytes` bound.

## Explicit tool compatibility

The `context_vault_repo_map` tool schema, description, and result are
unchanged. It continues to call the live `query` path and returns the existing
unqualified live fields (`freshness`, `workspaceRevision`, `generation`,
`gitHead`, and `pendingFiles`). It does not add `captureSemantics` or rename
those fields.

## Acceptance criteria

1. The first frozen capsule of a turn identifies itself as a
   `turn-start-snapshot` and uses capture-time field names and a non-live
   description.
2. A later workspace mutation in the same turn does not change capsule bytes
   or trigger another automatic query.
3. The next user turn rebuilds the capsule and exposes the new state under
   capture-time field names.
4. Bounded, minimal, and query-error capsules retain honest capture semantics
   and stay within the configured byte bound.
5. The explicit Repo Map tool remains on the live query path with its existing
   result schema.
6. Capsule placement, within-turn reuse, and telemetry behavior remain
   unchanged.
