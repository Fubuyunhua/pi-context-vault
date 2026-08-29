# PLUGIN-DIAG-02：更新后自动回归与持续监控

日期：2026-08-29  
模型调用：0（仅确定性 CI、历史查询回放和性能基准）

## 自动触发规则

本地 Windows Task Scheduler 已安装 `PiPluginRepoWatch`，每 6 小时检查两个仓库。单仓库满足以下条件才更新并回归：

1. 自上次成功测试以来至少 2 个 Issue 从 open 转为 closed；
2. `origin/main` HEAD 已变化；
3. `src/`、`extensions/`、`tests/`、`scripts/` 或 package/toolchain manifest 有实质变化；
4. 同一 commit 尚未尝试；
5. 本地 worktree 干净。

文档-only commit 不触发；失败 commit 等待下一次源代码更新，不会每 6 小时重复消耗资源。无人值守阶段不调用模型。

## Context Vault 更新回归

测试 commit：`7dda0d30a95be89a98e21bba0e929ce3c7ec5051`  
触发关闭 Issue：#53、#54

结果：

- typecheck：通过
- lint：通过
- package smoke：通过
- Vitest：15 files passed；176 passed、1 skipped
- production audit：0 vulnerabilities
- worktree：测试后干净

新的 terms/phrase API、`nextAction`、search→get guidance 及 Pi tool error propagation 均有单元回归覆盖。

### 历史真实查询回放仍失败

将 EXP-MEM-02 的同一批 39 条真实模型查询，按历史 arm 对正确/错误 fixture 使用新的默认 strict-AND `terms` 模式回放：

| 指标 | 命中 |
|---|---:|
| 旧 literal | 0/39 |
| 新 strict-AND terms | 0/39 |
| 至少一个 query term 出现在 fixture | 25/39 |

真实查询包含 identifier/词形差异和导航词，例如：

- `parse_config` vs `legacylib-parse-config`
- `env` vs `environment`
- `expand` vs `expansion`
- `legacy_api` / `implementation` 不一定出现在 behavior artifact

因此 synthetic unit fixture 证明了“所有词都出现时可跨行 AND”，但尚未改善原实验真实查询的 recall。#53 已补充证据并重新打开。后续建议 ranked OR/BM25、minimum-should-match、identifier normalization，并把 39-query set 固化为 Recall@k 回归集。

现有 search 性能和重复 crowding/quota 行为基本未变：#55、#57、#58 继续保持 open。

## Repo Context 更新回归

测试 commit：`162e4a22c3c4f4333d0c012ffef2c36fb5f34fa5`  
触发关闭 Issue：#3、#4、#5、#9

结果：

- typecheck：通过
- lint：通过
- former chmod/read-error cases：通过
- Vitest：17 files passed、1 failed；285 passed、1 failed、1 skipped
- package smoke：因 test stage 失败未执行
- production audit：首次 registry TLS failure；隔离重试为 0 vulnerabilities
- model-visible status：0 path fields、0 absolute paths、无 private-home marker
- worktree：测试后干净

### 新确认 Windows heartbeat 产品缺陷

唯一失败 case 在 Windows 稳定复现 5/5：

```text
Expected: State lock
Received: EPERM: operation not permitted, futime
```

`heartbeatOwnedLock()` 以 `O_RDONLY` 打开 owner 文件后调用 `FileHandle.utimes()`；Windows 不允许通过该只读 handle 更新时间。默认 scheduler 又吞掉 heartbeat rejection，因此长操作可能不刷新 mtime，随后被错误视为 stale lock。已创建 #13。

### 启动性能复测

| Workspace | Files | Generation | Cold | Unchanged warm |
|---|---:|---:|---:|---:|
| plugin repo | 64 | 364KB | 588ms | 553ms |
| experiment workspace | 3,637 | 37.5MB | 22.0s | 33.1s |

与修复前 22.6s/35.0s 相比没有足以改变结论的改善；#10 继续保持 open。

## 模型重测门控

当前不启动付费模型实验：

- Vault critical：#53、#55、#58 尚未全部关闭；
- Repo critical：#6、#7、#10 尚未全部关闭；
- Repo CI 被 #13 阻塞。

监控器只有在 critical issues 全部关闭、对应 commit 的确定性测试通过、历史 Vault query recall 至少达到 60% 时，才写入 `modelRetestReady: true`。之后执行预注册的 8–16 run，而不是自动重跑 40–80 runs。

## 证据

- `PLUGIN-DIAG-02-vault-query-replay-after-53.json`
- `PLUGIN-DIAG-02-repo-startup-after-update.json`
- `PLUGIN-DIAG-02-status-paths-after-update.json`
- GitHub follow-up comments：Context Vault #53；Repo Context #3/#4/#5/#9
- 新 Issue：Repo Context #13
