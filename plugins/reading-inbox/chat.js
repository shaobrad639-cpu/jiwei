/** Bounded conversation memory; only explicit record decisions become evidence. */
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { extractUrls } from './wechat.js'

const hash = text => createHash('sha256').update(text).digest('hex')
const bareConfirmation = text => /^(?:对|是|是的|好|好的|确认|确定|可以|嗯|ok|yes)[。！!\s]*$/iu.test(text.trim())
// 平日只转发链接：正文不进每次分类，只有问到文章内容/周报时才带上。
const CONTENT_HINT = /(周报|正文|这篇|那篇|文章|概括|总结|提炼|主要内容|讲了什么|写了什么|读一下|读过)/u
// “点评”两个字就够；“点评我的收藏”这类裸命令直接走点评，不交给模型去猜。
const REVIEW_COMMAND = /^(?:请)?(?:(?:点评|评价)(?:一下)?(?:我的|这些|那些|这周的)?(?:收藏|收件箱|文章)?|总结一下(?:我的)?(?:收藏|文章)|看看(?:我的)?收藏)[。！!.\s]*$/u
// “面板”：用固定排版把今天讲清楚，不交给模型自由发挥。
const PANEL_COMMAND = /^(?:面板|看板|今日面板|今日|今天的?安排|今天有(?:什么|啥))[。！!.\s]*$/u
// 生成之后想直接在微信里看全文：“发送给我”“念一下”“全文”。
const SEND_COMMAND = /^(?:(?:请)?(?:发送|发|念|来)(?:给我|我|一下|一遍)|(?:看|要)?全文|再看一遍|重发)[。！!.\s]*$/u
// 存错了要撤销：“取消刚才的保存”“撤销上一条”。
const UNDO_COMMAND = /^(?:取消|撤销|撤回|删掉|删除)(?:刚才|刚刚|上一条|最后一条|这次的?)?的?(?:保存|附件|图片|文件|记录|收藏)[。！!.\s]*$/u

function historyOf(state) {
  const history = []
  let size = 0
  for (const turn of [...state.turns].reverse()) {
    if (turn.delivered === false) continue
    size += turn.text.length + turn.reply.length
    if (size > 16000) break
    history.unshift({ user: turn.text, assistant: turn.reply })
  }
  return history
}

function proposalPreview(items, projects) {
  return items.map(item => {
    const details = []
    if (item.due) details.push('截止：' + item.due)
    if (item.at) details.push('时间：' + [item.at.date, item.at.slot, item.at.clock].filter(Boolean).join(' '))
    if (item.place) details.push('地点：' + item.place)
    if (item.project) details.push('项目：' + (projects.find(p => p.id === item.project)?.name || item.project))
    if (item.note) details.push('备注：' + clip(item.note, 80))
    return `· ${item.type === 'task' ? '待办' : '想法'}：${item.text}${details.length ? '（' + details.join('；') + '）' : ''}`
  }).join('\n')
}

export function chatCommand(text) {
  const raw = String(text || '').trim()
  if (raw === '/聊天') return { action: 'start' }
  if (/^\/(?:退出|退出聊天)$/u.test(raw)) return { action: 'stop' }
  if (/^(?:\/新对话|新对话|清空对话)$/u.test(raw)) return { action: 'reset' }
  const note = /^(?:\/记|\/记账)\s+([\s\S]+)$/u.exec(raw)
  if (note) return { action: 'capture', text: note[1].trim() }
  // /发 发票  → 把附件里最像「发票」的那份发回微信；不带关键词就是最近一份。
  const send = /^\/发(?:\s+([\s\S]+))?$/u.exec(raw)
  if (send) return { action: 'send', query: (send[1] || '').trim() }
  return null
}

function clip(value, limit) {
  const s = typeof value === 'string' ? value : ''
  return s.length > limit ? s.slice(0, limit) + '…（已截断）' : s
}

