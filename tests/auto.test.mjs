import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { JournalChat } from '../plugins/reading-inbox/chat.js'
import { JournalLlm } from '../plugins/reading-inbox/llm.js'
import { WeChatBot } from '../plugins/reading-inbox/wechat.js'
import { apply } from '../plugins/reading-inbox/index.js'

const python = process.env.DSH_PYTHON || 'python'
const model = { provider: 'configured', model: 'm' }
const at = '2026-10-31T23:58:00+08:00'
const row = (text, quote = text, extra = {}) => ({ type: 'task', text, quote, note: '',
  project: null, due: null, at: null, place: null, time_quote: null, ...extra })
const decision = (intent, items = [], reply = '', continuation = false) => ({ intent, items, reply, continuation, collect_refs: intent === 'ref' })

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'journal-auto-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const file of readdirSync('journal').filter(f => f.endsWith('.py') || f === 'RULES.md')) copyFileSync(join('journal', file), join(dir, file))
  const invoke = (args, input) => spawnSync(python, [join(dir, 'journal.py'), ...args], {
    encoding: 'utf8', input: input === undefined ? undefined : JSON.stringify(input),
    env: { ...process.env, JOURNAL_DIR: dir },
  })
  const journal = (args, input) => {
    const result = invoke(args, input)
    if (result.status !== 0) throw new Error(result.stderr || result.stdout)
    return JSON.parse(result.stdout)
  }
  journal(['init'])
  const inputs = []
  let output
  const runtime = {
    listProviders: () => [{ id: 'configured' }], listModels: () => [{ id: 'm' }],
    async *stream(options) {
      const input = JSON.parse(options.messages[0].content[0].text)
      inputs.push({ purpose: options.purpose, input })
      if (output instanceof Error) throw output
      const value = typeof output === 'function' ? output(input, options.purpose) : output
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(value) } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const llm = new JournalLlm()
  llm.runtime = runtime
  const make = () => new JournalChat({ dir, llm, context: async () => journal(['chat-context']) })
  const routes = []
  const handlers = {
    mark: async name => routes.push(name),
    validate: ({ ev, ...plan }) => journal(['triage', '--text', plan.source_messages.map(s => s.text).join('\n'), '--validate-plan'], plan),
    record: ({ ev, ...plan }) => journal(['triage', '--text', plan.source_messages.map(s => s.text).join('\n'),
      '--at', plan.source_messages.at(-1).at, '--ev', ev, '--plan', '-'], plan),
    reference: async () => '已加入阅读收件箱。',
  }
  const captures = () => existsSync(join(dir, 'capture'))
    ? readdirSync(join(dir, 'capture')).flatMap(f => readFileSync(join(dir, 'capture', f), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)) : []
  return { dir, journal, invoke, make, llm, runtime, inputs, handlers, routes, captures,
    output(value) { output = value },
    event(text, ev, timestamp = at) { return { text, ev, at: timestamp, urls: [] } },
  }
}

test('default routing chats without writes, saves clear tasks/ideas once, and preserves history', async t => {
  const f = fixture(t)
  const chat = f.make()
  assert.equal((await chat.state('wx')).mode, 'auto')
  f.output(decision('chat', [], '你好，想聊什么？'))
  const greeting = await chat.route('wx', f.event('你好', 'hello'), f.handlers)
  await chat.acknowledge('wx', 'hello')
  assert.equal(greeting.recorded, false)
  assert.equal(f.journal(['state']).items.length, 0)
  assert.equal(f.captures().length, 0)
  assert.equal(f.routes.at(-1), 'chat')
  f.output(decision('task', [row('交报告', '明天交报告', { due: '2026-11-01', time_quote: '明天' })]))
  const task = await chat.route('wx', f.event('明天交报告', 'task'), f.handlers)
  await chat.acknowledge('wx', 'task')
  assert.match(task.reply, /^已加入待办：/)
  assert.equal(f.inputs.at(-1).input.history[0].assistant, greeting.reply)
  f.output(decision('idea', [row('样本量可能不足', '我怀疑样本量不足', { type: 'idea' })]))
  const idea = await chat.route('wx', f.event('我怀疑样本量不足', 'idea'), f.handlers)
  assert.match(idea.reply, /^已保存想法：/)
  const count = f.inputs.length
  await f.journal(['set', '--id', f.journal(['state']).items[0].id, '--status', 'done'])
  const replay = await f.make().route('wx', f.event('明天交报告', 'task'), f.handlers)
  assert.match(replay.reply, /已完成，未重复添加/)
  assert.equal(f.inputs.length, count)
  assert.deepEqual(f.journal(['state']).items.map(i => i.type), ['task', 'idea'])
  assert.equal(f.captures().length, 2)
  assert.ok(f.inputs.every(i => i.purpose === 'journal-classify'))
})

