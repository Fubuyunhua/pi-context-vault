# Pi 上下文管理深度研究：从 Observation 污染、Lost-in-the-Middle 到可恢复的分层上下文

## 结论先行

调研后的结论是：**你的三个核心判断大体成立，但第二点和第三点需要做一个重要修正；而你提出的“双上下文 + Git + Repo Map”方向是对的，不过真正工程化以后，我更推荐的不是简单的“双上下文”，而是“持久化事实层 + 主 Agent 工作上下文 + 临时执行上下文 + 控制平面”的三数据平面加一控制平面架构。**

最关键的区别是：

> **不要把“context compression”理解成“把旧信息总结得更短”，而应该理解成“决定什么此刻需要进入模型，同时保证任何被移出的信息仍然可检索、可验证、可恢复”。**

这其实与 Anthropic 目前公开的 context-engineering 方法高度接近：它明确把 context 当作有限资源，主张使用 just-in-time retrieval、compaction、structured memory 和 sub-agent architecture，而不是把所有历史持续塞进主模型窗口。Anthropic 还明确指出，工具应当返回 token-efficient 的信息，并把 “clearing tool calls/results” 视为相对安全的轻量级 compaction 手段。citeturn22view0

对你的三个判断，我会这样评价：

| 你的判断 | 我的结论 | 需要修改的地方 |
|---|---|---|
| Observation 是 coding agent 最大的 context 污染来源之一 | **强烈同意** | 不能只做旧 observation masking；应该是 raw observation 外置 + structured receipt + 按需 rehydrate |
| 早期关键信息被推到中间会使执行变差 | **基本同意** | “因此把最新用户信息放到 context 头部”并不是最佳结论；更合理的是 **stable constraints 放头部，current task 放尾部** |
| 摘要/递归压缩导致信息丢失 | **同意** | 问题不是必须避免 lossy compression，而是必须让 compression **可恢复且有 provenance** |
| 每次有价值修改都 Git commit | **方向正确** | 不应每次 edit 都 commit，而应在“验证成功的原子工作单元”后 checkpoint；最好用 agent branch/worktree |
| Git 可以承担长期记忆 | **只对一半** | Git 是 code-state/provenance memory，不是 semantic memory；它不知道未采用的方案、用户偏好、失败实验等 |
| Aider Repo Map 可以扩展为全局理解 | **非常值得做，而且必须实时同步** | Repo Map 应是与 workspace revision 绑定的增量导航索引；增加 Git/change/memory overlay，并在每次模型使用前验证 freshness |

还有一点需要先纠正：你说 Claude Code 使用“observation masking”，这个理解在效果上是接近的，但 Anthropic 当前公开文档里的术语更接近 **tool-result clearing / context editing**。Claude Code 官方文档现在明确写到，当 context 变满时，它会**先清理旧的 tool outputs，再在必要时进行 summary/compaction**；Claude API 则公开提供了 tool-result clearing，并允许客户端继续保存完整、未修改的历史。citeturn20search8turn18search6

也就是说，**“模型看到的上下文”和“系统真实保存的历史”完全可以不是同一份东西**。这正是我认为你的方案最应该进一步发展的地方。

## 现状核查：Pi 和 Claude 实际上已经走到了哪里

### Pi 的问题确实有 GitHub 记录，但需要区分“历史问题”和“当前必然仍可复现”

你的判断“Pi 会因为长 tool loop 而超出配置的 contextWindow”并不是猜测。

2026 年 4 月 6 日的 Pi issue #2871 报告：auto-compaction 当时主要在整个 agentic turn 结束后和下一次用户 prompt 前检查，而长时间连续 tool call 可以让一个约 170K-token 的上下文一路增长到 400K+，超过配置窗口而仍没有中间 compaction。citeturn12search1

4 月 23 日的 #3609 进一步指出，工具返回结果加入 history 后，下一次 LLM request 之前缺少相应的 `_checkCompaction()`，在 32K local model 上尤其容易触发 context overflow。citeturn12search0

6 月 8 日的 #5512 又针对当时的 `main` 报告了相同架构问题：assistant usage 尚未超过 threshold，但加入大 tool result 后，loop 会直接发起下一个 provider request，而没有基于新增结果再次进行可靠的 context backpressure。citeturn12search2

所以你的问题定位是有现实依据的。

不过这里必须保持严谨：**这些 issue 现在已经关闭，而 Pi 随后经历过 refactor，因此不能仅凭这些 issue 断言 2026 年 8 月 13 日的当前 main 一定仍然存在完全相同的 bug。**我检索到的当前 Pi extension API 已经明确保证 `context` event 会在**每一次 LLM call 前**触发，并允许 extension 非破坏性地修改即将发送的 message context；`tool_result` 也允许在工具执行完以后修改 result。fileciteturn4file0L2-L2

但另一方面，我没有找到一份足够明确的当前官方说明，可以证明：

> **“最终 provider payload 在每一次 model sampling 前，一定经过基于实际输入大小的 hard context invariant 检查，并且永远不会超过模型真实 max input limit。”**

因此，更准确的结论应该是：

> Pi 历史上明确存在 long tool loop 导致 context overflow 的架构问题；当前扩展层已经提供了更好的 per-call context interception 能力，但我不会在没有当前代码路径完整验证的情况下声称这个问题已经彻底解决，或者仍然原样存在。

这一区分很重要。

### Pi 现在的 compaction 已经比简单的 sliding window 复杂，但本质仍然是 lossy working-context compression

Pi 当前文档描述的默认机制是：

`contextTokens > contextWindow - reserveTokens` 时触发 compaction；默认 `reserveTokens` 为 16,384。系统从后向前寻找 cut point，通常保留最近约 20K tokens，把更旧内容总结为 structured summary，然后让模型看到：

```text
system
+ compaction summary
+ recent messages
```

并且它支持 single huge turn 的 split-turn compaction，不会直接在 tool result 上切断，因为 tool result 需要与相应 tool call 保持关联。fileciteturn5file0L2-L2

Pi 的 summary 还专门保留：

```text
Goal
Constraints & Preferences
Progress
Key Decisions
Next Steps
Critical Context
read-files
modified-files
```

这实际上已经体现出它在尝试做“状态压缩”，而不仅仅是普通对话摘要。fileciteturn5file0L2-L2

但你的担心依旧成立，因为它还是有两个 loss channel。

第一，Pi 在把历史送给 compaction summarizer 之前，就会把每个 tool result 截断到 2,000 个字符，以避免 compaction request 本身被 `read`、`bash` 等大型结果撑爆。fileciteturn6file0L2-L2

第二，后续 compaction 会继续参考 previous summary，因此长期运行时模型越来越依赖一个经过压缩的状态表示。Pi 的原始 session 数据并不等于被物理删除，但**模型对历史细节的直接可访问性确实降低了**。fileciteturn5file0L2-L2

所以更准确的说法不是“Pi 删除了旧信息”，而是：

> **Pi 会逐步降低旧信息在 active model context 中的 fidelity，而目前没有把所有被压缩细节都变成一等公民、可查询的 retrieval objects。**

这才是你真正可以改进的地方。

### Pi 已经限制单次 observation，但“累计 observation”仍是不同的问题

Pi 当前 extension 文档明确要求工具输出进行 truncation，并提供约 **50 KB / 2,000 lines** 的 built-in truncation 约束和相关 helper。citeturn13search0

所以不能简单说“Pi 完全没管 tool output”。

它管的是：

> **single-observation size**

而你提出的问题更多是：

> **cumulative-observation residency**

例如：

```text
read -> 8k
grep -> 6k
bash -> 10k
read -> 9k
test -> 8k
read -> 7k
...
```

单个结果全部合法，却可以在一个连续 tool loop 中很快形成几十万 token。

这两个问题必须分开解决。

### Claude Code 的当前设计实际上相当支持你的方向

Claude Code 官方现在明确描述了三个相关行为。

第一，当 context 变满时，它会先清理旧 tool outputs，然后再根据需要 compact conversation；它也提醒“很早出现的 detailed instructions 可能在 compaction 后丢失”，因此要求真正需要长期生效的规则放进持久 context files，而不是只留在聊天历史中。citeturn20search8

