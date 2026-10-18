/**
 * dsh-bard — Bard-style role-play for DeepSeek Harness.
 *
 * The Host half owns four things:
 *
 *  1. **Storage** of character cards, world books and Bard presets
 *     (`lib/store.js`, under `$DSH_HOME/bard/`).
 *  2. **Native DSH agent presets.** Every Bard preset is registered with
 *     `ctx.agentPresets` as an ordinary `@deepseek-ai/dsh-agent-preset`
 *     declaration whose `@deepseek-ai/dsh-persona` row carries the rendered
 *     character. Selecting it in the session's preset picker is therefore all a
 *     user has to do — no Bard-specific session mode exists or is needed.
 *     The *rest* of the plugin list is copied from the profile's own default
 *     preset so the character keeps a real working toolset.
 *  3. **World-book activation.** For every Agent that selected a Bard preset,
 *     a scoped `systemPrompt.context()` is registered on that agent's context;
 *     its thunk re-runs `selectLore` against the session's recent transcript
 *     on every request — keyword match, selective logic, probability, and
 *     bounded recursion all happen there.
 *  4. **A UI API** (`/dsh-bard/api/*`) plus the `/bard` command, so the same
 *     operations are available from the settings page, from chat, and from a
 *     script.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  ensureDirs,
  listCards,
  getCard,
  putCard,
  deleteCard,
  listWorldBooks,
  getWorldBook,
  putWorldBook,
  deleteWorldBook,
  listPresets,
  getPreset,
  putPreset,
  deletePreset,
  putPortrait,
  portraitPath,
  putRenderedCard,
  deleteRenderedCard,
  makeId,
  listWorkspaceRecords,
  putWorkspaceRecord,
  deleteWorkspaceRecord,
  readToolCatalog,
  writeToolCatalog,
  readSectionCatalog,
  writeSectionCatalog,
  readSkillCatalog,
  writeSkillCatalog,
} from './store.js'
import {
  readCardDocument,
  normalizeCard,
  cardGreetings,
  isPng,
  updateCardEditable,
  isRedundantField,
  detectCardLanguage,
} from './cards.js'
import {
  readWorldBookDocument,
  worldBookFromCharacterBook,
  selectLore,
  renderLore,
} from './lorebook.js'
import { buildPersonaPrefix, describeCard, DEFAULT_STYLE_HINT } from './persona.js'
import { interpolateCard, interpolateText, DEFAULT_USER_NAME } from './interpolate.js'

/** Cordis plugin name. */
export const name = 'bard'
/** The browser carrier this plugin needs before it can expose its API. */
export const inject = ['webServer']

/**
 * 挂在 Bard 预设上的插件行 id。未列出的行不挂载。
 * 留空数组 = 不过滤，继承 profile 默认预设的全部行。
 */
const KEEP_ROW_IDS = [
  'tool-fs',
  'tool-fs-search',
  'tool-web',
  'present',
  'tool-comfy',
]
/** Preset identities this plugin owns, so they are never confused with others. */
const PRESET_PREFIX = 'bard-'
/** Bard 角色扮演必需的 section，白名单模式下强制保留。 */
const BARD_REQUIRED_SECTIONS = ['deployment:persona-prefix', 'deployment:persona-suffix']
/** tool:* section 的前缀。 */
const TOOL_SECTION_PREFIX = 'tool:'
/** Roster order for generated agent presets — after the shipped ones. */
const PRESET_ORDER_BASE = 50
// (行级工具过滤已移除。现在通过 tools.restrict({ allow }) 做 per-agent
// 过滤，见 registerAgentToolList。行级方案盖不住 capability-menu-policy
// 的 resident 工具；restrict() 能，且天然只作用于 Bard 预设的 agent。)
/** Bounds on an upload, in bytes. */
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024
/** How many recent transcript excerpts the lore matcher scans. */
const RECENT_LIMIT = 24
/** Prompt-context order: after sandbox/approval/subagent policy (110-120). */
const LORE_CONTEXT_ORDER = 130
const LORE_CONTEXT_NAME = 'bard:world-book'
/**
 * The tool list is injected as a prompt *variable*, not a section.
 *
 * A section is atomic at the top level of the prompt: `systemPrompt` sorts
 * sections against each other and joins them with blank lines, so nothing can
 * ever land *inside* the persona prefix — the list would sit next to the
 * persona, not under its last sentence. A prompt variable is substituted into
 * a section's text while that section is rendered, so writing
 * `{{bard_tools}}` at the bottom of the persona prefix puts the list exactly
 * there. The variable also survives a persona row registered with
 * `complete: true`: that flag discards every other *section*, but the persona
 * text itself — variable reference included — is still interpolated.
 *
 * The name must match /^[a-z][a-z0-9_]*$/; DSH rejects anything else at
 * registration time. There is no order to pick: variables are not placed,
 * they are referenced.
 */
const TOOL_LIST_VARIABLE_NAME = 'bard_tools'
/**
 * The workspace variable.
 *
 * Same mechanism as the tool list: a prompt variable evaluated by DSH before
 * every model request, so it can read the agent's live session cwd. The value
 * carries its own `## 你的工作区` heading, so an unset workspace renders as
 * nothing at all rather than a dangling "你的工作区是「」".
 */
const WORKSPACE_VARIABLE_NAME = 'bard_workspace'
/** Prefix used when a preset does not name one. */
const DEFAULT_WORKSPACE_PREFIX = 'Bard_World'
/**
 * How long a workspace record must exist before the lazy sweep may consider
 * it orphaned. A brand-new session that has produced no event does not appear
 * in `sessionPersistence.list()`; without this grace period the sweep would
 * delete a workspace the user just opened.
 */
const WORKSPACE_GRACE_MS = 5 * 60 * 1000

/** A short, stable, per-agent identifier used as the workspace suffix. */
function workspaceShortId(agentId) {
  return createHash('sha1').update(String(agentId)).digest('hex').slice(0, 6)
}

/**
 * Build the workspace path relative to a session's cwd.
 *
 * Both the prefix and the card name go through the same filter: directory
 * separators are normalized to `/`, `..` traversal is stripped, and characters
 * illegal in Windows filenames are removed. The result is safe to `path.join`
 * and safe to `fs.rmSync`.
 */
function workspaceRelPath(prefix, cardName, shortId) {
  const cleanPrefix = String(prefix || DEFAULT_WORKSPACE_PREFIX)
    .replace(/\\/gu, '/')
    .replace(/\.\./gu, '')
    .replace(/^\/+|\/+$/gu, '')
    .replace(/\/{2,}/gu, '/')
  const cleanName = String(cardName || 'char')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '')
    .replace(/^\.+|\.+$/gu, '')
    .trim()
    .slice(0, 40) || 'char'
  const lead = cleanPrefix.length > 0 ? `${cleanPrefix}/` : ''
  return `${lead}${cleanName}-${shortId}`
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(payload)),
  })
  res.end(payload)
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** The model-visible text of one committed session event, or ''. */
function eventText(event) {
  const type = event && event.type
  if (type === 'user/message') return textOf(event.data && event.data.content)
  if (type === 'assistant/message') return textOf(event.data && event.data.message && event.data.message.content)
  return ''
}

