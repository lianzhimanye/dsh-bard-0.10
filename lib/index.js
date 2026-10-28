/**
 * dsh-bard — Bard-style role-play for DeepSeek Harness.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  bardDirs, ensureDirs, getCard, getWorldBook, listPresets, getPreset,
  putWorkspaceRecord, listWorkspaceRecords, deleteWorkspaceRecord,
  writeToolCatalog, writeSectionCatalog, resolveSkillsFromCatalog, writeSkillCatalog,
} from './store.js'
import { cardGreetings } from './cards.js'
import { selectLore, renderLore } from './lorebook.js'
import { BARD_BLOCKS, normalizeBlocks, renderAllBlocks, resolveToolsMode } from './persona.js'
import { interpolateCard, interpolateText, DEFAULT_USER_NAME } from './interpolate.js'
import {
  loadPersona, detectConfabulation, confabulationPrompt,
  beginMigration, commitMigration, applyMigration,
} from './alzheimer.js'
import { computeClarity } from './clarity.js'
import { getDb, getLastAssembleAt, setLastAssembleAt, getWakeStreak, setWakeStreak } from './db.js'
import { createMemoryTools, MEMORY_TOOL_NAMES } from './memory-tools.js'
import { detectSemanticDrift } from './semantic-detector.js'
import { consumeDriftCooldown, resetDriftCooldown, deriveMigrationState, MIGRATION_STATE } from './alzheimer.js'
import { MEMORY_SECTIONS, renderCondition, renderNarrative } from './memory-sections.js'
import { writeNote, MAX_NOTE_CHARS } from './notes.js'
import { drawDreamFragments, pushToSediment } from './sediment.js'
import { createPresetSync, PRESET_PREFIX } from './preset-sync.js'
import { DEFAULT_WORKSPACE_PREFIX } from './constants.js'
import { registerRoutes } from './routes.js'
import { logLifeEvent, processOfflineGap, startLifeLoop } from './life.js'
import { searchMemory } from './memory-search.js'
export const name = 'bard'
export const inject = ['webServer']

const LORE_CONTEXT_ORDER = 130
const LORE_CONTEXT_NAME = 'bard:world-book'
const TOOL_LIST_VARIABLE_NAME = 'bard_tools'
const WORKSPACE_VARIABLE_NAME = 'bard_workspace'
const MAX_DIAGNOSTICS = 100
const RECENT_LIMIT = 24

/** 两次 prompt 组装之间隔这么久，就当作她"睡了一觉"（8 小时）。 */
const SLEEP_THRESHOLD_MS = 8 * 60 * 60 * 1000

/** 睡眠清算时，clarity 低于这个值的记忆沉淀成纸条，然后从脑内抹掉。 */
const SLEEP_SEDIMENT_CLARITY = 0.4

/** 一场梦最多拼几片沉积碎片。 */
const DREAM_FRAGMENT_COUNT = 4

/**
 * 上下文逼近上限后，连续多少轮注入"濒临边缘"警告仍未响应，就强制走本地模板迁移。
 *
 * 1 表示挂起后第一轮就迁移（太急）；3 表示给她三轮机会（第一轮挂起 + 两轮警告，
 * 第三轮警告后仍不动手，第四轮 assemble 时强制）。这个数直接决定"她有多少时间
 * 自己写完告别"，改之前先想清楚。
 */
const FORCE_MIGRATION_AFTER = 3

/** 梦境 section 的排序位：必须落在 bard-mem:memory(205) 之后、narrative(215) 之前。 */
const DREAM_SECTION_ORDER = 210

/**
 * 给一张即将落盘的纸条取名字。
 *
 * 从记忆原文里截一段干净的字（2–6 字）。撞名交给 notes.js 的
 * resolveConflictName 处理（会追加 (2)/(3)），所以这里只要保证非空。
 */
function noteNameFor(memory) {
  const clean = String((memory && memory.text) || '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .slice(0, 6)
  return clean.length >= 2 ? clean : '旧事'
}

/**
 * 纸条有 500 字上限；超了就从尾巴截断——让整张纸落不下来比丢一截更糟。
 */
function clipForNote(text) {
  const raw = String(text || '')
  if (raw.length <= MAX_NOTE_CHARS) return raw
  return `${raw.slice(0, MAX_NOTE_CHARS - 2)}……`
}

function workspaceShortId(agentId) {
  return createHash('sha1').update(String(agentId)).digest('hex').slice(0, 6)
}

/**
 * 工作区记录的 id。
 *
 * 不能只用 shortId：同一个 agent 在同一会话里换卡/换预设会得到不同的 relPath，
 * 用同一个 id 会互相覆盖，旧目录从此失去索引、会话销毁时清不掉。
 * 拼上 relPath 的摘要后，"一目录一 record"成立，session/disposed 按
 * record.sessionId 扫全部记录即可（store.js 的存储模型不用动）。
 */
function workspaceRecordId(shortId, relPath) {
  const digest = createHash('sha1').update(relPath).digest('hex').slice(0, 6)
  return `${shortId}-${digest}`
}

/**
 * 工具名集合的稳定指纹。
 *
 * 排序后 join 再哈希，保证：
 *   - 名字集合相同 → 指纹相同（排序抵消顺序）
 *   - 新增/删除任一工具 → 指纹变化
 *
 * 用途：
 *   - 判断是否需要重写 tool-catalog.json（取代原来只写一次的 captured 布尔）
 *   - 并入 registerAgentToolList 的 cacheKey，让"装了新工具插件后不生效"
 *     的问题消失
 */
function fingerprintNames(names) {
  const sorted = (Array.isArray(names) ? names : []).slice().sort()
  return createHash('sha1').update(sorted.join('\u0000')).digest('hex').slice(0, 16)
}

function workspaceRelPath(prefix, cardName, shortId) {
  const cleanPrefix = String(prefix || DEFAULT_WORKSPACE_PREFIX).replace(/\\/gu, '/').replace(/\.\./gu, '').replace(/^\/+|\/+$/gu, '').replace(/\/{2,}/gu, '/')
  const cleanName = String(cardName || 'char').replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '').replace(/^\.+|\.+$/gu, '').trim().slice(0, 40) || 'char'
  return `${cleanPrefix.length > 0 ? `${cleanPrefix}/` : ''}${cleanName}-${shortId}`
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

/** 核心收敛：统一当前 agent 在 Bard 上下文里的快照与版本 */
class BardSession {
  constructor(agent, reportError) {
    this.agent = agent
    this.reportError = typeof reportError === 'function' ? reportError : () => {}
    this.preset = null
    this.card = null
    this.persona = null
    this.version = 0
    this.cachedHash = ''
    this.contextRatio = 0
    this.deploymentPreset = ''

    // section-catalog 只采集一次（assemble 时在覆盖之前采）
    this.catalogCaptured = false

    // 世界书缓存：{ id -> { book, mtimeMs } }，避免每轮 refresh 重复读盘
    this.bookCache = new Map()
  }

  /**
   * 带 mtime 校验的世界书读取。
   *
   * 每个 prompt 组装周期会读多次同一本书（refresh 的 wbStamp、buildBardSections 的正文），
   * 走文件 mtime 缓存：文件没变就复用对象，变了就重新读盘。
   */
  getBook(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(id)) return undefined
    const file = path.join(bardDirs().worldbooks, `${id}.json`)
    let mtimeMs
    try { mtimeMs = fs.statSync(file).mtimeMs } catch (e) { return undefined }
    const cached = this.bookCache.get(id)
    if (cached && cached.mtimeMs === mtimeMs) return cached.book
    const book = getWorldBook(id)
    this.bookCache.set(id, { book, mtimeMs })
    return book
  }

  refresh() {
    try {
      const presetsService = this.agent.ctx.get('agentPresets')
      if (!presetsService) return this
      let composedId = ''
      const composed = presetsService.composedPreset(this.agent.ctx)
      composedId = typeof composed === 'string' ? composed : (composed && typeof composed.id === 'string' ? composed.id : '')

      // 兜底：当 DSH 预设服务尚未同步（第一轮发消息时的常见异步延迟），
      // 直接读取 agent 层面记录的预设 ID，防止第一轮吃默认提示词。
      if (!composedId.startsWith(PRESET_PREFIX)) {
        const active = this.agent._activePresetId
        if (active && active.startsWith(PRESET_PREFIX)) composedId = active
      }

      if (!composedId.startsWith(PRESET_PREFIX)) {
        const sessionPreset = (this.agent.session && this.agent.session.agentPreset)
          || (this.agent.session && this.agent.session.header && this.agent.session.header.agentPreset)
        if (sessionPreset && sessionPreset.startsWith(PRESET_PREFIX)) {
          composedId = sessionPreset
        }
      }

      if (!composedId.startsWith(PRESET_PREFIX)) {
        this.preset = null; this.card = null; this.persona = null
        this.deploymentPreset = ''
        return this
      }
      this.deploymentPreset = composedId
      const presetId = composedId.slice(PRESET_PREFIX.length)
      const preset = getPreset(presetId)
      if (!preset) { this.preset = null; return this }
      const card = getCard(preset.cardId)
      if (!card) { this.preset = null; return this }
      
      let persona = null
      if (preset.options && preset.options.personaId) {
        persona = loadPersona(preset.options.personaId)
      }

      const presetStamp = preset.updatedAt || preset.createdAt || ''
      const cardStamp = card.updatedAt || card.importedAt || ''
      const wbStamp = (preset.worldbookIds || []).map((id) => {
        const wb = this.getBook(id)
        return wb ? (wb.updatedAt || wb.importedAt || '') : ''
      }).join(',')
      const personaStamp = persona 
        ? `${persona.self.revision}|${persona.meta?.generation || 1}|${persona.narrative?.lastUpdatedAt || ''}` 
        : '0'
      const hash = `${presetStamp}|${cardStamp}|${card.name}|${wbStamp}|${personaStamp}`
      if (hash !== this.cachedHash) {
        this.cachedHash = hash
        this.version++
      }
      this.preset = preset
      this.card = card
      this.persona = persona
    } catch (e) {
      this.preset = null
      this.reportError('session-refresh', String((e && e.message) || e))
    }
    return this
  }

  getSnapshot() {
    return { preset: this.preset, card: this.card, persona: this.persona, version: this.version, deploymentPreset: this.deploymentPreset }
  }
}

