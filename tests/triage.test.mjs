// 分诊去重：同一件事被拆成几条微信消息时只记一次，但隔天要能重新记。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import { python } from './python.mjs'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'journal-triage-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const file of readdirSync('journal').filter((f) => f.endsWith('.py') || f === 'RULES.md')) {
    copyFileSync(join('journal', file), join(dir, file))
  }
  const journal = (args, env = {}, input) => {
    const result = spawnSync(python, [join(dir, 'journal.py'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, JOURNAL_DIR: dir, ...env },
      ...(input === undefined ? {} : { input }),
    })
    const line = String(result.stdout || '').trim().split(/\r?\n/).pop() || ''
    let payload = null
    try {
      payload = JSON.parse(line)
    } catch {
      payload = null
    }
    return { result, payload }
  }
  const state = () => journal(['state']).payload
  // 条目时间由 journal 自己写，测 24 小时窗口时得把它改旧。
  const backdate = (hours) => {
    const file = join(dir, 'store.json')
    const data = JSON.parse(readFileSync(file, 'utf8'))
    const stamp = new Date(Date.now() - hours * 3600 * 1000).toISOString()
    for (const item of data.items) item.created = stamp
    writeFileSync(file, JSON.stringify(data, null, 2))
  }
  return { dir, journal, state, backdate }
}

// 走 --plan 需要把 JSON 喂到 stdin
function triageWith(journal, text, planJson) {
  return journal(['triage', '--text', text, '--plan', '-'], {}, planJson).payload
}

function triage(journal, text, at = '') {
  const args = ['triage', '--text', text]
  if (at) args.push('--at', at)
  return journal(args).payload
}

test('identical text redelivered is recorded once', (t) => {
  const { journal, state } = fixture(t)
  triage(journal, '明天交周报')
  assert.equal(state().items.length, 1)

  const second = triage(journal, '明天交周报')
  assert.equal(second.duplicate, true)
  assert.equal(state().items.length, 1)
})

test('a paraphrased follow-up does not create a second entry', (t) => {
  const { journal, state } = fixture(t)
  // 同一件事被拆成第二条消息：原文不同、时间不同，ev 也就不同
  triage(journal, '明天交周报')
  const again = triage(journal, '还是明天交周报，补进去')
  assert.equal(again.duplicate, true, '换了说法的同一件事应当认出来')
  assert.equal(state().items.length, 1)
})

test('a genuinely different task still gets recorded', (t) => {
  const { journal, state } = fixture(t)
  triage(journal, '明天交周报')
  const other = triage(journal, '后天给客户打电话')
  assert.equal(other.duplicate, undefined)
  assert.equal(state().items.length, 2)
})

test('the same wording on a later day is a new entry, not a duplicate', (t) => {
  const { journal, state, backdate } = fixture(t)
  // 两天前那条：ev 按当天算
  const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString()
  triage(journal, '明天交周报', twoDaysAgo)
  assert.equal(state().items.length, 1)

  // created 由 journal 写成本次运行时间，测窗口时把它改旧
  backdate(30)
  const again = triage(journal, '明天交周报')
  assert.equal(again.duplicate, undefined, '隔了 30 小时应当允许重新记')
  assert.equal(state().items.length, 2)
})

test('the same wording for another day is a new arrangement, not a duplicate', (t) => {
  const { journal, state } = fixture(t)
  const first = triage(journal, '今天下午 3:30 电话会议')
  assert.equal(first.duplicate, undefined)
  // 昨天 15:30 那场会还在账上；今天说「明天下午 1:30」是新的一场，不能被判重挡掉。
  const next = triage(journal, '明天下午 1:30 电话会议')
  assert.equal(next.duplicate, undefined, '换了一天就是另一场会')
  assert.equal(state().items.length, 2)
})

