# 设计笔记

为什么这个插件长这样。行为看 README；这里记录接缝、取舍，以及重构时必须保住的规则。

## 1. 要解决的问题

Harness 本来就会在请求接近窗口时自动压缩（`dsh-compaction-basic`，默认 `thresholdRatio` 0.8）。这个触发知道**有多少上下文**，不知道**任务走到哪**。长会话里真正有价值的时刻是任务边界：一块活收尾、MR 提交、换话题。在那里压缩，摘要更连贯，丢掉的是一整段已经结束的区间；80% 处压缩经常落在块中间，摘要器只能猜。

Claude 侧的原版（`claude-code-self-compact`）把这个判断交给模型。这里是同一个动作，但遇上一处结构差异。

## 2. 接缝：`compactNow()` 不接受 instructions

Claude Code 上是 `$.session.compact({ instructions })`，模型写的交接直接成为摘要器提示词。Harness 上是：

```ts
abstract compactNow(agent, signal, sourceCommandId?): Promise<CompactionResult | null>
```

没有 instructions 参数；唯一记录在案的子类钩子 `summarize()` 自己拼尾部的压缩指令；`/compact` 本身也不接受参数（`dsh-command-compact` 对非空 `rawInput` 直接拒绝）。

于是让模型的话进入摘要器只有两条路：

| 路径 | 代价 | 换来什么 |
|---|---|---|
| **A. 只做续跑**（当前实现） | 零；引擎继续持有 `ctx.compaction` | standing orders / pending / next / decisions / artifacts 在压缩后逐字到达模型；摘要正文保持通用 |
| **B. 接管引擎** | disable `compaction-basic` 行、子类化 `CompactionEngine`、镜像 `thresholdRatio` / `headroomTokens` / `retainRatio` / `retainTokens` / `modelPolicies` / `auto` / overflow 重试、跟上游版本 | 摘要正文本身听话：逐字保留 standing orders、列出 pending、以 next 结尾、丢掉过期日志 |

B 的代价核过之后先搁置：

- 不能丢的东西已经由 A 保住了。B 改善的是"后来人（通常还是同一个模型）读摘要正文时的体验"，而交接文件路径就在续跑提示里。
- 接管不是局部改动：`dsh-live-compact`、`dsh-smart-compact` 抢的是同一行。任意两个同时装，必有一个失效，而且用户很难看出是哪个。
- 镜像 `BasicCompactionConfig` 等于复制一份上游仍在演进的配置面；新增的键会静默落回我们没选过的默认值。

B 转正的条件写成数字而不是感觉：**压缩后有超过约三分之一的工具调用回去读交接文件**（见 §6）。到那时候摘要确实丢得太多，接管才值。

**摘要器能看到什么。** 还有第三条看似免费的路：压缩前先把交接写进对话，让摘要器当上下文读到。这条路到不了摘要器。`dsh-compaction-basic` 的 `selectCompactableRange` 会把一段按价格选出的近期尾部原样保留，`summarizeWithLlm` 只总结被折叠的前缀，并把固定的 `COMPACTION_INSTRUCTION` 追加在 `input.messages` 之后。最新的消息（包括 `compact_now` 的结果）都在保留的尾巴里，摘要器读不到；交接则会在尾巴和续跑提示里各出现一次。所以续跑提示仍是唯一的载体，0.2.0 也没有移植 Claude 侧给摘要器的指令。

## 3. 生命周期

```
agent/pre-step，step 1 ──► 回合记账（开启回合、清信号、是不是自检回合）
                              │  每一步：提醒、节点标记、提示追加在这里
                              ▼
tools/result ──► 过期计数 · 节点信号 · skill 跟踪 · 回读观察
                              ▼
tools/pre-execute ──► compact_now 主体
                        │  门槛 → 写交接 → 入队
                        │  armAfterIdle()：debounce 定时器 + request.trigger
                        ▼
agent/status (idle) ──► request.trigger()   ← 快路径
                        │  没有请求：回合收尾记账 + 安排自检
                        ▼
                    runCompaction()
                        │  ctx.compaction.compactNow(agent, signal)
                        │  按 retryDelayMs 重试
                        ▼
                    finish() → 日志 · 量出并学习 P · agent.followup() 续跑
```