test('delivered clarification survives restart, uses original date/evidence, and commits only after confirmation', async t => {
  const f = fixture(t)
  const chat = f.make()
  const original = '也许明天该比较两个模型'
  const candidate = row('比较两个模型', original, { due: '2026-11-01', time_quote: '明天' })
  f.output(decision('clarify', [candidate], '要把比较两个模型加入待办吗？'))
  const question = await chat.route('wx', f.event(original, 'proposal'), f.handlers)
  assert.match(question.reply, /待确认内容（尚未保存）/)
  assert.match(question.reply, /截止：2026-11-01/)
  assert.equal(f.journal(['state']).items.length, 0)
  assert.equal(f.captures().length, 0)
  await chat.acknowledge('wx', 'proposal')
  const restarted = f.make()
  f.output(decision('confirm', [candidate], '', true))
  const answer = await restarted.route('wx', f.event('确认', 'confirm', '2026-11-01T00:01:00+08:00'), f.handlers)
  assert.match(answer.reply, /^已加入待办：/)
  assert.equal(f.inputs.at(-1).input.pending.delivered, true)
  assert.equal(f.journal(['state']).items[0].due, '2026-11-01')
  const [capture] = f.captures()
  assert.equal(capture.ev, 'proposal')
  assert.equal(capture.text, original + '\n确认')
  assert.deepEqual(capture.source_messages.map(s => s.at), [at, '2026-11-01T00:01:00+08:00'])
  assert.equal((await restarted.state('wx')).pending, undefined)
  const replay = await restarted.route('wx', f.event('确认', 'confirm', '2026-11-01T00:01:00+08:00'), f.handlers)
  assert.match(replay.reply, /未重复添加/)
  assert.equal(f.journal(['state']).items.length, 1)
  assert.equal(f.captures().length, 1)
  const oldQuestion = await restarted.route('wx', f.event(original, 'proposal'), f.handlers)
  assert.match(oldQuestion.reply, /已处理或已失效/)
})

test('unsent, ambiguous, stale and expired questions cannot turn a bare yes into a record; cancellation clears proposals', async t => {
  const f = fixture(t)
  const chat = f.make()
  const candidate = row('比较模型', '也许比较模型')
  f.output(decision('clarify', [candidate], '加入待办吗？'))
  await chat.route('unsent', f.event('也许比较模型', 'q'), f.handlers)
  f.output(decision('confirm', [row('比较模型', '对')], '', true))
  const unsent = await chat.route('unsent', f.event('对', 'a'), f.handlers)
  assert.equal(f.inputs.at(-1).input.pending, null)
  assert.equal(unsent.intent, 'clarify')
  assert.equal(unsent.recorded, false)
  f.output(decision('clarify', [], '要记成待办，还是仅讨论？'))
  await chat.route('ambiguous', f.event('也许比较模型', 'q'), f.handlers)
  await chat.acknowledge('ambiguous', 'q')
  f.output(decision('confirm', [candidate], '', true))
  assert.equal((await chat.route('ambiguous', f.event('好', 'a'), f.handlers)).intent, 'clarify')
  f.output(decision('clarify', [candidate], '加入待办吗？'))
  await chat.route('stale', f.event('也许比较模型', 'q'), f.handlers)
  await chat.acknowledge('stale', 'q')
  f.output(decision('chat', [], '可以换个话题。'))
  await chat.route('stale', f.event('聊点别的', 'other'), f.handlers)
  await chat.acknowledge('stale', 'other')
  f.output(decision('confirm', [candidate], '', true))
  assert.equal((await chat.route('stale', f.event('好的', 'a'), f.handlers)).intent, 'clarify')
  const expired = await chat.load('stale')
  expired.pending.asked_at = '2020-01-01T00:00:00Z'
  expired.pending.delivered = true
  await chat.save('stale', expired)
  f.output(decision('confirm', [row('比较模型', '确认')], '', true))
  assert.equal((await chat.route('stale', f.event('确认', 'expired'), f.handlers)).intent, 'clarify')
  await chat.acknowledge('stale', 'expired')
  f.output(decision('cancel', [], '', true))
  const cancelled = await chat.route('stale', f.event('不要记，只聊聊', 'cancel'), f.handlers)
  assert.match(cancelled.reply, /已取消/)
  assert.equal((await chat.state('stale')).pending, undefined)
  assert.equal(f.journal(['state']).items.length, 0)
  assert.equal(f.captures().length, 0)
})

