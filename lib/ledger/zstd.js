/**
 * 多帧 Zstandard 解码 —— DSH 会话日志是「每个持久化批次一帧」的**拼接** zstd。
 *
 * ⚠ 核心坑（实测）：Node 公开的 `zstdDecompressSync()` / `createZstdDecompress()`
 *   只解**第一帧**。本机实测：66843 B 的 `session.v4.jsonl.zstd` 经 one-shot 解得
 *   **273 字符**（只有 session 头记录），后续记录全丢；用魔数 `indexOf` 扫描也
 *   不可靠（会命中压缩载荷中的伪魔数）。必须按**帧头**逐帧计算边界。
 *
 * 帧布局契约（Zstandard 公开格式规范）：
 *   - 每帧起始 4 字节 LE 魔数 0xfd2fb528
 *   - frame_header_descriptor 的保留位 (0x18) 必须为 0
 *   - 每块 3 字节 LE 头：bit0 = lastBlock，bit1-2 = blockType，其余 = blockSize
 *   - 保留 block type 0x3 视为损坏
 *   - 可选 4 字节帧校验和（descriptor bit2）
 *
 * @module dsh-capability-aware/lib/ledger/zstd
 */
import { readFile } from 'node:fs/promises';
import { zstdDecompress } from 'node:zlib';
import { promisify } from 'node:util';

const zstdDecompressAsync = promisify(zstdDecompress);
const ZSTD_MAGIC = 0xfd2fb528;

/**
 * 定位完整的 zstd 帧。末尾未写完的帧作为 `tornStart` 单独返回，
 * 只读路径可以安全忽略它（正在写入的会话日志末尾常态如此）。
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset++);
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`);
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`);
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/** 解压全部完整帧，拼接为一份 UTF-8 文本。`torn` 表示末尾有半截帧被跳过。 */
export async function decompressAllZstdFrames(buffer) {
  const scan = scanZstdFrames(buffer);
  if (scan.frames.length === 0) throw new Error('empty or header-less Zstandard session log');
  const decoded = [];
  for (const frame of scan.frames) {
    decoded.push(await zstdDecompressAsync(buffer.subarray(frame.start, frame.end)));
  }
  return {
    content: Buffer.concat(decoded),
    frameCount: decoded.length,
    torn: scan.tornStart !== undefined,
  };
}

/** 读并解码一个会话日志文件 → 逐行 JSON 对象数组（坏行跳过，不 throw）。 */
export async function readSessionLogLines(file) {
  const raw = await readFile(file);
  const { content, frameCount, torn } = await decompressAllZstdFrames(raw);
  const events = [];
  let badLines = 0;
  for (const line of content.toString('utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      badLines += 1;
    }
  }
  return { events, frameCount, torn, badLines, bytes: raw.length };
}

export { ZSTD_MAGIC };
