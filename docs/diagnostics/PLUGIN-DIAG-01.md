# PLUGIN-DIAG-01：Context Vault / Repo Context 诊断报告

日期：2026-08-29  
模型调用：本阶段 0 次（仅复用既有产物与确定性测试）

## 摘要

本阶段没有继续盲目扩大 SWE-bench，而是对既有 40-run Sol 实验、24-run 封闭记忆实验及两个插件 CI 做离线取证。

确认结果：

1. **Context Vault Observation search 的自然多关键词检索不可用**：整个 query 被当作连续字面短语匹配。封闭记忆实验中 39 次 search 均未返回可识别 Observation ID，因此 0 次 get；此前“模型搜到但不愿 get”的归因需要修正。
2. **Repo Context 的 6 个 read-error 测试依赖 `chmod(0o000)`**，在 Windows 和 root Linux 容器中都不能可靠制造读取失败。
3. **Repo Context file-lock heartbeat 测试存在固定毫秒阈值脆弱性**：Windows 上稳定失败，Linux 容器通过。
4. **5.6-sol 四臂结果有 5/40 provider transport failures**，且所有结果的 `arm` 元数据都错误记录为 `none`。`sphinx-10435` 的 both-only FAIL 是 TLS 握手失败，并非插件交互回归。
5. **Repo Context 生产依赖存在 6 个 npm audit 项**：`npm audit --omit=dev` 仍为 4 moderate、2 high，主要来自 `java-parser -> chevrotain/lodash/lodash-es`；Context Vault 生产审计为 0。
6. **四臂 harness 的 `.pi` 控制配置污染 Agent diff**：插件配置被 `git add .` 计入修改，并且 both 仍写入 v0.3 已废弃的 `repoMapEnabled`。本地 runner 已改为 `.git/info/exclude` 隔离控制文件并删除旧键。

## 测试结果

### pi-context-vault v0.3.0

- TypeScript：通过
- Biome：通过
- Vitest：168 passed、1 skipped
- 覆盖率：89.01% statements、93.87% lines
- package smoke：通过
- Windows 上 `test:pi` 明确声明仅支持 Linux，未计为产品失败

### pi-repo-context v0.1.0

安装依赖后：

- TypeScript：通过
- Biome：通过
- package RPC smoke：通过
- Vitest：276 passed、7 failed、1 skipped

失败分类：

- 6 项：依赖 `chmod(0o000)` 的 read-error/freshness 测试；Windows 与 root Linux 均失败
- 1 项：heartbeat 年龄断言要求 `<40ms`，实际约 53–64ms；Windows 复现，Linux 通过

### EXP-MEM-02

- 验收测试：8/8 通过
- 封闭真实运行：24 runs
- Observation search：39 次
- search 返回可识别 Observation ID：0 次
- Observation get：0 次
- repo search：99 次
- 最终：24 FAIL，environment probe 为 0

## 确认问题 1：Observation search 使用整串 literal query

实现位于 `src/observations/virtualization.ts`：

```ts
const pattern = literalCaseInsensitivePattern(query);
```

确定性复现使用实际 correct-memory fixture：

| Query | 结果数 |
|---|---:|
| `parse_config legacy_api` | 0 |
| `config parser key value env expansion` | 0 |
| `metadata key` | 1 |
| `unresolved` | 1 |
| `Return an extra metadata key` | 1 |

模型自然地使用关键词列表，但 API 实际要求连续短语，且工具描述没有声明 literal 语义，也没有 `promptSnippet` / `promptGuidelines` 指示 search 后调用 get。

后续隔离验证：使用可命中的单词 `unresolved` 后，search 返回正确 Observation ID；随后 get 能取回同一 Observation，完整包含随机 `_meta_b79410b8` 契约与完整 behavior 数组，且未截断。这把故障限定在 search query 语义/工具引导层，而不是存储或 get 层。