test('invalid classifications and model failures do not fall back to writing; preflight rejects invented metadata', async t => {
  const f = fixture(t)
  const chat = f.make()
  const text = '明天比较模型'
  for (const output of [new Error('timeout'), { items: [] }, decision('task', []),
    decision('task', [row('比较模型', '没说过的话')]),
    decision('task', [row('比较模型', text, { project: 'unknown' })]),
    decision('task', [row('比较模型', text, { due: '2026-02-30', time_quote: '明天' })]),
    decision('task', [row('比较模型', text, { place: '虚构会议室' })]),
    decision('clarify', [row('比较模型', text, { status: 'done' })], '加入待办吗？')]) {
    f.output(output)
    await assert.rejects(chat.route('wx', f.event(text, 'invalid'), f.handlers))
    assert.equal((await chat.state('wx')).turns.length, 0)
    assert.equal(f.journal(['state']).items.length, 0)
    assert.equal(f.captures().length, 0)
  }
  const source_messages = [{ text, at, ev: 'x' }]
  const invalidSource = f.invoke(['triage', '--text', text, '--validate-plan'], {
    items: [row('比较模型', text)], model, source_messages: [{ ...source_messages[0], at: '2026-10-31' }],
  })
  assert.notEqual(invalidSource.status, 0)
  f.output(decision('chat', [], '可以继续讨论。'))
  await chat.route('wx', f.event('你好', 'valid'), f.handlers)
  assert.equal((await chat.state('wx')).turns.length, 1)
})

test('clarification can change type, cancellation and explicit recording clear pending, and links require collection intent', async t => {
  const f = fixture(t)
  const chat = f.make()
  f.output(decision('clarify', [], '要记成待办，还是保存为想法？'))
  await chat.route('wx', f.event('这个也许值得做', 'q'), f.handlers)
  await chat.acknowledge('wx', 'q')
  f.output(decision('confirm', [row('这个也许值得做', '这个也许值得做', { type: 'idea' })], '', true))
  const result = await chat.route('wx', f.event('先记成想法', 'a'), f.handlers)
  assert.match(result.reply, /^已保存想法：/)
  assert.equal(f.journal(['state']).items[0].type, 'idea')
  f.output(decision('chat', [], '可以一起分析这篇文章。'))
  await chat.route('wx', { ...f.event('分析这个 https://example.org', 'link-chat'), urls: ['https://example.org'] }, f.handlers)
  assert.equal(f.routes.at(-1), 'chat')
  let collected = 0
  const handlers = { ...f.handlers, reference: async sources => {
    collected += 1
    assert.match(sources[0].text, /https:\/\/example.org/)
    return '已加入阅读收件箱。'
  } }
  f.output(decision('ref'))
  const event = { ...f.event('收藏 https://example.org', 'collect'), urls: ['https://example.org'] }
  assert.match((await chat.route('wx', event, handlers)).reply, /已加入阅读收件箱/)
  assert.match((await chat.route('wx', event, handlers)).reply, /未重复收录/)
  assert.equal(collected, 1)
  f.output(decision('ref'))
  assert.equal((await chat.route('wx', f.event('收藏这个', 'missing-link'), handlers)).intent, 'clarify')
  await chat.dismiss('wx')
  assert.equal((await chat.state('wx')).pending, undefined)
  f.output(decision('chat', [], '不会显示这段普通聊天回复。'))
  const disabled = await chat.route('wx', f.event('你好', 'no-chat'), { ...handlers, allowChat: false })
  assert.match(disabled.reply, /聊天回复功能尚未开启/)
  assert.equal(f.journal(['state']).items.length, 1)
})

