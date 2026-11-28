// 收件箱落盘的安全性：插件热重载会留下旧实例，两个实例共用一份 inbox.json。
// 旧实例的内存快照如果直接覆盖，新条目和新标题就会被悄悄冲掉（真丢过一整条收藏）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { InboxStore } from '../plugins/reading-inbox/store.js'

test('a stale instance cannot erase items another instance added', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const old = new InboxStore(dir)
  await old.mutate((data) => { data.items.push({ id: 'it_old', title: '旧条目' }) })

  // 新实例（模拟热重载后的那个）先读到「旧条目」，再加一条。
  const fresh = new InboxStore(dir)
  await fresh.mutate((data) => { data.items.push({ id: 'it_new', title: '新条目' }) })

  // 旧实例此刻才落盘：它的内存里没有 it_new，但它必须先重读磁盘。
  await old.mutate((data) => { data.items.find((item) => item.id === 'it_old').title = '旧条目（改过）' })

  const seen = await fresh.read((data) => data.items.map((item) => item.id).sort())
  assert.deepEqual(seen, ['it_new', 'it_old'], '后写入的实例不能把别人的条目冲掉')
  const title = await fresh.read((data) => data.items.find((item) => item.id === 'it_old').title)
  assert.equal(title, '旧条目（改过）', '旧实例自己的修改要落到最新数据上')
})

test('a stale instance does not revert a title another instance fixed', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const old = new InboxStore(dir)
  await old.mutate((data) => { data.items.push({ id: 'it_a', title: '(微信文章)' }) })

  const fresh = new InboxStore(dir)
  await fresh.mutate((data) => {
    const item = data.items.find((entry) => entry.id === 'it_a')
    item.title = '真实标题'
    item.titleResolved = true
  })

  // 旧实例还在拿「(微信文章)」的印象做一次无关的写入。
  await old.mutate((data) => { data.items.find((entry) => entry.id === 'it_a').note = '备注' })

  const item = await fresh.read((data) => data.items.find((entry) => entry.id === 'it_a'))
  assert.equal(item.title, '真实标题', '标题不能被旧快照写回占位名')
  assert.equal(item.note, '备注')
})
