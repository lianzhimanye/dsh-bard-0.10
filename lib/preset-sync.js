/**
 * 预设构建与同步。
 * 将原本塞在 index.js 里的 DSH Preset 生成逻辑剥离。
 */

import { getCard, getPreset, putPreset, listPresets, putRenderedCard } from './store.js'
import { interpolateCard, DEFAULT_USER_NAME } from './interpolate.js'
import { describeCard } from './persona.js'

export const PRESET_PREFIX = 'bard-'
export const PRESET_ORDER_BASE = 50
export const KEEP_ROW_IDS = ['tool-fs', 'tool-fs-search', 'tool-web', 'present', 'tool-comfy']

export function createPresetSync(ctx, runtime) {
  function builtinToolRows() {
    const isWindows = process.platform === 'win32'
    return [
      { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }, { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search' },
      { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: isWindows }, { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: !isWindows },
      { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' }, { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
      { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo' }, { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' },
      { id: 'present', name: '@deepseek-ai/dsh-tool-present' }, { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
      { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' }, { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
      { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
    ]
  }

  async function baseRows(presetsService) {
    let defaultId
    try { const current = await presetsService.resolve(); defaultId = current && current.id } catch (e) { defaultId = undefined }
    const editor = ctx.get('configEditor')
    if (editor && typeof editor.configuration === 'function') {
      try {
        const rows = editor.configuration()
        const candidates = rows.filter((row) => row && row.entry && row.entry.options && row.entry.options.name === '@deepseek-ai/dsh-agent-preset' && row.inherited && Array.isArray(row.inherited.plugins))
        if (candidates.length > 0) {
          const chosen = candidates.find((row) => row.inherited.id === defaultId) || candidates[0]
          const plugins = structuredClone(chosen.inherited.plugins)
          // 从默认预设继承工具行。注意：为了安全与沉浸感，这里用 KEEP_ROW_IDS
          // 做了一层白名单过滤，只保留文件系统、搜索、Web、present 等基础工具，
          // 剥离 bash / pwsh / jobs 等高权限或破坏沉浸感的工具。
          // 这与“完全继承当前配置”有所出入，但属于产品层面的有意裁剪。
          const filtered = KEEP_ROW_IDS.length > 0 ? plugins.filter((row) => row && KEEP_ROW_IDS.includes(row.id)) : plugins
          if (KEEP_ROW_IDS.length > 0 && filtered.length === 0 && plugins.length > 0) {
            runtime.reportError('preset-sync', `默认预设的插件行完全不匹配 KEEP_ROW_IDS，生成的 Bard 预设将没有任何工具。`)
          }
          return { source: `preset:${chosen.inherited.id}`, rows: filtered }
        }
      } catch (error) { runtime.reportError('preset-sync', `读取默认预设失败：${String(error.message || error)}`) }
    }
    return { source: 'builtin', rows: builtinToolRows() }
  }

  async function buildDefinition(bardPreset, index, presetsService) {
    const rawCard = getCard(bardPreset.cardId)
    if (!rawCard) throw new Error(`角色卡已不存在（${bardPreset.cardId}）`)
    const userName = (bardPreset.options && bardPreset.options.userName) || DEFAULT_USER_NAME
    const card = interpolateCard(rawCard, { userName })
    const base = await baseRows(presetsService)
    const rows = base.rows.map((row) => ({ ...row }))
    const personaConfig = { prefix: '', complete: false, includeRuntimeContext: !(bardPreset.options && bardPreset.options.includeRuntimeContext === false) }
    const at = rows.findIndex((row) => row && row.name === '@deepseek-ai/dsh-persona')
    if (at >= 0) rows[at] = { ...rows[at], disabled: false, config: { ...(rows[at].config || {}), ...personaConfig } }
    else rows.unshift({ id: 'persona', name: '@deepseek-ai/dsh-persona', config: personaConfig })
    return { id: `${PRESET_PREFIX}${bardPreset.id}`, name: `吟游 · ${bardPreset.name}`, description: describeCard(card, bardPreset.name), order: PRESET_ORDER_BASE + index, plugins: rows, __base: base.source }
  }

  async function syncPresets(presetsService) {
    const run = async () => {
      for (const dispose of runtime.presetDisposers.splice(0)) { try { await dispose() } catch (e) {} }
      runtime.clearErrors('preset-sync')
      const bardPresets = listPresets()
      for (let index = 0; index < bardPresets.length; index++) {
        const bardPreset = bardPresets[index]
        let definition
        try { definition = await buildDefinition(bardPreset, index, presetsService) }
        catch (error) {
          const reason = String((error && error.message) || error)
          bardPreset.lastBase = ''; bardPreset.lastError = reason
          try { putPreset(bardPreset) } catch (e) {}
          runtime.reportError('preset-sync', `预设「${bardPreset.name}」无法生成：${reason}`)
          continue
        }
        const { __base, ...declaration } = definition
        bardPreset.lastBase = __base
        try { const snapshot = interpolateCard(getCard(bardPreset.cardId), { userName: (bardPreset.options && bardPreset.options.userName) || DEFAULT_USER_NAME }); if (snapshot) putRenderedCard(bardPreset.id, snapshot) } catch (e) {}
        try { const dispose = await presetsService.register(declaration); runtime.presetDisposers.push(dispose); bardPreset.lastError = '' }
        catch (error) { bardPreset.lastError = String((error && error.message) || error); runtime.reportError('preset-sync', `DSH 预设 ${declaration.id} 注册失败：${bardPreset.lastError}`) }
        try { putPreset(bardPreset) } catch (e) {}
      }
    }
    return run()
  }

  return { syncPresets, PRESET_PREFIX }
}
