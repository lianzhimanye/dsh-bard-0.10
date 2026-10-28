/**
 * Bard storage.
 *
 * Everything the plugin owns lives under `$DSH_HOME/bard/` as plain files, so
 * it survives plugin upgrades, needs no storage backend, and stays inspectable
 * (and hand-editable) by the user:
 *
 *   cards/<id>.json        normalized character cards
 *   worldbooks/<id>.json   normalized world books
 *   portraits/<id>.<ext>   the original PNG of an imported PNG card
 *   presets/<id>.json      a card + world books + skills, i.e. what becomes a
 *                          native DSH agent preset
 *
 * Writes are atomic (temp file + rename) so a crash can never leave a truncated
 * record that would silently drop a card on the next read.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const KINDS = ['cards', 'worldbooks', 'portraits', 'presets', 'rendered', 'workspaces', 'personas']

export function bardRoot() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const next = path.join(home, 'bard')
  const legacy = path.join(home, 'tavern')
  // ---- auto-migration from dsh-tavern ----
  // 首次以新版启动时，把旧目录整体搬过来，老用户数据不丢。
  // 失败不影响启动：数据还在原位，只是这次读到空目录。
  try {
    if (!fs.existsSync(next) && fs.existsSync(legacy)) {
      fs.renameSync(legacy, next)
    }
  } catch (error) {
    /* 目录被占用 / 权限不足等情况按新目录继续 */
  }
  return next
}

export function bardDirs() {
  const root = bardRoot()
  const dirs = { root }
  for (const kind of KINDS) dirs[kind] = path.join(root, kind)
  return dirs
}

export function ensureDirs() {
  const dirs = bardDirs()
  for (const kind of KINDS) fs.mkdirSync(dirs[kind], { recursive: true, mode: 0o700 })
  return dirs
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    return undefined
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temp, file)
}

/** A readable, collision-proof identifier derived from a display name. */
export function makeId(name) {
  const ascii = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 24)
  const digest = createHash('sha1').update(`${name}\u0000${randomUUID()}`).digest('hex').slice(0, 6)
  return `${ascii || 'item'}-${digest}`
}

function listRecords(kind) {
  const dir = bardDirs()[kind]
  let names = []
  try {
    names = fs.readdirSync(dir)
  } catch (error) {
    return []
  }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const value = readJson(path.join(dir, name))
    if (value && typeof value === 'object') out.push(value)
  }
  return out
}

function getRecord(kind, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(id)) return undefined
  return readJson(path.join(bardDirs()[kind], `${id}.json`))
}

function putRecord(kind, id, value) {
  writeJsonAtomic(path.join(bardDirs()[kind], `${id}.json`), value)
  return value
}

function deleteRecord(kind, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(id)) return false
  try {
    fs.unlinkSync(path.join(bardDirs()[kind], `${id}.json`))
    return true
  } catch (error) {
    return false
  }
}

export const listCards = () => listRecords('cards').sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)))
export const getCard = (id) => getRecord('cards', id)
export const putCard = (card) => putRecord('cards', card.id, card)
export const deleteCard = (id) => {
  deletePortrait(id)
  return deleteRecord('cards', id)
}

export const listWorldBooks = () => listRecords('worldbooks').sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)))
export const getWorldBook = (id) => getRecord('worldbooks', id)
export const putWorldBook = (book) => putRecord('worldbooks', book.id, book)
export const deleteWorldBook = (id) => deleteRecord('worldbooks', id)

export const listPresets = () => listRecords('presets').sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
export const getPreset = (id) => getRecord('presets', id)
export const putPreset = (preset) => putRecord('presets', preset.id, preset)
export const deletePreset = (id) => deleteRecord('presets', id)

/**
 * Personas.
 *
 * 人格 id 与预设 id 解耦：`personas/<personaId>.json` 是"她的一生"，
 * `presets/<presetId>.json` 通过 `options.personaId` 引用它。删除预设
 * 不删人格；删除人格需要显式确认。
 *
 * `personas/<personaId>.pre-migration.json` 是迁移前快照，用于 7 天
 * 回滚窗口。它不是 persona 记录，不参与 `listPersonas()`。
 */
