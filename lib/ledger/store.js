/**
 * 账本存储 —— append-only JSONL 明细 + 可重建的聚合快照。
 *
 * 设计取舍：
 *   - **明细用 JSONL 追加**（`events.v1.jsonl`）：崩溃只丢最后一行，不需要
 *     读-改-写整个文件；记录量随时间线性增长这是唯一可承受的形态。
 *   - **聚合用独立快照**（`rollup.v1.json`）：查询走内存，避免每次扫全量明细。
 *   - 两者都是**本插件私有数据**，放在 `~/.dsh/data/capability-aware/ledger/`，
 *     绝不写用户任何文件、绝不改会话日志（只读）。
 *
 * @module dsh-capability-aware/lib/ledger/store
 */
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 账本根目录。
 *
 * 归属 capability-aware 后落在 `~/.dsh/data/capability-aware/ledger/`——
 * 一个插件一个数据目录（topic-trail 先例），能力清单在 `../capabilities.json`。
 *
 * 环境变量优先级（CLI/测试用）：
 *   `DSH_ERROR_LEDGER_HOME`（整目录直给） > `DSH_CAP_DSH_HOME`（换 DSH 根） > `~/.dsh`
 */
export function ledgerDir() {
  if (process.env.DSH_ERROR_LEDGER_HOME) return process.env.DSH_ERROR_LEDGER_HOME;
  const dshHome = process.env.DSH_CAP_DSH_HOME || join(homedir(), '.dsh');
  return join(dshHome, 'data', 'capability-aware', 'ledger');
}

export function paths(dir = ledgerDir()) {
  return {
    dir,
    events: join(dir, 'events.v1.jsonl'),
    rollup: join(dir, 'rollup.v1.json'),
    meta: join(dir, 'meta.v1.json'),
  };
}

/** 原子写 JSON（tmp 名含 pid，避免与其他插件的 `.<uuid>.tmp` 混淆）。 */
export async function atomicWriteJson(file, obj) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await rename(tmp, file);
}

export async function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function exists(file) {
  try { await stat(file); return true; } catch { return false; }
}

/**
 * 追加一批错误记录。**单次 append 调用**（多行拼成一个 buffer）——
 * 逐条 append 在高频错误下会产生大量 syscall，且不支持原子批。
 */
export async function appendRecords(records, dir = ledgerDir()) {
  if (!records.length) return { appended: 0 };
  const p = paths(dir);
  await mkdir(dir, { recursive: true });
  const payload = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await appendFile(p.events, payload, 'utf8');
  return { appended: records.length, file: p.events };
}

/** 读取全部明细（可选 limit 取**最后** N 条）。坏行跳过。 */
export async function readRecords(dir = ledgerDir(), opts = {}) {
  const p = paths(dir);
  let text;
  try {
    text = await readFile(p.events, 'utf8');
  } catch {
    return { records: [], badLines: 0, existed: false };
  }
  const records = [];
  let badLines = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      records.push(JSON.parse(t));
    } catch {
      badLines += 1;
    }
  }
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : 0;
  return {
    records: limit ? records.slice(-limit) : records,
    total: records.length,
    badLines,
    existed: true,
  };
}

export { atomicWriteJson as saveRollup };