test('a completed entry does not block a paraphrase', (t) => {
  const { journal, state } = fixture(t)
  const created = triage(journal, '明天交周报')
  journal(['set', '--id', created.created, '--status', 'done'])
  assert.equal(state().items[0].status, 'done')

  const again = triage(journal, '明天要交周报这件事')
  assert.equal(again.duplicate, undefined, 'done 的条目不该拦新说法')
  assert.equal(state().items.length, 2)
})

test('identical text against a done entry reports it is already done', (t) => {
  const { journal, state } = fixture(t)
  const created = triage(journal, '明天交周报')
  journal(['set', '--id', created.created, '--status', 'done'])
  // 同一天、同一句话：ev 相同，走 ev 去重，回执说明已完成
  const again = triage(journal, '明天交周报')
  assert.equal(again.duplicate, true)
  assert.match(again.receipt, /已完成/)
  assert.equal(state().items.length, 1)
})

test('an idea is deduplicated too, not just tasks', (t) => {
  const { journal, state } = fixture(t)
  // 没有时间词也没有动词，规则分诊归为想法
  const first = triage(journal, '报销发票')
  assert.equal(state().items.length, 1)
  const again = triage(journal, '报销发票')
  assert.equal(again.duplicate, true, '想法同样不该重复入库')
  assert.equal(state().items.length, 1)
})

test('capture keeps one copy of the original message per text', (t) => {
  const { dir, journal } = fixture(t)
  triage(journal, '明天交周报')
  triage(journal, '明天交周报')
  const captureDir = join(dir, 'capture')
  const rows = existsSync(captureDir)
    ? readdirSync(captureDir).filter((f) => f.endsWith('.jsonl'))
        .flatMap((f) => readFileSync(join(captureDir, f), 'utf8').split('\n').filter(Boolean))
    : []
  assert.equal(rows.length, 1, '原文只该留一份，重投不应再追加')
})

// 直接测函数本身：命令行测不出「正好卡在边界」和「时间戳坏了」这两种情况。
test('the dedup window is measured on created time and tolerates bad timestamps', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-window-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const probe = join(dir, 'probe.py')
  writeFileSync(probe, [
    'import sys, json, datetime as dt',
    `sys.path.insert(0, ${JSON.stringify(resolve('journal'))})`,
    'import journal',
    'now = dt.datetime.now(journal.TZ)',
    'def item(text, hours, status="open", created=None):',
    '    stamp = created if created is not None else journal.iso(now - dt.timedelta(hours=hours))',
    '    return {"id": "t_1", "type": "task", "text": text, "status": status,',
    '            "created": stamp, "quote": "", "history": []}',
    'cases = {}',
    'cases["within"] = bool(journal.find_semantic_duplicate({"items": [item("交周报", 23)]}, "交周报", now))',
    'cases["outside"] = bool(journal.find_semantic_duplicate({"items": [item("交周报", 25)]}, "交周报", now))',
    'cases["done"] = bool(journal.find_semantic_duplicate({"items": [item("交周报", 1, "done")]}, "交周报", now))',
    'cases["dropped"] = bool(journal.find_semantic_duplicate({"items": [item("交周报", 1, "dropped")]}, "交周报", now))',
    'cases["bad_stamp"] = bool(journal.find_semantic_duplicate({"items": [item("交周报", 1, created="不是时间")]}, "交周报", now))',
    'cases["idea_new"] = bool(journal.find_semantic_duplicate({"items": [item("报销发票", 1, "new")]}, "报销发票", now))',
    'print(json.dumps(cases))',
  ].join('\n'))
  const result = spawnSync(python, [probe], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const cases = JSON.parse(result.stdout.trim())
  assert.equal(cases.within, true, '23 小时内应当认作重复')
  assert.equal(cases.outside, false, '25 小时前的不该再拦')
  assert.equal(cases.done, false, 'done 不参与去重')
  assert.equal(cases.dropped, false, 'dropped 不参与去重')
  assert.equal(cases.bad_stamp, false, '时间戳解析不了就跳过，宁可多记')
  assert.equal(cases.idea_new, true, '想法的 new 状态同样要去重')
})

