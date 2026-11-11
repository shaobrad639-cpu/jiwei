import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { JournalLlm, triageMessage, chatErrorMessage } from '../plugins/reading-inbox/llm.js'
import { apply } from '../plugins/reading-inbox/index.js'

const python = process.env.DSH_PYTHON || 'python'
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'journal-llm-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const invoke = (args, input) => spawnSync(python, [resolve('journal/journal.py'), ...args], {
    encoding: 'utf8', input: input === undefined ? undefined : JSON.stringify(input),
    env: { ...process.env, JOURNAL_DIR: dir },
  })
  const journal = async (args, input) => {
    const r = invoke(args, input)
    if (r.status !== 0) throw new Error(r.stderr || r.stdout)
    return JSON.parse(r.stdout)
  }
  return { dir, journal, invoke }
}

function plan(text, quote, extra = {}) {
  return { items: [{ type: 'task', text, quote, project: null, due: null, at: null,
    place: null, time_quote: null, note: '', ...extra }] }
}

function runtime(output, reason = { kind: 'stop' }) {
  return {
    listProviders: () => [{ id: 'configured' }],
    listModels: async () => [{ id: 'my-model' }],
    async *stream(options) {
      this.request = options
      yield { type: 'reasoning-delta', index: 0, text: 'private reasoning must not enter JSON' }
      const text = typeof output === 'string' ? output : JSON.stringify(output)
      yield { type: 'text-delta', index: 1, text: text.slice(0, 7) }
      yield { type: 'text-delta', index: 1, text: text.slice(7) }
      yield { type: 'block-end', index: 1, block: { type: 'text', text } }
      yield { type: 'finish', reason }
    },
  }
}

test('Harness routes, visible stream assembly and terminal failure checks', async () => {
  const llm = new JournalLlm()
  llm.runtime = runtime({ items: [] })
  llm.runtime.listProviders = () => ['user-provider', 'caller'].map(id => ({ id }))
  llm.runtime.listModels = async provider => [{ id: provider === 'caller' ? 'selected' : 'user-model' }]
  llm.observe({ provider: 'user-provider', model: 'user-model', reasoningEffort: 'low' })
  llm.observe({ provider: 'other', model: 'other', purpose: 'session-title' })
  const result = await llm.triage({ text: '收藏' })
  assert.deepEqual(result.value, { items: [] })
  assert.deepEqual(result.model, { provider: 'user-provider', model: 'user-model' })
  assert.equal(llm.runtime.request.reasoningEffort, 'low')
  assert.equal(llm.runtime.request.tools, undefined)
  llm.agents = { currentInitiator: () => ({ model: { current: () => ({ provider: 'caller', model: 'selected' }) } }) }
  assert.equal((await llm.route()).model, 'selected')
  llm.runtime = runtime({ items: [] }, { kind: 'max-tokens' })
  await assert.rejects(llm.triage({}), /max-tokens/)
  llm.runtime = runtime({ items: [] }, { kind: 'error', failure: { code: 'AUTH' } })
  await assert.rejects(llm.triage({}), /AUTH/)
  llm.runtime = runtime('not JSON')
  await assert.rejects(llm.triage({}), SyntaxError)
  llm.stop()
})

test('classify accepts a ledger query answered directly and rejects a query that carries records', async () => {
  const llm = new JournalLlm()
  const input = { text: '我有几个待办报销', history: [], journal: { projects: [], items: [] }, pending: null }
  llm.runtime = runtime({ intent: 'query', continuation: false, collect_refs: false, reply: '未完成 2 条，都是「报销发票」。', items: [] })
  const result = await llm.classify(input)
  assert.equal(result.intent, 'query')
  assert.equal(result.reply, '未完成 2 条，都是「报销发票」。')
  llm.runtime = runtime({ intent: 'query', continuation: false, collect_refs: false, reply: '', items: [] })
  await assert.rejects(llm.classify(input), { code: 'MODEL_RESPONSE_INVALID' })
  llm.runtime = runtime({ intent: 'query', continuation: false, collect_refs: false, reply: '答',
    items: [{ type: 'task', text: '报销发票', note: '', quote: '报销发票', project: null, due: null, at: null, place: null, time_quote: null }] })
  await assert.rejects(llm.classify(input), { code: 'MODEL_RESPONSE_INVALID' })
})

