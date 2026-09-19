// decode-icon-source.mjs — 用 **Electron 的 nativeImage** 解码图标源图，把 RGBA 交给生成器
//
// 用法（必须在 Electron 里跑，不能直接用 node）：
//   node_modules\electron\dist\electron.exe scripts/decode-icon-source.mjs        # Windows
//   node_modules/electron/dist/electron scripts/decode-icon-source.mjs            # Linux
//   node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/…     # macOS
// 产物：<临时目录>/dsh-icon-source.rgba（+ 同名 .json 记录宽高）
// 然后：
//   DSH_ICON_RGBA=<该路径> node scripts/gen-icon.mjs
//
// 为什么需要这个中转：`gen-icon.mjs` 要在**不依赖 Electron** 的前提下工作（受限会话里 Electron
// 起不来，而打包前置检查必须能跑）。但"正确解码一张渐进式 JPEG"这件事，Chromium 的实现经过
// 充分验证，比自带解码器可靠得多 —— 所以把两者接起来：
//   · 能用 Electron 时 → 走这里（解码权威）→ 生成器只做缩放与编码；
//   · 不能时 → 生成器退回自带解码器（见 lib/jpeg-decode.mjs 顶部说明，渐进式色度仍有缺陷）。
//
// `nativeImage.toBitmap()` 返回的是 **BGRA**（Chromium 的 SkBitmap 布局），这里顺手换成 RGBA，
// 免得下游每个消费者各自记着这件事。
import { app, nativeImage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = process.env.DSH_ICON_SRC || path.join(ROOT, '..', 'dsh.jpeg')
// 支持 `--out <文件>`：**用仓库内固定路径最省事**。
// 踩过的坑：默认写 os.tmpdir()，而提权/沙箱两种执行上下文里 TEMP 解析到**不同目录**，
// 于是"解出来的 RGBA" 与 "生成器要找的文件" 根本不是一个路径 —— 生成器静默退回自带解码器、产出坏图标。
// 换个稳定的落点（build/ 下，已被 gitignore 覆盖）就没有这个歧义。
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
