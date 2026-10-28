/**
 * 记忆清晰度计算（SQLite 节点字段版）。
 *
 * 沉默驱动（指数衰减）：
 *   days   = max(0, (now - last) / 86400000)
 *   gain   = max(0.2, 1 / (1 + restate_count))
 *   lambda = 0.06 * (1 - importance / 20)
 *   clarity = clamp(base_strength * exp(-lambda * days * gain), 0, 1)
 *
 * held 状态的记忆不衰减，恒为 1.0。
 */
export function computeClarity(node, now = Date.now()) {
  if (node.state === 'held') return 1.0
  const last = node.last_accessed_at || node.last_restated_at || node.created_at
  if (!Number.isFinite(last)) return node.base_strength || 1.0
  const days = Math.max(0, (now - last) / 86400000)
  const gain = Math.max(0.2, 1 / (1 + (node.restate_count || 0)))
  const importance = Number.isFinite(node.importance) ? node.importance : 5
  const lambda = 0.06 * (1 - importance / 20)
  return Math.max(0, Math.min(1, (node.base_strength || 1.0) * Math.exp(-lambda * days * gain)))
}
