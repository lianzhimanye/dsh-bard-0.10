import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 同 migration.test.js：store.js 的 bardRoot() 每次调用都读 DSH_HOME，
// beginMigration 会落盘 pre-migration 快照，所以先把家目录指到临时目录。
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bard-force-'))
process.env.DSH_HOME = TEST_HOME

const { putPersona, deletePersona } = await import('../lib/store.js')
const { createPersona } = await import('../lib/alzheimer.js')
const { forceMigrate } = await import('../lib/index.js')
const { getDb, closeDb } = await import('../lib/db.js')

const created = []

// test/run.js 把所有 *.test.js 塞进同一个进程跑，别的测试文件会在 import
// 阶段改掉 DSH_HOME。所以每个用例开头都要把家目录抢回来，读文件时也现算路径。
function useHome() {
  process.env.DSH_HOME = TEST_HOME
  return TEST_HOME
}

function personaFile(id) {
  return path.join(useHome(), 'bard', 'personas', `${id}.json`)
}

function readPersona(id) {
  return JSON.parse(fs.readFileSync(personaFile(id), 'utf8'))
}

function seed(memoryCount = 8) {
  useHome()
  const db = getDb()
  const p = createPersona()
  p.id = `scratch-force-${created.length}-${Date.now()}`
  created.push(p.id)
  p.self = {
    identity: '巴德',
    description: '游吟诗人',
    personality: '温和',
    revision: 3,
    history: [{ revision: 3, at: '2026-01-01T00:00:00.000Z', source: 'self' }],
  }
  p.narrative = {
    chapters: [{ generation: 1, bornAt: '2026-01-01T00:00:00.000Z', endedAt: null, summary: '', farewell: null }],
    lastUpdatedAt: null,
  }
  p.meta = { generation: 1, lineage: [], migrationJournal: null }
  putPersona(p)

  const now = Date.now()
  for (let i = 0; i < memoryCount; i += 1) {
    const t = now - i * 86400000
    db.prepare(`
      INSERT INTO nodes (id, persona_id, type, text, importance, emotion, base_strength,
        last_restated_at, restate_count, created_at, state)
      VALUES (?, ?, 'episodic', ?, ?, 0, 1.0, ?, 0, ?, 'active')
    `).run(`mem-${p.id}-${i + 1}`, p.id, `第 ${i + 1} 条记忆`, (i % 10) + 1, t, t)
  }
  return p
}

function run(persona, contextRatio = 0.95) {
  useHome()
  const diagnostics = []
  const ok = forceMigrate({ persona, contextRatio }, (scope, message) => diagnostics.push(`[${scope}] ${message}`))
  return { ok, diagnostics }
}

test('forceMigrate - 走完 journal 契约，代数递增，只带走 5 条', () => {
  const p = seed(8)
  const { ok, diagnostics } = run(p)

  assert.strictEqual(ok, true, '强制迁移应当成功')
  assert.ok(diagnostics.some((d) => d.startsWith('[force-migrate]')), '成功时要记一条诊断')
  assert.ok(diagnostics[0].includes('95%'), '诊断里应带上当时的上下文压力')

  const reborn = readPersona(p.id)
  assert.strictEqual(reborn.meta.generation, 2, '代数应递增到 2')
  const live = getDb().prepare(
    `SELECT COUNT(*) AS c FROM nodes WHERE persona_id = ? AND archived_at IS NULL`
  ).get(p.id).c
  assert.strictEqual(live, 5, '最多带走 5 条记忆')
  assert.strictEqual(reborn.meta.migrationJournal, null, 'journal 应当结清')
})

test('forceMigrate - 按 importance 取前 5', () => {
  const p = seed(8)
  run(p)
  // seed 的 importance 是 (i%10)+1，即 1..8，取 8,7,6,5,4
  const rows = getDb().prepare(
    `SELECT importance FROM nodes WHERE persona_id = ? AND archived_at IS NULL ORDER BY importance DESC`
  ).all(p.id)
  assert.deepStrictEqual(rows.map((r) => r.importance), [8, 7, 6, 5, 4])
})

test('forceMigrate - 不改人格：revision 不动，description 不被追加', () => {
  const p = seed(8)
  run(p)
  const reborn = readPersona(p.id)
  assert.strictEqual(reborn.self.revision, 3, 'nextSelf 留空时 revision 不应递增')
  assert.strictEqual(reborn.self.description, '游吟诗人', 'description 不应被模板改写')
  assert.ok(!String(reborn.self.description).includes('【前世的觉悟】'), '强制路径不应写入觉悟')
  assert.strictEqual(reborn.self.history.length, 1, 'history 不应增长')
})

test('forceMigrate - 上一章的 summary 为空时用记得最牢的那条兜底', () => {
  const p = seed(8)
  run(p)
  const reborn = readPersona(p.id)
  const chapter = reborn.narrative.chapters[0]
  assert.ok(chapter.summary.includes('第 8 条记忆'), `兜底 summary 应引用最重的那条记忆，实际：${chapter.summary}`)
  assert.ok(chapter.farewell.includes('第 8 条记忆'), 'farewell 也该带上那条记忆')
  assert.notStrictEqual(chapter.endedAt, null, '旧章节应当封笔')
})

test('forceMigrate - 没有 persona 时返回 false，不抛', () => {
  useHome()
  const diagnostics = []
  const ok = forceMigrate({ persona: null, contextRatio: 0.95 }, (scope, message) => diagnostics.push(message))
  assert.strictEqual(ok, false)
  assert.strictEqual(diagnostics.length, 0)
})

test.after(() => {
  useHome()
  for (const id of created) deletePersona(id)
  closeDb()
  // SQLite 连接在本进程内是单例且不会关闭；Windows 上删不掉仍被占用的
  // memory.sqlite 所在目录（EPERM）。清理是尽力而为，残留交给系统临时目录。
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }) } catch (e) { /* 连接未关闭时无法删除 */ }
})