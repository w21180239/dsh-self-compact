/**
 * Handoff rendering: the model writes the state it wants to survive the
 * compaction, this module turns it into one Markdown file and one continuation
 * prompt.
 *
 * The host summarizer takes no instructions and only sees the folded prefix,
 * so the continuation is the carrier that does not depend on its paraphrase:
 * language rules, standing orders, pending, decisions, artifacts and the skill
 * working set are repeated there verbatim.
 *
 * @module dsh-self-compact/handoff
 */
import fs from 'node:fs';
import path from 'node:path';

/** Field order used for rendering and for the "missing field" checks. */
export const LIST_FIELDS = ['standing_orders', 'decisions', 'artifacts', 'pending', 'done', 'drop', 'lessons'];

/** Fields the model must supply before a request is accepted. */
export const REQUIRED_FIELDS = ['node', 'next_step'];

/** Item caps per continuation section: standing orders are never trimmed. */
export const CONTINUATION_CAPS = Object.freeze({ pending: 24, decisions: 12, artifacts: 16 });

/** The opening request is capped so one pasted spec cannot crowd the handoff. */
export const INTENT_CAP = 1500;

/** Chars per item in the continuation, so one pasted log line cannot eat the prompt. */
const ITEM_CHARS = 400;

const LABELS = {
  en: {
    title: (node) => `# Handoff: ${node}`,
    language: 'Language rules',
    chat: 'Chat: ',
    sep: ' | ',
    objective: 'Objective',
    intent: 'Original request',
    standing: "Standing orders (user's words)",
    decisions: 'Decisions',
    artifacts: 'Artifacts',
    done: 'Done',
    pending: 'Pending',
    next: 'Next',
    lessons: 'Lessons from dead ends',
    dropped: 'Dropped threads',
    recent: 'Recent user messages',
    skills: 'Skills in use',
    head: (b, a, d) => `[self-compact] Context compacted (${b}% -> ${a}%, ~${d} tokens folded into the summary).`,
    handoff: 'handoff',
    nextLine: 'next',
    cont: { standing: 'standing orders (verbatim):', pending: 'pending (verbatim):', decisions: 'decisions (verbatim):', artifacts: 'artifacts (verbatim):' },
    more: (n) => `- … ${n} more in the handoff file`,
    skillSet: 'Skill working set:',
    skillHot: (name, file) => `- ${name}: still in use${file ? `; instructions at ${file}` : ''}`,
    skillRef: (p) => `  - ${p} (re-read when needed)`,
    skillDone: (name) => `- ${name}: finished; its instructions no longer apply.`,
    closing: (file) => `Continue with "next" now. The summary is lossy: read ${file}, or search the session with session_search / session_event_search, when you need an exact path, error string, value or command from before the compaction; do not guess or redo the work.`,
    reinforce: (line) => `[self-compact] Language rules still apply: ${line}`,
    langName: { zh: 'Chinese', en: 'English' },
  },
  zh: {
    title: (node) => `# 节点交接：${node}`,
    language: '语言约定',
    chat: '对话：',
    sep: '｜',
    objective: '目标',
    intent: '用户最初的需求',
    standing: '常驻指令（用户原话）',
    decisions: '已定决定',
    artifacts: '产物',
    done: '已完成',
    pending: '待处理',
    next: '下一步',
    lessons: '走不通的路及教训',
    dropped: '丢弃的支线',
    recent: '用户最近原话',
    skills: '在用的 skill',
    head: (b, a, d) => `[self-compact] 上下文已压缩（${b}% -> ${a}%，约 ${d} tokens 折进摘要）。`,
    handoff: '交接单',
    nextLine: '下一步',
    cont: { standing: '常驻指令（原文）：', pending: '待处理（原文）：', decisions: '已定决定（原文）：', artifacts: '产物（原文）：' },
    more: (n) => `- … 另有 ${n} 条见交接单`,
    skillSet: 'skill 工作集：',
    skillHot: (name, file) => `- ${name}：仍在使用${file ? `；说明在 ${file}` : ''}`,
    skillRef: (p) => `  - ${p}（需要时再读）`,
    skillDone: (name) => `- ${name}：已完成，其说明不再适用。`,
    closing: (file) => `现在按「下一步」继续。摘要会丢细节：需要压缩前的路径、报错原文、数值或命令时，读 ${file}，或用 session_search / session_event_search 查本会话，不要猜，也不要重做。`,
    reinforce: (line) => `[self-compact] 语言约定仍然有效：${line}`,
    langName: { zh: '中文', en: '英文' },
  },
};