必须成立的规则：

1. **每个会话只有一个请求**：排队期间再次调用返回已有节点，不叠加；`queued` 按 `session.id` 索引。
2. **触发靠 idle，不靠回合结束**：`agent/status` 变 `idle` 就是回合结束的那一刻；debounce 定时器是不发该事件的宿主上的兜底，轮询同理，等到 `maxIdleWaitMs` 才放弃。
3. **`compactNow()` 不套 `agent.runMaintenance()`**：引擎自己会占 idle 阶段，套一层就 `busy`。
4. **每次退出只写一条终态**：`done`、`skipped:no-range`、`failed:<code>`、`abandoned:<原因>`、`stale`；重试写 `retry:<code>` 并继续排队。
5. **上下文正在拆算 `abandoned`，不算 `failed`**：组合已在拆除时 cordis 抛 `inactive context`（headless 单次任务常见），重试无意义，`isInactiveContext()` 直接短路。
6. **续跑不另起任务**：只带 `next` 和未完成项；排队后若你提交了真消息，续跑丢弃、压缩照常完成。
7. **回合记账在 `agent/pre-step` 的 step 1 上做。** 它开启回合，并清掉本回合的信号、提醒标记、`compact_now` 标记和工具调用计数。紧跟在一次自检之后、且没有人类消息（没有 `source.kind === 'user'` 的消息）的 step 1 就是自检回合，它的结果在 idle 时归类为 `self-check:compacted` 或 `self-check:declined`。
8. **自检在 idle 上做。** `agent/status` 的 idle 处理器收尾回合，并可能安排一次自检：等 `debounceMs` 之后，若 agent 仍然 idle 且门槛仍然打开，就用一次 `agent.followup` 送出提示。同一种触发每涨 5 个百分点最多一次；本回合已调用过 `compact_now`、最后一个工具是 `ask_user_question`、或上次自检以来没有任何工具活动时都不发（自检回合里、或回合之外的调用不算）。自检被拒后，两种只看大小的触发（work 档、停留过久）也要等上下文再涨 5 个百分点，只有节点信号能更早再问。
9. **过期规则。** `compact_now` 之后到 idle 之前又调用了超过 3 次其他工具，说明模型还在干活，交接已不再描述当前状态，请求被丢弃（`stale`），并在下一步告诉模型：仍要压就重新调用。
10. **子代理和非交互会话不参与。** header 里 `origin === 'subagent'`（或 `delegationDepth > 0`）的会话被拒绝、也没有任何行；headless、SDK、ACP 宿主没有触发。

## 4. 门槛算术：回本成本模型

价格都相对于缓存未命中的输入 token。`r` = 缓存读价（`cacheReadRatio`，0.1），`o` = 输出价（`outputRatio`，1.5），`S` = 摘要长度（`summaryK`，10k 输出 token），`C` = 当前上下文，`P` = 压缩后下一次请求带的大小：

```
一次压缩的成本    o*S + r*C + (1-r)*P
                  摘要输出、摘要器重放已缓存的前缀、新前缀重新缓存
不压的成本        此后每次调用多付 r*(C-P)
N 次调用内回本    C >= C(N) = (F/r + N*P) / (N-1),   F = o*S + (1-r)*P
```

档位：

```
floor  = C(floorCalls = 20)        若 floorPct * 窗口 更大则取它
node   = C(nodeCalls  = 10)
work   = C(workCalls  = 8)
urgent = min(urgentK = 350k, 0.8 * 窗口)
每一档：封顶到 urgent，再抬到 P + MIN_GAIN（25k）
通过条件 = used >= floor
```

