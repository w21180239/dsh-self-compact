/**
 * Configuration defaults and normalization for dsh-self-compact.
 *
 * The numbers are deliberately later than the Claude-side plugin this ports
 * (floor 10 %, nudge 20 %, urgent 35 % on a 1M window). DeepSeek-class routes
 * bill cache reads at ~0.1x and the whole window is cheap, so the dominant
 * reason to compact here is headroom and attention, not money. See README
 * "Thresholds" for the arithmetic.
 *
 * @module dsh-self-compact/config
 */

/**
 * @typedef {object} SelfCompactConfig
 * @property {boolean} enabled - false denies every request while keeping the tool registered.
 * @property {number} floorPct - hard floor as a fraction of the context window.
 * @property {number} minSavingK - the floor also guarantees this many thousand tokens of saving.
 * @property {number} baselineK - estimated post-compact floor, in thousand tokens.
 * @property {number} retainK - estimated retained tail, in thousand tokens.
 * @property {number} nudgeStartPct - first nudge, as a fraction of the window.
 * @property {number} nudgeStepPct - gap between nudges.
 * @property {number} urgentPct - escalated nudge wording from here.
 * @property {boolean} continuation - submit a continuation prompt after compaction.
 * @property {number} debounceMs - buffer between turn end and compaction.
 * @property {number} retryDelayMs - retry interval.
 * @property {number} maxRetries - retries before giving up.
 * @property {number} idlePollMs - idle poll interval on the fallback path.
 * @property {number} maxIdlePolls - give up after this many polls.
 * @property {number} rereadWindowMs - how long to watch calls after a compaction.
 * @property {string} handoffDir - handoff directory; empty means the default.
 * @property {string} logPath - log file; empty means the default.
 * @property {string} [language] - 'en' or 'zh'.
 */

export const DEFAULTS = Object.freeze({
  enabled: true,
  floorPct: 0.3,
  minSavingK: 100,
  baselineK: 65,
  retainK: 20,
  nudgeStartPct: 0.4,
  nudgeStepPct: 0.1,
  urgentPct: 0.55,
  continuation: true,
  debounceMs: 1500,
  retryDelayMs: 2000,
  maxRetries: 5,
  idlePollMs: 250,
  maxIdlePolls: 30,
  rereadWindowMs: 1_800_000,
  handoffDir: '',
  logPath: '',
});

const FRACTIONS = ['floorPct', 'nudgeStartPct', 'nudgeStepPct', 'urgentPct'];
const NON_NEGATIVE = [
  'minSavingK',
  'baselineK',
  'retainK',
  'debounceMs',
  'retryDelayMs',
  'maxRetries',
  'idlePollMs',
  'maxIdlePolls',
  'rereadWindowMs',
];

/**
 * Merge user configuration over the defaults and validate it.
 * @param {Partial<SelfCompactConfig>} [input] - loader-supplied configuration.
 * @returns {SelfCompactConfig} frozen, fully populated configuration.
 * @throws {TypeError} on a value that would make the gate behave unpredictably.
 */
export function resolveConfig(input = {}) {
  const config = { ...DEFAULTS };
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!(key in DEFAULTS)) continue;
    if (value === undefined || value === null) continue;
    config[key] = value;
  }

  for (const key of FRACTIONS) {
    const value = config[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new TypeError(`dsh-self-compact: ${key} must be a fraction between 0 and 1 (got ${JSON.stringify(value)})`);
    }
  }
  for (const key of NON_NEGATIVE) {
    const value = config[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new TypeError(`dsh-self-compact: ${key} must be a non-negative integer (got ${JSON.stringify(value)})`);
    }
  }
  for (const key of ['enabled', 'continuation']) {
    if (typeof config[key] !== 'boolean') {
      throw new TypeError(`dsh-self-compact: ${key} must be a boolean (got ${JSON.stringify(config[key])})`);
    }
  }
  if (config.nudgeStepPct <= 0) config.nudgeStepPct = DEFAULTS.nudgeStepPct;
  // A nudge below the floor can never fire; keep them consistent instead of
  // silently never nagging.
  config.nudgeStartPct = Math.max(config.nudgeStartPct, config.floorPct);
  config.urgentPct = Math.max(config.urgentPct, config.nudgeStartPct);

  return Object.freeze(config);
}
