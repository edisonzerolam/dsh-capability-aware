// dsh-efficiency · 客户端半边测试（test/client.test.mjs）
//
// 覆盖 `lib/client.js`（设置页「效率机」条目）的四层契约：
//   ① ModuleLoader bundle 契约：id / factory / exports.apply / exports.inject
//   ② 注册契约：apply 必须把 settings.section 注册成 id='efficiency'、order=20 的独立项
//   ③ 韧性：ctx 缺服务时 apply 不得抛（客户端半边坏掉不该连累整个设置页）
//   ④ 渲染契约：真跑取数 + 渲染，页面上必须出现后端给的数（这是本功能的实质）
//
// ④ 用**自写的最小 React 垫片**（记录式 createElement + 真状态存储），因为
// 壳子提供的 react 只能在浏览器里跑；垫片让「取数 → setState → 重渲染」这条
// 链路在 Node 里真实走一遍，而不是断言源码字符串（同义反复）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'lib', 'client.js')

/** 用 vm 之外的轻量法：造 window，再动态 import（带 cache-bust）。 */
async function loadBundle() {
  let captured = null
  globalThis.window = { __ModuleLoader__: { load: (def) => { captured = def } } }
  await import(`${pathToFileURL(CLIENT).href}?t=${Date.now()}-${Math.random()}`)
  assert.ok(captured, 'lib/client.js 必须调用 window.__ModuleLoader__.load(...)')
  return captured
}

// ── 最小 React 垫片 ────────────────────────────────────────────
let store = []
let cursor = 0
let effects = []

const ReactShim = {
  createElement(type, props, ...children) {
    const p = { ...(props || {}) }
    if (children.length === 1) p.children = children[0]
    else if (children.length > 1) p.children = children
    return { type, props: p }
  },
  useState(init) {
    const i = cursor++
    if (store[i] === undefined) store[i] = typeof init === 'function' ? init() : init
    return [store[i], (v) => { store[i] = typeof v === 'function' ? v(store[i]) : v }]
  },
  useEffect(fn) { effects.push(fn) },
  useCallback(fn) { return fn }
}

/**
 * 渲染一次并摊平成文本。
 * 注意：`reg.comp` 返回的是**元素**（type=Page），所以必须走 flatten 才会
 * 真正调用 Page —— 副作用也正是在 flatten 期间被收集的。
 */
function renderText(Component, props) {
  cursor = 0
  effects = []
  return flatten(Component(props))
}

/** 把元素树摊平成纯文本（函数组件就地展开，便于断言页面内容）。 */
function flatten(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) flatten(n, out); return out }
  if (typeof node === 'object' && 'type' in node) {
    const props = node.props || {}
    if (typeof node.type === 'function') flatten(node.type(props), out)
    else flatten(props.children, out)
  }
  return out
}

/** 造一个把注册内容记下来的假 ctx。 */
function makeCtx() {
  const dicts = {}
  let reg = null
  const ctx = {
    effect(fn) { fn(); return () => {} },
    locale: {
      bind: (ns) => (k) => (dicts[ns] && dicts[ns].zh && dicts[ns].zh[k]) || k,
      register: (ns, d) => { dicts[ns] = d }
    },
    slots: {
      inject: (slot, fn) => { fn(); return () => {} },
      register: (opts, comp) => { reg = { slot: 'settings.section', opts, comp }; return () => {} }
    }
  }
  return { ctx, dicts, getReg: () => reg }
}

// ── ① + ② bundle 与注册契约 ───────────────────────────────────
test('客户端 bundle：id 正确、factory 产出 apply/inject', async () => {
  const def = await loadBundle()
  assert.equal(def.id, 'dsh-efficiency')
  assert.equal(typeof def.factory, 'function')

  const mod = def.factory((name) => {
    if (name === 'react') return ReactShim
    throw new Error(`意外的 require：${name}`)
  })
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots', 'locale'])
})

test('客户端 apply：把「效率机」注册成设置页的独立 section（id=efficiency, order=20）', async () => {
  const def = await loadBundle()
  const mod = def.factory(() => ReactShim)
  const { ctx, dicts, getReg } = makeCtx()

  mod.apply(ctx)

  const reg = getReg()
  assert.ok(reg, 'apply 必须调用 ctx.slots.register 注册 settings.section')
  assert.equal(reg.opts.name, 'settings.section')
  assert.equal(reg.opts.id, 'efficiency', 'section id 必须是 efficiency')
  assert.equal(reg.opts.order, 20, 'order=20：排在 plugins(15) 之后，且不与 agg-config(35) 撞位')
  assert.equal(reg.opts.locale, 'efficiency.settings')
  assert.equal(typeof reg.comp, 'function', '必须给出页面组件')

  // 字典已注册，且 label() 能取到中文导航名
  assert.ok(dicts['efficiency.settings'], '必须注册 locale 字典')
  assert.equal(dicts['efficiency.settings'].zh.nav, '效率机')
  assert.equal(reg.opts.label(), '效率机')
})

