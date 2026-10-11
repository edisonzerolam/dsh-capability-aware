// dsh-capability-aware · lib/ledger 错误账本验收测试（node --test，零外部依赖）
//
// 验收标准（对应用户 m04583 原话）：
//  A. 记录每个会话的报错信息        → T10–T16, T25–T30
//  B. 按插件／技能／对象等切面区分   → T17–T21, T27
//  C. 以备后续自修复与自进化        → T20（只给候选、只收 owner=local）
//  D. 不碰用户文件、只读会话日志     → T29（源码级）
//
// 归属（用户 m05633 裁决）：账本并入 dsh-capability-aware，不再独立成插件——
// 「本机有什么能力」与「什么坏了 / 缺什么」是同一问题的两面。
// 因此本测试直接测 lib/ledger/*，并额外断言主插件 apply() 确实把它挂起来了。
//
// 隔离：账本目录与会话根一律走显式参数或 DSH_ERROR_LEDGER_HOME 指向临时目录，
//       绝不读写真实 ~/.dsh/data 与 ~/.dsh/sessions。
//
// ⚠ 跑法必须是**文件形态**：`node --test test/ledger.test.mjs`
//   （`node --test test/` 目录形态在本机报 MODULE_NOT_FOUND，实测）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const mod = (p) => pathToFileURL(path.join(root, 'lib', p)).href;

const { PLUGIN_VERSION } = await import(mod('index.js'));   // 主插件版本（账本挂在它里面）
const zstd = await import(mod('ledger/zstd.js'));
const { classify, isSelfRepairable, signatureOf } = await import(mod('ledger/classify.js'));
const { objectOf, SessionAttribution, recordFromLoader } = await import(mod('ledger/extract.js'));
const store = await import(mod('ledger/store.js'));
const { rollup, facetKey, selfRepairCandidates, dayOf, FACETS } = await import(mod('ledger/rollup.js'));
const { parseSince, buildLedgerTool, TOOL_NAME } = await import(mod('ledger/tool.js'));
const { discoverLogs, backfill, sessionsRoot } = await import(mod('ledger/backfill.js'));
const { promptSectionText, mountPromptSection, SECTION_NAME, SECTION_ORDER } = await import(mod('ledger/prompt-section.js'));
const { mountLedger, LEDGER_BASE, LEDGER_NAME } = await import(mod('ledger/index.js'));

// 账本不再自己 apply()：由主插件调用 mountLedger(ctx, cfg, { version })，返回值是账本句柄。
// 这里用一层薄包装捕获最近一次挂载结果，替代旧独立插件的 `LEDGER`。
let LEDGER = null;
function mountLedgerT(ctx, cfg) {
  LEDGER = mountLedger(ctx, cfg, { version: PLUGIN_VERSION });
  return LEDGER;
}

