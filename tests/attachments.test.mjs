import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sweepAttachments } from '../plugins/reading-inbox/attachments.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'attachments-'))
  t.after(() => { /* 临时目录留给系统清理 */ })
  mkdirSync(join(dir, '2026-11'), { recursive: true })
  return dir
}

test('超过一小时的附件会被删掉，发票和刚存下来的保留', async t => {
  const dir = fixture(t)
  const folder = join(dir, '2026-11')
  const old = join(folder, 'old.jpg')
  const fresh = join(folder, 'fresh.jpg')
  const bill = join(folder, 'bill.pdf')
  for (const file of [old, fresh, bill]) writeFileSync(file, 'x')
  const now = Date.parse('2026-11-14T10:00:00+08:00')
  const stale = new Date(now - 2 * 3600 * 1000).toISOString()
  const recent = new Date(now - 10 * 60 * 1000).toISOString()
  writeFileSync(join(dir, 'index.jsonl'), [
    JSON.stringify({ at: stale, kind: 'image', name: 'old.jpg', path: old }),
    JSON.stringify({ at: recent, kind: 'image', name: 'fresh.jpg', path: fresh }),
    JSON.stringify({ at: stale, kind: 'file', name: 'bill.pdf', path: bill, invoice: { seller: '店', amount: '1.00', date: '2026年10月1日' } }),
    '{"broken":',
  ].join('\n') + '\n')

  const { removed } = await sweepAttachments(dir, { now })
  assert.equal(removed.length, 1)
  assert.equal(removed[0].name, 'old.jpg')
  assert.equal(existsSync(old), false, '过期图片应该被删掉')
  assert.equal(existsSync(fresh), true, '十分钟前的不该删')
  assert.equal(existsSync(bill), true, '发票要长期保留')
  const kept = readFileSync(join(dir, 'index.jsonl'), 'utf8').trim().split('\n')
  assert.equal(kept.length, 3, '保留两条记录加一行损坏行')
})

test('没有索引文件时安静返回', async t => {
  const dir = fixture(t)
  const result = await sweepAttachments(dir)
  assert.deepEqual(result.removed, [])
})
