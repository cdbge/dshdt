// gen-icon.mjs — 从仓库根 dsh.jpeg 生成 Windows/Linux 图标（纯 Node，不依赖 Electron，解码走 lib/jpeg-decode.mjs、编码用 zlib）。
// 用法：node scripts/gen-icon.mjs（可用 DSH_ICON_SRC 指定源图；要求源图最短边 ≥512）
import { decodeJpeg } from './lib/jpeg-decode.mjs'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = process.env.DSH_ICON_SRC || path.join(ROOT, '..', 'dsh.jpeg')
// --rgba <文件>：用外部（Electron nativeImage）解好的 RGBA 当源，见 decode-icon-source.mjs。
// 命令行参数优先于环境变量：跨调用传环境变量容易"看起来设了、其实没传到"，那样会静默退回自带解码器。
const argOf = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '' }
const RGBA_ARG = argOf('--rgba') || process.env.DSH_ICON_RGBA || ''
const DST_ICO = path.join(ROOT, 'build', 'icon.ico')
const DST_PNG = path.join(ROOT, 'build', 'icon.png')
const ICONS_DIR = path.join(ROOT, 'build', 'icons')
const ICO_SIZES = [256, 128, 64, 48, 32, 16]
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]


const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (buf) => {
  let c = 0xFFFFFFFF
  for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}
const chunk = (type, data) => {
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

// RGBA → PNG（filter 全 0，zlib 最高压缩）
function encodePng({ width, height, data }) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0 // filter: none
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * stride + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// 归一化盒式缩放（源图通常远大于目标尺寸，观感足够且实现短）
function resize({ width, height, data }, tw, th) {
  const out = new Uint8Array(tw * th * 4)
  for (let y = 0; y < th; y++) {
    const sy0 = Math.floor((y * height) / th)
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * height) / th))
    for (let x = 0; x < tw; x++) {
      const sx0 = Math.floor((x * width) / tw)
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * width) / tw))
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const o = (sy * width + sx) * 4
          r += data[o]; g += data[o + 1]; b += data[o + 2]; a += data[o + 3]
          n++
        }
      }
      const o2 = (y * tw + x) * 4
      out[o2] = Math.round(r / n); out[o2 + 1] = Math.round(g / n); out[o2 + 2] = Math.round(b / n); out[o2 + 3] = Math.round(a / n)
    }
  }
  return { width: tw, height: th, data: out }
}

// ICO 容器：ICONDIR(6) + ICONDIRENTRY(16*n) + 各尺寸 PNG 数据（Vista+ 支持 PNG payload）
function icoFromPngs(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  const entries = []
  let offset = 6 + 16 * pngs.length
  for (const { size, buf } of pngs) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2)
    e.writeUInt8(0, 3)
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(buf.length, 8)
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    offset += buf.length
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.buf)])
}


// ────────────────────────── 主流程 ──────────────────────────

const t0 = Date.now()
let img = null
let imgSource = ''

// 源图两条路，优先那条经过验证的：① DSH_ICON_RGBA（decode-icon-source.mjs 用 Chromium 解码器解出）；
// ② 自带 lib/jpeg-decode.mjs（受限环境兜底；渐进式 JPEG 的色度仍有缺陷）。
const rgbaFile = RGBA_ARG
if (rgbaFile !== '' && fs.existsSync(rgbaFile)) {
  const meta = JSON.parse(fs.readFileSync(`${rgbaFile}.json`, 'utf8'))
  const raw = fs.readFileSync(rgbaFile)
  if (raw.length !== meta.width * meta.height * 4) {
    console.error(`FAIL: RGBA 字节数不符（${raw.length} ≠ ${meta.width}×${meta.height}×4）`)
    process.exit(4)
  }
  img = { width: meta.width, height: meta.height, data: new Uint8Array(raw.buffer, raw.byteOffset, raw.length) }
  imgSource = `Electron nativeImage（${rgbaFile}）`
} else {
  if (!fs.existsSync(SRC)) { console.error(`FAIL: 找不到图标源图 ${SRC}（可用 DSH_ICON_SRC 指定）`); process.exit(2) }
  const srcBuf = fs.readFileSync(SRC)
  if (srcBuf.length === 0) { console.error(`FAIL: 图标源图是空文件 ${SRC}`); process.exit(2) }
  try {
    img = decodeJpeg(srcBuf)
    imgSource = `自带解码器（${SRC}）`
  } catch (e) {
    console.error(`FAIL: 解码源图失败（${e.message}）。`)
    console.error('优先方案：先用 `node scripts/decode-icon-source.mjs` 在 Electron 里解出 RGBA 再生成（见该文件用法）。')
    console.error('自带解码器的定位见 scripts/lib/jpeg-decode.mjs 顶部注释（渐进式色度仍有缺陷，作兜底）。')
    process.exit(4)
  }
}
console.log(`源图: ${imgSource} (${img.width}×${img.height})`)
const min = Math.min(img.width, img.height)
if (min < 512) {
  console.error(`FAIL: 源图最短边 ${min} < 512。electron-builder 的图标转换要求 ≥512（推荐 1024）。`)
  process.exit(3)
}

fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true })
// 不要放大：源图 512 时把主图写成 1024 只是插值，文件更大、观感更糊
const MASTER = Math.min(1024, min)
const pngAt = (size) => encodePng(resize(img, size, size))

const ico = icoFromPngs(ICO_SIZES.map((s) => ({ size: s, buf: pngAt(s) })))
fs.writeFileSync(DST_ICO, ico)
console.log(`${DST_ICO}: ${ico.length} bytes, sizes=${ICO_SIZES.join('/')}`)

const master = pngAt(MASTER)
fs.writeFileSync(DST_PNG, master)
console.log(`${DST_PNG}: ${master.length} bytes, ${MASTER}×${MASTER}${MASTER < 1024 ? '（受源图限制；换更大源图可提升到 1024）' : ''}`)

fs.rmSync(ICONS_DIR, { recursive: true, force: true })
fs.mkdirSync(ICONS_DIR, { recursive: true })
for (const s of PNG_SIZES) fs.writeFileSync(path.join(ICONS_DIR, `${s}x${s}.png`), pngAt(s))
console.log(`${ICONS_DIR}: ${PNG_SIZES.length} 个尺寸（${PNG_SIZES.join('/')}）`)

console.log(`完成（${((Date.now() - t0) / 1000).toFixed(1)}s）`)
// 退出码：ico / png 是打包的硬依赖，缺任何一个都该当场红
const missing = [DST_ICO, DST_PNG].filter((p) => !fs.existsSync(p))
if (missing.length > 0) {
  console.error(`FAIL: 缺少生成物 ${missing.join(', ')}`)
  process.exit(1)
}
process.exit(0)
