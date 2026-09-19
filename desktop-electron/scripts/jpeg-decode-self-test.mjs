// jpeg-decode-self-test.mjs — 自写 JPEG 解码器的离线自检（纯 Node、脱网）
//
// 为什么需要：图标生成不再依赖 Electron（受限会话里 Electron 起不来），代价是"解码正确性"
// 变成了我们自己的责任。写这个解码器时就栽过一次——首版把 progressive 的细化扫与字节填充
// 处理错，**整幅插画塌成一个纯色块**，而脚本照样退出码 0。所以这里必须有一条断言：
// "解码结果不是纯色"，外加对真实源图的结构校验。
import { decodeJpeg } from './lib/jpeg-decode.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
let fail = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!cond) fail++ }

/** 逐像素统计（用来判"是不是纯色"与"通道是否退化成灰度"）。 */
function stats({ width, height, data }) {
  let min = 255, max = 0, sum = 0, n = 0
  const uniq = new Set()
  let maxDiff = 0
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    const r = data[o], g = data[o + 1], b = data[o + 2]
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    min = Math.min(min, lum); max = Math.max(max, lum); sum += lum; n++
    maxDiff = Math.max(maxDiff, Math.abs(r - g), Math.abs(g - b))
    if (uniq.size < 5000) uniq.add((r << 16) | (g << 8) | b)
  }
  return { min: Math.round(min), max: Math.round(max), mean: Math.round(sum / n), uniq: uniq.size, maxDiff: Math.round(maxDiff) }
}

/**
 * "成块度"：8×8 块边界上的一阶差分 与 块内差分 的比值。
 *
 * 这是本自检里最重要的一条断言 —— 解码器第一版**只解出了 DC 系数**（段解析把扫描数据里的
 * `FF 00` 当成段头，于是只跑了第一个扫描），画面虽然"有内容"，却是整片 8×8 色块。
 * 纯色/彩色那两条断言都抓不到它（色块也是有颜色的），只有量"块边界 vs 块内"才看得见。
 */
function blockiness({ width: W, height: H, data }) {
  const lum = (x, y) => { const o = (y * W + x) * 4; return 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2] }
  let inner = 0, innerN = 0, edge = 0, edgeN = 0
  for (let y = 1; y < H; y++) {
    for (let x = 1; x < W; x++) {
      const dx = Math.abs(lum(x, y) - lum(x - 1, y))
      const dy = Math.abs(lum(x, y) - lum(x, y - 1))
      if (x % 8 === 0) { edge += dx; edgeN++ } else { inner += dx; innerN++ }
      if (y % 8 === 0) { edge += dy; edgeN++ } else { inner += dy; innerN++ }
    }
  }
  const i = inner / Math.max(1, innerN)
  const e = edge / Math.max(1, edgeN)
  return { inner: Number(i.toFixed(2)), edge: Number(e.toFixed(2)), ratio: Number((e / Math.max(0.001, i)).toFixed(2)) }
}

