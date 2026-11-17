/**
 * Offline logic tests for dsh-self-compact.
 *
 * The host packages are stubbed by tests/loader.mjs, so this runs on any Node
 * 22+ without installing DeepSeek Harness:
 *
 *   node --import ./tests/register.mjs --test tests/
 *
 * @module dsh-self-compact/tests
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { apply } from '../lib/index.js';
import { evaluate, measure, nudgeBand } from '../lib/gate.js';
import { buildContinuation, normalizeHandoff, renderHandoff } from '../lib/handoff.js';
import { resolveConfig } from '../lib/config.js';

const BASE = resolveConfig({ debounceMs: 0, retryDelayMs: 0, idlePollMs: 0, maxRetries: 1 });

/**
 * Build a fake host context with just the seams this plugin uses.
 * @param {{used?: number, window?: number, compact?: Function, language?: string}} options - fake host facts.
 * @returns {{ctx: object, tools: object[], listeners: object[]}} fake context and captured registrations.
 */
function fakeHost(options = {}) {
  const used = options.used ?? 0;
  const window = options.window ?? 1_000_000;
  const tools = [];
  const listeners = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    tools: {
      register(tool) {
        tools.push(tool);
        return () => {};
      },
    },
    tokenMeter: { contextPressure: () => ({ pressureTokens: used, contextWindow: window }) },
    ...(options.rootEngine === false ? {} : { compaction: { compactNow: options.compact ?? (async () => null) } }),
    on(event, handler, opts) {
      listeners.push({ event, handler, opts });
      return () => {};
    },
  };
  return { ctx, tools, listeners };
}

/**
 * Build a fake agent.
 * @param {{id: string, status?: string, events?: object[]}} options - fake agent facts.
 * @returns {object} fake agent.
 */
function fakeAgent(options) {
  const state = {
    id: options.id,
    status: options.status ?? 'running',
    followups: [],
    ctx: options.ctx,
    session: {
      id: options.id,
      snapshotEvents: () => options.events ?? [],
    },
    followup(message) {
      state.followups.push(message);
    },
  };
  return state;
}

/**
 * Wait for the after-turn pipeline to settle.
 * @param {number} [ms] - grace period.
 * @returns {Promise<void>} resolves after the grace period.
 */
function settle(ms = 30) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Locate a registered tool by name.
 * @param {object[]} tools - registered tools.
 * @param {string} toolName - tool name.
 * @returns {object} the tool definition.
 */
function toolByName(tools, toolName) {
  const found = tools.find((tool) => tool.name === toolName);
  assert.ok(found, `tool ${toolName} should be registered`);
  return found;
}

test('gate denies below the floor and names the percentage', () => {
  const config = resolveConfig({});
  const measurement = measure({ contextPressure: () => ({ pressureTokens: 120_000, contextWindow: 1_000_000 }) }, {}, config);
  const decision = evaluate(measurement, config, 'en');
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'below-floor');
  assert.match(decision.detail, /12\.0%/);
});

test('gate allows a node above the floor with a worthwhile saving', () => {
  const config = resolveConfig({});
  const measurement = measure({ contextPressure: () => ({ pressureTokens: 420_000, contextWindow: 1_000_000 }) }, {}, config);
  assert.deepEqual(evaluate(measurement, config, 'en'), { ok: true });
});

test('the minimum saving raises the floor on a small window', () => {
  // 200k window: 30% is only 60k, so the baseline + retain + minSavingK floor wins.
  const config = resolveConfig({ minSavingK: 100 });
  const measurement = measure({ contextPressure: () => ({ pressureTokens: 120_000, contextWindow: 200_000 }) }, {}, config);
  const decision = evaluate(measurement, config, 'en');
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'below-floor');
  assert.match(decision.detail, /floor is 80%/);
});

test('disabled configuration denies even a large context', () => {
  const config = resolveConfig({ enabled: false });
  const measurement = measure({ contextPressure: () => ({ pressureTokens: 900_000, contextWindow: 1_000_000 }) }, {}, config);
  assert.equal(evaluate(measurement, config, 'en').reason, 'disabled');
});

