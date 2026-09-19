// jpeg-info.mjs — JPEG 结构诊断（纯 Node）：帧类型、扫描表、系数能量分布
//
// 用途：图标生成的解码器（`lib/jpeg-decode.mjs`）出问题时，先看这里 —— 它能直接回答
// "AC 系数到底解出来没有"（`acNonZeroBlocks` 为 0 或极小 ⇒ 高频丢失，画面会成块状）。
// 这类"看得见症状、看不见数据"的排查，光看图片是猜不出来的（写解码器时正是这么栽的一次）。
//
// 用法：node scripts/jpeg-info.mjs [图片路径]（默认仓库根的 dsh.jpeg）
import { decodeJpeg } from './lib/jpeg-decode.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = process.argv[2] || process.env.DSH_ICON_SRC || path.join(ROOT, '..', 'dsh.jpeg')

/** 最小结构解析（与解码器同一套规则，只读表与扫描头，不做熵解码）。 */
function structure(buf) {
  let p = 2
  let frame = null
  const scans = []
  const qt = new Set()
  const huff = new Set()
  while (p < buf.length - 1) {
    if (buf[p] !== 0xFF) { p++; continue }
    const mk = buf[p + 1]
    p += 2
    if (mk === 0xD8 || mk === 0x01 || (mk >= 0xD0 && mk <= 0xD7)) continue
    if (mk === 0xD9) break
    const len = (buf[p] << 8) | buf[p + 1]
    const end = p + len
    if (mk === 0xDB) for (let q = p + 2; q < end;) { const pq = buf[q] >> 4; qt.add(`${pq}:${buf[q] & 15}`); q++; q += pq === 0 ? 64 : 128 }
    else if (mk === 0xC4) for (let q = p + 2; q < end;) { const tc = buf[q] >> 4; const th = buf[q] & 15; q++; const counts = buf.subarray(q, q + 16); const total = [...counts].reduce((a, b) => a + b, 0); huff.add(`${tc}-${th}`); q += 16 + total }
    else if (mk >= 0xC0 && mk <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(mk)) {
      frame = { marker: mk, progressive: mk === 0xC2, precision: buf[p + 2], height: (buf[p + 3] << 8) | buf[p + 4], width: (buf[p + 5] << 8) | buf[p + 6], comps: buf[p + 7] }
    } else if (mk === 0xDA) {
      const ns = buf[p + 2]
      let q = p + 3
      const cs = []
      for (let i = 0; i < ns; i++) { cs.push(`${buf[q]}(dc${buf[q + 1] >> 4},ac${buf[q + 1] & 15})`); q += 2 }
      scans.push({ comps: cs, ss: buf[q], se: buf[q + 1], ah: buf[q + 2] >> 4, al: buf[q + 2] & 15 })
    }
    p = end
  }
  return { frame, scans, qt: [...qt], huff: [...huff] }
}

if (!fs.existsSync(SRC)) { console.error(`找不到图片：${SRC}`); process.exit(2) }
const buf = fs.readFileSync(SRC)
console.log(`文件: ${SRC}（${(buf.length / 1024).toFixed(0)} KB）`)
const st = structure(buf)
console.log('帧:', JSON.stringify(st.frame))
console.log('量化表:', st.qt.join(' '), '｜ 霍夫曼表:', st.huff.join(' '))
console.log(`扫描 ${st.scans.length} 个:`)
for (const [i, s] of st.scans.entries()) {
  console.log(`  #${i} comps=${s.comps.join('+')} ss=${s.ss} se=${s.se} ah=${s.ah} al=${s.al}`)
}

// 系数能量：直接看解码器写进树里的结果（它内部会按扫描逐次合并）
const diag = []
const img = decodeJpeg(buf, { onDiagnostic: (m, d) => diag.push([m, d]) })
console.log('\n解码器诊断:')
for (const [m, d] of diag) console.log(`  ${m} ${JSON.stringify(d)}`)

