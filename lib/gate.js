/**
 * Size gate for one compaction request.
 *
 * A compaction rewrites the cached prefix, so it only pays when enough calls
 * follow at the smaller size. The gate therefore enforces two conditions:
 * a fraction of the window (so the plugin never fires absurdly early) and a
 * minimum absolute saving over the estimated post-compact size (so a small
 * window still gets a worthwhile reduction).
 *
 * @module dsh-self-compact/gate
 */

const K = 1000;

/**
 * @typedef {object} Measurement
 * @property {number} used - prompt tokens the next request would carry.
 * @property {number} window - context window advertised for the routed model.
 * @property {number} baseline - estimated post-compact floor (system head + original prompt).
 * @property {number} postCompact - estimated tokens left after compacting.
 * @property {number} saving - estimated tokens saved per later request.
 * @property {number} pct - used fraction of the window.
 */

/**
 * Read the current pressure and window for one session.
 * @param {{contextPressure(session: unknown): {pressureTokens?: number, contextWindow?: number}, measure?(session: unknown): {totalTokens?: number}}} tokenMeter - host token meter.
 * @param {unknown} session - live session.
 * @returns {Measurement} current measurement with the post-compact estimate.
 * @throws {Error} when the meter returns no usable window.
 */
export function measure(tokenMeter, session, config) {
  const pressure = tokenMeter.contextPressure(session);
  const window = Number(pressure?.contextWindow ?? 0);
  if (!Number.isFinite(window) || window <= 0) {
    throw new Error('dsh-self-compact: the routed model did not report a context window');
  }
  const used = promptTokens(tokenMeter, session, pressure);
  const baseline = Math.min(config.baselineK * K, Math.round(window * 0.2));
  const postCompact = baseline + config.retainK * K;
  return {
    used,
    window,
    baseline,
    postCompact,
    saving: Math.max(0, used - postCompact),
    pct: used / window,
  };
}

/**
 * Prompt size the next request would carry.
 *
 * `contextPressure().pressureTokens` is the last provider sample, and nothing
 * but a request reports usage, so it keeps answering the pre-compaction size
 * until the model replies again — right after a compaction it overstates the
 * context by the whole shadowed region. `measure()` replays the durable tail
 * and reprices the current surface, which is exactly the next request's
 * prompt, so prefer it and keep the sample only as a fallback.
 * @param {{contextPressure(session: unknown): {pressureTokens?: number}, measure?(session: unknown): {totalTokens?: number}}} tokenMeter - host token meter.
 * @param {unknown} session - live session.
 * @param {{pressureTokens?: number}} pressure - the sampled snapshot.
 * @returns {number} prompt tokens, never negative.
 */
function promptTokens(tokenMeter, session, pressure) {
  const sampled = Number(pressure?.pressureTokens ?? 0);
  if (typeof tokenMeter.measure !== 'function') return sampled;
  try {
    const exact = Number(tokenMeter.measure(session)?.totalTokens);
    return Number.isFinite(exact) && exact > 0 ? exact : sampled;
  } catch {
    return sampled;
  }
}

/**
 * Decide whether a compaction request is allowed right now.
 * @param {Measurement} measurement - gate input from {@link measure}.
 * @param {object} config - resolved configuration.
 * @param {string} language - 'en' or 'zh' for the denial text.
 * @returns {{ok: true} | {ok: false, reason: string, detail: string}} decision.
 */
export function evaluate(measurement, config, language = 'en') {
  const { used, pct, saving } = measurement;
  const floorTokens = Math.max(
    config.floorPct * measurement.window,
    measurement.baseline + config.retainK * K + config.minSavingK * K,
  );
  const percent = (pct * 100).toFixed(1);
  const floorPercent = ((floorTokens / measurement.window) * 100).toFixed(0);

  if (!config.enabled) {
    return deny(language, 'disabled', 'compaction requests are disabled by configuration', percent);
  }
  if (used < floorTokens) {
    return deny(
      language,
      'below-floor',
      `context is ${percent}% (${Math.round(used)} tokens); the floor is ${floorPercent}% (${Math.round(floorTokens)} tokens, which also guarantees a ~${config.minSavingK}k saving)`,
      percent,
    );
  }
  return { ok: true };
}

/**
 * Render one denial in the configured language.
 * @param {string} language - 'en' or 'zh'.
 * @param {string} code - stable denial code for logs.
 * @param {string} detail - human explanation.
 * @param {string} percent - current context percentage.
 * @returns {{ok: false, reason: string, detail: string}} denial.
 */
function deny(language, code, detail, percent) {
  const text = language === 'zh'
    ? `compact_now 未执行：${detail}。当前上下文 ${percent}%。`
    : `compact_now denied: ${detail}. Context is at ${percent}%.`;
  return { ok: false, reason: code, detail: text };
}

/**
 * Nudge band for the current context size.
 * @param {Measurement} measurement - current measurement.
 * @param {object} config - resolved configuration.
 * @returns {number} -1 when no nudge is due, otherwise a monotonically increasing band.
 */
export function nudgeBand(measurement, config) {
  if (measurement.pct < config.nudgeStartPct) return -1;
  return Math.floor((measurement.pct - config.nudgeStartPct) / config.nudgeStepPct);
}
