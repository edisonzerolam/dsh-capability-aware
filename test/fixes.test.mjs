// dsh-efficiency · v0.11.0 修复台账验收测试（node --test，零外部依赖）
//
// 覆盖用户 m01781 的需求：
//   「我已经使用里面的修复功能生成了修复提示词并执行过修复，
//     能增加检索到修复记录并更新待修复清单的功能吗」
//   ⇒ ① 检索修复记录（工单：何时为哪条 finding 生成过提示词）
//      ② 待修清单随修复结果收敛（修好的移出、修了没好的重新打开）
//
// 本文件重点锁死**三条诚实纪律**——它们一旦破掉，这个功能就会变成
// 「安慰性看板」（把「还没看够」显示成「已修好」）：
//   ① 「未再复发」≠「根因已消除」，且**窗口长度必须与结论同屏**；
//   ② 观察窗口不足时**不得**从待修清单移出（watching 仍在 pending）；
//   ③ 人工关闭是**声明**不是测量，必须单列，不得混进「已修好」。
//
// 隔离纪律：一律用临时目录显式传 `dir`，绝不读写真实 ~/.dsh/data。
//
// ⚠ 跑法必须是**文件形态**：`node --test test/fixes.test.mjs`

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const mod = (p) => pathToFileURL(path.join(root, 'lib', p)).href;

const {
  FIXES_SCHEMA, FIXES_FILE, DEFAULT_MIN_WINDOW_MS, STALE_AFTER_MS,
  FIX_RECORD_TYPES, FIX_STATES,
  fixesDir, fixesPath, promptHash, findingKey,
  makeTicket, openTicket, appendFix, readFixes, closeTicket, adoptTicket,
  verifyTicket, verifyAll, buildOpenList, summarizeOpenList, renderFixes,
} = await import(mod('fixes.js'));
const { diagnose } = await import(mod('diagnose.js'));
const { buildFixPrompt, pickFixables } = await import(mod('fixprompt.js'));

// ── 测试脚手架 ────────────────────────────────────────────────────
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fixes-'));

/** 造一条**形态与真实账本一致**的记录（字段取自 lib/ledger/extract.js:196-235）。 */
const mkRec = (o) => ({
  v: 1,
  time: o.time,
  session: o.session ?? 'session-A',
  kind: o.kind ?? 'tool',
  code: o.code,
  tool: o.tool,
  skill: o.skill,
  object: o.object,
  owner: o.owner ?? 'local',
  message: o.message ?? 'boom',
  fixHint: o.fixHint,
});

/** 一个假 finding，形状与 diagnose() 的产出一致。 */
const mkFinding = (o) => ({
  code: o.code,
  severity: o.severity ?? 'P1',
  subject: { kind: o.kind ?? 'tool', name: o.name ?? o.tool ?? 'edit' },
  count: o.count ?? 10,
  sessionCount: o.sessionCount ?? 3,
  firstTime: o.firstTime ?? 1000,
  lastTime: o.lastTime ?? 2000,
  message: o.message ?? 'boom',
  fixHint: o.fixHint ?? '先 read 再 edit',
  evidence: { basis: 'error-ledger-records', severityNote: '本机可修' },
});

const MIN = 60_000;      // 测试用短窗口，避免真的等 30 分钟
const NOW = 1_700_000_000_000;

// ── 1. 常量与 schema ──────────────────────────────────────────────
test('修复台账：schema 版本化且与诊断信封同族', () => {
  assert.equal(FIXES_SCHEMA, 'dsh-efficiency/fixes/v1');
  assert.equal(FIXES_FILE, 'fixes.v1.jsonl');
  assert.match(FIXES_SCHEMA, /^dsh-efficiency\/[a-z]+\/v\d+$/);
});

