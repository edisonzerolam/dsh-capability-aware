// dsh-capability-aware · 验收测试（node --test，零外部依赖）
// 验收标准：
//  A. 给定用户请求 → 返回匹配能力及调用方式
//  B. 移除某能力后 → 检测缺失并给出针对性补足引导
//  C. 边界：空/未初始化清单、模糊需求、多候选澄清
// 隔离：全部走 DSH_CAP_DSH_HOME / DSH_CAP_FILE 指向临时 fixture，不碰真实 ~/.dsh。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { provisionAgentsPointer } from '../lib/provision.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dshcap-'));
}

// 独立加载（直接 import 模块；scanner 的 homeDsh() 读 DSH_CAP_DSH_HOME 环境变量）
// ⚠ node:test 同进程共享 env，这里用「先设 env 再调函数」的顺序保证隔离。
process.env.DSH_CAP_DSH_HOME = mkTmp();

const modUrl = (p) => pathToFileURL(p).href;
const { scanAll, probeSkills, probePlugins, probeMemory, probeMcp, parseHardwareJson, parseInstalledSoftware } =
  await import(modUrl(path.join(root, 'lib', 'scanner.js')));
const { load, applyScan, diff } = await import(modUrl(path.join(root, 'lib', 'registry.js')));
const { match } = await import(modUrl(path.join(root, 'lib', 'matcher.js')));
const { guide, guideStale, guessType } = await import(modUrl(path.join(root, 'lib', 'guidance.js')));

// ── fixture：搭一个假 DSH_HOME ──────────────────────────────────────────
function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

function makeFakeHome(home) {
  // skill
  write(
    path.join(home, 'skills', 'bili-subtitle', 'SKILL.md'),
    '---\nname: bili-subtitle\ndescription: 抓取 B站 视频字幕，支持批量。\n---\n# t'
  );
  // plugin
  write(
    path.join(home, 'plugins', 'demo-plugin', 'package.json'),
    JSON.stringify({
      name: 'dsh-demo-plugin',
      version: '0.1.0',
      description: '演示插件：悬浮窗显示天气',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
  );
  // memory
  write(
    path.join(home, 'memory', 'README.md'),
    '| `harness-ops.md` | DSH 维护教训 | 修 DSH 时 |\n| `projects.md` | 项目快照 | 接手项目时 |'
  );
  write(path.join(home, 'memory', 'harness-ops.md'), '# x\n');
  write(path.join(home, 'memory', 'projects.md'), '# y\n');
  return home;
}

// ── T1 scanner：skills / plugins / memory 探针 ──────────────────────────
test('scanner: 探针在真实 fixture 上 ≥1 命中（映射字段先验）', () => {
  const home = makeFakeHome(process.env.DSH_CAP_DSH_HOME);
  const skills = probeSkills();
  assert.equal(skills.length, 1, `应恰好 1 条 skill，实际 ${JSON.stringify(skills)}`);
  assert.equal(skills[0].name, 'bili-subtitle');
  assert.equal(skills[0].type, 'skill');
  assert.ok(skills[0].description.includes('B站'));
  assert.ok(skills[0].fingerprint.length > 0);

  const plugins = probePlugins();
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].name, 'dsh-demo-plugin');
  assert.equal(plugins[0].type, 'plugin');

  const mems = probeMemory();
  assert.equal(mems.length, 2, 'README §1 登记两条 memory');
  assert.deepEqual(
    mems.map((m) => m.name).sort(),
    ['harness-ops.md', 'projects.md']
  );

  // 汇总扫描：探针错误为空
  const all = scanAll({});
  assert.deepEqual(all.probeErrors, []);
  assert.ok(all.entries.length >= 4);
});

// ── T2 registry：落盘 + 空清单边界 ──────────────────────────────────────
test('registry: 首次加载 → missing；空 entries → empty；scan 后 → ok', () => {
  const home = mkTmp();
  const file = path.join(home, 'data', 'capability-aware', 'capabilities.json');
  const first = load(file);
  assert.equal(first.state, 'missing');

  const scan = scanAll({});
  const res = applyScan(file, scan);
  assert.equal(res.state, 'ok');
  const second = load(file);
  assert.equal(second.state, 'ok');
  assert.ok(second.entries.length >= 4);

  // 幂等：二次扫描 diff 应为 0 added/removed
  const res2 = applyScan(file, scanAll({}));
  assert.equal(res2.diff.added.length, 0);
  assert.equal(res2.diff.removed.length, 0);
});

// ── T3 matcher：验收 A —— 匹配能力并返回调用方式 ────────────────────────
test('matcher: 给定用户请求 → 返回匹配能力及调用方式（验收 A）', () => {
  const home = process.env.DSH_CAP_DSH_HOME; // 已含 fake home
  const file = path.join(home, 'data', 'capability-aware', 'capabilities.json');
  // 先落盘（T2 写到了自己的 tmp，这里对共享 fixture 建清单）
  applyScan(file, scanAll({}));
  const reg = load(file);
  const m = match('帮我抓 B站 视频字幕', reg.entries);
  assert.ok(m.kind === 'ok' || m.kind === 'ambiguous', `应命中，实际 ${m.kind}`);
  // v3 语义：top 应为 skill 类型（「抓字幕」主意图是技能，软件条目 ffmpeg 可作为次候选但不得反超）
  assert.equal(m.top.type, 'skill', `top 应为 skill，实际 ${m.top.name}(${m.top.type})`);
  assert.equal(m.top.name, 'bili-subtitle');
  assert.ok(m.top.invoke.kind); // 调用方式存在
  assert.ok(m.top.invoke.how.length > 0);
  assert.ok(m.top.confidence > 0.5);

  // 精确点名
  const m2 = match('dsh-demo-plugin', reg.entries);
  assert.equal(m2.kind, 'ok');
  assert.equal(m2.top.name, 'dsh-demo-plugin');
});

// ── T4 matcher 边界：空清单 / 空查询 / 弱命中（缺失） ───────────────────
test('matcher: 空清单 → empty_registry；空查询 → no_query；真缺失 → anyStrong=false', () => {
  assert.equal(match('x', []).kind, 'empty_registry');
  const reg = load(path.join(process.env.DSH_CAP_DSH_HOME, 'data', 'capability-aware', 'capabilities.json'));
  assert.equal(match('', reg.entries).kind, 'no_query');
  // v5 Bug3：真缺失不再强行要求 kind=no_match（低分噪声仍会产出候选），
  // 而是要求 anyStrong=false —— 调用方据此追加缺失引导（附加式，不丢候选）。
  const nm = match('量子纠错编译器调优', reg.entries);
  assert.equal(nm.anyStrong, false, '真缺失查询不得被判为强命中');
  assert.ok((nm.candidates || []).every((c) => !c.quality?.strong), '真缺失时不应有强命中候选');
  // 缺失引导仍可用（tool.js 在 anyStrong=false 时调用它）
  const g = guide({ query: '量子纠错编译器调优' });
  assert.equal(g.kind, 'missing');
  assert.ok(g.message.includes('量子纠错编译器调优'));
  assert.ok(g.actions.length > 0);
});

