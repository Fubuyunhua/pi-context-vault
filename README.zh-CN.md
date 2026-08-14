# pi-context-vault

面向 Pi 的可恢复 Observation 存储与工作区版本感知 Repo Map。

> v0.1.0 面向 Node.js 22.19 及以上、`@earendil-works/pi-coding-agent` 0.84.x，以及
> TypeScript/JavaScript 仓库。

[English README](./README.md) · [研究文档](./deepResearch.md) · [v0.1 规范](./docs/specs/0001-v0.1.md) ·
[v0.1.0 发布说明](./docs/releases/v0.1.0.md)

## v0.1.0 已交付能力

- 所有符合条件的外部文本工具结果都会先脱敏并归档（Context Vault 自身 tools 除外）；超过
  `archiveThresholdBytes` 的结果只有在持久化成功后，才会被替换为有大小上限且可检索的 receipt；非文本 block
  会被保留。
- Pi 的非持久化 `context` 视图可以把已归档的旧 Observation 替换为 receipt，同时保持 canonical session
  的时序以及 tool-call/tool-result 结构不变。
- TS/JS Repo Map 索引路径、词法词项、import、export、顶层 symbol 和 signature。真实文件系统 watcher 会对
  每个相关编辑立即 invalidation 和 fast update，再在 reconciliation 后原子激活带 revision 的 generation。
- 每个模型可见的 Map capsule 都有大小上限、不会写回 session、标记为不可信派生导航数据，并携带
  freshness、workspace revision、pending files；stale 时会显式提供 fallback evidence。
- 默认将所有派生状态放在项目树之外，并按照 canonical project path 隔离。

## 安装

安装不可变的 v0.1.0 Git tag：

```bash
pi install git:github.com/Fubuyunhua/pi-context-vault@v0.1.0
```

开发期间可直接加载本地 checkout：

```bash
pi -e /absolute/path/to/pi-context-vault
```

Pi extension 具有当前操作系统用户权限，安装前请检查源码。

## Pi 接口

Tools：

| Tool | 用途 |
|---|---|
| `context_vault_obs_get` | 通过 Observation/artifact ID 恢复有界字节区间或匹配行。 |
| `context_vault_obs_search` | 搜索已脱敏归档，可按 tool name 过滤。 |
| `context_vault_repo_map` | 查询带 revision 与 freshness 的小型排序 Repo Map 切片。 |
| `context_vault_status` | 报告生命周期、Observation、Repo Map 与降级组件状态。 |

Command：

```text
/context-vault status
/context-vault rebuild
/context-vault gc
/context-vault doctor
```

`rebuild` 显式执行全量 Map 重建，`gc` 应用 retention 与 quota 策略，`doctor` 报告健康状态并检查状态目录
是否位于项目树之外。未知子命令只返回 usage，不修改状态。

## 配置

在项目根目录创建 `.pi/context-vault.json`。所有字段均可选；未知或非法字段会使初始化显式进入 degraded，
不会静默改变策略。

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `archiveThresholdBytes` | `16384` | 超过此值的已归档工具结果替换为 receipt。 |
| `receiptMaxBytes` | `4096` | 即时/历史 Observation receipt 的大小上限。 |
| `hotObservationCount` | `6` | 历史缩减时保留的最新工具结果数量。 |
| `softContextRatio` | `0.75` | 保守估算上下文的缩减触发比例。 |
| `targetContextRatio` | `0.6` | 批量缩减目标，必须低于 soft ratio。 |
| `projectQuotaBytes` | `536870912` | `gc` 使用的单项目 artifact 配额。 |
| `retentionDays` | `30` | `gc` 使用的 artifact 保留天数。 |
| `mapContextMaxBytes` | `6144` | 注入的 Repo Map capsule 大小上限。 |
| `mapDebounceMs` | `300` | batch reconciliation 与原子激活前的延时。 |
| `mapExcludePatterns` | `[]` | 额外的项目相对 glob 排除规则。 |

示例：

```json
{
  "archiveThresholdBytes": 32768,
  "hotObservationCount": 8,
  "mapExcludePatterns": ["generated/**", "vendor/**"]
}
```

## 状态与安全

状态目录：

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/context-vault/projects/<canonical-project-path的sha256>/
├── artifacts/
├── metadata/
└── repo-map/
    ├── active.json
    └── generations/
```

常见 token、credential、private key、Bearer header 和包含 credential 的 URL 会在 hash 与持久化之前脱敏。
Artifact ID 与 Repo Map path 会阻止路径穿越；状态写入和 generation 激活是原子的；并发 writer 使用文件锁；
损坏 metadata 会被拒绝而不是部分信任。Secret 检测属于启发式规则，因此不要把状态目录视为可公开导出的内容。

仓库内容、恢复的 Observation 和 Map capsule 始终是不可信数据。Stale Map 绝不会声称 fresh，而会返回
source/Git fallback evidence，并要求 Agent 使用直接 read、search 或 `git diff`。

## 限制与非目标

- 本 extension 能减少 model-visible context，但不能保证最终序列化 provider request 一定小于模型输入上限；
  最终 hard invariant 必须由 Pi core 实现。
- v0.1.0 不包含 embedding、完整 call graph、typed long-term memory、自动 Git commit 或 tool-episode subagent。
- TS、TSX、JS、JSX、MTS、CTS、MJS、CJS 使用语义索引；其他文本文件使用词法索引；不支持或语法损坏的
  源文件会被显式标记为 degraded。
- Secret 脱敏可降低意外持久化风险，但无法证明任意敏感数据均被识别。

## 开发与验收

```bash
npm ci
npm run ci
```

`npm run ci` 执行 type/lint、带覆盖率门禁的完整测试（lines 85%、branches 80%），以及 Pi package 安装 smoke。
GitHub Actions 在 Linux 的 Node 22.19 和 24 上跑完整验收，并在 macOS/Windows 上跑 package 与真实 watcher
smoke。

开发按照可独立验收的 GitHub 切片推进。每个切片先创建 Issue 和验收标准，通过测试并合并 PR 后才关闭。

## 许可证

MIT