默认 P（90k）下，floor 是 145k，占 1M 窗口的 14.5%。`MIN_GAIN` 让每一档都高于压缩后的大小，所以一次压缩至少释放 25k；urgent 的封顶让小窗口里没有任何一档越过 80%。Claude 版用 10% 下限，是因为那边一次压缩在约 $15/M 输入价下是真花钱；0.1.x 在固定 30% 以下拒绝。公式把百分比换成随学到的 P 和价格比移动的下限。

`used` 是**下一次请求**会带的 prompt 量，它和计量器免费给的那个数不是一回事。`tokenMeter.contextPressure()` 返回的是最后一次 provider 采样；只有请求会上报 usage，所以它看不见压缩，模型下一次回话之前一直报压缩前的体积。`tokenMeter.measure(session).totalTokens` 重放持久尾部并重算当前 surface，因此能看到被遮蔽的那段消失。门槛优先用它，采样只作兜底（计量器没有 `measure`、调用抛错、或结果为 0）。没有这一层，TUI 首次真实压缩在丢掉 235,938 token 后记成了 `30.3% -> 30.4%`，而在那个窗口里第二次 `compact_now` 会被放行，尽管上下文其实只剩 3%。

**学习 P。** 每次压缩一结束，`measure()` 已经在重放新的尾部，所以这个样本不用等下一步。它折进按项目和全局各一份的指数加权估计（权重 0.3）；偏离估计超过 50% 的样本算离群值，只让估计动 0.1，连续三个同向离群值把估计重置为它们的均值。规划用的 P 取第一个有值的来源：本会话最近一次采样、项目估计、全局估计（各自从 3 个样本起才可信），最后是本会话第一个非零读数 + 25k（第 1 步在没有 usage 样本前通常读到 0；首个读数晚于第 3 步或超过 150k 视为恢复的会话而不是基线；什么都没量过时基线是 65k，所以 P = 90k）。工具说明按学到的 P 把各档写成 token 数，每个进程只渲染一次，文本稳定，提示缓存不受影响。

**profile 锁。** 多个 dsh 进程共用 `profile.json`，所以每次读-改-写都在锁目录下进行（`profile.json.lock`，用 `mkdir` 创建，最多试 40 次、间隔 25 ms，超过 5 秒的锁视为过期），并通过写临时文件再重命名落盘。没抢到锁的进程跳过这次更新。

当 `C(workCalls)` 达到 `urgentK` 时，模型会收到一次性的 `heavy` 提示：harness 本身大到压缩几乎不划算，只在大的阶段交接时压。

## 5. 提醒与自主触发

`agent/pre-step` 是带 `prepend: true` 的 waterfall，每条面向模型的行都以一条合成 user 消息追加到本次组装的请求里。规则：

- 提醒从 node 档起（不低于 floor），之后每隔 `nudgeStepPct` 窗口比例重复一次；越过 urgent 档立即升级，不等下一个间隔。
- 排队期间不提醒；本步已有别的行提到 `compact_now` 时也不提醒。
- 监听器内部任何失败都原样返回决策：提醒不能弄坏一步。

注入消息用插件自己的 `MessageSource` kind（`self-compact`）与 `form: 'snapshot'`，和时间插件注入时钟行是同一手法。未知 kind 由消费者按设计放行，不需要改宿主。

### 5.1 自主触发

大小档位是必要条件。块是否收尾仍由模型判断，所以每条提示都写明三条标准：当前块已收尾、接下来的工作不依赖上下文里的大段原文、剩余工作够长能回本一次压缩。`autoNodes` 打开这些触发；每个触发都要求门槛（`used >= floor`）、主会话、交互式宿主和空队列。

