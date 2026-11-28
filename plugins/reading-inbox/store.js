/** 收件箱的唯一读写入口：串行化 read-modify-write，写盘走临时文件替换。 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export class InboxStore {
  constructor(dir) {
    this.dir = dir
    this.file = join(dir, 'inbox.json')
    this.data = { version: 1, items: [], digests: [], reminders: [] }
    this.loaded = false
    this.queue = Promise.resolve()
    // 上次读/写这份文件时的 mtime。插件重载会留下旧实例，它的内存快照可能
    // 早于别人的写入；直接落盘会把新条目和新标题冲掉（曾经丢过一整条收藏）。
    this.stamp = null
  }

  async currentStamp() {
    try {
      return (await stat(this.file)).mtimeMs
    } catch (error) {
      if (error && error.code === 'ENOENT') return null
      throw error
    }
  }

  async load() {
    if (this.loaded) return
    const stamp = await this.currentStamp()
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && Array.isArray(parsed.items)) {
        this.data = {
          version: 1,
          items: parsed.items,
          digests: Array.isArray(parsed.digests) ? parsed.digests : [],
          reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [],
        }
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error
    }
    this.stamp = stamp
    this.loaded = true
  }

  /** 文件被别人改过就丢掉内存里的副本，重新读一遍再改。 */
  async refreshIfStale() {
    if (!this.loaded) return
    const stamp = await this.currentStamp()
    if (stamp === this.stamp) return
    this.loaded = false
    await this.load()
  }

  async persist() {
    await mkdir(this.dir, { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8')
    await rename(tmp, this.file)
    this.stamp = await this.currentStamp()
  }

  /** Serialized read-modify-write; returns the callback's value. */
  async mutate(fn) {
    const run = this.queue.then(async () => {
      await this.load()
      await this.refreshIfStale()
      const result = await fn(this.data)
      await this.persist()
      return result
    })
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async read(fn) {
    await this.load()
    await this.refreshIfStale()
    return fn(this.data)
  }
}