test('修复台账：状态表完备，且「权威性」标注与语义一致', () => {
  for (const s of ['recurring', 'resolved', 'watching', 'declared', 'superseded', 'unticketed']) {
    assert.ok(FIX_STATES[s], `缺状态 ${s}`);
    assert.equal(typeof FIX_STATES[s].label, 'string');
    assert.equal(typeof FIX_STATES[s].basis, 'string');
  }
  // 只有「按窗口测出来的」才算权威；声明与信息不足一律 false
  assert.equal(FIX_STATES.recurring.authoritative, true);
  assert.equal(FIX_STATES.resolved.authoritative, true);
  assert.equal(FIX_STATES.watching.authoritative, false, '窗口不足不是测量');
  assert.equal(FIX_STATES.declared.authoritative, false, '人工声明不是测量');
  assert.equal(FIX_STATES.unticketed.authoritative, false);
});

test('修复台账：窗口下限与久未见阈值是具名常量，不是散落的魔法数', () => {
  assert.equal(DEFAULT_MIN_WINDOW_MS, 30 * 60 * 1000);
  assert.equal(STALE_AFTER_MS, 6 * 60 * 60 * 1000);
});

// ── 2. 键与指纹 ──────────────────────────────────────────────────
test('修复台账：findingKey 必须与 diagnose() 的合并键**逐字一致**', () => {
  // 这条不变量一旦破掉，工单与 finding 就配不上对，复发核验会永远报「0 次」。
  const f = mkFinding({ code: 'FS_EDIT_NOT_FOUND', kind: 'tool', name: 'edit' });
  assert.equal(findingKey(f), 'FS_EDIT_NOT_FOUND|tool:edit');

  // 用真实 diagnose() 产出的 finding 再验一次（不靠手写字符串）
  const records = [1, 2, 3].map((i) => mkRec({ time: NOW + i, code: 'FS_EDIT_NOT_FOUND', tool: 'edit' }));
  const d = diagnose(records, { minCount: 1 });
  const got = d.fixable[0];
  assert.equal(findingKey(got), `${got.code}|${got.subject.kind}:${got.subject.name}`);
});

test('修复台账：promptHash 稳定、定长，且不同正文不同指纹', () => {
  const a = promptHash('hello');
  assert.equal(a.length, 12);
  assert.equal(a, promptHash('hello'));
  assert.notEqual(a, promptHash('hello2'));
  assert.equal(promptHash('').length, 12);
  assert.equal(promptHash(undefined).length, 12);
});

// ── 3. 读写与折叠 ────────────────────────────────────────────────
test('修复台账：开单 → 读回，字段与工单语义完整', async () => {
  const dir = tmp();
  const f = mkFinding({ code: 'X', count: 7, sessionCount: 2 });
  const tk = makeTicket({ finding: f, prompt: 'P', by: 'cli', windowSince: 123, minCount: 4, now: NOW });
  await appendFix(tk, dir);

  const j = await readFixes(dir);
  assert.equal(j.existed, true);
  assert.equal(j.tickets.length, 1);
  assert.equal(j.badLines, 0);
  const got = j.tickets[0];
  assert.equal(got.id, tk.id);
  assert.equal(got.code, 'X');
  assert.deepEqual(got.subject, { kind: 'tool', name: 'edit' });
  assert.equal(got.count, 7);
  assert.equal(got.sessionCount, 2);
  assert.equal(got.windowSince, 123);
  assert.equal(got.minCount, 4);
  assert.equal(got.promptHash, promptHash('P'));
  assert.equal(got.basis, 'generated-fix-prompt');
  assert.equal(got.at, NOW);
});

test('修复台账：目录与文件名可预测（与错误账本同目录）', () => {
  assert.equal(fixesDir('/tmp/x'), '/tmp/x');
  assert.equal(fixesPath('/tmp/x'), path.join('/tmp/x', FIXES_FILE));
  const d = fixesDir();
  assert.ok(typeof d === 'string' && d.length > 0, '默认目录应回落到账本目录');
});

test('修复台账：close 折叠到对应工单，且保留备注与关闭时刻', async () => {
  const dir = tmp();
  const tk = makeTicket({ finding: mkFinding({ code: 'Y' }), now: NOW });
  await appendFix(tk, dir);
  const r = await closeTicket(tk.id, { by: 'user', note: '我改完了', now: NOW + 100 }, dir);
  assert.equal(r.matched, true);

  const j = await readFixes(dir);
  assert.equal(j.tickets.length, 1, 'close 不应新建工单');
  assert.equal(j.tickets[0].closedAt, NOW + 100);
  assert.equal(j.tickets[0].closedBy, 'user');
  assert.equal(j.tickets[0].closeNote, '我改完了');
});

