import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bard-edge-'))
process.env.DSH_HOME = TEST_HOME

const { getDb, closeDb } = await import('../lib/db.js')
const { createMemoryTools } = await import('../lib/memory-tools.js')
const { createPersona, savePersona } = await import('../lib/alzheimer.js')
const { searchMemory } = await import('../lib/memory-search.js')
const { deletePersona } = await import('../lib/store.js')

let pid = ''

function exec() {
  const p = createPersona({ name: `边-${Math.random().toString(36).slice(2, 8)}` })
  savePersona(p)
  pid = p.id
  const defs = createMemoryTools({ getPersonaId: () => p.id })
  return { p, map: new Map(defs.map((d) => [d.name, d])), run: { agent: {} } }
}

test('semantic 边双向扩散 + causal 反向可见 + archived 隔离', async () => {
  const { p, map, run } = exec()
  const db = getDb()

  // A：起点
  await map.get('remember').execute({ text: '我们在雨夜的街道上奔跑' }, run)
  const aId = db.prepare(`SELECT id FROM nodes WHERE persona_id = ? AND text = ?`).get(p.id, '我们在雨夜的街道上奔跑').id

  // B：语义相似（命中阈值）
  await map.get('remember').execute({ text: '我们在雨夜的街道上一直奔跑' }, run)
  const bId = db.prepare(`SELECT id FROM nodes WHERE persona_id = ? AND text = ?`).get(p.id, '我们在雨夜的街道上一直奔跑').id

  // C：因果连接到 A
  await map.get('remember').execute({ text: '那次奔跑让我受了伤', causalAnchor: aId }, run)
  const cId = db.prepare(`SELECT id FROM nodes WHERE persona_id = ? AND text = ?`).get(p.id, '那次奔跑让我受了伤').id

  // 1. semantic 边已写入（新节点 → 旧节点）
  const semEdge = db.prepare(`SELECT * FROM edges WHERE source_id = ? AND target_id = ? AND relation_type = 'semantic'`).get(bId, aId)
  assert.ok(semEdge, 'B→A semantic 边应存在')

  // 2. 检索 A 能带出 B（semantic）和 C（causal 反向）
  const fromA = searchMemory('雨夜的街道上奔跑', { personaId: p.id, limit: 10, depth: 2 })
  const idsFromA = fromA.map((n) => n.id)
  assert.ok(idsFromA.includes(bId), 'A 应带出 B')
  assert.ok(idsFromA.includes(cId), 'A 应带出 C')

  // 3. 检索 C 能反向带出 A（causal 反向遍历）
  const fromC = searchMemory('那次奔跑让我受了伤', { personaId: p.id, limit: 10, depth: 2 })
  assert.ok(fromC.map((n) => n.id).includes(aId), 'C 应反向带出 A')

  // 4. archived 节点即使有边也不返回
  db.prepare(`UPDATE nodes SET archived_at = ?, archived_reason = 'migrated' WHERE id = ?`).run(Date.now(), bId)
  const afterArchive = searchMemory('雨夜的街道上奔跑', { personaId: p.id, limit: 10, depth: 2 })
  assert.ok(!afterArchive.map((n) => n.id).includes(bId), 'archived 的 B 不应被返回')
})

test.after(() => {
  if (pid) deletePersona(pid)
  closeDb()
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }) } catch (e) { /* Windows 残留 */ }
})

