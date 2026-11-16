import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname, parse } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { runInNewContext } from 'node:vm'
import { apply } from '../plugins/journal-panel/index.js'
import { python } from './python.mjs'

test('project directory picker navigates outside workspace and binds another directory through the panel API', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'journal-directories-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const data = join(temp, 'data')
  const workspace = join(temp, 'workspace')
  const other = join(temp, 'other projects', '项目 A')
  for (const dir of [data, workspace, other]) mkdirSync(dir, { recursive: true })
  mkdirSync(join(other, '实验记录'))
  mkdirSync(join(other, '.hidden'))
  writeFileSync(join(other, 'notes.txt'), '原有项目文件')
  symlinkSync(workspace, join(other, 'linked-directory'), process.platform === 'win32' ? 'junction' : 'dir')
  for (const file of readdirSync('journal').filter(f => f.endsWith('.py'))) copyFileSync(join('journal', file), join(data, file))
  const init = spawnSync(python, [join(data, 'journal.py'), 'init'], { encoding: 'utf8', env: { ...process.env, JOURNAL_DIR: data } })
  assert.equal(init.status, 0, init.stderr)
  let handle
  apply({ effect: fn => fn(), webServer: { register(route) { handle = route.handler; return () => {} } } }, { dataDir: data, python })
  const request = (path, body) => new Promise((resolve, reject) => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : [])
    req.method = body ? 'POST' : 'GET'
    req.url = '/journal/api/' + path
    let status
    handle(req, { writeHead(code) { status = code }, end(raw) {
      try { resolve({ status, data: JSON.parse(raw) }) } catch (error) { reject(error) }
    } })
  })
  const browse = async root => {
    const result = await request('sources/browse' + (root === undefined ? '' : '?root=' + encodeURIComponent(root)))
    assert.equal(result.status, 200, JSON.stringify(result.data))
    return result.data
  }
  const initial = await browse()
  assert.equal(initial.root, realpathSync(homedir()))
  assert.equal(initial.parent, dirname(initial.root))
  assert.ok(initial.shortcuts.some(s => s.name === '用户目录'))
  assert.equal((await browse('~')).root, initial.root)
  writeFileSync(join(data, 'sources.json'), JSON.stringify({ workspace, projects: [] }))
  const config = readFileSync(join(data, 'sources.json'), 'utf8')
  const start = await browse()
  assert.equal(start.root, realpathSync(workspace))
  assert.equal(start.parent, realpathSync(temp))
  assert.ok(start.shortcuts.some(s => s.name === '工作区' && s.root === start.root))
  const parent = await browse(start.parent)
  assert.ok(parent.children.some(c => c.name === 'other projects'))
  const destination = await browse(other)
  assert.equal(destination.root, realpathSync(other))
  assert.deepEqual(destination.children.map(c => c.name), ['实验记录'])
  assert.equal(readFileSync(join(data, 'sources.json'), 'utf8'), config)
  const root = await browse(parse(realpathSync(temp)).root)
  assert.equal(root.parent, null)
  const invalid = await request('sources/browse?root=' + encodeURIComponent(join(other, 'missing')))
  assert.equal(invalid.status, 400)
  assert.match(invalid.data.error, /目录不存在或不可访问/)
  assert.equal((await browse(other)).root, destination.root)
  const project = await request('action', { action: 'project.add', name: '新项目' })
  assert.equal(project.status, 200)
  const bound = await request('action', { action: 'sources.bind', id: project.data.id, root: destination.root })
  assert.equal(bound.status, 200, JSON.stringify(bound.data))
  const sources = JSON.parse(readFileSync(join(data, 'sources.json'), 'utf8'))
  assert.equal(sources.workspace, workspace)
  assert.deepEqual(sources.projects, [{ id: project.data.id, root: destination.root }])
  assert.equal(readFileSync(join(other, 'notes.txt'), 'utf8'), '原有项目文件')
})

test('directory picker supports typed paths, parent navigation and recovery after a failed browse', async () => {
  const hooks = []
  let cursor = 0
  let component
  const requests = []
  const actions = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(c => c != null && c !== false) }),
    useState(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = initial
      return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value }]
    },
  }
  const source = readFileSync('plugins/journal-panel/client.js', 'utf8')
    .replace("      inject: ['slots'],", "      SourceBinding, inject: ['slots'],")
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(module) { component = module.factory(() => React).SourceBinding } } },
    fetch: async url => {
      const root = new URL(url, 'http://localhost').searchParams.get('root') || '/home/user'
      requests.push(root)
      return { ok: root !== '/missing', status: root === '/missing' ? 400 : 200, json: async () => root === '/missing'
        ? { error: '目录不存在' } : { root, parent: '/home', shortcuts: [{ name: '用户目录', root: '/home/user' }], children: [] } }
    },
  })
  assert.equal(typeof component, 'function')
  const render = () => { cursor = 0; return component({ project: { id: 'p1' }, state: { file_sources: [] },
    onAction: async (action, payload) => { actions.push({ action, ...payload }); return true } }) }
  const nodes = tree => [tree, ...tree.children.filter(c => typeof c === 'object').flatMap(nodes)]
  const button = (tree, label) => nodes(tree).find(n => n.type === 'button' && n.children.includes(label))
  let tree = render()
  await button(tree, '浏览添加目录').props.onClick()
  tree = render()
  await button(tree, '上一级').props.onClick()
  assert.equal(requests.at(-1), '/home')
  tree = render()
  nodes(tree).find(n => n.type === 'input').props.onChange({ target: { value: '/other projects/项目 A' } })
  tree = render()
  await nodes(tree).find(n => n.type === 'form').props.onSubmit({ preventDefault() {} })
  // Submit schedules an async browse; allow the response to update component state.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(requests.at(-1), '/other projects/项目 A')
  tree = render()
  await button(tree, '添加当前目录').props.onClick()
  assert.deepEqual(actions, [{ action: 'sources.bind', id: 'p1', root: '/other projects/项目 A' }])
  nodes(tree).find(n => n.type === 'input').props.onChange({ target: { value: '/missing' } })
  tree = render()
  nodes(tree).find(n => n.type === 'form').props.onSubmit({ preventDefault() {} })
  await new Promise(resolve => setImmediate(resolve))
  tree = render()
  assert.equal(nodes(tree).find(n => n.props.role === 'alert').children[0], '目录不存在')
  assert.equal(nodes(tree).find(n => n.type === 'input').props.value, '/missing')
  assert.equal(button(tree, '添加当前目录'), undefined)
  nodes(tree).find(n => n.type === 'input').props.onChange({ target: { value: '/valid' } })
  tree = render()
  nodes(tree).find(n => n.type === 'form').props.onSubmit({ preventDefault() {} })
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(button(render(), '添加当前目录'))
})
