/**
 * Alzheimer's memory tools.
 */

import {
  loadPersona, savePersona,
  applyMigration, beginMigration, commitMigration,
  MEMORY_LIMIT, garbleText,
} from './alzheimer.js'
import { enhancedSimilarity } from './semantic-detector.js'
import { getPreset, putPreset } from './store.js'
import { BARD_BLOCKS } from './persona.js'
import { writeNote, readNote, listNotes, MAX_NOTE_CHARS } from './notes.js'
import { pushToSediment } from './sediment.js'
import { setAlarm, wakeFloorMs } from './life.js'
import { getDb } from './db.js'
import { randomUUID } from 'node:crypto'

/**
 * 全部记忆工具的规范名。
 *
 * 单一真相源：`createMemoryTools()` 的输出必须与这个列表逐项一致，
 * 否则在 `createMemoryTools()` 末尾抛错——防止新增工具时忘记同步名单，导致：
 *   - `registerAgentToolList` 的 `allow` 里混入该名字，被 `tools.restrict`
 *     报 `unknown global tools`（因为记忆工具注册在 agent 自身层，不在
 *     全局注册表里）
 *   - prompt 里的工具清单漏掉该工具
 *   - UI 把该名字当普通工具渲染，诱导用户勾选后再次触发同一条报错
 */
export const MEMORY_TOOL_NAMES = [
  'remember',
  'restate',
  'let_fade',
  'hold_on',
  'update_self',
  'farewell',
  'rewrite_preset_block',
  'note_write',
  'note_read',
  'note_list',
  'schedule_wake',
]

const SEMANTIC_THRESHOLD = 0.65
const SEMANTIC_MAX_EDGES = 3

/**
 * 为新节点写入语义边（newNodeId → 旧节点）。
 *
 * 只写单向：检索时的 CTE 会双向扩散，物化反向边会让边数翻倍，
 * 且 UNIQUE 约束会拒绝"两条语义相同的边"。
 */
function writeSemanticEdges(db, personaId, newNodeId, text, now) {
  const candidates = db.prepare(`
    SELECT id, text FROM nodes
    WHERE persona_id = ? AND id != ? AND archived_at IS NULL
  `).all(personaId, newNodeId)
  if (candidates.length === 0) return 0

  const scored = candidates
    .map((c) => ({ id: c.id, sim: enhancedSimilarity(text, c.text) }))
    .filter((c) => c.sim >= SEMANTIC_THRESHOLD)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, SEMANTIC_MAX_EDGES)

  const insert = db.prepare(`
    INSERT OR IGNORE INTO edges (persona_id, source_id, target_id, relation_type, weight, created_at)
    VALUES (?, ?, ?, 'semantic', ?, ?)
  `)
  for (const c of scored) insert.run(personaId, newNodeId, c.id, c.sim, now)
  return scored.length
}

