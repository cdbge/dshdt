// abi-scan.mjs — ABI 门禁的 **CLI 薄封装**（实现在 src/vendor-build.mjs 的 runAbiGate）
//
// 用法：node scripts/abi-scan.mjs [node_modules 根] [electron.exe 路径]
//   环境变量回退：DSH_SCAN_ROOT / ABI_RUNTIME
//
// 为什么核心逻辑搬进 src/：装好的应用重建 vendor 暂存树时同样要跑这道门禁，而
// electron-builder 的 files 只含 src/**（scripts/ 不进包）。Q4 决定不做回滚备份后，ABI 门禁是
// 唯一防线，它绝不能在打包后退化成"没有这个脚本"。
// 本文件只负责参数解析与输出格式，保持既有的检查点命令与退出码契约不变。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAbiGate } from '../src/vendor-build.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(process.argv[2] ?? process.env.DSH_SCAN_ROOT ?? '.')
const runtime = path.resolve(process.argv[3] ?? process.env.ABI_RUNTIME ?? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'))

console.log(`[abi-scan] runtime=${runtime}`)
console.log(`[abi-scan] 扫描根=${root}`)

const r = runAbiGate({ nodeModulesDir: root, runtime })
if (r.error) {
  console.error(`[abi-scan] ${r.error}`)
  process.exit(1)
}
console.log(`[abi-scan] 发现 ${r.total} 个 .node 文件`)
console.log(`[abi-scan] 结果: OK=${r.okCount} SKIP=${r.skipCount} FAIL=${r.failCount}`)
if (!r.ok) {
  console.log('[abi-scan] 失败清单:')
  for (const f of r.failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('[abi-scan] 全部通过（非平台包）')
