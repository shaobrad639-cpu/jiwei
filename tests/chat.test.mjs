import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { JournalChat, chatCommand, chatSnapshot } from '../plugins/reading-inbox/chat.js'
import { JournalLlm } from '../plugins/reading-inbox/llm.js'
import { WeChatBot } from '../plugins/reading-inbox/wechat.js'
import { apply } from '../plugins/reading-inbox/index.js'

const python = process.env.DSH_PYTHON || 'python'
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'journal-chat-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const file of readdirSync('journal').filter(f => f.endsWith('.py') || f === 'RULES.md')) copyFileSync(join('journal', file), join(dir, file))
  const journal = (args, env = {}) => {
    const result = spawnSync(python, [join(dir, 'journal.py'), ...args], {
      encoding: 'utf8', env: { ...process.env, JOURNAL_DIR: dir, ...env },
    })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  journal(['init'])
  writeFileSync(join(dir, 'notebook.md'), '## 2026-10-31\n想讨论实验结果\n')
  return { dir, journal }
}

test('conversation is ordered, persists across restart, deduplicates and resets independently of journal', async t => {
  const { dir, journal } = fixture(t)
  const before = readFileSync(join(dir, 'store.json'), 'utf8')
  const inputs = []
  const llm = { async chat(input) { inputs.push(input); return { reply: `回答：${input.text}`, model: { provider: 'configured', model: 'm' } } } }
  const make = () => new JournalChat({ dir, llm, context: async () => journal(['chat-context']) })
  const chat = make()
  assert.equal((await chat.state('wechat:owner')).mode, 'auto')
  await chat.command('wechat:owner', 'start')
  await Promise.all([chat.reply('wechat:owner', '先说实验', '1'), chat.reply('wechat:owner', '那下一步呢', '2')])
  assert.equal(inputs[1].history[0].user, '先说实验')
  assert.equal(inputs[1].history[0].assistant, '回答：先说实验')
  const restarted = make()
  assert.equal((await restarted.state('wechat:owner')).mode, 'chat')
  assert.equal((await restarted.reply('wechat:owner', '那下一步呢', '2')).duplicate, true)
  assert.equal(inputs.length, 2)
  await assert.rejects(restarted.reply('wechat:owner', '另一句话', '2'), /消息 id/)
  assert.equal((await restarted.state('wechat:someone-else')).turns.length, 0)
  await restarted.command('wechat:owner', 'reset')
  assert.deepEqual(await restarted.state('wechat:owner'), { mode: 'chat', turns: [] })
  await restarted.command('wechat:owner', 'stop')
  assert.equal((await restarted.state('wechat:owner')).mode, 'auto')
  assert.equal(readFileSync(join(dir, 'store.json'), 'utf8'), before)
  assert.equal(existsSync(join(dir, 'capture')), false)
  assert.equal(readFileSync(join(dir, 'notebook.md'), 'utf8'), '## 2026-10-31\n想讨论实验结果\n')
})

test('chat failures leave history intact, retry succeeds, and context/history are explicitly bounded', async t => {
  const { dir } = fixture(t)
  let input
  const llm = { async chat(value) { input = value; throw new Error('timeout') } }
  const chat = new JournalChat({ dir, llm, context: async () => ({ projects: [], items: [] }) })
  await assert.rejects(chat.reply('wx', '你好', '1'), /timeout/)
  assert.equal((await chat.state('wx')).turns.length, 0)
  llm.chat = async value => { input = value; return { reply: '一'.repeat(3000), model: { provider: 'p', model: 'm' } } }
  for (let n = 0; n < 23; n += 1) await chat.reply('wx', '问题'.repeat(1500), String(n))
  assert.equal((await chat.state('wx')).turns.length, 20)
  assert.ok(input.history_omitted_turns > 0)
  assert.ok(JSON.stringify(input.history).length < 18000)
  const bounded = chatSnapshot({ projects: Array.from({ length: 14 }, (_, i) => ({ id: `p${i}`, state: 'x'.repeat(600) })),
    items: Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, type: 'task', status: 'open', text: '任务' })), notebook: '旧'.repeat(7000) + '最新记录' })
  assert.equal(bounded.coverage.omitted_projects, 2)
  assert.equal(bounded.coverage.omitted_items, 10)
  assert.equal(bounded.coverage.fields_may_be_truncated, true)
  assert.equal(bounded.coverage.notebook_truncated, true)
  assert.ok(bounded.notebook.endsWith('最新记录'))
})