test('修复台账：孤儿 close **不丢**，单列报出（那是数据损坏的信号）', async () => {
  const dir = tmp();
  const r = await closeTicket('fix-nope', { by: 'user', now: NOW }, dir);
  assert.equal(r.matched, false, '关闭不存在的工单必须如实回报 matched:false');
  const j = await readFixes(dir);
  assert.equal(j.tickets.length, 0);
  assert.equal(j.orphans.length, 1);
  assert.equal(j.orphans[0].id, 'fix-nope');
});

test('修复台账：坏行计入 badLines，不静默吞掉也不炸掉整个读取', async () => {
  const dir = tmp();
  const tk = makeTicket({ finding: mkFinding({ code: 'Z' }), now: NOW });
  await appendFix(tk, dir);
  fs.appendFileSync(fixesPath(dir), 'not json at all\n{"t":"open"}\n', 'utf8');
  const j = await readFixes(dir);
  assert.equal(j.tickets.length, 1, '合法工单仍应读出');
  assert.ok(j.badLines >= 1, '坏行必须被计数');
});

test('修复台账：目录不存在时返回空集而非抛错', async () => {
  const j = await readFixes(path.join(tmp(), 'does-not-exist'));
  assert.equal(j.existed, false);
  assert.deepEqual(j.tickets, []);
  assert.equal(j.badLines, 0);
});

// ── 4. 复发核验（本功能的核心测量） ──────────────────────────────
test('复发核验：工单时刻之后仍有记录 ⇒ recurring（修过但没治好）', () => {
  const tk = makeTicket({ finding: mkFinding({ code: 'A', tool: 'edit' }), now: NOW });
  const records = [
    mkRec({ time: NOW - 1000, code: 'A', tool: 'edit' }),
    mkRec({ time: NOW + 1000, code: 'A', tool: 'edit' }),
    mkRec({ time: NOW + 2000, code: 'A', tool: 'edit' }),
  ];
  const v = verifyTicket(tk, records, { minWindowMs: MIN, now: NOW + 5 * MIN });
  assert.equal(v.state, 'recurring');
  assert.equal(v.recurred, 2, '只数工单时刻之后的');
  assert.match(v.note, /仍复发/);
});

test('复发核验：工单时刻之后 0 条且窗口已满 ⇒ resolved（未再复发）', () => {
  const tk = makeTicket({ finding: mkFinding({ code: 'B' }), now: NOW });
  const records = [mkRec({ time: NOW - 5000, code: 'B' })];
  const v = verifyTicket(tk, records, { minWindowMs: MIN, now: NOW + 10 * MIN });
  assert.equal(v.state, 'resolved');
  assert.equal(v.recurred, 0);
  // 诚实纪律①：结论里必须明写「不等于根因已消除」
  assert.match(v.note, /未再复发/);
  assert.match(v.note, /不等于根因已消除|触发路径/);
});

test('复发核验：窗口不足 ⇒ watching，**不是** resolved', () => {
  const tk = makeTicket({ finding: mkFinding({ code: 'C' }), now: NOW });
  const v = verifyTicket(tk, [], { minWindowMs: MIN, now: NOW + 10 });
  assert.equal(v.state, 'watching');
  assert.equal(v.authoritative, false);
  assert.match(v.note, /窗口/);
});

test('复发核验：人工关闭 ⇒ declared，且明写「声明，不是测量」', () => {
  const tk = { ...makeTicket({ finding: mkFinding({ code: 'D' }), now: NOW }), closedAt: NOW + 5, closedBy: 'user' };
  const v = verifyTicket(tk, [], { minWindowMs: MIN, now: NOW + 10 * MIN });
  assert.equal(v.state, 'declared');
  assert.equal(v.authoritative, false);
  assert.match(v.note, /声明，不是测量|声明不是测量/);
});