test('a bare slot word only works for the message day; other dates are still rejected', async t => {
  const { invoke } = fixture(t)
  const plan = (date) => ({ items: [{ type: 'task', text: '中午订餐', note: '', quote: '中午订餐', project: null,
    due: null, at: { date, slot: '中午', clock: null }, place: null, time_quote: '中午' }],
    model: { provider: 'p', model: 'm' },
    source_messages: [{ text: '中午订餐', at: '2026-11-11T09:40:00+08:00', ev: 'e1' }] })
  const args = ['triage', '--text', '中午订餐', '--at', '2026-11-11T09:40:00+08:00', '--ev', 'e1', '--validate-plan']
  assert.equal(invoke(args, plan('2026-11-11')).status, 0)
  assert.notEqual(invoke(args, plan('2026-11-10')).status, 0)
})

test('classify accepts a weekly digest request and weeklyDigest validates its own payload', async () => {
  const llm = new JournalLlm()
  const input = { text: '出个周报', history: [], pending: null, journal: { projects: [], items: [] } }
  llm.runtime = runtime({ intent: 'digest', continuation: false, collect_refs: false, reply: '', items: [] })
  assert.equal((await llm.classify(input)).intent, 'digest')
  llm.runtime = runtime({ intent: 'chat', continuation: false, collect_refs: false, reply: '好', items: [],
    digest: { heading: 'h', body: 'b', item_ids: [] } })
  await assert.rejects(llm.classify(input), { code: 'MODEL_RESPONSE_INVALID' })

  const items = [{ id: 'it_1', title: '访谈纪要', body: '金刚石铜冷板', body_chars: 6, note: '', url: 'https://x', status: 'inbox' }]
  llm.runtime = runtime({ title: '第 1 期', intro: '这周攒了一篇。',
    sections: [{ heading: '散热', body: '比纯铜低 3–5℃。', item_ids: ['it_1'] }],
    top_pick_id: 'it_1', top_pick_reason: '最具体' })
  const digest = await llm.weeklyDigest({ items, now: '2026-11-11T05:00:00.000Z', timezone: 'Asia/Shanghai' })
  assert.equal(digest.sections[0].itemIds[0], 'it_1')
  assert.equal(digest.topPickId, 'it_1')
  llm.runtime = runtime({ title: '第 1 期', intro: '',
    sections: [{ heading: '散热', body: 'x', item_ids: ['it_9'] }], top_pick_id: null, top_pick_reason: '' })
  await assert.rejects(llm.weeklyDigest({ items, now: '', timezone: 'Asia/Shanghai' }), { code: 'MODEL_RESPONSE_INVALID' })
  llm.runtime = runtime({ title: '第 1 期', intro: '',
    sections: [{ heading: '散热', body: '长'.repeat(500), item_ids: ['it_1'] }], top_pick_id: null, top_pick_reason: '' })
  const long = await llm.weeklyDigest({ items, now: '', timezone: 'Asia/Shanghai' })
  assert.equal(long.sections[0].body.length, 301, '每篇点评要截到 300 字')
  assert.ok(long.sections[0].body.endsWith('…'))
})

test('timeout bounds discovery as well as a stalled stream; ambiguous routes fail', async () => {
  const llm = new JournalLlm({ timeoutMs: 20 })
  llm.runtime = { listProviders: () => new Promise(() => {}) }
  await assert.rejects(llm.triage({}), /超时/)
  assert.equal(llm.controllers.size, 0)
  llm.runtime = { listProviders: () => [{ id: 'a' }, { id: 'b' }], listModels: async () => [{ id: 'b' }] }
  await assert.rejects(llm.triage({}), /无法确定/)
  llm.lastRoute = { provider: 'a', model: 'b' }
  llm.runtime = { listProviders: () => [{ id: 'a' }], listModels: async () => [{ id: 'b' }], async *stream() { await new Promise(() => {}) } }
  await assert.rejects(llm.triage({}), /超时/)
})

test('WeChat startup uses Harness default selection with multiple adapters and no prior Agent turn', async () => {
  const llm = new JournalLlm()
  llm.runtime = runtime({ reply: '连接正常' })
  llm.runtime.listProviders = () => [{ id: 'deepseek-account' }, { id: 'deepseek-official' }]
  llm.runtime.listModels = async () => []
  llm.agents = { currentInitiator: () => undefined, roots: () => [] }
  await assert.rejects(llm.chat({ text: '你好' }), { code: 'MODEL_ROUTE_UNAVAILABLE' })
  assert.equal(llm.status.lastCall.code, 'MODEL_ROUTE_UNAVAILABLE')
  llm.defaultModel = { currentSelection: () => ({ provider: 'deepseek-account', model: 'selected-default', reasoningEffort: 'low' }) }
  llm.runtime.listModels = async provider => provider === 'deepseek-account' ? [{ id: 'selected-default' }] : []
  const result = await llm.chat({ text: '你好' })
  assert.equal(result.model.provider, 'deepseek-account')
  assert.equal(result.model.model, 'selected-default')
  assert.equal(llm.runtime.request.reasoningEffort, 'low')
  const status = await llm.diagnostics()
  assert.equal(status.has_default_model_service, true)
  assert.equal(status.route.model, 'selected-default')
  assert.deepEqual(status.providers, ['deepseek-account', 'deepseek-official'])
  assert.match(chatErrorMessage({ code: 'MODEL_ROUTE_UNAVAILABLE' }), /默认模型/)
  const safe = chatErrorMessage({ code: 'AUTH', message: 'private-token-and-response-body' })
  assert.match(safe, /认证失败/)
  assert.ok(!safe.includes('private-token'))
})

