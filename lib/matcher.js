// dsh-capability-aware · matcher.js (v5)
// 检索：BM25-lite（IDF 加权）+ 触发词直配 + 负触发降权 + 权限标志标注 + 歧义判定。
// v5 修复（全部源自真实调用回归实测，非纸面推演）：
//  Bug4 — 工具路径不传 idf 导致退化为常数权重（「查A股历史行情数据」全候选并列 16 分）。
//         正解：match() 在缺省 idf 时**自行用 entries 现算并缓存**，从根上拆掉这个脚枪。
//  Bug2 — disabled（disable-model-invocation 权限标志）被当成 negative（已归档/勿用）强降权，
//         致「只允许用户点名的敏感技能」不可见（wechat-send-file 真实事故）。
//         正解：两者分档——negative 强降权+告警；disabled 正常参与排序但显式标注「需用户点名确认」。
//  Bug3 — 纯描述噪声地板（「文生图」6 条并列 12.61，全来自单字 CJK 边界字命中）挤掉缺失引导。
//         正解：description 命中同样禁单字 CJK（与 name/trigger 口径一致），噪声地板归零 → 走 missing。
// v2/v3 既有设计保留：IDF 加权、触发词全等 6w/双向包含 3w、别名整词覆盖 +10×maxIDF、
//                     description 每条目封顶 3 token、FACT_TYPES 降权、hidden/priority。

import { CAP_TYPES } from './schema.js';

export function tokens(s) {
  const out = [];
  // v3：允许单字符拉丁词——「A股」的 a 必须成词，否则 alias 全断（实测踩坑）
  const latin = String(s).toLowerCase().match(/[a-z0-9_.@/-]+/g) || [];
  out.push(...latin);
  const cjk = String(s).match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of cjk) {
    if (run.length === 1) { out.push(run); continue; }
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
    // v3：边界单字（首/尾）。bigram 切不出「股」→「查A股…」永远桥不到触发词「股票」
    //（"A" 单字符被丢、"股历"≠"股票"）；首尾单字经全等桥接同义词。
    out.push(run[0], run[run.length - 1]);
  }
  return out;
}

const isSingleCjk = (t) => t.length === 1 && /[\u4e00-\u9fff]/.test(t);
// v5 缺陷 B：单字符拉丁 token（`b`/`a`）IDF 高得离谱（实测 `b`=4.831）却几乎无语义——
// 「抓B站视频字幕」里单字 `b` 一项就贡献 +43.47 分，是榜首噪声主因。
// 正解：单字符拉丁 token 的权重压到 0.5 保底（不删 token，别名整词覆盖仍需 `a` 参与
// qSet 判定，如「A股」→ [a, 股]），只掐掉它的**打分权重**。
const isSingleLatin = (t) => t.length === 1 && /[a-z0-9]/.test(t);

/**
 * BM25-lite 语料统计：IDF 预计算。
 * 词在越多条目出现 → IDF 越低（「PDF」「技能」类泛化词降权）；
 * 罕见词（「字幕」「wbi 签名」类特异词）IDF 高 → 命中时强加分。
 */
