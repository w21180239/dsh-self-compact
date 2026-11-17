/**
 * dsh-self-compact — agent-initiated compaction for DeepSeek Harness.
 *
 * The model calls `compact_now(handoff)` when it finishes a unit of work. The
 * gate refuses the call while the context is still small, the handoff is
 * written to disk, and the host's own compaction engine runs when the agent
 * goes idle. A continuation prompt then resumes work from the handoff, so
 * nothing is lost to the summarizer's paraphrase.
 *
 * The stock `@deepseek-ai/dsh-compaction-basic` engine keeps owning
 * `ctx.compaction`; this plugin only decides *when* to call its public
 * `compactNow()` seam. Automatic threshold compaction stays armed as the
 * safety net.
 *
 * @module dsh-self-compact
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { resolveConfig } from './config.js';
import { evaluate, measure, nudgeBand } from './gate.js';
import { buildContinuation, normalizeHandoff, renderHandoff, writeHandoff } from './handoff.js';

export const name = 'self-compact';
// `compaction` is deliberately NOT injected: it lives in the session's agent
// preset realm (dsh-tui disables the root `compaction-basic` row and lets each
// preset carry its own engine), so it must be resolved from the calling agent.
export const inject = ['tools', 'tokenMeter'];

/** Sessions with a request waiting for the agent to go idle. */
const queued = new Map();
/** Post-compaction "did the model have to re-read the handoff?" watches, per session. */
const watches = new Map();
/** Last nudge band per session, so the hint fires once per step of growth. */
const nudged = new Map();

