import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_LEAD_MINUTES, dueReminders, eventStart, humanGap, leadMinutes,
  parseLead, reminderKey, reminderText,
} from '../plugins/reading-inbox/reminders.js'

const task = (over = {}) => ({
  id: 't_7eaaa0d0', type: 'task', status: 'open', text: '参加电话会议', note: '', place: null,
  at: { date: '2026-11-25', slot: '下午', clock: '15:30' }, at_raw: '下午 3:30', ...over,
})
const at = (iso) => new Date(iso)

test('提前量：默认一小时，条目里写了就按条目的', () => {
  assert.equal(DEFAULT_LEAD_MINUTES, 60)
  assert.equal(parseLead('提前一天（12-29）提醒'), 1440)
  assert.equal(parseLead('提前半小时'), 30)
  assert.equal(parseLead('提前 2 小时提醒'), 120)
  assert.equal(parseLead('下午 3 点半'), null)
  assert.equal(leadMinutes(task()), 60)
  assert.equal(leadMinutes(task({ note: '提前一天提醒' })), 1440)
  assert.equal(leadMinutes(task(), 30), 30)
})

test('发生时间：只有具体钟点才算行程', () => {
  assert.equal(eventStart(task()).toISOString(), '2026-11-25T07:30:00.000Z')
  assert.equal(eventStart(task({ at: { date: '2026-11-25', slot: '下午', clock: null } })), null)
  assert.equal(eventStart(task({ at: null })), null)
  assert.equal(eventStart(task({ at: { date: '2026-11-25', clock: '25:00' } })), null)
  assert.equal(eventStart(task({ at: { date: '2026-13-01', clock: '15:30' } })), null)
})

test('提醒时刻：15:30 的会，14:30 发；会开了就不发', () => {
  const items = [task()]
  assert.deepEqual(dueReminders(items, at('2026-11-25T14:29:00+08:00')), [])
  const due = dueReminders(items, at('2026-11-25T14:30:00+08:00'))
  assert.equal(due.length, 1)
  assert.equal(due[0].key, 't_7eaaa0d0@2026-11-25 15:30')
  assert.equal(due[0].lead, 60)
  // 迟到也发：15:20 打开 DSH，会还没开，还来得及。
  assert.equal(dueReminders(items, at('2026-11-25T15:20:00+08:00')).length, 1)
  // 会已经开始了，别再打扰。
  assert.deepEqual(dueReminders(items, at('2026-11-25T15:30:00+08:00')), [])
  assert.deepEqual(dueReminders(items, at('2026-11-25T16:10:00+08:00')), [])
})

test('提醒时刻：提前一天按条目说的来', () => {
  const item = task({
    id: 't_ef40bd2c', text: '参加科创联联合会', note: '提前一天（12-29）提醒', place: '苏州工业园区世尊酒店苏园厅',
    at: { date: '2026-12-30', slot: '下午', clock: '14:00' },
  })
  assert.deepEqual(dueReminders([item], at('2026-12-29T13:59:00+08:00')), [])
  assert.equal(dueReminders([item], at('2026-12-29T14:00:00+08:00')).length, 1)
  // 发过一次之后，第二天开会前不再重复。
  const sent = { 't_ef40bd2c@2026-12-30 14:00': '2026-12-29T14:00:00+08:00' }
  assert.deepEqual(dueReminders([item], at('2026-12-30T13:00:00+08:00'), sent), [])
})

test('不该提醒的：已完成、已提醒过、没有钟点、不是任务', () => {
  const now = at('2026-11-25T14:30:00+08:00')
  assert.deepEqual(dueReminders([task({ status: 'done' })], now), [])
  assert.deepEqual(dueReminders([task({ status: 'dropped' })], now), [])
  assert.deepEqual(dueReminders([task({ type: 'idea' })], now), [])
  assert.deepEqual(dueReminders([task({ at: { date: '2026-11-25', slot: '下午', clock: null } })], now), [])
  assert.deepEqual(dueReminders([task()], now, { 't_7eaaa0d0@2026-11-25 15:30': '2026-11-25T14:30:00+08:00' }), [])
  // 改了时间就是新的一条，会重新提醒。
  assert.equal(dueReminders([task()], now, { 't_7eaaa0d0@2026-11-25 15:00': '2026-11-25T14:00:00+08:00' }).length, 1)
})

test('多件事按时间先后排队', () => {
  const items = [
    task({ id: 'b', text: '第二场', at: { date: '2026-11-25', slot: '下午', clock: '16:10' } }),
    task({ id: 'a', text: '第一场', at: { date: '2026-11-25', slot: '下午', clock: '15:30' } }),
  ]
  const due = dueReminders(items, at('2026-11-25T15:10:00+08:00'))
  assert.deepEqual(due.map((entry) => entry.item.id), ['a', 'b'])
})

test('提醒文案：几点、什么事、还有多久，地点备注带上', () => {
  const now = at('2026-11-25T14:30:00+08:00')
  const text = reminderText({ item: task(), start: eventStart(task()) }, now)
  assert.equal(text, '⏰ 还有 1 小时：15:30 参加电话会议')

  const item = task({
    text: '参加科创联联合会', note: '12月30日 14:00–20:00；提前一天（12-29）提醒',
    place: '苏州工业园区世尊酒店苏园厅', at: { date: '2026-12-30', slot: '下午', clock: '14:00' },
  })
  const lines = reminderText({ item, start: eventStart(item) }, at('2026-12-29T14:00:00+08:00')).split('\n')
  assert.equal(lines[0], '⏰ 还有 1 天：12-30 14:00 参加科创联联合会')
  assert.equal(lines[1], '地点：苏州工业园区世尊酒店苏园厅')
  // 「提前一天（12-29）提醒」已经变成提醒时间了，不重复念。
  assert.equal(lines[2], '备注：12月30日 14:00–20:00')
  assert.equal(lines.length, 3)
})

test('时间差写法', () => {
  assert.equal(humanGap(60), '1 小时')
  assert.equal(humanGap(90), '1 小时 30 分钟')
  assert.equal(humanGap(45), '45 分钟')
  assert.equal(humanGap(1440), '1 天')
  assert.equal(humanGap(0.2), '1 分钟')
})

test('去重键随时间和 id 变', () => {
  assert.equal(reminderKey(task()), 't_7eaaa0d0@2026-11-25 15:30')
  assert.notEqual(reminderKey(task()), reminderKey(task({ at: { date: '2026-11-25', slot: '下午', clock: '16:00' } })))
})
