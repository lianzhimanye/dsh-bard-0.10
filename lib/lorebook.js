/**
 * World books (lorebooks / World Info).
 *
 * Three on-disk shapes are accepted and flattened into one record:
 *   - the classic SillyTavern World Info export, whose `entries` is an object
 *     keyed by uid and whose keyword arrays are `key` / `keysecondary`;
 *   - the same document with `entries` as an array;
 *   - a Character-Card-V2 `character_book`, whose keyword arrays are `keys` /
 *     `secondary_keys` and whose enable flag is inverted (`enabled`, not
 *     `disable`).
 *
 * Selection follows SillyTavern's World Info semantics:
 *   - constant entries always activate; others require a primary-key match
 *     against the transcript;
 *   - selective entries gate on secondary keys with one of four logics
 *     (AND_ANY / AND_ALL / NOT_ANY / NOT_ALL);
 *   - probability < 100 gates the entry on each request;
 *   - matched entries' content is rescanned as a synthetic transcript for up
 *     to `maxRecursion` rounds (default 3), so an entry can activate another;
 *   - the final set is rendered in position-bucketed groups
 *     (background / supplement / situational).
 */

function asString(value) {
  return typeof value === 'string' ? value : ''
}

function toKeys(value) {
  if (Array.isArray(value)) {
    return value.map((item) => asString(item).trim()).filter((item) => item.length > 0)
  }
  if (typeof value === 'string') {
    // Writers store comma-separated keys in the flat V1 shape.
    return value.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
  }
  return []
}

function pick(object, ...names) {
  for (const name of names) {
    if (object && object[name] !== undefined && object[name] !== null) return object[name]
  }
  return undefined
}

/** 数字字段归一化。保留 0，非法值回退到 fallback。 */
function pickNumber(entry, names, fallback) {
  const raw = pick(entry, ...names)
  if (raw === undefined || raw === null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

/** ST selectiveLogic 数字编码 → 字符串。已是字符串则直接返回大写形式。 */
const SELECTIVE_LOGIC_BY_NUMBER = { 0: 'AND_ANY', 1: 'NOT_ALL', 2: 'NOT_ANY', 3: 'AND_ALL' }
const SELECTIVE_LOGIC_VALUES = new Set(['AND_ANY', 'AND_ALL', 'NOT_ANY', 'NOT_ALL'])

function normalizeSelectiveLogic(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return SELECTIVE_LOGIC_BY_NUMBER[raw] || 'AND_ANY'
  }
  if (typeof raw === 'string') {
    const upper = raw.toUpperCase()
    if (SELECTIVE_LOGIC_VALUES.has(upper)) return upper
    const n = Number(raw)
    if (Number.isFinite(n)) return SELECTIVE_LOGIC_BY_NUMBER[n] || 'AND_ANY'
  }
  return 'AND_ANY'
}

/** Normalize one entry, whichever dialect it came from. */
function normalizeEntry(entry, index) {
  if (!entry || typeof entry !== 'object') return null
  const keys = toKeys(pick(entry, 'keys', 'key'))
  const secondaryKeys = toKeys(pick(entry, 'secondary_keys', 'keysecondary', 'keySecondary'))
  const content = asString(entry.content)
  if (content.trim().length === 0) return null
  const disableRaw = pick(entry, 'disable', 'disabled')
  const enabledRaw = pick(entry, 'enabled')
  return {
    id: String(pick(entry, 'uid', 'id') ?? index),
    comment: asString(pick(entry, 'comment', 'name', 'title')).trim() || keys[0] || `条目 ${index + 1}`,
    keys,
    secondaryKeys,
    content,
    // `enabled` (V2) wins when present; otherwise `disable` (World Info) is inverted.
    enabled: enabledRaw === undefined ? disableRaw !== true : enabledRaw !== false,
    constant: pick(entry, 'constant') === true,
    selective: pick(entry, 'selective') === true,
    caseSensitive: pick(entry, 'case_sensitive', 'caseSensitive') === true,
    matchWholeWords: pick(entry, 'match_whole_words', 'matchWholeWords') === true,
    order: pickNumber(entry, ['insertion_order', 'order'], 0),
    priority: pickNumber(entry, ['priority'], 0),
    probability: pickNumber(entry, ['probability'], 100),
    selectiveLogic: normalizeSelectiveLogic(pick(entry, 'selectiveLogic', 'selective_logic')),
    position: pickNumber(entry, ['position'], 1),
    depth: pickNumber(entry, ['depth'], 4),
    excludeRecursion: pick(entry, 'excludeRecursion', 'exclude_recursion') === true,
    preventRecursion: pick(entry, 'preventRecursion', 'prevent_recursion') === true,
  }
}

/**
 * Flatten a world-book document.
 * @param raw - the parsed JSON document.
 * @param meta - provenance recorded beside the book.
 */
function normalizeWorldBook(raw, meta = {}) {
  const container = raw && typeof raw === 'object' ? (raw.entries ?? raw) : {}
  const list = []
  if (Array.isArray(container)) {
    container.forEach((entry, index) => {
      const normalized = normalizeEntry(entry, index)
      if (normalized) list.push(normalized)
    })
  } else if (container && typeof container === 'object') {
    Object.keys(container).forEach((key, index) => {
      const normalized = normalizeEntry(container[key], index)
      if (normalized) list.push(normalized)
    })
  }
  return {
    id: meta.id,
    name: asString(pick(raw, 'name', 'comment')).trim() || meta.name || '未命名世界书',
    source: meta.source || 'import',
    importedAt: meta.importedAt || new Date().toISOString(),
    entries: list,
  }
}

/** Build a world book from a card's embedded `character_book`. */
export function worldBookFromCharacterBook(book, meta = {}) {
  return normalizeWorldBook(book, { ...meta, source: 'character_book' })
}

/** Parse a world-book JSON buffer, with a message a human can act on. */
export function readWorldBookDocument(bytes, fileName = '') {
  let parsed
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    throw new Error(`世界书必须是 JSON 文件（${String((error && error.message) || error)}）`)
  }
  if (parsed === null || typeof parsed !== 'object') throw new Error('世界书 JSON 必须是一个对象')
  const book = normalizeWorldBook(parsed, { name: fileName.replace(/\.json$/iu, '') })
  if (book.entries.length === 0) throw new Error('这个世界书里没有任何可用条目')
  return book
}

