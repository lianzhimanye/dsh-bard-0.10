/**
 * dsh-bard — Web settings page.
 */

window.__ModuleLoader__.load({
  id: 'dsh-bard',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const API = '/dsh-bard/api'

    async function call(path, body) {
      const init = body === undefined
        ? { headers: { Accept: 'application/json' } }
        : { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15000)
      try {
        let response
        try {
          response = await fetch(`${API}${path}`, { ...init, signal: controller.signal })
        } catch (error) {
          throw new Error(`无法连接插件服务：${String((error && error.message) || error)}`)
        }
        let data = {}
        try { data = await response.json() } catch (error) { data = {} }
        if (!response.ok || data.ok === false) throw new Error(data.error || `请求失败 (HTTP ${response.status})`)
        return data
      } finally {
        clearTimeout(timer)
      }
    }

    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(new Error('读取文件失败'))
        reader.readAsDataURL(file)
      })
    }

    // -----------------------------------------------------------------------
    // PNG Tools (纯前端注入与解析)
    // -----------------------------------------------------------------------
    
    function injectTextChunk(pngBuffer, keyword, text) {
      const data = new Uint8Array(pngBuffer)
      const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      for (let i = 0; i < 8; i++) {
        if (data[i] !== signature[i]) throw new Error('不是有效的 PNG 文件')
      }

      const keywordBytes = new TextEncoder().encode(keyword)
      const textBytes = new TextEncoder().encode(text)
      const chunkData = new Uint8Array(keywordBytes.length + 1 + textBytes.length)
      chunkData.set(keywordBytes, 0)
      chunkData[keywordBytes.length] = 0
      chunkData.set(textBytes, keywordBytes.length + 1)

      const length = chunkData.length
      const chunk = new Uint8Array(12 + length)
      const view = new DataView(chunk.buffer)
      view.setUint32(0, length)
      chunk[4] = 116; chunk[5] = 69; chunk[6] = 88; chunk[7] = 116
      chunk.set(chunkData, 8)
      
      let crc = 0xffffffff
      for (let i = 4; i < 8 + length; i++) {
        crc ^= chunk[i]
        for (let j = 0; j < 8; j++) {
          crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
        }
      }
      view.setUint32(8 + length, (crc ^ 0xffffffff) >>> 0)

      const newPng = new Uint8Array(data.length + chunk.length)
      newPng.set(data.slice(0, 33), 0)
      newPng.set(chunk, 33)
      newPng.set(data.slice(33), 33 + chunk.length)
      return newPng
    }

    function downloadBlob(blob, filename) {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    }

    function exportToPNG(imageBase64, cardData, filename) {
      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '')
      const binaryString = atob(base64Data)
      const bytes = new Uint8Array(binaryString.length)
      for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i)
      
      const cardV2 = {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: cardData
      }
      const jsonStr = JSON.stringify(cardV2)
      const b64Str = btoa(unescape(encodeURIComponent(jsonStr)))
      const newPng = injectTextChunk(bytes, 'chara', b64Str)
      
      const blob = new Blob([newPng], { type: 'image/png' })
      downloadBlob(blob, filename)
    }

    // -----------------------------------------------------------------------
    // AutoResizeTextarea
    // -----------------------------------------------------------------------

    const AutoResizeTextarea = React.forwardRef((props, ref) => {
      const innerRef = useRef(null)
      const elRef = ref || innerRef
      useEffect(() => {
        const el = elRef.current
        if (el) {
          el.style.height = 'auto'
          el.style.height = el.scrollHeight + 'px'
        }
      }, [props.value, elRef])
      return h('textarea', {
        ...props,
        ref: elRef,
        style: { ...props.style, resize: 'none', overflow: 'hidden', minHeight: props.style?.minHeight || '40px' }
      })
    })

    // -----------------------------------------------------------------------
    // UI Layout
    // -----------------------------------------------------------------------

    const STYLE_ID = 'dsh-bard-ui-style'

    const INJECTED_CSS = `
.dsh-bard-scope .dsh-bard-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;cursor:pointer;font-family:inherit;font-size:13px;line-height:1.4;white-space:nowrap;transition:border-color .15s,background-color .15s,color .15s,opacity .15s}
.dsh-bard-scope .dsh-bard-btn:disabled{opacity:.45;cursor:not-allowed}
.dsh-bard-scope .dsh-bard-btn:not(:disabled):hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dsh-bard-scope .dsh-bard-btn-primary{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:#fff;font-weight:600;padding:6px 16px}
.dsh-bard-scope .dsh-bard-btn-primary:not(:disabled):hover{color:#fff;filter:brightness(1.06)}
.dsh-bard-scope .dsh-bard-btn-danger{border-color:var(--dsw-alias-state-error-primary);background:transparent;color:var(--dsw-alias-state-error-primary)}
.dsh-bard-scope .dsh-bard-btn-danger:not(:disabled):hover{background:rgba(220,38,38,.08)}
.dsh-bard-scope .dsh-bard-btn-icon{padding:4px 6px;font-size:11px;min-width:26px}
.dsh-bard-scope .dsh-bard-tab{border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:6px 14px;cursor:pointer;font-family:inherit;font-size:13px;transition:all .15s}
.dsh-bard-scope .dsh-bard-tab-active{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-bard-scope .dsh-bard-chip{border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;padding:3px 10px;cursor:pointer;font-size:12px}
.dsh-bard-scope .dsh-bard-chip-active{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-bard-scope .dsh-bard-clickable:hover{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.dsh-bard-scope .dsh-bard-section-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
`

    function ensureStyles() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
      const root = document.head || document.documentElement
      if (!root) return
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = INJECTED_CSS
      root.appendChild(el)
    }

    const CARD_PAD = 16
    const CARD_RADIUS = 12

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: '20px', color: 'var(--dsw-alias-label-primary)', fontSize: '13px', lineHeight: 1.6, maxWidth: '1200px', margin: '0 auto' },
      card: { border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: `${CARD_RADIUS}px`, padding: `${CARD_PAD}px`, boxShadow: '0 2px 8px rgba(0,0,0,0.02)' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      between: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
      tabs: { display: 'flex', gap: '6px', borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: '8px', flexWrap: 'wrap', marginBottom: '16px' },
      input: { border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', borderRadius: '8px', padding: '6px 10px', fontFamily: 'inherit', fontSize: '13px', width: '100%', boxSizing: 'border-box', transition: 'border-color 0.2s' },
      select: { border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', borderRadius: '8px', padding: '6px 10px', fontFamily: 'inherit', fontSize: '13px', width: '100%', boxSizing: 'border-box', cursor: 'pointer' },
      label: { fontSize: '12px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)', display: 'block', marginBottom: '6px' },
      list: { display: 'flex', flexDirection: 'column', gap: '10px' },
      item: { display: 'flex', gap: '12px', alignItems: 'flex-start', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: '10px', padding: '12px', transition: 'border-color 0.2s' },
      itemClickable: { display: 'flex', gap: '12px', alignItems: 'flex-start', border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: '10px', padding: '12px', cursor: 'pointer', transition: 'border-color 0.2s' },
      stickyBar: { position: 'sticky', top: 0, zIndex: 5, display: 'flex', alignItems: 'center', gap: '10px', background: 'var(--dsw-alias-bg-layer-1)', margin: `${-CARD_PAD}px ${-CARD_PAD}px 0`, padding: '12px 16px', borderBottom: '1px solid var(--dsw-alias-border-l1)', cursor: 'pointer', borderRadius: `${CARD_RADIUS}px ${CARD_RADIUS}px 0 0` },
      stickyFooter: { position: 'sticky', bottom: 0, zIndex: 5, display: 'flex', alignItems: 'center', gap: '12px', background: 'var(--dsw-alias-bg-layer-1)', margin: `0 ${-CARD_PAD}px ${-CARD_PAD}px`, padding: '12px 16px', borderTop: '1px solid var(--dsw-alias-border-l1)', borderRadius: `0 0 ${CARD_RADIUS}px ${CARD_RADIUS}px` },
      thumb: { width: '48px', height: '48px', borderRadius: '8px', objectFit: 'cover', flex: '0 0 auto', background: 'var(--dsw-alias-bg-layer-2)' },
      heroThumb: { width: '80px', height: '80px', borderRadius: '10px', objectFit: 'cover', flex: '0 0 auto', background: 'var(--dsw-alias-bg-layer-2)' },
      grow: { flex: '1 1 240px', minWidth: '0' },
      name: { fontWeight: 600, fontSize: '14px' },
      prose: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '14px', lineHeight: 1.85, color: 'var(--dsw-alias-label-primary)', margin: 0 },
      quote: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '14px', lineHeight: 1.85, color: 'var(--dsw-alias-label-primary)', margin: 0, paddingLeft: '14px', borderLeft: '2px solid var(--dsw-alias-border-l2)' },
      pre: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px', padding: '12px', fontSize: '13px', maxHeight: '400px', overflow: 'auto', margin: '8px 0 0', fontFamily: 'monospace' },
      alert: { border: '1px solid var(--dsw-alias-state-error-primary)', background: 'rgba(220, 38, 38, 0.05)', color: 'var(--dsw-alias-state-error-primary)', borderRadius: '8px', padding: '10px 14px', fontSize: '13px', wordBreak: 'break-word' },
      ok: { border: '1px solid var(--dsw-alias-state-success-primary)', background: 'rgba(22, 163, 74, 0.05)', color: 'var(--dsw-alias-state-success-primary)', borderRadius: '8px', padding: '10px 14px', fontSize: '13px' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '8px' },
      check: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px', cursor: 'pointer', padding: '4px 0' },
      ellipsis: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      section: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '10px', background: 'var(--dsw-alias-bg-layer-1)', marginBottom: '12px', overflow: 'hidden' },
      sectionHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: 'var(--dsw-alias-bg-layer-2)', cursor: 'pointer', userSelect: 'none', fontWeight: 600, fontSize: '13px' },
      sectionBody: { padding: '16px' },
      blockRow: { display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 12px', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '8px', marginBottom: '6px', fontSize: '12px', border: '1px solid transparent', transition: 'all 0.2s' },
      blockRowDisabled: { opacity: 0.6, background: 'transparent', border: '1px dashed var(--dsw-alias-border-l1)' },
      blockTag: { fontSize: '11px', padding: '2px 6px', borderRadius: '4px', background: 'var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-secondary)', marginLeft: '8px' },
      creatorLayout: { display: 'flex', flexDirection: 'column', gap: '16px' },
      creatorTopBar: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', padding: '12px 16px', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '10px' },
    }

    const ICON_PATHS = {
      chevronDown: 'M3 4.5 6 7.5 9 4.5', chevronRight: 'M4.5 3 7.5 6 4.5 9', chevronUp: 'M3 7.5 6 4.5 9 7.5',
      check: 'M2.5 6.5 5 9 9.5 3.5', close: 'M3 3 9 9M9 3 3 9', plus: 'M6 2.5v7M2.5 6h7',
    }

    function Icon(props) {
      const d = ICON_PATHS[props.name]
      if (!d) return null
      return h('svg', { width: props.size || 12, height: props.size || 12, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', style: { display: 'block', flex: '0 0 auto', ...(props.style || {}) } }, h('path', { d }))
    }

    function AvatarIcon() {
      return h('svg', { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', style: { display: 'block', opacity: 0.45 } }, [
        h('circle', { key: 'c', cx: 12, cy: 12, r: 9 }), h('circle', { key: 'e1', cx: 9, cy: 10.5, r: 0.9, fill: 'currentColor', stroke: 'none' }), h('circle', { key: 'e2', cx: 15, cy: 10.5, r: 0.9, fill: 'currentColor', stroke: 'none' }), h('path', { key: 'm', d: 'M8.8 14.6c.9 1.1 2 1.7 3.2 1.7s2.3-.6 3.2-1.7' })
      ])
    }

    function withIcon(name, text, size) {
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } }, [h(Icon, { key: 'i', name, size: size || 12 }), h('span', { key: 't' }, text)])
    }

    function Field(props) {
      return h('div', { style: { marginBottom: '12px' } }, [h('label', { key: 'l', style: S.label }, props.label), props.children])
    }

    const BTN_CLASS = { default: 'dsh-bard-btn', primary: 'dsh-bard-btn dsh-bard-btn-primary', danger: 'dsh-bard-btn dsh-bard-btn-danger', icon: 'dsh-bard-btn dsh-bard-btn-icon' }

    function Btn(props) {
      return h('button', { type: 'button', className: BTN_CLASS[props.variant || 'default'] || BTN_CLASS.default, style: props.style, disabled: props.disabled === true, onClick: props.onClick, title: props.title }, props.children)
    }

    function Section(props) {
      const [open, setOpen] = useState(props.defaultOpen !== false)
      const toggle = () => setOpen((value) => !value)
      return h('div', { style: S.section }, [
        h('div', { key: 'h', className: 'dsh-bard-section-head', style: S.sectionHeader, role: 'button', tabIndex: 0, onClick: toggle, onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } } }, [
          h('span', { key: 't' }, props.title),
          h(Icon, { key: 'a', name: open ? 'chevronDown' : 'chevronRight', size: 11, style: { color: 'var(--dsw-alias-label-secondary)' } }),
        ]),
        open ? h('div', { key: 'b', style: S.sectionBody }, props.children) : null,
      ])
    }

    function rowClickProps(onActivate) {
      return {
        role: 'button', tabIndex: 0,
        onClick: () => {
          const selection = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null
          if (selection && selection.toString().length > 0) return
          onActivate()
        },
        onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate() } },
      }
    }

    // -----------------------------------------------------------------------
    // Tabs & Components
    // -----------------------------------------------------------------------

    function GreetingBlock(props) {
      const [copied, setCopied] = useState('')
      const greetings = props.greetings || []
      const [index, setIndex] = useState(0)
      if (greetings.length === 0) return h('div', { style: S.muted }, '这张角色卡没有开场白（first_mes 为空）。')
      const current = greetings[Math.min(index, greetings.length - 1)]
      const copy = () => {
        const done = () => { setCopied('已复制到剪贴板'); setTimeout(() => setCopied(''), 2000) }
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(current.text).then(done, () => setCopied('复制失败')); return }
        } catch (error) { /* fall through */ }
        setCopied('复制失败，请手动选择文本')
      }
      return h('div', null, [
        h('div', { key: 'bar', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' } }, [
          greetings.length > 1 ? h('div', { key: 'tabs', style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } }, greetings.map((g, i) => h('button', { key: i, type: 'button', className: `dsh-bard-chip${i === index ? ' dsh-bard-chip-active' : ''}`, onClick: () => setIndex(i) }, g.label))) : h('span', { key: 'l', style: { ...S.muted } }, current.label),
          h(Btn, { key: 'copy', onClick: copy }, '复制'),
        ]),
        h('div', { key: 'txt', style: S.quote }, current.text),
        copied ? h('div', { key: 'st', style: { ...S.muted, marginTop: '6px' } }, copied) : null,
      ])
    }

    function CardEditor(props) {
      const { card: detail, onCancel, onSaved, notify } = props
      const [draft, setDraft] = useState(() => ({
        name: detail.name || '', description: detail.description || '', personality: detail.personality || '',
        scenario: detail.scenario || '', firstMes: detail.firstMes || '',
        alternateGreetings: Array.isArray(detail.alternateGreetings) ? detail.alternateGreetings.slice() : [],
        mesExample: detail.mesExample || '', systemPrompt: detail.systemPrompt || '',
        postHistoryInstructions: detail.postHistoryInstructions || '', creatorNotes: detail.creatorNotes || '',
        creator: detail.creator || '', characterVersion: detail.characterVersion || '',
        tags: Array.isArray(detail.tags) ? detail.tags.join(', ') : '', depthPrompt: detail.depthPrompt || '',
      }))
      const [busy, setBusy] = useState(false)
      const set = (patch) => setDraft((current) => ({ ...current, ...patch }))

      const save = async () => {
        setBusy(true)
        try {
          const result = await call('/card/update', { id: detail.id, patch: draft })
          notify(`已更新角色卡「${result.card.name}」`)
          onSaved(result.card)
        } catch (error) { notify(String((error && error.message) || error), 'error') } finally { setBusy(false) }
      }

      const textField = (key, label, hint) => h(Field, { key, label }, [
        h(AutoResizeTextarea, { key: 'i', style: { ...S.input, minHeight: '52px' }, value: draft[key], placeholder: hint || '', onChange: (e) => set({ [key]: e.target.value }) }),
      ])

      return h('div', { style: S.card }, [
        h('div', { key: 'h', style: S.between }, [
          h('span', { key: 't', style: { ...S.name, fontSize: '16px' } }, `编辑角色卡「${detail.name}」`),
          h('span', { key: 'id', style: { ...S.muted, fontFamily: 'monospace' } }, `ID：${detail.id}`),
        ]),
        h('div', { key: 'meta', style: { ...S.row, marginTop: '16px', alignItems: 'flex-start' } }, [
          h('div', { key: 'a', style: { flex: '1 1 200px' } }, [h('span', { key: 'l', style: S.label }, '角色名'), h('input', { key: 'i', style: S.input, value: draft.name, onChange: (e) => set({ name: e.target.value }) })]),
          h('div', { key: 'b', style: { flex: '1 1 200px' } }, [h('span', { key: 'l', style: S.label }, '作者'), h('input', { key: 'i', style: S.input, value: draft.creator, onChange: (e) => set({ creator: e.target.value }) })]),
          h('div', { key: 'c', style: { flex: '1 1 160px' } }, [h('span', { key: 'l', style: S.label }, '版本'), h('input', { key: 'i', style: S.input, value: draft.characterVersion, onChange: (e) => set({ characterVersion: e.target.value }) })]),
        ]),
        h(Field, { key: 'tags', label: '标签（逗号分隔）' }, h('input', { style: S.input, value: draft.tags, onChange: (e) => set({ tags: e.target.value }) })),
        textField('description', '角色简介', '角色的背景、来历、与他人的关系……'),
        textField('personality', '性格', '性格、说话方式、行为习惯……'),
        textField('scenario', '场景', '剧情发生的背景设定。'),
        textField('firstMes', '开场白（初始文本）', '会话开始时角色说的第一段话。'),
        textField('mesExample', '对话示例', '让模型模仿其风格，不会照抄。'),
        textField('systemPrompt', '角色专属系统指令', '会被写进 persona prefix，与预设的默认行为叠加。'),

        h(Section, { key: 'ag', title: `备用开场白（${draft.alternateGreetings.length}）` }, [
          draft.alternateGreetings.map((text, index) => h('div', { key: index, style: { marginBottom: '10px' } }, [
            h('div', { key: 'bar', style: S.between }, [
              h('span', { key: 'l', style: S.label }, `备用 ${index + 1}`),
              h(Btn, { key: 'x', variant: 'danger', onClick: () => set({ alternateGreetings: draft.alternateGreetings.filter((_, i) => i !== index) }) }, '删除'),
            ]),
            h(AutoResizeTextarea, { style: { ...S.input, minHeight: '70px' }, value: text, onChange: (e) => {
              const list = [...draft.alternateGreetings]; list[index] = e.target.value; set({ alternateGreetings: list })
            } }),
          ])),
          h('div', { key: 'add', style: { marginTop: '8px' } }, h(Btn, { onClick: () => set({ alternateGreetings: [...draft.alternateGreetings, ''] }) }, withIcon('plus', '添加备用开场白', 11))),
        ]),

        textField('postHistoryInstructions', '每轮都要遵守（重要）', '放在 persona prefix 最末尾的硬性要求。'),
        textField('creatorNotes', '作者备注', '只是给自己看的备注，不会进入模型提示。'),
        textField('depthPrompt', '深度提示', '角色自己的持续提醒；会进入 persona prefix，在输出风格之后。'),

        h('div', { key: 'act', style: { ...S.row, marginTop: '16px' } }, [
          h(Btn, { key: 's', variant: 'primary', disabled: busy, onClick: save }, busy ? '保存中…' : '保存修改'),
          h(Btn, { key: 'c', disabled: busy, onClick: onCancel }, '取消'),
        ]),
      ])
    }

    function CardsTab(props) {
      const { state, reload, notify, cardDetails, ensureCardDetail, invalidateCardDetail, onExtractBook } = props
      const [openId, setOpenId] = useState('')
      const [editing, setEditing] = useState(null)
      const fileRef = useRef(null)
      const [busy, setBusy] = useState(false)
      const [manual, setManual] = useState(null)
      const cards = Array.isArray(state.cards) ? state.cards : []
      const expanded = manual !== null ? manual : cards.length <= 8

      const toggleOpen = async (card) => {
        if (openId === card.id) { setOpenId(''); return }
        setOpenId(card.id)
        try { await ensureCardDetail(card.id) } catch (error) { notify(String((error && error.message) || error), 'error'); setOpenId('') }
      }
      const onFiles = async (event) => {
        const files = Array.from(event.target.files || []); event.target.value = ''
        if (files.length === 0) return; setBusy(true)
        try {
          for (const file of files) {
            const dataUrl = await readFileAsDataUrl(file)
            const result = await call('/card', { dataUrl, fileName: file.name })
            notify(`已导入角色卡「${result.card.name}」${result.hasCharacterBook ? '（含内嵌世界书）' : ''}`)
          }
          await reload()
        } catch (error) { notify(String((error && error.message) || error), 'error') } finally { setBusy(false) }
      }
      const remove = async (card) => {
        const presetsUsing = state.presets.filter(p => p.cardId === card.id)
        let msg = `删除角色卡「${card.name}」？`
        if (presetsUsing.length > 0) {
          msg += `\n\n⚠️ 警告：以下预设正在使用此卡，删除后这些预设将失效，对应会话也会报错：\n${presetsUsing.map(p => p.name).join('、')}`
        }
        if (!window.confirm(msg)) return
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur()
        setBusy(true)
        try {
          await call('/card/delete', { id: card.id, force: true })
          notify(`已删除「${card.name}」`)
          if (openId === card.id) setOpenId('')
          if (editing && editing.id === card.id) setEditing(null)
          invalidateCardDetail(card.id); await reload()
        } catch (error) { notify(String((error && error.message) || error), 'error') } finally { setBusy(false) }
      }
      const importBook = async (card) => {
        setBusy(true)
        try {
          const result = await call('/card/book', { id: card.id })
          notify(`已从「${card.name}」提取世界书「${result.book.name}」并跳转至女娲`)
          await reload()
          if (onExtractBook) onExtractBook(result.book)
        } catch (error) { notify(String((error && error.message) || error), 'error') } finally { setBusy(false) }
      }
      const startEdit = async (card) => {
        setBusy(true)
        try { const detail = await ensureCardDetail(card.id); setEditing(detail); setOpenId('') }
        catch (error) { notify(String((error && error.message) || error), 'error') } finally { setBusy(false) }
      }

      const renderDetail = (card) => {
        const detail = cardDetails[card.id] || null
        if (detail === null) return h('div', { key: 'loading', style: { ...S.muted, marginTop: '12px' } }, '正在加载详情…')
        const greetings = [
          detail.firstMes ? { label: '开场白', text: detail.firstMes } : null,
          ...(detail.alternateGreetings || []).map((text, i) => ({ label: `备用 ${i + 1}`, text })),
        ].filter(Boolean)
        const tags = Array.isArray(card.tags) ? card.tags : (Array.isArray(detail.tags) ? detail.tags : [])
        return h('div', { key: 'body', style: { marginTop: '12px' } }, [
          h('div', { key: 'head', style: { display: 'flex', gap: '16px', alignItems: 'flex-start', marginBottom: '20px' } }, [
            card.portrait ? h('img', { key: 'p', src: card.portrait, style: S.heroThumb, alt: card.name })
              : h('div', { key: 'p', style: { ...S.heroThumb, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dsw-alias-label-secondary)' } }, h(AvatarIcon)),
            h('div', { key: 'm', style: { flex: '1 1 auto', minWidth: 0 } }, [
              h('div', { key: 'n', style: { fontSize: '18px', fontWeight: 600, lineHeight: 1.3 } }, card.name),
              h('div', { key: 'meta', style: { ...S.muted, marginTop: '4px' } }, [card.creator ? `作者 ${card.creator}` : '', detail.characterVersion ? `版本 ${detail.characterVersion}` : '', card.spec].filter(Boolean).join(' · ')),
              tags.length > 0 ? h('div', { key: 'tags', style: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '8px' } }, tags.map((tag, i) => h('span', { key: i, style: { fontSize: '11px', padding: '1px 8px', borderRadius: '999px', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)' } }, tag))) : null,
            ]),
          ]),
          greetings.length > 0 ? h('div', { key: 'g', style: { marginBottom: '20px' } }, [h('div', { key: 'l', style: S.label }, '开场白'), h(GreetingBlock, { key: 'b', greetings })]) : null,
          detail.description ? h('div', { key: 'd', style: { marginBottom: '18px' } }, [h('div', { key: 'l', style: S.label }, '角色简介'), h('div', { key: 'p', style: S.prose }, detail.description)]) : null,
          detail.personality ? h('div', { key: 'pe', style: { marginBottom: '18px' } }, [h('div', { key: 'l', style: S.label }, '性格'), h('div', { key: 'p', style: S.prose }, detail.personality)]) : null,
          detail.scenario ? h('div', { key: 'sc', style: { marginBottom: '18px' } }, [h('div', { key: 'l', style: S.label }, '场景'), h('div', { key: 'p', style: S.prose }, detail.scenario)]) : null,
          detail.mesExample ? h('div', { key: 'me' }, [h('div', { key: 'l', style: S.label }, '对话示例'), h('div', { key: 'p', style: S.prose }, detail.mesExample)]) : null,
        ])
      }

      return h('div', { style: S.list }, [
        h('div', { key: 'imp', style: S.card }, [
          h('div', { key: 'a', style: S.between }, [
            h('span', { key: 't', style: { ...S.name, fontSize: '15px' } }, '导入角色卡'),
            h(Btn, { key: 'b', variant: 'primary', disabled: busy, onClick: () => fileRef.current && fileRef.current.click() }, busy ? '处理中…' : '选择文件'),
          ]),
          h('div', { key: 'b', style: { ...S.muted, marginTop: '6px' } }, '支持 SillyTavern 角色卡：PNG 或 JSON（V1 / V2 / V3）。'),
          h('input', { key: 'f', ref: fileRef, type: 'file', multiple: true, style: { display: 'none' }, accept: '.json,.png,application/json,image/png', onChange: onFiles }),
        ]),
        editing ? h(CardEditor, { key: 'editor', card: editing, notify, onCancel: () => setEditing(null), onSaved: async (saved) => { setEditing(null); if (saved && saved.id) invalidateCardDetail(saved.id); await reload() } }) : null,
        cards.length === 0 ? h('div', { key: 'empty', style: { textAlign: 'center', padding: '32px 16px' } }, [h('div', { key: 't', style: { fontSize: '15px', fontWeight: 600, marginBottom: '6px' } }, '还没有角色卡'), h('div', { key: 's', style: S.muted }, '用上方的「选择文件」导入，或前往「女娲」手动创建。')])
          : h('div', { key: 'ctl', style: S.between }, [h('span', { key: 'l', style: S.muted }, `共 ${cards.length} 张角色卡`), h(Btn, { key: 'b', onClick: () => setManual(!expanded) }, expanded ? '收起' : `展开全部 ${cards.length} 张`)]),
        expanded ? cards.map((card) => {
          const isOpen = openId === card.id
          return h('div', { key: card.id }, [
            h('div', { key: 'card', className: 'dsh-bard-clickable', style: S.itemClickable, ...rowClickProps(() => toggleOpen(card)) }, [
              card.portrait ? h('img', { key: 'p', src: card.portrait, style: S.thumb, alt: card.name }) : h('div', { key: 'p', style: { ...S.thumb, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dsw-alias-label-secondary)' } }, h(AvatarIcon)),
              h('div', { key: 'm', style: S.grow }, [
                h('div', { key: 'n', style: { ...S.name, display: 'flex', alignItems: 'center', gap: '6px' } }, [h(Icon, { key: 'a', name: isOpen ? 'chevronDown' : 'chevronRight', size: 11, style: { color: 'var(--dsw-alias-label-secondary)' } }), h('span', { key: 't', style: S.ellipsis }, card.name)]),
                h('div', { key: 's', style: S.muted }, [card.spec, card.creator ? `作者 ${card.creator}` : '', `${card.greetingCount} 条开场白`, card.hasCharacterBook ? '含内嵌世界书' : '', card.tags.length ? card.tags.slice(0, 5).join(' / ') : ''].filter(Boolean).join(' · ')),
                h('div', { key: 'b', style: { ...S.row, marginTop: '8px' } }, [
                  h(Btn, { key: 'e', disabled: busy, onClick: (e) => { e.stopPropagation(); startEdit(card) } }, '编辑'),
                  card.hasCharacterBook ? h(Btn, { key: 'bk', disabled: busy, onClick: (e) => { e.stopPropagation(); importBook(card) } }, '提取内嵌书') : null,
                  h(Btn, { key: 'x', variant: 'danger', disabled: busy, onClick: (e) => { e.stopPropagation(); remove(card) } }, '删除'),
                ]),
              ]),
            ]),
            isOpen ? h('div', { key: 'detail', style: { ...S.card, marginTop: '8px' } }, [
              h('div', { key: 'bar', style: S.stickyBar, ...rowClickProps(() => setOpenId('')) }, [h(Icon, { key: 'a', name: 'chevronDown', size: 11, style: { color: 'var(--dsw-alias-label-secondary)' } }), card.portrait ? h('img', { key: 'p', src: card.portrait, style: { width: '24px', height: '24px', borderRadius: '5px', objectFit: 'cover', flex: '0 0 auto' }, alt: '' }) : null, h('span', { key: 'n', style: { ...S.name, ...S.ellipsis } }, card.name), h(Btn, { key: 'e', disabled: busy, onClick: (e) => { e.stopPropagation(); startEdit(card) } }, '编辑')]),
              renderDetail(card),
            ]) : null,
          ])
        }) : null,
      ])
    }

    function BooksTab(props) {
      const { state, reload, notify } = props
      const [openId, setOpenId] = useState('')
      const [detail, setDetail] = useState(null)
      const [openEntries, setOpenEntries] = useState(() => new Set())
      const fileRef = useRef(null)
      const [busy, setBusy] = useState(false)
      const [manual, setManual] = useState(null)
      const openRequestRef = useRef(0)
      const books = Array.isArray(state.worldbooks) ? state.worldbooks : []
      const expanded = manual !== null ? manual : books.length <= 8

      const onFiles = async (event) => {
        const files = Array.from(event.target.files || []); event.target.value = ''
        if (files.length === 0) return; setBusy(true)
        try {
          for (const file of files) {
            const dataUrl = await readFileAsDataUrl(file)
            const result = await call('/worldbook', { dataUrl, fileName: file.name })
            notify(`已导入世界书「${result.book.name}」（${result.book.entryCount} 条，${result.book.keywordCount} 条关键词触发）`)
          }
          await reload()
        } catch (error) { notify(String((error && error.message) || error), 'error') } finally { setBusy(false) }
      }
      const remove = async (book) => {
        if (!window.confirm(`删除世界书「${book.name}」？`)) return
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur()
        setBusy(true)
        try {
          await call('/worldbook/delete', { id: book.id }); notify(`已删除「${book.name}」`)
          if (openId === book.id) { setOpenId(''); setDetail(null); setOpenEntries(new Set()) }
          await reload()
        } catch (error) { notify(String((error && error.message) || error), 'error') } finally { setBusy(false) }
      }
      const open = async (book) => {
        if (openId === book.id) { openRequestRef.current += 1; setOpenId(''); setDetail(null); setOpenEntries(new Set()); return }
        const requestId = ++openRequestRef.current; setBusy(true)
        try {
          const result = await call('/worldbook/detail', { id: book.id })
          if (requestId !== openRequestRef.current) return
          setDetail(result.book); setOpenId(book.id); setOpenEntries(new Set())
        } catch (error) { if (requestId === openRequestRef.current) notify(String((error && error.message) || error), 'error') }
        finally { if (requestId === openRequestRef.current) setBusy(false) }
      }
      const toggleEntry = (id) => setOpenEntries(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })

      return h('div', { style: S.list }, [
        h('div', { key: 'imp', style: S.card }, [
          h('div', { key: 'a', style: S.between }, [h('span', { key: 't', style: { ...S.name, fontSize: '15px' } }, '导入世界书'), h(Btn, { key: 'b', variant: 'primary', disabled: busy, onClick: () => fileRef.current && fileRef.current.click() }, busy ? '处理中…' : '选择文件')]),
          h('div', { key: 'b', style: { ...S.muted, marginTop: '6px' } }, '支持 SillyTavern World Info 导出（entries 为对象或数组）与 Character Card V2 的 character_book。'),
          h('input', { key: 'f', ref: fileRef, type: 'file', multiple: true, style: { display: 'none' }, accept: '.json,application/json', onChange: onFiles }),
        ]),
        books.length === 0 ? h('div', { key: 'empty', style: { textAlign: 'center', padding: '32px 16px' } }, [h('div', { key: 't', style: { fontSize: '15px', fontWeight: 600, marginBottom: '6px' } }, '还没有世界书'), h('div', { key: 's', style: S.muted }, '用上方的「选择文件」导入，或前往「女娲」手动创建。')])
          : h('div', { key: 'ctl', style: S.between }, [h('span', { key: 'l', style: S.muted }, `共 ${books.length} 本世界书`), h(Btn, { key: 'b', onClick: () => setManual(!expanded) }, expanded ? '收起' : `展开全部 ${books.length} 本`)]),
        expanded ? books.map((book) => {
          const isOpen = openId === book.id && detail !== null
          const entries = isOpen && Array.isArray(detail.entries) ? detail.entries : []
          return h('div', { key: book.id }, [
            h('div', { key: 'card', className: 'dsh-bard-clickable', style: S.itemClickable, ...rowClickProps(() => open(book)) }, [
              h('div', { key: 'm', style: S.grow }, [
                h('div', { key: 'n', style: { ...S.name, display: 'flex', alignItems: 'center', gap: '6px' } }, [h(Icon, { key: 'a', name: isOpen ? 'chevronDown' : 'chevronRight', size: 11, style: { color: 'var(--dsw-alias-label-secondary)' } }), h('span', { key: 't', style: S.ellipsis }, book.name)]),
                h('div', { key: 's', style: S.muted }, [`${book.entryCount} 条条目`, `${book.enabledCount} 条启用`, `${book.constantCount} 条常驻`, `${book.keywordCount} 条关键词`, book.source === 'character_book' ? '来自角色卡' : ''].filter(Boolean).join(' · ')),
                h('div', { key: 'b', style: { ...S.row, marginTop: '8px' } }, [h(Btn, { key: 'x', variant: 'danger', disabled: busy, onClick: (e) => { e.stopPropagation(); remove(book) } }, '删除')]),
              ]),
            ]),
            isOpen ? h('div', { key: 'detail', style: { ...S.card, marginTop: '8px' } }, [
              h('div', { key: 'bar', style: S.stickyBar, ...rowClickProps(() => open(book)) }, [h(Icon, { key: 'a', name: 'chevronDown', size: 11, style: { color: 'var(--dsw-alias-label-secondary)' } }), h('span', { key: 'n', style: { ...S.name, ...S.ellipsis } }, `${detail.name} — 条目（${entries.length}）`)]),
              entries.length === 0 ? h('div', { key: 'e', style: { ...S.muted, marginTop: '12px' } }, '这本书里没有可用条目。')
                : h('div', { key: 'list', style: { marginTop: '4px' } }, entries.map((entry) => {
                  const entryOpen = openEntries.has(entry.id)
                  const meta = [entry.constant ? '常驻' : `关键词：${entry.keys.join('、') || '（无）'}`, entry.selective && entry.secondaryKeys.length ? `需附带：${entry.secondaryKeys.join('、')}` : '', entry.enabled ? '' : '已停用'].filter(Boolean).join(' · ')
                  return h('div', { key: entry.id, style: { borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: '12px', marginTop: '12px', cursor: 'pointer' }, ...rowClickProps(() => toggleEntry(entry.id)) }, [
                    h('div', { key: 'h', style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [h(Icon, { key: 'a', name: entryOpen ? 'chevronDown' : 'chevronRight', size: 11, style: { color: 'var(--dsw-alias-label-secondary)' } }), h('span', { key: 'c', style: { ...S.ellipsis, flex: '0 1 auto', fontWeight: 600, fontSize: '13px' } }, entry.comment), h('span', { key: 'k', style: { ...S.muted, ...S.ellipsis }, title: meta }, meta)]),
                    entryOpen ? h('div', { key: 'p', style: { ...S.quote, marginTop: '10px' } }, entry.content) : null,
                  ])
                })),
            ]) : null,
          ])
        }) : null,
      ])
    }

    function SkillsTab(props) {
      const { state } = props
      const skills = Array.isArray(state.skills) ? state.skills : []
      const [manual, setManual] = useState(null)
      const expanded = manual !== null ? manual : skills.length <= 8
      return h('div', { style: S.list }, [
        h('div', { key: 'h', style: S.card }, [
          h('div', { key: 'a', style: S.between }, [h('div', { key: 't', style: { ...S.name, fontSize: '15px' } }, `DSH 技能目录（${skills.length}）`), skills.length > 0 ? h(Btn, { key: 'b', onClick: () => setManual(!expanded) }, expanded ? '收起' : `展开全部 ${skills.length} 个`) : null]),
          h('div', { key: 's', style: { ...S.muted, marginTop: '6px' } }, '这些是本机 DSH 已安装的 Skill。在「预设」页把技能挂到某个角色上，它的内容会被写进角色的系统提示，让角色按需使用。'),
        ]),
        skills.length === 0 ? h('div', { key: 'empty', style: { textAlign: 'center', padding: '32px 16px' } }, [h('div', { key: 't', style: { fontSize: '15px', fontWeight: 600, marginBottom: '6px' } }, '还没有可用的技能'), h('div', { key: 's', style: S.muted }, '在 DSH 里安装 Skill 后，这里会自动列出。')]) : expanded ? skills.map((skill) => h('div', { key: skill.name, style: S.item }, [
          h('div', { key: 'm', style: S.grow }, [h('div', { key: 'n', style: S.name }, skill.name), h('div', { key: 'd', style: S.muted }, skill.description || '（无描述）'), skill.whenToUse ? h('div', { key: 'w', style: S.muted }, `适用：${skill.whenToUse}`) : null, h('div', { key: 'p', style: { ...S.muted, marginTop: '4px' } }, `来源：${skill.provider} · ${skill.source}`)]),
        ])) : h('div', { key: 'hint', style: S.muted }, `已折叠 ${skills.length} 个技能。点击上方「展开全部」查看。`),
      ])
    }

    // -----------------------------------------------------------------------
    // Creator Tab (女娲)
    // -----------------------------------------------------------------------
    
    function CreatorTab(props) {
      const { state, reload, notify, cardDetails, ensureCardDetail, initialBook } = props
      const [mode, setMode] = useState('card') // card | book
      const [editingId, setEditingId] = useState('')
      
      // 角色卡草稿
      const emptyCard = { name: '', description: '', personality: '', scenario: '', firstMes: '', mesExample: '', systemPrompt: '', postHistoryInstructions: '', depthPrompt: '', creatorNotes: '', creator: '', characterVersion: '1.0', tags: '', alternateGreetings: [], portraitBase64: '' }
      const [cardDraft, setCardDraft] = useState(emptyCard)
      
      // 世界书草稿
      const emptyBook = { name: '', entries: [] }
      const [bookDraft, setBookDraft] = useState(emptyBook)
      const [editingEntryIndex, setEditingEntryIndex] = useState(-1)
      
      const fileRef = useRef(null)
      const [busy, setBusy] = useState(false)
            const importJson = () => {
        const raw = window.prompt(mode === 'card' ? '请粘贴角色卡 JSON：' : '请粘贴世界书 JSON：')
        if (!raw || !raw.trim()) return
        try {
          // 容错：剥离可能出现的 markdown 代码块标记
          const cleanStr = raw.replace(/^```(json)?\n?/i, '').replace(/\n?```$/i, '').trim()
          const data = JSON.parse(cleanStr)
          
          if (mode === 'card') {
            // 如果是最外层有 data 的 V2/V3 格式，剥开它
            const inner = data.data || data
            setCardDraft(prev => ({
              ...prev,
              name: inner.name || prev.name,
              description: inner.description || prev.description,
              personality: inner.personality || prev.personality,
              scenario: inner.scenario || prev.scenario,
              firstMes: inner.first_mes || inner.firstMes || prev.firstMes,
              mesExample: inner.mes_example || inner.mesExample || prev.mesExample,
              systemPrompt: inner.system_prompt || inner.systemPrompt || prev.systemPrompt,
              postHistoryInstructions: inner.post_history_instructions || inner.postHistoryInstructions || prev.postHistoryInstructions,
              creatorNotes: inner.creator_notes || inner.creatorNotes || prev.creatorNotes,
              creator: inner.creator || prev.creator,
              characterVersion: inner.character_version || inner.characterVersion || prev.characterVersion,
              tags: Array.isArray(inner.tags) ? inner.tags.join(', ') : (inner.tags || prev.tags),
              alternateGreetings: Array.isArray(inner.alternate_greetings) ? inner.alternate_greetings : prev.alternateGreetings,
              depthPrompt: (inner.extensions && inner.extensions.depth_prompt && inner.extensions.depth_prompt.prompt) || inner.depthPrompt || prev.depthPrompt
            }))
            notify('角色卡 JSON 导入成功')
          } else {
            const inner = data.data || data
            if (Array.isArray(inner)) {
              setBookDraft(prev => ({ ...prev, entries: inner }))
            } else if (Array.isArray(inner.entries)) {
              setBookDraft(prev => ({
                ...prev,
                name: (typeof inner.name === 'string' && inner.name.trim()) ? inner.name : prev.name,
                entries: inner.entries,
              }))
            } else {
              throw new Error('格式错误：找不到 entries 数组')
            }
            notify('世界书 JSON 导入成功')
          }
        } catch (e) {
          notify(`解析失败：${e.message}`, 'error')
        }
      }

      // 处理从外部跳转过来的提取请求
      useEffect(() => {
        if (initialBook) {
          setMode('book')
          setBookDraft(initialBook)
          setEditingId(initialBook.id)
          setEditingEntryIndex(-1)
        }
      }, [initialBook])

      // 载入现有卡或书
      const loadCard = async (id) => {
        setBusy(true)
        try {
          const detail = await ensureCardDetail(id)
          setCardDraft({ ...detail, tags: Array.isArray(detail.tags) ? detail.tags.join(', ') : '', portraitBase64: '' })
          setEditingId(id)
        } catch (e) { notify(String(e.message), 'error') } finally { setBusy(false) }
      }
      const loadBook = async (id) => {
        setBusy(true)
        try {
          const res = await call('/worldbook/detail', { id })
          setBookDraft(res.book)
          setEditingId(id)
          setEditingEntryIndex(-1)
        } catch (e) { notify(String(e.message), 'error') } finally { setBusy(false) }
      }

      const createNewCard = () => { setEditingId(''); setCardDraft({ ...emptyCard }) }
      const createNewBook = () => { setEditingId(''); setBookDraft({ ...emptyBook, entries: [] }); setEditingEntryIndex(-1) }

      const onImageFile = async (e) => {
        const file = e.target.files?.[0]
        if (!file) return
        const b64 = await readFileAsDataUrl(file)
        setCardDraft(prev => ({ ...prev, portraitBase64: b64 }))
      }

      const saveCard = async () => {
        setBusy(true)
        try {
          const payload = {
            ...cardDraft,
            id: editingId || undefined,
            tags: cardDraft.tags.split(',').map(s => s.trim()).filter(Boolean)
          }
          const res = await call('/card/save', payload)
          notify(`角色卡「${res.card.name}」已保存`)
          setEditingId(res.card.id)
          await reload()
        } catch (e) { notify(String(e.message), 'error') } finally { setBusy(false) }
      }

      const saveBook = async () => {
        setBusy(true)
        try {
          const res = await call('/worldbook/save', { ...bookDraft, id: editingId || undefined })
          notify(`世界书「${res.book.name}」已保存`)
          setEditingId(res.book.id)
          await reload()
        } catch (e) { notify(String(e.message), 'error') } finally { setBusy(false) }
      }

      const exportJson = () => {
        let data = mode === 'card' ? cardDraft : bookDraft
        if (mode === 'card') {
          data = { 
            spec: cardDraft.spec || 'chara_card_v2', 
            spec_version: cardDraft.specVersion || '2.0', 
            data: { ...data, tags: data.tags.split(',').map(s => s.trim()).filter(Boolean) } 
          }
        }
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
        downloadBlob(blob, `${mode === 'card' ? cardDraft.name : bookDraft.name || '未命名'}.json`)
      }

      const exportPng = () => {
        if (!cardDraft.portraitBase64 && !cardDraft.portrait) {
          notify('请先上传一张图片或确保当前卡有立绘', 'error'); return
        }
        const base64 = cardDraft.portraitBase64 || ''
        if (!base64) { notify('导出 PNG 需要先重新上传一次图片作为底图', 'error'); return }
        
        const data = {
          name: cardDraft.name, description: cardDraft.description, personality: cardDraft.personality, scenario: cardDraft.scenario,
          first_mes: cardDraft.firstMes, mes_example: cardDraft.mesExample, system_prompt: cardDraft.systemPrompt,
          post_history_instructions: cardDraft.postHistoryInstructions, creator_notes: cardDraft.creatorNotes,
          creator: cardDraft.creator, character_version: cardDraft.characterVersion,
          tags: cardDraft.tags.split(',').map(s => s.trim()).filter(Boolean), alternate_greetings: cardDraft.alternateGreetings,
          extensions: { depth_prompt: { prompt: cardDraft.depthPrompt } }
        }
        try {
          exportToPNG(base64, data, `${cardDraft.name || '未命名'}.png`)
          notify('导出 PNG 成功')
        } catch (e) { notify(`导出失败：${e.message}`, 'error') }
      }

      const addBookEntry = () => {
        setBookDraft(prev => ({
          ...prev,
          entries: [...prev.entries, { id: String(Date.now()), comment: '新条目', content: '', keys: [], secondaryKeys: [], enabled: true, constant: false, selective: false, caseSensitive: false, matchWholeWords: false, order: 0, priority: 0, probability: 100, selectiveLogic: 'AND_ANY', position: 1, depth: 4, excludeRecursion: false, preventRecursion: false }]
        }))
        setEditingEntryIndex(bookDraft.entries.length)
      }
      const removeBookEntry = (idx) => {
        setBookDraft(prev => ({ ...prev, entries: prev.entries.filter((_, i) => i !== idx) }))
        setEditingEntryIndex(prev => (prev === idx ? -1 : (prev > idx ? prev - 1 : prev)))
      }
      const updateEntry = (idx, patch) => {
        setBookDraft(prev => {
          const entries = [...prev.entries]
          entries[idx] = { ...entries[idx], ...patch }
          return { ...prev, entries }
        })
      }

      const installBuiltin = async (type) => {
        setBusy(true)
        try {
          const res = await call('/builtin/install', { type })
          if (res.ok) {
            notify(`已成功安装「${type === 'qianmian' ? '千面' : '万物'}」预设！\n请前往会话选择该预设，与 AI 对话生成 JSON，然后将 JSON 粘贴回此处。`)
            await reload()
          } else {
            notify(res.error || '安装失败', 'error')
          }
        } catch (e) { notify(String(e.message), 'error') } finally { setBusy(false) }
      }

      return h('div', { style: S.creatorLayout }, [
        h('div', { key: 'h', style: S.between }, [
          h('div', { key: 't', style: { ...S.name, fontSize: '18px' } }, '女娲 · 手动编辑与导出'),
          h('div', { key: 'actions', style: S.row }, [
            h(Btn, { variant: mode === 'card' ? 'primary' : 'default', onClick: () => { setMode('card'); createNewCard(); } }, '造人（角色卡）'),
            h(Btn, { variant: mode === 'book' ? 'primary' : 'default', onClick: () => { setMode('book'); createNewBook(); } }, '造物（世界书）'),
          ])
        ]),

        // 内置向导安装区
        h('div', { key: 'builtin', style: { ...S.card, background: 'var(--dsw-alias-bg-layer-2)' } }, [
          h('div', { style: { fontWeight: 600, marginBottom: '8px' } }, '✨ AI 辅助生成'),
          h('div', { style: { ...S.muted, marginBottom: '12px' } }, '没有灵感？可以一键安装官方提供的内置向导，在 DSH 会话里与它们对话生成内容，然后把输出的 JSON 贴到下面。'),
          h('div', { style: S.row }, [
            h(Btn, { onClick: () => installBuiltin('qianmian'), disabled: busy }, '安装「千面」（造人向导）'),
            h(Btn, { onClick: () => installBuiltin('wanwu'), disabled: busy }, '安装「万物」（造物向导）'),
          ])
        ]),

        h('div', { key: 'topBar', style: S.creatorTopBar }, [
          h('span', { key: 'l', style: { fontWeight: 600, marginRight: '8px' } }, mode === 'card' ? '当前角色卡：' : '当前世界书：'),
          h('select', {
            key: 'sel',
            style: { ...S.select, width: 'auto', minWidth: '240px', maxWidth: '400px' },
            value: editingId,
            onChange: (e) => {
              const val = e.target.value;
              if (val === '') {
                mode === 'card' ? createNewCard() : createNewBook();
              } else {
                mode === 'card' ? loadCard(val) : loadBook(val);
              }
            }
          }, [
            h('option', { key: '', value: '' }, '— 新建空白 —'),
            ...(mode === 'card'
              ? state.cards.map(c => h('option', { key: c.id, value: c.id }, c.name))
              : state.worldbooks.map(b => h('option', { key: b.id, value: b.id }, b.name)))
          ]),
          h(Btn, { key: 'new', onClick: mode === 'card' ? createNewCard : createNewBook }, '+ 新建空白'),
          h(Btn, { key: 'import', onClick: importJson }, '从 JSON 导入')
        ]),

        // 主编辑区
        h('div', { key: 'main', style: { flex: '1 1 auto', minWidth: '0' } }, [
          mode === 'card' ? h('div', { key: 'cardForm', style: S.card }, [
            h('div', { key: 'top', style: S.between }, [
              h('span', { key: 't', style: { ...S.name, fontSize: '16px' } }, editingId ? '编辑角色卡' : '新建角色卡'),
              h('div', { key: 'acts', style: S.row }, [
                h(Btn, { onClick: exportJson }, '导出 JSON'),
                h(Btn, { onClick: exportPng, title: '必须在此上传底图才能生成 PNG' }, '导出 PNG'),
                h(Btn, { variant: 'primary', onClick: saveCard, disabled: busy }, busy ? '保存中…' : '保存到库'),
              ])
            ]),
            h('div', { key: 'img', style: { marginTop: '16px', display: 'flex', gap: '16px', alignItems: 'center' } }, [
              cardDraft.portraitBase64 || cardDraft.portrait 
                ? h('img', { src: cardDraft.portraitBase64 || cardDraft.portrait, style: S.heroThumb }) 
                : h('div', { style: { ...S.heroThumb, display: 'flex', alignItems: 'center', justifyContent: 'center' } }, h(AvatarIcon)),
              h('div', null, [
                h('input', { type: 'file', accept: 'image/png,image/jpeg', onChange: onImageFile, style: { display: 'none' }, ref: fileRef }),
                h(Btn, { onClick: () => fileRef.current.click() }, '选择图片作为底图'),
                h('div', { style: { ...S.muted, marginTop: '4px' } }, '仅用于预览和导出 PNG 的底图，不改变原有卡图。')
              ])
            ]),
            h(Section, { key: 's1', title: '基础信息', defaultOpen: true }, [
              h('div', { style: S.grid }, [
                h(Field, { label: '角色名' }, h('input', { style: S.input, value: cardDraft.name, onChange: e => setCardDraft({ ...cardDraft, name: e.target.value }) })),
                h(Field, { label: '作者' }, h('input', { style: S.input, value: cardDraft.creator, onChange: e => setCardDraft({ ...cardDraft, creator: e.target.value }) })),
                h(Field, { label: '版本' }, h('input', { style: S.input, value: cardDraft.characterVersion, onChange: e => setCardDraft({ ...cardDraft, characterVersion: e.target.value }) })),
                h(Field, { label: '标签' }, h('input', { style: S.input, value: cardDraft.tags, onChange: e => setCardDraft({ ...cardDraft, tags: e.target.value }), placeholder: '逗号分隔' })),
              ])
            ]),
            h(Section, { key: 's2', title: '核心设定', defaultOpen: true }, [
              h(Field, { label: '角色简介' }, h(AutoResizeTextarea, { style: { ...S.input, minHeight: '120px' }, value: cardDraft.description, onChange: e => setCardDraft({ ...cardDraft, description: e.target.value }) })),
              h(Field, { label: '性格' }, h(AutoResizeTextarea, { style: { ...S.input, minHeight: '80px' }, value: cardDraft.personality, onChange: e => setCardDraft({ ...cardDraft, personality: e.target.value }) })),
              h(Field, { label: '场景' }, h(AutoResizeTextarea, { style: { ...S.input, minHeight: '80px' }, value: cardDraft.scenario, onChange: e => setCardDraft({ ...cardDraft, scenario: e.target.value }) })),
            ]),
            h(Section, { key: 's3', title: '对话表现', defaultOpen: true }, [
              h(Field, { label: '开场白' }, h(AutoResizeTextarea, { style: { ...S.input, minHeight: '100px' }, value: cardDraft.firstMes, onChange: e => setCardDraft({ ...cardDraft, firstMes: e.target.value }) })),
              h(Field, { label: '对话示例' }, h(AutoResizeTextarea, { style: { ...S.input, minHeight: '100px' }, value: cardDraft.mesExample, onChange: e => setCardDraft({ ...cardDraft, mesExample: e.target.value }) })),
            ]),
            h(Section, { key: 's4', title: '高级指令', defaultOpen: false }, [
              h(Field, { label: '角色专属系统指令' }, h(AutoResizeTextarea, { style: { ...S.input, minHeight: '80px' }, value: cardDraft.systemPrompt, onChange: e => setCardDraft({ ...cardDraft, systemPrompt: e.target.value }) })),
              h(Field, { label: '每轮都要遵守' }, h(AutoResizeTextarea, { style: { ...S.input, minHeight: '80px' }, value: cardDraft.postHistoryInstructions, onChange: e => setCardDraft({ ...cardDraft, postHistoryInstructions: e.target.value }) })),
              h(Field, { label: '深度提示' }, h(AutoResizeTextarea, { style: { ...S.input, minHeight: '80px' }, value: cardDraft.depthPrompt, onChange: e => setCardDraft({ ...cardDraft, depthPrompt: e.target.value }) })),
            ])
          ]) : h('div', { key: 'bookForm', style: S.card }, [
            h('div', { key: 'top', style: S.between }, [
              h('span', { key: 't', style: { ...S.name, fontSize: '16px' } }, editingId ? '编辑世界书' : '新建世界书'),
              h('div', { key: 'acts', style: S.row }, [
                h(Btn, { onClick: exportJson }, '导出 JSON'),
                h(Btn, { variant: 'primary', onClick: saveBook, disabled: busy }, busy ? '保存中…' : '保存到库'),
              ])
            ]),
            h(Field, { label: '世界书名称' }, h('input', { style: S.input, value: bookDraft.name, onChange: e => setBookDraft({ ...bookDraft, name: e.target.value }), placeholder: '如：异世界地理志' })),
            
            h('div', { style: { display: 'flex', gap: '16px', marginTop: '16px', alignItems: 'flex-start' } }, [
              // 条目列表
              h('div', { style: { flex: '0 0 200px', display: 'flex', flexDirection: 'column', gap: '6px' } }, [
                h(Btn, { onClick: addBookEntry, style: { width: '100%' } }, '+ 添加条目'),
                bookDraft.entries.map((entry, idx) => h('div', { key: idx, style: { ...S.item, padding: '8px', cursor: 'pointer', outline: editingEntryIndex === idx ? '2px solid var(--dsw-alias-brand-primary)' : 'none' }, onClick: () => setEditingEntryIndex(idx) }, [
                  h('div', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.comment || '未命名'),
                  h(Btn, { variant: 'danger', style: { padding: '2px 6px' }, onClick: (e) => { e.stopPropagation(); removeBookEntry(idx) } }, '×')
                ]))
              ]),
              // 条目详情
              h('div', { style: { flex: '1 1 auto', padding: '16px', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '8px' } }, editingEntryIndex >= 0 && bookDraft.entries[editingEntryIndex] ? (() => {
                const ent = bookDraft.entries[editingEntryIndex]
                const up = (p) => updateEntry(editingEntryIndex, p)
                return [
                  h('div', { key: 'n', style: S.grid }, [
                    h(Field, { label: '标题/备注' }, h('input', { style: S.input, value: ent.comment, onChange: e => up({ comment: e.target.value }) })),
                    h(Field, { label: '触发概率 (0-100)' }, h('input', { type: 'number', style: S.input, value: ent.probability, onChange: e => up({ probability: Number(e.target.value) }) })),
                    h(Field, { label: '位置 (0背景, 1补充, 4实时)' }, h('select', { style: S.select, value: ent.position, onChange: e => up({ position: Number(e.target.value) }) }, [0,1,4].map(v => h('option', { key: v, value: v }, v)))),
                  ]),
                  h('div', { key: 'c', style: S.row }, [
                    h('label', { style: S.check }, [h('input', { type: 'checkbox', checked: ent.enabled, onChange: e => up({ enabled: e.target.checked }) }), '启用']),
                    h('label', { style: S.check }, [h('input', { type: 'checkbox', checked: ent.constant, onChange: e => up({ constant: e.target.checked }) }), '常驻（免关键词）']),
                  ]),
                  !ent.constant ? h('div', { key: 'keys' }, [
                    h(Field, { label: '主关键词（逗号分隔）' }, h('input', { style: S.input, value: ent.keys.join(', '), onChange: e => up({ keys: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }) })),
                    h(Field, { label: '次关键词（逗号分隔）' }, h('input', { style: S.input, value: ent.secondaryKeys.join(', '), onChange: e => up({ secondaryKeys: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }) })),
                  ]) : null,
                  h(Field, { label: '条目内容' }, h(AutoResizeTextarea, { style: { ...S.input, minHeight: '200px' }, value: ent.content, onChange: e => up({ content: e.target.value }) }))
                ]
              })() : h('div', { style: S.muted }, '请选择左侧条目进行编辑，或新建一个条目。'))
            ])
          ])
        ])
      ])
    }

    // -----------------------------------------------------------------------
    // PresetsTab
    // -----------------------------------------------------------------------

    const DEFAULT_TOOL_ALLOWLIST = ['read', 'write', 'edit']
    const GENDERS = [{ value: '', label: '未指定' }, { value: '男', label: '男' }, { value: '女', label: '女' }]
    const LANGUAGES = [{ value: '', label: '自动（不指定）' }, { value: '简体中文', label: '简体中文' }, { value: '繁體中文', label: '繁體中文' }, { value: 'English', label: 'English' }, { value: '日本語', label: '日本語' }, { value: '한국어', label: '한국어' }]
    
    const BLOCKS = [
      { id: 'identity', title: '身份声明', order: 200 }, { id: 'stage', title: '舞台之外', order: 210 }, { id: 'agency', title: '关于你自己', order: 220 },
      { id: 'pacing', title: '对话节奏', order: 230 }, { id: 'gender', title: '关于玩家', order: 240 }, { id: 'language', title: '输出语言', order: 250 },
      { id: 'description', title: '角色简介', order: 260 }, { id: 'personality', title: '性格', order: 270 }, { id: 'scenario', title: '场景', order: 280 },
      { id: 'greeting', title: '你的开场白', order: 290 }, { id: 'examples', title: '对话示例', order: 300 }, { id: 'extra', title: '附加作者指令', order: 310 },
      { id: 'cardSystem', title: '角色专属系统指令', order: 320 }, { id: 'skills', title: '这个角色掌握的能力', order: 330 }, { id: 'style', title: '输出风格', order: 340 },
      { id: 'depth', title: '角色的持续提醒', order: 350 }, { id: 'postHistory', title: '每轮都要遵守', order: 360 },
    ]

    function normalizeBlocksClient(raw, options, defs) {
      const src = raw && typeof raw === 'object' ? raw : {}
      const list = Array.isArray(defs) && defs.length > 0 ? defs : BLOCKS
      const out = {}
      for (const def of list) {
        const item = src[def.id] || {}
        out[def.id] = { enabled: item.enabled !== false, order: Number.isFinite(item.order) ? item.order : null, text: typeof item.text === 'string' ? item.text : null }
      }
      if (options && options.enableTools === false && out.agency) out.agency.enabled = false
      return out
    }

    function splitSections(list, requiredSections, toolPrefix) {
      const required = [], tools = [], optional = []
      for (const s of list) {
        if (requiredSections.includes(s.name)) required.push(s)
        else if (s.name.startsWith(toolPrefix)) tools.push(s)
        else optional.push(s)
      }
      return { required, tools, optional }
    }
    function toolSectionChecked(name, draft, toolPrefix) {
      if (!name.startsWith(toolPrefix)) return false
      if (draft.enableTools === false) return false
      const allow = Array.isArray(draft.toolAllowlist) ? draft.toolAllowlist : []
      if (allow.length === 0) return true
      return allow.includes(name.slice(toolPrefix.length))
    }

    function BlockEditor(props) {
      const { draft, setDraft, availableBlocks } = props
      const defs = Array.isArray(props.blockDefs) && props.blockDefs.length > 0 ? props.blockDefs : BLOCKS
      const [editing, setEditing] = useState('')
      const [buffer, setBuffer] = useState('')
      const states = normalizeBlocksClient(draft.blocks, draft, defs)
      const info = new Map((Array.isArray(availableBlocks) ? availableBlocks : []).map((b) => [b.id, b]))

      const orderOf = (def) => {
        const state = states[def.id] || {}
        if (Number.isFinite(state.order)) return state.order
        const meta = info.get(def.id); if (meta && Number.isFinite(meta.order)) return meta.order
        return def.order
      }
      const sorted = defs.slice().sort((a, b) => orderOf(a) - orderOf(b))

      const setBlock = (id, patch) => setDraft((d) => {
        const next = normalizeBlocksClient(d.blocks, d, defs); next[id] = { ...next[id], ...patch }
        return { ...d, blocks: next }
      })
      const setAll = (enabled) => setDraft((d) => {
        const next = normalizeBlocksClient(d.blocks, d, defs)
        for (const def of defs) next[def.id] = { ...next[def.id], enabled }
        return { ...d, blocks: next }
      })
      const move = (def, delta) => {
        const visible = sorted.filter((d) => states[d.id] && states[d.id].enabled !== false)
        const at = visible.findIndex((d) => d.id === def.id); if (at < 0) return
        const other = visible[at + delta]; if (!other) return
        const a = orderOf(def), b = orderOf(other)
        setDraft((d) => {
          const next = normalizeBlocksClient(d.blocks, d, defs)
          next[def.id] = { ...next[def.id], order: a === b ? b + delta : b }
          next[other.id] = { ...next[other.id], order: a === b ? a - delta : a }
          return { ...d, blocks: next }
        })
      }
      const openEditor = (def) => {
        if (editing === def.id) { setEditing(''); return }
        const state = states[def.id] || {}; const meta = info.get(def.id)
        setBuffer(typeof state.text === 'string' ? state.text : (meta ? meta.template : ''))
        setEditing(def.id)
      }

      const rows = sorted.map((def) => {
        const state = states[def.id] || {}; const meta = info.get(def.id)
        const enabled = state.enabled !== false; const overridden = typeof state.text === 'string'
        const editable = overridden || !!meta; const chars = meta ? meta.chars : null
        const isEmpty = meta ? meta.empty === true : (overridden && state.text.length === 0)

        const row = h('div', { key: def.id, style: { ...S.blockRow, ...(!enabled ? S.blockRowDisabled : {}) } }, [
          h('input', { key: 'c', type: 'checkbox', checked: enabled, onChange: (e) => setBlock(def.id, { enabled: e.target.checked }) }),
          h('span', { key: 'o', style: { ...S.muted, fontFamily: 'monospace', width: '30px' } }, String(orderOf(def))),
          h('span', { key: 't', style: { flex: '1 1 140px', minWidth: 0, fontWeight: enabled ? 500 : 400 } }, def.title),
          overridden ? h('span', { key: 'ov', style: S.blockTag }, '已覆盖') : null,
          isEmpty ? h('span', { key: 'em', style: S.blockTag }, '空') : null,
          chars !== null && chars > 0 ? h('span', { key: 'ch', style: S.blockTag }, `${chars} 字`) : null,
          h('div', { key: 'act', style: { display: 'flex', gap: '4px', marginLeft: 'auto' } }, [
            h(Btn, { key: 'e', variant: 'icon', disabled: !editable, onClick: () => openEditor(def) }, editing === def.id ? '收起' : '编辑'),
            h(Btn, { key: 'u', variant: 'icon', disabled: !enabled, onClick: () => move(def, -1) }, h(Icon, { name: 'chevronUp', size: 11 })),
            h(Btn, { key: 'd', variant: 'icon', disabled: !enabled, onClick: () => move(def, 1) }, h(Icon, { name: 'chevronDown', size: 11 })),
            h(Btn, { key: 'r', variant: 'icon', disabled: !overridden, onClick: () => setBlock(def.id, { text: null }) }, '重置'),
          ])
        ])
        if (editing !== def.id) return row
        return h('div', { key: `${def.id}-box`, style: { marginBottom: '12px', padding: '0 12px' } }, [
          row,
          def.id === 'agency' ? h('div', { key: 'warn', style: { ...S.muted, margin: '4px 0 8px' } }, '保留 {{bard_tools}} 与 {{bard_workspace}} 才会显示实时工具清单与工作区路径。') : null,
          h(AutoResizeTextarea, { key: 'ta', style: { ...S.input, minHeight: '160px', fontFamily: 'monospace', background: 'var(--dsw-alias-bg-base)' }, value: buffer, onChange: (e) => setBuffer(e.target.value) }),
          h('div', { key: 'a', style: { ...S.row, marginTop: '8px' } }, [
            h(Btn, { key: 's', variant: 'primary', onClick: () => { setBlock(def.id, { text: buffer }); setEditing('') } }, '保存文案'),
            h(Btn, { key: 'c', onClick: () => setEditing('') }, '取消'),
            h(Btn, { key: 'r', onClick: () => { setBlock(def.id, { text: null }); setEditing('') } }, '恢复默认'),
          ]),
        ])
      })

      return h('div', null, [
        h('div', { key: 'hint', style: { ...S.muted, marginBottom: '12px' } }, '每块都是独立的系统提示 section：可单独停用、调顺序、改写文案。改写只作用于这个预设，不改角色卡；「重置」让它重新跟随角色卡。'),
        h('div', { key: 'list', style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, rows),
        h('div', { key: 'act', style: { ...S.row, marginTop: '16px', paddingTop: '12px', borderTop: '1px solid var(--dsw-alias-border-l1)' } }, [
          h(Btn, { key: 'on', onClick: () => setAll(true) }, '全部启用'),
          h(Btn, { key: 'off', onClick: () => setAll(false) }, '全部停用'),
          h(Btn, { key: 'rst', onClick: () => setDraft((d) => { const next = normalizeBlocksClient(d.blocks, d, defs); for (const def of defs) next[def.id] = { ...next[def.id], order: null }; return { ...d, blocks: next } }) }, '恢复默认顺序'),
        ]),
      ])
    }

    // -----------------------------------------------------------------------
    // Alzheimer Settings (独立分区)
    // -----------------------------------------------------------------------

    function AlzheimerSettings() {
      const [state, setState] = useState(null)
      const [failure, setFailure] = useState('')
      const [notice, setNotice] = useState(null)
      const [selectedId, setSelectedId] = useState('')

      const notify = useCallback((text, kind) => { setNotice({ text, kind: kind === 'error' ? 'error' : 'info' }) }, [])
      const load = useCallback(async () => {
        try {
          const next = await call('/memory/state')
          setState(next)
          setFailure('')
        } catch (error) { setFailure(String((error && error.message) || error)) }
      }, [])

      useEffect(() => { load() }, [load])

      if (failure) {
        return h('div', { className: 'dsh-bard-scope', style: S.page }, [
          h('div', { key: 't', style: S.name }, '阿尔兹海默'),
          h('div', { key: 'e', style: S.alert }, `读取失败：${failure}`),
          h(Btn, { key: 'r', onClick: load }, '重试'),
        ])
      }
      if (!state) return h('div', { className: 'dsh-bard-scope', style: S.page }, [h('div', { key: 'l', style: S.muted }, '正在读取…')])

      const personas = Array.isArray(state.personas) ? state.personas : []
      const effectiveId = selectedId && personas.some((p) => p.id === selectedId) ? selectedId : (personas[0]?.id || '')
      const selected = personas.find((p) => p.id === effectiveId)

      return h('div', { className: 'dsh-bard-scope', style: S.page }, [
        h('div', { key: 'head', style: S.between }, [
          h('div', { key: 'l' }, [
            h('div', { key: 't', style: { ...S.name, fontSize: '20px' } }, '阿尔兹海默'),
            h('div', { key: 's', style: { ...S.muted, marginTop: '4px' } }, '她的一生。记忆会散，但叙事还在。'),
          ]),
          h('span', { key: 'c', style: S.muted }, `${personas.length} 个人格`),
        ]),

        notice ? h('div', { key: 'n', style: notice.kind === 'error' ? S.alert : S.ok }, notice.text) : null,

        personas.length === 0
          ? h('div', { key: 'empty', style: S.card }, [
            h('div', { key: 't', style: S.name }, '还没有人格'),
            h('div', { key: 's', style: { ...S.muted, marginTop: '6px' } }, '在「预设」里创建一个预设，并为它绑定一个新人格。'),
          ])
          : h('div', { key: 'body', style: S.list }, [
            h('div', { key: 'sel', style: S.row }, [
              h('span', { key: 'l', style: S.label }, '选择人格'),
              h('select', {
                key: 's', style: { ...S.select, maxWidth: '400px' },
                value: effectiveId,
                onChange: (e) => setSelectedId(e.target.value),
              }, personas.map((p) => h('option', { key: p.id, value: p.id }, `${p.name || p.id} · 第 ${p.generation} 世`))),
            ]),
            selected ? renderPersonaDetail(selected, notify, load) : null,
          ]),
      ])
    }

    function renderPersonaDetail(persona, notify, reload) {
      const memories = Array.isArray(persona.memories) ? persona.memories : []
      const impressions = Array.isArray(persona.impressions) ? persona.impressions : []
      const active = memories.filter((m) => m.state === 'active' || m.state === 'held')
      const fading = memories.filter((m) => m.state === 'fading' || m.state === 'faded')
      const ratio = typeof persona.anchoredRatio === 'number' ? persona.anchoredRatio : 1
      return h('div', { key: 'detail', style: S.list }, [
               h('div', { key: 'stat', style: S.card }, [
          h('div', { key: 'head', style: S.between }, [
            h('div', { key: 't', style: S.name }, `${persona.name || persona.id}`),
            h(Btn, { 
              variant: 'danger', 
              onClick: async () => {
                if (!window.confirm(`彻底遗忘「${persona.name || persona.id}」？\n\n记忆、叙事和人格将被永久删除。这是不可逆的。`)) return
                try {
                  const res = await call('/persona/delete', { id: persona.id, force: true })
                  if (res.ok) {
                    notify('已遗忘。')
                    reload() // 刷新列表
                  } else {
                    notify(res.error || '遗忘失败', 'error')
                  }
                } catch (e) { notify(String(e.message), 'error') }
              } 
            }, '遗忘')
          ]),
          h('div', { key: 'm', style: { ...S.muted, marginTop: '6px' } }, [
            `第 ${persona.generation} 世`,
            `${active.length} 条清晰`,
            `${fading.length} 条模糊`,
            `${impressions.length} 条印象`,
            `带锚比例 ${(ratio * 100).toFixed(0)}%`,
          ].join(' · ')),
          h('div', { key: 'id', style: { ...S.muted, fontFamily: 'monospace', marginTop: '4px' } }, persona.id),
        ]),

        h(Section, { key: 'mem', title: `记忆（${memories.length}）`, defaultOpen: true }, [
          memories.length === 0 ? h('div', { key: 'e', style: S.muted }, '她还没有写下任何记忆。')
            : h('div', { key: 'list', style: S.list }, memories.slice().reverse().map((m) => h('div', { key: m.id, style: S.item }, [
              h('div', { key: 'm', style: S.grow }, [
                h('div', { key: 't', style: { ...S.prose, fontSize: '13px' } }, m.text),
                h('div', { key: 's', style: { ...S.muted, marginTop: '4px' } }, [
                  m.state === 'held' ? '抓住' : m.state === 'fading' ? '正在模糊' : m.state === 'faded' ? '已模糊' : '清晰',
                  `清晰度 ${(m.clarity * 100).toFixed(0)}%`,
                  `讲过 ${m.restateCount || 0} 次`,
                  m.scene ? `场景：${m.scene}` : '',
                ].filter(Boolean).join(' · ')),
              ]),
            ]))),
        ]),

        impressions.length > 0 ? h(Section, { key: 'imp', title: `印象（${impressions.length}）`, defaultOpen: false }, [
          h('div', { key: 'list', style: S.list }, impressions.map((imp) => h('div', { key: imp.id, style: S.item }, [
            h('div', { key: 'm', style: S.grow }, [
              h('div', { key: 't', style: { ...S.prose, fontSize: '13px', opacity: 0.7 } }, imp.text),
              h('div', { key: 's', style: { ...S.muted, marginTop: '4px' } }, `${imp.count} 条记忆的轮廓`),
            ]),
          ]))),
        ]) : null,

        h(Section, { key: 'nar', title: '叙事弧', defaultOpen: true }, [
          (persona.chapters || []).map((ch, i) => h('div', { key: i, style: { marginBottom: '12px' } }, [
            h('div', { key: 'h', style: { ...S.label } }, `第 ${ch.generation} 世${ch.endedAt ? '（已结束）' : '（此刻）'}`),
            ch.summary ? h('div', { key: 's', style: S.prose }, ch.summary) : h('div', { key: 'e', style: S.muted }, '还没有写下这一世的总结。'),
            ch.farewell ? h('div', { key: 'f', style: { ...S.quote, marginTop: '8px' } }, ch.farewell) : null,
          ])),
        ]),
      ])
    }

    function PresetsTab(props) {
      const { state, reload, notify, cardDetails, ensureCardDetail } = props
      const defaults = (state && state.defaults) || {}
      const defaultStyleHint = typeof defaults.styleHint === 'string' ? defaults.styleHint : ''
      const defaultWorkspacePrefix = typeof defaults.workspacePrefix === 'string' ? defaults.workspacePrefix : 'Bard_World'
      const availableTools = Array.isArray(state.availableTools) ? state.availableTools : []
      const availableSections = Array.isArray(state.availableSections) ? state.availableSections : []
      const bardRequiredSections = Array.isArray(state.bardRequiredSections) ? state.bardRequiredSections : []
      const toolSectionPrefix = typeof state.toolSectionPrefix === 'string' && state.toolSectionPrefix.length > 0 ? state.toolSectionPrefix : 'tool:'
      const blockDefs = Array.isArray(state.bardBlocks) && state.bardBlocks.length > 0 ? state.bardBlocks : BLOCKS

      const emptyDraft = useCallback(() => ({
        id: '', name: '', cardId: '', greetingIndex: null,  personaId: '',worldbookIds: [], skillNames: [],
        styleHint: defaultStyleHint, extraInstructions: '', complete: false, includeRuntimeContext: true,
        enableTools: true, toolAllowlist: DEFAULT_TOOL_ALLOWLIST.slice(), keepSections: [], keepSectionsEnabled: false,
        workspaceEnabled: true, workspacePrefix: defaultWorkspacePrefix,
        userName: '', userGender: '', outputLanguage: '', maxEntries: 12, maxChars: 6000,
        blocks: normalizeBlocksClient(null),
      }), [defaultStyleHint, defaultWorkspacePrefix])

      const [draft, setDraft] = useState(emptyDraft)
      const [busy, setBusy] = useState(false)
      const [greetFor, setGreetFor] = useState('')
      const [preview, setPreview] = useState(null)
      const [previewBusy, setPreviewBusy] = useState(false)
      const [wbExpanded, setWbExpanded] = useState(false)
      const [skExpanded, setSkExpanded] = useState(false)
      const set = (patch) => setDraft((current) => ({ ...current, ...patch }))

      const greetingsForDetail = (detail) => {
        if (!detail) return []
        const out = []
        if (detail.firstMes) out.push({ label: '开场白', text: detail.firstMes })
        ;(detail.alternateGreetings || []).forEach((text, index) => out.push({ label: `备用 ${index + 1}`, text }))
        return out
      }

      const edit = async (preset) => {
        setGreetFor(''); setPreview(null)
        let detail = null
        try { detail = await ensureCardDetail(preset.cardId) } catch (error) { notify(String((error && error.message) || error), 'error') }
        const greetings = greetingsForDetail(detail)
        const rawIndex = Number.isInteger(preset.options.greetingIndex) && preset.options.greetingIndex >= 0 ? preset.options.greetingIndex : null
        setDraft({
          personaId: preset.options.personaId || '',
          id: preset.id, name: preset.name, cardId: preset.cardId,
          greetingIndex: rawIndex !== null && rawIndex < greetings.length ? rawIndex : null,
          worldbookIds: preset.worldbookIds.slice(), skillNames: preset.skillNames.slice(),
          styleHint: preset.options.styleHint || '', extraInstructions: preset.options.extraInstructions || '',
          complete: preset.options.complete === true, includeRuntimeContext: preset.options.includeRuntimeContext !== false,
          enableTools: preset.options.enableTools !== false,
          toolAllowlist: Array.isArray(preset.options.toolAllowlist) ? preset.options.toolAllowlist.slice() : [],
          keepSections: Array.isArray(preset.options.keepSections) ? preset.options.keepSections : [],
          keepSectionsEnabled: preset.options.keepSectionsEnabled === true || (preset.options.keepSectionsEnabled === undefined && Array.isArray(preset.options.keepSections) && preset.options.keepSections.length > 0),
          workspaceEnabled: preset.options.workspaceEnabled !== false, workspacePrefix: preset.options.workspacePrefix || 'Bard_World',
          userName: preset.options.userName || '', userGender: preset.options.userGender || '',
          outputLanguage: preset.options.outputLanguage || '',
          maxEntries: Number.isFinite(preset.options.maxEntries) ? preset.options.maxEntries : 12,
          maxChars: Number.isFinite(preset.options.maxChars) ? preset.options.maxChars : 6000,
          blocks: normalizeBlocksClient(preset.options.blocks, preset.options, blockDefs),
        })
      }

      const toggle = (field, value) => {
        const list = draft[field].slice(); const at = list.indexOf(value)
        if (at >= 0) list.splice(at, 1); else list.push(value)
        set({ [field]: list })
      }
      const toggleKeepSection = (name, on) => {
        setDraft((d) => {
          const next = new Set(d.keepSections)
          if (on) { next.add(name); return { ...d, keepSections: [...next], complete: false } }
          next.delete(name); return { ...d, keepSections: [...next] }
        })
      }

      const save = async () => {
        if (!draft.cardId) { notify('请先选择一个角色卡', 'error'); return }
        setBusy(true)
        try {
          const result = await call('/preset', draft)
          notify(result.error ? `预设已保存，但注册到 DSH 时出错：${result.error}` : `已保存预设。到会话的预设选择器里选「吟游 · ${draft.name || '…'}」即可开始扮演。`, result.error ? 'error' : 'info')
          setPreview(null); setDraft(emptyDraft()); await reload()
        } catch (error) { notify(String((error && error.message) || error), 'error') } finally { setBusy(false) }
      }
      const runPreview = async () => {
        if (!draft.cardId) { notify('请先选择一个角色卡', 'error'); return }
        setPreviewBusy(true)
        try { const result = await call('/preset/preview', draft); setPreview(result) }
        catch (error) { notify(String((error && error.message) || error), 'error') } finally { setPreviewBusy(false) }
      }
      const remove = async (preset) => {
        if (!window.confirm(`删除预设「${preset.name}」？对应的 DSH 预设会同时注销。`)) return
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur()
        setBusy(true)
        try {
          await call('/preset/delete', { id: preset.id }); notify(`已删除预设「${preset.name}」`)
          if (draft.id === preset.id) setDraft(emptyDraft()); await reload()
        } catch (error) { notify(String((error && error.message) || error), 'error') } finally { setBusy(false) }
      }
      const toggleGreetFor = async (preset) => {
        if (greetFor === preset.id) { setGreetFor(''); return }
        try { await ensureCardDetail(preset.cardId); setGreetFor(preset.id) }
        catch (error) { notify(String((error && error.message) || error), 'error') }
      }

      const detail = draft.cardId ? cardDetails[draft.cardId] : null
      const greetings = greetingsForDetail(detail)
      const selectedGreeting = draft.greetingIndex !== null ? greetings[draft.greetingIndex] : undefined

      return h('div', { style: S.list }, [
        h('div', { key: 'form', style: S.card }, [
          h('div', { key: 'h', style: S.between }, [
            h('span', { key: 't', style: { ...S.name, fontSize: '16px' } }, draft.id ? '编辑预设' : '新建预设'),
            draft.id ? h(Btn, { key: 'c', onClick: () => { setPreview(null); setDraft(emptyDraft()) } }, '新建 / 取消编辑') : null,
          ]),

          h(Section, { key: 'sec-basic', title: '基础设定', defaultOpen: true }, [
            h('div', { key: 'f1', style: { ...S.grid, marginBottom: '12px' } }, [
              h(Field, { key: 'a', label: '预设名称' }, h('input', { style: S.input, value: draft.name, placeholder: '留空则使用角色名', onChange: (e) => set({ name: e.target.value }) })),
              h(Field, { key: 'b', label: '角色卡' }, h('select', { style: S.select, value: draft.cardId, onChange: async (e) => {
                const nextCardId = e.target.value; let dtl = null
                try { if (nextCardId) dtl = await ensureCardDetail(nextCardId) } catch (error) { notify(String((error && error.message) || error), 'error') }
                const nextGreetings = greetingsForDetail(dtl)
                setDraft((d) => ({ ...d, cardId: nextCardId, greetingIndex: Number.isInteger(d.greetingIndex) && d.greetingIndex < nextGreetings.length ? d.greetingIndex : null }))
              } }, [
                h('option', { key: '', value: '' }, '— 请选择 —'),
                ...state.cards.map((card) => h('option', { key: card.id, value: card.id }, card.name)),
              ])),
            ]),
                        h(Field, { key: 'persona', label: '绑定人格（阿尔兹海默）' }, [
              h('div', { key: 'row', style: { ...S.row, alignItems: 'stretch' } }, [
                h('select', { 
                  style: { ...S.select, flex: '1 1 auto' }, 
                  value: draft.personaId, 
                  onChange: (e) => set({ personaId: e.target.value }) 
                }, [
                  h('option', { key: '', value: '' }, '— 不绑定（普通模式） —'),
                  ...state.personas.map((p) => h('option', { key: p.id, value: p.id }, `${p.name}（第 ${p.generation} 世）`))
                ]),
                h(Btn, { 
                  onClick: async () => {
                    try {
                      const res = await call('/persona/create', { cardId: draft.cardId, name: draft.name });
                      notify('人格已创建并绑定');
                      set({ personaId: res.persona.id });
                      await reload();
                    } catch (e) { notify(String(e.message), 'error') }
                  } 
                }, '+ 新建人格')
              ])
            ]),
            h('div', { key: 'f2', style: { ...S.grid, marginBottom: '12px' } }, [
              h(Field, { key: 'greet', label: '开场白注入（可选）' }, [
                h('select', { key: 'sel', style: S.select, value: draft.greetingIndex === null ? '' : String(draft.greetingIndex), disabled: greetings.length === 0, onChange: (e) => set({ greetingIndex: e.target.value === '' ? null : Number(e.target.value) }) }, [
                  h('option', { key: '', value: '' }, greetings.length === 0 ? '（这张角色卡没有开场白）' : '不注入'),
                  ...greetings.map((g, i) => h('option', { key: String(i), value: String(i) }, g.label)),
                ]),
                selectedGreeting ? h('details', { key: 'preview', style: { marginTop: '6px' } }, [h('summary', { key: 's', style: { cursor: 'pointer', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, `预览：${selectedGreeting.label}`), h('div', { key: 'p', style: { ...S.quote, marginTop: '8px' } }, selectedGreeting.text)]) : null,
              ]),
              h(Field, { key: 'un', label: '你的名字（替换 {{user}}）' }, h('input', { style: S.input, value: draft.userName, placeholder: '留空则使用 User', onChange: (e) => set({ userName: e.target.value }) })),
              h(Field, { key: 'ug', label: '玩家性别' }, h('select', { style: S.select, value: GENDERS.some((item) => item.value === draft.userGender) ? draft.userGender : (draft.userGender ? '__custom__' : ''), onChange: (e) => {
                const value = e.target.value
                if (value === '__custom__') { const custom = window.prompt('请输入性别', draft.userGender || ''); if (custom !== null) set({ userGender: custom.trim() }); return }
                set({ userGender: value })
              } }, [
                ...GENDERS.map((item) => h('option', { key: item.value, value: item.value }, item.label)),
                draft.userGender && !GENDERS.some((item) => item.value === draft.userGender) ? h('option', { key: '__custom_current__', value: '__custom__' }, `自定义：${draft.userGender}`) : h('option', { key: '__custom__', value: '__custom__' }, '自定义…'),
              ])),
              h(Field, { key: 'ol', label: '输出语言' }, h('select', { style: S.select, value: LANGUAGES.some((lang) => lang.value === draft.outputLanguage) ? draft.outputLanguage : (draft.outputLanguage ? '__custom__' : ''), onChange: (e) => {
                const value = e.target.value
                if (value === '__custom__') { const custom = window.prompt('请输入语言名', draft.outputLanguage || ''); if (custom !== null) set({ outputLanguage: custom.trim() }); return }
                set({ outputLanguage: value })
              } }, [
                ...LANGUAGES.map((lang) => h('option', { key: lang.value, value: lang.value }, lang.label)),
                draft.outputLanguage && !LANGUAGES.some((lang) => lang.value === draft.outputLanguage) ? h('option', { key: '__custom_current__', value: '__custom__' }, `自定义：${draft.outputLanguage}`) : h('option', { key: '__custom__', value: '__custom__' }, '自定义…'),
              ])),
            ]),
            
            h('div', { key: 'wb', style: { marginTop: '16px' } }, [
              h('div', { key: 'l', style: { ...S.label, display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, [h('span', null, `世界书（${draft.worldbookIds.length} 已选）`), h(Btn, { key: 't', onClick: () => setWbExpanded(!wbExpanded) }, wbExpanded ? '收起列表' : '选择…')]),
              draft.worldbookIds.length > 0 ? h('div', { key: 's', style: { ...S.muted, marginBottom: '8px' } }, draft.worldbookIds.map((id) => (state.worldbooks.find((b) => b.id === id) || {}).name || id).join('、')) : null,
              wbExpanded ? (state.worldbooks.length === 0 ? h('div', { key: 'e', style: S.muted }, '还没有世界书。') : h('div', { key: 'g', style: S.grid }, state.worldbooks.map((book) => h('label', { key: book.id, style: S.check }, [h('input', { type: 'checkbox', checked: draft.worldbookIds.includes(book.id), onChange: () => toggle('worldbookIds', book.id) }), h('span', null, `${book.name}（${book.entryCount}）`)])))) : null,
            ]),

            h('div', { key: 'sk', style: { marginTop: '16px' } }, [
              h('div', { key: 'l', style: { ...S.label, display: 'flex', justifyContent: 'space-between', alignItems: 'center' } }, [h('span', null, `技能（${draft.skillNames.length} 已选）`), h(Btn, { key: 't', onClick: () => setSkExpanded(!skExpanded) }, skExpanded ? '收起列表' : '选择…')]),
              draft.skillNames.length > 0 ? h('div', { key: 's', style: { ...S.muted, marginBottom: '8px' } }, draft.skillNames.join('、')) : null,
              skExpanded ? (state.skills.length === 0 ? h('div', { key: 'e', style: S.muted }, '本机没有可用的 Skill。') : h('div', { key: 'g', style: S.grid }, state.skills.map((skill) => h('label', { key: skill.name, style: S.check, title: skill.description }, [h('input', { type: 'checkbox', checked: draft.skillNames.includes(skill.name), onChange: () => toggle('skillNames', skill.name) }), h('span', null, skill.name)])))) : null,
            ]),
          ]),

          h(Section, { key: 'sec-blocks', title: '提示词编排', defaultOpen: false }, [
            h(BlockEditor, { key: 'blocks', draft, setDraft, availableBlocks: preview ? preview.blocks : [], blockDefs }),
          ]),

          h(Section, { key: 'sec-adv', title: '高级设置与风格', defaultOpen: false }, [
            h('div', { key: 'tools', style: { marginBottom: '16px' } }, [
              h('label', { key: 'c', style: S.check }, [h('input', { type: 'checkbox', checked: draft.enableTools !== false, onChange: (e) => set(e.target.checked ? { enableTools: true, toolAllowlist: DEFAULT_TOOL_ALLOWLIST.slice() } : { enableTools: false }) }), h('span', { key: 't', style: { fontWeight: 600 } }, '引导角色使用工具')]),
              draft.enableTools !== false ? h('div', { key: 'opts', style: { paddingLeft: '24px', marginTop: '8px' } }, [
                h('label', { key: 'ws', style: S.check }, [h('input', { type: 'checkbox', checked: draft.workspaceEnabled !== false, onChange: (e) => set({ workspaceEnabled: e.target.checked }) }), h('span', null, '为每个对话建立专属工作区')]),
                draft.workspaceEnabled !== false ? h('div', { key: 'wsp', style: { marginTop: '8px' } }, [h('span', { key: 'l', style: S.label }, '工作区前缀'), h('input', { key: 'i', style: { ...S.input, maxWidth: '280px' }, value: draft.workspacePrefix, placeholder: 'Bard_World', onChange: (e) => set({ workspacePrefix: e.target.value }) })]) : null,
                h('details', { key: 'tools-allow', style: { marginTop: '12px' } }, [
                  h('summary', { key: 's', style: { cursor: 'pointer', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, `工具白名单（${draft.toolAllowlist.length} / ${availableTools.length} 已选）`),
                  availableTools.length === 0 ? h('div', { key: 'e', style: { ...S.muted, marginTop: '6px' } }, '尚未采集到工具清单。') : h('div', { key: 'g', style: { ...S.grid, marginTop: '8px' } }, availableTools.map((name) => h('label', { key: name, style: S.check }, [h('input', { type: 'checkbox', checked: draft.toolAllowlist.includes(name), onChange: () => toggle('toolAllowlist', name) }), h('span', null, name)]))),
                ]),
              ]) : null,
            ]),

            h('div', { key: 'sections', style: { marginBottom: '16px' } }, [
              h('label', { key: 't', style: S.check }, [h('input', { type: 'checkbox', checked: draft.keepSectionsEnabled, onChange: (e) => setDraft((d) => ({ ...d, keepSectionsEnabled: e.target.checked, ...(e.target.checked ? { complete: false } : {}) })) }), h('span', { key: 'l', style: { fontWeight: 600 } }, '启用 Section 白名单')]),
              draft.keepSectionsEnabled ? h('div', { key: 'b', style: { paddingLeft: '24px', marginTop: '8px' } }, [
                (() => {
                  if (availableSections.length === 0) return h('div', { key: 'e', style: S.muted }, '尚未采集到 section 清单。')
                  const groups = splitSections(availableSections, bardRequiredSections, toolSectionPrefix)
                  const renderRow = (s, checked, disabled, onChange) => h('label', { key: s.name, style: { ...S.check, opacity: disabled ? 0.6 : 1 } }, [h('input', { type: 'checkbox', checked, disabled, onChange: disabled ? undefined : (e) => onChange(e.target.checked) }), h('span', null, ` ${s.name} (${s.chars})`)])
                  return [
                    groups.required.length > 0 ? h('div', { key: 'req', style: { marginTop: '6px' } }, [h('div', { key: 'l', style: S.label }, 'Bard 必需'), h('div', { key: 'g', style: S.grid }, groups.required.map((s) => renderRow(s, true, true, () => {})))]) : null,
                    groups.tools.length > 0 ? h('div', { key: 'tool', style: { marginTop: '12px' } }, [h('div', { key: 'l', style: S.label }, '工具相关'), h('div', { key: 'g', style: S.grid }, groups.tools.map((s) => renderRow(s, toolSectionChecked(s.name, draft, toolSectionPrefix), true, () => {})))]) : null,
                    groups.optional.length > 0 ? h('div', { key: 'opt', style: { marginTop: '12px' } }, [h('div', { key: 'l', style: S.label }, '其他 section'), h('div', { key: 'g', style: S.grid }, groups.optional.map((s) => renderRow(s, draft.keepSections.includes(s.name), false, (on) => toggleKeepSection(s.name, on))))]) : null,
                  ]
                })(),
              ]) : null,
            ]),

            h(Field, { key: 'sh', label: '输出风格' }, h(AutoResizeTextarea, { style: { ...S.input, minHeight: '80px' }, value: draft.styleHint, onChange: (e) => set({ styleHint: e.target.value }) })),
            h(Field, { key: 'ei', label: '附加作者指令' }, h(AutoResizeTextarea, { style: { ...S.input, minHeight: '80px' }, value: draft.extraInstructions, placeholder: '例如：多用环境描写；不要替玩家决定行动。', onChange: (e) => set({ extraInstructions: e.target.value }) })),

            h('div', { key: 'adv', style: { ...S.grid, marginTop: '16px' } }, [
              h('label', { key: 'c', style: S.check }, [h('input', { type: 'checkbox', checked: draft.complete, onChange: (e) => setDraft((d) => ({ ...d, complete: e.target.checked, ...(e.target.checked ? { keepSectionsEnabled: false, keepSections: [] } : {}) })) }), h('span', { key: 't' }, '完全接管系统提示（complete）')]),
              h('label', { key: 'r', style: S.check }, [h('input', { type: 'checkbox', checked: draft.includeRuntimeContext, onChange: (e) => set({ includeRuntimeContext: e.target.checked }) }), h('span', { key: 't' }, '注入运行环境信息')]),
              h('div', { key: 'n1', style: S.row }, [h('span', { style: S.label }, '世界书最多条数'), h('input', { type: 'number', style: { ...S.input, width: '80px' }, value: draft.maxEntries, onChange: (e) => set({ maxEntries: Number(e.target.value) || 12 }) })]),
              h('div', { key: 'n2', style: S.row }, [h('span', { style: S.label }, '最多字符数'), h('input', { type: 'number', style: { ...S.input, width: '100px' }, value: draft.maxChars, onChange: (e) => set({ maxChars: Number(e.target.value) || 6000 }) })]),
            ]),
          ]),

          h('div', { key: 'footer', style: S.stickyFooter }, [
            h(Btn, { key: 's', variant: 'primary', disabled: busy || !draft.cardId, onClick: save }, busy ? '保存中…' : (draft.id ? '保存修改' : '保存为 DSH 预设')),
            h(Btn, { key: 'p', disabled: previewBusy || !draft.cardId, onClick: runPreview }, previewBusy ? '生成中…' : '预览提示词块'),
            preview ? h(Btn, { key: 'c', onClick: () => setPreview(null) }, '关闭预览') : null,
          ]),
        ]),

        preview ? h('div', { key: 'preview', style: S.card }, [
          h('div', { key: 'h', style: S.between }, [
            h('span', { key: 't', style: { ...S.name, fontSize: '15px' } }, '提示词块预览'),
            h('span', { key: 'c', style: S.muted }, `${preview.chars} 字符 · 约 ${preview.tokenEstimate} token · 卡语言：${preview.cardLanguage}`),
          ]),
          preview.warnings && preview.warnings.length > 0 ? h('div', { key: 'w', style: { ...S.alert, marginTop: '10px' } }, preview.warnings.map((line, at) => h('div', { key: at }, line))) : null,
          h('div', { key: 'blocks', style: { marginTop: '16px' } }, [
            h('div', { key: 'l', style: S.label }, `块清单（${preview.blocks.length} 个，按 order 排列）`),
            h('div', { key: 'list', style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, preview.blocks.slice().sort((a, b) => a.order - b.order).map((b) => h('div', { key: b.id, style: { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px', opacity: b.enabled ? 1 : 0.5, padding: '6px 10px', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '6px' } }, [
              h('span', { key: 's', style: { width: '14px', display: 'flex', justifyContent: 'center', color: b.enabled ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)' } }, h(Icon, { name: b.enabled ? 'check' : 'close', size: 11 })),
              h('span', { key: 'o', style: { ...S.muted, fontFamily: 'monospace', width: '30px' } }, String(b.order)),
              h('span', { key: 't', style: { flex: '1 1 auto', fontWeight: 500 } }, b.title),
              b.source === 'override' ? h('span', { key: 'ov', style: S.blockTag }, '已覆盖') : null,
              b.empty ? h('span', { key: 'e', style: S.blockTag }, '空') : null,
              h('span', { key: 'c', style: S.muted }, `${b.chars} 字`),
            ]))),
          ]),
          h('details', { key: 'full', style: { marginTop: '16px' } }, [
            h('summary', { key: 's', style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontWeight: 500 } }, `展开完整拼接文本（${preview.assembled.length} 字符）`),
            h('pre', { key: 'p', style: S.pre }, preview.assembled),
          ]),
        ]) : null,

        state.presets.length === 0 ? h('div', { key: 'empty', style: S.muted }, '还没有预设。')
          : h('div', { key: 'list', style: { marginTop: '16px' } }, [
            h('div', { key: 'l', style: { ...S.label, fontSize: '14px', marginBottom: '12px' } }, '已保存的预设'),
            ...state.presets.map((preset) => h('div', { key: preset.id, style: { ...S.item, marginBottom: '8px' } }, [
              h('div', { key: 'm', style: S.grow }, [
                h('div', { key: 'n', style: { ...S.name, fontSize: '14px' } }, preset.name),
                h('div', { key: 's', style: { ...S.muted, marginTop: '4px' } }, [`角色 ${preset.cardName}`, `${preset.worldbookIds.length} 本世界书`, `${preset.skillNames.length} 个技能`, preset.options.complete ? '完全接管系统提示' : '', Number.isInteger(preset.options.greetingIndex) && preset.options.greetingIndex >= 0 ? `开场白 #${preset.options.greetingIndex + 1}` : '', preset.options.enableTools === false ? '禁用工具调用' : '', preset.options.enableTools !== false && Array.isArray(preset.options.toolAllowlist) && preset.options.toolAllowlist.length > 0 ? `工具白名单 ${preset.options.toolAllowlist.length} 项` : '', preset.options.userName ? `称呼 ${preset.options.userName}` : '', preset.options.userGender ? `性别 ${preset.options.userGender}` : ''].filter(Boolean).join(' · ')),
                h('div', { key: 'id', style: { ...S.muted, fontFamily: 'monospace', marginTop: '4px' } }, `DSH 预设 ID：${preset.dshPresetId}`),
                preset.error ? h('div', { key: 'e', style: { ...S.muted, color: 'var(--dsw-alias-state-error-primary)', marginTop: '4px' } }, `注册错误：${preset.error}`) : null,
                h('div', { key: 'b', style: { ...S.row, marginTop: '10px' } }, [
                  h(Btn, { key: 'e', onClick: () => { edit(preset).catch(() => {}) } }, '编辑'),
                  h(Btn, { key: 'g', onClick: () => { toggleGreetFor(preset).catch(() => {}) } }, greetFor === preset.id ? '收起开场白' : '输出开场白'),
                  h(Btn, { key: 'x', variant: 'danger', disabled: busy, onClick: () => remove(preset) }, '删除'),
                ]),
                greetFor === preset.id ? h('div', { key: 'gb', style: { marginTop: '12px' } }, h(GreetingBlock, { greetings: greetingsForDetail(cardDetails[preset.cardId]) })) : null,
              ]),
            ])),
          ]),

        h('div', { key: 'cmd', style: { ...S.card, marginTop: '16px' } }, [
          h('div', { key: 't', style: { ...S.name, fontSize: '14px' } }, '聊天里的快捷命令'),
          h('pre', { key: 'p', style: S.pre }, ['/bard           列出所有 Bard 预设', '/bard card      显示当前会话扮演的角色', '/bard greet     输出当前会话角色卡的开场白', '/bard greet 2   输出第 2 条开场白（备用开场白 1）'].join('\n')),
        ]),
      ])
    }

    // -----------------------------------------------------------------------
    // Shell & App
    // -----------------------------------------------------------------------

    const TABS = [{ id: 'cards', label: '角色卡' }, { id: 'worldbooks', label: '世界书' }, { id: 'skills', label: '技能' }, { id: 'presets', label: '预设' }, { id: 'creator', label: '女娲' }]

    function BardSettings() {
      const [state, setState] = useState(null)
      const [tab, setTab] = useState('presets')
      const [notice, setNotice] = useState(null)
      const [failure, setFailure] = useState('')
      const [creatorBook, setCreatorBook] = useState(null)

      const notify = useCallback((text, kind) => { setNotice({ text, kind: kind === 'error' ? 'error' : 'info' }) }, [])
      const load = useCallback(async (silent) => {
        try { const next = await call('/state'); setState(next); setFailure(''); return next }
        catch (error) { if (!silent) setFailure(String((error && error.message) || error)); return undefined }
      }, [])

      useEffect(() => {
        let live = true
        load().then((next) => {
          if (!live) return
          if (next && next.presets.length === 0 && next.cards.length === 0) setTab('creator')
          else if (next && next.presets.length === 0) setTab('presets')
        })
        return () => { live = false }
      }, [load])

      const counts = useMemo(() => {
        if (!state) return {}
        return { cards: state.cards.length, worldbooks: state.worldbooks.length, skills: state.skills.length, presets: state.presets.length }
      }, [state])

      const reload = useCallback(() => load(true), [load])
      const [cardDetails, setCardDetails] = useState({})
      const inflightCardDetails = useRef(new Map())

      const ensureCardDetail = useCallback(async (id) => {
        if (typeof id !== 'string' || id.length === 0) throw new Error('缺少角色卡 id')
        if (cardDetails[id]) return cardDetails[id]
        if (inflightCardDetails.current.has(id)) return inflightCardDetails.current.get(id)
        const promise = call('/card/detail', { id }).then((result) => {
          setCardDetails((prev) => ({ ...prev, [id]: result.card })); return result.card
        }).finally(() => { inflightCardDetails.current.delete(id) })
        inflightCardDetails.current.set(id, promise); return promise
      }, [cardDetails])

      const invalidateCardDetail = useCallback((id) => {
        if (typeof id !== 'string' || id.length === 0) return
        setCardDetails((prev) => { if (!prev[id]) return prev; const next = { ...prev }; delete next[id]; return next })
      }, [])

      if (failure) {
        return h('div', { className: 'dsh-bard-scope', style: S.page }, [h('div', { key: 't', style: S.name }, '吟游'), h('div', { key: 'e', style: S.alert }, `读取吟游数据失败：${failure}`), h(Btn, { key: 'r', onClick: () => load() }, '重试')])
      }
      if (!state) return h('div', { className: 'dsh-bard-scope', style: S.page }, [h('div', { key: 'l', style: S.muted }, '正在读取吟游数据…')])

      const common = { state, reload, notify, cardDetails, ensureCardDetail, invalidateCardDetail }

      return h('div', { className: 'dsh-bard-scope', style: S.page }, [
        h('div', { key: 'head', style: { ...S.between, marginBottom: '8px' } }, [
          h('div', { key: 'l' }, [
            h('div', { key: 't', style: { ...S.name, fontSize: '20px' } }, '吟游'),
            h('div', { key: 's', style: { ...S.muted, marginTop: '4px' } }, '导入角色卡与世界书，挂上技能，保存成 DSH 预设后即可开始角色扮演。'),
          ]),
          h('div', { key: 'r', style: S.row }, [h('span', { key: 'c', style: S.muted }, `${counts.cards} 角色卡 · ${counts.worldbooks} 世界书 · ${counts.skills} 技能 · ${counts.presets} 预设`)]),
        ]),

        notice ? h('div', { key: 'n', style: { ...(notice.kind === 'error' ? S.alert : S.ok), display: 'flex', alignItems: 'flex-start', gap: '12px' } }, [
          h('span', { key: 't', style: { flex: '1 1 auto', minWidth: 0 } }, notice.text),
          h('button', { key: 'x', type: 'button', 'aria-label': '关闭提示', onClick: () => setNotice(null), style: { flex: '0 0 auto', display: 'flex', border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit', padding: '2px', marginTop: '2px', opacity: 0.7 } }, h(Icon, { name: 'close', size: 11 })),
        ]) : null,

        state.errors && state.errors.length > 0 ? h('div', { key: 'se', style: S.alert }, state.errors.map((line, at) => h('div', { key: at }, line))) : null,

        h('div', { key: 'tabs', style: S.tabs, role: 'tablist' }, TABS.map((item) => h('button', {
          key: item.id, type: 'button', role: 'tab', 'aria-selected': tab === item.id ? 'true' : 'false',
          className: `dsh-bard-tab${tab === item.id ? ' dsh-bard-tab-active' : ''}`,
          onClick: () => setTab(item.id),
        }, item.label))),

        tab === 'cards' ? h(CardsTab, { key: 'c', ...common, onExtractBook: (book) => { setCreatorBook(book); setTab('creator') } })
          : tab === 'worldbooks' ? h(BooksTab, { key: 'w', ...common })
            : tab === 'skills' ? h(SkillsTab, { key: 'k', ...common })
              : tab === 'presets' ? h(PresetsTab, { key: 'p', ...common })
                : h(CreatorTab, { key: 'crt', ...common, initialBook: creatorBook }),
      ])
    }

    if (typeof document !== 'undefined') ensureStyles()

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'bard', order: 25, label: '吟游' },
          BardSettings,
        ))
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'bard-memory', order: 26, label: '阿尔兹海默' },
          AlzheimerSettings,
        ))
      },
    }
  },
})