test('复发核验：程序性取代（by=supersede）不得被当成人工声明', () => {
  const tk = { ...makeTicket({ finding: mkFinding({ code: 'E' }), now: NOW }), closedAt: NOW + 5, closedBy: 'supersede' };
  const v = verifyTicket(tk, [], { minWindowMs: MIN, now: NOW + 10 * MIN });
  assert.equal(v.state, 'superseded');
  assert.notEqual(v.state, 'declared');
  assert.equal(v.authoritative, false);
});

test('复发核验：单次复发也要看得见 —— 不能被 minCount 吃掉变成假「0 次」', () => {
  // ⚠ 这是本功能最危险的一类 bug：核验里若沿用诊断的 minCount=3，
  //   一条只复发 1 次的故障会被过滤掉，页面显示「未再复发」——**假结论**。
  const tk = makeTicket({ finding: mkFinding({ code: 'F', tool: 'edit' }), now: NOW });
  const records = [mkRec({ time: NOW + 1, code: 'F', tool: 'edit' })];
  const v = verifyTicket(tk, records, { minWindowMs: MIN, now: NOW + 10 * MIN });
  assert.equal(v.recurred, 1, '1 次复发必须被数到');
  assert.equal(v.state, 'recurring');

  // 反向自证：同一批记录若用默认 minCount=3 去诊断，确实看不见 —— 说明上面那条
  // 断言不是同义反复，而是真的在防一个会发生的漏判。
  const d = diagnose(records, { minCount: 3 });
  assert.equal(d.fixable.length + d.notFixable.length, 0, '对照组：默认阈值下确实看不见');
});

test('复发核验：主体或错误码不同 ⇒ 不算复发（不误判成同一个故障）', () => {
  const tk = makeTicket({ finding: mkFinding({ code: 'G', tool: 'edit' }), now: NOW });
  const records = [
    mkRec({ time: NOW + 1, code: 'G', tool: 'write' }),   // 同码不同工具
    mkRec({ time: NOW + 2, code: 'H', tool: 'edit' }),    // 同工具不同码
  ];
  const v = verifyTicket(tk, records, { minWindowMs: MIN, now: NOW + 10 * MIN });
  assert.equal(v.recurred, 0);
});

// ── 5. 待修清单收敛 ──────────────────────────────────────────────
test('待修清单：pending = 未修过 + 已开单待观察 + 修过仍复发', () => {
  const d = diagnose([
    ...[1, 2, 3].map((i) => mkRec({ time: NOW + i, code: 'UNFIXED', tool: 'edit' })),
    ...[1, 2, 3].map((i) => mkRec({ time: NOW + i, code: 'WATCH', tool: 'read' })),
    ...[1, 2, 3].map((i) => mkRec({ time: NOW + i, code: 'RECUR', tool: 'write' })),
    ...[1, 2, 3].map((i) => mkRec({ time: NOW + i, code: 'DONE', tool: 'glob' })),
  ], { minCount: 1, since: 0 });

  const tickets = [
    // WATCH 的工单刚开（窗口 1 秒 < 下限）⇒ watching；DONE 的工单开在记录之后且窗口已满 ⇒ resolved
    makeTicket({ finding: mkFinding({ code: 'WATCH', tool: 'read' }), now: NOW + 10 * MIN - 1000 }),
    makeTicket({ finding: mkFinding({ code: 'RECUR', tool: 'write' }), now: NOW }),
    makeTicket({ finding: mkFinding({ code: 'DONE', tool: 'glob' }), now: NOW + 1000 }),
  ];
  // RECUR 在工单后又出现；DONE 之后一条都没有
  const records = [
    ...[1, 2, 3].map((i) => mkRec({ time: NOW + i, code: 'UNFIXED', tool: 'edit' })),
    ...[1, 2, 3].map((i) => mkRec({ time: NOW + i, code: 'WATCH', tool: 'read' })),
    ...[1, 2, 3].map((i) => mkRec({ time: NOW + i, code: 'RECUR', tool: 'write' })),
    ...[1, 2, 3].map((i) => mkRec({ time: NOW + i, code: 'DONE', tool: 'glob' })),
    mkRec({ time: NOW + 100, code: 'RECUR', tool: 'write' }),
  ];
  const vs = verifyAll(tickets, records, { minWindowMs: MIN, now: NOW + 10 * MIN });
  const rep = buildOpenList(d, vs, { minWindowMs: MIN, now: NOW + 10 * MIN });

  const states = Object.fromEntries(rep.pending.map((x) => [x.code, x.state]));
  assert.equal(states.UNFIXED, 'unticketed');
  assert.equal(states.WATCH, 'watching');
  assert.equal(states.RECUR, 'recurring');
  assert.equal(rep.pending.some((x) => x.code === 'DONE'), false, '未再复发必须移出待修清单');
  assert.equal(rep.resolved.length, 1);
  assert.equal(rep.counts.pending, 3);
});

