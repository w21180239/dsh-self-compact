/**
 * Every model-facing line, keyed by UI language. User-supplied handoff
 * content is never translated.
 *
 * @module dsh-self-compact/strings
 */
import { k } from './gate.js';

const CRIT = {
  en: 'Compact only if all three hold: (1) the current block is closed (no unfinished step, no open question; finished work saved to disk and handed over for review counts as closed: list it in pending); (2) the next work does not depend on large raw text in this context (a diff being compared line by line, a long file just read, an error text still to be quoted); (3) enough work remains to repay a compaction (more than a few calls); a session about to end is not compacted.',
  zh: '三条都满足才压：（1）当前块已收尾（没有未完成的步骤、没有开着的提问；成果已落盘、交给用户审阅也算收尾，写进 pending）；（2）接下来的工作不依赖当前上下文里的大段原文（正在逐行对照的 diff、刚读的长文件、还要引用的报错原文）；（3）剩余工作还够长，值得压一次（预计不止几次调用），马上要结束的会话不压。',
};

const NOT_STOP = {
  en: 'Compacting does not stop or interrupt the task: work resumes automatically right after, so "don\'t stop" instructions are no reason to skip.',
  zh: '压缩不会打断任务，压完会自动接着做。',
};

const NODE_NAMES = {
  en: {
    push: 'git push', pr: 'PR/MR create, review or merge', tag: 'git tag', merge: 'git merge', sent: 'outbound message sent',
    'spec-plan': 'spec/plan write', handoff: 'handoff note', 'todos-done': 'todo list (all done)', commit: 'git commit',
    tests: 'tests passed', 'doc-written': 'new document', 'agent-done': 'subagent returned',
  },
  zh: {
    push: 'git push', pr: 'PR/MR 创建、评审或合并', tag: 'git tag', merge: 'git merge', sent: '对外消息已发送',
    'spec-plan': 'spec/plan 落盘', handoff: '交接文档', 'todos-done': '待办全部完成', commit: 'git commit',
    tests: '测试通过', 'doc-written': '新文档', 'agent-done': '子代理返回',
  },
};

const tier = (lang, t, key) => {
  const pct = Math.round((t[key] / t.window) * 100);
  return lang === 'zh' ? `${k(t[key])}（${pct}%）` : `${k(t[key])} (${pct}%)`;
};

