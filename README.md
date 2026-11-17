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
model calls compact_now(handoff)
        │
        ├─ gate: too small, or saves too little → denied, with the current percentage
        │
        ├─ handoff written to ~/.dsh/self-compact/handoff/<time>-<node>.md
        ├─ request queued, tool returns "scheduled", the turn ends with one line
        │
agent goes idle (agent/status)
        │
        ├─ ctx.compaction.compactNow(agent)        ← the host's own engine and summarizer
        │      retry on failure · null means "nothing compactable"
        │
        └─ agent.followup(continuation prompt)
               next · standing_orders · pending · decisions · artifacts, verbatim
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

Above `urgentPct` (55% by default) the nudge wording escalates: compact at the next safe node instead of waiting for the wall.

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

A call missing a required field is denied and the field is named.

Rendered as Markdown, the handoff is the durable record the model can re-read. The continuation prompt repeats `next`, `standing_orders`, `pending`, `decisions` and `artifacts` verbatim (items capped at 400 characters; 24 / 12 / 16 items respectively, with a "… N more in the handoff file" line) so they do not depend on how the summarizer paraphrased anything. `done` / `drop` / `lessons` stay in the file only — repeating stale conclusions as current state costs more than it recovers.

## Thresholds

Defaults: **floor 30%**, **first nudge 40%**, **urgent 55%** of the context window. The Claude-side plugin this ports ran 10 / 20 / 35 on a 1M window; the difference is the cost curve.

- One compaction costs roughly "re-cache the retained prefix + summary output". DeepSeek-class routes bill cache reads at ~0.1x input and input is an order of magnitude cheaper, so the *absolute* price of compacting is not the decision variable. What actually hurts is a pointless rewrite: the cached prefix is invalidated and the summary loses detail.
- With the usual break-even arithmetic (each later call saves `0.1 × (before - after)`), on a 1M window retaining a 16% tail: compacting at 30% pays back in about 7 later calls, 40% in about 5, 55% in about 4. A 30% floor therefore means "compact when this block of work still has 5+ calls left", which lines up with the model's own "the block is closed" judgement.
- Automatic threshold compaction still fires at the engine's 80% default. The plugin only moves the "should we compact now" decision to the participant that knows the task.

`minSavingK` is a second condition: the floor is also at least `baseline + retained tail + minSavingK`, so a small window cannot be talked into an early, pointless rewrite (on a 200k window that pushes the floor to ~80%).

## Configuration

Override under `- id: self-compact` in the profile's `cordis.patch.yml`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false`: the tool stays registered, every call is denied |
| `floorPct` | `0.30` | hard floor, fraction of the window |
| `minSavingK` | `100` | the floor also guarantees this many k tokens of saving |
| `baselineK` | `65` | estimated post-compact floor (system head + original prompt) |
| `retainK` | `20` | estimated retained tail |
| `nudgeStartPct` | `0.40` | first nudge (raised to the floor when lower) |
| `nudgeStepPct` | `0.10` | gap between nudges |
| `urgentPct` | `0.55` | escalated nudge wording |
| `continuation` | `true` | submit the continuation prompt after a successful compaction |
| `debounceMs` | `1500` | buffer between turn end and compaction |
| `retryDelayMs` | `2000` | retry interval |
| `maxRetries` | `5` | retries before giving up |
| `idlePollMs` | `250` | idle poll interval on the fallback path |
| `maxIdlePolls` | `30` | give up after this many idle polls |
| `rereadWindowMs` | `1800000` | how long to watch calls after a compaction |
| `handoffDir` | `~/.dsh/self-compact/handoff` | handoff files |
| `logPath` | `~/.dsh/self-compact/log.jsonl` | run log |
| `language` | `en` | `zh` for Chinese tool text, denials, nudges and continuation |

## Observability

`log.jsonl` records one line per step. The two lines that matter when tuning:

- `reread` — the first tool call after a compaction whose arguments mention the handoff file, i.e. the model went back to the original text.
- `reread-rate` — written when the watch window closes (next request, or after `rereadWindowMs`): `calls` and `rereads` for that window.

That ratio is the decision rule for whether the summarizer ever needs steering. **If more than about a third of post-compaction calls re-read the handoff, the summary is losing too much** and taking over `summarize()` becomes worth its cost. Below that, the verbatim continuation is doing the job and the engine stays untouched. Field-by-field format: [docs/en/LOG-FORMAT.md](docs/en/LOG-FORMAT.md).

## How it compares

| | self-compact | [dsh-live-compact](https://github.com/Tranquillitatis-Lab/dsh-live-compact) | [dsh-smart-compact](https://github.com/hoyyang/dsh-smart-compact) | [dsh-block-ptc](https://github.com/mengwEX/dsh-block-ptc) |
|---|---|---|---|---|
| Who picks the moment | model, above a floor | every turn end, mechanically | threshold bands, or the model via `new_context` | model, per block |
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

The difference is a design choice, not a quality ranking. Theirs spends output tokens on one big condensation the model writes itself, saves the extra summarizer request, and needs no idle gap. This one keeps a single compaction code path, decides on a measured window percentage rather than on the model's feel for span boundaries, and does not rely on the model condensing a 200k-token span correctly inside a tool call.

## Data and privacy

Everything lives under `~/.dsh/self-compact/`, never inside a repository:

- `handoff/<time>-<node>.md` — the handoff, plus the session id.
- `log.jsonl` — one record per step: `queued`, `done`, `continued`, `reread`, `reread-rate`, `skipped:no-range`, `denied:<reason>`, `failed:<code>`, `abandoned:<reason>`.

The plugin makes no network calls of its own; the compaction summary is produced by the same route and account as the rest of the session. Handoff files contain your own words from the conversation — delete the folder whenever you like.

## Limitations

- The summary body is written by the host summarizer and this plugin does not steer its prompt. Steering it means disabling the `compaction-basic` row, subclassing `CompactionEngine`, and mirroring its whole configuration — see [Design](docs/en/DESIGN.md) for why that trade is deferred rather than rejected.
- Main session only: a subagent's context ends with the subagent, so compacting it buys nothing.
- The engine is resolved per session. Preset-based hosts disable the root `compaction-basic` row and let each agent preset carry its own engine (dsh-tui does this), so the plugin reads `agent.ctx.compaction` and falls back to `ctx.compaction`. A session on the `minimal` preset has no engine at all; `compact_now` then refuses with a named reason instead of failing silently.
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

The 16 offline tests drive the real plugin entry against a fake host (`tests/loader.mjs` points the two host imports at stubs): the gate, handoff rendering, the queue → compaction → continuation path, user takeover, the checkpoint false positive, `null` results, retry limits, nudge bands, and the reread rate.

A live check on an isolated `DSH_HOME` + headless profile produced:

```
queued     pct 0.9%
done       dropped 3451 tokens, durationMs 7334
continued
```

and the model answered `CONTINUATION-OK` in the continuation turn.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Design notes: [docs/en/DESIGN.md](docs/en/DESIGN.md).

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
