// vendor-equivalence.mjs — 暂存树验证门禁：证明更新引擎能独立产出一棵可用的 vendor 树。
// 判据：① 构建成功且 ABI 门禁 PASS；② 可选 --boot 真起一次宿主并探到就绪 URL；③ 与基线的体积对比只作诊断输出。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { buildStaging } from '../src/vendor-build.mjs'
import { electronBinaryPath } from '../src/platform-paths.mjs'
import { safeRemoveTree } from '../src/junction-safe.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = electronBinaryPath(createRequire(import.meta.url))
const argv = process.argv
const KEEP = argv.includes('--keep')
const BOOT = argv.includes('--boot')
const TO_IDX = argv.indexOf('--timeout')
const BOOT_TIMEOUT_S = TO_IDX >= 0 ? Number(argv[TO_IDX + 1]) : 120

const logPath = path.join(ROOT, 'vendor', 'vendor.lock.json')
if (!fs.existsSync(logPath)) {
  console.error(`[equiv] 找不到基线 ${logPath}（先跑一次 build-host）`)
  process.exit(1)
}
const baseline = JSON.parse(fs.readFileSync(logPath, 'utf8'))

// 从落盘痕迹判断基线是谁装的——决定体积对比有没有可比性
function detectProducer(profileDir) {
  const nm = path.join(profileDir, 'node_modules')
  if (fs.existsSync(path.join(nm, '.pnpm')) || fs.existsSync(path.join(profileDir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (fs.existsSync(path.join(nm, '.package-lock.json')) || fs.existsSync(path.join(profileDir, 'package-lock.json'))) return 'npm'
  return '未知'
}
const baselineProducer = detectProducer(path.join(ROOT, 'vendor', 'profile'))

console.log(`[equiv] 基线: ${baseline.totalFiles} 个文件 / ${(baseline.totalBytes / 1048576).toFixed(1)} MB（安装器：${baselineProducer}）`)
console.log(`[equiv] 目标版本: ${JSON.stringify(baseline.dshVersions)}`)
if (baselineProducer !== 'npm') {
  console.log(`[equiv] 注意：基线由 ${baselineProducer} 安装，本次由 npm 安装——体积对比仅供参考，不参与判定`)
}

const stagingRoot = path.join(os.tmpdir(), `dsh-vendor-equiv-${Date.now()}`)
console.log(`[equiv] 暂存区: ${stagingRoot}`)
console.log('[equiv] 开始真实构建（npm install 分钟级，请耐心等待）...')

const t0 = Date.now()
const built = await buildStaging({
  stagingRoot,
  versions: baseline.dshVersions,
  packagesDir: path.join(ROOT, 'packages'),
  cacheDir: path.join(ROOT, '.npm-cache'),
  runtime: ELECTRON,
  logFile: path.join(stagingRoot, 'install.log'),
  log: (m) => console.log(m),
})
const secs = ((Date.now() - t0) / 1000).toFixed(0)

if (!built.ok) {
  console.error(`\n[equiv] 构建失败（${secs}s）：${built.error}`)
  console.error(`[equiv] npm 日志: ${path.join(stagingRoot, 'install.log')}`)
  process.exit(1)
}

console.log(`\n[equiv] ① 构建 + ABI 门禁: PASS（${secs}s，ABI=${built.lock.abiScan}）`)

// ② 可选：真起一次宿主（框架级证据）
let bootOk = null
if (BOOT) {
  const dshBin = path.join(built.profileDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const bootHome = path.join(stagingRoot, 'boot-home')
  console.log(`[equiv] ② 暂存树启动冒烟（bin=${dshBin}）...`)
  bootOk = await new Promise((resolve) => {
    const child = spawn(process.execPath, [
      path.join(ROOT, 'scripts', 'boot-smoke.mjs'),
      ELECTRON,
      dshBin, '--home', bootHome, '--timeout', String(BOOT_TIMEOUT_S), '--expose-internals',
    ], { stdio: 'inherit', windowsHide: true })
    child.on('exit', (code) => resolve(code === 0))
    child.on('error', () => resolve(false))
  })
  console.log(`[equiv] ② 启动冒烟: ${bootOk ? 'PASS' : 'FAIL'}`)
} else {
  console.log('[equiv] ② 启动冒烟: 跳过（加 --boot 启用；这是最强的"树可用"证据）')
}

// ③ 诊断：体积对比（不参与判定）
const rel = (a, b) => (b === 0 ? Infinity : Math.abs(a - b) / b)
const pct = (x) => `${(x * 100).toFixed(1)}%`
console.log('\n[equiv] ③ 体积诊断（仅供参考，不参与判定）')
console.log(`[equiv]    基线  : ${baseline.totalFiles} 文件 / ${(baseline.totalBytes / 1048576).toFixed(1)} MB（${baselineProducer}）`)
console.log(`[equiv]    新引擎: ${built.lock.totalFiles} 文件 / ${(built.lock.totalBytes / 1048576).toFixed(1)} MB（npm）`)
console.log(`[equiv]    偏差  : 文件 ${pct(rel(built.lock.totalFiles, baseline.totalFiles))} / 字节 ${pct(rel(built.lock.totalBytes, baseline.totalBytes))}`)

const passed = bootOk === null ? true : bootOk
console.log(passed ? '\nSTAGING VERIFY: PASS' : '\nSTAGING VERIFY: FAIL（启动冒烟未通过）')

if (KEEP) console.log(`[equiv] --keep：保留暂存树 ${stagingRoot}`)
else {
  // 安全删除：暂存树里可能有构建期造的链接场
  const swept = safeRemoveTree(stagingRoot)
  console.log(`[equiv] 已清理暂存树（解开链接 ${swept.unlinked} 个）`)
}
process.exit(passed ? 0 : 1)
