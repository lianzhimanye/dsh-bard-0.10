import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bard-archived-'))
process.env.DSH_HOME = TEST_HOME

const { getDb, closeDb } = await import('../lib/db.js')
const { createPersona, savePersona } = await import('../lib/alzheimer.js')
const { deletePersona } = await import('../lib/store.js')

const created = []

test('archived 节点不出现在 /memory/state 的查询结果', () => {
  const db = getDb()
  const p = createPersona({ name: `归档-${Math.random().toString(36).slice(2, 8)}` })
  savePersona(p)
  created.push(p.id)

  const now = Date.now()
  db.prepare(`INSERT INTO nodes (id, persona_id, type, text, importance, emotion, base_strength, last_restated_at, restate_count, created_at, state) VALUES (?, ?, 'episodic', ?, 5, 0, 1.0, ?, 0, ?, 'active')`)
    .run('live-1', p.id, '活着的记忆', now, now)
  db.prepare(`INSERT INTO nodes (id, persona_id, type, text, importance, emotion, base_strength, last_restated_at, restate_count, created_at, state, archived_at, archived_reason) VALUES (?, ?, 'episodic', ?, 5, 0, 1.0, ?, 0, ?, 'active', ?, 'migrated')`)
    .run('archived-1', p.id, '已归档的记忆', now, now, now)

  // 与 routes.js /memory/state 使用的 SQL 保持一致
  const rows = db.prepare(`SELECT * FROM nodes WHERE persona_id = ? AND archived_at IS NULL ORDER BY created_at ASC`).all(p.id)
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0].id, 'live-1')
})

test.after(() => {
  for (const id of created) deletePersona(id)
  closeDb()
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }) } catch (e) { /* Windows 残留 */ }
})