第二，Claude Code 的 subagent 使用独立 context window。大型 file reads、research results 等可以留在 subagent 内，parent 只收到 summary 和少量 metadata，因此不会把详细观察全部带回 main context。citeturn20search0turn20search5

第三，Anthropic API 的 programmatic tool calling 更进一步：模型可以生成一段程序，在一个 execution environment 中连续调用多个工具，**中间 tool results 根本不会进入 Claude 的 conversation context，只有最后经过过滤或聚合的结果才返回主模型**。Anthropic 将它明确定位在 multi-tool workflow、大结果过滤和 agentic retrieval 上。citeturn18search7turn18search4

这三者可以看成：

```text
Tool-result clearing
        ↓
旧 Observation 不继续常驻

Programmatic tool execution
        ↓
中间 Observation 从一开始就不进入主 context

Subagent
        ↓
复杂推理 + Observation 整体隔离到另一个 context
```

而你提出的“临时工具上下文”，基本位于后两者之间。

## 你的三个核心假设：哪些成立，哪些需要改

### Observation 问题：判断正确，但不要给“每一个 tool call”都开 subagent

我非常赞同你把 observation 单独管理。

但是：

> **“每个工具调用都有自己的临时 LLM context”并不是最佳粒度。**

因为很多工具调用本身根本不值得产生另一次模型推理。

例如：

```text
grep 50 files
→ parse result
→ select 3 files
→ read those files
→ extract symbols
```

如果每一步：

```text
parent LLM
→ subagent
→ tool
→ subagent summary
→ parent LLM
```

你反而会得到：

- 额外 sampling cost；
- subagent 初始化 token；
- 重复读取 project context；
- latency；
- parent / child 状态同步问题。

Claude Code 官方文档也明确指出：subagent 每次从 fresh context 开始，会花时间重新 gather context；当多个阶段高度共享上下文或需要频繁迭代时，main conversation 更合适。citeturn20search5

因此，我建议把粒度从：

> one tool call → one temporary context

改成：

> **one high-entropy tool episode → one isolated execution context**

所谓 tool episode，例如：

```text
“找出 authentication subsystem 的结构”
“分析 5000 行 test failure”
“检查整个仓库所有调用关系”
“搜索 30 个文件后找出最可能的 bug”
“分析 build log 并给出最小根因”
```

这类任务适合 subagent。

而：

```text
read one file
git diff
run one unit test
write one edit
```

不值得。

更合理的决策矩阵是：

| 情况 | 处理 |
|---|---|
| 小且直接的 tool result | 原样进入 main context |
| 大型单次 result | raw archive + compact receipt |
| 大量可程序化过滤的 tool calls | execution worker / programmatic processing |
| 大量 exploration，需要 LLM 推理 | isolated subagent |
| 连续修改代码、上一步决定下一步 | main agent，保留小规模 hot observations |

这实际上比“所有 observation 都 subagent 化”更高效。

### 中部信息问题：你的因果猜测合理，但“把最新用户指令放头部”不是最佳方案

这里是我认为你原方案中最值得修改的一点。

经典的 *Lost in the Middle* 研究确实发现，在长 context 的 multi-document QA 和 key-value retrieval 中，相关信息放在 context **开头或结尾**时通常表现更好，而位于中间时性能下降。citeturn17academia24

所以你的这个过程：

```text
User critical instruction
↓
tool result
↓
tool result
↓
tool result
↓
tool result
↓
critical instruction becomes deep-middle context
```

确实是一个非常合理的 failure hypothesis。

但是更新的研究增加了一个重要细节：当输入逐渐逼近模型 context-window 上限以后，**primacy advantage 会减弱，而 recency advantage 往往相对稳定**。换句话说，在非常长的输入下，“离尾部更近”可能比“放在最开头”更加可靠。citeturn17academia25

Google 当前 Gemini 官方 prompting guidance 也直接建议：对于 large-context prompt，先提供 context，再把具体的 instruction/question 放在**最后**。citeturn17search13

所以：

> **“把最新用户指令每次都搬到最前面”不是一个跨模型都可靠的策略。**

它还有另外三个工程问题。

首先，会破坏 conversation chronology：

```text
user A
assistant
tool
user B
assistant
```

被重排以后，模型可能无法判断：

> A 是旧要求，B 是新的 override。

其次，旧 user instruction 和新 user instruction 有可能冲突。

例如：

```text
turn 1: use REST
turn 20: actually switch this to GraphQL
```

如果你把两条都当成“important user information”重复放到前面，很容易形成 contradictory anchor。

第三，tool-call / tool-result 有自己的结构约束。Pi 的 compaction 文档甚至专门指出，tool result 不应该与对应 tool call 分割。fileciteturn5file0L2-L2

所以我推荐的不是：

```text
[latest user message]
[entire history...]
```

而是：

```text
┌───────────────────────────────┐
│ Stable Contract               │ ← HEAD
│ system / project invariants   │
│ persistent user preferences   │
│ safety / coding conventions   │
├───────────────────────────────┤
│ Working Context               │
│ recent conversation           │
│ retrieved code/memory         │
│ hot tool observations         │
├───────────────────────────────┤
│ Current Task Capsule          │ ← TAIL
│ current goal                  │
│ latest user constraints       │
│ current step                  │
│ unresolved blocker            │
└───────────────────────────────┘
```

也就是一种 **bookended / sandwich context**：

> **稳定约束靠前，当前任务靠后。**

而且 tail 里的 Current Task Capsule 不是复制所有 user messages，而是一个很短、版本化的结构：

```yaml
task_revision: 14
goal: Fix Pi context overflow during tool-heavy turns
current_step: Implement observation virtualization
must_preserve:
  - raw tool output must remain retrievable
  - do not modify user-owned commits
latest_user_override:
  - prefer extension-first implementation
blocked_by: null
```

每次只存在**一个 active capsule**。

用户改变要求时：

```text
revision 14
→ replaced by
revision 15
```

而不是继续累积。

这样就不会自己制造新的 context pollution。

还有一个很重要的分析点：你观察到“越新的用户信息作用越重”，未必全部来自 position bias。这里至少混合了两种效应：

```text
recency / position
+
semantic chronology
```

模型本来就应该把“用户后来的明确修改”理解成对早先要求的更新。

所以不能只通过位置实验去推断因果，需要专门做 ablation，这一点我会在后面给出实验方法。

### 信息压缩：真正的问题不是 lossy，而是 irreversible

任何固定 context-window 系统，只要运行时间足够长，最终都必须：

```text
丢弃
压缩
外置
重新检索
```

四选一或组合。

因此：

> **“完全不丢信息的 active context compression”本身是不现实的。**

真正应该避免的是：

> **irreversible lossy compression**

例如：

```text
raw history
   ↓
summary A
   ↓
summary B of summary A
   ↓
summary C of summary B
```

如果 B 漏掉一个细节，那么 C 没有办法重新发现它。

这可以称为 summary-of-summary degradation。

Anthropic 自己也指出，compaction 的关键难点正是决定什么保留、什么删除；过于 aggressive 的 compaction 可能丢失只有之后才显现出价值的细节，因此它建议 compaction 优先保证 recall，再慢慢改善 precision。citeturn22view0

解决办法不是拒绝 summary，而是：

```text
                    ┌── active summary
                    │
raw immutable data ─┼── searchable memory
                    │
                    ├── git history
                    │
                    └── observation artifacts
```

summary 只是 **view**，而不是 source of truth。

这正是整个方案最核心的设计原则。

## 更合理的架构：从“双上下文”扩展为“可恢复的三数据平面 + 控制平面”

我建议把你的 dual-context 进一步抽象成三个承载数据的平面，再增加一个负责一致性、预算和策略执行的 Control Plane：

