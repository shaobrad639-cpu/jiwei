// 测试共用的 Python 解释器解析：优先 DSH_PYTHON，其次 python3，再退 python。
// 一个都没有时直接抛错，让 node --test 报出明确原因，而不是每个测试各挂一次 ENOENT。
import { spawnSync } from 'node:child_process'

function probe(command) {
  const result = spawnSync(command, ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' })
  if (result.error || result.status !== 0) return null
  return { command, version: result.stdout.trim() }
}

function resolvePython() {
  const explicit = process.env.DSH_PYTHON
  if (explicit) {
    const found = probe(explicit)
    if (!found) throw new Error(`DSH_PYTHON 指向的 Python 不可用：${explicit}`)
    return found
  }
  const tried = []
  for (const name of ['python3', 'python']) {
    tried.push(name)
    const found = probe(name)
    if (found) return found
  }
  throw new Error(`找不到可用的 Python 解释器（试过 ${tried.join('、')}）。`
    + '请安装 Python 3.10+，或用 DSH_PYTHON=/path/to/python 指定后重试。')
}

const found = resolvePython()
export const python = found.command
export const pythonVersion = found.version
