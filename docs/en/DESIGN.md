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

**What the summarizer sees.** A third route looks free: write the handoff into the conversation before compacting, so the summarizer reads it as context. It reaches nothing. `dsh-compaction-basic`'s `selectCompactableRange` keeps a priced recent tail verbatim, and `summarizeWithLlm` summarises only the folded prefix, appending its fixed `COMPACTION_INSTRUCTION` after `input.messages`. The newest messages, `compact_now`'s result among them, sit in the retained tail, so the summarizer never reads them, and the handoff would survive twice (in the tail and in the continuation). The continuation prompt stays the only carrier, and 0.2.0 does not port the Claude-side summarizer instructions.

## 3. Lifecycle

```
agent/pre-step, step 1 ──► turn bookkeeping (turn open, signals reset, check turn?)
                              │  every step: nudges, node flags, hints appended
                              ▼
tools/result ──► stale count · node signal · skill tracking · reread watch
                              ▼
tools/pre-execute ──► compact_now body
                        │  gate → handoff file → queue entry
                        │  armAfterIdle(): debounce timer + request.trigger
                        ▼
agent/status (idle) ──► request.trigger()  ← the fast path
                        │  no request: turn-end bookkeeping + self-check scheduling
                        ▼
                    runCompaction()
                        │  ctx.compaction.compactNow(agent, signal)
                        │  retries with retryDelayMs
                        ▼
                    finish() → log · measure and learn P · continuation via agent.followup()
```

Rules that must hold:

1. **One request per session.** A second call while one is queued returns the existing node instead of stacking; `queued` is keyed by `session.id`.
2. **Idle is the trigger, not the turn end.** `agent/status` flips to `idle` exactly when the turn is over. The debounce timer is a fallback for hosts that never emit it; polling exists for the same reason and gives up after `maxIdlePolls`.
3. **`compactNow()` is never wrapped in `agent.runMaintenance()`.** The engine reserves the idle phase itself; wrapping it would throw `busy`.
4. **Every exit logs exactly one terminal line**: `done`, `skipped:no-range`, `failed:<code>`, `abandoned:<reason>`, `stale`. Retries log `retry:<code>` and stay queued.
5. **Torn-down contexts are `abandoned`, not `failed`.** Cordis throws `cannot get required service "compaction" in inactive context` when the composition is already disposing (headless one-shot runs). Retrying that is pointless, so `isInactiveContext()` short-circuits it.
6. **The continuation never starts a new task.** It carries `next` and the open items; if a real user message landed after the request was queued, the continuation is dropped and the compaction still runs.
7. **Turn bookkeeping runs on `agent/pre-step` step 1.** It opens the turn and resets the per-turn signal, nudge flag, `compact_now` flag and tool-call count. A step-1 turn without a human message (no message with `source.kind === 'user'`) that follows a self-check is the check turn, and its outcome is classified on idle as `self-check:compacted` or `self-check:declined`.
8. **The self-check runs on idle.** The `agent/status` idle handler closes the turn and may schedule one self-check: after `debounceMs`, if the agent is still idle and the gate is still open, one `agent.followup` carries the prompt. One check per trigger per 5 points of context growth; none when `compact_now` was called this turn, when the last tool was `ask_user_question`, or when no tool ran since the previous check (calls inside the check turn, or outside any turn, do not count). A declined check also holds the two size-only triggers (work tier, long stretch) until context grows 5 more points; only a node signal asks sooner.
9. **Stale rule.** More than 3 other tool calls between `compact_now` and idle mean the model kept working; the handoff no longer describes the state, so the request is dropped (`stale`) and the next step tells the model to call again if it still wants to compact.
10. **Subagents and non-interactive sessions are out.** A session whose header says `origin === 'subagent'` (or `delegationDepth > 0`) is denied and gets no lines; headless, SDK and ACP hosts get no triggers.

## 4. Gate arithmetic: the break-even cost model

