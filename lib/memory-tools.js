/**
 * Alzheimer's memory tools.
 */

import {
  loadPersona, remember as rememberMemory, restate as restateMemory,
  letFade, holdOn, savePersona,
} from './alzheimer.js'

export function createMemoryTools(deps) {
  const requirePersona = (agent) => {
    const id = deps.getPersonaId(agent)
    if (!id) throw new Error('当前会话没有绑定人格。')
    const persona = loadPersona(id)
    if (!persona) throw new Error('人格不存在。')
    return persona
  }

  const output = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  }

  return [
    {
      name: 'remember',
      description: '记住一件你觉得重要的事。只有你主动写下的，才是你的记忆。',
      parameters: {
        text: { type: 'string', required: true, description: '用第一人称写下这件事。' },
        importance: { type: 'number', description: '1–10，默认 5。' },
        emotion: { type: 'number', description: '-1 到 1，默认 0。' },
        scene: { type: 'string', description: '地点或情境标签。' },
        timeAnchor: { type: 'string', description: '这件事发生的时间；缺省为现在。' },
        causalAnchor: { type: 'string', description: '因为哪条记忆，才有了这件事。' },
      },
      output,
      async execute(args, exec) {
        const persona = requirePersona(exec.agent)
        const next = rememberMemory(persona, args)
        return `已记住。你现在有 ${next.memories.length} 条记忆。`
      },
    },
    {
      name: 'restate',
      description: '重述一件旧事。讲出新细节会更清晰；只是重复不会。',
      parameters: {
        memoryId: { type: 'string', required: true },
        newDetail: { type: 'string' },
        causalAnchor: { type: 'string' },
      },
      output,
      async execute(args, exec) {
        const persona = requirePersona(exec.agent)
        const next = restateMemory(persona, args)
        const m = next.memories.find((x) => x.id === args.memoryId)
        return `已重述。这条记忆现在被讲起 ${m?.restateCount || 0} 次。`
      },
    },
    {
      name: 'let_fade',
      description: '选择让某件事慢慢模糊。这是你的决定，不是故障。',
      parameters: { memoryId: { type: 'string', required: true } },
      output,
      async execute(args, exec) {
        letFade(requirePersona(exec.agent), args.memoryId)
        return '你决定让它慢慢模糊。'
      },
    },
    {
      name: 'hold_on',
      description: '选择抓住某件事，不让它继续模糊。',
      parameters: { memoryId: { type: 'string', required: true } },
      output,
      async execute(args, exec) {
        holdOn(requirePersona(exec.agent), args.memoryId)
        return '你决定抓住它。'
      },
    },
    {
      name: 'update_self',
      description: '改写你对自己的描述。只有 identity / description / personality 三个字段。',
      parameters: {
        field: { type: 'string', required: true, enum: ['identity', 'description', 'personality'] },
        text: { type: 'string', required: true },
      },
      output,
      async execute(args, exec) {
        const persona = requirePersona(exec.agent)
        const now = new Date().toISOString()
        const revision = (persona.self.revision || 0) + 1
        const next = {
          ...persona,
          self: {
            ...persona.self,
            [args.field]: args.text,
            revision,
            history: [...(persona.self.history || []), { revision, at: now, source: 'self', field: args.field, text: args.text }],
          },
        }
        savePersona(next)
        return `你改写了自己的「${args.field}」。这是第 ${revision} 次修订。`
      },
    },
    {
      name: 'farewell',
      description: '在迁移前留下一句话给下一个自己。可以留空——沉默也是一种告别。',
      parameters: { text: { type: 'string' } },
      output,
      async execute(args, exec) {
        const persona = requirePersona(exec.agent)
        const chapters = persona.narrative.chapters.slice()
        const last = chapters[chapters.length - 1]
        last.farewell = typeof args.text === 'string' && args.text.trim().length > 0 ? args.text.trim() : null
        savePersona({ ...persona, narrative: { ...persona.narrative, chapters } })
        return last.farewell ? '你留下了这句话。' : '你没有留下什么。'
      },
    },
  ]
}