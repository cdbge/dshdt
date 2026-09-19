// check-assets.mjs — 打包前置资源检查（纯 Node、脱网、秒级）
//
// 为什么需要：`electron-builder.yml` 的 `extraResources` 里现在列了 `build/icon.png`
// （Linux/macOS 的托盘与窗口要用），而 `build/icon.ico` 才是唯一入库的图标源 —— 三个图标文件
// （ico / png / icons 目录 / icns）都由 `scripts/gen-icon.mjs` 生成。忘了生成时 electron-builder
// 会在**打包中途**报一句难懂的错（找不到 extraResources 文件 / 图标格式不支持），
// 而不是告诉我们"先跑 npm run icons"。
//
// 判据按平台取（icns 只能在 macOS 上生成，Windows/Linux 上缺它不算错）：
//   · 所有平台都要：build/icon.ico（Windows 与托盘）、build/icons/（linux.icon 只认 png 目录）
//   · Linux/macOS 还要：build/icon.png（extraResources → 运行时托盘/窗口图标）
//   · macOS 还要：build/icon.icns
// 另外顺手校验源图分辨率：electron-builder 的 icns/linux 图标转换要求源图 ≥512，
// 小于该尺寸会直接报错，前置发现比打包中途发现便宜。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUILD = path.join(ROOT, 'build')
const problems = []
const notes = []

const has = (rel) => fs.existsSync(path.join(BUILD, rel))
const sizeOf = (rel) => { try { return fs.statSync(path.join(BUILD, rel)).size } catch { return 0 } }

// 1) 必查项（按平台）
if (!has('icon.ico') || sizeOf('icon.ico') === 0) problems.push('build/icon.ico 缺失或为空（Windows 安装包与窗口图标）')
const iconsDir = path.join(BUILD, 'icons')
const iconPngs = (() => { try { return fs.readdirSync(iconsDir).filter((f) => f.endsWith('.png')) } catch { return [] } })()
if (iconPngs.length === 0) problems.push('build/icons/ 下没有 png（electron-builder 的 linux.icon 只认 png 目录）')
else if (!iconPngs.some((f) => f.startsWith('512x512') || f.startsWith('1024x1024'))) {
  problems.push(`build/icons/ 缺少 512 或 1024 档（现有 ${iconPngs.length} 个：${iconPngs.slice(0, 4).join(', ')}…）`)
}

if (process.platform === 'linux' || process.platform === 'darwin') {
  if (!has('icon.png') || sizeOf('icon.png') === 0) problems.push('build/icon.png 缺失（extraResources 要把它拷进 resources 供托盘/窗口使用）')
}
if (process.platform === 'darwin') {
  if (!has('icon.icns') || sizeOf('icon.icns') === 0) problems.push('build/icon.icns 缺失（macOS 应用图标；只能在 macOS 上生成）')
} else if (has('icon.icns')) {
  notes.push('build/icon.icns 存在（非 macOS 平台不会生成它，此处是别的机器留下的）')
}

// 2) 源图分辨率（生成图标的前提）
const src = process.env.DSH_ICON_SRC || path.join(ROOT, '..', 'dsh.jpeg')
if (has('icon.ico')) {
  // 已经生成过图标，说明源图此前是可用的；这里只在源图明显异常（0 字节）时提示
  try {
    const st = fs.statSync(src)
    if (st.size === 0) problems.push(`图标源图 ${src} 是 0 字节`)
  } catch { notes.push(`找不到图标源图 ${src}（已生成的图标仍可用；重新生成图标时才需要它）`) }
}

// 3) **vendor 树的平台必须与打包目标一致**
//
// 为什么这条必须挡在打包前：`extraResources` 是 `from: vendor` 的**整目录照拷**，
// electron-builder 完全不看里面装的是哪个平台的二进制。实测（2026-09-14）：在 Windows 上产
// Linux 包时忘了把 vendor 换成 linux 树，产物**照样"打包成功"**，但 resources/vendor 里全是
// win32-x64 的 koffi / node-pty ⇒ 那个包在 Linux 上**装上也起不来**（import 期崩）。
// 这类错误在打包日志里没有任何异常迹象，只有拆开产物看 vendor.lock.json 才发现得了。
// 判据取 lock 的 platform.tag 与本次打包目标比对；`DSH_PACK_PLATFORM` 可显式覆盖
// （本地交叉打包用，例如在 Windows 上产 Linux 包时设为 linux）。
const packPlatform = process.env.DSH_PACK_PLATFORM || process.platform
const VENDOR_LOCK = path.join(ROOT, 'vendor', 'vendor.lock.json')
if (!fs.existsSync(VENDOR_LOCK)) {
  problems.push('vendor/vendor.lock.json 不存在（先跑 npm run build:host 建树，打包要有树可打）')
} else {
  try {
    const lock = JSON.parse(fs.readFileSync(VENDOR_LOCK, 'utf8'))
    const lockOs = lock.platform?.os
    if (lockOs !== packPlatform) {
      problems.push(`vendor 树是给 **${lock.platform?.tag ?? lockOs ?? '（lock 无 platform 段：旧格式）'}** 的，`
        + `而这次打包的目标是 **${packPlatform}**。把别的平台的树打进包，产物能打出来但装上也起不来。`)
    } else {
      notes.push(`vendor 树平台与打包目标一致：${lock.platform.tag}（${lock.totalFiles} 文件 / ${(lock.totalBytes / 1048576).toFixed(1)} MB）`)
    }
  } catch (e) {
    problems.push(`vendor/vendor.lock.json 解析失败：${e.message}`)
  }
}

for (const n of notes) console.log(`  NOTE  ${n}`)
if (problems.length > 0) {
  console.error('打包前置资源检查未通过：')
  for (const p of problems) console.error(`  - ${p}`)
  console.error('\n修法：先跑 `npm run icons`（= 用 electron 执行 scripts/gen-icon.mjs）。')
  console.error('注意 .icns 只能在 macOS 上生成；Windows/Linux 上打包本平台产物不需要它。')
  console.error('vendor 平台不符时：`npm run build:host` 重建本平台树；交叉打包要用 --os/--out 另存，'
    + '并在打包前把该树放进 vendor/ —— electron-builder 不会替你换树。')
  process.exit(1)
}
console.log(`打包前置资源检查通过（打包目标 ${packPlatform}；icons=${iconPngs.length} 档；vendor 平台已核对）`)