test('model chat returns visible reply JSON and rejects invalid replies', async () => {
  const llm = new JournalLlm({ provider: 'configured', model: 'm' })
  let output = { reply: '可以，继续说。' }
  llm.runtime = { async *stream() {
    yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(output) } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  assert.equal((await llm.chat({ text: '你好' })).reply, '可以，继续说。')
  output = { reply: 'x'.repeat(3501) }
  await assert.rejects(llm.chat({ text: '你好' }), /reply/)
  output = { reply: '已完成', action: 'delete' }
  await assert.rejects(llm.chat({ text: '你好' }), /格式/)
  assert.deepEqual(chatCommand('/记 明天整理结果'), { action: 'capture', text: '明天整理结果' })
  assert.deepEqual(chatCommand('/发 发票'), { action: 'send', query: '发票' })
  assert.deepEqual(chatCommand('/发'), { action: 'send', query: '' })
  assert.equal(chatCommand('/发文件'), null)
  assert.deepEqual(chatCommand('/聊天'), { action: 'start' })
  assert.deepEqual(chatCommand('/退出'), { action: 'stop' })
  assert.deepEqual(chatCommand('/退出聊天'), { action: 'stop' })
  assert.equal(chatCommand('/记账'), null)
  assert.equal(chatCommand('我们聊聊这个问题'), null)
})

test('ledger queries answer without writing; a supplement merges into the existing item instead of duplicating it', async t => {
  const { dir } = fixture(t)
  const snapshot = { projects: [], notebook: '',
    items: [{ id: 't_1', type: 'task', status: 'open', text: '报销发票', note: '发票文件：a.pdf' }] }
  const calls = []
  const handlers = {
    mark: async route => { calls.push(['mark', route]) },
    validate: async () => {},
    record: async () => { calls.push(['record']); return { receipt: '已加入待办：报销发票。' } },
    merge: async (_capture, targets) => { calls.push(['merge', targets]); return { receipt: '已补进待办「报销发票」' } },
  }
  let decision
  const llm = { classify: async () => decision }
  const chat = new JournalChat({ dir, llm, context: async () => snapshot })

  decision = { intent: 'query', continuation: false, collect_refs: false, items: [],
    reply: '未完成 2 条，都是「报销发票」。', model: { provider: 'p', model: 'm' } }
  const answer = await chat.route('wx', { text: '现在我有几个待办报销', ev: '1' }, handlers)
  assert.equal(answer.reply, '未完成 2 条，都是「报销发票」。')
  assert.equal(answer.intent, 'query')
  assert.deepEqual(calls, [['mark', 'auto'], ['mark', 'query']])

  calls.length = 0
  decision = { intent: 'task', continuation: true, collect_refs: false, reply: '',
    items: [{ type: 'task', text: '报销发票', note: '补充：这笔是打车费（¥15.20）', quote: '打车费',
      project: null, due: null, at: null, place: null, time_quote: null }], model: { provider: 'p', model: 'm' } }
  const merged = await chat.route('wx', { text: '补进去，打车费', ev: '2' }, handlers)
  assert.equal(merged.reply, '已补进待办「报销发票」')
  assert.deepEqual(calls, [['mark', 'auto'], ['merge', ['t_1']]])
  const replay = await chat.route('wx', { text: '补进去，打车费', ev: '2' }, handlers)
  assert.equal(replay.duplicate, true)
  assert.deepEqual(calls.at(-1), ['merge', ['t_1']])
})

test('reading snapshot carries collected article bodies and flags ones cut short', () => {
  const snapshot = chatSnapshot({ projects: [], items: [], notebook: '',
    reading: [{ id: 'it_1', title: '访谈纪要：AI芯片散热', status: 'inbox', kind: '论文',
      url: 'https://mp.weixin.qq.com/s/x', summary: '', body: '金刚石铜冷板的技术优势。'.repeat(20), body_chars: 9000 }] })
  assert.equal(snapshot.reading[0].title, '访谈纪要：AI芯片散热')
  assert.equal(snapshot.reading[0].status, 'inbox')
  assert.ok(snapshot.reading[0].body.includes('金刚石铜冷板'))
  assert.equal(snapshot.reading[0].body_chars, 9000)
  assert.equal(snapshot.coverage.reading_truncated, true)
  const whole = chatSnapshot({ projects: [], items: [], notebook: '',
    reading: [{ id: 'it_2', title: '短文章', body: '全文', body_chars: 2 }] })
  assert.equal(whole.coverage.reading_truncated, false)
})

test('article bodies load only for content questions; the weekly digest has its own channel', async t => {
  const { dir } = fixture(t)
  const calls = []
  const snapshot = { projects: [], items: [], notebook: '' }
  let decision
  const llm = { classify: async () => decision }
  const chat = new JournalChat({ dir, llm,
    context: async (options = {}) => { calls.push(['context', Boolean(options.reading)]); return snapshot } })
  const handlers = {
    mark: async route => { calls.push(['mark', route]) },
    record: async () => { calls.push(['record']); return { receipt: '不应走到这里' } },
    digest: async () => { calls.push(['digest']); return { receipt: '已生成点评「第 1 期」' } },
  }
  decision = { intent: 'chat', continuation: false, collect_refs: false, reply: '早', items: [],
    model: { provider: 'p', model: 'm' } }
  await chat.route('wx', { text: '早', ev: 'a' }, handlers)
  assert.deepEqual(calls, [['mark', 'auto'], ['context', false], ['mark', 'chat']])

  calls.length = 0
  decision = { intent: 'digest', continuation: false, collect_refs: false, reply: '', items: [],
    model: { provider: 'p', model: 'm' } }
  const result = await chat.route('wx', { text: '出个周报', ev: 'b' }, handlers)
  assert.equal(result.reply, '已生成点评「第 1 期」')
  assert.deepEqual(calls, [['mark', 'auto'], ['context', true], ['digest'], ['mark', 'digest']])

  calls.length = 0
  let classified = 0
  llm.classify = async () => { classified += 1; return decision }
  const direct = await chat.route('wx', { text: '点评我的收藏', ev: 'c' }, handlers)
  assert.equal(direct.reply, '已生成点评「第 1 期」')
  assert.equal(classified, 0, '裸命令不应再问模型')
  assert.deepEqual(calls, [['mark', 'auto'], ['digest'], ['mark', 'digest']])

  calls.length = 0
  const bare = await chat.route('wx', { text: '点评', ev: 'c2' }, handlers)
  assert.ok(bare.reply.length > 0)
  assert.equal(classified, 0, '只说“点评”也要直接走点评')

  calls.length = 0
  handlers.panel = async () => { calls.push(['panel']); return { receipt: '【今天 · 11-12 周四】\n09:00　接待客户' } }
  const panel = await chat.route('wx', { text: '面板', ev: 'p1' }, handlers)
  assert.ok(panel.reply.includes('【今天'))
  assert.deepEqual(calls, [['mark', 'auto'], ['panel'], ['mark', 'panel']])

  calls.length = 0
  handlers.lastDigest = async () => { calls.push(['lastDigest']); return { receipt: '《点评 · 第 1 期》\n\n· 散热\n比纯铜低 3–5℃。' } }
  const sent = await chat.route('wx', { text: '发送给我', ev: 'd' }, handlers)
  assert.ok(sent.reply.includes('比纯铜低 3–5℃'))
  assert.deepEqual(calls, [['mark', 'auto'], ['lastDigest'], ['mark', 'digest']])

  calls.length = 0
  handlers.undo = async () => { calls.push(['undo']); return { receipt: '已撤销：pic.jpg，文件已删除。' } }
  const undone = await chat.route('wx', { text: '取消刚才的保存', ev: 'e' }, handlers)
  assert.ok(undone.reply.includes('已撤销'))
  assert.deepEqual(calls, [['mark', 'auto'], ['undo'], ['mark', 'undo']])
})

test('async WeChat handler failures are logged instead of becoming unhandled rejections', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'wechat-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const logs = []
  const bot = new WeChatBot({ dir, log: message => logs.push(message),
    onMessage: async () => { throw new Error('boom') } })
  bot.credential = { ilink_user_id: 'u1' }
  bot.handleMessage({ from_user_id: 'u1', message_id: 'm1', item_list: [{ type: 1, text_item: { text: '早上好' } }] })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(logs.some(line => line.includes('处理微信消息失败')))
})

