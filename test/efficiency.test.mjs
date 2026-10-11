// dsh-efficiency · v0.9.0 效率机验收测试（node --test，零外部依赖）
//
// 覆盖用户 m06161 的三条目标中**尚未被前两个测试文件覆盖**的部分：
//   目标 1「索引并快速定位工具/插件/环境/接口」 → interfaces + 第三提示词段
//   目标 2「监控运行中的资源调度，防范卡死」   → monitor/{procs,detect,collector,store,plugins,sessions}
//   目标 3「记录并给出修复依据」               → diagnose + fixprompt
//
// 前两个文件的分工（不重复）：
//   test/capability.test.mjs —— 清单/检索/供给/接线（v0.1–v0.8 主线）
//   test/ledger.test.mjs     —— 错误账本采集与十切面（v0.8.0）
//   本文件                    —— v0.9.0 效率机（接口面/监控/诊断/修复提示词）
//
// 隔离纪律：监控与账本目录一律走显式 `dir` 参数指向临时目录，
//           绝不读写真实 ~/.dsh/data。唯一例外是**显式读取**宿主 node_modules
//           做静态接口扫描（只读、无副作用），且可用 DSH_HOST_NODE_MODULES 覆盖。
//
// ⚠ 跑法必须是**文件形态**：`node --test test/efficiency.test.mjs`
//   （`node --test test/` 目录形态在本机报 MODULE_NOT_FOUND，实测）

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
  DIAGNOSTIC_SCHEMA, SEVERITIES, SEVERITY_RULES, MONITOR_SEVERITY,
  diagnose, renderDiagnostics,
} = await import(mod('diagnose.js'));
const { FIXPROMPT_VERSION, buildFixPrompt, buildSingleFixPrompt } = await import(mod('fixprompt.js'));
const detect = await import(mod('monitor/detect.js'));
const store = await import(mod('monitor/store.js'));
const procs = await import(mod('monitor/procs.js'));
const pluginLayer = await import(mod('monitor/plugins.js'));
const sessionLayer = await import(mod('monitor/sessions.js'));
const iface = await import(mod('interfaces.js'));
const effSection = await import(mod('efficiency-section.js'));
const { safeService } = await import(mod('svc.js'));
const { applyScan } = await import(mod('registry.js'));

