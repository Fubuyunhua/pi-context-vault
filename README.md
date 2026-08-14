# pi-context-vault

Recoverable observation storage and a revision-aware repository map for Pi.

> Status: v0.1 is under active development. The first release targets
> `@earendil-works/pi-coding-agent` 0.84.x and TypeScript/JavaScript repositories.

[中文说明](./README.zh-CN.md) · [Research and rationale](./deepResearch.md) · [v0.1 specification](./docs/specs/0001-v0.1.md)

## Planned v0.1 capabilities

- Archive tool observations before replacing large results with compact, retrievable receipts.
- Search and rehydrate archived observations through Pi tools.
- Maintain a TS/JS repository map tied to the current Git HEAD and dirty workspace state.
- Refresh affected map nodes after edits and expose freshness metadata to the model.
- Store all generated state outside the project working tree by default.

## Installation

During development, load the local checkout:

```bash
pi -e /absolute/path/to/pi-context-vault
```

After v0.1.0 is released:

```bash
pi install git:github.com/Fubuyunhua/pi-context-vault@v0.1.0
```

## Development

```bash
npm install
npm run ci
```

Development is organized as independently tested GitHub slices. Each slice starts with an issue and acceptance
criteria, is implemented in a short-lived branch, and is closed only after its tests and PR acceptance pass.

## Explicit non-goals for v0.1

- Guaranteeing that the final provider payload can never exceed the model input limit. Pi core must enforce that invariant.
- Embeddings, full cross-language call graphs, automatic Git commits, typed long-term memory, or subagents.
- Persisting unredacted secrets from tool output.

## Security

Pi extensions run with the user's operating-system permissions. Review the source before installing. Context Vault
will treat repository and tool content as untrusted data and will redact recognized secrets before persistence.

## License

MIT
