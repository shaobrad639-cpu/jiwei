// Obsidian 导出与公众号抓取的前置校验：改动这两处很容易悄悄破坏去重或安全边界。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import { python } from './python.mjs'

const EXPORT = resolve('plugins/reading-inbox/tools/export_obsidian.py')
const FETCH = resolve('plugins/reading-inbox/tools/fetch_article.py')

function run(script, args) {
  const result = spawnSync(python, [script, ...args], { encoding: 'utf8' })
  const line = String(result.stdout || '').trim().split(/\r?\n/).pop() || ''
  let payload = null
  try {
    payload = JSON.parse(line)
  } catch {
    payload = null
  }
  return { result, payload }
}

function item(overrides = {}) {
  return {
    id: 'it_test01',
    url: 'https://mp.weixin.qq.com/s/example',
    title: '测试文章',
    author: '测试公众号',
    publishTime: '2026-11-21T21:55:15+08:00',
    addedAt: '2026-11-22T07:23:10.889Z',
    body: '正文第一段。\n\n正文第二段。',
    bodyChars: 14,
    ...overrides,
  }
}

function workspace(t, items) {
  const dir = mkdtempSync(join(tmpdir(), 'obsidian-export-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const inbox = join(dir, 'inbox.json')
  writeFileSync(inbox, JSON.stringify({ version: 1, items, digests: [], reminders: [] }, null, 2))
  return { dir, inbox, vault: join(dir, 'vault') }
}

test('export writes one note per article and is idempotent', (t) => {
  const { inbox, vault } = workspace(t, [item()])
  const first = run(EXPORT, ['--inbox', inbox, '--vault', vault])
  assert.equal(first.payload.ok, true)
  assert.equal(first.payload.written.length, 1)

  const folder = join(vault, 'Weixin_Article_Analysis')
  const files = readdirSync(folder).filter((name) => name.endsWith('.md'))
  assert.deepEqual(files, ['2026-11-21_测试文章.md'])

  const note = readFileSync(join(folder, files[0]), 'utf8')
  assert.match(note, /^---\n/)
  assert.match(note, /title: 测试文章/)
  assert.match(note, /source: https:\/\/mp\.weixin\.qq\.com\/s\/example/)
  assert.match(note, /author: 测试公众号/)
  assert.match(note, /正文第一段/)

  const second = run(EXPORT, ['--inbox', inbox, '--vault', vault])
  assert.equal(second.payload.written.length, 0)
  assert.equal(second.payload.skipped.length, 1)
})

test('a retitled article replaces its old note instead of duplicating it', (t) => {
  const { inbox, vault } = workspace(t, [item()])
  run(EXPORT, ['--inbox', inbox, '--vault', vault])

  writeFileSync(inbox, JSON.stringify({ version: 1, items: [item({ title: '改名后的标题' })], digests: [], reminders: [] }, null, 2))
  const second = run(EXPORT, ['--inbox', inbox, '--vault', vault])
  assert.equal(second.payload.written.length, 1)
  assert.equal(second.payload.removed.length, 1)

  const files = readdirSync(join(vault, 'Weixin_Article_Analysis')).filter((name) => name.endsWith('.md'))
  assert.deepEqual(files, ['2026-11-21_改名后的标题.md'])
})

test('items without a body are skipped so no empty note is created', (t) => {
  const { inbox, vault } = workspace(t, [item({ body: '' })])
  const result = run(EXPORT, ['--inbox', inbox, '--vault', vault])
  assert.equal(result.payload.ok, true)
  assert.equal(result.payload.written.length, 0)
  assert.equal(existsSync(join(vault, 'Weixin_Article_Analysis')), false)
})

test('only one item is written when --item is given', (t) => {
  const { inbox, vault } = workspace(t, [item(), item({ id: 'it_test02', title: '第二篇' })])
  const result = run(EXPORT, ['--inbox', inbox, '--vault', vault, '--item', 'it_test02'])
  assert.equal(result.payload.written.length, 1)
  const files = readdirSync(join(vault, 'Weixin_Article_Analysis')).filter((name) => name.endsWith('.md'))
  assert.deepEqual(files, ['2026-11-21_第二篇.md'])
})

test('dry run reports work without touching the vault', (t) => {
  const { inbox, vault } = workspace(t, [item()])
  const result = run(EXPORT, ['--inbox', inbox, '--vault', vault, '--dry-run'])
  assert.equal(result.payload.written.length, 1)
  assert.equal(existsSync(join(vault, 'Weixin_Article_Analysis')), false)
})

test('a missing inbox is reported, not thrown', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'obsidian-missing-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const result = run(EXPORT, ['--inbox', join(dir, 'nope.json'), '--vault', join(dir, 'vault')])
  assert.equal(result.payload.ok, false)
  assert.match(result.payload.error, /找不到收件箱/)
})

// 代理 fake-IP 段必须放行，否则走代理时所有公众号链接都抓不到。
test('fetcher treats the RFC 2544 fake-IP range as public, not LAN', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-ip-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const script = join(dir, 'probe.py')
  writeFileSync(script, [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(resolve('plugins/reading-inbox/tools'))})`,
    'import fetch_article as f',
    'import ipaddress',
    'print(f._is_fake_ip(ipaddress.ip_address("198.18.0.85")))',
    'print(f._is_fake_ip(ipaddress.ip_address("198.19.255.255")))',
    'print(f._is_fake_ip(ipaddress.ip_address("198.20.0.1")))',
    'print(f._is_fake_ip(ipaddress.ip_address("10.0.0.1")))',
    'print(f._is_lan(ipaddress.ip_address("198.18.0.85")))',
    // getaddrinfo 走代理时会回这种映射形式；按 IPv4 判，否则整段被当成内网拒绝。
    'print(f._is_fake_ip(ipaddress.ip_address("::ffff:0:c612:72")))',
    'print(f._is_fake_ip(ipaddress.ip_address("::ffff:198.18.0.114")))',
    'print(f._is_fake_ip(ipaddress.ip_address("::ffff:10.0.0.1")))',
    'print(f._is_fake_ip(ipaddress.ip_address("2408:8207:1234::1")))',
  ].join('\n'))
  const result = spawnSync(python, [script], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const lines = result.stdout.trim().split(/\r?\n/)
  assert.deepEqual(lines, ['True', 'True', 'False', 'False', 'True', 'True', 'True', 'False', 'False'])
})

test('fetcher still refuses literal private and loopback hosts', () => {
  for (const url of ['http://127.0.0.1:9/x', 'http://10.1.2.3/x', 'http://localhost:8080/x']) {
    const { payload } = run(FETCH, [url])
    assert.match(payload.error, /内网|回环/, `应拒绝 ${url}`)
    assert.equal(payload.body, '')
  }
})
