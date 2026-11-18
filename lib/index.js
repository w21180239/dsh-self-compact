/**
 * dsh-self-compact — agent-initiated compaction for DeepSeek Harness.
 *
 * The model calls `compact_now(handoff)` at a task node. The gate refuses the
 * call below the break-even floor, the handoff is written to disk, and the
 * host's own compaction engine runs when the agent goes idle. A continuation
 * prompt then resumes work from the handoff. Node flags, a turn-end self-check
 * and a block-start hint supply the trigger; the model keeps the judgment.
 *
 * The stock engine keeps owning `ctx.compaction`; this plugin only decides
 * when to call its public `compactNow()` seam. Automatic threshold compaction
 * stays armed as the safety net.
 *
 * @module dsh-self-compact
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { resolveConfig } from './config.js';
import { evaluate, k, measure, nudgeLevel, pickP, thresholds } from './gate.js';
import {
  buildContinuation, capIntent, chatClass, dominantLang, labels, langLine, mergeLanguage,
  normalizeHandoff, parseSkipReason, renderHandoff, writeHandoff,
} from './handoff.js';
import { addPSample, loadProfile, updateProfile } from './profile.js';
import { strings } from './strings.js';
import { ASK_TOOL, MISS_WINDOW, detectNode, noteSkillPath, pathKey, tierSkills, touchedPaths } from './triggers.js';

export const name = 'self-compact';
// `compaction` is deliberately NOT injected: preset hosts mount it in an
// isolated entry group, so it is resolved from the calling agent instead.
export const inject = ['tools', 'tokenMeter'];

/** Window assumed for the tool description, which is rendered before any request. */
const REF_WINDOW = 1_000_000;
/** A queued request goes stale once more than this many other tool calls follow it. */
export const STALE_AFTER_CALLS = 3;
/** A main turn with at least this many tool calls did a block of work. */
export const WORK_TURN_MIN_CALLS = 2;
/** One self-check per trigger per this many points of growth. */
export const CHECK_STEP_PCT = 5;
/** Real user turns that carry the language line after a compaction. */
export const LANG_REINFORCE_TURNS = 3;
/** A first measurement above this is a resumed session, not a baseline. */
const BASELINE_MAX = 150_000;
const RECENT_USER_MESSAGES = 5;
const LOG_ROTATE_BYTES = 2_000_000;
const NON_INTERACTIVE = ['headlessStartup', 'sdkAppStartup', 'acpAppStartup'];

/** Sessions with a request waiting for the agent to go idle. */
const queued = new Map();
/** Post-compaction "did the model have to re-read the handoff?" watches. */
const watches = new Map();
/** Per-session trigger, language and skill state. */
const sessions = new Map();

/**
 * Per-session state, created on first use.
 * @param {string} id - session id.
 * @returns {object} state.
 */
function stateOf(id) {
  let st = sessions.get(id);
  if (!st) {
    st = {
      baseline: undefined,
      sessionP: undefined,
      lastNudged: undefined,
      heavyNoted: false,
      reqs: 0,
      turnOpen: false,
      turnSignal: undefined,
      nodeNudged: false,
      compactCalled: false,
      turnToolCalls: 0,
      lastTool: undefined,
      lines: [],
      checkedAt: new Map(),
      idleSinceCheck: false,
      awaitingCheck: false,
      checkTurn: false,
      checkTimer: undefined,
      lang: undefined,
      langTurns: 0,
      driftExpect: undefined,
      skills: new Map(),
      post: undefined,
    };
    sessions.set(id, st);
  }
  return st;
}