test('nudge bands open at the configured start and grow by one step', () => {
  const config = resolveConfig({ nudgeStartPct: 0.4, nudgeStepPct: 0.1 });
  const at = (pct) => nudgeBand({ pct }, config);
  assert.equal(at(0.39), -1);
  assert.equal(at(0.4), 0);
  assert.equal(at(0.49), 0);
  assert.equal(at(0.51), 1);
  assert.equal(at(0.72), 3);
});

test('handoff rendering keeps required sections and the continuation repeats them verbatim', () => {
  const { handoff, missing } = normalizeHandoff({
    node: 'MR up',
    next_step: 'review the diff for the compaction seam',
    standing_orders: 'never force-push\nanswer in Chinese',
    pending: 'subagent report for the token-meter audit',
    objective: 'port self-compact to dsh',
  });
  assert.deepEqual(missing, []);
  const body = renderHandoff(handoff, { sessionId: 's1', now: '2026-11-17T00:00:00.000Z' });
  assert.match(body, /^# Handoff — MR up/m);
  assert.match(body, /## Standing orders\n\n- never force-push\n- answer in Chinese/);
  const continuation = buildContinuation(handoff, { beforePct: 42, afterPct: 18, file: 'C:/tmp/h.md', dropped: 420_000 });
  assert.match(continuation, /42% -> 18%/);
  assert.match(continuation, /next: review the diff for the compaction seam/);
  assert.match(continuation, /standing orders \(verbatim\):\n- never force-push\n- answer in Chinese/);
  assert.match(continuation, /pending \(verbatim\):\n- subagent report for the token-meter audit/);
});

test('missing required fields are reported instead of scheduling', async () => {
  const { ctx, tools } = fakeHost({ used: 500_000 });
  apply(ctx, { debounceMs: 0 });
  const tool = toolByName(tools, 'compact_now');
  const agent = fakeAgent({ id: 'missing-fields' });
  const reply = await tool.execute({ node: 'only a node' }, { agent, signal: new AbortController().signal });
  assert.match(reply, /missing required field\(s\) next_step/);
});

test('the continuation carries decisions and artifacts verbatim, capped', () => {
  const { handoff } = normalizeHandoff({
    node: 'MR up',
    next_step: 'review',
    decisions: ['keep the stock engine — replacing it costs config mirroring', `long: ${'x'.repeat(600)}`],
    artifacts: Array.from({ length: 20 }, (_, index) => `tools/file-${index}.js`),
    pending: Array.from({ length: 30 }, (_, index) => `p${index}`),
  });
  const continuation = buildContinuation(handoff, { beforePct: 40, afterPct: 12, file: 'h.md', dropped: 1 });
  assert.match(continuation, /decisions \(verbatim\):\n- keep the stock engine/);
  assert.match(continuation, /artifacts \(verbatim\):\n- tools\/file-0\.js/);
  assert.match(continuation, /… 4 more in the handoff file/, 'artifacts capped at 16');
  assert.match(continuation, /… 6 more in the handoff file/, 'pending capped at 24');
  assert.ok(!continuation.includes('x'.repeat(500)), 'a single long item is truncated');
});

test('a gated call is denied with the current percentage and schedules nothing', async () => {
  const { ctx, tools } = fakeHost({ used: 90_000 });
  apply(ctx, { debounceMs: 0, logPath: path.join(os.tmpdir(), 'self-compact-denied.jsonl') });
  const tool = toolByName(tools, 'compact_now');
  const agent = fakeAgent({ id: 'denied' });
  const reply = await tool.execute({ node: 'early', next_step: 'keep going' }, { agent, signal: new AbortController().signal });
  assert.match(reply, /compact_now denied: context is 9\.0%/);
  await settle();
  assert.equal(agent.followups.length, 0);
});

test('an accepted call compacts after the turn and resumes from the handoff', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-compact-'));
  const calls = [];
  const { ctx, tools } = fakeHost({
    used: 520_000,
    compact: async () => {
      calls.push(String(calls.length + 1));
      return { shadowedTokenCount: 410_000 };
    },
  });
  apply(ctx, { debounceMs: 0, retryDelayMs: 0, idlePollMs: 0, handoffDir: dir, logPath: path.join(dir, 'log.jsonl') });
  const tool = toolByName(tools, 'compact_now');
  const agent = fakeAgent({ id: 'accepted' });

  const reply = await tool.execute({
    node: 'tests green',
    next_step: 'open the MR',
    standing_orders: ['no force-push'],
    pending: ['MR link'],
  }, { agent, signal: new AbortController().signal });
  assert.match(reply, /compact_now: scheduled at 52%/);
  assert.equal(agent.status === 'running', true, 'the turn is still running when the call returns');

  agent.status = 'idle';
  await settle();
  assert.equal(calls.length, 1, 'native compactNow ran once');
  assert.equal(agent.followups.length, 1, 'one continuation prompt was submitted');
  const text = agent.followups[0].content[0].text;
  assert.match(text, /next: open the MR/);
  assert.match(text, /standing orders \(verbatim\):\n- no force-push/);
  assert.match(text, /pending \(verbatim\):\n- MR link/);

  const files = fs.readdirSync(dir).filter((entry) => entry.endsWith('.md'));
  assert.equal(files.length, 1, 'one handoff file was written');
  const log = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(log.map((entry) => entry.result), ['queued', 'done', 'continued']);
});

test('a newer user message drops the continuation but still compacts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-compact-user-'));
  const { ctx, tools } = fakeHost({ used: 600_000, compact: async () => ({ shadowedTokenCount: 100 }) });
  apply(ctx, { debounceMs: 0, retryDelayMs: 0, idlePollMs: 0, handoffDir: dir, logPath: path.join(dir, 'log.jsonl') });
  const tool = toolByName(tools, 'compact_now');
  const agent = fakeAgent({
    id: 'user-moved-on',
    events: [{ type: 'user/message', time: Date.now() + 60_000, data: { source: { kind: 'user' } } }],
  });
  await tool.execute({ node: 'node', next_step: 'step' }, { agent, signal: new AbortController().signal });
  agent.status = 'idle';
  await settle();
  assert.equal(agent.followups.length, 0);
});