export const listPersonas = () => listRecords('personas')
  .filter((record) => record && record.kind === 'persona')
  .sort((a, b) => String(b.meta?.bornAt || '').localeCompare(String(a.meta?.bornAt || '')))

export const getPersona = (id) => {
  const record = getRecord('personas', id)
  return record && record.kind === 'persona' ? record : undefined
}

export const putPersona = (persona) => putRecord('personas', persona.id, persona)

export const deletePersona = (id) => deleteRecord('personas', id)

export const getPreMigrationSnapshot = (id) => {
  const record = getRecord('personas', `${id}.pre-migration`)
  return record && record.kind === 'pre-migration' ? record : undefined
}

export const putPreMigrationSnapshot = (id, snapshot) =>
  putRecord('personas', `${id}.pre-migration`, { ...snapshot, kind: 'pre-migration', personaId: id })

export const deletePreMigrationSnapshot = (id) =>
  deleteRecord('personas', `${id}.pre-migration`)

/**
 * Workspace records.
 *
 * One per live Bard session. Kept Host-side (not inside the session's working
 * directory) because cleanup has to find the directory *from* a session id,
 * not the other way around. Each record carries the absolute `cwd` and the
 * `relPath` used to build the directory, so a later sweep can recompute the
 * absolute path without any agent context.
 */
export const putWorkspaceRecord = (id, record) => putRecord('workspaces', id, { ...record, id })

/** 所有工作区记录（清理逻辑用来反查 session → 目录）。 */
export const listWorkspaceRecords = () => listRecords('workspaces')

/** 删除一条工作区记录。 */
export const deleteWorkspaceRecord = (id) => deleteRecord('workspaces', id)

/**
 * Rendered card snapshots.
 *
 * One per Bard preset — not one per card — because the same card renders
 * differently under different presets (the `{{user}}` substitution depends on
 * the preset's "your name"). The file name is the Bard preset id, so deleting
 * a preset can delete its snapshot without a lookup table.
 */
export const putRenderedCard = (presetId, card) => putRecord('rendered', presetId, { ...card, presetId })
export const deleteRenderedCard = (id) => deleteRecord('rendered', id)

/** Persist the original PNG of an imported card so the UI can show it. */
export function putPortrait(id, bytes, ext = 'png') {
  const dir = ensureDirs().portraits
  const file = path.join(dir, `${id}.${ext}`)
  fs.writeFileSync(file, bytes, { mode: 0o600 })
  return `/dsh-bard/api/portrait/${id}`
}

export function portraitPath(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/u.test(id)) return undefined
  for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
    const file = path.join(bardDirs().portraits, `${id}.${ext}`)
    if (fs.existsSync(file)) return file
  }
  return undefined
}

/**
 * Tool catalog cache.
 *
 * The only source of truth for the settings page's whitelist checkboxes. The
 * collector (see lib/index.js registerAgentToolList) rewrites it when the
 * fingerprint of all available schemas changes; the UI reads it through /state.
 * Never trust a stale in-memory copy
 * — always go back to disk.
 */
export function readToolCatalog() {
  const file = path.join(bardDirs().root, 'tool-catalog.json')
  const value = readJson(file)
  if (!value || !Array.isArray(value.tools)) return []
  return value.tools.filter((name) => typeof name === 'string' && name.length > 0)
}

export function writeToolCatalog(tools) {
  const list = Array.isArray(tools)
    ? tools.filter((name) => typeof name === 'string' && name.length > 0)
    : []
  // Never overwrite a good catalog with an empty one: the caller only writes
  // after a successful, non-empty collection, but the guard keeps a buggy
  // caller from blanking the settings page.
  if (list.length === 0) return
  try {
    writeJsonAtomic(path.join(bardDirs().root, 'tool-catalog.json'), {
      tools: list,
      updatedAt: new Date().toISOString(),
    })
  } catch (error) {
    /* a cache write failure must not break the request path */
  }
}

/**
 * Skill catalog cache.
 *
 * Same file-cache contract as the tool catalog: written by the agent-side
 * collector (lib/index.js captureSkillCatalog), read back by /state. The
 * settings page cannot call `ctx.skills.list()` with an agent scope (it is
 * a stateless HTTP request with no agent), so this file is the only path
 * that carries the agent-scoped skills into the UI.
 */
