// dsh-capability-aware · matcher.js (v2)
// 检索：BM25-lite（IDF 加权）+ 触发词直配 + 负触发降权 + 歧义判定。
// v2 调研依据：
//  - MCP 官方 Client Best Practices：keyword(BM25) 对描述型工具名/description「简单有效」；
//    embedding 路线在 <500 条能力 + 零依赖约束下复杂度不划算（Reddit 140 工具实战同结论）。
//  - Claude Skills：description 是触发器，须同时说「做什么 + 何时用」→ triggers 提取后直配强加分。
//  - 负触发（已归档/勿用）条目强降权并标注，防错误路由（本机 bili-daily 真实案例）。

import { CAP_TYPES } from './schema.js';

function tokens(s) {
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

/**
 * BM25-lite 语料统计：IDF 预计算（scan 后由 registry 传 entries 调用一次）。
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

// v3 事实型类型：env/hardware/software 是「参考事实」而非「可执行能力」——
// 任务意图同时命中能力型与事实型时，能力型应领先（真实回归：通道条目压过 web-intel 技能）。
const FACT_TYPES = new Set(['env', 'hardware', 'software']);

function scoreEntry(query, entry, idfMap) {
  const qTokens = tokens(query);
  if (!qTokens.length) return null;
  const aliases = (entry.manual?.aliases || []).map((a) => String(a).toLowerCase()).filter(Boolean);
  const nameL = entry.name.toLowerCase();
  const descL = (entry.description || '').toLowerCase();
  const trig = [...(entry.triggers || []), ...aliases];
  let score = 0;
  let descHits = 0;
  for (const t of qTokens) {
    // 词权重：IDF 可用时用 IDF（min 0.5 保底，防新词无权重），否则退化到 v1 常数
    const w = idfMap ? Math.max(0.5, idfMap.get(t) || 0.5) : 1;
    // 单字 CJK（边界字）禁 name.contains：泛词尾字「据」会白拿 4w（真实回归 B-自动化 34 分来源）
    if (nameL === t) score += 8 * w;
    else if (nameL.includes(t) && !(/[\u4e00-\u9fff]/.test(t) && t.length === 1)) score += 4 * w;
    // 单字 CJK token（边界单字）只允许触发词全等命中，禁 contains 桥接——
    // 否则「调优」的边界字「调」会桥接到触发词「调用方式」造成假命中（T4 实测）。
    const single = t.length === 1 && /[\u4e00-\u9fff]/.test(t);
    if (single) {
      if (trig.includes(t)) score += 6 * w;
    } else {
      if (trig.some((x) => x === t)) score += 6 * w;
      else if (trig.some((x) => x.includes(t) || t.includes(x))) score += 3 * w;
    }
    // description 命中：每条目封顶 3 个 token——长描述（automation prompt 500 字）里
    // 的泛词 bigram 靠词数累积会压过特异触发词（真实回归实测 34 vs 9）；封顶后
    // 触发词/别名命中（6w）稳定压过 desc 泛词，且纯 desc 条目仍可达 minScore。
    if (descHits < 3 && descL.includes(t)) { score += 2 * w; descHits++; }
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
  // 负触发（已归档/勿用）：强降权到近乎不可见，但保留可检索性（点名时仍能找到并给出警告）
  if (entry.negative) score = Math.min(score * 0.15, 2);
  if (FACT_TYPES.has(entry.type)) score *= 0.85;
  if (score <= 0) return null;
  return { entry, score };
}

/**
 * 检索（v2）。
 * opts: { topK, minScore, idf } —— idf 由 buildIdf(entries) 传入；缺省退化常数权重。
 * 返回 kind: empty_registry | no_query | no_match | ambiguous | ok
 * v2 新增：命中负触发条目时附 warnings。
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

  const scored = entries
    .map((e) => scoreEntry(q, e, idfMap))
    .filter(Boolean)
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));

  if (!scored.length) return { kind: 'no_match', missing: { query: q } };

  const top = scored.slice(0, topK);
  const best = top[0];
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
    negative: s.entry.negative === true,
    source: s.entry.source,
  }));

  const warnings = candidates.filter((c) => c.negative).map((c) => `${c.name} 已归档/标记勿用，匹配已降权——确认是否真要用它。`);
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
      clarifications: active.slice(0, 4).map((c) => `${c.name}（${c.type}）：${c.description || '（无描述）'}`),
    };
  }
  return { kind: 'ok', top: active[0] || candidates[0], candidates, warnings };
}
