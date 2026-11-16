import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { apply } from '../plugins/journal-panel/index.js'
import { python } from './python.mjs'

function listen(config) {
  let handle
  apply({ effect: fn => fn(), webServer: { register(route) { handle = route.handler; return () => {} } } }, config)
  return (path, body) => new Promise((resolve, reject) => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
    req.method = body ? 'POST' : 'GET'
    req.url = '/journal/api/' + path
    let status
    handle(req, {
      writeHead(code) { status = code },
      end(raw) {
        try { resolve({ status, data: JSON.parse(raw) }) } catch (error) { reject(error) }
      },
    })
  })
}

function journalDir(t) {
  const temp = mkdtempSync(join(tmpdir(), 'journal-panel-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const data = join(temp, 'data')
  mkdirSync(data, { recursive: true })
  for (const file of readdirSync('journal').filter(f => f.endsWith('.py'))) copyFileSync(join('journal', file), join(data, file))
  const init = spawnSync(python, [join(data, 'journal.py'), 'init'], { encoding: 'utf8', env: { ...process.env, JOURNAL_DIR: data } })
  assert.equal(init.status, 0, init.stderr)
  return data
}

test('without a data directory the panel answers with an actionable error instead of 404', async (t) => {
  const previous = process.env.JOURNAL_DIR
  const previousDsh = process.env.DSH_JOURNAL_DIR
  delete process.env.JOURNAL_DIR
  delete process.env.DSH_JOURNAL_DIR
  t.after(() => {
    if (previous !== undefined) process.env.JOURNAL_DIR = previous
    if (previousDsh !== undefined) process.env.DSH_JOURNAL_DIR = previousDsh
  })
  const request = listen({})
  const state = await request('state')
  assert.equal(state.status, 400)
  assert.match(state.data.error, /cordis\.patch\.yml/)
  assert.match(state.data.error, /config\.dataDir/)
})

test('a configured interpreter that does not exist falls back to python3 and the panel still works', async (t) => {
  const data = journalDir(t)
  const request = listen({ dataDir: data, python: 'journal-panel-no-such-python' })
  const state = await request('state')
  assert.equal(state.status, 200, JSON.stringify(state.data))
  assert.ok(Array.isArray(state.data.projects))
  assert.ok(Array.isArray(state.data.items))
  assert.ok(state.data.stats)
})