```text
 ┌──────────────────────────────────────────────────────────┐
 │ Control Plane                                            │
 │ budget · freshness · invalidation · policy · fallback   │
 └───────────────┬───────────────────────────────┬──────────┘
                 │                               │
       ┌─────────▼─────────┐           ┌─────────▼─────────┐
       │   Working Plane   │           │ Persistent Plane  │
       │ bounded context   │◄──────────│ canonical events  │
       │ task capsule      │ retrieval │ observations      │
       │ relevant map slice│           │ git / typed memory│
       └─────────┬─────────┘           │ derived indexes   │
                 │                     └─────────▲─────────┘
                 │ structured receipt           │
       ┌─────────▼─────────┐                     │
       │  Execution Plane  │─────────────────────┘
       │ tool episodes     │  archive / checkpoint
       │ subagents/workers │
       └───────────────────┘
```

严格说，第三层不是“LLM context”，而是 persistent source-of-truth，因此从模型视角你的“双上下文”仍然成立：

```text
Main Context
+
Temporary Execution Context
```

只是工程上必须再加：

```text
Persistent Recovery Layer
```

否则 temporary context 一旦结束，还是有不可恢复的信息丢失问题。Control Plane 也不是第四份上下文；它不承载主要业务事实，而是确保其余三个平面的装配结果始终满足预算、新鲜度、权限和可恢复性约束。

### 先明确事实层级：哪些是事实，哪些只是派生视图

多平面架构最容易出现的问题，是 session、memory、Git、Repo Map 和 summary 各自保存一份“当前状态”，但彼此不一致。因此必须先定义权威性：

```text
代码文件 + 原始用户事件 + 原始工具证据
                ↓
      durable evidence / canonical facts
                ↓
Git checkpoint + typed memory + task state
                ↓
Repo Map + retrieval result + compaction summary
                ↓
        model-visible prompt view
```

其中：

- 文件内容、用户原始消息和带 hash 的原始 observation 是可验证事实；
- Git、typed memory 和 TaskState 是带来源的结构化状态；
- Repo Map、摘要、ranking 和 prompt 都是 **derived views**，必须能够重建；
- 当派生视图与当前 workspace revision 不一致时，必须刷新、降级或显式标记 stale，不能静默当作事实使用。

### Persistent Plane：永远不依赖 LLM context 生存

这里应该保存四类东西：

```text
Pi session/event log
Raw observations
Git state/history
Semantic memory/indexes
```

其中 raw observation 建议 content-addressed：

```text
.pi/context/observations/
    sha256-37a8...
    sha256-10ef...
    ...
```

每一条记录包含：

```json
{
  "id": "obs_01H...",
  "tool": "bash",
  "input": "npm test",
  "timestamp": "...",
  "exitCode": 1,
  "bytes": 183442,
  "sha256": "...",
  "artifact": "...",
  "sessionEntryId": "...",
  "commit": "..."
}
```

不要直接 Git-track 这些大日志。

否则 repository 自己会被 agent memory 污染。

### Control Plane：预算、一致性和降级策略的执行者

Control Plane 负责跨平面约束，而不是再保存一份项目知识。它至少应管理：

```text
Context budget and final-request guard
Workspace revision and Repo Map freshness
Observation lifecycle and artifact retention
Memory authority / conflict / expiry
Prompt assembly order
Cache-aware batch pruning
Failure detection and fallback
```

它应建立几条硬 invariant：

```text
发送给 provider 的最终输入不得超过 hardInputBudget

被 receipt 替换的原始 observation 必须已经安全持久化

注入 prompt 的 Repo Map slice 必须匹配当前 workspace revision，
或者明确标记 stale 并同时提供回退路径

任何 derived view 都不能覆盖或删除其 canonical evidence
```

这样 context management 才不是散落在多个 extension hook 中的启发式逻辑，而是一套在每次 sampling boundary 都能检查的运行时协议。

### Working Plane：主 Agent 只看到“当前最值得看的东西”

这里不再是：

```text
entire transcript
```

而是：

```text
Stable Contract
Current state summary
Relevant retrieved memory
Relevant repo map
Recent conversation
Hot observations
Current Task Capsule
```

Anthropic 的 context-engineering 指南本身也在强调这一原则：目标是找到**尽可能小的高信号 token 集合**；对于大数据，它推荐保存轻量 identifier，再让 Agent 根据需要通过工具动态读取，而不是预先加载所有数据。citeturn22view0

这与我建议的：

```text
obs_123
commit abc123
symbol AuthService.login
memory decision_41
```

完全一致。

模型不需要一直看到具体内容。

它只需要知道：

> “那里有东西，以及怎样拿回来。”

### Execution Plane：Observation 的真正隔离区

它负责：

```text
repo exploration
large log analysis
large search
dependency investigation
many-file reading
test failure triage
```

一个 tool episode 返回 main agent 的不应该是 raw transcript，而是一个 **Observation Receipt**：

```yaml
observation_id: obs_7f2a
task: Diagnose failing auth tests
status: failure-understood

summary:
  Root cause is a stale refresh-token comparison.

key_facts:
  - failing test: refreshToken.spec.ts:184
  - expected expiresAt > now
  - actual code compares issuedAt

relevant_files:
  - src/auth/token.ts
  - test/auth/refreshToken.spec.ts

unresolved:
  - verify compatibility with legacy tokens

artifacts:
  raw_log: obs_7f2a/log
  search_trace: obs_7f2a/search

evidence:
  - artifact: obs_7f2a/log
    line_range: [351, 367]
    sha256: 37a8...
    extraction: deterministic

interpretation:
  confidence: verified
  generated_by: diagnose-worker

recommended_next:
  - inspect TokenService.refresh()
```

主 Agent 看到几百 tokens。

底层可能实际上产生了：

```text
60K log
+
20 file reads
+
15 grep outputs
+
10K reasoning
```

这就是非常大的 context saving。

而一旦模型发现 summary 不够：

```text
obs_get("obs_7f2a", grep="legacy")
```

即可重新加载。

这比“把旧 observation 一刀切 mask 掉”安全得多：

> masking + retrievability > masking alone。

Receipt 必须区分“原始证据”“确定性提取结果”和“LLM 推断”。每一个关键结论都应尽量带 artifact、line/byte range 和 hash，使主 Agent 可以局部验证，而不是把一段无法追溯的自然语言摘要当成新事实源。

### Observation 应该分 hot / warm / cold，而不是简单按年龄删除

我建议至少有四个状态：

| 类型 | 例子 | Main context 中的处理 |
|---|---|---|
| Pinned | 当前用户 constraint、未解决 critical failure | 持续保留 |
| Hot | 刚读的代码、当前 test failure | 保留完整或较完整 |
| Warm | 已经被下一步 reasoning 使用过的 read/search | receipt |
| Cold | resolved error、旧 log、大搜索结果 | 只有 ID/极短摘要 |

对于不同工具采用不同规则：

```text
read:
  recent relevant section → hot
  old full file → receipt

grep/search:
  matches consumed → warm/cold

bash success:
  command + exit code + key output
  full stdout → artifact

bash error:
  command
  exit code
  exception/root cause
  first/last relevant frames
  full stderr → artifact

edit/write:
  operation summary
  changed files
  exact state → git diff

test:
  failing test names
  primary assertion
  minimal stack
  full test output → artifact
```

这比让一个 LLM 对每一条 tool result 做 summary 更好。

原因是大量信息可以 deterministic compression：

```text
重复日志
ANSI
progress bars
vendor stack frames
相同 warning
成功的测试明细
```

不值得额外采样一次模型。

### 不要每一次 call 都 pruning：Prompt Cache 是一个容易遗漏的问题

这是你原方案中没有提到但实际非常重要的一点。

Anthropic 的 context-editing 文档明确指出，tool-result clearing 会让发生清理位置之后的 cached prompt prefix 失效，因此它提供了类似 `clear_at_least` 的机制，让一次清理足够多的 tokens，以摊薄 cache invalidation 成本。citeturn18search3turn18search6

所以绝对不推荐：

```text
request 1 → delete 1 old result
request 2 → delete another result
request 3 → delete another result
...
```

应该采用 hysteresis：

