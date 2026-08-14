# pi-context-vault

面向 Pi 的可恢复 Observation 存储与工作区版本感知 Repo Map。

> 状态：v0.1 正在开发。首个版本以 `@earendil-works/pi-coding-agent` 0.84.x 和 TypeScript/JavaScript
> 项目为目标。

[English README](./README.md) · [研究文档](./deepResearch.md) · [v0.1 规范](./docs/specs/0001-v0.1.md)

## v0.1 计划能力

- 在压缩大型工具结果前归档 Observation，并返回可检索的 receipt。
- 通过 Pi 工具搜索和恢复被移出上下文的 Observation。
- 维护与 Git HEAD 和未提交工作区状态绑定的 TS/JS Repo Map。
- 文件修改后增量刷新相关节点，并向模型提供 freshness 信息。
- 默认将状态保存在 Pi 用户目录，不污染项目工作树。

## 安装

开发期间可以直接加载本地目录：

```bash
pi -e /absolute/path/to/pi-context-vault
```

v0.1.0 发布后：

```bash
pi install git:github.com/Fubuyunhua/pi-context-vault@v0.1.0
```

## 开发

```bash
npm install
npm run ci
```

开发工作按照可独立验收的 GitHub 切片推进。每个切片先创建 Issue 和验收标准，通过测试和 PR
验收后才关闭 Issue。

## v0.1 明确不包含

- 保证最终 provider payload 永远不会超过模型输入上限；该硬约束必须由 Pi core 实现。
- Embedding、完整跨语言调用图、自动 Git commit、typed memory 或 subagent。
- 持久化工具输出中的未脱敏 secret。

## 许可证

MIT
