/**
 * system-prompt/assemble 全链路 smoke：用假 ctx / 假 agent 跑真实 apply()。
 *
 * 覆盖：
 *   1. Bard 活跃：原生段按规则裁剪、contexts 被清空、bard:* 全部出现、无重复文本、按 order 排序
 *   2. complete === true：只留骨架
 *   3. keepSections / toolAllowlist 白名单：显式段保留、未列出的段丢弃（旧 bug 正是白名单永久失效）
 *   4. 非 Bard 预设：原样放行，一个段都不动
 *   5. captureCatalogs：覆盖前采集，含原生段名，且只采一次
 *   6. {{bard_tools}} provider 在预设活跃时返回非空文本
 *   7. BardSession.getBook：mtime 缓存命中 / 文件变更后失效
 *   8. 不再注册任何 systemPrompt.section（渲染只走 assemble）
 *   9. per-agent 已知工具名：A 的 unknown 名单不污染 B
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bard-assemble-'))
process.env.DSH_HOME = home

const { apply } = await import('../lib/index.js')
const store = await import('../lib/store.js')

const results = []
const assert = (cond, msg) => {
  results.push({ ok: Boolean(cond), msg })
  console.log(`${cond ? 'ok  ' : 'FAIL'}: ${msg}`)
}

// ---------------------------------------------------------------- fixtures
const card = {
  id: 'card1',
  name: '青灯',
  description: '守夜人，记得每一场雨。',
  personality: '寡言，克制，偶尔刻薄。',
  scenario: '旧城的深夜。',
  tags: ['日常'],
  mesExample: ['<START>\n{{char}}: 灯还亮着。'],
  systemPrompt: 'CARD_SYSTEM_PROMPT',
  postHistoryInstructions: 'CARD_PHI',
  depthPrompt: 'CARD_DEPTH',
  importedAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
}
store.putCard(card)

const worldbook = {
  id: 'wb1',
  name: '旧城',
  entries: [{
    id: 'e1', comment: '旧城', content: '旧城常年下雨，路灯是煤油的。',
    keys: ['旧城', '雨'], secondaryKeys: [], enabled: true, constant: false,
    selective: false, order: 1, position: 'before', depth: 4, probability: 100, priority: 100,
  }],
  importedAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
}
store.putWorldBook(worldbook)

function putTestPreset(id, options) {
  store.putPreset({
    id, name: `测试 ${id}`, cardId: 'card1', worldbookIds: ['wb1'], skillNames: [],
    options: { toolsMode: 'all', ...options },
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  })
}
putTestPreset('p1', {})
putTestPreset('pcomplete', { complete: true })
putTestPreset('pkeep', { keepSections: ['guidance:writing'], toolsMode: 'allowlist', toolAllowlist: ['read'] })
putTestPreset('piso-a', { toolsMode: 'allowlist', toolAllowlist: ['read', 'alice'] })
putTestPreset('piso-b', { toolsMode: 'allowlist', toolAllowlist: ['read', 'bob'] })

// ---------------------------------------------------------------- fake ctx
const NOOP_DISPOSE = () => {}

let composedId = 'bard-p1'
const presetService = { composedPreset: () => composedId, resolve: async () => ({ id: composedId }) }

const globalServices = new Map()
const handlersAll = new Map()

// 只 apply 一次：assemble / agent/created / session/event 必须取自同一个 runtime，
// 否则两套 runtime 的 runtime.recent 互不相通，世界书永远匹配不到 transcript。
const fakeGlobalCtx = {
  on: (name, fn) => { const list = handlersAll.get(name) || []; list.push(fn); handlersAll.set(name, list); return NOOP_DISPOSE },
  get: (name) => globalServices.get(name),
  inject: (deps, cb) => { if (deps.every((d) => globalServices.has(d))) cb({ get: (n) => globalServices.get(n) }) },
  effect: (fn) => { const out = fn(); return typeof out === 'function' ? out : NOOP_DISPOSE },
  webServer: { register: () => NOOP_DISPOSE },
}

apply(fakeGlobalCtx)
const assembleHandlers = handlersAll.get('system-prompt/assemble') || []
assert(assembleHandlers.length === 1, 'apply() 注册了恰好一个 system-prompt/assemble 拦截器')

// ---------------------------------------------------------------- fake agent
function makeAgentCtx(services) {
  return {
    on: () => NOOP_DISPOSE,
    get: (name) => services.get(name),
    inject: (deps, cb) => { if (deps.every((d) => services.has(d))) cb({ get: (n) => services.get(n) }) },
    effect: (fn) => { const out = fn(); return typeof out === 'function' ? out : NOOP_DISPOSE },
  }
}

function makeAgent(id) {
  const vars = new Map()
  const restrictCalls = []
  const sectionRegistrations = []
  const systemPrompt = {
    variable: (name, fn) => { vars.set(name, fn); return NOOP_DISPOSE },
    section: (name) => { sectionRegistrations.push(name); return NOOP_DISPOSE },
  }
  const tools = {
    schemas: () => [{ name: 'read' }, { name: 'write' }, { name: 'remember' }, { name: 'hold_on' }],
    restrict: (spec) => { restrictCalls.push(spec); return NOOP_DISPOSE },
    register: () => NOOP_DISPOSE,
  }
  const services = new Map([
    ['systemPrompt', systemPrompt], ['tools', tools], ['agentPresets', presetService],
  ])
  const session = { id: `sess-${id}`, header: { cwd: process.cwd() }, agentPreset: '' }
  const agent = { id, ctx: makeAgentCtx(services), session }
  session.agent = agent
  return { agent, vars, restrictCalls, sectionRegistrations, tools }
}

const creationHandlers = handlersAll.get('agent/created') || []

function createAgent(id) {
  const made = makeAgent(id)
  for (const fn of creationHandlers) fn({ agent: made.agent })
  return made
}

// ---------------------------------------------------------------- assembly fixture
function nativeAssembly() {
  return {
    contexts: [{ text: 'runtime context text' }],
    tools: [{ name: 'read' }, { name: 'write' }],
    sections: [
      { name: 'deployment:persona-prefix', order: 10, text: 'NATIVE_PREFIX' },
      { name: 'deployment:persona-suffix', order: 900, text: 'NATIVE_SUFFIX' },
      { name: 'env-block', order: 20, text: 'Tokens prefixed with @ are file references' },
      { name: 'tool:read', order: 500, text: 'read tool doc' },
      { name: 'harness:loop', order: 600, text: 'harness loop doc' },
      { name: 'guidance:writing', order: 700, text: 'NATIVE_GUIDANCE' },
    ],
  }
}

function runAssemble(agent, assembly) {
  let called = 0
  const next = () => { called++ }
  assembleHandlers[0](assembly, { agent }, next)
  return called
}

function feedUserText(dshSession, text) {
  for (const fn of handlersAll.get('session/event') || []) {
    fn(dshSession, { type: 'user/message', data: { content: [{ type: 'text', text }] } })
  }
}

// ---------------------------------------------------------------- 1. Bard 活跃
{
  composedId = 'bard-p1'
  const { agent, vars, sectionRegistrations } = createAgent('a1')
  assert(sectionRegistrations.length === 0, 'agent/created 不再注册任何 systemPrompt.section（17 块改由 assemble 渲染）')

  // 喂一条用户消息，让世界书关键词能命中 runtime.recent 的 transcript
  feedUserText(agent.session, '旧城今晚下雨了。')

  const assembly = nativeAssembly()
  assert(runAssemble(agent, assembly) === 1, 'Bard 活跃时仍调用 next()')

  const names = assembly.sections.map((s) => s.name)
  assert(Array.isArray(assembly.contexts) && assembly.contexts.length === 0, 'assembly.contexts 被清空（斩断 runtime-context 注入）')
  assert(names.includes('deployment:persona-prefix'), '骨架段 deployment:persona-prefix 保留')
  assert(names.includes('deployment:persona-suffix'), '骨架段 deployment:persona-suffix 保留')
  assert(names.includes('tool:read'), '默认模式保留 tool:* 段')
  assert(names.includes('harness:loop'), '默认模式保留 harness:* 段')
  assert(!names.includes('guidance:writing'), '默认模式丢弃 guidance:* 原生段')
  assert(!names.includes('env-block'), '含 "Tokens prefixed with @" 的环境段被物理删除')
  const bardNames = names.filter((n) => n.startsWith('bard:'))
  assert(bardNames.length >= 5, `17 块里的启用块被渲染（实得 ${bardNames.length} 段）`)
  assert(names.includes('bard:world-book'), '世界书渲染为 bard:world-book 段')

  const texts = assembly.sections.map((s) => s.text)
  assert(new Set(texts).size === texts.length, 'sections 里没有重复文本（同一段不会出现两次）')
  const orders = assembly.sections.map((s) => s.order)
  const sorted = orders.slice().sort((a, b) => a - b)
  assert(orders.every((v, i) => typeof v === 'number' && v === sorted[i]), 'sections 按 order 升序排列')

  // {{bard_tools}} provider
  const toolVar = vars.get('bard_tools')
  assert(typeof toolVar === 'function', '注册了 {{bard_tools}} 变量 provider')
  const toolText = toolVar({ scope: agent })
  assert(typeof toolText === 'string' && toolText.length > 0, `{{bard_tools}} 在预设活跃时返回非空文本（${toolText.length} 字）`)
  assert(toolText.includes('read') && toolText.includes('remember'), '{{bard_tools}} 里既有全局工具也有 Bard 记忆工具')

  // section-catalog
  const catalogNames = (store.readSectionCatalog() || []).map((item) => item.name)
  assert(catalogNames.includes('deployment:persona-prefix'), 'section-catalog 采到原生骨架段（在覆盖前采集）')
  assert(!catalogNames.some((n) => n.startsWith('bard:')), 'section-catalog 不含 Bard 自己的段')

  // 只采一次
  store.writeSectionCatalog([{ name: 'SENTINEL', chars: 1 }])
  runAssemble(agent, nativeAssembly())
  const after = (store.readSectionCatalog() || []).map((i) => i.name)
  assert(after.includes('SENTINEL'), 'section-catalog 每个 session 只采一次（第二轮不再写盘）')
}

// ---------------------------------------------------------------- 2. complete
{
  composedId = 'bard-pcomplete'
  const { agent } = createAgent('a2')
  const assembly = nativeAssembly()
  runAssemble(agent, assembly)
  const names = assembly.sections.map((s) => s.name)
  assert(names.includes('deployment:persona-prefix') && names.includes('deployment:persona-suffix'), 'complete 模式保留骨架')
  assert(!names.includes('tool:read') && !names.includes('harness:loop'), 'complete 模式连 tool:/harness: 都不留')
  assert(names.some((n) => n.startsWith('bard:')), 'complete 模式下 Bard 段仍然渲染')
}

// ---------------------------------------------------------------- 3. 白名单
{
  composedId = 'bard-pkeep'
  const { agent } = createAgent('a3')
  feedUserText(agent.session, '旧城下雨了。')
  const assembly = nativeAssembly()
  runAssemble(agent, assembly)
  const names = assembly.sections.map((s) => s.name)
  assert(names.includes('guidance:writing'), '白名单模式：keepSections 里显式写出的原生段被保留（旧实现此处永久失效）')
  assert(names.includes('tool:read'), '白名单模式：toolAllowlist 里的工具段保留')
  assert(names.includes('harness:loop'), '白名单模式：harness:* 运行时骨架段始终保留')
  assert(!names.includes('env-block'), 'content 级过滤优先：含 runtime-context 字样的段仍被删除')
  const wb = assembly.sections.find((s) => s.name === 'bard:world-book')
  assert(Boolean(wb) && wb.text.includes('旧城常年下雨'), '世界书正文经 getBook 缓存进入 bard:world-book 段')
}

// ---------------------------------------------------------------- 4. 非 Bard
{
  composedId = 'deepseek-default'
  const { agent } = createAgent('a4')
  const assembly = nativeAssembly()
  const before = JSON.stringify(assembly)
  assert(runAssemble(agent, assembly) === 1, '非 Bard 会话调用 next()')
  assert(JSON.stringify(assembly) === before, '非 Bard 会话 assembly 原样放行，一个字段都没改')
}

// ---------------------------------------------------------------- 5. getBook 缓存
{
  composedId = 'bard-p1'
  const { agent } = createAgent('a5')
  const bard = agent._bardSession
  const first = bard.getBook('wb1')
  const second = bard.getBook('wb1')
  assert(Boolean(first) && first.id === 'wb1', 'getBook 能读到世界书')
  assert(first === second, 'getBook 命中 mtime 缓存（同一对象，不重复读盘）')

  const file = path.join(store.bardDirs().worldbooks, 'wb1.json')
  store.putWorldBook({ ...worldbook, name: '旧城改' })
  const future = new Date(Date.now() + 5000)
  fs.utimesSync(file, future, future)
  const third = bard.getBook('wb1')
  assert(third !== first && third.name === '旧城改', 'getBook 在 mtime 变化后重新读盘')
  assert(bard.getBook('nope') === undefined, 'getBook 对不存在的书返回 undefined')
  assert(bard.getBook('../escape') === undefined, 'getBook 拒绝路径穿越的 id')
}

// ---------------------------------------------------------------- 6. per-agent 工具名名单
{
  // 只让「第一个」restrict 调用失败一次，模拟 DSH 对未知全局工具的报错。
  // 旧实现把「亲眼见过的工具名」存在全局 Set：A 的 known 名单会覆盖 B 的，
  // 导致 B 合法的 allow 被削掉。per-agent 后 B 不受影响。
  let thrown = false
  const madeA = createAgent('iso-a')
  const madeB = createAgent('iso-b')
  madeA.tools.restrict = (spec) => {
    madeA.restrictCalls.push(spec)
    if (!thrown) {
      thrown = true
      throw new Error('unknown global tools "alice"\nknown global tools: read')
    }
    return NOOP_DISPOSE
  }

  composedId = 'bard-piso-a'
  runAssemble(madeA.agent, nativeAssembly())
  madeA.vars.get('bard_tools')({ scope: madeA.agent })
  composedId = 'bard-piso-b'
  runAssemble(madeB.agent, nativeAssembly())
  madeB.vars.get('bard_tools')({ scope: madeB.agent })

  const lastA = madeA.restrictCalls[madeA.restrictCalls.length - 1]
  const lastB = madeB.restrictCalls[madeB.restrictCalls.length - 1]
  assert(Array.isArray(lastA && lastA.allow) && !lastA.allow.includes('alice'), 'A：未知工具 alice 被从 allow 里剔掉')
  assert(Array.isArray(lastB && lastB.allow) && lastB.allow.includes('bob'), 'B：A 学到的 known 名单没有污染 B（per-agent 隔离）')
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  console.log('FAILED:', failed.map((f) => f.msg).join(' | '))
  process.exitCode = 1
}