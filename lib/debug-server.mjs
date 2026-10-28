/**
 * Bard Debug Server (独立进程 / 亦可由 DSH 动态加载)
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
s
// 控制前端按钮是否显示的开关。默认 'F'，改成 'T' 即可在 UI 中显示按钮。
export const DEBUG_UI_ENABLED = 'F'

const PORT = 3758

// 复刻 lib/store.js 的路径解析
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const personasDir = path.join(home, 'bard', 'personas')

function listPersonas() {
  try {
    const files = fs.readdirSync(personasDir).filter((f) => f.endsWith('.json') && !f.includes('.pre-migration'))
    return files.map((f) => {
      const raw = fs.readFileSync(path.join(personasDir, f), 'utf8')
      const data = JSON.parse(raw)
      return {
        id: data.id,
        name: data.self?.identity || '未命名',
        generation: data.meta?.generation || 1,
        memoryCount: data.memories?.length || 0,
        file: f,
      }
    })
  } catch (e) {
    return []
  }
}

function advanceTime(personaId, days) {
  const advanceMs = days * 24 * 60 * 60 * 1000
  let updated = 0

  const files = fs.readdirSync(personasDir).filter((f) => f.endsWith('.json') && !f.includes('.pre-migration'))
  for (const f of files) {
    const filePath = path.join(personasDir, f)
    const raw = fs.readFileSync(filePath, 'utf8')
    const data = JSON.parse(raw)
    
    if (personaId && data.id !== personaId) continue

    let changed = false
    if (Array.isArray(data.memories)) {
      for (const m of data.memories) {
        if (m.lastRestatedAt) {
          m.lastRestatedAt = new Date(Date.parse(m.lastRestatedAt) - advanceMs).toISOString()
          changed = true
        }
        if (m.createdAt) {
          m.createdAt = new Date(Date.parse(m.createdAt) - advanceMs).toISOString()
          changed = true
        }
      }
    }
    if (changed) {
      const temp = `${filePath}.tmp-${Date.now()}`
      fs.writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8')
      fs.renameSync(temp, filePath)
      updated++
    }
  }
  return updated
}

const html = (list) => `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bard Debug Console</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f9fafb; color: #111827; padding: 40px; margin: 0; }
  .card { max-width: 800px; margin: 0 auto; background: white; border-radius: 12px; padding: 24px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06); }
  h1 { font-size: 20px; font-weight: 600; margin-top: 0; border-bottom: 1px solid #e5e7eb; padding-bottom: 12px; }
  .row { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid #e5e7eb; }
  .row:last-child { border-bottom: none; }
  .info { flex: 1; }
  .name { font-weight: 600; font-size: 14px; }
  .meta { font-size: 12px; color: #6b7280; margin-top: 4px; }
  button { background: #3b82f6; color: white; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; transition: background 0.15s; }
  button:hover { background: #2563eb; }
  button:disabled { background: #93c5fd; cursor: not-allowed; }
  .empty { text-align: center; color: #6b7280; padding: 32px; font-size: 14px; }
</style>
</head>
<body>
<div class="card">
  <h1>Bard Debug Console <span style="font-size:12px;font-weight:normal;color:#6b7280;float:right;margin-top:4px;">127.0.0.1:${PORT}</span></h1>
  <div id="list">
    ${list.length === 0 ? '<div class="empty">没有找到任何人格记录。<br>请确认 DSH_HOME 设置正确，且已经在 DSH 里创建了人格。</div>' : list.map(p => `
      <div class="row" data-id="${p.id}">
        <div class="info">
          <div class="name">${p.name} <span style="font-weight:normal;color:#6b7280;">(第 ${p.generation} 世)</span></div>
          <div class="meta">ID: ${p.id} · 记忆数：${p.memoryCount}</div>
        </div>
        <button onclick="advance('${p.id}', 1)">推 1 天</button>
        <button onclick="advance('${p.id}', 7)">推 7 天</button>
        <button onclick="advance('${p.id}', 30)">推 30 天</button>
      </div>
    `).join('')}
  </div>
</div>
<script>
  async function advance(id, days) {
    if (!confirm('确定要把「' + id + '」的记忆时间倒推 ' + days + ' 天吗？')) return
    const btns = document.querySelectorAll('button')
    btns.forEach(b => b.disabled = true)
    try {
      const res = await fetch('/api/advance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personaId: id, days })
      })
      const data = await res.json()
      if (data.ok) {
        alert('成功推进 ' + data.updated + ' 个文件。')
        location.reload()
      } else {
        alert('失败：' + data.error)
      }
    } catch (e) {
      alert('网络错误：' + e.message)
    } finally {
      btns.forEach(b => b.disabled = false)
    }
  }
</script>
</body>
</html>
`

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html(listPersonas()))
    return
  }

  if (req.url === '/api/advance' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}')
        const days = Number(payload.days) || 1
        const updated = advanceTime(payload.personaId, days)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, updated }))
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: e.message }))
      }
    })
    return
  }

  res.writeHead(404)
  res.end('Not Found')
})

// 捕获 EADDRINUSE，防止 DSH 侧载和独立终端启动冲突
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.warn(`[debug-server] 端口 ${PORT} 已被占用（可能已在单独运行）。`)
  } else {
    console.error('[debug-server] 启动失败:', e)
  }
})
try {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  Bard Debug Server 已启动`)
    console.log(`  打开浏览器访问: http://127.0.0.1:${PORT}\n`)
  })
} catch (e) {}