export function buildIdf(entries) {
  const df = new Map();
  let N = 0;
  for (const e of entries) {
    if (e.manual?.hidden) continue; // hidden 不进语料
    N++;
    // 语料 = name + description + triggers + manual.aliases（别名参与 IDF：
    // 否则 alias token 不在词表里，整词覆盖加分被 0.5 保底压扁——真实踩坑）
    const text = `${e.name} ${(e.description || '')} ${(e.triggers || []).join(' ')} ${(e.manual?.aliases || []).join(' ')}`;
    const seen = new Set(tokens(text));
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = new Map();
  for (const [t, n] of df) {
    // BM25 IDF（r=0）：log((N - n + 0.5) / (n + 0.5) + 1)，罕见词高、常见词趋 0
    idf.set(t, Math.log((N - n + 0.5) / (n + 0.5) + 1));
  }
  return { idf, N };
}

// v5 Bug4：IDF 缓存。调用方忘传 idf（tool.js 历史 bug）时自愈，且同一份清单复用不重算。
// 用 WeakMap 以 entries 数组身份为键——清单重扫会换新数组，天然失效，无过期问题。
const idfCache = new WeakMap();

export function idfFor(entries) {
  if (!Array.isArray(entries)) return null;
  let hit = idfCache.get(entries);
  if (!hit) {
    hit = buildIdf(entries).idf;
    idfCache.set(entries, hit);
  }
  return hit;
}

// v3 事实型类型：env/hardware/software 是「参考事实」而非「可执行能力」——
// 任务意图同时命中能力型与事实型时，能力型应领先（真实回归：通道条目压过 web-intel 技能）。
const FACT_TYPES = new Set(['env', 'hardware', 'software']);

/**
 * v5 Bug3：命中**质量**评估（与打分正交）。
 *
 * 动机：得分高不等于答得对。「文生图」返回 frontend-studio 35.92 分，看似有答案，
 * 实则是单字/泛词噪声；而本机真的没有生图能力。仅靠分数阈值无法区分——
 * 实测「发送文件到微信」的噪声榜首（软件:微信 42.79 分）比真答案还高。
 *
 * 判据（全部由 10 条真实查询标定，见 docs/research-2026-10-05.md）：
 *   aliasHit  — 人工别名整词覆盖（最强证据，人工维护即精确同义）
 *   exact     — 条目名或触发词与查询 token **全等**
 *   cov       — 多字 token 的命中覆盖率（单字 CJK/拉丁不计，它们是噪声主源）
 *   nonDesc   — 其中命中在 name/trigger（非 description）的占比
 * 强证据：aliasHit | (exact && nonDesc>=0.2) | cov>=0.4
 *   —— 「软件:微信」虽然 name⊃微信，但 cov=0.09 → 弱；
 *      「ffmpeg 视频转码」cov=1.00 → 强；「GPU 用显卡加速转写」exact+nonDesc=0.5 → 强。
 * 该判据**只用于附加提示**（weak 时补一句「可能不具备」），不改变候选排序，
 * 因此不会把真有能力的查询误判成缺失——最坏情况是多一句提示。
 */
export function queryStrength(entry, qTokens, idfMap) {
  const qt = [...new Set(qTokens)].filter((t) => t.length > 1);
  const nameL = String(entry.name || '').toLowerCase();
  const descL = String(entry.description || '').toLowerCase();
  const all = [...(entry.triggers || []), ...(entry.manual?.aliases || [])].map((x) => String(x).toLowerCase());
  let hit = 0, nonDesc = 0, exact = false;
  for (const t of qt) {
    const nEq = nameL === t, nIn = nameL.includes(t);
    const tEq = all.includes(t), tIn = all.some((x) => x.includes(t) || t.includes(x));
    const dIn = descL.includes(t);
    if (nEq || tEq) exact = true;
    if (nEq || nIn || tEq || tIn || dIn) {
      hit++;
      if (nEq || nIn || tEq || tIn) nonDesc++;
    }
  }
  const cov = qt.length ? hit / qt.length : 0;
  const nonDescRatio = qt.length ? nonDesc / qt.length : 0;
  // 别名整词覆盖：与 scoreEntry 同口径（别名 token 全在查询里）
  const qSet = new Set(qTokens);
  const aliasHit = (entry.manual?.aliases || []).some((al) => {
    const at = [...new Set(tokens(al))];
    return at.length > 0 && at.every((t) => qSet.has(t));
  });
  const strong = aliasHit || (exact && nonDescRatio >= 0.2) || cov >= 0.4;
  return { cov, nonDesc: nonDescRatio, exact, aliasHit, strong };
}

function scoreEntry(query, entry, idfMap, qTokens) {
  if (!qTokens.length) return null;
  const aliases = (entry.manual?.aliases || []).map((a) => String(a).toLowerCase()).filter(Boolean);
  const nameL = entry.name.toLowerCase();
  const descL = (entry.description || '').toLowerCase();
  const trig = [...(entry.triggers || []), ...aliases];
  let score = 0;
  let descHits = 0;
  for (const t of qTokens) {
    // 词权重：IDF 可用时用 IDF（min 0.5 保底，防新词无权重），否则退化到 v1 常数
    let w = idfMap ? Math.max(0.5, idfMap.get(t) || 0.5) : 1;
    // v5 缺陷 B：单字符拉丁 token 权重压到 0.5 保底——「抓B站视频字幕」里单字 `b`
    // 一项贡献 +43.47 分（IDF 4.831，纯噪声）。不删 token（别名整词覆盖仍需 `a`/`b`
    // 参与 qSet 判定），只掐打分权重。
    if (isSingleLatin(t)) w = 0.5;
    const single = isSingleCjk(t);
    // 单字 CJK（边界字）禁 name.contains：泛词尾字「据」会白拿 4w（真实回归 B-自动化 34 分来源）
    if (nameL === t) score += 8 * w;
    else if (nameL.includes(t) && !single) score += 4 * w;
    // 单字 CJK token（边界单字）只允许触发词全等命中，禁 contains 桥接——
    // 否则「调优」的边界字「调」会桥接到触发词「调用方式」造成假命中（T4 实测）。
    if (single) {
      if (trig.includes(t)) score += 6 * w;
    } else {
      if (trig.some((x) => x === t)) score += 6 * w;
      else if (trig.some((x) => x.includes(t) || t.includes(x))) score += 3 * w;
    }
    // description 命中：每条目封顶 3 个 token——长描述（automation prompt 500 字）里
    // 的泛词 bigram 靠词数累积会压过特异触发词（真实回归实测 34 vs 9）；封顶后
    // 触发词/别名命中（6w）稳定压过 desc 泛词，且纯 desc 条目仍可达 minScore。
    // v5 Bug3：单字 CJK 同样禁 desc 命中——「文生图」的边界字「文」「图」几乎出现在
    // 每条中文描述里，制造出「6 条并列 12.61」的噪声地板，把真实缺失伪装成有候选。
    if (descHits < 3 && !single && descL.includes(t)) { score += 2 * w; descHits++; }
  }
  // 别名整词覆盖：别名的全部 token ⊆ 查询 token 集 → 强加分。
  // 这是 BM25 词表鸿沟的正解：「A股」= tokens [a, 股] 都在查询里 → AKShare 直上高分；
  // 整词覆盖 = 精确同义（不泛化），比逐 token contains 桥接噪声小得多。
  if (aliases.length) {
    const qSet = new Set(qTokens);
    for (const al of aliases) {
      const alTokens = [...new Set(tokens(al))];
      if (alTokens.length && alTokens.every((t) => qSet.has(t))) {
        const wMax = idfMap ? Math.max(...alTokens.map((t) => Math.max(0.5, idfMap.get(t) || 0.5))) : 1;
        score += 10 * wMax;
        break; // 命中一个别名就够
      }
    }
  }
  score += Math.max(-10, Math.min(10, entry.manual?.priority || 0));
  if (entry.manual?.hidden) score = -1;
  // v2 负触发（已归档/勿用/deprecated）：强降权到近乎不可见。
  // v5：但**点名仍须可用**——查询完整覆盖条目名（用户显式点名）时只温和降权，
  //     使其能浮出 minScore 并带告警（旧实现 0.15 系数 + minScore=4 使点名也查不到）。
  const nameTokens = [...new Set(tokens(nameL))];
  const namedExactly = nameTokens.length > 0 && nameTokens.every((t) => qTokens.includes(t));
  if (entry.negative) {
    score = namedExactly ? score * 0.5 : Math.min(score * 0.15, 2);
  }
  // v5 Bug2：disabled（disable-model-invocation / mcp enabled=false）是**权限标志**，
  // 不是「勿用」。不降权（它就是要被检索到的能力），仅由 match() 标注「需用户点名确认」。
  if (FACT_TYPES.has(entry.type)) score *= 0.85;
  if (score <= 0) return null;
  return { entry, score };
}

/**
 * 检索（v5）。
 * opts: { topK, minScore, idf } —— idf 缺省时**自动由 entries 现算**（Bug4 自愈）；
 *       也可显式传 Map 或落盘对象 {term: idf}。
 * 返回 kind: empty_registry | no_query | no_match | ambiguous | ok
 * 候选附 warnings（negative 告警 / disabled 需点名确认）。
 */
export function match(query, entries, opts = {}) {
  const topK = opts.topK || 5;
  const minScore = opts.minScore || 4;
  if (!entries || entries.length === 0) return { kind: 'empty_registry' };
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) return { kind: 'no_query' };

  const idfMap = opts.idf instanceof Map ? opts.idf
    : (opts.idf && typeof opts.idf === 'object' && !(opts.idf instanceof Map) && Object.keys(opts.idf).length && !(opts.idf.idf instanceof Map))
      ? new Map(Object.entries(opts.idf).map(([k, v]) => [k, Number(v)]))
    : (opts.idf && opts.idf.idf instanceof Map ? opts.idf.idf : null);
  // v5 Bug4 自愈：调用方没给 idf 就用清单现算（缓存），杜绝「静默退化为常数权重」
  const effIdf = idfMap || idfFor(entries);

  const qTokens = [...new Set(tokens(q))];
  const scored = entries
    .map((e) => scoreEntry(q, e, effIdf, qTokens))
    .filter(Boolean)
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));

  // v5 缺陷 B：父子竞争让位。路由器型父技能（如 visual-studio，4 个子技能）的触发面里
  // 带「覆盖词」（字幕/处理视频…），靠触发词全等 6w 压过真正专精的子技能
  // （实测「抓B站视频字幕」visual-studio 64.14 > web-intel/bili-daily 60.37）。
  // 规则：**父与其子同时进入候选**时，父让位（×0.7）——用户点名父技能（namedExactly）
  // 或子技能没命中时，父仍是正常候选。这比无条件降权路由器更精准：web-intel 作为
  // bili-daily 的父，只有在子同时命中时才让位，不会削弱它作为域入口的地位。
  const routerNames = new Set();
  for (const e of entries) if (e.super) routerNames.add(e.super);
  if (routerNames.size) {
    // 候选里各父技能各有多少个子技能入围
    const childHits = new Map();
    for (const s of scored) {
      if (s.entry.super) childHits.set(s.entry.super, (childHits.get(s.entry.super) || 0) + 1);
    }
    for (const s of scored) {
      if (!routerNames.has(s.entry.name)) continue; // 不是路由器（没有子技能）
      const namedParent = [...new Set(tokens(s.entry.name))].every((t) => qTokens.includes(t));
      if ((childHits.get(s.entry.name) || 0) > 0 && !namedParent) s.score *= 0.7;
    }
    scored.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
  }

  if (!scored.length) return { kind: 'no_match', missing: { query: q } };

  const top = scored.slice(0, topK);
  const best = top[0];
  // v5 Bug3：标注每个候选的「命中质量」，并给出整体是否可信（weak）。
  // 这是**附加信号**，不参与排序——保证不会把真有能力的查询误判为缺失。
  const strengths = new Map();
  for (const s of top) strengths.set(s.entry, queryStrength(s.entry, qTokens, effIdf));
  const anyStrong = top.some((s) => strengths.get(s.entry)?.strong);
  const candidates = top.map((s) => ({
    name: s.entry.name,
    type: s.entry.type,
    description: s.entry.description,
    triggers: s.entry.triggers,
    invoke: s.entry.invoke,
    guidance: s.entry.guidance,
    // v4.2：答案里显式带出权威归属与边界——「权威入口是 X，本插件仅索引底稿/兜底」
    authority: s.entry.authority || undefined,
    bounds: s.entry.bounds || undefined,
    score: Math.round(s.score * 100) / 100,
    confidence: Math.max(0, Math.min(1, s.score / best.score)),
    // v5 Bug3：命中质量透出（cov/nonDesc/exact/aliasHit/strong），供调用方判断
    // 「这是真答案还是噪声榜首」——「文生图」的 frontend-studio 就是噪声榜首的实例。
    quality: (() => { const q = strengths.get(s.entry); return q ? { cov: Math.round(q.cov * 100) / 100, nonDesc: Math.round(q.nonDesc * 100) / 100, exact: q.exact, aliasHit: q.aliasHit, strong: q.strong } : undefined; })(),
    negative: s.entry.negative === true,
    // v5 Bug2：权限标志透出——调用方须提示「需用户点名确认，agent 不得自动调用」
    disabled: s.entry.disabled === true,
    // v5：路由层级（父技能/子技能），便于展示与审计
    super: s.entry.super,
    tier: s.entry.tier,
    source: s.entry.source,
  }));

  const warnings = [];
  for (const c of candidates) {
    if (c.negative) warnings.push(`${c.name} 已归档/标记勿用，匹配已降权——确认是否真要用它。`);
    else if (c.disabled) warnings.push(`${c.name} 为受限能力（disable-model-invocation），仅可在用户显式点名时使用，不得自动调用。`);
  }
  const active = candidates.filter((c) => !c.negative);
  if (active.length === 0 && warnings.length) {
    return { kind: 'no_match', missing: { query: q }, warnings };
  }

  const nearTies = active.filter((c) => c !== active[0] && c.confidence >= 0.75);
  if (nearTies.length > 0) {
    return {
      kind: 'ambiguous',
      top: active[0] || candidates[0], // API 一致性：ambiguous 也要给 top（最高分候选），调用方免二次判空
      candidates,
      warnings,
      // v5 Bug3：全部候选都不是「强命中」→ 很可能本机确实没有这项能力。
      // 调用方应**保留候选**（可能仍有参考价值）并**附加缺失引导**。
      anyStrong,
      clarifications: active.slice(0, 4).map((c) => `${c.name}（${c.type}）：${c.description || '（无描述）'}`),
    };
  }
  return { kind: 'ok', top: active[0] || candidates[0], candidates, warnings, anyStrong };
}
