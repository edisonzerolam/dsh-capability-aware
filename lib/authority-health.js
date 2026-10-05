// dsh-capability-aware · authority-health.js（v4.3 · G2）
// 「其他系统出问题了我兜底」的**探测器**：检查各 assist 域的权威系统是否可达。
// 只做事实探测（文件/脚本/服务存在性与新鲜度），不做自动修复；不可达 → 建议切换本插件兜底并标注口径。
// 判定纪律：不确定就报 'unknown'，不猜（如 dsh-mneme 无本地可达性判据）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function homeDsh() {
  return process.env.DSH_CAP_DSH_HOME || path.join(os.homedir(), '.dsh');
}

function statSafe(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function ageHours(p) {
  const s = statSafe(p);
  return s ? Math.round((Date.now() - s.mtimeMs) / 3600e3 * 10) / 10 : null;
}

/**
 * 各 assist 域权威系统的可达性。
 * @returns {{checks: Array, degraded: string[], summary: string}}
 */
export function checkAuthorities() {
  const home = homeDsh();
  const checks = [];
  const add = (domain, authority, reachable, evidence, onFailure) =>
    checks.push({ domain, authority, reachable, evidence, onFailure });

  // skill-use-router：脚本 + 索引（索引新鲜度是硬指标）
  const routerDir = path.join(home, 'skills', 'skill-use-router');
  const idx = path.join(routerDir, 'references', 'index.json');
  const script = path.join(routerDir, 'scripts', 'skill_index.py');
  const idxAge = ageHours(idx);
  if (!statSafe(script)) add('skill', 'skill-use-router', false, `缺脚本 ${script}`, '改用本插件清单兜底（标注「来自索引底稿」）');
  else if (!statSafe(idx)) add('skill', 'skill-use-router', false, '缺 references/index.json（未 build）', '先跑 skill_index.py build；期间用本插件清单兜底');
  else add('skill', 'skill-use-router', true, `索引在（${idxAge}h 前生成，${(statSafe(idx).size / 1024).toFixed(0)}KB）`, '—');

  // MCP：连接器存储 + 是否配过连接
  const mcpF = path.join(home, 'storages', 'mcp_connector.json');
  let mcpOk = false, mcpEv = '缺 mcp_connector.json';
  if (statSafe(mcpF)) {
    try {
      const raw = JSON.parse(fs.readFileSync(mcpF, 'utf8'));
      const n = Object.keys(raw?.tables?.connections || {}).length;
      mcpOk = n > 0;
      mcpEv = n > 0 ? `连接器 ${n} 个（存储 mtime ${ageHours(mcpF)}h 前）` : '存储存在但 0 个连接';
    } catch { mcpEv = 'mcp_connector.json 解析失败'; }
  }
  add('mcp', 'DSH 连接器（mcp_connector_status）', mcpOk, mcpEv, '用本插件连接快照兜底（健康状态不可信）');

  // automation：存储存在性
  const autoF = path.join(home, 'storages', 'dsh_automation.json');
  add('automation', 'DSH automation（automation_list）', !!statSafe(autoF), statSafe(autoF) ? `存储在（${ageHours(autoF)}h 前）` : '缺 dsh_automation.json', '读该存储快照兜底（可能滞后）');

  // Hindsight：数据目录存在性
  const hsDirs = [path.join(home, 'hindsight'), path.join(home, 'storages', 'hindsight')];
  const hs = hsDirs.find((d) => statSafe(d));
  add('knowledge', 'Hindsight', !!hs, hs ? `数据目录存在：${hs}` : '未见 Hindsight 数据目录', '只能报「后端目录是否存在」');

  // dsh-mneme：无本地可达性判据 → 诚实报 unknown
  add('memory', 'dsh-mneme (memory_search)', 'unknown', '无本地可达性判据（记忆服务在会话层，插件侧探不到）', '用 memory/ 主题文件清单兜底（文件粒度）');

  const degraded = checks.filter((c) => c.reachable === false).map((c) => c.domain);
  const summary = degraded.length
    ? `⚠ ${degraded.length} 个权威域不可达（${degraded.join(', ')}）→ 这些域请切本插件兜底，结论须标注「来自索引底稿」`
    : '所有可探测的权威域均可达（memory 无判据，报 unknown）';
  return { checks, degraded, summary };
}