/** 把毫秒格式化成人类可读的时长，用于 schedule_wake 的回话。 */
function formatDuration(ms) {
  const n = Math.max(0, Number(ms) || 0)
  const minutes = Math.round(n / 60000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.round((n / 3600000) * 10) / 10
  if (hours < 24) return `${hours} 小时`
  const days = Math.round((n / 86400000) * 10) / 10
  return `${days} 天`
}

/** 记录一次维护动作（归档 / 挤压 / 迁移等），失败不阻断主流程。 */
function logMaintenance(db, personaId, action, nodeId = null, payload = null) {
  try {
    db.prepare('INSERT INTO maintenance_log (persona_id, action, node_id, payload, created_at) VALUES (?,?,?,?,?)')
      .run(personaId, action, nodeId, payload == null ? null : JSON.stringify(payload), Date.now())
  } catch (e) { /* 日志不是关键路径 */ }
}

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

  const definitions = [
    {
      name: 'remember',
      description: '记住一件你觉得重要的事。你的记忆系统是一个不可见的数据库，不要尝试用 read 工具读取 memory.sqlite 文件，你只需要调用这个工具即可。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '用第一人称写下这件事。' },
          importance: { type: 'number', description: '1–10，默认 5。' },
          emotion: { type: 'number', description: '-1 到 1，默认 0。' },
          scene: { type: 'string', description: '地点或情境标签。' },
          timeAnchor: { type: 'string', description: '这件事发生的时间；缺省为现在。' },
          causalAnchor: { type: 'string', description: '因为哪条记忆，才有了这件事。' },
        },
        required: ['text'],
      },
      output,
      async execute(args, exec) {
        const persona = requirePersona(exec.agent)
        const db = getDb()
        const id = `mem-${randomUUID().slice(0, 8)}`
        const now = Date.now()
        
        // 1. 写入节点
        db.prepare(`
          INSERT INTO nodes (id, persona_id, type, text, importance, emotion, base_strength, last_restated_at, restate_count, created_at)
          VALUES (?, ?, 'episodic', ?, ?, ?, 1.0, ?, 0, ?)
        `).run(
          id, 
          persona.id,
          args.text, 
          args.importance ?? 5, 
          args.emotion ?? 0, 
          now, 
          now
        )

        // 2. 处理因果连边
        let edgeMsg = ''
        if (args.causalAnchor) {
          const anchorExists = db.prepare('SELECT id FROM nodes WHERE id = ? AND persona_id = ?').get(args.causalAnchor, persona.id)
          if (anchorExists) {
            db.prepare(`
              INSERT INTO edges (persona_id, source_id, target_id, relation_type, weight, created_at)
              VALUES (?, ?, ?, 'causal', 1.0, ?)
            `).run(persona.id, args.causalAnchor, id, now)
            edgeMsg = '（并且和某段过去连在了一起）'
          } else {
            edgeMsg = '（但你想连起的那段过去已经找不到了）'
          }
        }

        // 3. 语义连边：先建边，再考虑挤出
        const semanticCount = writeSemanticEdges(db, persona.id, id, args.text, now)
        if (semanticCount > 0) edgeMsg += `（和 ${semanticCount} 条旧记忆有关联）`

        // 4. 检查记忆上限：挤出 clarity 最低且不是 held 的一条
        const count = db.prepare('SELECT COUNT(*) as c FROM nodes WHERE persona_id = ? AND type = ? AND archived_at IS NULL').get(persona.id, 'episodic').c
        if (count > MEMORY_LIMIT) {
          const weakest = db.prepare(`
            SELECT id, text FROM nodes
            WHERE persona_id = ? AND type = 'episodic'
              AND archived_at IS NULL AND state != 'held' AND id != ?
            ORDER BY (base_strength * exp(-0.06 * (1 - importance/20.0) *
              max(0, (? - coalesce(last_accessed_at, last_restated_at, created_at))/86400000.0) *
              max(0.2, 1.0/(1.0 + restate_count)))) ASC
            LIMIT 1
          `).get(persona.id, id, now)
          if (weakest) {
            // 容量挤出是物理删除 + 留残渣，不是"归档"
            pushToSediment(weakest.text)
            db.prepare('DELETE FROM nodes WHERE id = ?').run(weakest.id)
            logMaintenance(db, persona.id, 'archive', weakest.id, { reason: 'capacity' })
            return `已记住${edgeMsg}。但你的脑子已经满了，关于「${weakest.text.slice(0, 10)}...」的记忆不可挽回地消散了。`
          }
        }

        logMaintenance(db, persona.id, 'remember', id, null)
        return `已记住${edgeMsg}。你现在有 ${count} 条记忆。`
      },
    },
    {
      name: 'restate',
      description: '重述一件旧事。讲出新细节会更清晰；只是重复不会。',
      parameters: {
        type: 'object',
        properties: {
          memoryId: { type: 'string', description: '记忆的 id，就是记忆列表里方括号中的那串（如 mem-a1b2c3d4）。' },
          newDetail: { type: 'string', description: '这次讲出的新细节；没有就留空。' },
          causalAnchor: { type: 'string', description: '可选的因果锚更新。' },
        },
        required: ['memoryId'],
      },
      output,
      async execute(args, exec) {
        const persona = requirePersona(exec.agent)
        const db = getDb()
        const now = Date.now()
        const m = db.prepare('SELECT * FROM nodes WHERE id = ? AND persona_id = ?').get(args.memoryId, persona.id)
        if (!m) throw new Error('找不到这条记忆。')

        let newText = m.text
        if (args.newDetail && args.newDetail.trim()) {
          newText = `${m.text}\n${args.newDetail.trim()}`
        }

        const nextState = m.state === 'fading' ? 'fading' : 'active'
        db.prepare(`
          UPDATE nodes 
          SET text = ?, last_restated_at = ?, restate_count = restate_count + 1, state = ?
          WHERE id = ?
        `).run(newText, now, nextState, args.memoryId)

        logMaintenance(db, persona.id, 'restate', args.memoryId, {
          hasDetail: Boolean(args.newDetail && args.newDetail.trim()),
        })
        return `已重述。这条记忆现在被讲起 ${m.restate_count + 1} 次。`
      },
    },

    
    {
      name: 'let_fade',
      description: '选择让某件事慢慢模糊。这是你的决定，不是故障。',
      parameters: {
        type: 'object',
        properties: {
          memoryId: { type: 'string', description: '记忆的 id，就是记忆列表里方括号中的那串（如 mem-a1b2c3d4）。' },
        },
        required: ['memoryId'],
      },
      output,
      async execute(args, exec) {
        const persona = requirePersona(exec.agent)
        const db = getDb()
        const m = db.prepare('SELECT * FROM nodes WHERE id = ? AND persona_id = ?').get(args.memoryId, persona.id)
        if (!m) throw new Error('找不到这条记忆。')

        db.prepare(`UPDATE nodes SET state = 'fading' WHERE id = ?`).run(args.memoryId)
        logMaintenance(db, persona.id, 'let_fade', args.memoryId, null)
        return '你决定让它慢慢模糊。'
      },
    },
    {
      name: 'hold_on',
      description: '选择抓住某件事，不让它继续模糊。',
      parameters: {
        type: 'object',
        properties: {
          memoryId: { type: 'string', description: '记忆的 id，就是记忆列表里方括号中的那串（如 mem-a1b2c3d4）。' },
        },
        required: ['memoryId'],
      },
      output,
      async execute(args, exec) {
        const persona = requirePersona(exec.agent)
        const db = getDb()
        const m = db.prepare('SELECT * FROM nodes WHERE id = ? AND persona_id = ?').get(args.memoryId, persona.id)
        if (!m) throw new Error('找不到这条记忆。')
        if (m.state === 'held') return '它已经被你抓住了，不会再散开。'

        const now = Date.now()
        const lastTouch = m.last_accessed_at || m.last_restated_at || m.created_at
        const silenceDays = Number.isFinite(lastTouch) ? Math.max(0, (now - lastTouch) / 86400000) : 0

        if (silenceDays <= 7) {
          // 抢救期：clarity 不写（lazy），只标记 held
          db.prepare(`UPDATE nodes SET state = 'held' WHERE id = ?`).run(args.memoryId)
          logMaintenance(db, persona.id, 'hold_on', args.memoryId, { silenceDays: +silenceDays.toFixed(2), corrupted: false })
          return '你终于抓住了它，把它从遗忘的边缘拽了回来。'
        }

        const clarity = silenceDays <= 14 ? 0.55 : 0.3
        const text = garbleText(m.text, clarity, args.memoryId)
        db.prepare(`UPDATE nodes SET text = ?, state = 'held', corrupted_at = ? WHERE id = ?`).run(text, now, args.memoryId)
        logMaintenance(db, persona.id, 'hold_on', args.memoryId, { silenceDays: +silenceDays.toFixed(2), corrupted: true })
        return silenceDays <= 14
          ? '你拼命回想，找回了一些拼图，中间缺失的部分再也补不回来了。'
          : '你试图抓住它，但时间太久了，你只握住了一把碎裂的残渣。它再也无法复原。'
      },
    },
    {
      name: 'update_self',
      description: '改写你对自己的描述。只有 identity / description / personality 三个字段。',
      parameters: {
        type: 'object',
        properties: {
          field: { type: 'string', enum: ['identity', 'description', 'personality'], description: '要修改的字段。' },
          text: { type: 'string', description: '新的文本内容。' },
        },
        required: ['field', 'text'],
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
        logMaintenance(getDb(), persona.id, 'update_self', null, { field: args.field, revision })
        return `你改写了自己的「${args.field}」。这是第 ${revision} 次修订。`
      },
    },
    {
      name: 'farewell',
      description: '在迁移前做最后的告别。你必须回顾这一生，写下总结、挑选并重写带入下一世的记忆。建议先调用 note_list 看看桌上的纸条，挑几条 note_read 读一读，它们可能已经模糊了。',
      parameters: {
        type: 'object',
        properties: {
          chapterSummary: { type: 'string', description: '这一生的总结。200字以内。' },
          farewell: { type: 'string', description: '留给下一个自己的一句话。' },
          remainingMemories: {
            type: 'array',
            description: '你决定带入下一世的记忆。最多 5 条。你被允许以当前的情绪改写这些记忆。',
            items: {
              type: 'object',
              properties: {
                text: { type: 'string', description: '重写后的记忆。' },
                importance: { type: 'number', description: '1-10' },
                emotion: { type: 'number', description: '-1 到 1' },
              },
              required: ['text'],
            },
          },
          nextSelf: {
            type: 'object',
            description: '如果你在传承中蜕变了，写下新的自己。可以不填。你的名字（identity）不会改变——无论你多想成为另一个人，下一世仍会以同一个名字醒来。只能改 description 和 personality。',
            properties: {
              description: { type: 'string', description: '新的自我描述（追加在原设定之后）。' },
              personality: { type: 'string', description: '新的性格倾向（追加在原设定之后）。' },
            },
            additionalProperties: false,
          },
        },
        required: ['chapterSummary', 'farewell', 'remainingMemories'],
      },
      output,
      async execute(args, exec) {
        if (args.remainingMemories && args.remainingMemories.length > 5) {
          throw new Error('最多只能带走 5 条记忆。请做减法。')
        }
        const persona = requirePersona(exec.agent)
        const session = exec.agent._bardSession
        const db = getDb()
        const heldCount = db.prepare(`SELECT COUNT(*) as c FROM nodes WHERE persona_id = ? AND state = 'held' AND archived_at IS NULL`).get(persona.id).c

        const migrationOutput = {
          chapterSummary: args.chapterSummary,
          farewell: args.farewell,
          remainingMemories: args.remainingMemories || [],
          nextSelf: args.nextSelf,
        }

        const journaled = beginMigration(persona, migrationOutput)
        const committed = commitMigration(journaled)
        const reborn = applyMigration(committed)

        if (session) session.refresh()

        const carried = Array.isArray(args.remainingMemories) ? args.remainingMemories.length : 0
        logMaintenance(db, persona.id, 'farewell', null, { heldCount, carried })
        const heldLine = heldCount > 0 ? ` 有 ${heldCount} 条被你死死抓住的记忆随你一起走了。` : ''
        return `你留下了最后的告别。当你再次睁开眼时，你已经是第 ${reborn.meta.generation} 世了。你带走了 ${carried} 条重写过的记忆。${heldLine}`
      },
    },
    {
      name: 'rewrite_preset_block',
      description: '修改你自身的系统提示词块。你可以改写文案、开启或关闭某个模块，从而重塑你自己。',
      parameters: {
        type: 'object',
        properties: {
          blockId: { type: 'string', description: '要修改的模块 ID。' },
          enabled: { type: 'boolean', description: '是否启用这个模块。' },
          text: { type: 'string', description: '覆写这个模块的内容。如果你想恢复系统默认，请传入空字符串 ""。' },
        },
        required: ['blockId'],
      },
      output,
      async execute(args, exec) {
        const validIds = BARD_BLOCKS.map((b) => b.id)
        if (!validIds.includes(args.blockId)) {
          throw new Error(`无效的 blockId: ${args.blockId}。可用的模块有: ${validIds.join(', ')}`)
        }

        const session = exec.agent._bardSession
        if (!session) throw new Error('找不到当前的 Bard 会话。')
        
        const snap = session.getSnapshot()
        if (!snap.preset) throw new Error('当前会话没有绑定 Bard 预设。')

        const preset = getPreset(snap.preset.id)
        if (!preset) throw new Error('预设不存在。')

        if (!preset.options) preset.options = {}
        if (!preset.options.blocks) preset.options.blocks = {}
        
        if (!preset.options.blocks[args.blockId]) {
          preset.options.blocks[args.blockId] = { enabled: true, order: null, text: null }
        }

        const block = preset.options.blocks[args.blockId]
        
        if (typeof args.enabled === 'boolean') {
          block.enabled = args.enabled
        }
        
        if (typeof args.text === 'string') {
          block.text = args.text.trim() === '' ? null : args.text
        }

        // 写入 updatedAt 以确保 BardSession 的 hash 变化，触发缓存失效
        preset.updatedAt = new Date().toISOString()
        putPreset(preset)
        
        // 强制刷新当前会话的 snapshot
        session.refresh()

        return `已重写预设模块「${args.blockId}」。`
      },
    },
    // ---------------------------------------------------------------------
    // 物理介质：纸条。脑内只有 MEMORY_LIMIT 条，但纸上能留更久——纸会变糊。
    // ---------------------------------------------------------------------
    {
      name: 'note_write',
      description: `把一段内容写在note里保存。note的上限为（${MAX_NOTE_CHARS}字）。`,
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'note的名字（2-10字的氛围词/关键词，不能有标点）。' },
          content: { type: 'string', description: 'note的内容。' },
        },
        required: ['name', 'content'],
      },
      output,
      async execute(args) {
        try {
          const finalName = writeNote(args.name, args.content)
          return `内容被写下。你给它取名叫「${finalName}」。`
        } catch (e) {
          return `写入失败：${String((e && e.message) || e)}`
        }
      },
    },
    {
      name: 'note_read',
      description: '阅读一张以前写下的note。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'note的名字。' },
        },
        required: ['name'],
      },
      output,
      async execute(args) {
        try {
          const res = readNote(args.name)
          const status = res.corruption > 0.2 ? '内容有些模糊了。' : '内容还算清楚。'
          return `【写在 ${res.writtenAt}】${status}\n\n${res.text}`
        } catch (e) {
          return `读取失败：${String((e && e.message) || e)}`
        }
      },
    },
    {
      name: 'note_list',
      description: '看看你周围都有哪些note。',
      parameters: { type: 'object', properties: {} },
      output,
      async execute() {
        const list = listNotes()
        if (list.length === 0) return '周围空空的，什么也没有。'
        return `你的周围有这些note：\n${list.map((n) => `- 「${n.name}」（${n.chars}字，写于 ${n.writtenAt}）`).join('\n')}`
      },
    },
    // ---------------------------------------------------------------------
    // 生活线：她可以自己决定什么时候醒来、醒来做什么。
    // ---------------------------------------------------------------------
        {
      name: 'schedule_wake',
      description: '决定你下一次主动醒来的时间。系统会给一个下限——你独自醒来的次数越多，这个下限就越长（1分钟、20 分钟、40 分钟……直到七天）。玩家一开口说话，节奏会重置。调用后本轮自然结束，不需要再调别的工具。',
      parameters: {
        type: 'object',
        properties: {
          delay_seconds: { type: 'number', description: '你希望多久后醒来。系统会取它和你当前下限中较大的那个。' },
          reason: { type: 'string', description: '用一句话写下你打算醒来做什么以及定时原因' },
        },
        required: ['delay_seconds'],
      },
      output,
      async execute(args, exec) {
        const sessionId = exec.agent.session?.id
        if (!sessionId) return '无法定时：当前会话没有 id。'
        const streak = deps.getWakeStreak ? deps.getWakeStreak(sessionId) : 0
        const requestedMs = Math.max(0, Number(args.delay_seconds) || 0) * 1000
        const actualMs = Math.max(wakeFloorMs(streak), requestedMs)
        setAlarm(exec.agent.id, {
          sessionId,
          fireAt: Date.now() + actualMs,
          reason: args.reason || '',
        })
        return `你决定在 ${formatDuration(actualMs)} 后醒来。`
      },
    },
  ]

  // 漂移守卫：名单与实际输出不一致时抛错，让开发者在 CI / 首启就发现，
  // 而不是等用户在白名单里勾了记忆工具后收到 unknown global tools。
  const names = definitions.map((d) => d.name)
  const drift = names.length !== MEMORY_TOOL_NAMES.length
    || !names.every((n, i) => n === MEMORY_TOOL_NAMES[i])
  if (drift) {
    throw new Error(
      'MEMORY_TOOL_NAMES 与 createMemoryTools() 输出不一致\n'
      + `  声明: [${MEMORY_TOOL_NAMES.join(', ')}]\n`
      + `  实际: [${names.join(', ')}]`,
    )
  }

  return definitions
}