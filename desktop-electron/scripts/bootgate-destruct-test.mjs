// bootgate-destruct-test.mjs — 拿现网 vendor 树的拷贝跑一次真启动门禁，比对前后文件数，判断门禁是否破坏该树。
// 用法：node scripts/bootgate-destruct-test.mjs（需设 DSH_INSTALL_DIR 指向已安装应用目录）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runBootGate } from '../src/vendor-build.mjs'
import { electronBinaryPath } from '../src/platform-paths.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const INSTALL = process.env.DSH_INSTALL_DIR ?? ''
if (INSTALL === '') {
  console.error('需要 DSH_INSTALL_DIR 指向已安装应用的目录（含 resources/），例如：')
  console.error('  Windows: set DSH_INSTALL_DIR=%LOCALAPPDATA%\\Programs\\DSH Desktop')
  console.error('  macOS  : export DSH_INSTALL_DIR=/Applications/DSH\\ Desktop.app/Contents')
  console.error('  Linux  : export DSH_INSTALL_DIR=/opt/DSH\\ Desktop')
  process.exit(2)
}
const LIVE = path.join(INSTALL, 'resources', 'vendor', 'profile')
const PATCH = path.join(INSTALL, 'resources', 'desktop.patch.yml')
const ELECTRON = electronBinaryPath(createRequire(import.meta.url))

function walk(dir) {
  let files = 0
  let dirs = 0
  const stack = [dir]
  while (stack.length > 0) {
    const d = stack.pop()
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { dirs += 1; stack.push(p) } else { files += 1 }
    }
  }
  return { files, dirs }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gate-destruct-'))
const copy = path.join(tmp, 'profile')
console.log(`[实验] 拷贝现网树 → ${copy}`)
fs.cpSync(LIVE, copy, { recursive: true })
const before = walk(copy)
console.log(`[实验] 门禁前: ${before.files} 文件 / ${before.dirs} 目录`)

try {
  const r = await runBootGate({
    profileDir: copy,
    runtime: ELECTRON,
    patchFile: PATCH,
    ws: tmp,
    timeoutMs: 20000,   // 只关心文件系统副作用，不需要等满 90s
    log: (m) => console.log('[gate]', m),
  })
  console.log(`[实验] 门禁结果: ok=${r.ok} error=${r.error ?? ''}`)
} catch (e) {
  console.log('[实验] 门禁抛出:', e.message)
}

const after = walk(copy)
console.log(`[实验] 门禁后: ${after.files} 文件 / ${after.dirs} 目录`)
const lost = before.files - after.files
console.log(`[实验] 结论: ${lost === 0 ? '门禁未破坏树（文件数不变）' : `门禁破坏了树！少了 ${lost} 个文件`}`)

console.log('[实验] 清理拷贝...')
fs.rmSync(tmp, { recursive: true, force: true })
console.log('[实验] 完成')