export function readSkillCatalog() {
  const file = path.join(bardDirs().root, 'skill-catalog.json')
  const value = readJson(file)
  if (!value || !Array.isArray(value.skills)) return []
  return value.skills
    .filter((s) => s && typeof s.name === 'string' && s.name.length > 0)
    .map((s) => ({
      name: s.name,
      description: typeof s.description === 'string' ? s.description : '',
      whenToUse: typeof s.whenToUse === 'string' ? s.whenToUse : '',
      source: typeof s.source === 'string' ? s.source : 'unknown',
      provider: typeof s.provider === 'string' ? s.provider : 'unknown',
      // 完整内容随清单落盘：settings 页是无状态 HTTP，拿不到 agent scope；
      // resolveSkills 只能从这里读，否则用户级技能会被静默丢弃。
      content: typeof s.content === 'string' ? s.content : '',
    }))
}

export function writeSkillCatalog(skills) {
  const list = Array.isArray(skills)
    ? skills
      .filter((s) => s && typeof s.name === 'string' && s.name.length > 0)
      .map((s) => ({
        name: s.name,
        description: typeof s.description === 'string' ? s.description : '',
        whenToUse: typeof s.whenToUse === 'string' ? s.whenToUse : '',
        source: typeof s.source === 'string' ? s.source : 'unknown',
        provider: typeof s.provider === 'string' ? s.provider : 'unknown',
        content: typeof s.content === 'string' ? s.content : '',
      }))
    : []
  // Never overwrite a good catalog with an empty one.
  if (list.length === 0) return
  try {
    writeJsonAtomic(path.join(bardDirs().root, 'skill-catalog.json'), {
      skills: list,
      updatedAt: new Date().toISOString(),
    })
  } catch (error) {
    /* a cache write failure must not break the request path */
  }
}

/**
 * Section catalog cache.
 *
 * The settings page's section whitelist needs the *names* of the system-prompt
 * sections a Bard session actually assembles. Only the Host sees an assembly,
 * so the per-agent prompt filter collects the list once and writes it here;
 * the UI reads it back through /state. Same file-cache contract as the tool
 * catalog: never a memory copy, never overwrite a good list with an empty one.
 */
export function readSectionCatalog() {
  const file = path.join(bardDirs().root, 'section-catalog.json')
  const value = readJson(file)
  if (!value || !Array.isArray(value.sections)) return []
  return value.sections
    .filter((s) => s && typeof s.name === 'string' && s.name.length > 0)
    .map((s) => ({ name: s.name, chars: Number(s.chars) || 0 }))
}

export function writeSectionCatalog(sections) {
  const list = Array.isArray(sections)
    ? sections
      .filter((s) => s && typeof s.name === 'string' && s.name.length > 0)
      .map((s) => ({ name: s.name, chars: Number(s.chars) || 0 }))
    : []
  if (list.length === 0) return
  try {
    writeJsonAtomic(path.join(bardDirs().root, 'section-catalog.json'), {
      sections: list,
      updatedAt: new Date().toISOString(),
    })
  } catch (error) {
    /* a cache write failure must not break the request path */
  }
}

export function deletePortrait(id) {
  const file = portraitPath(id)
  if (!file) return
  try {
    fs.unlinkSync(file)
  } catch (error) {
    /* already gone */
  }
}

/**
 * 把预设里存的技能名解析成完整技能对象。
 *
 * 唯一数据源是本地技能缓存（skill-catalog.json）：settings 页与抓取时机
 * 都拿不到 agent scope，只有这份落盘清单能带上用户级技能的 content。
 * 缺失的技能报错但不中断，返回的数组可能比传入的短。
 */
export function resolveSkillsFromCatalog(names, reportError) {
  if (!Array.isArray(names) || names.length === 0) return []
  const catalog = readSkillCatalog()
  const map = new Map(catalog.map((s) => [s.name, s]))
  const out = []
  for (const name of names) {
    const skill = map.get(name)
    if (skill && skill.content) out.push(skill)
    else if (typeof reportError === 'function') reportError('skills', `技能「${name}」在本地技能缓存中缺失。`)
  }
  return out
}
