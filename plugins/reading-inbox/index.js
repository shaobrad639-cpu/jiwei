/**
 * 碎片阅读收件箱 (Fragments Reading Inbox) — Host half.
 *
 * Stores links forwarded from WeChat (or pasted by hand), exposes model-facing
 * tools the agent uses to curate them, and serves the small JSON API that the
 * Web UI panel reads.
 */
import { mkdir, readFile, writeFile, rename, appendFile, unlink, open, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'

import { WeChatBot, extractUrls } from './wechat.js'
import { JournalLlm, triageMessage, chatErrorMessage, modelErrorCode } from './llm.js'
import { JournalChat, chatCommand } from './chat.js'
import { sweepAttachments } from './attachments.js'
import { dueReminders, reminderText, DEFAULT_LEAD_MINUTES } from './reminders.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/** Both services must be present for this plugin to activate. */
export const inject = ['tools', 'webServer']

import { InboxStore } from './store.js'
import {
  resolvePython, pythonMeta, pythonArticle, pythonObsidian,
  fetchMeta, BODY_LIMIT, fetchState,
} from './fetch.js'
import {
  STATUSES, STATUS_LABELS, WECHAT_STATUS_LABELS, readingReceipt, WEEK_MS,
  normalizeUrl, dedupeKey, siteOf, textBlock, pickString, localDay,
  pickStatus, looksGeneric, needsTitle, labelFor,
  parseWhen, guessTitle, extractPlace, cleanTitle,
  decodeEntities, countsOf, compactItem, sortItems,
} from './util.js'
import { invoiceMonth, shanghaiNow, shanghaiDay } from './util.js'

/** 开票月份解析仍在包入口转出，保持对外契约不变。 */
export { invoiceMonth }

/** 同一个人 90 秒内说同一句话只处理一次：微信重投可能换 message_id，热重载时
 *  新旧实例也可能同时收到。占位表挂在 globalThis 上、按数据目录隔离，跨实例共用。 */
const INCOMING_CLAIMS = Symbol.for('dsh.reading-inbox.incoming-claims')
const RECENT_INCOMING_MS = 90 * 1000

function incomingClaims(dataDir) {
  const root = globalThis[INCOMING_CLAIMS] || (globalThis[INCOMING_CLAIMS] = new Map())
  let map = root.get(dataDir)
  if (!map) { map = new Map(); root.set(dataDir, map) }
  return map
}

function claimIncoming(dataDir, key) {
  const map = incomingClaims(dataDir)
  const nowMs = Date.now()
  const seen = map.get(key)
  if (seen && nowMs - seen < RECENT_INCOMING_MS) return false
  map.set(key, nowMs)
  if (map.size > 200) {
    for (const [text, when] of map) if (nowMs - when > RECENT_INCOMING_MS * 4) map.delete(text)
  }
  return true
}

function releaseIncoming(dataDir, key) {
  incomingClaims(dataDir).delete(key)
}

/** 跨进程占位：同一句话在两个 DSH 实例之间也只能处理一次。 */
function claimFile(dataDir, key) {
  return join(dataDir, 'incoming-claims', `${createHash('sha256').update(key).digest('hex').slice(0, 24)}.claim`)
}

async function claimIncomingOnDisk(dataDir, key) {
  const file = claimFile(dataDir, key)
  await mkdir(join(dataDir, 'incoming-claims'), { recursive: true }).catch(() => {})
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx')
      await handle.writeFile(String(Date.now()), 'utf8')
      await handle.close()
      return true
    } catch (error) {
      if (error.code !== 'EEXIST') return true
      let expired = false
      try { expired = Date.now() - (await stat(file)).mtimeMs > RECENT_INCOMING_MS } catch { expired = true }
      if (!expired) return false
      await unlink(file).catch(() => {})
    }
  }
  return false
}

async function releaseIncomingOnDisk(dataDir, key) {
  await unlink(claimFile(dataDir, key)).catch(() => {})
}