- **节点标记。** `tools/result` 对 dsh 内置工具跑 `detectNode`。强信号：`git push` / `merge` / `tag`，PR 或 MR 创建 / 评审 / 合并，`gh issue comment` / `close`，对外的 `gog` / `agent-slack` / `slack` / `outlook` 发送，写入 spec/plan 或 `handoff*` 文件（`write`、`edit`、`str_replace_editor`、`apply_patch`），全部完成的 `todo_write`。弱信号：`git commit`、通过的测试命令、新建的 `.md`、返回的 `subagent` / `wait_agent`。弱信号只在 node 档及以上才标记，强信号从 floor 起。标记以一行的形式搭在下一步上，每回合一次，本回合最强的信号被记住供自检使用。测试保持弱信号，因为循环里会反复跑。
- **轮末自检**（`turnEndCheck`）。由 idle 处理器安排（§3 规则 8）。理由取第一个成立的：本回合出现节点信号（强信号，或 node 档上的弱信号），其次是在 work 档上工具调用不少于两次的回合，再次是在 node 档停留很久。提示要求调用 `compact_now` 或只回复 `skip: <理由>`；理由从自检回合的回答里解析并写进日志。
- **新块提示。** 人类回合的 step 1 在门槛打开后追加一行，让新话题或暂停结束后可以从干净上下文起步。

### 5.2 语言约定

压缩最先丢的是对话语言和输出约定，所以它们单独携带。`compact_now` 接受可选的 `language: {chat, outputs[]}`。按子字段取值：给定的值优先，其次是上一次压缩的；`chat` 最后回退到从用户最近 5 条消息检测出的语言（去掉代码、URL 和路径后，CJK 字数不少于英文单词数就判为中文，所以夹满标识符的中文回答仍算中文）。结果放在交接文件的第一节、续跑提示的第一行，并在接下来 3 个人类回合上以一行重复。压缩后第一个助手回答会被归类，与 chat 约定不符就记一条 `lang-drift`。`queued` 和 `done` 上的 `langSource` 记录取值来自三者中的哪一个。

### 5.3 skill 工作集

压缩前加载的 skill 是摘要最先丢掉的东西。`tools/result` 跟踪每次 `skill` 调用的 `resourceBase` 目录，该目录下的读写都算一次使用；`SKILL.md` 以外的文件成为该 skill 的参考文件（保留最近 8 个）。压缩时 `tierSkills` 把已加载的 skill 分档：被 `keep_skills` 点名、在 `hotWindow` 个主步骤内用过、或学到的漏读率（`refMisses / compactions`）在 3 次以上压缩中不低于 0.3 的算热；被 `drop_skills` 点名的算已完成；其余不带。续跑提示列出每个热 skill 的 `SKILL.md`，参考文件每个最多 `refInlineK`、合计不超过 `skillBudgetK` 的部分内联（读之前先用 `stat` 量大小，且只读 skill 真实目录之内的文件），其余按路径列出。压缩后 30 个主步骤内去读了只列路径的参考文件，记为 `skill-ref-miss`，并在 profile 里给该 skill 的漏读次数加一；已内联的却仍被读，记为 `skill-ref-reread`。

## 6. 可观测即决策程序

每次压缩成功后给会话挂一个 `rereadWindowMs` 的观察窗。`tools/result` 是 emit 模式的观测点，带解析后的参数和调用方 agent，计数不花代价也改不动分发。

- `reread`：观察窗内第一次参数里提到交接文件的调用，只记一次，带工具名。
- `reread-rate`：窗口关闭时（下个请求或超时）写 `{calls, rereads}`。

比例 > 约 1/3 ⇒ 摘要丢了模型需要的东西 ⇒ §2 的 B 路径成立；接近 0 ⇒ 逐字续跑够用，引擎不动。这就是这个计数存在的全部意义：让一个设计决定可以用数字复核，而不是靠直觉。

0.2.0 为新机制加了记录，每条回答一个问题：

- `p-sample`：量到的压缩后大小，以及折入后的项目估计——档位适合这个项目吗？
- `node-nudge`、`self-check`、`self-check:compacted`、`self-check:declined`（带 `skip:` 理由）——触发有效吗，是什么一直在挡住压缩？只有触发而没有 `queued`，说明模型看到提示并拒绝了。
- `stale`：模型在 `compact_now` 之后还在继续干活吗？
- `lang-drift`：语言约定守住了吗？
- `skill-ref-miss`、`skill-ref-reread`：skill 工作集的大小合适吗？

