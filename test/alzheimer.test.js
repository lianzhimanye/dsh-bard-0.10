import test from 'node:test'
import assert from 'node:assert'
import {
  deriveState, MEMORY_LIMIT,
  extractAssertions, detectConfabulation, garbleText
} from '../lib/alzheimer.js'
import { computeClarity } from '../lib/clarity.js'

test('computeClarity - 沉默时间越久越模糊', () => {
  const now = Date.now()
  const oneDayAgo = now - 86400000
  const threeDaysAgo = now - 3 * 86400000

  const mem1 = { base_strength: 1.0, last_restated_at: oneDayAgo, restate_count: 0, state: 'active' }
  const mem2 = { base_strength: 1.0, last_restated_at: threeDaysAgo, restate_count: 0, state: 'active' }

  const c1 = computeClarity(mem1, now)
  const c2 = computeClarity(mem2, now)

  assert.ok(c2 < c1, '三天前未重述的记忆应比一天前的更模糊')
})

test('computeClarity - held 状态不衰减', () => {
  const now = Date.now()
  const longAgo = now - 30 * 86400000
  const mem = { base_strength: 0.8, last_restated_at: longAgo, restate_count: 0, state: 'held' }
  assert.strictEqual(computeClarity(mem, now), 1.0, 'held 在 UI 上也应显示 100%')
})

test('deriveState - 高情绪条目阈值更低', () => {
  const normal = { state: 'active', emotion: 0.0 }
  const intense = { state: 'active', emotion: 0.9 }
  
  // clarity 0.55 时，普通条目进入 fading (阈值 0.6)，高情绪条目仍在 active (阈值 0.6-0.1=0.5)
  assert.strictEqual(deriveState(normal, 0.55), 'fading')
  assert.strictEqual(deriveState(intense, 0.55), 'active')
})

test('deriveState - let_fade 的意志优先于阈值', () => {
  // 她主动放弃的记忆，即使 clarity 仍高于 active 阈值，也必须留在 fading
  const letFaded = { state: 'fading', emotion: 0.0 }
  assert.strictEqual(deriveState(letFaded, 0.95), 'fading', 'clarity 再高也不许弹回 active')
  assert.strictEqual(deriveState(letFaded, 0.6), 'fading')
  assert.strictEqual(deriveState(letFaded, 0.26), 'fading')
  // 只有彻底跌破 faded 底线才允许变成 faded
  assert.strictEqual(deriveState(letFaded, 0.24), 'faded')
  // 高情绪条目底线同样下移 0.1
  const intenseLetFaded = { state: 'fading', emotion: 0.9 }
  assert.strictEqual(deriveState(intenseLetFaded, 0.2), 'fading')
  assert.strictEqual(deriveState(intenseLetFaded, 0.14), 'faded')
  // held 仍然最高优先级
  assert.strictEqual(deriveState({ state: 'held', emotion: 0.9 }, 0.01), 'held')
})

test('computeClarity - 指数衰减与 importance 的权重', () => {
  const now = Date.now()
  const thirtyDaysAgo = now - 30 * 86400000

  const highImp = { base_strength: 1.0, last_restated_at: thirtyDaysAgo, restate_count: 0, importance: 10, state: 'active' }
  const lowImp = { base_strength: 1.0, last_restated_at: thirtyDaysAgo, restate_count: 0, importance: 1, state: 'active' }
  
  const cHigh = computeClarity(highImp, now)
  const cLow = computeClarity(lowImp, now)
  
  assert.ok(cHigh > cLow, '高重要度记忆应该比低重要度衰减慢')
  assert.ok(cHigh < 1.0 && cLow < 1.0, '30天后均应有不同程度的衰减')
})

test('computeClarity - 指数衰减是平滑长尾，不会中途突然归零', () => {
  const now = Date.now()
  const mem = (days) => ({
    base_strength: 1.0,
    last_restated_at: now - days * 86400000,
    restate_count: 0,
    importance: 5,
    state: 'active',
  })
  
  const c10 = computeClarity(mem(10), now)
  const c20 = computeClarity(mem(20), now)
  const c30 = computeClarity(mem(30), now)
  
  // 单调递减
  assert.ok(c10 > c20 && c20 > c30, '越久越模糊')
  // 等长时间段内相对损失恒定（这是指数衰减的定义性质，线性衰减做不到）
  const relA = (c10 - c20) / c10
  const relB = (c20 - c30) / c20
  assert.ok(Math.abs(relA - relB) < 1e-9, `相对损失恒定：${relA} vs ${relB}`)
  // 绝对损失随时间收缩 —— 低 clarity 的尾部越走越慢，不会一刀归零
  assert.ok((c10 - c20) > (c20 - c30), '绝对损失逐段收缩，形成长尾')
  assert.ok(c30 > 0, '30 天后仍有余温')
})

test('MEMORY_LIMIT - 脑容量硬上限是 30 条', () => {
  assert.strictEqual(MEMORY_LIMIT, 30)
})

test('garbleText - 乱码位置稳定，长度为原长度', () => {
  const text = '我们在雨夜的街道上奔跑。'
  const g1 = garbleText(text, 0.4, 'mem-123')
  const g2 = garbleText(text, 0.4, 'mem-123')
  assert.strictEqual(g1, g2, '相同 id 和 clarity 应该生成相同的乱码')
  assert.strictEqual(g1.length, text.length, '乱码替换不应该增加长度')
  assert.ok(g1.includes('█'))
  // 换 id 就是另一张残页
  assert.notStrictEqual(garbleText(text, 0.4, 'mem-999'), g1)
  // 句号保住句子骨架
  assert.ok(g1.endsWith('。'))
  // 清晰时原样返回
  assert.strictEqual(garbleText(text, 0.85, 'mem-123'), text)
  assert.strictEqual(garbleText(text, 1.0, 'mem-123'), text)
  // 空值安全
  assert.strictEqual(garbleText('', 0.2), '')
  assert.strictEqual(garbleText(null, 0.2), '')
})

test('extractAssertions - 提取日期、引号、专有名词', () => {
  const text = '在 2023-10-01 那天，「李明」对我说："你不要走"。'
  const assertions = extractAssertions(text)
  assert.ok(assertions.includes('2023-10-01'))
  assert.ok(assertions.includes('李明'))
  assert.ok(assertions.includes('你不要走'))
})

test('detectConfabulation - 识别无据的断言', () => {
  const persona = {
    memories: [{ text: '那天我和李明去了公园。' }],
    impressions: []
  }
  const reply = '在 2023-10-01 那天，「王芳」对我说："你好"。'
  const conf = detectConfabulation(reply, persona)
  assert.ok(conf.includes('2023-10-01'))
  assert.ok(conf.includes('王芳'))
  assert.ok(conf.includes('你好'))
  // extractAssertions 目前不识别中文短名，所以「我看到了李明」不会被提取为断言。
  // 这条用例保留为回归哨兵：若未来给 extractAssertions 增加中文 NER，
  // 它会开始提取「李明」，且因 corpus 已含该名，不应报错。
  assert.strictEqual(detectConfabulation('我看到了李明。', persona).includes('李明'), false)
  // 日期路径的正面用例：corpus 中没有日期，应被报告。
  assert.ok(detectConfabulation('那天是 2024-01-15。', persona).includes('2024-01-15'))
})
