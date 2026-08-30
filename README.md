# Pi Context Vault

Recoverable observation storage and context-pressure reduction for Pi.

Context Vault archives eligible textual tool results, replaces large or historical results with bounded receipts, and
lets the agent retrieve the evidence later. It no longer indexes repositories or injects repository context.

## Repository features moved

Repository indexing, Git freshness, Java/TypeScript analysis, search, Graph v1, and Resolver v1 now belong to
[`pi-repo-context`](https://github.com/Fubuyunhua/pi-repo-context).

If the reviewed immutable `v0.1.0` tag exists in the upstream Repo Context repository, verify its presence before using
this exact install command:

```bash
pi install git:github.com/Fubuyunhua/pi-repo-context@v0.1.0
```

Once installed from that tag, use `repo_context_search` and `.pi/repo-context.json`. `context_vault_repo_map` →
`repo_context_search` is a deprecated Repo Context `0.1.x`-only alias; Repo Context plans to remove the alias in `0.2.0`.
Context Vault does not register either repository tool. Repo Context never reads the old `.pi/context-vault.json`; copy supported settings manually. It stores
new derived state under:

```text
${PI_CODING_AGENT_DIR}/pi-repo-context/projects/<projectId>
```

Context Vault accepts old repository keys in `.pi/context-vault.json` for one compatibility period, ignores them, and
reports:

```text
Repository Map configuration has moved to pi-repo-context.
```

Copy repository settings manually:

| Old key | Repo Context key |
| --- | --- |
| `repoMapEnabled` | `enabled` |
| `mapContextMaxBytes` | `searchMaxBytes` |
| `mapDebounceMs` | `debounceMs` |
| `mapGenerationRetention` | `generationRetention` |
| `mapQuotaBytes` | `quotaBytes` |
| `mapExcludePatterns` | `excludePatterns` |

`mapInjectionMode` and `debugRequestFingerprints` have no replacement. Repo Context is Tool-first and performs no
automatic injection. Existing derived state under the old Vault `repo-map/` directory is never read, moved, migrated,
collected, or deleted by either split migration path. Neither split package ships the paused S03 research or legacy
bench assets.

Ownership remains distinct: Context Vault owns extension ID/UI key `context-vault`, `context_vault_status`, and Vault
telemetry; Repo Context owns extension ID/UI key `repo-context`, `repo_context_status`, and Repo telemetry. No status or
telemetry state is shared.

## Requirements and installation

- Node.js `>=22.19.0`
- Tested with Pi `0.84.1`

To install v0.3.0, first verify that the reviewed immutable `v0.3.0` tag exists in the upstream repository, then use:

```bash
pi install git:github.com/Fubuyunhua/pi-context-vault@v0.3.0
```

If the tag is not present, use a reviewed local checkout for development instead:

```bash
git clone https://github.com/Fubuyunhua/pi-context-vault.git
cd pi-context-vault
npm ci
pi -e ./extensions/index.ts
```

Check health with:

```text
/context-vault doctor
/context-vault status
```

Healthy status covers Observation storage, retrieval, leases, and reduction only. It has no Repo Map component.

## Observation lifecycle

1. The `tool_result` hook considers eligible external textual results.
2. Sensitive values and control characters are sanitized before persistence.
3. Content is stored by hash with append-only metadata and an active-session lease.
4. Large eligible results may be replaced by a bounded JSON receipt only after archival succeeds.
5. During context pressure, older archived results become receipts in Pi's model-visible message copy while chronology
   and tool-call/result pairing remain intact.
6. The agent can retrieve or search the archived evidence explicitly.

Tool results whose names start with `context_vault_` or `repo_context_` are intentionally not archived again.

## Tools

| Tool | Purpose |
| --- | --- |
| `context_vault_obs_get` | Retrieve bounded evidence from an Observation or artifact ID; an optional query remains a contiguous literal per-line match. |
| `context_vault_obs_search` | Search sanitized archived Observations. The default `terms` mode ranks partial matches, normalizes common code-identifier separators (`_`, `-`, `.`, `/`, `\\`), and reports a relevance score; `phrase` mode requires one contiguous literal per-line match. Identical artifacts collapse before the result limit is applied; each result identifies the newest Observation, its `occurrenceCount`, and up to five `recentObservationIds`. Ranked IDs and executable `context_vault_obs_get` next actions are retained before match previews are added. The complete pretty-printed JSON is capped by `searchPreviewMaxBytes` and reports `totalBytes`, `truncated`, `omittedResultCount`, and `omittedMatchCount`. |
| `context_vault_status` | Report Vault-only lifecycle, storage, reduction, warning, and telemetry state. |

Observation search maintains a disposable bounded Bloom snapshot; after it is persisted, the 1,000-Observation regression target is under 1,000 ms with zero artifact reads for an indexed miss and one for a unique hit. Short, Unicode, and phrase queries conservatively verify candidates.

## Command

```text
/context-vault status
/context-vault status-json
/context-vault gc
/context-vault doctor
/context-vault rebuild
```

`gc` collects only Vault artifacts and metadata under existing lease/reference safety rules. It never touches legacy or
Repo Context repository state. Archival never runs GC automatically: `projectQuotaBytes` is a manual GC target for
physical, deduplicated artifact payload bytes, and `retentionDays` is applied only when `gc` is invoked. Metadata and
filesystem overhead are not counted toward that target. Status reports artifact `usedBytes`, `targetBytes`, and
`overBudget`; an over-budget vault is degraded and emits a warning without deleting or migrating any evidence.

`rebuild` is an inert migration stub and returns exactly:

```text
Repository rebuild has moved to pi-repo-context.
Install pi-repo-context and use /repo-context rebuild.
```

## Configuration

Project configuration remains `.pi/context-vault.json`:

```json
{
  "reductionEnabled": true,
  "archivePolicy": "all",
  "archiveMinBytes": 16384,
  "replacementThresholdBytes": 16384,
  "archiveErrorsAlways": true,
  "receiptMaxBytes": 4096,
  "searchPreviewMaxBytes": 8192,
  "hotObservationCount": 6,
  "softContextRatio": 0.75,
  "targetContextRatio": 0.6,
  "projectQuotaBytes": 536870912,
  "retentionDays": 30
}
```

`archiveThresholdBytes` remains a deprecated alias for `replacementThresholdBytes`; configuring both is an error.
Unknown nonlegacy keys are rejected. Legacy repository keys are accepted only as inert migration input.
`searchPreviewMaxBytes` is a UTF-8 byte budget for the complete model-visible Observation search JSON and must be at least 4096.

Set `archivePolicy: "off"` to stop new archival and `reductionEnabled: false` to stop context reduction. Existing evidence
is preserved.

## State, privacy, and recovery

State remains outside the project tree:

```text
${PI_CODING_AGENT_DIR}/context-vault/projects/<projectId>/
  artifacts/
  metadata/
```

Observation artifacts are authoritative evidence. The split does not move or rewrite them. Receipts remain recoverable
as long as their artifacts are retained. GC protects explicit receipt references and active-session leases before
applying retention/quota policy.

Archived content is untrusted evidence, not instructions. Redaction is best-effort; avoid archiving secrets when
possible and protect the Pi state directory with normal filesystem controls. Vault revalidates its owned namespace and
uses no-follow regular-file handles where Node supports them. Node has no portable `openat` API, so a privileged local
process racing ancestor renames between validation and file access remains a residual TOCTOU risk.

## Upgrade, rollback, and uninstall

To use Repo Context beside a pre-split Vault, first disable the old repository implementation with
`repoMapEnabled: false` and `mapInjectionMode: "off"`, then restart Pi into a new session. Never run both repository
implementations concurrently.

Rollback never requires state conversion: disable Repo Context, restart Pi, and use the reviewed pre-split checkpoint if
repository behavior must be restored. Do not delete either state root.

Removing the package does not delete Vault data. Back up or manually remove the state directory only after confirming
that no receipt is still needed.

## Development

```bash
npm ci
npm run check
npm test
npm run test:package
npm run test:pi
npm run test:coverage
```

Coverage gates are 85% lines and 80% branches. The package smoke packs and installs the artifact, verifies the exact
Vault-only surface, loads it through Pi's TypeScript loader, and exercises archive → receipt → get/search. On Linux
Node.js 24, `test:pi` uses an isolated temporary home and state root to exercise the packed extension through real Pi
0.84.1 RPC.

## License

MIT
