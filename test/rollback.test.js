import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bard-rollback-'))
process.env.DSH_HOME = TEST_HOME

const { getDb, closeDb } = await import('../lib/db.js')
const { createPersona, savePersona, loadPersona, applyMigration, rollbackMigration } = await import('../lib/alzheimer.js')
const { deletePersona } = await import('../lib/store.js')
const { searchMemory } = await import('../lib/memory-search.js')

let pid = ''

test('rollback 恢复旧节点、删除新节点、persona 世代回退', () => {
  const db = getDb()
  const p = createPersona({ name: `回滚-${Math.random().toString(36).slice(2, 8)}` })
  pid = p.id
  savePersona(p)

  const now = Date.now()
  db.prepare(`INSERT INTO nodes (id, persona_id, type, text, importance, emotion, base_strength, last_restated_at, restate_count, created_at, state) VALUES (?, ?, 'episodic', ?, 5, 0, 1.0, ?, 0, ?, 'active')`)
    .run('old-gen', p.id, '第一世的记忆', now, now)

  // 触发迁移（写快照 + 归档 + 新节点）
  const before = loadPersona(pid)
  before.meta.migrationJournal = {
    status: 'committed',
    output: { chapterSummary: '一生', farewell: '再见', remainingMemories: [{ text: '第二世的记忆', importance: 5 }], nextSelf: {} },
  }
  savePersona(before)
  applyMigration(loadPersona(pid))

  // 迁移后：old-gen 归档，新节点存在
  assert.ok(db.prepare(`SELECT archived_at FROM nodes WHERE id = 'old-gen'`).get().archived_at, '旧节点应归档')
  assert.ok(searchMemory('第一世的记忆', { personaId: pid, limit: 10, depth: 2 }).every((n) => n.id !== 'old-gen'), '旧节点不应被检索')

  // 回滚
  const restored = rollbackMigration(pid)

  // 断言
  assert.strictEqual(restored.meta.generation, 1, '世代应回到 1')
  assert.strictEqual(db.prepare(`SELECT archived_at FROM nodes WHERE id = 'old-gen'`).get().archived_at, null, '旧节点应恢复')
  assert.ok(searchMemory('第一世的记忆', { personaId: pid, limit: 10, depth: 2 }).some((n) => n.id === 'old-gen'), '旧节点应可检索')
  const newCount = db.prepare(`SELECT COUNT(*) AS c FROM nodes WHERE persona_id = ? AND text = '第二世的记忆'`).get(pid).c
  assert.strictEqual(newCount, 0, '新世代节点应被删')
})

test.after(() => {
  if (pid) deletePersona(pid)
  closeDb()
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }) } catch (e) { /* Windows 残留 */ }
})
