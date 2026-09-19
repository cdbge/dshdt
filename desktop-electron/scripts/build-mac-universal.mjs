// build-mac-universal.mjs — 产出"双架构一棵树"的 macOS vendor（arm64 + x64 平台包并存）
//
// 为什么需要它（2026-09-14 实测发现的真缺口）：
//   `electron-builder --mac dmg zip --arm64 --x64` 会把**同一棵 vendor 树**打进两个架构的 .app，
//   而 npm install 一次只能按一个 `--cpu` 解析可选依赖 ⇒ arm64 产物里只有 arm64 的预编译，
//   x64 产物**装上也起不来**（koffi / node-pty 在 import 期崩）。
//   而 CLI 显式传了 `--arm64 --x64` 时，electron-builder 也不允许 target 里再指定 arch 把两个架构分开。
//   所以这个 job 的产物必须**同时**带上两套平台专属二进制。
//
// 做法：先建宿主架构（或 --host 指定的）那棵 → 再单独建另一架构那棵当 donor → 只把 donor 里
// **目标平台专属**的条目并进来（见 `mergePlatformPackages`）→ 重写 lock（记下 mergedPlatforms）。
// 不整树拷贝：脚本与 JS 代码在两棵树里是同一份，搬过来只会引入"两份可能漂移的代码"。
//
// 用法：
//   node scripts/build-mac-universal.mjs --out vendor --host arm64 --add x64
//   （在 macOS CI 上就是：宿主 arm64 + 并进 x64；本地交叉验证用 --os darwin）
// 产物布局与 build-host 一致：<out>/profile + <out>/vendor.lock.json。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { buildStaging, buildVendorLock, mergePlatformPackages, platformTag, vendorStats, verifyTargetPackages } from '../src/vendor-build.mjs'
import { VERSIONS } from '../src/dsh-versions.mjs'
import { electronBinaryPath } from '../src/platform-paths.mjs'
import { safeRemoveTree } from '../src/junction-safe.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES_DIR = path.join(ROOT, 'packages')
const argv = process.argv
const argOf = (flag, fallback = null) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}

const OUT_DIR = path.resolve(ROOT, argOf('--out', 'vendor'))
const OS = argOf('--os', process.platform)
const HOST_ARCH = argOf('--host', process.arch)
const ADD_ARCH = argOf('--add', HOST_ARCH === 'arm64' ? 'x64' : 'arm64')
// 运行时解析规则与 build-host.mjs 一致（那边有详细解释）：命令行下用当前 node，
// 从 Electron 里调用才用 Electron 二进制——Electron 在缺 GUI 依赖的环境里起不来（报 127）。
const CLI_RUNTIME = process.versions.electron === undefined ? process.execPath : electronBinaryPath(createRequire(import.meta.url))
const RUNTIME = argOf('--runtime', CLI_RUNTIME)
const CACHE_DIR = argOf('--cache', path.join(ROOT, '.npm-cache'))
// --merge-from <目录>：不重装，直接从一棵**已经建好的**目标平台树上取平台专属包。
// 两条用途：① 本地验证合并逻辑时不必再等一次 8 分钟的 npm install；
// ② CI 里如果需要重复出树，可以复用上一次的产物。
const MERGE_FROM = argOf('--merge-from', null)

const log = (m) => console.log(m)
const target = { os: OS, arch: HOST_ARCH }
const donorTarget = { os: OS, arch: ADD_ARCH }
if (platformTag(target) === platformTag(donorTarget)) {
  console.error('[mac-universal] --host 与 --add 不能相同（那就不是双架构了）')
  process.exit(2)
}

log(`[mac-universal] 主平台 ${platformTag(target)} / 并入 ${platformTag(donorTarget)} → ${path.relative(ROOT, OUT_DIR)}`)
const DONOR_ROOT = path.join(path.dirname(OUT_DIR), `.donor-${platformTag(donorTarget)}`)
const STAGE_ROOT = path.join(OUT_DIR, '.staging-build')

// ── ① 主架构 ──
// macOS 上跑的就是本机平台（target 即宿主），所以 ABI / 启动门禁照常跑、不延后；
// 本地在 Windows 上交叉验证（--os darwin）时两者必然 FAIL 且与树无关，故显式延后并留痕。
const CROSS = platformTag(target) !== platformTag({ os: process.platform, arch: process.arch })
if (CROSS) log('[mac-universal] 交叉产出：ABI / 启动门禁延后到目标平台（CI 在 macOS runner 上补跑）')
if (fs.existsSync(STAGE_ROOT)) safeRemoveTree(STAGE_ROOT)
fs.mkdirSync(STAGE_ROOT, { recursive: true })