// ── 通用工具 ────────────────────────────────────────────────────────────
function mkTmp(tag = 'eff') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-${tag}-`));
}

/** 造一条账本记录（形状对齐 lib/ledger/extract.js 的 build()）。 */
function rec(o = {}) {
  return {
    v: 1,
    time: o.time ?? Date.now(),
    session: o.session ?? 's1',
    kind: o.kind ?? 'tool',
    code: o.code,
    signature: o.signature,
    errorName: o.errorName ?? 'Error',
    tool: o.tool,
    skill: o.skill,
    object: o.object,
    owner: o.owner ?? 'local',
    category: o.category ?? 'fs',
    message: o.message ?? '',
    fixHint: o.fixHint,
  };
}

// ══════════════════════════════════════════════════════════════════════
// 一、diagnose —— 分级诊断（目标 3 的核心：给「修什么」提供依据）
// ══════════════════════════════════════════════════════════════════════

test('M4: 诊断信封 schema 是版本化常量（消费方可据此判能否处理）', () => {
  assert.equal(DIAGNOSTIC_SCHEMA, 'dsh-efficiency/diagnostics/v1');
  const d = diagnose([], {});
  assert.equal(d.schema, DIAGNOSTIC_SCHEMA);
  assert.ok(Number.isFinite(d.generatedAt));
});

test('M4: SEVERITIES 四档的语义是「确定性」而非「严重程度」，且 P3 明确不可修', () => {
  assert.equal(SEVERITIES.P0.rank, 0);
  assert.equal(SEVERITIES.P1.rank, 1);
  assert.equal(SEVERITIES.P2.rank, 2);
  assert.equal(SEVERITIES.P3.rank, 3);
  assert.equal(SEVERITIES.P0.fixable, true);
  assert.equal(SEVERITIES.P1.fixable, true);
  assert.equal(SEVERITIES.P2.fixable, true);
  // P3 是本模块最重要的设计：不是本机该修的，绝不进修复提示词。
  assert.equal(SEVERITIES.P3.fixable, false);
  assert.equal(SEVERITIES.P3.owner, 'provider');
  assert.equal(SEVERITIES.P3.label, '非本机问题');
});

test('M4: 每条分档规则都带 note（「为什么是这一档」比「是这一档」重要）', () => {
  const codes = Object.keys(SEVERITY_RULES);
  assert.ok(codes.length >= 30, `规则表应覆盖 ≥30 个错误码，实际 ${codes.length}`);
  for (const c of codes) {
    const r = SEVERITY_RULES[c];
    assert.ok(['P0', 'P1', 'P2', 'P3'].includes(r.severity), `${c} 的档位非法：${r.severity}`);
    assert.ok(typeof r.note === 'string' && r.note.length > 0, `${c} 缺 note`);
  }
});

test('M4: 文件系统类错误分到 P1（本机可修且证据充分）', () => {
  for (const code of ['FS_EDIT_NOT_FOUND', 'FS_NOT_OBSERVED', 'FS_STALE_VERSION', 'FS_NOT_FOUND']) {
    assert.equal(SEVERITY_RULES[code].severity, 'P1', `${code} 应为 P1`);
  }
});

test('M4: 加载器/宿主契约失败分到 P0（宿主自己报的确定失败）', () => {
  for (const code of ['LOADER_DISPOSE', 'PLUGIN_FAILED', 'HOST_CONTRACT']) {
    assert.equal(SEVERITY_RULES[code].severity, 'P0', `${code} 应为 P0`);
  }
});

test('M4: 供应商类错误分到 P3 —— 实测占全量错误四成，绝不能让 agent 去「修」限流', () => {
  for (const code of ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'QUOTA_EXCEEDED', 'AUTH']) {
    assert.equal(SEVERITY_RULES[code].severity, 'P3', `${code} 应为 P3`);
    assert.equal(SEVERITIES.P3.fixable, false);
  }
});

test('M4: 监控事件码单独一张表（判据不同：测量值 vs 宿主报错）', () => {
  assert.equal(MONITOR_SEVERITY.PLUGIN_FAILED, 'P0');
  // 进程消失：进程不在了是确定的，但**退出码无从读取** ⇒ 无法判定是崩溃还是正常
  // 退出 ⇒ 按「分档看确定性」只能归 P2（2026-10-11 由 P1 降级）。
  assert.equal(MONITOR_SEVERITY.PROCESS_GONE, 'P2');
  assert.equal(MONITOR_SEVERITY.HOT_PROCESS, 'P1');
  assert.equal(MONITOR_SEVERITY.MEMORY_GROWTH, 'P1');
  assert.equal(MONITOR_SEVERITY.IO_STORM, 'P2');
  // 会话停摆是最弱的一档：它是**推断**，不是测量。
  assert.equal(MONITOR_SEVERITY.SESSION_STALL, 'P2');
  // 两张表必须是不同的对象（混用会把监控语义套到错误码上）。
  assert.notEqual(SEVERITY_RULES, MONITOR_SEVERITY);
});

test('M4: detect.js 实际发出的 severity 必须与 MONITOR_SEVERITY 一致（两处曾各说各话）', () => {
  // 2026-10-11：detect.js 把 PROCESS_GONE 降为 P2，diagnose.js 的表还是 P1 —— 同一件事
  // 两张表各说各话，页面按哪张算都有一半是错的。这里用真实运行把两处钉在一起。
  const det = detect.createDetector({ goneMinTicks: 1, stallTicks: 1, cooldownMs: 0 });
  const seen = new Map();
  const note = (evs) => { for (const e of evs) seen.set(e.code, e.severity); };

  det.run({ now: 1000, procs: { source: 'ffi', rows: [{ pid: 5, cpuPct: 1 }] } });
  note(det.run({ now: 1100, procs: { source: 'ffi', rows: [] } }));  // PROCESS_GONE
  const flat = (seq) => ({ id: 's', steps: 1, asOfSeq: seq, dLlmMs: 0, dToolMs: 0, dSteps: 0, llmMs: 1, toolMs: 1 });
  det.run({ now: 1200, sessions: { sessions: [flat(1)] } });
  note(det.run({ now: 1300, sessions: { sessions: [flat(2)] } }));  // SESSION_STALL

  assert.deepEqual([...seen.keys()].sort(), ['PROCESS_GONE', 'SESSION_STALL']);
  for (const [code, sev] of seen) {
    assert.equal(MONITOR_SEVERITY[code], sev, `${code}：detect.js 发 ${sev}，diagnose 表里是 ${MONITOR_SEVERITY[code]}`);
  }
  // 每个 detect 会发的码都必须在表里有档位（缺档会被兜底成 P2，静默丢语义）
  for (const code of Object.keys(detect.REASONS)) {
    assert.ok(MONITOR_SEVERITY[code], `${code} 在 MONITOR_SEVERITY 里没有档位`);
  }
});

test('M4: minCount 阈值生效 —— 出现次数不足的噪声被滤掉', () => {
  const recs = [
    rec({ code: 'FS_NOT_FOUND' }), rec({ code: 'FS_NOT_FOUND' }),          // 2 次
    rec({ code: 'FS_EDIT_NOT_FOUND' }), rec({ code: 'FS_EDIT_NOT_FOUND' }), rec({ code: 'FS_EDIT_NOT_FOUND' }), // 3 次
  ];
  const d3 = diagnose(recs, { minCount: 3 });
  assert.equal(d3.totalFindings, 1);
  assert.equal(d3.fixable[0].code, 'FS_EDIT_NOT_FOUND');
  assert.equal(d3.fixable[0].count, 3);
  // 放宽到 2 → 两条都在
  const d2 = diagnose(recs, { minCount: 2 });
  assert.equal(d2.totalFindings, 2);
});

test('M4: since 时间窗生效 —— 窗口外的历史不参与诊断', () => {
  const now = Date.now();
  const recs = [
    rec({ code: 'FS_NOT_FOUND', time: now - 10 * 86400e3 }),   // 10 天前
    rec({ code: 'FS_NOT_FOUND', time: now - 10 * 86400e3 }),
    rec({ code: 'FS_NOT_FOUND', time: now - 10 * 86400e3 }),
    rec({ code: 'FS_NOT_OBSERVED', time: now - 60e3 }),        // 1 分钟前
    rec({ code: 'FS_NOT_OBSERVED', time: now - 60e3 }),
    rec({ code: 'FS_NOT_OBSERVED', time: now - 60e3 }),
  ];
  const d = diagnose(recs, { since: now - 86400e3, minCount: 3 });
  assert.equal(d.totalFindings, 1);
  assert.equal(d.fixable[0].code, 'FS_NOT_OBSERVED');
});

test('M4: 未归类错误兜底归 P2 而非 P0 —— 把不确定说成「确定故障」是诊断最易犯的错', () => {
  const d = diagnose([rec({ code: 'TOTALLY_MADE_UP_CODE', category: 'unknown' })], { minCount: 1 });
  assert.equal(d.totalFindings, 1);
  assert.equal(d.fixable[0].severity, 'P2');
  assert.match(d.fixable[0].evidence.severityNote, /未归类|人工判断/);
});

test('M4: 无码错误经 classify 兜底 —— provider 责任方直接归 P3', () => {
  const d = diagnose([rec({
    code: undefined, signature: 'rate limit exceeded', errorName: 'LlmError',
    category: 'llm_quota', owner: 'provider',
  })], { minCount: 1 });
  assert.equal(d.totalFindings, 1);
  assert.equal(d.notFixable[0].severity, 'P3');
  assert.equal(d.fixable.length, 0, 'P3 不得出现在 fixable 里');
});

test('M4: 档位与 owner 自洽 —— 可修项的 owner 必须是 local（原始归因留在 ownerRaw）', () => {
  // 造一个「档位表说是 P1（本机可修）但 classify 归因成 provider」的矛盾记录。
  // 以档位为准，但分歧不许隐瞒。
  const d = diagnose([rec({
    code: 'FS_EDIT_NOT_FOUND', owner: 'provider', category: 'fs',
  })], { minCount: 1 });
  const f = d.fixable[0];
  assert.equal(f.severity, 'P1');
  assert.equal(f.evidence.owner, 'local', 'P1 是可修项，owner 不得是 provider');
  assert.equal(f.evidence.ownerRaw, 'provider', '原始归因必须保留，不许悄悄抹掉');
});

test('M4: 全量不变量 —— fixable 里绝不出现 owner=provider 或 P3', () => {
  const recs = [];
  for (const code of ['RATE_LIMIT', 'SERVER', 'FS_EDIT_NOT_FOUND', 'FS_NOT_OBSERVED', 'LOADER_DISPOSE']) {
    for (let i = 0; i < 5; i += 1) recs.push(rec({ code, owner: code === 'FS_EDIT_NOT_FOUND' ? 'provider' : undefined }));
  }
  const d = diagnose(recs, { minCount: 3 });
  for (const f of d.fixable) {
    assert.notEqual(f.severity, 'P3', `${f.code} 是 P3 却在 fixable 里`);
    assert.notEqual(f.evidence.owner, 'provider', `${f.code} 的 owner=provider 却在 fixable 里`);
  }
  for (const f of d.notFixable) {
    assert.equal(f.severity, 'P3', `${f.code} 在 notFixable 里但不是 P3`);
  }
});

test('M4: 监控层事件并入诊断，且带 evidence.basis（不假装看到没看到的）', () => {
  const now = Date.now();
  const ev = {
    v: 1, time: now, code: 'HOT_PROCESS', subject: 'pid:1234',
    evidence: { basis: 'win32-getprocesstimes', cpuPct: 96.5, streak: 3, kind: 'renderer' },
  };
  const d = diagnose([], { minCount: 1, monitor: { events: [ev] } });
  assert.equal(d.totalFindings, 1);
  assert.equal(d.counts.P1, 1);
  const f = d.fixable[0];
  assert.equal(f.code, 'HOT_PROCESS');
  assert.equal(f.subject.kind, 'pid');
  assert.equal(f.subject.name, '1234');
  assert.equal(f.evidence.basis, 'win32-getprocesstimes');
  assert.equal(f.evidence.detail.cpuPct, 96.5);
});

test('M4: 监控事件码不在表里的直接丢弃（不猜档位）', () => {
  const d = diagnose([], { minCount: 1, monitor: { events: [{ v: 1, time: Date.now(), code: 'NOT_A_REAL_EVENT' }] } });
  assert.equal(d.totalFindings, 0);
});

test('M4: 同码同主体跨源合并 —— 取更确定的档位，计数相加', () => {
  const now = Date.now();
  const recs = [];
  for (let i = 0; i < 4; i += 1) {
    recs.push(rec({ code: 'HOT_PROCESS', time: now - 1000, category: 'unknown', owner: 'local' }));
  }
  // 账本侧 code=HOT_PROCESS 走兜底 → P2；监控侧同码同主体 → P1。合并后取 P1。
  const ev = { v: 1, time: now, code: 'HOT_PROCESS', subject: 'error:HOT_PROCESS', evidence: { basis: 'x' }, count: 7 };
  const d = diagnose(recs, { minCount: 3, monitor: { events: [ev] } });
  assert.equal(d.totalFindings, 1, '同码同主体必须合并成一条');
  const f = d.fixable[0];
  assert.equal(f.severity, 'P1', '合并取更确定的档位（rank 小者）');
  assert.equal(f.count, 11, '计数应相加（4 + 7）');
});

test('M4: 相关性输出叫 correlatedWith 且带 deltaMs —— 是相关性，不是因果', () => {
  const now = Date.now();
  const recs = [];
  for (let i = 0; i < 3; i += 1) recs.push(rec({ code: 'FS_NOT_FOUND', time: now }));
  const events = [{ v: 1, time: now + 3000, code: 'HOT_PROCESS', subject: 'pid:9', evidence: { basis: 'x' } }];
  const d = diagnose(recs, { minCount: 3, monitor: { events } });
  const c = d.fixable[0].evidence.correlatedWith;
  assert.ok(Array.isArray(c) && c.length === 1);
  assert.equal(c[0].code, 'HOT_PROCESS');
  assert.equal(c[0].deltaMs, 3000, '必须给出时间差让人自己判断');
});

test('M4: 超出相关窗口的事件不关联', () => {
  const now = Date.now();
  const recs = [];
  for (let i = 0; i < 3; i += 1) recs.push(rec({ code: 'FS_NOT_FOUND', time: now }));
  const events = [{ v: 1, time: now + 60 * 60 * 1000, code: 'HOT_PROCESS', subject: 'pid:9', evidence: { basis: 'x' } }];
  const d = diagnose(recs, { minCount: 3, monitor: { events }, correlateMs: 60e3 });
  assert.equal(d.fixable[0].evidence.correlatedWith, undefined);
});

test('M4: bySeverity 每档受 topK 限制，counts 是全量计数', () => {
  const recs = [];
  for (let i = 0; i < 6; i += 1) {
    for (let j = 0; j < 3; j += 1) recs.push(rec({ code: `FS_FAKE_${i}`, category: 'fs', owner: 'local' }));
  }
  const d = diagnose(recs, { minCount: 3, topK: 2 });
  assert.equal(d.counts.P2, 6);
  assert.equal(d.bySeverity.P2.length, 2, 'bySeverity 受 topK 限制');
  assert.equal(d.fixable.length, 6, 'fixable 是全集，不受 topK 限制');
});

test('M4: renderDiagnostics 输出含 schema/档位/主体（CLI 可读）', () => {
  const recs = [];
  for (let i = 0; i < 3; i += 1) recs.push(rec({ code: 'FS_EDIT_NOT_FOUND', tool: 'edit' }));
  const d = diagnose(recs, { minCount: 3 });
  const text = renderDiagnostics(d);
  assert.ok(text.includes(DIAGNOSTIC_SCHEMA));
  assert.ok(text.includes('P1'));
  assert.ok(text.includes('FS_EDIT_NOT_FOUND'));
  assert.ok(text.includes('tool:edit'));
  assert.ok(text.includes('分档依据'));
});

// ══════════════════════════════════════════════════════════════════════
// 二、fixprompt —— 修复提示词（只生成文本，不自动执行）
// ══════════════════════════════════════════════════════════════════════

function sampleDiagnostics() {
  const recs = [];
  for (let i = 0; i < 3; i += 1) recs.push(rec({ code: 'FS_EDIT_NOT_FOUND', tool: 'edit', message: 'old_string 未命中' }));
  for (let i = 0; i < 3; i += 1) recs.push(rec({ code: 'RATE_LIMIT', owner: 'provider', category: 'llm_quota', message: '429' }));
  return diagnose(recs, { minCount: 3 });
}

test('M4: FIXPROMPT_VERSION 存在（消费方可判格式版本）', () => {
  assert.equal(typeof FIXPROMPT_VERSION, 'number');
});

test('M4: 提示词第一步是「先判断身份」——防止被粘到另一个 DSH 实例上改错机器', () => {
  const p = buildFixPrompt(sampleDiagnostics(), { profile: 'desktop', home: 'C:\\Users\\X\\.dsh' });
  assert.ok(p.includes('【第一步·先判断身份】'));
  const iStep1 = p.indexOf('【第一步·先判断身份】');
  const iStep2 = p.indexOf('【第二步');
  assert.ok(iStep1 >= 0 && iStep2 > iStep1, '身份判定必须排在复现之前');
  assert.ok(p.includes('无法确定'), '必须给出「无法确定时按是你处理」的保守规则');
  assert.ok(p.includes('desktop'), '必须写明 profile');
});

test('M4: 提示词第二步要求先复现取证，禁止照着文档直接改代码', () => {
  const p = buildFixPrompt(sampleDiagnostics(), {});
  assert.ok(p.includes('【第二步·先复现，再动手】'));
  assert.ok(p.includes('cap.mjs ledger recent'));
  assert.ok(p.includes('cap.mjs ledger search'));
  assert.ok(p.includes('不要凭本文档的描述直接改代码'));
});

test('M4: 可修项渲染出档位/主体/计数/分档依据', () => {
  const d = sampleDiagnostics();
  const p = buildFixPrompt(d, {});
  assert.ok(p.includes('■ 本机该修的'));
  assert.ok(p.includes('FS_EDIT_NOT_FOUND'));
  assert.ok(p.includes('tool:edit'));
  assert.ok(p.includes('[P1'));
});

test('M4: P3 项被显式标为「不要修」并说明理由', () => {
  const p = buildFixPrompt(sampleDiagnostics(), {});
  assert.ok(p.includes('【不要修】'));
  assert.ok(p.includes('RATE_LIMIT'));
  assert.ok(p.includes('改本机代码对它们无效'));
  // 关键：RATE_LIMIT 只能出现在「不要修」段落里
  const iNot = p.indexOf('【不要修】');
  const iRate = p.indexOf('RATE_LIMIT');
  assert.ok(iRate > iNot, 'RATE_LIMIT 必须出现在「不要修」段落之后，不得混进可修清单');
});

test('M4: includeP3=false 时供应商项完全不出现（用于「只要可修清单」场景）', () => {
  const p = buildFixPrompt(sampleDiagnostics(), { includeP3: false });
  assert.ok(!p.includes('RATE_LIMIT'));
  assert.ok(p.includes('FS_EDIT_NOT_FOUND'));
});

test('M4: 无本机可修项时如实写「无」，而不是编造内容', () => {
  const recs = [];
  for (let i = 0; i < 3; i += 1) recs.push(rec({ code: 'RATE_LIMIT', owner: 'provider', category: 'llm_quota' }));
  const p = buildFixPrompt(diagnose(recs, { minCount: 3 }), {});
  assert.ok(p.includes('**无**'));
});

test('M4: 第四步改动纪律含六条硬约束（含「不得删账本记录」「不得改 provider 项」）', () => {
  const p = buildFixPrompt(sampleDiagnostics(), {});
  assert.ok(p.includes('【第四步·改动纪律】'));
  assert.ok(p.includes('一次只改一项'));
  assert.ok(p.includes('npm test'));
  assert.ok(p.includes('不要为了让诊断数字变好看而删除账本记录'));
  assert.ok(p.includes('不要修改 `owner=provider` 的项'));
  assert.ok(p.includes('evidence.basis'));
  assert.ok(p.includes('修完后向用户报告'));
});

test('M4: 结尾声明「只生成文本、不自动执行」——只读承诺的延伸', () => {
  const p = buildFixPrompt(sampleDiagnostics(), {});
  assert.ok(p.includes('插件只生成文本、不自动执行修复'));
  assert.ok(p.includes(`版本 ${FIXPROMPT_VERSION}`));
});

test('M4: extra 追加说明被拼进提示词', () => {
  const p = buildFixPrompt(sampleDiagnostics(), { extra: '另外请注意 SERIAL=XYZ 这台机器' });
  assert.ok(p.includes('【补充说明】'));
  assert.ok(p.includes('SERIAL=XYZ'));
});

test('M4: buildSingleFixPrompt 只针对单条 finding（用于「点一条立刻要一段话」）', () => {
  const d = sampleDiagnostics();
  const p = buildSingleFixPrompt(d.fixable[0], { profile: 'desktop' });
  assert.ok(p.includes('FS_EDIT_NOT_FOUND'));
  assert.ok(!p.includes('【不要修】'), '单条模式不附 P3 段落');
  assert.ok(p.includes('【第一步·先判断身份】'));
});

// ══════════════════════════════════════════════════════════════════════
// 三、monitor/detect —— 异常检出（目标 2：防范卡死）
// ══════════════════════════════════════════════════════════════════════

test('M3: 六条规则的默认阈值与理由都存在', () => {
  const d = detect.DEFAULTS;
  assert.equal(d.hotCpuPct, 80);
  assert.equal(d.hotStreak, 3);
  assert.equal(d.memGrowthMbPerMin, 60);
  assert.equal(d.memStreak, 4);
  assert.equal(d.ioStormMbPerTick, 512);
  assert.equal(d.stallTicks, 5);
  assert.equal(d.cooldownMs, 120000);
  // 每条规则都有可复述的理由（evidence.reason）
  for (const code of ['PLUGIN_FAILED', 'PROCESS_GONE', 'HOT_PROCESS', 'MEMORY_GROWTH', 'IO_STORM', 'SESSION_STALL']) {
    assert.ok(typeof detect.REASONS[code] === 'string' && detect.REASONS[code].length > 10, `${code} 缺理由`);
  }
});

test('M3: PLUGIN_FAILED 命中 fiberPhase=failed，且带 loader 证据', () => {
  const det = detect.createDetector();
  const ev = det.run({
    now: 1000,
    plugins: { plugins: [{ entryId: 'p1', moduleName: 'dsh-demo', fiberPhase: 'failed' }] },
  });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].code, 'PLUGIN_FAILED');
  assert.equal(ev[0].severity, 'P0');
  assert.equal(ev[0].subject, 'p1');
  assert.equal(ev[0].evidence.basis, 'loader-fiber-phase');
  assert.ok(ev[0].reason.includes('确定事实'));
});

test('M3: PLUGIN_FAILED 不误报 active 插件', () => {
  const det = detect.createDetector();
  const ev = det.run({ now: 1000, plugins: { plugins: [{ entryId: 'p1', fiberPhase: 'active' }] } });
  assert.equal(ev.length, 0);
});

test('M3: PROCESS_GONE 只在 source=ffi、且该 pid 曾连续稳定存在 ≥goneMinTicks 周期时才判定', () => {
  const det = detect.createDetector({ goneMinTicks: 3 });
  // 连续 3 个 ffi 周期都见到 pid 42 ⇒ 达到「曾经稳定存在」门限
  det.run({ now: 1000, procs: { source: 'ffi', rows: [{ pid: 42, cpuPct: 1 }] } });
  det.run({ now: 2000, procs: { source: 'ffi', rows: [{ pid: 42, cpuPct: 1 }] } });
  det.run({ now: 3000, procs: { source: 'ffi', rows: [{ pid: 42, cpuPct: 1 }] } });
  // self-only 模式下 pid 42 缺席 → 不得报（self-only 没有全机基线，且此路径不判消失）
  const noFfi = det.run({ now: 4000, procs: { source: 'self-only', rows: [] } });
  assert.equal(noFfi.filter((e) => e.code === 'PROCESS_GONE').length, 0);
  // ffi 模式下缺席 → 报
  const withFfi = det.run({ now: 5000, procs: { source: 'ffi', rows: [] } });
  const gone = withFfi.filter((e) => e.code === 'PROCESS_GONE');
  assert.equal(gone.length, 1);
  assert.equal(gone[0].subject, 'pid:42');
  // 降为 P2：进程已不在，**退出码无从读取**，无法判定是崩溃还是正常退出
  assert.equal(gone[0].severity, 'P2');
  assert.equal(gone[0].evidence.basis, 'stable-pid-disappeared');
  assert.equal(gone[0].evidence.seenTicks, 3);
  assert.ok(gone[0].reason.includes('不判定为崩溃'), '原因文案必须自证「不判定为崩溃」');
});

test('M3: PROCESS_GONE 短命进程（存在不足 goneMinTicks 周期）不报 —— 实测 49.2% 噪声的源头', () => {
  const det = detect.createDetector({ goneMinTicks: 3 });
  det.run({ now: 1000, procs: { source: 'ffi', rows: [{ pid: 9, cpuPct: 1 }] } });
  det.run({ now: 2000, procs: { source: 'ffi', rows: [{ pid: 9, cpuPct: 1 }] } });
  // 只出现 2 个周期就消失（工具子进程的正常退出）→ 不报
  const e = det.run({ now: 3000, procs: { source: 'ffi', rows: [] } });
  assert.equal(e.filter((x) => x.code === 'PROCESS_GONE').length, 0);
});

test('M3: HOT_PROCESS 要求连续 N 次，单次尖峰不算（宁可漏报不可误报）', () => {
  const det = detect.createDetector({ hotStreak: 3 });
  const row = { pid: 777, cpuPct: 95, kind: 'renderer', name: 'x' };
  const e1 = det.run({ now: 1000, procs: { source: 'ffi', rows: [row] } });
  const e2 = det.run({ now: 2000, procs: { source: 'ffi', rows: [row] } });
  assert.equal(e1.filter((e) => e.code === 'HOT_PROCESS').length, 0, '第 1 次不算');
  assert.equal(e2.filter((e) => e.code === 'HOT_PROCESS').length, 0, '第 2 次不算');
  const e3 = det.run({ now: 3000, procs: { source: 'ffi', rows: [row] } });
  const hot = e3.filter((e) => e.code === 'HOT_PROCESS');
  assert.equal(hot.length, 1, '第 3 次才报');
  assert.equal(hot[0].evidence.streak, 3);
  assert.equal(hot[0].evidence.cpuPct, 95);
});

test('M3: 热点中断后 streak 归零（间歇性尖峰不报）', () => {
  const det = detect.createDetector({ hotStreak: 3 });
  const hot = { pid: 777, cpuPct: 95 };
  const cold = { pid: 777, cpuPct: 5 };
  det.run({ now: 1000, procs: { source: 'ffi', rows: [hot] } });
  det.run({ now: 2000, procs: { source: 'ffi', rows: [hot] } });
  det.run({ now: 3000, procs: { source: 'ffi', rows: [cold] } });  // 断
  det.run({ now: 4000, procs: { source: 'ffi', rows: [hot] } });
  const e = det.run({ now: 5000, procs: { source: 'ffi', rows: [hot] } });
  assert.equal(e.filter((x) => x.code === 'HOT_PROCESS').length, 0, '断一次后重新计数，不得报');
});

test('M3: 自身进程不算热点（Host 自己由自检报告，不占告警）', () => {
  const det = detect.createDetector({ hotStreak: 1 });
  const ev = det.run({ now: 1000, procs: { source: 'ffi', rows: [{ pid: process.pid, cpuPct: 999 }] } });
  assert.equal(ev.filter((e) => e.code === 'HOT_PROCESS').length, 0);
});

test('M3: 抑制窗口内同 code+subject 只报一次（防持续热点刷屏）', () => {
  const det = detect.createDetector({ hotStreak: 1, cooldownMs: 120000 });
  const row = { pid: 888, cpuPct: 95 };
  const a = det.run({ now: 1000, procs: { source: 'ffi', rows: [row] } });
  const b = det.run({ now: 2000, procs: { source: 'ffi', rows: [row] } });
  const c = det.run({ now: 3000, procs: { source: 'ffi', rows: [row] } });
  assert.equal(a.filter((e) => e.code === 'HOT_PROCESS').length, 1);
  assert.equal(b.filter((e) => e.code === 'HOT_PROCESS').length, 0, '窗口内被抑制');
  assert.equal(c.filter((e) => e.code === 'HOT_PROCESS').length, 0, '窗口内被抑制');
  // 窗口过后再报
  const d = det.run({ now: 1000 + 120001, procs: { source: 'ffi', rows: [row] } });
  assert.equal(d.filter((e) => e.code === 'HOT_PROCESS').length, 1);
});

test('M3: MEMORY_GROWTH 要求单调增 + 斜率超阈值', () => {
  const det = detect.createDetector({ memStreak: 3, memGrowthMbPerMin: 60 });
  const mk = (mb) => ({ pid: 999, workingSetMB: mb });
  // 60 秒内 0 → 100 → 200 = 200 MB/min，单调，达标
  det.run({ now: 0, procs: { source: 'ffi', rows: [mk(0)] } });
  det.run({ now: 30000, procs: { source: 'ffi', rows: [mk(100)] } });
  const e = det.run({ now: 60000, procs: { source: 'ffi', rows: [mk(200)] } });
  const g = e.filter((x) => x.code === 'MEMORY_GROWTH');
  assert.equal(g.length, 1);
  assert.equal(g[0].evidence.basis, 'win32-working-set-trend');
  assert.ok(g[0].evidence.slopeMbPerMin >= 60);
});

test('M3: MEMORY_GROWTH 不因非单调（有回落）而报 —— 排除正常 GC', () => {
  const det = detect.createDetector({ memStreak: 3, memGrowthMbPerMin: 60 });
  const mk = (mb) => ({ pid: 999, workingSetMB: mb });
  det.run({ now: 0, procs: { source: 'ffi', rows: [mk(0)] } });
  det.run({ now: 30000, procs: { source: 'ffi', rows: [mk(300)] } });
  const e = det.run({ now: 60000, procs: { source: 'ffi', rows: [mk(100)] } }); // 回落
  assert.equal(e.filter((x) => x.code === 'MEMORY_GROWTH').length, 0);
});

test('M3: MEMORY_GROWTH 不因缓慢增长而报（斜率低于阈值）', () => {
  const det = detect.createDetector({ memStreak: 3, memGrowthMbPerMin: 60 });
  const mk = (mb) => ({ pid: 999, workingSetMB: mb });
  det.run({ now: 0, procs: { source: 'ffi', rows: [mk(0)] } });
  det.run({ now: 60000, procs: { source: 'ffi', rows: [mk(10)] } });
  const e = det.run({ now: 120000, procs: { source: 'ffi', rows: [mk(20)] } });
  assert.equal(e.filter((x) => x.code === 'MEMORY_GROWTH').length, 0, '10 MB/min < 60 阈值');
});

test('M3: IO_STORM 判据是相邻两周期的累计量增量（不是 streak）', () => {
  const det = detect.createDetector({ ioStormMbPerTick: 100 });
  const mk = (readMB) => ({ pid: 555, readMB, writeMB: 0 });
  const a = det.run({ now: 1000, procs: { source: 'ffi', rows: [mk(0)] } });
  assert.equal(a.filter((e) => e.code === 'IO_STORM').length, 0, '首次无基线不报');
  const b = det.run({ now: 2000, procs: { source: 'ffi', rows: [mk(50)] } });
  assert.equal(b.filter((e) => e.code === 'IO_STORM').length, 0, '增量 50 < 100 不报');
  const c = det.run({ now: 3000, procs: { source: 'ffi', rows: [mk(300)] } });
  const s = c.filter((e) => e.code === 'IO_STORM');
  assert.equal(s.length, 1, '增量 250 ≥ 100 报');
  assert.equal(s[0].evidence.deltaMB, 250);
});

test('M3: IO 计数回绕/负增量不报（进程被复用）', () => {
  const det = detect.createDetector({ ioStormMbPerTick: 100 });
  det.run({ now: 1000, procs: { source: 'ffi', rows: [{ pid: 555, readMB: 500, writeMB: 0 }] } });
  const e = det.run({ now: 2000, procs: { source: 'ffi', rows: [{ pid: 555, readMB: 10, writeMB: 0 }] } });
  assert.equal(e.filter((x) => x.code === 'IO_STORM').length, 0);
});

test('M3: SESSION_STALL 只在「事件仍在流（asOfSeq 推进）但时间零增长」时报（推断，最弱）', () => {
  const det = detect.createDetector({ stallTicks: 3 });
  // asOfSeq 每周期都在推进（会话仍在产生事件），但 llm/tool/step 增量为 0
  const mk = (i) => ({
    id: 'sess-1', title: 'T', steps: 4, asOfSeq: 100 + i,
    dLlmMs: 0, dToolMs: 0, dSteps: 0, llmMs: 10, toolMs: 5,
  });
  const runs = [];
  for (let i = 0; i < 4; i += 1) runs.push(det.run({ now: 1000 * (i + 1), sessions: { sessions: [mk(i)] } }));
  assert.equal(runs[0].filter((e) => e.code === 'SESSION_STALL').length, 0, '第 1 周期无前值，不算');
  assert.equal(runs[1].filter((e) => e.code === 'SESSION_STALL').length, 0);
  assert.equal(runs[2].filter((e) => e.code === 'SESSION_STALL').length, 0);
  const hit = runs[3].filter((e) => e.code === 'SESSION_STALL');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].severity, 'P2');
  assert.equal(hit[0].evidence.basis, 'events-flow-but-no-llm-tool-time');
  assert.equal(hit[0].evidence.asOfSeq, 103);
  assert.ok(hit[0].reason.includes('推断'));
});

test('M3: SESSION_STALL 已结束/空闲会话（asOfSeq 冻结）不报 —— 实测 45.6% 噪声的源头', () => {
  const det = detect.createDetector({ stallTicks: 2 });
  // 投影里已结束会话与停摆会话**无法区分**，都是「asOfSeq 冻结 + 时间不增」；
  // 故只认「事件在流」这一种可观测异常 —— 冻结的一律不报。
  const s = { id: 'sess-done', steps: 4, asOfSeq: 500, dLlmMs: 0, dToolMs: 0, dSteps: 0, llmMs: 900, toolMs: 400 };
  for (let i = 0; i < 6; i += 1) {
    const e = det.run({ now: 1000 * (i + 1), sessions: { sessions: [s] } });
    assert.equal(e.filter((x) => x.code === 'SESSION_STALL').length, 0, `第 ${i + 1} 周期不得报`);
  }
});

test('M3: 会话有增量时不报停摆', () => {
  const det = detect.createDetector({ stallTicks: 2 });
  const mk = (seq) => ({ id: 'sess-2', steps: 4, asOfSeq: seq, dLlmMs: 500, dToolMs: 0, dSteps: 1, llmMs: 10, toolMs: 5 });
  det.run({ now: 1000, sessions: { sessions: [mk(1)] } });
  const e = det.run({ now: 2000, sessions: { sessions: [mk(2)] } });
  assert.equal(e.filter((x) => x.code === 'SESSION_STALL').length, 0);
});

test('M3: reset() 清空全部内部状态（供测试与热重载）', () => {
  const det = detect.createDetector({ hotStreak: 1, goneMinTicks: 1 });
  const row = { pid: 1, cpuPct: 95 };
  det.run({ now: 1000, procs: { source: 'ffi', rows: [row] } });
  det.reset();
  const e = det.run({ now: 1100, procs: { source: 'ffi', rows: [row] } });
  assert.equal(e.filter((x) => x.code === 'HOT_PROCESS').length, 1, 'reset 后抑制表清空，可再次上报');
  // pidTicks 也必须被清空：否则 reset 后 pid 1 的「连续存在」计数会带着旧值继续累加
  det.reset();
  det.run({ now: 1200, procs: { source: 'ffi', rows: [row] } });
  const gone = det.run({ now: 1300, procs: { source: 'ffi', rows: [] } });
  assert.equal(gone.filter((x) => x.code === 'PROCESS_GONE').length, 1, 'reset 后 pidTicks 归零，1 个周期即可判定');
});

// ══════════════════════════════════════════════════════════════════════
// 四、monitor/store —— 有界环形落盘（不能成为新的写放大源）
// ══════════════════════════════════════════════════════════════════════

test('M2: 样本落盘到 monitor.v1.jsonl，读回形状一致', async () => {
  const dir = mkTmp('mon-store');
  const r = await store.appendSamples([{ v: 1, time: 1, selfMs: 0.5 }, { v: 1, time: 2, selfMs: 0.7 }], { dir });
  assert.equal(r.appended, 2);
  const back = await store.readSamples({ dir });
  assert.equal(back.existed, true);
  assert.equal(back.total, 2);
  assert.equal(back.badLines, 0);
  assert.equal(back.rows[1].time, 2);
});

test('M2: 空数组不写盘（避免制造空行与无谓 IO）', async () => {
  const dir = mkTmp('mon-store');
  const r = await store.appendSamples([], { dir });
  assert.equal(r.appended, 0);
  const back = await store.readSamples({ dir });
  assert.equal(back.existed, false);
});

test('M2: 读回只取最后 N 条（limit）', async () => {
  const dir = mkTmp('mon-store');
  const rows = Array.from({ length: 10 }, (_, i) => ({ v: 1, time: i }));
  await store.appendSamples(rows, { dir });
  const back = await store.readSamples({ dir, limit: 3 });
  assert.equal(back.total, 10, 'total 是全量行数');
  assert.equal(back.rows.length, 3);
  assert.equal(back.rows[2].time, 9, '取的是最后 3 条');
});

test('M2: 坏行被跳过并计数（不因一行损坏丢掉整个文件）', async () => {
  const dir = mkTmp('mon-store');
  const p = store.monitorPaths(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p.samples, '{"v":1,"time":1}\nNOT_JSON\n{"v":1,"time":3}\n', 'utf8');
  const back = await store.readSamples({ dir });
  assert.equal(back.total, 2);
  assert.equal(back.badLines, 1);
});

test('M2: 环形裁剪是「块裁剪」——超过 max*1.25 才裁，一次裁到 max*0.75', async () => {
  const dir = mkTmp('mon-store');
  // max=4 → 超过 5 才裁，裁到 3
  await store.appendSamples(Array.from({ length: 5 }, (_, i) => ({ v: 1, time: i })), { dir, max: 4 });
  const a = await store.readSamples({ dir, limit: 0 });
  assert.equal(a.total, 5, '恰好 5 条不触发裁剪（5 不 > 4*1.25=5）');
  const r = await store.appendSamples([{ v: 1, time: 99 }], { dir, max: 4 });
  assert.equal(r.trimmed, 3, '6 > 5 触发裁剪，裁到 floor(4*0.75)=3');
  const b = await store.readSamples({ dir, limit: 0 });
  assert.equal(b.total, 3);
  assert.equal(b.rows[2].time, 99, '保留的是最新的');
});

test('M2: 事件文件独立且不裁剪（事件量小、是诊断依据）', async () => {
  const dir = mkTmp('mon-store');
  await store.appendEvents([{ v: 1, time: 1, code: 'HOT_PROCESS' }], { dir });
  await store.appendEvents([{ v: 1, time: 2, code: 'IO_STORM' }], { dir });
  const back = await store.readEvents({ dir });
  assert.equal(back.existed, true);
  assert.equal(back.total, 2);
  assert.equal(back.events[1].code, 'IO_STORM');
  // 样本与事件是不同文件
  assert.notEqual(store.monitorPaths(dir).samples, store.monitorPaths(dir).events);
});

test('M2: meta 读写与 sampleFileSize', async () => {
  const dir = mkTmp('mon-store');
  assert.equal(await store.readMeta(dir), null);
  await store.writeMeta({ startedAt: 123 }, dir);
  assert.equal((await store.readMeta(dir)).startedAt, 123);
  assert.equal(await store.sampleFileSize(dir), 0, '无样本文件时返回 0 而非抛错');
  await store.appendSamples([{ v: 1, time: 1 }], { dir });
  assert.ok(await store.sampleFileSize(dir) > 0);
});

test('M2: monitorDir 尊重 DSH_MONITOR_HOME 覆盖（隔离测试用）', () => {
  const old = process.env.DSH_MONITOR_HOME;
  const dir = mkTmp('mon-home');
  process.env.DSH_MONITOR_HOME = dir;
  try {
    assert.equal(store.monitorDir(), dir);
  } finally {
    if (old === undefined) delete process.env.DSH_MONITOR_HOME; else process.env.DSH_MONITOR_HOME = old;
  }
});

test('M2: 写失败不抛（监控绝不能成为插件崩溃源）', async () => {
  // 指向一个不可能创建成功的路径（Windows 非法字符）
  const bad = path.join(mkTmp('mon-store'), 'a\u0000b');
  const r = await store.appendSamples([{ v: 1 }], { dir: bad });
  assert.ok(r.error !== undefined || r.appended === 0);
  assert.equal(r.appended, 0);
});

// ══════════════════════════════════════════════════════════════════════
// 五、monitor/procs —— 进程层（FFI 直读 + 异步进程树）
// ══════════════════════════════════════════════════════════════════════

test('M2: classify 识别宿主自身 / renderer / NodeService / 主进程', () => {
  assert.equal(procs.classify('x', '', true), 'host', 'isSelfPid 优先');
  assert.equal(procs.classify('node.exe', '--type=renderer', false), 'renderer');
  assert.equal(procs.classify('node.exe', '--type=utility --utility-sub-type=node.mojom.NodeService', false), 'host');
  assert.equal(procs.classify('node.exe', '--type=utility --utility-sub-type=network.mojom.NetworkService', false), 'network');
  assert.equal(procs.classify('DSH Desktop.exe', 'D:\\DSH Desktop.exe', false), 'main');
  assert.equal(procs.classify('node.exe', 'dsh-subprocess-local\\lib\\runner.js', false), 'tool-runner');
  assert.equal(procs.classify('node.exe', 'dsh-ego-browser\\bin\\ego-cast-worker.mjs', false), 'ego-worker');
  assert.equal(procs.classify('node.exe', '--type=crashpad-handler', false), 'crashpad');
  assert.equal(procs.classify('node.exe', '--type=gpu-process', false), 'gpu');
  assert.equal(procs.classify('other.exe', 'whatever', false), 'other');
});

test('M2: cpuPercent = 累计 CPU 差分 / 墙钟', () => {
  // 1000 ms 内消耗 1000 ms CPU（单核满）→ 100%
  assert.equal(procs.cpuPercent({ cpu100ns: 0n }, { cpu100ns: 10_000_000n }, 1000), 100);
  // 同样时间消耗 2000 ms CPU（双核）→ 200%
  assert.equal(procs.cpuPercent({ cpu100ns: 0n }, { cpu100ns: 20_000_000n }, 1000), 200);
  // 一半
  assert.equal(procs.cpuPercent({ cpu100ns: 0n }, { cpu100ns: 5_000_000n }, 1000), 50);
});

test('M2: cpuPercent 对缺失/非法输入返回 null 而非 NaN（不制造伪精度）', () => {
  assert.equal(procs.cpuPercent(null, { cpu100ns: 1n }, 1000), null);
  assert.equal(procs.cpuPercent({ cpu100ns: 0n }, null, 1000), null);
  assert.equal(procs.cpuPercent({ cpu100ns: 0n }, { cpu100ns: 1n }, 0), null, '墙钟为 0 不可除');
  // 计数器回绕（负增量）
  assert.equal(procs.cpuPercent({ cpu100ns: 100n }, { cpu100ns: 10n }, 1000), null);
});

test('M2: 采样入口存在且返回 Promise（异步，绝不阻塞 agent loop）', async () => {
  assert.equal(typeof procs.sampleAll, 'function');
  assert.equal(typeof procs.listProcesses, 'function');
  assert.equal(typeof procs.sample, 'function');
  const p = procs.listProcesses();
  assert.ok(p instanceof Promise, 'listProcesses 必须是异步的（曾因 execFileSync 阻塞事件循环 300ms 被修）');
  await p; // 让它跑完，避免悬挂
});

test('M2: 源码级 —— 绝不用 execFileSync（会阻塞 Host 事件循环，等于监控卡死被监控者）', () => {
  const src = fs.readFileSync(path.join(root, 'lib', 'monitor', 'procs.js'), 'utf8');
  assert.ok(!/execFileSync\s*\(/.test(src), 'procs.js 不得出现 execFileSync 调用');
  assert.ok(/from 'node:child_process'/.test(src));
  assert.ok(/\bexecFile\b/.test(src), '应使用异步 execFile');
});

test('M2: 源码级 —— FFI scratch 缓冲复用（消除每 tick 上百次短命对象分配）', () => {
  const src = fs.readFileSync(path.join(root, 'lib', 'monitor', 'procs.js'), 'utf8');
  assert.ok(/scratch\s*=\s*\{/.test(src), '应建立 scratch 缓冲对象');
  // sample() 内不得再逐次 alloc
  const body = src.slice(src.indexOf('export async function sample'));
  const sampleFn = body.slice(0, body.indexOf('\n}\n'));
  assert.ok(!/koffi\.alloc/.test(sampleFn), 'sample() 内不得每次 alloc（必须复用 scratch）');
  assert.ok(/scratch\.c/.test(sampleFn), 'sample() 应使用 scratch 缓冲');
});

// ══════════════════════════════════════════════════════════════════════
// 六、monitor/plugins + sessions —— 插件层与会话层采集
// ══════════════════════════════════════════════════════════════════════

test('M2: readPlugins 读 loader entries，跳过 group，标注自身', () => {
  const ctx = {
    loader: {
      entries: () => [
        { id: 'g1', options: { group: true } },
        { id: 'p1', options: { id: 'p1', name: 'dsh-demo' }, fiber: { state: 2 } },
        { id: 'p2', options: { id: 'p2', name: 'dsh-efficiency' }, fiber: { state: 3 } },
        { id: 'p3', options: { id: 'p3', name: 'x' }, disabled: true, fiber: { state: 0 } },
      ],
    },
  };
  const r = pluginLayer.readPlugins(ctx);
  assert.equal(r.source, 'loader');
  assert.equal(r.plugins.length, 3, 'group 必须被跳过');
  const p1 = r.plugins.find((p) => p.entryId === 'p1');
  assert.equal(p1.fiberPhase, 'active');
  assert.equal(p1.self, false);
  const p2 = r.plugins.find((p) => p.entryId === 'p2');
  assert.equal(p2.fiberPhase, 'failed');
  assert.equal(p2.self, true, '本插件自己应被标注');
  const p3 = r.plugins.find((p) => p.entryId === 'p3');
  assert.equal(p3.enabled, false);
  assert.equal(p3.fiberPhase, 'pending');
  assert.equal(r.counts.failed, 1);
});

test('M2: loader 不可用时不抛，且如实报 source=none（不得把「没接上」说成「空结果」）', () => {
  const r = pluginLayer.readPlugins({});
  assert.equal(r.source, 'none', 'loader 服务不可用时 source 必须是 none，不能谎报 loader');
  assert.deepEqual(r.plugins, []);
  assert.ok(typeof r.note === 'string' && r.note.length > 0);
});

test('M2: rankPluginCandidates 把装载失败强制置顶（确定问题优先）', () => {
  const ranked = pluginLayer.rankPluginCandidates([
    { entryId: 'a', fiberPhase: 'active', enabled: true },
    { entryId: 'b', fiberPhase: 'failed', enabled: true },
    { entryId: 'c', fiberPhase: 'loading', enabled: true },
    { entryId: 'd', fiberPhase: 'active', enabled: false },
  ]);
  assert.equal(ranked[0].entryId, 'b');
  assert.match(ranked[0].reason, /装载失败/);
  assert.equal(ranked[1].entryId, 'c');
  assert.match(ranked[1].reason, /未完成装载/);
  assert.equal(ranked[2].entryId, 'd');
  assert.match(ranked[2].reason, /已禁用/);
});

test('M2: readSessions 从投影读 sessionStats，落盘只存增量', () => {
  sessionLayer.resetSessionBaselines();
  const s = { id: 'sess-A', title: 't', header: { cwd: 'D:\\x' } };
  const ctx = {
    sessions: { list: () => [s] },
    sessionProjections: {
      stateOf: () => ({ turns: 2, steps: 5, llmMs: 1000, toolMs: 500, decodeTokens: 10 }),
      snapshot: () => ({ asOfSeq: 42 }),
    },
  };
  const r1 = sessionLayer.readSessions(ctx);
  assert.equal(r1.source, 'projection');
  assert.equal(r1.sessions.length, 1);
  assert.equal(r1.sessions[0].dLlmMs, 1000, '首次无基线 → 增量即当前值');
  assert.equal(r1.sessions[0].dSteps, 5);
  assert.equal(r1.sessions[0].cwd, 'D:\\x');
  assert.equal(r1.sessions[0].asOfSeq, 42);

  // 第二次：llmMs 增到 1500 → 增量应为 500
  ctx.sessionProjections.stateOf = () => ({ turns: 2, steps: 5, llmMs: 1500, toolMs: 500, decodeTokens: 10 });
  const r2 = sessionLayer.readSessions(ctx);
  assert.equal(r2.sessions[0].dLlmMs, 500, '第二次应只报增量');
  assert.equal(r2.sessions[0].dSteps, 0);
});

test('M2: 投影服务不可用时给 note，不抛（该 profile 可能没装 session-stats）', () => {
  const ctx = { sessions: { list: () => [{ id: 'x' }] } };
  const r = sessionLayer.readSessions(ctx);
  assert.equal(r.sessions.length, 0);
  assert.ok(r.note.includes('sessionProjections'));
});

test('M2: sessions.list 抛错被吞掉并记录 note', () => {
  const ctx = { sessions: { list: () => { throw new Error('boom'); } } };
  const r = sessionLayer.readSessions(ctx);
  assert.equal(r.sessions.length, 0);
  assert.ok(r.note.includes('boom'));
});

// ══════════════════════════════════════════════════════════════════════
// 七、interfaces —— 接口面索引（目标 1：让别的插件能复用宿主）
// ══════════════════════════════════════════════════════════════════════

test('M1: hostNodeModules 尊重 DSH_HOST_NODE_MODULES 显式覆盖', () => {
  const old = process.env.DSH_HOST_NODE_MODULES;
  const dir = mkTmp('nm');
  process.env.DSH_HOST_NODE_MODULES = dir;
  try {
    assert.equal(iface.hostNodeModules(), dir);
  } finally {
    if (old === undefined) delete process.env.DSH_HOST_NODE_MODULES; else process.env.DSH_HOST_NODE_MODULES = old;
  }
});

test('M1: hostNodeModules 在路径不存在时继续兜底（不返回无效路径）', () => {
  const old = process.env.DSH_HOST_NODE_MODULES;
  process.env.DSH_HOST_NODE_MODULES = path.join(mkTmp('nm'), 'does-not-exist');
  try {
    const r = iface.hostNodeModules();
    assert.notEqual(r, process.env.DSH_HOST_NODE_MODULES, '不存在的显式路径必须被跳过');
  } finally {
    if (old === undefined) delete process.env.DSH_HOST_NODE_MODULES; else process.env.DSH_HOST_NODE_MODULES = old;
  }
});

test('M1: scanTypertRemotes 解析 typert.host.js 的 invocations（纯数据模块，正则提取）', () => {
  const nm = mkTmp('nm');
  const pkgDir = path.join(nm, '@deepseek-ai', 'dsh-demo', 'lib');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'typert.host.js'), [
    'const TYPERT = {',
    '  invocations: [',
    "    { id: 'demo.alpha', service: 'demo', namespace: 'demo', method: 'alpha' },",
    "    { id: 'demo.beta', service: 'demo', namespace: 'demo', method: 'beta' },",
    '  ]',
    '};',
    'export { TYPERT };',
  ].join('\n'), 'utf8');
  const out = iface.scanTypertRemotes(nm);
  assert.equal(out.length, 2);
  assert.equal(out[0].pkg, '@deepseek-ai/dsh-demo');
  assert.equal(out[0].id, 'demo.alpha');
  assert.equal(out[0].service, 'demo');
  assert.equal(out[0].method, 'alpha');
  assert.ok(out[0].file.includes('typert.host.js'));
});

test('M1: scanBundleRows 解析 cordis.patch.yml 的 id+name 行', () => {
  const nm = mkTmp('nm');
  const pkgDir = path.join(nm, '@deepseek-ai', 'dsh-base');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'cordis.patch.yml'), [
    '- id: session-stats',
    '  name: "@deepseek-ai/dsh-session-stats"',
    '- id: tools',
    '  name: "@deepseek-ai/dsh-tools"',
  ].join('\n'), 'utf8');
  const out = iface.scanBundleRows(nm);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'session-stats');
  assert.equal(out[0].name, '@deepseek-ai/dsh-session-stats');
  assert.equal(out[0].bundle, 'dsh-base');
});

test('M1: nm 为 null 时静态扫描返回空数组而非抛错', () => {
  assert.deepEqual(iface.scanTypertRemotes(null), []);
  assert.deepEqual(iface.scanBundleRows(null), []);
});

test('M1: 19 个已知客户端插槽都有专属触发词（否则检索退化成任意并列）', () => {
  const ids = Object.keys(iface.SLOT_HINTS);
  assert.equal(ids.length, 19);
  for (const id of ids) {
    assert.ok(iface.SLOT_HINTS[id].length >= 1, `${id} 缺语义触发词`);
  }
  // 关键插槽的触发词必须语义专属
  assert.ok(iface.SLOT_HINTS['shell.overlay'].includes('浮窗'));
  assert.ok(iface.SLOT_HINTS['conversation.input.dock'].includes('输入框下方'));
});

test('M1: slotTriggers 合并 id 本身与语义提示', () => {
  const t = iface.slotTriggers('shell.overlay');
  assert.ok(t.includes('shell.overlay'));
  assert.ok(t.includes('浮窗'));
  assert.ok(t.includes('插槽'));
  assert.equal(new Set(t).size, t.length, '不得有重复项');
});

test('M1: scanSlots 从插件 client bundle 反推插槽消费者', () => {
  const dir = mkTmp('plug');
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'client.js'),
    "slots.get('shell.overlay').register(x); slots.get('settings.section').register(y);", 'utf8');
  const out = iface.scanSlots([dir]);
  assert.equal(out.length, 19, '始终返回全部已知插槽（未被使用则 usedBy 为空）');
  const overlay = out.find((s) => s.id === 'shell.overlay');
  assert.ok(overlay.usedBy.includes(path.basename(dir)));
  const unused = out.find((s) => s.id === 'sidebar.entry');
  assert.deepEqual(unused.usedBy, []);
});

test('M1: KNOWN_SERVICES 只声称已知服务，且每条都带可粘贴的 how', () => {
  assert.ok(iface.KNOWN_SERVICES.length >= 13);
  for (const s of iface.KNOWN_SERVICES) {
    assert.ok(typeof s.name === 'string' && s.name.length > 0);
    assert.ok(typeof s.note === 'string' && s.note.length > 0, `${s.name} 缺说明`);
    assert.ok(typeof s.how === 'string' && s.how.length > 0, `${s.name} 缺调用方式`);
  }
  const names = iface.KNOWN_SERVICES.map((s) => s.name);
  for (const must of ['systemPrompt', 'tools', 'webServer', 'loader', 'sessions', 'sessionProjections']) {
    assert.ok(names.includes(must), `缺少核心服务 ${must}`);
  }
});

test('M1: scanInterfaces 无 ctx 时 available=null、origin=static（不假装知道可用性）', () => {
  const scan = iface.scanInterfaces({ nm: null });
  assert.equal(scan.services.length, iface.KNOWN_SERVICES.length);
  for (const s of scan.services) {
    assert.equal(s.available, null, '无 ctx 时可用性必须为 null，不得猜 true/false');
    assert.equal(s.origin, 'static');
  }
  assert.deepEqual(scan.remotes, []);
  assert.equal(scan.slots.length, 19);
});

test('M1: scanInterfaces 有 ctx 时补 available 真值并标 origin=runtime', () => {
  const ctx = { get: (n) => (n === 'systemPrompt' ? { section() {} } : undefined) };
  const scan = iface.scanInterfaces({ nm: null, ctx });
  const sp = scan.services.find((s) => s.name === 'systemPrompt');
  const missing = scan.services.find((s) => s.name === 'shortcuts');
  assert.equal(sp.available, true);
  assert.equal(sp.origin, 'runtime');
  assert.equal(missing.available, false);
  assert.equal(missing.origin, 'runtime');
});

test('M1: scanInterfaces 的 ctx.get 抛错被吞（单服务探测失败不影响整体）', () => {
  const ctx = { get: () => { throw new Error('nope'); } };
  const scan = iface.scanInterfaces({ nm: null, ctx });
  assert.ok(scan.services.every((s) => s.available === false));
});

test('M1: interfacesToEntries 产出 type=interface 条目，每条带 invoke.how 与 fingerprint', () => {
  const entries = iface.interfacesToEntries(iface.scanInterfaces({ nm: null }));
  assert.equal(entries.length, iface.KNOWN_SERVICES.length + 19 + 2, '服务 + 19 插槽 + 2 路由前缀');
  for (const e of entries) {
    assert.equal(e.type, 'interface');
    assert.ok(typeof e.name === 'string' && e.name.length > 0);
    assert.ok(typeof e.description === 'string' && e.description.length > 0, `${e.name} 缺描述`);
    assert.ok(Array.isArray(e.triggers) && e.triggers.length > 0, `${e.name} 缺触发词`);
    assert.ok(typeof e.invoke?.how === 'string' && e.invoke.how.length > 0, `${e.name} 缺可粘贴的 how`);
    assert.ok(typeof e.fingerprint === 'string' && e.fingerprint.length === 8, `${e.name} 指纹格式不对`);
    assert.ok(e.source.startsWith('interface:'));
  }
  // 指纹必须唯一（否则清单去重会误合并）
  const fps = entries.map((e) => e.fingerprint);
  assert.equal(new Set(fps).size, fps.length, '指纹必须唯一');
});

test('M1: 路由前缀条目登记本插件命名空间与宿主桌面控制', () => {
  const entries = iface.interfacesToEntries(iface.scanInterfaces({ nm: null }));
  const routes = entries.filter((e) => e.source === 'interface:route');
  const names = routes.map((r) => r.name);
  assert.ok(names.includes('/api/efficiency'), '必须登记改名后的新前缀');
  assert.ok(!names.includes('/api/capability-aware'), '不得残留旧品牌');
});

test('M1: probeInterfaces 是 scanInterfaces + interfacesToEntries 的便捷入口', () => {
  const e = iface.probeInterfaces({ nm: null });
  assert.ok(Array.isArray(e) && e.length > 0);
  assert.ok(e.every((x) => x.type === 'interface'));
});

// ══════════════════════════════════════════════════════════════════════
// 八、efficiency-section —— 第三段常驻指令面（order 2952）
// ══════════════════════════════════════════════════════════════════════

test('M5: 段名与位次 —— efficiency:resource-index / 2952（与前两段连续且不抢槽位）', () => {
  assert.equal(effSection.SECTION_NAME, 'efficiency:resource-index');
  assert.equal(effSection.SECTION_ORDER, 2952);
});

test('M5: 正文含三段各自的问题、CLI 入口与分档语义', () => {
  const t = effSection.efficiencySectionText('9.9.9');
  assert.ok(t.includes('9.9.9'), '必须带版本');
  assert.ok(t.includes('本机效率与资源健康'));
  assert.ok(t.includes('cap.mjs monitor'));
  assert.ok(t.includes('cap.mjs diagnose'));
  assert.ok(t.includes('cap.mjs fixprompt'));
  assert.ok(t.includes('P0'));
  assert.ok(t.includes('P3'));
});

test('M5: 正文显式警告「P3 一律不要动」并解释理由（防止 agent 去修供应商限流）', () => {
  const t = effSection.efficiencySectionText('1.0.0');
  assert.ok(t.includes('P3 一律不要动'));
  assert.ok(t.includes('占全部错误的四成'));
  assert.ok(t.includes('改本机代码对它们无效'));
});

test('M5: 正文含监控数据的四条诚实边界（不把推断当事实）', () => {
  const t = effSection.efficiencySectionText('1.0.0');
  assert.ok(t.includes('无法据此归因到单个插件'));
  assert.ok(t.includes('相关性排序，不是 CPU 归因'));
  assert.ok(t.includes('非宿主官方计费口径'));
  assert.ok(t.includes('相关性，不是因果'));
});

test('M5: mountEfficiencySection 经 ctx.inject 软注入并注册 section（order 从中央常量推导）', () => {
  const registered = [];
  const scoped = {
    systemPrompt: {
      getSectionOrder: () => 3000,
      section: (o) => { registered.push(o); return () => {}; },
    },
    effect: (fn) => fn(),
  };
  const ctx = { inject: (deps, cb) => { assert.deepEqual(deps, ['systemPrompt']); cb(scoped); } };
  const r = effSection.mountEfficiencySection(ctx, { version: '9.9.9' });
  assert.equal(r.mounted, true);
  assert.equal(r.order, 2952, '3000 - 48');
  assert.equal(r.diag.injectCalled, 1);
  assert.equal(r.diag.sawService, true);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, 'efficiency:resource-index');
  assert.equal(registered[0].order, 2952);
  assert.equal(registered[0].interpolate, false);
  assert.equal(typeof registered[0].text, 'function');
  assert.ok(registered[0].text().includes('9.9.9'));
});

test('M5: 无 systemPrompt 服务时优雅降级（其余功能不受影响）', () => {
  const ctx = { inject: (deps, cb) => cb({}) };
  const r = effSection.mountEfficiencySection(ctx, {});
  assert.equal(r.mounted, false);
  assert.equal(r.reason, 'no-systemPrompt');
});

test('M5: enabled=false 与无 ctx 时不挂载', () => {
  assert.equal(effSection.mountEfficiencySection({}, { enabled: false }).reason, 'disabled');
  assert.equal(effSection.mountEfficiencySection(null, {}).reason, 'no-ctx');
});

test('M5: section() 抛错被捕获，不影响监控/诊断/CLI', () => {
  const scoped = {
    systemPrompt: { getSectionOrder: () => 3000, section: () => { throw new Error('duplicate'); } },
    effect: (fn) => fn(),
  };
  const ctx = { inject: (deps, cb) => cb(scoped) };
  const r = effSection.mountEfficiencySection(ctx, {});
  assert.equal(r.mounted, false);
  assert.ok(r.reason.includes('duplicate'));
});

test('M5: 源码级 —— 三坑防护（软注入/effect 包裹/原地改属性，不得乐观谎报 mounted）', () => {
  const src = fs.readFileSync(path.join(root, 'lib', 'efficiency-section.js'), 'utf8');
  assert.ok(/ctx\.inject\(\['systemPrompt'\]/.test(src), '必须软注入 systemPrompt');
  assert.ok(/scoped\.effect\(/.test(src), 'section() 必须包在 effect 里（否则热重载重名抛错）');
  assert.ok(/const result = \{ mounted: false/.test(src), '必须先建对象');
  assert.ok(/result\.mounted = true/.test(src), '回调内原地改属性');
  assert.ok(!/return \{ mounted: true/.test(src), '不得同步乐观返回 mounted:true');
});

// ══════════════════════════════════════════════════════════════════════
// 九、接线与命名空间完整性（改名后不留旧品牌）
// ══════════════════════════════════════════════════════════════════════

test('v0.9.0: index.js 接线第三段且默认开启', () => {
  const src = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8');
  assert.ok(/from '\.\/efficiency-section\.js'/.test(src), '必须导入效率段');
  assert.ok(/mountEfficiencySection\(ctx/.test(src), '必须调用 mountEfficiencySection');
  assert.ok(/apply\.__efficiencySection\s*=/.test(src), '必须暴露句柄供 CLI/测试');
});

test('v0.9.0: index.js 接线监控且默认开启（可 monitor:false 关闭）', () => {
  const src = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8');
  assert.ok(/from '\.\/monitor\/index\.js'/.test(src));
  assert.ok(/mountMonitor\(ctx/.test(src));
  assert.ok(/apply\.__monitor\s*=/.test(src));
});

test('v0.9.0: 执行路径无旧品牌残留（改名完整性）', () => {
  // 检查范围＝**会被宿主加载/执行的部件**：`lib/**` 与 `cap.mjs`。
  //
  // 为什么不扫「全仓」：文档必须能写出旧名才能说明「改了什么」——
  //   · `README.md` / `README.en.md` 的 v0.9.0 改名段要写「旧名 → 新名」，
  //     否则读者不知道迁移了什么；
  //   · `docs/research-*.md` 是带日期的历史记录，改写等于篡改历史证据；
  //   · `test/` 的夹具要证明「旧 AGENTS.md 块会被退役」，就得先持有旧串；
  //   · `lib/provision.js` 的 `LEGACY_MARK_PAIRS` / `LEGACY_SKILLS` 存的就是旧标记，
  //     那是「为了删除而引用」。
  // 把这些算作「残留」，等于要求改名者无法清理也无从记录自己的历史产物。
  // 真正会伤人的残留是**执行路径上的死引用**（旧 RPC 前缀、旧数据目录、
  // 旧工具名、旧环境变量），故只扫这里 —— 保护没减弱，误报被去掉。
  const bad = ['capability-aware', 'capability_query', 'capability-lookup', 'DSH_CAP_DSH_HOME', 'dsh-capability-aware'];
  const files = [path.join(root, 'cap.mjs')];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js') || e.name.startsWith('_')) continue;
      if (p === path.join(root, 'lib', 'provision.js')) continue;   // 为删除而引用
      files.push(p);
    }
  })(path.join(root, 'lib'));
  assert.ok(files.length > 20, `应扫到全部执行部件，实际 ${files.length}`);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const b of bad) {
      assert.ok(!src.includes(b), `${path.relative(root, f)} 残留旧品牌「${b}」`);
    }
  }
});

test('v0.9.0: 文档里的旧名只允许出现在「改名说明」语境（不得指导用户走死路径）', () => {
  // 文档豁免 ≠ 不管。旧名若出现在**可执行指引**里（路径/命令），那就是真的死引用。
  for (const rel of ['README.md', 'README.en.md']) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    // 死路径形态：node_modules\<旧包名> 或 file:D:/...\<旧目录名>
    assert.ok(!/node_modules[\\/]dsh-capability-aware/.test(src), `${rel} 不得出现旧安装路径`);
    assert.ok(!/file:[^\s`"]*dsh-capability-aware/.test(src), `${rel} 不得出现旧 file: 依赖路径`);
    assert.ok(!/cap\.mjs[^\n]*capability_query/.test(src), `${rel} 不得指引已改名前的工具名`);
  }
});

test('v0.9.0: 三个提示词段同命名空间 efficiency:*，位次连续', () => {
  const a = fs.readFileSync(path.join(root, 'lib', 'prompt-section.js'), 'utf8');
  const b = fs.readFileSync(path.join(root, 'lib', 'ledger', 'prompt-section.js'), 'utf8');
  assert.ok(a.includes("'efficiency:capability-index'"));
  assert.ok(b.includes("'efficiency:error-index'"));
  assert.equal(effSection.SECTION_NAME, 'efficiency:resource-index');
  const orders = [
    Number((a.match(/SECTION_ORDER\s*=\s*(\d+)/) || [])[1]),
    Number((b.match(/SECTION_ORDER\s*=\s*(\d+)/) || [])[1]),
    effSection.SECTION_ORDER,
  ];
  assert.deepEqual(orders, [2950, 2951, 2952], '三段位次必须连续且有序');
});

// ══════════════════════════════════════════════════════════════════════
// 十、诊断 RPC 接线（目标 3 的可编程入口）
// ══════════════════════════════════════════════════════════════════════

/**
 * 在**隔离的 DSH home** 里跑一次真实 `apply()`。
 *
 * 必须隔离：`apply()` 会真的挂账本与监控，不隔离就会写用户真实的
 * `~/.dsh/data/efficiency/`。故临时改写三个环境变量并在结束后还原。
 * 同时关掉 `scanOnBoot`/`watch`/`periodicMs`/`monitor.enabled`/`promptSection`，
 * 避免留下定时器与多余段（测试只关心路由注册）。
 */