test('客户端 apply：ctx 缺 slots/locale 时不得抛（坏半边不连累设置页）', async () => {
  const def = await loadBundle()
  const mod = def.factory(() => ReactShim)
  assert.doesNotThrow(() => mod.apply({}))
  assert.doesNotThrow(() => mod.apply({ effect: () => { throw new Error('boom') } }))
})

// ── ④ 渲染契约：真取数、真渲染 ────────────────────────────────
const FIXTURES = {
  '/api/efficiency/doctor': {
    healthy: true, state: 'ok', entries: 762,
    counts: { skill: 351, plugin: 10, interface: 174 }
  },
  '/api/efficiency/ledger/recent?limit=1': { total: 15768, badLines: 0, records: [] },
  '/api/efficiency/monitor/health': { healthy: true, stats: { ticks: 955, errors: 0, samplesWritten: 955 } },
  '/api/efficiency/monitor/procs': {
    source: 'ffi', cores: 12, wallMs: 504, totalWorkingSetMB: 5801,
    cached: true, sampleAgeMs: 4200,
    procs: [
      { pid: 42256, kind: 'host', cpuPct: 143.75, workingSetMB: 1981, name: 'DSH Desktop.exe' },
      { pid: 20412, kind: 'utility', cpuPct: 2.5, workingSetMB: 120.4, name: 'node.exe' }
    ],
    cpuBasis: 'CPUBASIS_SENTINEL',
    disclaimer: 'DISCLAIMER_SENTINEL'
  },
  '/api/efficiency/diagnose': {
    schema: 'dsh-efficiency/diagnostics/v1', minCount: 3, totalFindings: 3,
    counts: { P0: 1, P1: 1, P2: 1, P3: 0 },
    fixable: [{}, {}], notFixable: [],
    bySeverity: {
      P0: [{ code: 'PLUGIN_FAILED', subject: { kind: 'plugin', name: 'demo' }, count: 7, sessionCount: 2 }],
      P1: [], P2: [], P3: []
    }
  }
}

test('客户端页面：取数走 5 条只读路由，并把后端原样的数渲染出来', async () => {
  const def = await loadBundle()
  const mod = def.factory(() => ReactShim)
  const { ctx, getReg } = makeCtx()
  mod.apply(ctx)
  const reg = getReg()

  const asked = []
  const realFetch = globalThis.fetch
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.fetch = async (url) => {
    asked.push(url)
    const body = FIXTURES[url]
    if (!body) throw new Error(`未预期的 URL：${url}`)
    return { ok: true, status: 200, json: async () => body }
  }
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}

  try {
    // 首帧：loading，副作用表里挂着取数
    store = []
    renderText(reg.comp, { t: (k) => k })
    assert.ok(effects.length >= 1, '组件必须挂副作用（取数）')
    for (const fn of effects) fn()

    // 放行微任务，让 loadAll 的 Promise 链落地
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    const text = renderText(reg.comp, { t: (k) => k }).join('  ')

    assert.deepEqual(asked.sort(), Object.keys(FIXTURES).sort(), '必须且只取这 5 条路由')

    // 概览：能力条目 / 技能 / 插件 / 接口
    assert.match(text, /762/, '能力条目数必须上屏')
    assert.match(text, /351/, '技能数必须上屏')
    assert.match(text, /15,768/, '账本记录数必须按千分位上屏')
    assert.match(text, /955/, '监控心跳必须上屏')
    // 进程表：pid / 角色 / 映像名 / 免责说明
    assert.match(text, /42256/, '进程 pid 必须上屏')
    assert.match(text, /DSH Desktop\.exe/, '映像名必须上屏')
    assert.match(text, /143\.8%/, 'CPU% 必须按一位小数上屏')
    assert.match(text, /1,981 MB|1981 MB/, '工作集必须上屏')
    // CPU 口径必须上屏：cpuPct 是「100% = 占满 1 个逻辑核」，12 核机上 143.8%
    // 看着像 143% 其实只有 1.44 核。不带口径的数字会骗人（老板原话：「208% 是什么鬼」）。
    assert.match(text, /CPUBASIS_SENTINEL/, 'CPU 口径说明必须原样上屏（否则数字会骗人）')
    // 缓存路径必须自证：数据取自最近一次心跳采样，而不是点一次刷新就重采一遍全机
    assert.match(text, /最近一次心跳采样/, '必须标明数据取自缓存采样')
    assert.match(text, /4 秒前|4秒前/, '必须标明采样距今多久')
    assert.match(text, /DISCLAIMER_SENTINEL/, '后端免责说明必须原样上屏（不得吞掉）')
    // 诊断：分档 + 可修/不可修 + 条目
    assert.match(text, /PLUGIN_FAILED/, 'finding code 必须上屏')
    assert.match(text, /plugin:demo/, 'finding 主体必须上屏')
    assert.match(text, /P3/, 'P3 档位必须可见')
  } finally {
    globalThis.fetch = realFetch
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
})

