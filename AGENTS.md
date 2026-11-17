# AGENTS.md

Notes for coding agents working in this repository. Human contributors: `CONTRIBUTING.md` has the same rules with more context.

## What this package is

A DeepSeek Harness plugin bundle. `lib/index.js` is the entire lifecycle (tool registration, idle trigger, compaction call, continuation, nudge, watch). `lib/gate.js`, `lib/handoff.js` and `lib/config.js` are pure functions with tests.

It does **not** own `ctx.compaction`. Never add code that disables the `compaction-basic` row; see `docs/en/DESIGN.md` §2 for the condition that would change this.

## Commands

| Command | Purpose |
|---|---|
| `npm test` | 16 offline tests; the only gate that must pass before any change is claimed done |
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
| `ctx.tokenMeter.contextPressure(session)` | the gate's `{ pressureTokens, contextWindow }` |
| `ctx.compaction.compactNow(agent, signal)` | the host's own compaction |
| `ctx.on('agent/status')` | idle boundary — the primary trigger |
| `ctx.on('tools/result')` | reread observation (emit mode; cannot alter dispatch) |
| `ctx.on('agent/pre-step', …, { prepend: true })` | banded nudge injection |
| `agent.followup(message)` | continuation prompt |
| `agent.session.snapshotEvents()` | detecting a real user message after queueing |

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
