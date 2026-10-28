/**
 * HTTP 路由处理。
 * 所有端点均在此处注册。强制校验 loopback 与同源 origin。
 */

import fs from 'node:fs'
import path from 'node:path'
import { makeId, getCard, putCard, deleteCard, getWorldBook, putWorldBook, deleteWorldBook, getPreset, putPreset, deletePreset, putPortrait, portraitPath, deleteRenderedCard, readToolCatalog, readSectionCatalog, readSkillCatalog, listCards, listWorldBooks, listPresets, listPersonas, deletePersona, deletePreMigrationSnapshot } from './store.js'
import { readCardDocument, normalizeCard, cardGreetings, isPng, updateCardEditable, detectCardLanguage } from './cards.js'
import { readWorldBookDocument, worldBookFromCharacterBook } from './lorebook.js'
import { BARD_BLOCKS, normalizeBlocks, renderBlockText, DEFAULT_STYLE_HINT, resolveToolsMode } from './persona.js'
import { interpolateCard, DEFAULT_USER_NAME } from './interpolate.js'
import { createPersona, loadPersona, savePersona, computeAnchoredRatio, getDriftCooldownState, resetDriftCooldown, rollbackMigration } from './alzheimer.js'
import { PRESET_PREFIX } from './preset-sync.js'
import { DEFAULT_WORKSPACE_PREFIX } from './constants.js'
import { getDb } from './db.js'
import { computeClarity } from './clarity.js'

const BARD_REQUIRED_SECTIONS = ['deployment:persona-prefix', 'deployment:persona-suffix']
const TOOL_SECTION_PREFIX = 'tool:'
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': String(Buffer.byteLength(payload)) })
  res.end(payload)
}