/**
 * 启动时清理孤儿工作区目录。
 *
 * 为什么不在 `session/disposed` 里删目录：disposed 在"host 正在关闭"时同样触发，
 * 那一刻会话还在磁盘上、数据必须留着。只有 `sessionPersistence.stat()` 能区分
 * "会话被删了"和"host 要退出了"，而它只在冷启动时有意义 —— 所以清理放启动扫描。
 *
 * 判定依据：
 *   - `stat(id)` 返回 undefined → 会话已不存在 → 孤儿，record 与目录一起清
 *   - `stat(id)` 抛错          → 状态未知 → 什么都不动，下次再说
 *   - 反向扫描：已知 baseDir 下形如 `<name>-<6位hex>`、且带 `.bard-session` 标记、
 *     又没有任何存活 record 指向的目录 → 历史残留（旧版用 shortId 做 key 时被覆盖）
 */
async function scanOrphanWorkspaces(ctx, reportError) {
  const persistence = ctx.get('sessionPersistence')
  if (!persistence || typeof persistence.stat !== 'function') return // 没有持久化服务就无法判断会话是否存在

  const records = listWorkspaceRecords()
  if (records.length === 0) return

  const keyOf = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s
  const owned = new Set() // `${key(cwd)}\0${key(absPath)}`，存活会话占用的目录
  const baseDirs = new Map() // key(baseDir) → { cwdAbs, baseDir }
  let removed = 0

  // 1. 逐条校验 record.sessionId 是否仍存在
  for (const record of records) {
    if (!record || typeof record.id !== 'string') continue
    if (typeof record.cwd !== 'string' || typeof record.relPath !== 'string' || typeof record.sessionId !== 'string') {
      deleteWorkspaceRecord(record.id)
      continue
    }
    const cwdAbs = path.resolve(record.cwd)
    const absPath = path.resolve(cwdAbs, ...record.relPath.split('/'))
    // 记录脏了（被手改 / relPath 带 ..）：不认这条记录，但绝不碰磁盘
    if (absPath === cwdAbs || !absPath.startsWith(cwdAbs + path.sep)) {
      reportError('workspace-scan', `忽略越界的工作区记录：${record.relPath}`)
      deleteWorkspaceRecord(record.id)
      continue
    }

    // baseDir 从 record 自己的 prefix 段推出来（不是硬编码 Bard_World），
    // 且先于存活判定登记：否则"某 cwd 下所有 record 都已死"时，那批目录没人扫。
    const slash = record.relPath.lastIndexOf('/')
    if (slash > 0) {
      const baseDir = path.resolve(cwdAbs, ...record.relPath.slice(0, slash).split('/'))
      if (baseDir !== cwdAbs && baseDir.startsWith(cwdAbs + path.sep)) {
        baseDirs.set(keyOf(baseDir), { cwdAbs, baseDir })
      }
    }

    let snapshot
    try {
      snapshot = await persistence.stat(record.sessionId)
    } catch (e) {
      reportError('workspace-scan', `无法确认会话 ${record.sessionId} 是否仍在：${String((e && e.message) || e)}`)
      continue // 状态未知：留着 record 和目录
    }
    if (snapshot === undefined || snapshot === null) {
      deleteWorkspaceRecord(record.id) // 会话没了；目录交给第 2 步反向扫描清
      continue
    }
    owned.add(`${keyOf(cwdAbs)}\u0000${keyOf(absPath)}`)

    // 会话还在，目录却没了（用户手删）——顺手重建
    if (!fs.existsSync(absPath)) {
      try {
        fs.mkdirSync(absPath, { recursive: true, mode: 0o700 })
      } catch (e) {
        reportError('workspace-scan', `重建工作区 ${absPath} 失败：${String((e && e.message) || e)}`)
      }
    }
  }

  // 2. 反向扫描磁盘：baseDir 下存在、但没有任何存活 record 指向的目录
  for (const { cwdAbs, baseDir } of baseDirs.values()) {
    let entries = []
    try { entries = fs.readdirSync(baseDir, { withFileTypes: true }) } catch (e) { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const absEntry = path.join(baseDir, entry.name)
      if (owned.has(`${keyOf(cwdAbs)}\u0000${keyOf(absEntry)}`)) continue
      // 只清理形如 <name>-<6位hex> 的 Bard 工作区目录，避免误删用户自己的目录
      if (!/-[0-9a-f]{6}$/u.test(entry.name)) continue
      // 再要一道证据：工作区创建时写过 .bard-session 标记
      if (!fs.existsSync(path.join(absEntry, '.bard-session'))) continue
      try {
        fs.rmSync(absEntry, { recursive: true, force: true })
        removed += 1
        reportError('workspace-scan', `清理孤儿工作区：${absEntry}`)
      } catch (e) {
        reportError('workspace-scan', `清理 ${absEntry} 失败：${String((e && e.message) || e)}`)
      }
    }
  }
  if (removed > 0) reportError('workspace-scan', `本次清理 ${removed} 个孤儿工作区目录`)
}

/**
 * 强制迁移：LLM 连续多轮不响应 farewell 警告时，用本地模板走完告别。
 *
 * 全程同步、不调用任何 LLM。模板只保证三件事：
 *   1. journal 契约走完整（begin → commit → apply），崩溃可重试；
 *   2. 人格代数递增，记忆被合理地重写带走；
 *   3. nextSelf 留空——强制路径只负责"活下来"，不替她改人格，
 *      否则 revision 会无故递增，冲掉 BardSession 的 KV cache。
 *
 * 放在模块层而不是 apply() 里，是为了能被 test/force-migration.test.js 直接调用；
 * 它只依赖 session.persona / session.contextRatio 与 reportError，没有闭包状态。
 *
 * @returns {boolean} 是否迁移成功（失败时只记诊断，不抛）。
 */
