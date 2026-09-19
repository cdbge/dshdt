// build-host.mjs — vendor/profile 自包含构建的 **CLI 薄封装**
//
// 用法：node scripts/build-host.mjs [--runtime <electron 可执行文件>] [--prune-only] [--cache <npm 缓存目录>]
//        [--os win32|linux|darwin] [--cpu x64|arm64] [--libc glibc|musl] [--out <目录>]
//   --prune-only：跳过安装，只对现有 vendor/profile 做剪枝 + 插件同步 + 包门禁 + ABI 门禁 + 刷新 lock。
//   --os/--cpu/--libc：交叉产出**目标平台**的树（默认就是本机平台）。原生平台上构建可省略这些参数。
//   --out：产物目录（默认 vendor/）。交叉构建务必配合 --out，别让另一平台的树顶替本机的现网树。
//
// 为什么退化成薄封装：安装/剪枝/插件同步/ABI 门禁的实现已移入 `src/vendor-build.mjs`——装好的应用
// 也要能在本地重建 vendor 树，而 electron-builder 的 files 只含 `src/**`，**scripts/ 不进包**。
// 两边共用同一份实现，是"换树后插件消失"这类漂移唯一的根治办法（规范③）。
//
// 行为变化（相对旧版）：插件包缺失从"静默跳过"改为**硬失败**。旧写法会产出一棵没有
// dsh-desktop-ui / dsh-auto-approval 的 vendor 树，症状（设置面板少一节、/approval 消失）
// 离原因很远，而且出现在换树"成功"之后——不如当场拒绝。
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
// 运行时（用来跑 npm 与 ABI/dlopen 探针）默认解析规则：
//   · 从 Electron 里调用（打包态更新路径）→ 用 Electron 自己的二进制（`ELECTRON_RUN_AS_NODE` 当纯 Node 用）
//   · 从命令行调用（`npm run build:host`）→ **用当前这个 node**（`process.execPath`）
// 为什么必须分这两种（2026-09-14 在 Debian 上实测踩到）：命令行下默认取 Electron 二进制，
// 而 Electron 在缺 GUI 依赖的环境里**根本起不来**——`node_modules/electron/dist/electron` 报
// `error while loading shared libraries: libglib-2.0.so.0`（本机 Debian 13 缺 24 个共享库）。
// 症状是 `npm install 退出码 127`（找不到命令），而 npm 本身完全正常 —— 排查要绕一大圈。
// 命令行下用 node 既躲开这个坑，又让"构建期用的 node"就是表达式里那个可见的版本。
const CLI_RUNTIME = process.versions.electron === undefined ? process.execPath : electronBinaryPath(createRequire(import.meta.url))
const RUNTIME = argOf('--runtime', CLI_RUNTIME)
const PRUNE_ONLY = argv.includes('--prune-only')
// 本机 npm 默认 cache 在 Program Files 下（普通用户不可写 → EPERM）。这里**无条件**指向
// 仓库内的可写目录，不给外部环境变量顶掉它的机会（旧版的 `|| 回退` 写法正是被顶掉的那个）。
const CACHE_DIR = argOf('--cache', path.join(ROOT, '.npm-cache'))
// --out <目录>：把"树 + lock"写到别处，别动现网 vendor/。交叉构建的产物**不能**直接顶替现网树
// （它属于另一个平台，顶上去等于把本机应用换成起不来的树），所以交叉验证必须走 --out。
const OUT_DIR = argOf('--out', path.join(ROOT, 'vendor'))
const PROFILE_DIR = path.join(OUT_DIR, 'profile')
const LOCK_PATH = path.join(OUT_DIR, 'vendor.lock.json')
// 现网树与 lock 的关系：lock 由 `buildStaging` 产出（它是"树 + lock"的唯一写入方）。build-host 的
// 现网树不是 staging 布局，所以先用临时目录建 staging，再把 profile 与 lock 各就各位。
// 这样 lock 的字段集只有一处定义——两份手写字段集会漂移，而 lock 是事后诊断唯一的依据。
// 暂存根放在 OUT_DIR 下：交叉构建用 --out 时不会碰到现网 vendor/。
// 注意它**只在完整构建时创建**：--prune-only 不需要暂存，而在 `vendor/` 下留一个空目录也不行——
// electron-builder 的 extraResources 是 `from: vendor` 整目录拷贝，`vendor/` 里只该有 `profile/`
// 与 `vendor.lock.json`（实测踩过：prune-only 之后 `vendor/.staging-build` 留在那儿）。
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

