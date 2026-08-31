# Pi Context Vault

A Pi extension that reduces context pressure **without making tool-result evidence disposable**.

By default, Context Vault archives every eligible external textual tool result. Results larger than 16 KiB can be replaced immediately by small receipts; under context pressure, older archived results can also be virtualized. The agent can recover the evidence through explicit search and retrieval tools.

Context Vault does **not** index repositories or inject repository context. That belongs to [`pi-repo-context`](https://github.com/Fubuyunhua/pi-repo-context).

## Install

Requirements: Node.js `>=22.19.0` and a current Pi installation. Pi core packages are host-provided peers; CI currently tests the extension against Pi `0.84.1`.

Choose a reviewed version from [Releases](https://github.com/Fubuyunhua/pi-context-vault/releases), then replace the placeholder with that tag or commit:

```bash
pi install git:github.com/Fubuyunhua/pi-context-vault@<tag-or-commit>
```

Restart Pi and verify:

```text
/context-vault doctor
/context-vault status
```

No configuration or manual command is required for normal use. Vault handles eligible tool results automatically; the agent calls search/get when archived evidence is needed.

For local development:

```bash
git clone https://github.com/Fubuyunhua/pi-context-vault.git
cd pi-context-vault
npm ci
pi -e ./extensions/index.ts
```

## Core workflow

1. `tool_result` selects eligible external text.
2. Content is sanitized before hashing or persistence.
3. The artifact is stored by content hash with recoverable Observation metadata.
4. Only after archival succeeds may Pi's model-visible copy become a bounded receipt.
5. During pressure reduction, recent unreplaced results stay visible while older archived results can become receipts.
6. Search/get restores only the evidence needed now.

Results from `context_vault_*` and `repo_context_*` tools are not archived again.

| Tool | Purpose |
| --- | --- |
| `context_vault_obs_search` | Ranked search over sanitized evidence; collapses duplicate artifacts and returns compact previews plus executable `nextAction` handoffs. |
| `context_vault_obs_get` | Retrieve a UTF-8-safe byte window by ID/offset, or bounded case-insensitive matching-line excerpts with a literal query. |
| `context_vault_status` | Report lifecycle, storage, reduction, warnings, and bounded telemetry. |

Search defaults to ranked `terms` mode and normalizes common identifier separators (`_`, `-`, `.`, `/`, `\`). `phrase` mode requires a contiguous literal match on one line. The complete model-visible search JSON is capped at 12,288 UTF-8 bytes by default; `maxBytes` accepts 4,096–32,768. Lower-ranked rows or previews are omitted deterministically rather than slicing JSON.

Execute `nextAction` with **all returned arguments unchanged**. It is bounded and centered on matched evidence. Match spans larger than the default 8 KiB retrieval page expose their beginning and may need another bounded `get`.

## Experimental evidence

The latest preregistered comparison included 24 evaluable runs: 3 tasks × 2 repeats × 4 plugin arms. Its clearest result was a retrieval-required pressure task where the authoritative contract was hidden beyond the receipt preview.

| Pressure task | Pass | Avg wall | Avg tokens | Visible prelude |
| --- | ---: | ---: | ---: | ---: |
| NONE | 0/2 | 160s | 133k | 768KB |
| VAULT | 2/2 | 40s | 65k | 48KB |

Across `VAULT+BOTH`, 4/4 pressure runs passed; across `NONE+REPO`, 0/4 passed. All Vault-enabled runs searched archived evidence, and search found the hidden contract in 4/4. Comparing `VAULT` with `NONE`, average wall time fell about 75% and tokens about 51%.

This is a **pressure-specific result**, not a universal efficiency claim. All final patches passed the normal coding tasks, aggregate Vault/no-plugin tokens across all tasks were nearly equal, and there were only two repeats per task/arm. Search previews sometimes sufficed before `get`, so the evidence supports the combined virtualization + search workflow rather than strict get-only causality.

Full methodology, deterministic checks, startup/archive costs, and limitations:

- [POSTFIX-03 model experiment](https://github.com/Fubuyunhua/pi-context-vault/blob/main/docs/diagnostics/PLUGIN-DIAG-12-POSTFIX-03-RESULTS.md)
- [Deterministic comparison](https://github.com/Fubuyunhua/pi-context-vault/blob/main/docs/diagnostics/PLUGIN-DIAG-11-DETERMINISTIC-COMPARISON.md)

## Configuration

Optional project config: `.pi/context-vault.json`.

```json
{
  "reductionEnabled": true,
  "archivePolicy": "all",
  "archiveMinBytes": 16384,
  "replacementThresholdBytes": 16384,
  "archiveErrorsAlways": true,
  "receiptMaxBytes": 4096,
  "hotObservationCount": 6,
  "softContextRatio": 0.75,
  "targetContextRatio": 0.6,
  "projectQuotaBytes": 536870912,
  "retentionDays": 30
}
```

`archivePolicy` is `all`, `errors-and-large`, or `off`. With the default `all`, `archiveMinBytes` does not filter normal text; that threshold applies to `errors-and-large`. Set `archivePolicy: "off"` to stop new archival and new immediate replacements.

`reductionEnabled: false` disables context-pressure reduction only. It does not disable archival-time replacement; use `archivePolicy: "off"` for that. Neither option deletes existing evidence. `archiveThresholdBytes` is a deprecated alias for `replacementThresholdBytes` and cannot be configured with it.

## Operations, storage, and safety

```text
/context-vault status
/context-vault status-json
/context-vault doctor
/context-vault gc
```

State lives outside the project:

```text
${PI_CODING_AGENT_DIR}/context-vault/projects/<projectId>/{artifacts,metadata}
```

`gc` is manual; archival never invokes it automatically. `projectQuotaBytes` is a target for deduplicated artifact payloads, excluding metadata/filesystem overhead. Before retention/quota selection, GC protects artifacts in live leased sessions and receipt references found in the current session's entries/branch.

Safety limits:

- Artifacts are untrusted evidence, not instructions.
- Redaction is best-effort, not a secret-management boundary. Avoid archiving secrets and protect the Pi state directory.
- Uninstalling the extension does not delete evidence.
- Legacy repository settings are inert migration input; Vault never reads, migrates, collects, or deletes repository state.

Split/migration details: [plugin split contract](https://github.com/Fubuyunhua/pi-context-vault/blob/main/docs/specs/0018-plugin-split-contract.md).

## Development

```bash
npm ci
npm run check
npm test
npm run test:coverage
npm run test:package
npm run test:pi
```

Coverage gates: 85% lines, 80% branches.

## License

MIT
