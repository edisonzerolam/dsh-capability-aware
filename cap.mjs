#!/usr/bin/env node
// dsh-efficiency · CLI 入口（零依赖，node >= 20）
// 用法：
//   node cap.mjs scan                     # 全量扫描 + 落盘 + 打印 diff
//   node cap.mjs list [type]              # 列出清单（可按类型过滤）
//   node cap.mjs query "<任务描述>"        # 检索匹配能力 + 调用方式；无命中给缺失引导
//   node cap.mjs guide "<能力名>" [type]   # 对指定缺失能力生成补足引导
//   node cap.mjs stale                    # 与上次快照 diff，报告消失的能力（缺失引导）
//   node cap.mjs ledger <子命令>           # 错误账本（v0.8.0，见下）
//   DSH_EFF_DSH_HOME=<dir> 可重定向扫描根（测试/多 profile）
//
// 错误账本子命令（与「能力清单」互补：那边查「有什么能力」，这边查「什么坏了」）：
//   node cap.mjs ledger backfill [--force] [--workspace=] [--max-files=N] [--concurrency=N]
//   node cap.mjs ledger stats
//   node cap.mjs ledger recent [N]
//   node cap.mjs ledger facets [切面] [--top=K] [--since=7d]
//   node cap.mjs ledger repair [--since=] [--min=3]
//   node cap.mjs ledger search "<词>" [N]
//   node cap.mjs ledger report [--since=]
//   node cap.mjs ledger export [--out=f.json]
//   node cap.mjs interface [kind]         # 接口面（v0.9.0：service/remote/slot/row/route）
//   node cap.mjs monitor [--watch] [--json] [--selfcheck]   # 资源监控（v0.9.0）
//   node cap.mjs diagnose [--min=N] [--severity=P0]         # 分级诊断（v0.9.0）
//   node cap.mjs fixprompt [--out=f.md] [--no-ticket]          # 修复提示词（v0.9.0，v0.11.0 起开修复工单）
//   node cap.mjs fixes [list|show <id>|close <id>|adopt]        # 修复台账与待修清单收敛（v0.11.0）
//   node cap.mjs fixes adopt --code=X --kind=tool --name=edit --at="2026-10-11 20:00"
//     [--window=<ms>]  观察窗口下限（默认 30 分钟）　[--stale=<ms>] 久未见阈值（默认 6 小时）

import { scanAll } from './lib/scanner.js';
import { load, applyScan } from './lib/registry.js';
import { match, buildIdf } from './lib/matcher.js';
import { guide, guideStale } from './lib/guidance.js';
import { doctor } from './lib/doctor.js';
import { checkAuthorities } from './lib/authority-health.js';
import { briefLines, fallbackNote } from './lib/brief.js';
import { backfill, sessionsRoot, loadBackfillState, saveBackfillState } from './lib/ledger/backfill.js';
import { ledgerDir, readRecords } from './lib/ledger/store.js';
import { rollup, selfRepairCandidates, serializeFacets } from './lib/ledger/rollup.js';
import { parseSince } from './lib/ledger/tool.js';

const [, , cmd, ...rest] = process.argv;

function printJson(v) {
  console.log(JSON.stringify(v, null, 2));
}

const file = process.env.DSH_EFF_FILE || undefined;

// query/stale 前统一构造 idf：**每次现算**。
// ⚠ 不用落盘的 meta.idf——它是 scan 时刻的快照，alias 灌入/条目修改后会过期，
//   过期 IDF 会把别名 token 压到 0.5 保底（真实踩坑：AKShare 别名加分失效）。
//   237 条规模下 buildIdf 毫秒级，正确性优先。
function idfFor(reg) {
  return buildIdf(reg.entries).idf;
}

// v3：alias 子命令 —— 灌/清人工别名（BM25 词表鸿沟的正解，matcher 已接线 aliases 触发面）
function aliasCmd(rest) {
  const reg = load(file);
  if (reg.state !== 'ok') {
    printJson({ ok: false, message: '清单为空：先 node cap.mjs scan' });
    process.exit(2);
  }
  const [name, ...aliasWords] = rest;
  if (!name || !aliasWords.length) {
    printJson({ ok: false, message: '用法: node cap.mjs alias "<条目名>" <别名1> <别名2> …；clear 清空该条目别名' });
    process.exit(1);
  }
  const idx = reg.entries.findIndex((e) => e.name === name);
  if (idx < 0) {
    printJson({ ok: false, message: `条目不存在: ${name}（用 node cap.mjs list 查名字）` });
    process.exit(1);
  }
  const clear = aliasWords[0] === 'clear';
  const aliases = clear ? [] : [...new Set([...(reg.entries[idx].manual?.aliases || []), ...aliasWords])];
  // 手工编辑直接写盘（原子替换）；下次 scan 的 manual 尊重逻辑会保留这些别名
  import('node:fs').then((fs) => {
    const raw = JSON.parse(fs.readFileSync(reg.file, 'utf8'));
    raw.entries[idx].manual = { ...(raw.entries[idx].manual || {}), aliases };
    const tmp = reg.file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), 'utf8');
    fs.renameSync(tmp, reg.file);
    printJson({ ok: true, name, aliases });
  });
}

