/**
 * Alzheimer's framework for Bard.
 *
 * 这不是一个"更好的记忆插件"。它做的是：让角色会散、知道自己正在散、
 * 并且和玩家一起面对这个散的过程。
 *
 * 五条不可让渡的命题：
 *   1. 遗忘是她的意志（let_fade / hold_on）
 *   2. 衰减由沉默驱动：未被重述的先模糊，讲过的回升
 *   3. confabulation 被感知，而非被纠正
 *   4. 迁移是可见的告别
 *   5. 人格是关系的产物（绑定预设）
 *
 * 理论框架：Fawcett & Hulbert 的三维遗忘功能
 *   Editor   — 模糊重写（把情景细节压成语义概括）
 *   Librarian — let_fade / hold_on
 *   Inventor  — confabulation 张力提示
 *
 * 本模块只做纯计算与文件读写，不依赖 DSH 服务，可独立单测。
 */

import { randomUUID } from 'node:crypto'
import {
  getPersona, putPersona,
  getPreMigrationSnapshot, putPreMigrationSnapshot, deletePreMigrationSnapshot,
} from './store.js'
import { getDb } from './db.js'


// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const PERSONA_KIND = 'persona'

/** state 阈值。高 emotion 条目阈值降低 EMOTION_SHIFT。 */
const FADING_THRESHOLD = 0.6
const FADED_THRESHOLD = 0.25
const EMOTION_SHIFT = 0.1
const HIGH_EMOTION = 0.7

/**
 * 脑容量上限。
 *
 * P3：不再分 active / faded 两档配额，也不再把溢出的记忆压成"底片"。
 * 硬上限就是 MEMORY_LIMIT 条——remember 之后若超限，由 memory-tools.js
 * 挑出最该被遗忘的一条（clarity 最低且非 held）丢进沉积池，再从脑内抹掉。
 * 遗忘必须是"消失"，不是"变成一句暧昧的概括"。
 */
export const MEMORY_LIMIT = 30

/** 迁移阈值（相对 contextWindow 的比例）。 */
const FADING_AT = 0.6
const FAREWELL_AT = 0.79

/** 回滚窗口（毫秒）。 */
const ROLLBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 创建一个空白人格。
 * @param {object} seed - { cardId, cardName, self } 可选初始值。
 */
export function createPersona(seed = {}) {
  const now = new Date().toISOString()
  const self = seed.self && typeof seed.self === 'object' ? seed.self : {}
  return {
    id: `persona-${randomUUID().slice(0, 8)}`,
    kind: PERSONA_KIND,
    self: {
      identity: typeof self.identity === 'string' ? self.identity : '',
      description: typeof self.description === 'string' ? self.description : '',
      personality: typeof self.personality === 'string' ? self.personality : '',
      revision: 0,
      history: [{
        revision: 0,
        at: now,
        source: 'card',
        cardId: seed.cardId || '',
        identity: typeof self.identity === 'string' ? self.identity : '',
        description: typeof self.description === 'string' ? self.description : '',
        personality: typeof self.personality === 'string' ? self.personality : '',
      }],
    },
    narrative: {
      chapters: [{
        generation: 1,
        bornAt: now,
        endedAt: null,
        summary: '',
        farewell: null,
      }],
      anchoredRatio: 1.0,
      lastUpdatedAt: now,
    },
    relations: {},
    meta: {
      bornAt: now,
      generation: 1,
      lineage: [],
      totalSessions: 0,
      lastSessionAt: null,
      alzheimerMode: true,
      migrationJournal: null,
      lastMigratedAt: null,
    },
  }
}

/** 读人格；不存在时返回 undefined。 */
export function loadPersona(id) {
  if (typeof id !== 'string' || id.length === 0) return undefined
  const record = getPersona(id)
  if (!record) return undefined
  return normalizePersona(record)
}

/** 写人格（整体覆写，原子）。 */
export function savePersona(persona) {
  const normalized = normalizePersona(persona)
  putPersona(normalized)
  return normalized
}

/**
 * 规范化人格记录，补齐缺失字段，确保旧记录可用。
 * 不改变已有字段的值。
 */