export function chatSnapshot(snapshot) {
  const projects = snapshot.projects || []
  const items = snapshot.items || []
  const priority = items.filter(i => i.type === 'task' && i.status === 'open')
  const rest = items.filter(i => !priority.includes(i)).sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')))
  const selected = [...priority, ...rest].slice(0, 50)
  const notebook = snapshot.notebook || ''
  return {
    projects: projects.slice(0, 12).map(p => Object.fromEntries(['id', 'name', 'status', 'goal', 'state', 'next', 'open'].map(k => [k, clip(p[k], 500)]))),
    items: selected.map(i => ({ ...Object.fromEntries(['id', 'type', 'status', 'project', 'due', 'at', 'place', 'created', 'updated'].map(k => [k, i[k] ?? null])),
      text: clip(i.text, 200), note: clip(i.note, 300) })),
    notebook: notebook.length > 6000 ? '（仅保留本子末尾）…' + notebook.slice(-6000) : notebook,
    reading: (snapshot.reading || []).slice(0, 4).map(item => ({
      id: item.id, title: clip(item.title, 120), status: item.status ?? null, kind: item.kind ?? null,
      url: item.url ?? null, summary: clip(item.summary, 400),
      body: clip(item.body, 3200), body_chars: Number(item.body_chars) || 0 })),
    coverage: { omitted_projects: Math.max(0, projects.length - 12), omitted_items: items.length - selected.length,
      notebook_truncated: notebook.length > 6000,
      reading_truncated: (snapshot.reading || []).some(item => (Number(item.body_chars) || 0) > String(item.body || '').length),
      fields_may_be_truncated: projects.some(p => ['goal', 'state', 'next', 'open'].some(k => (p[k] || '').length > 500)) || selected.some(i => (i.text || '').length > 200 || (i.note || '').length > 300) },
  }
}

export class JournalChat {
  constructor({ dir, llm, context, rules = async () => '' }) {
    this.dir = join(dir, 'conversations')
    this.llm = llm
    this.context = context
    this.rules = rules
    this.queues = new Map()
  }

  serial(key, operation) {
    const prior = this.queues.get(key) || Promise.resolve()
    const result = prior.then(operation, operation)
    this.queues.set(key, result)
    void result.finally(() => { if (this.queues.get(key) === result) this.queues.delete(key) }).catch(() => {})
    return result
  }

  path(key) {
    if (typeof key !== 'string' || !key || key.length > 500) throw new Error('缺少有效会话身份')
    return join(this.dir, `${hash(key)}.json`)
  }

