import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JournalLlm } from '../plugins/reading-inbox/llm.js'
import { apply } from '../plugins/reading-inbox/index.js'

function fixture(config = {}) {
  const llm = new JournalLlm(config)
  const catalogs = { official: [], account: [], custom: ['first', 'second'] }
  const calls = []
  llm.runtime = {
    listProviders: () => Object.keys(catalogs).map(id => ({ id })),
    async listModels(provider) {
      const value = catalogs[provider]
      if (value instanceof Error) throw value
      if (typeof value === 'function') return value()
      return value.map(id => ({ id }))
    },
    async *stream(options) {
      calls.push(options)
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"reply":"连接正常"}' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  llm.defaultModel = { currentSelection: () => ({ provider: 'official', model: 'default' }) }
  return { llm, catalogs, calls }
}

test('automatic routing skips unauthenticated defaults and uses the only available configured provider', async () => {
  const { llm, catalogs, calls } = fixture()
  assert.deepEqual(await llm.route(), { provider: 'custom', model: 'first' })
  assert.equal(llm.status.selection.source, 'available-provider')
  assert.deepEqual(llm.status.selection.skipped, [{ provider: 'official', model: 'default', reason: 'NO_AVAILABLE_MODELS' }])
  assert.equal((await llm.chat({ text: '连接测试' })).reply, '连接正常')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].provider, 'custom')
  catalogs.custom = []
  catalogs.another = ['new-model']
  assert.deepEqual(await llm.route(), { provider: 'another', model: 'new-model' })
})

test('available initiator, recent conversation and default choices take priority and follow changes', async () => {
  const { llm, catalogs } = fixture()
  catalogs.official = ['default']
  assert.deepEqual(await llm.route(), { provider: 'official', model: 'default' })
  llm.observe({ provider: 'custom', model: 'second', reasoningEffort: 'low' })
  assert.deepEqual(await llm.route(), { provider: 'custom', model: 'second', reasoningEffort: 'low' })
  llm.observe({ provider: 'official', model: 'default', purpose: 'session-title' })
  assert.equal((await llm.route()).model, 'second')
  llm.agents = { currentInitiator: () => ({ model: { current: { provider: 'custom', model: 'first' } } }) }
  assert.equal((await llm.route()).model, 'first')
  assert.equal(llm.status.selection.source, 'initiator')
  catalogs.custom = []
  assert.equal((await llm.route()).provider, 'official')
  assert.equal(llm.status.selection.source, 'default')
  llm.agents = null
  llm.lastRoute = null
  llm.defaultModel.currentSelection = () => ({ provider: 'custom', model: 'first' })
  catalogs.custom = ['first']
  assert.equal((await llm.route()).provider, 'custom')
})

test('consistent live sessions resolve ambiguity when the default is unavailable; stale models are skipped', async () => {
  const { llm, catalogs } = fixture()
  catalogs.account = ['signed-in']
  llm.agents = { roots: () => [1, 2].map(() => ({ session: { requestHeader: () => ({ config: { provider: 'custom', model: 'second' } }) } })) }
  assert.deepEqual(await llm.route(), { provider: 'custom', model: 'second' })
  assert.equal(llm.status.selection.source, 'root-session')
  catalogs.custom = ['replacement']
  await assert.rejects(llm.route(), { code: 'MODEL_ROUTE_AMBIGUOUS' })
  assert.equal(llm.status.selection.skipped.at(-1).reason, 'MODEL_UNAVAILABLE')
})

test('ambiguous or entirely unavailable providers do not cause requests to an arbitrary service', async () => {
  const { llm, catalogs, calls } = fixture()
  catalogs.account = ['signed-in']
  await assert.rejects(llm.chat({ text: '私人消息' }), { code: 'MODEL_ROUTE_AMBIGUOUS' })
  assert.equal(calls.length, 0)
  catalogs.account = []
  catalogs.custom = []
  await assert.rejects(llm.chat({ text: '私人消息' }), { code: 'MODEL_ROUTE_UNAVAILABLE' })
  assert.equal(calls.length, 0)
})

test('an explicitly pinned route stays explicit and missing credentials do not switch it to another service', async () => {
  const { llm, calls } = fixture({ provider: 'official', model: 'unlisted' })
  llm.runtime.stream = async function * (options) {
    calls.push(options)
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } } }
  }
  await assert.rejects(llm.chat({ text: '私人消息' }), { code: 'MISSING_CREDENTIAL' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].provider, 'official')
  assert.equal(llm.status.selection.source, 'explicit')
  llm.config = { provider: 'official' }
  await assert.rejects(llm.route(), { code: 'MODEL_ROUTE_CONFIG' })
})

