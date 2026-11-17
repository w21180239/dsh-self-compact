/**
 * Handoff rendering: the model writes the state it wants to survive the
 * compaction, this module turns it into one Markdown file and one continuation
 * prompt.
 *
 * The file is the durable record (the model can re-read it later); the
 * continuation prompt is the part that must not depend on how the summarizer
 * paraphrased anything, so standing orders and pending items are repeated
 * there verbatim.
 *
 * @module dsh-self-compact/handoff
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Field order used for rendering and for the "missing field" checks. */
export const LIST_FIELDS = ['standing_orders', 'decisions', 'artifacts', 'pending', 'done', 'drop', 'lessons'];

/** Fields the model must supply before a request is accepted. */
export const REQUIRED_FIELDS = ['node', 'next_step'];

/**
 * Normalize one handoff argument set from a tool call.
 * @param {Record<string, unknown>} args - raw tool arguments.
 * @returns {{handoff: object, missing: string[]}} normalized handoff and missing required fields.
 */
export function normalizeHandoff(args = {}) {
  const handoff = {
    node: text(args.node),
    objective: text(args.objective),
    next_step: text(args.next_step),
  };
  for (const field of LIST_FIELDS) handoff[field] = list(args[field]);
  const missing = REQUIRED_FIELDS.filter((field) => handoff[field] === '');
  return { handoff, missing };
}

/**
 * Render the Markdown handoff.
 * @param {object} handoff - normalized handoff.
 * @param {{sessionId: string, now: string}} meta - identity and timestamp.
 * @returns {string} Markdown body.
 */
export function renderHandoff(handoff, meta) {
  const lines = [`# Handoff — ${handoff.node}`, '', `- written: ${meta.now}`, `- session: ${meta.sessionId}`, ''];
  const sections = [
    ['Objective', 'objective'],
    ['Standing orders', 'standing_orders'],
    ['Decisions', 'decisions'],
    ['Artifacts', 'artifacts'],
    ['Done', 'done'],
    ['Pending', 'pending'],
    ['Next', 'next_step'],
    ['Dropped', 'drop'],
    ['Lessons', 'lessons'],
  ];
  for (const [title, field] of sections) {
    const value = handoff[field];
    if (field === 'next_step') {
      if (value === '') continue;
      lines.push(`## ${title}`, '', value, '');
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`## ${title}`, '');
      for (const item of value) lines.push(`- ${item}`);
      lines.push('');
      continue;
    }
    if (value === '') continue;
    lines.push(`## ${title}`, '', value, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Write one handoff file.
 * @param {string} body - rendered Markdown.
 * @param {string} node - milestone label used in the filename.
 * @param {string} directory - target directory; defaults to `~/.dsh/self-compact/handoff`.
 * @returns {string} absolute path of the written file.
 */
export function writeHandoff(body, node, directory) {
  const target = directory || path.join(os.homedir(), '.dsh', 'self-compact', 'handoff');
  fs.mkdirSync(target, { recursive: true });
  const slug = node
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'milestone';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(target, `${stamp}-${slug}.md`);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

/**
 * Build the continuation prompt submitted after a successful compaction.
 * @param {object} handoff - normalized handoff.
 * @param {{beforePct: number, afterPct: number, file: string, dropped: number}} facts - measured outcome.
 * @returns {string} continuation text.
 */
export function buildContinuation(handoff, facts) {
  const lines = [
    `self-compact: context compacted (${facts.beforePct}% -> ${facts.afterPct}%, ~${facts.dropped} tokens folded into the summary).`,
    `handoff: ${facts.file}`,
    '',
    `node: ${handoff.node}`,
    handoff.objective ? `objective: ${handoff.objective}` : '',
    '',
    `next: ${handoff.next_step}`,
  ].filter((line, index, all) => line !== '' || all[index - 1] !== '');

  if (handoff.standing_orders.length > 0) {
    lines.push('', 'standing orders (verbatim):');
    for (const item of handoff.standing_orders) lines.push(`- ${item}`);
  }
  if (handoff.pending.length > 0) {
    pushList(lines, 'pending', handoff.pending, CONTINUATION_CAPS.pending);
  }
  // Decisions and artifacts are the two sections the native summarizer is most
  // likely to paraphrase away, and the model needs them after the compaction:
  // carry them verbatim instead of taking over the compaction engine just to
  // steer its prompt.
  if (handoff.decisions.length > 0) {
    pushList(lines, 'decisions', handoff.decisions, CONTINUATION_CAPS.decisions);
  }
  if (handoff.artifacts.length > 0) {
    pushList(lines, 'artifacts', handoff.artifacts, CONTINUATION_CAPS.artifacts);
  }
  lines.push(
    '',
    `Continue with "next" now. The summary above is lossy: read ${facts.file} or grep the session transcript when you need an exact path, error string or signature from before the compaction.`,
  );
  return lines.join('\n');
}

/** Item caps per section: standing orders and pending are never trimmed. */
export const CONTINUATION_CAPS = Object.freeze({ pending: 24, decisions: 12, artifacts: 16 });

/** Per-item character cap, so one pasted log line cannot eat the prompt. */
const ITEM_CHARS = 400;

/**
 * Append one verbatim list section, capped per item and per section.
 * @param {string[]} lines - output buffer.
 * @param {string} title - section title.
 * @param {string[]} items - verbatim items.
 * @param {number} cap - maximum items to emit.
 */
function pushList(lines, title, items, cap) {
  lines.push('', `${title} (verbatim):`);
  for (const item of items.slice(0, cap)) {
    lines.push(`- ${item.length > ITEM_CHARS ? `${item.slice(0, ITEM_CHARS)}…` : item}`);
  }
  if (items.length > cap) lines.push(`- … ${items.length - cap} more in the handoff file`);
}

/**
 * Coerce one value into a trimmed string.
 * @param {unknown} value - raw value.
 * @returns {string} trimmed text, empty when absent.
 */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Coerce a string, an array of strings, or a missing value into a string list.
 * @param {unknown} value - raw value.
 * @returns {string[]} non-empty trimmed items.
 */
function list(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? [] : trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
}