  async load(key) {
    try {
      const data = JSON.parse(await readFile(this.path(key), 'utf8'))
      if (data.version !== 1 || !Array.isArray(data.turns) || !['capture', 'auto', 'chat'].includes(data.mode)) throw new Error('对话文件格式无效')
      if (data.mode === 'capture') data.mode = 'auto'
      return data
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, mode: 'auto', turns: [] }
      throw error
    }
  }

  async save(key, data) {
    const file = this.path(key)
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const tmp = `${file}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(data) + '\n', { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, file)
    } finally { await unlink(tmp).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  }

  async state(key) {
    return this.serial(key, async () => {
      const state = await this.load(key)
      return { mode: state.mode, turns: state.turns, ...(state.pending ? { pending: state.pending } : {}) }
    })
  }

  command(key, action) {
    return this.serial(key, async () => {
      const state = await this.load(key)
      if (action === 'start') state.mode = 'chat'
      else if (action === 'stop') state.mode = 'auto'
      else if (action === 'reset') state.turns = []
      else throw new Error('未知对话操作')
      state.pending = null
      await this.save(key, state)
      return { mode: state.mode, reply: action === 'start'
        ? '已进入聊天模式，保留最近 20 轮对话。聊天不会自动记账；发“/记 具体内容”保存一条记录，发“/退出”或“/退出聊天”退出聊天。'
        : action === 'stop' ? '已退出聊天，恢复自动识别：待办和想法会保存，普通聊天直接回复，不确定时先问你确认。' : '已清空当前对话上下文和待确认提议，账本记录未修改。' }
    })
  }

  reply(key, text, requestId) {
    return this.serial(key, async () => {
      if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new Error('消息不能为空，且最多 4000 字')
      if (typeof requestId !== 'string' || !requestId || requestId.length > 200) throw new Error('缺少消息 id')
      const state = await this.load(key)
      const previous = state.turns.find(t => t.id === requestId)
      if (previous) {
        if (previous.text !== text) throw new Error('消息 id 已用于另一条内容')
        return { ...previous, duplicate: true }
      }
      const history = historyOf(state)
      const result = await this.llm.chat({ text: text.trim(), history,
        history_omitted_turns: state.turns.length - history.length,
        journal: chatSnapshot(await this.context({ reading: true })), now: new Date().toISOString(), timezone: 'Asia/Shanghai' })
      const turn = { id: requestId, text, reply: result.reply, model: result.model, at: new Date().toISOString() }
      state.turns = [...state.turns, turn].slice(-20)
      await this.save(key, state)
      return turn
    })
  }

  acknowledge(key, requestId) {
    return this.serial(key, async () => {
      const state = await this.load(key)
      const turn = state.turns.find(t => t.id === requestId)
      if (turn) turn.delivered = true
      if (state.pending?.question_turn_id === requestId) state.pending.delivered = true
      await this.save(key, state)
    })
  }

  dismiss(key) {
    return this.serial(key, async () => {
      const state = await this.load(key)
      if (!state.pending) return
      state.pending = null
      await this.save(key, state)
    })
  }

  route(key, event, handlers) {
    return this.serial(key, async () => {
      if (typeof event.text !== 'string' || !event.text.trim() || event.text.length > 4000) throw new Error('消息不能为空，且最多 4000 字')
      if (typeof event.ev !== 'string' || !event.ev || event.ev.length > 200) throw new Error('缺少消息 id')
      const state = await this.load(key)
      const id = event.ev
      const text = event.text.trim()
      const source = { text, at: event.at || new Date().toISOString(), ev: id }
      const previous = state.turns.find(t => t.id === id)
      if (previous) {
        if (previous.text !== text) throw new Error('消息 id 已用于另一条内容')
        if (previous.capture) {
          try {
            const result = previous.merge_targets
              ? await handlers.merge(previous.capture, previous.merge_targets)
              : await handlers.record(previous.capture)
            return { ...previous, reply: result.receipt, duplicate: true, recorded: true }
          } catch (error) { throw Object.assign(new Error('未能核对已处理消息'), { code: 'AUTO_CAPTURE_FAILED', cause: error }) }
        }
        await handlers.mark('processed')
        const obsolete = previous.intent === 'clarify' && state.pending?.question_turn_id !== id
        return { ...previous, reply: obsolete ? '这条确认请求已处理或已失效，未重复执行。'
          : previous.intent === 'ref' ? '这条消息已处理，未重复收录资料。' : previous.reply, duplicate: true }
      }
      await handlers.mark('auto')
      if (REVIEW_COMMAND.test(text) && typeof handlers.digest === 'function') {
        const result = await handlers.digest()
        await handlers.mark('digest')
        const turn = { id, text, reply: result.receipt, model: { provider: 'command', model: 'review' },
          intent: 'digest', recorded: false, at: new Date().toISOString(), delivered: false }
        state.turns = [...state.turns, turn].slice(-20)
        state.pending = null
        await this.save(key, state)
        return turn
      }
      if (SEND_COMMAND.test(text) && typeof handlers.lastDigest === 'function') {
        const result = await handlers.lastDigest()
        await handlers.mark('digest')
        const turn = { id, text, reply: result.receipt, model: { provider: 'command', model: 'send' },
          intent: 'digest', recorded: false, at: new Date().toISOString(), delivered: false }
        state.turns = [...state.turns, turn].slice(-20)
        await this.save(key, state)
        return turn
      }
      if (PANEL_COMMAND.test(text) && typeof handlers.panel === 'function') {
        const result = await handlers.panel()
        await handlers.mark('panel')
        const turn = { id, text, reply: result.receipt, model: { provider: 'command', model: 'panel' },
          intent: 'query', recorded: false, at: new Date().toISOString(), delivered: false }
        state.turns = [...state.turns, turn].slice(-20)
        await this.save(key, state)
        return turn
      }
      if (UNDO_COMMAND.test(text) && typeof handlers.undo === 'function') {
        const result = await handlers.undo()
        await handlers.mark('undo')
        const turn = { id, text, reply: result.receipt, model: { provider: 'command', model: 'undo' },
          intent: 'cancel', recorded: false, at: new Date().toISOString(), delivered: false }
        state.turns = [...state.turns, turn].slice(-20)
        await this.save(key, state)
        return turn
      }
      if (state.pending && Date.now() - Date.parse(state.pending.asked_at) > 24 * 3600000) state.pending = null
      const pending = state.pending?.delivered ? state.pending : null
      const [snapshot, rules] = await Promise.all([this.context({ reading: CONTENT_HINT.test(text) }), this.rules()])
      const journal = chatSnapshot(snapshot)
      const history = historyOf(state)
      const urls = [...new Set([...(event.urls || []), ...(pending?.sources.flatMap(s => extractUrls(s.text)) || [])])]
      const classifyInput = { text, received_at: source.at, urls,
        history, journal, rules, pending, now: new Date().toISOString(), timezone: 'Asia/Shanghai' }
      let decision
      try {
        decision = await this.llm.classify(classifyInput)
      } catch (error) {
        // 模型服务偶发失败（限流、上游抖动）时重试一次，别让一条待办直接丢掉。
        if (!/^MODEL_(CALL_FAILED|TIMEOUT)$/u.test(error?.code || '')) throw error
        await new Promise(resolve => setTimeout(resolve, 800))
        decision = await this.llm.classify(classifyInput)
      }
      const latest = state.turns.filter(t => t.delivered !== false).at(-1)
      const invalidConfirmation = decision.intent === 'confirm' && (!pending || !decision.continuation)
      const vagueConfirmation = bareConfirmation(text) &&
        (!pending || !pending.items.length || latest?.id !== pending.question_turn_id) &&
        ['task', 'idea', 'mixed', 'confirm'].includes(decision.intent)
      if (invalidConfirmation || vagueConfirmation) decision = { ...decision, intent: 'clarify', continuation: false,
        reply: '你想把哪件事记成待办、保存为想法，还是仅讨论一下？请说明要保存的具体内容。', items: [] }
      if (decision.intent === 'ref' && !(decision.continuation ? urls : event.urls)?.length) decision = { ...decision, intent: 'clarify',
        continuation: false, reply: '请补充要收藏的链接，或说明要保存的具体内容。', items: [] }
      if (decision.continuation && pending?.sources.length >= 8) decision = { ...decision,
        intent: 'clarify', continuation: false, items: [],
        reply: '这次确认经过了多次补充，请重新完整说一下要保存的内容；此前的提议尚未保存。' }
      const related = decision.continuation && pending
      const sources = related ? [...pending.sources, source] : [source]
      const capture = { items: decision.items, model: decision.model, source_messages: sources,
        ev: related ? pending.sources[0].ev : id }
      if (decision.items.length) await handlers.validate(capture)
      let reply = decision.reply
      let recorded = false
      let mergeTargets = null
      if (['task', 'idea', 'mixed', 'confirm'].includes(decision.intent)) {
        try {
          // “补进去”这类补充说明：同名未完成条目存在时补进原条目，不新建重复项。
          const targets = decision.items.map(item => journal.items.find(existing =>
            existing.type === item.type && existing.status === 'open' && existing.text === item.text &&
            String(existing.note || '').trim() && item.note.trim()))
          const merging = targets.length > 0 && targets.every(Boolean) && typeof handlers.merge === 'function'
          if (merging) mergeTargets = targets.map(existing => existing.id)
          const result = merging
            ? await handlers.merge(capture, mergeTargets)
            : await handlers.record(capture, { collectRefs: decision.collect_refs })
          reply = result.receipt
          recorded = true
          state.pending = null
        } catch (error) { throw Object.assign(new Error('未能确认自动记录结果'), { code: 'AUTO_CAPTURE_FAILED', cause: error }) }
      } else if (decision.intent === 'query') {
        await handlers.mark('query')
      } else if (decision.intent === 'digest') {
        if (typeof handlers.digest !== 'function') throw Object.assign(new Error('点评通道未启用'), { code: 'AUTO_CAPTURE_FAILED' })
        try {
          const result = await handlers.digest()
          reply = result.receipt
          state.pending = null
          await handlers.mark('digest')
        } catch (error) { throw error && error.code ? error : Object.assign(new Error('未能生成点评'), { code: 'AUTO_CAPTURE_FAILED', cause: error }) }
      } else if (decision.intent === 'clarify') {
        state.pending = { sources, items: decision.items, question: reply, question_turn_id: id,
          asked_at: new Date().toISOString(), delivered: false }
        const preview = proposalPreview(decision.items, journal.projects)
        reply += (preview ? '\n待确认内容（尚未保存）：\n' + preview : '\n尚未新增待办或想法。')
        await handlers.mark('clarify')
      } else if (decision.intent === 'cancel') {
        reply = pending ? '已取消这次记录，未新增待办或想法。' : '当前没有待确认的记录，未修改账本。'
        state.pending = null
        await handlers.mark('cancel')
      } else if (decision.intent === 'ref') {
        reply = await handlers.reference(sources)
        state.pending = null
        await handlers.mark('ref')
      } else {
        if (handlers.allowChat === false) reply = '这条消息是聊天内容，未记入账本。聊天回复功能尚未开启。'
        await handlers.mark('chat')
      }
      const turn = { id, text, reply, model: decision.model, intent: decision.intent, recorded,
        at: new Date().toISOString(), delivered: false,
        ...(recorded ? { capture, ...(mergeTargets ? { merge_targets: mergeTargets } : {}) } : {}) }
      state.turns = [...state.turns, turn].slice(-20)
      try { await this.save(key, state) }
      catch (error) {
        if (recorded) throw Object.assign(new Error('记录已保存但回执状态未保存'), { code: 'AUTO_CAPTURE_FAILED', cause: error })
        throw error
      }
      return turn
    })
  }
}
