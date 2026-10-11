/**
 * 监控样本存储 —— 环形 JSONL。
 *
 * ## 为什么要环形（而不是无限追加）
 *
 * 监控样本是**高频、低价值密度**数据：3 秒一次心跳 × 三层 = 每天约 28800 条。
 * 无限追加会让文件在几周内涨到几百 MB，而超过最近几小时的样本对「刚才为什么卡」
 * 毫无帮助。故默认保留 **20000 条**（约 16 小时 @3s），超出后按**块**裁剪。
 *
 * ## 裁剪策略：块裁剪，不是逐行裁剪
 *
 * 每次裁剪都要重写整个文件（O(n)）。若每来一条就裁一条，写放大是灾难
 * （这正是本插件在 v0.6.1 修掉的同类问题——监听过宽导致的写放大）。
 * 故：**只有当行数超过 `max * 1.25` 时才裁，一次裁到 `max * 0.75`**，
 * 摊薄后每条样本的重写代价趋近于 0。
 *
 * ## 与账本 store 的关系
 *
 * 账本（`lib/ledger/store.js`）是 **append-only、永不裁剪**的错误明细；
 * 这里是 **有界环形** 的资源样本。两者语义不同，故独立文件与独立实现，
 * 但复用同一个原子写范式（tmp 名含 pid）。
 *
 * @module dsh-efficiency/lib/monitor/store
 */
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_MAX_SAMPLES = 20000;
const TRIM_HIGH = 1.25;   // 超过 max*1.25 才裁
const TRIM_LOW = 0.75;    // 一次裁到 max*0.75

/** 监控数据目录：与账本同源，落在 `~/.dsh/data/efficiency/monitor/`。 */
export function monitorDir() {
  if (process.env.DSH_MONITOR_HOME) return process.env.DSH_MONITOR_HOME;
  const dshHome = process.env.DSH_EFF_DSH_HOME || join(homedir(), '.dsh');
  return join(dshHome, 'data', 'efficiency', 'monitor');
}

export function monitorPaths(dir = monitorDir()) {
  return {
    dir,
    samples: join(dir, 'monitor.v1.jsonl'),
    events: join(dir, 'events.v1.jsonl'),   // 检出的事件（HOT_PROCESS 等），量小不裁
    meta: join(dir, 'meta.v1.json'),
  };
}

async function atomicWrite(file, text) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
}

async function countLines(file) {
  try {
    const t = await readFile(file, 'utf8');
    let n = 0;
    for (const l of t.split('\n')) if (l.trim()) n += 1;
    return { n, text: t };
  } catch {
    return { n: 0, text: '' };
  }
}

/**
 * 追加一批样本。返回 `{appended, trimmed, total}`。
 *
 * **写失败不抛**（监控绝不能成为插件崩溃源），返回 `{error}` 由调用方计数。
 */
export async function appendSamples(rows, { dir = monitorDir(), max = DEFAULT_MAX_SAMPLES } = {}) {
  if (!Array.isArray(rows) || !rows.length) return { appended: 0, trimmed: 0 };
  const p = monitorPaths(dir);
  try {
    await mkdir(dir, { recursive: true });
    const payload = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    await appendFile(p.samples, payload, 'utf8');
  } catch (e) {
    return { appended: 0, trimmed: 0, error: String(e?.message ?? e) };
  }

  // 有界性：只在显著超出时才裁，且一次裁到低位（摊薄重写成本）。
  let trimmed = 0;
  try {
    const { n, text } = await countLines(p.samples);
    if (max > 0 && n > max * TRIM_HIGH) {
      const keep = Math.max(1, Math.floor(max * TRIM_LOW));
      const lines = text.split('\n').filter((l) => l.trim());
      const kept = lines.slice(-keep);
      await atomicWrite(p.samples, kept.join('\n') + '\n');
      trimmed = lines.length - kept.length;
    }
  } catch { /* 裁剪失败不影响本次追加的成功 */ }
  return { appended: rows.length, trimmed };
}

/** 读最近 N 条样本（坏行跳过）。 */
export async function readSamples({ dir = monitorDir(), limit = 500 } = {}) {
  const p = monitorPaths(dir);
  let text;
  try { text = await readFile(p.samples, 'utf8'); } catch { return { rows: [], total: 0, badLines: 0, existed: false }; }
  const rows = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { rows.push(JSON.parse(t)); } catch { badLines += 1; }
  }
  return {
    rows: limit > 0 ? rows.slice(-limit) : rows,
    total: rows.length, badLines, existed: true,
  };
}

/** 追加检出事件（量小，不裁剪）。 */
export async function appendEvents(events, { dir = monitorDir() } = {}) {
  if (!Array.isArray(events) || !events.length) return { appended: 0 };
  const p = monitorPaths(dir);
  try {
    await mkdir(dir, { recursive: true });
    await appendFile(p.events, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    return { appended: events.length };
  } catch (e) {
    return { appended: 0, error: String(e?.message ?? e) };
  }
}

export async function readEvents({ dir = monitorDir(), limit = 200 } = {}) {
  const p = monitorPaths(dir);
  let text;
  try { text = await readFile(p.events, 'utf8'); } catch { return { events: [], existed: false }; }
  const events = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)); } catch { /* 跳过 */ }
  }
  return { events: limit > 0 ? events.slice(-limit) : events, total: events.length, existed: true };
}

export async function readMeta(dir = monitorDir()) {
  try { return JSON.parse(await readFile(monitorPaths(dir).meta, 'utf8')); } catch { return null; }
}

export async function writeMeta(obj, dir = monitorDir()) {
  await atomicWrite(monitorPaths(dir).meta, JSON.stringify(obj, null, 2));
}

export async function sampleFileSize(dir = monitorDir()) {
  try { return (await stat(monitorPaths(dir).samples)).size; } catch { return 0; }
}
