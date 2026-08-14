# pi-context-vault

Recoverable observation storage and a revision-aware repository map for Pi.

> v0.1.0 targets Node.js 22.19 or newer, `@earendil-works/pi-coding-agent` 0.84.x, and
> TypeScript/JavaScript repositories.

[中文说明](./README.zh-CN.md) · [Research and rationale](./deepResearch.md) ·
[v0.1 specification](./docs/specs/0001-v0.1.md) · [v0.1.0 release notes](./docs/releases/v0.1.0.md)

## What ships in v0.1.0

- Every eligible external textual tool result is sanitized and archived (Context Vault's own tools are excluded).
  Results larger than `archiveThresholdBytes` are replaced only after durable storage with a bounded, retrievable
  receipt; non-text blocks are preserved.
- Old archived observations can be replaced by receipts in Pi's non-persistent `context` view while the canonical
  session chronology and tool-call/tool-result envelope remain unchanged.
- A TS/JS repository map indexes paths, lexical terms, imports, exports, top-level symbols, and signatures. A real
  filesystem watcher invalidates every relevant edit, performs a fast file update, and atomically activates a
  revisioned generation after reconciliation.
- Each model-visible map capsule is bounded, non-persistent, marked as untrusted derived navigation data, and carries
  freshness, workspace revision, pending files, and explicit fallback evidence when stale.
- Generated state stays outside the project tree by default and is isolated by the canonical project path.

## Installation

Install the immutable v0.1.0 Git tag:

```bash
pi install git:github.com/Fubuyunhua/pi-context-vault@v0.1.0
```

During development, load a checkout directly:

```bash
pi -e /absolute/path/to/pi-context-vault
```

Review extension source before installation: Pi extensions execute with your operating-system permissions.

## Pi interfaces

Tools:

| Tool | Purpose |
|---|---|
| `context_vault_obs_get` | Retrieve a bounded byte range or matching lines from an observation/artifact ID. |
| `context_vault_obs_search` | Search sanitized archived observations, optionally filtered by tool name. |
| `context_vault_repo_map` | Query a small ranked repository-map slice with revision and freshness metadata. |
| `context_vault_status` | Report lifecycle, observation, map, and degraded-component status. |

Command:

```text
/context-vault status
/context-vault rebuild
/context-vault gc
/context-vault doctor
```

`rebuild` performs an explicit full map rebuild, `gc` applies retention and quota policy, and `doctor` reports health
and whether state is outside the project tree. Unknown subcommands return usage instead of mutating state.

## Configuration

Create `.pi/context-vault.json` in the project root. Every key is optional; unknown or invalid keys fail initialization
with a degraded status instead of silently changing policy.

| Key | Default | Meaning |
|---|---:|---|
| `archiveThresholdBytes` | `16384` | Replace a larger archived tool result with a receipt. |
| `receiptMaxBytes` | `4096` | Maximum immediate/historical observation receipt size. |
| `hotObservationCount` | `6` | Newest tool results retained during historical reduction. |
| `softContextRatio` | `0.75` | Conservative estimated-context reduction trigger. |
| `targetContextRatio` | `0.6` | Target after a reduction batch; must be below the soft ratio. |
| `projectQuotaBytes` | `536870912` | Per-project artifact quota used by `gc`. |
| `retentionDays` | `30` | Artifact retention used by `gc`. |
| `mapContextMaxBytes` | `6144` | Maximum injected repository-map capsule size. |
| `mapDebounceMs` | `300` | Delay before a batch is reconciled and atomically activated. |
| `mapExcludePatterns` | `[]` | Additional repository-relative glob exclusions. |

Example:

```json
{
  "archiveThresholdBytes": 32768,
  "hotObservationCount": 8,
  "mapExcludePatterns": ["generated/**", "vendor/**"]
}
```

## State and security

State is stored at:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/context-vault/projects/<sha256-of-canonical-project-path>/
├── artifacts/
├── metadata/
└── repo-map/
    ├── active.json
    └── generations/
```

Secret redaction runs before hashing and persistence for common tokens, credentials, private keys, bearer headers,
and credential-bearing URLs. Artifact IDs and repository-map paths are validated against traversal; state writes and
generation activation are atomic; concurrent writers use file locks. Corrupt metadata is rejected rather than
partially trusted. Secret detection is heuristic, so do not treat the state directory as a public export.

Repository contents, retrieved observations, and map capsules remain untrusted data. A stale map never claims
freshness: it returns source/Git fallback evidence and directs the agent to direct reads, search, or `git diff`.

## Limits and non-goals

- This extension reduces model-visible context, but cannot guarantee that the final serialized provider request fits
  the model input limit. Pi core owns that final hard-invariant boundary.
- v0.1.0 does not provide embeddings, a complete call graph, typed long-term memory, automatic Git commits, or
  tool-episode subagents.
- Semantic indexing covers TS, TSX, JS, JSX, MTS, CTS, MJS, and CJS. Other text files receive lexical indexing;
  unsupported or malformed source is explicitly degraded.
- Secret redaction minimizes accidental persistence but cannot prove that arbitrary sensitive data was detected.

## Development and acceptance

```bash
npm ci
npm run ci
```

`npm run ci` performs type/lint checks, the coverage-gated full test suite (85% lines and 80% branches), and a Pi
package-install smoke. GitHub Actions runs the full suite on Linux with Node 22.19 and 24, plus package and real-watcher
smokes on macOS and Windows.

Development uses independently accepted GitHub slices. Each slice begins with an issue and acceptance criteria and
closes only after its tests pass and its pull request is merged.

## License

MIT