Prices are relative to a cache-miss input token. With `r` = cache-read price (`cacheReadRatio`, 0.1), `o` = output price (`outputRatio`, 1.5), `S` = summary length (`summaryK`, 10k output tokens), `C` = current context and `P` = the size the next request carries after compaction:

```
one compaction costs   o*S + r*C + (1-r)*P
                       summary output, the summarizer replaying the cached prefix, re-caching the new prefix
not compacting costs   r*(C-P) more on every later call
repays within N calls  C >= C(N) = (F/r + N*P) / (N-1),   F = o*S + (1-r)*P
```

Tiers:

```
floor  = C(floorCalls = 20)        or floorPct * window when larger
node   = C(nodeCalls  = 10)
work   = C(workCalls  = 8)
urgent = min(urgentK = 350k, 0.8 * window)
each tier: capped at urgent, then raised to P + MIN_GAIN (25k)
accept = used >= floor
```

With the default P (90k) the floor is 145k, 14.5% of a 1M window. `MIN_GAIN` keeps every tier above the post-compact size, so a compaction always frees at least 25k, and the urgent cap keeps a small window from pushing a tier past 80%. Claude's original used a 10% floor because a compaction there costs real money at about $15/M input; 0.1.x denied below a fixed 30%. The formula replaces the percentage with a floor that moves with the learned P and the price ratios.

`used` is the prompt size the *next* request would carry, which is not the same thing the meter hands out for free. `tokenMeter.contextPressure()` returns the last provider sample; nothing but a request reports usage, so it cannot observe a compaction and keeps answering the pre-compact size until the model replies again. `tokenMeter.measure(session).totalTokens` replays the durable tail and reprices the current surface, so it sees the shadowed region disappear. The gate prefers it and keeps the sample as the fallback (a meter without `measure`, a throwing call, or a zero result). Without this, the first live TUI compaction logged `30.3% -> 30.4%` after dropping 235,938 tokens, and a second `compact_now` in that window would have been accepted against a context that was already 3% full.

**Learning P.** Right after each compaction `measure()` already replays the new tail, so the sample needs no wait for the next step. It folds into an exponentially weighted estimate (weight 0.3) per project and globally; a sample more than 50% off the estimate is an outlier and moves it by 0.1 only, and three same-side outliers in a row reset the estimate to their mean. P for planning comes from the first source that has one: this session's latest sample, the project estimate, the global estimate (each trusted from 3 samples), then the session's first non-zero measured size + 25k (step 1 usually reads 0 before any usage sample; a first reading after step 3 or above 150k is a resumed session, not a baseline; with no measurement the baseline is 65k, so P = 90k). The tool description renders the tiers in tokens for the learned P once per process, so its text stays stable and the prompt cache holds.

**Profile lock.** Several dsh processes share `profile.json`, so every read-modify-write runs under a lock directory (`profile.json.lock`, created with `mkdir`, up to 40 tries 25 ms apart, a lock older than 5 s is stale) and lands by writing a temporary file and renaming it. A process that does not win the lock skips that update.

A one-time `heavy` note goes to the model when `C(workCalls)` reaches `urgentK`: the harness itself is so large that compaction barely pays, so compact at big phase handoffs only.

## 5. Nudges and autonomous triggers

`agent/pre-step` is a waterfall with `prepend: true`, so every model-facing line appends one synthetic user message to the assembled request before the step runs. Rules:

- Nudges start at the node tier (never below the floor) and repeat every `nudgeStepPct` of the window since the previous nudge. Crossing the urgent tier escalates at once, without waiting for the next gap.
- Suppressed while a request is queued, and when another line this step already names `compact_now`.
- Any failure inside the listener returns the untouched decision: a nudge must never break a step.

The injected message uses the plugin's own `MessageSource` kind (`self-compact`) with `form: 'snapshot'`, mirroring how the time-context plugin injects its clock line. Unknown kinds fall through consumers by design, so no host change is needed.

### 5.1 Autonomous triggers