test('semantic triage persists exact raw evidence, provenance, dates and stays idempotent', async t => {
  const { dir, journal } = fixture(t)
  await journal(['init'])
  writeFileSync(join(dir, 'notebook.md'), '我的本子原文\n')
  const event = { text: '明天晚上七点在会议室讨论方案，我来准备材料', at: '2026-10-31T20:00:00+08:00' }
  const llm = new JournalLlm()
  llm.runtime = runtime(plan('讨论方案', event.text, {
    at: { date: '2026-11-01', slot: '晚上', clock: '19:00' }, place: '会议室', time_quote: '明天晚上七点',
  }))
  const result = await triageMessage(event, journal, llm, async () => 'rules', assert.fail)
  assert.equal(result.engine, 'llm')
  assert.match(result.receipt, /^已加入待办：/)
  assert.match(result.receipt, /会议室/)
  const state = await journal(['state'])
  assert.equal(state.items.length, 1)
  assert.equal(state.items[0].at.clock, '19:00')
  assert.equal(state.items[0].history[0].from, event.text)
  assert.equal(state.items[0].llm.model, 'my-model')
  const again = await triageMessage(event, journal, llm, async () => { assert.fail('duplicate must skip model') }, assert.fail)
  assert.equal(again.duplicate, true)
  assert.match(again.receipt, /已存在，未重复添加/)
  assert.equal((await journal(['state'])).items.length, 1)
  await journal(['set', '--id', result.created, '--status', 'done'])
  const afterCompletion = await triageMessage(event, journal, llm, assert.fail, assert.fail)
  assert.match(afterCompletion.receipt, /该任务已完成，未重复添加/)
  const capture = readdirSync(join(dir, 'capture')).flatMap(f => readFileSync(join(dir, 'capture', f), 'utf8').trim().split('\n'))
  assert.equal(capture.length, 1)
  assert.equal(JSON.parse(capture[0]).text, event.text)
  assert.equal(readFileSync(join(dir, 'notebook.md'), 'utf8'), '我的本子原文\n')
  llm.runtime = runtime({ items: [
    plan('讨论方案', event.text, { place: '会议室' }).items[0],
    plan('准备材料', event.text).items[0],
  ] })
  const multi = await triageMessage({ ...event, at: '2026-10-31T20:01:00+08:00' }, journal, llm, async () => '', assert.fail)
  assert.match(multi.receipt, /会议室/)
})

test('malformed, invented and disallowed fields are rejected atomically; regex fallback remains usable', async t => {
  const { journal, invoke } = fixture(t)
  await journal(['init'])
  const event = { text: '明天完成示例报告', at: '2026-10-31T20:00:00+08:00' }
  const args = ['triage', '--text', event.text, '--at', event.at]
  const context = await journal([...args, '--prepare'])
  assert.equal(context.needs_llm, true)
  for (const extra of [{ quote: '没有说过的话' }, { project: 'unknown' }, { status: 'done' },
    { due: '2026-02-30', time_quote: '明天' }, { due: '2026-11-01' }, { place: '虚构会议室' },
    { at: { date: '2026-11-01', slot: null, clock: '25:00' }, time_quote: '明天' }]) {
    const valid = plan('完成报告', event.text).items[0]
    const invalid = plan('完成报告', event.text, extra).items[0]
    const r = invoke([...args, '--plan', '-'], { items: [valid, invalid], model: { provider: 'configured', model: 'my-model' } })
    assert.notEqual(r.status, 0)
    assert.equal((await journal(['state'])).items.length, 0)
  }
  const llm = new JournalLlm()
  llm.runtime = runtime(plan('完成报告', '伪造的引用'))
  const logs = []
  const result = await triageMessage(event, journal, llm, async () => '', line => logs.push(line))
  assert.ok(result.created)
  assert.equal(logs.length, 1)
  assert.equal((await journal(['state'])).items.length, 1)
  assert.equal((await journal([...args, '--prepare'])).duplicate, true)
})

