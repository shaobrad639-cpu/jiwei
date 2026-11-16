import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, symlinkSync, readlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import { python } from './python.mjs'

const repo = resolve('.')
function run(exe, args, env) {
  const result = spawnSync(exe, args, { encoding: 'utf8', env: { ...process.env, ...env } })
  assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout)
  return result.stdout
}

test('installer: dry-run, quoted paths, Python config, idempotence and data preservation', t => {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-journal-test-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const profile = join(temp, 'profiles', 'desktop')
  const data = join(temp, "user's notes", 'data')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), '{}\n')
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
  const args = [join(repo, 'install.mjs'), '--data', data, '--python', python]
  run(process.execPath, [...args, '--dry-run'], { DSH_HOME: temp })
  assert.equal(existsSync(data), false)
  assert.equal(readFileSync(join(profile, 'package.json'), 'utf8'), '{}\n')
  run(process.execPath, args, { DSH_HOME: temp })
  const patch = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
  const pythonLines = patch.split('\n').filter(l => l.trim().startsWith('python:'))
  assert.equal(pythonLines.length, 2)
  for (const line of pythonLines) assert.equal(JSON.parse(line.split('python:')[1]), python.replace(/\\/g, '/'))
  assert.ok(patch.includes(JSON.stringify(data.replace(/\\/g, '/'))))
  assert.ok(patch.includes('enabled: true'))
  assert.ok(existsSync(join(data, 'journal_llm.py')))
  const ready = readFileSync(join(data, '..', 'schedules-ready.md'), 'utf8')
  assert.ok(ready.includes('reading_journal_review'))
  const notebook = join(data, 'notebook.md')
  writeFileSync(notebook, 'My own notes\n')
  run(process.execPath, args, { DSH_HOME: temp })
  assert.equal(readFileSync(notebook, 'utf8'), 'My own notes\n')
  assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), patch)
  const pkg = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
  assert.equal(pkg.dsh.profile.bundles.length, 2)
  assert.ok(!readFileSync(join(data, '..', 'schedules-ready.md'), 'utf8').includes('{{'))
  const journal = (...args) => JSON.parse(run(python, [join(data, 'journal.py'), ...args], { JOURNAL_DIR: data }))
  assert.deepEqual(journal('status').projects, [])
  journal('triage', '--text', '明天完成示例报告', '--at', '2026-10-30T12:00:00+08:00', '--ev', 'test-event')
  const first = journal('state')
  assert.ok(first.items.length > 0)
  journal('triage', '--text', '明天完成示例报告', '--at', '2026-10-30T12:00:00+08:00', '--ev', 'test-event')
  assert.equal(journal('state').items.length, first.items.length)
  assert.equal(readFileSync(notebook, 'utf8'), 'My own notes\n')
  const pluginLink = join(profile, 'node_modules', '@local', 'reading-inbox')
  unlinkSync(pluginLink)
  symlinkSync(join(temp, 'old-checkout'), pluginLink, process.platform === 'win32' ? 'junction' : 'dir')
  run(process.execPath, [...args, '--dry-run'], { DSH_HOME: temp })
  assert.equal(readlinkSync(pluginLink), join(temp, 'old-checkout'))
  run(process.execPath, [...args, '--llm-provider', 'configured', '--llm-model', 'selected'], { DSH_HOME: temp })
  assert.equal(readlinkSync(pluginLink), join(repo, 'plugins', 'reading-inbox'))
  assert.ok(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8').includes('model: "selected"'))
  run(process.execPath, [...args, '--no-llm'], { DSH_HOME: temp })
  assert.ok(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8').includes('enabled: false'))
})
