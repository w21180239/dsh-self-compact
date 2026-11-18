# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [0.2.0] — 2026-11-18

Ports the Claude-side plugin's 0.2–0.7 design to Harness.

### Changed

- Every tier derives from P, the learned post-compact size, through a break-even formula priced for DeepSeek-class routes: one compaction costs `o*S + r*C + (1-r)*P` (summary output, the summarizer replaying the cached prefix, re-caching the new prefix), not compacting costs `r*(C-P)` per call, so `C(N) = (F/r + N*P) / (N-1)` with `F = o*S + (1-r)*P`. Floor `C(floorCalls=20)`, node `C(nodeCalls=10)`, work `C(workCalls=8)`, urgent `min(urgentK=350k, 0.8 x window)`; each tier capped at urgent, then raised to `P + 25k`. With the default P (90k) the floor is 145k, 14.5% of a 1M window; 0.1.x denied below 30%.
- P is measured right after each compaction (`tokenMeter.measure()` already replays the new tail, so no next-step wait), folded into an EWMA per project and globally in `~/.dsh/self-compact/profile.json` (outliers damped, three same-side outliers reset), written under a lock directory with an atomic rename because several dsh processes share it. Fallback: this session's sample, the project, the global estimate, then the session's first measured size + 25k.
- The tool description names the tiers in tokens for the learned P. It is rendered once per process, so the prompt cache holds.
- Nudges start at the node tier and repeat every `nudgeStepPct` (5% of the window); crossing urgent escalates at once. A one-time note when the harness itself is so large that compaction barely pays.
- All model-facing text moved to `lib/strings.js` (en, zh), including the continuation labels.
- Configuration: removed `minSavingK`, `baselineK`, `retainK`, `nudgeStartPct`, `urgentPct`, `handoffDir`, `logPath`; added `floorCalls`, `nodeCalls`, `workCalls`, `urgentK`, `summaryK`, `cacheReadRatio`, `outputRatio`, `autoNodes`, `turnEndCheck`, `hotWindow`, `refInlineK`, `skillBudgetK`, `dataDir`. Unknown keys are ignored.

### Added

- Autonomous triggers (`autoNodes`). Node detection over dsh tools: `git push`/`merge`/`tag`, PR/MR create/review/merge, `gh issue comment`/`close`, outbound `gog`/`agent-slack`/`slack`/`outlook` sends, a spec/plan or `handoff*` write (`write`, `edit`, `str_replace_editor`, `apply_patch`), an all-completed `todo_write` (strong); `git commit`, a passing test command, a new `.md`, a returned `subagent`/`wait_agent` (weak). A flag rides the next step once per turn. Turn-end self-check on the idle transition: after a node, a turn with two or more tool calls at the work tier, or a long stretch at the node tier, one prompt asks the model to compact or answer `skip: <reason>`; once per trigger per 5 points, never twice without tool activity in between. Block-start hint on every human prompt once the gate is open. Every prompt states that the size tier is only a necessary condition; the model compacts when three criteria hold (block closed, next work does not depend on large raw text in context, enough work left to repay it).
- Language rules: optional `language: {chat, outputs[]}` on `compact_now`; given value, then the previous compaction's, then the language detected from the user's last 5 messages. Carried in the handoff file's first section, the continuation's first line and the first 3 real user prompts after a compaction; `lang-drift` logged once when the first answer after a compaction is in the other language.
- Skill working set: the `skill` tool's `resourceBase` directory is tracked per skill, and reads under it become refs (8 max). At compaction a skill is hot when kept (`keep_skills`), used within `hotWindow` main steps, or its learned miss rate is at least 0.3 over 3+ compactions; `drop_skills` marks it finished. The continuation lists each hot skill's `SKILL.md` and inlines refs up to `refInlineK` within `skillBudgetK`, the rest by path. Reading a listed ref within 30 steps is a `skill-ref-miss` and feeds the profile.
- The handoff file carries the session's original request (first real user message, 1,500 characters, read from the append-only log, so it survives any number of compactions) and the user's last 5 messages.
- Stale requests: more than 3 tool calls after `compact_now` in the same turn drop the request and tell the model.
- Subagents (`header.origin === 'subagent'` or `delegationDepth > 0`) are denied and get no triggers; headless, SDK and ACP sessions get no triggers.
- The continuation points at `session_search` / `session_event_search` for exact pre-compaction strings.
- `log.jsonl` rotates past 2 MB. New records: `p-sample`, `stale`, `node-nudge`, `self-check`, `self-check:compacted`, `self-check:declined`, `lang-drift`, `skill-ref-miss`, `skill-ref-reread`; `queued` and `done` gain `langSource`, `done` gains `skills`.

### Not ported

- Summarizer instructions. The engine's `summarize()` appends its own fixed instruction and only sees the folded prefix; the newest messages, `compact_now`'s result among them, sit in the verbatim retained tail. Steering the summary still needs the engine takeover in `docs/en/DESIGN.md` §2; the continuation remains the carrier.

## [0.1.5] — 2026-11-17

### Fixed