test('slow and failed model catalogs are bounded, isolated and redacted in diagnostics', async () => {
  const { llm, catalogs } = fixture({ discoveryTimeoutMs: 15 })
  catalogs.official = () => new Promise(() => {})
  catalogs.account = Object.assign(new Error('private-auth-token-and-service-body'), { code: 'AUTH' })
  const status = await llm.diagnostics()
  assert.equal(status.route.provider, 'custom')
  assert.equal(status.catalogs.find(c => c.provider === 'official').error, 'MODEL_DISCOVERY_TIMEOUT')
  assert.equal(status.catalogs.find(c => c.provider === 'account').error, 'AUTH')
  assert.ok(!JSON.stringify(status).includes('private-auth-token'))
})

test('overall request cancellation stops catalog discovery without starting a late model call', async () => {
  const { llm, catalogs, calls } = fixture({ timeoutMs: 10, discoveryTimeoutMs: 500 })
  catalogs.official = () => new Promise(() => {})
  await assert.rejects(llm.chat({ text: '连接测试' }), { code: 'MODEL_TIMEOUT' })
  assert.equal(llm.controllers.size, 0)
  assert.equal(calls.length, 0)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(calls.length, 0)
})

test('WeChat follows the journal schedule session and immediately follows its next selected model', async () => {
  const { llm } = fixture()
  llm.journalDir = '/my journal/data'
  llm.schedule = { catalog: async () => [
    { id: 'other', title: '晚间收口', sessionId: 'unrelated', status: 'active', prompt: '/another/data' },
    { id: 'weekly', title: '周报压实', sessionId: 'journal', status: 'active', prompt: '/my journal/data' },
    { id: 'daily', title: '晚间收口', sessionId: 'journal', status: 'active', prompt: '/my journal/data' },
    { id: 'inactive', title: '晚间收口', sessionId: 'old', status: 'inactive', prompt: '/my journal/data' },
  ] }
  let next = { provider: 'scheduled-provider', model: 'scheduled-model', reasoningEffort: 'high' }
  llm.sessionController = { projections: async ({ sessionId }, signal) => {
    assert.equal(sessionId, 'journal')
    assert.equal(signal.aborted, false)
    return { values: { modelSelection: { next, lastUsed: { provider: 'previous', model: 'old' } } } }
  } }
  llm.lastRoute = { provider: 'custom', model: 'second' }
  assert.deepEqual(await llm.route(), next)
  assert.equal(llm.status.selection.source, 'journal-schedule')
  assert.equal(llm.status.selection.schedule.id, 'daily')
  next = { provider: 'scheduled-provider', model: 'new-selection' }
  assert.deepEqual(await llm.route(), next)
  assert.deepEqual((await llm.chat({ text: '连接测试' })).model, next)
})

test('missing journal schedules use ordinary discovery, while unreadable task models fall back without guessing', async () => {
  const { llm } = fixture()
  llm.schedule = { catalog: async () => [] }
  llm.sessionController = { projections: async () => { assert.fail('no scheduled session') } }
  assert.equal((await llm.route()).provider, 'custom')
  llm.schedule.catalog = async () => [{ id: 'daily', title: '晚间收口', sessionId: 'journal', status: 'active' }]
  llm.sessionController.projections = async () => { throw new Error('private session contents') }
  // DSH releases differ here; an unreadable task session must degrade to the
  // ordinary candidates rather than blocking every model call.
  const fallback = await llm.route()
  assert.equal(fallback.provider, 'custom')
  const status = await llm.diagnostics()
  assert.equal(status.route_error, undefined)
  assert.ok(!JSON.stringify(status).includes('private session'))
})

test('plugin wiring reads the schedule service and its session model without a fixed provider', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-schedule-model-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const tools = new Map()
  const cleanup = []
  let current = { provider: 'custom', model: 'second' }
  const { llm } = fixture()
  const ctx = {
    llm: llm.runtime,
    schedule: { catalog: async () => [{ id: 'daily', title: '晚间收口', status: 'active', sessionId: 'journal', prompt: dir }] },
    sessionController: { projections: async () => ({ values: { modelSelection: { next: current } } }) },
    tools: { register(tool) { tools.set(tool.name, tool); return () => {} } },
    webServer: { register() { return () => {} } },
    inject(names, fn) { if (names.every(name => this[name])) fn(this) }, on() {},
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose) },
  }
  t.after(() => cleanup.reverse().forEach(fn => fn()))
  apply(ctx, { dataDir: join(dir, 'inbox'), journalDir: dir })
  const status = await tools.get('reading_journal_llm_status').execute()
  assert.deepEqual(status.route, current)
  assert.equal(status.selection.source, 'journal-schedule')
  assert.equal(status.selection.schedule.session_id, 'journal')
  current = { provider: 'custom', model: 'first' }
  assert.deepEqual((await tools.get('reading_journal_llm_status').execute()).route, current)
})
