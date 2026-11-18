/**
 * Size gate: break-even tiers from the learned post-compact size P.
 *
 * Prices are relative to a cache-miss input token. With cache reads at r,
 * output at o, a summary of S tokens and a context of C tokens, one
 * compaction costs `o*S` (the summary) + `r*C` (the summarizer replays the
 * cached prefix) + `(1-r)*P` (the next request re-caches the new prefix).
 * Not compacting costs `r*(C-P)` more on every later call. Compacting pays
 * back within N calls when C >= (F/r + N*P) / (N-1), F = o*S + (1-r)*P.
 *
 * @module dsh-self-compact/gate
 */

const K = 1000;
/** A compaction must free at least this much, so no tier sits at the post-compact size. */
export const MIN_GAIN = 25 * K;
/** Fallback session head when nothing was measured yet. */
export const DEFAULT_BASELINE = 65 * K;
const URGENT_MAX_FRACTION = 0.8;

/**
 * Prompt size the next request would carry, and the window.
 *
 * `contextPressure().pressureTokens` is the last provider sample and cannot
 * see a compaction until the model replies again; `measure()` replays the
 * durable tail and reprices the current surface, so it is preferred.
 * @param {object} tokenMeter - host token meter.
 * @param {unknown} session - live session.
 * @returns {{used: number, window: number, pct: number}} measurement.
 * @throws {Error} when the meter returns no usable window.
 */
export function measure(tokenMeter, session) {
  const pressure = tokenMeter.contextPressure(session);
  const window = Number(pressure?.contextWindow ?? 0);
  if (!Number.isFinite(window) || window <= 0) {
    throw new Error('dsh-self-compact: the routed model did not report a context window');
  }
  const sampled = Number(pressure?.pressureTokens ?? 0);
  let used = sampled;
  if (typeof tokenMeter.measure === 'function') {
    try {
      const exact = Number(tokenMeter.measure(session)?.totalTokens);
      if (Number.isFinite(exact) && exact > 0) used = exact;
    } catch {
      // Keep the sample.
    }
  }
  return { used, window, pct: used / window };
}

/**
 * Context size at which one compaction pays back within n calls.
 * @param {number} n - calls after the compaction.
 * @param {number} p - post-compact size in tokens.
 * @param {object} config - resolved configuration.
 * @returns {number} tokens.
 */
export function breakEven(n, p, config) {
  const r = config.cacheReadRatio;
  const fixed = config.outputRatio * config.summaryK * K + (1 - r) * p;
  return (fixed / r + n * p) / (n - 1);
}

/**
 * Tier sizes in tokens: each capped at urgent, then raised to p + MIN_GAIN.
 * @param {number} p - post-compact size in tokens.
 * @param {number} window - context window in tokens.
 * @param {object} config - resolved configuration.
 * @returns {{p: number, window: number, floor: number, node: number, work: number, urgent: number, heavy: boolean}} tiers.
 */
export function thresholds(p, window, config) {
  const c = (n) => breakEven(n, p, config);
  const urgentRaw = Math.min(config.urgentK * K, URGENT_MAX_FRACTION * window);
  const tier = (v) => Math.round(Math.max(Math.min(v, urgentRaw), p + MIN_GAIN));
  return {
    p,
    window,
    floor: tier(Math.max(c(config.floorCalls), config.floorPct * window)),
    node: tier(c(config.nodeCalls)),
    work: tier(c(config.workCalls)),
    urgent: tier(urgentRaw),
    // The harness itself is so large that compaction barely pays.
    heavy: c(config.workCalls) >= config.urgentK * K,
  };
}

/**
 * Decide whether a compaction request is allowed right now.
 * @param {{used: number, window: number, pct: number}} m - current measurement.
 * @param {ReturnType<typeof thresholds>} t - current tiers.
 * @param {boolean} enabled - configuration switch.
 * @param {string} language - 'en' or 'zh'.
 * @returns {{ok: true} | {ok: false, reason: string, detail: string}} decision.
 */
