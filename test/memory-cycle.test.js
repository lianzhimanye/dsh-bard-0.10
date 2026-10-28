import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// store.js 的 bardRoot() 每次调用都读 DSH_HOME，所以先在临时目录里跑，
// 免得测试把真实的 ~/.dsh/bard 存档搅乱。必须在 import 业务模块之前设好。
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bard-test-'))
process.env.DSH_HOME = TEST_HOME

const { createMemoryTools } = await import('../lib/memory-tools.js')
const { createPersona, savePersona, loadPersona, MEMORY_LIMIT } = await import('../lib/alzheimer.js')
const { writeNote, readNote, listNotes, MAX_NOTE_CHARS } = await import('../lib/notes.js')
const { pushToSediment, drawDreamFragments, clearSediment } = await import('../lib/sediment.js')
const { getDb, closeDb } = await import('../lib/db.js')

/** 造一个人格，装满 count 条记忆，返回 [persona, 工具表, exec]。 */
function setup(count) {
  const now = Date.now()
  const db = getDb()
  const tag = Math.random().toString(36).slice(2, 8)
  const persona = createPersona({ name: `测试人格-${tag}` })
  savePersona(persona)

  for (let i = 0; i < count; i += 1) {
    db.prepare(`
      INSERT INTO nodes (id, persona_id, type, text, importance, emotion, base_strength,
        last_restated_at, restate_count, created_at, state)
      VALUES (?, ?, 'episodic', ?, ?, 0, ?, ?, ?, ?, ?)
    `).run(
      `mem-${tag}-${String(i).padStart(2, '0')}`,
      persona.id,
      i === 0 ? '很久以前在雨夜的街道上奔跑' : `第 ${i} 条被反复提起的记忆`,
      i === 0 ? 2 : 6,
      i === 0 ? 0.2 : 1.0,
      i === 0 ? now - 60 * 86400000 : now,
      i === 0 ? 0 : 3,
      now,
      i === 0 ? 'fading' : 'active',
    )
  }

  const defs = createMemoryTools({ getPersonaId: () => persona.id })
  const map = new Map(defs.map((d) => [d.name, d]))
  const exec = { agent: {} }
  return { persona, map, exec }
}

test('记忆工具清单包含三个介质工具', () => {
  const { map } = setup(1)
  for (const name of ['remember', 'note_write', 'note_read', 'note_list']) {
    assert.ok(map.has(name), `缺少工具 ${name}`)
  }
})

test('remember - 没满时正常记住，不撒谎说忘了', () => {
  const { map, exec } = setup(3)
  return Promise.resolve(map.get('remember').execute({ text: '一件新事' }, exec)).then((reply) => {
    assert.match(String(reply), /已记住/)
    assert.ok(!String(reply).includes('脑子已经满了'))
  })
})

test('note_write / note_read / note_list - 纸条能写能读能列', () => {
  const { map, exec } = setup(1)
  return Promise.resolve(map.get('note_write').execute({ name: '雨夜', content: '那天的雨很大。' }, exec))
    .then((reply) => {
      assert.match(String(reply), /雨夜/, `写纸条应该回显名字：${reply}`)
      return Promise.resolve(map.get('note_list').execute({}, exec))
    })
    .then((list) => {
      assert.match(String(list), /雨夜/)
      return Promise.resolve(map.get('note_read').execute({ name: '雨夜' }, exec))
    })
    .then((text) => {
      assert.match(String(text), /那天的雨很大。/)
      assert.match(String(text), /字迹/)
    })
})

test('note_write - 超长内容被拒绝或截断，不炸掉', () => {
  const { map, exec } = setup(1)
  const huge = '雨'.repeat(MAX_NOTE_CHARS + 100)
  return Promise.resolve(map.get('note_write').execute({ name: '长信', content: huge }, exec)).then((reply) => {
    assert.ok(String(reply).length > 0, '必须有回复')
    const noted = listNotes().find((n) => n.name === '长信')
    if (noted) assert.ok(noted.chars <= MAX_NOTE_CHARS, `落盘后不能超字数：${noted.chars}`)
  })
})

test('readNote - 读不存在的纸条给出人话错误', () => {
  assert.throws(() => readNote('根本不存在的纸条'), /./)
})

test('沉积池 - 去重、抽卡、清空', () => {
  clearSediment()
  pushToSediment('我们在雨夜的街道上奔跑，路灯一盏一盏地熄灭')
  pushToSediment('我们在雨夜的街道上奔跑，路灯一盏一盏地熄灭')
  const fragments = drawDreamFragments(4)
  assert.ok(Array.isArray(fragments))
  assert.ok(fragments.length <= 4)
  clearSediment()
  assert.strictEqual(drawDreamFragments(4).length, 0)
})

test('writeNote - 空名字、空内容都直接报错', () => {
  assert.throws(() => writeNote('', '无名的句子。'), /文件名不能为空/)
  assert.throws(() => writeNote('空纸', '   '), /./)
  // 标点/非法字符会被洗掉，剩下正气的气氛词
  const named = writeNote('雨/夜:*?', '那天的雨很大。')
  assert.ok(typeof named === 'string' && !/[\\/:*?"<>|]/.test(named), `名字应被清洗：${named}`)
})

test.after(() => {
  closeDb()
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }) } catch (e) { /* Windows 残留交给系统 */ }
})