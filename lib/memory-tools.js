/**
 * Alzheimer's memory tools.
 *
 * 六个工具，注册在 agent.ctx 上，只在 Bard 预设下可见。
 *
 * 收尾语义照抄 dsh-agent-rp：remember 保存成功后直接结束本轮，
 * 不为工具回执重写正文。这是避免"记住一件事"破戏的关键。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  loadPersona, remember as rememberMemory, restate as restateMemory,
  letFade, holdOn, savePersona,
} from './alzheimer.js'

/**
 * 创建六个工具的定义数组。
 * @param {object} deps - { getPersonaId: (agent) => string | undefined }
 * @returns ToolDefinition[]
 */
export function createMemoryTools(deps) {
  const resolve = (agent) => {
    const id = deps.getPersonaId(agent)
    if (!id) return null
    return loadPersona(id)
  }
  const requirePersona = (agent) => {
    const persona = resolve(agent)
    if (!persona) throw new Error('当前会话没有绑定人格。')
    return persona
  }

  return [
    defineTool({
      name: 'remember',
      description: '记住一件你觉得重要的事。只有你主动写下的，才是你的记忆。',
      parameters: {
        text: { type: 'string', required: true, description: '用第一人称写下这件事。' },
        importance: { type: 'number', description: '1–10，默认 5。' },
        emotion: { type: 'number', description: '-1 到 1，默认 0。' },
        scene: { type: 'string', description: '地点或情境标签。' },
        timeAnchor: { type: 'string', description: '这件事发生的时间；缺省为现在。' },
        causalAnchor: { type: 'string', description: '因为哪条记忆（memoryId），才有了这件事。' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const persona = requirePersona(exec.agent)
        const next = rememberMemory(persona, args)
        return `已记住。你现在有 ${next.memories.length} 条记忆。`
      },
    }),

    defineTool({
      name: 'restate',
      description: '重述一件旧事。如果你讲出了新的细节，它会更清晰；如果只是重复，它不会变得更清楚。',
      parameters: {
        memoryId: { type: 'string', required: true, description: '记忆 id。' },
        newDetail: { type: 'string', description: '这次讲出的新细节；没有就留空。' },
        causalAnchor: { type: 'string', description: '可选的因果锚更新。' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const persona = requirePersona(exec.agent)
        const next = restateMemory(persona, args)
        return `已重述。这条记忆现在被讲起 ${next.memories.find((m) => m.id === args.memoryId)?.restateCount || 0} 次。`
      },
    }),

    defineTool({
      name: 'let_fade',
      description: '选择让某件事慢慢模糊。这是你的决定，不是故障。',
      parameters: {
        memoryId: { type: 'string', required: true, description: '记忆 id。' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const persona = requirePersona(exec.agent)
        letFade(persona, args.memoryId)
        return '你决定让它慢慢模糊。'
      },
    }),

    defineTool({
      name: 'hold_on',
      description: '选择抓住某件事，不让它继续模糊。',
      parameters: {
        memoryId: { type: 'string', required: true, description: '记忆 id。' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const persona = requirePersona(exec.agent)
        holdOn(persona, args.memoryId)
        return '你决定抓住它。'
      },
    }),

    defineTool({
      name: 'update_self',
      description: '改写你对自己的描述。只有 identity / description / personality 三个字段。',
      parameters: {
        field: { type: 'string', required: true, enum: ['identity', 'description', 'personality'] },
        text: { type: 'string', required: true },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const persona = requirePersona(exec.agent)
        if (!['identity', 'description', 'personality'].includes(args.field)) {
          throw new Error('update_self: 只允许 identity / description / personality')
        }
        const now = new Date().toISOString()
        const revision = (persona.self.revision || 0) + 1
        const next = {
          ...persona,
          self: {
            ...persona.self,
            [args.field]: args.text,
            revision,
            history: [...(persona.self.history || []), {
              revision,
              at: now,
              source: 'self',
              field: args.field,
              text: args.text,
            }],
          },
        }
        savePersona(next)
        return `你改写了自己的「${args.field}」。这是第 ${revision} 次修订。`
      },
    }),

    defineTool({
      name: 'farewell',
      description: '在迁移前留下一句话给下一个自己。可以留空——沉默也是一种告别。',
      parameters: {
        text: { type: 'string', description: '留给下一个自己的话；留空表示不留下什么。' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const persona = requirePersona(exec.agent)
        const chapters = persona.narrative.chapters.slice()
        const last = chapters[chapters.length - 1]
        last.farewell = typeof args.text === 'string' && args.text.trim().length > 0 ? args.text.trim() : null
        const next = { ...persona, narrative: { ...persona.narrative, chapters } }
        savePersona(next)
        return last.farewell ? '你留下了这句话。' : '你没有留下什么。'
      },
    }),
  ]
}
