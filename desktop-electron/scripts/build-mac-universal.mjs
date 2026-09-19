// build-mac-universal.mjs — 产出一棵同时含 arm64 与 x64 平台专属二进制的 macOS vendor 树。
// 先建宿主架构那棵，再单独建另一架构当 donor，只并入 donor 的目标平台专属条目，最后重写 lock（mergedPlatforms）。
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
// 命令行下用当前 node，从 Electron 调用才用 Electron 二进制（同 build-host.mjs）
const CLI_RUNTIME = process.versions.electron === undefined ? process.execPath : electronBinaryPath(createRequire(import.meta.url))
const RUNTIME = argOf('--runtime', CLI_RUNTIME)
const CACHE_DIR = argOf('--cache', path.join(ROOT, '.npm-cache'))
// --merge-from <目录>：不重装，直接从一棵已建好的目标平台树取平台专属包
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

// ① 主架构：本机平台上两道门禁照常跑；交叉验证时必然 FAIL 且与树无关，故显式延后并留痕
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
  // 剪枝必须同时保住两个架构的预编译，否则主架构建完就把 donor 那个剪掉了
  keepPlatforms: [donorTarget],
  ...(CROSS ? { skipAbiGate: true, bootGate: null } : {}),
  log,
})
if (!main.ok) {
  console.error(`[mac-universal] 主架构构建失败：${main.error}`)
  process.exit(1)
}

// ② donor 架构：单独建一棵，只取平台专属部分
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
    // donor 的 .node 在宿主上加载不了，两道门禁都不必跑
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

// ③ 合并平台专属包 → 复验必需包 → 重写 lock
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
// 合并后两个架构的必需包都必须齐，这是本脚本存在的全部理由
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
  // 统计必须量在合并之后：main.built.stats/packages 是合并前的，直接用会少算整个另一架构
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

// ④ 就位并清场
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
