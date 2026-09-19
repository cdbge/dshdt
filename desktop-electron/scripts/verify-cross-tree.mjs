// verify-cross-tree.mjs — CLI：对一棵 vendor 树做"平台向静态体检"（判据在 src/cross-tree-check.mjs）
//
// 为什么需要它：交叉构建（在 A 平台产 B 平台的树）**不可能**跑 ABI 门禁与启动门禁——那两道门禁要把
// `.node` 加载进当前进程、要起当前平台的宿主。于是交叉产物天然少了两道最有力的证据，剩下的只能靠
// 静态体检补：树里到底属于哪个平台、该有的在不在、不该有的有没有残留、门禁结论有没有诚实标注。
//
// 目标平台**默认取 lock 里的 `platform` 段**，所以同一条命令在三处都能直接用：
//   · 交叉产物：`node scripts/verify-cross-tree.mjs --dir .tmp-cross/linux-x64`
//   · 本机现网树：`node scripts/verify-cross-tree.mjs --dir vendor`
//   · CI 三个打包 job（各在自己的 runner 上）：`node scripts/verify-cross-tree.mjs --dir vendor`
// `--os/--cpu` 只用于**额外核对**"lock 里的平台是不是我刚指定的那个"。
//
// 用法：node scripts/verify-cross-tree.mjs --dir <目录> [--os <os>] [--cpu <arch>]
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

// 现网 lock：只在与本树**不是同一棵**时用作对比基准
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