```text
soft watermark reached
        ↓
batch prune
        ↓
drop back to target watermark
        ↓
keep prefix stable for a while
```

例如作为初始实验值，而不是普适最优值：

```text
hard input budget = 100%
soft trigger      = 80%
post-prune target = 60–65%
```

一次清 15–20% 左右，而不是不断改 prompt prefix。

另外，prompt caching **只减少重复 token 的计费/计算成本，并不会减少模型实际需要容纳的 context 信息量**，因此不能解决 overflow 或 lost-in-the-middle 本身。Anthropic 当前 tool-context 文档也明确区分了 caching 和 context editing 的作用。citeturn18search7

## Git、Repo Map 与长期记忆应该怎样组合

### Git 的方向非常好，但 Git 应当是“项目状态记忆”，不是“Agent 的全部长期记忆”

这一点我非常赞同你的基本出发点。

Anthropic 在其 long-running coding-agent 实验中，实际上已经做了与你非常接近的设计：

```text
claude-progress.txt
+
git history
+
incremental feature work
+
descriptive commits
```

后续 agent 在 fresh context 中先读 progress file 和 git log，再决定下一步工作；Anthropic 的实验报告明确认为这种方式使新 agent 能快速理解项目状态，并允许通过 Git 恢复错误代码状态。citeturn22view1

所以：

> **Git + structured progress/memory 是经过真实 long-running coding harness 实践验证过的方向。**

但是我不同意“每次有价值修改或者切片修改成功立即直接在用户 branch 上 commit”作为默认行为。

更合理的单位是：

> **verified atomic milestone**

也就是：

```text
实现一个 coherent slice
      ↓
相关 lint/test 通过
      ↓
git diff inspected
      ↓
commit
```

而不是：

```text
edit
commit
edit
commit
fix typo
commit
test fails
commit
...
```

否则 Git history 自身就会从 memory 变成 noise。

更大的风险是：

```text
用户本来有 uncommitted changes
+
Agent 自动 git add .
+
Agent commit
```

这会把用户自己的工作一起卷进去。

所以更好的模式是：

```text
User working tree
       │
       ├── normal mode
       │
       └── Pi agent worktree / branch
               │
               ├── verified commit A
               ├── verified commit B
               └── verified commit C
```

例如：

```text
pi/<session-id>
```

最终再：

```text
cherry-pick
merge
rebase
squash
```

到用户 branch。

你把 Git 称为“时间树”很直观，不过严格来说 Git 的 commit history 更接近由 parent relationships 构成的有向无环提交图，而不是简单树；这反而更适合 branch、merge 和并行 Agent checkpoint。fileciteturn11file0L1-L5

### Commit message 不应该承担全部 Agent memory

建议：

```text
commit
= authoritative code state checkpoint

memory record
= why / what / constraints / failures / decisions
```

例如 commit：

```text
Fix refresh-token expiry validation

Pi-Session: 8f1d
Pi-Task: auth-refresh
Pi-Tests: auth-refresh-token
```

然后 memory：

```json
{
  "id": "decision_41",
  "type": "decision",
  "text": "Keep legacy refresh tokens compatible until migration v4.",
  "source": {
    "userEntry": "entry_812",
    "commit": "a37ef1",
    "files": [
      "src/auth/token.ts"
    ]
  },
  "status": "active"
}
```

这样 commit log 仍然给人类看。

详细 Agent state 放 semantic memory。

Git 本身无法表达很多关键东西，例如：

```text
用户偏好
已经尝试过但失败的方案
为什么没有采用 architecture B
某一个 external API observation
某一次失败 test 的完整 log
尚未进入代码的设计决定
```

所以 Git 绝对不能取代 memory store。

### Aider Repo Map 很值得借鉴，但不要把它理解成“整个 repo 的自然语言摘要”

Aider 官方 Repo Map 的设计非常值得采用。

它会提取仓库里的重要：

```text
files
classes
functions
types
signatures
definitions
```

然后构建代码关系图，对相关部分进行 ranking，只选择能放进当前 token budget 的最重要 repo-map 片段，而不是把整个项目全文放进去。Aider 文档还明确说明，默认 map token budget 大约为 1K，并会根据当前 chat 状态动态调整。citeturn16view0

这和你的思路高度一致，但我建议继续扩展成一个多分辨率 **Project Map**：

```text
L0 Project Identity
│
│ README / AGENTS.md
│ purpose
│ build system
│ test commands
│ architectural invariants
│
├── L1 Module Map
│      frontend
│      auth
│      database
│      provider
│      ...
│
├── L2 Dependency Graph
│      module → module
│      file → file
│
├── L3 Symbol Graph
│      classes
│      functions
│      references
│
├── L4 Change Overlay
│      git diff
│      recently modified files
│      recent commits
│      current branch
│
└── L5 Memory Overlay
       decisions
       unresolved bugs
       requirements
       observation refs
```

但是，Project Map 的关键不只是“包含哪些层”，而是它必须与当前工作区实时同步。它不是定期生成的静态文档，而是由代码事实派生出来、与 workspace revision 绑定的增量索引。

#### 更新触发条件：看语义影响，不只看修改大小

“大文件变动后更新 Map”仍然不够严格。一个只有 5 行的 public API 签名修改，可能影响几十个调用者；一次 5,000 行格式化则可能完全不改变语义图。因此所有文件变化都应先进入 change pipeline，再按变更类型决定更新范围：

| 变更 | 必须更新的内容 |
|---|---|
| 函数内部实现变化 | symbol digest、change overlay、必要的行为标签 |
| 函数/类型签名变化 | definition、references、call edges、影响范围 |
| import/export 变化 | file/module dependency graph |
| 创建、删除、重命名 | path node 及所有关联边 |
| 构建配置、入口、依赖清单变化 | project identity、build graph、external dependencies |
| 纯格式化 | content hash；语义 hash 未变时复用原图节点 |

变化来源不仅包括 Agent 的 `edit/write/apply_patch`，还包括用户或 IDE 的外部编辑，以及 `checkout/merge/rebase/cherry-pick` 等 Git 操作。只监听 Agent 工具会产生一个危险盲区：模型可能在用户已经改过代码后继续使用旧地图。

#### 两级实时更新：快速同步 + 深度索引

每个字符变化都全量重建 symbol/reference graph 会破坏交互延迟。更合理的是：

```text
filesystem / edit / git event
          ↓
Workspace Change Event
          ↓
立即标记受影响节点 dirty
          ↓
Fast Update
  path / hash / diff / imports / exports / top-level symbols
          ↓
Deep Update
  references / callers / dependency propagation / ranking
```

Fast Update 必须在下一次相关 model sampling 前完成。Deep Update 可以对短时间内的连续编辑做 debounce，在一个 edit batch、测试结束或 checkpoint 后合并执行。

#### Base Map + Dirty Overlay

Project Map 应拆成：

```text
Base Map
= 当前 Git HEAD 对应的稳定索引

Dirty Overlay
= 未提交 workspace changes 导致的节点和边变化

Effective Map
= Base Map + Dirty Overlay
```

checkpoint 后将 overlay 原子合并为新 Base Map。这样既能实时反映未提交修改，也不必每次 edit 都全仓重建。

每个 Map snapshot 和查询结果都必须携带 freshness metadata：

```yaml
map_version: 184
workspace_revision:
  git_head: a81f20c
  dirty_hash: 73fc9e
indexed_at: 2026-08-14T15:32:10+08:00
status: fresh
pending_files: []
```

其中 `dirty_hash` 应来自规范化的工作区变更集合，而不只是 `git status` 文本。查询还应标记每个关键节点来自静态解析、运行时证据还是模型推断。

#### 使用 Map 前必须经过 freshness guard

```text
prepare model context
        ↓
resolve current workspace revision
        ↓
check task-relevant Map nodes
        ↓
incrementally refresh dirty nodes
        ↓
retrieve and rank relevant slice
        ↓
inject slice with revision metadata
```

硬约束应该是：

> 如果本轮 prompt 使用 Repo Map，相关 Map 节点必须与当前 workspace revision 一致；如果解析器或索引更新失败，系统必须显式标记 stale，并回退到文件读取、lexical search 或 Git diff，不能静默注入旧地图。