/**
 * Labels for one UI language.
 * @param {string} language - 'en' or 'zh'.
 * @returns {object} label table.
 */
export function labels(language) {
  return LABELS[language === 'zh' ? 'zh' : 'en'];
}

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
  const language = parseLanguage(args.language);
  if (language) handoff.language = language;
  handoff.keep_skills = list(args.keep_skills);
  handoff.drop_skills = list(args.drop_skills);
  const missing = REQUIRED_FIELDS.filter((field) => handoff[field] === '');
  return { handoff, missing };
}

/**
 * A malformed `language` counts as absent; it never blocks a compaction.
 * @param {unknown} value - raw `language` argument.
 * @returns {{chat: string, outputs: string[]} | undefined} rules.
 */
function parseLanguage(value) {
  let v = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  if (!v || typeof v !== 'object') return undefined;
  const chat = typeof v.chat === 'string' ? v.chat.trim() : '';
  const outputs = Array.isArray(v.outputs) ? v.outputs.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : [];
  return chat === '' && outputs.length === 0 ? undefined : { chat, outputs };
}

// ---- language rules ----

const CJK = /[㐀-䶿一-鿿　-〿＀-￯]/g;
export const CJK_RATIO = 0.3;

/**
 * 'zh' when CJK characters are at least CJK_RATIO of the non-space characters.
 * @param {string} value - text.
 * @returns {'zh' | 'en' | undefined} class, undefined for empty text.
 */
export function dominantLang(value) {
  const chars = String(value ?? '').replace(/\s/g, '');
  if (chars === '') return undefined;
  return (chars.match(CJK)?.length ?? 0) / chars.length >= CJK_RATIO ? 'zh' : 'en';
}

/**
 * zh/en class of a free-text chat rule: the first language it names.
 * @param {string} chat - rule text such as "Chinese, English terms OK".
 * @returns {'zh' | 'en' | undefined} class.
 */
export function chatClass(chat) {
  const zh = chat.search(/chinese|mandarin|cantonese|中文|汉语|漢語|普通话|国语|粤语/i);
  const en = chat.search(/english|英文|英语/i);
  if (zh >= 0 && (en < 0 || zh < en)) return 'zh';
  if (en >= 0) return 'en';
  return dominantLang(chat) === 'zh' ? 'zh' : undefined;
}

/**
 * Per sub-field the given value wins, then the previous one; `chat` finally falls back to the detected language.
 * @param {{chat: string, outputs: string[]} | undefined} prev - rules from the previous compaction.
 * @param {{chat: string, outputs: string[]} | undefined} given - rules from this call.
 * @param {'zh' | 'en' | undefined} detected - language of the user's recent messages.
 * @param {string} language - UI language for the detected name.
 * @returns {{chat: string, outputs: string[], source: string}} merged rules.
 */
export function mergeLanguage(prev, given, detected, language) {
  const gChat = given?.chat ?? '';
  const outputs = given?.outputs?.length ? given.outputs : (prev?.outputs ?? []);
  if (gChat !== '') return { chat: gChat, outputs, source: 'tool' };
  if (prev && prev.chat !== '') return { chat: prev.chat, outputs, source: 'inherited' };
  if (detected) return { chat: labels(language).langName[detected], outputs, source: 'detected' };
  return { chat: '', outputs, source: 'none' };
}

/**
 * One line: the chat language, then each output rule.
 * @param {{chat: string, outputs: string[]} | undefined} rules - merged rules.
 * @param {string} language - UI language.
 * @returns {string | undefined} line, undefined without rules.
 */
export function langLine(rules, language) {
  const parts = langBullets(rules, language).map((s) => s.replace(/\s+/g, ' '));
  return parts.length === 0 ? undefined : parts.join(labels(language).sep);
}

function langBullets(rules, language) {
  if (!rules) return [];
  return [...(rules.chat ? [`${labels(language).chat}${rules.chat}`] : []), ...rules.outputs];
}

/**
 * Reason from a `skip: <reason>` self-check reply.
 * @param {string | undefined} answer - final assistant text.
 * @returns {string | undefined} reason (200 chars max), undefined for a bare skip or other text.
 */
export function parseSkipReason(answer) {
  const m = /^\s*skip\s*[:：]\s*([\s\S]*)$/i.exec(answer ?? '');
  const reason = m?.[1]?.trim().slice(0, 200);
  return reason ? reason : undefined;
}

// ---- rendering ----