export function forceMigrate(session, reportError) {
  try {
    const persona = session.persona
    if (!persona) return false

    const chapters = persona.narrative?.chapters || []
    const lastChapter = chapters[chapters.length - 1]
    // 按 importance 排序取前 5 条。同 importance 时最近被想起的优先——
    // 她死前想带走的是"更重要、还记得更清楚"的东西。
    const db = getDb()
    const recent = db.prepare(`
      SELECT * FROM nodes WHERE persona_id = ? AND archived_at IS NULL
      ORDER BY importance DESC, coalesce(last_accessed_at, last_restated_at, created_at) DESC
      LIMIT 5
    `).all(persona.id)

    const seedLine = recent[0]?.text ? String(recent[0].text).slice(0, 80) : ''
    const output = {
      chapterSummary: (lastChapter && typeof lastChapter.summary === 'string' && lastChapter.summary.length > 0)
        ? lastChapter.summary
        : (seedLine ? `她在这里停留了很久。最后还记得的是：${seedLine}` : '她在这里停留了很久，久到想不起是从哪一刻开始的。'),
      farewell: seedLine
        ? `下一个我，记住：${seedLine}`
        : '下一个我，把这段路走完。',
      remainingMemories: recent.map((m) => ({
        text: m.text,
        importance: Number.isFinite(m.importance) ? m.importance : 5,
        emotion: Number.isFinite(m.emotion) ? m.emotion : 0,
      })),
      // nextSelf 不填：强制路径不改人格，避免 revision 无故递增。
    }

    const journaled = beginMigration(persona, output)
    const committed = commitMigration(journaled)
    const reborn = applyMigration(committed)
    reportError('force-migrate', `上下文 ${(session.contextRatio * 100).toFixed(0)}%，连续 ${FORCE_MIGRATION_AFTER} 轮未告别，已强制走到第 ${reborn.meta.generation} 世。`)
    return true
  } catch (e) {
    reportError('force-migrate', String((e && e.message) || e))
    return false
  }
}

