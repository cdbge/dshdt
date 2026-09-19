// check-assets.mjs — 打包前置资源检查（纯 Node、脱网、秒级）：图标生成物齐不齐、
// 源图尺寸、以及 vendor 树的平台是否与本次打包目标一致。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUILD = path.join(ROOT, 'build')
const problems = []
const notes = []

const has = (rel) => fs.existsSync(path.join(BUILD, rel))
const sizeOf = (rel) => { try { return fs.statSync(path.join(BUILD, rel)).size } catch { return 0 } }

if (!has('icon.ico') || sizeOf('icon.ico') === 0) problems.push('build/icon.ico 缺失或为空（Windows 安装包与窗口图标）')
const iconsDir = path.join(BUILD, 'icons')
const iconPngs = (() => { try { return fs.readdirSync(iconsDir).filter((f) => f.endsWith('.png')) } catch { return [] } })()
if (iconPngs.length === 0) problems.push('build/icons/ 下没有 png（electron-builder 的 linux.icon 只认 png 目录）')
else if (!iconPngs.some((f) => f.startsWith('512x512') || f.startsWith('1024x1024'))) {
  problems.push(`build/icons/ 缺少 512 或 1024 档（现有 ${iconPngs.length} 个：${iconPngs.slice(0, 4).join(', ')}…）`)
}

if (process.platform === 'linux') {
  if (!has('icon.png') || sizeOf('icon.png') === 0) problems.push('build/icon.png 缺失（extraResources 要把它拷进 resources 供托盘/窗口使用）')
}


const src = process.env.DSH_ICON_SRC || path.join(ROOT, '..', 'dsh.jpeg')
if (has('icon.ico')) {
  // 已生成过图标说明源图此前可用，只在源图 0 字节时提示
  try {
    const st = fs.statSync(src)
    if (st.size === 0) problems.push(`图标源图 ${src} 是 0 字节`)
  } catch { notes.push(`找不到图标源图 ${src}（已生成的图标仍可用；重新生成图标时才需要它）`) }
}

// vendor 树的平台必须与打包目标一致：extraResources 是整目录照拷，electron-builder 不看里面是哪个平台的二进制，
// 别的平台的树也能"打包成功"但装不上。DSH_PACK_PLATFORM 可显式覆盖目标平台（本地交叉打包用）。
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
  console.error('\n修法：先跑 `npm run icons`（= `node scripts/gen-icon.mjs`，纯 Node、不需要 Electron/显示）。')
    console.error('vendor 平台不符时：`npm run build:host` 重建本平台树；交叉打包要用 --os/--out 另存，'
    + '并在打包前把该树放进 vendor/ —— electron-builder 不会替你换树。')
  process.exit(1)
}
console.log(`打包前置资源检查通过（打包目标 ${packPlatform}；icons=${iconPngs.length} 档；vendor 平台已核对）`)
