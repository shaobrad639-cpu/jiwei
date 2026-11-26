/** 行程提醒：只认具体到小时的时间，默认提前 60 分钟推一条微信。
 *
 * 纯函数，不碰 I/O、不读时钟：给定条目和「现在」，算出该不该提醒、提醒什么。
 * 这样能单独测，也不会把「现在几点」藏在某个闭包里。
 */

import { localDay } from './util.js'

export const DEFAULT_LEAD_MINUTES = 60
/** 提前量最多认到一个月：再远就不是提醒，是日历了，而且多半是误读。 */
const MAX_LEAD_MINUTES = 31 * 24 * 60

const CN_NUMBER = { 半: 0.5, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

/** 「提前一天」「提前半小时」「提前 30 分钟」→ 分钟数；没说返回 null。 */
export function parseLead(text) {
  const match = /提前\s*(\d+|[一二两三四五六七八九十]+|半)\s*个?\s*(天|日|小时|钟头|分钟)/u.exec(String(text || ''))
  if (!match) return null
  const raw = match[1]
  const value = /^\d+$/u.test(raw) ? Number(raw) : CN_NUMBER[raw]
  if (!value) return null
  const unit = match[2]
  const minutes = unit === '天' || unit === '日' ? value * 1440
    : unit === '小时' || unit === '钟头' ? value * 60
      : value
  return Math.min(Math.round(minutes), MAX_LEAD_MINUTES)
}

/** 条目自己写的提前量优先（「提前一天提醒」），其次才是全局默认。 */
export function leadMinutes(item, fallback = DEFAULT_LEAD_MINUTES) {
  for (const field of [item?.note, item?.at_raw, item?.text, item?.quote]) {
    const parsed = parseLead(field)
    if (parsed !== null) return parsed
  }
  return fallback
}

/**
 * {date:'2026-11-25', clock:'15:30'} → Date。
 * 只有「上午/下午」没有钟点的安排返回 null：那种事提前一小时没有意义。
 */
export function eventStart(item) {
  const at = item?.at
  if (!at || !at.date || !at.clock) return null
  const date = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(at.date).trim())
  const clock = /^(\d{1,2}):(\d{2})$/u.exec(String(at.clock).trim())
  if (!date || !clock) return null
  const hour = Number(clock[1])
  const minute = Number(clock[2])
  if (hour > 23 || minute > 59) return null
  // 账本里的日期钟点都按 Asia/Shanghai 理解，带死时区，别跟着机器时区漂。
  const when = new Date(`${date[1]}-${date[2]}-${date[3]}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`)
  return Number.isNaN(when.getTime()) ? null : when
}

/** 去重键：同一件事改了时间就是一个新键，会重新提醒一次。 */
export function reminderKey(item) {
  const at = item?.at || {}
  return `${item?.id || ''}@${at.date || ''} ${at.clock || ''}`
}

/**
 * 现在该发的提醒：到点了、会还没开、这条还没发过、条目还开着。
 * 迟到也发——14:50 才打开 DSH，15:30 的会还来得及；开会之后就不发了。
 */
export function dueReminders(items, now = new Date(), sent = {}, { fallbackLead = DEFAULT_LEAD_MINUTES } = {}) {
  const stamp = now.getTime()
  const due = []
  for (const item of items || []) {
    if (!item || item.type !== 'task' || item.status !== 'open') continue
    const start = eventStart(item)
    if (!start) continue
    const key = reminderKey(item)
    if (sent && sent[key]) continue
    const lead = leadMinutes(item, fallbackLead)
    const remindAt = start.getTime() - lead * 60000
    if (stamp < remindAt || stamp >= start.getTime()) continue
    due.push({ item, start, lead, remindAt: new Date(remindAt), key })
  }
  return due.sort((a, b) => a.start - b.start)
}

function clockOf(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

function monthDay(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
  }).format(date)
}

/** 90 → 「1 小时 30 分钟」；用来告诉人「还有多久」。 */
export function humanGap(minutes) {
  const total = Math.max(1, Math.round(minutes))
  if (total >= 1440) {
    const days = Math.floor(total / 1440)
    const rest = total % 1440
    return rest ? `${days} 天 ${humanGap(rest)}` : `${days} 天`
  }
  if (total >= 60) {
    const hours = Math.floor(total / 60)
    const rest = total % 60
    return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`
  }
  return `${total} 分钟`
}

/** 备注里的「提前一天（12-29）提醒」已经变成提醒时间了，别再念一遍。 */
function stripLead(text) {
  return String(text || '')
    .replace(/[，,；;]?\s*提前\s*(?:\d+|[一二两三四五六七八九十]+|半)\s*个?\s*(?:天|日|小时|钟头|分钟)\s*(?:[（(][^）)]*[）)])?\s*提醒?/u, '')
    .replace(/^[；;，,、\s]+|[；;，,、\s]+$/gu, '')
    .trim()
}

/** 一条提醒长什么样：会前多久、几点、什么事，地点和备注能带就带上。 */
export function reminderText({ item, start }, now = new Date()) {
  const gap = (start.getTime() - now.getTime()) / 60000
  const sameDay = localDay(start) === localDay(now)
  const when = sameDay ? clockOf(start) : `${monthDay(start)} ${clockOf(start)}`
  const lines = [`⏰ 还有 ${humanGap(gap)}：${when} ${item.text || '行程'}`]
  if (item.place) lines.push(`地点：${item.place}`)
  const note = stripLead(item.note)
  if (note) lines.push(`备注：${note}`)
  return lines.join('\n')
}
