/**
 * Pure helpers for the autonomous triggers and the skill working set.
 * Tool names and argument fields are the dsh built-ins (dsh 0.2.2).
 *
 * @module dsh-self-compact/triggers
 */
import path from 'node:path';

const STRONG_SHELL = [
  [/\bgit\s+push\b/, 'push'],
  [/\b(gh\s+pr|glab\s+mr)\s+(create|merge|review|comment|close)\b/, 'pr'],
  [/\bgh\s+issue\s+(comment|close)\b/, 'pr'],
  [/\bgit\s+tag\b/, 'tag'],
  [/\bgit\s+merge\b(?!-)/, 'merge'],
  [/\b(gog|agent-slack|slack|outlook)\b[^|;&\n]*\s(send|reply|post)\b/, 'sent'],
];
const COMMIT = /\bgit\s+commit\b/;
// Loops rerun tests, so a green run stays a weak signal.
const TESTS = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\b(?:pytest|tox|nox|vitest|jest|rspec|phpunit|ctest)\b|\bgo\s+test\b|\bcargo\s+test\b|\bdotnet\s+test\b|\b(?:mvn|gradlew?)\b[^|;&\n]*\btest\b|\bmake\s+(?:test|check)\b|\bInvoke-Pester\b/;
const SPEC_PLAN = /(^|\/)(specs?|plans?)\/[^/]+\.md$/i;
const HANDOFF = /^handoff/i;

export const SHELL_TOOLS = new Set(['bash', 'pwsh']);
export const ASK_TOOL = 'ask_user_question';

/**
 * Whether a finished tool call looks like a task node. Callers filter subagents.
 * @param {string} name - tool name.
 * @param {unknown} args - parsed arguments.
 * @param {{isError?: boolean} | undefined} result - tool result.
 * @returns {{kind: string, strength: 'strong' | 'weak'} | undefined} signal.
 */
export function detectNode(name, args, result) {
  if (result?.isError) return undefined;
  const a = args && typeof args === 'object' ? args : {};
  const strong = (kind) => ({ kind, strength: 'strong' });
  const weak = (kind) => ({ kind, strength: 'weak' });
  if (SHELL_TOOLS.has(name)) {
    if (typeof a.command !== 'string') return undefined;
    for (const [re, kind] of STRONG_SHELL) if (re.test(a.command)) return strong(kind);
    if (COMMIT.test(a.command)) return weak('commit');
    return TESTS.test(a.command) ? weak('tests') : undefined;
  }
  const written = writtenPaths(name, a);
  for (const p of written) {
    if (SPEC_PLAN.test(p)) return strong('spec-plan');
    if (HANDOFF.test(p.slice(p.lastIndexOf('/') + 1))) return strong('handoff');
  }
  if ((name === 'write' || (name === 'str_replace_editor' && a.command === 'create')) && written.some((p) => p.endsWith('.md'))) {
    return weak('doc-written');
  }
  if (name === 'todo_write') {
    const todos = Array.isArray(a.todos) ? a.todos : [];
    return todos.length > 0 && todos.every((t) => t?.status === 'completed') ? strong('todos-done') : undefined;
  }
  if (name === 'subagent' || name === 'wait_agent') return weak('agent-done');
  return undefined;
}

/**
 * Paths a write-type tool touched, with forward slashes.
 * @param {string} name - tool name.
 * @param {object} a - arguments.
 * @returns {string[]} paths.
 */
function writtenPaths(name, a) {
  const slash = (p) => p.replace(/\\/g, '/');
  if ((name === 'write' || name === 'edit') && typeof a.file_path === 'string') return [slash(a.file_path)];
  if (name === 'str_replace_editor' && a.command !== 'view' && typeof a.path === 'string') return [slash(a.path)];
  if (name === 'apply_patch' && typeof a.input === 'string') {
    return [...a.input.matchAll(/^\*\*\* (?:Add|Update) File: (.+)$/gm)].map((m) => slash(m[1].trim()));
  }
  return [];
}

// ---- skill working set ----

