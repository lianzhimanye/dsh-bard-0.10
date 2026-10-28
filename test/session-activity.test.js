import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bard-session-'))
process.env.DSH_HOME = TEST_HOME

const { getLastAssembleAt, setLastAssembleAt, getWakeStreak, setWakeStreak, closeDb } = await import('../lib/db.js')

test('session_activity 在"进程重启"后能读回', () => {
  const sid = 'sess-test-1'
  const t1 = 1_700_000_000_000

  setLastAssembleAt(sid, t1)
  setWakeStreak(sid, 3)
  assert.strictEqual(getLastAssembleAt(sid), t1)
  assert.strictEqual(getWakeStreak(sid), 3)

  // 模拟进程重启：closeDb 后下一次 getDb 会重新打开同一文件
  closeDb()

  // 重新 import 后调用——实际上模块级 db 已重置，下一次函数调用会自动 getDb
  assert.strictEqual(getLastAssembleAt(sid), t1, '重启后 lastAssembleAt 应恢复')
  assert.strictEqual(getWakeStreak(sid), 3, '重启后 wakeStreak 应恢复')

  // 覆盖写入
  setLastAssembleAt(sid, t1 + 1000)
  assert.strictEqual(getLastAssembleAt(sid), t1 + 1000)

  // 未知 session
  assert.strictEqual(getLastAssembleAt('sess-never-existed'), null)
  assert.strictEqual(getWakeStreak('sess-never-existed'), 0)
})

test.after(() => {
  closeDb()
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }) } catch (e) { /* Windows 残留 */ }
})
