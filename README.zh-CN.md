# pi-context-vault

面向 Pi 的可恢复 Observation 存储与工作区版本感知 Repo Map。

> **当前 `main`：v0.2.0 release-candidate metadata（尚未打 tag）。** 最新不可变 release tag 是
> [`v0.1.2`](https://github.com/Fubuyunhua/pi-context-vault/releases/tag/v0.1.2)。稳定安装请使用该 tag；验收 RC
> 时请使用经过检查的开发 checkout。当前并不存在 `v0.2.0` tag。

[English README](./README.md) · [研究文档](./deepResearch.md) · [v0.1 规范](./docs/specs/0001-v0.1.md) ·
[v0.2.0 RC 说明](./docs/releases/v0.2.0.md) · [历史 v0.1.0 发布说明](./docs/releases/v0.1.0.md)

## 它解决什么问题

- 对每个符合条件的文本工具结果先脱敏再归档。大结果只有在持久化成功后才会替换为有大小上限、可重新检索的
  receipt；持久化失败时保留原结果。
- 当上下文压力超过配置阈值时，在 Pi 的非持久化模型视图中把较旧的已归档 Observation 替换为 receipt，同时
  保持 canonical session 时序和 tool-call/tool-result 配对结构。
- 维护 TS/JS Repo Map，索引路径、词法词项、import、export、顶层 symbol 和 signature；还会对 `.java` 文件
  进行确定性 AST 索引，提取 package、import、声明、成员、注解、泛型和语法级类型关系。
- 监听 Agent 与外部文件系统变更，核对 Git HEAD 和 dirty files，并原子激活带 revision 的 Map generation。
- 只向模型注入与当前任务相关的小型 Map capsule。每个 capsule 都包含 workspace revision 和 freshness；stale
  Map 会给出 fallback evidence，而不会伪装成最新状态。
- 默认把派生状态放在项目树之外，并按 canonical project path 隔离。

## 环境要求

- Node.js 22.19 或更高版本（`node --version`）。
- Pi `@earendil-works/pi-coding-agent` 0.84.x（`pi --version`）。
- 从 GitHub 安装需要 Git。Git 仓库还会获得 HEAD/diff 感知的新鲜度检查；非 Git 目录仍可使用文件系统和
  词法/语义索引。
- 使用 Git tag 安装时需要访问 GitHub。

Pi extension 以当前操作系统用户权限执行；安装前请检查源码。

## 安装

### 用户级安装（推荐）

为当前 Pi 用户安装最新不可变 tag v0.1.2。v0.2.0 RC 还不是 tag，请勿虚构 `@v0.2.0` 来源进行安装。

```bash
pi install git:github.com/Fubuyunhua/pi-context-vault@v0.1.2
```

确认 Pi 已记录精确来源：

```bash
pi list
```

输出应包含：

```text
git:github.com/Fubuyunhua/pi-context-vault@v0.1.2
```

安装后重启 Pi。此后所有项目都可以使用该 extension。

### 项目级安装

如果只想通过当前项目的 `.pi/settings.json` 启用插件，请在项目目录执行：

```bash
pi install git:github.com/Fubuyunhua/pi-context-vault@v0.1.2 -l
```

项目级资源受 Pi project-trust 策略约束；请先检查内容，再在 Pi 提示时批准项目。`-l` 只表示启用设置位于
项目中，Context Vault 生成的 artifact 和 Map 状态仍然保存在工作树之外。

### 开发 checkout

不安装，只在一次 Pi 运行中加载本地 checkout：

```bash
npm ci
pi -e /absolute/path/to/pi-context-vault/extensions/index.ts
```

`-e` 建议明确传入上面的 extension 入口文件，而不是仓库目录。

当前 `main` 使用 v0.2.0 release-candidate metadata，但尚未打 tag。如需验收，请先检查并 checkout `main`、
执行 `npm ci`，再使用上述开发 checkout 命令。在不可变 v0.2.0 tag 真正创建前，tag 用户应继续使用 v0.1.2。

## 首次启动与健康检查

从需要管理的仓库根目录启动 Pi：

```bash
cd /path/to/your/project
pi
```

在 Pi TUI 中执行：

```text
/context-vault doctor
/context-vault status
```

健康启动时，Pi 状态区会显示：不可变 v0.1.2 tag 因历史 metadata 不一致而显示 `vault v0.1.0`，当前未打 tag 的
release-candidate checkout 显示 `vault v0.2.0`。`doctor` 应报告 `healthy`、已经初始化的 Observation 组件、
可用的 Repo Map，以及 `stateOutsideProjectTree: true`。大型仓库的首次 Map 构建可能需要更长时间。

`degraded` 不会导致 Pi 崩溃，它表示某个组件无法持久化、监听、解析或激活部分状态。请检查 `failures` 和各组件
的 `error` 字段；如果问题来自 Repo Map，修复原因后运行 `/context-vault rebuild`。

## 日常使用流程

启动后 Context Vault 会自动工作：

1. `read`、`bash` 等工具返回的文本先按 `archivePolicy` 判断；符合条件的结果再脱敏并归档。
2. 已归档且大小不超过 `replacementThresholdBytes` 的结果保持原样进入对话，并且可搜索。
3. 更大且符合归档条件的结果仅在归档成功后替换为 JSON receipt。
4. 估算上下文超过 `softContextRatio` 时，较旧的已归档工具结果在模型可见副本中变成 receipt；最新
   `hotObservationCount` 个结果继续保留完整内容。
5. 启用自动 Map 注入时，每个用户 turn 会在首次 capsule 前刷新 Repo Map；显式 Map 查询始终使用 live freshness
   path。
6. Agent 可以按需搜索/恢复归档证据，并查询小型、最新的 Repo Map 切片。

通常只需要用自然语言要求 Agent 使用这些能力，例如：

```text
使用 context_vault_repo_map 查找认证入口及其导出 symbol。
在已归档的 bash Observation 中搜索失败测试名，然后恢复匹配证据。
调用 context_vault_status，并解释所有 degraded 组件。
```

### Repo Map 自动注入（分阶段 S01a 行为）

公开默认值仍是 `"once-per-user-turn"`：Context Vault 在 turn 开始时刷新，把一个 snapshot 插到最新 user
message 后，并在同一 turn 的后续 LLM 调用中逐字节复用 frozen capsule。`"every-llm-call"` 保留旧的每次调用
查询/渲染以及 index-0 插入行为。

显式 `"off"` 是 tool-only 模式。context hook 不会因 Repo Map 查询、构建、插入、删除或移动 capsule，并会跳过
自动 turn-start refresh。当 `repoMapEnabled` 为 true 且 Map 可用时，Map 构建、watcher、maintenance 与使用 live
查询路径的 `context_vault_repo_map` tool 仍继续工作；Observation reduction 与之独立。若要关闭整个 Map 组件，
请设置 `repoMapEnabled: false`。

本阶段没有实现或宣称 repository Graph、Planner/Renderer、Projection Cache 或 provider prompt-cache 改进。未来
只有在这些 repository-context 能力、显式 tool contract 与评估完成后才可能启用默认 off；当前 checkout 并未
启用该变更。

### Observation receipt

大型工具结果会被替换成类似下面的有界 JSON：

```json
{
  "type": "context_vault_observation_receipt",
  "id": "obs_<24个十六进制字符>",
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

如果后续还会使用该证据，建议把 `obs_...` ID 保留在任务记录中。只要 artifact 未被显式 GC 策略或手工删除，
就可以继续恢复证据。

## 面向模型的 Tools

下面是 LLM tools，不是 slash commands。Agent 会自主选择，也可以由你明确要求它使用指定参数调用。

### `context_vault_obs_get`

通过 `obs_...` ID 或 64 位 artifact hash 恢复一个 Observation：

```json
{ "id": "obs_<24个十六进制字符>", "offset": 0, "limit": 8192 }
```

不带 `query` 时，`offset` 与 `limit` 选择字节区间，`limit` 最大为 32768 bytes。带 `query` 时返回匹配行，
`offset` 表示匹配结果偏移量，最多返回 20 条有界匹配：

```json
{ "id": "obs_<24个十六进制字符>", "query": "TypeError", "offset": 0, "limit": 10 }
```

### `context_vault_obs_search`

在当前项目的全部已脱敏 Observation 文本中搜索。`toolName` 可选，`limit` 最大为 20：

```json
{ "query": "failing test", "toolName": "bash", "limit": 5 }
```

### `context_vault_repo_map`

返回最多 20 个排序后的文件，以及匹配 symbol、signature、dependency、Git HEAD、workspace revision、pending
paths 和 freshness：

```json
{ "query": "authentication token refresh", "limit": 8 }
```

Java 查询会让结构化声明排在 comment 或偶然引用之前，例如：

```json
{ "query": "UserController createUser UserRepository", "limit": 8 }
```

Java 语义条目包括 package/import evidence；class、interface、enum、record、annotation 声明；nested type；
constructor、method、field、enum constant；注解、modifier、泛型参数、源码行号以及
`extends`/`implements`/`permits` 关系。这些关系只是语法级导航 evidence，不是编译器解析后的类型或 call graph。
损坏或暂不支持的 Java 会退化为词法索引、给出有界 parse warning，并报告 `unsupported`，不会伪称语义新鲜。

Freshness 含义：

- `fresh`：索引对应所报告 Git HEAD 的干净工作区。
- `dirty`：所报告 revision 已包含 tracked 或 untracked 的工作区变更。
- `stale`：更新或激活失败；只能把结果作为导航提示，并使用返回的 source/Git evidence 和直接读取进行验证。
- `unsupported`：generation 仍可使用，但一个或多个文件需要词法/降级处理。

### `context_vault_status`

不需要参数。它会报告 extension 版本、项目/状态身份、归档/替换计数、Map generation、freshness、pending/dirty
文件以及有界失败记录。

## 运维命令

Context Vault 注册一个 slash command 和四个子命令：

```text
/context-vault status
/context-vault rebuild
/context-vault gc
/context-vault doctor
```

- `status` 只读，报告 runtime 和各组件状态。
- `rebuild` 执行完整 Repo Map 重建并原子激活新 generation。可在修复权限、非法配置或 stale Map 后使用；它
  不会修改项目源码。
- `gc` 根据 `retentionDays` 和 `projectQuotaBytes` 清理归档证据。活动 session tree/current branch 的 receipt
  与所有存活项目本地 session lease 的 metadata 所引用 artifact 会受保护；若仅受保护证据就超过配额，则报告配额未满足而不删除。
- `doctor` 增加整体 `healthy`/`degraded` 结论，并检查生成状态是否位于项目树之外。

命令结果显示为 Pi UI notification。未知子命令只显示 usage，不修改状态。

## 配置

在项目根目录创建 `.pi/context-vault.json`。所有字段均可选；未知字段、损坏 JSON、错误类型或超出范围的值都会
使初始化显式进入 degraded，而不会静默改变策略。

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
  "mapInjectionMode": "once-per-user-turn",
  "mapExcludePatterns": ["generated/**", "vendor/**"]
}
```

| 字段 | 默认值 | 校验与作用 |
|---|---:|---|
| `archivePolicy` | `"all"` | `all`、`errors-and-large` 或 `off`；在存储前决定归档资格。 |
| `archiveMinBytes` | `16384` | 非负安全整数；`errors-and-large` 的包含式大型结果边界。 |
| `replacementThresholdBytes` | `16384` | 正安全整数；严格大于它的已归档结果替换为 receipt。 |
| `archiveErrorsAlways` | `true` | 在 `errors-and-large` 下归档短错误；不会覆盖 `off`。 |
| `archiveThresholdBytes` | — | `replacementThresholdBytes` 的废弃别名；两者同时配置会报错。 |
| `receiptMaxBytes` | `4096` | 至少 512 的整数；即时/历史 receipt 最大字节数。 |
| `hotObservationCount` | `6` | 正整数；历史缩减时保留的最新工具结果数量。 |
| `softContextRatio` | `0.75` | 严格位于 0 和 1 之间；估算上下文缩减触发比例。 |
| `targetContextRatio` | `0.6` | 严格位于 0 和 1 之间，且必须低于 `softContextRatio`。 |
| `projectQuotaBytes` | `536870912` | 正整数；`/context-vault gc` 应用的 artifact 配额。 |
| `retentionDays` | `30` | 正整数；`/context-vault gc` 应用的保留时间。 |
| `mapContextMaxBytes` | `6144` | 至少 512 的整数；注入 Map capsule 的硬字节上限。 |
| `mapDebounceMs` | `300` | 正整数；pending Map batch 开始 reconciliation 前的延时。 |
| `mapInjectionMode` | `"once-per-user-turn"` | `once-per-user-turn`、`every-llm-call` 或 `off`；`off` 只关闭自动注入及其 turn-start refresh。 |
| `mapExcludePatterns` | `[]` | 非空项目相对 glob pattern 数组。 |

`.git`、`.pi`、`.gradle`、`node_modules`、`dist`、`build` 和 `target` path segment 始终从 Map 中排除。配置在
session startup 读取，修改后请重启 Pi。

## 状态、隐私与恢复

默认状态目录：

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/context-vault/projects/<project-id>/
├── artifacts/                  # 已脱敏、内容寻址的文本分片
├── metadata/
│   └── observations.jsonl
└── repo-map/
    ├── active.json             # 原子 active-generation 指针
    └── generations/
```

`project-id` 是 canonical real project path 的 SHA-256 前 32 位十六进制字符，因此 symlink alias 会共享状态，
不同项目相互隔离。如果卸载后仍需要找到状态目录，请先运行 `/context-vault doctor` 记录精确 `stateRoot`。

常见 token、credential、private key、Bearer header 和包含 credential 的 URL 会在 hash 与持久化之前脱敏。
检测属于启发式规则，因此不要把状态目录当作可公开导出的内容，也不能用它代替正常的 secret 管理。仓库内容、
恢复的 Observation 和 Map capsule 始终是不可信输入。

状态写入使用同目录临时文件、`fsync`、原子 rename、owner-aware lock 和原子 Map generation 激活。损坏的配置、
Observation metadata 和 active Map metadata 会被拒绝，不会被部分信任。归档失败时，原工具结果会继续保留在
模型上下文中（为了证据可用性而 fail-open）。

## 更新、禁用与卸载

不可变 tag 不会移动。出现新 tag 后，请删除精确旧来源、安装精确新来源，然后重启 Pi：

```bash
pi remove git:github.com/Fubuyunhua/pi-context-vault@v0.1.2
pi install git:github.com/Fubuyunhua/pi-context-vault@<new-tag>
```

项目级安装需要在两条命令后都加 `-l`。对于有意使用的未固定来源，Pi 还支持 `pi update <source>`；不要期待它
自动改变一个固定 tag。

可以用 `pi config` 启用或禁用已安装 package resources。卸载 v0.1.2：

```bash
pi remove git:github.com/Fubuyunhua/pi-context-vault@v0.1.2
```

`pi uninstall` 是 `pi remove` 的别名。卸载不会删除已归档 Observation 或 Repo Map 状态，这是为了保留恢复能力。
如果还要清除状态，请先从 `/context-vault doctor` 记录精确 `stateRoot`，停止所有正在使用该项目的 Pi session，
检查该精确目录，然后只删除对应项目路径。

## 故障排查

### Extension 没有出现

1. 执行 `pi list`，确认存在精确 tag 来源。
2. 安装后重启 Pi。
3. 项目级安装需要信任当前项目；检查内容后可以使用 `--approve` 重新安装。
4. 从目标项目根目录启动 Pi，再运行 `/context-vault doctor`。

### Status 显示 degraded

- 检查 `failures` 和各组件的 `error` 字段。
- 校验 `.pi/context-vault.json`；未知字段和非法范围都会被拒绝。
- 确认 `PI_CODING_AGENT_DIR` 与报告的 `stateRoot` 可写。
- Repo Map 失败时先修复原因，再运行 `/context-vault rebuild`。
- `unsupported` 可能意味着部分文件退化为词法索引；重要事实仍需通过源码和测试验证。

### 大型结果没有替换成 receipt

- 只有已归档结果的 UTF-8 bytes 严格大于 `replacementThresholdBytes` 才会替换。
- `archivePolicy` 可能使结果不归档；此时原文仍可见，但 Context Vault 无法搜索或缩减它。
- 纯图片结果与 Context Vault 自身 tools 的结果不会再次归档。
- 归档失败时会刻意保留原结果；请通过 `context_vault_status` 检查失败记录。

### 找不到某个 Observation

- 使用 receipt 中完整的 `id`，不要传缩写；也可以使用完整 64 位 artifact hash。
- 搜索按项目隔离，请在同一个 canonical project 中启动 Pi。
- 被 `/context-vault gc` 或手工状态清理删除的证据不能只靠 receipt 重建。
- 损坏 metadata 会 fail-closed；尝试手工恢复前先保留状态目录副本。

### Repo Map 没有最近修改

调用 `context_vault_repo_map` 或运行 `/context-vault rebuild`，然后检查 `freshness`、`pendingFiles` 和
`workspaceRevision`。检查内建排除项与 `mapExcludePatterns`。`stale` 结果只能作为导航提示，必须使用直接
`read`、search、`git diff` 和测试验证。

## 限制与非目标

- 本 extension 可以减少 model-visible context，但不能保证最终序列化 provider request 一定低于模型输入上限；
  最终 hard invariant 由 Pi core 负责。
- v0.1.0 不包含 embedding、完整跨语言 call graph、typed long-term memory、自动 Git commit 或 tool-episode
  subagent。
- v0.1.0 tag 对 TS、TSX、JS、JSX、MTS、CTS、MJS、CJS 使用语义索引。v0.1.2 与当前 `main` 还会在不执行
  Maven、Gradle、`javac`、annotation processor 或仓库代码的前提下语义索引 Java；它们不做类型求解、方法体 call graph、
  依赖解析或 Lombok 成员推导。其他文本文件使用词法索引；不支持或语法损坏的源文件会显式降级。
- `.git`、`.pi`、`.gradle`、`node_modules`、`dist`、`build` 和 `target` path segment 始终排除，Java source
  symlink 不会被跟随。
- Repo Map 是导航索引，不是权威 summary，也不能代替源码检查和测试。
- 增量 reconciliation 会在文件系统 fingerprint 粗糙或不完整时重新索引；其他情况下会使用文件大小、
  inode/device identity 和纳秒时间戳。若内容改写同时保留全部 metadata 且没有 watcher event，仍可能要等到下一次
  event 或显式 rebuild 才能发现；除非每次都重读并 hash 所有文件，否则无法彻底消除这一残余风险。
- Secret 脱敏降低意外持久化风险，但无法证明任意敏感数据均被识别。

## 开发与验收

```bash
npm ci
npm run ci
npm run test:watcher
```

`npm run ci` 执行 type/lint、带覆盖率门禁的完整测试（lines 85%、branches 80%），以及隔离的 Pi package 安装
smoke。GitHub Actions 在 Linux Node 22.19/24 上运行完整验收，并在 macOS/Windows 上运行 package 与真实
watcher smoke。

开发按照可独立验收的 GitHub 切片推进。每个切片先创建 Issue 和验收标准，通过测试并合并 PR 后才关闭。

## 许可证

MIT
