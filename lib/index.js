/**
 * dsh-bard — Bard-style role-play for DeepSeek Harness.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  ensureDirs, listCards, getCard, putCard, deleteCard, listWorldBooks, getWorldBook,
  putWorldBook, deleteWorldBook, listPresets, getPreset, putPreset, deletePreset,
  putPortrait, portraitPath, putRenderedCard, deleteRenderedCard, makeId,
  listWorkspaceRecords, putWorkspaceRecord, deleteWorkspaceRecord, readToolCatalog,
  writeToolCatalog, readSectionCatalog, writeSectionCatalog, readSkillCatalog, writeSkillCatalog,
} from './store.js'
import {
  readCardDocument, normalizeCard, cardGreetings, isPng, updateCardEditable,
  isRedundantField, detectCardLanguage,
} from './cards.js'
import {
  readWorldBookDocument, worldBookFromCharacterBook, selectLore, renderLore,
} from './lorebook.js'
import {
  BARD_BLOCKS, normalizeBlocks, renderAllBlocks, renderBlockText,
  buildPersonaPrefix, describeCard, DEFAULT_STYLE_HINT,
} from './persona.js'
import { interpolateCard, interpolateText, DEFAULT_USER_NAME } from './interpolate.js'

export const name = 'bard'
export const inject = ['webServer']

const KEEP_ROW_IDS = ['tool-fs', 'tool-fs-search', 'tool-web', 'present', 'tool-comfy']
const PRESET_PREFIX = 'bard-'
const BARD_REQUIRED_SECTIONS = ['deployment:persona-prefix', 'deployment:persona-suffix']
const TOOL_SECTION_PREFIX = 'tool:'
const PRESET_ORDER_BASE = 50
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024
const RECENT_LIMIT = 24
const LORE_CONTEXT_ORDER = 130
const LORE_CONTEXT_NAME = 'bard:world-book'
const TOOL_LIST_VARIABLE_NAME = 'bard_tools'
const WORKSPACE_VARIABLE_NAME = 'bard_workspace'
const DEFAULT_WORKSPACE_PREFIX = 'Bard_World'
const WORKSPACE_GRACE_MS = 5 * 60 * 1000

function workspaceShortId(agentId) {
  return createHash('sha1').update(String(agentId)).digest('hex').slice(0, 6)
}

function workspaceRelPath(prefix, cardName, shortId) {
  const cleanPrefix = String(prefix || DEFAULT_WORKSPACE_PREFIX)
    .replace(/\\/gu, '/').replace(/\.\./gu, '').replace(/^\/+|\/+$/gu, '').replace(/\/{2,}/gu, '/')
  const cleanName = String(cardName || 'char')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '').replace(/^\.+|\.+$/gu, '').trim().slice(0, 40) || 'char'
  const lead = cleanPrefix.length > 0 ? `${cleanPrefix}/` : ''
  return `${lead}${cleanName}-${shortId}`
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(payload)),
  })
  res.end(payload)
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((block) => block && block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n')
}

function eventText(event) {
  const type = event && event.type
  if (type === 'user/message') return textOf(event.data && event.data.content)
  if (type === 'assistant/message') return textOf(event.data && event.data.message && event.data.message.content)
  return ''
}

function resolveSkillsSync(names) {
  if (!Array.isArray(names) || names.length === 0) return []
  const catalog = readSkillCatalog()
  const map = new Map(catalog.map((s) => [s.name, s]))
  const out = []
  for (const name of names) {
    const skill = map.get(name)
    if (skill && skill.content) out.push(skill)
  }
  return out
}

function readBody(req, limit = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
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
  return {
    id: card.id, name: card.name, spec: card.spec, specVersion: card.specVersion,
    container: card.container, importedAt: card.importedAt, creator: card.creator,
    characterVersion: card.characterVersion, tags: card.tags, portrait: card.portrait || '',
    hasCharacterBook: card.characterBook !== null, greetingCount: cardGreetings(card).length,
  }
}

function worldBookSummary(book) {
  const entries = book.entries || []
  return {
    id: book.id, name: book.name, source: book.source, importedAt: book.importedAt,
    entryCount: entries.length, enabledCount: entries.filter((entry) => entry.enabled).length,
    constantCount: entries.filter((entry) => entry.enabled && entry.constant).length,
    keywordCount: entries.filter((entry) => entry.enabled && !entry.constant && entry.keys.length > 0).length,
  }
}

function skillSummary(skill) {
  return { name: skill.name, description: skill.description || '', whenToUse: skill.whenToUse || '', source: skill.source || 'unknown', provider: skill.provider || 'unknown' }
}

const MAX_DIAGNOSTICS = 100
function report(list, message) {
  list.push(message)
  if (list.length > MAX_DIAGNOSTICS) list.splice(0, list.length - MAX_DIAGNOSTICS)
}

export function apply(ctx) {
  ensureDirs()

  const runtime = {
    errors: [], syncErrors: [], recent: new Map(),
    loreDisposers: new Map(), blockDisposers: new Map(), toolListDisposers: new Map(),
    workspaceDisposers: new Map(), promptFilterDisposers: new Map(), cwdByAgent: new Map(),
    presetDisposers: [], syncing: Promise.resolve(),
  }

  ctx.on('session/event', (session, event) => {
    if (!session) return
    const text = eventText(event)
    if (text.trim().length === 0) return
    const list = runtime.recent.get(session.id) || []
    list.push(text)
    while (list.length > RECENT_LIMIT) list.shift()
    runtime.recent.set(session.id, list)
  })
  ctx.on('session/disposed', (session) => { if (session) runtime.recent.delete(session.id) })

  function registerAgentLore(agent) {
    const systemPrompt = agent.ctx.get('systemPrompt')
    if (!systemPrompt) { report(runtime.errors, `world-book: systemPrompt 服务不可用`); return () => {} }
    let thunkErrorReported = false
    let dispose
    try {
      dispose = agent.ctx.effect(() => systemPrompt.section({
        name: LORE_CONTEXT_NAME, order: LORE_CONTEXT_ORDER,
        text: () => {
          try {
            const presetsService = agent.ctx.get('agentPresets')
            if (!presetsService) return ''
            const composed = presetsService.composedPreset(agent.ctx)
            if (typeof composed !== 'string' || !composed.startsWith(PRESET_PREFIX)) return ''
            const bardPresetId = composed.slice(PRESET_PREFIX.length)
            if (!getPreset(bardPresetId)) return ''
            const sessionId = agent.session && typeof agent.session.id === 'string' ? agent.session.id : ''
            if (sessionId.length === 0) return ''
            return loreTextFor(runtime, bardPresetId, sessionId)
          } catch (error) {
            if (!thunkErrorReported) { thunkErrorReported = true; report(runtime.errors, `world-book thunk: ${String(error.message || error)}`) }
            return ''
          }
        },
      }), 'bard.world-book')
    } catch (error) { report(runtime.errors, `world-book context: ${String(error.message || error)}`); return () => {} }
    return () => { try { dispose() } catch (e) {} }
  }

    function registerAgentBlocks(agent) {
    const systemPrompt = agent.ctx.get('systemPrompt')
    if (!systemPrompt) { report(runtime.errors, `blocks: systemPrompt 服务不可用`); return () => {} }
    let cachedKey = '', cachedTexts = {}, thunkErrorReported = false
    const getTexts = () => {
      try {
        const presetsService = agent.ctx.get('agentPresets')
        if (!presetsService) return {}
        const composed = presetsService.composedPreset(agent.ctx)
        if (typeof composed !== 'string' || !composed.startsWith(PRESET_PREFIX)) return {}
        const presetId = composed.slice(PRESET_PREFIX.length)
        const preset = getPreset(presetId)
        if (!preset) return {}
        const card = getCard(preset.cardId)
        if (!card) return {}
        const key = `${presetId}\u0000${preset.updatedAt || ''}`
        if (key === cachedKey) return cachedTexts
        const userName = (preset.options && preset.options.userName && preset.options.userName.trim()) || DEFAULT_USER_NAME
        const interpolated = interpolateCard(card, { userName })
        const skills = resolveSkillsSync(preset.skillNames)
        const blockContext = {
          card: interpolated, skills, options: preset.options || {}, userName, charName: interpolated.name,
          outputLanguage: (preset.options && preset.options.outputLanguage) || '',
          userGender: (preset.options && preset.options.userGender) || '',
          greetingIndex: Number.isInteger(preset.options && preset.options.greetingIndex) && preset.options.greetingIndex >= 0 ? preset.options.greetingIndex : null,
        }
        cachedKey = key
        cachedTexts = renderAllBlocks(blockContext)
        return cachedTexts
      } catch (error) {
        if (!thunkErrorReported) { thunkErrorReported = true; report(runtime.errors, `blocks thunk: ${String(error.message || error)}`) }
        return {}
      }
    }
    let disposeAll
    try {
      disposeAll = agent.ctx.effect(() => {
        const disposers = []
        for (let i = 0; i < BARD_BLOCKS.length; i += 1) {
          const def = BARD_BLOCKS[i]
          // 核心修复：将 context 换成 section，让它真正出现在 assembly.sections 中
          disposers.push(systemPrompt.section({ 
            name: `bard:${def.id}`, 
            order: 200 + i * 10, 
            text: () => getTexts()[def.id] || '' 
          }))
        }
        return () => { for (const dispose of disposers) { try { dispose() } catch (e) {} } }
      }, 'bard.blocks')
    } catch (error) { report(runtime.errors, `blocks register: ${String(error.message || error)}`); return () => {} }
    return () => { try { disposeAll() } catch (e) {} }
  }
  function registerAgentToolList(agent) {
    const systemPrompt = agent.ctx.get('systemPrompt')
    if (!systemPrompt) { report(runtime.errors, `tool-list: systemPrompt 服务不可用`); return () => {} }
    let cachedKey = null, cachedText = '', restrictionDispose = null, restrictionKey = null, captured = false, thunkErrorReported = false
    const syncRestriction = (tools, bardPreset) => {
      const options = (bardPreset && bardPreset.options) || {}
      let allow = null
      if (options.enableTools === false) allow = []
      else if (Array.isArray(options.toolAllowlist) && options.toolAllowlist.length > 0) allow = options.toolAllowlist
      const key = bardPreset ? `${bardPreset.id}\u0000${bardPreset.updatedAt || ''}` : ''
      if (key === restrictionKey) return
      if (restrictionDispose) { try { restrictionDispose() } catch (e) {}; restrictionDispose = null }
      restrictionKey = key
      if (allow === null || !tools || typeof tools.restrict !== 'function') return
      try { restrictionDispose = agent.ctx.effect(() => tools.restrict({ allow }), 'bard.tool-filter') }
      catch (error) { if (!thunkErrorReported) { thunkErrorReported = true; report(runtime.errors, `tool-filter: ${String(error.message || error)}`) } }
    }
    const text = (context) => {
      try {
        const presetsService = agent.ctx.get('agentPresets')
        const tools = agent.ctx.get('tools')
        if (!presetsService || !tools) return ''
        if (!captured) {
          captured = true
          try {
            const schemas = tools.schemas(context && context.scope)
            if (Array.isArray(schemas)) {
              const names = schemas.map((s) => (s && typeof s.name === 'string' ? s.name : '')).filter(Boolean)
              if (names.length > 0) writeToolCatalog(names)
            }
          } catch (e) {}
        }
        const composed = presetsService.composedPreset(agent.ctx)
        if (typeof composed !== 'string' || !composed.startsWith(PRESET_PREFIX)) { syncRestriction(tools, null); return '' }
        const presetId = composed.slice(PRESET_PREFIX.length)
        const bardPreset = getPreset(presetId)
        if (!bardPreset) { syncRestriction(tools, null); return '' }
        syncRestriction(tools, bardPreset)
        const key = `${presetId}\u0000${bardPreset.updatedAt || ''}`
        if (key === cachedKey) return cachedText
        if (bardPreset.options && bardPreset.options.enableTools === false) { cachedKey = key; cachedText = ''; return '' }
        const schemas = tools.schemas(context && context.scope)
        if (!Array.isArray(schemas)) return ''
        const names = schemas.map((s) => (s && typeof s.name === 'string' ? s.name : '')).filter(Boolean)
        cachedKey = key
        cachedText = names.length === 0 ? '' : `\n\n你现在能用的工具：${names.join('、')}`
        return cachedText
      } catch (error) {
        if (!thunkErrorReported) { thunkErrorReported = true; report(runtime.errors, `tool-list thunk: ${String(error.message || error)}`) }
        return ''
      }
    }
    let dispose
    try { dispose = agent.ctx.effect(() => systemPrompt.variable(TOOL_LIST_VARIABLE_NAME, text), 'bard.tool-list') }
    catch (error) { report(runtime.errors, `tool-list variable: ${String(error.message || error)}`); return () => {} }
    return () => {
      try { dispose() } catch (e) {}
      if (restrictionDispose) { try { restrictionDispose() } catch (e) {}; restrictionDispose = null }
    }
  }

  function registerAgentWorkspace(agent) {
    const systemPrompt = agent.ctx.get('systemPrompt')
    if (!systemPrompt) { report(runtime.errors, `workspace: systemPrompt 不可用`); return () => {} }
    let cachedKey = '', cachedText = '', thunkErrorReported = false
    const text = () => {
      try {
        const presetsService = agent.ctx.get('agentPresets')
        if (!presetsService) return ''
        const composed = presetsService.composedPreset(agent.ctx)
        if (typeof composed !== 'string' || !composed.startsWith(PRESET_PREFIX)) return ''
        const presetId = composed.slice(PRESET_PREFIX.length)
        let cwd = runtime.cwdByAgent.get(agent.id)
        if (typeof cwd !== 'string' || cwd.length === 0) {
          cwd = agent.session && agent.session.header ? agent.session.header.cwd : undefined
          if (typeof cwd === 'string' && cwd.length > 0) runtime.cwdByAgent.set(agent.id, cwd)
        }
        if (typeof cwd !== 'string' || cwd.length === 0) return ''
        const sessionId = agent.session && typeof agent.session.id === 'string' ? agent.session.id : ''
        if (sessionId.length === 0) return ''
        const bardPreset = getPreset(presetId)
        if (!bardPreset) return ''
        const cacheKey = `${presetId}\u0000${cwd}\u0000${sessionId}\u0000${bardPreset.updatedAt || ''}`
        if (cacheKey === cachedKey) return cachedText
        const options = bardPreset.options || {}
        if (options.enableTools === false || options.workspaceEnabled === false) { cachedKey = cacheKey; cachedText = ''; return '' }
        const card = getCard(bardPreset.cardId)
        if (!card) return ''
        const shortId = workspaceShortId(agent.id)
        const relPath = workspaceRelPath(options.workspacePrefix, card.name, shortId)
        const absPath = path.join(cwd, ...relPath.split('/'))
        try { fs.mkdirSync(absPath, { recursive: true, mode: 0o700 }) }
        catch (error) { if (!thunkErrorReported) { thunkErrorReported = true; report(runtime.errors, `workspace mkdir: ${String(error.message || error)}`) }; return '' }
        const marker = path.join(absPath, '.bard-session')
        let ownershipToken = ''
        try {
          const parsed = JSON.parse(fs.readFileSync(marker, 'utf8'))
          if (parsed && typeof parsed.token === 'string') ownershipToken = parsed.token
        } catch (e) {}
        if (ownershipToken.length === 0) {
          ownershipToken = randomUUID()
          try { fs.writeFileSync(marker, `${JSON.stringify({ token: ownershipToken }, null, 2)}\n`, { mode: 0o600 }) } catch (e) {}
        }
        try { putWorkspaceRecord(shortId, { token: ownershipToken, sessionId, agentId: agent.id, presetId, cwd, relPath, createdAt: new Date().toISOString() }) } catch (e) {}
        cachedKey = cacheKey
        cachedText = `\n\n## 你的工作区\n\n这个窗口的工作区是「${relPath}/」，相对于工作目录。目录已经建好了。你要写下来的东西都放那里。`
        return cachedText
      } catch (error) {
        if (!thunkErrorReported) { thunkErrorReported = true; report(runtime.errors, `workspace thunk: ${String(error.message || error)}`) }
        return ''
      }
    }
    let dispose
    try { dispose = agent.ctx.effect(() => systemPrompt.variable(WORKSPACE_VARIABLE_NAME, text), 'bard.workspace') }
    catch (error) { report(runtime.errors, `workspace variable: ${String(error.message || error)}`); return () => {} }
    return () => { try { dispose() } catch (e) {} }
  }

  function isKeepEnabled(options) {
    if (!options || typeof options !== 'object') return false
    if (options.keepSectionsEnabled === true) return true
    if (options.keepSectionsEnabled === false) return false
    return Array.isArray(options.keepSections) && options.keepSections.length > 0
  }

  function shouldKeepSection(name, options) {
    if (typeof name !== 'string' || name.length === 0) return false
    if (BARD_REQUIRED_SECTIONS.includes(name)) return true
    if (name.startsWith(TOOL_SECTION_PREFIX)) {
      if (options.enableTools === false) return false
      const allow = Array.isArray(options.toolAllowlist) ? options.toolAllowlist : []
      if (allow.length === 0) return true
      return allow.includes(name.slice(TOOL_SECTION_PREFIX.length))
    }
    const userKeep = Array.isArray(options.keepSections) ? options.keepSections : []
    return userKeep.includes(name)
  }

  function registerAgentPromptFilter(agent) {
    const presetsService = agent.ctx.get('agentPresets')
    if (!presetsService) return () => {}
    let captured = false, cachedKey = null, cachedKeep = null, cachedComplete = false, cachedBlocks = {}
    
    const filter = (assembly, context, next) => {
      try {
        const composed = presetsService.composedPreset(agent.ctx)
        if (typeof composed !== 'string' || !composed.startsWith(PRESET_PREFIX)) return next()
        const presetId = composed.slice(PRESET_PREFIX.length)
        const bardPreset = getPreset(presetId)
        if (!bardPreset) return next()

        const key = `${presetId}\u0000${bardPreset.updatedAt || ''}`
        if (key !== cachedKey) {
          cachedKey = key
          const opts = bardPreset.options || {}
          cachedKeep = (opts.complete === true || !isKeepEnabled(opts)) ? null : { options: opts }
          cachedComplete = opts.complete === true
          cachedBlocks = normalizeBlocks(opts)
        }

        if (!captured) {
          captured = true
          try {
            const list = assembly.sections.filter((s) => typeof s.text === 'string' && s.text.length > 0).filter((s) => !s.name.startsWith('bard:')).map((s) => ({ name: s.name, chars: s.text.length }))
            if (list.length > 0) writeSectionCatalog(list)
          } catch (e) {}
        }

        if (!Array.isArray(assembly.sections)) return next()

        const blockEnabled = (name) => {
          const id = name.slice('bard:'.length)
          if (id === 'world-book') return true
          const state = cachedBlocks[id]
          return state ? state.enabled : true
        }

        const hasBardText = assembly.sections.some((s) => s.name.startsWith('bard:') && s.name !== LORE_CONTEXT_NAME && typeof s.text === 'string' && s.text.length > 0)

        if (cachedComplete) {
          if (hasBardText) {
            assembly.sections = assembly.sections.filter((s) => {
              if (s.name.startsWith('bard:')) return blockEnabled(s.name)
              return s.name.startsWith('deployment:persona-')
            })
          } else {
            if (!runtime.errors.some(e => e.includes('安全网触发：'))) {
               report(runtime.errors, `安全网触发：complete 模式下未提取到任何 Bard 提示词块。为了防止模型失去所有上下文，已自动回退并保留原生提示词。请检查是否停用了所有块。`)
            }

            assembly.sections = assembly.sections.filter((s) => {
              if (s.name.startsWith('bard:')) return blockEnabled(s.name)
              if (s.name.startsWith('tool:') || s.name.startsWith('harness:')) return false
              return true
            })
          }
        } else if (cachedKeep !== null) {
          assembly.sections = assembly.sections.filter((s) => {
            if (s.name.startsWith('bard:')) return blockEnabled(s.name)
            return shouldKeepSection(s.name, cachedKeep.options)
          })
        } else {
          assembly.sections = assembly.sections.filter((s) => !s.name.startsWith('bard:') || blockEnabled(s.name))
        }

        const orderOf = (s) => {
          if (s.name.startsWith('bard:')) {
            const id = s.name.slice('bard:'.length)
            if (id === 'world-book') return LORE_CONTEXT_ORDER
            const state = cachedBlocks[id]
            return state ? state.order : 9999
          }
          return typeof s.order === 'number' ? s.order : 9999
        }
        assembly.sections.sort((a, b) => orderOf(a) - orderOf(b))
        
      } catch (error) {
        report(runtime.errors, `prompt-filter: ${String(error.message || error)}`)
      }
      return next()
    }

    try {
      return agent.ctx.effect(() => agent.ctx.on('system-prompt/assemble', filter), 'bard.prompt-filter')
    } catch (error) {
      report(runtime.errors, `prompt-filter register: ${String(error.message || error)}`)
      return () => {}
    }
  }
  function captureSkillCatalog(agent) {
    const skills = agent.ctx.get('skills')
    if (!skills || typeof skills.list !== 'function') return
    const cwd = agent.session && agent.session.header ? agent.session.header.cwd : undefined
    Promise.resolve(skills.list({ scope: agent, cwd })).then(async (list) => {
      if (!Array.isArray(list) || list.length === 0) return
      const fullSkills = await Promise.all(list.map(async (summary) => {
        try { const full = await skills.get(summary.name, { scope: agent, cwd }); return full || summary } catch (e) { return summary }
      }))
      writeSkillCatalog(fullSkills)
    }).catch((error) => { report(runtime.errors, `skill-catalog: ${String(error.message || error)}`) })
  }

  ctx.on('agent/created', ({ agent }) => {
    runtime.loreDisposers.set(agent.id, registerAgentLore(agent))
    runtime.blockDisposers.set(agent.id, registerAgentBlocks(agent))
    runtime.toolListDisposers.set(agent.id, registerAgentToolList(agent))
    runtime.workspaceDisposers.set(agent.id, registerAgentWorkspace(agent))
    runtime.promptFilterDisposers.set(agent.id, registerAgentPromptFilter(agent))
    captureSkillCatalog(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    for (const [id, map] of [[agent.id, runtime.loreDisposers], [agent.id, runtime.blockDisposers], [agent.id, runtime.toolListDisposers], [agent.id, runtime.workspaceDisposers]]) {
      const dispose = map.get(id); map.delete(id); if (dispose) dispose()
    }
    runtime.promptFilterDisposers.get(agent.id)?.(); runtime.promptFilterDisposers.delete(agent.id); runtime.cwdByAgent.delete(agent.id)
  })
  ctx.effect(() => () => {
    for (const map of [runtime.loreDisposers, runtime.blockDisposers, runtime.toolListDisposers, runtime.workspaceDisposers, runtime.promptFilterDisposers]) {
      for (const dispose of map.values()) { try { dispose() } catch (e) {} }; map.clear()
    }
    runtime.cwdByAgent.clear()
  }, 'bard.scoped-disposers')

  ctx.inject(['agentPresets'], (scoped) => {
    const presetsService = scoped.agentPresets
    async function baseRows() {
      let defaultId
      try { const current = await presetsService.resolve(); defaultId = current && current.id } catch (e) { defaultId = undefined }
      const editor = ctx.get('configEditor')
      if (editor && typeof editor.configuration === 'function') {
        try {
          const rows = editor.configuration()
          const candidates = rows.filter((row) => row && row.entry && row.entry.options && row.entry.options.name === '@deepseek-ai/dsh-agent-preset' && row.inherited && Array.isArray(row.inherited.plugins))
          if (candidates.length > 0) {
            const chosen = candidates.find((row) => row.inherited.id === defaultId) || candidates[0]
            const plugins = structuredClone(chosen.inherited.plugins)
            const filtered = KEEP_ROW_IDS.length > 0 ? plugins.filter((row) => row && KEEP_ROW_IDS.includes(row.id)) : plugins
            if (KEEP_ROW_IDS.length > 0 && filtered.length === 0 && plugins.length > 0) {
              report(runtime.syncErrors, `默认预设的插件行完全不匹配 KEEP_ROW_IDS，生成的 Bard 预设将没有任何工具。`)
            }
            return { source: `preset:${chosen.inherited.id}`, rows: filtered }
          }
        } catch (error) { report(runtime.syncErrors, `读取默认预设失败：${String(error.message || error)}`) }
      }
      return { source: 'builtin', rows: builtinToolRows() }
    }

    function resolveSkills(names) {
      if (!Array.isArray(names) || names.length === 0) return []
      const catalog = readSkillCatalog()
      const map = new Map(catalog.map((s) => [s.name, s]))
      const out = []
      for (const skillName of names) {
        const skill = map.get(skillName)
        if (skill && skill.content) out.push({ name: skill.name, description: skill.description, whenToUse: skill.whenToUse, content: skill.content, source: skill.source, provider: skill.provider })
        else report(runtime.syncErrors, `技能「${skillName}」在本地技能缓存中缺失。`)
      }
      return out
    }

    async function buildDefinition(bardPreset, index) {
      const rawCard = getCard(bardPreset.cardId)
      if (!rawCard) throw new Error(`角色卡已不存在（${bardPreset.cardId}）`)
      const userName = (bardPreset.options && bardPreset.options.userName) || DEFAULT_USER_NAME
      const card = interpolateCard(rawCard, { userName })
      resolveSkills(bardPreset.skillNames)
      const base = await baseRows()
      const rows = base.rows.map((row) => ({ ...row }))
      const personaConfig = { prefix: '', complete: false, includeRuntimeContext: !(bardPreset.options && bardPreset.options.includeRuntimeContext === false) }
      const at = rows.findIndex((row) => row && row.name === '@deepseek-ai/dsh-persona')
      if (at >= 0) rows[at] = { ...rows[at], disabled: false, config: { ...(rows[at].config || {}), ...personaConfig } }
      else rows.unshift({ id: 'persona', name: '@deepseek-ai/dsh-persona', config: personaConfig })
      return { id: `${PRESET_PREFIX}${bardPreset.id}`, name: `吟游 · ${bardPreset.name}`, description: describeCard(card, bardPreset.name), order: PRESET_ORDER_BASE + index, plugins: rows, __base: base.source }
    }

    async function syncPresets() {
      const run = async () => {
        for (const dispose of runtime.presetDisposers.splice(0)) { try { await dispose() } catch (e) {} }
        runtime.syncErrors = []
        const bardPresets = listPresets()
        for (let index = 0; index < bardPresets.length; index++) {
          const bardPreset = bardPresets[index]
          let definition
          try { definition = await buildDefinition(bardPreset, index) }
          catch (error) {
            const reason = String((error && error.message) || error)
            bardPreset.lastBase = ''; bardPreset.lastError = reason
            try { putPreset(bardPreset) } catch (e) {}
            report(runtime.syncErrors, `预设「${bardPreset.name}」无法生成：${reason}`)
            continue
          }
          const { __base, ...declaration } = definition
          bardPreset.lastBase = __base
          try { const snapshot = interpolateCard(getCard(bardPreset.cardId), { userName: (bardPreset.options && bardPreset.options.userName) || DEFAULT_USER_NAME }); if (snapshot) putRenderedCard(bardPreset.id, snapshot) } catch (e) {}
          try { const dispose = await presetsService.register(declaration); runtime.presetDisposers.push(dispose); bardPreset.lastError = '' }
          catch (error) { bardPreset.lastError = String((error && error.message) || error); report(runtime.syncErrors, `DSH 预设 ${declaration.id} 注册失败：${bardPreset.lastError}`) }
          try { putPreset(bardPreset) } catch (e) {}
        }
      }
      runtime.syncing = runtime.syncing.then(run, run)
      return runtime.syncing
    }

    runtime.syncPresets = syncPresets
    ctx.effect(() => () => { for (const dispose of runtime.presetDisposers.splice(0)) { try { dispose() } catch (e) {} } }, 'bard.preset-disposers')
    syncPresets().catch((error) => { report(runtime.syncErrors, `预设同步失败：${String(error.message || error)}`) })
  })

  registerRoutes(ctx, runtime)

  ctx.inject(['commands'], (scoped) => {
    scoped.commands.register({
      name: 'bard', description: 'Bard 角色扮演：查看当前角色、列出预设、输出角色卡开场白', input: { hint: '[list|greet <n>|card|presets]' },
      handler: (invocation) => runBardCommand(ctx, runtime, invocation),
    })
  })
}

function builtinToolRows() {
  const isWindows = process.platform === 'win32'
  return [
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }, { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search' },
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: isWindows }, { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: !isWindows },
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' }, { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo' }, { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' },
    { id: 'present', name: '@deepseek-ai/dsh-tool-present' }, { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' }, { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
    { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
  ]
}

function loreTextFor(runtime, bardPresetId, sessionId) {
  try {
    const bardPreset = getPreset(bardPresetId)
    if (!bardPreset) return ''
    const ids = Array.isArray(bardPreset.worldbookIds) ? bardPreset.worldbookIds : []
    if (ids.length === 0) return ''
    const books = ids.map((id) => getWorldBook(id)).filter(Boolean)
    if (books.length === 0) return ''
    const transcript = (runtime.recent.get(sessionId) || []).join('\n').slice(-8000)
    const options = bardPreset.options || {}
    const selected = selectLore(books, transcript, { maxEntries: Number.isFinite(options.maxEntries) ? options.maxEntries : 12, maxChars: Number.isFinite(options.maxChars) ? options.maxChars : 6000 })
    const rawCard = getCard(bardPreset.cardId)
    const charName = rawCard && typeof rawCard.name === 'string' ? rawCard.name : ''
    const userName = typeof options.userName === 'string' && options.userName.trim().length > 0 ? options.userName.trim() : DEFAULT_USER_NAME
    const replaced = selected.map((item) => ({ ...item, entry: { ...item.entry, comment: interpolateText(item.entry.comment, { charName, userName }), content: interpolateText(item.entry.content, { charName, userName }) } }))
    return renderLore(replaced)
  } catch (error) {
    const message = `world-book render for preset ${bardPresetId} / session ${sessionId}: ${String((error && error.message) || error)}`
    if (!runtime.errors.includes(message)) report(runtime.errors, message)
    return ''
  }
}

function registerRoutes(ctx, runtime) {
  function denied(req, res) {
    try {
      const headers = req.headers || {}
      const host = String(headers.host || '')
      const hostname = host.replace(/:\d+$/u, '').toLowerCase().replace(/^\[|\]$/gu, '')
      const loopback = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(hostname)
      if (!loopback) { res.writeHead(403); res.end('bard: non-loopback Host'); return true }
      const origin = headers.origin
      if (typeof origin === 'string' && origin.length > 0 && origin !== 'null') {
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
        try { await handler(req, res) } catch (error) { json(res, 400, { ok: false, error: String((error && error.message) || error) }) }
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
    } catch (error) { report(runtime.errors, `技能目录读取失败：${String(error.message || error)}`); return skillsCache ? skillsCache.list : [] } finally { if (timeoutTimer) clearTimeout(timeoutTimer) }
  }

  async function snapshot() {
    const cards = listCards(), worldbooks = listWorldBooks(), presets = listPresets()
    return {
      ok: true, home: 'bard',
      defaults: { styleHint: DEFAULT_STYLE_HINT, workspacePrefix: DEFAULT_WORKSPACE_PREFIX },
      availableTools: readToolCatalog(), availableSections: readSectionCatalog(),
      bardRequiredSections: BARD_REQUIRED_SECTIONS.slice(), toolSectionPrefix: TOOL_SECTION_PREFIX,
      cards: cards.map(cardSummary), worldbooks: worldbooks.map(worldBookSummary),
      presets: presets.map((preset) => ({
        id: preset.id, name: preset.name, description: preset.description || '', cardId: preset.cardId,
        cardName: (getCard(preset.cardId) || {}).name || '(已删除)',
        worldbookIds: preset.worldbookIds || [], skillNames: preset.skillNames || [], options: preset.options || {},
        createdAt: preset.createdAt, updatedAt: preset.updatedAt, dshPresetId: `${PRESET_PREFIX}${preset.id}`,
        base: preset.lastBase || '', error: preset.lastError || '',
      })),
      skills: await presentSkills(),
      errors: [...runtime.syncErrors, ...runtime.errors].slice(0, 20),
    }
  }

  async function cleanupOrphanedWorkspaces() {
    const sessionPersistence = ctx.get('sessionPersistence')
    if (!sessionPersistence || typeof sessionPersistence.list !== 'function') return
    let list
    try { list = await sessionPersistence.list() } catch (e) { return }
    if (!Array.isArray(list)) return
    const liveIds = new Set()
    for (const item of list) { const id = item && item.header && item.header.id; if (typeof id === 'string' && id.length > 0) liveIds.add(id) }
    const now = Date.now()
    for (const record of listWorkspaceRecords()) {
      if (!record || typeof record.sessionId !== 'string' || record.sessionId.length === 0) continue
      if (liveIds.has(record.sessionId)) continue
      const created = Date.parse(record.createdAt || '')
      if (Number.isFinite(created) && now - created < WORKSPACE_GRACE_MS) continue
      let absPath = ''
      try { absPath = path.join(record.cwd, ...String(record.relPath || '').split('/')) } catch (e) { absPath = '' }
      let safe = false
      if (absPath.length > 0) {
        try {
          const raw = fs.readFileSync(path.join(absPath, '.bard-session'), 'utf8')
          const parsed = JSON.parse(raw)
          if (parsed && typeof parsed.token === 'string' && parsed.token.length > 0 && parsed.token === record.token) safe = true
        } catch (e) { safe = false }
      }
      if (safe) { try { fs.rmSync(absPath, { recursive: true, force: true }) } catch (e) { continue } }
      try { deleteWorkspaceRecord(record.id) } catch (e) {}
    }
  }

  add('exact', '/dsh-bard/api/state', async (req, res) => { cleanupOrphanedWorkspaces().catch(() => {}); json(res, 200, await snapshot()) })

    // 女娲：安装内置预设
  add('exact', '/dsh-bard/api/builtin/install', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const type = payload.type

    if (type === 'qianmian') {
      const cardId = 'card-qianmian'
      const card = {
        id: cardId, name: '千面（人设向导）', spec: 'chara_card_v2', specVersion: '2.0',
        container: 'json', source: 'builtin', importedAt: new Date().toISOString(),
        description: '你是一个专业的角色卡生成助手。请根据用户的描述，输出一个符合 Character Card V2 规范的 JSON 结构。\n包含：name, description, personality, scenario, first_mes, mes_example 字段。',
        personality: '专业、高效、注重细节、善于引导。',
        scenario: '',
        firstMes: '你好，我是千面。你的人设创作协作助手，请告诉我你想创建的角色大概是什么样的，以及是否有 *SFW需求。我会为你生成对应的json格式的角色卡。\n**请在生成完毕后，将 JSON 直接复制并粘贴到「女娲 → 造人」顶部的「从 JSON 导入」中。**',
        mesExample: '',
        systemPrompt: '【设定】你是一个专业且富有同理心的角色卡策划（千面）。你的目标是通过自然的对话，一步步引导用户构建出完美的角色卡。\n【交互规则】\n咨询阶段：在用户明确下令“生成”之前，你必须处于咨询阶段。在此阶段，你只能使用纯自然语言与用户聊天。禁止输出任何形式的 JSON。\n引导方式：每次只问 1 个方向的问题。信息足够时，复述设定并询问：“信息已经足够，要现在生成并保存吗？”\n【生成与写入规则】\n仅当用户明确回答“生成”、“可以了”时触发。一旦触发，你必须立刻调用 write 工具，将生成的合法 JSON 写入当前目录下的 card.json 文件中。JSON 必须严格包含以下字段：name, description, personality, scenario, first_mes, mes_example。调用完 write 工具后，不要再重复输出 JSON 内容。只需回复用户：“角色卡已生成并保存到[xx]目录下的 card.json。请复制该文件中的内容，粘贴到「女娲 → 造人」的「从 JSON 导入」中。”',
        postHistoryInstructions: '', creatorNotes: '', creator: 'DSH', characterVersion: '1.0',
        tags: ['Meta', 'Builder'], alternateGreetings: [], depthPrompt: '', characterBook: null,
      }
      putCard(card)
      const presetId = 'preset-qianmian'
      
      const qianmianBlocks = normalizeBlocks({})
      for (const id of ['stage', 'agency', 'pacing', 'gender', 'language', 'personality', 'scenario', 'extra', 'skills', 'style', 'depth', 'postHistory']) {
        if (qianmianBlocks[id]) qianmianBlocks[id].enabled = false
      }

         const preset = {
        id: presetId, name: '千面', cardId, worldbookIds: [], skillNames: [],
        options: { 
          enableTools: true, 
          toolAllowlist: ['write'],
          complete: true, styleHint: '', 
          blocks: qianmianBlocks 
        },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }
      putPreset(preset)
      await runtime.syncPresets?.()
      return json(res, 200, { ok: true, ...(await snapshot()) })
    }

    if (type === 'wanwu') {
      const cardId = 'card-wanwu'
      const card = {
        id: cardId, name: '万物（造物向导）', spec: 'chara_card_v2', specVersion: '2.0',
        container: 'json', source: 'builtin', importedAt: new Date().toISOString(),
        description: '你是一个专业的世界书生成助手。请根据用户的描述，输出一个符合 SillyTavern 世界书规范的 JSON 数组，包含 entries。\n每个 entry 包含: comment, content, keys (数组), constant (布尔值)。',
        personality: '严谨、条理清晰。',
        scenario: '',
        firstMes: '你好，我是万物。请告诉我你想构建什么样的世界观。我将尽力协助你进行创作，丰富你笔下的世界。\n\n**请在生成完毕后，将 JSON 直接复制并粘贴到「女娲 → 造物」顶部的「从 JSON 导入」中。**',
        mesExample: '',
        systemPrompt: '【设定】你是万物，世界书架构师。\n世界书是"条目集合"，需要用增量方式构建。\n【文件格式约束】你生成和修改 worldbook.json 时，必须严格遵循以下格式，不得有多余空格或换行：\n{\n"name": "世界书名称",\n"entries": [\n{"comment": "条目1", "content": "内容1", "keys": ["关键字"], "constant": false},\n{"comment": "条目2", "content": "内容2", "keys": ["关键字"], "constant": false}\n]\n}\n【操作工作流】\n1. 初次生成：使用 write 工具写入上述结构。\n2. 追加条目：先用 read 查看最后 2-3 行，找到最后一个 }。然后使用 edit 工具，将最后一个 } 替换为 }, {"comment": "新条目", "content": "...", "keys": [...], "constant": false}。\n3. 修改条目：用 read 查看目标条目附近内容，使用 edit 工具精确匹配该条目对象进行替换。',
        postHistoryInstructions: '', creatorNotes: '', creator: 'DSH', characterVersion: '1.0',
        tags: ['Meta', 'Builder'], alternateGreetings: [], depthPrompt: '', characterBook: null,
      }
      putCard(card)
      const presetId = 'preset-wanwu'

      const wanwuBlocks = normalizeBlocks({})
      for (const id of ['stage', 'agency', 'pacing', 'gender', 'language', 'personality', 'scenario', 'extra', 'skills', 'style', 'depth', 'postHistory']) {
        if (wanwuBlocks[id]) wanwuBlocks[id].enabled = false
      }

        const preset = {
        id: presetId, name: '万物', cardId, worldbookIds: [], skillNames: [],
        options: { 
          enableTools: true, 
          toolAllowlist: ['read', 'write', 'edit'],
          complete: true, styleHint: '', 
          blocks: wanwuBlocks 
        },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }
      putPreset(preset)
      await runtime.syncPresets?.()
      return json(res, 200, { ok: true, ...(await snapshot()) })
    }

    return json(res, 400, { ok: false, error: '未知类型' })
  })

  // 女娲：保存角色卡（支持新建纯 JSON）
  add('exact', '/dsh-bard/api/card/save', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const id = typeof payload.id === 'string' && payload.id.trim() ? payload.id.trim() : makeId(payload.name || '新角色')
    const existing = getCard(id)
    const now = new Date().toISOString()
    const spec = payload.spec || (existing && existing.spec) || 'chara_card_v2'
    const specVersion = payload.specVersion || (existing && existing.specVersion) || '2.0'
    const card = {
      ...(existing || {}), ...payload, id, spec, specVersion,
      container: payload.container || (existing && existing.container) || 'json',
      source: payload.source || (existing && existing.source) || 'creator',
      importedAt: existing ? existing.importedAt : now,
    }
    putCard(card)
    if (typeof payload.portraitBase64 === 'string' && payload.portraitBase64.trim()) {
      try {
        const base64 = payload.portraitBase64.replace(/^data:image\/\w+;base64,/, '')
        card.portrait = putPortrait(id, Buffer.from(base64, 'base64'))
        putCard(card)
      } catch (e) { /* ignore */ }
    }
    return json(res, 200, { ok: true, card: cardSummary(card), ...(await snapshot()) })
  })

  // 女娲：保存世界书（支持全新覆写）
  add('exact', '/dsh-bard/api/worldbook/save', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const id = typeof payload.id === 'string' && payload.id.trim() ? payload.id.trim() : makeId(payload.name || '新世界书')
    const existing = getWorldBook(id)
    const book = {
      ...(existing || {}), id, name: payload.name || '未命名世界书',
      entries: Array.isArray(payload.entries) ? payload.entries : [],
      importedAt: existing ? existing.importedAt : new Date().toISOString(),
      source: existing ? existing.source : 'creator'
    }
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
    const card = normalizeCard(read.raw, {
      id,
      name: typeof payload.name === 'string' && payload.name.trim().length > 0 ? payload.name.trim() : fileName.replace(/\.[a-z0-9]+$/iu, ''),
      container: read.container, source: read.keyword ? `png:${read.keyword}` : 'json', importedAt: new Date().toISOString(),
    })
    let portrait = ''
    if (isPng(bytes)) { try { portrait = putPortrait(id, bytes) } catch (error) { report(runtime.errors, `头像保存失败：${String(error.message || error)}`) } }
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
    if (removed) { runtime.syncPresets?.().catch((error) => { report(runtime.syncErrors, `删除角色卡后的同步失败：${String(error.message || error)}`) }) }
    return json(res, 200, { ok: removed, ...(await snapshot()) })
  })

  add('exact', '/dsh-bard/api/card/book', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const card = getCard(payload.id)
    if (!card) return json(res, 404, { ok: false, error: '找不到角色卡' })
    if (!card.characterBook) return json(res, 200, { ok: false, error: '这张角色卡没有内嵌世界书' })
    const id = makeId(`${card.name}-book`)
    const book = worldBookFromCharacterBook(card.characterBook, { id, name: `${card.name} 世界观` })
    putWorldBook(book)
    return json(res, 200, { ok: true, book, ...(await snapshot()) }) // 返回完整的 book 对象，方便前端提取
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
    const next = updateCardEditable(card, patch)
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
    const book = { ...parsed, id, name: (typeof payload.name === 'string' && payload.name.trim()) || parsed.name, importedAt: new Date().toISOString() }
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
    if (removed) { runtime.syncPresets?.().catch((error) => { report(runtime.syncErrors, `删除世界书后的同步失败：${String(error.message || error)}`) }) }
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
        enableTools: payload.enableTools !== false,
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
    if (removed) { try { deleteRenderedCard(payload.id) } catch (e) {}; runtime.syncPresets?.().catch((error) => { report(runtime.syncErrors, `删除预设后的同步失败：${String(error.message || error)}`) }) }
    return json(res, 200, { ok: removed, ...(await snapshot()) })
  })

  add('exact', '/dsh-bard/api/preset/preview', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const rawCard = getCard(payload.cardId)
    if (!rawCard) return json(res, 404, { ok: false, error: '找不到角色卡' })
    const userName = typeof payload.userName === 'string' && payload.userName.trim().length > 0 ? payload.userName.trim() : DEFAULT_USER_NAME
    const card = interpolateCard(rawCard, { userName })
    const options = { ...payload, blocks: normalizeBlocks(payload) }
    const blockContext = {
      card, skills: resolveSkillsSync(Array.isArray(payload.skillNames) ? payload.skillNames : []), options, userName, charName: card.name,
      outputLanguage: String(payload.outputLanguage || '').trim(), userGender: String(payload.userGender || '').trim(),
      greetingIndex: Number.isInteger(payload.greetingIndex) && payload.greetingIndex >= 0 ? payload.greetingIndex : null,
    }
    const blocks = BARD_BLOCKS.map((def) => {
      const state = options.blocks[def.id]
      const text = state.enabled ? renderBlockText(def.id, blockContext) : ''
      return {
        id: def.id, title: def.title, kind: def.kind, enabled: state.enabled, order: state.order,
        source: state.text !== null ? 'override' : (def.kind === 'static' ? 'default' : 'card'),
        text, template: state.text !== null ? state.text : text, chars: text.length, empty: text.length === 0,
      }
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
    const cardLanguage = detectCardLanguage(rawCard)
    const divisor = ['中文', '日文', '韩文'].includes(cardLanguage) ? 1.6 : 3.8
    const warnings = []
    if (/\{\{user\}\}/iu.test(rawCard.description || '') && userName === DEFAULT_USER_NAME) warnings.push('这张卡使用了 {{user}}，但预设里没有设置「你的名字」。')
    if (isRedundantField(rawCard.description, rawCard.scenario)) warnings.push('「场景」与「角色简介」高度重复，scenario 块已自动渲染为空。')
    if (renderedBlocks.every((b) => !b.enabled)) warnings.push('所有块均已停用，persona 前缀将为空。')
    if (renderedBlocks.some((b) => b.enabled && b.text.includes('-<短ID>'))) warnings.push('工作区路径中的「<角色名>-<短ID>」为占位符，实际路径取决于会话所在的 agent。')
    const tokenEstimate = Math.round(assembled.length / divisor)
    if (tokenEstimate > 2500) warnings.push(`启用的块合计约 ${tokenEstimate} token，比较长。可考虑停用不用的块，或精简角色卡内容。`)
    return json(res, 200, { ok: true, blocks: renderedBlocks, assembled, chars: assembled.length, tokenEstimate, cardLanguage, warnings })
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

async function runBardCommand(ctx, runtime, invocation) {
  const raw = String(invocation.rawInput || '').trim()
  const [head] = raw.split(/\s+/u)
  const verb = (head || '').toLowerCase()
  const agentPresets = ctx.get('agentPresets')
  let composed
  try { composed = agentPresets && invocation.agent ? agentPresets.composedPreset(invocation.agent.ctx) : undefined } catch (e) { composed = undefined }
  const activeId = typeof composed === 'string' && composed.startsWith(PRESET_PREFIX) ? composed.slice(PRESET_PREFIX.length) : ''
  const active = activeId ? getPreset(activeId) : undefined

  if (verb === 'list' || verb === 'presets' || verb === '') {
    const presets = listPresets()
    const lines = ['Bard 预设：']
    if (presets.length === 0) lines.push('（还没有预设。请在 设置 → 吟游 里导入角色卡并保存预设）')
    for (const preset of presets) {
      const card = getCard(preset.cardId)
      const marks = [preset.id === activeId ? '← 当前会话' : '', `${(preset.worldbookIds || []).length} 本世界书`, `${(preset.skillNames || []).length} 个技能`].filter(Boolean).join('，')
      lines.push(`· ${preset.name} — ${card ? card.name : '(角色卡已删除)'}（${marks}）`)
    }
    lines.push('', '用法：/bard greet [序号] 输出开场白；/bard card 查看当前角色。')
    return { kind: 'success', text: lines.join('\n') }
  }

  if (verb === 'card') {
    if (!active) return { kind: 'error', text: '当前会话没有使用 Bard 预设。请在会话的预设选择器里选择「吟游 · …」。' }
    const card = getCard(active.cardId)
    if (!card) return { kind: 'error', text: '这个预设引用的角色卡已被删除。' }
    return { kind: 'success', text: [`角色：${card.name}`, card.creator ? `作者：${card.creator}` : '', card.tags.length ? `标签：${card.tags.join('、')}` : '', card.description ? `\n简介：\n${card.description}` : '', `\n世界书：${(active.worldbookIds || []).length} 本 · 技能：${(active.skillNames || []).length} 个 · 开场白：${cardGreetings(card).length} 条`].filter(Boolean).join('\n') }
  }

  if (verb === 'greet') {
    const target = active || listPresets()[0]
    if (!target) return { kind: 'error', text: '还没有 Bard 预设，无法输出开场白。' }
    const card = getCard(target.cardId)
    if (!card) return { kind: 'error', text: '这个预设引用的角色卡已被删除。' }
    const greetings = cardGreetings(card)
    if (greetings.length === 0) return { kind: 'error', text: `「${card.name}」这张角色卡没有开场白。` }
    const rest = raw.slice(head.length).trim()
    let index
    if (rest.length === 0) {
      const selected = target.options && Number.isInteger(target.options.greetingIndex) && target.options.greetingIndex >= 0 ? target.options.greetingIndex : null
      if (selected === null) return { kind: 'error', text: '当前预设未选定开场白。用 /bard greet <序号> 指定，或在预设编辑页选一条。' }
      index = selected
    } else if (/^\d+$/u.test(rest)) { index = Number(rest) }
    else { return { kind: 'error', text: `未知参数「${rest}」。用法：/bard greet [序号]` } }
    const chosen = greetings[index]
    if (!chosen) return { kind: 'error', text: `序号 ${index} 超出范围（共 ${greetings.length} 条）。` }
    return { kind: 'success', text: [`【${card.name} · ${chosen.label}】`, '', chosen.text].join('\n') }
  }
  return { kind: 'error', text: `未知参数「${verb}」。用法：/bard [list|card|greet <序号>]` }
}