test('a paraphrase that still carries the time phrase is still a duplicate', (t) => {
  const { journal, state } = fixture(t)
  // 条目正文会被剥掉时间（「给客户回电话」），新消息还带着「明天下午三点」，
  // 直接比只有 0.6 相似度，必须先剥时间再比
  triage(journal, '明天下午三点给客户回电话')
  assert.equal(state().items.length, 1)
  const again = triage(journal, '明天下午三点要给客户回个电话')
  assert.equal(again.duplicate, true, '带时间词的同义句也应当认作重复')
  assert.equal(state().items.length, 1)
})

// 下面几条锁住 cmd_triage 拆分后的各条去向，它们曾经都挤在同一个函数里。
test('a long group notice becomes one event with time and place', (t) => {
  const { journal, state } = fixture(t)
  const notice = '各位同学大家好，本次海清志愿服务具体安排如下：将于11月28日上午9:00在'
    + '【三教报告厅】举行动员会，请大家提前15分钟到场签到，届时会有老师讲解注意事项，请务必准时参加。'
  triage(journal, notice)
  const items = state().items
  assert.equal(items.length, 1, '公告只该抽出一个主事件，不按句切')
  assert.equal(items[0].text, '参加海清志愿服务')
  assert.equal(items[0].at.clock, '09:00')
  assert.equal(items[0].place, '三教报告厅')
})

test('a reply to a pending question is matched instead of becoming a new note', (t) => {
  const { journal, state } = fixture(t)
  const asked = journal(['ask', '--text', '周报要不要并入月报？',
    '--choices-json', '[{"label":"并入"},{"label":"分开"}]']).payload
  journal(['question-sent', '--id', asked.id])

  const answer = triage(journal, '周报要不要并入月报？并入')
  assert.equal(answer.answered, asked.id)
  assert.match(answer.receipt, /已保存答复/)
  assert.equal(state().items.length, 0, '答复不该被记成新条目')
})

test('the LLM plan path writes the proposed entries', (t) => {
  const { journal, state } = fixture(t)
  const plan = {
    items: [{
      type: 'task', text: '交季度报告', note: '', quote: '下周一交季度报告',
      project: null, due: '2026-11-30', at: null, place: null, time_quote: '下周一',
    }],
    model: { provider: 'p', model: 'm' },
  }
  const result = triageWith(journal, '下周一交季度报告', JSON.stringify(plan))
  assert.equal(result.engine, 'llm')
  const items = state().items
  assert.equal(items.length, 1)
  assert.equal(items[0].text, '交季度报告')
  assert.equal(items[0].due, '2026-11-30')
})

test('the LLM plan is filtered when it repeats an existing entry', (t) => {
  const { journal, state } = fixture(t)
  triage(journal, '明天交周报')
  const plan = {
    items: [{
      type: 'task', text: '交周报', note: '', quote: '明天交周报',
      project: null, due: null, at: null, place: null, time_quote: '明天',
    }],
    model: { provider: 'p', model: 'm' },
  }
  const result = triageWith(journal, '明天交周报', JSON.stringify(plan))
  assert.equal(result.duplicate, true, '模型提议与旧记录重复时应当挡下')
  assert.equal(state().items.length, 1)
})

test('--check-reply only classifies and never writes', (t) => {
  const { journal, state } = fixture(t)
  const result = journal(['triage', '--text', '随便一句话', '--check-reply']).payload
  assert.equal(result.needs_classification, true)
  assert.equal(state().items.length, 0)
})

test('a pure link is left to the reading inbox and stays silent', (t) => {
  const { journal, state } = fixture(t)
  const result = triage(journal, 'https://mp.weixin.qq.com/s/abc')
  assert.equal(result.created, null)
  assert.equal(result.receipt, '')
  assert.equal(state().items.length, 0)
})