test('a compaction checkpoint is not mistaken for the user taking over', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-compact-checkpoint-'));
  const { ctx, tools } = fakeHost({ used: 600_000, compact: async () => ({ shadowedTokenCount: 100 }) });
  apply(ctx, { debounceMs: 0, retryDelayMs: 0, idlePollMs: 0, handoffDir: dir, logPath: path.join(dir, 'log.jsonl') });
  const tool = toolByName(tools, 'compact_now');
  const agent = fakeAgent({
    id: 'checkpoint-not-user',
    events: [{ type: 'user/message', time: Date.now() + 60_000, data: { source: { kind: 'compact-checkpoint' } } }],
  });
  await tool.execute({ node: 'node', next_step: 'step' }, { agent, signal: new AbortController().signal });
  agent.status = 'idle';
  await settle();
  assert.equal(agent.followups.length, 1, 'the continuation still resumes work');
});

test('a null compaction result is recorded as skipped, not as a failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-compact-skip-'));
  const { ctx, tools } = fakeHost({ used: 600_000, compact: async () => null });
  apply(ctx, { debounceMs: 0, retryDelayMs: 0, idlePollMs: 0, handoffDir: dir, logPath: path.join(dir, 'log.jsonl') });
  const tool = toolByName(tools, 'compact_now');
  const agent = fakeAgent({ id: 'null-result' });
  await tool.execute({ node: 'node', next_step: 'step' }, { agent, signal: new AbortController().signal });
  agent.status = 'idle';
  await settle();
  const log = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(log.at(-1).result, 'skipped:no-range');
  assert.equal(agent.followups.length, 0);
});

test('a failing compaction is retried and then recorded as failed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-compact-fail-'));
  let attempts = 0;
  const { ctx, tools } = fakeHost({
    used: 600_000,
    compact: async () => {
      attempts += 1;
      const error = new Error('agent is busy');
      error.code = 'busy';
      throw error;
    },
  });
  apply(ctx, { debounceMs: 0, retryDelayMs: 0, idlePollMs: 0, maxRetries: 1, handoffDir: dir, logPath: path.join(dir, 'log.jsonl') });
  const tool = toolByName(tools, 'compact_now');
  const agent = fakeAgent({ id: 'failing' });
  await tool.execute({ node: 'node', next_step: 'step' }, { agent, signal: new AbortController().signal });
  agent.status = 'idle';
  await settle(80);
  assert.equal(attempts, 2, 'one attempt plus one retry');
  const log = fs.readFileSync(path.join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(log.at(-1).result, 'failed:busy');
});

