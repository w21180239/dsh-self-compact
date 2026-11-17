# Design

Why this plugin is shaped the way it is. Read the README first for behaviour; this file records the seams, the trade-offs, and the rules that must survive refactoring.

## 1. The problem it solves

DeepSeek Harness already compacts automatically when a routed request approaches the window (`@deepseek-ai/dsh-compaction-basic`, default `thresholdRatio` 0.8). That trigger knows *how much* context exists, not *where the task is*. In long sessions the moments that matter are task boundaries: a block closes, an MR goes up, a topic changes. Compacting there keeps the summary coherent and drops a large, already-finished region. Compacting at 80% often lands mid-block, and the summarizer has to guess.

The Claude-side original (`claude-code-self-compact`) moved that judgement into the model. This is the same move on Harness, with one structural difference described in §2.

## 2. The seam: `compactNow()` has no instructions

On Claude Code the plugin calls `$.session.compact({ instructions })`, so the model's handoff becomes the summarizer's prompt. On Harness:

```ts
abstract compactNow(
  agent: ManualCompactAgentContext,
  signal: AbortSignal,
  sourceCommandId?: CommandId,
): Promise<CompactionResult | null>
```

There is no instructions parameter, and `BasicCompactionEngine.summarize()` — the documented subclass hook — builds its own trailing instruction after replaying the conversation prefix. `/compact` itself takes no arguments (`dsh-command-compact` refuses `rawInput.trim().length > 0`).

A second placement detail matters more than it looks, and it cost three host restarts to get right. The engine is not always at the root: preset-based hosts (`dsh-tui`) disable the root `compaction-basic` row and mount each preset's rows into an **isolated entry group**. A service in an isolated group is visible neither from the root nor from the agent context — the live probe answered `agent ctx: present, root: missing` — so the documented way in is the registry: `ctx.agentPresets.serviceFor(agent, 'compaction')`. The plugin therefore never injects `compaction` (a missing root service leaves the row waiting forever and the tool silently absent) and resolves the engine as preset group → agent context → root, reporting all three probes when a session has none.

So there are exactly two ways to make the model's words reach the summarizer:
| Path | Cost | What it buys |
|---|---|---|
| **A. Continuation-only** (shipped) | none; the stock engine keeps `ctx.compaction` | Standing orders, pending, next, decisions and artifacts reach the model verbatim *after* the compaction; the summary body stays generic |
| **B. Take over the engine** | disable the `compaction-basic` row, subclass `CompactionEngine`, mirror `thresholdRatio` / `headroomTokens` / `retainRatio` / `retainTokens` / `modelPolicies` / `auto` / overflow retries, follow upstream version bumps | The summary body itself obeys the handoff: keeps standing orders verbatim, lists pending, ends on next, drops stale logs |

Path B was measured against its price and deferred:

- Everything that must not be lost already survives through A. B only improves prose that a later reader (usually the same model) can reconstruct from the handoff file, which the continuation names explicitly.
- The takeover is not local: it is the same row `dsh-live-compact` and `dsh-smart-compact` claim. Combining any two of them means one of them stops working, and the user has no obvious way to tell which.
- Mirroring `BasicCompactionConfig` means copying a configuration surface that upstream is actively evolving; every new key silently falls back to a default we did not choose.

The condition under which B becomes correct is stated as a number, not a feeling: **more than about a third of post-compaction tool calls re-reading the handoff file** (§6). Then the summary is provably losing too much and the takeover earns its cost.

## 3. Lifecycle

```
tools/pre-execute ──► compact_now body
                        │  gate → handoff file → queue entry
                        │  armAfterIdle(): debounce timer + request.trigger
                        ▼
agent/status (idle) ──► request.trigger()  ← the fast path
                        ▼
                    runCompaction()
                        │  ctx.compaction.compactNow(agent, signal)
                        │  retries with retryDelayMs
                        ▼
                    finish() → log; continuation via agent.followup()
```

Rules that must hold:

1. **One request per session.** A second call while one is queued returns the existing node instead of stacking; `queued` is keyed by `session.id`.
2. **Idle is the trigger, not the turn end.** `agent/status` flips to `idle` exactly when the turn is over. The debounce timer is a fallback for hosts that never emit it; polling exists for the same reason and gives up after `maxIdlePolls`.
3. **`compactNow()` is never wrapped in `agent.runMaintenance()`.** The engine reserves the idle phase itself; wrapping it would throw `busy`.
4. **Every exit logs exactly one terminal line**: `done`, `skipped:no-range`, `failed:<code>`, `abandoned:<reason>`. Retries log `retry:<code>` and stay queued.
5. **Torn-down contexts are `abandoned`, not `failed`.** Cordis throws `cannot get required service "compaction" in inactive context` when the composition is already disposing (headless one-shot runs). Retrying that is pointless, so `isInactiveContext()` short-circuits it.
6. **The continuation never starts a new task.** It carries `next` and the open items; if a real user message landed after the request was queued, the continuation is dropped and the compaction still runs.

## 4. Gate arithmetic

```
baseline    = min(baselineK, 20% of window)       // system head + original prompt
postCompact = baseline + retainK                  // what is left after compacting
floor       = max(floorPct × window, baseline + retainK + minSavingK)
accept      = used ≥ floor
```