function readBody(req, limit = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`请求体过大（上限 ${Math.round(limit / 1024 / 1024)} MiB）`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJsonBody(req) {
  const raw = await readBody(req)
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch (error) {
    throw new Error(`请求体不是合法 JSON（${String((error && error.message) || error)}）`)
  }
}

/** Decode the `{ dataUrl }` or `{ base64 }` payload the settings page sends. */
function bytesFromPayload(payload) {
  const dataUrl = typeof payload.dataUrl === 'string' ? payload.dataUrl : ''
  if (dataUrl.length > 0) {
    const comma = dataUrl.indexOf(',')
    const body = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
    return Buffer.from(body, 'base64')
  }
  if (typeof payload.base64 === 'string') return Buffer.from(payload.base64, 'base64')
  if (typeof payload.text === 'string') return Buffer.from(payload.text, 'utf8')
  throw new Error('缺少文件内容（dataUrl / base64 / text）')
}

// ---------------------------------------------------------------------------
// presentation snapshots
// ---------------------------------------------------------------------------

function cardSummary(card) {
  return {
    id: card.id,
    name: card.name,
    spec: card.spec,
    specVersion: card.specVersion,
    container: card.container,
    importedAt: card.importedAt,
    creator: card.creator,
    characterVersion: card.characterVersion,
    tags: card.tags,
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    firstMes: card.firstMes,
    alternateGreetings: card.alternateGreetings,
    mesExample: card.mesExample,
    systemPrompt: card.systemPrompt,
    postHistoryInstructions: card.postHistoryInstructions,
    creatorNotes: card.creatorNotes,
    depthPrompt: card.depthPrompt,
    portrait: card.portrait || '',
    hasCharacterBook: card.characterBook !== null,
    greetingCount: cardGreetings(card).length,
  }
}

function worldBookSummary(book) {
  const entries = book.entries || []
  return {
    id: book.id,
    name: book.name,
    source: book.source,
    importedAt: book.importedAt,
    entryCount: entries.length,
    enabledCount: entries.filter((entry) => entry.enabled).length,
    constantCount: entries.filter((entry) => entry.enabled && entry.constant).length,
    keywordCount: entries.filter((entry) => entry.enabled && !entry.constant && entry.keys.length > 0).length,
  }
}

function skillSummary(skill) {
  return {
    name: skill.name,
    description: skill.description || '',
    whenToUse: skill.whenToUse || '',
    source: skill.source || 'unknown',
    provider: skill.provider || 'unknown',
  }
}

// ---------------------------------------------------------------------------
// the plugin
// ---------------------------------------------------------------------------

export function apply(ctx) {
  ensureDirs()

  const runtime = {
    /** Diagnostics from the last preset synchronisation, shown in the UI. */
    errors: [],
    /** sessionId -> recent transcript excerpts, newest last. */
    recent: new Map(),
    /** sessionId -> disposer for that agent's scoped lore context. */
    loreDisposers: new Map(),
    /** agentId -> disposer for that agent's tool-list context. */
    toolListDisposers: new Map(),
    /** agentId -> disposer for that agent's workspace-variable context. */
    workspaceDisposers: new Map(),
    /** agentId -> disposer for that agent's system-prompt section filter. */
    promptFilterDisposers: new Map(),
    /** agentId -> that agent's session cwd, remembered for cleanup. */
    cwdByAgent: new Map(),
    /** Disposers for the agent presets this plugin currently owns. */
    presetDisposers: [],
    /** Serialises preset synchronisation. */
    syncing: Promise.resolve(),
  }

  // -- transcript memory ---------------------------------------------------

  ctx.on('session/event', (session, event) => {
    if (!session) return
    const text = eventText(event)
    if (text.trim().length === 0) return
    const list = runtime.recent.get(session.id) || []
    list.push(text)
    while (list.length > RECENT_LIMIT) list.shift()
    runtime.recent.set(session.id, list)
  })
  ctx.on('session/disposed', (session) => {
    if (session) runtime.recent.delete(session.id)
  })

  // -- per-agent world-book context ---------------------------------------

  /**
   * Per-agent world-book context.
   *
   * Scope matters here for the same reason it matters for the tool list: the
   * `systemPrompt` service must be read from `agent.ctx`, not from the
   * plugin's own `ctx`. `systemPrompt.context()` registers into the layer of
   * whatever context the service was accessed through; the plugin's ctx has
   * no scope tag, so the entry would land in the GLOBAL layer while the
   * effect that owns it (`agent.ctx.effect`) dies with the agent — a
   * lifecycle mismatch that silently disabled lore injection entirely.
   *
   * Registered unconditionally, like the tool list, and for the same reason:
   * at `agent/created` the Bard preset has not been applied yet, so any
   * early-exit check on the composed preset id disables the feature entirely.
   * The preset lookup now happens inside the thunk, which runs before each
   * request — after the preset is live.
   *
   * The context is intentionally NOT cached: `loreTextFor` re-selects entries
   * against the session's latest transcript every turn, which is the whole
   * point of keyword-triggered lore.
   */
  function registerAgentLore(agent) {
    const systemPrompt = agent.ctx.get('systemPrompt')
    if (!systemPrompt) {
      runtime.errors.push(`world-book: systemPrompt 服务在 agent ${agent.id} 的 ctx 上不可用`)
      return () => {}
    }
    let thunkErrorReported = false
    let dispose
    try {
      dispose = agent.ctx.effect(() => systemPrompt.context({
        name: LORE_CONTEXT_NAME,
        order: LORE_CONTEXT_ORDER,
        text: () => {
          try {
            const presetsService = agent.ctx.get('agentPresets')
            if (!presetsService) return ''
            const composed = presetsService.composedPreset(agent.ctx)
            if (typeof composed !== 'string' || !composed.startsWith(PRESET_PREFIX)) return ''
            const bardPresetId = composed.slice(PRESET_PREFIX.length)
            if (!getPreset(bardPresetId)) return ''
            return loreTextFor(runtime, bardPresetId, agent.id)
          } catch (error) {
            if (!thunkErrorReported) {
              thunkErrorReported = true
              runtime.errors.push(`world-book thunk for ${agent.id}: ${String((error && error.message) || error)}`)
            }
            return ''
          }
        },
      }), 'bard.world-book')
    } catch (error) {
      runtime.errors.push(`world-book context for ${agent.id}: ${String((error && error.message) || error)}`)
      return () => {}
    }
    return () => {
      try {
        dispose()
      } catch (error) {
        /* already disposed with the agent */
      }
    }
  }

  /**
   * Lazily rendered tool-list variable.
   *
   * Scope is the whole point of this function. `systemPrompt.variable()`
   * registers into the layer of whatever context the service was accessed
   * through — see `dsh-system-prompt`'s `variable()` calling
   * `this.layers.effect(this.ctx, …)` and `dsh-scope`'s `effect()` reading
   * `scopeOf(ctx)`. Accessing the service via the plugin's own `ctx` (no scope
   * tag) writes to the GLOBAL layer: the first agent would succeed, every
   * later agent would hit `NamedEntries`' "already registered" error, and the
   * value would never actually belong to any agent. So every service is
   * read from `agent.ctx`, and the effect ownership (`agent.ctx.effect`) then
   * matches the registration scope.
   *
   * `tools` is scoped per agent; reading it from the plugin's ctx returns the
   * global view (kernel-resident tools only, no read/write/pwsh). That was the
   * bug two revisions ago and is why this service must come from `agent.ctx`
   * as well.
   *
   * The variable is registered unconditionally for every agent; its provider is
   * evaluated by DSH before each model request. Everything that used to
   * happen at registration time now happens inside that provider, because at
   * `agent/created` the agent's ctx has not yet had the Bard preset applied:
   * `composedPreset()` returns the session's starting preset ("standard"), and
   * any early-exit check against PRESET_PREFIX would silently disable the
   * feature.
   *
   * DSH substitutes the returned string into `{{bard_tools}}` wherever a
   * section references it. Returning `''` for a non-Bard agent leaves the
   * reference site as empty text: no list line, no title, no token cost.
   *
   * The rendered string is cached per preset id: the provider still runs on every
   * assemble, but only recomputes when the composed preset actually changes.
   *
   * Respects the preset's own tool switch: when `enableTools` is false no list
   * is emitted — and the persona preamble, which is where `{{bard_tools}}`
   * lives, is omitted too, so the reference itself never reaches DSH.
   */
  function registerAgentToolList(agent) {
    const systemPrompt = agent.ctx.get('systemPrompt')
    if (!systemPrompt) {
      runtime.errors.push(`tool-list: systemPrompt 服务在 agent ${agent.id} 的 ctx 上不可用`)
      return () => {}
    }

    let cachedKey = null
    let cachedText = ''
    let restrictionDispose = null
    let restrictionKey = null
    let captured = false
    let thunkErrorReported = false

    /**
     * Register (or clear) the tool restriction for this agent.
     *
     * `allow === null` means "no restriction": the request carries every tool
     * the scope would otherwise see. An empty `allow` (enableTools === false)
     * is a deny-all. Anything else is a whitelist.
     *
     * The restriction lives on `agent.ctx.effect` — same scope as the other
     * Bard registrations — so it only affects agents running a Bard preset.
     * Reading `tools` from `agent.ctx` (not the plugin's own `ctx`) is what
     * keeps every other session's tool set untouched.
     */
    const syncRestriction = (tools, bardPreset) => {
      const options = (bardPreset && bardPreset.options) || {}
      let allow = null
      if (options.enableTools === false) allow = []
      else if (Array.isArray(options.toolAllowlist) && options.toolAllowlist.length > 0) allow = options.toolAllowlist
      const key = bardPreset ? `${bardPreset.id}\u0000${bardPreset.updatedAt || ''}` : ''
      if (key === restrictionKey) return
      if (restrictionDispose) {
        try { restrictionDispose() } catch (error) { /* already disposed */ }
        restrictionDispose = null
      }
      restrictionKey = key
      if (allow === null || !tools || typeof tools.restrict !== 'function') return
      try {
        restrictionDispose = agent.ctx.effect(() => tools.restrict({ allow }), 'bard.tool-filter')
      } catch (error) {
        // A whitelist naming an unknown tool makes `restrict` throw. Record
        // once per agent; the setting stays broken until the user edits the
        // allowlist, but the next request is not blocked.
        if (!thunkErrorReported) {
          thunkErrorReported = true
          runtime.errors.push(`tool-filter for ${agent.id}: ${String((error && error.message) || error)}`)
        }
      }
    }

    const text = (context) => {
      try {
        const presetsService = agent.ctx.get('agentPresets')
        const tools = agent.ctx.get('tools')
        if (!presetsService || !tools) return ''
        // Capture the full tool universe on this agent's FIRST turn — before
        // syncRestriction registers anything on this scope. A restriction
        // filters what a scope INHERITS (global + ancestor layers); the
        // agent's own layer is exempt, but the global-layer tools this
        // provider must see live in ancestor scopes, so once a restriction
        // exists, schemas() no longer shows them. Hence: capture once, before
        // the first syncRestriction call, and write the file. Subsequent
        // turns skip the block and the scope's own filter takes over.
        //
        // Reading `tools` from `agent.ctx` (not the plugin ctx) is mandatory:
        // the plugin ctx only sees the kernel-resident tools — compress,
        // acp_status, load_workspace_dependencies and friends — and would
        // write a six-entry catalog. See the README note on tools scoping.
        if (!captured) {
          captured = true
          try {
            const schemas = tools.schemas(context && context.scope)
            if (Array.isArray(schemas)) {
              const names = schemas
                .map((schema) => (schema && typeof schema.name === 'string' ? schema.name : ''))
                .filter((name) => name.length > 0)
              if (names.length > 0) writeToolCatalog(names)
            }
          } catch (error) {
            // A failed capture only leaves the settings page showing the last
            // good catalog. Never block the request.
          }
        }
        const composed = presetsService.composedPreset(agent.ctx)
        if (typeof composed !== 'string' || !composed.startsWith(PRESET_PREFIX)) {
          syncRestriction(tools, null)
          return ''
        }
        const presetId = composed.slice(PRESET_PREFIX.length)
        const bardPreset = getPreset(presetId)
        if (!bardPreset) {
          syncRestriction(tools, null)
          return ''
        }
        // Sync the restriction BEFORE reading schemas: the whitelist has to be
        // live this turn, otherwise the text below lists the previous config.
        syncRestriction(tools, bardPreset)
        const key = `${presetId}\u0000${bardPreset.updatedAt || ''}`
        if (key === cachedKey) return cachedText
        if (bardPreset.options && bardPreset.options.enableTools === false) {
          cachedKey = key
          cachedText = ''
          return ''
        }
        const schemas = tools.schemas(context && context.scope)
        if (!Array.isArray(schemas)) return ''
        const names = schemas
          .map((schema) => (schema && typeof schema.name === 'string' ? schema.name : ''))
          .filter((name) => name.length > 0)
        cachedKey = key
        cachedText = names.length === 0 ? '' : `\n\n你现在能用的工具：${names.join('、')}`
        return cachedText
      } catch (error) {
        // Report once per agent so a recurring per-turn failure does not flood
        // the diagnostics list.
        if (!thunkErrorReported) {
          thunkErrorReported = true
          runtime.errors.push(`tool-list thunk for ${agent.id}: ${String((error && error.message) || error)}`)
        }
        return ''
      }
    }
    let dispose
    try {
      dispose = agent.ctx.effect(() => systemPrompt.variable(TOOL_LIST_VARIABLE_NAME, text), 'bard.tool-list')
    } catch (error) {
      runtime.errors.push(`tool-list variable for ${agent.id}: ${String((error && error.message) || error)}`)
      return () => {}
    }
    return () => {
      try {
        dispose()
      } catch (error) {
        /* already disposed with the agent */
      }
      if (restrictionDispose) {
        try { restrictionDispose() } catch (error) { /* already disposed with the agent */ }
        restrictionDispose = null
      }
    }
  }

  /**
   * Per-agent workspace directory + prompt variable.
   *
   * Structure mirrors `registerAgentToolList`: the variable is registered
   * unconditionally for every agent, the Bard check and the directory work
   * happen inside the provider, and every service is read from `agent.ctx` so
   * the effect ownership matches the registration scope.
   *
   * What the provider does, in order:
   *
   *   1. Confirm the composed preset starts with `bard-`.
   *   2. Resolve the agent's session cwd (`agent.session.header.cwd`).
   *   3. Read the preset's `workspaceEnabled` / `workspacePrefix`.
   *   4. Compute `<prefix>/<cardName>-<shortId>` under the session cwd.
   *   5. `mkdirSync(recursive)` -- idempotent.
   *   6. Write `.bard-session` inside that directory if absent.
   *   7. Write a record to `$DSH_HOME/bard/workspaces/<shortId>.json`.
   *   8. Return the prompt text (heading + path + one imperative sentence).
   *
   * Every step is idempotent, so running once per request is safe. The result
   * is cached by `(presetId, cwd, sessionId)`; cwd is immutable per session,
   * so a hit means nothing below reruns this turn.
   *
   * Returns `''` for any non-Bard agent, any agent whose session cwd is not
   * yet available, and any Bard preset with workspaces disabled. An empty
   * return leaves the `{{bard_workspace}}` reference site as empty text.
   */
  function registerAgentWorkspace(agent) {
    const systemPrompt = agent.ctx.get('systemPrompt')
    if (!systemPrompt) {
      runtime.errors.push(`workspace: systemPrompt 服务在 agent ${agent.id} 的 ctx 上不可用`)
      return () => {}
    }
    let cachedKey = ''
    let cachedText = ''
    let thunkErrorReported = false
    const text = () => {
      try {
        const presetsService = agent.ctx.get('agentPresets')
        if (!presetsService) return ''
        const composed = presetsService.composedPreset(agent.ctx)
        if (typeof composed !== 'string' || !composed.startsWith(PRESET_PREFIX)) return ''
        const presetId = composed.slice(PRESET_PREFIX.length)
        let cwd = runtime.cwdByAgent.get(agent.id)
        if (typeof cwd !== 'string' || cwd.length === 0) {
          cwd = agent.session && agent.session.header ? agent.session.header.cwd : undefined
          if (typeof cwd === 'string' && cwd.length > 0) runtime.cwdByAgent.set(agent.id, cwd)
        }
        if (typeof cwd !== 'string' || cwd.length === 0) return ''
        const sessionId = agent.session && typeof agent.session.id === 'string' ? agent.session.id : ''
        if (sessionId.length === 0) return ''
        const bardPreset = getPreset(presetId)
        if (!bardPreset) return ''
        const cacheKey = `${presetId}\u0000${cwd}\u0000${sessionId}\u0000${bardPreset.updatedAt || ''}`
        if (cacheKey === cachedKey) return cachedText
        const options = bardPreset.options || {}
        if (options.enableTools === false || options.workspaceEnabled === false) {
          cachedKey = cacheKey
          cachedText = ''
          return ''
        }
        const card = getCard(bardPreset.cardId)
        if (!card) return ''
        const shortId = workspaceShortId(agent.id)
        const relPath = workspaceRelPath(options.workspacePrefix, card.name, shortId)
        const absPath = path.join(cwd, ...relPath.split('/'))
        try {
          fs.mkdirSync(absPath, { recursive: true, mode: 0o700 })
        } catch (error) {
          if (!thunkErrorReported) {
            thunkErrorReported = true
            runtime.errors.push(`workspace mkdir for ${agent.id}: ${String((error && error.message) || error)}`)
          }
          return ''
        }
        // marker 里只放一个随机 token。它的唯一用途是证明目录归属：cleanup
        // 在 rmSync 之前拿它和 record 里的 token 比对。它不指向任何会话、
        // agent 或预设——角色即使读到这个文件，也学不到任何关于 harness 的事。
        //
        // 复用已有的 token：provider 每次请求都会跑，第一次写下的 token 必须
        // 一直有效，否则 record 和 marker 会对不上，懒清扫就再也不敢删这个目录。
        const marker = path.join(absPath, '.bard-session')
        let ownershipToken = ''
        try {
          const parsed = JSON.parse(fs.readFileSync(marker, 'utf8'))
          if (parsed && typeof parsed.token === 'string') ownershipToken = parsed.token
        } catch (error) {
          /* marker 不存在或损坏，下面重建 */
        }
        if (ownershipToken.length === 0) {
          ownershipToken = randomUUID()
          try {
            fs.writeFileSync(
              marker,
              `${JSON.stringify({ token: ownershipToken }, null, 2)}\n`,
              { mode: 0o600 },
            )
          } catch (error) {
            /* marker 是清理凭据，写不进只影响懒清扫 */
          }
        }
        try {
          putWorkspaceRecord(shortId, {
            token: ownershipToken,
            sessionId,
            agentId: agent.id,
            presetId,
            cwd,
            relPath,
            createdAt: new Date().toISOString(),
          })
        } catch (error) {
          /* a missing record only disables lazy cleanup for this session */
        }
        cachedKey = cacheKey
        cachedText = `\n\n## 你的工作区\n\n这个窗口的工作区是「${relPath}/」，相对于工作目录。目录已经建好了。你要写下来的东西都放那里。`
        return cachedText
      } catch (error) {
        if (!thunkErrorReported) {
          thunkErrorReported = true
          runtime.errors.push(`workspace thunk for ${agent.id}: ${String((error && error.message) || error)}`)
        }
        return ''
      }
    }
    let dispose
    try {
      dispose = agent.ctx.effect(
        () => systemPrompt.variable(WORKSPACE_VARIABLE_NAME, text),
        'bard.workspace',
      )
    } catch (error) {
      runtime.errors.push(`workspace variable for ${agent.id}: ${String((error && error.message) || error)}`)
      return () => {}
    }
    return () => {
      try {
        dispose()
      } catch (error) {
        /* already disposed with the agent */
      }
    }
  }

  /**
   * 白名单模式是否启用。
   *
   * 迁移规则：显式 `keepSectionsEnabled` 优先；未定义时，`keepSections` 非空
   * 视为启用（兼容既有预设）。两者都为空/否 → 不启用。
   */
  function isKeepEnabled(options) {
    if (!options || typeof options !== 'object') return false
    if (options.keepSectionsEnabled === true) return true
    if (options.keepSectionsEnabled === false) return false
    return Array.isArray(options.keepSections) && options.keepSections.length > 0
  }

  /**
   * 单个 section 是否保留。
   *
   * 优先级：Bard 必需 > tool 联动 > 用户手选。
   * 依赖模块常量 BARD_REQUIRED_SECTIONS / TOOL_SECTION_PREFIX。
   */
  function shouldKeepSection(name, options) {
    if (typeof name !== 'string' || name.length === 0) return false
    if (BARD_REQUIRED_SECTIONS.includes(name)) return true
    if (name.startsWith(TOOL_SECTION_PREFIX)) {
      if (options.enableTools === false) return false
      const allow = Array.isArray(options.toolAllowlist) ? options.toolAllowlist : []
      if (allow.length === 0) return true
      return allow.includes(name.slice(TOOL_SECTION_PREFIX.length))
    }
    const userKeep = Array.isArray(options.keepSections) ? options.keepSections : []
    return userKeep.includes(name)
  }

  /**
   * Per-agent system-prompt section whitelist.
   *
   * `system-prompt/assemble` is a *waterfall*: every listener wraps `next()`
   * and the assembly object is shared, so a listener edits `assembly.sections`
   * in place and then calls `next()`. Returning a value would be dropped by
   * the waterfall implementation, and skipping `next()` would veto the whole
   * chain — but leaving the list untouched is exactly what "no whitelist"
   * means, so every non-matching branch below still ends in `next()`.
   *
   * Mutually exclusive with `complete`: a preset that already takes over the
   * system prompt ignores `keepSections` entirely (cachedKeep stays null).
   *
   * Synchronous by contract — the waterfall does not await a listener, so an
   * `await` here would let the prompt be built from a half-filtered list.
   */
  function registerAgentPromptFilter(agent) {
    const presetsService = agent.ctx.get('agentPresets')
    if (!presetsService) return () => {}

    // Written once per agent: the first assembled prompt is the only one that
    // shows the complete, unfiltered section list. Later requests may already
    // be filtered by a whitelist, so re-collecting would shrink the catalog to
    // whatever that one preset kept.
    let captured = false
    // Preset identity (id + updatedAt) -> the parsed whitelist. Re-reading the
    // preset file on every request would make the prompt path do disk I/O.
    let cachedKey = null
    let cachedKeep = null

    const filter = (assembly, context, next) => {
      try {
        const composed = presetsService.composedPreset(agent.ctx)
        if (typeof composed !== 'string' || !composed.startsWith(PRESET_PREFIX)) {
          return next()
        }
        const presetId = composed.slice(PRESET_PREFIX.length)
        const bardPreset = getPreset(presetId)
        if (!bardPreset) return next()

        const key = `${presetId}\u0000${bardPreset.updatedAt || ''}`
        if (key !== cachedKey) {
          cachedKey = key
          const opts = bardPreset.options || {}
          if (opts.complete === true || !isKeepEnabled(opts)) {
            cachedKeep = null
          } else {
            cachedKeep = { options: opts }
          }
        }

        if (!captured) {
          captured = true
          try {
            const list = assembly.sections
              .filter((s) => typeof s.text === 'string' && s.text.length > 0)
              .map((s) => ({ name: s.name, chars: s.text.length }))
            if (list.length > 0) writeSectionCatalog(list)
          } catch (error) {
            /* 采集失败不影响请求 */
          }
        }

        if (cachedKeep !== null && Array.isArray(assembly.sections)) {
          assembly.sections = assembly.sections.filter((s) => shouldKeepSection(s.name, cachedKeep.options))
        }
      } catch (error) {
        runtime.errors.push(`prompt-filter for ${agent.id}: ${String((error && error.message) || error)}`)
      }
      return next()
    }

    try {
      return agent.ctx.effect(
        () => agent.ctx.on('system-prompt/assemble', filter),
        'bard.prompt-filter',
      )
    } catch (error) {
      runtime.errors.push(`prompt-filter register ${agent.id}: ${String((error && error.message) || error)}`)
      return () => {}
    }
  }

  /**
   * Capture the agent-scoped skill catalog to disk.
   *
   * The skill registry is layered: `list({ scope })` merges the global layer
   * with the viewing scope's chain, while `list({})` sees only the global
   * layer. Skills provided by plugins mounted under an agent preset (the
   * common case for `dsh-skill-filesystem` + a user root) live in a
   * non-global layer, so an unscoped read from the settings page cannot see
   * them. This collector runs on an agent's ctx — the only context that
   * carries a scope — and persists the result for the settings page.
   *
   * Fire-and-forget: a slow or failed collection must not block agent
   * creation. The catalog is a UI convenience, not a request dependency.
   * The write is guarded against empty results inside `writeSkillCatalog`,
   * so a transient provider failure cannot blank the page.
   */
  function captureSkillCatalog(agent) {
    const skills = agent.ctx.get('skills')
    if (!skills || typeof skills.list !== 'function') return
    const cwd = agent.session && agent.session.header ? agent.session.header.cwd : undefined
    Promise.resolve(skills.list({ scope: agent, cwd }))
      .then((list) => {
        if (!Array.isArray(list) || list.length === 0) return
        writeSkillCatalog(list.map(skillSummary))
      })
      .catch((error) => {
        runtime.errors.push(`skill-catalog for ${agent.id}: ${String((error && error.message) || error)}`)
      })
  }

  ctx.on('agent/created', ({ agent }) => {
    runtime.loreDisposers.set(agent.id, registerAgentLore(agent))
    runtime.toolListDisposers.set(agent.id, registerAgentToolList(agent))
    runtime.workspaceDisposers.set(agent.id, registerAgentWorkspace(agent))
    runtime.promptFilterDisposers.set(agent.id, registerAgentPromptFilter(agent))
    captureSkillCatalog(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    for (const [id, map] of [
      [agent.id, runtime.loreDisposers],
      [agent.id, runtime.toolListDisposers],
      [agent.id, runtime.workspaceDisposers],
    ]) {
      const dispose = map.get(id)
      map.delete(id)
      if (dispose) dispose()
    }
    runtime.promptFilterDisposers.get(agent.id)?.()
    runtime.promptFilterDisposers.delete(agent.id)
    // The cwd memory is keyed by agent id; a disposed agent never comes back.
    runtime.cwdByAgent.delete(agent.id)
  })
  ctx.effect(() => () => {
    for (const map of [runtime.loreDisposers, runtime.toolListDisposers, runtime.workspaceDisposers, runtime.promptFilterDisposers]) {
      for (const dispose of map.values()) {
        try {
          dispose()
        } catch (error) {
          /* ignore */
        }
      }
      map.clear()
    }
    runtime.cwdByAgent.clear()
  }, 'bard.scoped-disposers')

  // -- services ------------------------------------------------------------

  ctx.inject(['agentPresets'], (scoped) => {
    const presetsService = scoped.agentPresets

    /** The plugin rows a generated preset should mount. */
    async function baseRows() {
      let defaultId
      try {
        const current = await presetsService.resolve()
        defaultId = current && current.id
      } catch (error) {
        defaultId = undefined
      }
      const editor = ctx.get('configEditor')
      if (editor && typeof editor.configuration === 'function') {
        try {
          const rows = editor.configuration()
          const candidates = rows.filter((row) => row
            && row.entry
            && row.entry.options
            && row.entry.options.name === '@deepseek-ai/dsh-agent-preset'
            && row.inherited
            && Array.isArray(row.inherited.plugins))
          if (candidates.length > 0) {
            const chosen = candidates.find((row) => row.inherited.id === defaultId) || candidates[0]
            const plugins = structuredClone(chosen.inherited.plugins)
            const filtered = KEEP_ROW_IDS.length > 0
              ? plugins.filter((row) => row && KEEP_ROW_IDS.includes(row.id))
              : plugins
            return { source: `preset:${chosen.inherited.id}`, rows: filtered }
          }
        } catch (error) {
          runtime.errors.push(`读取默认预设失败，已改用内置工具清单：${String((error && error.message) || error)}`)
        }
      }
      return { source: 'builtin', rows: builtinToolRows() }
    }

    /** Resolve the chosen Harness skills into full definitions. */
    async function resolveSkills(names) {
      const skillsService = ctx.get('skills')
      if (!skillsService || !Array.isArray(names) || names.length === 0) return []
      const out = []
      for (const skillName of names) {
        try {
          const definition = await skillsService.get(skillName, {})
          if (definition) out.push(definition)
        } catch (error) {
          runtime.errors.push(`技能「${skillName}」读取失败：${String((error && error.message) || error)}`)
        }
      }
      return out
    }

    /** Build the agent-preset declaration for one Bard preset. */
    async function buildDefinition(bardPreset, index) {
      const rawCard = getCard(bardPreset.cardId)
      if (!rawCard) {
        throw new Error(`角色卡已不存在（${bardPreset.cardId}）`)
      }
      const userName = (bardPreset.options && bardPreset.options.userName) || DEFAULT_USER_NAME
      const userGender = (bardPreset.options && bardPreset.options.userGender) || ''
      const card = interpolateCard(rawCard, { userName })
      const skills = await resolveSkills(bardPreset.skillNames)
      const enableTools = !(bardPreset.options && bardPreset.options.enableTools === false)
      const personaPrefix = buildPersonaPrefix(card, skills, {
        styleHint: bardPreset.options && bardPreset.options.styleHint ? bardPreset.options.styleHint : DEFAULT_STYLE_HINT,
        extraInstructions: bardPreset.options && bardPreset.options.extraInstructions,
        outputLanguage: bardPreset.options && bardPreset.options.outputLanguage,
        userGender,
        enableTools,
        greetingIndex: Number.isInteger(bardPreset.options && bardPreset.options.greetingIndex)
          && bardPreset.options.greetingIndex >= 0
          ? bardPreset.options.greetingIndex
          : null,
      })
      const base = await baseRows()
      const rows = base.rows.map((row) => ({ ...row }))
      const personaConfig = {
        prefix: personaPrefix,
        complete: !!(bardPreset.options && bardPreset.options.complete),
        includeRuntimeContext: !(bardPreset.options && bardPreset.options.includeRuntimeContext === false),
      }
      const at = rows.findIndex((row) => row && row.name === '@deepseek-ai/dsh-persona')
      if (at >= 0) {
        rows[at] = { ...rows[at], disabled: false, config: { ...(rows[at].config || {}), ...personaConfig } }
      } else {
        rows.unshift({ id: 'persona', name: '@deepseek-ai/dsh-persona', config: personaConfig })
      }
      return {
        id: `${PRESET_PREFIX}${bardPreset.id}`,
        name: `吟游 · ${bardPreset.name}`,
        description: describeCard(card, bardPreset.name),
        order: PRESET_ORDER_BASE + index,
        plugins: rows,
        __base: base.source,
      }
    }

    async function syncPresets() {
      const run = async () => {
        for (const dispose of runtime.presetDisposers.splice(0)) {
          try {
            await dispose()
          } catch (error) {
            /* the declaration is already gone */
          }
        }
        runtime.errors = []
        const bardPresets = listPresets()
        for (let index = 0; index < bardPresets.length; index++) {
          const bardPreset = bardPresets[index]
          let definition
          try {
            definition = await buildDefinition(bardPreset, index)
          } catch (error) {
            const reason = String((error && error.message) || error)
            bardPreset.lastBase = ''
            bardPreset.lastError = reason
            try {
              putPreset(bardPreset)
            } catch (writeError) {
              /* the record is unwritable; the runtime error below still reports it */
            }
            runtime.errors.push(`预设「${bardPreset.name}」无法生成：${reason}`)
            continue
          }
          const { __base, ...declaration } = definition
          bardPreset.lastBase = __base
          // Best-effort snapshot: a failed write must not abort preset sync.
          try {
            const snapshot = interpolateCard(getCard(bardPreset.cardId), {
              userName: (bardPreset.options && bardPreset.options.userName) || DEFAULT_USER_NAME,
            })
            if (snapshot) putRenderedCard(bardPreset.id, snapshot)
          } catch (error) {
            /* the snapshot is a convenience, never a requirement */
          }
          try {
            const dispose = await presetsService.register(declaration)
            runtime.presetDisposers.push(dispose)
            bardPreset.lastError = ''
          } catch (error) {
            bardPreset.lastError = String((error && error.message) || error)
            runtime.errors.push(`DSH 预设 ${declaration.id} 注册失败：${bardPreset.lastError}`)
          }
          // Persist the diagnostics: the settings page reads presets back from
          // disk, so in-memory-only fields would never reach it.
          try {
            putPreset(bardPreset)
          } catch (error) {
            /* a failed diagnostic write must not abort the remaining presets */
          }
        }
      }
      runtime.syncing = runtime.syncing.then(run, run)
      return runtime.syncing
    }

    runtime.syncPresets = syncPresets
    ctx.effect(() => () => {
      for (const dispose of runtime.presetDisposers.splice(0)) {
        try {
          dispose()
        } catch (error) {
          /* ignore */
        }
      }
    }, 'bard.preset-disposers')

    syncPresets().catch((error) => {
      runtime.errors.push(`预设同步失败：${String((error && error.message) || error)}`)
    })
  })

  // -- HTTP API ------------------------------------------------------------

  registerRoutes(ctx, runtime)

  // -- /bard command -----------------------------------------------------

  ctx.inject(['commands'], (scoped) => {
    scoped.commands.register({
      name: 'bard',
      description: 'Bard 角色扮演：查看当前角色、列出预设、输出角色卡开场白',
      input: { hint: '[list|greet <n>|card|presets]' },
      handler: (invocation) => runBardCommand(ctx, runtime, invocation),
    })
  })
}

// ---------------------------------------------------------------------------
// default toolset (used only when the profile's own default preset is unreadable)
// ---------------------------------------------------------------------------

function builtinToolRows() {
  const isWindows = process.platform === 'win32'
  return [
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search' },
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: isWindows },
    { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: !isWindows },
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo' },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' },
    { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
    { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
    { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
  ]
}

// ---------------------------------------------------------------------------
// world-book activation
// ---------------------------------------------------------------------------

/** Render the lore a Bard preset's books activate for one session right now. */
function loreTextFor(runtime, bardPresetId, sessionId) {
  try {
    const bardPreset = getPreset(bardPresetId)
    if (!bardPreset) return ''
    const ids = Array.isArray(bardPreset.worldbookIds) ? bardPreset.worldbookIds : []
    if (ids.length === 0) return ''
    const books = ids.map((id) => getWorldBook(id)).filter(Boolean)
    if (books.length === 0) return ''
    const transcript = (runtime.recent.get(sessionId) || []).join('\n').slice(-8000)
    const options = bardPreset.options || {}
    const selected = selectLore(books, transcript, {
      maxEntries: Number.isFinite(options.maxEntries) ? options.maxEntries : 12,
      maxChars: Number.isFinite(options.maxChars) ? options.maxChars : 6000,
    })
    // 世界书条目走 systemPrompt.context()，与 persona 前缀是两条独立通路，
    // 不经过 interpolateCard。含 {{char}} / {{user}} 的条目必须在进入
    // prompt 前替换掉，否则 DSH 的严格插值器会抛
    //   unknown prompt variable "{{char}}" in context "bard:world-book"
    // 并让整轮请求失败。
    const rawCard = getCard(bardPreset.cardId)
    const charName = rawCard && typeof rawCard.name === 'string' ? rawCard.name : ''
    const userName = typeof options.userName === 'string' && options.userName.trim().length > 0
      ? options.userName.trim()
      : DEFAULT_USER_NAME
    const replaced = selected.map((item) => ({
      ...item,
      entry: {
        ...item.entry,
        comment: interpolateText(item.entry.comment, { charName, userName }),
        content: interpolateText(item.entry.content, { charName, userName }),
      },
    }))
    return renderLore(replaced)
  } catch (error) {
    return ''
  }
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

function registerRoutes(ctx, runtime) {
  /** Reject anything that is not a same-origin request from this machine. */
  function denied(req, res) {
    try {
      const headers = req.headers || {}
      const host = String(headers.host || '')
      const hostname = host.replace(/:\d+$/u, '').toLowerCase().replace(/^\[|\]$/gu, '')
      const loopback = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1'
        || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(hostname)
      if (!loopback) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('bard: non-loopback Host')
        return true
      }
      const origin = headers.origin
      if (typeof origin === 'string' && origin.length > 0 && origin !== 'null') {
        let originHost
        try {
          originHost = new URL(origin).host.toLowerCase()
        } catch (error) {
          originHost = undefined
        }
        if (!originHost || originHost !== host.toLowerCase()) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('bard: cross-origin request')
          return true
        }
      }
      return false
    } catch (error) {
      try {
        res.writeHead(403)
        res.end()
      } catch (inner) {
        /* the socket is already gone */
      }
      return true
    }
  }

  /** Wrap a JSON endpoint with the fence and uniform error reporting. */
  function route(kind, path, handler) {
    return ctx.webServer.register({
      kind,
      path,
      handler: async (req, res) => {
        if (denied(req, res)) return
        try {
          await handler(req, res)
        } catch (error) {
          json(res, 400, { ok: false, error: String((error && error.message) || error) })
        }
      },
    })
  }

  const disposers = []
  const add = (kind, path, handler) => disposers.push(route(kind, path, handler))
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        /* ignore */
      }
    }
  }, 'bard.routes')

  function skillsService() {
    return ctx.get('skills')
  }

  // Cached so a slow or hung skills service cannot stall every API call:
  // snapshot() runs on every endpoint, and each run used to await list().
  let skillsCache = null

  async function presentSkills() {
    const now = Date.now()
    if (skillsCache && now - skillsCache.at < 30000) return skillsCache.list

    // Primary: the file the agent-side collector wrote. Its contents come
    // from an agent-scoped `list()`, so they include skills provided by
    // plugins mounted under an agent preset — the layer `list({})` cannot
    // reach from this stateless HTTP handler.
    const fromFile = readSkillCatalog()
    if (fromFile.length > 0) {
      skillsCache = { list: fromFile, at: now }
      return fromFile
    }

    // Fallback: a direct unscoped read. Reaches only the global layer, but
    // it is the only source before the first Bard session has run (the
    // collector fires on `agent/created`).
    const service = skillsService()
    if (!service) return []
    try {
      const list = await Promise.race([
        service.list({}),
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('skills.list 超时')), 3000)
          if (timer.unref) timer.unref()
        }),
      ])
      const mapped = list.map(skillSummary)
      if (mapped.length > 0) {
        skillsCache = { list: mapped, at: now }
        return mapped
      }
      return []
    } catch (error) {
      runtime.errors.push(`技能目录读取失败：${String((error && error.message) || error)}`)
      return skillsCache ? skillsCache.list : []
    }
  }

  async function snapshot() {
    const cards = listCards()
    const worldbooks = listWorldBooks()
    const presets = listPresets()
    return {
      ok: true,
      home: 'bard',
      defaults: {
        styleHint: DEFAULT_STYLE_HINT,
        workspacePrefix: DEFAULT_WORKSPACE_PREFIX,
      },
      // Read the file, not a memory cache: the collector rewrites it on every
      // Bard request, and the settings page must see the newest content even
      // if this Host process has not served a Bard request since it started.
      availableTools: readToolCatalog(),
      availableSections: readSectionCatalog(),
      bardRequiredSections: BARD_REQUIRED_SECTIONS.slice(),
      toolSectionPrefix: TOOL_SECTION_PREFIX,
      cards: cards.map(cardSummary),
      worldbooks: worldbooks.map(worldBookSummary),
      presets: presets.map((preset) => ({
        id: preset.id,
        name: preset.name,
        description: preset.description || '',
        cardId: preset.cardId,
        cardName: (getCard(preset.cardId) || {}).name || '(已删除)',
        worldbookIds: preset.worldbookIds || [],
        skillNames: preset.skillNames || [],
        options: preset.options || {},
        createdAt: preset.createdAt,
        updatedAt: preset.updatedAt,
        dshPresetId: `${PRESET_PREFIX}${preset.id}`,
        base: preset.lastBase || '',
        error: preset.lastError || '',
      })),
      skills: await presentSkills(),
      errors: runtime.errors.slice(0, 20),
    }
  }

  /**
   * Lazy sweep: delete workspaces whose session no longer exists.
   *
   * Called fire-and-forget from `/state`, so it runs when the settings page
   * opens and costs no model tokens. It is the *only* cleanup path -- the
   * plugin does not hook `session/disposed`, because DSH fires that on
   * Harness restart and agent teardown too, which would make a live
   * session's workspace look orphaned.
   *
   * Deliberately conservative:
   *
   *   - `sessionPersistence.list()` is the authority on "session still
   *     exists". Items are `SessionHeader` wrappers, so the id is
   *     `item.header.id`, not `item.id`.
   *   - A record younger than `WORKSPACE_GRACE_MS` is skipped. A session with
   *     zero events is not materialised and so does not appear in `list()`;
   *     the grace period keeps its workspace alive until the first event.
   *   - Before `rmSync`, the directory must still contain a `.bard-session`
   *     marker whose `sessionId` matches the record. A workspace that fails
   *     this check is left alone; only its bookkeeping record is dropped.
   *
   * On failure the record is kept so the next sweep can retry. The directory
   * is the expensive artifact; the record is the cheap one.
   */
  async function cleanupOrphanedWorkspaces() {
    const sessionPersistence = ctx.get('sessionPersistence')
    if (!sessionPersistence || typeof sessionPersistence.list !== 'function') return
    let list
    try {
      list = await sessionPersistence.list()
    } catch (error) {
      return
    }
    if (!Array.isArray(list)) return
    const liveIds = new Set()
    for (const item of list) {
      const id = item && item.header && item.header.id
      if (typeof id === 'string' && id.length > 0) liveIds.add(id)
    }
    const now = Date.now()
    for (const record of listWorkspaceRecords()) {
      if (!record || typeof record.sessionId !== 'string' || record.sessionId.length === 0) continue
      if (liveIds.has(record.sessionId)) continue
      const created = Date.parse(record.createdAt || '')
      if (Number.isFinite(created) && now - created < WORKSPACE_GRACE_MS) continue
      let absPath = ''
      try {
        absPath = path.join(record.cwd, ...String(record.relPath || '').split('/'))
      } catch (error) {
        absPath = ''
      }
      let safe = false
      if (absPath.length > 0) {
        try {
          const raw = fs.readFileSync(path.join(absPath, '.bard-session'), 'utf8')
          const parsed = JSON.parse(raw)
          // 非空字符串检查不能省：老记录和老 marker 都没有 token 字段，
          // 若只写 parsed.token === record.token，两边都是 undefined，
          // 校验会「通过」然后误删。加上检查后，老目录一律 safe = false，
          // 目录保留、record 丢弃。
          if (parsed && typeof parsed.token === 'string' && parsed.token.length > 0
              && parsed.token === record.token) safe = true
        } catch (error) {
          safe = false
        }
      }
      if (safe) {
        try {
          fs.rmSync(absPath, { recursive: true, force: true })
        } catch (error) {
          // Could not remove the directory; keep the record for a later pass.
          continue
        }
      }
      try {
        deleteWorkspaceRecord(record.id)
      } catch (error) {
        /* a failed delete just means the sweep retries next time */
      }
    }
  }

  add('exact', '/dsh-bard/api/state', async (req, res) => {
    cleanupOrphanedWorkspaces().catch(() => {})
    json(res, 200, await snapshot())
  })

  add('exact', '/dsh-bard/api/card', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const bytes = bytesFromPayload(payload)
    const fileName = typeof payload.fileName === 'string' ? payload.fileName : ''
    const read = readCardDocument(bytes, fileName)
    const id = makeId(payload.name || fileName || 'card')
    const card = normalizeCard(read.raw, {
      id,
      name: typeof payload.name === 'string' && payload.name.trim().length > 0
        ? payload.name.trim()
        : fileName.replace(/\.[a-z0-9]+$/iu, ''),
      container: read.container,
      source: read.keyword ? `png:${read.keyword}` : 'json',
      importedAt: new Date().toISOString(),
    })
    let portrait = ''
    if (isPng(bytes)) {
      try {
        portrait = putPortrait(id, bytes)
      } catch (error) {
        runtime.errors.push(`头像保存失败：${String((error && error.message) || error)}`)
      }
    }
    card.portrait = portrait
    putCard(card)
    return json(res, 200, { ok: true, card: cardSummary(card), hasCharacterBook: card.characterBook !== null })
  })

  add('exact', '/dsh-bard/api/card/delete', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    if (typeof payload.id !== 'string') return json(res, 400, { ok: false, error: '缺少 id' })
    const used = listPresets().filter((preset) => preset.cardId === payload.id).map((preset) => preset.name)
    if (used.length > 0 && payload.force !== true) {
      return json(res, 200, { ok: false, error: `该角色卡仍被预设使用：${used.join('、')}`, inUse: used })
    }
    const removed = deleteCard(payload.id)
    if (removed) {
      runtime.syncPresets?.().catch((error) => {
        runtime.errors.push(`删除角色卡后的同步失败：${String((error && error.message) || error)}`)
      })
    }
    return json(res, 200, { ok: removed, ...(await snapshot()) })
  })

  add('exact', '/dsh-bard/api/card/book', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const card = getCard(payload.id)
    if (!card) return json(res, 404, { ok: false, error: '找不到角色卡' })
    if (!card.characterBook) return json(res, 200, { ok: false, error: '这张角色卡没有内嵌世界书' })
    const id = makeId(`${card.name}-book`)
    const book = worldBookFromCharacterBook(card.characterBook, { id, name: `${card.name} 世界观` })
    putWorldBook(book)
    return json(res, 200, { ok: true, book: worldBookSummary(book), ...(await snapshot()) })
  })

  add('exact', '/dsh-bard/api/card/detail', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const card = getCard(payload.id)
    if (!card) return json(res, 404, { ok: false, error: '找不到角色卡' })
    return json(res, 200, { ok: true, card })
  })

  add('exact', '/dsh-bard/api/card/update', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const card = getCard(payload.id)
    if (!card) return json(res, 404, { ok: false, error: '找不到角色卡' })
    const patch = payload.patch && typeof payload.patch === 'object' ? payload.patch : {}
    const next = updateCardEditable(card, patch)
    putCard(next)
    // The card's rendered persona feeds every preset that references it, so a
    // rename or a description edit must propagate through preset resync —
    // otherwise the running DSH agent preset keeps the old prefix.
    await runtime.syncPresets?.()
    return json(res, 200, { ok: true, card: cardSummary(next), ...(await snapshot()) })
  })

  add('exact', '/dsh-bard/api/worldbook', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const bytes = bytesFromPayload(payload)
    const fileName = typeof payload.fileName === 'string' ? payload.fileName : ''
    const parsed = readWorldBookDocument(bytes, fileName)
    const id = makeId(payload.name || parsed.name || 'book')
    const book = { ...parsed, id, name: (typeof payload.name === 'string' && payload.name.trim()) || parsed.name, importedAt: new Date().toISOString() }
    putWorldBook(book)
    return json(res, 200, { ok: true, book: worldBookSummary(book) })
  })

  add('exact', '/dsh-bard/api/worldbook/detail', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const book = getWorldBook(payload.id)
    if (!book) return json(res, 404, { ok: false, error: '找不到世界书' })
    return json(res, 200, { ok: true, book })
  })

  add('exact', '/dsh-bard/api/worldbook/delete', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    if (typeof payload.id !== 'string') return json(res, 400, { ok: false, error: '缺少 id' })
    const removed = deleteWorldBook(payload.id)
    if (removed) {
      runtime.syncPresets?.().catch((error) => {
        runtime.errors.push(`删除世界书后的同步失败：${String((error && error.message) || error)}`)
      })
    }
    return json(res, 200, { ok: removed, ...(await snapshot()) })
  })

  add('exact', '/dsh-bard/api/preset', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    if (typeof payload.cardId !== 'string' || !getCard(payload.cardId)) {
      return json(res, 400, { ok: false, error: '请先选择一个角色卡' })
    }
    const name = typeof payload.name === 'string' && payload.name.trim().length > 0
      ? payload.name.trim()
      : (getCard(payload.cardId) || {}).name || '未命名'
    const existing = typeof payload.id === 'string' ? getPreset(payload.id) : undefined
    const now = new Date().toISOString()
    const preset = {
      id: existing ? existing.id : makeId(name),
      name,
      description: typeof payload.description === 'string' ? payload.description : '',
      cardId: payload.cardId,
      worldbookIds: Array.isArray(payload.worldbookIds) ? payload.worldbookIds.filter((id) => typeof id === 'string') : [],
      skillNames: Array.isArray(payload.skillNames) ? payload.skillNames.filter((id) => typeof id === 'string') : [],
      options: {
        styleHint: typeof payload.styleHint === 'string' ? payload.styleHint : DEFAULT_STYLE_HINT,
        extraInstructions: typeof payload.extraInstructions === 'string' ? payload.extraInstructions : '',
        complete: payload.complete === true,
        includeRuntimeContext: payload.includeRuntimeContext !== false,
        enableTools: payload.enableTools !== false,
        toolAllowlist: Array.isArray(payload.toolAllowlist)
          ? payload.toolAllowlist.filter((name) => typeof name === 'string' && name.length > 0)
          : [],
        keepSections: Array.isArray(payload.keepSections)
          ? payload.keepSections.filter((n) => typeof n === 'string' && n.length > 0)
          : [],
        keepSectionsEnabled: payload.keepSectionsEnabled === true,
        greetingIndex: Number.isInteger(payload.greetingIndex) && payload.greetingIndex >= 0
          ? payload.greetingIndex
          : null,
        workspaceEnabled: payload.workspaceEnabled !== false,
        workspacePrefix: typeof payload.workspacePrefix === 'string' && payload.workspacePrefix.trim().length > 0
          ? payload.workspacePrefix.trim()
          : DEFAULT_WORKSPACE_PREFIX,
        userName: typeof payload.userName === 'string' ? payload.userName.trim() : '',
        userGender: typeof payload.userGender === 'string' ? payload.userGender.trim() : '',
        outputLanguage: typeof payload.outputLanguage === 'string' ? payload.outputLanguage.trim() : '',
        maxEntries: Number.isFinite(payload.maxEntries) ? payload.maxEntries : 12,
        maxChars: Number.isFinite(payload.maxChars) ? payload.maxChars : 6000,
      },
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    }
    putPreset(preset)
    await runtime.syncPresets?.()
    const after = getPreset(preset.id)
    return json(res, 200, { ok: true, presetId: preset.id, dshPresetId: `${PRESET_PREFIX}${preset.id}`, error: (after && after.lastError) || '', ...(await snapshot()) })
  })

  add('exact', '/dsh-bard/api/preset/delete', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    if (typeof payload.id !== 'string') return json(res, 400, { ok: false, error: '缺少 id' })
    const removed = deletePreset(payload.id)
    if (removed) {
      try {
        deleteRenderedCard(payload.id)
      } catch (error) {
        /* the snapshot is already gone */
      }
      // The record is already gone from disk; making the request wait on a
      // preset resync only lets a stuck sync latch the caller's UI. Report a
      // failed resync instead of blocking the response on it.
      runtime.syncPresets?.().catch((error) => {
        runtime.errors.push(`删除预设后的同步失败：${String((error && error.message) || error)}`)
      })
    }
    return json(res, 200, { ok: removed, ...(await snapshot()) })
  })

  add('exact', '/dsh-bard/api/preset/preview', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    const rawCard = getCard(payload.cardId)
    if (!rawCard) return json(res, 404, { ok: false, error: '找不到角色卡' })
    const userName = typeof payload.userName === 'string' && payload.userName.trim().length > 0
      ? payload.userName.trim()
      : DEFAULT_USER_NAME
    const card = interpolateCard(rawCard, { userName })
    const prefix = buildPersonaPrefix(card, [], {
      styleHint: typeof payload.styleHint === 'string' ? payload.styleHint : DEFAULT_STYLE_HINT,
      extraInstructions: typeof payload.extraInstructions === 'string' ? payload.extraInstructions : '',
      outputLanguage: typeof payload.outputLanguage === 'string' ? payload.outputLanguage.trim() : '',
      userGender: typeof payload.userGender === 'string' ? payload.userGender.trim() : '',
      greetingIndex: Number.isInteger(payload.greetingIndex) && payload.greetingIndex >= 0
        ? payload.greetingIndex
        : null,
    })
    const cardLanguage = detectCardLanguage(rawCard)
    // Rough token estimate. The plugin carries no tokenizer, so this is an
    // order-of-magnitude hint, not a billing figure. CJK runs about 1 token
    // per 1.5-2 characters; Latin about 1 per 4.
    const divisor = cardLanguage === '中文' || cardLanguage === '日文' || cardLanguage === '韩文' ? 1.6 : 3.8
    const tokenEstimate = Math.round(prefix.length / divisor)
    // Section breakdown: split on top-level `## ` headers. The first chunk
    // (before any header) is the identity statement — label it explicitly
    // instead of letting it masquerade as a section.
    const parts = prefix.split(/^## /mu)
    const sections = []
    if (parts.length > 0 && parts[0].trim().length > 0) {
      sections.push({ name: '身份声明', chars: parts[0].trim().length })
    }
    for (let i = 1; i < parts.length; i += 1) {
      const chunk = parts[i]
      const text = chunk.trim()
      if (text.length === 0) continue
      const newline = text.indexOf('\n')
      const name = newline >= 0 ? text.slice(0, newline).trim() : text
      if (name.length === 0) continue
      // Add back the `## ` prefix the split consumed so the character totals
      // add up to the full prefix length.
      sections.push({ name, chars: chunk.length + 3 })
    }
    const warnings = []
    const usesUserMacro = /\{\{user\}\}/iu.test(rawCard.description || '')
      || /\{\{user\}\}/iu.test(rawCard.scenario || '')
      || /\{\{user\}\}/iu.test(rawCard.personality || '')
    if (usesUserMacro && userName === DEFAULT_USER_NAME) {
      warnings.push('这张卡使用了 {{user}}，但预设里没有设置「你的名字」。建议填写，否则替换值会是字面量 "User"。')
    }
    if (isRedundantField(rawCard.description, rawCard.scenario)) {
      warnings.push('「场景」与「角色简介」高度重复，persona 前缀已自动跳过「场景」section。')
    }
    if (tokenEstimate > 2500) {
      warnings.push(`persona 前缀约 ${tokenEstimate} token，比较长。可考虑精简卡片内容，或在角色卡编辑页拆分字段。`)
    }
    return json(res, 200, {
      ok: true,
      prefix,
      sections,
      chars: prefix.length,
      tokenEstimate,
      cardLanguage,
      warnings,
    })
  })

  add('exact', '/dsh-bard/api/greeting', async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
    const payload = await readJsonBody(req)
    let card = null
    if (typeof payload.cardId === 'string') card = getCard(payload.cardId)
    if (!card && typeof payload.presetId === 'string') {
      const preset = getPreset(payload.presetId)
      if (preset) card = getCard(preset.cardId)
    }
    if (!card) return json(res, 404, { ok: false, error: '找不到角色卡' })
    const greetings = cardGreetings(card)
    const index = Number.isInteger(payload.index) ? payload.index : 0
    const chosen = greetings[index] || greetings[0]
    if (!chosen) return json(res, 200, { ok: false, error: '这张角色卡没有开场白', greetings: [] })
    return json(res, 200, { ok: true, label: chosen.label, text: chosen.text, greetings })
  })

  add('prefix', '/dsh-bard/api/portrait', async (req, res) => {
    const id = new URL(req.url, 'http://x').pathname.split('/').pop()
    const file = portraitPath(id)
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('no portrait')
    }
    const bytes = fs.readFileSync(file)
    const ext = file.split('.').pop().toLowerCase()
    const type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': String(bytes.length) })
    res.end(bytes)
  })
}