test('客户端页面：intro 不得带纵向 flex，且轮询间隔必须是 15 秒', async () => {
  const def = await loadBundle()
  const mod = def.factory(() => ReactShim)
  const { ctx, getReg } = makeCtx()
  mod.apply(ctx)

  const realFetch = globalThis.fetch
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const intervals = []
  globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => FIXTURES[url] })
  globalThis.setInterval = (fn, ms) => { intervals.push(ms); return 0 }
  globalThis.clearInterval = () => {}

  try {
    store = []
    renderText(getReg().comp, { t: (k) => k })
    for (const fn of effects) fn()
    await new Promise((r) => setTimeout(r, 0))

    // 收集「纯文本 → style」对（flatten 会丢掉 style，这里自己走一遍树）
    const pairs = []
    const walk = (node) => {
      if (node === null || node === undefined || typeof node === 'boolean') return
      if (typeof node === 'string' || typeof node === 'number') return
      if (Array.isArray(node)) { for (const n of node) walk(n); return }
      if (typeof node === 'object' && 'type' in node) {
        const props = node.props || {}
        if (typeof node.type === 'function') { walk(node.type(props)); return }
        const kids = props.children
        const text = typeof kids === 'string'
          ? kids
          : (Array.isArray(kids) ? kids.filter((c) => typeof c === 'string').join('') : '')
        if (text) pairs.push({ text, style: props.style || {} })
        walk(kids)
      }
    }
    walk(getReg().comp({ t: (k) => k }))

    // 副标题：locale 走 makeCtx 注册的真实词典，故文本是中文而不是 key
    const intro = pairs.find((p) => /本机能力索引|Local capability index/.test(p.text))
    assert.ok(intro, `必须渲染出副标题，实际文本节点：${JSON.stringify(pairs.map((p) => p.text).slice(0, 12))}`)
    // intro 是 S.wrap（flexDirection:'column'）的直接子元素：纵向 flex 里 flex-basis
    // 量的是**高度**，grow:1 再吃光剩余纵向空间 ⇒ 顶出 500+px 空盒。绝不能加回 flex。
    assert.equal(intro.style.flex, undefined, 'intro 不能带 flex —— 会顶出一个大空盒')
    // 全树兜底：任何节点都不许再出现 `flex: '1 1 320px'` 这种纵向基高写法
    const bad = pairs.filter((p) => typeof p.style.flex === 'string' && p.style.flex.includes('320px'))
    assert.deepEqual(bad.map((p) => p.text), [], '不得再有纵向 flex-basis 写法')

    // 轮询间隔放宽到 15 秒（原 5 秒：一轮完整刷新 1313ms Host CPU ⇒ 常驻单核 26.3%）
    assert.ok(intervals.includes(15000), `自动刷新间隔必须是 15000ms，实际 ${JSON.stringify(intervals)}`)
  } finally {
    globalThis.fetch = realFetch
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
})

test('客户端页面：P3 的「不要动」告警必须在正文里（诚实纪律）', async () => {
  const def = await loadBundle()
  const mod = def.factory(() => ReactShim)
  const { ctx, getReg } = makeCtx()
  mod.apply(ctx)

  const realFetch = globalThis.fetch
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => FIXTURES[url] })
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}

  try {
    store = []
    renderText(getReg().comp, { t: (k) => k })
    for (const fn of effects) fn()
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    const text = renderText(getReg().comp, { t: (k) => k }).join('  ')
    assert.match(text, /P3 一律不要动/, '页面必须明写 P3 不该改本机代码')
  } finally {
    globalThis.fetch = realFetch
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
})

test('客户端页面：后端报错时如实显示，不得假装成功', async () => {
  const def = await loadBundle()
  const mod = def.factory(() => ReactShim)
  const { ctx, getReg } = makeCtx()
  mod.apply(ctx)

  const realFetch = globalThis.fetch
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) })
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}

  try {
    store = []
    renderText(getReg().comp, { t: (k) => k })
    for (const fn of effects) fn()
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    const text = renderText(getReg().comp, { t: (k) => k }).join('  ')
    assert.match(text, /HTTP 503/, '必须把 HTTP 状态如实显示出来')
    assert.doesNotMatch(text, /762/, '取数失败时不得显示任何编造的数')
  } finally {
    globalThis.fetch = realFetch
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
})

// ── ⑤ 打包契约：客户端半边必须在 package.json 里声明齐 ────────
test('package.json：客户端半边声明齐（exports + dsh.client + peers）', () => {
  const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'))
  assert.equal(pkg.exports['./client'], './lib/client.js', 'exports 必须导出 ./client')
  assert.ok(pkg.dsh && pkg.dsh.client, 'dsh.client 必须存在')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.client.immediately, true, '设置页导航项需要 immediately 装载')
  assert.ok(Array.isArray(pkg.dsh.client.inject))
  assert.ok(pkg.peerDependencies['@deepseek-ai/dsh-client-ui-slots'], '必须声明 slots 的 peer')
  assert.ok(pkg.peerDependencies['@deepseek-ai/dsh-client-locale'], '必须声明 locale 的 peer')
  assert.ok(pkg.peerDependencies.react, '必须声明 react 的 peer')
  assert.equal(pkg.peerDependenciesMeta['@deepseek-ai/dsh-client-ui-slots'].optional, true)
})