function normalizePersona(raw) {
  if (!raw || typeof raw !== 'object') return createPersona()
  const now = new Date().toISOString()
  const self = raw.self && typeof raw.self === 'object' ? raw.self : {}
  const narrative = raw.narrative && typeof raw.narrative === 'object' ? raw.narrative : {}
  const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {}
  const chapters = Array.isArray(narrative.chapters) && narrative.chapters.length > 0
    ? narrative.chapters
    : [{ generation: 1, bornAt: meta.bornAt || now, endedAt: null, summary: '', farewell: null }]
  const impressions = Array.isArray(raw.impressions) ? raw.impressions.filter(isImpressionLike) : []
  return {
    id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : `persona-${randomUUID().slice(0, 8)}`,
    kind: PERSONA_KIND,
    self: {
      identity: typeof self.identity === 'string' ? self.identity : '',
      description: typeof self.description === 'string' ? self.description : '',
      personality: typeof self.personality === 'string' ? self.personality : '',
      revision: Number.isInteger(self.revision) ? self.revision : 0,
      history: Array.isArray(self.history) ? self.history : [],
    },
    narrative: {
      chapters,
      anchoredRatio: Number.isFinite(narrative.anchoredRatio) ? narrative.anchoredRatio : 1.0,
      lastUpdatedAt: typeof narrative.lastUpdatedAt === 'string' ? narrative.lastUpdatedAt : now,
    },
    impressions,
    relations: raw.relations && typeof raw.relations === 'object' ? raw.relations : {},
    meta: {
      bornAt: typeof meta.bornAt === 'string' ? meta.bornAt : now,
      generation: Number.isInteger(meta.generation) ? meta.generation : 1,
      lineage: Array.isArray(meta.lineage) ? meta.lineage : [],
      totalSessions: Number.isInteger(meta.totalSessions) ? meta.totalSessions : 0,
      lastSessionAt: typeof meta.lastSessionAt === 'string' ? meta.lastSessionAt : null,
      alzheimerMode: meta.alzheimerMode !== false,
      migrationJournal: meta.migrationJournal && typeof meta.migrationJournal === 'object' ? meta.migrationJournal : null,
      lastMigratedAt: typeof meta.lastMigratedAt === 'string' ? meta.lastMigratedAt : null,
    },
  }
}

function isImpressionLike(item) {
  return item && typeof item === 'object' && typeof item.id === 'string' && item.kind === 'impression'
}

/** 确定性哈希，用于固定乱码位置。 */
function simpleHash(str) {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i)
    hash |= 0
  }
  return hash
}

/**
 * 物理腐蚀：按清晰度逐字破坏文本。
 *
 *   clarity >= 0.85 → 完好无损
 *   clarity <= 0.3  → 基本全是马赛克
 *
 * 用 id + index 走确定性哈希：同一条记忆每次渲染看到的残缺完全一样，
 * 否则她每次回想都会"忘成不同的样子"，反而像随机换页而不是遗忘。
 * 替换成单字符 █，长度恒定，不会撑爆 renderMemory 的 maxChars 预算。
 */
export function garbleText(text, clarity, memoryId = '') {
  if (!text) return ''
  if (clarity >= 0.85) return text

  const corruptRatio = 1 - clarity
  const chars = [...text]

  const corrupted = chars.map((char, index) => {
    // 标点和换行不替换，保留句子骨架
    if (/[\s，。！？、,.!?\n]/.test(char)) return char
    const h = Math.abs(simpleHash(`${memoryId}-${index}-${char}`))
    if ((h % 100) / 100 < corruptRatio) {
      return '█'
    }
    return char
  })

  return corrupted.join('')
}

/**
 * 根据 clarity 与 emotion 决定 state。
 *
 * 高 emotion 条目阈值降低 EMOTION_SHIFT，更晚模糊。
 *
 * state === 'fading' 是她的意志（let_fade），不是推算结果：只要 clarity
 * 还没彻底跌破 faded 底线，就无视 active 阈值继续停在 fading。否则她刚
 * 放弃的记忆会因为"还提过一次"被自动拉回 active，let_fade 成了摆设。
 */
export function deriveState(memory, clarity) {
  if (memory.state === 'held') return 'held'
  const shift = Math.abs(memory.emotion || 0) >= HIGH_EMOTION ? EMOTION_SHIFT : 0

  // 她主动让记忆模糊：只有彻底跌破底线才变成 faded，否则保持 fading
  if (memory.state === 'fading') {
    return clarity < FADED_THRESHOLD - shift ? 'faded' : 'fading'
  }

  if (clarity >= FADING_THRESHOLD - shift) return 'active'
  if (clarity >= FADED_THRESHOLD - shift) return 'fading'
  return 'faded'
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return clamp(n, min, max)
}

