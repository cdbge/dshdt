// abi-scan.mjs — ABI 门禁的 CLI 封装（判定在 src/vendor-build.mjs 的 runAbiGate）。
// 用法：node scripts/abi-scan.mjs [node_modules 根] [electron 可执行文件路径] [--os <os> --cpu <arch>]
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { currentTarget, runAbiGate } from '../src/vendor-build.mjs'
import { electronBinaryPath } from '../src/platform-paths.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const root = path.resolve(argv[2] ?? process.env.DSH_SCAN_ROOT ?? '.')
const runtime = path.resolve(argv[3] ?? process.env.ABI_RUNTIME ?? electronBinaryPath(createRequire(import.meta.url)))
const base = currentTarget()
const target = {
  os: argOf('--os', base.os),
  arch: argOf('--cpu', base.arch),
  ...(argOf('--os', base.os) === 'linux' ? { libc: argOf('--libc', base.libc ?? 'glibc') } : {}),
}

console.log(`[abi-scan] runtime=${runtime}`)
console.log(`[abi-scan] 扫描根=${root}`)
console.log(`[abi-scan] 目标平台=${target.os}-${target.arch}${target.libc ? `（libc=${target.libc}）` : ''}`)

const r = runAbiGate({ nodeModulesDir: root, runtime, target })
if (r.error) {
  console.error(`[abi-scan] ${r.error}`)
  process.exit(1)
}
console.log(`[abi-scan] 发现 ${r.total} 个 .node 文件`)
console.log(`[abi-scan] 结果: OK=${r.okCount} SKIP=${r.skipCount} FAIL=${r.failCount}`)
if (r.skipped.length > 0) {
  console.log('[abi-scan] 跳过（其它平台的制品，属预期）:')
  for (const f of r.skipped) console.log('  - ' + f)
}
if (!r.ok) {
  console.log('[abi-scan] 失败清单:')
  for (const f of r.failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('[abi-scan] 全部通过（本平台必需的 .node 均可加载）')