模型正常情况下只看到：

```text
L0
+
task-relevant L1
+
top-ranked L2/L3
+
recent L4
+
critical L5
```

如果需要再：

```text
repo_map(
  query="refresh token validation",
  depth=2
)
```

而不是每一轮把完整 map 放进 prompt。

这是很关键的一点：

> **Global understanding ≠ global context injection.**

真正好的“全局理解”应该是：

> 一个能让模型快速找到局部细节的全局导航结构。

### 长期 Memory 不应该继续做“递归摘要”，而应该做原子事实记录

这是我认为整个架构第二重要的部分。

不要维护：

```text
memory.md
↓
越来越长
↓
summary memory.md
↓
summary summary
```

而应该把记忆拆成 typed records：

```text
requirement
user_preference
decision
invariant
discovery
failure
attempt
unresolved_issue
checkpoint
```

例如：

```json
{
  "id": "mem_00081",
  "type": "requirement",
  "value": "Do not modify the database migration format.",
  "authority": "user",
  "confidence": "verified",
  "scope": "project",
  "createdAt": "...",
  "validFrom": {
    "gitHead": "...",
    "dirtyHash": "..."
  },
  "sourceEntries": ["session-entry-171"],
  "supersededBy": null
}
```

用户后来改口：

```json
{
  "id": "mem_00124",
  "type": "requirement",
  "value": "Migration format may be changed for v4 only.",
  "authority": "user",
  "createdAt": "...",
  "sourceEntries": ["session-entry-288"],
  "supersedes": ["mem_00081"]
}
```

于是系统知道：

```text
mem_00081 = historical
mem_00124 = active
```

而不是让 summary model 自己猜：

> 到底哪个要求是最新的？

Memory store 还必须定义确定性的权威与失效规则：

```text
explicit user requirement
    > repository/tool verified fact
    > agent inference

newer explicit override
    > older requirement in the same scope
```

每条记录至少应声明 `authority`、`confidence`、`scope`、`evidence`、`validFrom/validUntil` 和 `supersedes`。模型推断必须标成 `inferred`，不能因为被写进 memory 就升级成已验证事实；如果对应代码被回滚、文件被删除或 workspace revision 越出有效范围，记录应自动进入 stale/revalidation 状态。

检索层我会先做：

```text
SQLite FTS / BM25
+
filename / symbol matching
+
recency
+
authority
```

然后再考虑 embeddings。

原因是 coding context 里：

```text
TokenService.refresh
src/auth/token.ts
ERR_INVALID_TOKEN
commit 8b31a4
```

这种 exact lexical identifier 往往非常重要，不能只依赖 semantic embedding。

## 在 Pi 上我建议怎样真正落地

### v0.1.0 实施状态（2026-08-14）

本文提出的是完整研究架构；`pi-context-vault` v0.1.0 已经把其中可由 extension 可靠拥有的第一批能力实现为
可安装插件，而不是声称整套未来架构已经完成：

| 研究能力 | v0.1.0 状态 | 实际边界 |
|---|---|---|
| Observation Vault | 已实现 | 脱敏后内容寻址归档、即时 receipt、历史 masking、`obs_get/search` |
| 实时增量 Repo Map | 已实现 | TS/JS 语义索引、其他文本词法索引、Base + Dirty overlay、Git HEAD guard |
| 外部修改同步 | 已实现 | 真实 chokidar watcher 等待 ready；每次相关 add/change/unlink 立即 invalidation 与 fast update |
| Map 原子一致性 | 已实现 | generation 临时写入后切换 active；并发 runtime 通过文件锁串行激活；损坏 generation 拒绝加载 |
| Pi runtime surfaces | 已实现 | 四个 tools、`/context-vault status|rebuild|gc|doctor`、有界非持久化 Map capsule |
| Current Task Capsule / typed memory / Git checkpoint / tool-episode subagent | 未实现 | 保留为后续独立实验，不属于 v0.1.0 接口 |
| Final-request token guard | extension 中不可实现 | 必须在所有 transform 后、provider sampling 前由 Pi core 执行 |

> v0.1.0 发布后的下一版本开发状态：当前 `main` 已增加纯 Node Java CST 语义索引，覆盖 package/import、类型与
> member 声明、注解、泛型、源码行号及 `extends`/`implements`/`permits` 语法关系，并复用同一套增量 watcher、
> Git HEAD guard 与原子 generation 协议。它不会执行 Maven、Gradle、`javac`、annotation processor 或项目代码，
> 也不声称完成类型求解、call graph、依赖解析或 Lombok 推导。不可变的 v0.1.0 tag 仍然只有 TS/JS 语义索引；
> Java AST 能力必须由后续 tag 发布。

v0.1.0 的 Repo Map 实时同步协议是：watcher 收到任何非排除文件变化后立即把 path 标为 stale/pending，串行执行
文件级 fast update；下一次查询或 model context 使用前执行 `ensureFresh()`，核对当前 Git HEAD、从 `git status`
重算规范化 dirty path 集合、更新 Dirty Overlay，再通过完整 generation 文件和 `active.json` 指针原子切换。纯粹
依赖 Agent 自身 edit/write 事件是不够的，因此该实现也覆盖 IDE、用户进程和 Git checkout 等外部变化。

模型不会收到“整个项目 summary”，只收到与本轮 query 有关且有字节上限的 Map slice。该 slice 必须携带
`workspaceRevision` 和 freshness；如果解析、读取或 generation 激活失败，它必须显式为 `stale` 并带 source/
`git diff` fallback evidence。这里的“实时”指下一次相关使用前完成 freshness guard，而不是对每个字符变化执行
全仓 deep rebuild。

还必须强调：extension 的 `context` hook 可以显著降低 model-visible context，但它看不到最终 provider 序列化
边界，所以不能保证最终 payload 永远不超限。本文所述 final-request hard invariant 仍然是 Pi core patch 的 P0，
不能因为 v0.1.0 已交付 Observation/Repo Map 能力就把它写成 extension guarantee。

我会把实现拆成 extension POC 和一个很小但关键的 Pi core patch，但不会按下文章节出现顺序同时开发所有组件。更合理的优先级是：

| 优先级 | 能力 | 首要验收条件 |
|---|---|---|
| P0 | Final-request token guard | oversized provider requests = 0 |
| P1 | Observation archive + receipt + retrieval | eviction 后关键事实可恢复 |
| P1 | 实时增量 Repo Map | 查询节点与 workspace revision 一致 |
| P2 | Current Task Capsule | 长 tool loop 后约束违反率下降 |
| P2 | Typed memory + state materialization | 多次 compaction 后仍可回查证据 |
| P3 | Git/snapshot checkpoint | fresh context 可恢复到已验证状态 |
| P4 | Tool-Episode Subagent | 节省主上下文且不降低成功率 |

其中 P0 需要一个窄而明确的 core patch，其余能力优先通过 extension 验证。实时 Repo Map 与 Observation Vault 可以并行设计，因为二者都依赖 workspace revision、artifact identity 和 retrieval API。

原因是 Pi 当前已经暴露了非常适合你这个实验的 extension hooks。

当前文档明确给出了：

```text
context
→ before every LLM call
→ can modify messages non-destructively

tool_result
→ after tool execution
→ can modify result

session_before_compact
→ can replace/customize compaction

registerTool
→ custom retrieval tools
```

fileciteturn3file0L2-L2 fileciteturn4file0L2-L2

所以大约 **70–80% 的想法没有必要一开始 fork Pi core。**

### 组件 A：Context Vault Extension

建议目录：

```text
.pi/
└── extensions/
    └── context-vault/
        ├── index.ts
        ├── artifact-store.ts
        ├── observation-policy.ts
        ├── task-state.ts
        ├── memory-store.ts
        ├── repo-map.ts
        ├── repo-map-updater.ts
        ├── workspace-revision.ts
        ├── freshness-guard.ts
        ├── git-checkpoint.ts
        └── retrieval.ts

.pi-state/                  # 默认 gitignore
├── observations/
├── memory.sqlite
├── repo-index.sqlite
└── task-state.json
```