switch (cmd) {
  case 'scan': {
    const scan = scanAll({ tools: process.env.DSH_EFF_TOOLS ? process.env.DSH_EFF_TOOLS.split(',') : undefined });
    const res = applyScan(file, scan);
    printJson({
      state: res.state,
      counts: res.meta?.counts,
      probeErrors: res.meta?.lastScanProbeErrors,
      diff: {
        added: res.diff.added.map((e) => `${e.type}:${e.name}`),
        removed: res.diff.removed.map((e) => `${e.type}:${e.name}`),
        changed: res.diff.changed.map((c) => `${c.to.type}:${c.to.name}`),
      },
      file: res.file,
      scannedAt: scan.scannedAt,
    });
    if (res.diff.removed.length) {
      console.error('\n[缺失引导] 以下能力已消失：');
      console.error(JSON.stringify(guideStale(res.diff.removed), null, 2));
    }
    break;
  }
  case 'list': {
    const reg = load(file);
    const t = rest[0];
    const entries = t ? reg.entries.filter((e) => e.type === t) : reg.entries;
    printJson({ state: reg.state, total: entries.length, entries });
    break;
  }
  case 'query': {
    const q = rest.join(' ').trim();
    const reg = load(file);
    if (reg.state !== 'ok') {
      printJson({
        kind: 'empty_registry',
        message: '能力清单为空或未初始化：先跑 `node cap.mjs scan` 建立清单。',
      });
      process.exit(2);
    }
    // v2：detail=full 输出全条目（默认摘要档，MCP Progressive Discovery 口径）
    const detailFull = process.argv.includes('--detail=full') || process.env.DSH_EFF_DETAIL === 'full';
    const m = match(q, reg.entries, { idf: idfFor(reg) });
    if (!detailFull && (m.kind === 'ok' || m.kind === 'ambiguous')) {
      const slim = {
        ...m,
        candidates: m.candidates.map((c) => ({
          name: c.name, type: c.type, description: c.description,
          invoke: c.invoke, confidence: c.confidence, negative: c.negative,
          authority: c.authority, bounds: c.bounds,
          ...(c.negative ? { warning: '已归档/勿用' } : {}),
        })),
      };
      if (slim.kind === 'no_match') { printJson({ ...slim, guidance: guide({ query: q }) }); process.exit(3); }
      printJson(slim);
      if (m.kind === 'no_match') process.exit(3);
      break;
    }
    if (m.kind === 'no_match') {
      printJson({ ...m, guidance: guide({ query: q }) });
      process.exit(3);
    }
    printJson(m);
    break;
  }
  case 'doctor': {
    // v4.3（G2）：健康报告并入「权威系统可达性」——其他系统挂了要能自动发现并提示切兜底
    const d = doctor(file, {});
    const ah = checkAuthorities();
    printJson({ ...d, authorityHealth: ah });
    break;
  }
  // v4.3（G1）：一眼读视图——每条一行「能力|类型|做什么|怎么调|谁主|边界」
  case 'brief': {
    const reg = load(file);
    if (reg.state !== 'ok') {
      printJson({ kind: 'empty_registry', message: '清单为空：先 node cap.mjs scan' });
      process.exit(2);
    }
    const q = rest.join(' ').trim();
    const picked = q
      ? (() => { const m = match(q, reg.entries, { idf: idfFor(reg), topK: 5 });
                 return m.kind === 'ok' || m.kind === 'ambiguous' ? m.candidates : []; })()
      : reg.entries;
    // v4.4：与工具 efficiency_query 共用 lib/brief.js（口径单一事实源）
    const lines = briefLines(picked);
    const ah = checkAuthorities();
    console.log(lines.join('\n') + `\n— ${picked.length} 条 ｜ ${ah.summary}`);
    const fb = fallbackNote(ah);
    if (fb) console.log(fb);
    break;
  }
  case 'alias': {
    aliasCmd(rest);
    break;
  }
  case 'guide': {
    printJson(guide({ missingName: rest[0], missingType: rest[1] }));
    break;
  }
  case 'stale': {
    // 重新扫描并与磁盘快照对比，报告 removed（不落盘，只报告）
    const reg = load(file);
    const scan = scanAll({});
    const res = applyScan(file, scan, { dryRun: true });
    const g = guideStale(res.diff.removed);
    printJson({
      state: reg.state,
      currentCount: reg.entries.length,
      scannedCount: res.entries.length,
      stale: g || { kind: 'stale', count: 0, items: [] },
    });
    break;
  }
  case 'ledger': {
    ledgerCmd(rest).catch((e) => {
      printJson({ ok: false, error: String(e?.message ?? e) });
      process.exit(1);
    });
    break;
  }
  case 'interface':
  case 'iface': {
    interfaceCmd(rest).catch((e) => {
      printJson({ ok: false, error: String(e?.message ?? e) });
      process.exit(1);
    });
    break;
  }
  case 'monitor': {
    monitorCmd(rest).catch((e) => {
      printJson({ ok: false, error: String(e?.message ?? e) });
      process.exit(1);
    });
    break;
  }
  case 'diagnose': {
    diagnoseCmd(rest).catch((e) => {
      printJson({ ok: false, error: String(e?.message ?? e) });
      process.exit(1);
    });
    break;
  }
  case 'fixprompt': {
    fixpromptCmd(rest).catch((e) => {
      printJson({ ok: false, error: String(e?.message ?? e) });
      process.exit(1);
    });
    break;
  }
  case 'fixes': {
    fixesCmd(rest).catch((e) => {
      printJson({ ok: false, error: String(e?.message ?? e) });
      process.exit(1);
    });
    break;
  }
  default:
    console.error('用法: node cap.mjs <scan|list|query|doctor|guide|stale|alias|brief|ledger|interface|monitor|diagnose|fixprompt|fixes> [args]');
    process.exit(1);
}

