/**
 * WeChat iLink bot client used by the reading inbox.
 *
 * Implements the protocol documented by Tencent in
 * https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md:
 * QR login, long-poll message delivery, and outbound text messages.
 *
 * It talks only to ilinkai.weixin.qq.com. No WeChat local data is read and no
 * desktop client is involved.
 */
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { createDecipheriv } from 'node:crypto'
import { join } from 'node:path'

const BASE = 'https://ilinkai.weixin.qq.com'
const CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c'
const CLIENT_VERSION = 0x00020a0a
const CHANNEL_VERSION = '2.4.10'

const MEDIA_KINDS = { 2: 'image', 3: 'voice', 4: 'file', 5: 'video' }

const URL_RE = /https?:\/\/[^\s<>"'）)】，。；]+/gu

function headers(token) {
  const h = {
    'content-type': 'application/json',
    'X-WECHAT-UIN': Buffer.from(String(Math.floor(Math.random() * 0xffffffff))).toString('base64'),
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': String(CLIENT_VERSION),
  }
  if (token) {
    h.AuthorizationType = 'ilink_bot_token'
    h.Authorization = `Bearer ${token}`
  }
  return h
}

function timeoutSignal(ms) {
  return AbortSignal.timeout(ms)
}

async function postJson(path, body, { token, timeoutMs = 40000 } = {}) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify(body),
    signal: timeoutSignal(timeoutMs),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function getJson(path, { timeoutMs = 30000 } = {}) {
  const res = await fetch(BASE + path, { headers: headers(), signal: timeoutSignal(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

function isTimeout(error) {
  return error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

export function extractUrls(text) {
  if (typeof text !== 'string') return []
  const found = text.match(URL_RE) || []
  return [...new Set(found.map((url) => url.replace(/[.,;:!?]+$/u, '')))]
}

/** Text carried by one inbound message, joined across its items. */
function messageText(msg) {
  const parts = []
  for (const item of msg.item_list || []) {
    if (item.type === 1) parts.push((item.text_item || {}).text || '')
    else if (item.type === 3) parts.push((item.voice_item || {}).text || '')
    else if (item.type === 4) parts.push((item.file_item || {}).file_name || '')
  }
  return parts.filter(Boolean).join('\n')
}

/**
 * The downloadable part of one message item.
 *
 * Images carry their own key (`image_item.aeskey`), files carry theirs on
 * `media.aes_key`; both point at the same CDN download flow.
 */
function attachmentOf(item) {
  const kind = MEDIA_KINDS[item.type]
  if (!kind) return null
  const holder = item.image_item || item.voice_item || item.file_item || item.video_item || {}
  const media = holder.media || item.media || null
  if (!media || (!media.full_url && !media.encrypt_query_param)) return null
  return {
    kind,
    itemType: item.type,
    name: String(holder.file_name || holder.fileName || ''),
    bytes: Number(holder.len || holder.mid_size || holder.video_size || 0) || 0,
    aesKey: String((item.image_item && item.image_item.aeskey) || media.aes_key || ''),
    media,
  }
}

/** The CDN key arrives as base64 of either 16 raw bytes or a 32-char hex string. */
function decodeKey(raw) {
  if (!raw || typeof raw !== 'string') return null
  const buf = Buffer.from(raw, 'base64')
  if (buf.length === 16) return buf
  const text = buf.toString('utf8')
  if (/^[0-9a-fA-F]{32}$/u.test(text)) return Buffer.from(text, 'hex')
  return null
}

function decryptEcb(payload, key) {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  decipher.setAutoPadding(true)
  return Buffer.concat([decipher.update(payload), decipher.final()])
}

export class WeChatBot {
  constructor({ dir, onMessage, log = () => {} }) {
    this.dir = dir
    this.onMessage = onMessage
    this.log = log
    this.stateFile = join(dir, 'wechat.json')
    this.eventsFile = join(dir, 'wechat-events.json')
    this.credential = null
    this.login = null
    this.listenAbort = null
    this.listenTask = null
    this.events = []
    this.eventsWrite = Promise.resolve()
    this.contextTokens = new Map()
    this.status = 'idle'
    this.error = ''
    this.lastMessageAt = 0
  }

  snapshot() {
    return {
      status: this.status,
      error: this.error,
      url: this.login && this.login.status === 'waiting' ? this.login.url : '',
      qrcode: this.login && this.login.status === 'waiting' ? this.login.qrcode : '',
      botId: this.credential ? this.credential.ilink_bot_id : '',
      lastMessageAt: this.lastMessageAt,
      events: this.events.slice(-20).reverse(),
    }
  }

  async load() {
    try {
      const raw = await readFile(this.stateFile, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && parsed.bot_token) {
        this.credential = parsed
        this.status = 'connected'
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT') this.log(`读取微信凭据失败：${error.message}`)
    }
    try {
      const raw = await readFile(this.eventsFile, 'utf8')
      const events = JSON.parse(raw)
      if (Array.isArray(events)) {
        this.events = events.slice(-100)
        const last = this.events[this.events.length - 1]
        if (last && last.at) this.lastMessageAt = Date.parse(last.at) || 0
      }
    } catch {
      /* no event cache yet */
    }
    return this.snapshot()
  }

  async saveEvents() {
    // Download references carry keys; they live in memory only.
    const payload = JSON.stringify(
      this.events.slice(-100).map(({ attachmentRefs, ...rest }) => rest),
      null,
      2,
    )
    this.eventsWrite = this.eventsWrite.then(async () => {
      await mkdir(this.dir, { recursive: true })
      const tmp = `${this.eventsFile}.tmp`
      await writeFile(tmp, `${payload}\n`, 'utf8')
      await rename(tmp, this.eventsFile)
    }).catch(() => {})
    return this.eventsWrite
  }

  async persist() {
    await mkdir(this.dir, { recursive: true })
    const tmp = `${this.stateFile}.tmp`
    await writeFile(tmp, `${JSON.stringify(this.credential, null, 2)}\n`, 'utf8')
    await rename(tmp, this.stateFile)
  }

  async startLogin() {
    if (this.status === 'connected') return this.snapshot()
    if (this.login && this.login.status === 'waiting') return this.snapshot()
    this.error = ''
    this.status = 'waiting'
    try {
      const data = await postJson('/ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: [] }, { timeoutMs: 20000 })
      this.login = { qrcode: data.qrcode, url: data.qrcode_img_content, status: 'waiting' }
      this.loopPromise = this.pollLogin()
    } catch (error) {
      this.status = 'error'
      this.error = error.message
      this.login = null
    }
    return this.snapshot()
  }

  async pollLogin() {
    while (this.login && this.login.status === 'waiting') {
      let data
      try {
        data = await getJson(`/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(this.login.qrcode)}`, {
          timeoutMs: 300000,
        })
      } catch (error) {
        if (isTimeout(error)) continue
        this.log(`扫码状态查询失败：${error.message}`)
        await new Promise((resolve) => setTimeout(resolve, 2500))
        continue
      }
      const status = data.status || ''
      if (status === 'confirmed') {
        this.credential = {
          bot_token: data.bot_token || '',
          ilink_bot_id: data.ilink_bot_id || '',
          baseurl: data.baseurl || BASE,
          ilink_user_id: data.ilink_user_id || '',
          savedAt: new Date().toISOString(),
        }
        await this.persist()
        this.login.status = 'confirmed'
        this.status = 'connected'
        this.error = ''
        this.log(`微信已连接 bot=${this.credential.ilink_bot_id}`)
        this.startListening()
        return
      }
      if (status === 'expired') {
        const next = await postJson('/ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: [] }, { timeoutMs: 20000 })
        this.login = { qrcode: next.qrcode, url: next.qrcode_img_content, status: 'waiting' }
        continue
      }
      if (status === 'need_verifycode' || status === 'verify_code_blocked') {
        this.login.status = 'failed'
        this.status = 'error'
        this.error = '微信要求输入验证码，请重新发起登录并在手机上完成验证。'
        return
      }
    }
  }

  async connect() {
    if (!this.credential) return this.snapshot()
    this.status = 'connected'
    this.startListening()
    return this.snapshot()
  }

  startListening() {
    if (this.listenTask) return
    const controller = new AbortController()
    this.listenAbort = controller
    this.listenTask = this.listen(controller.signal)
      .catch((error) => {
        this.log(`微信收消息循环结束：${error && error.message}`)
        this.status = 'error'
        this.error = error && error.message ? error.message : String(error)
      })
      .finally(() => {
        this.listenTask = null
      })
  }

  async listen(signal) {
    let buf = ''
    this.log('开始监听微信消息')
    while (!signal.aborted) {
      let data
      try {
        data = await postJson(
          '/ilink/bot/getupdates',
          { get_updates_buf: buf, base_info: { channel_version: CHANNEL_VERSION, bot_agent: 'DSH' } },
          { token: this.credential.bot_token, timeoutMs: 120000 },
        )
      } catch (error) {
        if (signal.aborted) return
        if (isTimeout(error)) continue
        await new Promise((resolve) => setTimeout(resolve, 3000))
        continue
      }
      if (data.get_updates_buf) buf = data.get_updates_buf
      const ret = data.ret
      if (ret && ret !== 0) {
        if (ret === -14) {
          this.status = 'error'
          this.error = '微信登录已失效，请重新扫码接入。'
          await this.clearCredential()
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 3000))
        continue
      }
      for (const msg of data.msgs || []) {
        this.handleMessage(msg)
      }
    }
  }

  handleMessage(msg) {
    if (msg.from_user_id === this.credential?.ilink_user_id && typeof msg.context_token === 'string' && msg.context_token) {
      this.contextTokens.set(msg.from_user_id, msg.context_token)
    }
    const text = messageText(msg)
    const urls = extractUrls(text)
    const attachments = (msg.item_list || []).map(attachmentOf).filter(Boolean)
    const event = {
      id: String(msg.message_id || msg.client_id || ''),
      journal_route: 'pending',
      at: new Date().toISOString(),
      from: msg.from_user_id || '',
      type: msg.message_type,
      text: text.slice(0, 2000),
      urls,
      itemTypes: (msg.item_list || []).map((item) => item.type),
      attachments: attachments.map(({ kind, name, bytes, itemType }) => ({ kind, name, bytes, itemType })),
    }
    // Full references stay off the persisted event log (they carry keys).
    event.attachmentRefs = attachments
    this.lastMessageAt = Date.parse(event.at)
    this.events.push(event)
    if (this.events.length > 100) this.events.shift()
    void this.saveEvents()
    try {
      return this.onMessage(event, msg)
    } catch (error) {
      this.log(`处理微信消息失败：${error && error.message}`)
    }
  }

  /** Fetch and decrypt one inbound attachment from the WeChat CDN. */
  async download(attachment) {
    const media = (attachment && attachment.media) || {}
    const url = media.full_url
      || `${CDN_BASE}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param || '')}`
    if (!media.full_url && !media.encrypt_query_param) throw new Error('缺少下载参数')
    const res = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
        accept: '*/*',
      },
      signal: timeoutSignal(90000),
    })
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
    let bytes = Buffer.from(await res.arrayBuffer())
    const key = decodeKey(attachment.aesKey)
    if (key) bytes = decryptEcb(bytes, key)
    else if (attachment.kind !== 'image') throw new Error('缺少解密密钥，无法保存该附件')
    return bytes
  }

  async sendText(text) {
    if (!this.credential || !this.credential.bot_token) throw new Error('微信未连接')
    const to = this.credential.ilink_user_id
    if (!to) throw new Error('缺少微信用户 id，请重新扫码接入')
    const result = await postJson(
      '/ilink/bot/sendmessage',
      {
        msg: {
          from_user_id: '',
          to_user_id: to,
          client_id: `dsh-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
          message_type: 2,
          message_state: 2,
          ...(this.contextTokens.get(to) ? { context_token: this.contextTokens.get(to) } : {}),
          item_list: [{ type: 1, text_item: { text } }],
        },
        base_info: { channel_version: CHANNEL_VERSION, bot_agent: 'DSH' },
      },
      { token: this.credential.bot_token, timeoutMs: 30000 },
    )
    if ((result.ret !== undefined && result.ret !== 0) || (result.errcode !== undefined && result.errcode !== 0)) {
      throw Object.assign(new Error('微信未接受这条消息'), { code: 'WECHAT_SEND_FAILED' })
    }
    return result
  }

  async clearCredential() {
    this.credential = null
    this.contextTokens.clear()
    try {
      await rm(this.stateFile, { force: true })
    } catch {
      /* ignore */
    }
  }

  async logout() {
    this.status = 'idle'
    this.error = ''
    this.login = null
    if (this.listenAbort) {
      this.listenAbort.abort()
      this.listenAbort = null
    }
    this.listenTask = null
    await this.clearCredential()
    return this.snapshot()
  }

  stop() {
    if (this.listenAbort) {
      this.listenAbort.abort()
      this.listenAbort = null
    }
    this.listenTask = null
  }
}

/** Internals exposed for tests only; not part of the plugin contract. */
export const _testing = { attachmentOf, decodeKey, decryptEcb }
