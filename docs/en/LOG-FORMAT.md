# `log.jsonl`

One JSON object per line, appended to `~/.dsh/self-compact/log.jsonl` (or `logPath`). Nothing rotates and an unreadable log is never overwritten; delete the file to start over.

Every record carries `ts` (ISO 8601) except where noted, and every record about a request carries `session` (session id) and `node` (the handoff milestone label).

## Records

| `result` | Written when | Extra fields |
|---|---|---|
| `queued` | the gate accepted the call and the handoff was written | `pct` (one-decimal percentage at request time), `file` (absolute handoff path) |
| `done` | compaction returned a result | `beforePct`, `afterPct` (percentages on each side), `dropped` (`result.shadowedTokenCount`), `durationMs` |
| `continued` | the continuation prompt was submitted | — |
| `reread` | first call after a compaction whose arguments mention the handoff file | `tool` (tool name) |
| `reread-rate` | the post-compaction watch window closed | `calls`, `rereads` |
| `retry:<code>` | one attempt failed and another is queued | `reason` (first 200 characters) |
| `skipped:no-range` | `compactNow()` returned `null` | `reason`, `durationMs` |
| `denied:<reason>` | the gate refused the call | `pct`; `<reason>` is `below-floor` or `disabled` |
| `failed:<code>` | retries exhausted | `reason` (first 400 characters), `durationMs` |
| `abandoned:<reason>` | the plugin stopped waiting | `reason`; `<reason>` is `context-disposed`, `agent-busy` or `no-engine` |

`pct`, `beforePct`, `afterPct` are percentages with one decimal (`52.3`), not fractions.

`afterPct` is measured from the replayed session tail, so it is the prompt the next request carries. From 0.1.5 that is literally true; earlier versions read the provider's last usage sample, which cannot see a compaction and reported the pre-compact size (`30.3 -> 30.4` after dropping 235,938 tokens).

## Example

```json
{"ts":"2026-11-17T04:54:06.301Z","session":"session-da68","node":"live e2e","pct":0.9,"result":"queued","file":"C:\\Users\\Wei\\.dsh\\self-compact\\handoff\\2026-11-17T04-54-06-300Z-live-e2e.md"}
{"ts":"2026-11-17T04:54:17.807Z","session":"session-da68","node":"live e2e","result":"done","beforePct":0.9,"afterPct":1,"dropped":3451,"durationMs":7334}
{"ts":"2026-11-17T04:54:17.810Z","session":"session-da68","node":"live e2e","result":"continued"}
{"ts":"2026-11-17T04:57:02.114Z","session":"session-da68","node":"live e2e","result":"reread","tool":"read"}
{"ts":"2026-11-17T04:58:41.900Z","session":"session-da68","node":"live e2e","result":"reread-rate","calls":14,"rereads":6}
```

## Reading the numbers

- **Compaction quality.** `beforePct - afterPct` is what one compaction bought; `dropped` is the engine's own estimate of the replaced region's size before the new summary. They disagree when the retained tail is large — that is expected, not a bug.
- **Whether the floor is right.** Many `denied:below-floor` lines and few `done` lines means the floor is too high for the work; frequent `done` at very small `dropped` values means it is too low.
- **Whether the summarizer needs steering.** `rereads / calls` across several `reread-rate` lines: above ~1/3 means the summary is losing things the model needs, which is the trigger for taking over `summarize()` (`docs/en/DESIGN.md` §2, §6). Near zero means the verbatim continuation is enough.

## Failure signatures

| Symptom | Likely cause |
|---|---|
| `failed:busy` repeatedly | another compaction owns the durable lock, or a `/compact` is running; check for a `compaction/start` without `compaction/end` in the session log |
| `failed:summary` | the summarizer call failed through all retries; usually a route error, not a plugin bug |
| `abandoned:context-disposed` | headless one-shot: the process disposed the composition before the compaction could start |
| `abandoned:agent-busy` | waking input arrived after each poll; `maxIdlePolls` expired |
| `skipped:no-range` every time | everything is inside the engine's retained tail; the session is too short to compact |
