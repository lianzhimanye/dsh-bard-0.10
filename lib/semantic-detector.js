/**
 * Semantic drift detector (vector-based confabulation).
 *
 * 真·虚构症不是无中生有，是把模糊的东西讲成清晰的。
 * 这套检测器只问一个问题：
 *   "这句话，在语义空间上距离它最接近的那条记忆，有多远？"
 *
 * 判定区间：
 *   similarity < 0.5     → 无关创作，不触发
 *   0.5 ≤ similarity < 0.8 → 语义漂移，触发异样感
 *   similarity ≥ 0.8     → 忠实复述，不触发
 *
 * 如果模型加载失败，模块导出仍然有效，但 detectSemanticDrift 会返回 []，
 * 由调用方降级到 alzheimer.js 的日期检测路径。
 */

import path from 'node:path'
import { dice, jaroWinkler, levenshteinSimilarity } from 'strsimkit'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MODEL_ROOT = path.join(__dirname, '..', 'models')
const MODEL_NAME = 'Xenova/bge-small-zh-v1.5'

/** 相似度区间。改这里即可调整灵敏度。 */
export const DRIFT_LOWER = 0.5
export const DRIFT_UPPER = 0.8

let extractorPromise = null
let extractorFailed = false
const memoryVectorCache = new Map()

/**
 * 懒加载 HF pipeline。如果未安装或加载失败，则返回 null。
 */
async function getExtractor() {
  if (extractorFailed) return null
  if (extractorPromise) return extractorPromise
  extractorPromise = (async () => {
    try {
      const mod = await import('@huggingface/transformers')
      const { pipeline, env } = mod
      env.allowLocalModels = true
      env.allowRemoteModels = false
      env.localModelPath = MODEL_ROOT
      const extractor = await pipeline('feature-extraction', MODEL_NAME, { dtype: 'q8' })
      return extractor
    } catch (error) {
      extractorFailed = true
      return null
    }
  })()
  return extractorPromise
}

async function embed(text) {
  const extractor = await getExtractor()
  if (!extractor) return null
  try {
    const output = await extractor(text, { pooling: 'mean', normalize: true })
    return Array.from(output.data)
  } catch (error) {
    return null
  }
}

  /**
 * 组合多种算法，提高中文短句的语义漂移捕捉精度。
 * - Dice/bigram: 捕捉字面重叠
 * - Jaro-Winkler: 捕捉词序和前缀相似性
 * - Levenshtein: 捕捉编辑距离（字面变形程度）
 */
export function enhancedSimilarity(a, b) {
  if (a === b) return 1
  if (!a || !b) return 0

  // 权重可以根据实际效果微调，中文短文本建议 Dice 权重稍高
  const diceScore = dice(a, b)
  const jw = jaroWinkler(a, b)
  const lev = levenshteinSimilarity(a, b)

  return 0.45 * diceScore + 0.35 * jw + 0.20 * lev
}


async function getMemoryVector(memory) {
  if (memoryVectorCache.has(memory.id)) return memoryVectorCache.get(memory.id)
  const vector = await embed(memory.text)
  if (vector) memoryVectorCache.set(memory.id, vector)
  return vector
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * 剥离代码块、行内代码、表格、工具回执，只保留"她自己叙述"的散文。
 */
export function stripNonProse(text) {
  if (typeof text !== 'string') return ''
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/^已(记住|重述|选择|改写|留下)[^\n]*$/gm, ' ')
    .replace(/^你(决定|改写|留下)[^\n]*$/gm, ' ')
}

/**
 * 按中英文句末标点切分语义块。
 */
export function splitIntoSemanticChunks(text) {
  return text
    .split(/(?<=[。！？.!?])\s*/u)
    .map((s) => s.trim())
    .filter((s) => s.length >= 6)
}

/**
 * 语义漂移检测主入口。
 *
 * @param {string} replyText - 角色回复原文。
 * @param {Array} memories - persona.memories（建议先过滤掉 faded）。
 * @param {object} [options]
 * @param {number} [options.lower=0.5]
 * @param {number} [options.upper=0.8]
 * @returns {Promise<Array<{text:string, similarity:number, nearestId:string}>>}
 */
export async function detectSemanticDrift(replyText, memories, options = {}) {
  const lower = Number.isFinite(options.lower) ? options.lower : DRIFT_LOWER
  const upper = Number.isFinite(options.upper) ? options.upper : DRIFT_UPPER

  const prose = stripNonProse(replyText)
  if (prose.length < 10) return []

  const candidates = Array.isArray(memories) ? memories.filter((m) => m && m.state !== 'faded') : []
  if (candidates.length === 0) return []

  const chunks = splitIntoSemanticChunks(prose)
  if (chunks.length === 0) return []

  // 首轮：先确认 extractor 可用。不可用时，直接降级到轻量级字符相似度。
  const probe = await getExtractor()
  if (!probe) {
    const drift = []
    for (const chunk of chunks) {
      let best = 0
      let bestId = ''
      for (const m of candidates) {
        const sim = enhancedSimilarity(chunk, m.text)
        if (sim > best) { best = sim; bestId = m.id }
      }
      // 轻量算法的阈值设定：Dice 系数通常比 Cosine 偏大，设为 0.4 ~ 0.85
      if (best >= 0.4 && best < 0.85) {
        drift.push({ text: chunk, similarity: best, nearestId: bestId })
      }
    }
    return drift
  }

  const memoryVectors = []
  for (const m of candidates) {
    const v = await getMemoryVector(m)
    if (v) memoryVectors.push({ id: m.id, vector: v })
  }
  if (memoryVectors.length === 0) return []

  const drift = []
  for (const chunk of chunks) {
    const chunkVector = await embed(chunk)
    if (!chunkVector) continue
    let best = 0
    let bestId = ''
    for (const mv of memoryVectors) {
      const sim = cosine(chunkVector, mv.vector)
      if (sim > best) { best = sim; bestId = mv.id }
    }
    if (best >= lower && best < upper) {
      drift.push({ text: chunk, similarity: best, nearestId: bestId })
    }
  }
  return drift
}

