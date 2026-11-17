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
模型调用 compact_now(handoff)
        │
        ├─ 门槛：太小、或省不下足够 token → 拒绝，回执带当前百分比
        │
        ├─ 交接写入 ~/.dsh/self-compact/handoff/<时间>-<节点>.md
        ├─ 请求入队，工具返回 scheduled，本轮用一句话收尾
        │
agent 进入 idle（agent/status）
        │
        ├─ ctx.compaction.compactNow(agent)     ← 宿主自己的引擎与摘要器
        │      失败重试 · 返回 null 表示"没有可压的区间"
        │
        └─ agent.followup(续跑提示)
               next · standing_orders · pending · decisions · artifacts 逐字
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

超过 `urgentPct`（默认 55%）后提醒措辞升级：在下一个安全节点就压，别等窗口打满。

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

缺必填字段会被拒绝，并点名缺哪个。

交接渲染成 Markdown 落盘，是模型可回读的durable记录。续跑提示逐字重复 `next` / `standing_orders` / `pending` / `decisions` / `artifacts`（单条 400 字截断，分别 24 / 12 / 16 条封顶，超出写"… 还有 N 条在交接文件里"），不依赖摘要器怎么转述。`done` / `drop` / `lessons` 只落文件——把旧结论当现状复述，比丢掉更糟。

## 阈值

默认 **下限 30% / 首次提醒 40% / 催办 55%**（窗口比例）。移植来源的 Claude 版是 10 / 20 / 35，差别来自成本曲线：

- 压缩一次的成本约为"重缓存被保留的前缀 + 摘要输出"。DeepSeek 系路由缓存读约 0.1x 输入价，输入本身便宜一个数量级，所以压缩的**绝对花费不是决策变量**；真正伤的是无意义的改写——缓存前缀被打掉、摘要丢细节。
- 按常用回本算法（每次后续调用省 `0.1 × (压缩前 − 压缩后)`），1M 窗口、保留 16% 尾巴时：30% 压缩约 7 次后续调用回本，40% 约 5 次，55% 约 4 次。30% 下限意味着"这块活还剩 5 次以上调用才值得压"，与模型自己"这个块收尾了"的判断基本对齐。
- 引擎默认 80% 的自动阈值压缩仍在，插件只是把"现在该不该压"交给最了解任务的一方。

`minSavingK` 是第二道闸：下限同时不小于 `baseline + 保留尾巴 + minSavingK`，小窗口不会被百分比骗到很晚才压（200k 窗口下会把下限顶到约 80%）。

## 配置

在 profile 的 `cordis.patch.yml` 里按 `- id: self-compact` 覆盖：

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | `false`：工具仍注册，每次调用都被拒 |
| `floorPct` | `0.30` | 硬下限（窗口比例） |
| `minSavingK` | `100` | 下限还至少要省出这么多 k token |
| `baselineK` | `65` | 估计的压缩后底座（系统提示 + 原始需求） |
| `retainK` | `20` | 估计的压缩后保留尾巴 |
| `nudgeStartPct` | `0.40` | 第一次提醒起点（低于下限时自动抬到下限） |
| `nudgeStepPct` | `0.10` | 提醒间隔 |
| `urgentPct` | `0.55` | 催办措辞起点 |
| `continuation` | `true` | 压缩成功后自动续跑 |
| `debounceMs` | `1500` | 回合结束到压缩之间的缓冲 |
| `retryDelayMs` | `2000` | 失败重试间隔 |
| `maxRetries` | `5` | 重试次数 |
| `idlePollMs` | `250` | 兜底路径的 idle 轮询间隔 |
| `maxIdlePolls` | `30` | 轮询这么多次后放弃 |
| `rereadWindowMs` | `1800000` | 压缩后观察窗口长度 |
| `handoffDir` | `~/.dsh/self-compact/handoff` | 交接目录 |
| `logPath` | `~/.dsh/self-compact/log.jsonl` | 运行日志 |
| `language` | `en` | `zh` 时工具说明、拒因、提醒、续跑提示走中文 |

## 可观测

`log.jsonl` 每步一行，调参要看的是两条：

- `reread` — 压缩后第一次参数里提到交接文件的工具调用，说明模型回去读原文了。
- `reread-rate` — 观察窗口关闭时（下个请求，或超过 `rereadWindowMs`）写出的 `calls` / `rereads`。

这个比例就是"要不要接管摘要器"的判据：**压缩后的调用里超过约三分之一去回读交接文件，说明摘要丢得太多**，那时接管 `summarize()` 才值；低于这个数，逐字续跑已经够用，引擎保持不动。逐字段格式见 [docs/en/LOG-FORMAT.md](docs/en/LOG-FORMAT.md)。

## 与别的插件怎么分工

| | self-compact | [dsh-live-compact](https://github.com/Tranquillitatis-Lab/dsh-live-compact) | [dsh-smart-compact](https://github.com/hoyyang/dsh-smart-compact) | [dsh-block-ptc](https://github.com/mengwEX/dsh-block-ptc) |
|---|---|---|---|---|
| 谁挑时机 | 模型，在下限之上 | 每轮结束机械执行 | 阈值分带，或模型用 `new_context` | 模型，按块 |
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

差别是设计取舍，不是水平高低。它们的路线把输出 token 花在一次由模型自己写的大幅浓缩上，省掉额外摘要请求、也没有 idle 空档。本插件保留单一压缩代码路径，用可度量的窗口比例而不是模型对区间边界的感觉来做决定，也不依赖模型在一次工具调用里把 20 万 token 正确浓缩掉。

## 数据与隐私

全部在 `~/.dsh/self-compact/`，不进仓库：

- `handoff/<时间>-<节点>.md` — 交接正文与会话 id。
- `log.jsonl` — 每步一条：`queued`、`done`、`continued`、`reread`、`reread-rate`、`skipped:no-range`、`denied:<原因>`、`failed:<代码>`、`abandoned:<原因>`。

插件自己不发起网络请求；摘要由会话同一条路由、同一个账号产出。交接文件里是你自己在对话里说过的话，随时可以整个目录删掉。

## 已知边界

- 摘要正文由宿主摘要器写，本插件不改它的提示词。要改就得 disable `compaction-basic` 行、子类化 `CompactionEngine`、并镜像它整套配置——取舍理由见[设计文档](docs/zh-cn/DESIGN.md)。
- 只管主会话：子代理的上下文随它自己结束，压了也不赚。
- 引擎按会话解析：preset 型宿主会关掉 root 的 `compaction-basic` 行、让每个 agent preset 自带引擎（dsh-tui 就是这样），所以插件读 `agent.ctx.compaction`、回退到 `ctx.compaction`。`minimal` preset 的会话没有引擎，此时 `compact_now` 明确拒绝并说明原因，而不是静默失败。
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

16 项离线测试驱动真实插件入口（`tests/loader.mjs` 把两个宿主包换成桩），覆盖门槛、交接渲染、排队→压缩→续跑、用户抢话、检查点误判、`null` 结果、重试上限、提醒分带、回读率。

隔离 `DSH_HOME` + headless profile 的真机实测：

```
queued     pct 0.9%
done       dropped 3451 tokens, durationMs 7334
continued
```

模型在续跑回合回了 `CONTINUATION-OK`。

见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [AGENTS.md](AGENTS.md)；设计笔记在 [docs/zh-cn/DESIGN.md](docs/zh-cn/DESIGN.md)。

## 许可

[MIT](LICENSE-MIT) 或 [Apache-2.0](LICENSE-APACHE)，任选其一。