// ── v0.8.0 错误账本子命令 ────────────────────────────────────────
// 与「能力清单」互补：那边查「有什么能力」，这边查「什么坏了 / 缺什么」。
// 账本默认落在 ~/.dsh/data/efficiency/ledger/（可用 DSH_ERROR_LEDGER_HOME 覆盖）。
function ledgerFlags(rest) {
  const flags = { positional: [] };
  for (const a of rest) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
    if (!m) { flags.positional.push(a); continue; }
    const k = m[1];
    const v = m[2] === undefined ? true : m[2];
    flags[k] = v;
  }
  return flags;
}

function fmtTime(t) {
  if (!Number.isFinite(t)) return '?';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function oneLine(s, n = 160) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n)}…`;
}

async function ledgerCmd(rest) {
  const sub = rest[0] ?? 'stats';
  const flags = ledgerFlags(rest.slice(1));
  const dir = ledgerDir();

  if (sub === 'backfill') {
    const state = await loadBackfillState(dir);
    const res = await backfill({
      dir,
      root: sessionsRoot(),
      maxFiles: flags['max-files'] ? Number(flags['max-files']) : undefined,
      concurrency: flags.concurrency ? Number(flags.concurrency) : 4,
      workspace: typeof flags.workspace === 'string' ? flags.workspace : undefined,
      force: flags.force === true || flags.force === 'true',
      onProgress: (p) => {
        if (p.done % 200 === 0) process.stderr.write(`  … ${p.done}/${p.total} 文件，累计 ${p.records} 条\r`);
      },
    });
    // 记录本次回填时间（与实时水位线共用同一状态文件）
    state.lastBackfillAt = Date.now();
    state.backfillRuns = (state.backfillRuns ?? 0) + 1;
    await saveBackfillState(state, dir);
    printJson({ ...res, dir });
    return;
  }

  const read = await readRecords(dir);
  if (!read.existed) {
    printJson({ ok: false, dir, message: '账本为空或尚未初始化：先跑 `node cap.mjs ledger backfill`。' });
    process.exit(2);
  }
  const records = read.records;
  const since = parseSince(typeof flags.since === 'string' ? flags.since : undefined);
  const top = flags.top ? Number(flags.top) : 50;
  const min = flags.min ? Number(flags.min) : 3;

  if (sub === 'stats') {
    const r = rollup(records, { since, topK: top });
    printJson({
      dir, total: read.total, badLines: read.badLines,
      firstTime: r.firstTime ? fmtTime(r.firstTime) : null,
      lastTime: r.lastTime ? fmtTime(r.lastTime) : null,
      owners: Object.fromEntries((r.facets.owner ?? []).map((b) => [b.key, b.count])),
      byDay: r.byDay,
    });
    return;
  }

  if (sub === 'recent') {
    const n = flags.positional[0] ? Number(flags.positional[0]) : 20;
    const list = records.filter((r) => (r.time ?? 0) >= since).slice(-n).reverse();
    for (const r of list) {
      console.log(`· ${fmtTime(r.time)} [${r.code || r.errorName || 'UNKNOWN'}] ${r.owner}/${r.category} ${r.tool ? `tool=${r.tool} ` : ''}${r.skill ? `skill=${r.skill} ` : ''}${r.object?.id ? `${r.object.kind}=${r.object.id}` : ''}`);
      if (r.message) console.log(`    ${oneLine(r.message, 200)}`);
    }
    console.log(`— ${list.length} 条（账本共 ${read.total} 条）`);
    return;
  }

  if (sub === 'facets') {
    const r = rollup(records, { since, topK: top });
    const key = typeof flags.positional[0] === 'string' ? flags.positional[0] : undefined;
    const out = serializeFacets(r);
    if (key) {
      printJson({ dir, total: r.total, facet: key, buckets: out.facets[key] ?? [] });
    } else {
      printJson({ dir, total: r.total, byDay: r.byDay, facets: out.facets });
    }
    return;
  }

  if (sub === 'repair') {
    const cands = selfRepairCandidates(records, { since, minCount: min });
    if (flags.json === true) { printJson({ dir, count: cands.length, candidates: cands }); return; }
    console.log(`自修复候选 ${cands.length} 项（owner=local，≥${min} 次；provider/external 不列）`);
    for (const c of cands) {
      console.log(`\n▸ ${c.code || c.errorName}  ${c.count} 次 / ${c.sessionCount} 会话  优先级 ${c.priority}`);
      if (c.textSignature && c.textSignature !== c.code) console.log(`  文本签名：${oneLine(c.textSignature)}`);
      console.log(`  类别 ${c.category}${c.tool ? `  工具 ${c.tool}` : ''}`);
      if (c.fixHint) console.log(`  建议：${c.fixHint}`);
      if (c.sampleObjects?.length) console.log(`  样本：${c.sampleObjects.slice(0, 3).join(' | ')}`);
    }
    return;
  }

  if (sub === 'search') {
    const q = String(flags.positional.join(' ') || '').toLowerCase();
    if (!q) { printJson({ ok: false, message: '用法: node cap.mjs ledger search "<词>" [N]' }); process.exit(1); }
    const n = flags.positional[1] ? Number(flags.positional[1]) : 30;
    const hits = records.filter((r) => (r.time ?? 0) >= since
      && [r.code, r.errorName, r.message, r.tool, r.skill, r.object?.id, r.signature].some((v) => String(v ?? '').toLowerCase().includes(q)));
    for (const r of hits.slice(-n).reverse()) {
      console.log(`· ${fmtTime(r.time)} [${r.code || r.errorName || 'UNKNOWN'}] ${r.owner}/${r.category} ${r.tool ? `tool=${r.tool} ` : ''}${r.object?.id ?? ''}`);
      if (r.message) console.log(`    ${oneLine(r.message, 200)}`);
    }
    console.log(`— 命中 ${hits.length} 条（账本共 ${read.total} 条）`);
    return;
  }

  if (sub === 'export') {
    const out = typeof flags.out === 'string' ? flags.out : undefined;
    const payload = { dir, exportedAt: Date.now(), total: read.total, records };
    if (out) {
      const fs = await import('node:fs');
      fs.writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');
      printJson({ ok: true, out, total: read.total });
    } else {
      printJson(payload);
    }
    return;
  }

  if (sub === 'report') {
    const r = rollup(records, { since, topK: top });
    const cands = selfRepairCandidates(records, { since, minCount: min });
    const owners = Object.fromEntries((r.facets.owner ?? []).map((b) => [b.key, b.count]));
    console.log(`错误账本报告（账本共 ${read.total} 条，坏行 ${read.badLines}）`);
    console.log(`时间跨度：${fmtTime(r.firstTime)} → ${fmtTime(r.lastTime)}`);
    console.log(`责任方：local=${owners.local ?? 0} provider=${owners.provider ?? 0} external=${owners.external ?? 0} user=${owners.user ?? 0} unknown=${owners.unknown ?? 0}`);
    console.log('\nTop 错误码：');
    for (const b of (r.facets.code ?? []).slice(0, 12)) console.log(`  ${b.count}× ${b.key}  (${Object.keys(b.categories)[0] ?? '?'})`);
    console.log('\nTop 来源对象：');
    for (const b of (r.facets.object ?? []).slice(0, 8)) console.log(`  ${b.count}× ${b.key}`);
    console.log('\nTop 插件 / 技能：');
    for (const b of (r.facets.plugin ?? []).slice(0, 5)) console.log(`  插件 ${b.count}× ${b.key}`);
    for (const b of (r.facets.skill ?? []).slice(0, 5)) console.log(`  技能 ${b.count}× ${b.key}`);
    console.log(`\n自修复候选：${cands.length} 项（node cap.mjs ledger repair 看详情）`);
    console.log('按天分布：');
    for (const [d, n] of Object.entries(r.byDay).slice(-14)) console.log(`  ${d}  ${n}`);
    return;
  }

  printJson({ ok: false, message: `未知账本子命令「${sub}」。可用：backfill|stats|recent|facets|repair|search|report|export` });
  process.exit(1);
}

// ── v0.9.0 接口面子命令（目标 1：为其他插件高效工作提供支持） ──────────
// 与「能力清单」的区别：清单的受众是 **agent**（我该用什么），
// 接口面的受众是 **插件作者**（我能调用什么宿主 API）。
async function interfaceCmd(rest) {
  const flags = ledgerFlags(rest);
  const kind = typeof flags.positional[0] === 'string' ? flags.positional[0] : '';
  const { scanInterfaces, interfacesToEntries } = await import('./lib/interfaces.js');
  const scan = scanInterfaces({});
  const entries = interfacesToEntries(scan);

  if (flags.json === true || flags.json === 'true') {
    printJson({ ...scan, entryCount: entries.length });
    return;
  }

  const KINDS = ['service', 'remote', 'slot', 'row', 'route'];
  const want = kind && KINDS.includes(kind) ? kind : '';

  console.log(`接口面索引（宿主 node_modules: ${scan.sources.hostNodeModules ?? '未找到'}）`);
  console.log(`总计 ${entries.length} 条：service=${scan.services.length} remote=${scan.remotes.length} slot=${scan.slots.length} row=${scan.rows.length}\n`);

  if (!want || want === 'service') {
    console.log(`【service】Cordis 服务 ${scan.services.length} 条（available 需在宿主内运行才有真值）`);
    for (const s of scan.services) {
      const av = s.available === null ? '?' : s.available ? '✓' : '✗';
      console.log(`  ${av} ${s.name.padEnd(20)} ${s.note}`);
      console.log(`      ${oneLine(s.how, 140)}`);
    }
    console.log('');
  }
  if (!want || want === 'remote') {
    console.log(`【remote】Typert Remote 方法 ${scan.remotes.length} 条`);
    const bySvc = new Map();
    for (const r of scan.remotes) {
      if (!bySvc.has(r.service)) bySvc.set(r.service, []);
      bySvc.get(r.service).push(r);
    }
    for (const [svc, list] of [...bySvc.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${svc}  (${list.length})  ← ${list[0].pkg}`);
      for (const r of list.slice(0, 8)) {
        console.log(`      ${r.method}(${r.params.join(', ')})`);
      }
      if (list.length > 8) console.log(`      … 另有 ${list.length - 8} 个方法`);
    }
    console.log('');
  }
  if (!want || want === 'slot') {
    console.log(`【slot】客户端 UI 插槽 ${scan.slots.length} 条`);
    for (const s of scan.slots) {
      console.log(`  ${s.id.padEnd(38)} ${s.usedBy.length ? `已被 ${s.usedBy.slice(0, 4).join(', ')} 使用` : '（未发现消费者，可能仍可用）'}`);
    }
    console.log('');
  }
  if (!want || want === 'row') {
    console.log(`【row】宿主 bundle 登记项 ${scan.rows.length} 条（id = name）`);
    const byBundle = new Map();
    for (const r of scan.rows) {
      if (!byBundle.has(r.bundle)) byBundle.set(r.bundle, []);
      byBundle.get(r.bundle).push(r);
    }
    for (const [b, list] of byBundle) {
      console.log(`  [${b}] ${list.length} 项，前 20：`);
      for (const r of list.slice(0, 20)) console.log(`      ${r.id.padEnd(32)} = ${r.name}`);
    }
    console.log('');
  }
  if (!want || want === 'route') {
    const routes = entries.filter((e) => e.iface?.kind === 'route');
    console.log(`【route】已知 HTTP 路由前缀 ${routes.length} 条`);
    for (const r of routes) console.log(`  ${r.name}  ${r.description}`);
    console.log('');
  }

  if (!kind) console.log('提示：node cap.mjs interface <service|remote|slot|row|route> 只看一类；--json 出完整数据。');
}

