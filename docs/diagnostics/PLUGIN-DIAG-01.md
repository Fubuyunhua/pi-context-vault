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
5. **Repo Context 新安装存在 6 个 npm audit 项**：4 moderate、2 high，主要来自 `java-parser -> chevrotain/lodash/lodash-es`。

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

## GitHub Issues

- Context Vault multi-keyword search / search→get handoff: [pi-context-vault#53](https://github.com/Fubuyunhua/pi-context-vault/issues/53)
- Repo Context portable read-error fixtures: [pi-repo-context#3](https://github.com/Fubuyunhua/pi-repo-context/issues/3)
- Repo Context file-lock timing stability: [pi-repo-context#4](https://github.com/Fubuyunhua/pi-repo-context/issues/4)
- Repo Context dependency audit: [pi-repo-context#5](https://github.com/Fubuyunhua/pi-repo-context/issues/5)

## 证据来源

- `docs/diagnostics/PLUGIN-DIAG-01-evidence.json`
- `diagnostics/out/vault-search-repro.json`
- EXP-MEM-02 `_work/*/result.json`
- 5.6-sol 四臂 `results-*.json` / `transcript-*.json`
- 两个插件本地及 Linux-root 容器测试输出
