/**
 * 修复台账 —— 工单、复发核验与待修清单收敛。
 *
 * ## 为什么需要它
 *
 * `/fixprompt` 只产出提示词，产出之后就**断了线**：谁修了、修没修好、
 * 待修清单里那条还算不算数，全无线索。本模块把这条线接上：
 *
 *   fixprompt 生成 → 记一张工单（时刻 T + 当时的计数）
 *        ↓
 *   T 之后用**同一套诊断逻辑**只看新记录 → 数它还复发几次
 *        ↓
 *   复发 0 次且观察窗口足够 → 从待修清单移出（但留在台账里）
 *   复发 > 0 次            → **重新打开**，并标注「修过但没治好」
 *
 * ## 三条诚实纪律（写进代码，不只在文档里）
 *
 * ① **「未再复发」不等于「根因已消除」**。窗口内 0 次只能说明这段时间
 *    没再触发；触发路径没被走到时，它同样会显示 0 次。因此状态用词是
 *    「未再复发」而不是「已修复」，且**观察窗口长度必须与结论一起显示**。
 *
 * ② **人工关闭是「声明」，不是「测量」**。`closedBy` 有值时状态单列
 *    `declared`，绝不与自动判定混为一谈。
 *
 * ③ **无工单的旧条目不得凭弱证据移出待修清单**。`lastTime` 很久以前
 *    只加一个 `stale` 标注（「近 N 小时未见，可能是修好了，也可能只是
 *    没触发」），条目**仍留在待修清单里**。宁可漏报，不可误报。
 *
 * ## 为什么复发核验要重跑 `diagnose()`
 *
 * 因为它保证「复发 0 次」与「当初那条 finding」用的是**同一套分组键、
 * 同一套档位规则**。若另写一套匹配逻辑，两处一旦漂移就会出现
 * 「诊断说还在、台账说修好了」这种最伤信任的分歧。
 *
 * @module dsh-efficiency/lib/fixes
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ledgerDir } from './ledger/store.js';
import { diagnose, SEVERITIES } from './diagnose.js';

export const FIXES_SCHEMA = 'dsh-efficiency/fixes/v1';
export const FIXES_FILE = 'fixes.v1.jsonl';

/** 观察窗口下限：短于此窗口的「0 次复发」不足以从待修清单移出。 */
export const DEFAULT_MIN_WINDOW_MS = 30 * 60 * 1000;

/** 无工单条目的「久未出现」标注阈值。只做标注，不移出清单。 */
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** 台账记录类型：append-only 两态，读取时折叠。 */
export const FIX_RECORD_TYPES = { open: 'open', close: 'close' };

/**
 * 条目状态。`authoritative` 表示「这条状态是测量出来的」，
 * 为 false 的都是「没有测量支撑，只是声明或信息不足」。
 */
export const FIX_STATES = {
  recurring: { label: '修过仍复发', authoritative: true, basis: 'recurrence-window' },
  resolved: { label: '未再复发', authoritative: true, basis: 'recurrence-window' },
  watching: { label: '观察中（窗口不足）', authoritative: false, basis: 'insufficient-window' },
  declared: { label: '人工声明已修', authoritative: false, basis: 'user-declared' },
  superseded: { label: '已被新工单取代', authoritative: false, basis: 'superseded' },
  unticketed: { label: '未修过', authoritative: false, basis: 'no-ticket' },
  // 不是「还没修」，是「不该在本机修」——两者混在一个清单里就是按类别说谎。
  notFixable: { label: '不修（非本机问题）', authoritative: false, basis: 'owner-provider' },
};

/** 台账目录（默认与错误账本同目录——它们是同一件事的两半）。 */
export function fixesDir(dir) {
  return dir || ledgerDir();
}

export function fixesPath(dir) {
  return join(fixesDir(dir), FIXES_FILE);
}

/** 提示词指纹：证明「这份提示词」确实是这张工单生成的。 */
export function promptHash(text) {
  return createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 12);
}

/** finding 的稳定键 —— 与 `diagnose()` 的合并键**逐字一致**。 */
export function findingKey(f) {
  return `${f.code}|${f.subject.kind}:${f.subject.name}`;
}

function sameFinding(f, tk) {
  return f.code === tk.code && f.subject.kind === tk.subject.kind && f.subject.name === tk.subject.name;
}