export function apply(ctx, config = {}) {
  const pythonOverride = typeof config.python === 'string' ? config.python.trim() : ''
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dataDir =
    typeof config.dataDir === 'string' && config.dataDir.trim()
      ? config.dataDir.trim()
      : join(home, 'reading-inbox')
  const bridgeToken = pickString(config.bridgeToken, 200)
  const store = new InboxStore(dataDir)

  const log = (message) => process.stderr.write(`[reading-inbox] ${message}\n`)
  const ui = { pageLoads: 0, lastPageLoadAt: 0 }
  const llm = new JournalLlm(config.llm || {})
  const chatEnabled = config.chat?.enabled !== false && llm.enabled
  const journalDir =
    typeof config.journalDir === 'string' && config.journalDir.trim()
      ? config.journalDir.trim()
      : process.env.JOURNAL_DIR || join(HERE, '..', 'journal')
  llm.journalDir = journalDir
  // 抓到正文后另存一份到 Obsidian 库；vault 为空表示不导出。
  const obsidianVault =
    typeof config.obsidian?.vault === 'string' && config.obsidian.vault.trim()
      ? config.obsidian.vault.trim()
      : ''
  const obsidianFolder =
    typeof config.obsidian?.folder === 'string' && config.obsidian.folder.trim()
      ? config.obsidian.folder.trim()
      : 'Weixin_Article_Analysis'
  // 存进 Obsidian 之后要不要在微信里回一条「已存入」，默认开（config.obsidian.notify: false 关掉）。
  const obsidianNotify = config.obsidian?.notify !== false
  // 行程提醒：具体到小时的安排提前一小时推到微信；config.reminder.leadMinutes 改默认提前量。
  const reminderEnabled = config.reminder?.enabled !== false
  const reminderLead = Number.isFinite(config.reminder?.leadMinutes) && config.reminder.leadMinutes > 0
    ? Math.round(config.reminder.leadMinutes)
    : DEFAULT_LEAD_MINUTES
  // 早间提要：默认插件自己发；已交给「每日早晨事项提醒」定时任务时设 morning.enabled: false。
  const morningEnabled = config.morning?.enabled !== false
  // 微信里问“这篇收藏讲了什么”时，模型只有标题会答不了。带上最近几条的正文摘录。
  const CHAT_BODY_LIMIT = 3000
  const CHAT_READING_ITEMS = 3
  const CHAT_BODY_BUDGET = 6000
  function readingForChat(includeBody = false) {
    return store.read((data) => {
      let budget = CHAT_BODY_BUDGET
      return data.items
        .filter((item) => item.url && item.status !== 'dropped')
        .sort((a, b) => String(b.updatedAt || b.addedAt || '').localeCompare(String(a.updatedAt || a.addedAt || '')))
        .slice(0, CHAT_READING_ITEMS)
        .map((item) => {
          const full = String(item.body || '')
          const take = includeBody ? Math.max(0, Math.min(CHAT_BODY_LIMIT, budget, full.length)) : 0
          budget -= take
          return { id: item.id, title: item.title || item.url, status: item.status, kind: item.kind || '',
            url: item.url, summary: item.summary || '', body: full.slice(0, take), body_chars: full.length }
        })
    })
  }
  const chat = new JournalChat({ dir: journalDir, llm, rules: async () => {
    try { return await readFile(join(journalDir, 'RULES.md'), 'utf8') }
    catch { throw Object.assign(new Error('未能读取账本规则'), { code: 'JOURNAL_CONTEXT_FAILED' }) }
  }, context: async ({ reading = false } = {}) => {
    try {
      const [snapshot, items] = await Promise.all([journalCommand(['chat-context']), readingForChat(reading)])
      return { ...snapshot, reading: items }
    } catch (error) { throw Object.assign(new Error('未能读取账本上下文'), { code: 'JOURNAL_CONTEXT_FAILED', cause: error }) }
  } })
  let triageQueue = Promise.resolve()
  ctx.inject(['llm'], (modelCtx) => {
    llm.runtime = modelCtx.llm
    llm.status.available = true
    modelCtx.on('llm/stream', (options, next) => {
      llm.observe(options)
      return next()
    })
    modelCtx.effect(() => () => llm.stop())
  })
  ctx.inject(['agents'], (agentCtx) => {
    llm.agents = agentCtx.agents
    agentCtx.effect(() => () => { llm.agents = null })
  })
  ctx.inject(['agentDefaultModel'], (modelCtx) => {
    llm.defaultModel = modelCtx.agentDefaultModel
    modelCtx.effect(() => () => { llm.defaultModel = null })
  })
  ctx.inject(['schedule', 'sessionController'], (scheduleCtx) => {
    llm.schedule = scheduleCtx.schedule
    llm.sessionController = scheduleCtx.sessionController
    scheduleCtx.effect(() => () => { llm.schedule = null; llm.sessionController = null })
  })

  const bot = new WeChatBot({
    dir: dataDir,
    log,
    onMessage: (event) => {
      // A private ledger must only be exposed to the account paired at login.
      if (!event.from || event.from !== bot.credential?.ilink_user_id) {
        event.journal_route = 'ignored'
        void bot.saveEvents()
        log('忽略非绑定用户的微信消息')
        return
      }
      // 微信重投有时会换一个 message_id，旧实例也可能和新实例同时收到同一条。
      // 按「同一个人 + 同一句话」占位：谁先拿到谁处理，另一个直接忽略。
      const sameWords = `${event.from}\u0000${event.text}`
      triageQueue = triageQueue.then(async () => {
        // 进程内先挡一次；两个 DSH 实例同时开着时，再靠文件占位挡一次。
        const ignore = () => {
          event.journal_route = 'ignored'
          void bot.saveEvents()
          log('忽略重复投递的同一条消息')
        }
        if (!claimIncoming(dataDir, sameWords)) { ignore(); return }
        if (!(await claimIncomingOnDisk(dataDir, sameWords))) {
          releaseIncoming(dataDir, sameWords)
          ignore()
          return
        }
        try {
          return await handleMessage(event)
        } catch (error) {
          // 没处理成不算占位，让微信重投或用户重发还能再试一次。
          releaseIncoming(dataDir, sameWords)
          await releaseIncomingOnDisk(dataDir, sameWords)
          throw error
        }
      }, () => handleMessage(event))
      return triageQueue
    },
  })

  void bot.load().then(() => {
    if (bot.status === 'connected') bot.connect()
  })

  void store
    .read((data) => data.items.filter((item) => needsTitle(item)).slice(0, 10).map((item) => [item.id, item.url]))
    .then((pending) => {
      for (const [id, url] of pending) void enrich(id, url, { retries: 2 })
    })

  void store
    .read((data) => ({ digests: data.digests.filter((digest) => !digest.files), items: data.items }))
    .then(async ({ digests, items }) => {
      for (const digest of digests) {
        try {
          const files = await writeDigestFiles(digest, items)
          await store.mutate((data) => {
            const found = data.digests.find((entry) => entry.id === digest.id)
            if (found) found.files = files
          })
        } catch (error) {
          log(`历史周报导出失败：${error.message}`)
        }
      }
    })

  ctx.effect(() => () => bot.stop())

  /** Python validates proposals and returns the result of actual writes. */
  async function journalCommand(args, input) {
    const python = await resolvePython(pythonOverride)
    if (!python) throw new Error('找不到 Python，账本尚未读取')
    return new Promise((resolve, reject) => {
      const child = execFile(python, [join(journalDir, 'journal.py'), ...args],
        { timeout: 120000, windowsHide: true, encoding: 'utf8', cwd: journalDir,
          env: { ...process.env, JOURNAL_DIR: journalDir }, maxBuffer: 8 * 1024 * 1024 },
        (error, out, err) => {
          if (error) return reject(new Error(err?.trim() || error.message))
          try { resolve(JSON.parse(out)) } catch (parseError) { reject(parseError) }
        })
      child.stdin.on('error', reject)
      child.stdin.end(input === undefined ? undefined : JSON.stringify(input))
    })
  }

  const ATTACHMENT_KIND_LABEL = { image: '图片', file: '文件', voice: '语音', video: '视频' }
  const ATTACHMENT_FALLBACK = { image: 'image.jpg', file: 'file.bin', voice: 'voice.silk', video: 'video.mp4' }

  function safeFileName(name, kind) {
    const base = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_').trim()
    const chosen = base || ATTACHMENT_FALLBACK[kind] || 'file.bin'
    return chosen.length > 120 ? chosen.slice(-120) : chosen
  }

  function humanBytes(size) {
    if (!size) return '大小未知'
    if (size < 1024) return `${size} B`
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
    return `${(size / 1024 / 1024).toFixed(2)} MB`
  }

  /** Seller and total from a PDF invoice, read locally. No model call, no tokens. */
  async function invoiceFields(path) {
    const python = await resolvePython(pythonOverride)
    if (!python) return null
    return new Promise((resolve) => {
      execFile(
        python,
        [join(HERE, 'tools', 'invoice_fields.py'), path],
        { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error) return resolve(null)
          try {
            const line = String(stdout || '').trim().split(/\r?\n/).pop() || ''
            resolve(JSON.parse(line))
          } catch {
            resolve(null)
          }
        },
      )
    })
  }

  /**
   * Save an inbound document or photo under <journalDir>/attachments and log it
   * as a ledger reference, so an invoice is still findable months later.
   */
  async function saveAttachments(event) {
    const month = new Date().toISOString().slice(0, 7)
    const dir = join(journalDir, 'attachments', month)
    const saved = []
    const failed = []
    for (const ref of event.attachmentRefs || []) {
      try {
        // 密钥形态只记特征，不记内容；图片存坏时靠这几行判断是没密钥还是密钥格式变了。
        void appendFile(join(dataDir, 'attach-debug.log'), `${JSON.stringify({
          at: new Date().toISOString(), kind: ref.kind, bytes: ref.bytes,
          hasKey: Boolean(ref.aesKey), keyLength: String(ref.aesKey || '').length,
          keyIsHex: /^[0-9a-fA-F]{32}$/u.test(String(ref.aesKey || '')),
          mediaFields: ref.media ? Object.keys(ref.media) : [],
          hasFullUrl: Boolean(ref.media && ref.media.full_url),
          hasQueryParam: Boolean(ref.media && ref.media.encrypt_query_param),
        })}\n`, 'utf8').catch(() => {})
        const bytes = await bot.download(ref)
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        const name = safeFileName(ref.name, ref.kind)
        let path = join(dir, `${sha256.slice(0, 8)}-${name}`)
        await mkdir(dir, { recursive: true })
        const fresh = !existsSync(path)
        if (fresh) await writeFile(path, bytes)
        const record = {
          at: new Date().toISOString(),
          kind: ref.kind,
          name,
          bytes: bytes.length,
          sha256,
          path,
          duplicate: !fresh,
        }
        // An invoice only needs two fields for a reimbursement list, and both can
        // be read from the PDF text layer locally — no model call, no tokens.
        if (fresh && /\.pdf$/iu.test(name)) {
          const invoice = await invoiceFields(path)
          if (invoice && invoice.ok) {
            record.invoice = {
              seller: invoice.seller,
              amount: invoice.amount,
              number: invoice.number,
              date: invoice.date,
            }
          } else if (invoice && invoice.error) {
            record.invoiceError = invoice.error
          }
        }
        // 发票按开票日期归档，不看它哪天转到微信里。
        if (fresh && record.invoice?.date) {
          const invoiceMonthKey = invoiceMonth(record.invoice.date)
          if (invoiceMonthKey && invoiceMonthKey !== month) {
            const targetDir = join(journalDir, 'attachments', invoiceMonthKey)
            const target = join(targetDir, `${sha256.slice(0, 8)}-${name}`)
            await mkdir(targetDir, { recursive: true })
            await rename(path, target)
            path = target
            record.path = target
            record.filedBy = 'invoice'
            log(`发票按开票日期归档：${invoiceMonthKey}`)
          }
        }
        if (fresh) {
          await appendFile(join(journalDir, 'attachments', 'index.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
          log(`已保存微信附件：${path}`)
        }
        saved.push(record)
        if (fresh) {
          const detail = record.invoice
            ? [record.invoice.seller, record.invoice.amount && `¥${record.invoice.amount}`].filter(Boolean).join(' ')
            : ''
          try {
            await journalCommand(['add', '--type', 'ref',
              '--text', `${ATTACHMENT_KIND_LABEL[ref.kind] || '附件'}：${name}`,
              '--note', [`本地文件 ${path}`, detail].filter(Boolean).join(' · '), '--src', 'wechat'])
          } catch (error) {
            log(`附件登记账本失败：${error.message}`)
          }
        }
      } catch (error) {
        log(`附件保存失败：${error.message}`)
        failed.push(`${ATTACHMENT_KIND_LABEL[ref.kind] || '附件'}${ref.name ? `（${ref.name}）` : ''}：${error.message}`)
      }
    }
    const lines = saved.map((record) => {
      const where = `attachments/${month}/${record.path.split(/[\\/]/u).pop()}`
      const fields = record.invoice
        ? [record.invoice.seller, record.invoice.amount && `¥${record.invoice.amount}`].filter(Boolean).join(' · ')
        : ''
      const tail = fields ? ` · ${fields}` : record.invoiceError ? ` · 未识别出发票要素` : ''
      return `${record.duplicate ? '已存在' : '已保存'}${ATTACHMENT_KIND_LABEL[record.kind] || '附件'}：${record.name}（${humanBytes(record.bytes)}）→ ${where}${tail}`
    })
    for (const line of failed) lines.push(`未能保存${line}`)
    if (!lines.length) return
    try {
      await bot.sendText(lines.join('\n'))
    } catch (error) {
      log(`附件回执失败：${error.message}`)
    }
  }

  /** The part of a message that is a real caption, not the attachment's name. */
  function captionText(event) {
    let text = String(event.text || '')
    for (const ref of event.attachmentRefs || []) {
      if (ref.name) text = text.split(ref.name).join(' ')
    }
    return text.replace(/https?:\/\/\S+/gu, ' ').replace(/\s+/gu, ' ').trim()
  }

  async function handleMessage(event) {
    if (event.from !== bot.credential?.ilink_user_id) return
    const key = `wechat:${event.from}`
    // Files and photos arrive without text; save them before anything else so a
    // dropped caption never costs the document.
    if (Array.isArray(event.attachmentRefs) && event.attachmentRefs.length) {
      await saveAttachments(event)
      // A bare filename is not something to classify: the receipt already says
      // what was saved, and asking the model about it only produces a question.
      if (!captionText(event)) {
        event.journal_route = 'attachment'
        await bot.saveEvents()
        await chat.dismiss(key)
        return
      }
    }
    if (!event.text?.trim()) return
    const command = chatCommand(event.text)
    let recorded = false
    // 模型不可用时不能让消息白丢：只要还没写过账本、消息走的是自动分诊，
    // 就退回确定性规则分诊再存一次。fallbackAllowed 只在跳过所有前置命令
    // 之后才置真，避免把 /发、/记 这类命令的失败也当成记录来存。
    let fallbackAllowed = false
    let writeStarted = false
    try {
      if (command?.action === 'capture') {
        await chat.dismiss(key)
        return await captureEvent(event, command.text)
      }
      if (command?.action === 'send') {
        event.journal_route = 'send'
        await bot.saveEvents()
        const result = await sendSavedFile(command.query)
        await sendReply(result.receipt, event)
        return
      }
      if (command) {
        event.journal_route = 'command'
        await bot.saveEvents()
        if (!chatEnabled && command.action === 'start') {
          await sendReply('当前聊天回复功能尚未开启。你可以直接发消息记待办或灵感，也可以用「/记 具体内容」保存。', event)
          return
        }
        const result = await chat.command(key, command.action)
        await sendReply(command.action === 'stop' && !llm.enabled ? '已退出聊天模式，恢复按规则自动记账。' : result.reply, event)
        return
      }
      if (!llm.enabled) {
        return await captureEvent(event)
      }
      const state = await chat.state(key)
      if (state.mode === 'chat' && chatEnabled) {
        event.journal_route = 'chat'
        await bot.saveEvents()
        const id = createHash('sha256').update(`${event.from}\0${event.id || event.at}\0${event.text}`).digest('hex')
        const result = await chat.reply(key, event.text, id)
        if (!result.duplicate) await sendReply(result.reply, event)
        return
      }
      fallbackAllowed = true
      const ev = eventKey(event)
      // 微信会重投同一条消息；已经处理并送达过的，直接忽略，别再回一遍。
      const earlier = state.turns.find(turn => turn.id === ev)
      if (earlier && earlier.delivered !== false) return
      // Preserve already registered, version-checked task choices without storing
      // arbitrary conversation while checking whether this is an old answer.
      if (!state.pending) {
        const answer = await journalCommand(['triage', '--text', event.text, '--at', event.at,
          '--ev', ev, '--check-reply'])
        if (!answer.needs_classification && answer.receipt) {
          event.journal_route = 'answer'
          await bot.saveEvents()
          await sendReply(answer.receipt, event)
          // 这条没经过 route()，也要落一个「已送达」，不然微信重投会再回一遍。
          await chat.acknowledge(key, ev, { text: event.text, reply: answer.receipt })
          return
        }
      }
      const result = await chat.route(key, { ...event, ev }, {
        allowChat: chatEnabled,
        validate: ({ ev: ignored, ...plan }) => journalCommand(['triage', '--text', plan.source_messages.map(s => s.text).join('\n'), '--validate-plan'], plan)
          .catch((error) => { throw Object.assign(new Error(error.message), { code: 'VALIDATION_FAILED', cause: error }) }),
        record: async (capture, options) => {
          writeStarted = true
          const saved = await captureClassified(event, capture, options)
          recorded = true
          return saved
        },
        merge: (capture, targets) => mergeClassified(event, capture, targets),
        digest: () => buildWeeklyDigest(),
        lastDigest: () => readLatestDigest(),
        undo: () => undoLastSave(),
        panel: () => readPanelText(),
        reference: sources => collectReferences({ ...event, text: sources.map(s => s.text).join('\n'),
          urls: sources.flatMap(s => extractUrls(s.text)) }),
        mark: async route => { event.journal_route = route; await bot.saveEvents() },
      })
      recorded = result.recorded
      await sendReply(result.reply, event)
      await chat.acknowledge(key, ev)
    } catch (error) {
      log(`对话或回执失败：${modelErrorCode(error)}`)
      if (fallbackAllowed && !writeStarted && !recorded && event.journal_route === 'auto') {
        try {
          const ev = eventKey(event)
          event.journal_route = 'capture'
          event.journal_text = event.text
          event.journal_ev = ev
          await bot.saveEvents()
          // 规则分诊是确定性的，不会再碰刚才失败的那个模型。
          const result = await journalCommand(['triage', '--text', event.text,
            '--at', event.at || new Date().toISOString(), '--ev', ev])
          recorded = true
          await sendReply(result.receipt || '已保存这条记录。', event)
          await chat.acknowledge(key, ev, { text: event.text, reply: result.receipt || '已保存这条记录。' })
          return
        } catch (fallbackError) {
          log(`规则保存或回执失败：${modelErrorCode(fallbackError)}`)
        }
      }
      const hint = recorded ? '记录已为你保存好了，只是微信回执确认稍有延迟，可在账本中查看。'
        : writeStarted || fallbackAllowed ? '刚才的记录正在保存中，原话已完整留存，稍后可在账本中核对。'
          : chatErrorMessage(error)
      try {
        await sendReply(hint, event)
        await chat.acknowledge(key, ev, { text: event.text, reply: hint })
      } catch (sendError) { log(`对话失败提示未送达：${sendError.code || sendError.name || 'unknown'}`) }
    }
  }

  function eventKey(event) {
    return 'wx_' + createHash('sha256').update(`${event.from}\0${event.id || event.at + '\0' + event.text}`).digest('hex').slice(0, 24)
  }

  // 手动点评：你点名才跑，把收藏文章的正文取出来写成点评。平日收藏不读正文。
  const DIGEST_ITEM_LIMIT = 8
  const DIGEST_BODY_BUDGET = 12000
  async function buildWeeklyDigest() {
    const items = await store.read((data) => data.items.filter((item) => item.url && item.status !== 'dropped'))
    if (!items.length) return { receipt: '收件箱里目前还没有收藏文章，先转发几篇感兴趣的文章过来吧。' }
    const picked = [...items]
      .sort((a, b) => String(b.updatedAt || b.addedAt || '').localeCompare(String(a.updatedAt || a.addedAt || '')))
      .slice(0, DIGEST_ITEM_LIMIT)
    // 正文只在收到指令时抓：缺正文的当场补一次，抓不到就留空，点评里如实说明。
    const missing = picked.filter((item) => !item.body && item.url)
    if (missing.length) {
      await Promise.all(missing.map((item) => ensureBody(item.id, item.url).catch(() => false)))
    }
    const fresh = await store.read((data) => new Map(data.items.map((entry) => [entry.id, entry])))
    let budget = DIGEST_BODY_BUDGET
    const payload = picked.map((item) => fresh.get(item.id)).filter(Boolean).map((item) => {
      const body = String(item.body || '')
      const take = Math.max(0, Math.min(body.length, budget))
      budget -= take
      return { id: item.id, title: item.title || item.url, url: item.url, status: item.status,
        note: item.note || '', body: body.slice(0, take), body_chars: body.length }
    })
    const draft = await llm.weeklyDigest({ items: payload, now: shanghaiNow(), today: shanghaiDay(), timezone: 'Asia/Shanghai' })
    const today = localDay()
    await store.mutate((data) => {
      data.digests = data.digests.filter((entry) => localDay(new Date(entry.createdAt)) !== today)
    })
    const digest = await saveDigest({ title: `点评 · ${draft.title}`, intro: draft.intro,
      sections: draft.sections.map((section) => ({ heading: section.heading, body: section.body, itemIds: section.itemIds })),
      topPickId: draft.topPickId, topPickReason: draft.topPickReason })
    return { receipt: `已生成点评：\n\n${digestText(digest)}` }
  }

  // 微信里看全文：把最近一期原样发出来，不经过模型。
  function digestText(digest) {
    const lines = [`《${digest.title}》`]
    if (digest.intro) lines.push('', digest.intro)
    for (const section of digest.sections || []) {
      lines.push('', `· ${section.heading}`)
      if (section.body) lines.push(section.body)
    }
    if (digest.topPickReason) lines.push('', `首选：${digest.topPickReason}`)
    const text = lines.join('\n')
    return text.length > 3800 ? `${text.slice(0, 3800)}\n…（已截断，完整内容在周报标签页）` : text
  }

  async function readLatestDigest() {
    const digest = await store.read((data) => data.digests[0])
    if (!digest) return { receipt: '目前还没有生成过点评，随时对我说「点评我的收藏」即可生成。' }
    return { receipt: digestText(digest) }
  }

  /** 发送时用的文件名：发票写成「商家 · 金额 · 日期」，其余去掉哈希前缀。 */
  function sendName(record, path) {
    const clean = (text) => String(text || '').replace(/[\\/:*?"<>|\u0000-\u001f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 80)
    const raw = record && record.name ? record.name : String(path || '').split(/[\\/]/u).pop()
    const invoice = record && record.invoice
    if (invoice) {
      const parts = [clean(invoice.seller) || '发票', invoice.amount ? `¥${invoice.amount}` : '',
        String(invoice.date || '').replace(/^20\d\d年/u, '')].filter(Boolean)
      return `${clean(parts.join(' · '))}.pdf`
    }
    return clean(String(raw).replace(/^[0-9a-f]{8}-/u, '')) || 'file'
  }

  async function sendNameForPath(path) {
    try {
      const file = join(journalDir, 'attachments', 'index.jsonl')
      if (!existsSync(file)) return sendName(null, path)
      const rows = (await readFile(file, 'utf8')).split('\n').filter(Boolean)
        .map((line) => { try { return JSON.parse(line) } catch { return null } })
        .filter(Boolean)
      return sendName(rows.find((row) => row.path === path) || null, path)
    } catch { return sendName(null, path) }
  }

  /** 从附件里挑一份发回微信：有关键词就按名字/商家/日期匹配，没有就发最新的。 */
  async function sendSavedFile(query = '') {
    const file = join(journalDir, 'attachments', 'index.jsonl')
    if (!existsSync(file)) return { receipt: '目前还没有收到或保存过任何文件。' }
    const records = (await readFile(file, 'utf8')).split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line) } catch { return null } })
      .filter((row) => row && row.path && existsSync(row.path))
      .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
    if (!records.length) return { receipt: '之前的附件已按周期清理，目前没有可发送的文件。' }
    const needle = String(query || '').trim().toLowerCase()
    let hit = records[0]
    if (needle) {
      hit = records.find((row) => [row.name, row.path, row.invoice && row.invoice.seller,
        row.invoice && row.invoice.date, row.at].filter(Boolean).join(' ').toLowerCase().includes(needle))
      if (!hit) return { receipt: `没有找到名称包含「${query}」的文件。直接发「/发」可以获取最近的一份文件。` }
    }
    const isImage = /\.(?:jpe?g|png|gif|webp)$/iu.test(hit.name || hit.path)
    try {
      const sent = await bot.sendFile(hit.path, { fileName: sendName(hit, hit.path), asImage: isImage })
      const size = sent.bytes >= 1024 ? `${Math.round(sent.bytes / 1024)} KB` : `${sent.bytes} B`
      return { receipt: `已发送：${sent.fileName}（${size}）` }
    } catch (error) {
      return { receipt: `发送失败：${error.message}` }
    }
  }

  // 早间提要：插件自己发，不依赖模型；08:00–09:59 之间只发一次。
  let morningSentFor = ''
  async function buildMorningBrief() {
    const snapshot = await journalCommand(['chat-context'])
    const tasks = (snapshot.items || []).filter((item) => item.type === 'task' && item.status === 'open')
    const today = localDay()
    const yesterday = localDay(new Date(Date.parse(`${today}T00:00:00+08:00`) - 86400000))
    const clock = (item) => (item.at && (item.at.clock || item.at.slot)) || ''
    const timed = tasks.filter((item) => item.at && item.at.date)
      .sort((a, b) => `${a.at.date}${clock(a)}`.localeCompare(`${b.at.date}${clock(b)}`))
    const todayItems = timed.filter((item) => item.at.date === today)
    const yesterdayItems = timed.filter((item) => item.at.date === yesterday)
    const unread = await store.read((data) => data.items.filter((item) => item.status === 'inbox').length)
    const label = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', weekday: 'short' })
      .format(new Date())
    const lines = [`今天 ${label}`]
    for (const item of todayItems) lines.push(`${clock(item) || '全天'}　${item.text}`)
    if (!todayItems.length) lines.push('今天没有安排。')
    // 昨天的事项只在这里回顾一次，之后不再提醒。
    if (yesterdayItems.length) {
      lines.push('', '昨天回顾')
      for (const item of yesterdayItems) lines.push(`${clock(item) || '全天'}　${item.text}`)
    }
    if (unread) lines.push('', `收藏待读 ${unread} 条`)
    return lines.join('\n')
  }

  const MORNING_STATE = join(dataDir, 'morning.json')
  async function morningSentToday(day) {
    try { return JSON.parse(await readFile(MORNING_STATE, 'utf8')).day === day } catch { return false }
  }
  async function markMorningSent(day) {
    await writeFile(MORNING_STATE, JSON.stringify({ day, at: new Date().toISOString() }), 'utf8').catch(() => {})
  }

  async function maybeSendMorningBrief() {
    if (!morningEnabled) return
    const now = new Date()
    const day = localDay(now)
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(now))
    if (hour < 8 || hour > 9 || morningSentFor === day) return
    // 微信没连上就发不出去，等连上再发；也避免测试里把假通道当成真通道。
    if (bot.status !== 'connected') return
    // 插件重载会把内存状态清掉；以文件为准，避免重载后又发一遍。
    if (await morningSentToday(day)) { morningSentFor = day; return }
    morningSentFor = day
    try {
      const text = await buildMorningBrief()
      await bot.sendText(text)
      await markMorningSent(day)
      log('早间提要已发送')
      // 提醒只留一周：每天发完提要顺手清一次。
      try {
        const pruned = await journalCommand(['prune', '--days', '7'])
        if (pruned && pruned.count) log(`已删除 ${pruned.count} 条超过一周的提醒`)
      } catch (error) { log(`清理旧提醒失败：${error.message}`) }
    } catch (error) {
      morningSentFor = ''
      log(`早间提要发送失败：${error.message}`)
    }
  }
  ctx.effect(() => {
    void maybeSendMorningBrief()
    const timer = setInterval(() => { void maybeSendMorningBrief() }, 60 * 1000)
    return () => clearInterval(timer)
  })

  // 行程提醒：下午 3 点半的会，2 点半推一条到微信。
  // 只认具体到小时的安排（at.clock），上午/下午这种粗时段留给早间提要。
  const REMINDER_STATE = join(dataDir, 'reminders.json')
  const REMINDER_KEEP_DAYS = 30
  async function readReminderState() {
    try {
      const parsed = JSON.parse(await readFile(REMINDER_STATE, 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch { return {} }
  }
  async function writeReminderState(state) {
    await mkdir(dataDir, { recursive: true })
    const tmp = `${REMINDER_STATE}.${process.pid}.tmp`
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(tmp, REMINDER_STATE)
  }

  let remindersRunning = false
  async function maybeSendReminders() {
    if (!reminderEnabled || remindersRunning) return
    // 微信没连上就别跑：发不出去，还会每分钟白起一个 Python。
    if (bot.status !== 'connected') return
    remindersRunning = true
    try {
      const snapshot = await journalCommand(['chat-context'])
      const sent = await readReminderState()
      const now = new Date()
      const due = dueReminders(snapshot.items, now, sent, { fallbackLead: reminderLead })
      if (!due.length) return
      let changed = false
      for (const entry of due) {
        try {
          await bot.sendText(reminderText(entry, now))
        } catch (error) {
          log(`行程提醒发送失败：${String(error?.message || error).slice(0, 200)}`)
          continue
        }
        sent[entry.key] = new Date().toISOString()
        changed = true
        log(`已提醒：${entry.item.text}（提前 ${entry.lead} 分钟）`)
      }
      if (!changed) return
      // 状态文件只留一个月，别越滚越大。
      const cutoff = Date.now() - REMINDER_KEEP_DAYS * 86400000
      for (const [key, stamp] of Object.entries(sent)) {
        if (!(Date.parse(stamp) >= cutoff)) delete sent[key]
      }
      await writeReminderState(sent)
    } catch (error) {
      log(`行程提醒检查失败：${String(error?.message || error).slice(0, 200)}`)
    } finally {
      remindersRunning = false
    }
  }
  ctx.effect(() => {
    // 插件刚起来时微信还在连，20 秒后再看第一眼，之后每分钟一次。
    const kickoff = setTimeout(() => { void maybeSendReminders() }, 20 * 1000)
    const timer = setInterval(() => { void maybeSendReminders() }, 60 * 1000)
    return () => { clearTimeout(kickoff); clearInterval(timer) }
  })

  // 附件只留一小时；发票例外，长期可查。
  const ATTACHMENT_SWEEP_MS = 10 * 60 * 1000
  async function sweepExpiredAttachments() {
    let removed = []
    try {
      ({ removed } = await sweepAttachments(join(journalDir, 'attachments')))
    } catch (error) {
      log(`附件清理失败：${error.message}`)
      return
    }
    if (!removed.length) return
    log(`已清理 ${removed.length} 个超过一小时的附件`)
    try {
      // 账本里指向这些文件的条目一并标为已放弃，别留悬空引用。
      const snapshot = await journalCommand(['chat-context'])
      for (const record of removed) {
        const name = String(record.path || '').split('/').pop()
        if (!name) continue
        const item = (snapshot.items || []).find((row) => row.type === 'ref' && (row.note || '').includes(name))
        if (item) await journalCommand(['set', '--id', item.id, '--status', 'dropped']).catch(() => {})
      }
    } catch { /* 账本读不到时只清文件 */ }
  }
  ctx.effect(() => {
    void sweepExpiredAttachments()
    const timer = setInterval(() => { void sweepExpiredAttachments() }, ATTACHMENT_SWEEP_MS)
    return () => clearInterval(timer)
  })

  // “面板”：固定排版，分组 + 计数，像面板那样一眼扫完。
  async function recentInvoices(limit = 5) {
    const file = join(journalDir, 'attachments', 'index.jsonl')
    if (!existsSync(file)) return []
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean)
    return lines.slice(-40).map((line) => { try { return JSON.parse(line) } catch { return null } })
      .filter((row) => row && row.invoice)
      .sort((a, b) => String(b.invoice.date || '').localeCompare(String(a.invoice.date || '')))
      .slice(0, limit)
  }

  async function readPanelText() {
    const snapshot = await journalCommand(['chat-context'])
    const tasks = (snapshot.items || []).filter((item) => item.type === 'task' && item.status === 'open')
    const now = new Date()
    const today = localDay(now)
    const yesterday = localDay(new Date(Date.parse(`${today}T00:00:00+08:00`) - 86400000))
    const clock = (item) => (item.at && (item.at.clock || item.at.slot)) || ''
    const stamp = (item) => `${item.at.date}${clock(item)}`
    const timed = tasks.filter((item) => item.at && item.at.date).sort((a, b) => stamp(a).localeCompare(stamp(b)))
    const todayItems = timed.filter((item) => item.at.date === today)
    const earlier = timed.filter((item) => item.at.date <= yesterday)
    const isMoney = (item) => /报销|发票/u.test(item.text)
    const reimburse = tasks.filter(isMoney)
    const untimed = tasks.filter((item) => !(item.at && item.at.date) && !isMoney(item))
    const reading = await store.read((data) => data.items
      .filter((item) => item.status === 'inbox' || item.status === 'later')
      .sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')))
      .slice(0, 3))
    const invoices = await recentInvoices(5)
    const dateLabel = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', weekday: 'short' })
      .format(now)
    const shortDate = (value) => String(value || '').replace(/^\d{4}年?/, '').replace(/-/gu, '/')
    const lines = []
    const section = (title, rows) => {
      if (!rows.length) return
      if (lines.length) lines.push('')
      lines.push(`【${title}】`)
      lines.push(...rows)
    }
    section(`今天 · ${dateLabel}`, todayItems.map((item) => `${clock(item) || '全天'}　${item.text}`))
    section(`昨天回顾 ${earlier.length}`, earlier.slice(-6).map((item) => item.at.date === yesterday
      ? `${clock(item) || '全天'}　${item.text}`
      : `${shortDate(item.at.date)} ${clock(item)}　${item.text}`))
    section(`记录 ${untimed.length}`, untimed.slice(0, 6).map((item) => `· ${item.text}`))
    section(`报销 ${reimburse.length + invoices.length}`, [
      ...reimburse.slice(0, 4).map((item) => `· ${item.text}（记录）`),
      ...invoices.map((row) => `· ${row.invoice.seller || row.name}　¥${row.invoice.amount || '—'}　${shortDate(row.invoice.date)}`),
    ])
    section(`收藏待读 ${reading.length}`, reading.map((item) => `· ${item.title || item.url}`))
    if (!lines.length) return { receipt: '今天暂时没有日程安排，记录和阅读收藏也都很清爽。' }
    lines.push('', `未完成共 ${tasks.length} 条`)
    return { receipt: lines.join('\n') }
  }

  // “取消刚才的保存”：撤销两小时内最后一次落盘（附件或收藏）。
  const UNDO_WINDOW_MS = 2 * 3600 * 1000
  async function lastAttachmentRecord() {
    const file = join(journalDir, 'attachments', 'index.jsonl')
    if (!existsSync(file)) return null
    const lines = (await readFile(file, 'utf8')).split('\n').filter((line) => line.trim())
    if (!lines.length) return null
    try { return { record: JSON.parse(lines[lines.length - 1]), lines } } catch { return null }
  }

  async function undoLastSave() {
    const attachment = await lastAttachmentRecord()
    const item = await store.read((data) => [...data.items]
      .sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt))[0] || null)
    const attachmentAt = attachment ? Date.parse(attachment.record.at) || 0 : 0
    const itemAt = item ? Date.parse(item.addedAt) || 0 : 0
    const cutoff = Date.now() - UNDO_WINDOW_MS
    const undoAttachment = Boolean(attachment && attachmentAt > cutoff && attachmentAt >= itemAt)
    const undoItem = Boolean(item && itemAt > cutoff && itemAt > attachmentAt)
    if (!undoAttachment && !undoItem) return { receipt: '最近两小时内没有找到可撤销的保存记录。' }

    if (undoAttachment) {
      const { record, lines } = attachment
      const base = join(journalDir, 'attachments')
      const path = String(record.path || '')
      if (!path.startsWith(`${base}/`)) return { receipt: '最后一条保存的路径不在附件目录内，未撤销。' }
      await unlink(path).catch((error) => { if (error.code !== 'ENOENT') throw error })
      await writeFile(join(journalDir, 'attachments', 'index.jsonl'),
        lines.slice(0, -1).map((line) => `${line}\n`).join(''), 'utf8')
      return { receipt: `已撤销：${record.name}（${path.slice(base.length + 1)}），文件已删除。` }
    }
    const removed = await store.mutate((data) => {
      const index = data.items.findIndex((entry) => entry.id === item.id)
      return index === -1 ? null : data.items.splice(index, 1)[0]
    })
    if (!removed) return { receipt: '这条收藏已经不在收件箱里了。' }
    return { receipt: `已撤销收藏：${removed.title || removed.url}` }
  }

  // “补进去”：把补充内容追加到已有条目，而不是新建一条同名待办。
  async function mergeClassified(event, capture, targets) {
    const lines = []
    for (const [index, id] of targets.entries()) {
      const item = capture.items[index]
      const detail = await journalCommand(['detail', '--id', id])
      if (!detail?.item || detail.item.id !== id) throw new Error('要补进的条目已不存在')
      const previous = String(detail.item.note || '').trim()
      const addition = String(item.note || '').trim()
      const note = !addition || previous.includes(addition) ? previous : [previous, addition].filter(Boolean).join('\n')
      await journalCommand(['set', '--id', id, '--note', note, '--expected-revision', String(detail.item.revision ?? '')])
      lines.push(`已补进「${item.text}」${addition ? '：' + addition : ''}`)
    }
    event.journal_route = 'merge'
    await bot.saveEvents()
    return { receipt: lines.join('\n') }
  }

  async function captureClassified(event, capture, { collectRefs = false } = {}) {
    const { ev, ...plan } = capture
    const text = plan.source_messages.map(s => s.text).join('\n')
    event.journal_route = 'capture'
    event.journal_text = text
    event.journal_ev = ev
    event.journal_sources = plan.source_messages
    await bot.saveEvents()
    const result = await journalCommand(['triage', '--text', text, '--at', event.at, '--ev', ev, '--plan', '-'], plan)
    if (!result.duplicate && collectRefs) result.receipt += '\n' + await collectReferences({ ...event, text, urls: extractUrls(text) })
    return result
  }

  async function collectReferences(event) {
    const replies = []
    const note = event.text.replace(/https?:\/\/\S+/gu, '').trim().slice(0, 1000)
    for (const url of event.urls || []) {
      try { replies.push(readingReceipt(await addItem({ url, note, source: 'wechat', acknowledge: false }))) }
      catch { replies.push(`链接未能加入阅读收件箱：${url}`) }
    }
    return replies.join('\n') || '未收到可收藏的链接，未新增资料。'
  }

  async function captureEvent(event, text = event.text) {
    event.journal_route = 'capture'
    event.journal_text = text
    event.journal_ev = event.id ? 'wx_' + createHash('sha256').update(`${event.from}\0${event.id}`).digest('hex').slice(0, 24) : ''
    await bot.saveEvents()
    return captureMessage({ ...event, text, ev: event.journal_ev })
  }

  async function sendReply(text, event) {
    if (event.from !== bot.credential?.ilink_user_id) throw new Error('微信绑定用户已变化，未发送旧会话内容')
    // Long replies (a full 点评) would be rejected as one message; split on lines.
    const chunks = []
    let current = ''
    for (const line of String(text).split('\n')) {
      if (current && (current.length + line.length + 1) > 1500) { chunks.push(current); current = line }
      else current = current ? `${current}\n${line}` : line
    }
    if (current) chunks.push(current)
    let result
    for (const chunk of chunks) result = await bot.sendText(chunk)
    return result
  }

  function captureMessage(event) {
    const note = event.text.replace(/https?:\/\/\S+/gu, '').trim().slice(0, 1000)
    for (const url of event.urls || []) {
      addItem({ url, note, source: 'wechat' }).catch(error => log(`收录失败：${error.code || error.name || 'unknown'}`))
    }
    return triage(event)
  }

  async function triage(event) {
    if (!event.text || !event.text.trim()) return
    try {
      const result = await triageMessage(event, journalCommand, llm,
        () => readFile(join(journalDir, 'RULES.md'), 'utf8'), log)
      if (result && result.receipt) await sendReply(result.receipt, event)
    } catch (error) {
      log(`分诊或回执失败：${error.code || error.name || 'unknown'}`)
      // 静默失败最糟：用户以为记下了。至少回一句，别让人等。
      try {
        await sendReply('未能确认这条消息的保存结果，请在账本中核对。原文仍保留在微信记录中。', event)
      } catch (sendError) {
        log(`失败回执也没发出去：${sendError.message}`)
      }
    }
  }

  /* ------------------------------------------------------------- actions */

  async function addItem(input) {
    const url = normalizeUrl(input.url)
    if (!url) throw new Error('无效链接：需要一个 http(s) URL。')
    const now = new Date().toISOString()
    const key = dedupeKey(url)

    const result = await store.mutate((data) => {
      const existing = data.items.find((item) => dedupeKey(item.url) === key)
      if (existing) {
        let updated = false
        const restored = existing.status === 'dropped'
        const extraNote = pickString(input.note)
        if (extraNote && !existing.note.includes(extraNote)) {
          existing.note = existing.note ? `${existing.note}\n${extraNote}` : extraNote
          updated = true
        }
        if (existing.status === 'dropped') existing.status = 'inbox'
        existing.updatedAt = now
        return { item: compactItem(existing), duplicate: true, updated, restored }
      }
      const providedTitle = pickString(input.title, 400)
      const item = {
        id: `it_${randomUUID().slice(0, 8)}`,
        url,
        title: providedTitle || labelFor(url),
        titleResolved: Boolean(providedTitle),
        site: siteOf(url),
        note: pickString(input.note),
        tags: [],
        status: 'inbox',
        summary: '',
        minutes: null,
        kind: '',
        addedAt: now,
        updatedAt: now,
        source: ['wechat', 'manual', 'agent'].includes(input.source) ? input.source : 'manual',
      }
      data.items.push(item)
      return { item: compactItem(item), duplicate: false }
    })

    const titlePromise = needsTitle(result.item)
      ? enrich(result.item.id, result.item.url, { retries: 2 })
      : Promise.resolve(result.item.title)
    if (input.source === 'wechat' && input.acknowledge !== false) void ackCaptured(titlePromise, result)
    else void titlePromise.catch(error => log(`资料标题更新失败：${error.code || error.name || 'unknown'}`))
    // 转发进来的链接不该等用户开口才读正文、才进笔记库：后台补正文，
    // ensureBody 写完正文会自己调 syncObsidian，存好后 notifyObsidianSaved 回一条通知。
    if (obsidianVault) void autoStoreLater(result.item.id, result.item.url)
    return result
  }

  /** 后台补正文并同步 Obsidian：出错只记日志，不能影响收录回执。 */
  async function autoStoreLater(id, url) {
    try {
      await ensureBody(id, url)
    } catch (error) {
      log(`obsidian: 后台补正文失败 ${String(error?.message || error).slice(0, 200)}`)
    }
  }

  /** Short WeChat receipt so the user knows the link landed. */
  async function ackCaptured(titlePromise, result) {
    try {
      const title = await titlePromise
      await bot.sendText(readingReceipt(result, title))
    } catch (error) {
      log(`回执发送失败：${error.message}`)
    }
  }

  /** Fill in a readable title (and a lead-in summary) once the page has been fetched. */
  async function enrich(id, url, options = {}) {
    let meta = await fetchMeta(url)
    // Login walls and JS shells often answer the first request; retry once.
    if (looksGeneric(meta.title)) {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const retry = await fetchMeta(url)
      if (!looksGeneric(retry.title) || !meta.description) meta = retry
    }
    // Still a shell: let the Python client try (different TLS fingerprint).
    if (looksGeneric(meta.title)) {
      const alt = await pythonMeta(url, pythonOverride)
      if (alt) meta = { title: alt.title || meta.title, description: alt.description || meta.description }
    }
    const title = looksGeneric(meta.title) ? '' : meta.title
    if (!title && !meta.description) {
      if ((options.retries || 0) > 0) scheduleRetry(id, url, options.retries)
      return ''
    }
    await store.mutate((data) => {
      const item = data.items.find((entry) => entry.id === id)
      if (!item) return
      if (title && needsTitle(item)) {
        item.title = title
        item.titleResolved = true
      }
      if (!item.summary && meta.description) item.summary = meta.description
      item.updatedAt = new Date().toISOString()
    })
    return title
  }

  /**
   * Store the article body once, so the weekly digest can summarise content
   * instead of inferring it from a headline.
   */
  async function ensureBody(id, url) {
    // An article that already has text may still lack the header fields the
    // Obsidian note wants, so those are backfilled on a later pass.
    const wanted = await store.read((data) => {
      const item = data.items.find((entry) => entry.id === id)
      return Boolean(item && item.status !== 'dropped' && (!item.body || !item.author))
    })
    if (!wanted) return false
    const article = await pythonArticle(url, pythonOverride)
    if (!article) {
      await store.mutate((data) => {
        const item = data.items.find((entry) => entry.id === id)
        if (item && !item.body) item.bodyError = fetchState.bodyError
      })
      return false
    }
    let changed = false
    await store.mutate((data) => {
      const item = data.items.find((entry) => entry.id === id)
      if (!item) return
      if (!item.body) {
        item.body = article.body.slice(0, BODY_LIMIT)
        item.bodyChars = article.chars
        item.bodyAt = new Date().toISOString()
        delete item.bodyError
        if (article.title && needsTitle(item)) {
          item.title = article.title
          item.titleResolved = true
        }
        if (!item.summary && article.description) item.summary = article.description.slice(0, 500)
        changed = true
      }
      if (article.author && item.author !== article.author) {
        item.author = article.author
        changed = true
      }
      if (article.publishedAt && item.publishTime !== article.publishedAt) {
        item.publishTime = article.publishedAt
        changed = true
      }
      if (changed) item.updatedAt = new Date().toISOString()
    })
    if (changed) void syncObsidian(id)
    return changed
  }

  /**
   * Copy the freshly stored article into the Obsidian vault.
   *
   * Deliberately detached from the capture path: the note is a convenience,
   * while the inbox write is the thing that must not fail.
   */
  async function syncObsidian(id) {
    if (!obsidianVault) return
    const python = await resolvePython(pythonOverride)
    if (!python) {
      log('obsidian: no python interpreter, skipped')
      return
    }
    const result = await pythonObsidian(python, {
      inbox: join(dataDir, 'inbox.json'),
      vault: obsidianVault,
      folder: obsidianFolder,
      itemId: id,
    })
    if (result?.ok) {
      const written = Array.isArray(result.written) ? result.written : []
      if (written.length) {
        log(`obsidian: wrote ${written.length} note(s) for ${id}`)
        void notifyObsidianSaved(id, written)
      }
      return
    }
    const detail = result?.error || (result?.errors || [])[0]?.error || 'unknown error'
    log(`obsidian: export failed for ${id}: ${String(detail).slice(0, 200)}`)
    await store.mutate((data) => {
      const item = data.items.find((entry) => entry.id === id)
      if (item) item.obsidianError = String(detail).slice(0, 300)
    }).catch(() => {})
  }

  /**
   * 收链接时微信只回了「已收下」，存进 Obsidian 是后台悄悄做的，
   * 用户看不到成没成。文件真写进库之后单独回一条，带文件名，好核对。
   * 同一篇重复写入（正文刷新会重导）不重复打扰。
   */
  async function notifyObsidianSaved(id, written) {
    if (!obsidianNotify) return
    const first = (Array.isArray(written) && written[0]) || null
    const name = String((first && first.path) || first || '').split('/').pop()
    let fresh = null
    try {
      fresh = await store.mutate((data) => {
        const item = data.items.find((entry) => entry.id === id)
        if (!item) return null
        const first = item.obsidianFile !== name
        item.obsidianFile = name
        item.obsidianAt = new Date().toISOString()
        delete item.obsidianError
        return first ? { title: item.title || item.url || '这篇文章', name } : null
      })
    } catch (error) {
      log(`obsidian: 记录写入状态失败 ${String(error?.message || error).slice(0, 200)}`)
      return
    }
    if (!fresh) return
    try {
      const lines = [`✅ 已存入 Obsidian：《${fresh.title}》`]
      if (fresh.name) lines.push(`文件：${obsidianFolder}/${fresh.name}`)
      await bot.sendText(lines.join('\n'))
    } catch (error) {
      log(`obsidian: 通知发送失败 ${String(error?.message || error).slice(0, 200)}`)
    }
  }

  const retryTimers = new Set()
  ctx.effect(() => () => {
    for (const timer of retryTimers) clearTimeout(timer)
    retryTimers.clear()
  })
  /** Titles that failed once often succeed a few minutes later. */
  function scheduleRetry(id, url, retriesLeft) {
    const delay = 2 * 60 * 1000 * Math.pow(4, 2 - retriesLeft)
    const timer = setTimeout(() => {
      retryTimers.delete(timer)
      void enrich(id, url, { retries: retriesLeft - 1 })
    }, delay)
    retryTimers.add(timer)
  }

  async function updateItem(id, patch) {
    return store.mutate((data) => {
      const item = data.items.find((entry) => entry.id === id)
      if (!item) throw new Error(`找不到条目：${id}`)
      const status = pickStatus(patch.status)
      if (status) item.status = status
      if (typeof patch.title === 'string' && patch.title.trim()) {
        item.title = pickString(patch.title, 400)
        item.titleResolved = true
      }
      if (typeof patch.note === 'string') item.note = pickString(patch.note)
      if (typeof patch.summary === 'string') item.summary = pickString(patch.summary, 4000)
      if (typeof patch.kind === 'string') item.kind = pickString(patch.kind, 40)
      if (Array.isArray(patch.tags)) item.tags = patch.tags.map((tag) => pickString(tag, 40)).filter(Boolean).slice(0, 8)
      if (typeof patch.minutes === 'number' && Number.isFinite(patch.minutes)) {
        item.minutes = Math.max(1, Math.min(600, Math.round(patch.minutes)))
      }
      item.updatedAt = new Date().toISOString()
      return compactItem(item)
    })
  }

  /* ------------------------------------------------------------- exports */

  function slugify(text) {
    const slug = String(text || '')
      .replace(/[\\/:*?"<>|]/gu, '')
      .replace(/\s+/gu, '-')
      .slice(0, 40)
      .replace(/^-+|-+$/gu, '')
    return slug || 'digest'
  }

  function escapeHtml(text) {
    return String(text || '')
      .replace(/&/gu, '&amp;')
      .replace(/</gu, '&lt;')
      .replace(/>/gu, '&gt;')
      .replace(/"/gu, '&quot;')
  }

  function digestMarkdown(digest, items) {
    const byId = new Map(items.map((item) => [item.id, item]))
    const lines = [`# ${digest.title}`, '']
    if (digest.intro) lines.push(`> ${digest.intro}`, '')
    lines.push(`_${localDay(new Date(digest.createdAt))}_`, '')
    for (const section of digest.sections) {
      lines.push(`## ${section.heading}`, '')
      if (section.body) lines.push(section.body, '')
      for (const id of section.itemIds || []) {
        const item = byId.get(id)
        if (!item) continue
        lines.push(`- [${item.title}](${item.url})${item.site ? ` — ${item.site}` : ''}`)
      }
      if ((section.itemIds || []).length > 0) lines.push('')
    }
    const top = digest.topPickId ? byId.get(digest.topPickId) : null
    if (top) {
      lines.push('## 如果只读一条', '', `[${top.title}](${top.url})`, '')
      if (digest.topPickReason) lines.push(digest.topPickReason, '')
    }
    lines.push('---', '', `由 DSH 碎片阅读收件箱生成 · ${new Date().toISOString()}`)
    return `${lines.join('\n')}\n`
  }

  function digestHtml(digest, items) {
    const byId = new Map(items.map((item) => [item.id, item]))
    const refs = (ids) =>
      (ids || [])
        .map((id) => {
          const item = byId.get(id)
          if (!item) return ''
          return `<a class="ref" href="${escapeHtml(item.url)}">${escapeHtml(item.title)}<span>${escapeHtml(item.site)}</span></a>`
        })
        .join('')
    const sections = digest.sections
      .map(
        (section) => `<section>
<h2>${escapeHtml(section.heading)}</h2>
${section.body ? `<p>${escapeHtml(section.body).replace(/\n/gu, '<br>')}</p>` : ''}
${refs(section.itemIds)}
</section>`,
      )
      .join('\n')
    const top = digest.topPickId ? byId.get(digest.topPickId) : null
    const pick = top
      ? `<div class="pick"><div class="label">如果只读一条</div><a href="${escapeHtml(top.url)}">${escapeHtml(top.title)}</a>${
          digest.topPickReason ? `<p>${escapeHtml(digest.topPickReason)}</p>` : ''
        }</div>`
      : ''
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(digest.title)}</title>
<style>
:root { color-scheme: light dark; }
body { margin:0; background:#fafafa; color:#1a1a1a; font:16px/1.75 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
main { max-width:720px; margin:0 auto; padding:56px 24px 80px; }
.meta { font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:#8a8a8a; }
h1 { font-size:28px; line-height:1.35; margin:10px 0 0; letter-spacing:-.01em; }
.intro { margin:16px 0 0; color:#333; }
section { margin-top:36px; padding-top:28px; border-top:1px solid #e6e6e6; }
h2 { font-size:18px; margin:0 0 10px; }
p { margin:0 0 12px; }
.ref { display:block; margin:8px 0; font-size:14px; color:#2f6bff; text-decoration:none; }
.ref span { color:#8a8a8a; font-size:12px; margin-left:8px; }
.pick { margin-top:40px; padding:18px 20px; background:#f0f4ff; border-radius:12px; }
.pick .label { font-size:12px; color:#5a6b8c; }
.pick a { display:block; margin-top:6px; font-weight:600; color:#1a1a1a; text-decoration:none; }
footer { margin-top:48px; font-size:12px; color:#9a9a9a; }
@media (prefers-color-scheme: dark) {
  body { background:#111; color:#eaeaea; }
  .intro { color:#c9c9c9; }
  section { border-color:#2a2a2a; }
  .pick { background:#16203a; }
  .pick a { color:#fff; }
  .ref { color:#7aa2ff; }
}
</style>
</head>
<body><main>
<div class="meta">碎片阅读周报 · ${localDay(new Date(digest.createdAt))}</div>
<h1>${escapeHtml(digest.title)}</h1>
${digest.intro ? `<p class="intro">${escapeHtml(digest.intro)}</p>` : ''}
${sections}
${pick}
<footer>由 DSH 碎片阅读收件箱生成 · ${new Date().toISOString()}</footer>
</main></body></html>
`
  }

  async function writeDigestFiles(digest, items) {
    const dir = join(dataDir, 'digests')
    await mkdir(dir, { recursive: true })
    const base = `${localDay(new Date(digest.createdAt))}-${slugify(digest.title)}`
    const md = join(dir, `${base}.md`)
    const html = join(dir, `${base}.html`)
    await writeFile(md, digestMarkdown(digest, items), 'utf8')
    await writeFile(html, digestHtml(digest, items), 'utf8')
    return { md, html }
  }

  async function saveDigest(input) {
    const now = new Date().toISOString()
    const sections = Array.isArray(input.sections)
      ? input.sections
          .map((section) => ({
            heading: pickString(section && section.heading, 120) || '未命名',
            body: pickString(section && section.body, 4000),
            itemIds: Array.isArray(section && section.itemIds)
              ? section.itemIds.map((id) => pickString(id, 40)).filter(Boolean)
              : [],
          }))
          .filter((section) => section.heading)
      : []
    if (sections.length === 0) throw new Error('周报至少需要一个 section（含 heading）。')
    const digest = {
      id: `dg_${randomUUID().slice(0, 8)}`,
      title: pickString(input.title, 160) || '本周碎片整理',
      intro: pickString(input.intro, 2000),
      sections,
      topPickId: pickString(input.topPickId, 40),
      topPickReason: pickString(input.topPickReason, 800),
      createdAt: now,
    }
    await store.mutate((data) => {
      data.digests.unshift(digest)
      data.digests = data.digests.slice(0, 30)
    })
    try {
      const items = await store.read((data) => data.items)
      const files = await writeDigestFiles(digest, items)
      digest.files = files
      await store.mutate((data) => {
        const found = data.digests.find((entry) => entry.id === digest.id)
        if (found) found.files = files
      })
    } catch (error) {
      log(`周报导出失败：${error.message}`)
    }
    return digest
  }

  /* --------------------------------------------------------------- tools */

  const tool = (definition) => ctx.effect(() => ctx.tools.register(definition))

  tool({
    name: 'reading_add',
    description:
      '把一条推送收进「碎片阅读收件箱」。用户从微信文件传输助手转来链接、或你在整理时补充材料都用它。同一链接不会重复入库，只合并备注。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '文章或资源链接（http/https）。' },
        title: { type: 'string', description: '标题；抓不到时可省略，界面会先用链接。' },
        note: { type: 'string', description: '用户当时的备注，例如“想试试这个工具”。' },
        source: { type: 'string', enum: ['wechat', 'manual', 'agent'], description: '来源渠道。' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        const item = value && value.item ? value.item : {}
        const prefix = value.restored ? '已恢复到阅读收件箱' : value.updated ? '已补充资料备注'
          : value.duplicate ? '这条资料已存在，未重复添加' : '已加入阅读收件箱'
        return textBlock(`${prefix}：${item.title || item.url || ''}`)
      },
    },
    async execute(args) {
      return addItem(args || {})
    },
  })

  tool({
    name: 'reading_list',
    description:
      '列出收件箱条目，默认给出待读和稍后（还没处理）的条目。做周报或回答“我这周攒了什么”时先调用它。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: STATUSES, description: '按状态过滤；省略则返回待读 + 稍后。' },
        limit: { type: 'number', description: '最多返回多少条，默认 50。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        const counts = value.counts || {}
        const items = Array.isArray(value.items) ? value.items : []
        const lines = [`共 ${items.length} 条（待读 ${counts.inbox ?? 0} / 稍后 ${counts.later ?? 0} / 已读 ${counts.read ?? 0} / 已弃 ${counts.dropped ?? 0}）`]
        for (const item of items) {
          const flags = [STATUS_LABELS[item.status] || item.status]
          flags.push(item.hasBody ? `正文 ${item.bodyChars || 0} 字` : item.bodyError ? `未抓到正文：${item.bodyError}` : '无正文')
          if (item.summary) flags.push(`摘要：${String(item.summary).slice(0, 80)}`)
          if (item.note) flags.push(`备注：${String(item.note).slice(0, 60)}`)
          lines.push(`${item.id} · ${item.title || item.url}（${flags.join('；')}）`)
        }
        return textBlock(lines.join('\n'))
      },
    },
    async execute(args) {
      const status = pickStatus(args && args.status)
      const limit = Math.max(1, Math.min(200, Number((args && args.limit) || 50) || 50))
      return store.read((data) => {
        const filtered = status ? data.items.filter((item) => item.status === status)
          : data.items.filter((item) => item.status === 'inbox' || item.status === 'later')
        return {
          items: sortItems(filtered).slice(0, limit).map(compactItem),
          counts: countsOf(data.items),
        }
      })
    },
  })

  tool({
    name: 'reading_get',
    description: '按 id 读取一条收件箱条目的完整信息。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '条目 id，形如 it_ab12cd34。' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        const item = value.item || {}
        const body = String(item.body || '')
        const lines = [`${item.title}\n${item.url}`]
        if (body) {
          lines.push('', body)
          const total = Number(item.bodyChars) || body.length
          if (total > body.length) lines.push(`（正文共 ${total} 字，以上是前 ${body.length} 字）`)
        } else lines.push('', '（这篇只有标题和链接，还没有正文；可先用 reading_refresh 重试抓取）')
        return textBlock(lines.join('\n'))
      },
    },
    async execute(args) {
      const id = pickString(args && args.id, 40)
      return store.read((data) => {
        const item = data.items.find((entry) => entry.id === id)
        if (!item) throw new Error(`找不到条目：${id}`)
        return { item, digestMentions: data.digests.filter((d) => d.sections.some((s) => s.itemIds.includes(id))).length }
      })
    },
  })

  tool({
    name: 'reading_update',
    description:
      '更新条目：状态（inbox 待读 / later 稍后 / read 已读 / dropped 丢弃）、摘要、标签、类型、预计阅读分钟数。用户说“这条看过了”或你整理完一条时调用。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: STATUSES },
        title: { type: 'string' },
        note: { type: 'string' },
        summary: { type: 'string', description: '一句话说清这篇讲什么。' },
        kind: { type: 'string', description: '类型：论文 / 工具 / 观点 / 教程 / 其他。' },
        tags: { type: 'array', items: { type: 'string' } },
        minutes: { type: 'number' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        return textBlock(`已更新资料：${value.item.title}（状态：${STATUS_LABELS[value.item.status] || value.item.status}）`)
      },
    },
    async execute(args) {
      const id = pickString(args && args.id, 40)
      return { item: await updateItem(id, args || {}) }
    },
  })

  tool({
    name: 'reading_refresh',
    description:
      '重新抓取条目的标题与摘要。用于小红书、知乎这类抓取失败、或标题只显示站名/链接的条目。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '只刷新这一条；省略则刷新所有标题不可用的条目。' },
        all: { type: 'boolean', description: 'true 表示刷新全部条目（会慢一些）。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        return textBlock(`检查 ${value.refreshed} 条，更新 ${value.updated.length} 条标题。`)
      },
    },
    async execute(args) {
      const id = pickString(args && args.id, 40)
      const all = Boolean(args && args.all)
      const targets = await store.read((data) =>
        data.items
          .filter((item) => (id ? item.id === id : all ? true : needsTitle(item) || !item.summary))
          .slice(0, 30)
          .map((item) => [item.id, item.url]),
      )
      const updated = []
      for (const [itemId, url] of targets) {
        const title = await enrich(itemId, url)
        const body = await ensureBody(itemId, url)
        if (title || body) updated.push({ id: itemId, title, body })
      }
      return {
        refreshed: targets.length,
        updated,
        python: await resolvePython(pythonOverride),
        errors: fetchState.metaError ? [fetchState.metaError] : [],
        bodyErrors: fetchState.bodyError ? [fetchState.bodyError] : [],
      }
    },
  })

  tool({
    name: 'reading_export_obsidian',
    description:
      '把收件箱里已抓到正文的文章另存为 Obsidian 笔记。用户说“存到 Obsidian/我的笔记库”时调用；省略 id 则同步全部。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '只导出这一条；省略则导出所有已有正文的条目。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        if (!value.vault) {
          return textBlock('未配置 Obsidian 库路径（config.obsidian.vault），没有导出任何文件。')
        }
        const written = Array.isArray(value.written) ? value.written : []
        const skipped = Array.isArray(value.skipped) ? value.skipped : []
        const removed = Array.isArray(value.removed) ? value.removed : []
        const errors = Array.isArray(value.errors) ? value.errors : []
        if (!written.length && !errors.length && !removed.length) {
          return textBlock(`没有需要写入的笔记：${skipped.length} 篇已是最新。库：${value.vault}`)
        }
        const lines = [`写入 ${written.length} 篇，跳过 ${skipped.length} 篇，库：${value.vault}`]
        for (const row of written.slice(0, 20)) lines.push(`· ${row.path}（${row.chars} 字）`)
        for (const row of removed.slice(0, 10)) lines.push(`· 移除旧版本 ${row.path}`)
        for (const row of errors.slice(0, 5)) lines.push(`· 失败 ${row.id || ''}：${row.error}`)
        return textBlock(lines.join('\n'))
      },
    },
    async execute(args) {
      if (!obsidianVault) {
        return { vault: '', written: [], skipped: [], errors: [] }
      }
      const python = await resolvePython(pythonOverride)
      if (!python) {
        return { vault: obsidianVault, written: [], skipped: [], errors: [{ error: '没有可用的 python' }] }
      }
      const id = pickString(args && args.id, 40)
      const result = await pythonObsidian(python, {
        inbox: join(dataDir, 'inbox.json'),
        vault: obsidianVault,
        folder: obsidianFolder,
        itemId: id,
      })
      return { vault: obsidianVault, folder: obsidianFolder, ...result }
    },
  })

  tool({
    name: 'reading_attachments',
    description:
      '列出从微信保存下来的附件（发票、合同、图片等本地文件），可按月份过滤。用户问“上个月的发票在哪”时调用。',
    parameters: {
      type: 'object',
      properties: {
        month: { type: 'string', description: '月份，形如 2026-11；省略则列出全部。' },
        limit: { type: 'number', description: '最多返回多少条，默认 50。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        if (!value.items.length) return textBlock(value.total ? '该月份没有附件。' : '还没有保存过附件。')
        const lines = value.items.map((item) => `${String(item.at || '').slice(0, 10)} · ${item.name}（${item.kind}，${item.bytes} B）· ${item.path}`)
        return textBlock(`共 ${value.total} 个附件：\n${lines.join('\n')}`)
      },
    },
    async execute(args) {
      const month = pickString(args && args.month, 10)
      const limit = Math.max(1, Math.min(200, Number((args && args.limit) || 50) || 50))
      const file = join(journalDir, 'attachments', 'index.jsonl')
      if (!existsSync(file)) return { items: [], total: 0 }
      const items = []
      for (const line of (await readFile(file, 'utf8')).split('\n')) {
        if (!line.trim()) continue
        try {
          const record = JSON.parse(line)
          if (month && !String(record.at || '').startsWith(month)) continue
          items.push(record)
        } catch {
          /* a torn line should not hide the rest */
        }
      }
      return { items: items.slice(-limit).reverse(), total: items.length }
    },
  })

  tool({
    name: 'reading_digest_save',
    description:
      '保存一期「碎片阅读周报」，界面会在周报标签页展示。做完整理汇报后必须调用，否则用户在页面上看不到。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '周报标题，例如“第 3 周 · 值得动手的两个工具”。' },
        intro: { type: 'string', description: '开篇两三句：这周整体攒了什么、主线是什么。' },
        sections: {
          type: 'array',
          description: '按主题分组的内容块。',
          items: {
            type: 'object',
            properties: {
              heading: { type: 'string', description: '小标题，例如“先读这两篇”。' },
              body: { type: 'string', description: '这一组的点评：为什么值得读、彼此什么关系。' },
              itemIds: { type: 'array', items: { type: 'string' }, description: '关联的条目 id。' },
            },
            required: ['heading'],
            additionalProperties: false,
          },
        },
        topPickId: { type: 'string', description: '如果只读一条，读哪条（条目 id）。' },
        topPickReason: { type: 'string', description: '为什么是它。' },
      },
      required: ['title', 'sections'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        return textBlock(`周报已保存：${value.digest.title}`)
      },
    },
    async execute(args) {
      const digest = await saveDigest(args || {})
      return { digest }
    },
  })

  tool({
    name: 'reading_digest_latest',
    description: '读取最近一期周报；没有则返回 null。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        if (!value.digest) return textBlock('还没有周报。')
        return textBlock(digestText(value.digest))
      },
    },
    async execute() {
      return store.read((data) => ({ digest: data.digests[0] || null }))
    },
  })

  tool({
    name: 'reading_wechat_status',
    description:
      '查看微信通道状态：是否已连接、最近收到的消息、以及未连接时的扫码链接。用户问“微信连上了吗”或你要把链接发给用户时调用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        if (value.wechat.status === 'connected') return textBlock('微信已连接。')
        if (value.wechat.url) return textBlock(`等待扫码：${value.wechat.url}`)
        return textBlock(`微信${WECHAT_STATUS_LABELS[value.wechat.status] || '连接状态未知'}。`)
      },
    },
    async execute() {
      return { wechat: bot.snapshot() }
    },
  })

  tool({
    name: 'reading_wechat_login',
    description:
      '发起微信扫码登录，返回一个在微信里打开的链接。用户确认后，转发给机器人的链接会自动进入收件箱。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        if (value.wechat.url) return textBlock(`把这条链接发到微信里打开：${value.wechat.url}`)
        return textBlock(`微信${WECHAT_STATUS_LABELS[value.wechat.status] || '连接状态未知'}。`)
      },
    },
    async execute() {
      return { wechat: await bot.startLogin() }
    },
  })

  tool({
    name: 'reading_journal_llm_status',
    description: '查看账本 LLM 是否启用、Harness 模型服务是否就绪、最近调用状态。不返回密钥或消息原文。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render(args, value) {
      if (!value.enabled) return textBlock('账本模型已禁用，即时记录使用规则分诊。')
      if (!value.available) return textBlock('账本模型服务尚未加载。')
      if (value.route_error) return textBlock(`尚未选定账本模型（${value.route_error}）。`)
      const recent = value.lastCall ? value.lastCall.ok ? '最近一次模型调用成功。' : `最近一次模型调用失败（${value.lastCall.code || '原因未知'}）。` : '尚无模型调用记录。'
      const source = value.selection?.source === 'journal-schedule' ? `跟随定时任务「${value.selection.schedule.title}」所属会话。` : ''
      return textBlock(`已选定模型：${value.route?.provider}/${value.route?.model}。${source}${recent}`)
    } },
    async execute() { return { ...await llm.diagnostics(), chat_enabled: chatEnabled } },
  })

  tool({
    name: 'reading_journal_review',
    description: '调用 Harness 已配置的 LLM 做晚间收口或周报分析，校验逐字引用，返回整理建议、本子回应和现有任务的下一步。不会自动修改项目、完成任务或推送微信。必须继续 coverage.next_offset 分页，partial_source_ids 需核对完整来源；建议通过现有 evidence / notebook-review 命令保存。',
    parameters: { type: 'object', properties: {
      mode: { type: 'string', enum: ['daily', 'weekly'] },
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 30 },
    }, required: ['mode'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render(args, value) {
      // The model reads this text, not the structured value: without the
      // findings, coverage and notebook hashes here, the review output is
      // unusable and nothing can be saved back.
      const payload = JSON.stringify(value ?? {}, null, 1)
      const shown = payload.length > 12000 ? `${payload.slice(0, 12000)}\n…（已截断，先按 coverage.next_offset 继续分页）` : payload
      return textBlock(`已生成整理建议，尚未写入账本。确认后须另行保存。\n\n${shown}`)
    } },
    async execute(args) {
      if (!['daily', 'weekly'].includes(args?.mode)) throw new Error('mode 必须为 daily 或 weekly')
      const offset = args.offset ?? 0
      const limit = args.limit ?? 6
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 30) throw new Error('分页参数无效')
      const context = await journalCommand(['context', '--offset', String(offset), '--limit', String(limit)])
      const snapshot = await journalCommand(['notebook-review'])
      const notebook = Object.fromEntries(['hash', 'pending', 'latest', 'responses', 'notebook', 'sections'].map(key => [key, snapshot[key]]))
      const rules = await readFile(join(journalDir, 'RULES.md'), 'utf8')
      // Only first page proposes notebook responses; later pages still read its context.
      if (offset > 0) notebook.pending = false
      const result = await llm.review(context, notebook, rules, args.mode)
      if (!notebook.pending) result.notebook_responses = []
      return result
    },
  })

  tool({
    name: 'reading_journal_context',
    description: '晚间收口或周报必须先调用。读取本子、项目、待答问题、工作区变化和文献快照。证据只表示观察，不等于进展；按 journal/RULES.md 处理并引用来源。若 next_offset 非空，继续分页。',
    parameters: {type:'object',properties:{offset:{type:'integer',minimum:0}},additionalProperties:false},
    output: {schema:{type:'object',additionalProperties:true},render(args,value){
      const projects = value.projects || []
      const items = value.items || []
      const evidence = value.evidence || []
      const open = items.filter((item) => item.type === 'task' && item.status === 'open')
      // 模型只能看到这段文本：没有日期它就分不清今天和下周，早间提醒会误报「今天没有日程」。
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
      const weekday = '日一二三四五六'[new Date(`${day}T12:00:00+08:00`).getUTCDay()]
      const when = (item) => {
        const at = item.at || {}
        if (at.date && at.clock) return `${at.date} ${at.clock}`
        if (at.date) return `${at.date} ${at.slot || ''}`.trim()
        if (item.due) return `截止 ${item.due}`
        return ''
      }
      const timed = open.filter((item) => when(item))
      const untimed = open.filter((item) => !when(item))
      const lines = [`今天 ${day}（周${weekday}）· 项目 ${projects.length} · 条目 ${items.length}（未完成 ${open.length}） · 待核对来源 ${value.total ?? evidence.length} 条（本页 ${evidence.length}）`]
      if (projects.length) lines.push('项目：' + projects.slice(0, 10).map((p) => `${p.id}·${p.name}`).join('、'))
      if (timed.length) {
        lines.push(`有时间的未完成 ${timed.length} 条：`)
        for (const item of timed.slice(0, 12)) {
          lines.push(`  ${item.id} · ${item.text} · ${when(item)}${item.place ? ` · ${item.place}` : ''}`)
        }
      }
      if (untimed.length) lines.push(`无时间的未完成 ${untimed.length} 条：` + untimed.slice(0, 10).map((i) => `${i.id}·${i.text}`).join('、'))
      for (const row of evidence.slice(0, 10)) {
        lines.push(`来源 ${row.id} · ${row.kind || ''} · ${row.title || row.locator || ''} · version ${row.version ?? ''} · ${row.status || ''}`)
        const excerpt = (row.excerpt || '').replace(/\s+/g, ' ').trim()
        if (excerpt) lines.push(`  原文：${excerpt.length > 400 ? `${excerpt.slice(0, 400)}…` : excerpt}`)
      }
      lines.push(value.next_offset === null || value.next_offset === undefined ? '已到最后一页。' : `还有来源未返回，继续分页：offset=${value.next_offset}`)
      return textBlock(lines.join('\n'))
    }},
    execute(args){return journalCommand(['context','--offset',String(args?.offset||0)])},
  })

  tool({
    name: 'reading_wechat_push',
    description: '把一段文本（例如周报摘要）发回用户的微信。仅在微信已连接时可用。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '要发送的内容，4000 字以内。先回应用户具体记录，再提一件下一步；没有记录不等于没有做。' },
        question_id: {type:'string',description:'如有提问，传入 ask --prepared 返回的 id。发送成功才激活，选项须与登记一致。'} },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        return textBlock(value?.question_activated === false
          ? '消息已发送到微信，但问题回复识别未启用。请重试启用问题，不要重复发送消息。'
          : '消息已发送到微信。')
      },
    },
    async execute(args) {
      const text = pickString(args && args.text, 4000)
      if (!text) throw new Error('缺少 text')
      if (args.question_id) {
        const pending = await journalCommand(['pending'])
        const question = pending.open.find(p=>p.id===args.question_id)
        if (!question || !text.includes(question.question)) throw new Error('待发问题不存在或正文未包含完整问题')
        if ((question.choices||[]).some(c=>!text.includes(c.label))) throw new Error('正文未包含登记的全部选项')
      }
      await bot.sendText(text)
      if (args.question_id) {
        try {await journalCommand(['question-sent','--id',args.question_id])}
        catch(error){return {ok:true,sent:true,question_activated:false,error:error.message,warning:'消息已发送，不要重发；请单独重试 question-sent。'}}
      }
      return { ok: true }
    },
  })

  tool({
    name: 'reading_wechat_send',
    description: '把本机上的一个文件发到用户微信（图片走图片消息，其余走文件消息）。用户说“把这个发我”时用。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '本机文件的绝对路径。' } },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        const size = value.bytes >= 1024 ? `${Math.round(value.bytes / 1024)} KB` : `${value.bytes} B`
        return textBlock(`已发送到微信：${value.fileName}（${size}）`)
      },
    },
    async execute(args) {
      const path = pickString(args && args.path, 500)
      if (!existsSync(path)) throw new Error(`找不到文件：${path}`)
      const name = path.split(/[\\/]/u).pop()
      const asImage = /\.(?:jpe?g|png|gif|webp)$/iu.test(name)
      const sent = await bot.sendFile(path, { fileName: await sendNameForPath(path), asImage })
      return { ok: true, ...sent }
    },
  })

  tool({
    name: 'reading_wechat_events',
    description:
      '查看微信通道最近收到的原始消息（含无法解析成链接的卡片、图片等），用于排查“转发了但没收进来”。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        const events = value.events || []
        const lines = [`最近 ${events.length} 条微信消息：`]
        for (const event of events) {
          lines.push(`${event.at || ''} · ${event.journal_route || ''} · ${String(event.text || '').slice(0, 80) || '（无文本）'}`)
        }
        return textBlock(lines.join('\n'))
      },
    },
    async execute() {
      return { events: bot.events.slice(-20).reverse() }
    },
  })

  /* ---------------------------------------------------------------- HTTP */

  async function readBody(req, limit = 1024 * 1024) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > limit) throw new Error('请求体过大')
      chunks.push(chunk)
    }
    if (chunks.length === 0) return {}
    const text = Buffer.concat(chunks).toString('utf8')
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('请求体不是合法 JSON')
    }
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const path = url.pathname
    try {
      if (req.method === 'GET' && path === '/reading-inbox/api/llm/status') {
        return sendJson(res, 200, { ...await llm.diagnostics(), chat_enabled: chatEnabled })
      }
      if (req.method === 'POST' && path === '/reading-inbox/api/llm/probe') {
        if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
          return sendJson(res, 415, { error: '需要 application/json 请求' })
        }
        if (req.headers.origin && req.headers.origin !== ctx.webServer.getOrigin()) {
          return sendJson(res, 403, { error: '仅允许本机应用来源' })
        }
        await readBody(req, 1024)
        // Fixed, non-personal input: no notebook, chat history or WeChat send.
        const result = await llm.chat({ text: '连接测试，请只回复“连接正常”。', history: [], journal: {}, timezone: 'Asia/Shanghai' })
        return sendJson(res, 200, { ok: true, ...result })
      }
      if (req.method === 'GET' && path === '/reading-inbox/api/state') {
        const state = await store.read((data) => ({
          items: sortItems(data.items).map(compactItem),
          digests: data.digests,
          counts: countsOf(data.items),
        }))
        return sendJson(res, 200, { ...state, wechat: bot.snapshot(), ui, llm: llm.status })
      }

      if (req.method === 'GET' && path === '/reading-inbox/api/debug') {
        const script = join(HERE, 'tools', 'fetch_meta.py')
        return sendJson(res, 200, {
          here: HERE,
          script,
          scriptExists: existsSync(script),
          python: await resolvePython(pythonOverride),
          metaError: fetchState.metaError,
        })      }

      if (req.method === 'POST' && path === '/reading-inbox/api/heartbeat') {
        ui.pageLoads += 1
        ui.lastPageLoadAt = Date.now()
        return sendJson(res, 200, { ok: true })
      }

      if (req.method === 'POST' && path === '/reading-inbox/wechat/reconnect') {
        await bot.load()
        return sendJson(res, 200, { wechat: await bot.connect() })
      }

      if (req.method === 'POST' && path === '/reading-inbox/wechat/login') {
        return sendJson(res, 200, { wechat: await bot.startLogin() })
      }

      if (req.method === 'POST' && path === '/reading-inbox/wechat/logout') {
        return sendJson(res, 200, { wechat: await bot.logout() })
      }

      if (req.method === 'POST' && path === '/reading-inbox/wechat/send') {
        const body = await readBody(req)
        const text = pickString(body.text, 4000)
        if (!text) return sendJson(res, 400, { error: '缺少 text' })
        const result = await bot.sendText(text)
        return sendJson(res, 200, { ok: true, result })
      }

      if (req.method === 'POST' && path === '/reading-inbox/api/action') {
        const body = await readBody(req)
        const action = pickString(body.action, 20)
        if (action === 'add') {
          return sendJson(res, 200, await addItem({ ...body, source: 'manual' }))
        }
        if (action === 'update') {
          return sendJson(res, 200, { item: await updateItem(pickString(body.id, 40), body) })
        }
        return sendJson(res, 400, { error: '未知 action' })
      }

      if (req.method === 'POST' && path === '/reading-inbox/bridge/ingest') {
        if (bridgeToken) {
          const given = req.headers['x-inbox-token']
          if (given !== bridgeToken) return sendJson(res, 401, { error: 'token 不正确' })
        }
        const body = await readBody(req)
        const result = await addItem({ ...body, source: 'wechat' })
        return sendJson(res, 200, result)
      }

      if (req.method === 'GET' && path === '/reading-inbox/api/health') {
        return sendJson(res, 200, {
          ok: true, dataDir, items: (await store.read((data) => data.items.length)),
          // 配置到底生效没有，看这里最快：插件重载和 DSH 重启后都能核对。
          morning: morningEnabled,
          reminder: { enabled: reminderEnabled, leadMinutes: reminderLead },
        })
      }

      return sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/reading-inbox',
      handler: (req, res) => void handle(req, res),
    }),
  )
}

/** 仅供测试：跨进程占位读的是同一份文件，能在单测里验证。 */
export const _testing = { claimIncomingOnDisk, releaseIncomingOnDisk }
