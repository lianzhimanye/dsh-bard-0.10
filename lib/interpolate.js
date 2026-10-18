/**
 * SillyTavern variable interpolation for Bard character cards.
 *
 * Character cards written for SillyTavern are full of `{{macro}}` placeholders.
 * DSH's prompt interpolator is strict: any `{{name}}` it does not recognise
 * aborts preset assembly with
 *   unknown prompt variable "{{char}}" in section "deployment:persona-prefix".
 *
 * This module rewrites card text before it reaches the persona prefix:
 *
 *   {{char}}      -> the card's own name
 *   {{user}}      -> the preset's "your name" (defaults to "User")
 *   {{original}}  -> removed (a SillyTavern meta-macro with no DSH meaning)
 *   {{provider}} / {{model}} / {{cwd}}  -> left untouched; DSH owns these
 *   anything else -> braces swapped for [[...]] so the text stays readable and
 *                    keeps acting as prompt content instead of aborting
 *   single {X}    -> same rules, rewritten to [X]
 *
 * Replacement is text-only: no field is added, removed or reordered, so a card
 * that renders cleanly is still a valid card.
 */

/** Variables DSH itself registers. Never rewrite these. */
const DSH_VARIABLES = new Set(['provider', 'model', 'cwd'])

/** SillyTavern macros that carry no meaning in DSH; drop the token. */
const DROPPED_MACROS = new Set(['original'])

/** The name {{user}} falls back to when a preset has not set one. */
export const DEFAULT_USER_NAME = 'User'

/**
 * Rewrite one card string.
 * @param text - the raw field value.
 * @param charName - what {{char}} resolves to.
 * @param userName - what {{user}} resolves to.
 */
function rewriteText(text, charName, userName) {
  if (typeof text !== 'string' || text.length === 0) return text
  return text
    .replace(/\{\{([^{}]*)\}\}/gu, (match, inner) => resolve(inner, charName, userName, match, false))
    .replace(/\{([^{}]*)\}/gu, (match, inner) => resolve(inner, charName, userName, match, true))
}

/** Resolve one macro body. `original` is the untouched match. */
function resolve(inner, charName, userName, original, single) {
  const name = inner.trim()
  const lower = name.toLowerCase()
  if (lower === 'char') return charName
  if (lower === 'user') return userName
  if (DSH_VARIABLES.has(lower)) return original
  if (DROPPED_MACROS.has(lower)) return ''
  // Unknown macro: keep the text, lose the braces. [[...]] reads as emphasis
  // and never triggers DSH's strict variable scanner.
  return single ? `[${name}]` : `[[${name}]]`
}

/**
 * Drop a comma left dangling at the start of a line by a removed macro.
 * `"{{original}},[Use ...]"` becomes `"[Use ...]"`, not `",[Use ...]"`.
 *
 * Limitation: only a comma at the very start of the string is cleaned. A
 * `{{original}}` in mid-string would leave `" ,"` behind. SillyTavern's own
 * convention puts it at the start, so this is intentional and sufficient.
 */
function tidy(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  return text.replace(/^\s*,\s*/u, '')
}

/**
 * 对任意一段文本做宏替换。
 *
 * 与 `interpolateCard` 用同一套规则（{{char}}→卡名、{{user}}→用户名、
 * DSH 变量保留、未知宏降级为 [[...]]），但作用于单个字符串而不是卡片
 * 字段。世界书条目是主要调用方——它走的是 `systemPrompt.context()` 的
 * 通路，与 persona 前缀完全独立，不经过 `interpolateCard`。
 *
 * 如果这里漏掉，含 `{{char}}` 的世界书条目会在 DSH 组装 prompt 时直接
 * 抛 `unknown prompt variable "{{char}}"`，整轮请求失败。
 */
export function interpolateText(text, options = {}) {
  const charName = typeof options.charName === 'string' ? options.charName : ''
  const userName = typeof options.userName === 'string' && options.userName.trim().length > 0
    ? options.userName.trim()
    : DEFAULT_USER_NAME
  return tidy(rewriteText(text, charName, userName))
}

/** Apply the rewrite to every field a persona prefix or greeting can show. */
export function interpolateCard(card, options = {}) {
  if (!card || typeof card !== 'object') return card
  const charName = typeof card.name === 'string' ? card.name : ''
  const userName = typeof options.userName === 'string' && options.userName.trim().length > 0
    ? options.userName.trim()
    : DEFAULT_USER_NAME
  const one = (value) => interpolateText(value, { charName, userName })
  const many = (list) => (Array.isArray(list) ? list.map(one) : list)
  return {
    ...card,
    description: one(card.description),
    personality: one(card.personality),
    scenario: one(card.scenario),
    firstMes: one(card.firstMes),
    alternateGreetings: many(card.alternateGreetings),
    mesExample: one(card.mesExample),
    systemPrompt: one(card.systemPrompt),
    postHistoryInstructions: one(card.postHistoryInstructions),
    depthPrompt: one(card.depthPrompt),
  }
}