// ── T5 多候选澄清 ────────────────────────────────────────────────────────
test('matcher: 多候选且置信接近 → ambiguous + clarifications', () => {
  const entries = [
    {
      v: 1, name: 'pdf-ocr', type: 'skill', description: 'OCR 扫描 PDF 转文字',
      triggers: ['pdf', 'ocr', '扫描'], invoke: { kind: 'cli', how: 'pdfocr' },
      manual: { aliases: [], notes: '', hidden: false, priority: 0 },
    },
    {
      v: 1, name: 'pdf-deliverable-probe', type: 'skill', description: '校验 PDF 页数边距文字',
      triggers: ['pdf', '校验'], invoke: { kind: 'cli', how: 'pdfprobe' },
      manual: { aliases: [], notes: '', hidden: false, priority: 0 },
    },
  ];
  const m = match('处理 pdf', entries);
  assert.equal(m.kind, 'ambiguous');
  assert.ok(m.clarifications.length >= 2);
  assert.ok(m.candidates[0].confidence >= m.candidates[1].confidence);
});

// ── T6 缺失检测（验收 B）：移除能力 → scan diff → 引导 ──────────────────
test('guidance: 移除能力后 scan 检测缺失并给针对性引导（验收 B）', () => {
  const home = process.env.DSH_CAP_DSH_HOME;
  const file = path.join(home, 'data', 'capability-aware', 'capabilities.json');
  const before = load(file);
  const beforeCount = before.entries.length;
  assert.ok(beforeCount >= 4);

  // 模拟用户移除技能目录
  fs.rmSync(path.join(home, 'skills', 'bili-subtitle'), { recursive: true, force: true });

  const res = applyScan(file, scanAll({}));
  assert.equal(res.diff.removed.length, 1, '应检出 1 条 removed');
  assert.equal(res.diff.removed[0].name, 'bili-subtitle');

  // 针对性引导：type=skill → 引导指向 skill-use-router build
  const g = guide({ missingName: 'bili-subtitle', missingType: 'skill' });
  assert.equal(g.kind, 'missing');
  assert.ok(JSON.stringify(g.actions).includes('skill-use-router'), '技能缺失引导必须指向索引重建');
  assert.ok(g.verify.length > 0);

  // stale 批量口径
  const gs = guideStale(res.diff.removed);
  assert.equal(gs.count, 1);
  assert.equal(gs.items[0].name, 'bili-subtitle');
  assert.ok(gs.items[0].message.includes('已从 DSH 消失'));
});

// ── T7 guidance 类型猜测 ────────────────────────────────────────────────
test('guidance: guessType 保守映射 + 未知类型兜底', () => {
  assert.equal(guessType('每天早上自动跑日报'), 'automation');
  assert.equal(guessType('装一个悬浮窗插件'), 'plugin');
  assert.equal(guessType('连接器断了这个外部工具用不了'), 'mcp');
  assert.equal(guessType('完全无关的查询词xyz'), null);
  const g = guide({ query: '完全无关的查询词xyz' });
  assert.equal(g.kind, 'missing');
  assert.ok(g.actions.length >= 1);
});

