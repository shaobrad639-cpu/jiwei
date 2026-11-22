/** 收件箱的唯一读写入口：串行化 read-modify-write，写盘走临时文件替换。 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export class InboxStore {
  constructor(dir) {
    this.dir = dir
    this.file = join(dir, 'inbox.json')
    this.data = { version: 1, items: [], digests: [], reminders: [] }
    this.loaded = false
    this.queue = Promise.resolve()
  }

  async load() {
    if (this.loaded) return
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
    this.loaded = true
  }

  async persist() {
    await mkdir(this.dir, { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    await writeFile(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8')
    await rename(tmp, this.file)
  }

  /** Serialized read-modify-write; returns the callback's value. */
  async mutate(fn) {
    const run = this.queue.then(async () => {
      await this.load()
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
    return fn(this.data)
  }
}