const main = await buildStaging({
  stagingRoot: STAGE_ROOT,
  versions: VERSIONS,
  packagesDir: PACKAGES_DIR,
  runtime: RUNTIME,
  cacheDir: CACHE_DIR,
  install: true,
  target,
  // 剪枝必须**同时**保住两个架构的预编译，否则主架构建完就把 donor 那个剪掉了（合并是在之后做的）
  keepPlatforms: [donorTarget],
  ...(CROSS ? { skipAbiGate: true, bootGate: null } : {}),
  log,
})
if (!main.ok) {
  console.error(`[mac-universal] 主架构构建失败：${main.error}`)
  process.exit(1)
}

// ── ② donor 架构（单独一棵，建完只取平台专属部分）──
let donorProfileDir
let donorBuilt = null
if (MERGE_FROM !== null) {
  donorProfileDir = path.join(path.resolve(ROOT, MERGE_FROM), 'profile')
  if (!fs.existsSync(donorProfileDir)) {
    console.error(`[mac-universal] --merge-from 里没有 profile/：${donorProfileDir}`)
    process.exit(2)
  }
  log(`[mac-universal] donor 用现成的树（--merge-from）：${path.relative(ROOT, donorProfileDir)}`)
} else {
  if (fs.existsSync(DONOR_ROOT)) safeRemoveTree(DONOR_ROOT)
  fs.mkdirSync(DONOR_ROOT, { recursive: true })
  const donor = await buildStaging({
    stagingRoot: DONOR_ROOT,
    versions: VERSIONS,
    packagesDir: PACKAGES_DIR,
    runtime: RUNTIME,
    cacheDir: CACHE_DIR,
    install: true,
    target: donorTarget,
    // donor 只是"平台专属包的来源"，两道门禁都不必跑（它的 .node 在宿主上本来就加载不了）
    skipAbiGate: true,
    bootGate: null,
    log: (m) => log(`  [donor] ${m}`),
  })
  if (!donor.ok) {
    console.error(`[mac-universal] donor 架构构建失败：${donor.error}`)
    process.exit(1)
  }
  donorProfileDir = donor.profileDir
  donorBuilt = donor.built
}

// ── ③ 合并平台专属包 → 复验必需包 → 重写 lock ──
const merged = mergePlatformPackages({
  donorProfileDir,
  donorRoot: path.dirname(donorProfileDir),
  profileDir: main.profileDir,
  target: donorTarget,
  log,
})
if (merged.missing.length > 0) {
  console.error(`[mac-universal] 合并不完整：${merged.missing.join(' / ')}`)
  process.exit(1)
}
// 合并之后**两个架构的必需包都必须齐**——这是这个脚本存在的全部理由，缺一个就白干
for (const t of [target, donorTarget]) {
  const pkgs = verifyTargetPackages(main.profileDir, t)
  if (!pkgs.ok) {
    console.error(`[mac-universal] ${platformTag(t)} 的必需包在合并后仍缺：${pkgs.missing.join(' / ')}`)
    process.exit(1)
  }
  log(`[mac-universal] ${platformTag(t)} 必需包齐备：${pkgs.present.length} 项`)
}

const lock = buildVendorLock({
  versions: VERSIONS,
  target,
  // 统计必须是**合并之后**的：`main.built.stats` 与 `main.built.packages` 都是合并前量的，
  // 直接用会写出"100.3 MB / 11,171 文件"这种少算了整个另一架构的数字（实测踩过），
  // 而 lock 的体积/文件数正是事后判断"这棵树全不全"的依据 —— 报小了比不报更坏。
  built: {
    ...main.built,
    stats: vendorStats(main.profileDir),
    packages: verifyTargetPackages(main.profileDir, target),
  },
  profileDir: main.profileDir,
  mergedPlatforms: [donorTarget],
})
const lockPath = path.join(OUT_DIR, 'vendor.lock.json')
fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n')

// ── ④ 就位并清场 ──
const PROFILE_DIR = path.join(OUT_DIR, 'profile')
if (path.resolve(main.profileDir) !== path.resolve(PROFILE_DIR)) {
  if (fs.existsSync(PROFILE_DIR)) {
    const swept = safeRemoveTree(PROFILE_DIR)
    if (swept.leftovers > 0) {
      console.error(`[mac-universal] 旧 profile 未清干净（残留 ${swept.leftovers} 项），中止以免产出混合树`)
      process.exit(1)
    }
  }
  fs.renameSync(main.profileDir, PROFILE_DIR)
}
safeRemoveTree(STAGE_ROOT)
if (donorBuilt !== null) safeRemoveTree(DONOR_ROOT)

const mb = (b) => `${(b / 1048576).toFixed(1)} MB`
console.log(`[mac-universal] 完成：${mb(lock.totalBytes)} / ${lock.totalFiles} 个文件，平台 ${lock.platform.tag} + ${platformTag(donorTarget)}`)
console.log(`[mac-universal] 门禁：abi=${lock.abiScan} boot=${lock.gatesDeferred?.boot ? 'DEFERRED' : 'PASS'}`)
console.log(`[mac-universal] 打包：npx electron-builder --mac dmg zip --arm64 --x64（这一棵树两个架构都能用）`)