// ── v0.9.0 资源监控子命令（目标 2：监控资源调度，防范卡死/崩溃） ────────
// 与「错误账本」的区别：账本答「什么坏了」（事后），监控答「现在跑得怎么样」（当下）。
// 数据由插件在宿主内的心跳写入 ~/.dsh/data/efficiency/monitor/；
// 本命令在**插件外部**读那些文件，或（--live）现采一次全机进程树。
async function monitorCmd(rest) {
  const flags = ledgerFlags(rest);
  const sub = typeof flags.positional[0] === 'string' ? flags.positional[0] : 'stats';
  const limit = Number(flags.limit) || 20;
  const { monitorDir, readSamples, readEvents, readMeta, sampleFileSize } = await import('./lib/monitor/store.js');

  // --live：不依赖宿主心跳，直接现采一次（CLI 独立可用，这是「插件外也能用」的关键）
  if (flags.live === true || flags.live === 'true') {
    const { sampleAll } = await import('./lib/monitor/procs.js');
    const s = await sampleAll({ intervalMs: Number(flags.interval) || 500 });
    if (flags.json === true || flags.json === 'true') { printJson(s); return; }
    console.log(`实时采样（source=${s.source}，窗口 ${s.wallMs}ms，${s.rows.length} 进程，共 ${s.totalWorkingSetMB}MB）`);
    if (s.note) console.log(`  注：${s.note}`);
    const rows = s.rows.slice().sort((a, b) => (b.cpuPct ?? -1) - (a.cpuPct ?? -1));
    for (const r of rows.slice(0, limit)) {
      console.log(`  pid=${String(r.pid).padEnd(7)} ${String(r.kind).padEnd(11)} cpu=${String(r.cpuPct ?? '?').padStart(7)}%  ws=${String(r.workingSetMB ?? '?').padStart(8)}MB  ${oneLine(r.name, 40)}`);
    }
    return;
  }

  const dir = typeof flags.dir === 'string' ? flags.dir : monitorDir();
  const meta = await readMeta(dir);
  const sampleBytes = await sampleFileSize(dir);

  if (sub === 'stats' || sub === 'health') {
    const { rows: samples } = await readSamples({ dir, limit: 500 });
    const { events } = await readEvents({ dir, limit: 500 });
    const out = {
      dir,
      sampleBytes,
      meta,
      recentSamples: samples.length,
      recentEvents: events.length,
      lastSampleTime: samples.at(-1)?.time ?? null,
      lastEventTime: events.at(-1)?.time ?? null,
    };
    if (flags.json === true || flags.json === 'true') { printJson(out); return; }
    console.log(`监控数据目录：${dir}`);
    console.log(`  采样文件 ${(sampleBytes / 1024).toFixed(1)} KB`);
    console.log(`  最近窗口：采样 ${samples.length} 条（至 ${fmtTime(out.lastSampleTime)}）　事件 ${events.length} 条（至 ${fmtTime(out.lastEventTime)}）`);
    if (meta) {
      console.log(`  元数据：version=${meta.version ?? '?'} ticks=${meta.ticks ?? '?'} startedAt=${fmtTime(meta.startedAt)}`);
      if (meta.lastError) console.log(`  ⚠ 最近错误：${oneLine(meta.lastError, 140)}`);
    } else {
      console.log('  （无元数据：插件可能尚未在宿主内启动过心跳）');
    }
    return;
  }

  if (sub === 'samples' || sub === 'procs') {
    const { rows: samples } = await readSamples({ dir, limit });
    if (flags.json === true || flags.json === 'true') { printJson(samples); return; }
    if (!samples.length) { console.log(`无采样数据（${dir}）。若插件刚装上，等一个心跳周期；或加 --live 现采。`); return; }
    for (const s of samples) {
      console.log(`── ${fmtTime(s.time)}　进程 ${s.procCount ?? '?'}　会话 ${s.sessionCount ?? '?'}　共 ${s.totalWorkingSetMB ?? '?'}MB`);
      for (const p of (s.procs ?? []).slice(0, limit)) {
        console.log(`    pid=${String(p.pid).padEnd(7)} ${String(p.kind).padEnd(11)} cpu=${String(p.cpuPct ?? '?').padStart(7)}%  ws=${String(p.workingSetMB ?? '?').padStart(8)}MB`);
      }
    }
    return;
  }

  if (sub === 'sessions') {
    const { rows: samples } = await readSamples({ dir, limit });
    const last = samples.at(-1);
    if (flags.json === true || flags.json === 'true') { printJson(last?.sessions ?? []); return; }
    if (!last) { console.log(`无采样数据（${dir}）。`); return; }
    console.log(`最近一次采样 ${fmtTime(last.time)} 的会话增量（本插件上次读取至今）：`);
    for (const s of (last.sessions ?? []).slice(0, limit)) {
      console.log(`  ${oneLine(s.title ?? s.id, 46)}　turns+${s.dTurns ?? 0} steps+${s.dSteps ?? 0} llm+${Math.round((s.dLlmMs ?? 0) / 1000)}s tool+${Math.round((s.dToolMs ?? 0) / 1000)}s`);
    }
    return;
  }

  if (sub === 'events') {
    const { events } = await readEvents({ dir, limit });
    if (flags.json === true || flags.json === 'true') { printJson(events); return; }
    if (!events.length) { console.log(`无监控事件（${dir}）——这是好消息：没有触发任何异常规则。`); return; }
    for (const e of events) {
      console.log(`[${e.severity ?? '?'}] ${fmtTime(e.time)} ${e.code}　${e.subject ?? ''}`);
      if (e.message) console.log(`    ${oneLine(e.message, 160)}`);
      if (e.evidence?.reason) console.log(`    依据：${oneLine(e.evidence.reason, 140)}`);
    }
    return;
  }

  printJson({ ok: false, message: `未知监控子命令「${sub}」。可用：stats|procs|sessions|events|samples，或 --live 现采` });
  process.exit(1);
}