// ── T8 schema：normalizeEntry 字段校验 ──────────────────────────────────
test('schema: normalizeEntry 必填校验 + manual 字段保留', async () => {
  const { normalizeEntry } = await import(modUrl(path.join(root, 'lib', 'schema.js')));
  const bad = normalizeEntry({ name: '', type: 'nonsense' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 2);

  const good = normalizeEntry({
    name: 'demo', type: 'tool', description: '测试',
    triggers: ['TEST', ' demo '],
    invoke: { kind: 'cli', how: 'demo --run' },
    manual: { aliases: ['d'], notes: '人工备注', priority: 5 },
  });
  assert.equal(good.ok, true);
  assert.deepEqual(good.entry.triggers, ['test', 'demo']);
  assert.equal(good.entry.manual.priority, 5);
  assert.equal(good.entry.manual.notes, '人工备注');
});

// ── T9 (v3) MCP 探针：真实路径 + 真实结构 fixture + 工具目录增强 ─────────
test('mcp: mcp_connector.json tables.connections 探针 + tool_catalog 触发面增强（v3 路径修正）', () => {
  const home = process.env.DSH_CAP_DSH_HOME;
  // v3 实证真实结构：tables.connections + tables.tool_catalog
  write(
    path.join(home, 'storages', 'mcp_connector.json'),
    JSON.stringify({
      unit: { name: 'mcp_connector', version: 1 },
      tables: {
        connections: {
          'akshare-akshare': {
            key: 'akshare-akshare', name: 'AKShare', connectorId: 'akshare', kind: 'manual',
            serverKey: 'akshare', transport: 'stdio', command: 'uvx', args: ['akshare-one-mcp'],
            env: {}, cwd: '', serverName: 'akshare', headers: {}, enabled: true, updatedAt: 1790877442890,
          },
          'wind-wind': {
            key: 'wind-wind', name: 'Wind 股票数据', connectorId: 'wind', transport: 'streamable-http',
            url: 'https://mcp.wind.com.cn/vserver_stock_data/mcp/', serverName: 'wind_stock_data',
            enabled: false, updatedAt: 1790895781093,
          },
        },
        catalog: {
          remote: {
            key: 'remote', updatedAt: 1790895781000, etag: 'x',
            connectors: [
              { id: 'akshare', name: 'AKShare', summary: '股票 / 基金 / 期货 / 债券 / 宏观公开数据', tags: ['AKShare', '股票', '基金', '宏观', 'Python'] },
              { id: 'wind', name: 'Wind 股票数据', summary: '股票行情与财务数据', tags: ['Wind', '行情'] },
            ],
          },
        },
        tool_catalog: {
          'akshare-akshare': {
            key: 'akshare-akshare', serverName: 'akshare', observedAt: 1790895781093,
            tools: [
              { name: 'get_hist_data', title: 'get_hist_data', description: 'Get historical stock market data' },
              { name: 'get_realtime_data', title: 'get_realtime_data', description: 'Get real-time stock data' },
              { name: 'get_balance_sheet', title: 'get_balance_sheet', description: 'Get company balance sheet' },
            ],
          },
        },
      },
    }),
  );
  const mcp = probeMcp();
  assert.equal(mcp.length, 2, `应 2 条连接，实际 ${mcp.length}`);
  const ak = mcp.find((e) => e.name === 'AKShare');
  assert.ok(ak, 'AKShare 条目存在');
  assert.equal(ak.type, 'mcp');
  // 工具目录增强：工具名进 triggers、工具数与首工具进 description/invoke.example
  assert.ok(ak.triggers.includes('get_hist_data'), '工具名应进 triggers');
  assert.ok(ak.triggers.includes('股票'), '市场目录中文 tags 应进 triggers');
  assert.ok(ak.description.includes('股票'), '市场目录中文 summary 应进描述');
  assert.ok(ak.description.includes('3 个工具'), '工具数应进描述');
  assert.ok(ak.invoke.example.includes('mcp__akshare__get_hist_data'), '示例应为可直接调用的工具名');
  assert.equal(ak.invoke.how.includes('uvx akshare-one-mcp'), true, 'stdio 传输应给命令');
  // 停用连接器：disabled 标记
  const wind = mcp.find((e) => e.name === 'Wind 股票数据');
  assert.equal(wind.disabled, true, 'enabled=false 应标 disabled');
  assert.ok(wind.invoke.how.includes('https://mcp.wind.com.cn'), 'http 传输应给 URL');
});

// ── T10 (v3) hardware 解析：虚拟 GPU 排除 + 触发词 ──────────────────────
test('hardware: parseHardwareJson 排除虚拟显卡并产出实体条目（解析层可测）', () => {
  const entries = parseHardwareJson({
    cs: { Manufacturer: 'MSI', Model: 'B450', TotalPhysicalMemory: 34359738368 },
    os: { Caption: 'Microsoft Windows 11 专业版', Version: '10.0.26100', TotalVisibleMemorySize: 17825792 },
    cpu: { Name: 'AMD Ryzen 7 7800X3D', NumberOfCores: 8, NumberOfLogicalProcessors: 16, MaxClockSpeed: 4201 },
    gpus: [
      { Name: 'Todesk Virtual Display Adapter', AdapterRAM: 1073741824 },
      { Name: 'AMD Radeon RX 7800 XT', AdapterRAM: 4294967296 },
    ],
    disks: [{ DeviceID: 'C:', Size: 1024209543680, FreeSpace: 214748364800 }],
  });
  assert.ok(entries.length >= 5 && entries.length <= 6, `CPU+RAM+实体GPU+DISK+OS = 5 条，实际 ${entries.length}`);
  const gpu = entries.find((e) => e.name.startsWith('GPU:'));
  assert.ok(gpu, '实体 GPU 条目存在');
  assert.ok(gpu.name.includes('7800 XT'), '虚拟卡被排除后应只剩实体卡');
  assert.ok(!entries.some((e) => e.name.includes('Todesk')), '虚拟显卡不应产出条目');
  const cpu = entries.find((e) => e.name.startsWith('CPU:'));
  assert.ok(cpu.triggers.includes('cpu'));
  const ram = entries.find((e) => e.name.startsWith('RAM:'));
  assert.equal(ram.name, 'RAM: 32GB');
});

// ── T11 (v3) software 解析：注册表行解析 + 噪声过滤 ─────────────────────
test('software: parseInstalledSoftware 解析 TSV 行并过滤系统更新噪声', () => {
  const rows = parseInstalledSoftware(
    'Python 3.12\t3.12.4150.0\n7-Zip 24.08\t24.08\nKB5034441\t1.0\nUpdate for Microsoft Edge\t133\n\nX\t\nSomeApp\t2.0',
  );
  assert.equal(rows.length, 3, `噪声过滤后应 3 条，实际 ${rows.length}`);
  assert.deepEqual(rows.map((r) => r.name).sort(), ['7-Zip 24.08', 'Python 3.12', 'SomeApp']);
  assert.equal(rows.find((r) => r.name === '7-Zip 24.08').version, '24.08');
});

// ── T11b (v4.5.1) cp936 修复回归：CJK 2 字软件名不被误滤 + 乱码行如实保留 ──
test('software: parseInstalledSoftware 保留 CJK 2 字软件名、拉丁 2 字名仍过滤（cp936 修复回归）', () => {
  const rows = parseInstalledSoftware('微信\t6.9\n迅雷\t5.1.30\nAB\t1.0\nWPS Office\t12.1');
  const names = rows.map((r) => r.name);
  assert.ok(names.includes('微信'), `CJK 2 字名「微信」应保留，实际 ${JSON.stringify(names)}`);
  assert.ok(names.includes('迅雷'), `CJK 2 字名「迅雷」应保留`);
  assert.ok(!names.includes('AB'), '拉丁 2 字名 AB 仍应被过滤（登记价值低）');
  assert.ok(names.includes('WPS Office'));
});

// ── T12 (v3) 硬件/软件纳入检索与引导 ────────────────────────────────────
test('matcher+guidance: 硬件/软件条目可被检索，缺失时按类型引导（v3 验收）', () => {
  const entries = [
    {
      v: 1, name: 'GPU: AMD Radeon RX 7800 XT', type: 'hardware',
      description: '显卡 AMD Radeon RX 7800 XT。GPU 加速类任务先核支持矩阵。',
      triggers: ['gpu', '显卡', '转写', '加速'],
      invoke: { kind: 'manual', how: '物理事实条目' },
      manual: { aliases: [], notes: '', hidden: false, priority: 0 },
    },
    {
      v: 1, name: '软件: ffmpeg', type: 'software',
      description: '本机已安装开发工具 ffmpeg（版本 7.1）。', triggers: ['ffmpeg', '视频', '转码'],
      invoke: { kind: 'cli', how: '命令行调用 `ffmpeg`' },
      manual: { aliases: [], notes: '', hidden: false, priority: 0 },
    },
  ];
  const m1 = match('用显卡加速转写', entries);
  assert.equal(m1.kind, 'ok');
  assert.equal(m1.top.name, 'GPU: AMD Radeon RX 7800 XT');
  const m2 = match('视频转码用什么', entries);
  assert.equal(m2.kind, 'ok');
  assert.equal(m2.top.name, '软件: ffmpeg');
  // 缺失引导：硬件类措辞是「本机缺少该硬件能力」
  const g1 = guide({ missingName: 'RTX 5090', missingType: 'hardware' });
  assert.ok(g1.message.includes('本机缺少该硬件能力'));
  const g2 = guide({ query: '想用 docker 跑容器但找不到' });
  assert.equal(g2.missing.guessedType, 'software');
  const g3 = guide({ missingName: 'SomeApp', missingType: 'software' });
  assert.ok(g3.message.includes('本机未安装该软件'));
});

// ── T13 (v4) host 半：RPC 路由真实接线（stub ctx，验「register 被调用 + handler 返回真数据」）──
test('host: apply() 经 ctx.inject 软注入注册 /api/capability-aware/* 且 handler 可返回数据', async () => {
  const mod = await import(modUrl(path.join(root, 'lib', 'index.js')));
  assert.equal(typeof mod.apply, 'function');
  assert.ok(!('inject' in mod), '不得硬声明 inject（会让无 webServer 的 profile 整体 pending）');

  const registered = [];
  const effects = [];
  const injected = [];
  const scoped = {
    effect(fn, label) { effects.push(String(label || '')); return fn(); },
    webServer: { register(opts) { registered.push(opts); return () => {}; } },
  };
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn, label) { effects.push(String(label || '')); return fn(); },
    inject(deps, cb) { injected.push(deps.join(',')); cb(scoped); },
  };
  mod.apply(ctx, { scanOnBoot: false, watch: true, periodicMs: 0, scanDelayMs: 0 });

  assert.deepEqual(injected.sort(), ['tools', 'webServer'], '应以软注入方式请求 webServer 与 tools');
  const paths = registered.map((r) => r.path).sort();
  assert.deepEqual(
    paths,
    [
      '/api/capability-aware/doctor',
      '/api/capability-aware/guide',
      '/api/capability-aware/list',
      '/api/capability-aware/query',
      '/api/capability-aware/scan',
    ],
    `应注册 5 条路由，实际 ${JSON.stringify(paths)}`,
  );
  assert.ok(registered.every((r) => r.kind === 'exact'), '全部 kind=exact');
  assert.ok(effects.some((l) => l.includes('watchers')), 'watch=true 时应挂监听 effect');
  assert.ok(effects.some((l) => l.includes('route')), '注册必须包在 effect 里（否则热重载 duplicate route 崩树）');

  // 真调一次 /list 的 handler（mock req/res；req 必须真的 emit end，否则 readBody 永不 resolve）
  const listRoute = registered.find((r) => r.path.endsWith('/list'));
  const res = {
    code: null, body: null,
    writeHead(c) { this.code = c; },
    end(s) { this.body = s ? JSON.parse(s) : null; },
  };
  const mockReq = (url, payload) => {
    const h = {};
    const req = { url, on(ev, cb) { (h[ev] = h[ev] || []).push(cb); return req; }, destroy() {} };
    setImmediate(() => {
      if (payload !== undefined) (h.data || []).forEach((cb) => cb(JSON.stringify(payload)));
      (h.end || []).forEach((cb) => cb());
    });
    return req;
  };
  await listRoute.handler(mockReq('/api/capability-aware/list', {}), res);
  await new Promise((r) => setTimeout(r, 20)); // 等异步 handler 写完（handler 内部不 await 返回）
  assert.equal(res.code, 200, 'handler 应返回 200');
  assert.ok(Array.isArray(res.body.entries), 'handler 应返回 entries 数组');
  assert.ok(['ok', 'empty', 'missing'].includes(res.body.state));

  // 再验 /query 的 handler 真能走检索链路（空查询 → no_query）
  const qRoute = registered.find((r) => r.path.endsWith('/query'));
  const res2 = { code: null, body: null, writeHead(c) { this.code = c; }, end(s) { this.body = s ? JSON.parse(s) : null; } };
  await qRoute.handler(mockReq('/api/capability-aware/query', { query: '' }), res2);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(res2.code, 200);
  assert.ok(['no_query', 'empty_registry', 'no_match', 'ok', 'ambiguous'].includes(res2.body.kind), `query handler 应返回合法 kind，实际 ${res2.body.kind}`);
});