function newId(now) {
  return `fix-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 由一条 finding 造工单。
 *
 * @param {object} p
 * @param {object} p.finding     `diagnose()` 产出的 finding
 * @param {string} [p.prompt]    实际交给用户的提示词全文（取指纹 + 长度）
 * @param {string} [p.by]        触发方：ui / cli / rpc / agent / adopt
 * @param {number} [p.windowSince] 生成时的诊断窗口起点（复算用）
 * @param {number} [p.minCount]  生成时的 minCount（复算用）
 * @param {number} [p.now]
 */
export function makeTicket({ finding, prompt, by = 'rpc', windowSince = 0, minCount = 3, now = Date.now() }) {
  return {
    v: 1,
    t: FIX_RECORD_TYPES.open,
    id: newId(now),
    at: now,
    by,
    code: finding.code,
    severity: finding.severity,
    subject: { kind: finding.subject.kind, name: finding.subject.name },
    count: finding.count,
    sessionCount: finding.sessionCount,
    firstTime: finding.firstTime,
    lastTime: finding.lastTime,
    message: String(finding.message ?? '').slice(0, 300),
    fixHint: finding.fixHint,
    promptChars: prompt ? String(prompt).length : 0,
    promptHash: prompt ? promptHash(prompt) : undefined,
    windowSince: windowSince || undefined,
    minCount,
    basis: by === 'adopt' ? 'adopted-by-user' : 'generated-fix-prompt',
  };
}

export async function appendFix(rec, dir) {
  const d = fixesDir(dir);
  await mkdir(d, { recursive: true });
  await appendFile(fixesPath(d), `${JSON.stringify(rec)}\n`, 'utf8');
  return rec;
}

/**
 * 开一张工单，并**保证同一 finding 只有一张在用工单**。
 *
 * 为什么要取代而不是并存：同一 key 有两张工单时，「修后有没有再复发」
 * 就有两个分界线，答案会互相矛盾（实测踩到：旧工单说「仍复发」、新工单说
 * 「未再复发」，页面上显示哪条取决于遍历顺序）。工单的语义是
 * 「我最近一次动手是在什么时候」，所以只保留最新那张。
 *
 * 被取代的工单**不删**（历史照留），而是补一条 `by:'supersede'` 的关闭记录；
 * 这类关闭是**程序行为**，不是人工声明，故 `buildOpenList` 不把它算进 `declared`。
 *
 * @returns {{ticket: object, superseded: string[]}}
 */
export async function openTicket({ finding, prompt, by = 'rpc', windowSince = 0, minCount = 3, now = Date.now() }, dir) {
  const ticket = makeTicket({ finding, prompt, by, windowSince, minCount, now });
  const key = findingKey(ticket);
  const superseded = [];
  try {
    const j = await readFixes(dir);
    for (const old of j.tickets) {
      if (old.id === ticket.id) continue;
      if (old.closedAt) continue;
      if (`${old.code}|${old.subject?.kind}:${old.subject?.name}` !== key) continue;
      await appendFix({
        v: 1, t: FIX_RECORD_TYPES.close, id: old.id, at: now, by: 'supersede',
        note: `被新工单 ${ticket.id} 取代（同一故障重新生成修复提示词）`,
      }, dir);
      superseded.push(old.id);
    }
  } catch { /* 读不到旧台账不应阻止开新单 */ }
  await appendFix(ticket, dir);
  return { ticket, superseded };
}

/**
 * 读台账并折叠：`open` 建条，`close` 给已有条目打上关闭标记。
 * 孤儿 close（找不到对应 open）**不丢**，单独报出来——那是数据损坏的信号。
 */
export async function readFixes(dir) {
  const d = fixesDir(dir);
  let text;
  try {
    text = await readFile(fixesPath(d), 'utf8');
  } catch {
    return { tickets: [], badLines: 0, orphans: [], existed: false, dir: d };
  }
  const tickets = new Map();
  const orphans = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let rec;
    try {
      rec = JSON.parse(s);
    } catch {
      badLines += 1;
      continue;
    }
    if (!rec || typeof rec !== 'object') { badLines += 1; continue; }
    if (rec.t === FIX_RECORD_TYPES.close) {
      const tk = tickets.get(rec.id);
      if (!tk) { orphans.push(rec); continue; }
      tk.closedAt = rec.at;
      tk.closedBy = rec.by;
      tk.closeNote = rec.note;
      continue;
    }
    if (rec.t !== FIX_RECORD_TYPES.open || !rec.id) { badLines += 1; continue; }
    if (!tickets.has(rec.id)) tickets.set(rec.id, { ...rec });
  }
  const list = [...tickets.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return { tickets: list, badLines, orphans, existed: true, dir: d };
}

export async function closeTicket(id, { by = 'user', note, now = Date.now() } = {}, dir) {
  if (!id) throw new Error('closeTicket 需要 id');
  // 先看这个 id 有没有对应的 open —— 没有就是孤儿。
  // 孤儿**照样写入**（不丢数据，readFixes 会单列出来），但必须**当场如实报告**：
  // 只回「已关闭工单 X」会让用户以为关掉了一条真实工单。
  let matched = false;
  try {
    const j = await readFixes(dir);
    matched = j.tickets.some((t) => t.id === id);
  } catch { /* 台账不可读不是关闭动作的失败原因 */ }
  const rec = await appendFix({ v: 1, t: FIX_RECORD_TYPES.close, id, at: now, by, note }, dir);
  return { ...rec, matched };
}

/**
 * 人工认领：为**已经修过但没有工单**的旧条目补一张。
 * `at` 是「你动手修的时刻」，复发核验从它开始算。
 * basis 记为 `adopted-by-user` —— 时刻是声明，不是测量。
 */
export async function adoptTicket({ code, subject, at, by = 'user', note, now = Date.now() }, dir) {
  if (!code || !subject?.kind || !subject?.name) {
    throw new Error('adoptTicket 需要 code 与 subject.{kind,name}');
  }
  if (!Number.isFinite(at) || at <= 0) throw new Error('adoptTicket 需要合法的 at（毫秒时间戳）');
  const rec = {
    v: 1,
    t: FIX_RECORD_TYPES.open,
    id: newId(now),
    at,
    adoptedAt: now,
    by,
    code,
    severity: undefined,
    subject: { kind: subject.kind, name: subject.name },
    count: undefined,
    sessionCount: undefined,
    message: note ? String(note).slice(0, 300) : undefined,
    basis: 'adopted-by-user',
  };
  return appendFix(rec, dir);
}

/**
 * 复发核验：把工单时刻之后的记录**单独喂给 `diagnose()`**，
 * 看同一条 finding 还在不在、还在几次。
 *
 * ⚠ `minCount: 1` 与 `topK: Infinity` 是必须的 —— 复发的第一条记录
 * 也要能看见，且不能被每档截断吃掉。否则「0 次复发」会变成
 * 「因为被过滤了所以看不见」的假结论。
 */
export function verifyTicket(ticket, records, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const minWindowMs = Number.isFinite(opts.minWindowMs) ? opts.minWindowMs : DEFAULT_MIN_WINDOW_MS;
  const windowMs = Math.max(0, now - (ticket.at ?? now));

  const after = records.filter((r) => (r?.time ?? 0) > (ticket.at ?? 0));
  const d2 = diagnose(after, { since: 0, minCount: 1, topK: Number.MAX_SAFE_INTEGER, monitor: { events: [] } });
  const hit = [...(d2.fixable ?? []), ...(d2.notFixable ?? [])].find((f) => sameFinding(f, ticket));

  const recurred = hit?.count ?? 0;
  let state;
  if (ticket.closedAt && ticket.closedBy === 'supersede') state = 'superseded';
  else if (ticket.closedAt) state = 'declared';
  else if (recurred > 0) state = 'recurring';
  else if (windowMs < minWindowMs) state = 'watching';
  else state = 'resolved';

  const meta = FIX_STATES[state];
  return {
    id: ticket.id,
    at: ticket.at,
    by: ticket.by,
    adopted: ticket.basis === 'adopted-by-user',
    code: ticket.code,
    severity: ticket.severity,
    subject: ticket.subject,
    countAtTicket: ticket.count,
    sessionCountAtTicket: ticket.sessionCount,
    promptHash: ticket.promptHash,
    state,
    stateLabel: meta.label,
    authoritative: meta.authoritative,
    basis: meta.basis,
    recurred,
    lastRecurAt: hit?.lastTime,
    recurredSessions: hit?.sessionCount ?? 0,
    windowMs,
    windowLabel: windowLabel(windowMs),
    minWindowMs,
    closedAt: ticket.closedAt,
    closedBy: ticket.closedBy,
    closeNote: ticket.closeNote,
    note: recurrenceNote(state, recurred, windowMs, minWindowMs),
  };
}

function windowLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const m = Math.floor(ms / 60000);
  if (m < 1) return '不到 1 分钟';
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h} 小时 ${rm} 分钟` : `${h} 小时`;
  const d = Math.floor(h / 24);
  return `${d} 天 ${h % 24} 小时`;
}