// ── v0.9.0 分级诊断 + 修复提示词 ──────────────────────────────────
// 读账本（+ 可选监控事件）→ 按确定性分 P0–P3 → 出信封或可粘贴的修复提示词。
async function loadDiagnoseInputs(flags) {
  const { ledgerDir: ld, readRecords } = await import('./lib/ledger/store.js');
  const dir = typeof flags.ledger === 'string' ? flags.ledger : ld();
  const { records } = await readRecords(dir);
  const { parseSince } = await import('./lib/ledger/tool.js');
  const since = typeof flags.since === 'string' ? parseSince(flags.since) : 0;
  return { dir, records, since: since || 0 };
}

async function diagnoseCmd(rest) {
  const flags = ledgerFlags(rest);
  const { diagnose, renderDiagnostics } = await import('./lib/diagnose.js');
  const { records, since } = await loadDiagnoseInputs(flags);

  // 有监控数据就一并纳入（相关性，不是因果）
  let monitor;
  try {
    const { monitorDir, readEvents, readSamples } = await import('./lib/monitor/store.js');
    const mdir = typeof flags.monitor === 'string' ? flags.monitor : monitorDir();
    const { events } = await readEvents({ dir: mdir, limit: 500 });
    const { rows: samples } = await readSamples({ dir: mdir, limit: 5 });
    monitor = { events, procs: samples.at(-1)?.procs ?? [] };
  } catch { /* 监控数据不可用不是错误：诊断仍可只基于账本 */ }

  const d = diagnose(records, {
    since,
    minCount: Number(flags.min) || 3,
    topK: Number(flags.top) || 20,
    monitor,
  });

  if (flags.json === true || flags.json === 'true') { printJson(d); return; }
  console.log(renderDiagnostics(d));
}