// ── T17 (v4.2) 吸收 skill-use-router：索引并入 + 目录扫描去重 + 权威归口 ──
test('skill-router: 索引被吸收、目录扫描去重、权威归口指向 skill-use-router', async () => {
  const { probeSkillRouter, probeSkills, scanAll } = await import(modUrl(path.join(root, 'lib', 'scanner.js')));
  const prevHome = process.env.DSH_CAP_DSH_HOME;
  const home = mkTmp();
  process.env.DSH_CAP_DSH_HOME = home;
  try {
    // 路由器索引：2 条（其一为子技能、其一已禁用）
    write(
      path.join(home, 'skills', 'skill-use-router', 'references', 'index.json'),
      JSON.stringify({
        generated: '2026-10-05T00:00:00Z',
        entries: [
          { name: 'accounting-audit-forge', rel: 'accounting-audit-forge', tier: 1, super: null, description: '会计审计超级技能：准则/账套/对账。', disabled: false, version: '1.0.0' },
          { name: 'cas-standards', rel: 'accounting-audit-forge/skills/cas-standards', tier: 1, super: 'accounting-audit-forge', description: '会计准则依据库——48 份准则全文。', disabled: false, version: '1.0.0' },
          { name: 'old-skill', rel: 'old-skill', tier: 2, super: null, description: '已停用技能。', disabled: true, version: '0.9.0' },
        ],
      }),
    );
    // 另有一个不在索引里的新技能目录（验证「索引滞后时目录扫描兜底」）
    write(path.join(home, 'skills', 'brand-new', 'SKILL.md'), '---\nname: brand-new\ndescription: 新装技能，尚未重建索引。\n---\n');

    const router = probeSkillRouter();
    assert.equal(router.length, 3, `索引应吸收 3 条，实际 ${router.length}`);
    const sub = router.find((e) => e.name === 'cas-standards');
    assert.ok(sub.description.startsWith('[accounting-audit-forge 子技能]'), '子技能应带父技能前缀');
    // v5 Bug2：disabled（disable-model-invocation 权限标志）与 negative（已归档/勿用）
    // 是**两档语义**，必须分开——旧实现把两者合并，致「只允许用户点名的敏感技能」不可见
    //（真实事故：wechat-send-file 精确点名也查不到）。
    const oldSkill = router.find((e) => e.name === 'old-skill');
    assert.equal(oldSkill.disabled, true, '索引 disabled 条目应标 disabled（权限标志）');
    assert.equal(oldSkill.negative, false, 'disabled ≠ negative：不得混为一谈');

    // 去重：已索引的技能名不再由目录扫描产出；未索引的新技能仍被发现
    const dirSkills = probeSkills({ skip: new Set(router.map((e) => e.name)) });
    assert.ok(!dirSkills.some((e) => e.name === 'accounting-audit-forge'), '已索引技能不应重复');
    assert.ok(dirSkills.some((e) => e.name === 'brand-new'), '未索引的新技能应由目录扫描兜底');

    // 权威归口 + 边界：scanAll 后 skill 条目应带 authority(→skill-use-router) 与 bounds
    const all = scanAll({ probes: ['skills'] });
    const s = all.entries.find((e) => e.name === 'cas-standards');
    assert.equal(s.authority.system, 'skill-use-router');
    assert.equal(s.invoke.kind, 'delegate');
    assert.ok(String(s.invoke.how).includes('skill_index.py'));
    assert.ok(s.bounds && String(s.bounds.limits).includes('skill-use-router'), 'bounds.limits 应点明权威归属');
    // 本机环境类不设权威（本插件即权威）
    const hw = scanAll({ probes: ['knowledge'] }).entries.length; // 省钱探针：只验 routerEntries 始终并入
    assert.ok(hw >= 3, 'routerEntries 应始终并入');
  } finally {
    process.env.DSH_CAP_DSH_HOME = prevHome;
  }
});

