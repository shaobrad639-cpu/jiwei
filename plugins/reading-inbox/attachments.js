/**
 * 附件过期清理：手机发来的图片、截图、随手文件只留一小时。
 *
 * 发票例外——报销要长期可查，带 invoice / invoiceError 的记录一直留着。
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export const DEFAULT_TTL_MS = 60 * 60 * 1000

/**
 * 删掉超过 ttlMs 的附件（文件和索引行），返回被删掉的记录。
 * 索引损坏的行原样保留，不因为一行读不出来就清空整份清单。
 */
export async function sweepAttachments(dir, { ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  const file = join(dir, 'index.jsonl')
  if (!existsSync(file)) return { removed: [] }
  const lines = (await readFile(file, 'utf8')).split('\n').filter((line) => line.trim())
  const cutoff = now - ttlMs
  const keep = []
  const removed = []
  for (const line of lines) {
    let record
    try {
      record = JSON.parse(line)
    } catch {
      keep.push(line)
      continue
    }
    const savedAt = Date.parse(record.at) || 0
    const permanent = Boolean(record.invoice || record.invoiceError)
    if (!permanent && savedAt && savedAt < cutoff) {
      if (record.path) await unlink(record.path).catch(() => {})
      removed.push(record)
    } else keep.push(line)
  }
  if (removed.length) {
    await writeFile(file, keep.length ? `${keep.join('\n')}\n` : '', 'utf8')
  }
  return { removed }
}
