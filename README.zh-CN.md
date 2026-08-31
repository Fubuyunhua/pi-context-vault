# Pi Context Vault

一个在降低上下文压力的同时，保证 Tool Result 证据仍可恢复的 Pi 扩展。

默认情况下，Context Vault 会归档所有符合条件的外部文本 Tool Result。超过 16 KiB 的结果可以立即替换成小型索引凭据；上下文压力升高时，较旧的已归档结果也可以被虚拟化。Agent 通过显式搜索和检索 Tool 恢复证据。

Context Vault **不**建立仓库索引，也不注入仓库上下文。该能力属于独立项目 [`pi-repo-context`](https://github.com/Fubuyunhua/pi-repo-context)。

## 安装

要求：Node.js `>=22.19.0` 和当前版本的 Pi。Pi 核心包由宿主提供；CI 目前使用 Pi `0.84.1` 测试该扩展。

从 [Releases](https://github.com/Fubuyunhua/pi-context-vault/releases) 选择经过审核的版本，然后把占位符替换为对应 tag 或 commit：

```bash
pi install git:github.com/Fubuyunhua/pi-context-vault@<tag-or-commit>
```

重启 Pi 并检查：

```text
/context-vault doctor
/context-vault status
```

正常使用不要求额外配置或手工命令。Vault 会自动处理符合条件的 Tool Result；需要历史证据时，Agent 会调用 search/get。

本地开发：

```bash
git clone https://github.com/Fubuyunhua/pi-context-vault.git
cd pi-context-vault
npm ci
pi -e ./extensions/index.ts
```

## 核心流程

1. `tool_result` 选择符合条件的外部文本。
2. 在 hash 和持久化之前清理内容。
3. Artifact 按内容 hash 保存，同时写入可恢复的 Observation metadata。
4. 只有归档成功后，Pi 的模型可见副本才可能变成有界索引凭据。
5. 执行上下文压力削减时，尚未替换的最近结果保持可见，较旧结果可以变成索引凭据。
6. search/get 只恢复当前需要的证据。

`context_vault_*` 和 `repo_context_*` Tool 的结果不会被再次归档。

| Tool | 用途 |
| --- | --- |
| `context_vault_obs_search` | 对已清理证据进行排序搜索；合并重复 artifact，并返回紧凑预览和可执行的 `nextAction`。 |
| `context_vault_obs_get` | 按 ID/offset 恢复 UTF-8 安全的字节窗口，或用字面 query 返回有界、不区分大小写的匹配行。 |
| `context_vault_status` | 返回生命周期、存储、上下文削减、警告和有界遥测。 |

搜索默认使用排序 `terms` 模式，并归一化常见标识符分隔符（`_`、`-`、`.`、`/`、`\`）。`phrase` 模式要求同一行内存在连续字面匹配。完整的模型可见搜索 JSON 默认最多 12,288 UTF-8 bytes；`maxBytes` 支持 4,096–32,768。系统会确定性地省略较低排名结果或预览，而不是直接切割 JSON。

执行 `nextAction` 时必须原样传递**全部参数**。它有界并围绕匹配证据定位。若匹配跨度超过默认 8 KiB 检索页面，action 会暴露匹配开头，调用方可能需要继续执行一次有界 `get`。

## 实验结果

最新预注册比较包含 24 个有效运行：3 个任务 × 2 次重复 × 4 个插件组。最清晰的结果来自一个必须检索历史证据的上下文压力任务；权威行为契约位于索引凭据预览之外。

| 压力任务 | 通过 | 平均耗时 | 平均 tokens | 模型可见前置内容 |
| --- | ---: | ---: | ---: | ---: |
| NONE | 0/2 | 160s | 133k | 768KB |
| VAULT | 2/2 | 40s | 65k | 48KB |

`VAULT+BOTH` 的压力任务通过 4/4，`NONE+REPO` 通过 0/4。所有启用 Vault 的运行都搜索了归档证据，并在 4/4 次搜索中找到隐藏契约。比较 `VAULT` 与 `NONE`，平均耗时降低约 75%，tokens 降低约 51%。

这是一个**针对上下文压力的结果**，不是普遍效率结论。所有实验组的最终补丁都通过了普通编码任务；汇总全部任务后，Vault 与无插件组的 tokens 几乎相同；每个任务/实验组只有两次重复。搜索预览有时已包含足够证据，因此结果支持的是虚拟化 + 搜索工作流，而不是严格的 get-only 因果关系。

完整方法、确定性检查、启动/归档成本与限制：

- [POSTFIX-03 模型实验](https://github.com/Fubuyunhua/pi-context-vault/blob/main/docs/diagnostics/PLUGIN-DIAG-12-POSTFIX-03-RESULTS.md)
- [确定性比较](https://github.com/Fubuyunhua/pi-context-vault/blob/main/docs/diagnostics/PLUGIN-DIAG-11-DETERMINISTIC-COMPARISON.md)

## 配置

可选项目配置：`.pi/context-vault.json`。

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

`archivePolicy` 可设为 `all`、`errors-and-large` 或 `off`。使用默认值 `all` 时，`archiveMinBytes` 不会过滤普通文本；该阈值只用于 `errors-and-large`。设置 `archivePolicy: "off"` 会停止新归档和新的即时替换。

`reductionEnabled: false` 只关闭上下文压力触发的削减，不会关闭归档时的即时替换；如需关闭后者，请使用 `archivePolicy: "off"`。两者都不会删除已有证据。`archiveThresholdBytes` 是 `replacementThresholdBytes` 的 deprecated alias，两者不能同时配置。

## 运维、存储与安全

```text
/context-vault status
/context-vault status-json
/context-vault doctor
/context-vault gc
```

状态位于项目目录之外：

```text
${PI_CODING_AGENT_DIR}/context-vault/projects/<projectId>/{artifacts,metadata}
```

`gc` 只能手工执行，归档不会自动触发。`projectQuotaBytes` 是去重 artifact payload 的目标，不包含 metadata 和文件系统开销。在应用 retention/quota 策略前，GC 会保护仍有活动租约的会话 artifact，以及当前会话 entries/branch 中的索引凭据引用。

安全限制：

- Artifact 是不可信证据，不是指令。
- Redaction 只提供尽力清理，不是 secret 管理边界。请避免归档 secret，并保护 Pi 状态目录。
- 卸载扩展不会删除证据。
- 旧仓库配置只作为无行为的迁移输入；Vault 不会读取、迁移、GC 或删除仓库状态。

拆分与迁移细节：[插件拆分契约](https://github.com/Fubuyunhua/pi-context-vault/blob/main/docs/specs/0018-plugin-split-contract.md)。

## 开发

```bash
npm ci
npm run check
npm test
npm run test:coverage
npm run test:package
npm run test:pi
```

Coverage gate：lines 85%，branches 80%。

## License

MIT