// ---------------------------------------------------------------------------
// /bard command
// ---------------------------------------------------------------------------

async function runBardCommand(ctx, runtime, invocation) {
  const raw = String(invocation.rawInput || '').trim()
  const [head] = raw.split(/\s+/u)
  const verb = (head || '').toLowerCase()

  const agentPresets = ctx.get('agentPresets')
  let composed
  try {
    composed = agentPresets && invocation.agent ? agentPresets.composedPreset(invocation.agent.ctx) : undefined
  } catch (error) {
    composed = undefined
  }
  const activeId = typeof composed === 'string' && composed.startsWith(PRESET_PREFIX) ? composed.slice(PRESET_PREFIX.length) : ''
  const active = activeId ? getPreset(activeId) : undefined

  if (verb === 'list' || verb === 'presets' || verb === '') {
    const presets = listPresets()
    const lines = ['Bard 预设：']
    if (presets.length === 0) lines.push('（还没有预设。请在 设置 → 吟游 里导入角色卡并保存预设）')
    for (const preset of presets) {
      const card = getCard(preset.cardId)
      const marks = [preset.id === activeId ? '← 当前会话' : '', `${(preset.worldbookIds || []).length} 本世界书`, `${(preset.skillNames || []).length} 个技能`]
        .filter(Boolean).join('，')
      lines.push(`· ${preset.name} — ${card ? card.name : '(角色卡已删除)'}（${marks}）`)
    }
    lines.push('', '用法：/bard greet [序号] 输出开场白；/bard card 查看当前角色。')
    return { kind: 'success', text: lines.join('\n') }
  }

  if (verb === 'card') {
    if (!active) return { kind: 'error', text: '当前会话没有使用 Bard 预设。请在会话的预设选择器里选择「吟游 · …」。' }
    const card = getCard(active.cardId)
    if (!card) return { kind: 'error', text: '这个预设引用的角色卡已被删除。' }
    return {
      kind: 'success',
      text: [
        `角色：${card.name}`,
        card.creator ? `作者：${card.creator}` : '',
        card.tags.length ? `标签：${card.tags.join('、')}` : '',
        card.description ? `\n简介：\n${card.description}` : '',
        `\n世界书：${(active.worldbookIds || []).length} 本 · 技能：${(active.skillNames || []).length} 个 · 开场白：${cardGreetings(card).length} 条`,
      ].filter(Boolean).join('\n'),
    }
  }

  if (verb === 'greet') {
    const target = active || listPresets()[0]
    if (!target) return { kind: 'error', text: '还没有 Bard 预设，无法输出开场白。' }
    const card = getCard(target.cardId)
    if (!card) return { kind: 'error', text: '这个预设引用的角色卡已被删除。' }
    const greetings = cardGreetings(card)
    if (greetings.length === 0) return { kind: 'error', text: `「${card.name}」这张角色卡没有开场白。` }

    const rest = raw.slice(head.length).trim()
    let index
    if (rest.length === 0) {
      // 无参数：使用当前预设选中的那条。未选中时给明确提示，而不是
      // 静默回退到 index 0 —— 用户已经表达过"不注入"，默认输出主开场白
      // 会与预设设置矛盾。
      const selected = target.options
        && Number.isInteger(target.options.greetingIndex)
        && target.options.greetingIndex >= 0
        ? target.options.greetingIndex
        : null
      if (selected === null) {
        return {
          kind: 'error',
          text: '当前预设未选定开场白。用 /bard greet <序号> 指定，或在预设编辑页选一条。',
        }
      }
      index = selected
    } else if (/^\d+$/u.test(rest)) {
      index = Number(rest)
    } else {
      return { kind: 'error', text: `未知参数「${rest}」。用法：/bard greet [序号]` }
    }
    const chosen = greetings[index]
    if (!chosen) return { kind: 'error', text: `序号 ${index} 超出范围（共 ${greetings.length} 条）。` }
    return {
      kind: 'success',
      text: [`【${card.name} · ${chosen.label}】`, '', chosen.text].join('\n'),
    }
  }

  return { kind: 'error', text: `未知参数「${verb}」。用法：/bard [list|card|greet <序号>]` }
}