/**
 * Register the tool, the idle trigger, the triggers and the nudges.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {object} [rawConfig] - loader-supplied configuration.
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig);
  const language = String(rawConfig?.language ?? 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  const S = strings(language);
  const dataDir = config.dataDir || path.join(os.homedir(), '.dsh', 'self-compact');
  const logFile = path.join(dataDir, 'log.jsonl');
  const profileFile = path.join(dataDir, 'profile.json');
  const handoffDir = path.join(dataDir, 'handoff');
  let profile = loadProfile(profileFile);
  const log = (entry) => appendLog(logFile, entry);

  // ---- engine resolution ----

  function probeScope(scope) {
    if (!scope) return null;
    try {
      const viaGet = typeof scope.get === 'function' ? scope.get('compaction') : undefined;
      if (viaGet && typeof viaGet.compactNow === 'function') return viaGet;
    } catch {
      // No such service in this scope.
    }
    try {
      const direct = scope.compaction;
      if (direct && typeof direct.compactNow === 'function') return direct;
    } catch {
      // Property access guarded by inject: expected on the root context.
    }
    return null;
  }

  function probePreset(agent) {
    if (!agent?.ctx) return null;
    try {
      const registry = typeof ctx.get === 'function' ? ctx.get('agentPresets') : undefined;
      const engine = registry?.serviceFor?.(agent, 'compaction');
      if (engine && typeof engine.compactNow === 'function') return engine;
    } catch {
      // No preset registry, or the agent is not bound to a preset group.
    }
    return null;
  }

  const resolveEngine = (agent) => probePreset(agent) ?? probeScope(agent?.ctx) ?? probeScope(ctx);
  const describeProbes = (agent) => {
    const mark = (found) => (found ? 'present' : 'missing');
    return `preset: ${mark(probePreset(agent))}, agent ctx: ${mark(probeScope(agent?.ctx))}, root: ${mark(probeScope(ctx))}`;
  };

  // ---- session facts ----

  const interactive = () => !NON_INTERACTIVE.some((service) => {
    try {
      return typeof ctx.get === 'function' && ctx.get(service) !== undefined;
    } catch {
      return false;
    }
  });
  const projectOf = (agent) => agent?.session?.header?.cwd ?? process.cwd();
  const tiersFor = (agent, st, window) => thresholds(pickP(profile, projectOf(agent), st.sessionP, st.baseline), window, config);

  /** Gate for the autonomous triggers: open, interactive, main session, nothing queued. */
  function triggerGate(agent) {
    if (!config.autoNodes || !config.enabled || !agent?.session || isSubagent(agent) || !interactive()) return undefined;
    if (queued.has(agent.session.id)) return undefined;
    let m;
    try {
      m = measure(ctx.tokenMeter, agent.session);
    } catch {
      return undefined;
    }
    const t = tiersFor(agent, stateOf(agent.session.id), m.window);
    if (m.used < t.floor) return undefined;
    return { m, t, pct: round(m.pct) };
  }

  ctx.logger?.info?.(`dsh-self-compact: armed (enabled=${config.enabled}, autoNodes=${config.autoNodes}, P=${k(pickP(profile, process.cwd()))}, engine=${probeScope(ctx) ? 'root' : 'per-agent'})`);

  // ---- queue lifecycle ----

  function finish(sessionId, request, entry) {
    if (queued.get(sessionId) === request) queued.delete(sessionId);
    log({ session: sessionId, node: request.handoff.node, ...entry });
    if (String(entry.result).startsWith('failed')) {
      ctx.logger?.warn?.(`dsh-self-compact: compaction ${entry.result} — ${entry.reason ?? ''}`);
    } else {
      ctx.logger?.info?.(`dsh-self-compact: ${entry.result} at node "${request.handoff.node}"${entry.beforePct != null ? ` (${entry.beforePct}% -> ${entry.afterPct}%)` : ''}`);
    }
  }

  function finalizeWatch(sessionId, watch) {
    if (!watch || watches.get(sessionId) !== watch) return;
    watches.delete(sessionId);
    if (watch.calls === 0) return;
    log({ session: sessionId, node: watch.node, result: 'reread-rate', calls: watch.calls, rereads: watch.rereads });
  }

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

  /** Fold the measured post-compact size into the session and the profile. */
  function learnSample(agent, st, used) {
    if (!(used > 0)) return;
    st.sessionP = used;
    const saved = updateProfile(profileFile, (p) => addPSample(p, projectOf(agent), used));
    if (saved) profile = saved;
    log({ session: agent.session.id, result: 'p-sample', pSample: used, p: pickP(profile, projectOf(agent)) });
  }

  /** Count this compaction for every loaded skill and snapshot refs for miss learning. */
  function noteSkillCompaction(st, inlined) {
    if (st.skills.size === 0) return;
    const saved = updateProfile(profileFile, (p) => {
      for (const use of st.skills.values()) {
        const prior = p.skills[use.name] ?? { compactions: 0, refMisses: 0 };
        p.skills[use.name] = { compactions: prior.compactions + 1, refMisses: prior.refMisses };
      }
    });
    if (saved) profile = saved;
    const refs = new Map();
    for (const use of st.skills.values()) refs.set(use.name, new Set(use.refs.map((r) => keyOf(r))));
    st.post = { at: st.reqs, refs, inlined: new Set([...inlined].map((r) => keyOf(r))) };
  }

  /** Skill working set for the continuation: hot skills with inlined or listed refs, done skills. */
  function renderSkills(st, handoff) {
    const { hot, done } = tierSkills(st.skills.values(), {
      keep: handoff.keep_skills,
      drop: handoff.drop_skills,
      now: st.reqs,
      priors: profile.skills,
      hotWindow: config.hotWindow,
    });
    if (hot.length === 0 && done.length === 0) return { text: undefined, inlined: [], log: undefined };
    const t = labels(language);
    const lines = [t.skillSet];
    const inlined = [];
    let budget = config.skillBudgetK * 4000;
    let inlinedChars = 0;
    let listed = 0;
    for (const use of hot) {
      lines.push(t.skillHot(use.name, use.dir ? `${use.dir.replace(/\\/g, '/')}/SKILL.md` : undefined));
      for (const ref of use.refs) {
        const body = readRef(ref, use.dir, config.refInlineK * 4000, budget);
        if (body === undefined) {
          lines.push(t.skillRef(ref));
          listed += 1;
          continue;
        }
        budget -= body.length;
        inlinedChars += body.length;
        inlined.push(ref);
        lines.push(`  - ${ref}:`, fence(body));
      }
    }
    for (const use of done) lines.push(t.skillDone(use.name));
    return {
      text: lines.join('\n'),
      inlined,
      log: { hot: hot.map((u) => u.name), done: done.map((u) => u.name), inlinedK: Math.round(inlinedChars / 4000), listed },
    };
  }

  function submitContinuation(agent, request, beforePct, afterPct, skills) {
    const text = buildContinuation(request.handoff, {
      beforePct,
      afterPct,
      file: request.file,
      dropped: request.dropped ?? 0,
      language,
      skills,
    });
    try {
      agent.followup(syntheticMessage(text));
      log({ session: agent.session.id, node: request.handoff.node, result: 'continued' });
      armWatch(agent.session.id, request);
    } catch {
      // The compaction itself succeeded; a failed continuation is not a failed compaction.
    }
  }

  async function runCompaction(agent, request) {
    const sessionId = agent.session.id;
    const st = stateOf(sessionId);
    const started = Date.now();
    let attempt = 0;

    for (;;) {
      if (queued.get(sessionId) !== request) return;
      attempt += 1;
      try {
        const engine = resolveEngine(agent);
        if (!engine) {
          finish(sessionId, request, { result: 'abandoned:no-engine', reason: 'this session has no compaction engine (preset "minimal" carries none)' });
          return;
        }
        const result = await engine.compactNow(agent, new AbortController().signal);
        if (result === null) {
          finish(sessionId, request, { result: 'skipped:no-range', reason: 'No compactable history yet.', durationMs: Date.now() - started });
          return;
        }
        const after = safeMeasure(ctx, agent);
        const afterPct = after ? round(after.pct) : 0;
        request.dropped = result.shadowedTokenCount;
        const skills = renderSkills(st, request.handoff);
        finish(sessionId, request, {
          result: 'done',
          beforePct: round(request.pct),
          afterPct,
          dropped: result.shadowedTokenCount,
          durationMs: Date.now() - started,
          langSource: request.langSource,
          ...(skills.log ? { skills: skills.log } : {}),
        });
        // measure() replays the durable tail, so this is the exact next prompt.
        if (after) learnSample(agent, st, after.used);
        noteSkillCompaction(st, skills.inlined);
        st.lastNudged = undefined;
        st.checkedAt.clear();
        if (request.handoff.language) {
          st.langTurns = LANG_REINFORCE_TURNS;
          st.driftExpect = chatClass(request.handoff.language.chat);
        }
        if (config.continuation && !userSpokeSince(agent, request)) {
          submitContinuation(agent, request, round(request.pct), afterPct, skills.text);
        }
        return;
      } catch (error) {
        const message = String(error?.message ?? error);
        if (isInactiveContext(message)) {
          finish(sessionId, request, { result: 'abandoned:context-disposed', reason: message.slice(0, 200) });
          return;
        }
        const code = error?.code ?? error?.name ?? 'error';
        if (attempt > config.maxRetries) {
          finish(sessionId, request, { result: `failed:${code}`, reason: message.slice(0, 400), durationMs: Date.now() - started });
          return;
        }
        log({ session: sessionId, node: request.handoff.node, result: `retry:${code}`, reason: message.slice(0, 200) });
        await delay(config.retryDelayMs);
      }
    }
  }

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
    // The idle status event is the exact turn end; a short-lived process may
    // already be tearing the context down a beat later.
    request.trigger = () => {
      if (request.fulfilled) return;
      request.fulfilled = true;
      void runCompaction(agent, request);
    };
    setTimeout(attempt, config.debounceMs);
  }

  // ---- the tool ----

  const p = S.params;
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'compact_now',
    // Rendered once per process from the learned P: stable text keeps the prompt cache.
    description: S.description(thresholds(pickP(profile, process.cwd()), REF_WINDOW, config)),
    parameters: {
      node: { type: 'string', required: true, description: p.node },
      next_step: { type: 'string', required: true, description: p.next_step },
      objective: { type: 'string', description: p.objective },
      standing_orders: { type: 'array', description: p.standing_orders },
      decisions: { type: 'array', description: p.decisions },
      artifacts: { type: 'array', description: p.artifacts },
      pending: { type: 'array', description: p.pending },
      done: { type: 'array', description: p.done },
      drop: { type: 'array', description: p.drop },
      lessons: { type: 'array', description: p.lessons },
      language: {
        type: 'object',
        description: p.language,
        additionalProperties: false,
        properties: {
          chat: { type: 'string' },
          outputs: { type: 'array', items: { type: 'string' } },
        },
      },
      keep_skills: { type: 'array', description: p.keep_skills },
      drop_skills: { type: 'array', description: p.drop_skills },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args, exec) {
      const agent = exec?.agent;
      if (!agent?.session) return 'compact_now: no live agent session on this call; compaction ignored.';
      if (isSubagent(agent)) return S.denySub;
      const sessionId = agent.session.id;
      const st = stateOf(sessionId);
      st.compactCalled = true;

      const existing = queued.get(sessionId);
      if (existing) return S.duplicate(existing.handoff.node);
      finalizeWatch(sessionId, watches.get(sessionId));
      if (!resolveEngine(agent)) return S.denyEngine(describeProbes(agent));

      const { handoff, missing } = normalizeHandoff(args ?? {});
      if (missing.length > 0) return S.denyMissing(missing.join(', '));

      let m;
      try {
        m = measure(ctx.tokenMeter, agent.session);
      } catch (error) {
        return `compact_now denied: ${error.message}.`;
      }
      const t = tiersFor(agent, st, m.window);
      const decision = evaluate(m, t, config.enabled, language);
      if (!decision.ok) {
        log({ session: sessionId, node: handoff.node, pct: round(m.pct), result: `denied:${decision.reason}` });
        return decision.detail;
      }

      const userTexts = realUserTexts(agent);
      const recent = userTexts.slice(-RECENT_USER_MESSAGES);
      const merged = mergeLanguage(st.lang, handoff.language, dominantLang(recent.join(' ')), language);
      const { source: langSource, ...rules } = merged;
      handoff.language = rules.chat || rules.outputs.length > 0 ? rules : undefined;
      st.lang = handoff.language;

      let file;
      try {
        const body = renderHandoff(handoff, {
          sessionId,
          now: new Date().toISOString(),
          language,
          intent: capIntent(userTexts[0]),
          recent,
          skills: [...st.skills.keys()],
        });
        file = writeHandoff(body, handoff.node, handoffDir);
      } catch (error) {
        return S.denyWrite(error.message);
      }

      const request = {
        handoff,
        file,
        queuedAt: Date.now(),
        pct: m.pct,
        tokens: m.used,
        callsSince: 0,
        langSource,
        fulfilled: false,
      };
      queued.set(sessionId, request);
      log({ session: sessionId, node: handoff.node, pct: round(m.pct), result: 'queued', file, langSource });
      armAfterIdle(agent, request);
      return S.scheduled(round(m.pct), Math.round(m.used), file);
    },
  })), `${name}: compact_now`);

  // ---- turn end: run the queue, settle the self-check, schedule the next one ----

  ctx.on('agent/status', (payload) => {
    try {
      if (payload?.status !== 'idle') return;
      const agent = payload.agent;
      if (!agent?.session) return;
      const request = queued.get(agent.session.id);
      request?.trigger?.();
      if (isSubagent(agent)) return;
      const st = stateOf(agent.session.id);
      if (!st.turnOpen) return;
      st.turnOpen = false;
      onTurnEnd(agent, st);
    } catch {
      // Never let a status listener break the agent.
    }
  });

  function onTurnEnd(agent, st) {
    const answer = lastAssistantText(agent);
    if (st.driftExpect && !st.checkTurn && answer.trim() !== '') {
      const expected = st.driftExpect;
      st.driftExpect = undefined;
      const got = dominantLang(answer);
      if (got && got !== expected) log({ session: agent.session.id, result: 'lang-drift', expected, got });
    }
    if (st.checkTurn) {
      st.checkTurn = false;
      if (st.compactCalled) log({ session: agent.session.id, result: 'self-check:compacted' });
      else {
        const reason = parseSkipReason(answer);
        log({ session: agent.session.id, result: 'self-check:declined', ...(reason ? { reason } : {}) });
      }
    }
    scheduleSelfCheck(agent, st);
  }

  function scheduleSelfCheck(agent, st) {
    if (!config.turnEndCheck || st.compactCalled || st.idleSinceCheck) return;
    if (st.lastTool === ASK_TOOL) return;
    const g = triggerGate(agent);
    if (!g) return;
    const sig = st.turnSignal;
    let key;
    let reason;
    if (sig && (sig.strength === 'strong' || g.m.used >= g.t.node)) {
      key = sig.kind;
      reason = S.reasonNode(sig.kind);
    } else if (st.turnToolCalls >= WORK_TURN_MIN_CALLS && g.m.used >= g.t.work) {
      key = 'work';
      reason = S.reasonWork;
    } else if (g.m.used >= g.t.node) {
      key = 'pct';
      reason = S.reasonLong;
    } else return;
    const prev = st.checkedAt.get(key);
    if (prev !== undefined && g.pct >= prev && g.pct < prev + CHECK_STEP_PCT) return;
    st.checkedAt.set(key, g.pct);
    st.idleSinceCheck = true;
    clearTimeout(st.checkTimer);
    st.checkTimer = setTimeout(() => {
      st.checkTimer = undefined;
      try {
        if (agent.status !== 'idle') return;
        const again = triggerGate(agent);
        if (!again) return;
        st.awaitingCheck = true;
        log({ session: agent.session.id, result: 'self-check', ...(key === 'pct' ? {} : { kind: key }), pct: again.pct });
        agent.followup(syntheticMessage(S.selfCheck(reason, again.pct)));
      } catch {
        // The self-check is best effort.
      }
    }, config.debounceMs);
  }

  // ---- tool results: staleness, node flags, skills, rereads ----

  ctx.on('tools/result', (exec, result) => {
    try {
      const agent = exec?.agent;
      const sessionId = agent?.session?.id;
      if (!sessionId) return;
      const toolName = String(exec.name ?? '');
      const args = exec.arguments ?? exec.parsedArguments ?? null;
      observeReread(sessionId, toolName, args);
      if (isSubagent(agent) || toolName === 'compact_now') return;
      const st = stateOf(sessionId);
      st.lastTool = toolName;
      st.turnToolCalls += 1;
      st.idleSinceCheck = false;
      const request = queued.get(sessionId);
      if (request && !request.fulfilled) {
        request.callsSince += 1;
        if (request.callsSince > STALE_AFTER_CALLS) {
          finish(sessionId, request, { result: 'stale' });
          st.lines.push(S.stale);
        }
      }
      if (!result?.isError) trackSkills(agent, st, toolName, args, result);
      onNodeSignal(agent, st, toolName, args, result);
    } catch {
      // Observation never breaks a call.
    }
  });

  function observeReread(sessionId, toolName, args) {
    const watch = watches.get(sessionId);
    if (!watch) return;
    if (Date.now() > watch.until) {
      finalizeWatch(sessionId, watch);
      return;
    }
    watch.calls += 1;
    const text = safeStringify(args);
    if (text.includes(watch.marker) || text.includes(watch.file) || text.includes(watch.file.replace(/\\/g, '\\\\'))) {
      watch.rereads += 1;
      if (!watch.firstHit) {
        watch.firstHit = true;
        log({ session: sessionId, node: watch.node, result: 'reread', tool: toolName });
      }
    }
  }

  function onNodeSignal(agent, st, toolName, args, result) {
    if (!config.autoNodes) return;
    const sig = detectNode(toolName, args, result);
    if (!sig) return;
    const cur = st.turnSignal;
    if (!cur || sig.strength === 'strong' || cur.strength === 'weak') st.turnSignal = sig;
    if (st.nodeNudged) return;
    const g = triggerGate(agent);
    if (!g || (sig.strength === 'weak' && g.m.used < g.t.node)) return;
    st.nodeNudged = true;
    log({ session: agent.session.id, result: 'node-nudge', kind: sig.kind, pct: g.pct });
    st.lines.push(S.nodeNudge(sig.kind, g.pct));
  }

  function trackSkills(agent, st, toolName, args, result) {
    const cwd = projectOf(agent);
    const home = os.homedir();
    if (toolName === 'skill' && typeof args?.name === 'string') {
      const base = result?.value?.resourceBase;
      const dir = base?.kind === 'directory' && typeof base.path === 'string' ? path.resolve(cwd, base.path) : undefined;
      const prev = st.skills.get(args.name);
      st.skills.set(args.name, {
        name: args.name,
        dir,
        dirKey: dir ? pathKey(dir, cwd, home) : `\0${args.name}`,
        lastUse: st.reqs,
        refs: prev?.refs ?? [],
      });
      return;
    }
    if (st.skills.size === 0) return;
    for (const touched of touchedPaths(toolName, args)) {
      const key = pathKey(touched.path, cwd, home);
      if (!key) continue;
      const abs = path.resolve(cwd, touched.path).replace(/\\/g, '/');
      noteSkillPath(st.skills, key, abs, touched.file, st.reqs);
      if (toolName === 'read') learnRefRead(agent, st, key);
    }
  }

  function learnRefRead(agent, st, key) {
    const post = st.post;
    if (!post || st.reqs - post.at > MISS_WINDOW) return;
    for (const [skill, refs] of post.refs) {
      if (!refs.has(key)) continue;
      refs.delete(key);
      if (post.inlined.has(key)) {
        log({ session: agent.session.id, result: 'skill-ref-reread', skill });
        continue;
      }
      const saved = updateProfile(profileFile, (prof) => {
        const prior = prof.skills[skill] ?? { compactions: 0, refMisses: 0 };
        prof.skills[skill] = { compactions: prior.compactions, refMisses: prior.refMisses + 1 };
      });
      if (saved) profile = saved;
      log({ session: agent.session.id, result: 'skill-ref-miss', skill });
    }
  }

  // ---- pre-step: turn bookkeeping and every model-facing line ----

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    try {
      if (decision?.kind === 'reject') return decision;
      const agent = payload?.agent;
      if (!agent?.session || payload.signal?.aborted || isSubagent(agent)) return decision;
      const sessionId = agent.session.id;
      const st = stateOf(sessionId);
      st.reqs += 1;
      const lines = [];
      if (payload.step === 1) {
        const human = (payload.messages ?? []).some((msg) => msg?.source?.kind === 'user');
        st.turnOpen = true;
        st.turnSignal = undefined;
        st.nodeNudged = false;
        st.compactCalled = false;
        st.turnToolCalls = 0;
        st.lastTool = undefined;
        st.checkTurn = st.awaitingCheck && !human;
        st.awaitingCheck = false;
        clearTimeout(st.checkTimer);
        st.checkTimer = undefined;
        if (human) {
          if (st.langTurns > 0) {
            st.langTurns -= 1;
            const line = langLine(st.lang, language);
            if (line) lines.push(labels(language).reinforce(line));
          }
          const g = triggerGate(agent);
          if (g) lines.push(S.blockStart(g.pct));
        }
      }
      lines.push(...st.lines.splice(0));
      if (!queued.has(sessionId)) {
        const m = measure(ctx.tokenMeter, agent.session);
        if (st.baseline === undefined && st.reqs === 1 && m.used > 0 && m.used <= BASELINE_MAX) st.baseline = m.used;
        const t = tiersFor(agent, st, m.window);
        if (t.heavy && !st.heavyNoted && m.used >= t.floor) {
          st.heavyNoted = true;
          lines.push(S.heavy(k(t.p)));
        }
        const level = nudgeLevel(m.used, st.lastNudged, t, config.nudgeStepPct * m.window);
        if (level !== 'none' && !lines.some((l) => l.includes('compact_now'))) {
          st.lastNudged = m.used;
          lines.push(level === 'urgent' ? S.nudgeUrgent(round(m.pct)) : S.nudgeSoft(round(m.pct)));
        }
      }
      if (lines.length === 0) return decision;
      return { ...decision, messages: [...(decision.messages ?? []), syntheticMessage(lines.join('\n\n'))] };
    } catch {
      // A nudge must never break a step.
      return decision;
    }
  }, { prepend: true });
}

