// build-host.mjs — vendor/profile 自包含构建的 **CLI 薄封装**
//
// 用法：node scripts/build-host.mjs [--runtime <electron.exe 路径>] [--prune-only] [--cache <npm 缓存目录>]
//   --prune-only：跳过安装，只对现有 vendor/profile 做剪枝 + 插件同步 + ABI 门禁 + 刷新 lock。
//
// 为什么退化成薄封装：安装/剪枝/插件同步/ABI 门禁的实现已移入 `src/vendor-build.mjs`——装好的应用
// 也要能在本地重建 vendor 树，而 electron-builder 的 files 只含 `src/**`，**scripts/ 不进包**。
// 两边共用同一份实现，是"换树后插件消失"这类漂移唯一的根治办法（规范 §25③）。
//
// 行为变化（相对旧版）：插件包缺失从"静默跳过"改为**硬失败**。旧写法会产出一棵没有
// dsh-desktop-ui / dsh-auto-approval 的 vendor 树，症状（设置面板少一节、/approval 消失）
// 离原因很远，而且出现在换树"成功"之后——不如当场拒绝。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildVendorTree } from '../src/vendor-build.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE_DIR = path.join(ROOT, 'vendor', 'profile')
const PACKAGES_DIR = path.join(ROOT, 'packages')
const LOCK_PATH = path.join(ROOT, 'vendor', 'vendor.lock.json')

const argv = process.argv
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const RUNTIME = argOf('--runtime', path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'))
const PRUNE_ONLY = argv.includes('--prune-only')
// 坑 20：本机 npm 默认 cache 在 Program Files 下（普通用户不可写 → EPERM）。这里**无条件**指向
// 仓库内的可写目录，不给外部环境变量顶掉它的机会（旧版的 `|| 回退` 写法正是被顶掉的那个）。
const CACHE_DIR = argOf('--cache', path.join(ROOT, '.npm-cache'))

/**
 * bundles 锁定的 DSH 版本。三者同进同退——只升一个会让 vendor 树不自洽。
 *
 * 2026-09-12 由 0.1.0-rc.8 升到 **0.1.5-rc.2**。为什么必须升：
 * 用户机器上的已装应用**早就**通过「DSH 更新按钮」跑在 0.1.5-rc.2 上了，
 * 而仓库这边还锁着 rc.8 —— 于是「打出来的安装包」和「大家在用的应用」是两棵不同的树。
 * 后果不是崩溃而是**静默失配**：本轮的桌面皮肤（滚动条 / 跳转轨 / 中央遮罩 / 左右侧栏）
 * 全部按 0.1.5 的 CSS-modules 类名书写（`_marks` / `eGxaPq_*` / `wSkVaW_*`），
 * 这些在 rc.8 里**根本不存在** → 新装的机器上皮肤不报错、就是没效果。
 * 见《代码规范与范例.md》坑 45。
 */
const VERSIONS = { '@deepseek-ai/dsh': '0.1.5-rc.2', '@deepseek-ai/dsh-base': '0.1.5-rc.2', '@deepseek-ai/dsh-web-app': '0.1.5-rc.2' }

const log = (m) => console.log(m)
if (PRUNE_ONLY) log('[build-host] prune-only 模式：跳过安装')

const built = await buildVendorTree({
  profileDir: PROFILE_DIR,
  versions: VERSIONS,
  packagesDir: PACKAGES_DIR,
  runtime: RUNTIME,
  cacheDir: CACHE_DIR,
  install: !PRUNE_ONLY,
  log,
})
if (!built.ok) {
  console.error(`[build-host] 构建失败：${built.error}`)
  process.exit(1)
}

const lock = {
  generatedAt: new Date().toISOString(),
  dshVersions: VERSIONS,
  runtime: built.runtime,
  abiScan: 'PASS',
  prunedBytes: built.pruned.prunedBytes,
  prunedFiles: built.pruned.prunedFiles,
  ...built.stats,
}
fs.writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2) + '\n')
const mb = (b) => `${(b / 1048576).toFixed(1)} MB`
console.log(`[build-host] 完成: ${mb(lock.totalBytes)} / ${lock.totalFiles} 个文件 → vendor/profile + vendor.lock.json`)

// 运行时版本读不出时 lock 的 runtime 段会是空值——那会让事后诊断失去唯一的 ABI 依据，必须显式告警。
if (!lock.runtime?.electron || !lock.runtime?.node) {
  console.error('[build-host] 警告：运行时版本未能读出，vendor.lock.json 的 runtime 段为空')
}

// 清掉 DSH 更新按钮留下的暂存树：electron-builder 的 extraResources 是 `from: vendor` 整目录拷贝，
// 残留的 staging 会把上百 MB 的临时树打进安装包。
const stagingDir = path.join(ROOT, 'vendor', 'staging')
if (fs.existsSync(stagingDir)) {
  fs.rmSync(stagingDir, { recursive: true, force: true })
  console.log('[build-host] 已清理 vendor/staging（避免被打进安装包）')
}
