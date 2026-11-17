# Contributing

Thanks for looking at this. The plugin is small on purpose: one tool, one after-turn trigger, one observer. Keep it that way.

## Before you open a pull request

```sh
npm test     # node --import ./tests/register.mjs --test tests/
```

Every change that touches `lib/` needs a test that fails without it. The suite runs on plain Node 22+ — no Harness install, no network — because `tests/loader.mjs` redirects the two host imports to stubs. If your change needs another host seam, extend the fake host in `tests/logic.test.mjs` rather than adding a dependency.

Please also say, in the pull request, whether you ran a live host, and on which dsh version. Offline tests cannot catch loader routing or lifecycle races; two of the bugs recorded in the changelog were only visible on a real host.

## What belongs here

- Anything that makes the compaction decision better: gate arithmetic, node/anti-node guidance, handoff shape, continuation content.
- Observability that lets a design decision be re-checked with a number (the reread rate is the model for this).
- Fixes for lifecycle races: idle boundaries, teardown, cancellation, duplicate requests.

## What does not

- Taking over `ctx.compaction` (the `compaction-basic` row). That is a different product with a different failure surface; see `docs/en/DESIGN.md` §2 for the condition under which it becomes justified, and open an issue with log evidence first.
- Network calls, telemetry, or any dependency beyond the host packages.
- Anything that needs a change inside the dsh host itself.

## Code style

- ES modules, no build step, Node 22+. `lib/index.js` is the only file with lifecycle code; the rest are pure functions with tests.
- Comments carry facts and reasons, one line where possible. No restating the code.
- `log.jsonl` field names and `result` codes are a contract (`docs/en/LOG-FORMAT.md`). Adding one is fine; renaming or dropping one is a breaking change.
- Error paths must end in exactly one terminal log line, and a nudge must never break a step.

## Docs

If behaviour changes, update, in the same pull request: `README.md`, `README.zh-cn.md`, `docs/en/DESIGN.md` (and the zh-cn copy), `docs/en/CHANGELOG.md`, and `docs/en/LOG-FORMAT.md` when a record changes. The two design documents are kept in step deliberately; an English-only change is an incomplete change.

## Reporting a bug

Include the relevant `log.jsonl` lines, your `config` overrides, the dsh version, and whether the session was TUI, web or headless. Handoff files contain your own conversation text — redact before pasting.