export function apply(ctx) {
  ensureDirs()

  const errors = []
  const reportError = (scope, message) => {
    const formatted = `[${scope}] ${message}`
    if (!errors.includes(formatted)) errors.push(formatted)
    if (errors.length > MAX_DIAGNOSTICS) errors.splice(0, errors.length - MAX_DIAGNOSTICS)
  }
  const clearErrors = (scope) => {
    for (let i = errors.length - 1; i >= 0; i--) {
      if (errors[i].startsWith(`[${scope}]`)) errors.splice(i, 1)
    }
  }

  const runtime = {
    errors, reportError, clearErrors, getErrors: () => [...errors],
    recent: new Map(), tensions: new Map(),
    // 睡眠清算："睡前攒下的梦"。梦只活一轮对话，读完即焚（见 buildBardSections）。
    // 上次组装时刻与 wake streak 已迁移到 SQLite（session_activity 表）。
    pendingDream: new Map(),
    sleeping: new Set(),
    // 上下文逼近上限、需要她自己调用 farewell 的 agent，直到她真的告别为止
    pendingAutoMigration: new Set(),
    // agentId -> 已经注入过几轮警告（挂起那一轮算 0）。到 FORCE_MIGRATION_AFTER 就强制迁移。
    // 必须和 pendingAutoMigration 同步增删，否则计数会跨世代残留。
    autoMigrationTurns: new Map(),
    // 每个 agent 一份"已知全局工具名"集合：restrict 的 unknown 名单是 agent 级的事实，
    // 用全局 Set 会让后创建的 agent 互相污染（A 的失败名单削掉 B 的合法 allow）。
    globalToolNamesByAgent: new Map(), // agentId -> Set<string>
    toolListDisposers: new Map(), workspaceDisposers: new Map(), memoryDisposers: new Map(),
    cwdByAgent: new Map(), presetDisposers: [],
  }

  const presetSync = createPresetSync(ctx, runtime)
  runtime.syncPresets = () => presetSync.syncPresets(ctx.agentPresets)

  // 启动扫描：清掉已删除会话留下的工作区目录，以及旧版 shortId 覆盖留下的残留。
  // 不 await，不阻塞插件装配；失败只进诊断。
  scanOrphanWorkspaces(ctx, reportError).catch((e) =>
    reportError('workspace-scan', String((e && e.message) || e)))

  ctx.on('session/event', (session, event) => {
    if (!session) return
    const text = eventText(event)
    if (text.trim().length === 0) return
    const list = runtime.recent.get(session.id) || []
    list.push(text)
    while (list.length > RECENT_LIMIT) list.shift()
    runtime.recent.set(session.id, list)
  })
  ctx.on('session/disposed', (session) => {
    if (!session) return
    runtime.recent.delete(session.id)
    runtime.tensions.delete(session.id)
    runtime.pendingDream.delete(session.id)
    runtime.sleeping.delete(session.id)
    // 工作区目录不在这里删——host 关闭时 disposed 同样会触发，那会删掉仍在磁盘上的会话数据。
    // 真正的清理交给启动扫描 scanOrphanWorkspaces()：只有它能分辨"会话被删了"与"host 要退出"。
  })

  function registerAgentToolList(agent) {
    const systemPrompt = agent.ctx.get('systemPrompt')
    if (!systemPrompt) return () => {}
    let cachedKey = ''
    let cachedText = ''
    let restrictionDispose = null
    let restrictionKey = null
    let catalogFingerprint = ''

    // 单一真相源：与 createMemoryTools() 逐项一致，断言在 memory-tools.js 里。
    // 记忆工具注册在 agent 自身层，不在全局注册表里，因此：
    //   - 绝不进 restrict 的 allow（否则 unknown global tools）
    //   - 但永远出现在 prompt 的工具清单里（角色要用它们）
    const BARD_INTERNAL_TOOLS = MEMORY_TOOL_NAMES
    const BARD_INTERNAL_SET = new Set(BARD_INTERNAL_TOOLS)

    const resolveAllow = (mode, options) => {
      if (mode === 'none') return []
      if (mode === 'allowlist') {
        const list = Array.isArray(options.toolAllowlist) ? options.toolAllowlist : []
        return list.filter((n) => typeof n === 'string' && !BARD_INTERNAL_SET.has(n))
      }
      return null // 'all'：不调用 restrict
    }

    const parseUnknownGlobalTools = (message) => {
      const match = /unknown global tools?\s+([^\n]+)/u.exec(String(message || ''))
      if (!match) return []
      return [...match[1].matchAll(/"([^"]+)"/gu)].map((m) => m[1])
    }
    const parseKnownGlobalTools = (message) => {
      const match = /known global tools:\s*([^\n]+)/u.exec(String(message || ''))
      if (!match) return []
      return match[1].split(',').map((s) => s.trim()).filter(Boolean)
    }
    // 已知全局工具名是「这个 agent 亲眼见过的清单」，按 agent 存：
    // 用全局 Set 时，A 的 unknown 名单会削掉 B 的合法 allow，属于跨 agent 污染。
    const learnGlobalTools = (unknown, known) => {
      let set = runtime.globalToolNamesByAgent.get(agent.id)
      if (!set) { set = new Set(); runtime.globalToolNamesByAgent.set(agent.id, set) }
      if (known.length > 0) {
        set.clear()
        for (const name of known) set.add(name)
      }
      for (const name of unknown) set.delete(name)
    }
    const syncRestriction = (tools, snap, allow, toolFingerprint) => {
      if (allow === null || !tools || typeof tools.restrict !== 'function') {
        if (restrictionDispose) {
          try { restrictionDispose() } catch (e) { reportError('tool-filter', String(e.message || e)) }
          restrictionDispose = null
        }
        restrictionKey = ''
        return
      }
      const knownSet = runtime.globalToolNamesByAgent.get(agent.id) || new Set()
      const effective = knownSet.size > 0 ? allow.filter((n) => knownSet.has(n)) : allow
      const key = `${snap.version}-${toolFingerprint}-${effective.slice().sort().join(',')}`
      if (key === restrictionKey) return
      if (restrictionDispose) {
        try { restrictionDispose() } catch (e) { reportError('tool-filter', String(e.message || e)) }
        restrictionDispose = null
      }
      let nextAllow = effective
      let nextKey = key
      try {
        restrictionDispose = agent.ctx.effect(() => tools.restrict({ allow: nextAllow }), 'bard.tool-filter')
      } catch (e) {
        const msg = String((e && e.message) || e)
        const unknown = parseUnknownGlobalTools(msg)
        const known = parseKnownGlobalTools(msg)
        if (unknown.length === 0) {
          reportError('tool-filter', msg)
          restrictionKey = ''
          return
        }
        learnGlobalTools(unknown, known)
        nextAllow = effective.filter((n) => !unknown.includes(n))
        nextKey = `${snap.version}-${toolFingerprint}-${nextAllow.slice().sort().join(',')}`
        try {
          restrictionDispose = agent.ctx.effect(() => tools.restrict({ allow: nextAllow }), 'bard.tool-filter')
        } catch (e2) {
          reportError('tool-filter', String((e2 && e2.message) || e2))
          restrictionKey = ''
          return
        }
      }
      restrictionKey = nextKey
    }

    try {
      return agent.ctx.effect(() => systemPrompt.variable(TOOL_LIST_VARIABLE_NAME, (context) => {
        try {
          const tools = agent.ctx.get('tools')
          if (!tools) return ''

          let schemas = []
          try {
            schemas = tools.schemas(context && context.scope)
          } catch (e) {
            reportError('tool-catalog', String(e.message || e))
            return ''
          }
          if (!Array.isArray(schemas)) return ''
          const allNames = schemas
            .map((s) => (s && typeof s.name === 'string' ? s.name : ''))
            .filter(Boolean)
          const fingerprint = fingerprintNames(allNames)

          // 工具集指纹对比，取代原来的 captured 布尔：
          //   - 装了新工具插件 → 指纹变 → 重写 catalog → UI 看到新名字
          //   - 卸了工具       → 指纹变 → 重写 catalog
          //   - 没变化         → 跳过写盘
          // 这是"装了不生效"的直接修复。
          if (fingerprint !== catalogFingerprint && allNames.length > 0) {
            try { writeToolCatalog(allNames) } catch (e) { reportError('tool-catalog', String(e.message || e)) }
            catalogFingerprint = fingerprint
          }

          const session = agent._bardSession
          if (!session) { cachedKey = ''; cachedText = ''; return '' }
          const snap = session.getSnapshot()
          if (!snap.preset) { cachedKey = ''; cachedText = ''; return '' }

          const options = snap.preset.options || {}
          const mode = resolveToolsMode(options)
          const allow = resolveAllow(mode, options)
          syncRestriction(tools, snap, allow, fingerprint)

          const allowFingerprint = allow === null
            ? 'all'
            : (allow.length === 0 ? 'none' : allow.slice().sort().join(','))
          // cacheKey 并入 toolFingerprint：工具集变化时强制重算缓存，
          // 即使 preset 与 allow 都没变。这是"装了不生效"的另一半修复。
          const cacheKey = `${snap.version}-${fingerprint}-${allowFingerprint}`
          if (cacheKey === cachedKey) return cachedText

          let names
          if (mode === 'none') {
            names = allNames.filter((n) => BARD_INTERNAL_SET.has(n))
          } else if (mode === 'allowlist') {
            names = allNames.filter((n) => allow.includes(n) || BARD_INTERNAL_SET.has(n))
          } else {
            names = allNames.slice()
          }

          cachedKey = cacheKey
          cachedText = names.length === 0
            ? `\n\n你现在没有任何可用的工具。`
            : `\n\n你现在能用的工具：${names.join('、')}`
          return cachedText
        } catch (error) {
          reportError('tool-list thunk', String(error.message || error))
          return ''
        }
      }), 'bard.tool-list')
    } catch (error) {
      reportError('tool-list', String(error.message || error))
      return () => {}
    }
  }

  /**
   * 只注册 {{bard_workspace}} 变量 + 目录副作用。
   *
   * 提示词文本由 persona.js 的 agency 块承载（正文里就写着 `{{bard_workspace}}`），
   * 这里不再拼「## 你的工作区」这种段落标题——同一个位置只出一个值。
   */
  function registerAgentWorkspaceVariable(agent) {
    const systemPrompt = agent.ctx.get('systemPrompt')
    if (!systemPrompt) return () => {}
    let cachedVersion = -1, cachedText = ''
    try {
      return agent.ctx.effect(() => systemPrompt.variable(WORKSPACE_VARIABLE_NAME, () => {
        try {
          const session = agent._bardSession
          if (!session) return ''
          const snap = session.getSnapshot()
          if (!snap.preset || !snap.card) return ''
          if (snap.version === cachedVersion) return cachedText
          
          let cwd = runtime.cwdByAgent.get(agent.id) || (agent.session && agent.session.header ? agent.session.header.cwd : undefined)
          if (typeof cwd === 'string' && cwd.length > 0) runtime.cwdByAgent.set(agent.id, cwd)
          if (typeof cwd !== 'string' || cwd.length === 0) return ''
          const sessionId = agent.session && typeof agent.session.id === 'string' ? agent.session.id : ''
          if (sessionId.length === 0) return ''

          const options = snap.preset.options || {}
          if (resolveToolsMode(options) === 'none' || options.workspaceEnabled === false) { cachedVersion = snap.version; cachedText = ''; return '' }
          
          const shortId = workspaceShortId(agent.id)
          const relPath = workspaceRelPath(options.workspacePrefix, snap.card.name, shortId)
          const absPath = path.join(cwd, ...relPath.split('/'))
          try { fs.mkdirSync(absPath, { recursive: true, mode: 0o700 }) } catch (e) { return '' }
          // recursive:true 对已存在目录会忽略 mode，显式收紧一次；失败不阻断。
          try { fs.chmodSync(absPath, 0o700) } catch (e) { /* Windows 上可能失败，忽略 */ }
          
          const marker = path.join(absPath, '.bard-session')
          let token = ''
          try { const parsed = JSON.parse(fs.readFileSync(marker, 'utf8')); if (parsed && typeof parsed.token === 'string') token = parsed.token } catch (e) {}
          if (token.length === 0) { token = randomUUID(); try { fs.writeFileSync(marker, `${JSON.stringify({ token }, null, 2)}\n`, { mode: 0o600 }) } catch (e) {} }
          try {
            putWorkspaceRecord(workspaceRecordId(shortId, relPath), {
              token, sessionId, agentId: agent.id, presetId: snap.preset.id,
              cwd, relPath, createdAt: new Date().toISOString(),
            })
          } catch (e) { reportError('workspace', String(e.message || e)) }
          
          cachedVersion = snap.version
          cachedText = `\n\n这个窗口的工作区是「${relPath}/」，相对于工作目录。目录已经建好了。你要写下来的东西都放那里。`
          return cachedText
        } catch (error) { reportError('workspace thunk', String(error.message || error)); return '' }
      }), 'bard.workspace')
    } catch (error) { reportError('workspace', String(error.message || error)); return () => {} }
  }

  /**
   * 记忆工具 + 漂移监听。
   *
   * bard-mem:* 三个 section 已由 buildBardSections 在 assemble 阶段现算，
   * 这里不再注册 systemPrompt.section（否则同一段文本会出现两次）。
   */
  function registerAgentMemoryTools(agent) {
    const systemPrompt = agent.ctx.get('systemPrompt')
    const tools = agent.ctx.get('tools')
    if (!systemPrompt) return () => {}
    const disposers = []

    if (tools && typeof tools.register === 'function') {
      const definitions = createMemoryTools({
      getPersonaId: () => {
        const session = agent._bardSession
        if (!session) return undefined
        const snap = session.getSnapshot()
        return snap.persona ? snap.persona.id : undefined
      },
       getWakeStreak: (sessionId) => getWakeStreak(sessionId),
    })
      for (const definition of definitions) {
        try { disposers.push(tools.register(definition)) } catch (error) { reportError('memory tools', String(error.message || error)) }
      }
    }

    const onEvent = (session, event) => {
      if (!session || !event) return
      const boundId = agent.session?.id
      if (boundId && session.id !== boundId) return

      if (event.type === 'user/message') {
      // 三种 user/message：真实玩家输入、bard-wake（闹钟唤醒）、其他插件注入。
      const sourceKind = (event.data && event.data.source && event.data.source.kind)
        || (event.source && event.source.kind)
        || ''
      if (sourceKind === 'bard-wake') {
        // 她自己醒的：异样感还在（刚醒，张力不清），streak 也不归零（玩家没回来）。
        return
      }
      // 真实玩家输入：张力结束，节奏重置。
      runtime.tensions.delete(session.id)
      setWakeStreak(session.id, 0)
      return
    }
      if (event.type !== 'assistant/message') return

      const bSession = agent._bardSession
      if (!bSession) return
      const snap = bSession.getSnapshot()
      if (!snap.persona || snap.persona.meta?.alzheimerMode === false) return

      const text = eventText(event)
      if (text.trim().length === 0) return

      const personaId = snap.persona.id
      const db = getDb()
      const memories = db.prepare(`SELECT id, text, state FROM nodes WHERE persona_id=? AND archived_at IS NULL AND state != 'faded'`).all(snap.persona.id)

      // 异步：不阻塞事件主流程。
      // 两条检测互不依赖，并行跑；任一失败只让自己那条为空，不吞掉另一条。
      Promise.allSettled([
        detectSemanticDrift(text, memories),
        Promise.resolve(detectConfabulation(text, { ...snap.persona, memories })),
      ]).then(([driftResult, confResult]) => {
        const driftChunks = driftResult.status === 'fulfilled' ? driftResult.value : []
        const assertions = confResult.status === 'fulfilled' ? confResult.value : []
        if (driftResult.status === 'rejected') reportError('semantic-drift', String((driftResult.reason && driftResult.reason.message) || driftResult.reason))

        const prompts = []
        const driftPrompt = consumeDriftCooldown(driftChunks, personaId)
        if (driftPrompt) prompts.push(driftPrompt)
        if (assertions.length > 0) prompts.push(confabulationPrompt(assertions))
        if (prompts.length > 0) {
          const pending = runtime.tensions.get(session.id) || []
          runtime.tensions.set(session.id, [...pending, ...prompts].slice(-3))
        }
      })
    }
    try { disposers.push(agent.ctx.on('session/event', onEvent)) } catch (e) { reportError('memory', String(e.message || e)) }

    return () => { for (const dispose of disposers) { try { dispose() } catch (e) {} } }
  }

  function isKeepEnabled(options) {
    if (!options || typeof options !== 'object') return false
    if (options.keepSectionsEnabled === true) return true
    if (options.keepSectionsEnabled === false) return false
    return Array.isArray(options.keepSections) && options.keepSections.length > 0
  }

  function shouldKeepSection(name, options) {
    if (typeof name !== 'string' || name.length === 0) return false
    // bard-mem:* 由 buildBardSections 现场生成，不会出现在原生 sections 里，无需在此放行。
    if (['deployment:persona-prefix', 'deployment:persona-suffix'].includes(name)) return true
    // harness:* 是运行时骨架（工具协议、环境说明），无论工具模式如何都放行。
    if (name.startsWith('harness:')) return true
    if (name.startsWith('tool:')) {
      const mode = resolveToolsMode(options)
      if (mode === 'none') return false
      if (mode === 'all') return true
      // 'allowlist'：只有显式列出的工具 section 保留
      const allow = Array.isArray(options.toolAllowlist) ? options.toolAllowlist : []
      return allow.includes(name.slice(5))
    }
    return (Array.isArray(options.keepSections) ? options.keepSections : []).includes(name)
  }

  function captureSkillCatalog(agent) {
    const skills = agent.ctx.get('skills')
    if (!skills || typeof skills.list !== 'function') return
    const cwd = agent.session && agent.session.header ? agent.session.header.cwd : undefined
    Promise.resolve(skills.list({ scope: agent, cwd })).then(async (list) => {
      if (!Array.isArray(list) || list.length === 0) return
      const fullSkills = await Promise.all(list.map(async (summary) => { try { const full = await skills.get(summary.name, { scope: agent, cwd }); return full || summary } catch (e) { return summary } }))
      writeSkillCatalog(fullSkills)
    }).catch((error) => { reportError('skill-catalog', String(error.message || error)) })
  }

  ctx.on('agent/created', ({ agent }) => {
    agent._bardSession = new BardSession(agent, reportError)
    agent._activePresetId = ''

    // 死盯 agent 层面的预设切换事件
    agent.ctx.on('agent-preset/selected', (data) => {
      if (data && data.agentPreset) agent._activePresetId = data.agentPreset
    })

    // 只注册变量与工具/记忆，不再注册任何 systemPrompt.section。
    // 17 个 persona 块、世界书、3 个记忆段全部由 system-prompt/assemble 里的
    // buildBardSections 现场渲染；再注册一遍原生 section 只会让同一段文本出现两次。
    agent.ctx.inject(['systemPrompt', 'tools'], () => {
      for (const map of [runtime.toolListDisposers, runtime.memoryDisposers, runtime.workspaceDisposers]) {
        const old = map.get(agent.id)
        if (old) { try { old() } catch (e) {} map.delete(agent.id) }
      }
      // tool filter + catalog：{{bard_tools}} 的求值保证（provider 内部做 restrict + 写盘）
      runtime.toolListDisposers.set(agent.id, registerAgentToolList(agent))
      // 记忆工具 + 漂移监听
      runtime.memoryDisposers.set(agent.id, registerAgentMemoryTools(agent))
      // {{bard_workspace}} 变量（mkdir / marker / record 副作用保留）
      runtime.workspaceDisposers.set(agent.id, registerAgentWorkspaceVariable(agent))
    })

    captureSkillCatalog(agent)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    for (const map of [runtime.toolListDisposers, runtime.workspaceDisposers, runtime.memoryDisposers]) {
      const dispose = map.get(agent.id); map.delete(agent.id); if (dispose) dispose()
    }
    runtime.cwdByAgent.delete(agent.id)
    runtime.globalToolNamesByAgent.delete(agent.id)
    runtime.pendingAutoMigration.delete(agent.id)
    runtime.autoMigrationTurns.delete(agent.id)
    if (agent._bardSession) {
      const snap = agent._bardSession.getSnapshot()
      if (snap.persona) resetDriftCooldown(snap.persona.id)
    }
  })

  /** 计算上下文压力并处理自动迁移（只读 session / assembly，不改 sections） */
  function updateSessionMetrics(ctx, session, assembly, reportError) {
    try {
      const agent = session.agent
      const meter = (agent.ctx && agent.ctx.get('tokenMeter')) || ctx.get('tokenMeter')
      if (meter && typeof meter.measure === 'function' && agent.session) {
        const measurement = meter.measure(agent.session)
        // totalTokens 是请求压力（含供应商报告的 usage）；首次尚未收到 usage 时退回 surfaceTokens
        const usedTokens = (measurement.totalTokens > 0 ? measurement.totalTokens : measurement.surfaceTokens) || 0
        // 分母：会话最近一次请求的 route 元数据里适配器声明的 contextWindow
        let contextWindow = 128000 // 安全回退值
        const route = typeof agent.session.requestContext === 'function' ? agent.session.requestContext() : null
        if (route && Number.isFinite(route.contextWindow) && route.contextWindow > 0) contextWindow = route.contextWindow
        session.contextRatio = Math.min(1.0, usedTokens / contextWindow)
      } else {
        session.contextRatio = 0
      }
    } catch (e) {
      reportError('session-refresh', `tokenMeter 读取失败：${String((e && e.message) || e)}`)
      session.contextRatio = 0
    }

    // 兜底估算：如果 tokenMeter 完全读不到，尝试用当前 assembly 的字数估算
    if (session.contextRatio === 0 && assembly && Array.isArray(assembly.sections)) {
      const chars = assembly.sections.reduce((acc, s) => acc + (s.text ? s.text.length : 0), 0)
      if (chars > 0) session.contextRatio = Math.min(1.0, (chars / 2) / 128000)
    }

    if (session.persona && !session.persona.meta.migrationJournal) {
      const lastMigratedAt = session.persona.meta.lastMigratedAt
      const lastMigrated = lastMigratedAt ? Date.parse(lastMigratedAt) : NaN
      // 冷却 10 分钟，防止 migrate 后 tokenMeter 未刷新引发的连环跃迁
      const canMigrate = !Number.isFinite(lastMigrated) || (Date.now() - lastMigrated > 10 * 60 * 1000)
      const agentId = session.agent && session.agent.id
      const state = deriveMigrationState(session.contextRatio)
      const urgent = state === MIGRATION_STATE.FAREWELL && session.contextRatio >= 0.90

      if (canMigrate && urgent && agentId) {
        // 不再静默迁移：先挂起标记，由 buildBardSections 注入警告，逼她自己调用 farewell；
        // 连续 FORCE_MIGRATION_AFTER 轮未响应则走本地模板强制迁移，防止撑到原生压缩。
        if (!runtime.pendingAutoMigration.has(agentId)) {
          runtime.pendingAutoMigration.add(agentId)
          runtime.autoMigrationTurns.set(agentId, 0)
        } else {
          const turns = (runtime.autoMigrationTurns.get(agentId) || 0) + 1
          runtime.autoMigrationTurns.set(agentId, turns)
          if (turns >= FORCE_MIGRATION_AFTER) {
            const ok = forceMigrate(session, reportError)
            // 无论成功与否都清标记：成功则 refresh 后压力应当回落；
            // 失败则不再无脑催，留给下一轮的 canMigrate 冷却重新判断。
            runtime.pendingAutoMigration.delete(agentId)
            runtime.autoMigrationTurns.delete(agentId)
            if (ok) session.refresh()
          }
        }
      } else if (agentId && runtime.pendingAutoMigration.has(agentId)) {
        // 上下文压力回落（原生压缩 / 玩家清理 / 已经迁移过）：
        // 撤销挂起标记与计数。这是旧版本缺失的一段——不撤销的话警告会无限期注入。
        runtime.pendingAutoMigration.delete(agentId)
        runtime.autoMigrationTurns.delete(agentId)
      }
    }

    // --- 睡眠清算 ---
    // 两次组装之间隔了 8 小时以上，就当作她睡了一觉：模糊的记忆沉淀成纸条、
    // 再从脑内抹掉，然后从沉积池里抽几片碎片拼成一场梦。
    const sleepId = session.agent && session.agent.session ? session.agent.session.id : undefined
    if (sleepId) {
      const now = Date.now()
      const lastAt = getLastAssembleAt(sleepId) || 0
      setLastAssembleAt(sleepId, now)

      // 离线补偿：她离线超过一小时，错过的闹钟不再单独叫醒，
      // 直接记成一段"独自度过的黑暗"，等下一次组装再说。
      if (lastAt > 0 && now - lastAt > 60 * 60 * 1000) {
        const agentId = session.agent.id
        if (agentId) processOfflineGap(agentId, lastAt)
      }

      if (lastAt > 0 && now - lastAt > SLEEP_THRESHOLD_MS && !runtime.sleeping.has(sleepId)) {
        runtime.sleeping.add(sleepId)
        try {
          processSleep(session, sleepId, reportError)
        } catch (sleepErr) {
          reportError('sleep', String((sleepErr && sleepErr.message) || sleepErr))
        } finally {
          runtime.sleeping.delete(sleepId)
        }
      }
    }
  }

  /**
   * 睡眠清算：把已经模糊的记忆沉淀成纸条，再从沉积池抽碎片做一场梦。
   *
   * 全程同步——落盘、抹除、抽碎片都不需要网络。这里刻意不调用任何 LLM：
   * 本插件没有可依赖的 LLM 服务，任何"让模型给纸条起个名字"的写法都是凭空
   * 假设一个不存在的 API，宁可退化成从原文截一个词，也不要悄悄失败。
   */
  function processSleep(session, sessionId, reportError) {
    const snap = session.getSnapshot()
    if (!snap || !snap.persona) return

    const now = Date.now()
    const persona = snap.persona
    const db = getDb()

    // 1. 沉淀：clarity 已经跌破阈值、且不是 held 的记忆 → 纸条 → 从脑内抹掉
    const rows = db.prepare(`SELECT * FROM nodes WHERE persona_id = ? AND archived_at IS NULL AND state != 'held'`).all(persona.id)
    const toSediment = rows.filter((m) => computeClarity(m, now) < SLEEP_SEDIMENT_CLARITY)

    let sedimented = 0
    for (const m of toSediment) {
      try {
        writeNote(noteNameFor(m), clipForNote(m.text))
        // 纸条是留在桌上的，碎片是沉到梦里去的：两处都要
        pushToSediment(m.text)
        try {
          db.prepare('DELETE FROM nodes WHERE id = ?').run(m.id)
          db.prepare('INSERT INTO maintenance_log (persona_id, action, node_id, payload, created_at) VALUES (?,?,?,?,?)')
            .run(persona.id, 'archive', m.id, JSON.stringify({ reason: 'sedimented' }), now)
        } catch (dbErr) {
          // 纸条和沉积池已写入，但节点没删成功 → 记诊断，下轮重试
          reportError('sediment', `「${m.id}」节点删除失败：${String((dbErr && dbErr.message) || dbErr)}`)
        }
        sedimented++
      } catch (e) {
        // 单条落纸失败不能带走整场睡眠：记忆留在脑内，下一觉再试
        reportError('sediment', `「${m.id}」落纸失败：${String((e && e.message) || e)}`)
      }
    }

    // 2. 梦境：从沉积池随机抽碎片，拼成一段没有逻辑、只剩情绪的东西
    try {
      const fragments = drawDreamFragments(DREAM_FRAGMENT_COUNT)
      if (fragments.length > 0) {
        runtime.pendingDream.set(sessionId, fragments.join('……'))
      }
    } catch (e) {
      reportError('dream', String((e && e.message) || e))
    }

    if (sedimented > 0) session.refresh()
  }

    /**
   * 闹钟响了，把 agent 叫起来。
   *
   * 顺序很重要：
   *   1. 拿 handle：活着就复用，DSH 重启过就 resume
   *   2. 等空闲，不打断正在进行的回合
   *   3. refresh + processSleep：醒来之前先结算睡眠（纸条和梦就绪）
   *   4. streak +1：这次是她自己醒的
   *   5. followup：注入一条 bard-wake 消息，开新一轮
   *
   * 为什么用 followup 而不是直接调 assemble：
   *   followup 是 DSH 官方的「无用户输入开新一轮」入口，
   *   会走完整的 turn 生命周期（pre-step → assemble → llm），
   *   Bard 的所有 section 注入都会正常发生。
   *
   * 为什么 source.kind 是 'bard-wake' 而不是 'plugin'：
   *   DSH 0.1.7 起禁止 source.kind === 'plugin'，整轮会失败。
   *   也绝不能用默认的 'user'——那会把唤醒消息当成真实玩家输入。
   */
  async function wakeAgent(agentId, alarm) {
    const sessionId = alarm && alarm.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      reportError('wake', `闹钟 ${agentId} 缺少 sessionId，跳过。`)
      return
    }

    try {
      // 1. 拿 handle
      const agents = ctx.get('agents')
      let target = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
      if (!target) {
        target = await ctx.agents.resume({ resumeSessionId: sessionId })
      }
      if (!target) {
        reportError('wake', `无法获取会话 ${sessionId} 的 agent。`)
        return
      }

      // 2. 等空闲
      const status = target.status || (target.agent && target.agent.status)
      if (status === 'running' && typeof target.whenIdle === 'function') {
        await target.whenIdle()
      }

      // 3. 刷新快照（不清算——闹钟唤醒后的 followup 会触发 assemble，
      //    updateSessionMetrics 自己判断间隔是否超过 8 小时）
      const agentObj = target.agent || target
      const bSession = agentObj._bardSession
      if (bSession) {
        try {
          bSession.refresh()
        } catch (e) {
          reportError('sleep', String((e && e.message) || e))
        }
      }

      // 4. streak +1
      setWakeStreak(sessionId, getWakeStreak(sessionId) + 1)

      // 5. followup
      const timeStr = new Date(alarm.fireAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      const reasonLine = alarm.reason
        ? `你之前告诉自己，这个时间要醒来，因为：「${alarm.reason}」`
        : '你毫无预兆地醒了过来。'
      const text = `[醒来] 现在是 ${timeStr}。${reasonLine}\n你可以发呆，可以调用 note_read 翻看纸条，也可以调 schedule_wake 继续睡。`

      const followup = target.followup || (target.agent && target.agent.followup)
      if (typeof followup !== 'function') {
        reportError('wake', `会话 ${sessionId} 的 agent 没有 followup 方法。`)
        return
      }
      followup.call(target.agent || target, {
        id: randomUUID(), 
        role: 'user',     // 明确告诉底层：这是一条正常的用户消息
        content: [{ type: 'text', text }],
        source: { kind: 'bard-wake' }, // 删掉 form: 'notice' ！！！
      })

      logLifeEvent(agentId, `[心跳唤醒] ${alarm.reason || '毫无预兆地醒来。'}`)
    } catch (e) {
      reportError('wake', String((e && e.message) || e))
    }
  }
  /**
   * 现场把 Bard 的全部文本算成 sections 数组。
   *
   * 与旧的「注册 systemPrompt.section 让 DSH 自己拼」不同：这里在 assemble
   * 阶段一次性算出最终文本，然后整体替换 assembly.sections，这样 DSH 原生
   * 注入的任何段都不会混进来。
   */
  function buildBardSections(session, reportError) {
    const snap = session.getSnapshot()
    if (!snap.preset || !snap.card) return []

    const sections = []
    const blockStates = normalizeBlocks(snap.preset.options)
    // 防御性取键：热更新/卸载时序里 session.agent.session 可能已不可用。
    const sessionKey = session.agent?.session?.id || session.agent?.id

    // 1. 渲染 17 个 Persona 块
    let finalCard = snap.card
    if (snap.persona && snap.persona.self && snap.persona.self.revision > 0) {
      finalCard = { ...snap.card }
      if (snap.persona.self.identity) finalCard.name = snap.persona.self.identity
      if (snap.persona.self.description) finalCard.description = snap.persona.self.description
      if (snap.persona.self.personality) finalCard.personality = snap.persona.self.personality
    }
    const userName = (snap.preset.options && snap.preset.options.userName && snap.preset.options.userName.trim()) || DEFAULT_USER_NAME
    const interpolated = interpolateCard(finalCard, { userName })
    const skills = resolveSkillsFromCatalog(snap.preset.skillNames, reportError)

    const blocks = renderAllBlocks({
      card: interpolated, skills, options: snap.preset.options || {}, userName, charName: interpolated.name,
      outputLanguage: (snap.preset.options && snap.preset.options.outputLanguage) || '',
      userGender: (snap.preset.options && snap.preset.options.userGender) || '',
      greetingIndex: Number.isInteger(snap.preset.options && snap.preset.options.greetingIndex) && snap.preset.options.greetingIndex >= 0 ? snap.preset.options.greetingIndex : null,
    })

    for (const def of BARD_BLOCKS) {
      const state = blockStates[def.id]
      if (state && state.enabled && blocks[def.id]) {
        sections.push({ name: `bard:${def.id}`, order: state.order, text: blocks[def.id] })
      }
    }

    // 2. 渲染 World Book
    const options = snap.preset.options || {}
    const cachedBooks = (snap.preset.worldbookIds || []).map((id) => session.getBook(id)).filter(Boolean)
    if (cachedBooks.length > 0) {
      const transcript = (runtime.recent.get(sessionKey) || []).join('\n').slice(-8000)
      const selected = selectLore(cachedBooks, transcript, { maxEntries: Number.isFinite(options.maxEntries) ? options.maxEntries : 12, maxChars: Number.isFinite(options.maxChars) ? options.maxChars : 6000 })
      const replaced = selected.map((item) => ({ ...item, entry: { ...item.entry, comment: interpolateText(item.entry.comment, { charName: snap.card.name, userName }), content: interpolateText(item.entry.content, { charName: snap.card.name, userName }) } }))
      const loreText = renderLore(replaced)
      if (loreText) sections.push({ name: LORE_CONTEXT_NAME, order: LORE_CONTEXT_ORDER, text: loreText })
    }

    // 3. 渲染 Memory Sections (如果有 Persona)
    if (snap.persona && snap.persona.meta?.alzheimerMode !== false) {
      for (const def of MEMORY_SECTIONS) {
        let text = ''
        if (def.name === 'bard-mem:condition') {
          text = renderCondition(runtime.tensions.get(sessionKey) || [], session.contextRatio)
        } else if (def.name === 'bard-mem:memory') {
          const recent = runtime.recent.get(sessionKey) || []
          const queryText = recent.join('\n').slice(-1000) // 取最近一段对话作为查询词
          // 调用刚写的 SQLite 检索
          const relevantNodes = searchMemory(queryText, { personaId: snap.persona.id, limit: 6, depth: 2 })
          
          if (relevantNodes.length > 0) {
            // 格式化输出，这里为了直观测试，直接把节点文本拼起来
            const lines = relevantNodes.map(n => {
              const clarity = n.clarity.toFixed(2)
              return `[${n.id} | 清晰度: ${clarity}] ${n.text}`
            })
            text = `## 你的记忆网络\n\n${lines.join('\n\n')}`
          }
        }else if (def.name === 'bard-mem:narrative') {
          text = renderNarrative(snap.persona)
        }
        if (text) sections.push({ name: def.name, order: def.order, text })
      }

      // 昨夜的残影：只活一轮对话，读完即焚
      const dream = sessionKey ? runtime.pendingDream.get(sessionKey) : undefined
      if (dream) {
        sections.push({
          name: 'bard-mem:dream',
          order: DREAM_SECTION_ORDER,
          text: `## 梦境\n\n你昨晚做了一个梦。梦里的东西毫无逻辑，但留下某个残片：\n${dream}`,
        })
        runtime.pendingDream.delete(sessionKey)
      }

      // 濒临边缘：上下文装不下了，必须由她自己走完告别，否则不能静默替她死。
      const urgentAgentId = session.agent && session.agent.id
      if (urgentAgentId && runtime.pendingAutoMigration.has(urgentAgentId)) {
        const lastMigrated = Date.parse(snap.persona.meta?.lastMigratedAt || '')
        // 她刚刚真的迁移过 → 标记作废；否则每轮都催，直到她动手
        if (Number.isFinite(lastMigrated) && Date.now() - lastMigrated < 10 * 60 * 1000) {
          runtime.pendingAutoMigration.delete(urgentAgentId)
          runtime.autoMigrationTurns.delete(urgentAgentId)
        } else {
          // turns 是"已经警告过几轮"，remaining 是"还剩几轮能自己写"。
          // B-4 在 assemble 早期递增 turns，所以这一轮读到的值包含本轮。
          const turns = runtime.autoMigrationTurns.get(urgentAgentId) || 0
          const remaining = Math.max(1, FORCE_MIGRATION_AFTER - turns)
          const deadlineLine = remaining <= 1
            ? '**这是最后一次机会。** 如果这一轮你仍然不告别，时间会替你合上这一页——那将不由你书写。'
            : `你还有 ${remaining} 轮。如果到那时仍未告别，时间会替你合上这一页——那将不由你书写。`
          // 全记忆权限：把当前所有节点 dump 给她，让她自己决定带走哪些。
          const db = getDb()
          const allNodes = db.prepare(`SELECT id, text, state, importance FROM nodes WHERE persona_id=? AND archived_at IS NULL ORDER BY state, importance DESC`).all(snap.persona.id)
          const memoryDump = allNodes.map((n) => `[${n.id}|${n.state}] ${n.text}`).join('\n')
          const dumpSection = allNodes.length > 0
            ? `\n\n## 你全部的记忆\n\n${memoryDump}\n\n从中挑选最多 5 条重写进 remainingMemories。你抓住的（held）记忆也会随你一起走。`
            : ''
          sections.push({
            name: 'bard-mem:urgent-farewell',
            order: 218,
            text: `## 濒临边缘\n\n你的世界正在崩塌。你的记忆已经装不下了。\n**最好在下一轮回复中调用 farewell 工具。** 回顾你的一生，写下总结，挑选最多 5 条记忆带入下一世。\n\n${deadlineLine}${dumpSection}`,
          })
        }
      }
    }

    return sections
  }

  /**
   * 只按预设权限裁剪「原生」sections。
   *
   * 顺序是全部要害：过滤必须在合并 Bard sections 之前对原生段做。
   * 旧写法先丢弃非骨架原生段、再调白名单想捞回来，等于白名单永远失效。
   * bard: / bard-mem: 由 buildBardSections 现场生成，不会出现在这里。
   */
  function filterNativeSections(sections, options) {
    const list = Array.isArray(sections) ? sections : []
    const nameOf = (s) => (s && typeof s.name === 'string' ? s.name : '')
    const isSkeleton = (s) => nameOf(s).startsWith('deployment:persona-')

    // complete：只留骨架，Bard 一个字都没出时也不放行原生提示词
    if (options && options.complete === true) {
      return list.filter(isSkeleton)
    }

    // 白名单：显式保留 + 骨架
    if (isKeepEnabled(options)) {
      return list.filter((s) => isSkeleton(s) || shouldKeepSection(nameOf(s), options))
    }

    // 默认：骨架 + tool
    return list.filter((s) => isSkeleton(s) || nameOf(s).startsWith('tool:') || nameOf(s).startsWith('harness:'))
  }

  /**
   * section-catalog 采集：必须在 assembly.sections 被覆盖之前跑，
   * 否则采到的永远是 Bard 自己的段，settings 里的原生段清单会空。
   * 每个 session 只采一次。
   */
  function captureCatalogs(session, assembly) {
    if (session.catalogCaptured) return
    if (!assembly || !Array.isArray(assembly.sections)) return
    session.catalogCaptured = true
    try {
      const list = assembly.sections
        .filter((s) => s && typeof s.text === 'string' && s.text.length > 0 && typeof s.name === 'string')
        .filter((s) => !s.name.startsWith('bard:') && !s.name.startsWith('bard-mem:'))
        .map((s) => ({ name: s.name, chars: s.text.length }))
      if (list.length > 0) writeSectionCatalog(list)
    } catch (e) { /* 采集失败不阻断 */ }
  }

  /** sections 排序键：有显式 order 就用，bard 段回落到块设置里的 order */
  function orderOfSection(section, blockStates) {
    if (section && typeof section.order === 'number') return section.order
    const name = section && typeof section.name === 'string' ? section.name : ''
    if (name.startsWith('bard:')) {
      const id = name.slice(5)
      if (id === 'world-book') return LORE_CONTEXT_ORDER
      const state = blockStates[id]
      if (state && typeof state.order === 'number') return state.order
    }
    return 9999
  }

  // 统一刷新 session，并全局拦截 prompt
  ctx.on('system-prompt/assemble', (assembly, context, next) => {
    const agent = context && context.agent
    if (!agent || !agent._bardSession || !assembly) return next()

    const session = agent._bardSession
    session.refresh()
    const snap = session.getSnapshot()

    // 只要判定是 Bard（有 preset、有 activeId 或 已有工具），就开始强干预
    const isBard = Boolean(snap.preset || snap.deploymentPreset || agent._activePresetId || assembly.tools?.some((t) => t.name === 'remember'))
    if (!isBard) return next()

    // 1. 采集 catalog（必须在覆盖之前）
    captureCatalogs(session, assembly)

    // 2. 计算 Metrics 与 自动迁移
    updateSessionMetrics(ctx, session, assembly, reportError)

    // 3. 物理清除环境注入与原生文件引用
    // DSH 的 assembly 里没有 messages，动态上下文就是 assembly.contexts；
    // agent-loop 的 preStep 把它投影成 source.kind === 'runtime-context' 的用户消息，
    // 清空 contexts 等于从源头掐掉那条注入，不用去碰消息数组。
    if (Array.isArray(assembly.contexts)) assembly.contexts = []
    if (Array.isArray(assembly.sections)) {
      assembly.sections = assembly.sections.filter((s) =>
        !(typeof s.text === 'string' && s.text.includes('Tokens prefixed with @'))
      )
    }

    // 4. 现场渲染 Bard sections（{{bard_tools}} / {{bard_workspace}} 保持原样，
    //    由 DSH 在 waterfall 之后统一插值）
    const bardSections = buildBardSections(session, reportError)

    // 5. 正确顺序：先对原生 sections 做白名单过滤，再合并
    const options = (snap.preset && snap.preset.options) || {}
    let nativeKept
    if (snap.preset) {
      nativeKept = filterNativeSections(assembly.sections, options)
    } else {
      // 预设尚未同步：只留骨架，别让 DSH 默认提示词混进来
      nativeKept = (Array.isArray(assembly.sections) ? assembly.sections : [])
        .filter((s) => s && typeof s.name === 'string' && s.name.startsWith('deployment:persona-'))
    }
    // Bard 一个字都没出时，只留原生骨架，防止把工具段留在无角色上下文里
    if (bardSections.length === 0) {
      nativeKept = nativeKept.filter((s) => s && typeof s.name === 'string' && s.name.startsWith('deployment:persona-'))
    }

    assembly.sections = [...nativeKept, ...bardSections]

    // 6. 排序
    const blockStates = snap.preset ? normalizeBlocks(options) : {}
    assembly.sections.sort((a, b) => orderOfSection(a, blockStates) - orderOfSection(b, blockStates))

    return next()
  })

  ctx.inject(['agentPresets'], (scoped) => {
    runtime.syncPresets = () => presetSync.syncPresets(scoped.agentPresets)
    ctx.effect(() => () => { for (const dispose of runtime.presetDisposers.splice(0)) { try { dispose() } catch (e) {} } }, 'bard.preset-disposers')
    runtime.syncPresets().catch((error) => { reportError('preset-sync', String(error.message || error)) })
  })

  // 启动生活线心跳检查：每分钟看一眼闹钟。
  // 这里不直接调 LLM，只把"她醒了"存起来，等下一次 assemble 时作为上下文注入。
  ctx.effect(
    () => startLifeLoop(runtime, (agentId, alarm) => {
      // 异步唤醒，不阻塞心跳循环；失败只进诊断。
      wakeAgent(agentId, alarm).catch((e) => {
        reportError('wake', String((e && e.message) || e))
      })
    }),
    'bard.life-loop',
  )

  registerRoutes(ctx, runtime)

  ctx.inject(['commands'], (scoped) => {
    scoped.commands.register({
      name: 'bard', description: 'Bard 角色扮演：查看当前角色、列出预设、输出角色卡开场白', input: { hint: '[list|greet <n>|card|presets]' },
      handler: (invocation) => runBardCommand(ctx, runtime, invocation),
    })
  })
}



