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

## 3. 生命周期

```
tools/pre-execute ──► compact_now 主体
                        │  门槛 → 写交接 → 入队
                        │  armAfterIdle()：debounce 定时器 + request.trigger
                        ▼
agent/status (idle) ──► request.trigger()   ← 快路径
                        ▼
                    runCompaction()
                        │  ctx.compaction.compactNow(agent, signal)
                        │  按 retryDelayMs 重试
                        ▼
                    finish() → 日志；agent.followup() 续跑
```

必须成立的规则：

1. **每个会话只有一个请求**：排队期间再次调用返回已有节点，不叠加；`queued` 按 `session.id` 索引。
2. **触发靠 idle，不靠回合结束**：`agent/status` 变 `idle` 就是回合结束的那一刻；debounce 定时器是不发该事件的宿主上的兜底，轮询同理，超过 `maxIdlePolls` 放弃。
3. **`compactNow()` 不套 `agent.runMaintenance()`**：引擎自己会占 idle 阶段，套一层就 `busy`。
4. **每次退出只写一条终态**：`done`、`skipped:no-range`、`failed:<code>`、`abandoned:<原因>`；重试写 `retry:<code>` 并继续排队。
5. **上下文正在拆算 `abandoned`，不算 `failed`**：组合已在拆除时 cordis 抛 `inactive context`（headless 单次任务常见），重试无意义，`isInactiveContext()` 直接短路。
6. **续跑不另起任务**：只带 `next` 和未完成项；排队后若你提交了真消息，续跑丢弃、压缩照常完成。

## 4. 门槛算术

```
baseline    = min(baselineK, 窗口的 20%)      // 系统提示 + 原始需求
postCompact = baseline + retainK              // 压缩后剩下的量
floor       = max(floorPct × 窗口, baseline + retainK + minSavingK)
通过条件    = used ≥ floor
```

`floor` 一条规则同时承载两个意图："别太早"（比例项）与"值这一次改写"（绝对项）。早先版本把 saving 单独判一次，实际不可达——第二项已经保证了它——于是删掉那个分支，而不是留着死代码。

默认 0.30 / 100k / 65k / 20k。Claude 版用 10% 下限，是因为那边一次压缩在 $15/M 输入价下是真花钱。DeepSeek 系路由上绝对成本不是约束，无意义的前缀改写和细节丢失才是。回本算术见 README 阈值表。

`used` 是**下一次请求**会带的 prompt 量，它和计量器免费给的那个数不是一回事。`tokenMeter.contextPressure()` 返回的是最后一次 provider 采样；只有请求会上报 usage，所以它看不见压缩，模型下一次回话之前一直报压缩前的体积。`tokenMeter.measure(session).totalTokens` 重放持久尾部并重算当前 surface，因此能看到被遮蔽的那段消失。门槛优先用它，采样只作兜底（计量器没有 `measure`、调用抛错、或结果为 0）。没有这一层，TUI 首次真实压缩在丢掉 235,938 token 后记成了 `30.3% -> 30.4%`，而在那个窗口里第二次 `compact_now` 会被放行，尽管上下文其实只剩 3%。

## 5. 提醒

`agent/pre-step` 是带 `prepend: true` 的 waterfall，提醒以一条合成 user 消息追加到本次组装的请求里。规则：

- 按 `floor((pct - nudgeStartPct) / nudgeStepPct)` 分带并按会话记住，每涨 10 个点提醒一次，而不是每步都提醒。
- 排队期间不提醒；低于 `nudgeStartPct` 不提醒。
- 监听器内部任何失败都原样返回决策：提醒不能弄坏一步。

注入消息用插件自己的 `MessageSource` kind（`self-compact`）与 `form: 'snapshot'`，和时间插件注入时钟行是同一手法。未知 kind 由消费者按设计放行，不需要改宿主。

## 6. 可观测即决策程序

每次压缩成功后给会话挂一个 `rereadWindowMs` 的观察窗。`tools/result` 是 emit 模式的观测点，带解析后的参数和调用方 agent，计数不花代价也改不动分发。

- `reread`：观察窗内第一次参数里提到交接文件的调用，只记一次，带工具名。
- `reread-rate`：窗口关闭时（下个请求或超时）写 `{calls, rereads}`。

比例 > 约 1/3 ⇒ 摘要丢了模型需要的东西 ⇒ §2 的 B 路径成立；接近 0 ⇒ 逐字续跑够用，引擎不动。这就是这个计数存在的全部意义：让一个设计决定可以用数字复核，而不是靠直觉。

## 7. 存储布局

```
~/.dsh/self-compact/
  handoff/2026-11-17T04-51-13-237Z-live-e2e.md
  log.jsonl
```

交接文件名是"ISO 时间把冒号点换成短横"+`node` 的 slug（小写、`[a-z0-9-]`、40 字）。slug 让 Windows 路径安全，也让人能按节点名找到文件。不往仓库里写东西；日志不轮转——读不出来的日志原样留着，不覆盖。

## 8. 回执与错误码

| 回执 | 含义 |
|---|---|
| `scheduled at N% (M tokens)` + 交接路径 | 已接受，本轮该收尾 |
| `denied: context is N% … floor is M%` | 门槛拒绝，什么都没写 |
| `denied: missing required field(s) …` | 需补齐交接再调 |
| `denied: the handoff file could not be written …` | 文件系统故障，没排期 |
| `a compaction is already scheduled (node …)` | 重复调用，原请求保留 |

`log.jsonl` 的 `result`：`queued`、`done`、`continued`、`reread`、`reread-rate`、`retry:<code>`、`skipped:no-range`、`denied:<原因>`、`failed:<code>`、`abandoned:context-disposed|agent-busy`。

## 9. 测试策略

`tests/loader.mjs` 是 Node 的 resolve 钩子，把 `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm` 指到桩，真实插件入口因此能在裸 Node 上跑，不需要装 Harness。假宿主只提供插件真正用到的接缝：`tools.register`、`tokenMeter.contextPressure`、`compaction.compactNow`、`on(event)`、`effect`、`logger`。

真机路径单独在隔离 `DSH_HOME` + headless profile + 本地网关上验证，因为只有那里才会暴露两类问题：宿主包的模块解析（解法是把每个导入的宿主包声明成 optional peer，loader 据此路由），以及 headless 拆除时的 idle 竞态（解法是改在 `agent/status` 上触发，而非定时器）。

## 10. 待定

- 压缩前把交接追加进 surface，让摘要器当上下文看到？能拿到 B 的好处而不接管引擎，但那条消息会留在保留尾巴里，跟续跑重复一遍。代价是每次压缩多一块重复文本，还没实测。
- 子代理：委派出去的 agent 上下文随它结束，但长跑的子代理也许能受益，需要先定"谁拥有续跑"。
- 同一会话第二次压缩时要不要重新注入 `done` / `drop` / `lessons`？现在只落文件，避免把旧结论当现状复述。
