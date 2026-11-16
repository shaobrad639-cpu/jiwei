import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (['node_modules', '.git', '__pycache__'].includes(e.name)) return []
    const path = join(dir, e.name)
    return e.isDirectory() ? walk(path) : [path]
  })
}
const files = walk('.')
for (const path of files) {
  if (path.endsWith('.json')) JSON.parse(readFileSync(path, 'utf8'))
  if (/\.(mjs|js)$/.test(path)) {
    const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' })
    if (result.status !== 0) process.exit(1)
  }
}
const py = files.filter(p => p.endsWith('.py'))
// 先 python3 再 python；DSH_PYTHON 是显式覆盖，指错了要报错而不是悄悄换一个。
let python = process.env.DSH_PYTHON || ''
if (!python) {
  const tried = []
  for (const name of ['python3', 'python']) {
    tried.push(name)
    const probe = spawnSync(name, ['--version'], { encoding: 'utf8' })
    if (!probe.error && probe.status === 0) { python = name; break }
  }
  if (!python) {
    console.error(`✗ 找不到可用的 Python 解释器（试过 ${tried.join('、')}）。`)
    console.error('  请安装 Python 3.10+，或用 DSH_PYTHON=/path/to/python 指定后重试。')
    process.exit(1)
  }
}
const result = spawnSync(python, ['-c',
  'import ast, pathlib, sys; [ast.parse(pathlib.Path(p).read_text(encoding="utf-8-sig"), filename=p, feature_version=(3,10)) for p in sys.argv[1:]]', ...py], { stdio: 'inherit' })
if (result.error) {
  console.error(`✗ 无法运行 Python 解释器 ${python}：${result.error.message}`)
  console.error('  请用 DSH_PYTHON=/path/to/python 指定一个可用的 Python 3.10+。')
  process.exit(1)
}
if (result.status !== 0) process.exit(1)
console.log('JavaScript, JSON and Python syntax checks passed.')
