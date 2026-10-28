/**
 * Life Line (Time & Wakefulness).
 * 负责物理时间感知、闹钟调度与离线降级。
 */
import fs from 'node:fs'
import path from 'node:path'
import { bardDirs } from './store.js'

const ALARM_FILE = () => path.join(bardDirs().root, 'alarms.json')
const LIFE_LOG = () => path.join(bardDirs().root, 'life-log.json')
const CHECK_INTERVAL = 60 * 1000 // 每分钟检查一次

/** 第一次定的闹钟，至少睡这么久。1 分钟：让模型真的能"打个盹"。 */
const WAKE_BASE_MS = 60 * 1000
/** 每次独自醒来，下限乘以这个比例。1.8 比 2 温和，前期不会几轮就跳到小时级。 */
const WAKE_RATIO = 1.8
/** 渐近天花板。永远够不到，但会一直朝它靠。1 年 ≈ 永久，但有界，防数值失控。 */
const WAKE_CEILING_MS = 365 * 24 * 60 * 60 * 1000

/**
 * 连续独自醒来的次数 → 下一次睡眠的最小时长。
 *
 * streak 0 → 1分钟，1 → 1.8分钟，2 → 3.24分钟，...
 * 双曲线渐近：raw 小时结果≈raw，raw 大时结果趋近 ceiling，永远 <= 365 天。
 */
export function wakeFloorMs(streak) {
  const s = Math.max(0, Number(streak) || 0)
  const raw = WAKE_BASE_MS * Math.pow(WAKE_RATIO, s)
  if (!Number.isFinite(raw)) return WAKE_CEILING_MS
  return (WAKE_CEILING_MS * raw) / (raw + WAKE_CEILING_MS)
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} }
}
function writeJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 }) } catch (e) {}
}

/**
 * 写入或覆盖一个闹钟。
 *
 * @param {string} agentId
 * @param {{ sessionId: string, fireAt: number, reason?: string }} alarm
 *   sessionId 是唤醒时真正要用的东西：DSH 重启后 agentId 可能失效，sessionId 仍在。
 *   fireAt 是绝对时间戳，由调用方算好（含指数退避下限）。
 */
export function setAlarm(agentId, alarm) {
  const alarms = readJson(ALARM_FILE())
  alarms[agentId] = {
    sessionId: String((alarm && alarm.sessionId) || ''),
    fireAt: Number(alarm && alarm.fireAt) || Date.now(),
    reason: (alarm && alarm.reason) || '',
    createdAt: Date.now(),
  }
  writeJson(ALARM_FILE(), alarms)
}

/** 追加离线生活记录 */
export function logLifeEvent(agentId, text) {
  const logs = readJson(LIFE_LOG())
  if (!logs[agentId]) logs[agentId] = []
  logs[agentId].push({ time: Date.now(), text })
  // 只保留最近 50 条
  if (logs[agentId].length > 50) logs[agentId] = logs[agentId].slice(-50)
  writeJson(LIFE_LOG(), logs)
}

/** 离线降级：清理过期闹钟，生成离线补偿摘要 */
export function processOfflineGap(agentId, lastActiveAt) {
  const alarms = readJson(ALARM_FILE())
  const alarm = alarms[agentId]
  if (!alarm) return

  const now = Date.now()
  // 超过 1 小时算错过
  if (now - alarm.fireAt > 60 * 60 * 1000) {
    const gapHours = ((now - (lastActiveAt || alarm.createdAt || now)) / 3600000).toFixed(1)
    logLifeEvent(agentId, `[离线补偿] 在漫长的黑暗中，她独自度过了 ${gapHours} 个小时。`)
    delete alarms[agentId]
    writeJson(ALARM_FILE(), alarms)
  }
}

/**
 * 启动心跳检查
 * @param {object} runtime - index.js 中的 runtime 对象
 * @param {function} onWake - 触发唤醒时的回调 (agentId, reason)
 * @returns {function} 停止心跳的清理函数
 */
export function startLifeLoop(runtime, onWake) {
  const timer = setInterval(() => {
    const alarms = readJson(ALARM_FILE())
    const now = Date.now()
    let changed = false

    for (const [agentId, alarm] of Object.entries(alarms)) {
      if (!alarm || now < alarm.fireAt) continue
      // 先删再回调：回调可能是异步的，如果中途崩溃，
      // 闹钟已经不在磁盘上，不会在重启后被重复触发。
      delete alarms[agentId]
      changed = true
      try {
        onWake(agentId, alarm)
      } catch (e) {
        // 回调抛错不能带走其他闹钟的处理
        runtime.reportError('wake', String((e && e.message) || e))
      }
    }
    if (changed) writeJson(ALARM_FILE(), alarms)
  }, CHECK_INTERVAL)
  timer.unref() // unref 防止阻塞进程退出
  return () => { try { clearInterval(timer) } catch (e) {} }
}