`floor` is a single rule that carries both intents: "not absurdly early" (the fraction) and "worth the rewrite" (the absolute saving). An earlier revision checked the saving separately, which was unreachable — the floor's second term already guarantees it — so the check and its denial code were removed rather than left as dead branches.

`used` is the prompt size the *next* request would carry, which is not the same thing the meter hands out for free. `tokenMeter.contextPressure()` returns the last provider sample; nothing but a request reports usage, so it cannot observe a compaction and keeps answering the pre-compact size until the model replies again. `tokenMeter.measure(session).totalTokens` replays the durable tail and reprices the current surface, so it sees the shadowed region disappear. The gate prefers it and keeps the sample as the fallback (a meter without `measure`, a throwing call, or a zero result). Without this, the first live TUI compaction logged `30.3% -> 30.4%` after dropping 235,938 tokens, and a second `compact_now` in that window would have been accepted against a context that was already 3% full.

Defaults are 0.30 / 100k / 65k / 20k. The Claude-side plugin used a 10% floor because a compaction there costs real money at ~$15/M input. On DeepSeek-class routes the absolute cost is not the constraint; pointless prefix rewrites and lost detail are. See the README threshold table for the break-even arithmetic.

## 5. Nudges

`agent/pre-step` is a waterfall with `prepend: true`, so the nudge appends one synthetic user message to the assembled request before the step runs. Rules:

- Banded by `floor((pct - nudgeStartPct) / nudgeStepPct)`, remembered per session, so a nudge appears once per 10 points of growth rather than every step.
- Suppressed while a request is queued, and never sent below `nudgeStartPct`.
- Any failure inside the listener returns the untouched decision: a nudge must never break a step.

The injected message uses the plugin's own `MessageSource` kind (`self-compact`) with `form: 'snapshot'`, mirroring how the time-context plugin injects its clock line. Unknown kinds fall through consumers by design, so no host change is needed.

## 6. Observability as a decision procedure

After a successful compaction the plugin arms a watch on the session for `rereadWindowMs`. `tools/result` is an emit-mode observation point that contains the parsed arguments and the calling agent, so counting is free and cannot alter dispatch.

- `reread` — first call whose arguments mention the handoff file; logged once per window with the tool name.
- `reread-rate` — `{calls, rereads}` written when the window closes (a new request, or expiry).

Ratio > ~1/3 ⇒ the summary is losing material the model needs ⇒ Path B in §2 becomes justified. Ratio near zero ⇒ the verbatim continuation is sufficient and the engine stays untouched. This is the whole point of the counter: a design decision that can be re-evaluated with a number instead of a hunch.

## 7. Storage layout

```
~/.dsh/self-compact/
  handoff/2026-11-17T04-51-13-237Z-live-e2e.md
  log.jsonl
```

Handoff filenames are `ISO-time-with-dashes` + a slug of `node` (lowercase, `[a-z0-9-]`, 40 chars). Slugging keeps Windows paths safe and makes the file findable by the node name. Nothing is written inside a repository; nothing rotates — an unreadable log is left alone rather than truncated.

## 8. Reporting and error codes

`compact_now` returns one of:

| Reply | Meaning |
|---|---|
| `scheduled at N% (M tokens)` + handoff path | accepted; the turn should end with one line |
| `denied: context is N% … floor is M%` | gate refused; nothing was written |
| `denied: missing required field(s) …` | the model must re-call with a complete handoff |
| `denied: the handoff file could not be written …` | filesystem failure; nothing was scheduled |
| `a compaction is already scheduled (node …)` | duplicate call; the queued request stays |

`log.jsonl` `result` values: `queued`, `done`, `continued`, `reread`, `reread-rate`, `retry:<code>`, `skipped:no-range`, `denied:<reason>`, `failed:<code>`, `abandoned:context-disposed|agent-busy`.

## 9. Testing strategy

`tests/loader.mjs` is a Node resolve hook that points `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-llm` at stubs, so the real plugin entry runs on plain Node with no Harness install. The fake host supplies only the seams the plugin touches: `tools.register`, `tokenMeter.contextPressure`, `compaction.compactNow`, `on(event)`, `effect`, `logger`.

The live path is verified separately on an isolated `DSH_HOME` with a headless profile and a local gateway, because two classes of bug only appear there: module resolution of host peers (fixed by declaring each imported host package as an optional peer, which the loader routes) and the idle-boundary race in headless teardown (fixed by triggering on `agent/status` instead of a timer).

## 10. Open questions

- Should the plugin offer a span-selection mode, closer to `dsh-clear-mind` and `dsh-agent-compact`, where the model writes the summary itself and the extra summarizer request disappears? Their route is cheaper per compaction and needs no idle gap; this route keeps one code path and does not ask the model to condense a 200k-token span inside a tool call. The reread rate (§6) is what should decide: a high rate means the summarizer is the weak link, which argues for letting the model write; a low rate argues for leaving it alone.
- Should the handoff be appended to the surface before compaction so the summarizer sees it as context? It would give Path B's benefit without the takeover, but the message would survive in the retained tail and duplicate the continuation. Cost: one duplicated block of text per compaction. Not measured yet.
- Subagents: a delegated agent's context ends with it, but a long-running subagent could still benefit. Needs a policy for who owns the continuation.
- Should `done` / `drop` / `lessons` be re-injected on the *second* compaction of the same session? They are currently file-only to avoid repeating stale conclusions as fact.