test('legacy registered task choices still apply with revision checks; checking ordinary text does not write', t => {
  const f = fixture(t)
  const unchanged = readFileSync(join(f.dir, 'store.json'), 'utf8')
  assert.equal(f.journal(['triage', '--text', '明天可以聊聊吗', '--ev', 'chat', '--check-reply']).needs_classification, true)
  assert.equal(f.captures().length, 0)
  assert.equal(readFileSync(join(f.dir, 'store.json'), 'utf8'), unchanged)
  const task = f.journal(['triage', '--text', '明天比较模型', '--ev', 'task'])
  f.journal(['ask', '--text', '比较模型做完了吗？', '--item', task.created, '--choices-json',
    JSON.stringify([{ label: '已做完', replies: ['做完了'], status: 'done' }, { label: '还没做完' }])])
  const answer = f.journal(['triage', '--text', '第一个', '--ev', 'answer', '--check-reply'])
  assert.match(answer.receipt, /已更新状态.*已完成/)
  assert.equal(f.journal(['state']).items.length, 1)
  assert.equal(f.journal(['state']).items[0].status, 'done')
})

test('a write followed by a failure reports uncertain save and retries without adding twice', async t => {
  const f = fixture(t)
  const chat = f.make()
  f.output(decision('task', [row('比较模型')]))
  const event = f.event('比较模型', 'task')
  await assert.rejects(chat.route('wx', event, { ...f.handlers, record: async capture => {
    await f.handlers.record(capture)
    throw new Error('failed after commit')
  } }), { code: 'AUTO_CAPTURE_FAILED' })
  assert.equal(f.journal(['state']).items.length, 1)
  assert.match((await chat.route('wx', event, f.handlers)).reply, /未重复添加/)
  assert.equal(f.journal(['state']).items.length, 1)
})

test('WeChat sending checks business errors and echoes the bound conversation token without exposing it to the model', async t => {
  const f = fixture(t)
  const bot = new WeChatBot({ dir: join(f.dir, 'bot'), onMessage() {} })
  bot.credential = { ilink_user_id: 'owner', bot_token: 'fake-test-token' }
  bot.saveEvents = async () => {}
  bot.handleMessage({ from_user_id: 'owner', context_token: 'owner-context', item_list: [] })
  bot.handleMessage({ from_user_id: 'other', context_token: 'other-context', item_list: [] })
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  let response = { ret: 0 }
  let request
  globalThis.fetch = async (_url, options) => { request = JSON.parse(options.body); return { ok: true, json: async () => response } }
  await bot.sendText('确认问题')
  assert.equal(request.msg.context_token, 'owner-context')
  assert.equal(JSON.stringify(bot.events).includes('owner-context'), false)
  response = { ret: -14, errmsg: 'private-service-response' }
  await assert.rejects(bot.sendText('确认问题'), { code: 'WECHAT_SEND_FAILED', message: '微信未接受这条消息' })
  response = { ret: 0, errcode: 123 }
  await assert.rejects(bot.sendText('确认问题'), { code: 'WECHAT_SEND_FAILED' })
  response = {}
  await bot.sendText('兼容不带 ret 的旧响应')
})