function recurrenceNote(state, recurred, windowMs, minWindowMs) {
  const w = windowLabel(windowMs);
  switch (state) {
    case 'declared':
      return '由人工声明为已修 —— **声明，不是测量**：本条目没有「修后未再复发」的证据支撑。';
    case 'superseded':
      return '同一故障重新生成过修复提示词，本工单已被更新的那张取代；历史保留，不参与当前判定。';
    case 'recurring':
      return `工单生成后仍复发 ${recurred} 次（观察 ${w}）——修过但没治好，已重新打开。`;
    case 'watching':
      return `工单生成后未再复发，但观察窗口仅 ${w}（下限 ${windowLabel(minWindowMs)}）——不足以判定，暂不移出待修清单。`;
    default:
      return `工单生成后 ${w} 内未再复发 —— 是**未再复发**，不等于根因已消除；触发路径没被走到时同样会显示 0 次。`;
  }
}

export function verifyAll(tickets, records, opts = {}) {
  return tickets.map((t) => verifyTicket(t, records, opts));
}

/**
 * 待修清单收敛。
 *
 * `pending` = 从未修过（`unticketed`）+ 修过仍复发（`recurring`）。
 * 前者按「次数 × 会话数」排序（与诊断一致），后者**排在最前**——
 * 「我以为修好了结果没修好」是这里最值钱的一条信息。
 */