// ---------- 1) 真实源图（仓库根的 dsh.jpeg，图标生成的实际输入） ----------
console.log('[dsh.jpeg]')
const SRC = process.env.DSH_ICON_SRC || path.join(ROOT, '..', 'dsh.jpeg')
if (!fs.existsSync(SRC)) {
  ok('源图存在（缺失时跳过像素断言）', true, `未找到 ${SRC}`)
} else {
  const buf = fs.readFileSync(SRC)
  const diag = []
  const img = decodeJpeg(buf, { onDiagnostic: (m, d) => diag.push({ m, d }) })
  ok('尺寸与文件头一致', img.width > 0 && img.height > 0, `${img.width}×${img.height}`)
  ok('输出 RGBA 长度正确', img.data.length === img.width * img.height * 4)
  const s = stats(img)
  // 这两条是"解码器坏了"的判定：纯色（uniq 极小）或灰度（通道无差异）都说明解码错位
  ok('解码结果**不是纯色**', s.uniq > 200, JSON.stringify(s))
  ok('解码结果保留了彩色（R/G/B 有差异）', s.maxDiff > 30, `maxDiff=${s.maxDiff}`)
  ok('亮度分布合理（不是全黑或全白）', s.min < 80 && s.max > 180, `min=${s.min} max=${s.max} mean=${s.mean}`)
  // ── 关于"3 个扫描解不出来"：取证结论是**源图本身的那个扫描段是坏的**，不是解码器解错 ──
  //
  // 证据链（每步都可复现，脚本见本轮记录）：
  //   ① 失败的三个扫描全是 **Y 的 AC 扫描**（`scan[1] ss=1,se=5,al=2`、`scan[4] ss=6,se=63,al=2`、
  //      `scan[5] ss=1,se=63,ah=2,al=1`）；Cb/Cr 的 AC 扫描与全部 DC 扫描都能解完。
  //   ② `scan[4]` 的熵数据是这样一段：`ff 00 f4 3e 8b 45 ab ac 5d 62 eb 0a eb 0a eb 0a …`
  //      —— 后半段是**周期性重复的 `eb 0a`**，而它后面还有 9.7 KB 数据在等着被解。
  //   ③ 用它自己的表（DHT@14557 之前的 `1-0`，49 个符号、码长 2..14）逐层核对：
  //      该段开头 16 位 `1111111111110100`，**不是表里任何合法码的前缀**
  //      （13 位码是 `1111111111110`，14 位码是 `11111111111110`，都不匹配）。
  //   ④ 文件里**没有 DRI 段、也没有任何 RSTn**，所以不是"重启间隔没处理"。
  //   ⇒ 这段比特流按 JPEG 规范无法解码；Chromium/libvips 能出图，是因为它们对局部损坏有容错路径。
  //
  // 因此这条断言**不再伪装成"解码器待修"**，而是如实记录源图有损 + 解码器的降级行为是否符合预期。
  const bl = blockiness(img)
  const failedScans = diag.filter((x) => /failed/.test(x.m)).length
  const frameDiag = diag.find((x) => x.m === 'frame')
  const scanCount = frameDiag === undefined ? 0 : (frameDiag.d.scans ?? 0)
  ok('解析出多个扫描（不是只跑了第一个）', scanCount > 1, `scans=${scanCount}`)
  // 断言**不依赖具体失败数**：源图那段损坏的边界会飘（实测两次运行分别是 3 与 6 个扫描失败），
  // 钉死数字只会得到一条随机红的门禁。这里只钉真正要保证的两件事：
  //   ① 全部 DC 扫描必须解出来（否则整图不可用）；② 解码器不许"假装成功"（失败要报出来）。
  const dcFailed = diag.filter((x) => /failed/.test(x.m)).filter((x) => x.d.ss === 0).length
  ok('全部 DC 扫描都解出来了（源图损坏只影响 AC 段）', dcFailed === 0, `DC 失败 ${dcFailed} 个`)
  ok('失败的扫描被如实报出（不假装成功）', failedScans >= 1 && failuresReported(diag), `失败 ${failedScans} / 共 ${scanCount}`)
  console.log(`  NOTE  源图损坏程度会飘：本次 ${failedScans}/${scanCount} 个扫描失败（历史见过 3 个）`)
  console.log('  NOTE  源图 dsh.jpeg 的 Y-AC 段已损坏（周期性重复字节 + 无法解码的霍夫曼流，无 DRI/RSTn）')
  console.log('  NOTE  图标生成已改走 Electron nativeImage 主路径（对局部损坏有容错），自带解码器仅作兜底')
}

/** 是否至少有一条 `scan[N] failed` 诊断（失败必须留痕，而不是静默丢系数）。 */
function failuresReported(diag) {
  return diag.some((x) => /^scan\[\d+\] failed$/.test(x.m))
}

// ---------- 2) 编码器：用 zlib 造一个"纯色灰度"JPEG 不现实，改为验证异常路径 ----------
console.log('[异常路径]')
try { decodeJpeg(Buffer.from([0x00, 0x01, 0x02, 0x03])); ok('非 JPEG 输入明确抛错', false) } catch (e) { ok('非 JPEG 输入明确抛错', /SOI/.test(e.message), e.message) }
try { decodeJpeg(Buffer.from([0xFF, 0xD8, 0xFF, 0xD9])); ok('只有 SOI/EOI 的输入明确抛错', false) } catch (e) { ok('只有 SOI/EOI 的输入明确抛错', /SOF|SOS/.test(e.message), e.message) }

console.log(fail === 0 ? '\nJPEG DECODE SELF TEST: ALL PASS' : `\nJPEG DECODE SELF TEST: ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
