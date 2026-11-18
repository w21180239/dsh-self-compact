# `log.jsonl`

One JSON object per line, appended to `~/.dsh/self-compact/log.jsonl` (or `<dataDir>/log.jsonl`). Past about 2 MB the file moves to `log.1.jsonl` and a new one starts; an unreadable log is never overwritten.

Every record carries `ts` (ISO 8601) and `session` (session id). Records about a request also carry `node` (the handoff milestone label).

## Records

| `result` | Written when | Extra fields |
|---|---|---|
| `queued` | the gate accepted the call and the handoff was written | `pct`, `file` (absolute handoff path), `langSource` |
| `done` | compaction returned a result | `beforePct`, `afterPct`, `dropped` (`result.shadowedTokenCount`), `durationMs`, `langSource`, optional `skills` |
| `p-sample` | the post-compact size was measured after a compaction | `pSample` (tokens the next request carries), `p` (the project estimate after folding it in) |
| `continued` | the continuation prompt was submitted | — |
| `stale` | more than 3 tool calls followed a queued request before the turn ended | — |
| `reread` | first call after a compaction whose arguments mention the handoff file | `tool` |
| `reread-rate` | the post-compaction watch window closed | `calls`, `rereads` |
| `node-nudge` | a node signal was flagged to the model | `kind`, `pct` |
| `self-check` | the turn-end self-check prompt was submitted | optional `kind` (node kind or `work`; absent for a long stretch), `pct` |
| `self-check:compacted` | the check turn called `compact_now` | — |
| `self-check:declined` | the check turn ended without it | optional `reason` (text after `skip:`, 200 characters max) |
| `lang-drift` | the first answer after a compaction was in the other language | `expected`, `got` (`zh` or `en`) |
| `skill-ref-miss` | a listed (not inlined) skill reference was read within 30 main steps of a compaction | `skill` |
| `skill-ref-reread` | an inlined skill reference was read anyway | `skill` |
| `retry:<code>` | one attempt failed and another is queued | `reason` (first 200 characters) |
| `skipped:no-range` | `compactNow()` returned `null` | `reason`, `durationMs` |
| `denied:<reason>` | the gate refused the call | `pct`; `<reason>` is `below-floor` or `disabled` |
| `failed:<code>` | retries exhausted | `reason` (first 400 characters), `durationMs` |
| `abandoned:<reason>` | the plugin stopped waiting | `reason`; `<reason>` is `context-disposed`, `agent-busy` or `no-engine` |

`pct`, `beforePct`, `afterPct` are percentages with one decimal (`52.3`), not fractions. `afterPct` and `pSample` are measured from the replayed session tail, so they are the prompt the next request carries.

`langSource` says where the chat language came from: `tool` (this call), `inherited` (the previous compaction), `detected` (the user's last 5 messages) or `none`.

`skills` on `done` is `{ hot, done, inlinedK, listed }`: the skills carried and named finished, the thousand tokens of references inlined, and how many references were listed by path.

## Example

```json
{"ts":"2026-11-18T04:54:06.301Z","session":"s-da68","node":"MR up","pct":21.4,"result":"queued","file":"C:\\Users\\me\\.dsh\\self-compact\\handoff\\2026-11-18T04-54-06-300Z-mr-up.md","langSource":"tool"}
{"ts":"2026-11-18T04:54:31.807Z","session":"s-da68","node":"MR up","result":"done","beforePct":21.4,"afterPct":6.2,"dropped":171000,"durationMs":25334,"langSource":"tool","skills":{"hot":["git-workflow"],"done":[],"inlinedK":1,"listed":0}}
{"ts":"2026-11-18T04:54:31.809Z","session":"s-da68","result":"p-sample","pSample":62000,"p":62000}
{"ts":"2026-11-18T04:54:31.810Z","session":"s-da68","node":"MR up","result":"continued"}
```

## Reading the numbers

- **Whether the tiers fit.** `p` converges to your real post-compact size; the tiers in the tool description follow it from the next process start. Many `denied:below-floor` lines mean the model calls too early; frequent `self-check:declined` with the same reason names what keeps blocking.
- **Whether the triggers work.** `node-nudge` and `self-check` without any `queued` means the model sees the prompts and declines; read the `reason`s.
- **Whether the summary loses too much.** `rereads / calls` across several `reread-rate` lines: above ~1/3 the summary is losing what the model needs, the stated trigger for taking over `summarize()` (`docs/en/DESIGN.md` §2). Near zero the continuation is enough.
- **Whether the skill set is sized right.** Repeated `skill-ref-miss` for one skill raises its miss rate and makes it hot by default; repeated `skill-ref-reread` means inlining did not help for that file.

## Failure signatures

| Symptom | Likely cause |
|---|---|
| `failed:busy` repeatedly | another compaction owns the durable lock, or a `/compact` is running |
| `failed:summary` | the summarizer call failed through all retries; usually a route error |
| `abandoned:context-disposed` | headless one-shot: the process disposed the composition first |
| `abandoned:agent-busy` | waking input arrived after each poll; `maxIdlePolls` expired |
| `skipped:no-range` every time | everything is inside the engine's retained tail; the session is too short |
| `stale` often | the model keeps working after `compact_now`; the tool reply asks it to end the turn |
