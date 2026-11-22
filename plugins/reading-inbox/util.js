/** 纯工具：URL 归一、标题清洗、中文时间解析、条目摘要。
 *
 * 不碰 I/O，也不持有状态，所以可以单独测、随便搬。
 */

export const STATUSES = ['inbox', 'later', 'read', 'dropped']
export const STATUS_LABELS = { inbox: '待读', later: '稍后阅读', read: '已读', dropped: '已移出阅读列表' }
export const WECHAT_STATUS_LABELS = { idle: '未连接', waiting: '等待扫码确认', connected: '已连接', error: '连接失败' }
export function readingReceipt(result, title = '') {
  const label = title || result.item.title
  const subject = label ? `《${label}》` : '这条链接'
  const outcome = result.restored ? '已恢复到阅读收件箱' : result.updated ? '已补充资料备注'
    : result.duplicate ? '这条资料已存在，未重复添加' : '已加入阅读收件箱'
  return `${outcome}：${subject}（${STATUS_LABELS[result.item.status] || result.item.status}）。`
}
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export function normalizeUrl(raw) {
  if (typeof raw !== 'string') return ''
  let url = raw.trim()
  if (!url) return ''
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    return parsed.toString()
  } catch {
    return ''
  }
}

/** Dedupe key: host + path + query, without the fragment. */
export function dedupeKey(url) {
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    // Share links carry per-session tracking params; the path identifies the note.
    const search = host.endsWith('xiaohongshu.com') ? '' : u.search
    return `${host}${u.pathname}${search}`
  } catch {
    return url
  }
}

export function siteOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function textBlock(text) {
  return [{ type: 'text', text }]
}

export function pickString(value, max = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/** YYYY-MM-DD in the user's zone; toISOString would shift early mornings to the previous day. */
export function localDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

/** 开票日期（2026年10月23日 或 2026-10-23）→ 归档月份 2026-10。 */
export function invoiceMonth(date) {
  if (typeof date !== 'string') return ''
  const chinese = /(\d{4})\s*年\s*(\d{1,2})\s*月/.exec(date)
  if (chinese) return `${chinese[1]}-${chinese[2].padStart(2, '0')}`
  const iso = /(\d{4})-(\d{2})-\d{2}/.exec(date)
  if (iso) return `${iso[1]}-${iso[2]}`
  return ''
}

export function pickStatus(value) {
  return STATUSES.includes(value) ? value : undefined
}

const GENERIC_TITLE =
  /^(小红书|微信公众平台|知乎|微博|哔哩哔哩|bilibili|抖音|首页|登录|环境异常|完成验证|微信文章|小红书笔记|网页|知乎回答)(\s|$|[-–—·|])/iu

/** Site shells, login walls, captcha pages and raw URLs carry no title. */
export function looksGeneric(title) {
  if (!title) return true
  const text = String(title).trim()
  if (/^https?:\/\//iu.test(text)) return true
  if (text.length < 4) return true
  if (GENERIC_TITLE.test(text)) return true
  if (/环境异常|完成验证|访问过于频繁|安全验证/iu.test(text)) return true
  return /^小红书\s*[-–—]/u.test(text)
}

/** An item still needs a real title. */
export function needsTitle(item) {
  if (!item) return false
  if (item.titleResolved === true) return false
  return looksGeneric(item.title)
}

/** Placeholder title so a failed fetch still reads as something. */
export function labelFor(url) {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./u, '')
    const tail = (parsed.pathname.split('/').filter(Boolean).pop() || '').slice(0, 8)
    if (host === 'mp.weixin.qq.com') return tail ? `微信文章 · ${tail}` : '微信文章'
    if (host.includes('xiaohongshu') || host.includes('xhslink')) return tail ? `小红书笔记 · ${tail}` : '小红书笔记'
    if (host === 'zhihu.com' || host.endsWith('.zhihu.com')) return tail ? `知乎回答 · ${tail}` : '知乎内容'
    return host ? `网页 · ${host}` : '未命名链接'
  } catch {
    return '未命名链接'
  }
}

const CN_WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }

/**
 * Pull a date and a clock time out of a Chinese notice.
 * Returns null unless both are present — a memo without a time is not a reminder.
 */