async function fixpromptCmd(rest) {
  const flags = ledgerFlags(rest);
  const { diagnose } = await import('./lib/diagnose.js');
  const { buildFixPrompt, pickFixables } = await import('./lib/fixprompt.js');
  const { records, since } = await loadDiagnoseInputs(flags);

  const d = diagnose(records, { since, minCount: Number(flags.min) || 3 });
  const opts = {
    profile: typeof flags.profile === 'string' ? flags.profile : 'desktop',
    home: typeof flags.home === 'string' ? flags.home : undefined,
    ledgerDir: typeof flags.ledger === 'string' ? flags.ledger : undefined,
    repoDir: typeof flags.repo === 'string' ? flags.repo : undefined,
    maxItems: Number(flags.top) || 8,
    includeP3: flags.p3 !== 'false',
  };
  const text = buildFixPrompt(d, opts);

  // ── 开修复工单（v0.11.0） ──────────────────────────────────────
  // 工单记「这份提示词列了哪几条 + 生成时刻」；生成时刻是之后判断
  // 「修后有没有再复发」的分界线，没有它待修清单无法收敛。
  // `--no-ticket` 只出提示词、不落台账（用于「只想看看」的场景）。
  const tickets = [];
  let ticketError;
  if (flags.ticket !== 'false') {
    try {
      const { openTicket } = await import('./lib/fixes.js');
      for (const f of pickFixables(d, opts)) {
        const { ticket: tk, superseded } = await openTicket({
          finding: f, prompt: text, by: 'cli', windowSince: since, minCount: d.minCount,
        }, flags.ledger);
        for (const old of superseded) console.error(`  ↳ 取代旧工单 ${old}（同一故障）`);
        tickets.push(tk);
      }
    } catch (e) {
      ticketError = String(e?.message ?? e);
      console.error(`⚠ 修复工单写入失败（提示词仍已生成）：${ticketError}`);
    }
  }

  if (typeof flags.out === 'string') {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(flags.out, text, 'utf8');
    printJson({
      ok: true, out: flags.out, chars: text.length,
      tickets: tickets.map((t) => ({ id: t.id, code: t.code, subject: t.subject })),
      ticketError,
    });
    return;
  }
  // 直接吐纯文本（便于管道 / 复制）
  console.log(text);
  if (tickets.length) {
    console.error('');
    console.error(`已开修复工单 ${tickets.length} 条（待你修完后用 \`node cap.mjs fixes\` 看待修清单收敛）：`);
    for (const t of tickets) console.error(`  ${t.id}　${t.code}　${t.subject.kind}:${t.subject.name}`);
  }
}