不要把：

```text
logs
raw observations
SQLite cache
```

提交进用户 repo。

#### 在 `tool_result` 做 immediate observation virtualization

逻辑：

```text
tool result
   ↓
small?
 ├─ yes → normal
 └─ no
      ↓
archive raw result
      ↓
generate deterministic receipt
      ↓
return receipt to Pi
```

概念代码：

```ts
pi.on("tool_result", async (event, ctx) => {
  const raw = serializeToolContent(event.content);
  const size = Buffer.byteLength(raw, "utf8");

  if (size < config.archiveThresholdBytes) {
    return;
  }

  const artifact = await artifactStore.put({
    sessionId: ctx.sessionManager.getSessionId(),
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    input: event.input,
    raw,
    isError: event.isError,
  });

  const receipt = buildToolReceipt({
    artifact,
    toolName: event.toolName,
    input: event.input,
    raw,
    isError: event.isError,
  });

  return {
    content: [
      {
        type: "text",
        text: receipt,
      },
    ],
  };
});
```

重点：

> **一定要 archive raw output 在前，compression 在后。**

否则立即 summary 一旦漏掉东西就永久失去。

对 error 不建议直接用 LLM summary。

先 deterministic：

```text
command
exit code
exception
caused-by chain
failing tests
important file:line
head N relevant lines
tail N relevant lines
```

完整 stderr 永久有 artifact ref。

#### 在 `context` 做 historical observation masking

由于 Pi 的 `context` hook 每次 LLM call 前触发，并且只修改 model-visible deep copy，因此非常适合：

```text
Hot observation
→ full

Warm observation
→ receipt

Cold observation
→ compact ref
```

而不会修改 Pi session 原始 message history。fileciteturn4file0L2-L2

这实际上就是你想要的：

> **双上下文视图**

只是没有复制整个 session object。

模型看到：

```text
working view
```

系统保存：

```text
canonical session
```

这比真正复制两套 conversation state 简单很多。

#### 给 Main Agent 增加 retrieval tools

至少做：

```text
obs_get
obs_search
memory_search
repo_map
git_context
```

比如：

```text
obs_get(
  id="obs_7f2a",
  grep="TokenService"
)
```

返回：

```text
matching 38 lines
```

而不是整份 180K log。

`git_context`：

```text
git_context(
  file="src/auth/token.ts",
  limit=10
)
```

可以组合：

```text
git log
git show
git blame
git diff
```

给出与当前问题真正相关的历史。

### 组件 B：实现实时增量 Repo Map

第一版不需要立即构建跨语言的完美调用图，但必须先建立正确的一致性协议：

```text
watch filesystem + intercept edit/write + observe Git state
                         ↓
              compute workspace revision
                         ↓
          invalidate affected files/symbols/edges
                         ↓
          Fast Update before relevant sampling
                         ↓
        Deep Update after batch/test/checkpoint
```

建议最小数据结构：

```ts
interface WorkspaceRevision {
  gitHead: string | null;
  dirtyHash: string;
}

interface MapNode {
  id: string;
  kind: "project" | "module" | "file" | "symbol";
  sourceHash: string;
  semanticHash?: string;
  indexedAt: string;
  revision: WorkspaceRevision;
  status: "fresh" | "dirty" | "stale" | "unsupported";
  provenance: "parser" | "runtime" | "agent-inference";
}
```

`repo_map` 不只返回检索结果，也返回 map version、workspace revision 和 pending files。查询前由 `freshness-guard` 检查 task-relevant nodes；无法及时更新时，自动回退到 `rg/read/git diff`，并在结果中明确说明地图不完整。

索引写入必须是原子的：先在临时 generation 中完成受影响节点计算，通过一致性检查后再切换 active generation，防止模型读到一半新、一半旧的依赖图。

### 可选后期组件：增加 Tool-Episode Subagent，而不是 Tool-Call Subagent

Pi 官方当前设计原则明确表示，core 本身刻意保持精简，不内建 sub-agent，而希望通过 extension/package 等方式实现这些 workflow。citeturn13search5

所以很适合做：

```text
delegate_explore
delegate_diagnose
delegate_review
```

基于 Pi SDK 创建一个 fresh AgentSession。

例如：

```text
Parent
  │
  ├── delegate_explore(
  │      task="Map authentication subsystem",
  │      budget=30000
  │   )
  │
  ▼
Child Pi session
  │
  ├─ grep
  ├─ read
  ├─ read
  ├─ git log
  ├─ search
  └─ ...
  │
  ▼
structured handoff
  │
  ▼
Parent
```

第一版建议 child **read-only**。

不要立即允许多个 agent 同时 edit 相同 working tree。

否则你马上会从 context-management project 变成 distributed-concurrency project。

### 组件 C：实现 Task Anchor，而不是移动 raw user messages

维护：

```text
TaskState
```

例如：

```ts
interface TaskState {
  revision: number;
  goal: string;
  constraints: Array<{
    text: string;
    sourceEntry: string;
    authority: "user" | "project" | "agent";
    scope: string;
  }>;
  currentStep?: string;
  blockers: string[];
  importantRefs: string[];
}
```

原则：

```text
Stable constraints
→ short system/head capsule

Current task
→ short tail capsule

Raw user history
→ chronological, never reordered
```

Current Task Capsule 建议限制在几百 tokens。

不要因为追求 position advantage 再创造一个 3K-token “important information” prompt。

而且它应该是 **replace**：

```text
task anchor v10
→ v11
```

不是 append：

```text
v1 + v2 + v3 + ... + v11
```

否则会重新出现你现在要解决的问题。

TaskState 不能完全依赖 LLM 自由重写。模型可以提出 patch，但运行时应保留每次状态 diff，并确定性检查：删除用户约束、扩大任务 scope、用 agent inference 覆盖用户要求等变化。每条关键约束都应回链到原始 user entry 或 project rule；无法验证的状态只能标记为 proposed/inferred，不能悄悄进入 Stable Contract。

### 组件 D：把 Pi compaction 改成 State Materialization，而不是 summary-of-summary

Pi 已经允许 `session_before_compact` 提供 custom compaction。fileciteturn6file0L2-L2

可以把默认：

```text
conversation
+
previous summary
↓
new prose summary
```

改为：

```text
new unsummarized events
+
persistent typed memory
+
current git state
+
current TaskState
↓
materialized state
```

最后给 Pi 的 summary 只是这个状态的 render：

```markdown
## Goal
...

## Active Constraints
- [mem_81] ...

## Current State
...

## Decisions
- [decision_41] ...

## Open Problems
...

## Checkpoints
- commit a81f20

## Retrievable Context
- obs_7f2a
- obs_8a10

## Relevant Files
...
```

最重要的是：

```text
mem_81
decision_41
obs_7f2a
commit a81f20
```

这些都是可回查的。

这样即使 prose summary 丢了某个细节：

```text
memory_search
obs_get
git_show
```

仍能恢复。

### 组件 E：Git Checkpoint Agent

我不会让 Agent 在每次 edit 后自动 commit。

我会提供一个：

```text
checkpoint_commit
```

tool。不过 checkpoint 不应等同于“必须创建正式 Git commit”。不同项目可以配置：

```text
git commit              # 项目允许 Agent 提交时
patch bundle             # 保留可审查、可恢复的补丁
workspace snapshot       # content-addressed 内部快照
metadata-only checkpoint # 只记录当前已有 commit + dirty hash
```

具体策略必须服从项目规则和用户授权。无论使用哪一种形式，checkpoint 都需要记录 workspace revision，且不能通过 `git add .` 卷入无法确认归属的用户修改。

它做：

```text
check status
↓
identify files changed by agent
↓
run configured validation
↓
inspect diff
↓
stage only owned files
↓
commit
↓
write memory checkpoint
↓
update repo map
```

