# dsh-self-compact

**A DeepSeek Harness plugin that lets the model compact its own context at task milestones: it picks the moment, writes the handoff, the host runs native compaction, and work resumes by itself.**

[English](README.md) · [简体中文](README.zh-cn.md) · [Design](docs/en/DESIGN.md) · [Changelog](docs/en/CHANGELOG.md) · [Log format](docs/en/LOG-FORMAT.md)

MIT OR Apache-2.0

## Why

Long sessions compact whether or not you plan for it. Threshold compaction fires at an arbitrary moment, often mid-task, and the summarizer has to guess which parts of the conversation matter. A manual `/compact` with your own instructions works better, but only when you are there to pick the moment and write them.

This plugin moves that judgement to the model, which is the only participant that knows where the task stands. It does **not** replace the compaction engine: `@deepseek-ai/dsh-compaction-basic` keeps owning `ctx.compaction`, its automatic threshold compaction stays armed as the safety net, and this plugin only decides *when* to call the engine's public `compactNow()` seam.

If you have used [`claude-code-self-compact`](https://github.com/w21180239/claude-code-self-compact), this is the same idea ported to Harness. One difference is structural: dsh's `compactNow()` takes no `instructions` argument, so the parts that must not depend on the summarizer's paraphrase (standing orders, pending items, next step, decisions, artifact paths) are carried verbatim in the continuation prompt instead.

## How it works

```
trigger: the model's own judgement, a node flag, the turn-end self-check, or the block-start hint
        │
model calls compact_now(handoff)
        │
        ├─ gate: context below the break-even floor → denied, with the current size and the floor
        │
        ├─ handoff written to ~/.dsh/self-compact/handoff/<time>-<node>.md
        ├─ request queued, tool returns "scheduled", the turn ends with one line
        │        (more than 3 tool calls after the request → it goes stale and is dropped)
        │
agent goes idle (agent/status)
        │
        ├─ ctx.compaction.compactNow(agent)        ← the host's own engine and summarizer
        │      retry on failure · null means "nothing compactable"
        │
        ├─ measure the new prompt size → learn P (the post-compact size) in profile.json
        │
        └─ agent.followup(continuation prompt)
               language rules · next · standing_orders · pending · decisions · artifacts, verbatim
               + the skill working set (hot skills, inlined references)
               + the handoff path, for anything the summary dropped
```

Everything is recorded as one JSON line per step in `~/.dsh/self-compact/log.jsonl`.

## Requirements

- DeepSeek Harness `>=0.2.2-rc.1` (developed and tested on `0.2.2-rc.2`).
- A routed model that reports a `contextWindow`; the gate has nothing to measure otherwise.
- Node 22+ for the offline tests.

## Install

```sh
dsh plugin --profile <name> add dsh-self-compact
```

During development, install from a checkout:

```sh
dsh plugin --profile <name> add link:/absolute/path/to/dsh-self-compact
```

**Restart dsh afterwards.** The loader keeps one module per resolved URL, so an installed bundle is not recomposed inside a running host.

Verify the row composed:

```sh
dsh --profile <name> --dump-config | Select-String self-compact
```

Then ask the model "which compaction tools do you have?" — `compact_now` should be in the list.

## When it compacts

Good nodes:

- A block of work ends: tests green, a merge request opened or merged, a document written and on disk, todos complete.
- State was just written to disk and pushed.
- You change topic, or pick the work up again after a pause.
- A subagent returned, or work was delegated and the model is now waiting — with every running task listed in `pending`.
- You say "compact", "continue" or "next".

Anti-nodes, where the tool description tells the model not to compact:

- A question of its own is waiting for your answer and that answer decides the next step.
- You just corrected something or gave a rule that is not yet in the handoff.
- Mid polling, retrying, editing, or a debug loop.
- The API just returned an error, or a background result arrived unread.

### Autonomous triggers

With `autoNodes` on (the default) the plugin prompts the model at the right moments. Every prompt states that the size tier is only a necessary condition; the model compacts when three criteria hold: the current block is closed, the next work does not depend on large raw text in context, and enough work is left to repay the compaction. All triggers need the context to be at or above the floor, a main session, an interactive host and no request already queued.

- **Node flags.** Tool calls are classified as nodes. Strong: `git push` / `merge` / `tag`, PR or MR create / review / merge, `gh issue comment` / `close`, an outbound `gog` / `agent-slack` / `slack` / `outlook` send, a write to a spec/plan file or a `handoff*` file, an all-completed `todo_write`. Weak: `git commit`, a passing test command, a new `.md`, a returned `subagent` / `wait_agent`. A flag rides the next step once per turn; a weak one counts only from the node tier up.
- **Turn-end self-check** (`turnEndCheck`). When the agent goes idle, one prompt asks the model to compact or answer `skip: <reason>`. It fires after a node, after a turn with two or more tool calls at the work tier, or after a long stretch at the node tier. Each trigger fires once per 5 points of context growth, never twice without tool activity in between (calls made inside the check turn do not count), and not after `ask_user_question`. A `skip:` also holds the two size-only triggers until context grows another 5 points. The model's `skip:` reason is logged.
- **Block-start hint.** Every human prompt gets a one-line hint once the gate is open, so a new block can start from a clean context.
- **Nudges.** From the node tier the plugin repeats a reminder every `nudgeStepPct` (5% of the window). Crossing the urgent tier escalates at once: compact at the next safe step instead of waiting for the wall.

Subagents are denied and get no triggers; headless, SDK and ACP sessions get no triggers either.

## What the handoff keeps

`compact_now` takes a structured handoff:

| Field | Required | Meaning |
|---|---|---|
| `node` | yes | Milestone label, e.g. "MR up", "tests green" |
| `next_step` | yes | The first action after compaction, written as an instruction to itself |
| `objective` | no | What the session is trying to achieve |
| `standing_orders` | no | Your rules, constraints and permissions, in your words |
| `decisions` | no | Decisions taken, with reasons |
| `artifacts` | no | Files, branches, URLs and IDs produced |
| `pending` | no | Every open item and how it reports back |
| `done` | no | Finished work worth naming |
| `drop` | no | Material that may be dropped |
| `lessons` | no | What failed and why |
| `language` | no | `{chat, outputs[]}`: the chat language and one rule per output channel |
| `keep_skills` | no | Skills whose work continues |
| `drop_skills` | no | Skills whose work is finished |

A call missing a required field is denied and the field is named.

Rendered as Markdown, the handoff is the durable record the model can re-read. The plugin adds to it: the session's original request (the first real user message, 1,500 characters, read from the append-only log so it survives any number of compactions) and your last 5 messages. The continuation prompt repeats `next`, `standing_orders`, `pending`, `decisions` and `artifacts` verbatim (items capped at 400 characters; 24 / 12 / 16 items respectively, with a "… N more in the handoff file" line) so they do not depend on how the summarizer paraphrased anything. `done` / `drop` / `lessons` stay in the file only — repeating stale conclusions as current state costs more than it recovers. The continuation also points at `session_search` / `session_event_search` for exact pre-compaction strings.

**Language rules.** The chat language and the output conventions (code, commits, outgoing text) are the first thing a compaction tends to lose. The value comes from the `language` field, else the previous compaction's, else the language detected from your last 5 messages. It leads the handoff file, opens the continuation, and repeats on the first 3 real user prompts after a compaction. If the first answer afterwards is in the other language, `lang-drift` is logged.

**Skill working set.** The plugin tracks each loaded skill's directory and the files read under it (8 references per skill at most). At compaction a skill is hot when `keep_skills` names it, when it was used within `hotWindow` main steps, or when its learned reference-miss rate is at least 0.3 over 3 or more compactions; `drop_skills` marks it finished. The continuation lists each hot skill's `SKILL.md` and inlines references up to `refInlineK` each within `skillBudgetK` in total; the rest are listed by path. Reading a listed reference within 30 steps counts as a `skill-ref-miss` and feeds the profile.

## Thresholds

Every tier derives from P, the learned post-compact size, through a break-even formula priced for DeepSeek-class routes. Prices are relative to a cache-miss input token: `r` = cache-read price (`cacheReadRatio`, 0.1), `o` = output price (`outputRatio`, 1.5), `S` = summary length (`summaryK`, 10k tokens), `C` = current context.

- One compaction costs `o*S + r*C + (1-r)*P`: the summary output, the summarizer replaying the cached prefix, and re-caching the new prefix.
- Not compacting costs `r*(C-P)` more on every later call.
- Compaction therefore repays within N calls when `C ≥ C(N) = (F/r + N*P) / (N-1)`, with `F = o*S + (1-r)*P`.

The tiers are `C(N)` at call counts you can set, each capped at the urgent tier and then raised to `P + 25k` so no tier sits at the post-compact size:

| Tier | Rule | Meaning |
|---|---|---|
| floor | `C(floorCalls = 20)` (or `floorPct × window` if larger) | below it `compact_now` is denied |
| node | `C(nodeCalls = 10)` | any clean node; nudges start |
| work | `C(workCalls = 8)` | the turn-end self-check after a block of work |
| urgent | `min(urgentK = 350k, 0.8 × window)` | compact at the next safe step |

On a 1M window:

| P | floor | node | work | urgent |
|---|---|---|---|---|
| 60k | 99k (9.9%) | 143k (14.3%) | 167k (16.7%) | 350k (35%) |
| 90k | 145k (14.5%) | 207k (20.7%) | 240k (24%) | 350k (35%) |
| 120k | 191k (19.1%) | 270k (27%) | 313k (31.3%) | 350k (35%) |

On a 200k window with P = 90k, node, work and urgent all sit at 160k (80%).

**P is learned.** It is measured right after each compaction (`tokenMeter.measure()` replays the new tail) and folded into an exponentially weighted average (EWMA) per project and globally in `~/.dsh/self-compact/profile.json`; outliers are damped and three same-side outliers reset the estimate. Because several dsh processes share the file, writes run under a lock directory and land by atomic rename. The plugin plans with the first source that exists: this session's latest sample, the project estimate, the global estimate (project and global need 3 samples), then the session's first non-zero measured size + 25k (65k + 25k = 90k when nothing was measured yet). The tool description names the tiers in tokens for the learned P; it is rendered once per process, so the prompt cache holds.

When the harness itself is so large that `C(workCalls)` reaches `urgentK`, compaction barely pays; the model gets a one-time note to compact at big phase handoffs only.

Automatic threshold compaction still fires at the engine's 80% default. The plugin moves the "should we compact now" decision to the participant that knows the task.

## Configuration

Override under `- id: self-compact` in the profile's `cordis.patch.yml`. Unknown keys are ignored.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false`: the tool stays registered, every call is denied |
| `floorCalls` | `20` | floor = the context that repays a compaction within N calls |
| `nodeCalls` | `10` | any clean node from here |
| `workCalls` | `8` | turn-end self-check after a block of work from here |
| `floorPct` | `0` | optional extra floor, fraction of the window |
| `urgentK` | `350` | urgent tier in k tokens, capped at 80% of the window |
| `summaryK` | `10` | estimated summary length, k output tokens |
| `cacheReadRatio` | `0.1` | cache-hit price / cache-miss price |
| `outputRatio` | `1.5` | output price / cache-miss price |
| `nudgeStepPct` | `0.05` | gap between nudges, fraction of the window |
| `autoNodes` | `true` | node flags, turn-end self-check, block-start hint |
| `turnEndCheck` | `true` | the turn-end self-check alone |
| `hotWindow` | `20` | a skill used within N main steps is carried |
| `refInlineK` | `2` | inline a skill reference up to N k tokens |
| `skillBudgetK` | `6` | total k tokens of inlined skill references |
| `continuation` | `true` | submit a continuation prompt after compaction |
| `dataDir` | `''` | state directory; empty means `~/.dsh/self-compact` |
| `language` | `en` | `zh` for Chinese tool text, denials, nudges and continuation |

Timing keys that suit the defaults and rarely need a change: `debounceMs` (1500, buffer between turn end and compaction or self-check), `retryDelayMs` (2000), `maxRetries` (5), `idlePollMs` (250), `maxIdlePolls` (30), `rereadWindowMs` (1800000, how long to watch calls after a compaction).

## Observability

`log.jsonl` records one line per step; it moves to `log.1.jsonl` past 2 MB. New in 0.2:

- `p-sample` — the post-compact size measured after each compaction, and the project estimate it produced.
- `node-nudge`, `self-check`, `self-check:compacted`, `self-check:declined` — each trigger and the model's answer, including the `skip:` reason. `self-check` or `node-nudge` lines without a following `queued` mean the model saw the prompt and declined; read the reasons.
- `stale` — the model kept working after `compact_now` and the request was dropped.
- `lang-drift`, `skill-ref-miss`, `skill-ref-reread` — whether the language rules and the skill working set did their job.
- `queued` and `done` gain `langSource`; `done` gains `skills`.

Two lines decide whether the summarizer ever needs steering:

- `reread` — the first tool call after a compaction whose arguments mention the handoff file, i.e. the model went back to the original text.
- `reread-rate` — written when the watch window closes (next request, or after `rereadWindowMs`): `calls` and `rereads` for that window.

**If more than about a third of post-compaction calls re-read the handoff, the summary is losing too much** and taking over `summarize()` becomes worth its cost. Below that, the verbatim continuation is doing the job and the engine stays untouched. Field-by-field format: [docs/en/LOG-FORMAT.md](docs/en/LOG-FORMAT.md).

## How it compares

| | self-compact | [dsh-live-compact](https://github.com/Tranquillitatis-Lab/dsh-live-compact) | [dsh-smart-compact](https://github.com/hoyyang/dsh-smart-compact) | [dsh-block-ptc](https://github.com/mengwEX/dsh-block-ptc) |
|---|---|---|---|---|
| Who picks the moment | model, above a break-even floor, prompted by node flags and a turn-end check | every turn end, mechanically | threshold bands, or the model via `new_context` | model, per block |
| What runs | the host's own summarizer | local rewrite, 0 model calls | zero-model window rollover | the model writes the replacement |
| Handoff survives | structured file + verbatim continuation | card in place | notes + mechanical anchor | summary carries the ids |
| Replaces the engine | no | yes | yes | no, but needs the Block PTC preset |
| Works in the default preset | yes | yes | yes | no |

These solve different parts of the problem and can be combined: `live-compact` shrinks the tool output that accumulates *inside* a block, this plugin decides where a block ends and what must survive it.

Two more are close enough to name, and neither is dismissed lightly:

| Plugin | What it does | Where this plugin still differs |
|---|---|---|
| [dsh-clear-mind](https://github.com/john-walks-slow/dsh-clear-mind) ★10 | `mind_map` + `clear_mind(start, end, notes)`: the model inspects its own surface, picks a span, and replaces it with a checkpoint it wrote, through the host's own compaction transaction vocabulary; threshold reminders included | The model picks the span **and writes the summary**, in-turn, so there is no summarizer call and no continuation. Its host peer range is pinned to the `0.1.2-rc` line, older than the `0.2.2` this plugin targets |
| [dsh-agent-compact](https://github.com/MimicHunterZ/dsh-agent-compact) ★5 | `context_compact(startAnchor, endAnchor, summary)` with anchor matching, a spill archive, and a `summarize()` patch that returns the agent's text for one call | Same "the model writes the summary" route, implemented by patching the engine rather than using it as-is |

The difference is a design choice, not a quality ranking. Theirs spends output tokens on one big condensation the model writes itself, saves the extra summarizer request, and needs no idle gap. This one keeps a single compaction code path, decides on a measured context size against a break-even floor rather than on the model's feel for span boundaries, and does not rely on the model condensing a 200k-token span correctly inside a tool call.

## Data and privacy

Everything lives under `~/.dsh/self-compact/` (or `dataDir`), never inside a repository:

- `handoff/<time>-<node>.md` — the handoff, the session id, the original request and your last 5 messages.
- `log.jsonl` — one record per step (full list in [docs/en/LOG-FORMAT.md](docs/en/LOG-FORMAT.md)); rotates to `log.1.jsonl` past 2 MB.
- `profile.json` — the learned post-compact size P per project (keyed by working directory) and globally, plus per-skill compaction and reference-miss counts.

The plugin makes no network calls of its own; the compaction summary is produced by the same route and account as the rest of the session. Handoff files contain your own words from the conversation — delete the folder whenever you like.

## Limitations

- The summary body is written by the host summarizer and takes no instructions: the engine's `summarize()` appends its own fixed instruction, and it only sees the folded prefix. The newest messages, including `compact_now`'s result, stay in the verbatim retained tail, so the handoff cannot reach the summarizer by being appended to the surface. The continuation carries it instead. Steering the summary means disabling the `compaction-basic` row, subclassing `CompactionEngine`, and mirroring its whole configuration — see [Design](docs/en/DESIGN.md) for why that trade is deferred rather than rejected, and the changelog's "Not ported" entry.
- Main session only: a subagent's context ends with the subagent, so compacting it buys nothing. Subagents are denied; headless, SDK and ACP sessions get no autonomous triggers.
- The engine is resolved per session. Preset-based hosts disable the root `compaction-basic` row and mount each preset's engine inside an **isolated entry group**, so the plugin reads it through `ctx.agentPresets.serviceFor(agent, 'compaction')`, then the agent context, then the root. A session on the `minimal` preset has no engine at all; `compact_now` then refuses with a reason that names which of the three probes was empty.
- Headless one-shot runs tear the context down right after the turn; a compaction can land as `abandoned:context-disposed`. Long-lived TUI and web sessions are unaffected.
- A compaction takes roughly 5–15 seconds depending on window size and route, and the agent is idle throughout.
- No keystroke awareness: the plugin runs only when the agent is idle, but a compaction can still land right as you start typing. A real user message submitted in the meantime drops the continuation (the compaction itself still runs).

## Uninstall

```sh
dsh plugin --profile <name> remove dsh-self-compact
```

then restart. Nothing else is touched; delete `~/.dsh/self-compact/` to drop the data.

## Development

```sh
npm test     # node --import ./tests/register.mjs --test tests/logic.test.mjs
```

The 35 offline tests drive the real plugin entry against a fake host (`tests/loader.mjs` points the two host imports at stubs): the break-even tiers and P learning, the gate, handoff rendering, language rules, the queue → compaction → continuation path, user takeover, the checkpoint false positive, `null` results, retry limits, nudges, node detection and the turn-end self-check, stale requests, the skill working set, subagents, post-compaction accounting, and the reread rate.

A live check of the 0.1 line on an isolated `DSH_HOME` + headless profile produced:

```
queued     pct 0.9%
done       dropped 3451 tokens, durationMs 7334
continued
```

and the model answered `CONTINUATION-OK` in the continuation turn.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Design notes: [docs/en/DESIGN.md](docs/en/DESIGN.md).

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
