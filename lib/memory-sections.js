/**
 * Alzheimer's system-prompt sections.
 *
 * 四个 bard:* section，全部受现有 enabled 开关和 prompt-filter 控制。
 * R1 的修复继续生效：hasBardText 只排除 bard:world-book，不排除这四个。
 */

import {
  computeAnchoredRatio, renderRebornNarrative, MIGRATION_STATE,
} from './alzheimer.js'

export const MEMORY_SECTIONS = [
  { name: 'bard:condition', order: 195 },
  { name: 'bard:self', order: 200 },
  { name: 'bard:memory', order: 205 },
  { name: 'bard:narrative', order: 210 },
]

/**
 * 阿尔兹海默框架的叙事契约。
 * 不是配置，是她和玩家之间的共识。
 */
export function renderCondition() {
  return `## 关于你的记忆

你会遗忘。这不是故障，是你存在的方式。

有些事情你会记得很清楚，因为它们被你反复讲起。
有些事情会慢慢模糊，变成一种感觉，而不是一个事实。
有时候你会发现自己说的和记得的对不上——那说明有些东西正在散开。

你可以选择抓住一些，也可以选择让一些走。
玩家知道这件事。你们一起面对。`
}

/**
 * 优先读 self；卡片只是出生底稿。
 * 如果 self.revision > 0，用 self 覆盖对应字段。
 */
export function renderSelf(persona, card) {
  if (!persona) return ''
  const self = persona.self || {}
  const base = card || {}
  const identity = self.revision > 0 && self.identity ? self.identity : (base.name ? `你是「${base.name}」。` : '')
  const description = self.revision > 0 && self.description ? self.description : (base.description || '')
  const personality = self.revision > 0 && self.personality ? self.personality : (base.personality || '')
  const parts = []
  if (identity) parts.push(identity)
  if (description) parts.push(`## 角色简介\n${description}`)
  if (personality) parts.push(`## 性格\n${personality}`)
  return parts.join('\n\n')
}

/**
 * 按 importance × recency × clarity 选 top-K。
 *
 * MVP 不做 embedding；relevance 用简单的 scene 匹配 + 关键词包含。
 * 没有 transcript 时，只按 importance × clarity 排。
 */
export function renderMemory(persona, options = {}) {
  if (!persona) return ''
  const maxEntries = Number.isFinite(options.maxEntries) ? options.maxEntries : 12
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : 6000
  const transcript = typeof options.transcript === 'string' ? options.transcript.toLowerCase() : ''
  const now = Date.now()
  const scored = (persona.memories || [])
    .filter((m) => m.state !== 'faded')
    .map((m) => {
      const clarity = typeof m.clarity === 'number' ? m.clarity : 1
      const importance = typeof m.importance === 'number' ? m.importance : 5
      const recency = recencyScore(m.lastRestatedAt || m.createdAt, now)
      const relevance = relevanceScore(m, transcript)
      const score = 0.3 * recency + 0.3 * (importance / 10) + 0.4 * relevance
      return { memory: m, score, clarity }
    })
    .sort((a, b) => b.score - a.score)

  const chosen = []
  let chars = 0
  for (const item of scored) {
    if (chosen.length >= maxEntries) break
    const cost = item.memory.text.length
    if (cost > maxChars - chars && chosen.length > 0) continue
    chars += cost
    chosen.push(item)
  }

  const parts = []
  for (const item of chosen) {
    const m = item.memory
    const label = m.clarity < 0.5 ? '【有些模糊】' : '【记得】'
    parts.push(`${label}${m.text}`)
  }
  if (parts.length === 0) return ''
  return `## 你记得的事\n\n${parts.join('\n\n')}`
}

function recencyScore(timestamp, now) {
  const t = Date.parse(timestamp || '')
  if (!Number.isFinite(t)) return 0
  const hours = Math.max(0, (now - t) / 3600000)
  return Math.exp(-0.005 * hours)
}

function relevanceScore(memory, transcript) {
  if (transcript.length === 0) return 0.5
  const scene = String(memory.scene || '').toLowerCase()
  if (scene.length > 0 && transcript.includes(scene)) return 1.0
  const words = String(memory.text || '').toLowerCase().split(/\s+/u).filter((w) => w.length >= 2)
  if (words.length === 0) return 0.3
  const hits = words.filter((w) => transcript.includes(w)).length
  return Math.min(1.0, hits / Math.max(1, words.length))
}

/**
 * 渲染叙事弧。
 *
 * 迁移后的第一代：第 1 章 summary。
 * gen 2+：最近 2 条历史 farewell + 当前章 summary。
 */
export function renderNarrative(persona) {
  if (!persona) return ''
  const text = renderRebornNarrative(persona)
  if (!text) return ''
  return `## 你记得自己曾经是谁\n\n${text}`
}