test('WeChat default entry uses one classifier, asks then commits, and ingest excludes chat and undecided messages', async t => {
  const f = fixture(t)
  let bot
  let sendFails = false
  const sent = []
  const originalLoad = WeChatBot.prototype.load
  const originalSend = WeChatBot.prototype.sendText
  WeChatBot.prototype.load = async function () { bot = this; this.credential = { ilink_user_id: 'owner' } }
  WeChatBot.prototype.sendText = async function (text) { if (sendFails) throw new Error('offline'); sent.push(text) }
  t.after(() => { WeChatBot.prototype.load = originalLoad; WeChatBot.prototype.sendText = originalSend })
  const cleanup = []
  const ctx = {
    llm: f.runtime, agentDefaultModel: { currentSelection: () => model }, agents: { currentInitiator: () => undefined },
    tools: { register() { return () => {} } }, webServer: { register() { return () => {} } },
    inject(_names, fn) { fn(this) }, on() {},
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose) },
  }
  t.after(() => cleanup.reverse().forEach(fn => fn()))
  apply(ctx, { dataDir: join(f.dir, 'inbox'), journalDir: f.dir, python })
  const receive = (text, id) => bot.handleMessage({ from_user_id: 'owner', message_id: id,
    item_list: [{ type: 1, text_item: { text } }] })
  const ingest = () => {
    const result = spawnSync(python, [join(f.dir, 'journal.py'), 'ingest'], {
      encoding: 'utf8', env: { ...process.env, JOURNAL_DIR: f.dir, WECHAT_EVENTS: join(f.dir, 'inbox', 'wechat-events.json') },
    })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  f.output(decision('chat', [], '你好。'))
  await receive('你好', 'hello')
  assert.equal(sent.at(-1), '你好。')
  assert.equal(ingest().new, 0)
  const original = '也许比较模型'
  const candidate = row('比较模型', original)
  f.output(decision('clarify', [candidate], '要加入待办吗？'))
  await receive(original, 'q')
  assert.match(sent.at(-1), /尚未保存/)
  assert.equal(f.journal(['state']).items.length, 0)
  assert.equal(ingest().new, 0)
  f.output(decision('confirm', [candidate], '', true))
  await receive('确认', 'a')
  assert.match(sent.at(-1), /^已加入待办：/)
  assert.equal(f.journal(['state']).items.length, 1)
  assert.equal(f.inputs.length, 3)
  const sentBefore = sent.length
  await receive('确认', 'a')
  assert.equal(sent.length, sentBefore, '重投已送达的消息不再回一遍')
  assert.equal(f.inputs.length, 3)
  const mixed = '明天写报告，我怀疑样本不足'
  f.output(decision('mixed', [row('写报告', '明天写报告'), row('样本不足', '我怀疑样本不足', { type: 'idea' })]))
  await receive(mixed, 'mixed')
  assert.match(sent.at(-1), /已加入 1 条待办/)
  assert.match(sent.at(-1), /已保存 1 条想法/)
  assert.equal(f.journal(['state']).items.length, 3)
  f.output(new Error('model unavailable'))
  await receive('明天还有任务', 'failed')
  assert.match(sent.at(-1), /没有自动记入账本/)
  assert.equal(f.journal(['state']).items.length, 3)
  assert.equal(ingest().new, 0)
  f.output(decision('clarify', [candidate], '加入待办吗？'))
  sendFails = true
  await receive(original, 'unsent')
  sendFails = false
  f.output(decision('confirm', [row('比较模型', '对')], '', true))
  await receive('对', 'not-confirmed')
  assert.match(sent.at(-1), /请说明要保存的具体内容/)
  assert.equal(f.journal(['state']).items.length, 3)
  assert.equal(ingest().new, 0)
  const routes = JSON.parse(readFileSync(join(f.dir, 'inbox', 'wechat-events.json'), 'utf8'))
  assert.equal(routes.find(e => e.id === 'hello').journal_route, 'chat')
  assert.equal(routes.find(e => e.id === 'q').journal_route, 'clarify')
  assert.equal(routes.find(e => e.id === 'a').journal_route, 'capture')
  assert.equal(routes.find(e => e.id === 'failed').journal_route, 'auto')
  assert.equal(f.captures().length, 2)
})