test('待修清单：档位判为「不是本机该修的」(P3) **不得**混进待修', () => {
  // 真机实测：219 条待修里前几条全是 P3 RATE_LIMIT / SERVER / TIMEOUT —— 把「修不了」
  // 的东西摆进「待修」，既按类别说谎，又把真正该修的 P1 挤到列表后面。
  const d = diagnose([
    ...[1, 2, 3].map((i) => mkRec({ time: NOW + i, code: 'FS_EDIT_NOT_FOUND', tool: 'edit' })),
    ...[1, 2, 3].map((i) => mkRec({ time: NOW + i, code: 'RATE_LIMIT' })),
  ], { minCount: 1, since: 0 });
  assert.equal(d.notFixable.length, 1, '前置：RATE_LIMIT 必须被判为不可修');
  const rep = buildOpenList(d, [], { minWindowMs: MIN, now: NOW });
  assert.equal(rep.pending.length, 1, '待修清单只收 fixable');
  assert.equal(rep.pending[0].code, 'FS_EDIT_NOT_FOUND');
  assert.equal(rep.counts.notFixable, 1, '不修条目仍须如实计数（不得静默丢弃）');
  assert.equal(rep.notFixable[0].code, 'RATE_LIMIT');
  assert.equal(rep.notFixable[0].state, 'notFixable');
  assert.match(rep.notFixable[0].note, /不是本机该修的|换路由或退避/);
  // 渲染：必须与待修分开，且说明为什么不在待修里
  const txt = renderFixes(rep);
  assert.match(txt, /不修（非本机该修的/);
  assert.match(txt, /不在待修清单里/);
  // 摘要里也要看得见，否则看板会让人以为「待修 = 全部问题」
  assert.match(summarizeOpenList(rep), /不修（非本机问题）1/);
});

test('待修清单：观察窗口不足**不得**移出（这是最容易被做成假看板的一步）', () => {
  const d = diagnose([1, 2, 3].map((i) => mkRec({ time: NOW + i, code: 'W', tool: 'edit' })), { minCount: 1, since: 0 });
  const tk = makeTicket({ finding: mkFinding({ code: 'W', tool: 'edit' }), now: NOW });
  const vs = verifyAll([tk], d.records ?? [], { minWindowMs: MIN, now: NOW + 10 });
  const rep = buildOpenList(d, vs, { minWindowMs: MIN, now: NOW + 10 });
  assert.equal(rep.pending.length, 1, '刚开单 0 次复发 ≠ 修好了，必须仍在待修');
  assert.equal(rep.pending[0].state, 'watching');
  assert.equal(rep.resolved.length, 0);
  assert.equal(rep.watching.length, 1);
});

test('待修清单：修过仍复发排在最前（「以为修好了结果没好」最值钱）', () => {
  const d = diagnose([
    ...[1, 2, 3].map((i) => mkRec({ time: NOW + i, code: 'BIG', tool: 'read' })),
    ...[1, 2, 3].map((i) => mkRec({ time: NOW + i, code: 'REC', tool: 'write' })),
  ], { minCount: 1, since: 0 });
  const tk = makeTicket({ finding: mkFinding({ code: 'REC', tool: 'write' }), now: NOW });
  const records = [
    ...[1, 2, 3].map((i) => mkRec({ time: NOW + i, code: 'BIG', tool: 'read' })),
    mkRec({ time: NOW + 100, code: 'REC', tool: 'write' }),
  ];
  const vs = verifyAll([tk], records, { minWindowMs: MIN, now: NOW + 10 * MIN });
  const rep = buildOpenList(d, vs, { minWindowMs: MIN, now: NOW + 10 * MIN });
  assert.equal(rep.pending[0].code, 'REC', '复发项必须置顶');
});

