/**
 * Medium Memory (Notes).
 * 
 * 物理介质层。负责纸条的加密落盘、时间腐坏、字数限制。
 * 采用 AES-128-CBC 加密，不依赖外部库，零外部成本。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { bardDirs } from './store.js'
import { garbleText } from './alzheimer.js'

// --- 常量定义 ---
const MAGIC = Buffer.from('DSHB')
const ALGORITHM = 'aes-128-cbc'
export const MAX_NOTE_CHARS = 500

/** 计算腐坏率：每天增加 0.01，上限 0.4 (40%) */
const CORRUPTION_PER_DAY = 0.01
const MAX_CORRUPTION = 0.4

// --- 密钥管理 ---
function getSecretKey() {
  const root = bardDirs().root
  const secretPath = path.join(root, '.secret')
  try {
    if (!fs.existsSync(secretPath)) {
      const key = crypto.randomBytes(16).toString('hex')
      fs.writeFileSync(secretPath, key, { mode: 0o600 })
      return Buffer.from(key, 'hex')
    }
    const hex = fs.readFileSync(secretPath, 'utf8').trim()
    return Buffer.from(hex, 'hex')
  } catch (error) {
    throw new Error(`无法获取笔记加密密钥: ${String(error.message || error)}`)
  }
}

// --- 文件名与路径安全 ---
function getNotesDir() {
  const dir = path.join(bardDirs().root, 'notes')
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  return dir
}

function sanitizeName(name) {
  // 剔除路径分隔符，限制长度
  const clean = String(name || '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 20)
  if (!clean) throw new Error('文件名不能为空')
  return clean
}

function resolveConflictName(dir, baseName) {
  let finalName = `${baseName}.bin`
  let counter = 2
  while (fs.existsSync(path.join(dir, finalName))) {
    finalName = `${baseName}(${counter}).bin`
    counter++
  }
  return finalName
}

// --- 核心读写接口 ---

/**
 * 写入一张纸条。
 * @param {string} name - 文件名（氛围词/关键词）
 * @param {string} content - 纸条内容
 * @returns {string} 实际落盘的文件名（不含 .bin 后缀）
 */
export function writeNote(name, content) {
  const text = String(content || '').trim()
  if (!text) throw new Error('内容不能为空')
  if (text.length > MAX_NOTE_CHARS) {
    throw new Error(`字数超限：纸条最多写 ${MAX_NOTE_CHARS} 字，当前 ${text.length} 字。请精简或拆分为多张。`)
  }

  const dir = getNotesDir()
  const baseName = sanitizeName(name)
  const fileName = resolveConflictName(dir, baseName)
  const filePath = path.join(dir, fileName)

  const writtenAt = Date.now()
  const iv = crypto.randomBytes(16)
  const key = getSecretKey()

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])

  // 构建 32 字节文件头
  const header = Buffer.alloc(32)
  MAGIC.copy(header, 0)
  header.writeBigInt64BE(BigInt(writtenAt), 4)
  header.writeUInt32BE(text.length, 12)
  iv.copy(header, 16)

  fs.writeFileSync(filePath, Buffer.concat([header, encrypted]), { mode: 0o600 })
  return fileName.replace(/\.bin$/u, '')
}

/**
 * 读取一张纸条。
 * @param {string} name - 文件名（可带或不带 .bin）
 * @returns {{ text: string, corruption: number, writtenAt: string }}
 */
export function readNote(name) {
  const dir = getNotesDir()
  const baseName = String(name || '').replace(/\.bin$/u, '')
  const filePath = path.join(dir, `${baseName}.bin`)

  if (!fs.existsSync(filePath)) {
    throw new Error(`找不到名为「${baseName}」的纸条。`)
  }

  const raw = fs.readFileSync(filePath)
  if (raw.length < 32 || !raw.subarray(0, 4).equals(MAGIC)) {
    throw new Error('文件损坏或格式不正确。')
  }

  const writtenAt = Number(raw.readBigInt64BE(4))
  const iv = raw.subarray(16, 32)
  const encrypted = raw.subarray(32)

  const key = getSecretKey()
  let decrypted = ''
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
    decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
  } catch (error) {
    throw new Error('纸条内容已无法辨认（解密失败）。')
  }

  // 计算腐坏率
  const daysElapsed = Math.max(0, (Date.now() - writtenAt) / 86400000)
  const corruption = Math.min(MAX_CORRUPTION, daysElapsed * CORRUPTION_PER_DAY)

  // 施加物理打码 (使用随机种子，保证同一文件每次看打码位置一致)
  const seed = baseName + writtenAt
  const garbledText = garbleText(decrypted, 1 - corruption, seed)

  return {
    text: garbledText,
    corruption,
    writtenAt: new Date(writtenAt).toISOString().slice(0, 10), // YYYY-MM-DD
  }
}

/**
 * 列出所有纸条（不读取内容）。
 * @returns {Array<{ name: string, chars: number, writtenAt: string }>}
 */
export function listNotes() {
  const dir = getNotesDir()
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.bin'))
  
  return files.map((file) => {
    const filePath = path.join(dir, file)
    try {
      const fd = fs.openSync(filePath, 'r')
      const header = Buffer.alloc(16)
      fs.readSync(fd, header, 0, 16, 0)
      fs.closeSync(fd)

      if (!header.subarray(0, 4).equals(MAGIC)) return null

      const writtenAt = Number(header.readBigInt64BE(4))
      const chars = header.readUInt32BE(12)

      return {
        name: file.replace(/\.bin$/u, ''),
        chars,
        writtenAt: new Date(writtenAt).toISOString().slice(0, 10)
      }
    } catch (e) {
      return null // 忽略读取失败的脏文件
    }
  }).filter(Boolean).sort((a, b) => a.writtenAt.localeCompare(b.writtenAt))
}