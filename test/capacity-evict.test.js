import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bard-capacity-'))
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
  const now = Date.now()
  const LONG_AGO = now - 100 * 86400000
  for (let i = 0; i < 30; i += 1) {
    const isVictim = i === 0
    db.prepare(`INSERT INTO nodes (id, persona_id, type, text, importance, emotion, base_strength, last_restated_at, restate_count, created_at, state) VALUES (?, ?, 'episodic', ?, ?, 0, ?, ?, 0, ?, 'active')`)
      .run(`mem-${i}`, p.id, isVictim ? '注定被挤出的事' : `第 ${i} 条`, isVictim ? 1 : 6, isVictim ? 0.3 : 1.0, isVictim ? LONG_AGO : now, isVictim ? LONG_AGO : now)
  }
  const defs = createMemoryTools({ getPersonaId: () => p.id })
  return { p, db, map: new Map(defs.map((d) => [d.name, d])), exec: { agent: {} } }
}

test('挤出时碎片进沉积池 + maintenance_log 记录 capacity', async () => {
  const { p, db, map, exec } = setup()
  await map.get('remember').execute({ text: '新的记忆' }, exec)

  const sedimentPath = path.join(TEST_HOME, 'bard', 'sediment.json')
  const sediment = JSON.parse(fs.readFileSync(sedimentPath, 'utf8'))
  assert.ok(sediment.some((s) => String(s.text || s).includes('注定被挤出的事')), '挤出内容应进沉积池')

  const log = db.prepare(`SELECT * FROM maintenance_log WHERE persona_id = ? AND action = 'archive'`).all(p.id)
  assert.ok(log.length >= 1, 'maintenance_log 应有 archive 记录')
  assert.strictEqual(JSON.parse(log[0].payload).reason, 'capacity')
})

test.after(() => {
  for (const id of created) deletePersona(id)
  closeDb()
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }) } catch (e) { /* Windows 残留 */ }
})
