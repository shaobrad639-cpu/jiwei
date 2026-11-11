/**
 * 账本 (Journal) — Host half.
 *
 * 只做三件事：把 journal 目录的现状读成 JSON 交给面板；把面板上的动作
 * 转成 journal.py 的命令行调用；把 notebook.md 原样交出去/收回来。
 *
 * 业务判断一行都不写在这里——全部留在 journal.py 和 RULES.md，
 * 免得面板和定时任务跑出两套语义。
 */
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export const inject = ['webServer']

// 数据目录不写死：优先 cordis.patch.yml 的 config，其次环境变量。
// 装好之后由 install 脚本写入 config，所以这里留空是正常的。
const ENV_DIR = process.env.JOURNAL_DIR || process.env.DSH_JOURNAL_DIR || ''
const ENV_READING = process.env.READING_INBOX_DIR || process.env.DSH_READING_INBOX_DIR || ''

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1_000_000) {
        reject(new Error('内容过长，未保存'))
        raw = ''
      }
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(new Error('请求内容无效，未保存'))
      }
    })
    req.on('error', reject)
  })
}

function str(value, max = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export function apply(ctx, config = {}) {
  const dataDir = typeof config.dataDir === 'string' && config.dataDir.trim() ? config.dataDir.trim() : ENV_DIR
  const readingDir =
    typeof config.readingInbox === 'string' && config.readingInbox.trim() ? config.readingInbox.trim() : ENV_READING
  if (!dataDir) {
    process.stderr.write(
      '[journal-panel] 未配置账本目录，面板未启用。\n' +
        '  请在 profile 的 cordis.patch.yml 里给 journal-panel 填 config.dataDir，\n' +
        '  或设置环境变量 JOURNAL_DIR 后重启。\n',
    )
    return
  }
  const python = typeof config.python === 'string' && config.python.trim() ? config.python.trim() : 'python'
  const script = join(dataDir, 'journal.py')
  const log = (message) => process.stderr.write(`[journal-panel] ${message}\n`)

  async function run(args) {
    try {
      const { stdout } = await exec(python, [script, ...args], {
        cwd: dataDir,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
      })
      return stdout
    } catch (error) {
      throw new Error(error.stderr?.trim().split(/\r?\n/).pop() || '账本操作失败，请重试')
    }
  }

  async function readJson(path) {
    try {
      return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))
    } catch {
      return null
    }
  }

  async function readingCount() {
    const data = await readJson(join(readingDir, 'inbox.json'))
    if (!data || !Array.isArray(data.items)) return { inbox: 0, later: 0 }
    let inbox = 0
    let later = 0
    for (const item of data.items) {
      if (item.status === 'inbox') inbox += 1
      else if (item.status === 'later') later += 1
    }
    return { inbox, later }
  }

  /**
   * 面板不自己解析任何东西：state / recent / search 都由 journal.py 产。
   * 这样「文件是正式记录」才立得住——面板只是个渲染器，读到的永远是磁盘上的现状
   * （包括你在编辑器里直接改过的项目 md）。
   */
  async function snapshot() {
    let notebook = ''
    try {
      notebook = await readFile(join(dataDir, 'notebook.md'), 'utf8')
    } catch {
      notebook = ''
    }
    const raw = await run(['state'])
    const state = JSON.parse(raw)
    return { ...state, notebook: state.notebook_view?.text ?? notebook, dataDir }
  }

  async function handleAction(body) {
    const action = str(body.action, 40)
    switch (action) {
      case 'project.add': {
        const name = str(body.name, 60)
        if (!name) throw new Error('项目名不能为空')
        return JSON.parse(await run(['project', 'add', '--name', name]))
      }
      case 'project.remove': {
        const id = str(body.id, 40)
        if (!id) throw new Error('缺少项目 id')
        return JSON.parse(await run(['project', 'remove', '--id', id]))
      }
      case 'project.set': {
        const id = str(body.id, 40)
        if (!id) throw new Error('缺少项目 id')
        const args = ['project', 'set', '--id', id]
        for (const field of ['goal', 'state', 'next', 'open']) {
          if (typeof body[field] === 'string') args.push(`--${field}`, body[field])
        }
        if (str(body.name, 60)) args.push('--name', str(body.name, 60))
        return JSON.parse(await run(args))
      }
      case 'item.add': {
        const type = str(body.type, 10) || 'task'
        const text = str(body.text, 500)
        if (!text) throw new Error('内容不能为空')
        const args = ['add', '--type', type, '--text', text, '--src', 'manual']
        if (str(body.project, 40)) args.push('--project', str(body.project, 40))
        if (str(body.due, 40)) args.push('--due', str(body.due, 40))
        if (str(body.at, 80)) args.push('--at', str(body.at, 80))
        return JSON.parse(await run(args))
      }
      case 'item.set': {
        const id = str(body.id, 40)
        if (!id) throw new Error('缺少条目 id')
        const args = ['set', '--id', id]
        if (typeof body.type === 'string') args.push(`--type=${body.type}`)
        if (typeof body.revision === 'string') args.push(`--expected-revision=${body.revision}`)
        if (str(body.status, 20)) args.push(`--status=${str(body.status, 20)}`)
        if (typeof body.text === 'string') {
          if (!body.text.trim()) throw new Error('正文不能为空')
          if (body.text.length > 20000) throw new Error('正文超过 20000 字，请缩短后保存')
          args.push(`--text=${body.text}`)
        }
        if (typeof body.due === 'string') args.push(`--due=${body.due.trim()}`)
        if (typeof body.at === 'string') args.push(`--at=${body.at.trim()}`)
        else if (Object.hasOwn(body, 'at')) args.push(`--at-json=${JSON.stringify(body.at)}`)
        if (typeof body.place === 'string') args.push(`--place=${body.place}`)
        if (typeof body.project === 'string') args.push(`--project=${body.project}`)
        return JSON.parse(await run(args))
      }
      case 'idea.promote': {
        const id = str(body.id, 40)
        if (!id) throw new Error('缺少想法 id')
        return JSON.parse(await run(['promote', '--id', id]))
      }
      case 'sources.scan': {
        await run(['sources', 'scan'])
        return true
      }
      case 'sources.unbind':
      case 'sources.bind': {
        if (!str(body.id,40) || !str(body.root,1000)) throw new Error('请选择项目和来源目录')
        await run(['sources',action === 'sources.unbind' ? 'unbind' : 'bind','--id',str(body.id,40),'--root',str(body.root,1000)])
        return true
      }
      case 'evidence.undo':
      case 'evidence.decide': {
        const temp = join(dataDir, `.evidence-${randomUUID()}.json`)
        try {
          await writeFile(temp, JSON.stringify({ id: body.id, decision: action==='evidence.undo'?'undo':body.decision, revision:body.revision, projects: body.projects,
            summary: body.summary, quote: body.quote }), 'utf8')
          return JSON.parse(await run(['evidence','--file',temp]))
        } finally { await unlink(temp).catch(() => {}) }
        return true
      }
      case 'notebook.day.save': {
        if (typeof body.text !== 'string' || typeof body.key !== 'string' || typeof body.revision !== 'string') throw new Error('缺少日期、正文或版本，未保存')
        const temp = join(dataDir, `.notebook-request-${randomUUID()}.json`)
        await mkdir(dataDir, { recursive: true })
        try {
          await writeFile(temp, JSON.stringify({ key: body.key, text: body.text, revision: body.revision, base: body.base, existed: body.existed }), 'utf8')
          await run(['notebook-day', '--file', temp])
        } finally { await unlink(temp).catch(() => {}) }
        return true
      }
      case 'notebook.save': {
        if (typeof body.text !== 'string') throw new Error('缺少本子内容，未保存')
        const text = body.text
        await mkdir(dataDir, { recursive: true })
        const temp = join(dataDir, `.notebook-${randomUUID()}.tmp`)
        try {
          await writeFile(temp, text, 'utf8')
          await rename(temp, join(dataDir, 'notebook.md'))
        } finally {
          await unlink(temp).catch(() => {})
        }
        return true
      }
      default:
        throw new Error(`未知动作：${action}`)
    }
  }

  // Keep actions (including notebook saves) in request order within this host.
  let actionQueue = Promise.resolve()
  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const path = url.pathname
    try {
      if (req.method === 'GET' && path === '/journal/api/state') {
        return sendJson(res, 200, await snapshot())
      }
      if (req.method === 'GET' && path === '/journal/api/sources/browse') {
        return sendJson(res, 200, JSON.parse(await run(['sources','browse','--root',url.searchParams.get('root') || ''])))
      }
      if (req.method === 'GET' && path === '/journal/api/item') {
        const id = url.searchParams.get('id')
        if (!id) throw new Error('缺少条目 id')
        return sendJson(res, 200, JSON.parse(await run(['detail', `--id=${id}`])))
      }
      if (req.method === 'GET' && path === '/journal/api/reading') {
        const data = await readJson(join(readingDir, 'inbox.json'))
        const items = (data && Array.isArray(data.items) ? data.items : [])
          .filter((item) => item.status === 'inbox' || item.status === 'later')
          .sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')))
          .slice(0, 6)
          .map((item) => ({ id: item.id, title: item.title || item.url, url: item.url,
            status: item.status, hasBody: Boolean(item.body) }))
        return sendJson(res, 200, { items })
      }
      if (req.method === 'GET' && path === '/journal/api/heat') {
        const days = Math.max(7, Math.min(370, Number(url.searchParams.get('days')) || 84))
        const raw = await run(['heat', '--days', String(days)])
        return sendJson(res, 200, JSON.parse(raw))
      }
      if (req.method === 'GET' && path === '/journal/api/recent') {
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 40))
        return sendJson(res, 200, JSON.parse(await run(['recent', '--limit', String(limit)])))
      }
      if (req.method === 'GET' && path === '/journal/api/search') {
        const q = url.searchParams.get('q') || ''
        return sendJson(res, 200, JSON.parse(await run(['search', '--q', q, '--limit', '40'])))
      }
      if (req.method === 'POST' && path === '/journal/api/action') {
        const body = await readBody(req)
        const operation = actionQueue.then(() => handleAction(body))
        actionQueue = operation.catch(() => {})
        const result = await operation
        return sendJson(res, 200, typeof result==='object' ? result : { ok: true })
      }
      return sendJson(res, 404, { error: 'not found' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`动作失败：${message}`)
      return sendJson(res, 400, { error: message })
    }
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/journal',
      handler: (req, res) => void handle(req, res),
    }),
  )
}
