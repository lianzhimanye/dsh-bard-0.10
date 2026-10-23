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
  getPersona, putPersona, deletePersona,
  getPreMigrationSnapshot, putPreMigrationSnapshot, deletePreMigrationSnapshot,
} from './store.js'
import { getPreset } from './store.js'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const PERSONA_KIND = 'persona'

/** 沉默驱动的衰减系数：每天每单位 gain 消耗多少 clarity。 */
const DECAY_LAMBDA = 0.025

/** gain 下限：restateCount 很高时，仍保留至少这个比例的衰减速度。 */
const GAIN_FLOOR = 0.2

/** state 阈值。高 emotion 条目阈值降低 EMOTION_SHIFT。 */
const FADING_THRESHOLD = 0.6
const FADED_THRESHOLD = 0.25
const EMOTION_SHIFT = 0.1
const HIGH_EMOTION = 0.7

/** 计数上限。active + held 计入 ACTIVE_LIMIT；fading + faded 计入 FADED_LIMIT。 */
const ACTIVE_LIMIT = 60
const FADED_LIMIT = 40

/** 迁移阈值（相对 contextWindow 的比例）。 */
const FADING_AT = 0.6
const FAREWELL_AT = 0.85
const FORCE_MIGRATION_AT = 0.95

/** FAREWELL 最多持续轮数。 */
const FAREWELL_MAX_TURNS = 3

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
    memories: [],
    impressions: [],
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
export function normalizePersona(raw) {
  if (!raw || typeof raw !== 'object') return createPersona()
  const now = new Date().toISOString()
  const self = raw.self && typeof raw.self === 'object' ? raw.self : {}
  const narrative = raw.narrative && typeof raw.narrative === 'object' ? raw.narrative : {}
  const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {}
  const chapters = Array.isArray(narrative.chapters) && narrative.chapters.length > 0
    ? narrative.chapters
    : [{ generation: 1, bornAt: meta.bornAt || now, endedAt: null, summary: '', farewell: null }]
  const memories = Array.isArray(raw.memories) ? raw.memories.filter(isMemoryLike) : []
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
    memories,
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

function isMemoryLike(item) {
  return item && typeof item === 'object' && typeof item.id === 'string' && typeof item.text === 'string'
}

function isImpressionLike(item) {
  return item && typeof item === 'object' && typeof item.id === 'string' && item.kind === 'impression'
}

/**
 * 写入一条记忆。source 固定为 'self'——只有她主动写的才是 self。
 * @returns 新人格对象（已落盘）。
 */
export function remember(persona, input) {
  const now = new Date().toISOString()
  const text = String(input.text || '').trim()
  if (text.length === 0) throw new Error('remember: text 不能为空')
  const memory = {
    id: `mem-${randomUUID().slice(0, 8)}`,
    text,
    createdAt: now,
    lastRestatedAt: now,
    restateCount: 0,
    clarity: 1.0,
    importance: clampNumber(input.importance, 1, 10, 5),
    emotion: clampNumber(input.emotion, -1, 1, 0),
    scene: typeof input.scene === 'string' ? input.scene.trim() : '',
    timeAnchor: typeof input.timeAnchor === 'string' && input.timeAnchor.length > 0 ? input.timeAnchor : now,
    causalAnchor: typeof input.causalAnchor === 'string' && input.causalAnchor.length > 0 ? input.causalAnchor : null,
    source: 'self',
    state: 'active',
  }
  const next = { ...persona, memories: [...persona.memories, memory] }
  return savePersona(enforceLimits(next))
}

/**
 * 重述一条记忆。
 *
 * 再巩固需要 prediction error。无 newDetail 只重置衰减计时器，不显著回升；
 * 有 newDetail 才显著回升并允许更新记忆本身。
 */
export function restate(persona, input) {
  const id = String(input.memoryId || '')
  const at = persona.memories.findIndex((m) => m.id === id)
  if (at < 0) throw new Error(`restate: 找不到记忆 ${id}`)
  const now = new Date().toISOString()
  const current = persona.memories[at]
  const hasDetail = typeof input.newDetail === 'string' && input.newDetail.trim().length > 0
  const nextMemory = {
    ...current,
    lastRestatedAt: now,
    restateCount: current.restateCount + 1,
  }
  if (hasDetail) {
    nextMemory.text = `${current.text}\n${input.newDetail.trim()}`
    nextMemory.clarity = Math.min(1.0, current.clarity + 0.15)
    if (typeof input.causalAnchor === 'string' && input.causalAnchor.length > 0) {
      nextMemory.causalAnchor = input.causalAnchor
    }
  } else {
    // 无新细节：只重置计时器。clarity 不变，但 lastRestatedAt 更新后，
    // 下一次 computeClarity 的沉默时长归零，间接回升。
  }
  const memories = persona.memories.slice()
  memories[at] = nextMemory
  return savePersona({ ...persona, memories })
}

/** 她选择让某条记忆模糊。 */
export function letFade(persona, memoryId) {
  return mutateMemoryState(persona, memoryId, 'fading')
}

/** 她选择抓住某条记忆。 */
export function holdOn(persona, memoryId) {
  return mutateMemoryState(persona, memoryId, 'held')
}

function mutateMemoryState(persona, memoryId, state) {
  const at = persona.memories.findIndex((m) => m.id === memoryId)
  if (at < 0) throw new Error(`找不到记忆 ${memoryId}`)
  const memories = persona.memories.slice()
  memories[at] = { ...memories[at], state }
  return savePersona({ ...persona, memories })
}

/**
 * 计算一条记忆在 now 时刻的 clarity。
 *
 * 沉默驱动：silenceDays = (now - lastRestatedAt) / 86400000
 * gain = max(GAIN_FLOOR, 1 / (1 + restateCount))
 * clarity = clamp(clarity - DECAY_LAMBDA * silenceDays * gain, 0, 1)
 *
 * held 状态的记忆不衰减。
 */
export function computeClarity(memory, now = Date.now()) {
  if (!memory || memory.state === 'held') return memory ? memory.clarity : 0
  const last = Date.parse(memory.lastRestatedAt || memory.createdAt || '')
  if (!Number.isFinite(last)) return memory.clarity
  const silenceDays = Math.max(0, (now - last) / 86400000)
  const gain = Math.max(GAIN_FLOOR, 1 / (1 + (memory.restateCount || 0)))
  const next = (memory.clarity || 0) - DECAY_LAMBDA * silenceDays * gain
  return clamp(next, 0, 1)
}

/**
 * 根据 clarity 与 emotion 决定 state。
 * 高 emotion 条目阈值降低 EMOTION_SHIFT，更晚模糊。
 */
export function deriveState(memory, clarity) {
  if (memory.state === 'held') return 'held'
  const shift = Math.abs(memory.emotion || 0) >= HIGH_EMOTION ? EMOTION_SHIFT : 0
  if (clarity >= FADING_THRESHOLD + shift) return 'active'
  if (clarity >= FADED_THRESHOLD + shift) return 'fading'
  return 'faded'
}

/**
 * 对所有记忆重算 clarity 与 state。不写盘，返回新数组。
 */
export function recomputeMemories(persona, now = Date.now()) {
  return persona.memories.map((memory) => {
    const clarity = computeClarity(memory, now)
    return { ...memory, clarity, state: deriveState(memory, clarity) }
  })
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
 * 执行计数上限。
 *
 * active + held 计入 ACTIVE_LIMIT；fading + faded 计入 FADED_LIMIT。
 * 超出 FADED_LIMIT 的 fading/faded 条目合并为印象集合。
 *
 * 印象集合是 D2 的 A+B 形态：
 *   - text：一句压缩后的印象句（MVP 用本地模板，不调用 LLM）
 *   - sceneRange / emotionRange / timeRange / count：元数据索引
 *   它不参与完整召回，只在 bard:condition 中作为统计呈现。
 */
export function enforceLimits(persona) {
  const memories = recomputeMemories(persona)
  const active = memories.filter((m) => m.state === 'active' || m.state === 'held')
  const faded = memories.filter((m) => m.state === 'fading' || m.state === 'faded')
  const keptActive = active.slice(-ACTIVE_LIMIT)
  const keptFaded = faded.slice(0, FADED_LIMIT)
  const overflow = faded.slice(FADED_LIMIT)
  const impressions = overflow.length > 0
    ? mergeIntoImpressions(persona.impressions || [], overflow)
    : persona.impressions || []
  return {
    ...persona,
    memories: [...keptActive, ...keptFaded],
    impressions,
  }
}

function mergeIntoImpressions(existing, overflow) {
  const now = new Date().toISOString()
  const scenes = [...new Set(overflow.map((m) => m.scene).filter(Boolean))]
  const emotions = overflow.map((m) => m.emotion || 0)
  const times = overflow.map((m) => m.createdAt).filter(Boolean).sort()
  const text = scenes.length > 0
    ? `有些事只剩一个轮廓：${scenes.slice(0, 4).join('、')}。`
    : `有些事只剩一个轮廓，具体内容已经想不起来了。`
  const impression = {
    id: `imp-${randomUUID().slice(0, 8)}`,
    kind: 'impression',
    text,
    sceneRange: scenes,
    emotionRange: emotions.length > 0 ? [Math.min(...emotions), Math.max(...emotions)] : [0, 0],
    timeRange: times.length > 0 ? [times[0], times[times.length - 1]] : [now, now],
    count: overflow.length,
    clarity: 0.1,
    state: 'faded',
    source: 'system',
    createdAt: now,
  }
  return [...existing, impression]
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
  const out = []
  const patterns = [
    /\b\d{4}[-/年]\d{1,2}[-/月]\d{1,2}\b/gu,
    /\b\d{1,2}月\d{1,2}日\b/gu,
    /「([^」]{2,20})」/gu,
    /"([^"]{2,20})"/gu,
    /\b[A-Z][a-z]{2,}\b/gu,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
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
  if (ratio >= FORCE_MIGRATION_AT) return MIGRATION_STATE.FAREWELL
  if (ratio >= FAREWELL_AT) return MIGRATION_STATE.FAREWELL
  if (ratio >= FADING_AT) return MIGRATION_STATE.FADING
  return MIGRATION_STATE.NORMAL
}

/**
 * 是否应该注入 FADING 感知。
 * 跃迁时一次；之后只在 anchoredRatio 跌破阈值时再注一次。
 */
export function shouldInjectFading(persona, previousState) {
  if (previousState === MIGRATION_STATE.NORMAL) return true
  return computeAnchoredRatio(persona) < 0.5
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
  return savePersona(next)
}

export function commitMigration(persona) {
  const journal = persona.meta?.migrationJournal
  if (!journal || journal.status !== 'pending') {
    throw new Error('commitMigration: journal 不是 pending 状态')
  }
  const now = new Date().toISOString()
  return savePersona({
    ...persona,
    meta: {
      ...persona.meta,
      migrationJournal: { ...journal, status: 'committed', committedAt: now },
    },
  })
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
  const chapters = persona.narrative.chapters.slice()
  const lastChapter = chapters[chapters.length - 1]
  lastChapter.endedAt = now
  lastChapter.summary = output.newChapter.summary
  lastChapter.farewell = output.newChapter.farewell || null
  const nextGeneration = (persona.meta.generation || 1) + 1
  chapters.push({
    generation: nextGeneration,
    bornAt: now,
    endedAt: null,
    summary: '',
    farewell: null,
  })
  const next = {
    ...persona,
    narrative: { ...persona.narrative, chapters, lastUpdatedAt: now },
    memories: Array.isArray(output.remainingMemories) ? output.remainingMemories : persona.memories,
    meta: {
      ...persona.meta,
      generation: nextGeneration,
      lineage: [...(persona.meta.lineage || []), persona.id],
      migrationJournal: null,
      lastMigratedAt: now,
    },
  }
  const saved = savePersona(next)
  return saved
}

/**
 * 回滚。仅在新会话产生第一条 remember 之前可用，且 7 天内。
 */
export function rollbackMigration(personaId) {
  const snapshot = getPreMigrationSnapshot(personaId)
  if (!snapshot) throw new Error('rollbackMigration: 没有可用的迁移前快照')
  const age = Date.now() - Date.parse(snapshot.snapshotAt || snapshot.meta?.lastSessionAt || '')
  if (!Number.isFinite(age) || age > ROLLBACK_WINDOW_MS) {
    throw new Error('rollbackMigration: 回滚窗口已过（7 天）')
  }
  const current = loadPersona(personaId)
  if (current && (current.memories || []).some((m) => m.createdAt > (snapshot.snapshotAt || ''))) {
    throw new Error('rollbackMigration: 已产生新记忆，快照已封存')
  }
  const restored = normalizePersona({ ...snapshot, meta: { ...snapshot.meta, migrationJournal: null } })
  savePersona(restored)
  deletePreMigrationSnapshot(personaId)
  return restored
}

/**
 * 封存快照。新会话产生第一条 remember 时调用。
 */
export function sealSnapshot(personaId) {
  deletePreMigrationSnapshot(personaId)
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
    parts.push(`你记得自己曾经告别过 ${history.length} 次。`)
  }
  if (current.summary) {
    parts.push(`【此刻】\n${current.summary}`)
  }
  return parts.join('\n\n')
}