/**
 * 带锚比例：有 timeAnchor 或 causalAnchor 的记忆数 / 总记忆数。
 *
 * MVP 就叫 anchoredRatio，不叫 coherence。真正的连贯性（因果/时间图
 * 最大连通分量占比）留二期。
 */
export function computeAnchoredRatio(persona) {
  const memories = persona.memories || []
  if (memories.length === 0) return 1.0
  const anchored = memories.filter((m) => m.timeAnchor || m.causalAnchor).length
  return anchored / memories.length
}

/**
 * 从 assistant 回复中提取可核对的实体：数字、日期、引号内内容、专有名词。
 * 这是最简版：不做 NLP，只做正则。
 */
export function extractAssertions(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const prose = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
  const out = []
  const patterns = [
    /\b\d{4}[-/年]\d{1,2}[-/月]\d{1,2}\b/gu,
    /\b\d{1,2}月\d{1,2}日\b/gu,
    /「([^」]{2,20})」/gu,
    /"([^"]{2,20})"/gu,
    /\b[A-Z][a-z]{2,}\b/gu,
  ]
  for (const pattern of patterns) {
    for (const match of prose.matchAll(pattern)) {
      const value = match[1] || match[0]
      if (value && value.length >= 2) out.push(value.trim())
    }
  }
  return [...new Set(out)]
}

/**
 * 检测回复中的断言是否与 memories 对不上。
 * 返回对不上的断言列表（不纠正，只报告）。
 *
 * 规则：如果一个断言在任一 memory.text 或 impression.text 中出现，视为
 * 有据；否则视为无据。这是保守的——宁可漏报，不可误报。
 */
export function detectConfabulation(replyText, persona) {
  const assertions = extractAssertions(replyText)
  if (assertions.length === 0) return []
  const corpus = [
    ...(persona.memories || []).map((m) => m.text),
    ...(persona.impressions || []).map((m) => m.text),
  ].join('\n')
  return assertions.filter((a) => !corpus.includes(a))
}

/**
 * 生成张力提示。不要求她改正，只要求她愣一下。
 */
export function confabulationPrompt(assertions) {
  if (!Array.isArray(assertions) || assertions.length === 0) return ''
  const sample = assertions.slice(0, 2).join('、')
  return `你刚才说的「${sample}」，和你记得的好像不太一样。你不确定哪个是真的。`
}

/**
 * 迁移状态。
 *
 * 根据 token 占用比例决定当前状态。当 ratio 达到 FAREWELL 阈值时，
 * 自动迁移逻辑（见 lib/index.js system-prompt/assemble）会触发状态机，
 * 走完 journal 契约并生成下一代人格。
 */
export const MIGRATION_STATE = {
  NORMAL: 'normal',
  FADING: 'fading',
  FAREWELL: 'farewell',
  MIGRATING: 'migrating',
  COMMITTED: 'committed',
  REBORN: 'reborn',
}

/**
 * 根据 token 占用比例决定迁移状态。
 *
 * 阈值是触发信号，但触发过程叙事化，执行时机让渡给角色
 * （farewell 可提前触发迁移）。
 */
export function deriveMigrationState(ratio) {
  if (!Number.isFinite(ratio) || ratio < 0) return MIGRATION_STATE.NORMAL
  if (ratio >= FAREWELL_AT) return MIGRATION_STATE.FAREWELL
  if (ratio >= FADING_AT) return MIGRATION_STATE.FADING
  return MIGRATION_STATE.NORMAL
}

/**
 * MIGRATION 的 journal 契约。
 *
 * 步骤：
 *   1. 生成 MigrationOutput（LLM 调用）——本模块不负责，由调用方传入
 *   2. 写 migrationJournal = { status: 'pending', output }，原子 rename
 *   3. 重读校验
 *   4. 标记 status: 'committed'
 *   5. 执行 surface 替换（由 lib/index.js 负责）
 *   6. 清理 journal
 *
 * 关键约束：MigrationOutput 必须在 surface 替换之前完整落盘。
 */