- Post-compaction accounting read the wrong number. `tokenMeter.contextPressure()` is the last provider usage sample, and only a request reports usage, so right after a compaction it still answered the pre-compact size: the first live TUI compaction logged `30.3% -> 30.4%` with `dropped: 235938`. The gate now reads `tokenMeter.measure(session).totalTokens`, which replays the durable tail and reprices the current surface, falling back to the sample when `measure` is missing, throws, or returns zero. This also closes a re-fire hole: a second `compact_now` right after a compaction used to pass the floor against a context that was already small.

## [0.1.4] — 2026-11-17

### Fixed

- The engine is still not reachable from the agent context on a preset-based host: preset rows mount into an **isolated entry group**, so `compaction` lives in neither the root nor the agent scope (`agent ctx: present, root: missing` from the live probe). The engine is now read through the documented registry seam, `ctx.agentPresets.serviceFor(agent, 'compaction')`, with the agent context and the root kept as fallbacks. The denial text reports all three probes.

## [0.1.3] — 2026-11-17

### Fixed

- A live `compact_now` call failed with `cannot get property "compaction" without inject`. cordis guards service property access from contexts that did not declare the service, and the engine lookup evaluated `ctx.compaction` before entering its try block. The lookup now uses `ctx.get('compaction')`, the ungated service lookup, and keeps the property accessor as a fallback behind its own try. Regression test added.

## [0.1.2] — 2026-11-17

### Fixed

- The bundle never activated on any preset-based profile. `compaction` was a declared injection, but preset hosts disable the root `compaction-basic` row and mount the engine inside each agent's own realm, so the service never appeared at the root and the row waited forever — the tool was simply absent with no error. The engine is now resolved per session from the agent context first, falling back to the root for root-mounted hosts.
- A session whose preset carries no engine (`minimal`) now gets an explicit `compact_now denied: this session has no compaction engine` reply and an `abandoned:no-engine` log record, instead of a request that would silently never run.

## [0.1.1] — 2026-11-17

### Added

- Continuation prompts now carry `decisions` and `artifacts` verbatim (400 characters per item; 12 and 16 items per section, then "… N more in the handoff file"). The native summarizer is most likely to paraphrase exactly these away, and they are what the model needs after the compaction; carrying them closes the gap that engine takeover would otherwise address.
- `reread` / `reread-rate` observability: after each compaction the plugin watches the following calls and records whether they mention the handoff file. The ratio is the stated, numeric condition for ever taking over `summarize()` (see `docs/en/DESIGN.md` §6). New `rereadWindowMs` configuration key (default 30 minutes).
- `pending` is now capped at 24 items so one runaway list cannot crowd out the rest of the continuation.

### Changed

- `done` / `drop` / `lessons` stay file-only by design; repeating stale conclusions as current state costs more than it recovers.
- Ready for publication: dual MIT/Apache-2.0 licence, bilingual README, design notes, log-format reference, CI, contributor and agent guidance.

### Docs

- The comparison now names `dsh-clear-mind` and `dsh-agent-compact`: both are model-initiated and model-written, which is closer to this plugin than the threshold-driven neighbours the first draft listed. The trade-off between the two routes (model writes the summary in-turn vs. host summarizer plus verbatim continuation) is stated instead of being implied.
- CI passes the test file explicitly; `node --test <dir>` fails under `--import` with `ERR_UNSUPPORTED_DIR_IMPORT` on a clean runner.

### Fixed

- `finalizeWatch` threw when no watch existed for the session (`watches.get()` returned `undefined`). Found by the new reread test.

## [0.1.0] — 2026-11-17

### Added

- `compact_now(handoff)` tool for the default agent preset: the model writes a structured handoff at a task milestone and the host's own compaction engine runs after the turn.
- Size gate: `floorPct` of the window, raised to `baseline + retainK + minSavingK` so a small window gets a worthwhile reduction. Denials name the current percentage and the floor.
- Handoff files under `~/.dsh/self-compact/handoff/`, one JSON line per step in `log.jsonl`.
- Idle-boundary trigger on `agent/status`, with a debounce timer and a bounded poll as fallback; retries with `retryDelayMs` and a `maxRetries` cap.
- Continuation prompt via `agent.followup()` carrying `next`, `standing_orders` and `pending` verbatim, plus the handoff path.
- Banded `agent/pre-step` nudges from `nudgeStartPct` every `nudgeStepPct`, escalating at `urgentPct`.
- `language: zh` for the tool description, denials, nudges and the continuation prompt.

### Fixed during live validation

- The debounce timer fired after a headless run had already disposed the composition (`cannot get required service "compaction" in inactive context`). Compaction now starts on the `agent/status` idle transition, and a torn-down context is logged as `abandoned:context-disposed` instead of a retried failure.
- The compaction checkpoint is itself a `user/message` event with a newer timestamp, so it was mistaken for the user taking over and silently dropped every continuation. The check now requires `source.kind === 'user'`.
- Host packages did not resolve inside the host (`Cannot find package '@deepseek-ai/dsh-tools'`) because the import set was not declared. Each imported host package is now an optional peer dependency, which is what the loader routes on.