test('待修清单：无工单且久未见 ⇒ 只加标注，**仍留在清单里**', () => {
  const d = diagnose([1, 2, 3].map((i) => mkRec({ time: NOW - 10 * 60 * 60 * 1000 + i, code: 'OLD', tool: 'edit' })), { minCount: 1, since: 0 });
  const rep = buildOpenList(d, [], { minWindowMs: MIN, staleAfterMs: 60 * 1000, now: NOW });
  assert.equal(rep.pending.length, 1, '无工单不得凭弱证据移出');
  assert.equal(rep.pending[0].stale, true);
  assert.match(rep.pending[0].staleNote, /可能是修好了|只是这条路径没被走到/);
  assert.equal(rep.staleUnticketed.length, 1);
});

test('待修清单：人工声明的条目单列，不得混进「已修好」', () => {
  const d = diagnose([1, 2, 3].map((i) => mkRec({ time: NOW + i, code: 'DEC', tool: 'edit' })), { minCount: 1, since: 0 });
  const tk = { ...makeTicket({ finding: mkFinding({ code: 'DEC', tool: 'edit' }), now: NOW }), closedAt: NOW + 1, closedBy: 'user' };
  const vs = verifyAll([tk], [], { minWindowMs: MIN, now: NOW + 10 * MIN });
  const rep = buildOpenList(d, vs, { minWindowMs: MIN, now: NOW + 10 * MIN });
  assert.equal(rep.declared.length, 1);
  assert.equal(rep.resolved.length, 0);
  assert.equal(rep.pending.some((x) => x.code === 'DEC'), false);
  assert.equal(rep.declared[0].authoritative, false);
});

test('待修清单：同一 key 多张工单时，**在用**的那张说话（不是最老的）', () => {
  // 踩过的真实 bug：byKey 用循环赋值，而 tickets 是按 at 降序排的，
  // 于是最后写入的是**最旧**的工单 —— 「最近一次动手」被最老的分界线覆盖。
  const d = diagnose([1, 2, 3].map((i) => mkRec({ time: NOW + i, code: 'K', tool: 'edit' })), { minCount: 1, since: 0 });
  const oldTk = { ...makeTicket({ finding: mkFinding({ code: 'K', tool: 'edit' }), now: NOW - 1000 }), closedAt: NOW, closedBy: 'supersede' };
  const newTk = makeTicket({ finding: mkFinding({ code: 'K', tool: 'edit' }), now: NOW });
  const records = [mkRec({ time: NOW - 500, code: 'K', tool: 'edit' })];   // 只在旧工单窗口内复发
  const vs = verifyAll([newTk, oldTk], records, { minWindowMs: MIN, now: NOW + 10 * MIN });
  const rep = buildOpenList(d, vs, { minWindowMs: MIN, now: NOW + 10 * MIN });
  assert.equal(rep.resolved.length, 1, '应按新工单（在用）的分界线判定为「未再复发」');
  assert.equal(rep.resolved[0].ticket.id, newTk.id);
  assert.equal(rep.resolved[0].recurred, 0, '新工单窗口内确实没有复发');
});

// ── 6. 开单取代 ──────────────────────────────────────────────────
test('开单：同一故障重新生成提示词时取代旧工单，且旧工单留痕（不删）', async () => {
  const dir = tmp();
  const f = mkFinding({ code: 'S', tool: 'edit' });
  const a = await openTicket({ finding: f, prompt: 'p1', by: 'cli', now: NOW }, dir);
  const b = await openTicket({ finding: f, prompt: 'p2', by: 'cli', now: NOW + 1000 }, dir);
  assert.deepEqual(b.superseded, [a.ticket.id]);

  const j = await readFixes(dir);
  assert.equal(j.tickets.length, 2, '历史工单必须保留');
  const oldOne = j.tickets.find((t) => t.id === a.ticket.id);
  assert.equal(oldOne.closedBy, 'supersede');
  assert.match(oldOne.closeNote, new RegExp(b.ticket.id));
  const newOne = j.tickets.find((t) => t.id === b.ticket.id);
  assert.equal(newOne.closedAt, undefined, '新工单必须是在用的');
});

