#!/usr/bin/env node
// dsh-capability-aware · CLI 入口（零依赖，node >= 20）
// 用法：
//   node cap.mjs scan                     # 全量扫描 + 落盘 + 打印 diff
//   node cap.mjs list [type]              # 列出清单（可按类型过滤）
//   node cap.mjs query "<任务描述>"        # 检索匹配能力 + 调用方式；无命中给缺失引导
//   node cap.mjs guide "<能力名>" [type]   # 对指定缺失能力生成补足引导
//   node cap.mjs stale                    # 与上次快照 diff，报告消失的能力（缺失引导）
//   node cap.mjs ledger <子命令>           # 错误账本（v0.8.0，见下）
//   DSH_CAP_DSH_HOME=<dir> 可重定向扫描根（测试/多 profile）
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

const file = process.env.DSH_CAP_FILE || undefined;

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
    const scan = scanAll({ tools: process.env.DSH_CAP_TOOLS ? process.env.DSH_CAP_TOOLS.split(',') : undefined });
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
    const detailFull = process.argv.includes('--detail=full') || process.env.DSH_CAP_DETAIL === 'full';
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
    // v4.4：与工具 capability_query 共用 lib/brief.js（口径单一事实源）
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
  default:
    console.error('用法: node cap.mjs <scan|list|query|doctor|guide|stale|alias|brief|ledger> [args]');
    process.exit(1);
}

// ── v0.8.0 错误账本子命令 ────────────────────────────────────────
// 与「能力清单」互补：那边查「有什么能力」，这边查「什么坏了 / 缺什么」。
// 账本默认落在 ~/.dsh/data/capability-aware/ledger/（可用 DSH_ERROR_LEDGER_HOME 覆盖）。
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
