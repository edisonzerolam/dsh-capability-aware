#!/usr/bin/env node
// dsh-capability-aware · CLI 入口（零依赖，node >= 20）
// 用法：
//   node cap.mjs scan                     # 全量扫描 + 落盘 + 打印 diff
//   node cap.mjs list [type]              # 列出清单（可按类型过滤）
//   node cap.mjs query "<任务描述>"        # 检索匹配能力 + 调用方式；无命中给缺失引导
//   node cap.mjs guide "<能力名>" [type]   # 对指定缺失能力生成补足引导
//   node cap.mjs stale                    # 与上次快照 diff，报告消失的能力（缺失引导）
//   DSH_CAP_DSH_HOME=<dir> 可重定向扫描根（测试/多 profile）

import { scanAll } from './lib/scanner.js';
import { load, applyScan } from './lib/registry.js';
import { match, buildIdf } from './lib/matcher.js';
import { guide, guideStale } from './lib/guidance.js';
import { doctor } from './lib/doctor.js';
import { checkAuthorities } from './lib/authority-health.js';
import { briefLines, fallbackNote } from './lib/brief.js';

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
  default:
    console.error('用法: node cap.mjs <scan|list|query|doctor|guide|stale|alias> [args]');
    process.exit(1);
}
