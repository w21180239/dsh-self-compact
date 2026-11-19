# dsh-self-compact

**让模型自己在任务节点压缩上下文：它挑时机、写交接，宿主跑原生压缩，压完自己接着做。**

[English](README.md) · 简体中文 · [设计](docs/zh-cn/DESIGN.md) · [更新日志](docs/en/CHANGELOG.md) · [日志格式](docs/en/LOG-FORMAT.md)

MIT OR Apache-2.0

## 为什么

长会话该压的总会压。阈值压缩在任意时刻触发，经常落在任务中间，摘要器只能猜哪段对话重要；手写 `/compact` 效果更好，但要你在场挑时机、写指令。

这个插件把这个判断交给模型——只有它知道任务进行到哪。它**不替换压缩引擎**：`@deepseek-ai/dsh-compaction-basic` 继续持有 `ctx.compaction`，自动阈值压缩仍然是兜底，插件只决定什么时候调它公开的 `compactNow()`。

如果你用过 [`claude-code-self-compact`](https://github.com/w21180239/claude-code-self-compact)，这就是同一套思路移植到 Harness。结构上有一处不同：dsh 的 `compactNow()` 不接受 `instructions` 参数，所以"绝不能交给摘要器转述"的内容（standing orders、pending、next、decisions、artifacts 路径）改由续跑提示逐字携带。

## 怎么工作

```
触发：模型自己的判断、节点标记、轮末自检、新块提示
        │
模型调用 compact_now(handoff)
        │
        ├─ 门槛：上下文低于回本下限 → 拒绝，回执带当前大小和下限
        │
        ├─ 交接写入 ~/.dsh/self-compact/handoff/<时间>-<节点>.md
        ├─ 请求入队，工具返回 scheduled，本轮用一句话收尾
        │        （入队后又调用超过 3 次工具 → 请求过期并丢弃）
        │
agent 进入 idle（agent/status）
        │
        ├─ ctx.compaction.compactNow(agent)     ← 宿主自己的引擎与摘要器
        │      失败重试 · 返回 null 表示"没有可压的区间"
        │
        ├─ 量出新的 prompt 大小 → 把 P（压缩后大小）学进 profile.json
        │
        └─ agent.followup(续跑提示)
               语言约定 · next · standing_orders · pending · decisions · artifacts 逐字
               + skill 工作集（热 skill、内联的参考文件）
               + 交接文件路径，摘要丢掉的东西去那里取
```

每一步都在 `~/.dsh/self-compact/log.jsonl` 留一行 JSON。

## 要求

- DeepSeek Harness `>=0.2.2-rc.1`（开发与实测在 `0.2.2-rc.2`）。
- 路由模型必须报告 `contextWindow`，否则门槛没有可度量的分母。
- 离线测试需要 Node 22+。

## 安装

```sh
dsh plugin --profile <名字> add dsh-self-compact
```

开发期从本地 checkout 装：

```sh
dsh plugin --profile <名字> add link:/绝对路径/dsh-self-compact
```

**装完重启 dsh。** loader 按 URL 缓存模块，运行中的宿主不会重组已装的 bundle。

确认组合进树：

```sh
dsh --profile <名字> --dump-config | Select-String self-compact
```

然后问模型"你有哪些压缩工具"，应该能看到 `compact_now`。

## 什么时候压

适合调用：

- 一个工作块收尾：测试绿了、MR 建好或合并了、文档写完并落盘、待办全部完成。
- 状态刚写到磁盘并推送。
- 换话题，或暂停后重新捡起来。
- 子代理返回、工作已委派出去而模型在等——此时 `pending` 里列出每个运行中的任务。
- 你说"压缩"、"继续"、"下一步"。

不该调用（工具说明里写明了）：

- 它自己的问题在等你回答，而那个回答决定下一步。
- 你刚纠正它、或给了还没写进交接的新规则。
- 卡在轮询、重试、编辑、调试循环里。
- 接口刚报错，或后台结果还没读。

### 自主触发

`autoNodes` 开着（默认）时，插件会在合适的时刻提示模型。每条提示都写明：大小档位只是必要条件；三条同时满足模型才压——当前块已收尾、接下来的工作不依赖上下文里的大段原文、剩余工作够长能把这次压缩回本。所有触发都要求上下文达到下限、是主会话、宿主是交互式、且没有已排队的请求。

- **节点标记。** 工具调用会被归类为节点。强信号：`git push` / `merge` / `tag`，PR 或 MR 创建 / 评审 / 合并，`gh issue comment` / `close`，对外的 `gog` / `agent-slack` / `slack` / `outlook` 发送，写入 spec/plan 文件或 `handoff*` 文件，全部完成的 `todo_write`。弱信号：`git commit`、通过的测试命令、新建的 `.md`、返回的 `subagent` / `wait_agent`。标记搭在下一步上，每轮一次；弱信号只在 node 档及以上才算。
- **轮末自检**（`turnEndCheck`）。agent 进入 idle 时发一条提示，请模型压缩或回答 `skip: <理由>`。触发条件：出现节点之后；一轮里工具调用两次以上且上下文在 work 档；或在 node 档停留了很久。同一种触发每涨 5 个百分点最多一次，中间没有工具活动不会连发（自检那一轮里的调用不算），`ask_user_question` 之后也不发。回答 `skip:` 后，两种只看大小的触发也要等上下文再涨 5 个百分点。模型的 `skip:` 理由会写进日志。
- **新块提示。** 下限一过，每条用户输入都带一行提示，让新块有机会从干净上下文起步。
- **提醒。** 从 node 档起，每隔 `nudgeStepPct`（窗口的 5%）重复提醒一次；越过 urgent 档立即升级措辞：在下一个安全步骤就压，别等窗口打满。

子代理会被拒绝、也没有触发；headless、SDK、ACP 会话同样没有自主触发。

## 交接里留什么

| 字段 | 必填 | 含义 |
|---|---|---|
| `node` | 是 | 节点标签，如"MR up"、"tests green" |
| `next_step` | 是 | 压缩后第一件事，写成给自己的指令 |
| `objective` | 否 | 这次会话要达成什么 |
| `standing_orders` | 否 | 你的规则、约束、许可，用你的原话 |
| `decisions` | 否 | 已做的决定及理由 |
| `artifacts` | 否 | 产出的文件、分支、URL、ID |
| `pending` | 否 | 每个未完成项及回报方式 |
| `done` | 否 | 完成的工作 |
| `drop` | 否 | 可以丢掉的材料 |
| `lessons` | 否 | 什么失败过、为什么 |
| `language` | 否 | `{chat, outputs[]}`：对话语言，以及每个输出渠道一条约定 |
| `keep_skills` | 否 | 工作仍在继续的 skill |
| `drop_skills` | 否 | 工作已完成的 skill |

缺必填字段会被拒绝，并点名缺哪个。

交接渲染成 Markdown 落盘，是模型可回读的持久记录。插件还会补上两样：会话的原始需求（第一条真实用户消息，1,500 字符，从只追加的日志里读，所以压缩多少次都在）和你最近 5 条消息。续跑提示逐字重复 `next` / `standing_orders` / `pending` / `decisions` / `artifacts`（单条 400 字截断，分别 24 / 12 / 16 条封顶，超出写"… 还有 N 条在交接文件里"），不依赖摘要器怎么转述。`done` / `drop` / `lessons` 只落文件——把旧结论当现状复述，比丢掉更糟。续跑提示还会指向 `session_search` / `session_event_search`，需要压缩前的原文时可以去查。

**语言约定。** 对话语言和输出约定（代码、commit、对外文字）是压缩最容易丢的东西。取值顺序：`language` 字段，其次上一次压缩的值，最后是从你最近 5 条消息检测出的语言。它放在交接文件的第一节、续跑提示的第一行，并在压缩后的前 3 条真实用户输入上重复一次。压缩后第一个回答若用了另一种语言，会记一条 `lang-drift`。

**skill 工作集。** 插件按 skill 记录加载目录，以及在该目录下读过的文件（每个 skill 最多 8 个参考文件）。压缩时一个 skill 算"热"：被 `keep_skills` 点名，或在 `hotWindow` 个主步骤内用过，或学到的参考文件漏读率在 3 次以上压缩中不低于 0.3；`drop_skills` 标记为已完成。续跑提示列出每个热 skill 的 `SKILL.md`，参考文件每个最多 `refInlineK`、合计不超过 `skillBudgetK` 的部分直接内联，其余只列路径。压缩后 30 步内去读了某个只列了路径的参考文件，记为一次 `skill-ref-miss`，并写进 profile。

## 阈值

所有档位都由 P（学到的压缩后大小）经回本公式推出，价格按 DeepSeek 系路由取值。价格都相对于缓存未命中的输入 token：`r` = 缓存读价（`cacheReadRatio`，0.1），`o` = 输出价（`outputRatio`，1.5），`S` = 摘要长度（`summaryK`，10k token），`C` = 当前上下文。

- 一次压缩的成本是 `o*S + r*C + (1-r)*P`：摘要输出、摘要器重放已缓存的前缀、新前缀重新缓存。
- 不压的成本是此后每次调用多付 `r*(C-P)`。
- 所以压缩在 N 次调用内回本的条件是 `C ≥ C(N) = (F/r + N*P) / (N-1)`，其中 `F = o*S + (1-r)*P`。

各档就是在你能设的调用次数上取 `C(N)`，每档封顶到 urgent，再抬到 `P + 25k`，保证没有任何档落在压缩后的大小上：

| 档位 | 规则 | 含义 |
|---|---|---|
| floor | `C(floorCalls = 20)`（若 `floorPct × 窗口` 更大则取它） | 低于它 `compact_now` 被拒 |
| node | `C(nodeCalls = 10)` | 任何干净节点；开始提醒 |
| work | `C(workCalls = 8)` | 一块工作之后的轮末自检 |
| urgent | `min(urgentK = 350k, 0.8 × 窗口)` | 下一个安全步骤就压 |

1M 窗口下：

| P | floor | node | work | urgent |
|---|---|---|---|---|
| 60k | 99k（9.9%） | 143k（14.3%） | 167k（16.7%） | 350k（35%） |
| 90k | 145k（14.5%） | 207k（20.7%） | 240k（24%） | 350k（35%） |
| 120k | 191k（19.1%） | 270k（27%） | 313k（31.3%） | 350k（35%） |

200k 窗口、P = 90k 时，node、work、urgent 都落在 160k（80%）。

**P 是学出来的。** 每次压缩后立即量（`tokenMeter.measure()` 会重放新的尾部），折进 `~/.dsh/self-compact/profile.json` 里按项目和全局各一份的指数加权平均（EWMA）；离群值被压低权重，连续三个同向离群值会重置估计。多个 dsh 进程共用这个文件，所以写入在锁目录下进行，并以原子重命名落盘。规划时取第一个存在的来源：本会话最近一次采样、项目估计、全局估计（项目和全局都要有 3 个样本），最后是本会话第一个非零读数 + 25k（什么都没量过时是 65k + 25k = 90k）。工具说明按学到的 P 把各档写成 token 数；它每个进程只渲染一次，所以提示缓存不受影响。

如果 harness 本身大到 `C(workCalls)` 达到 `urgentK`，压缩几乎不划算，模型会收到一条一次性提示：只在大的阶段交接时压。

引擎默认 80% 的自动阈值压缩仍在，插件只是把"现在该不该压"交给最了解任务的一方。

## 配置

在 profile 的 `cordis.patch.yml` 里按 `- id: self-compact` 覆盖。未知的键会被忽略。

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | `false`：工具仍注册，每次调用都被拒 |
| `floorCalls` | `20` | floor = 在 N 次调用内回本所需的上下文 |
| `nodeCalls` | `10` | 从这里起任何干净节点都可压 |
| `workCalls` | `8` | 一块工作之后的轮末自检从这里起 |
| `floorPct` | `0` | 可选的额外下限，窗口比例 |
| `urgentK` | `350` | urgent 档（k token），封顶窗口的 80% |
| `summaryK` | `10` | 估计的摘要长度，k 输出 token |
| `cacheReadRatio` | `0.1` | 缓存命中价 / 未命中价 |
| `outputRatio` | `1.5` | 输出价 / 未命中价 |
| `nudgeStepPct` | `0.05` | 提醒间隔，窗口比例 |
| `autoNodes` | `true` | 节点标记、轮末自检、新块提示 |
| `turnEndCheck` | `true` | 只控制轮末自检 |
| `hotWindow` | `20` | N 个主步骤内用过的 skill 会被带上 |
| `refInlineK` | `2` | skill 参考文件内联上限（k token） |
| `skillBudgetK` | `6` | 内联 skill 参考文件的总预算（k token） |
| `continuation` | `true` | 压缩成功后自动续跑 |
| `dataDir` | `''` | 状态目录；空表示 `~/.dsh/self-compact` |
| `language` | `en` | `zh` 时工具说明、拒因、提醒、续跑提示走中文 |

默认值通常够用、很少需要改的时间类键：`debounceMs`（1500，回合结束到压缩或自检之间的缓冲）、`retryDelayMs`（2000）、`maxRetries`（5）、`idlePollMs`（250）、`maxIdleWaitMs`（180000，排队的压缩等 agent 变 idle 的最长时间）、`maxIdlePolls`（30，仅在 `maxIdleWaitMs` 为 0 时使用的旧轮询次数）、`rereadWindowMs`（1800000，压缩后观察调用的时长）。

## 可观测

`log.jsonl` 每步一行，超过 2 MB 后移到 `log.1.jsonl`。0.2 新增：

- `p-sample` — 每次压缩后量到的压缩后大小，以及据此得出的项目估计。
- `node-nudge`、`self-check`、`self-check:compacted`、`self-check:declined` — 每次触发和模型的回应，包括 `skip:` 理由。只有 `self-check` 或 `node-nudge` 而没有随后的 `queued`，说明模型看到了提示并拒绝了，去读理由。
- `stale` — 模型在 `compact_now` 之后继续干活，请求被丢弃。
- `lang-drift`、`skill-ref-miss`、`skill-ref-reread` — 语言约定和 skill 工作集有没有起作用。
- `queued` 和 `done` 多了 `langSource`；`done` 多了 `skills`。

两条记录决定要不要去管摘要器：

- `reread` — 压缩后第一次参数里提到交接文件的工具调用，说明模型回去读原文了。
- `reread-rate` — 观察窗口关闭时（下个请求，或超过 `rereadWindowMs`）写出的 `calls` / `rereads`。

**压缩后的调用里超过约三分之一去回读交接文件，说明摘要丢得太多**，那时接管 `summarize()` 才值；低于这个数，逐字续跑已经够用，引擎保持不动。逐字段格式见 [docs/en/LOG-FORMAT.md](docs/en/LOG-FORMAT.md)。

## 与别的插件怎么分工

| | self-compact | [dsh-live-compact](https://github.com/Tranquillitatis-Lab/dsh-live-compact) | [dsh-smart-compact](https://github.com/hoyyang/dsh-smart-compact) | [dsh-block-ptc](https://github.com/mengwEX/dsh-block-ptc) |
|---|---|---|---|---|
| 谁挑时机 | 模型，在回本下限之上，由节点标记和轮末自检提示 | 每轮结束机械执行 | 阈值分带，或模型用 `new_context` | 模型，按块 |
| 跑什么 | 宿主自己的摘要器 | 本地改写，0 次模型调用 | 零模型调用的换窗 | 模型写替换内容 |
| 交接怎么活 | 结构化文件 + 逐字续跑 | 原地卡片 | 笔记 + 机械锚点 | 摘要携带 id |
| 替换引擎 | 不替换 | 替换 | 替换 | 不替换，但需要 Block PTC preset |
| 默认 preset 可用 | 是 | 是 | 是 | 否 |

它们解决的是不同层面，可以叠加：`live-compact` 收短的是块**内部**堆积的工具输出，本插件决定块在哪里结束、什么必须活下去。

另外两个足够接近，值得点名，都不是随手排除的：

| 插件 | 它做什么 | 本插件的差别 |
|---|---|---|
| [dsh-clear-mind](https://github.com/john-walks-slow/dsh-clear-mind) ★10 | `mind_map` + `clear_mind(start, end, notes)`：模型先看清自己的上下文表面，选一段区间，用它自己写的检查点替换，走宿主原生的压缩事务词汇；带阈值提醒 | 区间和**摘要都由模型自己写**，发生在回合内，所以没有摘要器调用、也不需要续跑。它的宿主 peer 范围锁在 `0.1.2-rc` 线，比本插件要求的 `0.2.2` 老 |
| [dsh-agent-compact](https://github.com/MimicHunterZ/dsh-agent-compact) ★5 | `context_compact(startAnchor, endAnchor, summary)`，带锚点匹配、溢出归档，并用 `summarize()` 补丁让某一次调用直接返回模型写的文本 | 同样是"模型自己写摘要"，实现方式是打引擎补丁，而不是照原样用引擎 |

差别是设计取舍，不是水平高低。它们的路线把输出 token 花在一次由模型自己写的大幅浓缩上，省掉额外摘要请求、也没有 idle 空档。本插件保留单一压缩代码路径，用可度量的上下文大小对照回本下限而不是模型对区间边界的感觉来做决定，也不依赖模型在一次工具调用里把 20 万 token 正确浓缩掉。

## 数据与隐私

全部在 `~/.dsh/self-compact/`（或 `dataDir`），不进仓库：

- `handoff/<时间>-<节点>.md` — 交接正文、会话 id、原始需求和你最近 5 条消息。
- `log.jsonl` — 每步一条（完整列表见 [docs/en/LOG-FORMAT.md](docs/en/LOG-FORMAT.md)）；超过 2 MB 轮转为 `log.1.jsonl`。
- `profile.json` — 学到的压缩后大小 P（按项目，以工作目录为键，另有全局一份），以及每个 skill 的压缩次数和参考文件漏读次数。

插件自己不发起网络请求；摘要由会话同一条路由、同一个账号产出。交接文件里是你自己在对话里说过的话，随时可以整个目录删掉。

## 已知边界

- 摘要正文由宿主摘要器写，不接受任何指令：引擎的 `summarize()` 自己追加固定的压缩指令，而且它只看到被折叠的前缀。最新的消息（包括 `compact_now` 的结果）留在原样保留的尾巴里，所以把交接追加进 surface 到不了摘要器；续跑提示才是载体。要改摘要就得 disable `compaction-basic` 行、子类化 `CompactionEngine`、并镜像它整套配置——取舍理由见[设计文档](docs/zh-cn/DESIGN.md)，以及更新日志的 "Not ported" 一条。
- 只管主会话：子代理的上下文随它自己结束，压了也不赚。子代理会被拒绝；headless、SDK、ACP 会话没有自主触发。
- 引擎按会话解析：preset 型宿主会关掉 root 的 `compaction-basic` 行，把每个 preset 的引擎挂在**隔离的 entry group** 里，所以插件经 `ctx.agentPresets.serviceFor(agent, 'compaction')` 取，再退到 agent ctx、最后 root。`minimal` preset 的会话没有引擎，此时 `compact_now` 明确拒绝，并在回执里说明三个探针哪个是空的。
- headless 单次任务：回合结束后宿主很快拆上下文，压缩可能落成 `abandoned:context-disposed`；TUI / web 长驻会话不受影响。
- 一次压缩 5–15 秒（取决于窗口与路由），期间 agent 是 idle 的。
- 看不到键盘：插件只在 agent idle 时执行，但仍可能刚好在你开始打字时落刀。期间你提交了真消息，续跑会被丢弃（压缩本身照常完成）。

## 卸载

```sh
dsh plugin --profile <名字> remove dsh-self-compact
```

然后重启。其它配置不受影响；删 `~/.dsh/self-compact/` 即可清数据。

## 开发

```sh
npm test     # node --import ./tests/register.mjs --test tests/logic.test.mjs
```

36 项离线测试驱动真实插件入口（`tests/loader.mjs` 把两个宿主包换成桩），覆盖回本档位与 P 的学习、门槛、交接渲染、语言约定、排队→压缩→续跑、用户抢话、检查点误判、`null` 结果、重试上限、提醒、节点识别与轮末自检、过期请求、skill 工作集、子代理、压缩后计量、回读率。

0.1 版在隔离 `DSH_HOME` + headless profile 上的真机实测：

```
queued     pct 0.9%
done       dropped 3451 tokens, durationMs 7334
continued
```

模型在续跑回合回了 `CONTINUATION-OK`。

见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [AGENTS.md](AGENTS.md)；设计笔记在 [docs/zh-cn/DESIGN.md](docs/zh-cn/DESIGN.md)。

## 许可

[MIT](LICENSE-MIT) 或 [Apache-2.0](LICENSE-APACHE)，任选其一。
