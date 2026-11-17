# Changelog

All notable changes are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [0.1.1] — 2026-11-17

### Added

- Continuation prompts now carry `decisions` and `artifacts` verbatim (400 characters per item; 12 and 16 items per section, then "… N more in the handoff file"). The native summarizer is most likely to paraphrase exactly these away, and they are what the model needs after the compaction; carrying them closes the gap that engine takeover would otherwise address.
- `reread` / `reread-rate` observability: after each compaction the plugin watches the following calls and records whether they mention the handoff file. The ratio is the stated, numeric condition for ever taking over `summarize()` (see `docs/en/DESIGN.md` §6). New `rereadWindowMs` configuration key (default 30 minutes).
- `pending` is now capped at 24 items so one runaway list cannot crowd out the rest of the continuation.

### Changed

- `done` / `drop` / `lessons` stay file-only by design; repeating stale conclusions as current state costs more than it recovers.
- Ready for publication: dual MIT/Apache-2.0 licence, bilingual README, design notes, log-format reference, CI, contributor and agent guidance.

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