The size tier is a necessary condition. Judging whether the block is closed stays with the model, so every prompt names three criteria: the current block is closed, the next work does not depend on large raw text in context, and enough work remains to repay a compaction. `autoNodes` switches the triggers on; every trigger requires the gate (`used >= floor`), a main session, an interactive host and an empty queue.

- **Node flags.** `tools/result` runs `detectNode` over the dsh built-ins. Strong: `git push` / `merge` / `tag`, PR or MR create / review / merge, `gh issue comment` / `close`, outbound `gog` / `agent-slack` / `slack` / `outlook` sends, a spec/plan or `handoff*` write (`write`, `edit`, `str_replace_editor`, `apply_patch`), an all-completed `todo_write`. Weak: `git commit`, a passing test command, a new `.md`, a returned `subagent` / `wait_agent`. A weak signal flags only from the node tier up; a strong one from the floor. A flag rides the next step as a line, once per turn, and the strongest signal of the turn is remembered for the self-check. Tests stay weak because loops rerun them.
- **Turn-end self-check** (`turnEndCheck`). Scheduled by the idle handler (§3 rule 8). The reason is the first that applies: a node signal in the turn (strong, or weak at the node tier), then a turn with at least two tool calls at the work tier, then the node tier reached after a long stretch. The prompt asks for `compact_now` or a bare `skip: <reason>`; the reason is parsed from the check turn's answer and logged.
- **Block-start hint.** Step 1 of a human turn appends one line once the gate is open, so a new topic or the end of a pause can start from a clean context.

### 5.2 Language rules

A compaction drops the chat language and the output conventions first, so they travel on their own. `compact_now` takes an optional `language: {chat, outputs[]}`. Per sub-field the given value wins, then the previous compaction's; `chat` falls back to the language detected from the user's last 5 messages (with code, URLs and paths removed, at least as many CJK characters as Latin words reads as Chinese, so a Chinese answer full of identifiers stays Chinese). The result leads the handoff file, opens the continuation, and repeats as a line on the next 3 human turns. After a compaction the first assistant answer is classified; a mismatch with the chat rule is logged once as `lang-drift`. `langSource` on `queued` and `done` records which of the three supplied the value.

### 5.3 Skill working set

Skills loaded before a compaction are the first casualty of a summary. `tools/result` tracks each `skill` call's `resourceBase` directory and counts reads and writes under it as use; files other than `SKILL.md` become that skill's references (the 8 most recent). At compaction `tierSkills` splits the loaded skills: hot when `keep_skills` names it, when it was used within `hotWindow` main steps, or when its learned miss rate (`refMisses / compactions`) is at least 0.3 over 3 or more compactions; done when `drop_skills` names it; otherwise left out. The continuation lists each hot skill's `SKILL.md` and inlines its references up to `refInlineK` each and `skillBudgetK` in total (sized by `stat` before any read, and only inside the skill's real directory); the rest go in by path. A listed reference read within 30 main steps of the compaction is a `skill-ref-miss` and raises that skill's miss count in the profile; an inlined one read anyway is a `skill-ref-reread`.

## 6. Observability as a decision procedure

After a successful compaction the plugin arms a watch on the session for `rereadWindowMs`. `tools/result` is an emit-mode observation point that contains the parsed arguments and the calling agent, so counting is free and cannot alter dispatch.

- `reread` — first call whose arguments mention the handoff file; logged once per window with the tool name.
- `reread-rate` — `{calls, rereads}` written when the window closes (a new request, or expiry).

Ratio > ~1/3 ⇒ the summary is losing material the model needs ⇒ Path B in §2 becomes justified. Ratio near zero ⇒ the verbatim continuation is sufficient and the engine stays untouched. This is the whole point of the counter: a design decision that can be re-evaluated with a number instead of a hunch.

0.2.0 adds records for the new mechanisms, each answering one question:

- `p-sample` — the measured post-compact size and the project estimate after folding it in: do the tiers fit this project?
- `node-nudge`, `self-check`, `self-check:compacted`, `self-check:declined` (with the `skip:` reason) — do the triggers work, and what keeps blocking a compaction? Triggers without a `queued` mean the model saw the prompt and declined.
- `stale` — does the model keep working after `compact_now`?
- `lang-drift` — did the language rules hold?
- `skill-ref-miss`, `skill-ref-reread` — is the skill working set sized right?

`queued` and `done` carry `langSource`; `done` carries `skills`. Field reference: `docs/en/LOG-FORMAT.md`.

## 7. Storage layout

```
~/.dsh/self-compact/               (or dataDir)
  handoff/2026-11-17T04-51-13-237Z-live-e2e.md
  log.jsonl
  log.1.jsonl                      after a rotation
  profile.json
```

Handoff filenames are `ISO-time-with-dashes` + a slug of `node` (lowercase, `[a-z0-9-]`, 40 chars). Slugging keeps Windows paths safe and makes the file findable by the node name. Nothing is written inside a repository. `log.jsonl` moves to `log.1.jsonl` once it passes 2 MB; an unreadable log is left alone rather than truncated. `profile.json` holds the P estimates per project (keyed by working directory) and globally, plus per-skill compaction and reference-miss counts; an unreadable profile reads as empty. The location is the single `dataDir` key; there is no separate path for the handoff directory or the log.

## 8. Reporting and error codes

`compact_now` returns one of:

| Reply | Meaning |
|---|---|
| `scheduled at N% (M tokens)` + handoff path | accepted; the turn should end with one line |
| `denied: context is N% … below the break-even floor` | gate refused; nothing was written |
| `denied: missing required field(s) …` | the model must re-call with a complete handoff |
| `denied: the handoff file could not be written …` | filesystem failure; nothing was scheduled |
| `denied: only the main session compacts …` | called from a subagent |
| `a compaction is already scheduled (node …)` | duplicate call; the queued request stays |

`log.jsonl` `result` values: `queued`, `done`, `p-sample`, `continued`, `stale`, `reread`, `reread-rate`, `node-nudge`, `self-check`, `self-check:compacted`, `self-check:declined`, `lang-drift`, `skill-ref-miss`, `skill-ref-reread`, `retry:<code>`, `skipped:no-range`, `denied:<reason>`, `failed:<code>`, `abandoned:context-disposed|agent-busy|no-engine`.

## 9. Testing strategy

`tests/loader.mjs` is a Node resolve hook that points `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-llm` at stubs, so the real plugin entry runs on plain Node with no Harness install. The fake host supplies only the seams the plugin touches: `tools.register`, `tokenMeter.contextPressure` and `measure`, `compaction.compactNow`, `on(event)` (`agent/status`, `agent/pre-step`, `tools/result`), `effect`, `logger`, and an agent with a session header, `snapshotEvents` and `followup`. The pure modules (`gate`, `handoff`, `triggers`, `config`) are tested directly.

The live path is verified separately on an isolated `DSH_HOME` with a headless profile and a local gateway, because two classes of bug only appear there: module resolution of host peers (fixed by declaring each imported host package as an optional peer, which the loader routes) and the idle-boundary race in headless teardown (fixed by triggering on `agent/status` instead of a timer).

## 10. Open questions

- Should the plugin offer a span-selection mode, closer to `dsh-clear-mind` and `dsh-agent-compact`, where the model writes the summary itself and the extra summarizer request disappears? Their route is cheaper per compaction and needs no idle gap; this route keeps one code path and does not ask the model to condense a 200k-token span inside a tool call. The reread rate (§6) is what should decide: a high rate means the summarizer is the weak link, which argues for letting the model write; a low rate argues for leaving it alone.
- Subagents: a delegated agent's context ends with it, but a long-running subagent could still benefit. Subagents are denied today; allowing them needs a policy for who owns the continuation.
- Should `done` / `drop` / `lessons` be re-injected on the *second* compaction of the same session? They are currently file-only to avoid repeating stale conclusions as fact.