test('a post-compaction reread of the handoff is counted and reported as a rate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-compact-reread-'));
  const logPath = path.join(dir, 'log.jsonl');
  const { ctx, tools, listeners } = fakeHost({ used: 600_000, compact: async () => ({ shadowedTokenCount: 100 }) });
  apply(ctx, { debounceMs: 0, retryDelayMs: 0, idlePollMs: 0, rereadWindowMs: 60_000, handoffDir: dir, logPath });
  const tool = toolByName(tools, 'compact_now');
  const agent = fakeAgent({ id: 'reread' });
  await tool.execute({ node: 'node', next_step: 'step' }, { agent, signal: new AbortController().signal });
  agent.status = 'idle';
  await settle();

  const onResult = listeners.find((entry) => entry.event === 'tools/result');
  assert.ok(onResult, 'tools/result listener registered');
  const handoff = fs.readdirSync(dir).find((entry) => entry.endsWith('.md'));
  assert.ok(handoff);
  onResult.handler({ agent, name: 'read', parsedArguments: { file_path: 'src/unrelated.js' } });
  onResult.handler({ agent, name: 'read', parsedArguments: { file_path: path.join(dir, handoff) } });

  // A second request finalizes the previous window and reports the rate.
  await tool.execute({ node: 'second', next_step: 'step' }, { agent, signal: new AbortController().signal });
  const log = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const reread = log.find((entry) => entry.result === 'reread');
  assert.equal(reread?.tool, 'read');
  const rate = log.find((entry) => entry.result === 'reread-rate');
  assert.equal(rate?.calls, 2);
  assert.equal(rate?.rereads, 1);
});

test('a preset-scoped engine is used when the root has none', async () => {
  // dsh-tui disables the root compaction row and lets each agent preset carry
  // its own engine, so the plugin must read `agent.ctx.compaction`.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-compact-preset-'));
  let calls = 0;
  const { ctx, tools } = fakeHost({ used: 520_000, rootEngine: false });
  apply(ctx, { debounceMs: 0, retryDelayMs: 0, idlePollMs: 0, handoffDir: dir, logPath: path.join(dir, 'log.jsonl') });
  const tool = toolByName(tools, 'compact_now');
  const engine = {
    async compactNow() {
      calls += 1;
      return { shadowedTokenCount: 123 };
    },
  };
  const agent = fakeAgent({ id: 'preset-engine', ctx: { compaction: engine } });

  const reply = await tool.execute({ node: 'node', next_step: 'step' }, { agent, signal: new AbortController().signal });
  assert.match(reply, /compact_now: scheduled/);
  agent.status = 'idle';
  await settle();
  assert.equal(calls, 1);
  assert.equal(agent.followups.length, 1);
});

test('the inject guard on service properties does not block engine resolution', async () => {
  // cordis throws `cannot get property "compaction" without inject` on property
  // access from a context that did not declare it; `ctx.get()` is not gated.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-compact-guard-'));
  const tools = [];
  const engine = { async compactNow() { return { shadowedTokenCount: 7 }; } };
  const guarded = {
    get(name) {
      if (name === 'compaction') return engine;
      throw new Error(`no service ${name}`);
    },
    get compaction() {
      throw new Error('cannot get property "compaction" without inject');
    },
  };
  const ctx = {
    logger: { info() {}, warn() {} },
    effect: (fn) => { fn(); return () => {}; },
    tools: { register(tool) { tools.push(tool); return () => {}; } },
    tokenMeter: { contextPressure: () => ({ pressureTokens: 520_000, contextWindow: 1_000_000 }) },
    get compaction() {
      throw new Error('cannot get property "compaction" without inject');
    },
    on() { return () => {}; },
  };
  apply(ctx, { debounceMs: 0, retryDelayMs: 0, idlePollMs: 0, handoffDir: dir, logPath: path.join(dir, 'log.jsonl') });
  const tool = toolByName(tools, 'compact_now');
  const agent = fakeAgent({ id: 'guarded', ctx: guarded });
  const reply = await tool.execute({ node: 'node', next_step: 'step' }, { agent, signal: new AbortController().signal });
  assert.match(reply, /compact_now: scheduled/, 'the engine is found through ctx.get even though the property throws');
});