`queued` 和 `done` 带 `langSource`；`done` 带 `skills`。字段参考：`docs/en/LOG-FORMAT.md`。

## 7. 存储布局

```
~/.dsh/self-compact/               （或 dataDir）
  handoff/2026-11-17T04-51-13-237Z-live-e2e.md
  log.jsonl
  log.1.jsonl                      轮转之后
  profile.json
```

交接文件名是"ISO 时间把冒号点换成短横"+`node` 的 slug（小写、`[a-z0-9-]`、40 字）。slug 让 Windows 路径安全，也让人能按节点名找到文件。不往仓库里写东西。`log.jsonl` 超过 2 MB 后移到 `log.1.jsonl`；读不出来的日志原样留着，不覆盖。`profile.json` 存按项目（以工作目录为键）和全局的 P 估计，以及每个 skill 的压缩次数和参考文件漏读次数；读不出来的 profile 按空处理。位置只由一个 `dataDir` 键决定，交接目录和日志没有各自独立的路径配置。

## 8. 回执与错误码

| 回执 | 含义 |
|---|---|
| `scheduled at N% (M tokens)` + 交接路径 | 已接受，本轮该收尾 |
| `denied: context is N% … below the break-even floor` | 门槛拒绝，什么都没写 |
| `denied: missing required field(s) …` | 需补齐交接再调 |
| `denied: the handoff file could not be written …` | 文件系统故障，没排期 |
| `denied: only the main session compacts …` | 从子代理里调用 |
| `a compaction is already scheduled (node …)` | 重复调用，原请求保留 |

`log.jsonl` 的 `result`：`queued`、`done`、`p-sample`、`continued`、`stale`、`reread`、`reread-rate`、`node-nudge`、`self-check`、`self-check:compacted`、`self-check:declined`、`lang-drift`、`skill-ref-miss`、`skill-ref-reread`、`retry:<code>`、`skipped:no-range`、`denied:<原因>`、`failed:<code>`、`waiting:agent-busy`、`abandoned:context-disposed|agent-busy|no-engine`。

## 9. 测试策略

`tests/loader.mjs` 是 Node 的 resolve 钩子，把 `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm` 指到桩，真实插件入口因此能在裸 Node 上跑，不需要装 Harness。假宿主只提供插件真正用到的接缝：`tools.register`、`tokenMeter.contextPressure` 与 `measure`、`compaction.compactNow`、`on(event)`（`agent/status`、`agent/pre-step`、`tools/result`）、`effect`、`logger`，以及带 session header、`snapshotEvents` 和 `followup` 的 agent。纯函数模块（`gate`、`handoff`、`triggers`、`config`）直接测。

真机路径单独在隔离 `DSH_HOME` + headless profile + 本地网关上验证，因为只有那里才会暴露两类问题：宿主包的模块解析（解法是把每个导入的宿主包声明成 optional peer，loader 据此路由），以及 headless 拆除时的 idle 竞态（解法是改在 `agent/status` 上触发，而非定时器）。

## 10. 待定

- 要不要提供区间选择模式，更接近 `dsh-clear-mind` 和 `dsh-agent-compact`：由模型自己写摘要，省掉额外的摘要器请求？它们的路线每次压缩更便宜、也没有 idle 空档；本路线保留单一代码路径，也不要求模型在一次工具调用里浓缩 20 万 token 的区间。该由重读率（§6）来决定：比例高说明摘要器是薄弱环节，倾向让模型来写；比例低就别动。
- 子代理：委派出去的 agent 上下文随它结束，但长跑的子代理也许能受益。目前子代理被拒绝；放开需要先定"谁拥有续跑"。
- 同一会话第二次压缩时要不要重新注入 `done` / `drop` / `lessons`？现在只落文件，避免把旧结论当现状复述。