export function parseWhen(text, now = new Date()) {
  const src = String(text || '').replace(/[０-９]/gu, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
  let base = null
  let weekday = null

  const full = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/u.exec(src)
  if (full) base = new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]))

  if (!base) {
    const md = /(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*[日号]?/u.exec(src)
    if (md) {
      const month = Number(md[1])
      const day = Number(md[2])
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        base = new Date(now.getFullYear(), month - 1, day)
        if (base.getTime() < now.getTime() - 30 * 86400000) base.setFullYear(base.getFullYear() + 1)
      }
    }
  }

  if (!base) {
    const rel = /(大后天|后天|明天|明日|今天|今日)/u.exec(src)
    if (rel) {
      const offset = { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3 }[rel[1]]
      base = new Date(now)
      base.setDate(base.getDate() + offset)
    }
  }

  if (!base) {
    const week = /(?:周|星期|礼拜)([一二三四五六日天])/u.exec(src)
    if (week) weekday = CN_WEEKDAY[week[1]]
  }
  if (!base && weekday === null) return null

  let hour = null
  let minute = 0
  const hm = /(\d{1,2})\s*[:：]\s*(\d{2})/u.exec(src)
  if (hm) {
    hour = Number(hm[1])
    minute = Number(hm[2])
  } else {
    const dian = /(\d{1,2})\s*点\s*(半|[0-5]?\d\s*分?)?/u.exec(src)
    if (dian) {
      hour = Number(dian[1])
      minute = dian[2] === '半' ? 30 : dian[2] ? Number(String(dian[2]).replace(/\D/gu, '')) : 0
    }
  }
  if (hour === null) return null

  if (hour <= 12 && /(下午|傍晚|晚上|夜里)/u.test(src) && hour < 12) hour += 12
  else if (hour <= 12 && /中午/u.test(src) && hour < 11) hour += 12
  if (hour > 23 || minute > 59) return null

  if (!base) {
    base = new Date(now)
    base.setDate(base.getDate() + ((weekday - base.getDay() + 7) % 7))
  }

  const due = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, minute)
  if (weekday !== null && due.getTime() <= now.getTime()) due.setDate(due.getDate() + 7)

  const pad = (n) => String(n).padStart(2, '0')
  return {
    dueAt: due.toISOString(),
    label: `${pad(due.getMonth() + 1)}-${pad(due.getDate())} ${pad(due.getHours())}:${pad(due.getMinutes())}`,
    past: due.getTime() < now.getTime() - 12 * 3600000,
  }
}

/** A short human title for a forwarded notice. */
export function guessTitle(text) {
  const lines = String(text || '')
    .split(/\r?\n/u)
    .map((line) => line.replace(/^@所有人\s*/u, '').replace(/\[[^\]]{1,8}\]/gu, '').trim())
    .filter(Boolean)

  const focused = lines.find((line) => /本次|关于/u.test(line))
  if (focused) {
    const core = focused.replace(/^本次/u, '').split(/(具体|安排|通知|如下)/u)[0].trim()
    if (core.length >= 3) return core.slice(0, 40)
  }

  const head =
    lines.find((line) => /(会议|活动|安排|通知|讲座|组会|答辩|出发|集合)/u.test(line)) || lines[0] || '微信提醒'
  return head
    .replace(/[【】[\]]/gu, '')
    .replace(/[:：]\s*$/u, '')
    .replace(/(如下|安排如下)[:：]?$/u, '')
    .slice(0, 60)
}

/** "集合地点：【东北门校内门口】" -> 东北门校内门口 */
export function extractPlace(text) {
  const match = /(?:集合|活动|会议)?地点[：:]\s*【?([^】\n]{2,40})】?/u.exec(String(text || ''))
  return match ? match[1].trim() : ''
}

export function cleanTitle(raw) {
  let text = decodeEntities(String(raw || '').replace(/\s+/g, ' ').trim())
  text = text.replace(/\s*[-–—|]\s*(微信公众平台|小红书|知乎|微博|哔哩哔哩|bilibili|抖音)\s*$/iu, '')
  text = text.replace(/\.\s*\(arXiv:[^)]*\)\s*$/iu, '')
  return text.trim().slice(0, 300)
}

export function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
}

/* ---------------------------------------------------------------- helpers */

export function countsOf(items) {
  const counts = { inbox: 0, later: 0, read: 0, dropped: 0, week: 0, total: items.length }
  const since = Date.now() - WEEK_MS
  for (const item of items) {
    if (counts[item.status] !== undefined) counts[item.status] += 1
    if (Date.parse(item.addedAt) >= since) counts.week += 1
  }
  return counts
}

export function compactItem(item) {
  return {
    id: item.id,
    title: item.title,
    url: item.url,
    site: item.site,
    note: item.note,
    status: item.status,
    tags: item.tags,
    summary: item.summary,
    minutes: item.minutes,
    kind: item.kind,
    addedAt: item.addedAt,
    source: item.source,
    hasBody: Boolean(item.body),
    bodyChars: Number(item.bodyChars) || String(item.body || '').length,
    bodyError: item.bodyError || '',
  }
}

export function sortItems(items) {
  return [...items].sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt))
}