export function evaluate(m, t, enabled, language = 'en') {
  const percent = (m.pct * 100).toFixed(1);
  if (!enabled) {
    return deny(language, 'disabled', language === 'zh' ? '配置已关闭压缩请求' : 'compaction requests are disabled by configuration', percent);
  }
  if (m.used < t.floor) {
    const floorPercent = ((t.floor / m.window) * 100).toFixed(1);
    const detail = language === 'zh'
      ? `上下文 ${percent}%（${k(m.used)}），低于回本门槛 ${floorPercent}%（${k(t.floor)}，压缩后约剩 ${k(t.p)}）：现在压不划算，继续工作`
      : `context is ${percent}% (${k(m.used)}), below the break-even floor ${floorPercent}% (${k(t.floor)}; compaction leaves ~${k(t.p)}): compacting now does not pay off, keep working`;
    return deny(language, 'below-floor', detail, percent);
  }
  return { ok: true };
}

function deny(language, code, detail, percent) {
  const text = language === 'zh'
    ? `compact_now 未执行：${detail}。当前上下文 ${percent}%。`
    : `compact_now denied: ${detail}. Context is at ${percent}%.`;
  return { ok: false, reason: code, detail: text };
}

/**
 * Nudge from the node tier (never below the floor), again after each further step; urgent at once.
 * @param {number} used - current tokens.
 * @param {number | undefined} last - tokens at the previous nudge.
 * @param {ReturnType<typeof thresholds>} t - current tiers.
 * @param {number} step - tokens between nudges.
 * @returns {'none' | 'soft' | 'urgent'} nudge level.
 */
export function nudgeLevel(used, last, t, step) {
  if (used < Math.max(t.node, t.floor)) return 'none';
  const urgent = used >= t.urgent;
  if (last !== undefined && used < last + step && !(urgent && last < t.urgent)) return 'none';
  return urgent ? 'urgent' : 'soft';
}

const OUTLIER_FRACTION = 0.5;
const OUTLIER_RESET = 3;
const MIN_TRUSTED = 3;

/**
 * Fold one post-compact sample into an estimate: EWMA 0.3, outliers 0.1, three same-side outliers reset.
 * @param {{p: number, n: number, out?: {dir: number, samples: number[]}} | undefined} est - previous estimate.
 * @param {number} sample - measured post-compact tokens.
 * @returns {{p: number, n: number, out?: {dir: number, samples: number[]}}} new estimate.
 */
export function learnP(est, sample) {
  if (!est) return { p: sample, n: 1 };
  const dev = sample - est.p;
  if (Math.abs(dev) <= OUTLIER_FRACTION * est.p) return { p: Math.round(est.p + 0.3 * dev), n: est.n + 1 };
  const dir = dev > 0 ? 1 : -1;
  const samples = est.out?.dir === dir ? [...est.out.samples, sample] : [sample];
  if (samples.length >= OUTLIER_RESET) {
    return { p: Math.round(samples.reduce((a, b) => a + b, 0) / samples.length), n: samples.length };
  }
  return { p: Math.round(est.p + 0.1 * dev), n: est.n + 1, out: { dir, samples } };
}

/**
 * Post-compact size to plan with: this session's sample, the project's, the global, else baseline + MIN_GAIN.
 * @param {{byProject: Record<string, {p: number, n: number}>, global?: {p: number, n: number}}} profile - learned profile.
 * @param {string} project - project key (cwd).
 * @param {number | undefined} sessionSample - this session's latest sample.
 * @param {number | undefined} baseline - this session's first measured size.
 * @returns {number} tokens.
 */
export function pickP(profile, project, sessionSample, baseline) {
  if (sessionSample !== undefined) return sessionSample;
  const proj = profile?.byProject?.[project];
  if (proj && proj.n >= MIN_TRUSTED) return proj.p;
  if (profile?.global && profile.global.n >= MIN_TRUSTED) return profile.global.p;
  return (baseline ?? DEFAULT_BASELINE) + MIN_GAIN;
}

/**
 * Tokens as "123k".
 * @param {number} n - tokens.
 * @returns {string} rounded label.
 */
export function k(n) {
  return `${Math.round(n / K)}k`;
}