// ── T16 (v4) Agent 工具面：capability_query 逻辑 + 注册接线 ─────────────
test('tool: capability_query 能返回匹配能力与调用方式；无命中给缺失引导（agent 入口）', async () => {
  const { buildCapabilityTool, TOOL_NAME, TOOL_DESCRIPTION, TOOL_PARAMETERS } =
    await import(modUrl(path.join(root, 'lib', 'tool.js')));
  assert.equal(TOOL_NAME, 'capability_query');
  assert.ok(TOOL_DESCRIPTION.includes('当你不确定'), 'description 必须双说「做什么 + 何时用」');
  assert.equal(TOOL_PARAMETERS.query.required, true, 'query 为必填参数');
  // 锁死 DSH 语法坑：可选参数不得写 required:false（写了 defineTool 抛 JsonSchemaError，
  // 工具会静默注册失败——本机用真实 @deepseek-ai/dsh-tools 集成校验时实测）
  assert.equal(TOOL_PARAMETERS.topK.required, undefined, '可选参数不得出现 required 键');

  // 造 fixture 清单
  const home = mkTmp();
  const file = path.join(home, 'data', 'capability-aware', 'capabilities.json');
  applyScan(file, {
    scannedAt: new Date().toISOString(), probeErrors: [], dshHome: home,
    entries: [
      {
        name: 'bili-subtitle', type: 'skill', description: '抓取 B站 视频字幕', triggers: ['字幕', 'b站'],
        source: 'skills:bili-subtitle', fingerprint: 'f1',
        invoke: { kind: 'auto-route', how: 'skill-use-router query "bili-subtitle"' },
      },
      {
        name: 'GPU: RX 7800 XT', type: 'hardware', description: '显卡 AMD Radeon RX 7800 XT',
        triggers: ['gpu', '显卡', '加速'], source: 'hardware:wmi', fingerprint: 'd',
      },
    ],
  });

  const tool = buildCapabilityTool({ file });
  const hit = await tool.execute({ query: '抓B站视频字幕' });
  assert.ok(hit.includes('bili-subtitle'), `应命中技能，实际：${hit}`);
  assert.ok(hit.includes('skill-use-router'), '应给出调用方式');
  // v4.4：返回体改为与 CLI `cap.mjs brief` 同款一行式（共享 lib/brief.js）
  assert.ok(hit.includes('｜ 调: '), '一行式应含「调」段');
  assert.ok(hit.includes('｜ 主: '), '一行式应含「谁主导」段（原则③）');
  assert.ok(hit.includes('｜ 边界: '), '一行式应含「边界」段（原则①）');

  // v4.4：某域权威不可达时应带兜底提示（原则④）——fixture 下探测结果依本机而定，故只验格式而非必然出现
  const b = await import(modUrl(path.join(root, 'lib', 'brief.js')));
  assert.equal(b.roleOf({ strength: 'primary', system: 'X' }), '我主上（X）');
  assert.equal(b.roleOf({ strength: 'assist', system: 'Y' }), '它主上·我辅助（Y）');
  assert.ok(b.fallbackNote({ degraded: ['knowledge'] }).includes('索引底稿'));
  assert.equal(b.fallbackNote({ degraded: [] }), '');

  const miss = await tool.execute({ query: '量子纠错编译器调优' });
  assert.ok(miss.includes('未匹配到能力'), `无命中应给缺失引导，实际：${miss}`);
  assert.ok(miss.includes('补足建议'), '缺失应带补足动作');

  // 清单未就绪 → 引导 scan（而非抛错）
  const t2 = buildCapabilityTool({ file: path.join(home, 'nope.json') });
  const empty = await t2.execute({ query: 'x' });
  assert.ok(empty.includes('未就绪') || empty.includes('scan'), `坏清单应引导 scan，实际：${empty}`);
});

test('host: apply() 同时软注入 tools 与 webServer（agent 入口 + RPC 入口）', async () => {
  const mod = await import(modUrl(path.join(root, 'lib', 'index.js')));
  const injected = [];
  const effects = [];
  const scoped = {
    effect(fn, label) { effects.push(String(label || '')); return fn(); },
    webServer: { register() { return () => {}; } },
    tools: { register() { return () => {}; } },
  };
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn, label) { effects.push(String(label || '')); return fn(); },
    inject(deps, cb) { injected.push(deps.join(',')); cb(scoped); },
  };
  mod.apply(ctx, { scanOnBoot: false, watch: false, periodicMs: 0 });
  assert.deepEqual(injected.sort(), ['tools', 'webServer'], `应软注入 tools 与 webServer，实际 ${injected}`);
  // 注：本仓库环境无 @deepseek-ai/dsh-tools，动态 import 会走 .catch 降级——
  // 这正是设计意图（宿主包不可用时工具面降级，CLI/RPC 不受影响），故此处不断言工具注册成功。
});