/** `--at` 解析：纯数字按毫秒时间戳，否则按可被 Date 解析的字符串。 */
function parseWhen(v) {
  if (v === undefined || v === true) return undefined;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

async function fixesCmd(rest) {
  const flags = ledgerFlags(rest);
  // 位置参数 = 非 `--flag` 项。⚠ 不能取 `rest[0]`：`--ledger=…` 也会出现在 rest 里，
  // 取错了就会把 flag 当成子命令/工单号（踩过一次：`fixes show --ledger=X <id>` 报「未找到工单 --ledger=X」）。
  const pos = rest.filter((a) => !String(a).startsWith('--'));
  const sub = pos[0] ?? 'list';
  const arg = pos[1];
  const F = await import('./lib/fixes.js');

  if (sub === 'close') {
    if (!arg) { console.error('用法：node cap.mjs fixes close <id> [--note="..."]'); process.exitCode = 2; return; }
    const rec = await F.closeTicket(arg, { by: 'cli', note: typeof flags.note === 'string' ? flags.note : undefined }, flags.ledger);
    if (!rec.matched) {
      console.error(`⚠ 未找到工单 ${rec.id} —— 该关闭记录已写入但**没有对应工单**，将作为孤儿记录报出。请核对 id。`);
      process.exitCode = 1;
      return;
    }
    console.log(`已关闭工单 ${rec.id}（人工声明，不是测量）${rec.note ? `　备注：${rec.note}` : ''}`);
    return;
  }

  if (sub === 'adopt') {
    const at = parseWhen(flags.at);
    if (!flags.code || !flags.kind || !flags.name || at === undefined) {
      console.error('用法：node cap.mjs fixes adopt --code=<错误码> --kind=tool --name=<主体名> --at="2026-10-11 20:00" [--note="..."]');
      console.error('说明：为「功能上线前已经修过」的条目补一张工单，让复发核验有分界线。');
      process.exitCode = 2; return;
    }
    const rec = await F.adoptTicket({
      code: String(flags.code), subject: { kind: String(flags.kind), name: String(flags.name) },
      at, by: 'cli', note: typeof flags.note === 'string' ? flags.note : undefined,
    }, flags.ledger);
    console.log(`已补开工单 ${rec.id}　${rec.code}　${rec.subject.kind}:${rec.subject.name}　分界线 ${new Date(rec.at).toISOString()}`);
    return;
  }

  // list / show
  const { diagnose } = await import('./lib/diagnose.js');
  const { records } = await loadDiagnoseInputs(flags);
  const d = diagnose(records, { minCount: Number(flags.min) || 3 });
  const j = await F.readFixes(flags.ledger);

  if (sub === 'show') {
    const tk = j.tickets.find((t) => t.id === arg);
    if (!tk) { console.error(`未找到工单 ${arg}`); process.exitCode = 1; return; }
    const v = F.verifyTicket(tk, records, {});
    printJson({ ticket: tk, verification: v, orphans: j.orphans.filter((o) => o.id === tk.id) });
    return;
  }

  const vs = F.verifyAll(j.tickets, records, {
    minWindowMs: Number(flags.window) || undefined,
    staleAfterMs: Number(flags.stale) || undefined,
  });
  const rep = F.buildOpenList(d, vs, {
    minWindowMs: Number(flags.window) || undefined,
    staleAfterMs: Number(flags.stale) || undefined,
  });
  if (flags.json === true || flags.json === 'true') { printJson({ ...rep, badLines: j.badLines }); return; }
  console.log(F.renderFixes(rep));
  if (j.badLines) console.log(`\n⚠ 台账有 ${j.badLines} 行无法解析（已跳过）`);
  if (j.orphans.length) console.log(`⚠ 有 ${j.orphans.length} 条孤儿关闭记录（找不到对应工单）`);
}