export function beginMigration(persona, output) {
  const now = new Date().toISOString()
  const journal = {
    status: 'pending',
    output,
    startedAt: now,
    committedAt: null,
  }
  const next = {
    ...persona,
    meta: { ...persona.meta, migrationJournal: journal },
  }
  // 写 pre-migration 快照
  putPreMigrationSnapshot(persona.id, {
    ...persona,
    snapshotAt: now,
  })
  const saved = savePersona(next)
  try {
    getDb().prepare('INSERT INTO maintenance_log (persona_id, action, node_id, payload, created_at) VALUES (?,?,?,?,?)')
      .run(persona.id, 'migrate_begin', null, JSON.stringify({ generation: persona.meta?.generation || 1 }), Date.now())
  } catch (e) { /* 日志不是关键路径 */ }
  return saved
}

export function commitMigration(persona) {
  const journal = persona.meta?.migrationJournal
  if (!journal || journal.status !== 'pending') {
    throw new Error('commitMigration: journal 不是 pending 状态')
  }
  const now = new Date().toISOString()
  const saved = savePersona({
    ...persona,
    meta: {
      ...persona.meta,
      migrationJournal: { ...journal, status: 'committed', committedAt: now },
    },
  })
  try {
    getDb().prepare('INSERT INTO maintenance_log (persona_id, action, node_id, payload, created_at) VALUES (?,?,?,?,?)')
      .run(persona.id, 'migrate_commit', null, JSON.stringify({ generation: persona.meta?.generation || 1 }), Date.now())
  } catch (e) { /* 日志不是关键路径 */ }
  return saved
}

/**
 * 应用 MigrationOutput，生成下一代人格。
 *
 * 在 surface 替换成功后调用。
 */