function withIsolatedApply(fn) {
  const home = mkTmp('eff-home');
  const keys = ['DSH_EFF_DSH_HOME', 'DSH_ERROR_LEDGER_HOME', 'DSH_MONITOR_HOME'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.DSH_EFF_DSH_HOME = home;
  process.env.DSH_ERROR_LEDGER_HOME = path.join(home, 'data', 'efficiency', 'ledger');
  process.env.DSH_MONITOR_HOME = path.join(home, 'data', 'efficiency', 'monitor');
  try {
    return fn(home);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

async function applyAndCollectRoutes(extraCfg = {}) {
  // ⚠ 局部名不得叫 `mod`：那会遮蔽模块顶层的 `mod()` 路径助手（TDZ 抛
  //   "Cannot access 'mod' before initialization"）。
  const host = await import(mod('index.js'));
  const routes = [];
  const scoped = {
    webServer: { register: (o) => { routes.push(o.path); return () => {}; } },
    tools: { register: () => () => {} },
    systemPrompt: { getSectionOrder: () => 3000, section: () => () => {} },
    // ⚠ 必须有 `effect`：RPC 注册是 `scoped.effect(() => server.register(...))`。
    //   漏了它 → 回调内抛 TypeError → 被外层 try/catch 吞成一句 warn → routes 全空，
    //   表现为「一条路由都没注册」这种极难定位的假故障（实测踩过）。
    effect: (fn) => fn(),
  };
  const ctx = {
    logger: { info() {}, warn() {} },
    sessions: { list: () => [] },
    on() { return () => {}; },
    effect(fn) { return fn(); },
    inject(deps, cb) { cb(scoped); },
  };
  const cfg = {
    scanOnBoot: false, watch: false, periodicMs: 0, promptSection: false,
    ledger: { capture: false, backfillOnBoot: false },
    monitor: { enabled: false },
    ...extraCfg,
  };
  withIsolatedApply(() => host.apply(ctx, cfg));
  return routes;
}

test('v0.9.0: diagnose 默认挂 /diagnose 与 /fixprompt 两条只读 RPC（目标 3 的可编程入口）', async () => {
  const routes = await applyAndCollectRoutes();
  assert.ok(routes.includes('/api/efficiency/diagnose'), `应注册 /diagnose，实际 ${JSON.stringify(routes)}`);
  assert.ok(routes.includes('/api/efficiency/fixprompt'), '应注册 /fixprompt');
  // 核心 5 条不得因为新增而丢失
  for (const p of ['/api/efficiency/list', '/api/efficiency/query', '/api/efficiency/scan', '/api/efficiency/guide', '/api/efficiency/doctor']) {
    assert.ok(routes.includes(p), `核心路由 ${p} 不得丢失；实际 ${JSON.stringify(routes)}`);
  }
});

test('v0.9.0: diagnose:false 时两条诊断 RPC 都不注册（核心面不受影响）', async () => {
  const routes = await applyAndCollectRoutes({ diagnose: false });
  assert.ok(!routes.includes('/api/efficiency/diagnose'), 'diagnose:false 时不得注册 /diagnose');
  assert.ok(!routes.includes('/api/efficiency/fixprompt'), 'diagnose:false 时不得注册 /fixprompt');
  assert.ok(routes.includes('/api/efficiency/list'), '关掉诊断不得影响核心能力面');
});

test('v0.9.0: index.js 有 diagnose 配置键且默认开启（yml 里承诺的键必须有消费者）', () => {
  const src = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8');
  assert.ok(/diagnose:\s*config\?\.diagnose !== false/.test(src), 'cfg 必须有 diagnose 键且默认 true');
  assert.ok(/cfg\.diagnose !== false/.test(src), 'cfg.diagnose 必须真的被消费（否则是死配置）');
  // 两条路由都必须动态 import 诊断模块（不在模块顶层拉重依赖）
  assert.ok(/import\('\.\/diagnose\.js'\)/.test(src));
  assert.ok(/import\('\.\/fixprompt\.js'\)/.test(src));
});

test('v0.9.0: 诊断 RPC 是只读的 —— 源码级断言不调用任何写盘/修复动作', () => {
  const src = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8');
  const i = src.indexOf('${BASE}/diagnose');
  const j = src.indexOf('${BASE}/fixprompt');
  assert.ok(i > 0 && j > i);
  const seg = src.slice(i, j + 900);
  for (const bad of ['writeFile', 'appendFile', 'rmSync', 'unlink', 'mkdirSync']) {
    assert.ok(!seg.includes(bad), `诊断 RPC 段落不得出现写操作 ${bad}`);
  }
  assert.ok(seg.includes('buildFixPrompt'), 'fixprompt 必须走 buildFixPrompt（只生成文本）');
});

// ══════════════════════════════════════════════════════════════════════
// 十一、真机验证发现的两个缺陷 —— 回归锁定
// ══════════════════════════════════════════════════════════════════════
// 两个都是**纸面测试全绿、真机上才暴露**的缺陷，由宿主 RPC 实测抓到：
//   · 监控心跳 `started:true` 但 `ticks:0` / `errors:45`，
//     `lastError = cannot get property "sessionProjections" without inject`
//   · `doctor` 报 `interface: 0`，而 `cap.mjs interface` 明明能列 174 条
// 故这里的复现必须**忠实于真机形态**（会抛的 getter / 真的走一次轻扫），
// 而不是再写一个"看起来像"的 stub —— 否则同一类缺陷还会再漏过去。

test('M2 回归：真实 Cordis 式「会抛的 getter」不得打断采集（曾致 ticks:0 / errors:45）', () => {
  // 忠实复现：Cordis 把未 inject 的服务装成**会抛的 getter**，`?.` 对 throw 无效。
  const ctx = {};
  for (const name of ['sessionProjections', 'sessions', 'loader']) {
    Object.defineProperty(ctx, name, {
      get() { throw new Error(`cannot get property "${name}" without inject`); },
      configurable: true,
    });
  }
  ctx.get = () => { throw new Error('cannot get service without inject'); };

  // 会话层：不得抛，且必须如实说明投影不可用
  const r = sessionLayer.readSessions(ctx);
  assert.equal(r.sessions.length, 0);
  assert.ok(String(r.note).includes('sessionProjections'), `note 应说明投影不可用：${r.note}`);

  // 插件层：不得抛（旧写法会被 catch 吞成 source:'none'，即该层永不工作）
  const p = pluginLayer.readPlugins(ctx);
  assert.equal(p.plugins.length, 0);
  assert.equal(p.source, 'none');
  assert.ok(typeof p.note === 'string');
});

test('M2：safeService 优先用 ctx.get，并在两条路都不可用时返回 null（永不抛）', () => {
  const svc = { marker: 1 };

  // ① ctx.get 命中 → 直接返回（get 不检查 inject，是可选依赖的正解）
  assert.equal(safeService({ get: (n) => (n === 'loader' ? svc : undefined) }, 'loader'), svc);

  // ② ctx.get 抛错 → 退回属性访问
  assert.equal(safeService({ get() { throw new Error('nope'); }, loader: svc }, 'loader'), svc);

  // ③ ctx.get 返回 undefined → 退回属性访问
  assert.equal(safeService({ get: () => undefined, loader: svc }, 'loader'), svc);

  // ④ 两条路都不可用（属性是会抛的 getter）→ null，绝不冒泡
  const bad = { get() { throw new Error('nope'); } };
  Object.defineProperty(bad, 'loader', { get() { throw new Error('boom'); } });
  assert.equal(safeService(bad, 'loader'), null);

  // ⑤ 空输入
  assert.equal(safeService(null, 'loader'), null);
  assert.equal(safeService({}, ''), null);
});

test('M1 回归：轻扫不得抹掉 interface 条目（曾致 doctor interface:0 / 清单里一条不剩）', () => {
  const dir = mkTmp('reg-light');
  const file = path.join(dir, 'capabilities.json');
  const mk = (name, type, fp) => ({
    v: 1, name, type, description: `${type} 条目`, triggers: ['t'],
    invoke: { kind: 'cli', how: 'x' }, source: `${type}:src`, fingerprint: fp,
  });

  // ① 全量扫描：产出 interface / software / skill 三类
  applyScan(file, {
    entries: [
      mk('systemPrompt', 'interface', 'a'),
      mk('ffmpeg', 'software', 'b'),
      mk('skill-x', 'skill', 'c'),
    ],
    probeErrors: [], scannedAt: new Date().toISOString(), dshHome: dir,
  }, { reason: 'boot' });

  // ② 轻扫：只产出 skill（模拟「LIGHT_PROBES 不含 interfaces」的缺陷形态），
  //    但按**修复后**的保留名单调用 —— interface 必须活下来。
  const res = applyScan(file, {
    entries: [mk('skill-x', 'skill', 'c')],
    probeErrors: [], scannedAt: new Date().toISOString(), dshHome: dir,
  }, { reason: 'light', preserveTypes: ['hardware', 'software', 'interface'] });

  const types = new Set(res.entries.map((e) => e.type));
  assert.ok(types.has('skill'), '本次产出的类型必须保留');
  assert.ok(types.has('interface'), 'interface 必须被保留（这正是真机事故点）');
  assert.ok(types.has('software'), 'software 也必须被保留（v0.6.1 老缺陷）');
  assert.equal(res.entries.length, 3);
});

test('M1：保留名单用的是**条目 type 名**，不是探针名（interface 是单数）', () => {
  // 这条断言防的是「把 'interfaces'（探针名）写进 preserveTypes」——
  // 那样不会报错、也不会生效，只会静默地继续抹掉条目（最难发现的写法）。
  const src = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8');
  const m = src.match(/const PRESERVE_ON_LIGHT = \[([^\]]*)\]/);
  assert.ok(m, '必须存在 PRESERVE_ON_LIGHT（原 FULL_ONLY_PROBES 改名，语义即 preserveTypes）');
  assert.ok(/'interface'/.test(m[1]), '保留名单必须含单数 type 名 interface');
  assert.ok(!/'interfaces'/.test(m[1]), '不得把探针名 interfaces 当作 type 名写进保留名单');
  assert.ok(/'hardware'/.test(m[1]) && /'software'/.test(m[1]), 'hardware/software 不得丢失');

  const light = src.match(/const LIGHT_PROBES = \[([^\]]*)\]/);
  assert.ok(light && /'interfaces'/.test(light[1]), '轻扫探针集应含 interfaces（探针名，复数）');
});

test('M2 回归：自证开销只量「采集自己」——不得把宿主 CPU 冒领成采集自耗', async () => {
  // 真机事故（2026-10-11，重启后自证发现）：`selfMsAvg=1095.2ms` /
  // `selfCpuPctApprox=36.507%` / `SELF_COST_HIGH` 恒亮 —— 而那是**整个 Host 进程**
  // 的 CPU。tick 里含 `await sleep(500ms)`，窗口内宿主自己在跑 agent loop，全被记到采集器头上。
  // 恒亮的假告警等于训练人忽略告警，比没有告警更糟，故用两层锁死。

  // ① 结构层：`sampleAll` 必须把两段 FFI 采样的 CPU 分开量、把 sleep 窗口排除在外。
  const psrc = fs.readFileSync(path.join(root, 'lib', 'monitor', 'procs.js'), 'utf8');
  assert.ok(/selfCpuMs/.test(psrc), 'sampleAll 必须返回 selfCpuMs');
  const body = psrc.slice(psrc.indexOf('export async function sampleAll'));
  const iSleep = body.indexOf('await new Promise');
  const iCpuA = body.indexOf('process.cpuUsage(cpuA0)');
  const iCpuB0 = body.indexOf('process.cpuUsage(cpuB0)');
  assert.ok(iCpuA > 0 && iCpuB0 > iSleep,
    '两段 CPU 快照必须夹住 sleep：第一段量完才 sleep，sleep 之后才开第二段');
  assert.ok(iCpuA < iSleep, 'cpuA 必须在 sleep 之前结算（否则会把睡眠窗口算进来）');

  // ② 组装层：collector 的 selfMs 必须来自 procs.selfCpuMs + 同步块，而不是整进程差值；
  //    整进程差值只能作为对照量另存（hostCpuMs），且必须显式标注它不等于采集开销。
  const csrc = fs.readFileSync(path.join(root, 'lib', 'monitor', 'collector.js'), 'utf8');
  assert.ok(/procs\.selfCpuMs/.test(csrc), 'selfMs 必须用 procs.selfCpuMs');
  assert.ok(/hostCpuMs/.test(csrc), '整进程 CPU 必须另存为 hostCpuMs（供对照，不冒充自耗）');
  assert.ok(/const selfMs = \(Number\(procs\.selfCpuMs\)/.test(csrc),
    'selfMs 必须以 procs.selfCpuMs 为首项');
  assert.ok(!/const selfMs = \(cpuUs\.user/.test(csrc), '不得再用整进程差值当 selfMs（旧缺陷写法）');

  // ③ 行为层：本地跑一次真实的 sampleAll —— selfCpuMs 必须是数字，且远小于 wallMs
  //    （wallMs 含 500ms sleep；若自耗把 sleep 算进去，两者会同量级）。
  const s = await procs.sampleAll({ intervalMs: 200 });
  assert.equal(typeof s.selfCpuMs, 'number', 'selfCpuMs 必须是数字');
  assert.ok(s.selfCpuMs >= 0);
  assert.ok(s.wallMs >= 200, `wallMs 应包含 sleep 窗口，实际 ${s.wallMs}`);
  assert.ok(s.selfCpuMs < s.wallMs, 'selfCpuMs 必须显著小于 wallMs（说明 sleep 窗口未进账）');
  assert.ok(s.selfCpuMs < 150, `自耗应远低于 SELF_COST_HIGH 触发线 150ms，实际 ${s.selfCpuMs}`);
});