test('article fetcher refuses loopback and private addresses', () => {
  const result = spawnSync(python, [resolve('plugins/reading-inbox/tools/fetch_article.py'), 'http://127.0.0.1:9/secret'], { encoding: 'utf8' })
  const payload = JSON.parse(result.stdout)
  assert.match(payload.error, /内网|回环/)
  assert.equal(payload.body, '')
})

test('transient model failures are retried once; invalid responses are not', async t => {
  const { dir } = fixture(t)
  const reply = { intent: 'chat', continuation: false, collect_refs: false, reply: '好', items: [],
    model: { provider: 'p', model: 'm' } }
  const handlers = { mark: async () => {}, record: async () => ({ receipt: '' }), digest: async () => ({ receipt: '' }) }
  let attempts = 0
  const flaky = { classify: async () => {
    attempts += 1
    if (attempts === 1) throw Object.assign(new Error('上游抖了一下'), { code: 'MODEL_CALL_FAILED' })
    return reply
  } }
  const first = await new JournalChat({ dir, llm: flaky, context: async () => ({ projects: [], items: [], notebook: '' }) })
    .route('wx', { text: '中午订餐', ev: 'r1' }, handlers)
  assert.equal(attempts, 2, '失败后应重试一次')
  assert.equal(first.reply, '好')

  let invalid = 0
  const broken = { classify: async () => { invalid += 1; throw Object.assign(new Error('格式不对'), { code: 'MODEL_RESPONSE_INVALID' }) } }
  await assert.rejects(new JournalChat({ dir, llm: broken, context: async () => ({ projects: [], items: [], notebook: '' }) })
    .route('wx', { text: '中午订餐', ev: 'r2' }, handlers), { code: 'MODEL_RESPONSE_INVALID' })
  assert.equal(invalid, 1, '格式错误不应重试')
})

