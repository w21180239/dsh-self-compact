/**
 * Configuration defaults and normalization for dsh-self-compact.
 *
 * Every size tier derives from P, the learned post-compact size, through a
 * break-even formula priced for DeepSeek-class routes (see gate.js and
 * docs/en/DESIGN.md §4). The knobs below are call counts and price ratios,
 * not window percentages.
 *
 * @module dsh-self-compact/config
 */

/**
 * @typedef {object} SelfCompactConfig
 * @property {boolean} enabled - false denies every request while keeping the tool registered.
 * @property {number} floorCalls - the floor is the size that repays a compaction within this many calls.
 * @property {number} nodeCalls - any clean node from the size that repays within this many calls.
 * @property {number} workCalls - turn-end self-check after a block of work from this size.
 * @property {number} floorPct - optional extra floor as a fraction of the window (0 = off).
 * @property {number} urgentK - urgent tier in thousand tokens, capped at 80% of the window.
 * @property {number} summaryK - estimated summary length in thousand output tokens.
 * @property {number} cacheReadRatio - cache-hit input price relative to cache-miss input.
 * @property {number} outputRatio - output price relative to cache-miss input.
 * @property {number} nudgeStepPct - gap between nudges, as a fraction of the window.
 * @property {boolean} autoNodes - node flags, turn-end self-check and block-start hint.
 * @property {boolean} turnEndCheck - the turn-end self-check alone.
 * @property {number} hotWindow - a skill used within this many main steps is hot at compaction.
 * @property {number} refInlineK - inline a hot skill's reference file up to this many thousand tokens.
 * @property {number} skillBudgetK - total thousand tokens of inlined skill references.
 * @property {boolean} continuation - submit a continuation prompt after compaction.
 * @property {number} debounceMs - buffer between turn end and compaction or self-check.
 * @property {number} retryDelayMs - retry interval.
 * @property {number} maxRetries - retries before giving up.
 * @property {number} idlePollMs - idle poll interval on the fallback path.
 * @property {number} maxIdlePolls - legacy poll count, used only when maxIdleWaitMs is 0.
 * @property {number} maxIdleWaitMs - wall-clock budget for the agent to turn idle before giving up.
 * @property {number} rereadWindowMs - how long to watch calls after a compaction.
 * @property {string} dataDir - state directory; empty means ~/.dsh/self-compact.
 * @property {string} [language] - 'en' or 'zh'.
 */

export const DEFAULTS = Object.freeze({
  enabled: true,
  floorCalls: 20,
  nodeCalls: 10,
  workCalls: 8,
  floorPct: 0,
  urgentK: 350,
  summaryK: 10,
  cacheReadRatio: 0.1,
  outputRatio: 1.5,
  nudgeStepPct: 0.05,
  autoNodes: true,
  turnEndCheck: true,
  hotWindow: 20,
  refInlineK: 2,
  skillBudgetK: 6,
  continuation: true,
  debounceMs: 1500,
  retryDelayMs: 2000,
  maxRetries: 5,
  idlePollMs: 250,
  maxIdlePolls: 30,
  maxIdleWaitMs: 180_000,
  rereadWindowMs: 1_800_000,
  dataDir: '',
});

const FRACTIONS = ['floorPct', 'nudgeStepPct', 'cacheReadRatio'];
const POSITIVE = ['urgentK', 'summaryK', 'outputRatio', 'refInlineK', 'skillBudgetK'];
const NON_NEGATIVE_INT = ['debounceMs', 'retryDelayMs', 'maxRetries', 'idlePollMs', 'maxIdlePolls', 'maxIdleWaitMs', 'rereadWindowMs', 'hotWindow'];
const CALLS = ['floorCalls', 'nodeCalls', 'workCalls'];
const FLAGS = ['enabled', 'continuation', 'autoNodes', 'turnEndCheck'];

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
  const fail = (key, what) => {
    throw new TypeError(`dsh-self-compact: ${key} must be ${what} (got ${JSON.stringify(config[key])})`);
  };
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  for (const key of FRACTIONS) if (!isNum(config[key]) || config[key] < 0 || config[key] > 1) fail(key, 'a fraction between 0 and 1');
  for (const key of POSITIVE) if (!isNum(config[key]) || config[key] < 0) fail(key, 'a non-negative number');
  for (const key of NON_NEGATIVE_INT) if (!Number.isInteger(config[key]) || config[key] < 0) fail(key, 'a non-negative integer');
  // N = 1 would divide by zero in the break-even formula.
  for (const key of CALLS) if (!Number.isInteger(config[key]) || config[key] < 2) fail(key, 'an integer of at least 2');
  for (const key of FLAGS) if (typeof config[key] !== 'boolean') fail(key, 'a boolean');
  if (config.cacheReadRatio <= 0) fail('cacheReadRatio', 'greater than 0');
  if (config.nudgeStepPct <= 0) config.nudgeStepPct = DEFAULTS.nudgeStepPct;
  config.urgentK = Math.max(50, config.urgentK);
  return Object.freeze(config);
}
