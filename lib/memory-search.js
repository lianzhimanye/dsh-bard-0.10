import { getDb } from './db.js'
import { computeClarity } from './clarity.js'

/** 批量刷新 last_accessed_at（多跳扩展命中的节点都算"被想起"）。 */
function touchAccess(db, rows, now) {
  const ids = rows.map((n) => n.id).filter(Boolean)
  if (ids.length === 0) return
  const placeholders = ids.map(() => '?').join(',')
  try {
    db.prepare(`UPDATE nodes SET last_accessed_at = ? WHERE id IN (${placeholders})`).run(now, ...ids)
  } catch (err) {
    // 访问时间戳不是关键路径，失败不阻断检索
  }
}

/** 是否含 CJK 字符（FTS trigram 无命中时走 LIKE 兜底）。 */
function hasCJK(text) {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(text)
}

export function searchMemory(queryText, { personaId, limit = 5, depth = 2 } = {}) {
  if (!personaId) return []
  const db = getDb()
  const now = Date.now()

  if (!queryText || queryText.trim() === '') {
    const rows = db.prepare(`
      SELECT * FROM nodes
      WHERE persona_id = ? AND archived_at IS NULL
      ORDER BY importance DESC, last_restated_at DESC
      LIMIT ?
    `).all(personaId, limit)

    touchAccess(db, rows, now)
    return rows.map((n) => ({ ...n, clarity: computeClarity(n, now) }))
  }

  const safeQuery = queryText.length > 3 ? queryText : `"${queryText}"`

  let startNodes = []
  try {
    startNodes = db.prepare(`
      SELECT n.*
      FROM nodes_fts f
      JOIN nodes n ON n.rowid = f.rowid
      WHERE f.nodes_fts MATCH ? AND n.persona_id = ? AND n.archived_at IS NULL
      ORDER BY rank
      LIMIT ?
    `).all(safeQuery, personaId, limit)
  } catch (err) {
    startNodes = []
  }

  // FTS 无命中且查询含 CJK → LIKE 兜底
  if (startNodes.length === 0 && hasCJK(queryText)) {
    try {
      startNodes = db.prepare(`
        SELECT * FROM nodes
        WHERE persona_id = ? AND archived_at IS NULL AND text LIKE ?
        ORDER BY importance DESC, last_restated_at DESC
        LIMIT ?
      `).all(personaId, `%${queryText.slice(0, 50)}%`, limit)
    } catch (err) {
      startNodes = []
    }
  }

  // 兜底仍空 → importance 保底，不 return []（记忆不能因为检索失败就消失）
  if (startNodes.length === 0) {
    const rows = db.prepare(`
      SELECT * FROM nodes
      WHERE persona_id = ? AND archived_at IS NULL
      ORDER BY importance DESC, last_restated_at DESC
      LIMIT ?
    `).all(personaId, limit)

    touchAccess(db, rows, now)
    return rows.map((n) => ({ ...n, clarity: computeClarity(n, now) }))
  }

  const placeholders = startNodes.map(() => '?').join(',')
  let expanded = []
  try {
    expanded = db.prepare(`
      WITH RECURSIVE chain(id, depth) AS (
        SELECT id, 0 FROM nodes WHERE id IN (${placeholders}) AND persona_id = ?
        UNION
        SELECT
          CASE WHEN e.source_id = c.id THEN e.target_id ELSE e.source_id END,
          c.depth + 1
        FROM chain c
        JOIN edges e ON (e.source_id = c.id OR e.target_id = c.id) AND e.persona_id = ?
        WHERE c.depth < ?
      )
      SELECT DISTINCT n.* FROM nodes n
      JOIN chain c ON n.id = c.id
      WHERE n.persona_id = ? AND n.archived_at IS NULL
    `).all(...startNodes.map((n) => n.id), personaId, personaId, depth, personaId)
  } catch (err) {
    expanded = startNodes // 连边报错时至少返回起点节点
  }

  const scored = expanded
    .map((n) => ({ ...n, clarity: computeClarity(n, now) }))
    .filter((n) => n.clarity > 0.15)
    .sort((a, b) => (b.clarity * b.importance) - (a.clarity * a.importance))

  touchAccess(db, expanded, now)
  return scored
}