export const STRINGS = {
  en: {
    nodeName: (kind) => NODE_NAMES.en[kind] ?? kind,
    nodeNudge: (kind, pct) => `[self-compact] The ${NODE_NAMES.en[kind] ?? kind} just now looks like a node (context ${pct}%, past the break-even line: necessary, not sufficient). ${CRIT.en} ${NOT_STOP.en} If all three hold, call compact_now before this turn ends.`,
    selfCheck: (reason, pct) => `[self-compact self-check] ${reason}, context ${pct}%, past the break-even line: necessary, not sufficient. ${CRIT.en} ${NOT_STOP.en} If all three hold, call compact_now now (next_step: what to do next, or how to answer the user's latest message if nothing remains); otherwise reply with just "skip: <one-line reason>" and end.`,
    reasonNode: (kind) => `The last turn showed a node signal (${NODE_NAMES.en[kind] ?? kind})`,
    reasonWork: 'The last turn finished a block of work',
    reasonLong: 'The context has not been compacted for a long stretch',
    blockStart: (pct) => `[self-compact] Context ${pct}%, past the break-even line: necessary, not sufficient. ${CRIT.en} If this message opens a new block of work (a different topic, or picking the work up again after a pause) and all three hold, call compact_now first (next_step: the gist of this request, in its own words) and end the turn; work resumes automatically right after.`,
    nudgeSoft: (pct) => `[self-compact] Context ${pct}%, past the break-even line (necessary, not sufficient). Watch for the next node; ${CRIT.en}`,
    nudgeUrgent: (pct) => `[self-compact] Context ${pct}%, automatic compaction is close. Unless (1) fails (the current block is unfinished or a question is open), call compact_now at the next safe step; no need to wait for a perfect node.`,
    heavy: (p) => `[self-compact] The context after a compaction is still about ${p} (tools, skills, instructions), so a compaction saves little: compact at big phase handoffs or near the urgent tier, not at every small node.`,
    stale: '[self-compact] The queued compact_now expired (several tool calls followed, so the handoff no longer reflects the current state) and was dropped. To still compact, call compact_now again with the latest state.',
    scheduled: (pct, used, file) => `compact_now: scheduled at ${pct}% (${used} tokens).\nhandoff: ${file}\nEnd this turn now with one short line and call no more tools. The compaction runs as soon as the agent is idle and work resumes from your next_step automatically.`,
    duplicate: (node) => `compact_now: a compaction is already scheduled (node "${node}"); nothing new was queued.`,
    denySub: 'compact_now denied: only the main session compacts; subagents stay short instead.',
    denyMissing: (fields) => `compact_now denied: missing required field(s) ${fields}. Call it again with the complete handoff.`,
    denyWrite: (msg) => `compact_now denied: the handoff file could not be written (${msg}). Nothing was scheduled.`,
    denyEngine: (probes) => `compact_now denied: this session has no compaction engine (${probes}). The standard, ptc and cordis presets carry one; the minimal preset does not.`,
    description: (t) => [
      `Compact your own context at a task node. The call queues: the host compacts after this turn ends, then you resume at next_step automatically.`,
      `Tiers (compaction leaves ~${k(t.p)}): below ${tier('en', t, 'floor')} denied; ${tier('en', t, 'floor')}-${tier('en', t, 'node')} only at a big phase handoff with a clearly long next phase; from ${tier('en', t, 'node')} any clean node, nudged; from ${tier('en', t, 'urgent')} compact at the next safe step, no perfect node needed.`,
      'Good nodes: a verified block end (push, merge, PR, tests green, message sent, todos done), topic change, phase handoff, subagent returned, delegation waiting (list each task in pending), work saved for review. Anti-nodes: open question whose answer decides the next step, unsent draft, a new user rule not yet in standing_orders, mid retry/debug loop, unread background result.',
      'The plugin flags nodes and may ask you at a turn end; act when the phase is closed, otherwise answer "skip: <reason>".',
      'standing_orders: the user\'s rules, permissions and preferences in their words. pending: each running task, draft or awaited reply and how it reports. language: the rules this session actually uses (chat language, one rule per output channel). keep_skills/drop_skills: skills whose work continues or is finished.',
      'After "scheduled", end the turn with one line and call no more tools.',
    ].join('\n'),
    params: {
      node: 'Node in one sentence, e.g. "plan written -> start implementation".',
      next_step: 'The first concrete action after compaction, as an instruction to yourself.',
      objective: 'Goal of the whole task, one or two sentences.',
      standing_orders: 'The user\'s "don\'t/must" rules, permissions and preferences, verbatim.',
      decisions: 'Decisions taken, each with its reason.',
      artifacts: 'Files, branches, URLs and IDs produced, with paths.',
      pending: 'Every open item (running agents, drafts awaiting approval, awaited replies) and how it reports back.',
      done: 'Finished work worth naming.',
      drop: 'Threads explicitly dropped.',
      lessons: 'What failed and why, one line each, so it is not retried.',
      language: 'Language rules this session uses: {"chat": "<conversation language as the user set it>", "outputs": ["<one rule per channel: code, commit, PR, spec, outgoing text>"]}.',
      keep_skills: 'Skills (names) whose work continues after this compaction.',
      drop_skills: 'Skills (names) whose work is finished.',
    },
  },
  zh: {
    nodeName: (kind) => NODE_NAMES.zh[kind] ?? kind,
    nodeNudge: (kind, pct) => `[self-compact] 刚才的 ${NODE_NAMES.zh[kind] ?? kind} 像是一个节点（上下文 ${pct}%，已过回本线，这是压缩的必要条件而非充分条件）。${CRIT.zh}${NOT_STOP.zh}三条都满足就在本轮结束前调用 compact_now。`,
    selfCheck: (reason, pct) => `[self-compact 自检] ${reason}，上下文 ${pct}%，已过回本线，这是压缩的必要条件而非充分条件。${CRIT.zh}${NOT_STOP.zh}三条都满足就现在调用 compact_now（next_step 写接下来要做的事；没有就写怎么回应用户最新的消息）；否则只回复 skip: <一句理由> 并结束。`,
    reasonNode: (kind) => `上一轮出现了节点信号（${NODE_NAMES.zh[kind] ?? kind}）`,
    reasonWork: '上一轮做完了一整块工作',
    reasonLong: '上下文已经很久没有压缩',
    blockStart: (pct) => `[self-compact] 上下文 ${pct}%，已过回本线，这是压缩的必要条件而非充分条件。${CRIT.zh}如果这条消息开启一个新工作块（换了话题，或隔了一阵重新接着做）且三条都满足，先调用 compact_now（next_step 写这条需求的原文要点）再结束本轮；压完会自动接着做。`,
    nudgeSoft: (pct) => `[self-compact] 上下文 ${pct}%，已过回本线（必要条件）。留意下一个节点；${CRIT.zh}`,
    nudgeUrgent: (pct) => `[self-compact] 上下文 ${pct}%，很快会触发自动压缩。除非（1）不满足（当前块未收尾或有开着的提问），否则在下一个安全步骤调用 compact_now，不必等完美节点。`,
    heavy: (p) => `[self-compact] 压缩后上下文仍有约 ${p}（工具、skill、指令占用大），压一次省得不多：只在大阶段交接或接近紧急档时压，别每个小节点都压。`,
    stale: '[self-compact] 排队的 compact_now 已过期（之后又调用了多个工具，交接单不再反映当前状态），已丢弃。若仍要压缩，请用最新状态重新调用 compact_now。',
    scheduled: (pct, used, file) => `compact_now：已排队（上下文 ${pct}%，${used} tokens）。\n交接单：${file}\n现在用一行话收尾本轮，不要再调用任何工具。agent 空闲后立即压缩，并自动按 next_step 续接。`,
    duplicate: (node) => `compact_now：已有一个排队中的压缩（节点「${node}」），没有新排队。`,
    denySub: 'compact_now 未执行：只有主会话压缩；子代理应保持短小。',
    denyMissing: (fields) => `compact_now 未执行：缺少必填字段 ${fields}。补全交接后重新调用。`,
    denyWrite: (msg) => `compact_now 未执行：交接单写入失败（${msg}），没有排队。`,
    denyEngine: (probes) => `compact_now 未执行：本会话没有压缩引擎（${probes}）。standard、ptc、cordis 预设带引擎，minimal 不带。`,
    description: (t) => [
      '在任务节点上压缩你自己的上下文。调用只排队：本轮结束后宿主压缩，随后自动按 next_step 续接。',
      `门槛（压缩后约剩 ${k(t.p)}）：低于 ${tier('zh', t, 'floor')} 拒绝；${tier('zh', t, 'floor')}-${tier('zh', t, 'node')} 只在大阶段交接压（spec→plan、plan→实现、MR 创建→review）且下一阶段明显够长；从 ${tier('zh', t, 'node')} 起任何干净节点可压，插件开始提醒；从 ${tier('zh', t, 'urgent')} 起在下一个安全步骤就压，不必等完美节点。`,
      '好节点：一块工作收尾并已验证（push、合并、PR、测试通过、消息已发、待办全完成），换话题，阶段交接，子代理返回，任务委派出去进入等待（pending 写明每个任务），成果落盘待审阅。反节点：提问没答且答案决定下一步；外发草稿等用户说发；用户刚给的新规则还没写进 standing_orders；重试、调试循环中途；后台结果已到未读。',
      '插件会标出节点，也可能在轮末问你；阶段已收尾就压，否则回答 "skip: <理由>"。',
      'standing_orders 填用户的规则、授权、偏好原话；pending 列每个在跑任务、待批准草稿、等外部回复的事及回报方式；language 填本会话实际在用的语言约定（对话语言，各输出渠道一条）；keep_skills/drop_skills 填仍要继续或已完成的 skill。',
      '收到「已排队」后用一行话收尾本轮，不要再调用任何工具。',
    ].join('\n'),
    params: {
      node: '节点，一句话，如"plan 已落盘 → 开始实现"。',
      next_step: '压缩后的第一步具体动作，写成给自己的指令。',
      objective: '整个任务的目标，一两句。',
      standing_orders: '用户的"不要/必须"、授权、偏好，原话。',
      decisions: '已定决定，每条带理由。',
      artifacts: '产物：文件、分支、URL、ID，带路径。',
      pending: '每个未完成项（在跑的 agent、待批准草稿、等外部回复）及回报方式。',
      done: '值得一提的已完成工作。',
      drop: '明确丢弃的支线。',
      lessons: '试过不行的做法及原因，每条一行，免得重试。',
      language: '本会话在用的语言约定：{"chat": "<用户设定的对话语言>", "outputs": ["<每个渠道一条：代码、commit、PR、spec、对外文字>"]}。',
      keep_skills: '压缩后仍要继续的 skill 名。',
      drop_skills: '已完成的 skill 名。',
    },
  },
};

/**
 * Strings for one UI language.
 * @param {string} language - 'en' or 'zh'.
 * @returns {object} string table.
 */
export function strings(language) {
  return STRINGS[language === 'zh' ? 'zh' : 'en'];
}