test('pure links skip model, mixed link tasks use model, empty proposals are deduplicated', async t => {
  const { journal } = fixture(t)
  await journal(['init'])
  const llm = new JournalLlm()
  llm.runtime = runtime({ items: [] })
  const pure = await triageMessage({ text: 'https://example.org', at: '2026-10-31T20:00:00+08:00' }, journal, llm, assert.fail, assert.fail)
  assert.equal(pure.receipt, '')
  const event = { text: '帮我整理这篇文章 https://example.org', at: '2026-10-31T20:01:00+08:00' }
  const result = await triageMessage(event, journal, llm, async () => '', assert.fail)
  assert.equal(result.engine, 'llm')
  assert.equal((await triageMessage(event, journal, llm, assert.fail, assert.fail)).duplicate, true)
})

test('review validates evidence, notebook dates and existing next tasks, and exposes incomplete coverage', async () => {
  const llm = new JournalLlm()
  const context = { projects: [{ id: 'p1' }], items: [{ id: 't1', type: 'task', status: 'open' }],
    evidence: [{ id: 'e1', version: 'v1', excerpt: '已核对初步结果', truncated: true }], next_offset: 6 }
  const notebook = { hash: 'original-hash', notebook: '## 2026-10-31\n今天有一个问题',
    sections: [{ date: '2026-10-31', text: '今天有一个问题' }] }
  const output = { summary: '核对了初步结果，问题仍待确认',
    findings: [{ evidence_id: 'e1', source_id: 'e1', quote: '已核对初步结果', summary: '初步结果已核对', project: 'p1' }],
    next_item_ids: ['t1'], notebook_responses: [{ date: '2026-10-31', quote: '今天有一个问题', response: '这个问题还没有结论。' }], uncertainties: [] }
  llm.runtime = runtime(output)
  const result = await llm.review(context, notebook, 'rules', 'daily')
  assert.equal(result.applied, false)
  assert.equal(result.coverage.complete, false)
  assert.equal(result.coverage.next_offset, 6)
  assert.deepEqual(result.coverage.partial_source_ids, ['e1'])
  assert.equal(result.notebook_responses[0].hash, notebook.hash)
  assert.equal(result.findings[0].version, 'v1')
  for (const change of [
    { next_item_ids: ['invented-task'] },
    { findings: [{ ...output.findings[0], quote: '实验成功了' }] },
    { notebook_responses: [{ ...output.notebook_responses[0], date: '2026-10-30' }] },
  ]) {
    llm.runtime = runtime({ ...output, ...change })
    await assert.rejects(llm.review(context, notebook, 'rules', 'weekly'))
  }
})

test('plugin registers and executes daily review through Harness service and installed Python modules', async t => {
  const { dir, journal } = fixture(t)
  for (const file of readdirSync('journal').filter(f => f.endsWith('.py') || f === 'RULES.md')) {
    copyFileSync(join('journal', file), join(dir, file))
  }
  await journal(['init'])
  writeFileSync(join(dir, 'notebook.md'), '')
  const notebook = readFileSync(join(dir, 'notebook.md'), 'utf8')
  const tools = new Map()
  const cleanup = []
  const ctx = {
    llm: runtime({ summary: '暂无新记录', findings: [], next_item_ids: [], notebook_responses: [], uncertainties: [] }),
    agents: { currentInitiator: () => ({ options: { provider: 'configured', model: 'my-model' } }) },
    tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
    webServer: { register() { return () => {} } },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose) },
    inject(_names, fn) { fn(this) },
    on() {},
  }
  t.after(() => cleanup.reverse().forEach(fn => fn()))
  apply(ctx, { dataDir: join(dir, 'inbox'), journalDir: dir, python,
    llm: { provider: 'configured', model: 'my-model' } })
  assert.ok(tools.has('reading_journal_review'))
  const status = await tools.get('reading_journal_llm_status').execute()
  assert.equal(status.enabled, true)
  assert.equal(status.available, true)
  await assert.rejects(tools.get('reading_journal_review').execute({ mode: 'invalid' }), /mode/)
  const result = await tools.get('reading_journal_review').execute({ mode: 'daily', limit: 1 })
  assert.equal(result.summary, '暂无新记录')
  assert.equal(result.applied, false)
  assert.equal(result.model.model, 'my-model')
  assert.equal((await journal(['state'])).items.length, 0)
  assert.equal(readFileSync(join(dir, 'notebook.md'), 'utf8'), notebook)
})
