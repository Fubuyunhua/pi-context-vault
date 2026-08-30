# Pi Context Vault

面向 Pi 的可恢复 Observation 存储与上下文压力削减插件。

Context Vault 会归档符合条件的文本 Tool Result，把较大或较旧结果替换为有界 receipt，并允许 Agent 稍后恢复证据。它不再建立仓库索引，也不再自动注入仓库上下文。

## 仓库能力已经迁出

仓库索引、Git freshness、Java/TypeScript 分析、搜索、Graph v1 和 Resolver v1 现在属于
[`pi-repo-context`](https://github.com/Fubuyunhua/pi-repo-context)。

如果经过审核的不可变 `v0.1.0` tag 存在于 Repo Context 上游仓库中，请先验证其存在，再使用以下精确安装命令：

```bash
pi install git:github.com/Fubuyunhua/pi-repo-context@v0.1.0
```

从该 tag 安装后，请使用 `repo_context_search` 和 `.pi/repo-context.json`。`context_vault_repo_map` →
`repo_context_search` 是仅限 Repo Context `0.1.x` 的 deprecated alias；Repo Context 计划在 `0.2.0` 删除该 alias。
Context Vault 不注册这两个仓库 Tool。Repo Context 绝不会读取旧 `.pi/context-vault.json`；受支持的配置必须手工复制。
新派生状态位于：

```text
${PI_CODING_AGENT_DIR}/pi-repo-context/projects/<projectId>
```

Context Vault 会在一个兼容周期内接受 `.pi/context-vault.json` 中的旧仓库字段，忽略它们，并报告：

```text
Repository Map configuration has moved to pi-repo-context.
```

配置需手工迁移：

| 旧字段 | Repo Context 字段 |
| --- | --- |
| `repoMapEnabled` | `enabled` |
| `mapContextMaxBytes` | `searchMaxBytes` |
| `mapDebounceMs` | `debounceMs` |
| `mapGenerationRetention` | `generationRetention` |
| `mapQuotaBytes` | `quotaBytes` |
| `mapExcludePatterns` | `excludePatterns` |

`mapInjectionMode` 和 `debugRequestFingerprints` 没有对应字段。Repo Context 采用 Tool-first，不自动注入。旧 Vault
`repo-map/` 目录中的派生状态不会在拆分过程中被读取、移动、迁移、GC 或删除。两个拆分 package 都不会发布暂停的
S03 研究或 legacy bench assets。

所有权保持独立：Context Vault 拥有 extension ID/UI key `context-vault`、`context_vault_status` 和 Vault telemetry；
Repo Context 拥有 extension ID/UI key `repo-context`、`repo_context_status` 和 Repo telemetry。两者不共享 status 或
telemetry state。

## 要求与安装

- Node.js `>=22.19.0`
- 已用 Pi `0.84.1` 测试

安装 v0.3.0 前，请先验证经过审核的不可变 `v0.3.0` tag 存在于上游仓库中，然后使用：

```bash
pi install git:github.com/Fubuyunhua/pi-context-vault@v0.3.0
```

如果该 tag 不存在，请改用经过审核的本地 checkout 进行开发：

```bash
git clone https://github.com/Fubuyunhua/pi-context-vault.git
cd pi-context-vault
npm ci
pi -e ./extensions/index.ts
```

健康检查：

```text
/context-vault doctor
/context-vault status
```

健康状态只覆盖 Observation 存储、恢复、lease 和 reduction，不再包含 Repo Map component。

## Observation 生命周期

1. `tool_result` hook 检查外部 Tool 的文本结果。
2. 持久化前清理敏感值和控制字符。
3. 内容按 hash 保存，并写入 append-only metadata 和 active-session lease。
4. 只有归档成功后，较大结果才可能被替换成有界 JSON receipt。
5. 上下文压力升高时，较旧的已归档结果在 Pi 的模型可见副本中变成 receipt，同时保持时间顺序和 Tool call/result 配对。
6. Agent 可以显式检索或搜索归档证据。

名称以 `context_vault_` 或 `repo_context_` 开头的 Tool Result 不会被再次归档。

## Tools

| Tool | 用途 |
| --- | --- |
| `context_vault_obs_get` | 通过 Observation 或 artifact ID 恢复有界证据；可选 query 仍按单行内连续字面短语匹配。 |
| `context_vault_obs_search` | 搜索已清理的归档 Observation。默认 `terms` 模式对部分命中排序，归一化常见代码标识符分隔符（`_`、`-`、`.`、`/`、`\\`），并返回相关度分数；`phrase` 模式只匹配单行内连续字面短语。相同 artifact 会在应用结果数量限制前合并；每项结果返回最新 Observation、`occurrenceCount` 和最多五个 `recentObservationIds`，以及可直接执行的 `context_vault_obs_get` next action；调用时必须原样传递 `nextAction.arguments` 的全部字段，确保检索窗口仍以命中证据为中心。完整的 pretty-printed 模型可见 JSON 默认上限为 12,288 UTF-8 bytes；可选 `maxBytes` 范围为 4,096–32,768。 |
| `context_vault_status` | 返回 Vault-only 生命周期、存储、reduction、warning 和 telemetry。 |

Observation search 会维护一个可丢弃的有界 Bloom 快照；快照持久化后，1,000 条 Observation 回归目标为低于 1,000 ms，已索引 miss 读取 0 个 artifact，唯一命中读取 1 个。短查询、Unicode 查询和 phrase 查询会保守验证候选项。聚合 payload 会先保留排序后的 result identity、score、occurrence/recency metadata 和可执行 `nextAction`，再添加行预览，且绝不会截断 JSON。`serializedBytes` 精确计算 pretty-printed result；`truncated`、`omittedResults` 和 `omittedMatches` 确定性报告省略项；`matchesTruncated` 继续表示超出每个 artifact 五行预览窗口的匹配。

## Command

```text
/context-vault status
/context-vault status-json
/context-vault gc
/context-vault doctor
/context-vault rebuild
```

`gc` 只清理 Vault artifacts 和 metadata，并遵守 lease/reference 安全规则；它不会触碰旧仓库状态或 Repo Context 状态。
归档不会自动运行 GC：`projectQuotaBytes` 是物理去重 artifact payload bytes 的手工 GC target，`retentionDays`
也只在调用 `gc` 时应用。Metadata 和文件系统开销不计入该 target。Status 会返回 artifact `usedBytes`、
`targetBytes` 和 `overBudget`；超过 target 时 Vault 会标记为 degraded 并发出 warning，但不会删除或迁移任何证据。

`rebuild` 是不执行操作的迁移提示，精确返回：

```text
Repository rebuild has moved to pi-repo-context.
Install pi-repo-context and use /repo-context rebuild.
```

## 配置

项目配置仍为 `.pi/context-vault.json`：

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

`archiveThresholdBytes` 仍是 `replacementThresholdBytes` 的 deprecated alias；两者同时配置会报错。未知的非 legacy
字段会被拒绝。旧仓库字段只作为 inert migration input 被接受。

使用 `archivePolicy: "off"` 可停止新增归档，使用 `reductionEnabled: false` 可停止上下文削减；已有证据不会被删除。

## 状态、隐私与恢复

状态继续位于项目目录之外：

```text
${PI_CODING_AGENT_DIR}/context-vault/projects/<projectId>/
  artifacts/
  metadata/
```

Observation artifact 是权威证据，拆分不会移动或重写它们。只要 artifact 仍被保留，receipt 就可以恢复。GC 会先保护显式
receipt 引用和 active-session lease，再应用 retention/quota 策略。

归档内容是不可信证据，不是指令。Redaction 只能尽力而为；应尽量避免归档 secret，并使用常规文件系统权限保护 Pi
状态目录。Vault 会重新验证自己拥有的 namespace，并在 Node 支持时通过 no-follow regular-file handle 访问文件。
Node 没有可移植的 `openat` API，因此具备本地高权限、且能在验证与文件访问之间竞速替换 ancestor 的进程仍会造成残余
TOCTOU 风险。

## 升级、回滚与卸载

如果需要让 Repo Context 与拆分前的 Vault 暂时共存，先设置 `repoMapEnabled: false` 和
`mapInjectionMode: "off"`，然后重启 Pi 并建立新 session。不得同时运行两个仓库实现。

回滚不需要转换状态：禁用 Repo Context、重启 Pi，并在确需恢复旧仓库行为时使用已审核的拆分前 checkpoint。不要删除任一状态根目录。

卸载 package 不会删除 Vault 数据。只有确认不再需要任何 receipt 后，才应备份或手工删除状态目录。

## 开发

```bash
npm ci
npm run check
npm test
npm run test:package
npm run test:pi
npm run test:coverage
```

Coverage gate 为 85% lines、80% branches。Package smoke 会打包并安装 artifact，验证精确的 Vault-only surface，通过 Pi
TypeScript loader 加载，并执行 archive → receipt → get/search。在 Linux Node.js 24 上，`test:pi` 使用隔离的临时 home 和
state root，通过真实 Pi 0.84.1 RPC 测试打包后的 extension。

## License

MIT