export const MAX_REFS = 8;
/** A ref read this many main steps after a compaction is a miss. */
export const MISS_WINDOW = 30;
const MIN_PRIOR_COMPACTIONS = 3;
const PRIOR_MISS_RATE = 0.3;
const FILE_LIKE = /^[^*?{}[\]]+\.[A-Za-z0-9]+$/;
const TOKEN_SPLIT = /[\s'"`<>|;&()=]+/;

/**
 * Normalize a path for comparison: absolute, forward slashes, lower case on Windows.
 * @param {string} raw - path as the tool saw it.
 * @param {string} cwd - working directory for relative paths.
 * @param {string} home - home directory for `~`.
 * @returns {string | undefined} key, undefined for an empty path.
 */
export function pathKey(raw, cwd, home) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  let p = raw.trim();
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(home, p.slice(1));
  // Git Bash style /d/foo on Windows.
  if (process.platform === 'win32' && /^\/[a-zA-Z]\//.test(p)) p = `${p[1]}:${p.slice(2)}`;
  const abs = path.resolve(cwd || '.', p).replace(/\\/g, '/');
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/**
 * Paths one call touched, each with whether it names a file.
 * @param {string} name - tool name.
 * @param {object} args - arguments.
 * @returns {{path: string, file: boolean}[]} touched paths.
 */
export function touchedPaths(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  if (['read', 'write', 'edit', 'read_image'].includes(name) && typeof a.file_path === 'string') return [{ path: a.file_path, file: true }];
  if (name === 'str_replace_editor' && typeof a.path === 'string') return [{ path: a.path, file: true }];
  if ((name === 'grep' || name === 'glob') && typeof a.path === 'string') return [{ path: a.path, file: false }];
  if (SHELL_TOOLS.has(name) && typeof a.command === 'string') {
    return a.command
      .split(TOKEN_SPLIT)
      .map((t) => t.replace(/[,.;:]+$/, '').replace(/:\d+(?::\d+)?$/, ''))
      .filter((t) => /[\\/]/.test(t))
      .map((t) => ({ path: t, file: FILE_LIKE.test(t.slice(Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\')) + 1)) }));
  }
  return [];
}

/**
 * Record one touched path against the loaded skills.
 * @param {Map<string, {name: string, dirKey: string, lastUse: number, refs: string[]}>} skills - loaded skills.
 * @param {string} key - normalized path.
 * @param {string} raw - path as given, kept for display.
 * @param {boolean} file - the path names a file.
 * @param {number} now - main step counter.
 * @returns {string | undefined} the owning skill's name.
 */
export function noteSkillPath(skills, key, raw, file, now) {
  let owner;
  for (const use of skills.values()) {
    if (key === use.dirKey || key.startsWith(`${use.dirKey}/`)) {
      if (!owner || use.dirKey.length > owner.dirKey.length) owner = use;
    }
  }
  if (!owner) return undefined;
  owner.lastUse = now;
  if (file && key !== `${owner.dirKey}/skill.md` && key !== `${owner.dirKey}/SKILL.md`) {
    const display = raw.replace(/\\/g, '/');
    owner.refs = [display, ...owner.refs.filter((r) => pathKeyLoose(r) !== pathKeyLoose(display))].slice(0, MAX_REFS);
  }
  return owner.name;
}

const pathKeyLoose = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

/**
 * Split loaded skills into hot (carried) and done (named finished).
 * @param {Iterable<{name: string, lastUse: number}>} skills - loaded skills.
 * @param {{keep: string[], drop: string[], now: number, priors: Record<string, {compactions: number, refMisses: number}>, hotWindow: number}} opts - inputs.
 * @returns {{hot: object[], done: object[]}} tiers.
 */
export function tierSkills(skills, opts) {
  const matches = (list, name) => list.some((n) => n === name || n === name.slice(name.lastIndexOf(':') + 1));
  const hot = [];
  const done = [];
  for (const use of skills) {
    if (matches(opts.keep, use.name)) hot.push(use);
    else if (matches(opts.drop, use.name)) done.push(use);
    else if (opts.now - use.lastUse <= opts.hotWindow || priorHot(opts.priors[use.name])) hot.push(use);
  }
  return { hot, done };
}

function priorHot(prior) {
  return !!prior && prior.compactions >= MIN_PRIOR_COMPACTIONS && prior.refMisses / prior.compactions >= PRIOR_MISS_RATE;
}