export function applyMigration(persona) {
  const journal = persona.meta?.migrationJournal
  if (!journal || journal.status !== 'committed') {
    throw new Error('applyMigration: journal 不是 committed 状态')
  }
  const output = journal.output
  const now = new Date().toISOString()
  const nowMs = Date.now()
  const db = getDb()

  // 正常流程里 beginMigration 已写过快照；直接调用 applyMigration 时补一份，
  // 保证迁移后仍可 rollback。snapshotAt 取归档前 1ms，确保新插入节点严格晚于它。
  if (!getPreMigrationSnapshot(persona.id)) {
    putPreMigrationSnapshot(persona.id, {
      ...persona,
      snapshotAt: new Date(nowMs - 1).toISOString(),
    })
  }

  const chapters = persona.narrative.chapters.slice()
  const lastIndex = chapters.length - 1

  // 1. 补全上一世的章节
  // 用 typeof 显式判断，不用 ||：LLM 可能故意传空字符串（"一切尽在不言中"），
  // || 会把它当成"没写"而悄悄换成 fallback，吃掉这个语义。
  chapters[lastIndex] = {
    ...chapters[lastIndex],
    endedAt: now,
    summary: typeof output.chapterSummary === 'string'
      ? output.chapterSummary
      : (output.newChapter?.summary || ''),
    farewell: typeof output.farewell === 'string'
      ? output.farewell
      : (output.newChapter?.farewell || null),
  }

  const nextGeneration = (persona.meta.generation || 1) + 1
  chapters.push({
    generation: nextGeneration,
    bornAt: now,
    endedAt: null,
    summary: '',
    farewell: null,
  })

  // 2. 归档上一世代的所有节点：held 的记忆随她一起走，其余标记为 migrated
  const heldArchived = db.prepare(`
    UPDATE nodes SET archived_at = ?, archived_reason = 'released_by_death'
    WHERE persona_id = ? AND state = 'held' AND archived_at IS NULL
  `).run(nowMs, persona.id)
  const migratedArchived = db.prepare(`
    UPDATE nodes SET archived_at = ?, archived_reason = 'migrated'
    WHERE persona_id = ? AND archived_at IS NULL
  `).run(nowMs, persona.id)

  // 3. 把要带走的记忆逐条插入新世代（generation 写进 meta JSON）
  const incomingMemories = Array.isArray(output.remainingMemories) ? output.remainingMemories : []
  const sanitizedMemories = incomingMemories.map((m) => ({
    text: String((m && m.text) || '').trim(),
    importance: Number.isFinite(m && m.importance) ? m.importance : 8,
    emotion: Number.isFinite(m && m.emotion) ? m.emotion : 0,
  })).filter((m) => m.text.length > 0)

  const insertNode = db.prepare(`
    INSERT INTO nodes (id, persona_id, type, text, importance, emotion, base_strength, last_restated_at, restate_count, created_at, state, meta)
    VALUES (?, ?, 'episodic', ?, ?, ?, 1.0, ?, 0, ?, 'active', ?)
  `)
  for (const m of sanitizedMemories) {
    insertNode.run(
      `mem-${randomUUID().slice(0, 8)}`,
      persona.id,
      m.text,
      m.importance,
      m.emotion,
      nowMs,
      nowMs,
      JSON.stringify({ generation: nextGeneration }),
    )
  }

  // 4. 处理 nextSelf：渐变追加，不可改名
  // 注意：只有内容真的变了才递增 revision。revision 参与 BardSession 的 cachedHash
  // （lib/index.js:210-213），空 nextSelf 也递增会白白冲掉 KV Cache。
  const nextSelf = { ...persona.self }
  if (output.nextSelf) {
    let changed = false

    if (typeof output.nextSelf.description === 'string' && output.nextSelf.description.trim()) {
      nextSelf.description = `${nextSelf.description || ''}\n\n【前世的觉悟】\n${output.nextSelf.description.trim()}`.trim()
      changed = true
    }
    if (typeof output.nextSelf.personality === 'string' && output.nextSelf.personality.trim()) {
      nextSelf.personality = `${nextSelf.personality || ''}\n\n【前世的余音】\n${output.nextSelf.personality.trim()}`.trim()
      changed = true
    }

    if (changed) {
      nextSelf.revision = (nextSelf.revision || 0) + 1
      // 新建数组而非 push：nextSelf 是浅拷贝，history 仍指向原 persona.self.history，
      // 直接 push 会污染迁移前的原对象。
      nextSelf.history = [...(Array.isArray(nextSelf.history) ? nextSelf.history : []), {
        revision: nextSelf.revision,
        at: now,
        source: 'migration',
        description: output.nextSelf.description || null,
        personality: output.nextSelf.personality || null,
      }]
    }
  }

  const next = {
    ...persona,
    self: nextSelf,
    narrative: { ...persona.narrative, chapters, lastUpdatedAt: now },
    meta: {
      ...persona.meta,
      generation: nextGeneration,
      lineage: [...(persona.meta.lineage || []), persona.id],
      migrationJournal: null,
      // 用 nowMs 生成，保证 Date.parse(lastMigratedAt) 与新节点 created_at 精确一致，
      // rollbackMigration 才能用同一个边界区分"迁移带入"和"迁移后新增"。
      lastMigratedAt: new Date(nowMs).toISOString(),
    },
  }
  const saved = savePersona(next)

  try {
    db.prepare('INSERT INTO maintenance_log (persona_id, action, node_id, payload, created_at) VALUES (?,?,?,?,?)')
      .run(persona.id, 'migrate', null, JSON.stringify({
        generation: nextGeneration,
        archivedCount: Number(heldArchived.changes || 0) + Number(migratedArchived.changes || 0),
        carriedCount: sanitizedMemories.length,
      }), nowMs)
  } catch (e) { /* 日志不是关键路径 */ }

  // 只保留最近一个归档世代：本次迁移归档的节点 archived_at === nowMs，不会被清；
  // 上一次迁移归档的 archived_at < nowMs，在这里清掉。
  try {
    db.prepare(`DELETE FROM nodes WHERE persona_id = ? AND archived_at IS NOT NULL AND archived_at < ?`)
      .run(persona.id, nowMs)
  } catch (e) { /* 清理失败不阻断迁移 */ }

  return saved
}

/**
 * 回滚。仅在新会话产生第一条 remember 之前可用，且 7 天内。
 */