// ── 通用工具 ────────────────────────────────────────────────────────────
function mkTmp(tag = 'ledger') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-${tag}-`));
}

function writeFileDeep(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** 造一个**多帧** zstd 会话日志（真实形态：每个持久化批次一帧）。 */
function makeSessionLog(events, { tornBytes = 0 } = {}) {
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const mid = Math.floor(lines.length / 2);
  const cut = lines.lastIndexOf('\n', mid) + 1;
  const frames = [zstdCompressSync(Buffer.from(lines.slice(0, cut), 'utf8')), zstdCompressSync(Buffer.from(lines.slice(cut), 'utf8'))];
  let buf = Buffer.concat(frames);
  if (tornBytes > 0) buf = Buffer.concat([buf, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01])]);
  return buf;
}

function toolResult(seq, { callId, error, text = 'boom', turn = 1, step = 1, meta } = {}) {
  const message = {
    role: 'tool',
    toolCallId: callId,
    source: { kind: 'tool', callId },
    content: [{ type: 'text', text }],
    isError: true,
    id: `m-${seq}`,
  };
  const data = { turn, step, message };
  if (error) data.error = error;
  if (meta) data.meta = meta;
  return { type: 'tool/result', seq, time: 1_700_000_000_000 + seq * 1000, data };
}

function toolCall(seq, name, args, callId = `call-${seq}`) {
  return { type: 'tool/call', seq, time: 1_700_000_000_000 + seq * 1000, data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) } };
}

// ════════════════════════════════════════════════════════════════════════
// 1. 多帧 zstd 解码（本插件最容易踩死的一处）
// ════════════════════════════════════════════════════════════════════════

test('T1 多帧 zstd：one-shot 只解第一帧，本解码器解全部', async () => {
  const events = [
    { type: 'session', data: { id: 's1', cwd: 'D:\\Agent\\CodeLib', version: 4 } },
    ...Array.from({ length: 30 }, (_, i) => toolResult(i + 1, { callId: `c${i}`, error: { name: 'FsError', code: 'FS_NOT_FOUND' } })),
  ];
  const buf = makeSessionLog(events);
  const { frames, tornStart } = zstd.scanZstdFrames(buf);
  assert.equal(frames.length, 2, '应识别出 2 帧');
  assert.equal(tornStart, undefined, '完整日志不应有 torn 帧');

  // 反证：Node 公开 API 只解第一帧 —— 这正是必须自写帧扫描器的原因
  const oneShot = zstdDecompressSync(buf);
  const all = await zstd.decompressAllZstdFrames(buf);
  assert.ok(all.frameCount === 2, `frameCount 应为 2，实为 ${all.frameCount}`);
  assert.ok(all.content.length > oneShot.length * 1.5, '多帧解码结果应显著长于 one-shot');
  const lines = all.content.toString('utf8').trim().split('\n');
  assert.equal(lines.length, events.length, '逐行数量应与写入一致');
});

test('T2 zstd：末尾半截帧不报错，标记 torn 并跳过', async () => {
  const events = [{ type: 'session', data: { id: 's1', cwd: 'D:\\x' } }, toolResult(1, { callId: 'a', error: { name: 'FsError', code: 'FS_NOT_FOUND' } })];
  const buf = makeSessionLog(events, { tornBytes: 6 });
  const scan = zstd.scanZstdFrames(buf);
  assert.equal(scan.frames.length, 2);
  assert.ok(scan.tornStart !== undefined, '应识别出 torn 帧起点');
  const all = await zstd.decompressAllZstdFrames(buf);
  assert.equal(all.torn, true);
  assert.ok(all.content.toString('utf8').includes('FS_NOT_FOUND'));
});

test('T3 zstd：坏魔数抛错（不静默返回空）', async () => {
  assert.throws(() => zstd.scanZstdFrames(Buffer.from('not a zstd frame at all')), /invalid frame magic/);
});

test('T4 zstd：readSessionLogLines 跳过坏行且统计', async () => {
  const dir = mkTmp('zstd');
  const file = path.join(dir, 's.log');
  const body = [JSON.stringify({ type: 'session', data: { cwd: 'D:\\x' } }), '{ broken json', JSON.stringify({ type: 'turn/start', seq: 1 })].join('\n') + '\n';
  fs.writeFileSync(file, zstdCompressSync(Buffer.from(body, 'utf8')));
  const r = await zstd.readSessionLogLines(file);
  assert.equal(r.events.length, 2);
  assert.equal(r.badLines, 1);
});

// ════════════════════════════════════════════════════════════════════════
// 2. 分类学（错误码 / 类名 / 正文签名 → 类别 + 责任方 + 修法）
// ════════════════════════════════════════════════════════════════════════

test('T5 classify：已知错误码走 CODE_RULES', () => {
  const r = classify({ name: 'FsError', code: 'FS_EDIT_NOT_FOUND', message: 'x' });
  assert.equal(r.code, 'FS_EDIT_NOT_FOUND');
  assert.equal(r.category, 'fs');
  assert.equal(r.owner, 'local');
  assert.ok(r.fixHint.includes('read'), '应给出「先 read」的专属修法');
});

test('T6 classify：无码错误用正文签名反查专属修法（真机第一大项）', () => {
  const r = classify({ name: 'ToolError', code: '', message: 'Error: old_string and new_string must differ' });
  assert.equal(r.signature, 'old_string and new_string must differ');
  assert.equal(r.category, 'tool_args');
  assert.ok(r.fixHint.includes('新旧内容相同'), '不得退化成泛泛的「参数不合规」');
});

test('T7 classify：签名匹配锚定在归一化签名上（带 Error: 前缀也能命中）', () => {
  const r = classify({ name: 'ToolError', message: 'Error: [Compression FAILED: Requested range(s) cannot be anchored (e.g. m01168..m01230)' });
  assert.ok(r.fixHint.includes('compress'), `compress 专属修法未命中：${r.fixHint}`);
  const img = classify({ name: 'Error', message: 'Error: cannot read "C:/x/y.png" as an image: unsupported' });
  assert.ok(img.fixHint.includes('图片'), `图片专属修法未命中：${img.fixHint}`);
});

test('T8 classify：code="UNKNOWN" 视作无码（宿主 turn/end 的字面量）', () => {
  const r = classify({ name: 'TurnError', code: 'UNKNOWN', message: 'old_string and new_string must differ' });
  assert.equal(r.code, '', 'UNKNOWN 不得当真码，否则 code 切面被假桶吞掉');
  assert.equal(r.category, 'tool_args', '仍应靠签名归到正确类别');
});

test('T9 classify：供应商侧错误不进自修复（owner=provider）', () => {
  const r = classify({ name: 'LlmError', code: 'RATE_LIMIT', message: 'rpm exhausted' });
  assert.equal(r.category, 'llm_quota');
  assert.equal(r.owner, 'provider');
  assert.equal(isSelfRepairable(r), false, '配额/限流不该被当成「本机要修的缺陷」');
  assert.equal(isSelfRepairable(classify({ name: 'FsError', code: 'FS_NOT_FOUND', message: '' })), true);
  assert.equal(isSelfRepairable(classify({ name: 'AbortError', code: 'ABORTED', message: '' })), false, '中断不是缺陷');
});

test('T10 classify：正文关键词优先级——具体规则先于宽泛规则', () => {
  // 「余额不足」同时含 quota 与「余额」，必须归 llm_quota 而不是被 reasoning/其他吞掉
  assert.equal(classify({ name: '', message: 'insufficient balance: 积分余额不足' }).category, 'llm_quota');
  assert.equal(classify({ name: '', message: 'model reasoning loop detected' }).category, 'llm_server');
  assert.equal(classify({ name: '', message: 'fetch failed: ECONNRESET' }).category, 'llm_transport');
});

test('T11 signatureOf：数字与 id 归一化，路径引号内容保留（是证据）', () => {
  const a = signatureOf('Error: cannot read "D:\\a\\b.png" at offset 1234');
  const b = signatureOf('Error: cannot read "D:\\a\\b.png" at offset 5678');
  assert.equal(a, b, '同类错误必须归一到同一签名');
  assert.ok(a.includes('D:\\a\\b.png'), '路径是定位证据，不得被抹掉');
});

// ════════════════════════════════════════════════════════════════════════
// 3. 对象抽取（对象切面）
// ════════════════════════════════════════════════════════════════════════

test('T12 objectOf：meta 优先，其次引号内路径', () => {
  assert.deepEqual(objectOf({ path: 'D:\\a\\b.md' }, 'ignored'), { kind: 'path', id: 'D:\\a\\b.md' });
  assert.deepEqual(objectOf({ url: 'https://x.dev/y' }, ''), { kind: 'url', id: 'https://x.dev/y' });
  assert.deepEqual(objectOf(null, 'Error: old_string was not found in "D:\\Agent\\CodeLib\\lib\\classify.js"'), { kind: 'path', id: 'D:\\Agent\\CodeLib\\lib\\classify.js' });
});

test('T13 objectOf：含空格路径不被截断成假桶', () => {
  const r = objectOf(null, 'grantWrite(D:\\Program Files\\DSH Desktop) failed');
  assert.equal(r.id, 'D:\\Program Files\\DSH Desktop', '实测坑：裸匹配会在空格处截成 D:\\Program');
});

test('T14 objectOf：Unix 路径至少两级（防 /ui4 这类片段污染对象切面）', () => {
  assert.equal(objectOf(null, 'present /ui4'), undefined);
  assert.equal(objectOf(null, '看 /CodeLib 下的东西'), undefined);
  assert.deepEqual(objectOf(null, 'cannot open /home/user/data.txt'), { kind: 'path', id: '/home/user/data.txt' });
});

test('T15 objectOf：裸路径在英文连接词处截断', () => {
  const r = objectOf(null, 'Error: cannot read D:\\a\\b.png is not a file');
  assert.equal(r.id, 'D:\\a\\b.png');
});

// ════════════════════════════════════════════════════════════════════════
// 4. 归因状态机（插件／技能／工具／供应商／模型切面的来源）
// ════════════════════════════════════════════════════════════════════════

const HDR = { cwd: 'D:\\Agent\\CodeLib', origin: 'subagent', delegationDepth: 2, agentPreset: 'p1', parentSession: 'p-1' };
const ref = () => ({ id: 'sess-1', header: HDR });

test('T16 归因：tool/result 靠 callId 关联出工具名', () => {
  const a = new SessionAttribution(ref);
  a.observe(toolCall(1, 'edit', { path: 'D:\\a.md' }, 'c1'));
  const recs = a.observe(toolResult(2, { callId: 'c1', error: { name: 'FsError', code: 'FS_EDIT_NOT_FOUND' }, text: 'Error: old_string was not found in "D:\\a.md"' }));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].tool, 'edit');
  assert.equal(recs[0].kind, 'tool');
  assert.equal(recs[0].category, 'fs');
  assert.equal(recs[0].object.id, 'D:\\a.md');
  assert.equal(recs[0].session, 'sess-1');
  assert.equal(recs[0].cwd, 'D:\\Agent\\CodeLib');
  assert.equal(recs[0].delegationDepth, 2);
});

test('T17 归因：污染的工具名被拒（实测 name 里混进参数文本）', () => {
  const a = new SessionAttribution(ref);
  a.observe(toolCall(1, 'bash 2>&1 | head -3; echo done', {}, 'c1'));
  const recs = a.observe(toolResult(2, { callId: 'c1', error: { name: 'ToolError', code: 'UNKNOWN_TOOL' } }));
  assert.equal(recs[0].tool, undefined, '非工具名形态必须丢弃，否则切面被假桶污染');
});

test('T18 归因：技能切面来自最近一次 skill 工具调用', () => {
  const a = new SessionAttribution(ref);
  a.observe(toolCall(1, 'skill', { name: 'android-forge' }, 's1'));
  a.observe(toolCall(2, 'skill', { name: 'web-intel' }, 's2'));
  const recs = a.observe(toolResult(3, { callId: 'x', error: { name: 'FsError', code: 'FS_NOT_FOUND' } }));
  assert.equal(recs[0].skill, 'web-intel', '应取最近一次，而不是第一次');
});

test('T19 归因：llm/retry 带 provider，模型靠 request/header 富化', () => {
  const a = new SessionAttribution(ref);
  a.observe({ type: 'request/header', seq: 1, data: { config: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } } });
  const recs = a.observe({ type: 'llm/retry', seq: 2, time: 1, data: { provider: 'opencode-go', retry: 2, maxRetries: 5, failure: { code: 'RATE_LIMIT', message: 'rpm exhausted' } } });
  assert.equal(recs[0].provider, 'opencode-go');
  assert.equal(recs[0].model, 'deepseek-v4.1-flash', 'llm/retry 本身没有 model，必须靠会话内最近 header 补');
  assert.equal(recs[0].retry, 2);
  assert.equal(recs[0].owner, 'provider');
});

test('T20 归因：turn/end 仅在 reason.kind=error 时记录', () => {
  const a = new SessionAttribution(ref);
  assert.equal(a.observe({ type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } }).length, 0);
  const recs = a.observe({ type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'error', error: { code: 'SERVER', message: '502' } } } });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].kind, 'turn');
  assert.equal(recs[0].category, 'llm_server');
});

test('T21 归因：中断与成功结果都不产生记录', () => {
  const a = new SessionAttribution(ref);
  const recs = a.observe({ type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, message: { interrupted: true } } });
  assert.equal(recs.length, 1);
  assert.equal(recs[0].category, 'abort');
  const ok = a.observe({ type: 'tool/result', seq: 2, data: { turn: 1, step: 1, message: { toolCallId: 'z', isError: false, content: [{ type: 'text', text: 'ok' }] } } });
  assert.equal(ok.length, 0, '成功结果不得进账本');
});

test('T22 归因：callId 表有软上限（超长会话不无限增长）', () => {
  const a = new SessionAttribution(ref);
  for (let i = 0; i < 5000; i += 1) a.observe(toolCall(i, 'read', {}, `c${i}`));
  assert.ok(a.calls.size <= 4096, `callId 表应被裁剪，实为 ${a.calls.size}`);
  assert.ok(a.calls.has('c4999'), '应保留最新的，淘汰最旧的');
});

test('T23 归因：长正文被截断（账本不存整段上下文）', () => {
  const a = new SessionAttribution(ref);
  const recs = a.observe(toolResult(1, { callId: 'c', error: { name: 'FsError', code: 'FS_NOT_FOUND' }, text: 'x'.repeat(5000) }));
  assert.ok(recs[0].message.length < 1400);
  assert.ok(recs[0].message.includes('[+'), '截断应留下长度标记');
});

test('T24 recordFromLoader：绝不访问 entry.id（会让宿主起不来）', () => {
  const entry = {
    options: { id: 'dsh-foo', name: 'foo' },
    // 读 id 会抛 —— 与真实 loader 在 Entry 构造函数内 emit 的行为一致
    get id() { throw new Error("Cannot read properties of undefined (reading 'tree')"); },
  };
  const rec = recordFromLoader('dispose', entry, { message: 'entry disposed', legacy: false, active: true });
  assert.equal(rec.plugin, 'dsh-foo');
  assert.equal(rec.kind, 'plugin');
  assert.equal(rec.category, 'plugin');
});

// ════════════════════════════════════════════════════════════════════════
// 5. 存储（明细 JSONL + 状态文件）
// ════════════════════════════════════════════════════════════════════════

test('T25 store：追加 + 读取 + limit 取最后 N + 坏行计数', async () => {
  const dir = mkTmp('store');
  await store.appendRecords([{ v: 1, time: 1, code: 'A' }, { v: 1, time: 2, code: 'B' }], dir);
  await store.appendRecords([{ v: 1, time: 3, code: 'C' }], dir);
  fs.appendFileSync(store.paths(dir).events, 'not json\n');

  const all = await store.readRecords(dir);
  assert.equal(all.total, 3);
  assert.equal(all.badLines, 1, '坏行必须被统计而不是抛错');
  assert.equal(all.existed, true);

  const tail = await store.readRecords(dir, { limit: 2 });
  assert.deepEqual(tail.records.map((r) => r.code), ['B', 'C'], 'limit 必须取最后 N 条');
});

test('T26 store：空账本不抛错，返回 existed=false', async () => {
  const r = await store.readRecords(path.join(mkTmp('empty'), 'nope'));
  assert.deepEqual(r, { records: [], badLines: 0, existed: false });
});

test('T27 store：账本目录口径 DSH_ERROR_LEDGER_HOME > DSH_CAP_DSH_HOME > ~/.dsh，落 data/capability-aware/ledger', () => {
  const saved = { a: process.env.DSH_ERROR_LEDGER_HOME, c: process.env.DSH_CAP_DSH_HOME };
  try {
    delete process.env.DSH_ERROR_LEDGER_HOME;
    delete process.env.DSH_CAP_DSH_HOME;
    assert.ok(store.ledgerDir().endsWith(path.join('.dsh', 'data', 'capability-aware', 'ledger')));
    process.env.DSH_CAP_DSH_HOME = 'X:\\cap';
    assert.equal(store.ledgerDir(), path.join('X:\\cap', 'data', 'capability-aware', 'ledger'));
    process.env.DSH_ERROR_LEDGER_HOME = 'X:\\explicit';
    assert.equal(store.ledgerDir(), 'X:\\explicit');
  } finally {
    for (const [k, v] of Object.entries({ DSH_ERROR_LEDGER_HOME: saved.a, DSH_CAP_DSH_HOME: saved.c })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('T28 store：原子写不留 .tmp 残骸', async () => {
  const dir = mkTmp('atomic');
  await store.atomicWriteJson(store.paths(dir).meta, { v: 1, hello: '世界' });
  const files = fs.readdirSync(dir);
  assert.deepEqual(files, ['meta.v1.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'meta.v1.json'), 'utf8')).hello, '世界');
});

// ════════════════════════════════════════════════════════════════════════
// 6. 切面聚合 + 自修复候选（用户需求的落点）
// ════════════════════════════════════════════════════════════════════════

function rec(over = {}) {
  return {
    v: 1, time: 1_700_000_000_000, session: 's1', cwd: 'D:\\Agent\\CodeLib', kind: 'tool',
    tool: 'edit', skill: 'web-intel', plugin: 'dsh-foo', provider: 'opencode-go', model: 'm1',
    object: { kind: 'path', id: 'D:\\a.md' },
    code: 'FS_EDIT_NOT_FOUND', category: 'fs', owner: 'local', retryable: false, label: '文件系统',
    fixHint: '先 read', message: 'Error: old_string was not found', ...over,
  };
}

test('T29 rollup：facetKey 覆盖各切面 + code 无码时回落到签名', () => {
  assert.equal(facetKey(rec(), 'code'), 'FS_EDIT_NOT_FOUND');
  assert.equal(facetKey(rec({ code: '', signature: 'old_string and new_string must differ' }), 'code'), '~old_string and new_string must differ');
  assert.equal(facetKey(rec(), 'object'), 'path:D:\\a.md');
  assert.equal(facetKey(rec({ object: undefined }), 'object'), undefined, '无对象不得进聚合');
  assert.equal(facetKey(rec(), 'owner'), 'local');
  assert.ok(FACETS.includes('plugin') && FACETS.includes('skill') && FACETS.includes('object'));
});

test('T30 rollup：桶键不被 record.code 覆写（回归：来源对象显示成错误码）', () => {
  const r = rollup([rec(), rec({ code: 'FS_NOT_FOUND', object: { kind: 'path', id: 'D:\\b.md' } })], { facets: ['object', 'owner'] });
  assert.deepEqual(r.facets.object.map((b) => b.key).sort(), ['path:D:\\a.md', 'path:D:\\b.md']);
  assert.deepEqual(r.facets.owner.map((b) => b.key), ['local']);
});

test('T31 rollup：since 过滤 + byDay + sessions 计数', () => {
  const old = rec({ time: Date.parse('2026-09-01T00:00:00') });
  const now = rec({ time: Date.parse('2026-10-11T10:00:00') });
  const r = rollup([old, now], { since: Date.parse('2026-10-01T00:00:00') });
  assert.equal(r.total, 1, 'since 之前的不进统计');
  assert.deepEqual(Object.keys(r.byDay), ['2026-10-11']);
  assert.equal(r.sessions[0].key, 's1');
  assert.equal(dayOf(undefined), undefined);
});

test('T32 自修复候选：只收 owner=local、按次数×会话数排序、附证据', () => {
  const records = [
    ...Array.from({ length: 5 }, () => rec({ session: 's1' })),
    ...Array.from({ length: 3 }, () => rec({ session: 's2' })),
    // 供应商侧：绝不能进候选
    ...Array.from({ length: 100 }, () => rec({ code: 'RATE_LIMIT', category: 'llm_quota', owner: 'provider' })),
    // 中断：不是缺陷
    ...Array.from({ length: 50 }, () => rec({ code: 'ABORTED', category: 'abort', owner: 'user' })),
  ];
  const c = selfRepairCandidates(records, { minCount: 3 });
  assert.equal(c.length, 1, '限流与中断不得进候选');
  assert.equal(c[0].count, 8);
  assert.equal(c[0].sessionCount, 2);
  assert.equal(c[0].priority, 16, 'priority = count × 影响会话数');
  assert.deepEqual(c[0].sampleObjects, ['D:\\a.md']);
  assert.ok(c[0].fixHint, '候选必须带修法，否则自修复无从下手');
});

test('T33 自修复候选：minCount 生效（噪声不入选）', () => {
  assert.equal(selfRepairCandidates([rec()], { minCount: 3 }).length, 0);
  assert.equal(selfRepairCandidates([rec()], { minCount: 1 }).length, 1);
});

// ════════════════════════════════════════════════════════════════════════
// 7. 工具面
// ════════════════════════════════════════════════════════════════════════

test('T34 parseSince：相对时长 / ISO 日期 / 非法输入', () => {
  const now = Date.parse('2026-10-11T12:00:00');
  assert.equal(parseSince('7d', now), now - 7 * 86400000);
  assert.equal(parseSince('24h', now), now - 24 * 3600000);
  assert.equal(parseSince('90m', now), now - 90 * 60000);
  assert.equal(parseSince('2026-10-09', now), Date.parse('2026-10-09T00:00:00'));
  assert.equal(parseSince('garbage', now), 0);
  assert.equal(parseSince('', now), 0);
});

test('T35 工具：账本为空时给可操作的引导（不是空字符串）', async () => {
  const tool = buildLedgerTool({ dir: path.join(mkTmp('tool'), 'none') });
  assert.equal(tool.name, TOOL_NAME);
  const out = await tool.execute({ view: 'recent' });
  assert.ok(out.includes('空') && out.includes('backfill'), `应引导用户回填：${out}`);
});

test('T36 工具：五个视图都能渲染出带证据的文本', async () => {
  const dir = mkTmp('tool2');
  const records = [
    ...Array.from({ length: 4 }, (_, i) => rec({ time: 1_700_000_000_000 + i, session: i % 2 ? 's1' : 's2' })),
    rec({ code: 'FS_NOT_FOUND', object: { kind: 'path', id: 'D:\\b.md' } }),
  ];
  await store.appendRecords(records, dir);
  const tool = buildLedgerTool({ dir });

  const recent = await tool.execute({ view: 'recent', limit: 3 });
  assert.ok(recent.includes('FS_'), 'recent 应含错误码');
  assert.ok(recent.includes('edit'), 'recent 应含工具名（证据）');

  const facets = await tool.execute({ view: 'facets', key: 'object' });
  assert.ok(facets.includes('D:\\a.md'), 'facets 应能按对象下钻');

  const repair = await tool.execute({ view: 'repair' });
  assert.ok(repair.includes('FS_EDIT_NOT_FOUND'), 'repair 应列出候选');

  const search = await tool.execute({ view: 'search', key: 'old_string' });
  assert.ok(search.length > 0);

  const report = await tool.execute({ view: 'report' });
  assert.ok(report.includes('责任方'), 'report 必须含「该不该修」的责任方分布');
  assert.ok(report.includes('本机可修'), 'report 必须点明 local 才是该修的');
});

test('T37 工具：未知视图回落 recent，不抛错', async () => {
  const dir = mkTmp('tool3');
  await store.appendRecords([rec()], dir);
  const out = await buildLedgerTool({ dir }).execute({ view: '不存在的视图' });
  assert.ok(typeof out === 'string' && out.length > 0);
});

// ════════════════════════════════════════════════════════════════════════
// 8. 历史回填（1.26 GB 的会话日志）
// ════════════════════════════════════════════════════════════════════════

function makeFakeSessions() {
  const rootDir = mkTmp('sessions');
  const events = [
    { type: 'session', data: { id: 'sess-a', cwd: 'D:\\Agent\\CodeLib', version: 4 } },
    toolCall(1, 'edit', { path: 'D:\\a.md' }, 'c1'),
    toolResult(2, { callId: 'c1', error: { name: 'FsError', code: 'FS_EDIT_NOT_FOUND' }, text: 'Error: old_string was not found in "D:\\a.md"' }),
    toolCall(3, 'skill', { name: 'web-intel' }, 'c2'),
    { type: 'llm/retry', seq: 4, time: 1_700_000_004_000, data: { provider: 'opencode-go', retry: 1, failure: { code: 'RATE_LIMIT', message: 'rpm exhausted' } } },
    { type: 'turn/end', seq: 5, time: 1_700_000_005_000, data: { turn: 1, reason: { kind: 'error', error: { code: 'SERVER', message: '502' } } } },
  ];
  writeFileDeep(path.join(rootDir, '--D-Agent-CodeLib--', 'sess-a', 'session.v4.jsonl.zstd'), makeSessionLog(events));
  writeFileDeep(path.join(rootDir, '--D-Agent-story--', 'sess-b', 'session.v4.jsonl.zstd'), makeSessionLog([
    { type: 'session', data: { id: 'sess-b', cwd: 'D:\\Agent\\story', version: 4 } },
    toolResult(1, { callId: 'zz', error: { name: 'FsError', code: 'FS_NOT_FOUND' } }),
  ]));
  writeFileDeep(path.join(rootDir, '--empty--', 'sess-c', 'session.v4.jsonl.zstd'), Buffer.alloc(0));
  return rootDir;
}

test('T38 backfill：discoverLogs 只收非空 v4 日志', async () => {
  const rootDir = makeFakeSessions();
  const logs = await discoverLogs(rootDir);
  assert.equal(logs.length, 2, '空文件不得入选');
  assert.ok(logs.every((l) => l.file.endsWith('session.v4.jsonl.zstd')));
  assert.ok(logs.every((l) => l.size > 0));
  const one = await discoverLogs(rootDir, { workspace: '--D-Agent-story--' });
  assert.equal(one.length, 1);
});

test('T39 backfill：抽全量错误 + 归因正确', async () => {
  const rootDir = makeFakeSessions();
  const dir = mkTmp('bf');
  const res = await backfill({ dir, root: rootDir, concurrency: 2 });
  assert.equal(res.discovered, 2);
  assert.equal(res.processed, 2);
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  assert.equal(res.records, 4, `应抽出 4 条（sess-a 的 edit/llm/turn + sess-b 的 fs），实为 ${res.records}`);

  const { records } = await store.readRecords(dir);
  const byCode = Object.fromEntries(records.map((r) => [r.code, r]));
  assert.equal(byCode.FS_EDIT_NOT_FOUND.tool, 'edit');
  assert.equal(byCode.FS_EDIT_NOT_FOUND.object.id, 'D:\\a.md');
  assert.equal(byCode.FS_EDIT_NOT_FOUND.session, 'sess-a');
  assert.equal(byCode.FS_EDIT_NOT_FOUND.cwd, 'D:\\Agent\\CodeLib', '会话头 cwd 应被回填进记录');
  assert.equal(byCode.RATE_LIMIT.provider, 'opencode-go');
  assert.equal(byCode.SERVER.kind, 'turn');
  assert.ok(records.every((r) => r.backfill === true));
});

test('T40 backfill：未变化的文件跳过（可续跑，不重复记账）', async () => {
  const rootDir = makeFakeSessions();
  const dir = mkTmp('bf2');
  await backfill({ dir, root: rootDir });
  const second = await backfill({ dir, root: rootDir });
  assert.equal(second.processed, 0);
  assert.equal(second.unchanged, 2);
  assert.equal(second.records, 0, '第二次不得重复写入');
  const { total } = await store.readRecords(dir);
  assert.equal(total, 4);

  const forced = await backfill({ dir, root: rootDir, force: true });
  assert.equal(forced.processed, 2, 'force 应重解');
  assert.equal(forced.records, 4, 'force 会重写明细（回填通道不做去重，靠水位线）');
});

test('T41 backfill：实时水位线以下的 seq 被跳过（不与实时通道重复）', async () => {
  const rootDir = makeFakeSessions();
  const dir = mkTmp('bf3');
  await store.atomicWriteJson(store.paths(dir).meta, {
    v: 1, files: {}, backfillRuns: 0,
    sessions: { 'sess-a': { liveThroughSeq: 2 } }, // 前两条已由实时通道记录
  });
  const res = await backfill({ dir, root: rootDir });
  assert.ok(res.skippedForLive >= 2, `应跳过已实时捕获的事件，实为 ${res.skippedForLive}`);
  const { records } = await store.readRecords(dir);
  // sess-a 共 5 个事件，seq<=2 的两个被水位线挡掉 → 只剩 seq4(llm/retry) 与 seq5(turn/end)
  assert.equal(records.filter((r) => r.session === 'sess-a').length, 2, 'sess-a 应只回填 seq>2 的错误');
  assert.equal(records.filter((r) => r.session === 'sess-b').length, 1, '其他会话不受影响');
});

test('T42 backfill：maxFiles 分批推进', async () => {
  const rootDir = makeFakeSessions();
  const dir = mkTmp('bf4');
  const first = await backfill({ dir, root: rootDir, maxFiles: 1 });
  assert.equal(first.processed, 1);
  assert.equal(first.discovered, 2);
});

test('T43 backfill：会话根不存在时安静返回空结果', async () => {
  const res = await backfill({ dir: mkTmp('bf5'), root: path.join(mkTmp('bf6'), 'nope') });
  assert.equal(res.discovered, 0);
  assert.equal(res.errors.length, 0);
});

test('T44 sessionsRoot：随 DSH_HOME 口径变化', () => {
  const saved = { b: process.env.DSH_CAP_DSH_HOME };
  try {
    process.env.DSH_CAP_DSH_HOME = 'X:\\home';
    assert.equal(sessionsRoot(), path.join('X:\\home', 'sessions'));
  } finally {
    if (saved.b === undefined) delete process.env.DSH_CAP_DSH_HOME; else process.env.DSH_CAP_DSH_HOME = saved.b;
  }
});

// ════════════════════════════════════════════════════════════════════════
// 9. 常驻指令面（「装上即被用」）
// ════════════════════════════════════════════════════════════════════════

test('T45 promptSectionText：含工具名、触发条件、责任方判读要点、版本戳', () => {
  const t = promptSectionText('9.9.9');
  assert.ok(t.includes('v9.9.9'), '版本戳用于验证重启后代码是否更新');
  assert.ok(t.includes('error_ledger_query'), '必须点名工具');
  assert.ok(t.includes('反复出现'), '必须给出触发条件（agent 自己可识别的信号）');
  assert.ok(t.includes('repair'), '必须指向自修复候选视图');
  assert.ok(t.includes('local') && t.includes('provider'), '必须教它分辨「该不该修」');
  assert.ok(t.includes('只读'), '必须声明不改任何东西');
  assert.ok(t.indexOf('error_ledger_query') < t.indexOf('cap.mjs ledger') || !t.includes('cap.mjs ledger'), '工具优先于 CLI');
});

test('T46 mountPromptSection：软注入 systemPrompt，effect 包裹，位次 2951', () => {
  const sections = [];
  const effects = [];
  const injected = [];
  const fake = {
    inject(services, cb) { injected.push(services.join(',')); cb(fakeScoped); },
  };
  const fakeScoped = {
    systemPrompt: {
      getSectionOrder(n) { return n === 'TOOL_COMPUTER_USE' ? 3000 : undefined; },
      section(spec) { sections.push(spec); return () => {}; },
    },
    effect(fn, label) { effects.push(label); return fn(); },
  };
  const r = mountPromptSection(fake, { version: '9.9.9' });
  assert.deepEqual(injected, ['systemPrompt'], '必须软注入，不得硬声明 export const inject');
  assert.equal(r.mounted, true);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, SECTION_NAME);
  assert.equal(sections[0].order, 2951, '应跟随宿主常量推导（3000-49）');
  assert.equal(sections[0].interpolate, false);
  assert.equal(typeof sections[0].text, 'function');
  assert.ok(sections[0].text().includes('error_ledger_query'));
  assert.equal(effects.length, 1, '必须挂 effect，否则热重载 duplicate section 抛错');
});

test('T47 mountPromptSection：enabled=false 与宿主无 systemPrompt 时安全降级', () => {
  const fake = { inject() { throw new Error('should not be called'); } };
  assert.deepEqual(mountPromptSection(fake, { enabled: false }), { mounted: false, reason: 'disabled' });

  const noSp = { inject(services, cb) { cb({ systemPrompt: undefined }); } };
  const r = mountPromptSection(noSp, {});
  // 只断言契约字段：diag 是排障用的附加信息，不应让契约断言变脆
  assert.equal(r.mounted, false);
  assert.equal(r.reason, 'no-systemPrompt');
  assert.ok(r.diag && typeof r.diag.injectCalled === 'number', '应带 diag 诊断字段');
});

test('T48 源码级：不硬声明 inject、不写用户文件、只读会话日志', () => {
  const idx = fs.readFileSync(path.join(root, 'lib', 'ledger', 'index.js'), 'utf8');
  const code = idx.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/export const inject\s*=/.test(code), '硬声明 inject 会让无该服务的 profile 里 apply() 整体 pending');
  assert.ok(/ctx\.inject\(\['systemPrompt'\]/.test(fs.readFileSync(path.join(root, 'lib', 'ledger', 'prompt-section.js'), 'utf8')));
  for (const s of ['webServer', 'tools']) assert.ok(idx.includes(`ctx.inject(['${s}']`), `应软注入 ${s}`);
  assert.ok(/promptSection: config\?\.promptSection !== false/.test(idx), '常驻指令面默认开');
  assert.ok(/mountPromptSection\(ctx,/.test(idx));
  // 只读：绝无写会话日志的调用
  assert.ok(!/writeFile[^\n]*session\.v4\.jsonl\.zstd/.test(idx));
  assert.ok(!/rm\(|rmSync\(|unlink\(/.test(code), '账本插件不得删除任何文件');
});

test('T49 版本一致性：PLUGIN_VERSION 与 package.json 一致；账本归 capability-aware 命名空间', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(PLUGIN_VERSION, pkg.version, '两处版本必须同步（health 会暴露实际运行版本）');
  assert.equal(LEDGER_NAME, 'capability-aware/ledger');
  assert.equal(LEDGER_BASE, '/api/capability-aware/ledger');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
});

// ════════════════════════════════════════════════════════════════════════
// 10. apply() 端到端（真实装配路径，不碰真实 ~/.dsh）
// ════════════════════════════════════════════════════════════════════════

function makeFakeCtx() {
  const handlers = new Map();
  const effects = [];
  const injected = [];
  const routes = [];
  const ctx = {
    logger: { info() {}, warn() {} },
    sessions: { list: () => [] },
    on(evt, cb) { handlers.set(evt, cb); return () => handlers.delete(evt); },
    effect(fn, label) { effects.push(label); const d = fn(); return () => { try { d?.(); } catch {} }; },
    inject(services, cb) {
      injected.push(services.join(','));
      const scoped = {
        effect: ctx.effect,
        webServer: { register(spec) { routes.push(spec.path); return () => {}; } },
        tools: { register() { return () => {}; } },
        systemPrompt: { getSectionOrder: () => 3000, section: () => () => {} },
      };
      cb(scoped);
    },
  };
  return { ctx, handlers, effects, injected, routes };
}

test('T50 apply()：端到端捕获 → 落盘 → 可查询', async () => {
  const dir = mkTmp('e2e');
  const rootDir = mkTmp('e2e-sessions');
  const { ctx, handlers, effects, injected, routes } = makeFakeCtx();
  mountLedgerT(ctx, { dir, sessionsRoot: rootDir, backfillOnBoot: false, flushMs: 10 });

  const fakeSession = { id: 'live-1', header: { cwd: 'D:\\Agent\\CodeLib' } };
  handlers.get('session/created')(fakeSession);
  handlers.get('session/event')(fakeSession, toolCall(1, 'edit', { path: 'D:\\a.md' }, 'c1'));
  handlers.get('session/event')(fakeSession, toolResult(2, { callId: 'c1', error: { name: 'FsError', code: 'FS_EDIT_NOT_FOUND' }, text: 'Error: old_string was not found in "D:\\a.md"' }));
  handlers.get('session/event')(fakeSession, { type: 'llm/retry', seq: 3, time: Date.now(), data: { provider: 'opencode-go', failure: { code: 'RATE_LIMIT', message: 'rpm' } } });

  const flush = await LEDGER.flushNow();
  assert.equal(flush.appended, 2, '应写入 1 条工具错误 + 1 条限流');
  const { records } = await store.readRecords(dir);
  assert.equal(records[0].tool, 'edit');
  assert.equal(records[0].skill, undefined);
  assert.equal(records[0].session, 'live-1');
  assert.equal(records[0].live, true, '实时通道的记录应带 live 标记');
  assert.equal(records[1].owner, 'provider');

  // 三面齐备：指令面 + 工具面 + RPC 面（都不许缺席）
  assert.ok(injected.includes('systemPrompt') && injected.includes('tools') && injected.includes('webServer'), `软注入面缺失：${injected}`);
  assert.ok(routes.includes('/api/capability-aware/ledger/stats') && routes.includes('/api/capability-aware/ledger/repair'));
  assert.ok(effects.some((l) => l.includes('session capture')));
  assert.ok(effects.some((l) => l.includes('loader capture')));

  const h = LEDGER.health();
  assert.equal(h.version, PLUGIN_VERSION);
  assert.equal(h.promptSection.mounted, true);
  assert.ok(h.healthy, `health 不应有 warn：${JSON.stringify(h.findings)}`);
});

test('T51 apply()：agent/error 事件（payload 无 agent 字段）也能落账', async () => {
  const dir = mkTmp('e2e2');
  const { ctx, handlers } = makeFakeCtx();
  mountLedgerT(ctx, { dir, sessionsRoot: mkTmp('e2e2-s'), backfillOnBoot: false });
  handlers.get('session/created')({ id: 's9', header: { cwd: 'D:\\x' } });
  handlers.get('agent/error')({ turn: 3, step: 2, error: { name: 'LlmError', code: 'SERVER', message: '502' } });
  await LEDGER.flushNow();
  const { records } = await store.readRecords(dir);
  assert.equal(records.length, 1);
  assert.equal(records[0].turn, 3);
  assert.equal(records[0].step, 2, 'agent/error 的 step 必须透传');
  assert.equal(records[0].source, 'agent/error');
});

test('T52 apply()：recordInterrupts=false 时中断不入账', async () => {
  const dir = mkTmp('e2e3');
  const { ctx, handlers } = makeFakeCtx();
  mountLedgerT(ctx, { dir, sessionsRoot: mkTmp('e2e3-s'), backfillOnBoot: false, recordInterrupts: false });
  const s = { id: 's1', header: {} };
  handlers.get('session/created')(s);
  handlers.get('session/event')(s, { type: 'assistant/message', seq: 1, data: { turn: 1, step: 1, message: { interrupted: true } } });
  await LEDGER.flushNow();
  const { records } = await store.readRecords(dir);
  assert.equal(records.length, 0);
});

test('T53 apply()：capture=false 时不订阅任何事件（只留回填）', async () => {
  const dir = mkTmp('e2e4');
  const { ctx, effects } = makeFakeCtx();
  mountLedgerT(ctx, { dir, sessionsRoot: mkTmp('e2e4-s'), capture: false, backfillOnBoot: false });
  assert.ok(!effects.some((l) => l.includes('session capture')));
  assert.ok(!effects.some((l) => l.includes('loader capture')));
});

test('T54 apply()：loader 异常路径入账（插件切面）', async () => {
  const dir = mkTmp('e2e5');
  const { ctx, handlers } = makeFakeCtx();
  mountLedgerT(ctx, { dir, sessionsRoot: mkTmp('e2e5-s'), backfillOnBoot: false });
  handlers.get('loader/partial-dispose')({ options: { id: 'dsh-broken' } }, true, true);
  await LEDGER.flushNow();
  const { records } = await store.readRecords(dir);
  assert.equal(records.length, 1);
  assert.equal(records[0].plugin, 'dsh-broken');
  assert.equal(records[0].kind, 'plugin');
});

test('T55 apply()：RPC handlers 真实可调用（stats / repair / recent）', async () => {
  const dir = mkTmp('e2e6');
  const { ctx, handlers, routes } = makeFakeCtx();
  // 收集真实注册的 handler，模拟 HTTP 调用
  const routeMap = new Map();
  const ctx2 = { ...ctx, inject(services, cb) {
    cb({
      effect: ctx.effect,
      webServer: { register(spec) { routeMap.set(spec.path, spec.handler); return () => {}; } },
      tools: { register: () => () => {} },
      systemPrompt: { getSectionOrder: () => 3000, section: () => () => {} },
    });
  } };
  mountLedgerT(ctx2, { dir, sessionsRoot: mkTmp('e2e6-s'), backfillOnBoot: false });
  const s = { id: 's1', header: { cwd: 'D:\\x' } };
  handlers.get('session/created')(s);
  handlers.get('session/event')(s, toolResult(1, { callId: 'c', error: { name: 'FsError', code: 'FS_NOT_FOUND' } }));
  await LEDGER.flushNow();

  const call = (p) => new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      writeHead(c, h) { this._c = c; },
      end(b) { chunks.push(b); resolve({ code: this._c, body: JSON.parse(chunks.join('')) }); },
    };
    routeMap.get(p)({ url: p, method: 'GET', on(e, cb) { if (e === 'end') cb(); } }, res);
  });
  const stats = await call('/api/capability-aware/ledger/stats');
  assert.equal(stats.code, 200);
  assert.equal(stats.body.captured, 1);
  assert.equal(stats.body.dir, dir);

  const repair = await call('/api/capability-aware/ledger/repair');
  assert.equal(repair.code, 200);
  assert.ok(Array.isArray(repair.body.candidates));

  const recent = await call('/api/capability-aware/ledger/recent');
  assert.equal(recent.body.records.length, 1);
});