export function buildOpenList(diagnostics, verifications, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const minWindowMs = Number.isFinite(opts.minWindowMs) ? opts.minWindowMs : DEFAULT_MIN_WINDOW_MS;
  const staleAfterMs = Number.isFinite(opts.staleAfterMs) ? opts.staleAfterMs : STALE_AFTER_MS;

  // ⚠ 同一 key 可能有多张工单（历史遗留）。取值规则：**在用工单优先，其次最新**。
  //   不能直接让循环最后一个赢 —— `verifications` 是按 `at` 降序排的，最后一个是最旧的，
  //   那样「最近一次动手」反而会被最老的分界线覆盖（实测踩到过）。
  const byKey = new Map();
  for (const v of verifications) {
    const key = `${v.code}|${v.subject.kind}:${v.subject.name}`;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, v); continue; }
    const prevActive = !prev.closedAt;
    const curActive = !v.closedAt;
    if (prevActive && !curActive) continue;      // 已有一张在用工单，旧的已关闭 → 保留在用的
    if (!prevActive && curActive) { byKey.set(key, v); continue; }
    if ((v.at ?? 0) > (prev.at ?? 0)) byKey.set(key, v);  // 同为在用/同为关闭 → 取最新
  }

  const pending = [];
  const resolved = [];
  const watching = [];
  const declared = [];
  const superseded = [];
  const notFixable = [];

  // ⚠ 待修清单**只收 `fixable`**（P0–P2）。
  //   P3 是本插件自己判定「不是本机该修的」（供应商限流/配额/断流/网络，`fixable:false`），
  //   修复提示词里也专门列在「不要修」一节。把 2797 次 RATE_LIMIT 这类条目摆进「待修」
  //   是**按类别说谎**：它既修不了，又会把真正该修的 P1 挤到列表后面（实测 219 条待修里
  //   前几条全是 P3）。它们单列 `notFixable`，仍如实计数、仍可查，但不占待修位。
  const findings = diagnostics.fixable ?? [];
  for (const f of diagnostics.notFixable ?? []) {
    notFixable.push({
      key: findingKey(f),
      code: f.code,
      severity: f.severity,
      subject: { kind: f.subject.kind, name: f.subject.name },
      count: f.count,
      sessionCount: f.sessionCount,
      lastTime: f.lastTime,
      message: f.message,
      fixHint: f.fixHint,
      severityNote: f.evidence?.severityNote,
      state: 'notFixable',
      stateLabel: FIX_STATES.notFixable.label,
      authoritative: false,
      basis: FIX_STATES.notFixable.basis,
      ticket: null,
      recurred: 0,
      note: '档位判为「不是本机该修的」（供应商/外部服务）—— 换路由或退避，不在本机修。',
    });
  }
  for (const f of findings) {
    const key = findingKey(f);
    const v = byKey.get(key);
    const age = f.lastTime ? now - f.lastTime : undefined;
    const stale = v ? false : Number.isFinite(age) && age > staleAfterMs;

    const item = {
      key,
      code: f.code,
      severity: f.severity,
      subject: { kind: f.subject.kind, name: f.subject.name },
      count: f.count,
      sessionCount: f.sessionCount,
      firstTime: f.firstTime,
      lastTime: f.lastTime,
      message: f.message,
      fixHint: f.fixHint,
      severityNote: f.evidence?.severityNote,
      stale,
      staleNote: stale
        ? `近 ${windowLabel(age)} 未见新记录 —— **可能是修好了，也可能只是这条路径没被走到**；无工单支撑，故仍留在待修清单。`
        : undefined,
    };

    if (!v) {
      pending.push({ ...item, state: 'unticketed', stateLabel: FIX_STATES.unticketed.label,
        authoritative: false, basis: FIX_STATES.unticketed.basis,
        ticket: null, recurred: 0, note: '未生成过修复提示词（无工单），无「修后未再复发」的证据。' });
      continue;
    }

    const withTicket = {
      ...item,
      state: v.state,
      stateLabel: v.stateLabel,
      authoritative: v.authoritative,
      basis: v.basis,
      note: v.note,
      recurred: v.recurred,
      lastRecurAt: v.lastRecurAt,
      windowMs: v.windowMs,
      windowLabel: v.windowLabel,
      ticket: {
        id: v.id,
        at: v.at,
        by: v.by,
        adopted: v.adopted,
        countAtTicket: v.countAtTicket,
        sessionCountAtTicket: v.sessionCountAtTicket,
        promptHash: v.promptHash,
        closedAt: v.closedAt,
        closedBy: v.closedBy,
        closeNote: v.closeNote,
      },
    };

    if (v.state === 'recurring') pending.unshift(withTicket);
    else if (v.state === 'resolved') resolved.push(withTicket);
    else if (v.state === 'watching') {
      // ⚠ 观察窗口不足 ⇒ **仍留在待修清单**。
      // 刚开单 1 秒、0 次复发，不等于修好了；把它移出待修清单就是拿
      // 「还没看够」当「已经好了」——正是本功能最该避免的谎报。
      watching.push(withTicket);
      pending.push(withTicket);
    } else if (v.state === 'superseded') {
      // 程序性取代：既不算人工声明，也不占待修位（有更新的工单代表它）。
      superseded.push(withTicket);
    } else declared.push(withTicket);
  }

  // 复发项已置顶，其余按「次数 × 会话数」降序
  const tail = pending.filter((x) => x.state !== 'recurring')
    .sort((a, b) => (b.count * Math.max(1, b.sessionCount)) - (a.count * Math.max(1, a.sessionCount)));
  const recurring = pending.filter((x) => x.state === 'recurring')
    .sort((a, b) => b.recurred - a.recurred);
  const ordered = [...recurring, ...tail];

  return {
    schema: FIXES_SCHEMA,
    generatedAt: now,
    minWindowMs,
    staleAfterMs,
    counts: {
      pending: ordered.length,
      recurring: recurring.length,
      watching: watching.length,
      unticketed: ordered.length - recurring.length - watching.length,
      resolved: resolved.length,
      declared: declared.length,
      superseded: superseded.length,
      notFixable: notFixable.length,
      tickets: verifications.length,
      activeTickets: byKey.size,
    },
    pending: ordered,
    resolved,
    watching,
    declared,
    superseded,
    /** 档位判为「不是本机该修的」—— 单列，不占待修位。 */
    notFixable,
    /** 无工单且久未见 —— 仅提示，**未从 pending 移出**。 */
    staleUnticketed: ordered.filter((x) => x.stale),
  };
}