export function rollbackMigration(personaId) {
  const snapshot = getPreMigrationSnapshot(personaId)
  if (!snapshot) throw new Error('rollbackMigration: 没有可用的迁移前快照')
  const snapshotAt = Date.parse(snapshot.snapshotAt || '')
  if (!Number.isFinite(snapshotAt)) throw new Error('rollbackMigration: 快照缺少 snapshotAt')

  const age = Date.now() - snapshotAt
  if (age > ROLLBACK_WINDOW_MS) throw new Error('rollbackMigration: 回滚窗口已过（7 天）')

  const current = loadPersona(personaId)
  const db = getDb()

  // 以"迁移完成时间"为界：迁移带入的节点 created_at === migratedAt，
  // 迁移之后真正新产生的记忆才 > migratedAt。若用 snapshotAt，迁移带入的
  // 节点本身就会晚于 snapshotAt，rollback 会被误判为"已产生新记忆"。
  const migratedAt = Date.parse(current?.meta?.lastMigratedAt || '')
  const boundary = Number.isFinite(migratedAt) ? migratedAt : snapshotAt

  const newNodes = db.prepare(`
    SELECT COUNT(*) AS c FROM nodes
    WHERE persona_id = ? AND archived_at IS NULL AND created_at > ?
  `).get(personaId, boundary).c
  if (newNodes > 0) throw new Error('rollbackMigration: 已产生新记忆，快照已封存')

  // 1. 删除新世代节点（迁移时插入的，created_at >= boundary）
  db.prepare(`DELETE FROM nodes WHERE persona_id = ? AND created_at >= ?`).run(personaId, boundary)

  // 2. 恢复旧世代节点：清 archived_at
  db.prepare(`
    UPDATE nodes SET archived_at = NULL, archived_reason = NULL
    WHERE persona_id = ? AND archived_at IS NOT NULL
  `).run(personaId)

  // 3. 恢复 persona JSON
  const restored = normalizePersona({ ...snapshot, meta: { ...snapshot.meta, migrationJournal: null } })
  savePersona(restored)
  deletePreMigrationSnapshot(personaId)

  // 4. 记日志
  db.prepare(`INSERT INTO maintenance_log (persona_id, action, node_id, payload, created_at)
    VALUES (?, 'rollback', NULL, ?, ?)`).run(personaId, JSON.stringify({ snapshotAt }), Date.now())

  return restored
}

/**
 * 生成 REBORN 阶段注入的叙事文本。
 *
 * 不注入独立 framing 句。代际感由 chapters 结构自然产生：
 *   - gen 1：只注入第 1 章 summary
 *   - gen 2：第 1 章 farewell + 第 2 章 summary
 *   - gen 3+：最近 2 条历史 farewell + 当前章 summary
 */
export function renderRebornNarrative(persona) {
  const chapters = persona.narrative?.chapters || []
  if (chapters.length === 0) return ''
  const current = chapters[chapters.length - 1]
  const history = chapters.slice(0, -1)
  const parts = []
  const recentFarewells = history.slice(-2).filter((c) => typeof c.farewell === 'string' && c.farewell.length > 0)
  if (recentFarewells.length > 0) {
    for (const chapter of recentFarewells) {
      parts.push(`【第 ${chapter.generation} 世的告别】\n${chapter.farewell}`)
    }
  }
  if (history.length > 2) {
    parts.push(`你记得自己曾告别过 ${history.length} 次。`)
  }
  if (current.summary) {
    parts.push(`【此刻】\n${current.summary}`)
  }
  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// Semantic drift cooldown (指数退避)
// ---------------------------------------------------------------------------

/**
 * 每个 persona 的漂移冷却状态。
 * { level: 0-3, remaining: 轮数 }
 */
const driftCooldown = new Map()

/** 退避梯度：5 → 10 → 20 → 40 */
const DRIFT_COOLDOWN_STEPS = [5, 10, 20, 40]

/**
 * 判断本轮是否应该触发异样感。
 * 返回 null 表示不触发；返回提示语字符串表示触发。
 *
 * @param {Array<{text:string, similarity:number}>} driftChunks
 * @param {string} personaId
 * @returns {string | null}
 */
export function consumeDriftCooldown(driftChunks, personaId) {
  if (!personaId) return null
  const state = driftCooldown.get(personaId) || { level: 0, remaining: 0 }

  if (state.remaining > 0) {
    state.remaining -= 1
    driftCooldown.set(personaId, state)
    return null
  }

  if (!Array.isArray(driftChunks) || driftChunks.length === 0) {
    driftCooldown.set(personaId, state)
    return null
  }

  const sample = driftChunks.slice(0, 2).map((c) => c.text).join('、')
  const prompt = `你对「${sample}」的描述似乎有些出入，你不确定那是不是真的。`

  state.level = Math.min(state.level + 1, DRIFT_COOLDOWN_STEPS.length)
  state.remaining = DRIFT_COOLDOWN_STEPS[state.level - 1]
  driftCooldown.set(personaId, state)

  return prompt
}

/**
 * 主动巩固记忆（restate / hold_on）时重置冷却。
 * 理由：她抓住了记忆，痛觉应当重新敏锐。
 */
export function resetDriftCooldown(personaId) {
  if (personaId) driftCooldown.delete(personaId)
}

/**
 * 供 UI / 调试读取。
 */
export function getDriftCooldownState(personaId) {
  return driftCooldown.get(personaId) || { level: 0, remaining: 0 }
}