test('WeChat routes chat, followups, explicit notes and mode changes; ingest excludes conversation', async t => {
  const { dir, journal } = fixture(t)
  let bot
  const sent = []
  const originalLoad = WeChatBot.prototype.load
  const originalSend = WeChatBot.prototype.sendText
  WeChatBot.prototype.load = async function () { bot = this; this.credential = { ilink_user_id: 'owner' } }
  WeChatBot.prototype.sendText = async function (text) { sent.push(text) }
  t.after(() => { WeChatBot.prototype.load = originalLoad; WeChatBot.prototype.sendText = originalSend })
  const cleanup = []
  const inputs = []
  const tools = []
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'configured', model: 'm' }) },
    llm: { listProviders: () => [{ id: 'configured' }, { id: 'unused' }], listModels: async provider => provider === 'configured' ? [{ id: 'm' }] : [], async *stream(options) {
      assert.equal(options.provider, 'configured')
      assert.equal(options.model, 'm')
      const input = JSON.parse(options.messages[0].content[0].text)
      inputs.push({ purpose: options.purpose, input })
      let output = options.purpose === 'journal-chat' ? { reply: input.history.length ? '接着刚才的实验讨论。' : '可以讨论实验。' }
        : options.purpose === 'journal-digest'
          ? { title: '第 1 期 · 这周收藏', intro: '这周攒了一篇。',
              sections: [{ heading: '金刚石铜冷板', body: '比纯铜低 3–5℃。', item_ids: ['it_1'] }],
              top_pick_id: 'it_1', top_pick_reason: '最具体' }
          : { items: [{ type: 'task', text: '整理结果', note: '', quote: input.text, project: null, due: null, at: null, place: null, time_quote: null }] }
      if (options.purpose === 'journal-classify') output = input.text.includes('周报')
        ? { intent: 'digest', continuation: false, collect_refs: false, reply: '', items: [] }
        : { intent: 'task', continuation: false, collect_refs: false, reply: '', items: output.items }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(output) } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
    agents: { currentInitiator: () => undefined },
    tools: { register(definition) { tools.push(definition); return () => {} } }, webServer: { register() { return () => {} } },
    inject(_names, fn) { fn(this) }, on() {},
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose) },
  }
  t.after(() => cleanup.reverse().forEach(fn => fn()))
  mkdirSync(join(dir, 'inbox'), { recursive: true })
  writeFileSync(join(dir, 'inbox', 'inbox.json'), JSON.stringify({ version: 1, digests: [], reminders: [],
    items: [{ id: 'it_1', url: 'https://mp.weixin.qq.com/s/x', title: '访谈纪要：AI芯片散热', site: 'mp.weixin.qq.com',
      note: '收藏。内容放入周报', tags: [], status: 'inbox', summary: '', minutes: null, kind: '', source: 'wechat',
      addedAt: '2026-11-10T20:00:00.000Z', updatedAt: '2026-11-10T20:00:00.000Z',
      body: '金刚石铜冷板的技术优势。', bodyChars: 12, bodyAt: '2026-11-10T20:01:00.000Z' }] }))
  apply(ctx, { dataDir: join(dir, 'inbox'), journalDir: dir, python })
  const readingGet = tools.find(tool => tool.name === 'reading_get')
  const rendered = readingGet.output.render({ id: 'it_1' },
    { item: { title: '访谈纪要', url: 'https://x', body: '金刚石铜冷板的技术优势。', bodyChars: 12 } })
  assert.ok(JSON.stringify(rendered).includes('金刚石铜冷板的技术优势'))
  const readingList = tools.find(tool => tool.name === 'reading_list')
  const listText = JSON.stringify(readingList.output.render({}, await readingList.execute({})))
  assert.ok(listText.includes('it_1'), 'reading_list 必须把条目 id 交给模型')
  assert.ok(listText.includes('访谈纪要'))
  const receive = (text, id, from = 'owner') => bot.handleMessage({ from_user_id: from, message_id: id,
    item_list: [{ type: 1, text_item: { text } }] })
  await receive('/聊天', 'start')
  await receive('一起讨论实验', '1')
  await receive('那接下来呢 https://example.org', '2')
  assert.equal(sent.at(-1), '接着刚才的实验讨论。')
  assert.equal(inputs[1].input.history[0].user, '一起讨论实验')
  const calls = inputs.length
  await receive('那接下来呢 https://example.org', '2')
  assert.equal(inputs.length, calls)
  assert.equal(journal(['state']).items.length, 0)
  const eventsFile = join(dir, 'inbox', 'wechat-events.json')
  assert.equal(journal(['ingest'], { WECHAT_EVENTS: eventsFile }).new, 0)
  await receive('/记 整理结果', 'note')
  assert.equal(journal(['state']).items.length, 1)
  assert.equal(journal(['state']).items[0].text, '整理结果')
  await receive('/记 整理结果', 'note')
  assert.equal(journal(['state']).items.length, 1)
  assert.equal(journal(['ingest'], { WECHAT_EVENTS: eventsFile }).new, 0)
  await receive('别人询问账本', 'stranger', 'stranger')
  assert.equal(inputs.length, calls + 1)
  await receive('/新对话', 'reset')
  await receive('重新开始', '3')
  assert.equal(inputs.at(-1).input.history.length, 0)
  await receive('/退出聊天', 'stop')
  await receive('整理结果', 'new-note')
  assert.equal(journal(['state']).items.length, 2)
  const beforeRepeat = sent.length
  await receive('整理结果', 'new-note')
  assert.equal(sent.length, beforeRepeat, '同一条消息重投时不应再发一遍回执')
  assert.equal(journal(['state']).items.length, 2)
  await receive('出个周报', 'digest-write')
  const inbox = JSON.parse(readFileSync(join(dir, 'inbox', 'inbox.json'), 'utf8'))
  assert.equal(inbox.digests.length, 1)
  assert.equal(inbox.digests[0].title, '点评 · 第 1 期 · 这周收藏')
  assert.equal(inbox.digests[0].sections[0].heading, '金刚石铜冷板')
  assert.ok(sent.at(-1).includes('已生成点评'))
  assert.equal(journal(['state']).items.length, 2)
  await receive('发送给我', 'digest-send')
  assert.ok(sent.at(-1).includes('金刚石铜冷板'))
  assert.ok(sent.at(-1).includes('比纯铜低 3–5℃'))
  const attachmentsDir = join(dir, 'attachments', '2026-11')
  mkdirSync(attachmentsDir, { recursive: true })
  const picture = join(attachmentsDir, 'pic.jpg')
  writeFileSync(picture, 'x')
  writeFileSync(join(dir, 'attachments', 'index.jsonl'),
    `${JSON.stringify({ at: new Date().toISOString(), kind: 'image', name: 'pic.jpg', bytes: 1, path: picture })}\n`)
  await receive('取消刚才的保存', 'undo-save')
  assert.ok(sent.at(-1).includes('已撤销'))
  assert.equal(existsSync(picture), false)
  assert.equal(readFileSync(join(dir, 'attachments', 'index.jsonl'), 'utf8'), '')
  const routes = JSON.parse(readFileSync(eventsFile, 'utf8'))
  assert.equal(routes.find(e => e.id === '1').journal_route, 'chat')
  assert.equal(routes.find(e => e.id === 'stranger').journal_route, 'ignored')
})
