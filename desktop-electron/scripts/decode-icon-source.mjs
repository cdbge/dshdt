// decode-icon-source.mjs — 用 Electron 的 nativeImage 解码图标源图（BGRA→RGBA），交给 gen-icon.mjs。
// 必须在 Electron 里跑：node_modules\electron\dist\electron.exe scripts/decode-icon-source.mjs [--out <文件>]
import { app, nativeImage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = process.env.DSH_ICON_SRC || path.join(ROOT, '..', 'dsh.jpeg')
// 默认落点在仓库 build/ 下：写 os.tmpdir() 时提权/沙箱两种上下文的 TEMP 可能解析到不同目录，
// 生成器会找不到文件而静默退回自带解码器。
const argOf = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '' }
const OUT = argOf('--out') || process.env.DSH_ICON_RGBA_OUT || path.join(ROOT, 'build', 'icon-source.rgba')

app.whenReady().then(() => {
  const img = nativeImage.createFromPath(SRC)
  if (img.isEmpty()) { console.error(`FAIL: Electron 解不出源图 ${SRC}`); app.exit(2); return }
  const { width, height } = img.getSize()
  const bgra = img.toBitmap()
  if (bgra.length !== width * height * 4) {
    console.error(`FAIL: 位图字节数不符（${bgra.length} ≠ ${width}×${height}×4）`)
    app.exit(3); return
  }
  // BGRA → RGBA（原地交换）
  for (let i = 0; i < bgra.length; i += 4) {
    const b = bgra[i]
    bgra[i] = bgra[i + 2]
    bgra[i + 2] = b
  }
  fs.writeFileSync(OUT, bgra)
  fs.writeFileSync(`${OUT}.json`, JSON.stringify({ width, height, source: SRC, decoder: 'electron/nativeImage', at: new Date().toISOString() }, null, 2))
  console.log(`已写出 ${width}×${height} RGBA → ${OUT}`)
  console.log(`下一步：DSH_ICON_RGBA="${OUT}" node scripts/gen-icon.mjs`)
  app.exit(0)
})