/**
 * Render the Markdown handoff.
 * @param {object} handoff - normalized handoff (with merged `language`).
 * @param {{sessionId: string, now: string, language?: string, intent?: string, recent?: string[], skills?: string[]}} meta - context.
 * @returns {string} Markdown body.
 */
export function renderHandoff(handoff, meta) {
  const t = labels(meta.language);
  const recent = meta.recent ?? [];
  const out = [t.title(handoff.node), '', `- written: ${meta.now}`, `- session: ${meta.sessionId}`, ''];
  const section = (title, body) => out.push(`## ${title}`, '', body, '');
  const bullets = (items) => items.map((item) => `- ${item}`).join('\n');
  const rules = langBullets(handoff.language, meta.language);
  if (rules.length > 0) section(t.language, bullets(rules));
  if (handoff.objective) section(t.objective, handoff.objective);
  // Skipped while the opening request is still among the recent messages.
  if (meta.intent && !recent.includes(meta.intent)) section(t.intent, fenced(meta.intent));
  const lists = [
    [t.standing, 'standing_orders'],
    [t.decisions, 'decisions'],
    [t.artifacts, 'artifacts'],
    [t.done, 'done'],
    [t.pending, 'pending'],
  ];
  for (const [title, field] of lists) if (handoff[field].length > 0) section(title, bullets(handoff[field]));
  section(t.next, handoff.next_step);
  if (meta.skills?.length) section(t.skills, bullets(meta.skills));
  if (handoff.lessons.length > 0) section(t.lessons, bullets(handoff.lessons));
  if (handoff.drop.length > 0) section(t.dropped, bullets(handoff.drop));
  if (recent.length > 0) {
    out.push(`## ${t.recent}`, '');
    recent.forEach((m, i) => out.push(`### ${i + 1}`, '', fenced(m), ''));
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/**
 * Write one handoff file.
 * @param {string} body - rendered Markdown.
 * @param {string} node - milestone label used in the filename.
 * @param {string} directory - target directory.
 * @returns {string} absolute path of the written file.
 */
export function writeHandoff(body, node, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const slug = node
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'milestone';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(directory, `${stamp}-${slug}.md`);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

/**
 * Build the continuation prompt submitted after a successful compaction.
 * @param {object} handoff - normalized handoff (with merged `language`).
 * @param {{beforePct: number, afterPct: number, file: string, dropped: number, language?: string, skills?: string}} facts - outcome and carriers.
 * @returns {string} continuation text.
 */
export function buildContinuation(handoff, facts) {
  const t = labels(facts.language);
  const lines = [];
  const rules = langLine(handoff.language, facts.language);
  if (rules) lines.push(rules, '');
  lines.push(t.head(facts.beforePct, facts.afterPct, facts.dropped), `${t.handoff}: ${facts.file}`, '', `node: ${handoff.node}`);
  if (handoff.objective) lines.push(`objective: ${handoff.objective}`);
  lines.push('', `${t.nextLine}: ${handoff.next_step}`);
  if (facts.skills) lines.push('', facts.skills);
  if (handoff.standing_orders.length > 0) {
    lines.push('', t.cont.standing);
    for (const item of handoff.standing_orders) lines.push(`- ${item}`);
  }
  pushList(lines, t, t.cont.pending, handoff.pending, CONTINUATION_CAPS.pending);
  pushList(lines, t, t.cont.decisions, handoff.decisions, CONTINUATION_CAPS.decisions);
  pushList(lines, t, t.cont.artifacts, handoff.artifacts, CONTINUATION_CAPS.artifacts);
  lines.push('', t.closing(facts.file));
  return lines.join('\n');
}

function pushList(lines, t, title, items, cap) {
  if (items.length === 0) return;
  lines.push('', title);
  for (const item of items.slice(0, cap)) {
    lines.push(`- ${item.length > ITEM_CHARS ? `${item.slice(0, ITEM_CHARS)}…` : item}`);
  }
  if (items.length > cap) lines.push(t.more(items.length - cap));
}

/**
 * Cap the opening request.
 * @param {string | undefined} value - first real user message.
 * @returns {string | undefined} capped text.
 */
export function capIntent(value) {
  if (!value) return undefined;
  return value.length > INTENT_CAP ? `${value.slice(0, INTENT_CAP)}\n[...]` : value;
}

// A fence longer than any backtick run inside, so the text stays verbatim.
function fenced(value) {
  const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${value}\n${fence}`;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function list(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? [] : trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
}