test('the engine is read from the agent preset group through the registry', async () => {
  // Preset rows mount into an isolated entry group: neither the root nor the
  // agent context can see `compaction`; `agentPresets.serviceFor` is the way in.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-compact-presetgroup-'));
  const tools = [];
  let calls = 0;
  const engine = { async compactNow() { calls += 1; return { shadowedTokenCount: 42 }; } };
  const registry = {
    serviceFor(agent, name) {
      return name === 'compaction' ? engine : undefined;
    },
  };
  const ctx = {
    logger: { info() {}, warn() {} },
    effect: (fn) => { fn(); return () => {}; },
    tools: { register(tool) { tools.push(tool); return () => {}; } },
    tokenMeter: { contextPressure: () => ({ pressureTokens: 520_000, contextWindow: 1_000_000 }) },
    get(name) {
      if (name === 'agentPresets') return registry;
      throw new Error(`no service ${name}`);
    },
    on() { return () => {}; },
  };
  apply(ctx, { debounceMs: 0, retryDelayMs: 0, idlePollMs: 0, handoffDir: dir, logPath: path.join(dir, 'log.jsonl') });
  const tool = toolByName(tools, 'compact_now');
  const agent = fakeAgent({ id: 'preset-group', ctx: { get() { throw new Error('no service compaction'); } } });
  const reply = await tool.execute({ node: 'node', next_step: 'step' }, { agent, signal: new AbortController().signal });
  assert.match(reply, /compact_now: scheduled/);
  agent.status = 'idle';
  await settle();
  assert.equal(calls, 1, 'the preset-group engine ran');
});

test('a session without any engine is denied with a named reason', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'self-compact-noengine-'));
  const { ctx, tools } = fakeHost({ used: 520_000, rootEngine: false });
  apply(ctx, { debounceMs: 0, handoffDir: dir, logPath: path.join(dir, 'log.jsonl') });
  const tool = toolByName(tools, 'compact_now');
  const agent = fakeAgent({ id: 'no-engine' });
  const reply = await tool.execute({ node: 'node', next_step: 'step' }, { agent, signal: new AbortController().signal });
  assert.match(reply, /no compaction engine/);
  await settle();
  assert.equal(agent.followups.length, 0);
});

test('the pre-step nudge fires once per band and never below the start', async () => {
  const { ctx, listeners } = fakeHost({ used: 300_000 });
  apply(ctx, { debounceMs: 0, nudgeStartPct: 0.4, nudgeStepPct: 0.1, logPath: path.join(os.tmpdir(), 'self-compact-nudge.jsonl') });
  const preStep = listeners.find((entry) => entry.event === 'agent/pre-step');
  assert.ok(preStep, 'pre-step listener registered');
  const agent = fakeAgent({ id: 'nudge' });
  const call = () => preStep.handler({ agent, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'continue', messages: [] }));

  const low = await call();
  assert.equal(low.messages.length, 0, '30% is below the 40% nudge start');

  const { ctx: highCtx, listeners: highListeners } = fakeHost({ used: 460_000 });
  apply(highCtx, { debounceMs: 0, nudgeStartPct: 0.4, nudgeStepPct: 0.1 });
  const highPreStep = highListeners.find((entry) => entry.event === 'agent/pre-step');
  const highAgent = fakeAgent({ id: 'nudge-high' });
  const highCall = () => highPreStep.handler({ agent: highAgent, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'continue', messages: [] }));

  const first = await highCall();
  assert.equal(first.messages.length, 1, '46% is inside the first nudge band');
  assert.match(first.messages[0].content[0].text, /^\[self-compact\] Context is at 46%/);
  const second = await highCall();
  assert.equal(second.messages.length, 0, 'the same band does not nudge twice');
});