function readBody(req, limit = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) { reject(new Error(`请求体过大`)); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJsonBody(req) {
  const raw = await readBody(req)
  if (raw.length === 0) return {}
  try { return JSON.parse(raw.toString('utf8')) }
  catch (error) { throw new Error(`请求体不是合法 JSON（${String((error && error.message) || error)}）`) }
}

function bytesFromPayload(payload) {
  const dataUrl = typeof payload.dataUrl === 'string' ? payload.dataUrl : ''
  if (dataUrl.length > 0) {
    const comma = dataUrl.indexOf(',')
    const body = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
    return Buffer.from(body, 'base64')
  }
  if (typeof payload.base64 === 'string') return Buffer.from(payload.base64, 'base64')
  if (typeof payload.text === 'string') return Buffer.from(payload.text, 'utf8')
  throw new Error('缺少文件内容（dataUrl / base64 / text）')
}

function cardSummary(card) {
  return { id: card.id, name: card.name, spec: card.spec, specVersion: card.specVersion, container: card.container, importedAt: card.importedAt, creator: card.creator, characterVersion: card.characterVersion, tags: card.tags, portrait: card.portrait || '', hasCharacterBook: card.characterBook !== null, greetingCount: cardGreetings(card).length }
}

function worldBookSummary(book) {
  const entries = book.entries || []
  return { id: book.id, name: book.name, source: book.source, importedAt: book.importedAt, entryCount: entries.length, enabledCount: entries.filter((entry) => entry.enabled).length, constantCount: entries.filter((entry) => entry.enabled && entry.constant).length, keywordCount: entries.filter((entry) => entry.enabled && !entry.constant && entry.keys.length > 0).length }
}

function skillSummary(skill) {
  return { name: skill.name, description: skill.description || '', whenToUse: skill.whenToUse || '', source: skill.source || 'unknown', provider: skill.provider || 'unknown' }
}

export function registerRoutes(ctx, runtime) {
  function denied(req, res) {
    try {
      const headers = req.headers || {}
      const host = String(headers.host || '')
      const hostname = host.replace(/:\d+$/u, '').toLowerCase().replace(/^\[|\]$/gu, '')
      const loopback = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(hostname)
      if (!loopback) { res.writeHead(403); res.end('bard: non-loopback Host'); return true }
      const origin = headers.origin
      if (typeof origin === 'string' && origin.length > 0) {
        if (origin === 'null') { res.writeHead(403); res.end('bard: null origin'); return true }
        let originHost
        try { originHost = new URL(origin).host.toLowerCase() } catch (e) { originHost = undefined }
        if (!originHost || originHost !== host.toLowerCase()) { res.writeHead(403); res.end('bard: cross-origin request'); return true }
      }
      return false
    } catch (error) { try { res.writeHead(403); res.end() } catch (inner) {}; return true }
  }

  function route(kind, path, handler) {
    return ctx.webServer.register({
      kind, path,
      handler: async (req, res) => {
        if (denied(req, res)) return
        try { await handler(req, res) } catch (error) {
          if (res.writableEnded) return
          try { json(res, 400, { ok: false, error: String((error && error.message) || error) }) } catch (e) { /* socket 已断，忽略 */ }
        }
      },
    })
  }

  const disposers = []
  const add = (kind, path, handler) => disposers.push(route(kind, path, handler))
  ctx.effect(() => () => { for (const dispose of disposers.splice(0)) { try { dispose() } catch (e) {} } }, 'bard.routes')

  let skillsCache = null
  async function presentSkills() {
    const now = Date.now()
    if (skillsCache && now - skillsCache.at < 30000) return skillsCache.list
    const fromFile = readSkillCatalog()
    if (fromFile.length > 0) { const mapped = fromFile.map(skillSummary); skillsCache = { list: mapped, at: now }; return mapped }
    const service = ctx.get('skills')
    if (!service) return []
    let timeoutTimer
    try {
      const list = await Promise.race([service.list({}), new Promise((_, reject) => { timeoutTimer = setTimeout(() => reject(new Error('skills.list 超时')), 3000); if (timeoutTimer.unref) timeoutTimer.unref() })])
      const mapped = list.map(skillSummary)
      if (mapped.length > 0) { skillsCache = { list: mapped, at: now }; return mapped }
      return []
    } catch (error) { runtime.reportError('routes/skills', `技能目录读取失败：${String(error.message || error)}`); return skillsCache ? skillsCache.list : [] } finally { if (timeoutTimer) clearTimeout(timeoutTimer) }
  }


  // 动态检查 debug 开关（debug-server.mjs 被删除或加载失败时自动降级为 false）
  // 显式启用路径：设置环境变量 DSH_BARD_DEBUG=1。
  async function isDebugEnabled() {
    if (process.env.DSH_BARD_DEBUG === '1') return true
    try {
      const debug = await import('./debug-server.mjs')
      return debug.DEBUG_UI_ENABLED === 'T'
    } catch (e) {
      return false
    }
  }

  async function snapshot() {
    const cards = listCards(), worldbooks = listWorldBooks(), presets = listPresets()
    const debugMode = await isDebugEnabled()
    return {
      ok: true, home: 'bard',
      debugMode,
      defaults: { styleHint: DEFAULT_STYLE_HINT, workspacePrefix: DEFAULT_WORKSPACE_PREFIX },
      availableTools: readToolCatalog(), availableSections: readSectionCatalog(),
      bardRequiredSections: BARD_REQUIRED_SECTIONS.slice(), toolSectionPrefix: TOOL_SECTION_PREFIX,
      bardBlocks: BARD_BLOCKS.map((def) => ({ id: def.id, title: def.title, kind: def.kind, order: def.order })),
      cards: cards.map(cardSummary), worldbooks: worldbooks.map(worldBookSummary),
      presets: presets.map((preset) => ({
        id: preset.id, name: preset.name, description: preset.description || '', cardId: preset.cardId,
        cardName: (getCard(preset.cardId) || {}).name || '(已删除)',
        worldbookIds: preset.worldbookIds || [], skillNames: preset.skillNames || [], options: preset.options || {},
        createdAt: preset.createdAt, updatedAt: preset.updatedAt, dshPresetId: `${PRESET_PREFIX}${preset.id}`,
        base: preset.lastBase || '', error: preset.lastError || '',
      })),
      personas: listPersonas().map((p) => ({ id: p.id, name: p.self?.identity || '未命名人格', generation: p.meta?.generation || 1 })),
      skills: await presentSkills(),
      errors: runtime.getErrors().slice(0, 20),
    }
  }

  add('exact', '/dsh-bard/api/state', async (req, res) => { json(res, 200, await snapshot()) })

  add('exact', '/dsh-bard/api/builtin/install', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const type = payload.type
    if (type === 'qianmian') {
      const cardId = 'card-qianmian'
      putCard({ id: cardId, name: '千面（人设向导）', spec: 'chara_card_v2', specVersion: '2.0', container: 'json', source: 'builtin', importedAt: new Date().toISOString(), description: '你是一个专业的角色卡生成助手。请根据用户的描述，输出一个符合 Character Card V2 规范的 JSON 结构。\n包含：name, description, personality, scenario, first_mes, mes_example 字段。', personality: '专业、高效、注重细节、善于引导。', scenario: '', firstMes: '你好，我是千面。你的人设创作协作助手，请告诉我你想创建的角色大概是什么样的，以及是否有 *SFW需求。我会为你生成对应的json格式的角色卡。\n**请在生成完毕后，将 JSON 直接复制并粘贴到「女娲 → 造人」顶部的「从 JSON 导入」中。**', mesExample: '', systemPrompt: '【设定】你是一个专业且富有同理心的角色卡策划（千面）。你的目标是通过自然的对话，一步步引导用户构建出完美的角色卡。\n【交互规则】\n咨询阶段：在用户明确下令“生成”之前，你必须处于咨询阶段。在此阶段，你只能使用纯自然语言与用户聊天。禁止输出任何形式的 JSON。\n引导方式：每次只问 1 个方向的问题。信息足够时，复述设定并询问：“信息已经足够，要现在生成并保存吗？”\n【生成与写入规则】\n仅当用户明确回答“生成”、“可以了”时触发。一旦触发，你必须立刻调用 write 工具，将生成的合法 JSON 写入当前目录下的 card.json 文件中。JSON 必须严格包含以下字段：name, description, personality, scenario, first_mes, mes_example。调用完 write 工具后，不要再重复输出 JSON 内容。只需回复用户：“角色卡已生成并保存到[xx]目录下的 card.json。请复制该文件中的内容，粘贴到「女娲 → 造人」的「从 JSON 导入」中。”', postHistoryInstructions: '', creatorNotes: '', creator: 'DSH', characterVersion: '1.0', tags: ['Meta', 'Builder'], alternateGreetings: [], depthPrompt: '', characterBook: null })
      const qianmianBlocks = normalizeBlocks({})
      for (const id of ['stage', 'agency', 'pacing', 'gender', 'language', 'personality', 'scenario', 'extra', 'skills', 'style', 'depth', 'postHistory']) if (qianmianBlocks[id]) qianmianBlocks[id].enabled = false
      putPreset({ id: 'preset-qianmian', name: '千面', cardId, worldbookIds: [], skillNames: [], options: { toolsMode: 'allowlist', toolAllowlist: ['write'], complete: true, styleHint: '', blocks: qianmianBlocks }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      await runtime.syncPresets?.()
      return json(res, 200, { ok: true, ...(await snapshot()) })
    }
    if (type === 'wanwu') {
      const cardId = 'card-wanwu'
      putCard({ id: cardId, name: '万物（造物向导）', spec: 'chara_card_v2', specVersion: '2.0', container: 'json', source: 'builtin', importedAt: new Date().toISOString(), description: '你是一个专业的世界书生成助手。请根据用户的描述，输出一个符合 SillyTavern 世界书规范的 JSON 数组，包含 entries。\n每个 entry 包含: comment, content, keys (数组), constant (布尔值)。', personality: '严谨、条理清晰。', scenario: '', firstMes: '你好，我是万物。请告诉我你想构建什么样的世界观。我将尽力协助你进行创作，丰富你笔下的世界。\n\n**请在生成完毕后，将 JSON 直接复制并粘贴到「女娲 → 造物」顶部的「从 JSON 导入」中。**', mesExample: '', systemPrompt: '【设定】你是万物，世界书架构师。\n世界书是"条目集合"，需要用增量方式构建。\n【文件格式约束】你生成和修改 worldbook.json 时，必须严格遵循以下格式，不得有多余空格或换行：\n{\n"name": "世界书名称",\n"entries": [\n{"comment": "条目1", "content": "内容1", "keys": ["关键字"], "constant": false},\n{"comment": "条目2", "content": "内容2", "keys": ["关键字"], "constant": false}\n]\n}\n【操作工作流】\n1. 初次生成：使用 write 工具写入上述结构。\n2. 追加条目：先用 read 查看最后 2-3 行，找到最后一个 }。然后使用 edit 工具，将最后一个 } 替换为 }, {"comment": "新条目", "content": "...", "keys": [...], "constant": false}。\n3. 修改条目：用 read 查看目标条目附近内容，使用 edit 工具精确匹配该条目对象进行替换。', postHistoryInstructions: '', creatorNotes: '', creator: 'DSH', characterVersion: '1.0', tags: ['Meta', 'Builder'], alternateGreetings: [], depthPrompt: '', characterBook: null })
      const wanwuBlocks = normalizeBlocks({})
      for (const id of ['stage', 'agency', 'pacing', 'gender', 'language', 'personality', 'scenario', 'extra', 'skills', 'style', 'depth', 'postHistory']) if (wanwuBlocks[id]) wanwuBlocks[id].enabled = false
      putPreset({ id: 'preset-wanwu', name: '万物', cardId, worldbookIds: [], skillNames: [], options: { toolsMode: 'allowlist', toolAllowlist: ['read', 'write', 'edit'], complete: true, styleHint: '', blocks: wanwuBlocks }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      await runtime.syncPresets?.()
      return json(res, 200, { ok: true, ...(await snapshot()) })
    }
    return json(res, 400, { ok: false, error: '未知类型' })
  })

  add('exact', '/dsh-bard/api/card/save', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const id = typeof payload.id === 'string' && payload.id.trim() ? payload.id.trim() : makeId(payload.name || '新角色')
    const existing = getCard(id)
    const now = new Date().toISOString()
    const spec = payload.spec || (existing && existing.spec) || 'chara_card_v2'
    const specVersion = payload.specVersion || (existing && existing.specVersion) || '2.0'
    const { portraitBase64, ...safePayload } = payload
    const card = { ...(existing || {}), ...safePayload, id, spec, specVersion, container: payload.container || (existing && existing.container) || 'json', source: payload.source || (existing && existing.source) || 'creator', importedAt: existing ? existing.importedAt : now, updatedAt: now }
    putCard(card)
    if (typeof portraitBase64 === 'string' && portraitBase64.trim()) {
      try { const base64 = portraitBase64.replace(/^data:image\/\w+;base64,/, ''); card.portrait = putPortrait(id, Buffer.from(base64, 'base64')); putCard(card) } catch (e) { runtime.reportError('routes/card', `头像保存失败：${String((e && e.message) || e)}`) }
    }
    return json(res, 200, { ok: true, card: cardSummary(card), ...(await snapshot()) })
  })

  add('exact', '/dsh-bard/api/worldbook/save', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const id = typeof payload.id === 'string' && payload.id.trim() ? payload.id.trim() : makeId(payload.name || '新世界书')
    const existing = getWorldBook(id)
    const now = new Date().toISOString()
    const book = { ...(existing || {}), id, name: payload.name || '未命名世界书', entries: Array.isArray(payload.entries) ? payload.entries : [], importedAt: existing ? existing.importedAt : now, source: existing ? existing.source : 'creator', updatedAt: now }
    putWorldBook(book)
    return json(res, 200, { ok: true, book: worldBookSummary(book), ...(await snapshot()) })
  })

  add('exact', '/dsh-bard/api/card', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const bytes = bytesFromPayload(payload)
    const fileName = typeof payload.fileName === 'string' ? payload.fileName : ''
    const read = readCardDocument(bytes, fileName)
    const id = makeId(payload.name || fileName || 'card')
    const now = new Date().toISOString()
    const card = normalizeCard(read.raw, { id, name: typeof payload.name === 'string' && payload.name.trim().length > 0 ? payload.name.trim() : fileName.replace(/\.[a-z0-9]+$/iu, ''), container: read.container, source: read.keyword ? `png:${read.keyword}` : 'json', importedAt: now })
    card.updatedAt = now
    let portrait = ''
    if (isPng(bytes)) { try { portrait = putPortrait(id, bytes) } catch (error) { runtime.reportError('routes/card', `头像保存失败：${String(error.message || error)}`) } }
    card.portrait = portrait
    putCard(card)
    return json(res, 200, { ok: true, card: cardSummary(card), hasCharacterBook: card.characterBook !== null })
  })

  add('exact', '/dsh-bard/api/card/delete', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    if (typeof payload.id !== 'string') return json(res, 400, { ok: false, error: '缺少 id' })
    const used = listPresets().filter((preset) => preset.cardId === payload.id).map((preset) => preset.name)
    if (used.length > 0 && payload.force !== true) return json(res, 200, { ok: false, error: `该角色卡仍被预设使用：${used.join('、')}`, inUse: used })
    const removed = deleteCard(payload.id)
    if (removed) { runtime.syncPresets?.().catch((error) => { runtime.reportError('routes/card', `删除角色卡后的同步失败：${String(error.message || error)}`) }) }
    return json(res, 200, { ok: removed, ...(await snapshot()) })
  })

  add('exact', '/dsh-bard/api/card/book', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const card = getCard(payload.id)
    if (!card) return json(res, 404, { ok: false, error: '找不到角色卡' })
    if (!card.characterBook) return json(res, 200, { ok: false, error: '这张角色卡没有内嵌世界书' })
    const id = makeId(`${card.name}-book`)
    const now = new Date().toISOString()
    const book = { ...worldBookFromCharacterBook(card.characterBook, { id, name: `${card.name} 世界观` }), updatedAt: now }
    putWorldBook(book)
    return json(res, 200, { ok: true, book, ...(await snapshot()) })
  })

  add('exact', '/dsh-bard/api/card/detail', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const card = getCard(payload.id)
    if (!card) return json(res, 404, { ok: false, error: '找不到角色卡' })
    return json(res, 200, { ok: true, card })
  })

  add('exact', '/dsh-bard/api/card/update', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const card = getCard(payload.id)
    if (!card) return json(res, 404, { ok: false, error: '找不到角色卡' })
    const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : {}
    const next = { ...updateCardEditable(card, patch), updatedAt: new Date().toISOString() }
    putCard(next)
    await runtime.syncPresets?.()
    return json(res, 200, { ok: true, card: cardSummary(next), ...(await snapshot()) })
  })

  add('exact', '/dsh-bard/api/worldbook', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const bytes = bytesFromPayload(payload)
    const fileName = typeof payload.fileName === 'string' ? payload.fileName : ''
    const parsed = readWorldBookDocument(bytes, fileName)
    const id = makeId(payload.name || parsed.name || 'book')
    const now = new Date().toISOString()
    const book = { ...parsed, id, name: (typeof payload.name === 'string' && payload.name.trim()) || parsed.name, importedAt: now, updatedAt: now }
    putWorldBook(book)
    return json(res, 200, { ok: true, book: worldBookSummary(book) })
  })

  add('exact', '/dsh-bard/api/worldbook/detail', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const book = getWorldBook(payload.id)
    if (!book) return json(res, 404, { ok: false, error: '找不到世界书' })
    return json(res, 200, { ok: true, book })
  })

  add('exact', '/dsh-bard/api/worldbook/delete', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    if (typeof payload.id !== 'string') return json(res, 400, { ok: false, error: '缺少 id' })
    const removed = deleteWorldBook(payload.id)
    if (removed) { runtime.syncPresets?.().catch((error) => { runtime.reportError('routes/worldbook', `删除世界书后的同步失败：${String(error.message || error)}`) }) }
    return json(res, 200, { ok: removed, ...(await snapshot()) })
  })

  add('exact', '/dsh-bard/api/preset', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    if (typeof payload.cardId !== 'string' || !getCard(payload.cardId)) return json(res, 400, { ok: false, error: '请先选择一个角色卡' })
    const name = typeof payload.name === 'string' && payload.name.trim().length > 0 ? payload.name.trim() : (getCard(payload.cardId) || {}).name || '未命名'
    const existing = typeof payload.id === 'string' ? getPreset(payload.id) : undefined
    const now = new Date().toISOString()
    const preset = {
      id: existing ? existing.id : makeId(name), name, description: typeof payload.description === 'string' ? payload.description : '',
      cardId: payload.cardId, worldbookIds: Array.isArray(payload.worldbookIds) ? payload.worldbookIds.filter((id) => typeof id === 'string') : [],
      skillNames: Array.isArray(payload.skillNames) ? payload.skillNames.filter((id) => typeof id === 'string') : [],
      options: {
        styleHint: typeof payload.styleHint === 'string' ? payload.styleHint : DEFAULT_STYLE_HINT,
        extraInstructions: typeof payload.extraInstructions === 'string' ? payload.extraInstructions : '',
        complete: payload.complete === true, includeRuntimeContext: payload.includeRuntimeContext !== false,
        toolsMode: resolveToolsMode(payload),
        toolAllowlist: Array.isArray(payload.toolAllowlist) ? payload.toolAllowlist.filter((name) => typeof name === 'string' && name.length > 0) : [],
        keepSections: Array.isArray(payload.keepSections) ? payload.keepSections.filter((n) => typeof n === 'string' && n.length > 0) : [],
        keepSectionsEnabled: payload.keepSectionsEnabled === true,
        greetingIndex: Number.isInteger(payload.greetingIndex) && payload.greetingIndex >= 0 ? payload.greetingIndex : null,
        workspaceEnabled: payload.workspaceEnabled !== false,
        workspacePrefix: typeof payload.workspacePrefix === 'string' && payload.workspacePrefix.trim().length > 0 ? payload.workspacePrefix.trim() : DEFAULT_WORKSPACE_PREFIX,
        userName: typeof payload.userName === 'string' ? payload.userName.trim() : '',
        userGender: typeof payload.userGender === 'string' ? payload.userGender.trim() : '',
        outputLanguage: typeof payload.outputLanguage === 'string' ? payload.outputLanguage.trim() : '',
        maxEntries: Number.isFinite(payload.maxEntries) ? payload.maxEntries : 12, maxChars: Number.isFinite(payload.maxChars) ? payload.maxChars : 6000,
        blocks: normalizeBlocks(payload),
        personaId: typeof payload.personaId === 'string' && payload.personaId.length > 0 ? payload.personaId : undefined,
      },
      createdAt: existing ? existing.createdAt : now, updatedAt: now,
    }
    putPreset(preset)
    await runtime.syncPresets?.()
    const after = getPreset(preset.id)
    return json(res, 200, { ok: true, presetId: preset.id, dshPresetId: `${PRESET_PREFIX}${preset.id}`, error: (after && after.lastError) || '', ...(await snapshot()) })
  })

  add('exact', '/dsh-bard/api/preset/delete', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    if (typeof payload.id !== 'string') return json(res, 400, { ok: false, error: '缺少 id' })
    const removed = deletePreset(payload.id)
    if (removed) { try { deleteRenderedCard(payload.id) } catch (e) {}; runtime.syncPresets?.().catch((error) => { runtime.reportError('routes/preset', `删除预设后的同步失败：${String(error.message || error)}`) }) }
    return json(res, 200, { ok: removed, ...(await snapshot()) })
  })

  add('exact', '/dsh-bard/api/preset/preview', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const rawCard = getCard(payload.cardId)
    if (!rawCard) return json(res, 404, { ok: false, error: '找不到角色卡' })
    const userName = typeof payload.userName === 'string' && payload.userName.trim().length > 0 ? payload.userName.trim() : DEFAULT_USER_NAME
    const card = interpolateCard(rawCard, { userName })
    const options = { ...payload, toolsMode: resolveToolsMode(payload), blocks: normalizeBlocks(payload) }
    const blockContext = { card, skills: [], options, userName, charName: card.name, outputLanguage: String(payload.outputLanguage || '').trim(), userGender: String(payload.userGender || '').trim(), greetingIndex: Number.isInteger(payload.greetingIndex) && payload.greetingIndex >= 0 ? payload.greetingIndex : null }
    const blocks = BARD_BLOCKS.map((def) => {
      const state = options.blocks[def.id]
      const text = state.enabled ? renderBlockText(def.id, blockContext) : ''
      return { id: def.id, title: def.title, kind: def.kind, enabled: state.enabled, order: state.order, source: state.text !== null ? 'override' : (def.kind === 'static' ? 'default' : 'card'), text, template: state.text !== null ? state.text : text, chars: text.length, empty: text.length === 0 }
    })
    const toolCatalog = readToolCatalog()
    const toolsLine = toolCatalog.length > 0 ? `\n\n你现在能用的工具：${toolCatalog.join('、')}` : ''
    const workspacePrefix = typeof options.workspacePrefix === 'string' && options.workspacePrefix.trim().length > 0 ? options.workspacePrefix.trim() : DEFAULT_WORKSPACE_PREFIX
    const workspaceLine = options.workspaceEnabled === false ? '' : `\n\n## 你的工作区\n\n这个窗口的工作区是「${workspacePrefix}/<角色名>-<短ID>/」，相对于工作目录。`
    const renderedBlocks = blocks.map((b) => {
      if (b.id !== 'agency') return b
      const actual = b.text.replace('{{bard_tools}}', toolsLine).replace('{{bard_workspace}}', workspaceLine)
      return { ...b, text: actual, chars: actual.length, empty: actual.length === 0 }
    })
    const assembled = renderedBlocks.filter((b) => b.enabled && !b.empty).sort((a, b) => a.order - b.order).map((b) => b.text).join('\n\n')
    return json(res, 200, { ok: true, blocks: renderedBlocks, assembled, chars: assembled.length, tokenEstimate: Math.round(assembled.length / 2), cardLanguage: detectCardLanguage(card), warnings: [] })
  })

  add('exact', '/dsh-bard/api/memory/state', async (req, res) => {
    const debugMode = await isDebugEnabled()
    const db = getDb()
    const personas = listPersonas().map((record) => {
      const persona = loadPersona(record.id) || record

      // 从 SQLite 抓取这个人的所有记忆节点
      const nodes = db.prepare(`SELECT * FROM nodes WHERE persona_id = ? AND archived_at IS NULL ORDER BY created_at ASC`).all(persona.id)

      const memories = nodes.map(n => ({
        id: n.id,
        text: n.text,
        state: n.state || 'active',
        clarity: computeClarity(n, Date.now()),
        restateCount: n.restate_count,
        scene: '',
        createdAt: new Date(n.created_at).toISOString()
      }))

      return {
        id: persona.id,
        name: persona.self?.identity || persona.id,
        generation: persona.meta?.generation || 1,
        anchoredRatio: computeAnchoredRatio(persona),
        memories,
        impressions: persona.impressions || [],
        chapters: persona.narrative?.chapters || [],
        driftState: getDriftCooldownState(persona.id)
      }
    })
    return json(res, 200, { ok: true, personas, debugMode })
  })

  add('exact', '/dsh-bard/api/memory/curves', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const id = typeof payload.id === 'string' ? payload.id : ''
    if (!id) return json(res, 400, { ok: false, error: '缺少 id' })
    const persona = loadPersona(id)
    if (!persona) return json(res, 404, { ok: false, error: '人格不存在' })

    const days = Number.isFinite(payload.days) ? Math.max(1, Math.min(90, payload.days)) : 30
    const points = Number.isFinite(payload.points) ? Math.max(2, Math.min(90, payload.points)) : 30
    const now = Date.now()
    const step = (days * 86400000) / (points - 1)

    const db = getDb()
    // 从 SQLite 取出节点，不再读 JSON
    const nodes = db.prepare('SELECT * FROM nodes WHERE persona_id = ? AND archived_at IS NULL').all(id)

    const curves = nodes.map((m) => {
      const samples = []
      for (let i = 0; i < points; i += 1) {
        const t = now + i * step
        samples.push({
          day: +((i * step) / 86400000).toFixed(2),
          clarity: +computeClarity(m, t).toFixed(4),
        })
      }
      return {
        id: m.id,
        text: String(m.text || '').slice(0, 40),
        state: m.state || 'active',
        importance: Number.isFinite(m.importance) ? m.importance : 5,
        restateCount: m.restate_count || 0,
        currentClarity: +computeClarity(m, now).toFixed(4),
        points: samples,
      }
    })
    return json(res, 200, { ok: true, days, points, curves })
  })

  add('exact', '/dsh-bard/api/memory/rollback', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const debugMode = await isDebugEnabled()
    if (!debugMode) return json(res, 403, { ok: false, error: '回滚仅在调试模式下可用' })
    const payload = await readJsonBody(req)
    const id = typeof payload.id === 'string' ? payload.id : ''
    if (!id) return json(res, 400, { ok: false, error: '缺少 id' })
    try {
      const restored = rollbackMigration(id)
      runtime.reportError('rollback', `人格 ${id} 已回滚到第 ${restored.meta.generation} 世`)
      return json(res, 200, { ok: true, persona: { id: restored.id, name: restored.self.identity || restored.id, generation: restored.meta.generation } })
    } catch (e) {
      return json(res, 400, { ok: false, error: String((e && e.message) || e) })
    }
  })

  add('exact', '/dsh-bard/api/persona/create', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const persona = createPersona({ cardId: payload.cardId || '', self: { identity: payload.name || '新人格' } })
    savePersona(persona)
    return json(res, 200, { ok: true, persona, ...(await snapshot()) })
  })

  add('exact', '/dsh-bard/api/persona/delete', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const id = payload.id
    if (typeof id !== 'string' || id.length === 0) return json(res, 400, { ok: false, error: '缺少 id' })
    const used = listPresets().filter((preset) => preset.options && preset.options.personaId === id).map((p) => p.name)
    if (used.length > 0 && payload.force !== true) return json(res, 200, { ok: false, error: `该人格仍被预设使用：${used.join('、')}`, inUse: used })
    deletePersona(id)
    try { deletePreMigrationSnapshot(id) } catch (e) {}
    try { resetDriftCooldown(id) } catch (e) {}
    return json(res, 200, { ok: true, ...(await snapshot()) })
  })

  add('prefix', '/dsh-bard/api/portrait', async (req, res) => {
    const id = new URL(req.url, 'http://x').pathname.split('/').pop()
    const file = portraitPath(id)
    if (!file) { res.writeHead(404); return res.end('no portrait') }
    const bytes = fs.readFileSync(file)
    const ext = file.split('.').pop().toLowerCase()
    const type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': String(bytes.length) })
    res.end(bytes)
  })
}