// ── T15 (v4) 轻量扫描必须保留 hardware/software（真实回归：total 125 → 10）──
test('registry: preserveTypes 让部分探针扫描保留未覆盖类型条目', () => {
  const home = mkTmp();
  const file = path.join(home, 'data', 'capability-aware', 'capabilities.json');
  // 第一轮：全量（含 hardware/software 类型）
  const full = {
    scannedAt: new Date().toISOString(), probeErrors: [], dshHome: home,
    entries: [
      { name: 'alpha', type: 'skill', description: '技能', source: 'skills:alpha', fingerprint: 'f1' },
      { name: 'GPU: X', type: 'hardware', description: '显卡', source: 'hardware:wmi', fingerprint: 'd:wmi' },
      { name: '软件: ffmpeg', type: 'software', description: 'ffmpeg', source: 'software:devtool:ffmpeg', fingerprint: 'v1' },
    ],
  };
  applyScan(file, full);
  let reg = load(file);
  assert.equal(reg.entries.length, 3);

  // 第二轮：轻扫（只含 skill，但声明保留 hardware/software）
  const light = {
    scannedAt: new Date().toISOString(), probeErrors: [], dshHome: home,
    entries: [
      { name: 'alpha', type: 'skill', description: '技能', source: 'skills:alpha', fingerprint: 'f1' },
      { name: 'beta', type: 'skill', description: '新技能', source: 'skills:beta', fingerprint: 'f2' },
    ],
  };
  applyScan(file, light, { preserveTypes: ['hardware', 'software'], reason: 'skill 变更' });
  reg = load(file);
  assert.equal(reg.entries.length, 4, `轻扫应保留 hardware/software，实际 ${reg.entries.length} 条`);
  const byType = Object.fromEntries(reg.meta.counts ? Object.entries(reg.meta.counts) : []);
  assert.equal(reg.meta.counts.hardware, 1, 'hardware 条目必须保留');
  assert.equal(reg.meta.counts.software, 1, 'software 条目必须保留');
  assert.equal(reg.meta.counts.skill, 2, 'skill 应更新为新值');
  assert.equal(reg.meta.lastScanReason, 'skill 变更', 'meta 应记录扫描触发源');

  // 第三轮：不带 preserveTypes 的轻扫 → hardware/software 被清（证明该选项确实在起作用）
  applyScan(file, light, { reason: 'no-preserve' });
  reg = load(file);
  assert.equal(reg.entries.length, 2, '不声明 preserveTypes 时应按本次产出重建');
});

// ── T14 (v4) host 半：watch=false 不挂监听；disabled 字段不被 schema 丢弃 ──
test('host: watch=false 无监听 effect；schema 保留 mcp disabled 字段', async () => {
  const mod = await import(modUrl(path.join(root, 'lib', 'index.js')));
  const { normalizeEntry } = await import(modUrl(path.join(root, 'lib', 'schema.js')));
  const effects = [];
  const scoped = { effect(fn, label) { effects.push(String(label || '')); return fn(); }, webServer: { register() { return () => {}; } } };
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(fn, label) { effects.push(String(label || '')); return fn(); },
    inject(deps, cb) { cb(scoped); },
  };
  mod.apply(ctx, { scanOnBoot: false, watch: false, periodicMs: 0 });
  assert.ok(!effects.some((l) => l.includes('watchers')), 'watch=false 不应挂监听');

  const r = normalizeEntry({ name: 'X conn', type: 'mcp', description: 'd', disabled: true });
  assert.equal(r.ok, true);
  assert.equal(r.entry.disabled, true, 'disabled 必须被 schema 保留（v3 曾静默丢弃）');
  const r2 = normalizeEntry({ name: 'Y conn', type: 'mcp', description: 'd' });
  assert.equal(r2.entry.disabled, false);
});
test('host: apply() cfg whitelist must pass through provision keys (v4.5 regression: missing keys made AGENTS pointer dead code)', async () => {
  const idx = await fs.promises.readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.ok(idx.includes('provisionSkill: config?.provisionSkill !== false'));
  assert.ok(idx.includes('provisionAgentsPointer: config?.provisionAgentsPointer === true'));
  assert.ok(idx.includes('cfg.provisionAgentsPointer === true'));
  assert.ok(idx.includes('cfg.provisionSkill !== false'));
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cap-agents-'));
  try {
    const home = path.join(tmp, 'dsh');
    const r1 = provisionAgentsPointer({ version: '9.9.9', pluginDir: 'D:/pd', dshHome: home });
    assert.equal(r1.action, 'created');
    const t1 = await fs.promises.readFile(path.join(home, 'AGENTS.md'), 'utf8');
    assert.ok(t1.includes('managed:begin') && t1.includes('managed:end') && t1.includes('cap.mjs'));
    const r2 = provisionAgentsPointer({ version: '9.9.9', pluginDir: 'D:/pd', dshHome: home });
    assert.equal(r2.action, 'unchanged');
    await fs.promises.writeFile(path.join(home, 'AGENTS.md'), ['USER', 'CONTENT'].join(' '), 'utf8');
    provisionAgentsPointer({ version: '9.9.9', pluginDir: 'D:/pd', dshHome: home });
    const t3 = await fs.promises.readFile(path.join(home, 'AGENTS.md'), 'utf8');
    assert.ok(t3.startsWith('USER CONTENT'));
  } finally { await fs.promises.rm(tmp, { recursive: true, force: true }); }
});

// ════════════════════════════════════════════════════════════════════════
// v5 修复回归（六个缺陷，全部源自真实调用取证 —— 见 docs/research-2026-10-05.md）
// ════════════════════════════════════════════════════════════════════════

// ── T15 (v5 Bug1) 人工数据（别名/备注/隐藏/优先级）必须跨扫描存活 ──────
test('v5 Bug1: mergeManual 逐字段「非空者胜」——扫描不得抹掉人工别名', async () => {
  const { mergeManual } = await import(modUrl(path.join(root, 'lib', 'registry.js')));
  // 扫描侧全是空默认值 → 必须整体保留上一版人工值
  const p = { aliases: ['A股', '沪深'], notes: '人工备注', hidden: true, priority: 5 };
  const empty = { aliases: [], notes: '', hidden: false, priority: 0 };
  const m = mergeManual(p, empty);
  assert.deepEqual(m.aliases, ['A股', '沪深'], '别名必须存活（旧实现被空默认值覆盖 → 全清单人工数据=0）');
  assert.equal(m.notes, '人工备注');
  assert.equal(m.hidden, true);
  assert.equal(m.priority, 5);
  // 扫描侧有值时只覆盖对应字段
  const m2 = mergeManual(p, { aliases: ['新别名'], notes: '', hidden: false, priority: 0 });
  assert.deepEqual(m2.aliases, ['新别名'], '扫描给出别名时应采用');
  assert.equal(m2.notes, '人工备注', '未给出的字段仍保留人工值');
  assert.equal(m2.hidden, true);
  // undefined 入参容错
  assert.deepEqual(mergeManual(undefined, undefined).aliases, []);
  assert.deepEqual(mergeManual(p, undefined).aliases, ['A股', '沪深']);
});