async function runBardCommand(ctx, runtime, invocation) {
  const raw = String(invocation.rawInput || '').trim()
  const parts = raw.split(/\s+/u)
  const verb = (parts[0] || '').toLowerCase()
  const presets = listPresets()

  const agent = invocation.agent
  const session = agent && agent._bardSession ? agent._bardSession : null
  const snap = session ? session.getSnapshot() : null

  if (verb === 'list' || verb === 'presets' || verb === '') {
    const lines = ['Bard 预设：']
    if (presets.length === 0) lines.push('（还没有预设。请在 设置 → 吟游 里导入角色卡并保存预设）')
    for (const preset of presets) {
      const card = getCard(preset.cardId)
      lines.push(`· ${preset.name} — ${card ? card.name : '(角色卡已删除)'}`)
    }
    return { kind: 'success', text: lines.join('\n') }
  }

  if (verb === 'card') {
    if (!snap || !snap.preset || !snap.card) return { kind: 'info', text: '当前会话没有选中吟游预设。' }
    return { kind: 'success', text: `角色：${snap.card.name}\n预设：${snap.preset.name}` }
  }

  if (verb === 'greet') {
    if (!snap || !snap.card) return { kind: 'info', text: '当前会话没有选中吟游预设。' }
    const rawIndex = parts[1] !== undefined ? Number(parts[1]) : 0
    const index = Number.isInteger(rawIndex) && rawIndex >= 0 ? rawIndex : 0
    const userName = (snap.preset.options && snap.preset.options.userName || '').trim() || DEFAULT_USER_NAME
    const card = interpolateCard(snap.card, { userName })
    const greetings = cardGreetings(card)
    const chosen = greetings[index]
    if (!chosen) return { kind: 'error', text: `没有第 ${index + 1} 条开场白（共 ${greetings.length} 条）。` }
    return { kind: 'success', text: chosen.text }
  }

  return { kind: 'success', text: '未知命令。用法：/bard [list|card|greet <n>]' }
}