/** 一行摘要，供 RPC / 客户端顶栏用。 */
export function summarizeOpenList(report) {
  const c = report?.counts ?? {};
  const parts = [`待修 ${c.pending ?? 0}`];
  if (c.recurring) parts.push(`其中修过仍复发 ${c.recurring}`);
  if (c.watching) parts.push(`已开单待观察 ${c.watching}`);
  if (c.resolved) parts.push(`未再复发 ${c.resolved}`);
  if (c.declared) parts.push(`人工声明 ${c.declared}`);
  if (c.notFixable) parts.push(`不修（非本机问题）${c.notFixable}`);
  return parts.join(' · ');
}

/** CLI 文本渲染。窗口长度与结论**必须同屏**。 */
export function renderFixes(report, opts = {}) {
  const maxItems = Number.isFinite(opts.maxItems) ? opts.maxItems : 20;
  const L = [];
  const c = report.counts;
  L.push(`修复台账　schema=${report.schema}`);
  L.push(`待修 ${c.pending}（修过仍复发 ${c.recurring} · 已开单待观察 ${c.watching} · 未修过 ${c.unticketed}）　未再复发（已移出）${c.resolved}　人工声明 ${c.declared}　不修（非本机问题）${c.notFixable ?? 0}　工单 ${c.tickets} 张（在用 ${c.activeTickets ?? '—'}）`);
  L.push(`观察窗口下限 ${windowLabel(report.minWindowMs)}　久未见阈值 ${windowLabel(report.staleAfterMs)}`);
  L.push('');

  const block = (title, list, hint) => {
    if (!list.length) return;
    L.push(`▸ ${title}（${list.length}）`);
    if (hint) L.push(`  ${hint}`);
    for (const it of list.slice(0, maxItems)) {
      L.push(`  ${it.severity} ${it.code}　${it.subject.kind}:${it.subject.name}　${it.count} 次 / ${it.sessionCount} 会话`);
      L.push(`    ${it.stateLabel}　${it.note}`);
      if (it.ticket) L.push(`    工单 ${it.ticket.id}　${new Date(it.ticket.at).toISOString()}　by=${it.ticket.by}${it.ticket.promptHash ? `　prompt=${it.ticket.promptHash}` : ''}`);
      if (it.fixHint) L.push(`    建议：${it.fixHint}`);
    }
    if (list.length > maxItems) L.push(`  …另有 ${list.length - maxItems} 条`);
    L.push('');
  };

  block('待修（修过仍复发 — 最优先）', report.pending.filter((x) => x.state === 'recurring'));
  block('待修（已开单，观察窗口不足 —— 还不能说修好了）', report.pending.filter((x) => x.state === 'watching'),
    `窗口下限 ${windowLabel(report.minWindowMs)}；窗口内 0 次复发也**不足以**判定修好，需等满窗口。`);
  block('待修（未修过）', report.pending.filter((x) => x.state === 'unticketed'));
  block('未再复发（已从待修清单移出）', report.resolved,
    '「未再复发」≠「根因已消除」：触发路径没被走到时同样显示 0 次。');
  block('人工声明已修（声明，非测量）', report.declared);
  block('已被新工单取代（程序行为，不参与判定）', report.superseded ?? []);
  block('不修（非本机该修的 —— 供应商/外部服务，换路由或退避即可）', report.notFixable ?? [],
    '它们**不在待修清单里**：档位判定 `fixable:false`，本机修不了，摆进「待修」只会把真正该修的条目挤到后面。');

  if (report.staleUnticketed.length) {
    L.push(`▸ 无工单但久未见（${report.staleUnticketed.length}）—— 仅提示，**仍在待修清单里**`);
    for (const it of report.staleUnticketed.slice(0, maxItems)) {
      L.push(`  ${it.severity} ${it.code}　${it.subject.kind}:${it.subject.name}　${it.count} 次　最后 ${it.lastTime ? new Date(it.lastTime).toISOString() : '—'}`);
    }
  }
  return L.join('\n');
}

export { SEVERITIES };