// ── T16 (v5 Bug1 端到端) applyScan 后别名仍在，且别名让条目排名跃升 ─────
test('v5 Bug1 端到端: 灌别名 → scan → 别名存活且检索排名提升', async () => {
  const { applyScan, load: loadReg } = await import(modUrl(path.join(root, 'lib', 'registry.js')));
  const tmp = mkTmp();
  const file = path.join(tmp, 'capabilities.json');
  const base = {
    v: 2, state: 'ok',
    entries: [
      { v: 1, name: 'AKShare', type: 'mcp', description: '股票 / 基金 / 期货 / 债券 / 宏观公开数据', triggers: ['akshare', '股票'], invoke: { kind: 'delegate', how: 'mcp__akshare__get_hist_data' }, manual: { aliases: ['A股', '沪深行情'], notes: '', hidden: false, priority: 0 } },
      { v: 1, name: 'android-data', type: 'skill', description: '安卓数据抓取', triggers: ['android-data'], invoke: { kind: 'cli', how: 'x' }, manual: { aliases: [], notes: '', hidden: false, priority: 0 } },
    ],
    meta: {},
  };
  fs.writeFileSync(file, JSON.stringify(base, null, 2), 'utf8');
  // 模拟一次扫描：产出条目**不带**人工数据（normalizeEntry 会填空默认值）
  const scan = { entries: base.entries.map((e) => ({ ...e, manual: undefined })), errors: [] };
  applyScan(file, scan, { reason: 'test' });
  const after = loadReg(file);
  const ak = after.entries.find((e) => e.name === 'AKShare');
  // v5 数据层起：落盘别名 = 用户人工值 ∪ 预置值，故断言「存活」而非全等。
  // 核心是 Bug1 的回归：这两个用户别名**必须还在**（旧实现被 normalizeEntry 空默认值抹成 []）。
  assert.ok(ak.manual.aliases.includes('A股'), '扫描后用户别名必须存活（Bug1 修复核心断言）');
  assert.ok(ak.manual.aliases.includes('沪深行情'), '扫描后用户别名必须存活（Bug1 修复核心断言）');
  assert.ok(ak.manual.aliases.length >= 2, '不得被扫描结果清空');
  // 别名参与检索：查「A股」应命中 AKShare
  const m = match('查A股历史行情', after.entries);
  assert.ok(m.candidates.some((c) => c.name === 'AKShare'), '别名「A股」应使 AKShare 可被检索到');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── T17 (v5 Bug2) disabled ≠ negative：权限标志可检索、点名可用 ────────
test('v5 Bug2: disabled（权限标志）不被当负面降权，点名仍可见并带告警', async () => {
  const entries = [
    {
      v: 1, name: 'wechat-send-file', type: 'skill',
      description: '把文件发送到微信。当用户说「发我微信」时使用。',
      triggers: ['wechat-send-file'], invoke: { kind: 'cli', how: 'wx send' },
      disabled: true, negative: false, manual: { aliases: [], notes: '', hidden: false, priority: 0 },
    },
    {
      v: 1, name: 'archived-skill', type: 'skill', description: '【已归档·勿用】旧技能',
      triggers: ['archived-skill'], invoke: { kind: 'cli', how: 'x' },
      disabled: false, negative: true, manual: { aliases: [], notes: '', hidden: false, priority: 0 },
    },
  ];
  // 精确点名受限技能 → 必须可见（旧实现：negative 强降权致 no_match，真实事故）
  const m = match('wechat-send-file', entries);
  assert.equal(m.kind, 'ok', '点名受限技能应返回候选，不得 no_match');
  assert.equal(m.top.name, 'wechat-send-file');
  assert.ok(m.warnings.some((w) => w.includes('受限能力')), '受限能力须带「需用户点名」告警');
  assert.ok(!m.warnings.some((w) => w.includes('已归档')), 'disabled 不得报「已归档」');
  // 已归档条目仍强降权
  const m2 = match('archived-skill', entries);
  if (m2.kind !== 'no_match') {
    assert.ok(m2.candidates.every((c) => c.negative), '仅剩 negative 候选时不应有非负面条目');
  }
});

// ── T18 (v5 Bug3) 命中质量判据：真答案 strong=true，噪声/缺失 strong=false ──
test('v5 Bug3: queryStrength 区分真命中与噪声榜首', async () => {
  const { queryStrength, tokens } = await import(modUrl(path.join(root, 'lib', 'matcher.js')));
  const mk = (o) => ({ v: 1, manual: { aliases: [], notes: '', hidden: false, priority: 0 }, ...o });
  // 真命中：ffmpeg 触发词含「转码」全等
  const ff = mk({ name: '软件: ffmpeg', type: 'software', description: '视频转码工具', triggers: ['ffmpeg', '转码'] });
  const q1 = tokens('视频转码');
  const s1 = queryStrength(ff, q1, null);
  assert.equal(s1.strong, true, 'ffmpeg 视频转码应判为强命中');
  assert.equal(s1.exact, true);
  // 噪声榜首：名字里含「微信」但查询讲的是「发文件」
  const wx = mk({ name: '软件: 微信', type: 'software', description: '已安装微信', triggers: ['微信'] });
  const q2 = tokens('发送文件到微信 IM 微信渠道 dsh-im 附件');
  const s2 = queryStrength(wx, q2, null);
  assert.equal(s2.strong, false, '「软件:微信」对发文件查询应判为弱命中（cov 极低）');
  // 别名命中是最强证据
  const ak = mk({ name: 'AKShare', type: 'mcp', description: '公开数据', triggers: ['akshare'], manual: { aliases: ['A股'], notes: '', hidden: false, priority: 0 } });
  const q3 = tokens('查A股行情');
  assert.equal(queryStrength(ak, q3, null).aliasHit, true, '人工别名整词覆盖应被识别');
  assert.equal(queryStrength(ak, q3, null).strong, true);
});

// ── T19 (v5 Bug4) tool 路径必须与 CLI 路径同分（旧实现漏传 idf） ───────
test('v5 Bug4: capability_query 与 CLI 走同一打分（idf 已接通，不得退化为常数权重）', async () => {
  const { buildCapabilityTool } = await import(modUrl(path.join(root, 'lib', 'tool.js')));
  const { match: m2, idfFor: idf2 } = await import(modUrl(path.join(root, 'lib', 'matcher.js')));
  const reg = load(path.join(process.env.DSH_CAP_DSH_HOME, 'data', 'capability-aware', 'capabilities.json'));
  if (reg.state !== 'ok') return; // 无真实清单时跳过（隔离 fixture 下常见）
  const q = '查A股历史行情数据';
  const viaMatch = m2(q, reg.entries, { topK: 5, idf: idf2(reg.entries) });
  const viaTool = m2(q, reg.entries, { topK: 5 }); // 不传 idf —— 应自愈为同一结果
  assert.deepEqual(
    viaTool.candidates.map((c) => c.name),
    viaMatch.candidates.map((c) => c.name),
    '缺省 idf 时 match() 必须自愈（Bug4：旧 tool.js 漏传导致全候选并列）',
  );
  // 且候选分数不应全部相等（退化特征）
  const scores = new Set(viaTool.candidates.map((c) => c.score));
  if (viaTool.candidates.length > 1) {
    assert.ok(scores.size > 1, `退化检测：候选分数不应全等（实测 ${[...scores].join(',')}）`);
  }
  // 源码层断言：tool.js 必须显式传 idf
  const src = await fs.promises.readFile(path.join(root, 'lib', 'tool.js'), 'utf8');
  assert.ok(src.includes('idf: idfFor(reg.entries)'), 'tool.js 必须显式传 idf（双保险）');
  const tool = buildCapabilityTool({});
  assert.equal(typeof tool.execute, 'function');
});

// ── T20 (v5 缺陷A) 同名条目按 source 区分，diff 不失真 ─────────────────
test('v5 缺陷A: 同名条目靠 source 区分（entryKey），diff 不互相覆盖', async () => {
  const { entryKey, diff } = await import(modUrl(path.join(root, 'lib', 'registry.js')));
  const a = { type: 'skill', name: 'bili-daily', source: 'skill-router:bili-daily' };
  const b = { type: 'skill', name: 'bili-daily', source: 'skill-router:web-intel/skills/bili-daily' };
  assert.notEqual(entryKey(a), entryKey(b), '同名不同 source 必须是不同键（旧实现 (type,name) 键会互相覆盖）');
  assert.equal(entryKey({ type: 'skill', name: 'x' }), 'skill:x', '无 source 时退回 type:name');
  // diff：两条同名条目都在 prev 里，删除其一应被检出
  const d = diff([a, b], [a]);
  assert.equal(d.removed.length, 1, '删除一条同名条目应被检出（旧实现两条互相覆盖 → diff 失真）');
});

// ── T21 (v5 缺陷B) 路由器覆盖词不得压过专精子技能 ──────────────────────
test('v5 缺陷B: 父路由器与子技能同现时父让位（覆盖词不再压过专精技能）', async () => {
  const entries = [
    {
      v: 1, name: 'visual-studio', type: 'skill', super: undefined,
      description: '视觉后处理与图表超级技能（4 个子技能路由器）',
      triggers: ['visual-studio', '字幕', '处理视频', '压缩图片'], invoke: { kind: 'cli', how: 'x' },
      manual: { aliases: [], notes: '', hidden: false, priority: 0 },
    },
    {
      v: 1, name: 'web-intel', type: 'skill', super: undefined,
      description: '网络情报：抓取 B站视频字幕、字幕轨解析',
      triggers: ['web-intel', '字幕', 'b站'], invoke: { kind: 'cli', how: 'y' },
      manual: { aliases: [], notes: '', hidden: false, priority: 0 },
    },
  ];
  // 给 visual-studio 造一个子技能，使父子竞争让位规则生效
  entries.push({
    v: 1, name: 'video', type: 'skill', super: 'visual-studio',
    description: '视频压缩转格式字幕处理', triggers: ['video', '字幕'], invoke: { kind: 'cli', how: 'z' },
    manual: { aliases: [], notes: '', hidden: false, priority: 0 },
  });
  const m = match('抓B站视频字幕', entries);
  const vs = m.candidates.find((c) => c.name === 'visual-studio');
  const vi = m.candidates.find((c) => c.name === 'web-intel');
  assert.ok(vs && vi, '两个候选都应出现');
  assert.ok(vi.score > vs.score, `专精技能应排在路由器之前（web-intel ${vi.score} > visual-studio ${vs.score}）`);
});

// ── T23 (v5 数据层) 预置别名随插件分发：装上即生效、跨扫描存活、用户别名不被覆盖 ──
test('v5 数据层: 预置别名（seed）注入并跨扫描存活，且不覆盖用户自己的别名', async () => {
  const { applySeedAliases, SEED_ALIASES } = await import(modUrl(path.join(root, 'lib', 'seed.js')));
  assert.ok(SEED_ALIASES.length >= 3, '至少覆盖 A股/微信发文件/文生图 三个已取证缺口');
  // 纯函数：并集、不改原数组
  const src = [{ name: 'AKShare', type: 'mcp', description: 'd', manual: { aliases: ['用户自定义别名'], notes: '', hidden: false, priority: 0 } }];
  const { entries, applied } = applySeedAliases(src);
  assert.equal(src[0].manual.aliases.length, 1, '不得修改原数组（纯函数）');
  assert.ok(entries[0].manual.aliases.includes('用户自定义别名'), '用户别名必须保留');
  assert.ok(entries[0].manual.aliases.includes('A股'), '预置别名必须注入');
  assert.ok(applied.some((a) => a.name === 'AKShare' && a.added > 0));
  // 幂等：再跑一次不应重复添加
  const twice = applySeedAliases(entries);
  assert.equal(twice.entries[0].manual.aliases.length, entries[0].manual.aliases.length, '重复注入必须幂等');
  assert.equal(twice.applied.length, 0, '无新增时 applied 应为空');
  // 端到端：applyScan 之后预置别名仍在，且能检索到
  const { applyScan: as, load: ld } = await import(modUrl(path.join(root, 'lib', 'registry.js')));
  const tmp = mkTmp();
  const file = path.join(tmp, 'capabilities.json');
  const scan = {
    entries: [{ name: 'AKShare', type: 'mcp', description: '股票 / 基金 / 宏观公开数据', triggers: ['akshare'], invoke: { kind: 'cli', how: 'x' } }],
    errors: [],
  };
  as(file, scan, { reason: 'test' });
  const reg = ld(file);
  const ak = reg.entries.find((e) => e.name === 'AKShare');
  assert.ok(ak.manual.aliases.includes('A股'), '预置别名必须经 applyScan 落盘（新装机器首次扫描即生效）');
  const m = match('查A股历史行情数据', reg.entries);
  assert.equal(m.top.name, 'AKShare', `别名应使 AKShare 居首（实测 ${m.top?.name}）`);
  fs.rmSync(tmp, { recursive: true, force: true });
});
test('v5 Bug3: 弱命中时保留候选并附缺失提示（附加式，不误判真有能力的查询）', async () => {
  const { buildCapabilityTool } = await import(modUrl(path.join(root, 'lib', 'tool.js')));
  const tool = buildCapabilityTool({});
  // 用一个几乎不可能命中的查询：候选取自真实清单时 anyStrong 应为 false 且带提示
  const reg = load(path.join(process.env.DSH_CAP_DSH_HOME, 'data', 'capability-aware', 'capabilities.json'));
  if (reg.state !== 'ok') return;
  const out = await tool.execute({ query: '量子纠错拓扑码编译器的表面码解码器调优' });
  // 不抛错即可，且若给出提示必须仍保留「匹配到/命中」候选行
  assert.equal(typeof out, 'string');
  if (out.includes('命中质量均偏低')) {
    assert.ok(/匹配到|命中 \d+ 个接近候选/.test(out), '附加提示不得取代候选列表');
  }
});
