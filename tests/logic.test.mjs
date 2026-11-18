/**
 * Offline logic tests for dsh-self-compact.
 *
 * The host packages are stubbed by tests/loader.mjs, so this runs on any Node
 * 22+ without installing DeepSeek Harness:
 *
 *   node --import ./tests/register.mjs --test tests/logic.test.mjs
 *
 * @module dsh-self-compact/tests
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { apply, isSubagent } from '../lib/index.js';
import { breakEven, evaluate, learnP, measure, nudgeLevel, pickP, thresholds } from '../lib/gate.js';
import { buildContinuation, chatClass, langLine, mergeLanguage, normalizeHandoff, parseSkipReason, renderHandoff } from '../lib/handoff.js';
import { resolveConfig } from '../lib/config.js';
import { detectNode, tierSkills, touchedPaths } from '../lib/triggers.js';
import { loadProfile } from '../lib/profile.js';

const CFG = resolveConfig({});
const FAST = { debounceMs: 0, retryDelayMs: 0, idlePollMs: 0, maxRetries: 1 };

/** Fresh state dir per test, so no test touches ~/.dsh. */
function tmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `self-compact-${label}-`));
}

function readLog(dir) {
  const file = path.join(dir, 'log.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

/**
 * Fake host with only the seams this plugin touches. `host.used` is live, so
 * a compaction callback can shrink it.
 */
function fakeHost(options = {}) {
  const tools = [];
  const listeners = [];
  const host = { used: options.used ?? 0, window: options.window ?? 1_000_000, tools, listeners };
  const services = options.services ?? {};
  host.ctx = {
    logger: { info() {}, warn() {} },
    effect(fn) {
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    tools: { register(tool) { tools.push(tool); return () => {}; } },
    tokenMeter: {
      contextPressure: () => ({ pressureTokens: host.used, contextWindow: host.window }),
      measure: () => ({ totalTokens: host.used }),
    },
    get(name) {
      if (name in services) return services[name];
      return undefined;
    },
    ...(options.rootEngine === false ? {} : { compaction: { compactNow: options.compact ?? (async () => null) } }),
    on(event, handler, opts) {
      listeners.push({ event, handler, opts });
      return () => {};
    },
  };
  host.listener = (event) => listeners.find((entry) => entry.event === event).handler;
  host.tool = () => tools.find((tool) => tool.name === 'compact_now');
  return host;
}

function fakeAgent(options) {
  const agent = {
    id: options.id,
    status: options.status ?? 'running',
    followups: [],
    ctx: options.ctx,
    session: {
      id: options.id,
      header: options.header ?? { cwd: options.cwd ?? 'D:/proj' },
      snapshotEvents: () => options.events ?? [],
    },
    followup(message) {
      agent.followups.push(message);
    },
  };
  return agent;
}

const settle = (ms = 30) => new Promise((resolve) => { setTimeout(resolve, ms); });
const userEvent = (text, time = 0) => ({ type: 'user/message', time, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } });
const assistantEvent = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
const execOf = (agent) => ({ agent, signal: new AbortController().signal });

async function preStep(host, agent, step, messages = []) {
  return host.listener('agent/pre-step')({ agent, step, turn: 1, messages, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages: [] }));
}

const lastText = (decision) => decision.messages.at(-1)?.content[0].text ?? '';

// ---- gate ----

test('break-even tiers follow the formula and P', () => {
  const t = thresholds(90_000, 1_000_000, CFG);
  // F = 1.5*10k + 0.9*90k = 96k; C(N) = (960k + N*90k) / (N-1).
  assert.equal(Math.round(breakEven(20, 90_000, CFG)), 145263);
  assert.equal(t.floor, 145263);
  assert.equal(t.node, 206667);
  assert.equal(t.work, 240000);
  assert.equal(t.urgent, 350000);
  assert.equal(t.heavy, false);
  const smaller = thresholds(60_000, 1_000_000, CFG);
  assert.ok(smaller.floor < t.floor, 'a smaller post-compact size lowers the floor');
});

test('a small window caps every tier at 80% and keeps a 25k gain', () => {
  const t = thresholds(90_000, 128_000, CFG);
  assert.equal(t.urgent, 115_000, 'raised from 102.4k to P + 25k');
  assert.equal(t.floor, 115_000);
  assert.equal(t.node, 115_000);
});

test('the gate denies below the floor, passes above, and honours enabled', () => {
  const t = thresholds(90_000, 1_000_000, CFG);
  const low = evaluate({ used: 120_000, window: 1_000_000, pct: 0.12 }, t, true, 'en');
  assert.equal(low.ok, false);
  assert.equal(low.reason, 'below-floor');
  assert.match(low.detail, /12\.0%/);
  assert.match(low.detail, /break-even floor 14\.5%/);
  assert.deepEqual(evaluate({ used: 150_000, window: 1_000_000, pct: 0.15 }, t, true, 'en'), { ok: true });
  assert.equal(evaluate({ used: 900_000, window: 1_000_000, pct: 0.9 }, t, false, 'en').reason, 'disabled');
});

test('the exact measurement outranks the stale sample, and the sample is the fallback', () => {
  const meter = { contextPressure: () => ({ pressureTokens: 303_035, contextWindow: 1_000_000 }), measure: () => ({ totalTokens: 34_120 }) };
  assert.equal(measure(meter, {}).used, 34_120);
  const failing = { ...meter, measure: () => { throw new Error('inactive context'); } };
  assert.equal(measure(failing, {}).used, 303_035);
  assert.equal(measure({ ...meter, measure: () => ({ totalTokens: 0 }) }, {}).used, 303_035);
});

test('nudges open at the node tier, repeat per step and escalate at urgent', () => {
  const t = thresholds(90_000, 1_000_000, CFG);
  const step = 50_000;
  assert.equal(nudgeLevel(200_000, undefined, t, step), 'none');
  assert.equal(nudgeLevel(210_000, undefined, t, step), 'soft');
  assert.equal(nudgeLevel(240_000, 210_000, t, step), 'none');
  assert.equal(nudgeLevel(262_000, 210_000, t, step), 'soft');
  assert.equal(nudgeLevel(351_000, 340_000, t, step), 'urgent', 'crossing urgent escalates at once');
});

test('P learning: EWMA, damped outliers, reset after three, and the fallback order', () => {
  let est = learnP(undefined, 60_000);
  est = learnP(est, 70_000);
  assert.equal(est.p, 63_000);
  est = learnP(est, 200_000);
  assert.equal(est.out.samples.length, 1);
  est = learnP(est, 210_000);
  est = learnP(est, 190_000);
  assert.equal(est.p, 200_000, 'three same-side outliers reset to their mean');
  const profile = { byProject: { a: { p: 50_000, n: 3 } }, global: { p: 70_000, n: 5 } };
  assert.equal(pickP(profile, 'a', 40_000), 40_000);
  assert.equal(pickP(profile, 'a'), 50_000);
  assert.equal(pickP(profile, 'b'), 70_000);
  assert.equal(pickP({ byProject: {} }, 'b', undefined, 30_000), 55_000);
  assert.equal(pickP({ byProject: {} }, 'b'), 90_000);
});

test('configuration rejects a call count that would divide by zero', () => {
  assert.throws(() => resolveConfig({ floorCalls: 1 }), /at least 2/);
  assert.throws(() => resolveConfig({ cacheReadRatio: 0 }), /greater than 0/);
});

// ---- handoff ----

test('handoff rendering and continuation carry the sections verbatim', () => {
  const { handoff, missing } = normalizeHandoff({
    node: 'MR up',
    next_step: 'review the diff',
    standing_orders: 'never force-push\nanswer in Chinese',
    pending: 'subagent report',
    objective: 'port self-compact',
  });
  assert.deepEqual(missing, []);
  const body = renderHandoff(handoff, { sessionId: 's1', now: 'now', intent: 'build it', recent: ['latest ask'] });
  assert.match(body, /^# Handoff: MR up/m);
  assert.match(body, /## Standing orders \(user's words\)\n\n- never force-push\n- answer in Chinese/);
  assert.match(body, /## Original request\n\n```\nbuild it\n```/);
  assert.match(body, /## Recent user messages/);
  const continuation = buildContinuation(handoff, { beforePct: 42, afterPct: 18, file: 'C:/tmp/h.md', dropped: 420_000 });
  assert.match(continuation, /42% -> 18%/);
  assert.match(continuation, /next: review the diff/);
  assert.match(continuation, /standing orders \(verbatim\):\n- never force-push\n- answer in Chinese/);
  assert.match(continuation, /pending \(verbatim\):\n- subagent report/);
  assert.match(continuation, /session_event_search/);
});

test('the opening request is skipped while it is still a recent message', () => {
  const { handoff } = normalizeHandoff({ node: 'n', next_step: 's' });
  const body = renderHandoff(handoff, { sessionId: 's', now: 'now', intent: 'same', recent: ['same'] });
  assert.ok(!body.includes('## Original request'));
});

test('the continuation caps decisions, artifacts and pending', () => {
  const { handoff } = normalizeHandoff({
    node: 'MR up',
    next_step: 'review',
    decisions: ['keep the stock engine', `long: ${'x'.repeat(600)}`],
    artifacts: Array.from({ length: 20 }, (_, i) => `tools/file-${i}.js`),
    pending: Array.from({ length: 30 }, (_, i) => `p${i}`),
  });
  const continuation = buildContinuation(handoff, { beforePct: 40, afterPct: 12, file: 'h.md', dropped: 1 });
  assert.match(continuation, /decisions \(verbatim\):\n- keep the stock engine/);
  assert.match(continuation, /… 4 more in the handoff file/);
  assert.match(continuation, /… 6 more in the handoff file/);
  assert.ok(!continuation.includes('x'.repeat(500)));
});

test('language rules: given wins, then inherited, then detected; the line leads the continuation', () => {
  const prev = { chat: 'Chinese, English terms OK', outputs: ['code in English'] };
  assert.equal(mergeLanguage(prev, { chat: 'English', outputs: [] }, 'zh', 'en').source, 'tool');
  const inherited = mergeLanguage(prev, undefined, 'en', 'en');
  assert.equal(inherited.source, 'inherited');
  assert.deepEqual(inherited.outputs, ['code in English']);
  assert.deepEqual(mergeLanguage(undefined, undefined, 'zh', 'zh'), { chat: '中文', outputs: [], source: 'detected' });
  assert.equal(chatClass('中文为主，术语英文'), 'zh');
  assert.equal(chatClass('English; Chinese quotes ok'), 'en');
  const { handoff } = normalizeHandoff({ node: 'n', next_step: 's', language: { chat: 'Chinese', outputs: ['commits in English'] } });
  const text = buildContinuation(handoff, { beforePct: 1, afterPct: 1, file: 'f', dropped: 0 });
  assert.equal(text.split('\n')[0], langLine(handoff.language, 'en'));
  assert.equal(text.split('\n')[0], 'Chat: Chinese | commits in English');
  const fromString = normalizeHandoff({ node: 'n', next_step: 's', language: '{"chat":"English","outputs":[]}' }).handoff;
  assert.equal(fromString.language.chat, 'English');
  assert.equal(normalizeHandoff({ node: 'n', next_step: 's', language: 42 }).handoff.language, undefined, 'malformed never blocks');
});

test('skip reasons parse from the self-check answer', () => {
  assert.equal(parseSkipReason('skip: still debugging'), 'still debugging');
  assert.equal(parseSkipReason('skip：等用户回复'), '等用户回复');
  assert.equal(parseSkipReason('skip'), undefined);
  assert.equal(parseSkipReason('done, compacting'), undefined);
});

// ---- triggers ----

test('node detection maps dsh tools to strong and weak signals', () => {
  assert.deepEqual(detectNode('bash', { command: 'git push origin main' }), { kind: 'push', strength: 'strong' });
  assert.deepEqual(detectNode('pwsh', { command: 'gh pr create --fill' }), { kind: 'pr', strength: 'strong' });
  assert.deepEqual(detectNode('bash', { command: 'git commit -m x' }), { kind: 'commit', strength: 'weak' });
  assert.deepEqual(detectNode('bash', { command: 'npm test' }), { kind: 'tests', strength: 'weak' });
  assert.equal(detectNode('bash', { command: 'npm test' }, { isError: true }), undefined, 'a failed call is no node');
  assert.deepEqual(detectNode('write', { file_path: 'D:\\repo\\docs\\plans\\x.md' }), { kind: 'spec-plan', strength: 'strong' });
  assert.deepEqual(detectNode('apply_patch', { input: '*** Begin Patch\n*** Add File: specs/a.md\n' }), { kind: 'spec-plan', strength: 'strong' });
  assert.deepEqual(detectNode('write', { file_path: 'notes/readme.md' }), { kind: 'doc-written', strength: 'weak' });
  assert.equal(detectNode('edit', { file_path: 'notes/readme.md' }), undefined);
  assert.deepEqual(detectNode('todo_write', { todos: [{ content: 'a', status: 'completed' }] }), { kind: 'todos-done', strength: 'strong' });
  assert.equal(detectNode('todo_write', { todos: [{ content: 'a', status: 'in_progress' }] }), undefined);
  assert.deepEqual(detectNode('subagent', { prompt: 'x' }), { kind: 'agent-done', strength: 'weak' });
});

test('touched paths come from file tools and path-like shell tokens', () => {
  assert.deepEqual(touchedPaths('read', { file_path: 'a/b.md' }), [{ path: 'a/b.md', file: true }]);
  assert.deepEqual(touchedPaths('grep', { pattern: 'x', path: 'skills/a' }), [{ path: 'skills/a', file: false }]);
  const shell = touchedPaths('bash', { command: 'cat ~/.dsh/skills/x/ref.md:12 | head' });
  assert.deepEqual(shell, [{ path: '~/.dsh/skills/x/ref.md', file: true }]);
});

test('skill tiers: keep wins, drop marks done, recent use or a high miss rate is hot', () => {
  const skills = [
    { name: 'a', lastUse: 100 },
    { name: 'b', lastUse: 10 },
    { name: 'c', lastUse: 10 },
    { name: 'plug:d', lastUse: 100 },
  ];
  const { hot, done } = tierSkills(skills, {
    keep: ['b'],
    drop: ['d'],
    now: 105,
    priors: { c: { compactions: 4, refMisses: 2 } },
    hotWindow: 20,
  });
  assert.deepEqual(hot.map((s) => s.name), ['a', 'b', 'c']);
  assert.deepEqual(done.map((s) => s.name), ['plug:d']);
});

test('subagents are recognised from the session header', () => {
  assert.equal(isSubagent({ session: { header: { origin: 'subagent' } } }), true);
  assert.equal(isSubagent({ session: { header: { delegationDepth: 1 } } }), true);
  assert.equal(isSubagent({ session: { header: {} } }), false);
});

// ---- integration ----

test('missing required fields are reported instead of scheduling', async () => {
  const host = fakeHost({ used: 500_000 });
  apply(host.ctx, { ...FAST, dataDir: tmp('missing') });
  const reply = await host.tool().execute({ node: 'only a node' }, execOf(fakeAgent({ id: 'missing-fields' })));
  assert.match(reply, /missing required field\(s\) next_step/);
});

test('a call below the floor is denied and schedules nothing', async () => {
  const dir = tmp('denied');
  const host = fakeHost({ used: 90_000 });
  apply(host.ctx, { ...FAST, dataDir: dir });
  const agent = fakeAgent({ id: 'denied' });
  const reply = await host.tool().execute({ node: 'early', next_step: 'keep going' }, execOf(agent));
  assert.match(reply, /compact_now denied: context is 9\.0%/);
  await settle();
  assert.equal(agent.followups.length, 0);
  assert.equal(readLog(dir).at(-1).result, 'denied:below-floor');
});

test('the baseline is the first non-zero early reading, not step 1 alone', async () => {
  // A live host reads 0 on step 1 (no usage sample yet).
  const host = fakeHost({ used: 0 });
  apply(host.ctx, { ...FAST, dataDir: tmp('baseline') });
  const early = fakeAgent({ id: 'baseline-early' });
  await preStep(host, early, 1);
  host.used = 40_000;
  await preStep(host, early, 2);
  assert.match(await host.tool().execute({ node: 'n', next_step: 's' }, execOf(early)), /leaves ~65k/);

  host.used = 0;
  const late = fakeAgent({ id: 'baseline-late' });
  for (let step = 1; step <= 4; step += 1) await preStep(host, late, step);
  host.used = 40_000;
  await preStep(host, late, 5);
  assert.match(await host.tool().execute({ node: 'n', next_step: 's' }, execOf(late)), /leaves ~90k/, 'a late first reading is no baseline');
});

test('an accepted call compacts at idle, learns P and resumes from the handoff', async () => {
  const dir = tmp('accepted');
  let calls = 0;
  const host = fakeHost({
    used: 520_000,
    compact: async () => {
      calls += 1;
      host.used = 61_000;
      return { shadowedTokenCount: 459_000 };
    },
  });
  apply(host.ctx, { ...FAST, dataDir: dir });
  const events = [userEvent('port the plugin'), ...Array.from({ length: 5 }, (_, i) => userEvent(`follow-up ${i}`))];
  const agent = fakeAgent({ id: 'accepted', events });
  const reply = await host.tool().execute({
    node: 'tests green',
    next_step: 'open the MR',
    standing_orders: ['no force-push'],
    pending: ['MR link'],
    language: { chat: 'Chinese', outputs: ['commits in English'] },
  }, execOf(agent));
  assert.match(reply, /compact_now: scheduled at 52%/);

  agent.status = 'idle';
  host.listener('agent/status')({ status: 'idle', agent });
  await settle();
  assert.equal(calls, 1);
  assert.equal(agent.followups.length, 1);
  const text = agent.followups[0].content[0].text;
  assert.equal(text.split('\n')[0], 'Chat: Chinese | commits in English');
  assert.match(text, /next: open the MR/);
  assert.match(text, /standing orders \(verbatim\):\n- no force-push/);

  const handoffs = fs.readdirSync(path.join(dir, 'handoff'));
  assert.equal(handoffs.length, 1);
  const body = fs.readFileSync(path.join(dir, 'handoff', handoffs[0]), 'utf8');
  assert.match(body, /## Language rules\n\n- Chat: Chinese\n- commits in English/);
  assert.match(body, /## Original request\n\n```\nport the plugin\n```/);
  assert.deepEqual(readLog(dir).map((e) => e.result), ['queued', 'done', 'p-sample', 'continued']);
  assert.equal(readLog(dir)[2].pSample, 61_000);
  assert.equal(readLog(dir)[2].p, 61_000, 'p is the project estimate, not the trusted planning value');
  assert.equal(loadProfile(path.join(dir, 'profile.json')).byProject['D:/proj'].p, 61_000);
});

test('a newer user message drops the continuation but still compacts', async () => {
  const dir = tmp('user');
  const host = fakeHost({ used: 600_000, compact: async () => ({ shadowedTokenCount: 100 }) });
  apply(host.ctx, { ...FAST, dataDir: dir });
  const agent = fakeAgent({ id: 'user-moved-on', events: [userEvent('new ask', Date.now() + 60_000)] });
  await host.tool().execute({ node: 'node', next_step: 'step' }, execOf(agent));
  agent.status = 'idle';
  await settle();
  assert.equal(agent.followups.length, 0);
  assert.ok(readLog(dir).some((e) => e.result === 'done'));
});

test('a compaction checkpoint is not mistaken for the user taking over', async () => {
  const host = fakeHost({ used: 600_000, compact: async () => ({ shadowedTokenCount: 100 }) });
  apply(host.ctx, { ...FAST, dataDir: tmp('checkpoint') });
  const agent = fakeAgent({
    id: 'checkpoint-not-user',
    events: [{ type: 'user/message', time: Date.now() + 60_000, data: { source: { kind: 'compact-checkpoint' }, content: [] } }],
  });
  await host.tool().execute({ node: 'node', next_step: 'step' }, execOf(agent));
  agent.status = 'idle';
  await settle();
  assert.equal(agent.followups.length, 1);
});

test('a null compaction result is skipped, a throwing one retried then failed', async () => {
  const skipDir = tmp('skip');
  const skip = fakeHost({ used: 600_000, compact: async () => null });
  apply(skip.ctx, { ...FAST, dataDir: skipDir });
  const a = fakeAgent({ id: 'null-result' });
  await skip.tool().execute({ node: 'node', next_step: 'step' }, execOf(a));
  a.status = 'idle';
  await settle();
  assert.equal(readLog(skipDir).at(-1).result, 'skipped:no-range');

  const failDir = tmp('fail');
  let attempts = 0;
  const fail = fakeHost({
    used: 600_000,
    compact: async () => {
      attempts += 1;
      throw Object.assign(new Error('agent is busy'), { code: 'busy' });
    },
  });
  apply(fail.ctx, { ...FAST, dataDir: failDir });
  const b = fakeAgent({ id: 'failing' });
  await fail.tool().execute({ node: 'node', next_step: 'step' }, execOf(b));
  b.status = 'idle';
  await settle(80);
  assert.equal(attempts, 2);
  assert.equal(readLog(failDir).at(-1).result, 'failed:busy');
});

test('a post-compaction reread of the handoff is counted and reported as a rate', async () => {
  const dir = tmp('reread');
  const host = fakeHost({ used: 600_000, compact: async () => ({ shadowedTokenCount: 100 }) });
  apply(host.ctx, { ...FAST, rereadWindowMs: 60_000, dataDir: dir });
  const agent = fakeAgent({ id: 'reread' });
  await host.tool().execute({ node: 'node', next_step: 'step' }, execOf(agent));
  agent.status = 'idle';
  await settle();
  const handoff = path.join(dir, 'handoff', fs.readdirSync(path.join(dir, 'handoff'))[0]);
  const onResult = host.listener('tools/result');
  onResult({ agent, name: 'read', arguments: { file_path: 'src/unrelated.js' } }, { isError: false });
  onResult({ agent, name: 'read', arguments: { file_path: handoff } }, { isError: false });
  await host.tool().execute({ node: 'second', next_step: 'step' }, execOf(agent));
  const log = readLog(dir);
  assert.equal(log.find((e) => e.result === 'reread')?.tool, 'read');
  const rate = log.find((e) => e.result === 'reread-rate');
  assert.equal(rate?.calls, 2);
  assert.equal(rate?.rereads, 1);
});

test('the engine is found in the preset group, the agent context, or behind the inject guard', async () => {
  const run = async (ctxPatch, agentCtx, id) => {
    const host = fakeHost({ used: 520_000, rootEngine: false });
    Object.assign(host.ctx, ctxPatch);
    apply(host.ctx, { ...FAST, dataDir: tmp(id) });
    const agent = fakeAgent({ id, ctx: agentCtx });
    return host.tool().execute({ node: 'node', next_step: 'step' }, execOf(agent));
  };
  const engine = { async compactNow() { return { shadowedTokenCount: 1 }; } };
  assert.match(await run({ get: (n) => (n === 'agentPresets' ? { serviceFor: () => engine } : undefined) }, { get() { throw new Error('none'); } }, 'preset-group'), /scheduled/);
  assert.match(await run({}, { compaction: engine }, 'agent-ctx'), /scheduled/);
  const guarded = {
    get: (n) => (n === 'compaction' ? engine : undefined),
    get compaction() { throw new Error('cannot get property "compaction" without inject'); },
  };
  assert.match(await run({}, guarded, 'guarded'), /scheduled/);
  assert.match(await run({}, undefined, 'no-engine'), /no compaction engine/);
});

test('subagents are denied and get no nudges', async () => {
  const host = fakeHost({ used: 600_000 });
  apply(host.ctx, { ...FAST, dataDir: tmp('sub') });
  const child = fakeAgent({ id: 'child', header: { origin: 'subagent' } });
  assert.match(await host.tool().execute({ node: 'n', next_step: 's' }, execOf(child)), /only the main session/);
  const decision = await preStep(host, child, 1, [userEvent('x').data]);
  assert.equal(decision.messages.length, 0);
});

test('pre-step: one nudge per step band, block-start hint on a human prompt only', async () => {
  // The first step's 50k becomes the baseline: P = 75k, floor ~126k, node ~183k.
  const host = fakeHost({ used: 50_000 });
  apply(host.ctx, { ...FAST, dataDir: tmp('nudge') });
  const agent = fakeAgent({ id: 'nudge' });
  assert.equal((await preStep(host, agent, 1)).messages.length, 0, 'below the floor: silent');

  host.used = 215_000;
  const human = await preStep(host, agent, 1, [userEvent('next task').data]);
  assert.match(lastText(human), /opens a new block of work/);
  const machine = await preStep(host, agent, 2);
  assert.match(lastText(machine), /past the break-even line/, 'the nudge rides a later step');
  assert.equal((await preStep(host, agent, 3)).messages.length, 0, 'same band does not nudge twice');
});

test('a node signal flags the next step once per turn', async () => {
  const dir = tmp('nodeflag');
  const host = fakeHost({ used: 160_000 });
  apply(host.ctx, { ...FAST, dataDir: dir });
  const agent = fakeAgent({ id: 'nodeflag' });
  await preStep(host, agent, 1);
  host.listener('tools/result')({ agent, name: 'bash', arguments: { command: 'git push' } }, { isError: false });
  host.listener('tools/result')({ agent, name: 'bash', arguments: { command: 'gh pr create' } }, { isError: false });
  const next = await preStep(host, agent, 2);
  assert.match(lastText(next), /The git push just now looks like a node/);
  assert.equal(readLog(dir).filter((e) => e.result === 'node-nudge').length, 1);
});

test('a weak node below the node tier does not flag', async () => {
  const host = fakeHost({ used: 160_000 });
  apply(host.ctx, { ...FAST, dataDir: tmp('weak') });
  const agent = fakeAgent({ id: 'weak' });
  await preStep(host, agent, 1);
  host.listener('tools/result')({ agent, name: 'bash', arguments: { command: 'git commit -m x' } }, { isError: false });
  assert.equal((await preStep(host, agent, 2)).messages.length, 0);
});

test('turn-end self-check fires after a node and logs the skip reason', async () => {
  const dir = tmp('selfcheck');
  const events = [];
  const host = fakeHost({ used: 160_000 });
  apply(host.ctx, { ...FAST, dataDir: dir });
  const agent = fakeAgent({ id: 'selfcheck', events });
  await preStep(host, agent, 1, [userEvent('ship it').data]);
  host.listener('tools/result')({ agent, name: 'bash', arguments: { command: 'git push' } }, { isError: false });
  agent.status = 'idle';
  host.listener('agent/status')({ status: 'idle', agent });
  await settle();
  assert.equal(agent.followups.length, 1);
  assert.match(agent.followups[0].content[0].text, /^\[self-compact self-check\] The last turn showed a node signal \(git push\)/);

  // The check turn: no tool call, the model answers skip.
  agent.status = 'running';
  await preStep(host, agent, 1, []);
  events.push(assistantEvent('skip: waiting for CI'));
  agent.status = 'idle';
  host.listener('agent/status')({ status: 'idle', agent });
  await settle();
  const log = readLog(dir);
  assert.deepEqual(log.filter((e) => e.result.startsWith('self-check')).map((e) => e.result), ['self-check', 'self-check:declined']);
  assert.equal(log.at(-1).reason, 'waiting for CI');
  assert.equal(agent.followups.length, 1, 'no second check without tool activity');
});

test('a declined check is not followed by a size-only check', async () => {
  // Live: a node check declined at 19.6%, then a long-stretch check fired 2 s later.
  const dir = tmp('declined-size');
  const events = [];
  const host = fakeHost({ used: 300_000 });
  apply(host.ctx, { ...FAST, dataDir: dir });
  const agent = fakeAgent({ id: 'declined-size', events });
  await preStep(host, agent, 1, [userEvent('go').data]);
  host.listener('tools/result')({ agent, name: 'todo_write', arguments: { todos: [{ content: 'x', status: 'completed' }] } }, { isError: false });
  agent.status = 'idle';
  host.listener('agent/status')({ status: 'idle', agent });
  await settle();
  assert.equal(agent.followups.length, 1);

  // The check turn: a tool call still lands, then the model declines.
  agent.status = 'running';
  await preStep(host, agent, 1, []);
  host.listener('tools/result')({ agent, name: 'read', arguments: { file_path: 'x' } }, { isError: false });
  events.push(assistantEvent('skip: nothing left'));
  agent.status = 'idle';
  host.listener('agent/status')({ status: 'idle', agent });
  await settle();
  assert.equal(agent.followups.length, 1, 'neither the check turn\'s own call nor the size tier re-asks');
});

test('no self-check in a non-interactive session', async () => {
  const host = fakeHost({ used: 400_000, services: { headlessStartup: { task: 'x' } } });
  apply(host.ctx, { ...FAST, dataDir: tmp('headless') });
  const agent = fakeAgent({ id: 'headless' });
  await preStep(host, agent, 1, [userEvent('go').data]);
  host.listener('tools/result')({ agent, name: 'bash', arguments: { command: 'git push' } }, { isError: false });
  agent.status = 'idle';
  host.listener('agent/status')({ status: 'idle', agent });
  await settle();
  assert.equal(agent.followups.length, 0);
});

test('a queued request goes stale after more than three tool calls', async () => {
  const dir = tmp('stale');
  const host = fakeHost({ used: 600_000 });
  apply(host.ctx, { ...FAST, debounceMs: 300, dataDir: dir });
  const agent = fakeAgent({ id: 'stale' });
  await host.tool().execute({ node: 'n', next_step: 's' }, execOf(agent));
  for (let i = 0; i < 4; i += 1) host.listener('tools/result')({ agent, name: 'read', arguments: { file_path: `f${i}` } }, { isError: false });
  assert.equal(readLog(dir).at(-1).result, 'stale');
  assert.match(lastText(await preStep(host, agent, 2)), /expired/);
});

test('language rules ride the first real user prompts after a compaction', async () => {
  const host = fakeHost({ used: 600_000, compact: async () => { host.used = 50_000; return { shadowedTokenCount: 1 }; } });
  apply(host.ctx, { ...FAST, dataDir: tmp('lang') });
  const agent = fakeAgent({ id: 'lang' });
  await host.tool().execute({ node: 'n', next_step: 's', language: { chat: 'Chinese', outputs: ['code in English'] } }, execOf(agent));
  agent.status = 'idle';
  await settle();
  const texts = [];
  for (let i = 0; i < 4; i += 1) texts.push(lastText(await preStep(host, agent, 1, [userEvent(`q${i}`).data])));
  assert.equal(texts.filter((t) => t.includes('Language rules still apply: Chat: Chinese | code in English')).length, 3);
});

test('the skill working set: refs tracked, inlined after compaction, counted in the profile', async () => {
  const dir = tmp('skills');
  const skillDir = path.join(dir, 'skills', 'briefcase');
  fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# briefcase');
  const ref = path.join(skillDir, 'references', 'rubric.md');
  fs.writeFileSync(ref, 'rubric: +10 / +5 / +2');
  const big = path.join(skillDir, 'references', 'big.md');
  fs.writeFileSync(big, 'x'.repeat(20_000));

  const host = fakeHost({ used: 600_000, compact: async () => { host.used = 50_000; return { shadowedTokenCount: 1 }; } });
  apply(host.ctx, { ...FAST, dataDir: dir });
  const agent = fakeAgent({ id: 'skills', cwd: dir });
  await preStep(host, agent, 1, [userEvent('do the task').data]);
  const onResult = host.listener('tools/result');
  onResult({ agent, name: 'skill', arguments: { name: 'briefcase' } }, { isError: false, value: { resourceBase: { kind: 'directory', path: skillDir } } });
  onResult({ agent, name: 'read', arguments: { file_path: ref } }, { isError: false });
  onResult({ agent, name: 'read', arguments: { file_path: big } }, { isError: false });
  await host.tool().execute({ node: 'n', next_step: 's' }, execOf(agent));
  agent.status = 'idle';
  await settle();
  const text = agent.followups[0].content[0].text;
  assert.match(text, /Skill working set:\n- briefcase: still in use; instructions at .*SKILL\.md/);
  assert.match(text, /rubric: \+10 \/ \+5 \/ \+2/, 'the small ref is inlined');
  assert.match(text, /big\.md \(re-read when needed\)/, 'the large ref is listed');
  const done = readLog(dir).find((e) => e.result === 'done');
  assert.deepEqual(done.skills.hot, ['briefcase']);
  assert.equal(done.skills.listed, 1);
  assert.equal(loadProfile(path.join(dir, 'profile.json')).skills.briefcase.compactions, 1);

  // Reading the listed ref soon after counts as a miss; the inlined one as a reread.
  onResult({ agent, name: 'read', arguments: { file_path: big } }, { isError: false });
  onResult({ agent, name: 'read', arguments: { file_path: ref } }, { isError: false });
  const log = readLog(dir);
  assert.ok(log.some((e) => e.result === 'skill-ref-miss'));
  assert.ok(log.some((e) => e.result === 'skill-ref-reread'));
  assert.equal(loadProfile(path.join(dir, 'profile.json')).skills.briefcase.refMisses, 1);
});
