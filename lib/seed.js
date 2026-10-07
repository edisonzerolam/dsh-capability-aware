// dsh-capability-aware · seed.js
//
// 预置人工别名（随插件分发，装上即生效）。
//
// 为什么需要这一层：BM25 是**词面**匹配，中英文混排的清单里天然存在词表鸿沟——
// 用户说「查 A股行情」，条目里写的是「股票 / 基金 / 宏观公开数据」；说「发我微信」，
// 技能名却是 `wechat-send-file`。实测（v5 取证）：
//   · AKShare[mcp] 对「查A股历史行情数据」排名 **12**；灌入别名后排名 **1**。
//   · wechat-send-file 对「发送文件到微信」命中质量 cov=0.27、exact=0 → 被判缺失；
//     灌入别名后 anyStrong=true、rank1、score 177.71。
// 正解是人工别名（精确同义），而不是继续堆权重——权重堆到能桥接这两个词，噪声也会一起涨。
//
// 落点：applyScan 合并人工数据之后、落盘之前统一注入（见 registry.js）。
// 语义：**并集**，只增不减；用户用 `cap.mjs alias` 自己加的别名不受影响。
// 纪律：只收「有真实取证支撑」的缺口（见 docs/research-2026-10-05.md），不做无差别铺词。

export const SEED_ALIASES = [
  {
    // 取证：查「查A股历史行情数据」时 mcp AKShare 掉到 rank12（top5 全是短名 skill 噪声）
    name: 'AKShare',
    type: 'mcp',
    aliases: ['A股', '沪深', '股市', '行情数据', '股票行情', '历史行情', '股票数据', '财经数据'],
    note: 'MCP 数据源，覆盖股票/基金/期货/债券/宏观公开数据',
  },
  {
    // 取证：精确点名 wechat-send-file 曾返回 no_match（Bug2 叠加词表鸿沟）；
    // 描述原文即「当用户说「把这个文件发我微信」…时使用」，别名直接取自用户口语
    name: 'wechat-send-file',
    type: 'skill',
    aliases: ['发我微信', '发送文件到微信', '发到微信', '发文件到微信', '传到手机', '发到我手机'],
    note: '受限技能（disable-model-invocation）：仅用户显式点名时可用',
  },
  {
    // 取证：中文「文生图」到不了英文技能名 imagegen-frontend-web（真实能力缺失 → 词表鸿沟）。
    // ⚠ 它不是本地生图引擎，是「图像提示词方向」技能（由宿主图像工具执行）——别名只负责让它
    //   可被检索到，边界说明由条目自身 description/bounds 承担，不夸大为「本机可本地生图」。
    name: 'imagegen-frontend-web',
    type: 'skill',
    aliases: ['文生图', '图像生成', '生图', 'AI画图', '提示词生图', '图片生成'],
    note: '图像提示词方向技能（宿主图像工具执行），非本地扩散模型',
  },
];

/**
 * 把预置别名并集注入条目（纯函数，不改原数组）。
 * @param {object[]} entries
 * @returns {{entries: object[], applied: {name:string, type:string, added:number}[]}}
 */
export function applySeedAliases(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const applied = [];
  const out = list.map((e) => {
    const seeds = SEED_ALIASES.filter(
      (s) => s.name === e.name && (!s.type || s.type === e.type),
    );
    if (!seeds.length) return e;
    const cur = Array.isArray(e.manual?.aliases) ? e.manual.aliases : [];
    const merged = [...cur];
    for (const s of seeds) {
      for (const a of s.aliases) {
        if (!merged.some((x) => String(x).toLowerCase() === String(a).toLowerCase())) merged.push(a);
      }
    }
    const added = merged.length - cur.length;
    if (added > 0) applied.push({ name: e.name, type: e.type, added });
    return {
      ...e,
      manual: {
        notes: '',
        hidden: false,
        priority: 0,
        ...(e.manual || {}),
        aliases: merged, // 并集结果必须最后落，不能被 e.manual 的旧值盖回
      },
    };
  });
  return { entries: out, applied };
}