function matches(text, needle, caseSensitive, wholeWords) {
  if (needle.length === 0) return false
  if (caseSensitive) {
    return wholeWords ? new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, 'u').test(text) : text.includes(needle)
  }
  const haystack = text.toLowerCase()
  const target = needle.toLowerCase()
  return wholeWords ? new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(target)}(?![\\p{L}\\p{N}])`, 'u').test(haystack) : haystack.includes(target)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * FNV-1a 32 位哈希。用于把 (transcript, entry.id) 映射到 [0, 99] 的
 * 稳定桶号，替代 Math.random()。不追求密码学强度，只要确定、分布均匀。
 */
function stableHash(input) {
  let hash = 2166136261
  const text = String(input)
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/**
 * 次级键门控。ST 的 selectiveLogic 四值：
 *   AND_ANY — 任一命中（默认）
 *   AND_ALL — 全部命中
 *   NOT_ANY — 任一命中则否定
 *   NOT_ALL — 全部命中则否定
 * 无次级键时一律通过。
 */
function matchSecondary(keys, text, caseSensitive, wholeWords, logic) {
  if (keys.length === 0) return true
  const hits = keys.map((key) => matches(text, key, caseSensitive, wholeWords))
  switch (logic) {
    case 'AND_ALL': return hits.every(Boolean)
    case 'NOT_ANY': return !hits.some(Boolean)
    case 'NOT_ALL': return !hits.every(Boolean)
    case 'AND_ANY':
    default:        return hits.some(Boolean)
  }
}

/**
 * 选出 transcript 激活的世界书条目。
 *
 * 流程：
 *   1. 摊平所有 enabled 条目
 *   2. 第一轮扫 transcript，constant 免关键词但仍过 probability
 *   3. 递归轮：用已命中条目的 content 拼成新 transcript，最多 maxRecursion 层
 *      - preventRecursion 的条目不作为触发器
 *      - excludeRecursion 的条目不被递归命中
 *      - constant 不参与递归轮
 *   4. 按 priority → order → comment 排序，按 maxEntries / maxChars 裁剪
 *      - 首条超预算强制注入（保持旧行为）
 *
 * 递归轮与第一轮共用 picked 去重，循环引用不会死循环。
 */
export function selectLore(books, transcript, options = {}) {
  const maxEntries = Number.isFinite(options.maxEntries) ? options.maxEntries : 12
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : 6000
  const maxRecursion = Number.isFinite(options.maxRecursion) ? Math.max(0, options.maxRecursion) : 3

  const pool = []
  for (const book of books || []) {
    if (!book) continue
    for (const entry of book.entries || []) {
      if (entry.enabled) pool.push({ book, entry })
    }
  }

  const picked = new Map()
  const keyOf = (item) => `${item.book.id}\u0000${item.entry.id}`

  /**
   * 扫描一段文本。返回本轮新命中的条目。
   * @param text - 待匹配文本。
   * @param allowConstant - 是否处理 constant 条目（仅第一轮 true）。
   * @param skipExcludeRecursion - 是否跳过 excludeRecursion 条目（仅递归轮 true）。
   */
  const scan = (text, allowConstant, skipExcludeRecursion) => {
    const fresh = []
    for (const item of pool) {
      const key = keyOf(item)
      if (picked.has(key)) continue
      const { entry } = item
      if (skipExcludeRecursion && entry.excludeRecursion) continue
      if (entry.constant) {
        if (!allowConstant) continue
      } else {
        if (entry.keys.length === 0) continue
        if (!entry.keys.some((k) => matches(text, k, entry.caseSensitive, entry.matchWholeWords))) continue
        if (entry.selective
          && !matchSecondary(entry.secondaryKeys, text, entry.caseSensitive, entry.matchWholeWords, entry.selectiveLogic)) continue
      }
      if (entry.probability < 100) {
        // 用 (transcript + entry.id) 的稳定哈希代替 Math.random。
        // 同一 transcript 下每次结果一致，保住 provider 的 prompt cache。
        const bucket = stableHash(`${text}\u0000${entry.id}`) % 100
        if (bucket >= entry.probability) continue
      }
      picked.set(key, item)
      fresh.push(item)
    }
    return fresh
  }

  let frontier = scan(transcript, true, false)

  for (let depth = 0; depth < maxRecursion && frontier.length > 0; depth++) {
    const trigger = frontier
      .filter((item) => !item.entry.preventRecursion)
      .map((item) => item.entry.content)
      .join('\n')
    if (trigger.length === 0) break
    frontier = scan(trigger, false, true)
  }

  const chosen = [...picked.values()]
  chosen.sort((a, b) =>
    (b.entry.priority - a.entry.priority)
    || (b.entry.order - a.entry.order)
    || a.entry.comment.localeCompare(b.entry.comment),
  )

  const out = []
  let budget = maxChars
  for (const item of chosen) {
    if (out.length >= maxEntries) break
    const cost = item.entry.content.length
    if (cost > budget && out.length > 0) continue
    budget -= cost
    out.push(item)
  }
  return out
}

/** position 数值 → 渲染 bucket。2/3 并入 supplement，避免重复标题。 */
const POSITION_BUCKET = { 0: 'background', 1: 'supplement', 2: 'supplement', 3: 'supplement', 4: 'situational' }
const BUCKET_LABEL = { background: '背景设定', supplement: '补充设定', situational: '实时情境' }
const BUCKET_ORDER = ['background', 'supplement', 'situational']

/**
 * 渲染已选条目。
 * 单一 bucket 时不加小标题（与旧行为一致）；多 bucket 时按 background → supplement → situational 分组渲染。
 * 顺序稳定，便于 KV-cache 复用。
 */
export function renderLore(items) {
  if (!items || items.length === 0) return ''
  const unique = new Map()
  for (const item of items) {
    const key = `${item.book.id}\u0000${item.entry.id}`
    if (!unique.has(key)) unique.set(key, item)
  }

  const buckets = new Map()
  for (const item of unique.values()) {
    const pos = Number.isInteger(item.entry.position) ? item.entry.position : 1
    const bucket = POSITION_BUCKET[pos] || 'supplement'
    if (!buckets.has(bucket)) buckets.set(bucket, [])
    buckets.get(bucket).push(item)
  }

  const present = BUCKET_ORDER.filter((b) => buckets.has(b))
  const single = present.length === 1

  return present
    .map((bucket) => {
      const body = buckets.get(bucket)
        .map((item) => `【${item.entry.comment}】\n${item.entry.content}`)
        .join('\n\n')
      return single ? body : `## ${BUCKET_LABEL[bucket]}\n${body}`
    })
    .join('\n\n')
}
