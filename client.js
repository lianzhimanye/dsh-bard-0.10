/**
 * dsh-bard — Web settings page.
 *
 * Contributes one `settings.section` entry ("吟游") that manages everything the
 * Host half stores: character cards, world books, the Harness skills a character
 * may use, and the Bard presets that become native DSH agent presets.
 *
 * Deliberately dependency-free: only `react` is required, styling uses the
 * `--dsw-alias-*` theme tokens, and every operation goes through the Host's
 * `/dsh-bard/api/*` endpoints so the page never reimplements storage rules.
 */

window.__ModuleLoader__.load({
  id: 'dsh-bard',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const API = '/dsh-bard/api'

    // -----------------------------------------------------------------------
    // data access
    // -----------------------------------------------------------------------

    async function call(path, body) {
      const init = body === undefined
        ? { headers: { Accept: 'application/json' } }
        : { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) }
      // A request that never settles would leave a caller's busy flag latched
      // forever, so abort it and let the caller's error path run.
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
        try {
          data = await response.json()
        } catch (error) {
          data = {}
        }
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
    // styles
    // -----------------------------------------------------------------------

    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: '14px', color: 'var(--dsw-alias-label-primary)', fontSize: '13px', lineHeight: 1.6 },
      card: { border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: '10px', padding: '12px' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      between: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' },
      muted: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
      tabs: { display: 'flex', gap: '4px', borderBottom: '1px solid var(--dsw-alias-border-l1)', paddingBottom: '6px', flexWrap: 'wrap' },
      tab: {
        border: '1px solid transparent', background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
        borderRadius: '8px', padding: '5px 12px', cursor: 'pointer', fontSize: '13px', font: 'inherit',
      },
      tabActive: {
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)', fontWeight: 600,
      },
      button: {
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)', borderRadius: '8px', padding: '5px 11px',
        cursor: 'pointer', fontSize: '12px', font: 'inherit',
      },
      primary: {
        border: '1px solid var(--dsw-alias-brand-primary)', background: 'transparent',
        color: 'var(--dsw-alias-brand-primary)', borderRadius: '8px', padding: '5px 12px', cursor: 'pointer', fontSize: '12px', font: 'inherit',
      },
      danger: {
        border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary)', borderRadius: '8px', padding: '5px 11px',
        cursor: 'pointer', fontSize: '12px', font: 'inherit',
      },
      input: {
        border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)', borderRadius: '8px', padding: '5px 9px',
        fontSize: '12px', font: 'inherit', width: '100%', boxSizing: 'border-box',
      },
      selectLight: {
        border: '1px solid var(--dsw-alias-border-l2)', background: '#ffffff',
        color: '#000000', colorScheme: 'light', borderRadius: '8px', padding: '5px 9px',
        fontSize: '12px', font: 'inherit', width: '100%', boxSizing: 'border-box',
      },
      label: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', display: 'block', marginBottom: '3px' },
      list: { display: 'flex', flexDirection: 'column', gap: '8px' },
      item: {
        display: 'flex', gap: '10px', alignItems: 'flex-start', border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)', borderRadius: '10px', padding: '10px',
      },
      /** item 的可点击变体，用于卡片本身可展开/折叠时。 */
      itemClickable: {
        display: 'flex', gap: '10px', alignItems: 'flex-start', border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)', borderRadius: '10px', padding: '10px',
        cursor: 'pointer',
      },
      /** 详情块的 sticky 标题栏。负 margin 抵消 card 的 padding，让背景覆盖卡片顶部。 */
      stickyBar: {
        position: 'sticky',
        top: 0,
        zIndex: 5,
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        background: 'var(--dsw-alias-bg-layer-1)',
        margin: '-12px -12px 0',
        padding: '12px 12px 6px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        cursor: 'pointer',
      },
      thumb: { width: '48px', height: '48px', borderRadius: '8px', objectFit: 'cover', flex: '0 0 auto', background: 'var(--dsw-alias-bg-layer-2)' },
      grow: { flex: '1 1 240px', minWidth: '0' },
      name: { fontWeight: 600, fontSize: '13px' },
      pre: {
        whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--dsw-alias-bg-base)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px', padding: '9px',
        fontSize: '12px', maxHeight: '320px', overflow: 'auto', margin: '6px 0 0',
      },
      alert: {
        border: '1px solid var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)',
        borderRadius: '8px', padding: '8px 10px', fontSize: '12px', wordBreak: 'break-word',
      },
      ok: {
        border: '1px solid var(--dsw-alias-state-success-primary)', color: 'var(--dsw-alias-state-success-primary)',
        borderRadius: '8px', padding: '8px 10px', fontSize: '12px',
      },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '6px' },
      check: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', cursor: 'pointer' },
      ellipsis: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      fieldset: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '10px', padding: '10px', margin: '0' },
      legend: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', padding: '0 5px' },
    }

    function Field(props) {
      return h('label', { style: { display: 'block', marginBottom: '8px' } }, [
        h('span', { key: 'l', style: S.label }, props.label),
        props.children,
      ])
    }

    function Btn(props) {
      const style = props.variant === 'primary' ? { ...S.primary, ...(props.style || {}) }
        : props.variant === 'danger' ? { ...S.danger, ...(props.style || {}) }
          : { ...S.button, ...(props.style || {}) }
      return h('button', {
        type: 'button', style, disabled: props.disabled === true, onClick: props.onClick, title: props.title,
      }, props.children)
    }

    /**
     * 让非 button 元素成为 disclosure 触发器：
     * role=button + tabIndex 提供键盘可达；Enter/Space 激活；选区非空时不触发。
     */
    function rowClickProps(onActivate) {
      return {
        role: 'button',
        tabIndex: 0,
        onClick: () => {
          const selection = typeof window !== 'undefined' && window.getSelection
            ? window.getSelection()
            : null
          if (selection && selection.toString().length > 0) return
          onActivate()
        },
        onKeyDown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onActivate()
          }
        },
      }
    }

    // -----------------------------------------------------------------------
    // copy-to-clipboard greeting block
    // -----------------------------------------------------------------------

    function GreetingBlock(props) {
      const [copied, setCopied] = useState('')
      const greetings = props.greetings || []
      const [index, setIndex] = useState(0)
      if (greetings.length === 0) {
        return h('div', { style: S.muted }, '这张角色卡没有开场白（first_mes 为空）。')
      }
      const current = greetings[Math.min(index, greetings.length - 1)]
      const copy = () => {
        const done = () => { setCopied('已复制到剪贴板'); setTimeout(() => setCopied(''), 2000) }
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(current.text).then(done, () => setCopied('复制失败，请手动选择文本'))
            return
          }
        } catch (error) {
          /* fall through to the manual path */
        }
        setCopied('（浏览器未授权剪贴板，请手动选择文本）')
      }
      return h('div', null, [
        h('div', { key: 'bar', style: { ...S.row, marginBottom: '4px' } }, [
          h('select', {
            key: 'sel', style: { ...S.selectLight, width: 'auto' }, value: String(index),
            onChange: (event) => setIndex(Number(event.target.value)),
          }, greetings.map((greeting, at) => h('option', {
            key: at, value: String(at), style: { background: '#ffffff', color: '#000000' },
          }, greeting.label))),
          h(Btn, { key: 'copy', onClick: copy }, '复制开场白'),
          copied ? h('span', { key: 'st', style: S.muted }, copied) : null,
        ]),
        h('pre', { key: 'txt', style: S.pre }, current.text),
      ])
    }

    // -----------------------------------------------------------------------
    // character-card editor
    // -----------------------------------------------------------------------

    /**
     * Everything the settings page may change about an existing card.
     *
     * The field list is the same one the Host whitelists; there is no import
     * here because the card already exists — this form only edits it in place.
     * `alternateGreetings` is a list of textareas so a greeting with internal
     * blank lines survives editing; joining it into one textarea would destroy
     * that structure on save.
     */
    function CardEditor(props) {
      const { card, onCancel, onSaved, notify } = props
      const [draft, setDraft] = useState(() => ({
        name: card.name || '',
        description: card.description || '',
        personality: card.personality || '',
        scenario: card.scenario || '',
        firstMes: card.firstMes || '',
        alternateGreetings: Array.isArray(card.alternateGreetings) ? card.alternateGreetings.slice() : [],
        mesExample: card.mesExample || '',
        systemPrompt: card.systemPrompt || '',
        postHistoryInstructions: card.postHistoryInstructions || '',
        creatorNotes: card.creatorNotes || '',
        creator: card.creator || '',
        characterVersion: card.characterVersion || '',
        tags: Array.isArray(card.tags) ? card.tags.join(', ') : '',
        depthPrompt: card.depthPrompt || '',
      }))
      const [busy, setBusy] = useState(false)

      const set = (patch) => setDraft((current) => ({ ...current, ...patch }))

      const setGreeting = (index, value) => {
        setDraft((current) => {
          const list = current.alternateGreetings.slice()
          list[index] = value
          return { ...current, alternateGreetings: list }
        })
      }

      const addGreeting = () => setDraft((current) => ({
        ...current,
        alternateGreetings: [...current.alternateGreetings, ''],
      }))

      const removeGreeting = (index) => setDraft((current) => ({
        ...current,
        alternateGreetings: current.alternateGreetings.filter((_, at) => at !== index),
      }))

      const save = async () => {
        setBusy(true)
        try {
          const result = await call('/card/update', { id: card.id, patch: draft })
          notify(`已更新角色卡「${result.card.name}」`)
          onSaved(result.card)
        } catch (error) {
          notify(String((error && error.message) || error), 'error')
        } finally {
          setBusy(false)
        }
      }

      const textField = (key, label, hint, rows) => h(Field, { key, label }, [
        h('textarea', {
          key: 'i',
          style: { ...S.input, minHeight: rows ? `${rows * 22}px` : '52px' },
          value: draft[key],
          placeholder: hint || '',
          onChange: (e) => set({ [key]: e.target.value }),
        }),
      ])

      return h('div', { style: S.card }, [
        h('div', { key: 'h', style: S.between }, [
          h('span', { key: 't', style: S.name }, `编辑「${card.name}」`),
          h('span', { key: 'id', style: { ...S.muted, fontFamily: 'monospace' } }, `ID：${card.id}`),
        ]),

        h('div', { key: 'meta', style: { ...S.row, gap: '10px', marginTop: '8px', alignItems: 'flex-start' } }, [
          h('span', { key: 'a', style: { flex: '1 1 200px' } }, [
            h('span', { key: 'l', style: S.label }, '角色名'),
            h('input', {
              key: 'i', style: S.input, value: draft.name,
              onChange: (e) => set({ name: e.target.value }),
            }),
          ]),
          h('span', { key: 'b', style: { flex: '1 1 200px' } }, [
            h('span', { key: 'l', style: S.label }, '作者'),
            h('input', {
              key: 'i', style: S.input, value: draft.creator,
              onChange: (e) => set({ creator: e.target.value }),
            }),
          ]),
          h('span', { key: 'c', style: { flex: '1 1 160px' } }, [
            h('span', { key: 'l', style: S.label }, '版本'),
            h('input', {
              key: 'i', style: S.input, value: draft.characterVersion,
              onChange: (e) => set({ characterVersion: e.target.value }),
            }),
          ]),
        ]),

        h(Field, { key: 'tags', label: '标签（逗号分隔）' },
          h('input', {
            key: 'i', style: S.input, value: draft.tags,
            placeholder: '例如：fantasy, romance, mystery',
            onChange: (e) => set({ tags: e.target.value }),
          })),

        textField('description', '角色简介', '角色的背景、来历、与他人的关系……', 6),
        textField('personality', '性格', '性格、说话方式、行为习惯……', 4),
        textField('scenario', '场景', '剧情发生的背景设定。', 3),
        textField('firstMes', '开场白（初始文本）', '会话开始时角色说的第一段话。', 5),
        textField('mesExample', '对话示例', '让模型模仿其风格，不会照抄。', 4),
        textField('systemPrompt', '角色专属系统指令', '会被写进 persona prefix，与预设的默认行为叠加。', 3),

        h('fieldset', { key: 'ag', style: { ...S.fieldset, marginBottom: '8px' } }, [
          h('legend', { key: 'l', style: S.legend }, `备用开场白（${draft.alternateGreetings.length}）`),
          draft.alternateGreetings.length === 0
            ? h('div', { key: 'e', style: S.muted }, '还没有备用开场白。')
            : draft.alternateGreetings.map((text, index) => h('div', {
              key: index, style: { marginTop: index === 0 ? 0 : '6px' },
            }, [
              h('div', { key: 'bar', style: S.between }, [
                h('span', { key: 'l', style: S.label }, `备用 ${index + 1}`),
                h(Btn, { key: 'x', variant: 'danger', onClick: () => removeGreeting(index) }, '删除'),
              ]),
              h('textarea', {
                key: 'i',
                style: { ...S.input, minHeight: '70px' },
                value: text,
                onChange: (e) => setGreeting(index, e.target.value),
              }),
            ])),
          h('div', { key: 'add', style: { marginTop: '6px' } },
            h(Btn, { onClick: addGreeting }, '+ 添加备用开场白')),
        ]),

        textField('postHistoryInstructions', '每轮都要遵守（重要）', '放在 persona prefix 最末尾的硬性要求。', 3),
        textField('creatorNotes', '作者备注', '只是给自己看的备注，不会进入模型提示。', 3),
        textField('depthPrompt', '深度提示', '角色自己的持续提醒；会进入 persona prefix，在输出风格之后。', 3),

        h('div', { key: 'act', style: { ...S.row, marginTop: '8px' } }, [
          h(Btn, { key: 's', variant: 'primary', disabled: busy, onClick: save }, busy ? '保存中…' : '保存修改'),
          h(Btn, { key: 'c', disabled: busy, onClick: onCancel }, '取消'),
        ]),
        h('div', { key: 'tip', style: { ...S.muted, marginTop: '6px' } },
          '保存后所有引用这张卡的预设会自动重新注册，新的 persona 前缀立即生效。'),
      ])
    }

    // -----------------------------------------------------------------------
    // cards tab
    // -----------------------------------------------------------------------

    function CardsTab(props) {
      const { state, reload, notify } = props
      const [openId, setOpenId] = useState('')
      const [editing, setEditing] = useState(null)
      const fileRef = useRef(null)
      const [busy, setBusy] = useState(false)
      const [manual, setManual] = useState(null)

      const cards = Array.isArray(state.cards) ? state.cards : []
      const expanded = manual !== null ? manual : cards.length <= 8

      const onFiles = async (event) => {
        const files = Array.from(event.target.files || [])
        event.target.value = ''
        if (files.length === 0) return
        setBusy(true)
        try {
          for (const file of files) {
            const dataUrl = await readFileAsDataUrl(file)
            const result = await call('/card', { dataUrl, fileName: file.name })
            notify(`已导入角色卡「${result.card.name}」${result.hasCharacterBook ? '（含内嵌世界书）' : ''}`)
          }
          await reload()
        } catch (error) {
          notify(String((error && error.message) || error), 'error')
        } finally {
          setBusy(false)
        }
      }

      const remove = async (card) => {
        const confirmed = window.confirm(`删除角色卡「${card.name}」？使用它的预设会失效。`)
        // A confirm dialog can leave focus on a node that no longer exists;
        // browsers then refuse focus to every native control on the page.
        if (typeof document !== 'undefined' && document.activeElement && document.activeElement.blur) {
          try { document.activeElement.blur() } catch (error) { /* ignore */ }
        }
        if (!confirmed) return
        setBusy(true)
        try {
          await call('/card/delete', { id: card.id, force: true })
          notify(`已删除「${card.name}」`)
          if (openId === card.id) setOpenId('')
          if (editing && editing.id === card.id) setEditing(null)
          await reload()
        } catch (error) {
          notify(String((error && error.message) || error), 'error')
        } finally {
          setBusy(false)
        }
      }

      const importBook = async (card) => {
        setBusy(true)
        try {
          const result = await call('/card/book', { id: card.id })
          notify(`已从「${card.name}」导入世界书「${result.book.name}」（${result.book.entryCount} 条）`)
          await reload()
        } catch (error) {
          notify(String((error && error.message) || error), 'error')
        } finally {
          setBusy(false)
        }
      }

      const startEdit = (card) => {
        // cardSummary already carries every editable field, depthPrompt
        // included, so the row we already have is enough to seed the editor;
        // round-tripping /card/detail would just refetch what we hold.
        setEditing(card)
        setOpenId('')
      }

      return h('div', { style: S.list }, [
        h('div', { key: 'imp', style: S.card }, [
          h('div', { key: 'a', style: S.between }, [
            h('span', { key: 't', style: S.name }, '导入角色卡'),
            h(Btn, { key: 'b', variant: 'primary', disabled: busy, onClick: () => fileRef.current && fileRef.current.click() }, busy ? '处理中…' : '选择文件'),
          ]),
          h('div', { key: 'b', style: { ...S.muted, marginTop: '4px' } },
            '支持 SillyTavern 角色卡：PNG（内嵌 chara / ccv3 数据块）或 JSON（Character Card V1 / V2 / V3）。可以一次选多个文件。'),
          h('input', {
            key: 'f', ref: fileRef, type: 'file', multiple: true, style: { display: 'none' },
            accept: '.json,.png,.webp,.jpg,.jpeg,application/json,image/png,image/jpeg,image/webp',
            onChange: onFiles,
          }),
        ]),

        editing ? h(CardEditor, {
          key: 'editor',
          card: editing,
          notify,
          onCancel: () => setEditing(null),
          onSaved: async () => {
            setEditing(null)
            await reload()
          },
        }) : null,

        cards.length === 0
          ? h('div', { key: 'empty', style: S.muted }, '还没有角色卡。')
          : h('div', { key: 'ctl', style: S.between }, [
            h('span', { key: 'l', style: S.muted }, `共 ${cards.length} 张角色卡`),
            h(Btn, { key: 'b', onClick: () => setManual(!expanded) }, expanded ? '收起' : `展开全部 ${cards.length} 张`),
          ]),

        expanded
          ? cards.map((card) => {
            const isOpen = openId === card.id
            return h('div', { key: card.id }, [
              h('div', {
                key: 'card',
                style: S.itemClickable,
                ...rowClickProps(() => setOpenId(isOpen ? '' : card.id)),
              }, [
                card.portrait
                  ? h('img', { key: 'p', src: card.portrait, style: S.thumb, alt: card.name })
                  : h('div', { key: 'p', style: { ...S.thumb, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dsw-alias-label-secondary)', fontSize: '18px' } }, '🎭'),
                h('div', { key: 'm', style: S.grow }, [
                  h('div', { key: 'n', style: { ...S.name, display: 'flex', alignItems: 'center', gap: '6px' } }, [
                    h('span', { key: 'a', style: { flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary)' } }, isOpen ? '▾' : '▸'),
                    h('span', { key: 't', style: S.ellipsis }, card.name),
                  ]),
                  h('div', { key: 's', style: S.muted }, [
                    card.spec,
                    card.creator ? `作者 ${card.creator}` : '',
                    `${card.greetingCount} 条开场白`,
                    card.hasCharacterBook ? '含内嵌世界书' : '',
                    card.tags.length ? card.tags.slice(0, 5).join(' / ') : '',
                  ].filter(Boolean).join(' · ')),
                  h('div', { key: 'b', style: { ...S.row, marginTop: '6px' } }, [
                    h(Btn, { key: 'e', disabled: busy, onClick: (e) => { e.stopPropagation(); startEdit(card) } }, '编辑'),
                    card.hasCharacterBook ? h(Btn, { key: 'bk', disabled: busy, onClick: (e) => { e.stopPropagation(); importBook(card) } }, '导入内嵌世界书') : null,
                    h(Btn, { key: 'x', variant: 'danger', disabled: busy, onClick: (e) => { e.stopPropagation(); remove(card) } }, '删除'),
                  ]),
                ]),
              ]),
              isOpen ? h('div', { key: 'detail', style: { ...S.card, marginTop: '6px' } }, [
                h('div', {
                  key: 'bar',
                  style: S.stickyBar,
                  ...rowClickProps(() => setOpenId('')),
                }, [
                  h('span', { key: 'a', style: { flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary)' } }, '▾'),
                  h('span', { key: 'n', style: { ...S.name, ...S.ellipsis } }, `${card.name} — 详情`),
                  h(Btn, { key: 'e', disabled: busy, onClick: (e) => { e.stopPropagation(); startEdit(card) } }, '编辑'),
                ]),
                card.description ? h('div', { key: 'd' }, [h('div', { key: 'l', style: S.label }, '角色简介'), h('pre', { key: 'p', style: S.pre }, card.description)]) : null,
                card.personality ? h('div', { key: 'pe' }, [h('div', { key: 'l', style: S.label }, '性格'), h('pre', { key: 'p', style: S.pre }, card.personality)]) : null,
                card.scenario ? h('div', { key: 'sc' }, [h('div', { key: 'l', style: S.label }, '场景'), h('pre', { key: 'p', style: S.pre }, card.scenario)]) : null,
                h('div', { key: 'g', style: { marginTop: '10px' } }, [
                  h('div', { key: 'l', style: S.label }, '开场白（初始文本）'),
                  h(GreetingBlock, { key: 'b', greetings: [
                    card.firstMes ? { label: '开场白', text: card.firstMes } : null,
                    ...(card.alternateGreetings || []).map((text, index) => ({ label: `备用开场白 ${index + 1}`, text })),
                  ].filter(Boolean) }),
                ]),
                card.mesExample ? h('div', { key: 'me' }, [h('div', { key: 'l', style: S.label }, '对话示例'), h('pre', { key: 'p', style: S.pre }, card.mesExample)]) : null,
              ]) : null,
            ])
          })
          : null,
      ])
    }

    // -----------------------------------------------------------------------
    // world books tab
    // -----------------------------------------------------------------------

    function BooksTab(props) {
      const { state, reload, notify } = props
      const [openId, setOpenId] = useState('')
      const [detail, setDetail] = useState(null)
      const [openEntries, setOpenEntries] = useState(() => new Set())
      const fileRef = useRef(null)
      const [busy, setBusy] = useState(false)
      const [manual, setManual] = useState(null)

      const books = Array.isArray(state.worldbooks) ? state.worldbooks : []
      const expanded = manual !== null ? manual : books.length <= 8

      const onFiles = async (event) => {
        const files = Array.from(event.target.files || [])
        event.target.value = ''
        if (files.length === 0) return
        setBusy(true)
        try {
          for (const file of files) {
            const dataUrl = await readFileAsDataUrl(file)
            const result = await call('/worldbook', { dataUrl, fileName: file.name })
            notify(`已导入世界书「${result.book.name}」（${result.book.entryCount} 条，${result.book.keywordCount} 条关键词触发）`)
          }
          await reload()
        } catch (error) {
          notify(String((error && error.message) || error), 'error')
        } finally {
          setBusy(false)
        }
      }

      const remove = async (book) => {
        const confirmed = window.confirm(`删除世界书「${book.name}」？`)
        // A confirm dialog can leave focus on a node that no longer exists;
        // browsers then refuse focus to every native control on the page.
        if (typeof document !== 'undefined' && document.activeElement && document.activeElement.blur) {
          try { document.activeElement.blur() } catch (error) { /* ignore */ }
        }
        if (!confirmed) return
        setBusy(true)
        try {
          await call('/worldbook/delete', { id: book.id })
          notify(`已删除「${book.name}」`)
          if (openId === book.id) {
            setOpenId('')
            setDetail(null)
            setOpenEntries(new Set())
          }
          await reload()
        } catch (error) {
          notify(String((error && error.message) || error), 'error')
        } finally {
          setBusy(false)
        }
      }

      const open = async (book) => {
        if (openId === book.id) {
          setOpenId('')
          setDetail(null)
          setOpenEntries(new Set())
          return
        }
        setBusy(true)
        try {
          const result = await call('/worldbook/detail', { id: book.id })
          setDetail(result.book)
          setOpenId(book.id)
          setOpenEntries(new Set())
        } catch (error) {
          notify(String((error && error.message) || error), 'error')
        } finally {
          setBusy(false)
        }
      }

      const toggleEntry = (id) => {
        setOpenEntries((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }

      return h('div', { style: S.list }, [
        h('div', { key: 'imp', style: S.card }, [
          h('div', { key: 'a', style: S.between }, [
            h('span', { key: 't', style: S.name }, '导入世界书'),
            h(Btn, { key: 'b', variant: 'primary', disabled: busy, onClick: () => fileRef.current && fileRef.current.click() }, busy ? '处理中…' : '选择文件'),
          ]),
          h('div', { key: 'b', style: { ...S.muted, marginTop: '4px' } },
            '支持 SillyTavern World Info 导出（entries 为对象或数组）与 Character Card V2 的 character_book。条目按 recent transcript 里的关键词命中，constant 条目常驻。'),
          h('input', {
            key: 'f', ref: fileRef, type: 'file', multiple: true, style: { display: 'none' },
            accept: '.json,application/json', onChange: onFiles,
          }),
        ]),

        books.length === 0
          ? h('div', { key: 'empty', style: S.muted }, '还没有世界书。')
          : h('div', { key: 'ctl', style: S.between }, [
            h('span', { key: 'l', style: S.muted }, `共 ${books.length} 本世界书`),
            h(Btn, { key: 'b', onClick: () => setManual(!expanded) }, expanded ? '收起' : `展开全部 ${books.length} 本`),
          ]),

        expanded
          ? books.map((book) => {
            const isOpen = openId === book.id && detail !== null
            const entries = isOpen && Array.isArray(detail.entries) ? detail.entries : []
            return h('div', { key: book.id }, [
              h('div', {
                key: 'card',
                style: S.itemClickable,
                ...rowClickProps(() => open(book)),
              }, [
                h('div', { key: 'm', style: S.grow }, [
                  h('div', { key: 'n', style: { ...S.name, display: 'flex', alignItems: 'center', gap: '6px' } }, [
                    h('span', { key: 'a', style: { flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary)' } }, isOpen ? '▾' : '▸'),
                    h('span', { key: 't', style: S.ellipsis }, book.name),
                  ]),
                  h('div', { key: 's', style: S.muted }, [
                    `${book.entryCount} 条条目`,
                    `${book.enabledCount} 条启用`,
                    `${book.constantCount} 条常驻`,
                    `${book.keywordCount} 条关键词`,
                    book.source === 'character_book' ? '来自角色卡' : '',
                  ].filter(Boolean).join(' · ')),
                  h('div', { key: 'b', style: { ...S.row, marginTop: '6px' } }, [
                    h(Btn, {
                      key: 'x',
                      variant: 'danger',
                      disabled: busy,
                      onClick: (e) => { e.stopPropagation(); remove(book) },
                    }, '删除'),
                  ]),
                ]),
              ]),
              isOpen ? h('div', { key: 'detail', style: { ...S.card, marginTop: '6px' } }, [
                h('div', {
                  key: 'bar',
                  style: S.stickyBar,
                  ...rowClickProps(() => open(book)),
                }, [
                  h('span', { key: 'a', style: { flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary)' } }, '▾'),
                  h('span', { key: 'n', style: { ...S.name, ...S.ellipsis } }, `${detail.name} — 条目（${entries.length}）`),
                ]),
                entries.length === 0
                  ? h('div', { key: 'e', style: { ...S.muted, marginTop: '6px' } }, '这本书里没有可用条目。')
                  : h('div', { key: 'list', style: { marginTop: '6px' } },
                    entries.map((entry) => {
                      const entryOpen = openEntries.has(entry.id)
                      const meta = [
                        entry.constant ? '常驻' : `关键词：${entry.keys.join('、') || '（无）'}`,
                        entry.selective && entry.secondaryKeys.length ? `需附带：${entry.secondaryKeys.join('、')}` : '',
                        entry.enabled ? '' : '已停用',
                      ].filter(Boolean).join(' · ')
                      return h('div', {
                        key: entry.id,
                        style: {
                          borderTop: '1px solid var(--dsw-alias-border-l1)',
                          paddingTop: '6px',
                          marginTop: '6px',
                          cursor: 'pointer',
                        },
                        ...rowClickProps(() => toggleEntry(entry.id)),
                      }, [
                        h('div', { key: 'h', style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
                          h('span', { key: 'a', style: { flex: '0 0 auto', color: 'var(--dsw-alias-label-secondary)' } }, entryOpen ? '▾' : '▸'),
                          h('span', { key: 'c', style: { ...S.ellipsis, flex: '0 1 auto', fontWeight: 600 } }, entry.comment),
                          h('span', { key: 'k', style: { ...S.muted, ...S.ellipsis }, title: meta }, meta),
                        ]),
                        entryOpen ? h('pre', { key: 'p', style: S.pre }, entry.content) : null,
                      ])
                    })),
              ]) : null,
            ])
          })
          : null,
      ])
    }

    // -----------------------------------------------------------------------
    // skills tab
    // -----------------------------------------------------------------------

    function SkillsTab(props) {
      const { state } = props
      const skills = Array.isArray(state.skills) ? state.skills : []
      const [manual, setManual] = useState(null)
      const expanded = manual !== null ? manual : skills.length <= 8
      return h('div', { style: S.list }, [
        h('div', { key: 'h', style: S.card }, [
          h('div', { key: 'a', style: S.between }, [
            h('div', { key: 't', style: S.name }, `DSH 技能目录（${skills.length}）`),
            skills.length > 0
              ? h(Btn, { key: 'b', onClick: () => setManual(!expanded) }, expanded ? '收起' : `展开全部 ${skills.length} 个`)
              : null,
          ]),
          h('div', { key: 's', style: { ...S.muted, marginTop: '4px' } },
            '这些是本机 DSH 已安装的 Skill。在「预设」页把技能挂到某个角色上，它的内容会被写进角色的系统提示，让角色按需使用。'),
        ]),
        skills.length === 0
          ? h('div', { key: 'empty', style: S.muted }, '本机没有可用的技能。')
          : expanded
            ? skills.map((skill) => h('div', { key: skill.name, style: S.item }, [
              h('div', { key: 'm', style: S.grow }, [
                h('div', { key: 'n', style: S.name }, skill.name),
                h('div', { key: 'd', style: S.muted }, skill.description || '（无描述）'),
                skill.whenToUse ? h('div', { key: 'w', style: S.muted }, `适用：${skill.whenToUse}`) : null,
                h('div', { key: 'p', style: { ...S.muted, marginTop: '2px' } }, `来源：${skill.provider} · ${skill.source}`),
              ]),
            ]))
            : h('div', { key: 'hint', style: S.muted }, `已折叠 ${skills.length} 个技能。点击上方「展开全部」查看。`),
      ])
    }

    // -----------------------------------------------------------------------
    // presets tab
    // -----------------------------------------------------------------------

    // 默认值由 Host 下发（GET /state 的 defaults 字段）。客户端不再抄一份，
    // 否则两份默认值会各自漂移。

    /**
     * 工具名 → 提供它的包（短名，去掉了 @deepseek-ai/ scope 前缀）。
     *
     * tools.schemas() 的每个 schema 只有 name/description/parameters，没有
     * "来自哪个包"的字段。分组只能靠这张手工表。未列入的工具会归入
     * "未知来源"组，显示原始名——Harness 升级新增工具时会自动落到那里。
     *
     * 表里的包名部分为推测（依赖包布局没有权威文档），若显示有误只影响
     * UI 上的分组标题，不影响功能。
     */
    const TOOL_PACKAGES = {
      read: 'dsh-tool-fs',
      write: 'dsh-tool-fs',
      edit: 'dsh-tool-fs',
      glob: 'dsh-tool-fs-search',
      grep: 'dsh-tool-fs-search',
      pwsh: 'dsh-tool-pwsh',
      bash: 'dsh-tool-bash',
      web_search: 'dsh-tool-web',
      web_fetch: 'dsh-tool-web',
      read_image: 'dsh-tool-image',
      present: 'dsh-tool-present',
      todo_write: 'dsh-tool-todo',
      ask_user_question: 'dsh-tool-ask-user',
      skill: 'dsh-tool-skill',
      job_output: 'dsh-tool-jobs',
      job_list: 'dsh-tool-jobs',
      job_kill: 'dsh-tool-jobs',
      get_goal: 'dsh-tool-goal',
      create_goal: 'dsh-tool-goal',
      update_goal: 'dsh-tool-goal',
      exit_plan_mode: 'dsh-tool-plan-mode',
      load_workspace_dependencies: 'dsh-tool-workspace-deps',
      subagent: 'dsh-tool-subagent',
      subagent_fork: 'dsh-tool-subagent',
      list_subagent_models: 'dsh-tool-subagent',
      workflow: 'dsh-tool-workflow',
      spawn_teammate: 'dsh-experimental-agent-team-profile',
      send_message: 'dsh-experimental-agent-team-profile',
      interrupt_agent: 'dsh-experimental-agent-team-profile',
      list_agents: 'dsh-experimental-agent-team-profile',
      wait_agent: 'dsh-experimental-agent-team-profile',
      team_task_create: 'dsh-experimental-agent-team-profile',
      team_task_get: 'dsh-experimental-agent-team-profile',
      team_task_list: 'dsh-experimental-agent-team-profile',
      team_task_update: 'dsh-experimental-agent-team-profile',
      acp_status: 'dsh-acp',
      acp_cache: 'dsh-acp',
      compress: 'billion-context',
      decompress: 'billion-context',
      search_context: 'billion-context',
    }

    /** 新建预设、以及每次打开「引导角色使用工具」开关时，默认勾选的工具。 */
    const DEFAULT_TOOL_ALLOWLIST = [
      'read',
      'write',
      'edit',
      'glob',
      'grep',
      'read_image',
      'web_search',
      'web_fetch',
    ]

    /**
     * 计算一张角色卡的所有开场白，索引语义与 Host 的 cardGreetings 一致：
     *   0     — first_mes
     *   1..N  — alternate_greetings[0..N-1]
     *
     * card 来自 /state 的 cardSummary，字段名是 firstMes / alternateGreetings。
     * 索引顺序必须与 Host 完全一致，否则用户在 UI 选第 2 条、模型收到第 3 条。
     */
    function greetingsForCard(card) {
      if (!card) return []
      const out = []
      if (card.firstMes) out.push({ label: '开场白', text: card.firstMes })
      ;(card.alternateGreetings || []).forEach((text, index) => {
        out.push({ label: `备用开场白 ${index + 1}`, text })
      })
      return out
    }

    const GENDERS = [
      { value: '', label: '未指定' },
      { value: '男', label: '男' },
      { value: '女', label: '女' },
    ]

    const LANGUAGES = [
      { value: '', label: '自动（不指定）' },
      { value: '简体中文', label: '简体中文' },
      { value: '繁體中文', label: '繁體中文' },
      { value: 'English', label: 'English' },
      { value: '日本語', label: '日本語' },
      { value: '한국어', label: '한국어' },
    ]

    /**
     * 将 section 目录分为三组：
     *   required — Bard 必需（锁定勾选）
     *   tools    — tool:* 前缀（由工具配置推导，只读展示）
     *   optional — 其余（用户可自由勾选）
     *
     * 依赖参数而非模块常量：Host 是 BARD_REQUIRED_SECTIONS / TOOL_SECTION_PREFIX
     * 的权威来源，Client 通过 /state 拿到它们的值。
     */
    function splitSections(list, requiredSections, toolPrefix) {
      const required = []
      const tools = []
      const optional = []
      for (const s of list) {
        if (requiredSections.includes(s.name)) required.push(s)
        else if (s.name.startsWith(toolPrefix)) tools.push(s)
        else optional.push(s)
      }
      return { required, tools, optional }
    }

    /**
     * tool:* section 的只读勾选状态，由 enableTools / toolAllowlist 推导。
     * 与 Host 的 shouldKeepSection 在 tool 分支上保持一致。
     */
    function toolSectionChecked(name, draft, toolPrefix) {
      if (!name.startsWith(toolPrefix)) return false
      if (draft.enableTools === false) return false
      const allow = Array.isArray(draft.toolAllowlist) ? draft.toolAllowlist : []
      if (allow.length === 0) return true
      return allow.includes(name.slice(toolPrefix.length))
    }

    function PresetsTab(props) {
      const { state, reload, notify } = props
      const defaults = (state && state.defaults) || {}
      const defaultStyleHint = typeof defaults.styleHint === 'string' ? defaults.styleHint : ''
      const defaultWorkspacePrefix = typeof defaults.workspacePrefix === 'string'
        ? defaults.workspacePrefix
        : 'Bard_World'
      const availableTools = Array.isArray(state.availableTools) ? state.availableTools : []
      const availableSections = Array.isArray(state.availableSections) ? state.availableSections : []
      const bardRequiredSections = Array.isArray(state.bardRequiredSections) ? state.bardRequiredSections : []
      // 兜底默认值 'tool:'：仅当 Host 版本过旧、未下发 toolSectionPrefix 时生效。
      const toolSectionPrefix = typeof state.toolSectionPrefix === 'string' && state.toolSectionPrefix.length > 0
        ? state.toolSectionPrefix
        : 'tool:'

      const emptyDraft = useCallback(() => ({
        id: '', name: '', cardId: '', greetingIndex: null, worldbookIds: [], skillNames: [],
        styleHint: defaultStyleHint,
        extraInstructions: '', complete: false, includeRuntimeContext: true,
        enableTools: true, toolAllowlist: DEFAULT_TOOL_ALLOWLIST.slice(), keepSections: [], keepSectionsEnabled: false,
        workspaceEnabled: true, workspacePrefix: defaultWorkspacePrefix,
        userName: '', userGender: '', outputLanguage: '', maxEntries: 12, maxChars: 6000,
      }), [defaultStyleHint, defaultWorkspacePrefix])

      const [draft, setDraft] = useState(emptyDraft)
      const [busy, setBusy] = useState(false)
      const [greetFor, setGreetFor] = useState('')
      const [preview, setPreview] = useState(null)
      const [previewBusy, setPreviewBusy] = useState(false)
      const [wbExpanded, setWbExpanded] = useState(false)
      const [skExpanded, setSkExpanded] = useState(false)

      const set = (patch) => setDraft((current) => ({ ...current, ...patch }))

      const edit = (preset) => {
        setGreetFor('')
        setPreview(null)
        setDraft({
          id: preset.id,
          name: preset.name,
          cardId: preset.cardId,
          greetingIndex: Number.isInteger(preset.options.greetingIndex) && preset.options.greetingIndex >= 0
            ? preset.options.greetingIndex
            : null,
          worldbookIds: preset.worldbookIds.slice(),
          skillNames: preset.skillNames.slice(),
          styleHint: preset.options.styleHint || '',
          extraInstructions: preset.options.extraInstructions || '',
          complete: preset.options.complete === true,
          includeRuntimeContext: preset.options.includeRuntimeContext !== false,
          enableTools: preset.options.enableTools !== false,
          toolAllowlist: Array.isArray(preset.options.toolAllowlist) ? preset.options.toolAllowlist.slice() : [],
          keepSections: Array.isArray(preset.options.keepSections) ? preset.options.keepSections : [],
          keepSectionsEnabled: preset.options.keepSectionsEnabled === true
            || (preset.options.keepSectionsEnabled === undefined
              && Array.isArray(preset.options.keepSections)
              && preset.options.keepSections.length > 0),
          workspaceEnabled: preset.options.workspaceEnabled !== false,
          workspacePrefix: preset.options.workspacePrefix || 'Bard_World',
          userName: preset.options.userName || '',
          userGender: preset.options.userGender || '',
          outputLanguage: preset.options.outputLanguage || '',
          maxEntries: Number.isFinite(preset.options.maxEntries) ? preset.options.maxEntries : 12,
          maxChars: Number.isFinite(preset.options.maxChars) ? preset.options.maxChars : 6000,
        })
      }

      const toggle = (field, value) => {
        const list = draft[field].slice()
        const at = list.indexOf(value)
        if (at >= 0) list.splice(at, 1)
        else list.push(value)
        set({ [field]: list })
      }

      /**
       * Tick one section. Turning any section on also turns `complete` off:
       * `complete: true` makes the Host ignore `keepSections` outright, so
       * leaving it on would silently discard the user's selection.
       * Unticking never touches `complete` — there is nothing to undo.
       */
      const toggleKeepSection = (name, on) => {
        setDraft((d) => {
          const next = new Set(d.keepSections)
          if (on) {
            next.add(name)
            return { ...d, keepSections: [...next], complete: false }
          }
          next.delete(name)
          return { ...d, keepSections: [...next] }
        })
      }

      const save = async () => {
        if (!draft.cardId) { notify('请先选择一个角色卡', 'error'); return }
        setBusy(true)
        try {
          const result = await call('/preset', draft)
          notify(result.error
            ? `预设已保存，但注册到 DSH 时出错：${result.error}`
            : `已保存预设，DSH 预设 ID：${result.dshPresetId}。到会话的预设选择器里选「吟游 · ${draft.name || '…'}」即可开始扮演。`,
          result.error ? 'error' : 'info')
          setPreview(null)
          setDraft(emptyDraft())
          await reload()
        } catch (error) {
          notify(String((error && error.message) || error), 'error')
        } finally {
          setBusy(false)
        }
      }

      const runPreview = async () => {
        if (!draft.cardId) { notify('请先选择一个角色卡', 'error'); return }
        setPreviewBusy(true)
        try {
          const result = await call('/preset/preview', draft)
          setPreview(result)
        } catch (error) {
          notify(String((error && error.message) || error), 'error')
        } finally {
          setPreviewBusy(false)
        }
      }

      const remove = async (preset) => {
        const confirmed = window.confirm(`删除预设「${preset.name}」？对应的 DSH 预设会同时注销。`)
        // A confirm dialog can leave focus on a node that no longer exists;
        // browsers then refuse focus to every native control on the page.
        if (typeof document !== 'undefined' && document.activeElement && document.activeElement.blur) {
          try { document.activeElement.blur() } catch (error) { /* ignore */ }
        }
        if (!confirmed) return
        setBusy(true)
        try {
          await call('/preset/delete', { id: preset.id })
          notify(`已删除预设「${preset.name}」`)
          if (draft.id === preset.id) setDraft(emptyDraft())
          await reload()
        } catch (error) {
          notify(String((error && error.message) || error), 'error')
        } finally {
          setBusy(false)
        }
      }

      return h('div', { style: S.list }, [
        h('div', { key: 'form', style: S.card }, [
          h('div', { key: 'h', style: S.between }, [
            h('span', { key: 't', style: S.name }, draft.id ? '编辑预设' : '新建预设'),
            draft.id ? h(Btn, { key: 'c', onClick: () => { setPreview(null); setDraft(emptyDraft()) } }, '新建 / 取消编辑') : null,
          ]),

          h('div', { key: 'f1', style: { marginTop: '8px' } }, [
            h(Field, { key: 'a', label: '预设名称' },
              h('input', { style: S.input, value: draft.name, placeholder: '留空则使用角色名', onChange: (e) => set({ name: e.target.value }) })),
            h(Field, { key: 'b', label: '角色卡' },
              h('select', { style: S.selectLight, value: draft.cardId, onChange: (e) => {
                const nextCardId = e.target.value
                const nextCard = state.cards.find((c) => c.id === nextCardId)
                const nextGreetings = greetingsForCard(nextCard)
                // 换卡后原选中索引可能越界（新卡开场白更少）。越界就清空，
                // 让用户重新选 —— 保留越界值会在保存时被 Host 静默丢弃，
                // UI 与落盘不一致。
                setDraft((d) => ({
                  ...d,
                  cardId: nextCardId,
                  greetingIndex: Number.isInteger(d.greetingIndex) && d.greetingIndex < nextGreetings.length
                    ? d.greetingIndex
                    : null,
                }))
              } }, [
                h('option', { key: '', value: '', style: { background: '#ffffff', color: '#000000' } }, '— 请选择 —'),
                ...state.cards.map((card) => h('option', {
                  key: card.id, value: card.id, style: { background: '#ffffff', color: '#000000' },
                }, card.name)),
              ])),
            (() => {
              const selectedCard = state.cards.find((c) => c.id === draft.cardId)
              const greetings = greetingsForCard(selectedCard)
              const selectedGreeting = draft.greetingIndex !== null ? greetings[draft.greetingIndex] : undefined
              return h(Field, { key: 'greet', label: '开场白注入（可选）' }, [
                h('select', {
                  key: 'sel',
                  style: S.selectLight,
                  value: draft.greetingIndex === null ? '' : String(draft.greetingIndex),
                  disabled: greetings.length === 0,
                  onChange: (e) => {
                    const value = e.target.value
                    set({ greetingIndex: value === '' ? null : Number(value) })
                  },
                }, [
                  h('option', { key: '', value: '', style: { background: '#ffffff', color: '#000000' } },
                    greetings.length === 0 ? '（这张角色卡没有开场白）' : '不注入'),
                  ...greetings.map((g, i) => h('option', {
                    key: String(i),
                    value: String(i),
                    style: { background: '#ffffff', color: '#000000' },
                  }, g.label)),
                ]),
                selectedGreeting ? h('details', {
                  key: 'preview',
                  style: { marginTop: '6px' },
                }, [
                  h('summary', {
                    key: 's',
                    style: { cursor: 'pointer', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
                  }, `预览：${selectedGreeting.label}`),
                  h('pre', { key: 'p', style: S.pre }, selectedGreeting.text),
                ]) : null,
              ])
            })(),
            h(Field, { key: 'un', label: '你的名字（角色卡里的 {{user}} 会替换成它）' },
              h('input', {
                style: S.input,
                value: draft.userName,
                placeholder: '留空则使用 User',
                onChange: (e) => set({ userName: e.target.value }),
              })),
            h(Field, { key: 'ug', label: '玩家性别（避免模型对中性名字猜错称呼）' },
              h('select', {
                style: S.selectLight,
                value: GENDERS.some((item) => item.value === draft.userGender)
                  ? draft.userGender
                  : (draft.userGender ? '__custom__' : ''),
                onChange: (e) => {
                  const value = e.target.value
                  if (value === '__custom__') {
                    const custom = window.prompt('请输入性别（例如：non-binary、futa）', draft.userGender || '')
                    if (custom !== null) set({ userGender: custom.trim() })
                    return
                  }
                  set({ userGender: value })
                },
              }, [
                ...GENDERS.map((item) => h('option', {
                  key: item.value, value: item.value, style: { background: '#ffffff', color: '#000000' },
                }, item.label)),
                draft.userGender && !GENDERS.some((item) => item.value === draft.userGender)
                  ? h('option', {
                    key: '__custom_current__', value: '__custom__', style: { background: '#ffffff', color: '#000000' },
                  }, `自定义：${draft.userGender}`)
                  : h('option', {
                    key: '__custom__', value: '__custom__', style: { background: '#ffffff', color: '#000000' },
                  }, '自定义…'),
              ])),
            h(Field, { key: 'ol', label: '输出语言（角色卡原文语言可能不同，这里显式声明）' },
              h('select', {
                style: S.selectLight,
                value: LANGUAGES.some((lang) => lang.value === draft.outputLanguage) ? draft.outputLanguage : (draft.outputLanguage ? '__custom__' : ''),
                onChange: (e) => {
                  const value = e.target.value
                  if (value === '__custom__') {
                    const custom = window.prompt('请输入语言名（例如：繁體中文、Français、Deutsch）', draft.outputLanguage || '')
                    if (custom !== null) set({ outputLanguage: custom.trim() })
                    return
                  }
                  set({ outputLanguage: value })
                },
              }, [
                ...LANGUAGES.map((lang) => h('option', {
                  key: lang.value, value: lang.value, style: { background: '#ffffff', color: '#000000' },
                }, lang.label)),
                draft.outputLanguage && !LANGUAGES.some((lang) => lang.value === draft.outputLanguage)
                  ? h('option', {
                    key: '__custom_current__', value: '__custom__', style: { background: '#ffffff', color: '#000000' },
                  }, `自定义：${draft.outputLanguage}`)
                  : h('option', {
                    key: '__custom__', value: '__custom__', style: { background: '#ffffff', color: '#000000' },
                  }, '自定义…'),
              ])),
          ]),

          h('fieldset', { key: 'wb', style: { ...S.fieldset, marginBottom: '8px' } }, [
            h('legend', { key: 'l', style: S.legend }, `世界书（${draft.worldbookIds.length} 已选）`),
            state.worldbooks.length === 0
              ? h('div', { key: 'e', style: S.muted }, '还没有世界书，请先在「世界书」页导入。')
              : h('div', { key: 'body' }, [
                h('div', { key: 'bar', style: S.row }, [
                  h('span', { key: 's', style: { ...S.muted, ...S.ellipsis } },
                    draft.worldbookIds.length === 0
                      ? '未选择'
                      : draft.worldbookIds
                        .map((id) => (state.worldbooks.find((b) => b.id === id) || {}).name || id)
                        .join('、')),
                  h(Btn, { key: 't', onClick: () => setWbExpanded(!wbExpanded) },
                    wbExpanded ? '收起' : `选择…（共 ${state.worldbooks.length} 本）`),
                ]),
                wbExpanded
                  ? h('div', { key: 'g', style: { ...S.grid, marginTop: '6px' } },
                    state.worldbooks.map((book) => h('label', { key: book.id, style: S.check }, [
                      h('input', {
                        type: 'checkbox',
                        checked: draft.worldbookIds.includes(book.id),
                        onChange: () => toggle('worldbookIds', book.id),
                      }),
                      h('span', null, `${book.name}（${book.entryCount}）`),
                    ])))
                  : null,
              ]),
          ]),

          h('fieldset', { key: 'sk', style: { ...S.fieldset, marginBottom: '8px' } }, [
            h('legend', { key: 'l', style: S.legend }, `技能（${draft.skillNames.length} 已选）`),
            state.skills.length === 0
              ? h('div', { key: 'e', style: S.muted }, '本机没有可用的 Skill。')
              : h('div', { key: 'body' }, [
                h('div', { key: 'bar', style: S.row }, [
                  h('span', { key: 's', style: { ...S.muted, ...S.ellipsis } },
                    draft.skillNames.length === 0
                      ? '未选择'
                      : draft.skillNames.join('、')),
                  h(Btn, { key: 't', onClick: () => setSkExpanded(!skExpanded) },
                    skExpanded ? '收起' : `选择…（共 ${state.skills.length} 个）`),
                ]),
                skExpanded
                  ? h('div', { key: 'g', style: { ...S.grid, marginTop: '6px' } },
                    state.skills.map((skill) => h('label', { key: skill.name, style: S.check, title: skill.description }, [
                      h('input', {
                        type: 'checkbox',
                        checked: draft.skillNames.includes(skill.name),
                        onChange: () => toggle('skillNames', skill.name),
                      }),
                      h('span', null, skill.name),
                    ])))
                  : null,
              ]),
          ]),

          h('fieldset', { key: 'tools', style: { ...S.fieldset, marginBottom: '8px' } }, [
            h('legend', { key: 'l', style: S.legend }, '引导角色使用工具'),
            h('label', {
              key: 'c',
              style: S.check,
              title: '开启后角色会在 persona 最前面收到一段引导，知道自己能在真实世界留下痕迹，并被鼓励主动行动。工具白名单非空时，只有白名单里的工具会出现在请求里。',
            }, [
              h('input', {
                type: 'checkbox',
                checked: draft.enableTools !== false,
                onChange: (e) => set(e.target.checked
                  ? { enableTools: true, toolAllowlist: DEFAULT_TOOL_ALLOWLIST.slice() }
                  : { enableTools: false }),
              }),
              h('span', null, '引导角色使用工具'),
            ]),
            h('div', { key: 'hint', style: { ...S.muted, marginTop: '4px' } },
              draft.enableTools !== false
                ? '角色会在开场被告知自己能写文件、查资料、在真实世界行动，并被鼓励主动使用这些能力。下方的白名单可以进一步限制哪些工具真正进入请求。'
                : '角色不会被引导主动使用工具，所有工具定义也会从请求中移除。'),
            draft.enableTools !== false ? h('label', {
              key: 'ws',
              style: { ...S.check, marginTop: '8px' },
              title: '开启后，每次新开一个对话窗口，Harness 会在预设前缀下为该窗口建立独立子文件夹，并把这个路径写进角色提示。',
            }, [
              h('input', {
                type: 'checkbox',
                checked: draft.workspaceEnabled !== false,
                onChange: (e) => set({ workspaceEnabled: e.target.checked }),
              }),
              h('span', null, '为每个对话建立专属工作区'),
            ]) : null,
            draft.enableTools !== false && draft.workspaceEnabled !== false ? h('div', {
              key: 'wsp', style: { marginTop: '6px' },
            }, [
              h('span', { key: 'l', style: S.label }, '工作区前缀（相对工作目录）'),
              h('input', {
                key: 'i',
                style: { ...S.input, maxWidth: '280px' },
                value: draft.workspacePrefix,
                placeholder: 'Bard_World',
                onChange: (e) => set({ workspacePrefix: e.target.value }),
              }),
              h('div', { key: 'n', style: { ...S.muted, marginTop: '4px' } },
                '留空则使用 Bard_World。实际路径为「前缀/角色名-短ID/」，每个对话窗口独立一份。'),
            ]) : null,
          ]),

          draft.enableTools !== false ? h('details', {
            key: 'tools-allow', style: { ...S.fieldset, marginBottom: '8px' },
          }, [
            h('summary', {
              key: 's',
              style: { cursor: 'pointer', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
            }, `工具白名单（${draft.toolAllowlist.length} / ${availableTools.length} 已选）`),
            h('div', { key: 'hint', style: { ...S.muted, marginTop: '6px' } },
              '留空 = 全选，所有工具都可用；勾选后只有列表里的工具会出现在请求里。'),
            availableTools.length === 0
              ? h('div', { key: 'e', style: { ...S.muted, marginTop: '6px' } },
                  '尚未采集到工具清单。运行一次任意 Bard 会话后，这里会显示可用工具。')
              : h('div', { key: 'groups', style: { marginTop: '6px' } }, [
                  (() => {
                    // Bucket availableTools by package name. Unknown tools fall
                    // into a synthetic "未知来源" bucket so a Harness upgrade
                    // that adds a new tool is visible rather than silently
                    // missing from the UI.
                    const byPackage = new Map()
                    const mapped = new Set(Object.keys(TOOL_PACKAGES))
                    for (const name of availableTools) {
                      const pkg = TOOL_PACKAGES[name]
                      if (!pkg) continue
                      if (!byPackage.has(pkg)) byPackage.set(pkg, [])
                      byPackage.get(pkg).push(name)
                    }
                    const groups = [...byPackage.entries()].map(([pkg, tools]) => ({ pkg, tools }))
                    const others = availableTools.filter((name) => !mapped.has(name))
                    if (others.length > 0) groups.push({ pkg: '未知来源', tools: others })
                    return groups.map((group) => h('div', { key: group.pkg, style: { marginTop: '6px' } }, [
                      h('div', { key: 'l', style: S.label }, group.pkg),
                      h('div', { key: 'g', style: S.grid }, group.tools.map((name) => h('label', {
                        key: name,
                        style: S.check,
                      }, [
                        h('input', {
                          type: 'checkbox',
                          checked: draft.toolAllowlist.includes(name),
                          onChange: () => toggle('toolAllowlist', name),
                        }),
                        h('span', null, name),
                      ]))),
                    ]))
                  })(),
                  h('div', { key: 'actions', style: { ...S.row, marginTop: '8px' } }, [
                    h(Btn, { key: 'all', onClick: () => set({ toolAllowlist: availableTools.slice() }) }, '全选'),
                    h(Btn, { key: 'none', onClick: () => set({ toolAllowlist: [] }) }, '清空（不限制）'),
                  ]),
                ]),
          ]) : null,

          h('fieldset', { key: 'sections-keep', style: { ...S.fieldset, marginBottom: '8px' } }, [
            h('legend', { key: 'l', style: S.legend }, 'Section 白名单'),
            h('label', {
              key: 'toggle',
              style: S.check,
              title: '开启后仅保留下列 section；关闭时全部 section 都会进入系统提示。',
            }, [
              h('input', {
                type: 'checkbox',
                checked: draft.keepSectionsEnabled,
                onChange: (e) => setDraft((d) => ({
                  ...d,
                  keepSectionsEnabled: e.target.checked,
                  ...(e.target.checked ? { complete: false } : {}),
                })),
              }),
              h('span', null, '启用 Section 白名单'),
            ]),
            h('div', { key: 'hint', style: { ...S.muted, marginTop: '4px' } },
              draft.keepSectionsEnabled
                ? '开启中：仅保留下方勾选的 section。Bard 必需与工具相关的 section 已自动保留。'
                : '关闭中：全部 section 都会进入系统提示。'),
            draft.keepSectionsEnabled ? h('div', { key: 'body', style: { marginTop: '8px' } }, [
              (() => {
                if (availableSections.length === 0) {
                  return h('div', { key: 'e', style: S.muted }, '尚未采集到 section 清单，先跑一次 Bard 会话。')
                }
                const groups = splitSections(availableSections, bardRequiredSections, toolSectionPrefix)
                const renderRow = (s, checked, disabled, onChange) => h('label', {
                  key: s.name,
                  style: { ...S.check, opacity: disabled ? 0.6 : 1, cursor: disabled ? 'default' : 'pointer' },
                }, [
                  h('input', {
                    type: 'checkbox',
                    checked,
                    disabled,
                    onChange: disabled ? undefined : (e) => onChange(e.target.checked),
                  }),
                  h('span', null, ` ${s.name} (${s.chars})`),
                ])
                const blocks = []
                if (groups.required.length > 0) {
                  blocks.push(h('div', { key: 'req', style: { marginTop: '6px' } }, [
                    h('div', { key: 'l', style: S.label }, 'Bard 必需（自动保留）'),
                    h('div', { key: 'g', style: S.grid },
                      groups.required.map((s) => renderRow(s, true, true, () => {}))),
                  ]))
                }
                if (groups.tools.length > 0) {
                  blocks.push(h('div', { key: 'tool', style: { marginTop: '6px' } }, [
                    h('div', { key: 'l', style: S.label }, '工具相关（由上方工具配置决定）'),
                    h('div', { key: 'g', style: S.grid },
                      groups.tools.map((s) => renderRow(
                        s,
                        toolSectionChecked(s.name, draft, toolSectionPrefix),
                        true,
                        () => {},
                      ))),
                  ]))
                }
                if (groups.optional.length > 0) {
                  blocks.push(h('div', { key: 'opt', style: { marginTop: '6px' } }, [
                    h('div', { key: 'l', style: S.label }, '其他 section'),
                    h('div', { key: 'g', style: S.grid },
                      groups.optional.map((s) => renderRow(
                        s,
                        draft.keepSections.includes(s.name),
                        false,
                        (on) => toggleKeepSection(s.name, on),
                      ))),
                  ]))
                }
                blocks.push(h('div', { key: 'act', style: { ...S.row, marginTop: '8px' } }, [
                  h(Btn, {
                    key: 'all',
                    onClick: () => setDraft((d) => ({
                      ...d,
                      keepSections: groups.optional.map((s) => s.name),
                      complete: false,
                    })),
                  }, '全选可选'),
                  h(Btn, {
                    key: 'none',
                    onClick: () => setDraft((d) => ({ ...d, keepSections: [] })),
                  }, '清空可选'),
                ]))
                return blocks
              })(),
            ]) : null,
          ]),

          h(Field, { key: 'sh', label: '输出风格' },
            h('textarea', { style: { ...S.input, minHeight: '52px' }, value: draft.styleHint, onChange: (e) => set({ styleHint: e.target.value }) })),

          h(Field, { key: 'ei', label: '附加作者指令（可选，会写在角色设定里）' },
            h('textarea', { style: { ...S.input, minHeight: '52px' }, value: draft.extraInstructions, placeholder: '例如：多用环境描写；不要替玩家决定行动。', onChange: (e) => set({ extraInstructions: e.target.value }) })),

          h('details', { key: 'adv', style: { marginBottom: '8px' } }, [
            h('summary', { key: 's', style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' } }, '高级选项'),
            h('div', { key: 'b', style: { marginTop: '8px' } }, [
              h('div', { key: 'r', style: { ...S.row, gap: '16px', marginBottom: '8px' } }, [
                h('label', { key: 'a', style: S.check, title: '开启后角色设定会完全替代 Harness 的系统提示（Agent Teams、skill catalog 等全部消失）。与「引导角色使用工具」互不影响——工具开启时，工具 schema 仍会注入请求。' }, [
                  h('input', {
                    type: 'checkbox',
                    checked: draft.complete,
                    onChange: (e) => setDraft((d) => ({
                      ...d,
                      complete: e.target.checked,
                      ...(e.target.checked ? { keepSectionsEnabled: false, keepSections: [] } : {}),
                    })),
                  }),
                  h('span', null, '完全接管系统提示（complete）'),
                ]),
                h('label', { key: 'b', style: S.check, title: '关闭后连工作目录、时间等运行环境信息也不注入。' }, [
                  h('input', { type: 'checkbox', checked: draft.includeRuntimeContext, onChange: (e) => set({ includeRuntimeContext: e.target.checked }) }),
                  h('span', null, '注入运行环境信息'),
                ]),
              ]),
              h('div', { key: 'n', style: S.row }, [
                h('span', { key: 'a' }, [h('span', { key: 'l', style: S.label }, '世界书最多注入条数'),
                  h('input', {
                    key: 'i', type: 'number', min: 1, max: 64, style: { ...S.input, width: '90px' }, value: draft.maxEntries,
                    onChange: (e) => set({ maxEntries: Number(e.target.value) || 12 }),
                  })]),
                h('span', { key: 'b' }, [h('span', { key: 'l', style: S.label }, '世界书最多字符数'),
                  h('input', {
                    key: 'i', type: 'number', min: 500, step: 500, style: { ...S.input, width: '110px' }, value: draft.maxChars,
                    onChange: (e) => set({ maxChars: Number(e.target.value) || 6000 }),
                  })]),
              ]),
            ]),
          ]),

          h('div', { key: 'act', style: S.row }, [
            h(Btn, { key: 's', variant: 'primary', disabled: busy || !draft.cardId, onClick: save }, busy ? '保存中…' : (draft.id ? '保存修改' : '保存为 DSH 预设')),
            h(Btn, { key: 'p', disabled: previewBusy || !draft.cardId, onClick: runPreview }, previewBusy ? '生成中…' : '预览 persona 前缀'),
            preview ? h(Btn, { key: 'c', onClick: () => setPreview(null) }, '关闭预览') : null,
          ]),
          h('div', { key: 'tip', style: { ...S.muted, marginTop: '6px' } },
            '保存后会在 DSH 里注册一个真正的 Agent 预设，可以在会话输入框上方的预设选择器里直接切换。'),
        ]),

        preview ? h('div', { key: 'preview', style: S.card }, [
          h('div', { key: 'h', style: S.between }, [
            h('span', { key: 't', style: S.name }, 'persona 前缀预览'),
            h('span', { key: 'c', style: S.muted },
              `${preview.chars} 字符 · 约 ${preview.tokenEstimate} token · 卡语言：${preview.cardLanguage}`),
          ]),
          preview.warnings && preview.warnings.length > 0
            ? h('div', { key: 'w', style: { ...S.alert, marginTop: '6px' } },
              preview.warnings.map((line, at) => h('div', { key: at }, line)))
            : null,
          h('div', { key: 'sections', style: { marginTop: '8px' } }, [
            h('div', { key: 'l', style: S.label }, `Section 占比（${preview.sections.length} 个）`),
            h('div', { key: 'list', style: S.list },
              preview.sections.map((sec, at) => {
                const share = preview.chars > 0 ? Math.round((sec.chars / preview.chars) * 100) : 0
                return h('div', {
                  key: at,
                  style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' },
                }, [
                  h('span', { key: 'b', style: {
                    display: 'inline-block', height: '6px', borderRadius: '3px',
                    background: 'var(--dsw-alias-brand-primary)', flex: `0 0 ${Math.max(share, 2)}%`,
                  } }),
                  h('span', { key: 'n', style: { flex: '1 1 auto' } }, sec.name),
                  h('span', { key: 'v', style: S.muted }, `${share}% · ${sec.chars}`),
                ])
              })),
          ]),
          h('details', { key: 'full', style: { marginTop: '8px' } }, [
            h('summary', { key: 's', style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' } }, '展开完整文本'),
            h('pre', { key: 'p', style: S.pre }, preview.prefix),
          ]),
        ]) : null,

        state.presets.length === 0
          ? h('div', { key: 'empty', style: S.muted }, '还没有预设。')
          : state.presets.map((preset) => h('div', { key: preset.id, style: S.item }, [
            h('div', { key: 'm', style: S.grow }, [
              h('div', { key: 'n', style: S.name }, preset.name),
              h('div', { key: 's', style: S.muted }, [
                `角色 ${preset.cardName}`,
                `${preset.worldbookIds.length} 本世界书`,
                `${preset.skillNames.length} 个技能`,
                preset.options.complete ? '完全接管系统提示' : '',
                Number.isInteger(preset.options.greetingIndex) && preset.options.greetingIndex >= 0
                  ? `开场白 #${preset.options.greetingIndex + 1}`
                  : '',
                preset.options.enableTools === false ? '禁用工具调用' : '',
                preset.options.enableTools !== false
                  && Array.isArray(preset.options.toolAllowlist)
                  && preset.options.toolAllowlist.length > 0
                  ? `工具白名单 ${preset.options.toolAllowlist.length} 项`
                  : '',
                preset.options.enableTools !== false && preset.options.workspaceEnabled !== false
                  ? `工作区 ${preset.options.workspacePrefix || 'Bard_World'}`
                  : '',
                preset.options.userName ? `称呼 ${preset.options.userName}` : '',
                preset.options.userGender ? `性别 ${preset.options.userGender}` : '',
              ].filter(Boolean).join(' · ')),
              h('div', { key: 'id', style: { ...S.muted, fontFamily: 'monospace' } }, `DSH 预设 ID：${preset.dshPresetId}`),
              preset.error ? h('div', { key: 'e', style: { ...S.muted, color: 'var(--dsw-alias-state-error-primary)' } }, `注册错误：${preset.error}`) : null,
              h('div', { key: 'b', style: { ...S.row, marginTop: '6px' } }, [
                h(Btn, { key: 'e', onClick: () => edit(preset) }, '编辑'),
                h(Btn, { key: 'g', onClick: () => setGreetFor(greetFor === preset.id ? '' : preset.id) }, greetFor === preset.id ? '收起开场白' : '输出开场白'),
                h(Btn, { key: 'x', variant: 'danger', disabled: busy, onClick: () => remove(preset) }, '删除'),
              ]),
              greetFor === preset.id ? h(GreetingBlock, {
                key: 'gb',
                greetings: (() => {
                  const card = state.cards.find((item) => item.id === preset.cardId)
                  if (!card) return []
                  return [
                    card.firstMes ? { label: '开场白', text: card.firstMes } : null,
                    ...(card.alternateGreetings || []).map((text, index) => ({ label: `备用开场白 ${index + 1}`, text })),
                  ].filter(Boolean)
                })(),
              }) : null,
            ]),
          ])),

        h('div', { key: 'cmd', style: S.card }, [
          h('div', { key: 't', style: S.name }, '聊天里的快捷命令'),
          h('pre', { key: 'p', style: S.pre }, [
            '/bard           列出所有 Bard 预设',
            '/bard card      显示当前会话扮演的角色',
            '/bard greet     输出当前会话角色卡的开场白',
            '/bard greet 2   输出第 2 条开场白（备用开场白 1）',
          ].join('\n')),
        ]),
      ])
    }

    // -----------------------------------------------------------------------
    // shell
    // -----------------------------------------------------------------------

    const TABS = [
      { id: 'cards', label: '角色卡' },
      { id: 'worldbooks', label: '世界书' },
      { id: 'skills', label: '技能' },
      { id: 'presets', label: '预设' },
    ]

    function BardSettings() {
      const [state, setState] = useState(null)
      const [tab, setTab] = useState('presets')
      const [notice, setNotice] = useState(null)
      const [failure, setFailure] = useState('')

      const notify = useCallback((text, kind) => {
        setNotice({ text, kind: kind === 'error' ? 'error' : 'info' })
      }, [])

      const load = useCallback(async (silent) => {
        try {
          const next = await call('/state')
          setState(next)
          setFailure('')
          return next
        } catch (error) {
          if (!silent) setFailure(String((error && error.message) || error))
          return undefined
        }
      }, [])

      useEffect(() => {
        let live = true
        load().then((next) => {
          if (!live) return
          if (next && next.presets.length === 0 && next.cards.length === 0) setTab('cards')
          else if (next && next.presets.length === 0) setTab('presets')
        })
        return () => { live = false }
      }, [load])

      const counts = useMemo(() => {
        if (!state) return {}
        return { cards: state.cards.length, worldbooks: state.worldbooks.length, skills: state.skills.length, presets: state.presets.length }
      }, [state])

      const reload = useCallback(() => load(true), [load])

      if (failure) {
        return h('div', { style: S.page }, [
          h('div', { key: 't', style: S.name }, '吟游'),
          h('div', { key: 'e', style: S.alert }, `读取吟游数据失败：${failure}`),
          h(Btn, { key: 'r', onClick: () => load() }, '重试'),
        ])
      }
      if (!state) {
        return h('div', { style: S.page }, [h('div', { key: 'l', style: S.muted }, '正在读取吟游数据…')])
      }

      const common = { state, reload, notify }

      return h('div', { style: S.page }, [
        h('div', { key: 'head', style: S.between }, [
          h('div', { key: 'l' }, [
            h('div', { key: 't', style: { ...S.name, fontSize: '15px' } }, '吟游'),
            h('div', { key: 's', style: S.muted }, '导入角色卡与世界书，挂上技能，保存成 DSH 预设后即可开始角色扮演。'),
          ]),
          h('div', { key: 'r', style: S.row }, [
            h('span', { key: 'c', style: S.muted }, `${counts.cards} 角色卡 · ${counts.worldbooks} 世界书 · ${counts.skills} 技能 · ${counts.presets} 预设`),
          ]),
        ]),

        notice ? h('div', { key: 'n', style: notice.kind === 'error' ? S.alert : S.ok }, [
          h('span', { key: 't' }, notice.text),
          h('button', {
            key: 'x', type: 'button', onClick: () => setNotice(null),
            style: { float: 'right', border: 'none', background: 'transparent', cursor: 'pointer', color: 'inherit' },
          }, '×'),
        ]) : null,

        state.errors && state.errors.length > 0
          ? h('div', { key: 'se', style: S.alert }, state.errors.map((line, at) => h('div', { key: at }, line)))
          : null,

        h('div', { key: 'tabs', style: S.tabs }, TABS.map((item) => h('button', {
          key: item.id, type: 'button',
          style: { ...S.tab, ...(tab === item.id ? S.tabActive : {}) },
          onClick: () => setTab(item.id),
        }, `${item.label}${counts[item.id] !== undefined ? ` (${counts[item.id]})` : ''}`))),

        tab === 'cards' ? h(CardsTab, { key: 'c', ...common })
          : tab === 'worldbooks' ? h(BooksTab, { key: 'w', ...common })
            : tab === 'skills' ? h(SkillsTab, { key: 'k', ...common })
              : h(PresetsTab, { key: 'p', ...common }),
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'bard', order: 25, label: '吟游' },
          BardSettings,
        ))
      },
    }
  },
})