test('开单：不同故障之间互不取代', async () => {
  const dir = tmp();
  const a = await openTicket({ finding: mkFinding({ code: 'P1', tool: 'edit' }), now: NOW }, dir);
  const b = await openTicket({ finding: mkFinding({ code: 'P2', tool: 'edit' }), now: NOW + 1 }, dir);
  const c = await openTicket({ finding: mkFinding({ code: 'P1', tool: 'write' }), now: NOW + 2 }, dir);
  assert.deepEqual(a.superseded, []);
  assert.deepEqual(b.superseded, []);
  assert.deepEqual(c.superseded, [], '同码不同主体不是同一故障');
});

test('开单：已人工关闭的工单不被新工单取代（声明应保留）', async () => {
  const dir = tmp();
  const f = mkFinding({ code: 'Q', tool: 'edit' });
  const a = await openTicket({ finding: f, now: NOW }, dir);
  await closeTicket(a.ticket.id, { by: 'user', now: NOW + 1 }, dir);
  const b = await openTicket({ finding: f, now: NOW + 2 }, dir);
  assert.deepEqual(b.superseded, [], '已关闭的不再取代');
  const j = await readFixes(dir);
  const oldOne = j.tickets.find((t) => t.id === a.ticket.id);
  assert.equal(oldOne.closedBy, 'user', '人工关闭记录不得被覆盖');
});

// ── 7. 人工认领 ──────────────────────────────────────────────────
test('人工认领：为历史修复补单，basis 标为声明而非测量', async () => {
  const dir = tmp();
  const rec = await adoptTicket({ code: 'R', subject: { kind: 'tool', name: 'edit' }, at: NOW, by: 'user', note: '我上周就改了', now: NOW + 5 }, dir);
  assert.equal(rec.basis, 'adopted-by-user');
  const j = await readFixes(dir);
  assert.equal(j.tickets.length, 1);
  assert.equal(j.tickets[0].at, NOW, '分界线必须是我说的动手时刻');
  assert.equal(j.tickets[0].adoptedAt, NOW + 5);
  const v = verifyTicket(j.tickets[0], [], { minWindowMs: MIN, now: NOW + 10 * MIN });
  assert.equal(v.adopted, true);
});

test('人工认领：缺参数或非法时刻一律抛错，不写脏数据', async () => {
  const dir = tmp();
  await assert.rejects(() => adoptTicket({ subject: { kind: 'tool', name: 'edit' }, at: NOW }, dir), /code/);
  await assert.rejects(() => adoptTicket({ code: 'R', at: NOW }, dir), /subject/);
  await assert.rejects(() => adoptTicket({ code: 'R', subject: { kind: 'tool', name: 'edit' }, at: NaN }, dir), /at/);
  await assert.rejects(() => adoptTicket({ code: 'R', subject: { kind: 'tool', name: 'edit' }, at: 0 }, dir), /at/);
  const j = await readFixes(dir);
  assert.equal(j.tickets.length, 0, '失败不得留下半条记录');
});

// ── 8. 呈现 ──────────────────────────────────────────────────────
test('渲染：窗口长度与结论必须同屏（否则「未再复发」会被读成「已修好」）', () => {
  const d = diagnose([1, 2, 3].map((i) => mkRec({ time: NOW - 1000, code: 'V', tool: 'edit' })), { minCount: 1, since: 0 });
  const tk = makeTicket({ finding: mkFinding({ code: 'V', tool: 'edit' }), now: NOW - 20 * MIN });
  const vs = verifyAll([tk], [], { minWindowMs: MIN, now: NOW });
  const rep = buildOpenList(d, vs, { minWindowMs: MIN, now: NOW });
  const text = renderFixes(rep);
  assert.match(text, /未再复发/);
  assert.match(text, /20 分钟|观察/, '结论旁边必须有窗口长度');
  assert.match(text, /不等于根因已消除|触发路径/, '必须点明这不是根因消除');
  assert.match(text, new RegExp(FIXES_SCHEMA.replace(/[/]/g, '\\/')));
});

