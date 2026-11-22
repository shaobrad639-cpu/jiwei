/** 抓取与 Python 桥接：页面元数据、公众号正文、Obsidian 导出。
 *
 * 网络和子进程都在这里，解析规则在 util.js，装配在 index.js。
 */
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { cleanTitle, decodeEntities } from './util.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/** arXiv id from /abs/, /pdf/ or /html/ URLs. */
export function arxivId(url) {
  try {
    const parsed = new URL(url)
    if (!/(^|\.)arxiv\.org$/u.test(parsed.hostname)) return ''
    const match = /^\/(?:abs|pdf|html|format)\/([a-z-]+\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/iu.exec(parsed.pathname)
    return match ? match[1] : ''
  } catch {
    return ''
  }
}

export function pickXml(xml, tag) {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'iu').exec(xml)
  return match ? decodeEntities(match[1].replace(/<[^>]+>/gu, ' ')).replace(/\s+/gu, ' ').trim() : ''
}

/** arXiv's export API answers for abs, pdf and html links alike. */
export async function arxivMeta(url) {
  const id = arxivId(url)
  if (!id) return null
  try {
    const res = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(15000),
      headers: { accept: 'application/atom+xml' },
    })
    if (!res.ok) return null
    const xml = await res.text()
    const entry = /<entry>([\s\S]*?)<\/entry>/u.exec(xml)
    if (!entry) return null
    const title = pickXml(entry[1], 'title')
    if (!title) return null
    return { title: cleanTitle(title), description: cleanTitle(pickXml(entry[1], 'summary')).slice(0, 500) }
  } catch {
    return null
  }
}

const pythonResolvers = new Map()

/** 最近一次抓取失败的原因，供调用方原样报给用户。 */
export const fetchState = { metaError: '', bodyError: '' }
// Enough text for a digest to summarise; keeps the store small.
export const BODY_LIMIT = 12000

/** Find a working Python interpreter once, preferring an explicit override. */
export function resolvePython(override = '') {
  if (pythonResolvers.has(override)) return pythonResolvers.get(override)
  const candidates = override ? [override] : [
    process.env.DSH_PYTHON,
    'python',
    'python3',
    'py',
    join(homedir(), 'Miniconda3', 'python.exe'),
    join(homedir(), 'anaconda3', 'python.exe'),
    'C:\\Python313\\python.exe',
    'C:\\Python312\\python.exe',
  ].filter(Boolean)
  const pythonResolver = new Promise((resolve) => {
    const attempt = (index) => {
      if (index >= candidates.length) return resolve(null)
      execFile(candidates[index], ['-c', 'print(1)'], { timeout: 10000, windowsHide: true }, (error) => {
        if (error) attempt(index + 1)
        else resolve(candidates[index])
      })
    }
    attempt(0)
  })
  pythonResolvers.set(override, pythonResolver)
  return pythonResolver
}

/**
 * Fallback metadata fetch through the Python helper.
 *
 * Some sites (Xiaohongshu, notably) answer Node's TLS fingerprint with a
 * login redirect but serve a normal page to Python's OpenSSL client.
 */
export async function pythonMeta(url, pythonOverride = '') {
  const python = await resolvePython(pythonOverride)
  if (!python) {
    fetchState.metaError = 'no python interpreter'
    return null
  }
  return new Promise((resolve) => {
    execFile(
      python,
      [join(HERE, 'tools', 'fetch_meta.py'), url],
      { timeout: 30000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          fetchState.metaError = `${error.message} ${String(stderr || '').slice(0, 200)}`
          return resolve(null)
        }
        const line = String(stdout).trim().split(/\r?\n/).pop() || ''
        try {
          const data = JSON.parse(line)
          if (!data || (!data.title && !data.description)) return resolve(null)
          resolve({
            title: cleanTitle(data.title || ''),
            description: cleanTitle(data.description || '').slice(0, 500),
          })
        } catch {
          fetchState.metaError = `bad json: ${line.slice(0, 120)}`
          resolve(null)
        }
      },
    )
  })
}

/**
 * Full article text through the Python helper.
 *
 * Metadata alone made the weekly digest guess from headlines; this is the body
 * it actually needs. WeChat official-account articles are extracted from
 * #js_content, and a captcha wall is reported instead of stored as empty text.
 */
export async function pythonArticle(url, pythonOverride = '') {
  const python = await resolvePython(pythonOverride)
  if (!python) {
    fetchState.bodyError = 'no python interpreter'
    return null
  }
  return new Promise((resolve) => {
    execFile(
      python,
      [join(HERE, 'tools', 'fetch_article.py'), url],
      { timeout: 45000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const line = String(stdout || '').trim().split(/\r?\n/).pop() || ''
        let data = null
        try {
          data = JSON.parse(line)
        } catch {
          data = null
        }
        if (!data) {
          fetchState.bodyError = `${error ? error.message : 'no output'} ${String(stderr || '').slice(0, 200)}`
          return resolve(null)
        }
        if (data.error || !data.body) {
          fetchState.bodyError = String(data.error || 'empty body').slice(0, 200)
          return resolve(null)
        }
        resolve({
          title: cleanTitle(data.title || ''),
          description: cleanTitle(data.description || ''),
          body: String(data.body),
          chars: Number(data.chars) || String(data.body).length,
          author: cleanTitle(data.author || ''),
          publishedAt: typeof data.publishedAt === 'string' ? data.publishedAt : '',
        })
      },
    )
  })
}

/**
 * Mirror one captured article into the Obsidian vault.
 *
 * Runs after the body lands in the inbox so a note never appears with an
 * empty body. Failures are logged and reported on the item, never thrown:
 * a missing vault must not break link capture.
 */
export function pythonObsidian(python, { inbox, vault, folder, itemId }) {
  return new Promise((resolve) => {
    const args = [
      join(HERE, 'tools', 'export_obsidian.py'),
      '--inbox', inbox,
      '--vault', vault,
      '--folder', folder,
    ]
    if (itemId) args.push('--item', itemId)
    execFile(
      python,
      args,
      { timeout: 30000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const line = String(stdout || '').trim().split(/\r?\n/).pop() || ''
        let data = null
        try {
          data = JSON.parse(line)
        } catch {
          data = null
        }
        if (!data) {
          resolve({ ok: false, error: `${error ? error.message : 'no output'} ${String(stderr || '').slice(0, 200)}`.trim() })
          return
        }
        resolve(data)
      },
    )
  })
}

/** Best-effort page metadata for a captured link. */
export async function fetchMeta(url) {
  const arxiv = await arxivMeta(url)
  if (arxiv) return arxiv
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(18000),
    })
    if (!res.ok) return { title: '', description: '' }
    const type = res.headers.get('content-type') || ''
    if (!type.includes('html')) return { title: '', description: '' }
    const html = (await res.text()).slice(0, 3000000)
    const og = /<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)["']/iu.exec(html)
    const raw = og ? og[1] : ((/<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html) || [])[1] || '')
    const desc = /<meta[^>]+(?:property|name)=["'](?:og:)?description["'][^>]+content=["']([^"']+)["']/iu.exec(html)
    return {
      title: cleanTitle(raw),
      description: cleanTitle(desc ? desc[1] : '').slice(0, 500),
    }
  } catch {
    return { title: '', description: '' }
  }
}