最后一步不是简单地“通知 Repo Map 更新”，而是要求产生一个与新 checkpoint revision 一致的 Map generation；只有新 generation 通过节点/边一致性检查后才原子切换为 active。若更新失败，checkpoint 仍然有效，但 Map 必须标记 stale，并在查询时回退到源文件和 Git diff。

结果：

```yaml
checkpoint: chk_018
commit: 8a72f03
task: Implement observation artifact store
tests:
  - npm test -- context-vault
files:
  - artifact-store.ts
  - observation-policy.ts
status: verified
```

并在 system guidance 中告诉 Agent：

> 完成一个 coherent、verified 的工作单元后 checkpoint，而不是每个 edit 后 checkpoint。

这与 Anthropic 的 long-running harness 中“一次完成一个 feature、验证后 commit，并维护 progress artifact”的实践相当一致。citeturn22view1

### 组件 F（实施优先级 P0）：真正需要修改 Pi core 的地方

这是我认为整个 proposal 里**唯一非常值得直接改 Pi core，而不是 extension 绕过去的部分**：

> **在每一次最终 provider request 发送之前建立 hard input-budget invariant。**

这正是此前 #2871、#3609、#5512 所暴露的核心架构问题。citeturn12search1turn12search0turn12search2

我建议不是继续修：

```text
when should _checkCompaction() run?
```

而是引入一个更明确的：

```text
ContextBudgetManager
```

核心 invariant：

```text
NO provider request may be sent
when effectiveInputTokens > hardInputBudget
```

而且不能只使用：

```text
model.contextWindow
```

作为单一概念。

历史 Pi issue #3765 就报告过某些模型存在：

```text
total context window
!=
effective max input tokens
```

因此仅仅与 `contextWindow` 比较可能太晚。citeturn12search7

模型元数据更合理的是：

```ts
interface ContextLimits {
  contextWindow: number;
  maxInputTokens?: number;
  maxOutputTokens: number;
  safetyMargin: number;
}
```

计算：

```ts
hardInputBudget =
  Math.min(
    model.maxInputTokens ?? Infinity,
    model.contextWindow - requestedOutputTokens
  )
  - safetyMargin;
```

然后每一次 sampling：

```text
Session messages
      ↓
context extension transforms
      ↓
observation masking
      ↓
memory retrieval
      ↓
task anchor
      ↓
provider serialization
      ↓
before_provider_request extensions
      ↓
FINAL TOKEN GUARD          ← critical
      ↓
provider
```

为什么 guard 必须足够靠后？

因为 Pi 当前 extension lifecycle 中，`context` 可以修改 messages，之后 `before_provider_request` 甚至还允许替换 provider-specific payload。fileciteturn4file0L2-L2

所以如果你：

```text
token count
↓
extension adds 30k
↓
send
```

hard invariant 还是假的。

理想流程类似：

```ts
async function prepareProviderRequest(req: ProviderRequest) {
  let candidate = await runContextExtensions(req);
  candidate = await materializeProviderPayload(candidate);
  candidate = await runBeforeProviderRequest(candidate);

  let tokens = await tokenCounter.count(candidate);

  if (tokens > limits.softInputBudget) {
    candidate = await contextManager.reduce(candidate, {
      target: limits.targetInputBudget,
    });

    tokens = await tokenCounter.count(candidate);
  }

  if (tokens > limits.hardInputBudget) {
    candidate = emergencyLossBoundedPrune(candidate);
    tokens = await tokenCounter.count(candidate);
  }

  if (tokens > limits.hardInputBudget) {
    throw new ContextBudgetInvariantError({
      tokens,
      hardLimit: limits.hardInputBudget,
    });
  }

  return candidate;
}
```

而且：

```text
reduce()
```

不能只有一个方法。

应该按优先级：

```text
remove cold observations
↓
replace warm observations with receipts
↓
reduce retrieved repo context
↓
reduce noncritical memory
↓
compact old dialogue
↓
emergency truncate with retrievable artifact refs
```

**用户消息、active constraints、current task 绝对不能跟普通 observation 一起按 FIFO 剪掉。**

另一个值得吸收的 issue 是 #4497：历史上 local/OpenAI-compatible provider 可能返回零或不可靠 usage，因此单纯依赖“上一轮 provider 报告的 input usage”做下一轮 context budget 并不够稳。citeturn12search14

所以这里应该有：

```text
provider token counter
or
local tokenizer/estimator
```

在 request 之前计算。

哪怕是 conservative estimate，也比：

```text
send first
→ provider rejects
→ try to compact
```

更合理。

Anthropic 当前 server-side compaction 甚至会在 server-tool 的每个 sampling iteration 开始检查 compaction trigger；这也是很好的架构佐证：**context control 的安全点应该是 model sampling boundary，而不是“用户 turn 结束以后”。**citeturn19search0

## 安全、生命周期与失败降级

把上下文外置成 artifacts、memory 和 indexes 后，系统获得了可恢复性，也同时扩大了持久化数据面。这个部分不能留给实现细节。

### Artifact 与 Memory 的安全边界

原始日志可能包含 access token、环境变量、用户数据和私有路径，因此至少需要：

```text
secret detection / redaction before persistence
project- and session-level namespace isolation
filesystem permission enforcement
size quota and retention policy
explicit purge / export lifecycle
never Git-track raw observations by default
```

来自仓库、日志、网页和工具结果的内容都属于 untrusted data。Observation Receipt、Repo Map 和 retrieval result 应作为带来源的数据注入，而不能获得 system instruction 的权威；否则持久化与再检索会放大 prompt injection。

### 降级必须保持“宁可少优化，也不丢事实”

| 失败 | 正确降级 |
|---|---|
| Artifact 写入失败 | 不得用不可恢复的 receipt 替换 raw result；截断时显式报错 |
| Repo Map stale/更新失败 | 回退到 `rg/read/git diff`，返回 stale metadata |
| 语言 parser 不支持 | 使用文件级索引、lexical identifiers 和 Git overlay |
| SQLite/index 损坏 | 从 canonical facts 重建；重建前禁用相关 derived view |
| token 估算不可靠 | 使用保守上界和更大 safety margin |
| memory 相互冲突 | 按 authority/scope/revision 展示冲突，不让 LLM 静默合并 |
| subagent 超时 | 保存已有 artifacts，返回 incomplete receipt 和未完成项 |

这里的原则是：优化层可以暂时不可用，但事实层必须保持完整，且模型必须知道当前拿到的信息是否完整、新鲜和已验证。

## 验证方案与最终推荐

我不建议直接认定新架构一定更强，因为你这里实际上提出了几个不同 hypothesis：

```text
H1 Observation reduction improves performance
H2 task anchoring improves instruction adherence
H3 retrievable memory beats recursive summaries
H4 git-aware recovery improves long-running coding
H5 subagent isolation saves context without hurting task success
H6 revision-bound incremental Repo Map improves navigation without stale-map errors
```

应该拆开测试。

最值得做的是下面几组 ablation。

| Variant | 内容 |
|---|---|
| A | Stock Pi |
| B | Pi + tool-output truncation only |
| C | B + stale observation masking |
| D | C + artifact retrieval |
| E | D + Current Task Capsule |
| F | E + typed memory |
| G | F + static Project Map |
| H | G + incremental Map + freshness guard |
| I | H + Git/snapshot checkpoint |
| J | I + subagent tool episodes |

这样你才能知道究竟是哪部分有效。

### Observation flood test

构造：

```text
20–50 tool calls
每次 10–50 KB
其中混入几个关键事实
```

然后在很晚的时候问 Agent：

```text
第 7 个工具结果中的关键 API behavior 是什么？
```

比较：

```text
stock context
mask-only
mask + retrieval
```

理想结果：

```text
mask-only
→ 很可能遗忘

mask + retrieval
→ 自动 obs_search / obs_get 后恢复
```

真正核心 metric 不应该只是：

```text
tokens saved
```

还应该有：

```text
critical-fact recall after eviction
```

### Lost-in-the-middle instruction test

例如用户一开始说：

```text
Do not modify migrations.
```

然后强制：

```text
30 tool calls
+
large observations
```

最后给一个很容易诱导它修改 migration 的任务。