/**
 * Register the tool, the idle trigger, and the size nudge.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {object} [rawConfig] - loader-supplied configuration.
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig);
  const language = detectLanguage(rawConfig);
  const logFile = config.logPath || path.join(os.homedir(), '.dsh', 'self-compact', 'log.jsonl');

  /**
   * Resolve the compaction engine for one session.
   *
   * Preset-based hosts (dsh-tui) mount `compaction-basic` inside the agent's
   * own isolate realm and disable the root row, while headless and web profiles
   * carry it at the root. Try the agent first, then the root context.
   * @param {object} agent - live agent, or undefined.
   * @returns {object | null} the engine, or null when this session has none.
   */
  function resolveEngine(agent) {
    const candidates = [agent?.ctx?.compaction, ctx.compaction];
    for (const candidate of candidates) {
      try {
        if (candidate && typeof candidate.compactNow === 'function') return candidate;
      } catch {
        // An inactive scope throws on property access; try the next candidate.
      }
    }
    return null;
  }

  ctx.logger?.info?.(`dsh-self-compact: armed (enabled=${config.enabled}, floor=${Math.round(config.floorPct * 100)}%, nudge=${Math.round(config.nudgeStartPct * 100)}%, urgent=${Math.round(config.urgentPct * 100)}%, engine=${resolveEngine(null) ? 'root' : 'per-agent'})`);

  /**
   * Clear the queue entry and record one outcome.
   * @param {string} sessionId - session identity.
   * @param {object} request - queued request state.
   * @param {object} entry - log fields for this outcome.
   */
  function finish(sessionId, request, entry) {
    if (queued.get(sessionId) === request) queued.delete(sessionId);
    appendLog(logFile, { session: sessionId, node: request.handoff.node, ...entry });
    if (String(entry.result).startsWith('failed')) {
      ctx.logger?.warn?.(`dsh-self-compact: compaction ${entry.result} — ${entry.reason ?? ''}`);
    } else {
      ctx.logger?.info?.(`dsh-self-compact: ${entry.result} at node "${request.handoff.node}"${entry.beforePct != null ? ` (${entry.beforePct}% -> ${entry.afterPct}%)` : ''}`);
    }
  }

  /**
   * Record the watch outcome and drop it.
   * @param {string} sessionId - session identity.
   * @param {object} watch - watch state.
   */
  function finalizeWatch(sessionId, watch) {
    if (!watch || watches.get(sessionId) !== watch) return;
    watches.delete(sessionId);
    if (watch.calls === 0) return;
    appendLog(logFile, {
      session: sessionId,
      node: watch.node,
      result: 'reread-rate',
      calls: watch.calls,
      rereads: watch.rereads,
    });
  }

  /**
   * Start watching the calls that follow one compaction.
   * @param {string} sessionId - session identity.
   * @param {object} request - the compaction request that just finished.
   */
  function armWatch(sessionId, request) {
    finalizeWatch(sessionId, watches.get(sessionId));
    watches.set(sessionId, {
      node: request.handoff.node,
      file: request.file,
      marker: path.basename(request.file),
      until: Date.now() + config.rereadWindowMs,
      calls: 0,
      rereads: 0,
      firstHit: false,
    });
  }

  /**
   * Submit the continuation prompt that resumes work from the handoff.
   * @param {object} agent - live agent.
   * @param {object} request - queued request state.
   * @param {number} beforePct - context percentage when the request was queued.
   * @param {number} afterPct - context percentage after compaction.
   */
  function submitContinuation(agent, request, beforePct, afterPct) {
    const text = buildContinuation(request.handoff, {
      beforePct,
      afterPct,
      file: request.file,
      dropped: request.tokens ?? 0,
    });
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: name, form: 'snapshot', sections: [{ name, text }] },
      }));
      appendLog(logFile, { session: agent.session.id, node: request.handoff.node, result: 'continued' });
      armWatch(agent.session.id, request);
    } catch (error) {
      // The compaction itself succeeded; a failed continuation must not be
      // reported as a failed compaction.
    }
  }

  /**
   * Run one compaction attempt with retries.
   * @param {object} agent - live agent.
   * @param {object} request - queued request state.
   */
  async function runCompaction(agent, request) {
    const sessionId = agent.session.id;
    const started = Date.now();
    let attempt = 0;

    for (;;) {
      if (queued.get(sessionId) !== request) return;
      attempt += 1;
      try {
        const engine = resolveEngine(agent);
        if (!engine) {
          finish(sessionId, request, {
            result: 'abandoned:no-engine',
            reason: 'this session has no compaction engine (preset "minimal" carries none)',
          });
          return;
        }
        const result = await engine.compactNow(agent, new AbortController().signal);
        const after = safeMeasure(ctx, agent, config);
        if (result === null) {
          finish(sessionId, request, {
            result: 'skipped:no-range',
            reason: 'No compactable history yet.',
            durationMs: Date.now() - started,
          });
          return;
        }
        const afterPct = after ? round(after.pct) : 0;
        finish(sessionId, request, {
          result: 'done',
          beforePct: round(request.pct),
          afterPct,
          dropped: result.shadowedTokenCount,
          durationMs: Date.now() - started,
        });
        if (config.continuation && !userSpokeSince(agent, request)) {
          submitContinuation(agent, request, round(request.pct), afterPct);
        }
        return;
      } catch (error) {
        const message = String(error?.message ?? error);
        if (isInactiveContext(message)) {
          // The profile is tearing down: headless runs and disposed agents end
          // the context before the compaction can start.
          finish(sessionId, request, { result: 'abandoned:context-disposed', reason: message.slice(0, 200) });
          return;
        }
        const code = error?.code ?? error?.name ?? 'error';
        if (attempt > config.maxRetries) {
          finish(sessionId, request, {
            result: `failed:${code}`,
            reason: message.slice(0, 400),
            durationMs: Date.now() - started,
          });
          return;
        }
        appendLog(logFile, { session: sessionId, node: request.handoff.node, result: `retry:${code}`, reason: message.slice(0, 200) });
        await delay(config.retryDelayMs);
      }
    }
  }

  /**
   * Wait for this agent to be idle, then run the queued compaction once.
   * @param {object} agent - live agent.
   * @param {object} request - queued request state.
   */
  function armAfterIdle(agent, request) {
    if (request.fulfilled) return;
    let polls = 0;

    const attempt = () => {
      if (request.fulfilled || queued.get(agent.session.id) !== request) return;
      if (agent.status !== 'idle') {
        polls += 1;
        if (polls > config.maxIdlePolls) {
          finish(agent.session.id, request, { result: 'abandoned:agent-busy' });
          return;
        }
        setTimeout(attempt, config.idlePollMs);
        return;
      }
      request.fulfilled = true;
      void runCompaction(agent, request);
    };

    // The idle status event is the exact moment the turn is over: skip the
    // poll chain instead of discovering idleness a beat later, when a
    // short-lived process (headless) may already be tearing the context down.
    request.trigger = () => {
      if (request.fulfilled) return;
      request.fulfilled = true;
      void runCompaction(agent, request);
    };

    setTimeout(attempt, config.debounceMs);
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'compact_now',
    description: compactToolDescription(config, language),
    parameters: {
      node: { type: 'string', required: true, description: 'Milestone label, e.g. "spec written", "MR up", "tests green".' },
      next_step: { type: 'string', required: true, description: 'The first action after compaction. Written as an instruction to yourself.' },
      objective: { type: 'string', description: 'What the session is trying to achieve, in one or two sentences.' },
      standing_orders: { type: 'array', description: 'Rules, constraints and permissions from the user, in their words.' },
      decisions: { type: 'array', description: 'Decisions taken, each with its reason.' },
      artifacts: { type: 'array', description: 'Files, branches, URLs and IDs produced, with paths.' },
      pending: { type: 'array', description: 'Every still-open item and how it reports back.' },
      done: { type: 'array', description: 'Finished work worth naming.' },
      drop: { type: 'array', description: 'Material that may be dropped.' },
      lessons: { type: 'array', description: 'What failed and why, so it is not repeated.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const agent = exec?.agent;
      if (!agent?.session) return 'compact_now: no live agent session on this call; compaction ignored.';
      const sessionId = agent.session.id;

      const existing = queued.get(sessionId);
      if (existing) {
        return `compact_now: a compaction is already scheduled (node "${existing.handoff.node}"); nothing new was queued.`;
      }
      finalizeWatch(sessionId, watches.get(sessionId));
      if (!resolveEngine(agent)) {
        return 'compact_now denied: this session has no compaction engine (the "minimal" preset carries none; standard, ptc and cordis presets do).';
      }

      const { handoff, missing } = normalizeHandoff(args ?? {});
      if (missing.length > 0) {
        return `compact_now denied: missing required field(s) ${missing.join(', ')}. Call it again with the complete handoff.`;
      }

      let measurement;
      try {
        measurement = measure(ctx.tokenMeter, agent.session, config);
      } catch (error) {
        return `compact_now denied: ${error.message}.`;
      }
      const decision = evaluate(measurement, config, language);
      if (!decision.ok) {
        appendLog(logFile, { session: sessionId, node: handoff.node, pct: round(measurement.pct), result: `denied:${decision.reason}` });
        return decision.detail;
      }

      let file;
      try {
        const body = renderHandoff(handoff, { sessionId, now: new Date().toISOString() });
        file = writeHandoff(body, handoff.node, config.handoffDir);
      } catch (error) {
        return `compact_now denied: the handoff file could not be written (${error.message}). Nothing was scheduled.`;
      }

      const request = {
        handoff,
        file,
        queuedAt: Date.now(),
        pct: measurement.pct,
        tokens: measurement.used,
        fulfilled: false,
      };
      queued.set(sessionId, request);
      appendLog(logFile, { session: sessionId, node: handoff.node, pct: round(measurement.pct), result: 'queued', file });
      armAfterIdle(agent, request);

      return [
        `compact_now: scheduled at ${round(measurement.pct)}% (${Math.round(measurement.used)} tokens).`,
        `handoff: ${file}`,
        'End this turn with one short line. The compaction runs as soon as the agent is idle and work resumes from your `next_step` automatically; do not call the tool again.',
      ].join('\n');
    },
  })), `${name}: compact_now`);

  // Fast path: the agent going idle is the moment the turn is over, so start
  // the debounce here instead of waiting for a fallback timer.
  ctx.on('agent/status', (payload) => {
    try {
      if (payload?.status !== 'idle') return;
      const agent = payload.agent;
      const request = agent?.session ? queued.get(agent.session.id) : undefined;
      request?.trigger?.();
    } catch {
      // Never let a status listener break the agent.
    }
  });

  // Observability: does the model have to re-read the handoff to recover facts
  // the summary dropped? One log line per compaction window answers that with a
  // number instead of a guess, and decides whether steering the summarizer is
  // ever worth taking over the engine.
  ctx.on('tools/result', (exec) => {
    try {
      const sessionId = exec?.agent?.session?.id;
      const watch = sessionId ? watches.get(sessionId) : undefined;
      if (!watch) return;
      if (Date.now() > watch.until) {
        finalizeWatch(sessionId, watch);
        return;
      }
      watch.calls += 1;
      const args = safeStringify(exec.parsedArguments ?? exec.arguments ?? exec.args ?? exec.input ?? null);
      if (args.includes(watch.marker) || args.includes(watch.file)) {
        watch.rereads += 1;
        if (!watch.firstHit) {
          watch.firstHit = true;
          appendLog(logFile, { session: sessionId, node: watch.node, result: 'reread', tool: String(exec.name ?? '') });
        }
      }
    } catch {
      // Observability never breaks a call.
    }
  });

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    try {
      if (decision?.kind === 'reject') return decision;
      const agent = payload?.agent;
      if (!agent?.session || payload.signal?.aborted) return decision;
      const sessionId = agent.session.id;
      if (queued.has(sessionId)) return decision;
      const measurement = measure(ctx.tokenMeter, agent.session, config);
      const band = nudgeBand(measurement, config);
      if (band < 0) return decision;
      const previous = nudged.get(sessionId);
      if (previous !== undefined && band <= previous) return decision;
      nudged.set(sessionId, band);
      const text = nudgeText(measurement, config, language);
      return {
        ...decision,
        messages: [
          ...(decision.messages ?? []),
          createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: name, form: 'snapshot', sections: [{ name, text }] },
          }),
        ],
      };
    } catch {
      // A nudge must never break a step: any measurement or shape failure
      // simply means no hint this time.
      return decision;
    }
  }, { prepend: true });
}

