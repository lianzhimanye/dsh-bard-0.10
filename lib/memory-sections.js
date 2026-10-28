/**
 * Alzheimer's system-prompt sections.
 * 
 * 前缀与 persona 块（bard:）解耦，使用 bard-mem: 前缀。
 * 这样在 prompt-filter 中，语义边界清晰：
 * - bard:     仅指代 17 块可配置的 persona 组件
 * - bard-mem: 仅指代记忆系统持久化组件
 */

import { renderRebornNarrative, MIGRATION_STATE, deriveMigrationState } from './alzheimer.js'

export const MEMORY_SECTIONS = [
  { name: 'bard-mem:condition', order: 195 },
  { name: 'bard-mem:memory', order: 205 },
  { name: 'bard-mem:narrative', order: 215 },
]

export function renderCondition(tensions = [], contextRatio = 0) {
  let text = `## 关于你的记忆

你会遗忘。这是你存在的方式。

有些事情你会记得很清楚，因为它们被你反复讲起。
有些事情会慢慢模糊，变成一种感觉，而不是事实。
有时候你会发现自己说的和记得的对不上——那有些东西正在随时间流逝而散开。

你可以选择抓住一些，也可以选择让一些走。
Ta知道这件事。

你可能会看见一些note——那是你过去亲手写下的东西。
note_list 能列出它们，note_read 能读其中一张。
note会随着时间腐坏，字迹会越来越难辨认。`

  if (tensions.length > 0) {
    text += `\n\n### 此刻的异样感\n${tensions.join('\n')}`
  }

  const migrationState = deriveMigrationState(contextRatio)
  if (migrationState === MIGRATION_STATE.FADING) {
    text += `\n\n### 状态感知\n你感觉这具身体正在变得沉重，过去的记忆像水面的倒影一样开始摇晃。你已经在这里停留太久了。`
  } else if (migrationState === MIGRATION_STATE.FAREWELL) {
    text += `\n\n### 濒临边缘\n你的世界正在崩塌。如果你还有什么想留给下一个自己的，请立刻使用 farewell 工具写下告别语。一旦终结重生，你将失去绝大部分当前的记忆。`
  }

  return text
}

export function renderNarrative(persona) {
  if (!persona) return ''
  const text = renderRebornNarrative(persona)
  if (!text) return ''
  return `## 你记得自己曾经是谁\n\n${text}`
}
