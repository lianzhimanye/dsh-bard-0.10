import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bard-weakest-'))
process.env.DSH_HOME = TEST_HOME

const { getDb, closeDb } = await import('../lib/db.js')
const { createMemoryTools } = await import('../lib/memory-tools.js')
const { createPersona, savePersona } = await import('../lib/alzheimer.js')
const { deletePersona } = await import('../lib/store.js')

const created = []

function setup() {
  const db = getDb()
  const p = createPersona({ name: `测试-${Math.random().toString(36).slice(2, 8)}` })
  savePersona(p)
  created.push(p.id)

  // 同一个进程里 setup 会被调用多次，nodes.id 是全局主键，固定 id 会撞。
  const tag = Math.random().toString(36).slice(2, 8)
  const heldId = `held-${tag}`
  const fadingId = `fading-${tag}`

  const now = Date.now()
  const LONG_AGO = now - 100 * 86400000

  db.prepare(`INSERT INTO nodes (id, persona_id, type, text, importance, emotion, base_strength, last_restated_at, restate_count, created_at, state) VALUES (?, ?, 'episodic', ?, ?, 0, ?, ?, ?, ?, 'held')`)
    .run(heldId, p.id, '死死抓住的事', 1, 1.0, LONG_AGO, 0, LONG_AGO)
  db.prepare(`INSERT INTO nodes (id, persona_id, type, text, importance, emotion, base_strength, last_restated_at, restate_count, created_at, state) VALUES (?, ?, 'episodic', ?, ?, 0, ?, ?, ?, ?, 'fading')`)
    .run(fadingId, p.id, '已经模糊的事', 1, 0.5, LONG_AGO, 0, LONG_AGO)
  for (let i = 0; i < 28; i += 1) {
    db.prepare(`INSERT INTO nodes (id, persona_id, type, text, importance, emotion, base_strength, last_restated_at, restate_count, created_at, state) VALUES (?, ?, 'episodic', ?, ?, 0, ?, ?, ?, ?, 'active')`)
      .run(`active-${tag}-${i}`, p.id, `第 ${i} 条活跃记忆`, 6, 1.0, now, 0, now)
  }

  const defs = createMemoryTools({ getPersonaId: () => p.id })
  const map = new Map(defs.map((d) => [d.name, d]))
  return { p, db, map, exec: { agent: {} }, heldId, fadingId }
}

test('溢出删 clarity 最低的非 held 节点，held 保留', async () => {
  const { p, db, map, exec, heldId, fadingId } = setup()
  await map.get('remember').execute({ text: '新的记忆' }, exec)

  assert.ok(db.prepare(`SELECT id FROM nodes WHERE id = ?`).get(heldId), 'held 不能被挤出')
  assert.strictEqual(db.prepare(`SELECT id FROM nodes WHERE id = ?`).get(fadingId), undefined, 'fading 应被删')
  const live = db.prepare(`SELECT COUNT(*) AS c FROM nodes WHERE persona_id = ? AND archived_at IS NULL`).get(p.id).c
  assert.strictEqual(live, 30)
})

test('全 held 时新记忆临时超到 31 条', async () => {
  const { p, db, map, exec } = setup()
  db.prepare(`UPDATE nodes SET state = 'held' WHERE persona_id = ?`).run(p.id)
  await map.get('remember').execute({ text: '又一条' }, exec)
  const count = db.prepare(`SELECT COUNT(*) AS c FROM nodes WHERE persona_id = ? AND archived_at IS NULL`).get(p.id).c
  assert.strictEqual(count, 31)
})

test.after(() => {
  for (const id of created) deletePersona(id)
  closeDb()
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }) } catch (e) { /* Windows 残留交给系统 */ }
})