// 交叉构建：ABI 门禁与启动门禁在这里**必然**判 FAIL，且失败原因与树无关——门禁要把 .node 加载进
// 当前进程、要起当前平台的宿主可执行文件，Windows 上加载不了 Mach-O / ELF。
// 于是：显式降级为"延后到目标平台"，并让结论写进 vendor.lock.json（abiScan=DEFERRED + gatesDeferred）。
// 绝不静默跳过：降级要留痕，否则后来的人会把没验过的树当成验过的（"假绿"）。
if (CROSS) {
  log('[build-host] 交叉构建：ABI 门禁 / 启动门禁延后到目标平台（CI 在 Linux、macOS runner 上补跑）')
}

// 两条路径分开走，因为它们的"暂存"含义不同：
//   · 完整构建（默认）：在 OUT_DIR/.staging-build 里从零建树，建完把 profile 与 lock 搬到位置。
//     现网 vendor/ 全程不动，中途失败不会留下一棵半成品树。
//   · --prune-only（维护/换平台修复）：**没有东西可暂存**——它复用的就是现网那棵树，
//     把它复制一份再剪等于凭空多拷 124 MB。所以它就在原地做，只做剪枝/插件/平台包门禁/lock。
//     剪枝本身是幂等的（目标平台的预编译件不动），插件同步是覆盖式拷贝，风险可控。
if (PRUNE_ONLY) {
  // 顺手清掉可能残留的暂存目录（旧版本在 prune-only 之后把它留在了 vendor/ 里）
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
  // 目标树落在临时 staging 根下（布局 = <root>/profile + <root>/vendor.lock.json），
  // 建完再搬进 vendor/profile。直接写现网目录会让构建中途失败留下一棵半成品树。
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
    // 版本锁在 OUT_DIR 下（`vendor/package-lock.json`）。**必须显式传**：构建走暂存布局
    // `<out>/.staging-build/profile`，从 profileDir 往上推会落到 `.staging-build` 而不是 `<out>`，
    // 于是仓库里那份锁永远找不到（实测踩到）。
    lockDir: OUT_DIR,
    ...(CROSS ? { skipAbiGate: true, bootGate: null } : {}),
    log,
  })
  if (!built.ok) {
    console.error(`[build-host] 构建失败：${built.error}`)
    process.exit(1)
  }

  // 搬到现网位置。profile 用先删后 rename：rename 到已存在目录在 Windows 上会失败。
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

/** 收尾汇报（两条路径共用，避免"一条路径忘了报门禁状态"）。 */
function report(lock) {
  const mb = (b) => `${(b / 1048576).toFixed(1)} MB`
  console.log(`[build-host] 完成: ${mb(lock.totalBytes)} / ${lock.totalFiles} 个文件 → ${path.relative(ROOT, PROFILE_DIR)} + ${path.relative(ROOT, LOCK_PATH)}`)
  console.log(`[build-host] 平台 ${lock.platform.tag} / 门禁 abi=${lock.abiScan} boot=${lock.gatesDeferred?.boot ? 'DEFERRED' : 'PASS'}`)
  if (!lock.runtime?.electron || !lock.runtime?.node) {
    // 运行时版本读不出时 lock 的 runtime 段会是空值——那会让事后诊断失去唯一的 ABI 依据，必须显式告警。
    console.error('[build-host] 警告：运行时版本未能读出，vendor.lock.json 的 runtime 段为空')
  }
}

// 清掉 DSH 更新按钮留下的暂存树：electron-builder 的 extraResources 是 `from: vendor` 整目录拷贝，
// 残留的 staging 会把上百 MB 的临时树打进安装包。
// 走安全删除：暂存树里可能有构建期造的链接场。
// 只在写现网 vendor/ 时清理——交叉构建走 --out，现网 vendor/staging 不归它管。
const LIVE_VENDOR = path.join(ROOT, 'vendor')
if (path.resolve(OUT_DIR) === path.resolve(LIVE_VENDOR)) {
  const stagingDir = path.join(LIVE_VENDOR, 'staging')
  if (fs.existsSync(stagingDir)) {
    const swept = safeRemoveTree(stagingDir)
    console.log(`[build-host] 已清理 vendor/staging（避免被打进安装包；解开链接 ${swept.unlinked} 个）`)
  }
}
