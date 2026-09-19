// build-host.mjs — vendor/profile 自包含构建的 CLI 封装（实现在 src/vendor-build.mjs；插件包缺失硬失败）。
// 用法：node scripts/build-host.mjs [--runtime <electron>] [--prune-only] [--cache <npm 缓存>]
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { buildStaging, buildVendorLock, buildVendorTree, currentTarget, platformTag } from '../src/vendor-build.mjs'
import { VERSIONS } from '../src/dsh-versions.mjs'
import { electronBinaryPath } from '../src/platform-paths.mjs'
import { safeRemoveTree } from '../src/junction-safe.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES_DIR = path.join(ROOT, 'packages')

const argv = process.argv
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
// 命令行下用当前 node（Electron 在缺 GUI 依赖的环境里起不来，会让 npm install 退成 127）；从 Electron 调用才用 Electron 二进制。
const CLI_RUNTIME = process.versions.electron === undefined ? process.execPath : electronBinaryPath(createRequire(import.meta.url))
const RUNTIME = argOf('--runtime', CLI_RUNTIME)
const PRUNE_ONLY = argv.includes('--prune-only')
// 无条件指向仓库内可写目录：本机 npm 默认 cache 在 Program Files 下，普通用户不可写。
const CACHE_DIR = argOf('--cache', path.join(ROOT, '.npm-cache'))
// --out：把"树 + lock"写到别处。交叉构建的产物属于另一平台，不能顶替现网 vendor/。
const OUT_DIR = argOf('--out', path.join(ROOT, 'vendor'))
const PROFILE_DIR = path.join(OUT_DIR, 'profile')
const LOCK_PATH = path.join(OUT_DIR, 'vendor.lock.json')
// lock 的唯一写入方是 buildStaging，故先建 staging 再各就各位。暂存根放在 OUT_DIR 下，
// 且只在完整构建时创建：electron-builder 整目录拷贝 vendor/，里面只该有 profile/ 与 vendor.lock.json。
const STAGE_ROOT = path.join(OUT_DIR, '.staging-build')

/** 目标平台：显式参数优先，缺省即本机平台。 */
const TARGET = (() => {
  const base = currentTarget()
  const os = argOf('--os', base.os)
  const arch = argOf('--cpu', base.arch)
  const libc = argOf('--libc', os === 'linux' ? (base.libc ?? 'glibc') : undefined)
  return { os, arch, ...(os === 'linux' && libc ? { libc } : {}) }
})()

const log = (m) => console.log(m)
if (PRUNE_ONLY) log('[build-host] prune-only 模式：跳过安装')
const CROSS = platformTag(TARGET) !== platformTag(currentTarget())
log(`[build-host] 目标平台: ${platformTag(TARGET)}${TARGET.libc ? `（libc=${TARGET.libc}）` : ''}${CROSS ? '（交叉构建）' : '（本机）'}`)

// 交叉构建下两道门禁必然 FAIL 且与树无关（门禁要加载 .node、要起当前平台的宿主）。
// 显式降级为"延后到目标平台"并写进 vendor.lock.json，绝不静默跳过。
if (CROSS) {
  log('[build-host] 交叉构建：ABI 门禁 / 启动门禁延后到目标平台（CI 在 Linux、macOS runner 上补跑）')
}

// 完整构建在 STAGE_ROOT 里从零建树再搬到位置（现网 vendor/ 全程不动）；
// --prune-only 复用现网树原地做，不复制（剪枝幂等、插件同步是覆盖式拷贝）。
if (PRUNE_ONLY) {
  if (fs.existsSync(STAGE_ROOT)) safeRemoveTree(STAGE_ROOT)
  const built = await buildVendorTree({
    profileDir: PROFILE_DIR,
    versions: VERSIONS,
    packagesDir: PACKAGES_DIR,
    runtime: RUNTIME,
    cacheDir: CACHE_DIR,
    install: false,
    target: TARGET,
    ...(CROSS ? { skipAbiGate: true, bootGate: null } : {}),
    log,
  })
  if (!built.ok) {
    console.error(`[build-host] 剪枝失败：${built.error}`)
    process.exit(1)
  }
  const lock = buildVendorLock({ versions: VERSIONS, target: TARGET, built, profileDir: PROFILE_DIR })
  fs.writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2) + '\n')
  report(lock)
} else {
  // 布局 = <root>/profile + <root>/vendor.lock.json，建完再搬进 vendor/profile
  if (fs.existsSync(STAGE_ROOT)) safeRemoveTree(STAGE_ROOT)
  fs.mkdirSync(STAGE_ROOT, { recursive: true })

  const built = await buildStaging({
    stagingRoot: STAGE_ROOT,
    versions: VERSIONS,
    packagesDir: PACKAGES_DIR,
    runtime: RUNTIME,
    cacheDir: CACHE_DIR,
    install: true,
    target: TARGET,
    // 必须显式传：从暂存布局 (<out>/.staging-build/profile) 上推会落到 .staging-build 而非 <out>
    lockDir: OUT_DIR,
    ...(CROSS ? { skipAbiGate: true, bootGate: null } : {}),
    log,
  })
  if (!built.ok) {
    console.error(`[build-host] 构建失败：${built.error}`)
    process.exit(1)
  }

  // 先删后 rename：rename 到已存在目录在 Windows 上会失败
  if (fs.existsSync(PROFILE_DIR)) {
    const swept = safeRemoveTree(PROFILE_DIR)
    if (swept.leftovers > 0) {
      console.error(`[build-host] 旧 vendor/profile 未能清干净（残留 ${swept.leftovers} 项），中止以免产出混合树`)
      process.exit(1)
    }
  }
  fs.renameSync(built.profileDir, PROFILE_DIR)
  fs.copyFileSync(built.lockPath, LOCK_PATH)
  safeRemoveTree(STAGE_ROOT)
  report(built.lock)
}

// 两条路径共用的收尾汇报
function report(lock) {
  const mb = (b) => `${(b / 1048576).toFixed(1)} MB`
  console.log(`[build-host] 完成: ${mb(lock.totalBytes)} / ${lock.totalFiles} 个文件 → ${path.relative(ROOT, PROFILE_DIR)} + ${path.relative(ROOT, LOCK_PATH)}`)
  console.log(`[build-host] 平台 ${lock.platform.tag} / 门禁 abi=${lock.abiScan} boot=${lock.gatesDeferred?.boot ? 'DEFERRED' : 'PASS'}`)
  if (!lock.runtime?.electron || !lock.runtime?.node) {
    // runtime 段为空会让事后诊断失去唯一的 ABI 依据
    console.error('[build-host] 警告：运行时版本未能读出，vendor.lock.json 的 runtime 段为空')
  }
}

// 清掉 DSH 更新按钮留下的 vendor/staging，否则会被整目录拷进安装包。
// 走安全删除（暂存树里可能有链接场），且只在写现网 vendor/ 时清理。
const LIVE_VENDOR = path.join(ROOT, 'vendor')
if (path.resolve(OUT_DIR) === path.resolve(LIVE_VENDOR)) {
  const stagingDir = path.join(LIVE_VENDOR, 'staging')
  if (fs.existsSync(stagingDir)) {
    const swept = safeRemoveTree(stagingDir)
    console.log(`[build-host] 已清理 vendor/staging（避免被打进安装包；解开链接 ${swept.unlinked} 个）`)
  }
}
