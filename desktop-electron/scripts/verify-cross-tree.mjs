// verify-cross-tree.mjs — CLI：对一棵 vendor 树做平台向静态体检（判据在 src/cross-tree-check.mjs）。
// 交叉产物跑不了 ABI/启动门禁，只能靠静态体检补：树属于哪个平台、该有的在不在、门禁结论是否诚实标注。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkCrossTree } from '../src/cross-tree-check.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argOf = (flag, fallback = null) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

const dirArg = argOf('--dir')
if (dirArg === null) {
  console.error('[verify-cross] 需要 --dir <产物目录>（含 profile/ 与 vendor.lock.json）')
  process.exit(2)
}
const DIR = path.resolve(ROOT, dirArg)
const LOCK_PATH = path.join(DIR, 'vendor.lock.json')
if (!fs.existsSync(LOCK_PATH)) {
  console.error(`[verify-cross] 缺 vendor.lock.json：${LOCK_PATH}`)
  process.exit(2)
}
const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'))

// 现网 lock：只在与本树不是同一棵时用作对比基准
const liveDir = path.join(ROOT, 'vendor')
const liveLockPath = path.join(liveDir, 'vendor.lock.json')
const sameAsLive = path.resolve(DIR) === path.resolve(liveDir)
let referenceLock = null
if (!sameAsLive && fs.existsSync(liveLockPath)) {
  try { referenceLock = { ...JSON.parse(fs.readFileSync(liveLockPath, 'utf8')), __dir: liveDir } } catch { referenceLock = null }
}

const { pass, fail, checks } = checkCrossTree({ dir: DIR, lock, referenceLock })
console.log(`[verify-cross] ${DIR}`)
console.log(checks.join('\n'))

// --os/--cpu 只做额外核对：lock 写的平台必须与"我以为的目标平台"一致
if (argv.includes('--os') || argv.includes('--cpu')) {
  const want = `${argOf('--os', lock.platform?.os)}-${argOf('--cpu', lock.platform?.arch)}`
  const fine = lock.platform?.tag === want
  console.log(`  ${fine ? 'PASS' : 'FAIL'}  lock.platform 与 --os/--cpu 一致 — ${lock.platform?.tag} vs ${want}`)
  if (!fine) process.exit(1)
}

console.log(`\n[verify-cross] pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
