/**
 * Sediment Pool (Subconscious).
 * 
 * 绝对灰色的潜意识沉积池。不可被 AI 直接读取。
 * 接收被挤出脑内的记忆碎片，进行语义去重与废词过滤，供梦境生成调用。
 */

import fs from 'node:fs'
import path from 'node:path'
import { bardDirs } from './store.js'
import { enhancedSimilarity } from './semantic-detector.js'

const MAX_SEDIMENT_ITEMS = 50
const MIN_FRAGMENT_LENGTH = 4
const DEDUPLICATION_THRESHOLD = 0.75

// 常见的无意义短句/语气词黑名单
const STOP_WORDS = new Set([
  '好的', '嗯', '知道了', '明白了', '没问题', '可以', '收到',
  '谢谢', '不客气', '哈哈', '好的吧', '行吧', '没事'
])

function getSedimentPath() {
  return path.join(bardDirs().root, 'sediment.json')
}

function loadPool() {
  const file = getSedimentPath()
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (Array.isArray(data)) return data
    }
  } catch (e) {
    // 文件损坏则重置
  }
  return []
}

function savePool(pool) {
  const file = getSedimentPath()
  try {
    fs.writeFileSync(file, JSON.stringify(pool, null, 2), { mode: 0o600 })
  } catch (e) {
    // 忽略写盘失败，防止阻塞主流程
  }
}

/**
 * 将一个完整的脑内记忆分解，过滤后放入沉积池。
 * @param {string} text - 被挤出的记忆文本
 * @returns {string[]} 实际入池的有效碎片
 */
export function pushToSediment(text) {
  if (typeof text !== 'string' || !text.trim()) return []

  let pool = loadPool()
  const newFragments = []

  // 1. 切分并清理标点
  const chunks = text
    .split(/[。！？；,.;!?]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_FRAGMENT_LENGTH)

  for (const chunk of chunks) {
    // 2. 废词过滤
    if (STOP_WORDS.has(chunk)) continue

    // 3. 语义去重
    let isDuplicate = false
    for (const existing of pool) {
      // 只要发现和池中已有的碎片极度相似，就抛弃
      if (enhancedSimilarity(chunk, existing.text) > DEDUPLICATION_THRESHOLD) {
        isDuplicate = true
        break
      }
    }
    if (isDuplicate) continue

    // 4. 构建碎片对象
    const fragment = {
      text: chunk,
      createdAt: Date.now()
    }
    pool.push(fragment)
    newFragments.push(chunk)
  }

  // 5. FIFO 无情淘汰
  if (pool.length > MAX_SEDIMENT_ITEMS) {
    pool = pool.slice(-MAX_SEDIMENT_ITEMS)
  }

  if (newFragments.length > 0) {
    savePool(pool)
  }

  return newFragments
}

/**
 * 随机抽取碎片，用于拼装梦境。
 * @param {number} count - 期望抽取的数量
 * @returns {string[]} 碎片文本数组
 */
export function drawDreamFragments(count = 3) {
  const pool = loadPool()
  if (pool.length === 0) return []

  // 打乱池子
  const shuffled = [...pool].sort(() => Math.random() - 0.5)
  const actualCount = Math.min(count, pool.length)
  
  return shuffled.slice(0, actualCount).map((item) => item.text)
}

/**
 * 清空沉积池（测试或特殊重置时使用）。
 */
export function clearSediment() {
  savePool([])
}