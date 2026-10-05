// dsh-capability-aware · doctor.js (v2)
// 能力健康报告（SBoM drift 口径：声明 vs 实际运行的偏差）。
// 检查项：
//  1. 清单年龄：lastScanAt 距今 > 阈值 → 建议巡检
//  2. 探针错误：上次扫描的 probeErrors 未清 → 列出
//  3. 陈旧指纹：fingerprint 带 "missing" 的条目（登记了但文件没了）
//  4. 负触发条目：已归档/勿用清单（路由规避面）
//  5. 检索自检：对样本查询跑 match，kind 必须是 ok/ambiguous（防「扫描成功但索引坏了」的假健康）
//  6. IDF 索引健康：meta.idf 存在且非空（v2 落盘口径）

import { load } from './registry.js';
import { match, buildIdf } from './matcher.js';

export function doctor(file, opts = {}) {
  const reg = load(file);
  const findings = [];
  const now = Date.now();

  if (reg.state === 'missing') {
    findings.push({ level: 'error', code: 'REGISTRY_MISSING', message: '清单文件不存在：从未扫描过。执行 `node cap.mjs scan`。' });
    return { healthy: false, state: reg.state, findings };
  }
  if (reg.state === 'empty') {
    findings.push({ level: 'error', code: 'REGISTRY_EMPTY', message: '清单为空：扫描未产出任何条目（DSH_HOME 不对？全探针失败？）。检查 meta.lastScanProbeErrors。' });
  }

  const meta = reg.meta || {};
  // 1. 清单年龄
  const staleMs = opts.staleHours != null ? opts.staleHours * 3600e3 : 24 * 3600e3;
  if (meta.lastScanAt) {
    const age = now - new Date(meta.lastScanAt).getTime();
    if (age > staleMs) {
      findings.push({
        level: 'warn', code: 'STALE_SCAN',
        message: `上次扫描距今 ${(age / 3600e3).toFixed(1)} 小时（阈值 ${staleMs / 3600e3}h）——能力变化不会自动进入清单，跑一次巡检。`,
        action: 'node cap.mjs scan',
      });
    }
  } else {
    findings.push({ level: 'warn', code: 'NO_SCAN_TIME', message: 'meta.lastScanAt 缺失：清单可能来自旧版本或手工构造。', action: 'node cap.mjs scan' });
  }

  // 2. 探针错误
  const errs = meta.lastScanProbeErrors || [];
  if (errs.length) {
    findings.push({ level: 'warn', code: 'PROBE_ERRORS', message: `上次扫描 ${errs.length} 个探针失败：${errs.map((e) => `${e.probe}(${e.error.slice(0, 60)})`).join('; ')}` });
  }

  // 3. 陈旧指纹
  const stale = reg.entries.filter((e) => e.fingerprint === 'missing');
  if (stale.length) {
    findings.push({
      level: 'warn', code: 'STALE_ENTRIES',
      message: `${stale.length} 条登记但文件已消失：${stale.slice(0, 5).map((e) => `${e.type}:${e.name}`).join(', ')}${stale.length > 5 ? '…' : ''}`,
      action: 'node cap.mjs stale 核对后重建清单',
    });
  }

  // 4. 负触发
  const neg = reg.entries.filter((e) => e.negative);
  if (neg.length) {
    findings.push({ level: 'info', code: 'NEGATIVE_ENTRIES', message: `${neg.length} 条已归档/勿用条目（检索会降权告警）：${neg.map((e) => e.name).join(', ')}` });
  }

  // 6. IDF 索引健康
  const idfSize = meta.idf ? Object.keys(meta.idf).length : 0;
  if (reg.state === 'ok' && idfSize === 0) {
    findings.push({ level: 'warn', code: 'IDF_MISSING', message: 'meta.idf 为空：v2 权重索引未落盘（旧版清单），检索退化为常数权重。', action: 'node cap.mjs scan' });
  }

  // 5. 检索自检（样本查询必须能命中；防「扫描成功但匹配坏了」假健康）
  const idfMap = idfSize ? new Map(Object.entries(meta.idf)) : null;
  const samples = opts.samples || ['字幕', 'PDF', '自动化', 'plugin'];
  const selfTest = [];
  for (const q of samples) {
    const m = match(q, reg.entries, { idf: idfMap });
    const ok = m.kind === 'ok' || m.kind === 'ambiguous';
    selfTest.push({ query: q, kind: m.kind, top: m.top ? m.top.name : null, ok });
    if (!ok && reg.state === 'ok') {
      findings.push({ level: 'warn', code: 'SELFTEST_MISS', message: `检索自检「${q}」无命中（${m.kind}）——清单有 ${reg.entries.length} 条但常见词匹配不到，疑似索引/语料异常。` });
    }
  }

  return {
    healthy: findings.every((f) => f.level !== 'error' && f.level !== 'warn'),
    state: reg.state,
    counts: meta.counts,
    entries: reg.entries.length,
    idfTerms: idfSize,
    lastScanAt: meta.lastScanAt,
    findings,
    selfTest,
  };
}