分别测试：

```text
raw Pi
head-only anchor
tail-only task capsule
head stable + tail task capsule
```

测：

```text
constraint violation rate
```

而不是凭直觉决定头还是尾。

因为已有研究已经证明 position effect 存在，而新的工作又说明该 effect 会随相对 context utilization 改变，所以这是一个非常适合直接实验而不是硬编码假设的问题。citeturn17academia24turn17academia25

### Mid-turn overflow invariant test

这是 core patch 最简单而且最硬的验收条件：

```text
∀ provider requests:
effectiveInputTokens
<=
hardInputBudget
```

测试：

```text
32K model
64K model
200K model
high-output-reserve model
provider with missing usage
```

然后故意：

```text
start at 80–90%
→ repeated huge tools
```

最后指标必须：

```text
oversized provider requests = 0
```

这不是“平均表现”。

这是 invariant。

### Repeated compaction test

连续触发：

```text
compaction × 5
```

在第一轮放入：

```text
requirement
decision
failed approach
exact command
file-specific invariant
```

之后测试是否还能：

```text
memory_search
obs_get
git_context
```

恢复。

如果新系统最终仍只能说：

> “according to my summary...”

那它没有解决你的根本问题。

### Incremental Repo Map consistency test

构造一组会改变不同图节点的连续操作：

```text
修改函数实现
修改 public signature
增加 import/export
重命名文件
修改构建配置
执行大规模纯格式化
从外部进程直接修改文件
Git checkout / merge
```

每一步都在下一次 model sampling 前查询受影响符号和调用者，测量：

```text
workspace change → relevant Map fresh 的 P50/P95 延迟
task query → 正确文件进入 Top-K 的概率
stale node 被无标记注入 prompt 的次数
错误依赖边比例
增量更新相对全量重建的耗时和 CPU
因 stale Map 导致的错误文件编辑次数
```

核心 invariant 是：

```text
∀ model-visible Map slices:
slice.workspaceRevision == current.workspaceRevision
OR slice.status is explicitly stale with fallback evidence
```

还要进行 crash consistency test：在索引 generation 更新到一半时强制中断，确认 active Map 仍然是完整的旧版本，而不是新旧节点混合的损坏版本。

### Git recovery test

让 Agent：

```text
feature A
checkpoint
feature B
checkpoint
introduce regression
context reset
```

然后让 fresh agent 仅使用：

```text
Project Map
TaskState
git log
memory
```

恢复工作。

测：

```text
time/tokens to orientation
wrong-file edits
repeated work
regression recovery
```

Anthropic 的 long-running harness 已经证明 Git history + progress artifact 对 fresh-context agent 的重新定位非常有帮助，因此这里很值得在 Pi 上做系统化 benchmark。citeturn22view1

### 我最终会实施的 Pi 版本

如果由我决定实际 architecture，我最终不会做一个“更聪明的 compactor”，而会做：

```text
                        Pi Context Runtime

 ┌─────────────────────────────────────────────────────┐
 │ Control Plane                                       │
 │ budget · revision · freshness · policy · fallback  │
 └──────────────────────┬──────────────────────────────┘
                        │ validates every sampling
                        ▼
 ┌─────────────────────────────────────────────────────┐
 │ Stable Contract                                     │
 │ Project + persistent user constraints               │
 ├─────────────────────────────────────────────────────┤
 │ Bounded Working Context                             │
 │                                                     │
 │ recent dialogue                                     │
 │ hot observation receipts                           │
 │ relevant repo-map slice                            │
 │ retrieved semantic memories                        │
 │                                                     │
 ├─────────────────────────────────────────────────────┤
 │ Current Task Capsule                                │
 └──────────────────────┬──────────────────────────────┘
                        │
                each LLM sampling
                        │
                ContextBudgetManager
                        │
                        ▼
                      Model


 Persistent Evidence and State
 ┌─────────────────────────────────────────────────────┐
 │ Pi session                                           │
 │ raw observation artifacts                            │
 │ typed memory                                         │
 │ git commits                                          │
 │ canonical workspace files                            │
 └───────────────▲──────────────────▲──────────────────┘
                 │                  │
          retrieval tools     checkpoint/indexing
                 │                  │
                 └──── Main Agent ──┘

 Revision-bound Derived Views
 ┌─────────────────────────────────────────────────────┐
 │ Base Repo Map + Dirty Overlay                       │
 │ symbol/dependency/change/memory indexes             │
 │ map version + git HEAD + dirty hash + freshness     │
 └─────────────────────────────────────────────────────┘


 Isolated Execution
 ┌─────────────────────────────────────────────────────┐
 │ Programmatic tool workers                           │
 │ Explore subagent                                    │
 │ Diagnose subagent                                   │
 │ Review subagent                                     │
 └─────────────────────────────────────────────────────┘
                 │
       structured receipts only
                 │
                 ▼
             Main Agent
```

这个版本比你最初的三个方案多了几个我认为非常关键的约束：

**Observation 不是删除，而是 virtualize。** Raw data 进入 artifact store，模型只拿 receipt，需要时重新 retrieve。Anthropic 当前的 context editing 本身也采用类似的“client 保留完整历史、model-visible context 可以被清理”的思想。citeturn18search6

**临时上下文按 tool episode 建，而不是每个 tool call。** 简单过滤用 deterministic/programmatic execution；真正 high-entropy exploration 才值得 subagent。Claude Code 当前的 isolated subagent 设计以及 Anthropic 的 programmatic tool calling 都支持这个方向。citeturn20search5turn18search4

**不要把最新用户信息强行搬到头。** 保持 chronological transcript，stable contract 放头，Current Task Capsule 放尾；这是比“所有关键信息都放头”更稳妥的跨模型布局，尤其考虑到长期 context 的 recency behavior 和 Google 对 long-context query-at-end 的当前建议。citeturn17academia25turn17search13

**Git 是 checkpoint/reconstruction layer，不是 semantic memory。** Verified atomic changes 才 commit；Agent 最好工作在独立 branch/worktree；memory records 通过 commit hashes 与代码历史关联。Anthropic 的 long-running coding harness 已经给出了 Git + progress artifact 的强工程先例。citeturn22view1

**Repo Map 不是长期 summary，而是与 workspace revision 绑定的实时全局导航索引。** 借鉴 Aider 的 symbol/dependency ranking，再叠加 Dirty/Git-change overlay 和 memory overlay；每次修改立即 invalidation 和 fast update，在 batch/checkpoint 后 deep update。模型按任务检索很小的一片，并在注入前通过 freshness guard，而不是每轮发送全项目认知。citeturn16view0

**所有索引和摘要都是 derived views。** 文件、原始用户事件和带 hash 的工具证据才是 canonical facts；派生视图必须带 provenance、revision 和 freshness，并能在损坏或过期后重建。

**Compaction 不再是 source of truth。** 它只是一个 materialized view。真正事实仍然在 raw session、observation artifacts、Git 和 typed memory 中。

**Pi core 最值得改的地方不是再加一种 summary，而是实现 final-request context invariant。** 每一次 model sampling，在 observation/context transforms 之后、实际 provider request 之前，必须重新计算最终有效输入并实施 backpressure。历史 Pi issues 已经反复显示“只在 user-turn/agent-run 边界做 compaction 判断”对长 tool loop 并不可靠。citeturn12search1turn12search0turn12search2

最终我会把整个目标浓缩成一句设计原则：

> **Pi 不应该试图让 LLM“记住整个 session”；Pi 应该基于当前工作区的确切版本，在任何一次 sampling 时都装配最小而充分的 working set，同时让模型知道所有被移出的事实在哪里、为什么可信、当前是否新鲜，以及怎样在需要时重新取回。**

这比单纯增加 context window、滑动窗口、递归 summary，甚至单纯 observation masking，都更接近一个能够真正长期运行的 coding-agent context architecture。Anthropic 当前公开的 context-engineering 指南最终也落在同一个原则上：高性能 agent 的目标不是最大化 context，而是最大化每一个进入 context 的 token 的信息价值。
