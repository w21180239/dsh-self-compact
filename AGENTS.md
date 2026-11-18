# AGENTS.md

Notes for coding agents working in this repository. Human contributors: `CONTRIBUTING.md` has the same rules with more context.

## What this package is

A DeepSeek Harness plugin bundle. `lib/index.js` is the entire lifecycle (tool registration, idle trigger, compaction call, continuation, nudges, node flags, turn-end self-check, skill tracking, watch). `lib/gate.js`, `lib/handoff.js`, `lib/triggers.js` and `lib/config.js` are pure functions with tests; `lib/profile.js` owns the locked `profile.json`; `lib/strings.js` holds every model-facing line (en, zh).

It does **not** own `ctx.compaction`. Never add code that disables the `compaction-basic` row; see `docs/en/DESIGN.md` §2 for the condition that would change this.

## Commands

| Command | Purpose |
|---|---|
| `npm test` | 33 offline tests; the only gate that must pass before any change is claimed done |
| `node --import ./tests/register.mjs --test tests/logic.test.mjs` | same thing, explicit loader |
| `dsh --profile <p> --dump-config` (with `Select-String self-compact`) | confirm the bundle row composes |

There is no build step and no linter. Do not add one: the package must stay installable as plain ESM.

## Host seams in use

Import only from these, and declare each one as an optional peer dependency in `package.json` — the loader routes host packages by that declaration. A missing entry fails at runtime with `Cannot find package '@deepseek-ai/...'`.

| Seam | Used for |
|---|---|
| `@deepseek-ai/dsh-tools` → `defineTool` | registering `compact_now` |
| `@deepseek-ai/dsh-llm` → `createUserMessage` | synthesizing the continuation and nudge messages |
| `ctx.tools.register` | tool registration (inside `ctx.effect`) |
| `ctx.tokenMeter.contextPressure(session)` | the window, and the fallback prompt size |
| `ctx.tokenMeter.measure(session).totalTokens` | the prompt size the next request carries; the sample above cannot see a compaction |
| `ctx.agentPresets.serviceFor(agent, 'compaction')`, then `agent.ctx`, then root `ctx.get('compaction')` | the host's own compaction. Never inject `compaction`: preset hosts mount the engine in an isolated entry group, so the root never has it and the row would wait forever |
| `ctx.on('agent/status')` | idle boundary — the primary trigger |
| `ctx.on('tools/result', (exec, result))` | staleness, node signals, skill tracking, reread observation (emit mode; cannot alter dispatch). Arguments are `exec.arguments`, the error flag `result.isError` |
| `ctx.on('agent/pre-step', …, { prepend: true })` | turn start (`payload.step === 1`, human when a message has `source.kind === 'user'`) and every model-facing line: nudges, node flags, block-start hint, language line |
| `agent.followup(message)` | continuation and self-check prompts (wakes an idle agent into a new turn) |
| `agent.session.snapshotEvents()` | real user messages (after queueing, the original request, the last 5) and the last assistant answer |
| `agent.session.header` | `origin === 'subagent'` / `delegationDepth` for subagents, `cwd` as the profile project key |
| `ctx.get()` for `headlessStartup`, `sdkAppStartup`, `acpAppStartup` | non-interactive session: no triggers |

## Invariants

1. `compactNow()` is never wrapped in `agent.runMaintenance()`; the engine reserves the idle phase itself.
2. One queued request per session; a second call reports the existing node.
3. Every request ends with exactly one terminal `log.jsonl` record (`docs/en/LOG-FORMAT.md`).
4. A nudge never breaks a step: any failure returns the untouched decision.
5. A compaction checkpoint is a `user/message` with `source.kind !== 'user'` — it is not the human taking over.
6. Torn-down contexts log `abandoned:context-disposed` and are not retried.
7. `result` codes and log field names are a contract; adding is fine, renaming is breaking.

## Verification before claiming done

- `npm test` green, and the new behaviour has a test that fails without the change.
- If behaviour changed: `README.md`, `README.zh-cn.md`, both `DESIGN.md` files, `docs/en/CHANGELOG.md`, and `docs/en/LOG-FORMAT.md` if a record changed.
- Live verification (isolated `DSH_HOME`, headless profile, local gateway) for anything touching lifecycle, loader resolution or idle timing. Offline tests cannot see those classes of bug.
