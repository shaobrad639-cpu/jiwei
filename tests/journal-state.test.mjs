// store 脏数据容错 + prune 墓碑。四条硬规则之外的可靠性底线：
// 旧 store 里缺时区的时间戳、缺字段的条目，不能让 render / status / prune 崩；
// prune 不许让已完成的记录消失，也不许让真正清掉的记录无迹可查。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { python } from './python.mjs'

const stamp = (offsetDays) => {
  const d = new Date(Date.now() + offsetDays * 86400000 - 8 * 3600000)
  return d.toISOString().slice(0, 19) + '+08:00'
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'journal-state-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const file of readdirSync('journal').filter(f => f.endsWith('.py') || f === 'RULES.md')) {
    copyFileSync(join('journal', file), join(dir, file))
  }
  const run = (args) => spawnSync(python, [join(dir, 'journal.py'), ...args], {
    encoding: 'utf8', env: { ...process.env, JOURNAL_DIR: dir },
  })
  const text = (...args) => {
    const result = run(args)
    assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout)
    return result.stdout
  }
  const journal = (...args) => {
    const out = text(...args)
    return out ? JSON.parse(out) : null
  }
  journal('init')
  const writeStore = (items) => writeFileSync(join(dir, 'store.json'), JSON.stringify({
    version: 1, projects: [], items, pending: [], cursor: {},
  }, null, 2))
  const readStore = () => JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8'))
  return { dir, run, text, journal, writeStore, readStore }
}

test('store: 无时区的时间戳不再让 render / status 崩', (t) => {
  const { text, journal, writeStore } = fixture(t)
  writeStore([{
    id: 'k_naive', type: 'idea', text: '没时区的旧想法', status: 'new',
    created: stamp(-2).slice(0, 19), // 2026-xx-xxT09:00:00，故意不带 +08:00
    updated: stamp(-2).slice(0, 19), history: [], project: null, due: null, at: null,
  }])
  const board = text('render')
  assert.ok(board.includes('没时区的旧想法'), 'render 应把旧想法渲进最近的想法')
  const state = journal('state')
  const idea = state.items.find(i => i.id === 'k_naive')
  assert.ok(idea, 'state 应含该条')
  assert.equal(idea.status, 'new')
  assert.match(idea.created, /\+08:00$/, '缺时区应按本机时区补成 +08:00')
  assert.match(idea.created.slice(0, 10), /^\d{4}-\d{2}-\d{2}$/)
  journal('status') // 之前这里会 TypeError: can't compare offset-naive and offset-aware
})

test('store: 缺 status / 缺 history 的条目按类型补默认值，不崩', (t) => {
  const { text, journal, writeStore } = fixture(t)
  writeStore([
    { id: 't_nostatus', type: 'task', text: '缺状态的任务', created: stamp(-1), updated: stamp(-1) },
    { id: 'x_unknown', text: '连 type 都没有的条目', created: stamp(-1) },
    { id: 'k_nohist', text: '缺 history 的想法', created: stamp(-1) },
  ])
  const board = text('render')
  assert.ok(board.includes('缺状态的任务'), '缺 status 的任务应出现在记录区')
  const state = journal('state')
  assert.equal(state.items.find(i => i.id === 't_nostatus').status, 'open')
  const plain = state.items.find(i => i.id === 'x_unknown')
  assert.equal(plain.type, 'task', 'id 不带 k_ 前缀时按 task 补')
  assert.equal(plain.status, 'open')
  const repaired = state.items.find(i => i.id === 'k_nohist')
  assert.equal(repaired.type, 'idea', 'k_ 前缀按 idea 补')
  assert.equal(repaired.status, 'new')
  assert.deepEqual(repaired.history, [])
  journal('status')
  journal('list')
})

test('prune: done / dropped 任务不被删', (t) => {
  const { journal, writeStore, readStore } = fixture(t)
  writeStore([
    { id: 't_done', type: 'task', text: '早就做完的事', status: 'done',
      created: stamp(-40), updated: stamp(-40), history: [] },
    { id: 't_dropped', type: 'task', text: '主动丢掉的事', status: 'dropped',
      created: stamp(-40), updated: stamp(-40), history: [] },
  ])
  const out = journal('prune')
  assert.equal(out.count, 0, 'done / dropped 一条都不该删')
  assert.deepEqual(out.removed, [])
  const ids = readStore().items.map(i => i.id).sort()
  assert.deepEqual(ids, ['t_done', 't_dropped'])
})

test('prune: 清掉的条目留墓碑，可追溯', (t) => {
  const { journal, writeStore, readStore } = fixture(t)
  writeStore([
    { id: 't_stale', type: 'task', text: '过期没挂项目的提醒', status: 'open',
      created: stamp(-30), updated: stamp(-30), history: [] },
    { id: 't_live', type: 'task', text: '今天的提醒', status: 'open',
      created: stamp(0), updated: stamp(0), history: [] },
  ])
  const out = journal('prune')
  assert.equal(out.count, 1)
  assert.equal(out.removed[0].id, 't_stale')
  assert.ok(out.removed[0].text.includes('过期没挂项目'))
  assert.equal(out.archive_total, 1)

  const store = readStore()
  assert.deepEqual(store.items.map(i => i.id), ['t_live'])
  assert.equal(store.archive.length, 1)
  const tomb = store.archive[0]
  assert.equal(tomb.id, 't_stale')
  assert.equal(tomb.status, 'open')
  assert.match(tomb.pruned_at, /\+08:00$/)
  assert.ok(tomb.reason.length > 0, '墓碑要写清为什么清')
  assert.equal(tomb.item.text, '过期没挂项目的提醒', '整条原记录要留档，能还原')

  // 幂等：再跑一次不该重复删、也不该再堆墓碑
  assert.equal(journal('prune').count, 0)
  assert.equal(readStore().archive.length, 1)
})

test('prune: 有项目或报销发票的照旧保留', (t) => {
  const { journal, writeStore } = fixture(t)
  writeStore([
    { id: 't_proj', type: 'task', text: '挂项目的旧事', status: 'open',
      created: stamp(-40), updated: stamp(-40), history: [], project: 'p_x' },
    { id: 't_inv', type: 'task', text: '报销 12 月的车票', status: 'open',
      created: stamp(-40), updated: stamp(-40), history: [] },
  ])
  assert.equal(journal('prune').count, 0)
})