同时发现 benchmark 的 ID 解析路径错误：真实结构是 `details.results[].observation.observationId`，旧 runner 只检查顶层 `observationId/id`。不过将 24-run 的 39 条原始 query 对实际 fixture 做 literal 回放后，真实命中仍为 **0/39**，所以 search 根因不受该指标 bug 影响。

建议：

1. 默认使用 tokenized AND/OR 检索或增加明确的 phrase 模式；
2. search 返回 top hit 的 Observation ID、预览和明确 next action；
3. 增加 `promptSnippet` / `promptGuidelines`；
4. 考虑一步式 `obs_recall` 或 top-1 自动展开；
5. 增加自然多关键词回归测试。

## 确认问题 2：read-error 测试不可移植

以下测试通过 `chmod(path, 0o000)` 期望 readFile 失败：

- `tests/repo-map.test.ts`
- `tests/repo-map-runtime.test.ts` 中 5 个 freshness/recovery cases

该假设在 Windows 不成立；root Linux 也可读取 mode 000 文件。代码库已经有注入 `indexFileSystem.readFile` 的确定性 ENOENT case，应将其推广到所有 read-error cases。

建议：

- 使用注入 file-system adapter 抛出 EACCES/EIO/ENOENT；
- 不依赖 OS 权限或当前 UID；
- 在 Windows、普通 Linux user、root container 三种环境验证。

## 确认问题 3：file-lock 测试时序脆弱

测试先等待 45ms，再要求 heartbeat 文件年龄 `<40ms`，配置 `staleMs=60`。在 Windows 调度下实际年龄约 53–64ms，断言先于被测锁替换逻辑失败。

建议：

- 注入 monotonic clock/fake timers；或
- 将行为断言与 wall-clock 调度分离；
- 不使用相互重叠的 40/45/60ms 窗口。

## 既有四臂实验完整性更正

Sol/medium 40 runs 的 provider transport errors：

| 组 | provider errors |
|---|---:|
| none | 2 |
| vault | 1 |
| repoctx | 1 |
| both | 1 |

错误包括 TLS handshake、unknown certificate verification 和 WebSocket 1006。`both/sphinx-10435` 在首次 provider 请求前失败，不能作为双插件负向交互证据。

另外，四个目录中的结果均记录 `arm: none`；后续 harness 必须把 `plugins` 组名写入正式结果，并将 provider error 记为基础设施失败而不是任务 FAIL。

## 当前修改优先级

1. P0：修复 Vault multi-keyword search 及 search→get 引导
2. P0：修复实验 harness 对 provider error 和 arm 的分类
3. P1：修复 Repo Context read-error 测试可移植性
4. P1：修复 file-lock 测试时序稳定性
5. P1：处理 java-parser 依赖审计项
6. P2：上述修复后只跑 8 个假设驱动模型实验，不立即重跑 40/80 runs

## Repo Context 搜索采用取证

从既有 transcript 恢复 8 次 `repo_context_search`：平均返回 10 项、约 2.4KB；top-1 后续被引用 4/8，top-5 被引用 4/8，最终修改文件出现在任意返回位置 6/8。

明确噪声案例：

- `QuerySet.in_bulk` 查询把 vendored `xregexp.js` / `.min.js` 排在前两位，实际 `django/db/models/query.py` 位于第 10；
- Sphinx HTML signature 查询的前列被 `sphinx/search/ja.py` 和多个 locale `.po` 文件占据，相关实现未进 top-10；
- 精确的 LaTeX writer 与 `sphinx.util.inspect` 查询可把正确文件排到 1–2，说明主要问题是 broad-query ranking/path priors，而不是索引完全不可用。

## 工具面诊断

确定性加载结果：Vault 3 tools、Repo Context 3 tools、双装 6 tools，无工具名冲突。但所有 6 个工具都没有 `promptSnippet` 或 `promptGuidelines`；Repo Context 还默认激活与 canonical search schema 完全重复的 deprecated `context_vault_repo_map`。

