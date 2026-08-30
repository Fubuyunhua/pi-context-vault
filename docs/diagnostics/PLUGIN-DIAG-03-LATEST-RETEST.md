# PLUGIN-DIAG-03：最新仓库更新回归

日期：2026-08-30  
模型调用：0

## 更新检测

两个仓库均有源代码更新并满足“至少关闭 2 个 Issue + main 更新”门槛，定时监控器已自动 fast-forward 并测试：

- Context Vault：`a9ef7de` → `73274f3908270822bd96fe032755cb90b33836cd`
- Repo Context：`c0c3d67` → `212e1b7e9b647c36a09186d2371b9f242d399f1f`

## Context Vault

触发关闭：#53、#56、#58。

结果：

- 完整 CI：15 files passed；182 passed、1 skipped
- typecheck/lint/package smoke：通过
- production audit：0
- 历史 39-query recall：38/39（97.4%），此前为 0/39
- duplicate crowding：从 10 条同 artifact 结果改善为 2 条独特 artifact；较早独特证据成功返回
- model-visible status：0 path fields、0 absolute paths、无 private-home marker
- 测试后 worktree：干净

唯一历史 miss：`legacy_api.py original implementation`（D_WRONG_PASSIVE）。

原自动 quota diagnostic 首次失败是 harness 使用已被 #56 正确删除的 `status.project.stateRoot`。修复 harness 为从其自有 `agentDir + project.id` 推导路径后，隔离重跑通过。

后续 #57 修复已合并到 `4e35be1d95fca5da1a9e9af8c499734c2f1fb04d`。针对性验证通过 typecheck 和 7 个 quota/storage tests；同样的 2KB target / 46KB used 场景现在返回 `degraded=true`、明确 `/context-vault gc` warning，并在 status 暴露 target/usage。契约明确为可观测的手工 GC target，而不是自动硬限制。#57 已关闭。

Search 规模性能仍近似线性：1,000 Observations 的 miss/oldest/newest 约 1.15秒，#55 保持 open。

## Repo Context

触发关闭：#6、#7、#8、#10、#13（以及前次失败后保留的 #3/#4/#5/#9 门控）。

结果：

- 完整 CI：21 files passed；310 passed、1 skipped
- typecheck/lint/package smoke：通过
- production audit：0
- Windows heartbeat focused repetition：5/5 passed
- ranking + Pi wrapper focused tests：8/8 passed
- model-visible status：0 path fields、0 absolute paths
- canonical search 已有 prompt snippet/guideline；deprecated alias 默认从 active tools 隐藏
- 测试后 worktree：干净

3,000 文件 Git warm regression：

- cold ready：1,979ms
- warm ready：995ms
- hydrated fast reuse：1
- warm full build：0
- warm generation write：0

旧 composite non-Git experiment workspace 的 direct runtime benchmark 仍较重（约 21.9s cold、35.8s warm），但 #10 的 extension lazy startup 与 Git fast-reuse contract 已通过。隔离的 3,000 文件非 Git synthetic fixture 为约 1.26s cold、1.46s warm；暂不据此创建新缺陷。

## Issue 完整性

所有此前确认问题都已提交 GitHub Issue：

### Context Vault

- #53 closed：自然查询与 search→get；最新 recall 38/39
- #54 closed：Pi tool error contract
- #55 open：Observation search full scan 性能
- #56 closed：model-visible path privacy
- #57 closed：quota manual-target visibility；针对性回归通过
- #58 closed：duplicate search crowding

### Repo Context

- #3–#10：全部 closed
- #13：closed，Windows heartbeat 修复已 5/5 验证

本轮没有发现尚未提交的、达到确定复现标准的新产品缺陷。诊断 harness 兼容性问题已本地修复，不作为插件 Issue。

## 当前模型实验门控

- Repo Context：`modelRetestReady=true`
- Context Vault：`modelRetestReady=false`，仅等待 #55

因此暂不自动调用付费模型。