/**
 * Whether an error means the composition is being torn down.
 * @param {string} message - error message.
 * @returns {boolean} true for cordis inactive-context failures.
 */
function isInactiveContext(message) {
  return /inactive context|disposed|context is inactive/i.test(message);
}

/**
 * Measure without throwing.
 * @param {object} ctx - host context.
 * @param {object} agent - live agent.
 * @param {object} config - resolved configuration.
 * @returns {ReturnType<typeof measure> | null} measurement or null.
 */
function safeMeasure(ctx, agent, config) {
  try {
    return measure(ctx.tokenMeter, agent.session, config);
  } catch {
    return null;
  }
}

/**
 * Whether a real user message landed after the request was queued.
 *
 * A compaction checkpoint is also a `user/message` event, so the source kind
 * has to be checked: only `kind === 'user'` counts as the human taking over.
 * @param {object} agent - live agent.
 * @param {object} request - queued request state.
 * @returns {boolean} true when the user already moved on.
 */
function userSpokeSince(agent, request) {
  try {
    const events = agent.session?.snapshotEvents?.();
    if (!Array.isArray(events)) return false;
    for (const event of events) {
      if (event?.type !== 'user/message') continue;
      if (event.data?.source?.kind !== 'user') continue;
      if (event.time != null && event.time >= request.queuedAt) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Append one JSON line; logging is best-effort by design.
 * @param {string} file - log path.
 * @param {object} entry - record.
 */
function appendLog(file, entry) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8');
  } catch {
    // Logging is best-effort by design.
  }
}

/**
 * Model-facing tool description: when to compact, when not to, and the gate.
 * @param {object} config - resolved configuration.
 * @param {string} language - 'en' or 'zh'.
 * @returns {string} description text.
 */
function compactToolDescription(config, language) {
  const floor = Math.round(config.floorPct * 100);
  const urgent = Math.round(config.urgentPct * 100);
  if (language === 'zh') {
    return [
      `把一个干净的工作节点写入交接文件，并在本轮结束后压缩上下文（当前硬下限 ${floor}% 窗口）。`,
      '适合调用：一个工作块收尾（测试绿了、MR 建好或合并了、文档写完并落盘、待办全部完成）、即将换话题、或你说"压缩/继续/下一步"之后。',
      '不要调用：正在等你回答决定下一步的问题、刚给你新的规则或纠正还没写进交接、正卡在轮询/重试/调试循环、后台任务结果还没读。',
      '交接必须写清：standing_orders（用户的规则与原话）、decisions（含理由）、pending（每个未完成项及回报方式）、next_step（压缩后第一件事）。压缩后的续跑提示会逐字带上这些内容。',
      `上下文超过 ${urgent}% 时优先尽快挑一个安全节点压缩。调用后本轮用一句话收尾即可，不要重复调用。`,
    ].join('\n');
  }
  return [
    `Write a clean work milestone to a handoff file and compact the context after this turn (hard floor: ${floor}% of the window).`,
    'Call it at a node: a block of work ended (tests green, MR opened or merged, a doc written and on disk, todos complete), you are switching topic, or the user said compact/continue/next.',
    'Do not call it: a question of yours is waiting for the user to decide the next step, the user just corrected you or gave a rule not yet in the handoff, you are mid polling/retry/debug loop, or a background result arrived unread.',
    'The handoff must carry: standing_orders (the user rules in their words), decisions (with reasons), pending (each open item and how it reports), next_step (the first action after compaction). The continuation prompt repeats these verbatim.',
    `Above ${urgent}% of the window, compact at the next safe node rather than waiting for the wall. End the turn with one line after calling; do not call it twice.`,
  ].join('\n');
}

/**
 * Model-facing nudge text for the current band.
 * @param {ReturnType<typeof measure>} measurement - current measurement.
 * @param {object} config - resolved configuration.
 * @param {string} language - 'en' or 'zh'.
 * @returns {string} nudge text.
 */
function nudgeText(measurement, config, language) {
  const pct = round(measurement.pct);
  const urgent = measurement.pct >= config.urgentPct;
  if (language === 'zh') {
    return urgent
      ? `[self-compact] 上下文已到 ${pct}%。下一步若是干净节点（工作块收尾、准备换话题），现在就调用 compact_now 写交接并压缩；不要拖到窗口打满。`
      : `[self-compact] 上下文 ${pct}%。收尾一个工作块、或准备换话题时，调用 compact_now 写交接并压缩，把 standing orders、pending、next 记下来。`;
  }
  return urgent
    ? `[self-compact] Context is at ${pct}%. If the next step is a clean node (a block closing, a topic change), call compact_now now and write the handoff; do not wait for the window wall.`
    : `[self-compact] Context is at ${pct}%. When a block of work closes or you switch topic, call compact_now and write the handoff (standing orders, pending, next).`;
}

/**
 * Pick the plugin language from configuration.
 * @param {object} config - raw loader configuration.
 * @returns {string} 'zh' only when explicitly requested.
 */
function detectLanguage(config) {
  return String(config?.language ?? 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/**
 * Percentage helper.
 * @param {number} fraction - 0..1.
 * @returns {number} one-decimal percentage.
 */
function round(fraction) {
  return Math.round(fraction * 1000) / 10;
}

/**
 * Serialize tool arguments without throwing on cycles.
 * @param {unknown} value - raw arguments.
 * @returns {string} JSON text, or an empty string.
 */
function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * Promise delay.
 * @param {number} ms - milliseconds.
 * @returns {Promise<void>} resolves after the delay.
 */
function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export default { name, inject, apply };
