// gen-icon.mjs — 从 workspace 根目录的 dsh.jpeg 生成多尺寸 build/icon.ico（PNG-in-ICO 容器）
// 用法（完整权限环境）：electron.exe scripts/gen-icon.mjs
// 产物覆盖 build/icon.ico：BrowserWindow / Tray / electron-builder win.icon 共用这一个文件。
import { app, nativeImage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = process.env.DSH_ICON_SRC || path.join(ROOT, '..', 'dsh.jpeg')
const DST = path.join(ROOT, 'build', 'icon.ico')
const SIZES = [256, 128, 64, 48, 32, 16]

// ICO 容器：ICONDIR(6) + ICONDIRENTRY(16*n) + 各尺寸 PNG 数据（Vista+ 全尺寸支持 PNG payload）
function icoFromPngs(pngs) {
  const count = pngs.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(count, 4)
  const entries = []
  let offset = 6 + 16 * count
  for (const { size, buf } of pngs) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0) // 256 记作 0
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2) // 无调色板
    e.writeUInt8(0, 3) // reserved
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32LE(buf.length, 8)
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    offset += buf.length
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.buf)])
}

app.whenReady().then(() => {
  const img = nativeImage.createFromPath(SRC)
  if (img.isEmpty()) { console.error(`FAIL: 无法解码源图 ${SRC}`); app.exit(2); return }
  console.log(`源图: ${img.getSize().width}x${img.getSize().height}`)
  const pngs = SIZES.map((s) => ({ size: s, buf: img.resize({ width: s, height: s, quality: 'best' }).toPNG() }))
  const ico = icoFromPngs(pngs)
  fs.writeFileSync(DST, ico)
  const check = nativeImage.createFromPath(DST)
  const ok = !check.isEmpty()
  console.log(`${DST}: ${ico.length} bytes, sizes=${SIZES.join('/')}, 回读=${ok ? check.getSize().width + 'x' + check.getSize().height : 'FAIL'}`)
  app.exit(ok ? 0 : 1)
})
