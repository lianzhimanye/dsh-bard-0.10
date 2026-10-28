import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 同 memory-cycle.test.js：store.js 的 bardRoot() 每次调用都读 DSH_HOME，
// 先指到临时目录，免得测试搅乱真实的 ~/.dsh/bard 存档。
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bard-migrate-'))
process.env.DSH_HOME = TEST_HOME

const { putPersona, deletePersona } = await import('../lib/store.js')
const { createPersona, applyMigration } = await import('../lib/alzheimer.js')
const { closeDb } = await import('../lib/db.js')

const created = []
function seed() {
  const p = createPersona()
  p.id = `scratch-mig-${created.length}-${Date.now()}`
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
  return p
}

function migrate(persona, output) {
  persona.meta.migrationJournal = { status: 'committed', output }
  return applyMigration(persona)
}

test('applyMigration - 空 nextSelf 不递增 revision，不污染原 history', () => {
  const p = seed()
  const out = migrate(p, { chapterSummary: '一生', farewell: '再见', remainingMemories: [], nextSelf: {} })

  assert.strictEqual(out.self.revision, 3, '空 nextSelf 不应递增 revision')
  assert.strictEqual(out.self.history.length, 1, 'history 不应增长')
  assert.strictEqual(p.self.revision, 3, '原 persona.self.revision 被污染了')
  assert.strictEqual(p.self.history.length, 1, '原 persona.self.history 被 push 污染了')
})

test('applyMigration - 真变化才递增 revision，且新建 history 数组', () => {
  const p = seed()
  const before = p.self.history
  const out = migrate(p, {
    chapterSummary: '一生',
    farewell: '再见',
    remainingMemories: [],
    nextSelf: { description: '我学会了告别。', personality: '更沉静' },
  })

  assert.strictEqual(out.self.revision, 4, '真变化应递增 revision')
  assert.strictEqual(out.self.history.length, 2)
  assert.notStrictEqual(out.self.history, before, 'history 必须新建数组，不能复用原引用')
  assert.strictEqual(before.length, 1, '原 history 被 push 污染了')
  assert.ok(out.self.description.includes('我学会了告别。'), 'description 应追加在原设定之后')
  assert.strictEqual(out.self.history[1].personality, '更沉静')
})

test('applyMigration - nextSelf 改名无效，identity 不可变', () => {
  const p = seed()
  const out = migrate(p, {
    chapterSummary: '一生',
    farewell: '再见',
    remainingMemories: [],
    nextSelf: { identity: '另一个人', description: '蜕变' },
  })

  assert.strictEqual(out.self.identity, '巴德', 'identity 被 LLM 改掉了')
  assert.strictEqual(out.self.revision, 4, '只有 description 变化也应算变化')
})

test('applyMigration - 只有 personality 变化也算变化', () => {
  const p = seed()
  const out = migrate(p, { chapterSummary: '一生', farewell: '再见', remainingMemories: [], nextSelf: { personality: '更冷' } })

  assert.strictEqual(out.self.revision, 4, '仅 personality 变化也应递增')
  assert.strictEqual(out.self.history[1].description, null)
})

test('applyMigration - 故意留空的 chapterSummary / farewell 不被 fallback 吃掉', () => {
  const p = seed()
  const out = migrate(p, {
    chapterSummary: '',
    farewell: '',
    newChapter: { summary: '不该出现', farewell: '不该出现' },
    remainingMemories: [],
  })

  assert.strictEqual(out.narrative.chapters[0].summary, '', '空 chapterSummary 被 newChapter.summary 顶掉了')
  assert.strictEqual(out.narrative.chapters[0].farewell, '', '空 farewell 被 newChapter.farewell 顶掉了')
})

test('applyMigration - 缺省 chapterSummary 时才回落到 newChapter.summary', () => {
  const p = seed()
  const out = migrate(p, { farewell: '再见', newChapter: { summary: '备用' }, remainingMemories: [] })

  assert.strictEqual(out.narrative.chapters[0].summary, '备用')
})

test.after(() => {
  for (const id of created) deletePersona(id)
  closeDb()
  // 同 force-migration：SQLite 单例连接不关，Windows 上可能删不掉仍占用的目录。
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }) } catch (e) { /* 尽力而为 */ }
})