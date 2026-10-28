import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bard-migsearch-'))
process.env.DSH_HOME = TEST_HOME

const { getDb, closeDb } = await import('../lib/db.js')
const { createPersona, savePersona, loadPersona, applyMigration } = await import('../lib/alzheimer.js')
const { searchMemory } = await import('../lib/memory-search.js')
const { deletePersona } = await import('../lib/store.js')

const created = []

test('迁移后旧世代节点不被 searchMemory 返回，新世代可检索', () => {
  const db = getDb()
  const p = createPersona({ name: `迁移-${Math.random().toString(36).slice(2, 8)}` })
  savePersona(p)
  created.push(p.id)

  const now = Date.now()
  db.prepare(`INSERT INTO nodes (id, persona_id, type, text, importance, emotion, base_strength, last_restated_at, restate_count, created_at, state) VALUES (?, ?, 'episodic', ?, 5, 0, 1.0, ?, 0, ?, 'active')`)
    .run('old-1', p.id, '旧世代的雨夜记忆', now, now)

  const persona = loadPersona(p.id)
  persona.meta.migrationJournal = {
    status: 'committed',
    output: {
      chapterSummary: '一生',
      farewell: '再见',
      remainingMemories: [{ text: '新世代的记忆', importance: 5, emotion: 0 }],
      nextSelf: {},
    },
  }
  savePersona(persona)
  applyMigration(loadPersona(p.id))

  const oldResults = searchMemory('旧世代的雨夜记忆', { personaId: p.id, limit: 10, depth: 2 })
  // 检索有 importance 保底，不会返回空数组；这里要确认的是旧节点本身没被捞出来。
  assert.ok(!oldResults.some((r) => r.id === 'old-1'), '旧世代节点不应被检索')

  const newResults = searchMemory('新世代的记忆', { personaId: p.id, limit: 10, depth: 2 })
  assert.ok(newResults.length > 0, '新世代节点应可检索')

  const archivedRow = db.prepare(`SELECT archived_reason FROM nodes WHERE id = 'old-1'`).get()
  assert.strictEqual(archivedRow.archived_reason, 'migrated')
})

test('第二次迁移后，上上次归档的节点被清理', () => {
  const db = getDb()
  const p = createPersona({ name: `二迁-${Math.random().toString(36).slice(2, 8)}` })
  savePersona(p)
  created.push(p.id)

  const now = Date.now()
  db.prepare(`INSERT INTO nodes (id, persona_id, type, text, importance, emotion, base_strength, last_restated_at, restate_count, created_at, state) VALUES (?, ?, 'episodic', ?, 5, 0, 1.0, ?, 0, ?, 'active')`)
    .run('gen1-1', p.id, '第一世的记忆', now, now)

  const first = loadPersona(p.id)
  first.meta.migrationJournal = {
    status: 'committed',
    output: { chapterSummary: '', farewell: '', remainingMemories: [{ text: '第二世的记忆', importance: 5 }], nextSelf: {} },
  }
  savePersona(first)
  applyMigration(loadPersona(p.id))

  // 第一次迁移后，gen1-1 应还在（archived，可回滚）
  assert.ok(db.prepare(`SELECT id FROM nodes WHERE id = 'gen1-1'`).get(), '第一次迁移后 gen1 应保留')

  // 第二次迁移
  const second = loadPersona(p.id)
  second.meta.migrationJournal = {
    status: 'committed',
    output: { chapterSummary: '', farewell: '', remainingMemories: [{ text: '第三世的记忆', importance: 5 }], nextSelf: {} },
  }
  savePersona(second)
  applyMigration(loadPersona(p.id))

  assert.strictEqual(db.prepare(`SELECT id FROM nodes WHERE id = 'gen1-1'`).get(), undefined, '第二次迁移后 gen1 应被清')
})

test.after(() => {
  for (const id of created) deletePersona(id)
  closeDb()
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }) } catch (e) { /* Windows 残留 */ }
})