test('渲染：空台账也要能出话，不能崩', () => {
  const text = renderFixes(buildOpenList({ fixable: [], notFixable: [] }, []));
  assert.equal(typeof text, 'string');
  assert.match(text, /待修 0/);
});

test('摘要：一行说清待修构成', () => {
  const s = summarizeOpenList({ counts: { pending: 12, recurring: 3, watching: 4, resolved: 5, declared: 1 } });
  assert.match(s, /待修 12/);
  assert.match(s, /仍复发 3/);
  assert.match(s, /待观察 4/);
});

// ── 9. 与诊断/提示词的接线 ───────────────────────────────────────
test('接线：开工单的条目与提示词正文列出的条目**必须是同一批**', () => {
  // 若两处各写一遍 slice，一旦漂移就会出现「台账跟踪的和提示词里写的不是同一条」。
  const findings = Array.from({ length: 20 }, (_, i) => mkFinding({ code: `C${i}`, tool: 'edit' }));
  const d = { schema: 'x', fixable: findings, notFixable: [], bySeverity: {}, counts: {}, minCount: 3, generatedAt: NOW, since: 0 };
  const picked = pickFixables(d, { maxItems: 5 });
  assert.equal(picked.length, 5);
  const text = buildFixPrompt(d, { maxItems: 5 });
  for (const f of picked) assert.ok(text.includes(f.code), `提示词里必须有 ${f.code}`);
  assert.equal(text.includes('C5'), false, '第 6 条不得出现在提示词里');
});

test('接线：源码层锁死「开工单」与「提示词」共用 pickFixables', () => {
  const fp = fs.readFileSync(path.join(root, 'lib', 'fixprompt.js'), 'utf8');
  assert.match(fp, /export function pickFixables/);
  assert.match(fp, /const fixable = pickFixables\(diagnostics, opts\)/);
  assert.equal(/const fixable = \(diagnostics\.fixable \?\? \[\]\)\.slice/.test(fp), false,
    '不得再出现第二处 slice');

  const idx = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8');
  assert.match(idx, /pickFixables/, 'RPC 侧也必须用同一个选取函数');
  assert.match(idx, /openTicket/, 'RPC 侧必须走 openTicket（保证同 key 只有一张在用工单）');
});

test('接线：开单失败不得影响提示词交付（提示词是主产物）', () => {
  const idx = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8');
  // 开单必须在 try 里，且 catch 只记 ticketError、不改变响应里的 prompt
  const seg = idx.slice(idx.indexOf('${BASE}/fixprompt'));
  const body = seg.slice(0, seg.indexOf('${BASE}/fixes`]'));
  assert.match(body, /try \{/);
  assert.match(body, /catch \(e\) \{/);
  assert.match(body, /prompt,\s*\n\s*tickets/, '响应里 prompt 与 tickets 并列，开单失败只让 tickets 为空');
});

test('接线：CLI 与 RPC 用同一套语义（都走 fixes.js，不各写一遍判定）', () => {
  const cap = fs.readFileSync(path.join(root, 'cap.mjs'), 'utf8');
  assert.match(cap, /case 'fixes'/);
  assert.match(cap, /['"]\.\/lib\/fixes\.js['"]/, 'CLI 必须复用 lib/fixes.js');
  // 状态字符串不得在 CLI 里硬编
  for (const s of ['recurring', 'resolved', 'watching']) {
    assert.equal(new RegExp(`['"]${s}['"]`).test(cap), false, `CLI 不得硬编状态 ${s}`);
  }
});

test('接线：设置页有独立的修复台账卡片，且不做二次判定', () => {
  const cl = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8');
  assert.match(cl, /function FixesPanel/);
  assert.match(cl, /fixes: '\/fixes'/, '必须取数 /fixes');
  assert.match(cl, /h\(Card, \{ title: t\('fixes'\) \}/);
  assert.match(cl, /onClose: closeFix/);
  // 页面不得自己算复发：不得出现按时间过滤记录的逻辑
  assert.equal(/filter\(\s*\(?r\)?\s*=>\s*r\.time/.test(cl), false, '复发判定只能在 Host 侧');
});
