#!/usr/bin/env node
// ABI 扫描：在目标运行时（ELECTRON_RUN_AS_NODE 的 electron.exe）下逐个 dlopen 所有 .node 原生模块。
// 目的：验证 DSH 依赖树（node-pty/sharp/koffi/@img 等）的预编译二进制与 Electron 内建 Node 的 ABI 兼容。
// 用法：node scripts/abi-scan.mjs <node_modules 根> [electron.exe 路径]
// 说明：子进程用 stdio:'inherit'（沙箱管道限制）；非 win32-x64 平台的 .node 按 SKIP 分类。
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? process.env.DSH_SCAN_ROOT ?? '.')
const runtime = resolve(process.argv[3] ?? process.env.ABI_RUNTIME ?? new URL('../node_modules/electron/dist/electron.exe', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const PLATFORM_MARKERS = /(darwin|linux|freebsd|openbsd|android|sunos|aix|arm64|armv|ia32|ppc64|s390x)/
const PROBE = `try{process.dlopen(module,process.argv[1]);process.stdout.write('OK\\n')}catch(e){process.stderr.write('FAIL: '+e.message+'\\n');process.exit(1)}`

const files = []
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walk(p)
    else if (entry.name.endsWith('.node')) files.push(p)
  }
}
walk(root)
files.sort()

console.log(`[abi-scan] runtime=${runtime}`)
console.log(`[abi-scan] 扫描根=${root}`)
console.log(`[abi-scan] 发现 ${files.length} 个 .node 文件`)

let ok = 0, fail = 0, skip = 0
const failures = []
const runOpts = { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }

for (const [i, file] of files.entries()) {
  const rel = file.slice(root.length + 1)
  process.stdout.write(`[${i + 1}/${files.length}] ${rel} ... `)
  const r = spawnSync(runtime, ['-e', PROBE, file], runOpts)
  if (r.status === 0) { ok++; process.stdout.write('OK\n') }
  else if (PLATFORM_MARKERS.test(rel)) { skip++; process.stdout.write('SKIP(平台包)\n') }
  else { fail++; failures.push(rel); process.stdout.write('FAIL\n') }
}

console.log(`[abi-scan] 结果: OK=${ok} SKIP=${skip} FAIL=${fail}`)
if (failures.length > 0) {
  console.log('[abi-scan] 失败清单:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('[abi-scan] 全部通过（非平台包）')