// 结构解析的交叉校验：把"跳段"的过程打出来。
// 为什么需要：如果解析把熵编码数据里的 `FF xx` 当成标记，扫描就会**只解析出第一个**，
// 而解码器随后按"渐进式但只有一个 DC 扫描"处理 ⇒ 高频全丢 ⇒ 画面成块（本轮真实故障形态）。
{
  let p = 2
  const trace = []
  const sosOffsets = []
  let guard = 0
  while (p < buf.length - 1 && guard++ < 20000) {
    if (buf[p] !== 0xFF) { p++; continue }
    const mk = buf[p + 1]
    if (mk === 0x00) { p += 2; continue }
    const start = p
    p += 2
    if (mk === 0xD8 || mk === 0x01 || (mk >= 0xD0 && mk <= 0xD7)) { trace.push(`@${start} FF${mk.toString(16)}（无长度）`); continue }
    if (mk === 0xD9) { trace.push(`@${start} FFD9 EOI`); break }
    const len = (buf[p] << 8) | buf[p + 1]
    const name = { 0xDB: 'DQT', 0xC4: 'DHT', 0xC0: 'SOF0', 0xC2: 'SOF2', 0xDD: 'DRI', 0xDA: 'SOS', 0xE0: 'APP0', 0xE1: 'APP1', 0xFE: 'COM' }[mk] ?? `FF${mk.toString(16)}`
    trace.push(`@${start} ${name} len=${len}`)
    if (mk === 0xDA) sosOffsets.push(start)
    p += len
  }
  console.log('\n段结构追踪（前 14 条）:')
  for (const t of trace.slice(0, 14)) console.log(`  ${t}`)
  console.log(`  … 共记录 ${trace.length} 段；SOS 出现 ${sosOffsets.length} 次；文件 ${buf.length} 字节`)

  // 熵数据里的原始 0xFF 序列：JPEG 要求 0xFF 后跟 0x00（字面量）或 RSTn；
  // 若是 0xFFDA/0xFFD9，说明扫描结束判断被"数据里的伪标记"骗了 —— 这是"只解析出 1 个扫描"的直接成因。
  const seq = new Map()
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0xFF && buf[i + 1] !== 0x00) {
      const k = buf[i + 1]
      seq.set(k, (seq.get(k) ?? 0) + 1)
    }
  }
  const fmt = [...seq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([k, v]) => `FF${k.toString(16).padStart(2, '0')}×${v}`).join('  ')
  console.log(`\n非填充的 0xFF 序列统计（前 8 多）：${fmt}`)
}

// 像素层面的"成块"检测：块间边界与块内的一阶差分能量比（块状伪影会让前者显著偏高）
const { width: W, height: H, data } = img
let innerDiff = 0, innerN = 0, edgeDiff = 0, edgeN = 0
for (let y = 1; y < H; y++) {
  for (let x = 1; x < W; x++) {
    const o = (y * W + x) * 4
    const l = (yy, xx) => { const oo = (yy * W + xx) * 4; return 0.299 * data[oo] + 0.587 * data[oo + 1] + 0.114 * data[oo + 2] }
    const dx = Math.abs(l(y, x) - l(y, x - 1))
    const dy = Math.abs(l(y, x) - l(y - 1, x))
    if (x % 8 === 0) { edgeDiff += dx; edgeN++ } else { innerDiff += dx; innerN++ }
    if (y % 8 === 0) { edgeDiff += dy; edgeN++ } else { innerDiff += dy; innerN++ }
  }
}
const inner = innerDiff / Math.max(1, innerN)
const edge = edgeDiff / Math.max(1, edgeN)
console.log(`\n像素一阶差分：块内平均 ${inner.toFixed(2)} ／ 块边界平均 ${edge.toFixed(2)} ／ 比值 ${(edge / Math.max(0.001, inner)).toFixed(2)}`)
console.log(edge / Math.max(0.001, inner) > 2.5
  ? '⚠️ 块边界明显高于块内 ⇒ 高频（AC）系数缺失，画面会成块状'
  : '块边界与块内相当 ⇒ 高频系数正常')