既有非基础设施 runs 中，repo-only 使用 canonical search 6/9，both 仅 1/9；这不是因果证明，但与工具面缺少引导、双装工具选择增多构成需要验证的采用信号。

## Vault search 规模性能

确定性 100/500/1000 Observation benchmark 显示每次 search 都逐条读取 artifact，延迟近似线性；1,000 条时 miss/最旧命中/最新命中均约 1.17–1.24 秒。最新命中同样扫描全库，因为结果未达到默认 limit=10。

建议建立按 metadata log generation/content hash 失效的 token/line 索引或缓存，并记录 candidates scanned、bytes read、cache hit 与 duration。

## 工具错误语义缺陷

两个插件都通过 return `{ isError:true }` 表达工具失败，但 Pi agent-core 的成功分支会无条件生成 `isError:false`，只有 `execute()` 抛异常才生成错误 tool result。现有插件测试直接调用 execute 并检查返回对象，因此没有覆盖真实 wrapped runtime。

影响：无效 Observation ID、存储错误、Repo index/query unavailable 等状态可能被 Pi 记录为普通成功调用。Repo Context 需要进一步区分“硬失败（throw）”与“可用但 stale/degraded 的正常证据”。

## 评测 harness 修正

继续诊断发现：

- Observation search ID 应从 `results[].observation.observationId` 读取；
- `arm` 必须记录 `plugins` 而不是默认 `none`；
- TLS/certificate/WebSocket transport failures 必须标为基础设施错误；
- `.pi/context-vault.json` 与 `.pi/repo-context.json` 必须排除在 Agent diff 之外；
- Context Vault v0.3 已是 Observation-only，不应再写 `repoMapEnabled`。

上述修正已在本地 benchmark harness 完成并通过 typecheck/验收测试。

## GitHub Issues

- Context Vault multi-keyword search / search→get handoff: [pi-context-vault#53](https://github.com/Fubuyunhua/pi-context-vault/issues/53)
- Context Vault wrapped tool error semantics: [pi-context-vault#54](https://github.com/Fubuyunhua/pi-context-vault/issues/54)
- Context Vault search full-scan performance: [pi-context-vault#55](https://github.com/Fubuyunhua/pi-context-vault/issues/55)
- Repo Context ranking noise: [pi-repo-context#6](https://github.com/Fubuyunhua/pi-repo-context/issues/6)
- Repo Context tool guidance/deprecated alias: [pi-repo-context#7](https://github.com/Fubuyunhua/pi-repo-context/issues/7)
- Repo Context wrapped tool error semantics: [pi-repo-context#8](https://github.com/Fubuyunhua/pi-repo-context/issues/8)
- Repo Context portable read-error fixtures: [pi-repo-context#3](https://github.com/Fubuyunhua/pi-repo-context/issues/3)
- Repo Context file-lock timing stability: [pi-repo-context#4](https://github.com/Fubuyunhua/pi-repo-context/issues/4)
- Repo Context dependency audit: [pi-repo-context#5](https://github.com/Fubuyunhua/pi-repo-context/issues/5)

## 证据来源

- `docs/diagnostics/PLUGIN-DIAG-01-evidence.json`
- `docs/diagnostics/PLUGIN-DIAG-01-vault-search-repro.json`
- `docs/diagnostics/PLUGIN-DIAG-01-vault-query-replay.json`
- `docs/diagnostics/PLUGIN-DIAG-01-repo-adoption.json`
- `docs/diagnostics/PLUGIN-DIAG-01-tool-surface.json`
- `docs/diagnostics/PLUGIN-DIAG-01-vault-search-scale.json`
- EXP-MEM-02 `_work/*/result.json`
- 5.6-sol 四臂 `results-*.json` / `transcript-*.json`
- 两个插件本地及 Linux-root 容器测试输出