/**
 * Plugin-sourced user message; `source.kind` keeps it apart from the human.
 * @param {string} text - body.
 * @returns {object} user message.
 */
function syntheticMessage(text) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: name, form: 'snapshot', sections: [{ name, text }] },
  });
}

/**
 * A delegated child: subagents stay short and never compact.
 * @param {object} agent - live agent.
 * @returns {boolean} true for a subagent.
 */
export function isSubagent(agent) {
  const header = agent?.session?.header;
  return header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0;
}

function isInactiveContext(message) {
  return /inactive context|disposed|context is inactive/i.test(message);
}

function safeMeasure(ctx, agent) {
  try {
    return measure(ctx.tokenMeter, agent.session);
  } catch {
    return null;
  }
}

function events(agent) {
  try {
    const list = agent.session?.snapshotEvents?.();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

const textOf = (content) => (Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '');

/**
 * Text the person typed, oldest first. The log is append-only, so the opening
 * request is still there after any number of compactions.
 * @param {object} agent - live agent.
 * @returns {string[]} messages.
 */
function realUserTexts(agent) {
  return events(agent)
    .filter((e) => e?.type === 'user/message' && e.data?.source?.kind === 'user')
    .map((e) => textOf(e.data.content).trim())
    .filter(Boolean);
}

function lastAssistantText(agent) {
  const list = events(agent);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const e = list[i];
    if (e?.type !== 'assistant/message') continue;
    const text = textOf(e.data?.message?.content);
    if (text.trim() !== '') return text;
  }
  return '';
}

/**
 * Whether a real user message landed after the request was queued. A
 * compaction checkpoint is also a `user/message`, so only `kind === 'user'` counts.
 * @param {object} agent - live agent.
 * @param {object} request - queued request.
 * @returns {boolean} true when the user already moved on.
 */
function userSpokeSince(agent, request) {
  for (const event of events(agent)) {
    if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user') continue;
    if (event.time != null && event.time >= request.queuedAt) return true;
  }
  return false;
}

/**
 * Read one skill reference for inlining, or undefined to list it instead.
 * Sized by stat first, so an oversized file is never read.
 * @param {string} ref - absolute path.
 * @param {string | undefined} dir - the skill's directory.
 * @param {number} maxChars - per-file cap.
 * @param {number} budget - chars left in the total budget.
 * @returns {string | undefined} file text.
 */
function readRef(ref, dir, maxChars, budget) {
  if (!dir) return undefined;
  try {
    const size = fs.statSync(ref).size;
    if (size > maxChars || size > budget) return undefined;
    const real = fs.realpathSync(ref);
    const root = fs.realpathSync(dir);
    if (!keyOf(real).startsWith(`${keyOf(root)}/`)) return undefined;
    return fs.readFileSync(real, 'utf8');
  } catch {
    return undefined;
  }
}

const keyOf = (p) => {
  const slashed = p.replace(/\\/g, '/');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
};

function fence(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const marks = '`'.repeat(Math.max(3, longest + 1));
  return `${marks}\n${text.trimEnd()}\n${marks}`;
}

/**
 * Append one JSON line, rotating past ~2 MB; logging is best-effort.
 * @param {string} file - log path.
 * @param {object} entry - record.
 */
function appendLog(file, entry) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > LOG_ROTATE_BYTES) fs.renameSync(file, file.replace(/\.jsonl$/, '.1.jsonl'));
    } catch {
      // No log yet.
    }
    fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8');
  } catch {
    // Logging is best-effort by design.
  }
}

function round(fraction) {
  return Math.round(fraction * 1000) / 10;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export default { name, inject, apply };
