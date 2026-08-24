# pi-context-vault

Recoverable observation storage and a revision-aware repository map for Pi.

> **Current `main`: v0.2.0 release-candidate metadata (untagged).** The latest immutable release tag is
> [`v0.1.2`](https://github.com/Fubuyunhua/pi-context-vault/releases/tag/v0.1.2). Use that tag for a stable install;
> use a reviewed development checkout to evaluate the release candidate. No `v0.2.0` tag exists yet.

[中文说明](./README.zh-CN.md) · [Research and rationale](./deepResearch.md) ·
[v0.1 specification](./docs/specs/0001-v0.1.md) · [v0.2.0 RC notes](./docs/releases/v0.2.0.md) ·
[historical v0.1.0 release notes](./docs/releases/v0.1.0.md)

## What it does

- Sanitizes and archives every eligible textual tool result. Large results are replaced only after durable storage
  with a bounded receipt that the agent can retrieve later. If persistence fails, the original result stays visible.
- Replaces older archived observations in Pi's non-persistent model view when context pressure crosses the configured
  threshold. Canonical session chronology and tool-call/tool-result pairs are preserved.
- Maintains a TS/JS repository map of paths, lexical terms, imports, exports, top-level symbols, and signatures.
  `.java` files additionally receive deterministic AST indexing for packages, imports, declarations, members,
  annotations, generics, and syntactic type relationships.
- Watches agent and external filesystem changes, reconciles Git HEAD plus dirty files, and atomically activates
  revisioned map generations.
- Injects only a small task-relevant map capsule. Every capsule identifies its workspace revision and freshness; a
  stale map carries fallback evidence instead of pretending to be current.
- Stores generated state outside the project tree by default and isolates it by canonical project path.

## Requirements

- Node.js 22.19 or newer (`node --version`).
- Pi `@earendil-works/pi-coding-agent` 0.84.x (`pi --version`).
- Git for installing from GitHub. Git-backed projects also get HEAD/diff-aware map freshness; non-Git directories
  still receive filesystem and lexical/semantic indexing.
- Network access to GitHub for the tagged installation command.

Pi extensions execute with your operating-system permissions. Review extension source before installation.

## Install

### User installation (recommended)

Install the latest immutable tag, v0.1.2, once for your Pi user profile. The v0.2.0 release candidate is not a tag
and must not be installed by inventing an `@v0.2.0` source.

```bash
pi install git:github.com/Fubuyunhua/pi-context-vault@v0.1.2
```

Verify that Pi recorded the exact source:

```bash
pi list
```

The output should include:

```text
git:github.com/Fubuyunhua/pi-context-vault@v0.1.2
```

Restart Pi after installation. The extension is then available in every project.

### Project-local installation

To enable the package only through a project's `.pi/settings.json`, run this from that project:

```bash
pi install git:github.com/Fubuyunhua/pi-context-vault@v0.1.2 -l
```

Project-local resources are subject to Pi's project-trust policy. Review them and approve the project when Pi asks.
The `-l` setting is project-local, but Context Vault's generated artifacts and map state still remain outside the
working tree.

### Development checkout

Load a checkout for one Pi invocation without installing it:

```bash
npm ci
pi -e /absolute/path/to/pi-context-vault/extensions/index.ts
```

Use the extension entry file shown above; passing only the repository directory is not required for `-e`.

Current `main` carries v0.2.0 release-candidate metadata but remains untagged. To evaluate it, review and check out
`main`, run `npm ci`, and use this development-checkout command. Tagged users should remain on v0.1.2 until an
immutable v0.2.0 tag is actually created.

## First run and health check

Start Pi from the repository you want Context Vault to manage:

```bash
cd /path/to/your/project
pi
```

In the Pi TUI, run:

```text
/context-vault doctor
/context-vault status
```

A healthy startup shows `vault v0.1.0` for the immutable v0.1.2 tag (a historical metadata mismatch) or
`vault v0.2.0` for the current untagged release-candidate checkout. `doctor` should report `healthy`, an initialized
Observation component, a usable Repo Map, and `stateOutsideProjectTree: true`. The first map build can take longer in
large repositories.

`degraded` does not crash Pi. It means a component could not persist, watch, parse, or activate some state. Inspect
the `failures` and component `error` fields, fix the cause, and run `/context-vault rebuild` when the problem concerns
the map.

## Everyday usage

Context Vault is automatic after startup:

1. Text returned by tools such as `read` or `bash` is checked against `archivePolicy`, then eligible results are sanitized and archived.
2. An archived result at or below `replacementThresholdBytes` remains unchanged in the conversation and is searchable.
3. A larger eligible result is replaced with a JSON receipt only after archival succeeds.
4. When estimated context usage crosses `softContextRatio`, older archived tool results become receipts in the
   model-visible copy; the newest `hotObservationCount` results remain hot.
5. Before model calls and explicit map queries, the Repo Map checks pending filesystem changes and Git HEAD.
6. The agent can search or retrieve archived evidence and query a small, current map slice on demand.

You normally ask the agent in plain language. Examples:

```text
Use context_vault_repo_map to find the authentication entry points and their exported symbols.
Search archived bash observations for the failing test name, then retrieve the matching evidence.
Call context_vault_status and explain any degraded component.
```

### Observation receipts

A large tool result is replaced by a bounded JSON object similar to:

```json
{
  "type": "context_vault_observation_receipt",
  "id": "obs_<24-hex-characters>",
  "hash": "<sha256>",
  "tool": "bash",
  "originalBytes": 120000,
  "sanitizedBytes": 119940,
  "redactions": 2,
  "error": false,
  "evidence": {
    "artifactId": "<sha256>",
    "byteOffset": 0,
    "preview": "..."
  }
}
```

Keep the `obs_...` ID in task notes when the evidence may be needed later. Retrieval remains available until the
artifact is removed by an explicit garbage-collection policy or the state directory is deleted.

## Model-facing tools

These are LLM tools, not slash commands. The agent chooses them automatically, or you can explicitly ask it to call
one with the shown arguments.

### `context_vault_obs_get`

Retrieve one archived observation by its `obs_...` ID or 64-character artifact hash.

```json
{ "id": "obs_<24-hex-characters>", "offset": 0, "limit": 8192 }
```

Without `query`, `offset` and `limit` select a UTF-8 byte range; `limit` is capped at 32768 bytes. The response keeps
`byteOffset`/`requestedByteOffset` as the requested position and reports the UTF-8-aligned half-open range as
`byteStart` and `byteEnd`; use `byteEnd` to request the next page. With `query`, the tool searches complete sanitized
lines before returning match-centered bounded excerpts, `offset` is the match offset, and at most 20 matches are returned.

```json
{ "id": "obs_<24-hex-characters>", "query": "TypeError", "offset": 0, "limit": 10 }
```

### `context_vault_obs_search`

Search all sanitized observation text for the current project. `toolName` is optional and `limit` is capped at 20.

```json
{ "query": "failing test", "toolName": "bash", "limit": 5 }
```

### `context_vault_repo_map`

Return up to 20 ranked files with matched symbols, signatures, dependencies, Git HEAD, workspace revision, pending
paths, and freshness.

```json
{ "query": "authentication token refresh", "limit": 8 }
```

Java queries rank structured declarations above comments and incidental references. For example:

```json
{ "query": "UserController createUser UserRepository", "limit": 8 }
```

Java semantic entries include package/import evidence; class, interface, enum, record, and annotation declarations;
nested types; constructors, methods, fields, and enum constants; annotations, modifiers, generic parameters, source
lines, and `extends`/`implements`/`permits` relationships. The relationships are syntax-level navigation evidence,
not compiler-resolved types or a call graph. Malformed or unsupported Java falls back to lexical indexing with a
bounded parse warning and reports `unsupported` rather than claiming fresh semantics.

Freshness meanings:

- `fresh`: the indexed workspace is clean for the reported Git HEAD.
- `dirty`: tracked or untracked workspace changes are included in the reported revision.
- `stale`: an update or activation failed; use the included source/Git fallback evidence and verify with direct reads.
- `unsupported`: the generation is usable, but one or more files required lexical/degraded handling.

### `context_vault_status`

Takes no arguments. It reports extension version, project/state identity, archive/replacement counters, map generation,
freshness, pending/dirty files, and bounded failure records.

## Operator command

Context Vault registers one slash command with four subcommands:

```text
/context-vault status
/context-vault rebuild
/context-vault gc
/context-vault doctor
```

- `status` is read-only and reports runtime/component state.
- `rebuild` performs a full repository-map rebuild and atomically activates a new generation. Use it after repairing
  permissions, invalid configuration, or a stale map. It does not modify project source files.
- `gc` applies `retentionDays` and `projectQuotaBytes` to archived evidence. Artifacts referenced by the active session
  tree/current branch, plus metadata for every live project-local session lease, are protected; quota is reported
  unsatisfied rather than deleting them.
- `doctor` adds an overall `healthy`/`degraded` result and verifies that generated state is outside the project tree.

Command results are shown as Pi UI notifications. Unknown subcommands display usage and do not mutate state.

## Configuration

Create `.pi/context-vault.json` in the project root. Every key is optional. Unknown keys, malformed JSON, invalid
types, and out-of-range values cause explicit degraded initialization instead of silently changing policy.

```json
{
  "archivePolicy": "errors-and-large",
  "archiveMinBytes": 16384,
  "replacementThresholdBytes": 32768,
  "archiveErrorsAlways": true,
  "receiptMaxBytes": 4096,
  "hotObservationCount": 8,
  "softContextRatio": 0.75,
  "targetContextRatio": 0.6,
  "projectQuotaBytes": 536870912,
  "retentionDays": 30,
  "mapContextMaxBytes": 6144,
  "mapDebounceMs": 300,
  "mapExcludePatterns": ["generated/**", "vendor/**"]
}
```

| Key | Default | Validation and effect |
|---|---:|---|
| `archivePolicy` | `"all"` | `all`, `errors-and-large`, or `off`; decides eligibility before storage. |
| `archiveMinBytes` | `16384` | Non-negative safe integer; inclusive large-result boundary for `errors-and-large`. |
| `replacementThresholdBytes` | `16384` | Positive safe integer; archived results strictly above it become receipts. |
| `archiveErrorsAlways` | `true` | Archives short errors under `errors-and-large`; never overrides `off`. |
| `archiveThresholdBytes` | — | Deprecated alias for `replacementThresholdBytes`; configuring both is an error. |
| `receiptMaxBytes` | `4096` | Integer at least 512; maximum immediate/historical receipt bytes. |
| `hotObservationCount` | `6` | Positive integer; newest tool results kept during historical reduction. |
| `softContextRatio` | `0.75` | Number strictly between 0 and 1; estimated reduction trigger. |
| `targetContextRatio` | `0.6` | Number strictly between 0 and 1 and lower than `softContextRatio`. |
| `projectQuotaBytes` | `536870912` | Positive integer; artifact quota applied by `/context-vault gc`. |
| `retentionDays` | `30` | Positive integer; retention applied by `/context-vault gc`. |
| `mapContextMaxBytes` | `6144` | Integer at least 512; hard byte bound for the injected map capsule. |
| `mapDebounceMs` | `300` | Positive integer; delay before a pending map batch is reconciled. |
| `mapExcludePatterns` | `[]` | Array of non-empty project-relative glob patterns. |

`.git`, `.pi`, `.gradle`, `node_modules`, `dist`, `build`, and `target` path segments are always excluded from the map.
Configuration is read at session startup; restart Pi after changing it.

## State, privacy, and recovery

By default, state is stored at:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/context-vault/projects/<project-id>/
├── artifacts/                  # sanitized, content-addressed text shards
├── metadata/
│   └── observations.jsonl
└── repo-map/
    ├── active.json             # atomic active-generation pointer
    └── generations/
```

`project-id` is the first 32 hexadecimal characters of SHA-256 over the canonical real project path. Symlink aliases
therefore share state, while different projects are isolated. Run `/context-vault doctor` before uninstalling if you
need the exact `stateRoot` path.

Common tokens, credentials, private keys, bearer headers, and credential-bearing URLs are redacted before hashing and
persistence. Detection is heuristic: do not treat the state directory as a public export or a substitute for normal
secret-handling controls. Repository content, retrieved observations, and map capsules remain untrusted input.

State writes use same-directory temporary files, `fsync`, atomic rename, owner-aware locks, and atomic map-generation
activation. Corrupt configuration, observation metadata, and active map metadata are rejected rather than partially
trusted. A failed archive leaves the original tool result in model context (fail-open for evidence preservation).

## Update, disable, and uninstall

An immutable tag does not move. To upgrade when a newer tag exists, remove the exact old source and install the exact
new source, then restart Pi:

```bash
pi remove git:github.com/Fubuyunhua/pi-context-vault@v0.1.2
pi install git:github.com/Fubuyunhua/pi-context-vault@<new-tag>
```

For a project-local installation, add `-l` to both commands. For an intentionally unpinned source, Pi also supports
`pi update <source>`; do not expect it to change a pinned tag.

Use `pi config` to enable or disable installed package resources. To uninstall v0.1.2:

```bash
pi remove git:github.com/Fubuyunhua/pi-context-vault@v0.1.2
```

`pi uninstall` is an alias for `pi remove`. Removal does not delete archived observations or Repo Map state. This is
intentional recovery behavior. If you also want to erase state, first record the exact `stateRoot` from
`/context-vault doctor`, stop all Pi sessions using the project, inspect that exact directory, and delete only that
project-specific path.

## Troubleshooting

### The extension does not appear

1. Run `pi list` and confirm the exact tagged source is present.
2. Restart Pi after installation.
3. For a local installation, ensure the current project is trusted or rerun the install with `--approve` after review.
4. Run Pi in the intended project root and try `/context-vault doctor`.

### Status is degraded

- Read `failures` and each component's `error` field.
- Validate `.pi/context-vault.json`; unknown keys and invalid ranges are rejected.
- Confirm that `PI_CODING_AGENT_DIR` and the reported `stateRoot` are writable.
- For a map failure, repair the cause and run `/context-vault rebuild`.
- `unsupported` can mean a file fell back to lexical indexing; verify important facts from source and tests.

### A large output was not replaced

- Replacement occurs only for archived results whose UTF-8 bytes are greater than `replacementThresholdBytes`.
- `archivePolicy` may leave an output unarchived; it then remains visible but is not searchable or reducible by Context Vault.
- Image-only results and Context Vault's own tool results are not re-archived.
- If archival fails, the original result is deliberately preserved; check `context_vault_status` for failures.

### An observation cannot be found

- Use the receipt's `id`, not a shortened value, or use its full 64-character artifact hash.
- Search is project-scoped; start Pi in the same canonical project.
- Evidence removed by `/context-vault gc` or manual state deletion cannot be reconstructed from a receipt alone.
- Corrupt metadata fails closed. Preserve the state directory before attempting manual recovery.

### The map misses a recent edit

Call `context_vault_repo_map` or run `/context-vault rebuild`, then inspect `freshness`, `pendingFiles`, and
`workspaceRevision`. Check built-in exclusions and `mapExcludePatterns`. Treat `stale` results only as navigation hints
and verify with direct `read`, search, `git diff`, and tests.

## Limits and non-goals

- The extension reduces model-visible context but cannot guarantee that the final serialized provider request fits
  the model input limit. Pi core owns that final hard-invariant boundary.
- v0.1.0 does not provide embeddings, a complete cross-language call graph, typed long-term memory, automatic Git
  commits, or tool-episode subagents.
- The v0.1.0 tag semantically indexes TS, TSX, JS, JSX, MTS, CTS, MJS, and CJS. v0.1.2 and current `main` also
  semantically index Java without invoking Maven, Gradle, `javac`, annotation processors, or repository code. They do
  not perform type solving, method-body call graphs, dependency resolution, or Lombok member inference. Other text files receive
  lexical indexing; unsupported or malformed source is explicitly degraded.
- `.git`, `.pi`, `.gradle`, `node_modules`, `dist`, `build`, and `target` path segments are always excluded from the
  map. Java source symlinks are not followed.
- Repository maps are navigation indexes, not authoritative summaries or substitutes for source inspection and tests.
- Incremental reconciliation reindexes when filesystem fingerprints are coarse or incomplete and otherwise uses size,
  inode/device identity, and nanosecond timestamps. A metadata-preserving content rewrite with no watcher event can still
  evade detection until another event or an explicit rebuild; this is unavoidable without rereading and hashing every file.
- Secret redaction reduces accidental persistence risk but cannot prove that arbitrary sensitive data was detected.

## Development and acceptance

```bash
npm ci
npm run ci
npm run test:watcher
```

`npm run ci` performs type/lint checks, the coverage-gated full test suite (85% lines and 80% branches), and an
isolated Pi package-install smoke. GitHub Actions runs the full suite on Linux with Node 22.19 and 24, plus package and
real-watcher smokes on macOS and Windows.

Development uses independently accepted GitHub slices. Each slice begins with an issue and acceptance criteria and
closes only after its tests pass and its pull request is merged.

## License

MIT
