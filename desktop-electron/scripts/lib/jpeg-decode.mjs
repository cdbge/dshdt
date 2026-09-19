// jpeg-decode.mjs — 最小 JPEG 解码器（纯 Node，零依赖），供 gen-icon.mjs 在不起 Electron 的前提下解码源图。
// 支持 baseline（SOF0）与 progressive（SOF2）、8bit、1/3 分量（灰度与 YCbCr，含子采样）；不支持算术编码与 12bit。
import { decodeScan, decodeHuff } from './decode-scan.mjs'

/** 霍夫曼表：codes[len] = [[code, symbol], ...] */
function buildHuffman(counts, symbols) {
  const codes = []
  let code = 0
  let k = 0
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < counts[len - 1]; i++) {
      if (codes[len] === undefined) codes[len] = []
      codes[len].push([code++, symbols[k++]])
    }
    code <<= 1
  }
  return codes
}

// 标记名（诊断用）
function markerName(m) {
  return { 0xDB: 'DQT', 0xC4: 'DHT', 0xC0: 'SOF0', 0xC1: 'SOF1', 0xC2: 'SOF2', 0xC3: 'SOF3', 0xDD: 'DRI', 0xDA: 'SOS', 0xE0: 'APP0', 0xE1: 'APP1', 0xE2: 'APP2', 0xEE: 'APP14', 0xFE: 'COM' }[m] ?? `ff${m.toString(16)}`
}

// 把文件走一遍，逐个真标记地解析结构。
// 若一律按长度跳，FF 00 会被当成 marker=0x00 的段头，于是只解析出第一个扫描、后续全丢。
function parseStructure(buf) {
  let p = 2
  const qt = {}
  const huff = {}
  let frame = null
  let restartInterval = 0
  const scans = []
  const trace = []
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) throw new Error('不是 JPEG（缺 SOI）')
  while (p < buf.length - 1) {
    if (buf[p] !== 0xFF) { p++; continue }
    const marker = buf[p + 1]
    if (marker === 0x00) { p += 2; continue } // 段外的填充字节：不是标记
    const at = p
    p += 2
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { trace.push(`ff${marker.toString(16)}@${at}`); continue }
    if (marker === 0xD9) { trace.push(`EOI@${at}`); break }
    const len = (buf[p] << 8) | buf[p + 1]
    const end = p + len
    trace.push(`${markerName(marker)}@${at}`)
    if (marker === 0xDB) {
      let q = p + 2
      while (q < end) {
        const pq = buf[q] >> 4
        const tq = buf[q] & 15
        q++
        const t = new Uint16Array(64)
        for (let i = 0; i < 64; i++) {
          if (pq === 0) t[i] = buf[q++]
          else { t[i] = (buf[q] << 8) | buf[q + 1]; q += 2 }
        }
        qt[tq] = t
      }
      p = end
    } else if (marker === 0xC4) {
      let q = p + 2
      while (q < end) {
        const tc = buf[q] >> 4
        const th = buf[q] & 15
        q++
        const counts = Array.from(buf.subarray(q, q + 16)); q += 16
        const total = counts.reduce((a, b) => a + b, 0)
        const symbols = Array.from(buf.subarray(q, q + total)); q += total
        huff[`${tc}-${th}`] = buildHuffman(counts, symbols)
      }
      p = end
    } else if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
      const precision = buf[p + 2]
      const height = (buf[p + 3] << 8) | buf[p + 4]
      const width = (buf[p + 5] << 8) | buf[p + 6]
      const n = buf[p + 7]
      let q = p + 8
      const comps = []
      for (let i = 0; i < n; i++) {
        const id = buf[q]
        const hv = buf[q + 1]
        comps.push({ id, h: hv >> 4, v: hv & 15, tq: buf[q + 2] })
        q += 3
      }
      frame = { marker, precision, width, height, comps }
      p = end
    } else if (marker === 0xDD) {
      restartInterval = (buf[p + 2] << 8) | buf[p + 3]
      p = end
    } else if (marker === 0xDA) {
      const ns = buf[p + 2]
      let q = p + 3
      const comps = []
      for (let i = 0; i < ns; i++) {
        comps.push({ id: buf[q], td: buf[q + 1] >> 4, ta: buf[q + 1] & 15 })
        q += 2
      }
      const header = { comps, ss: buf[q], se: buf[q + 1], ah: buf[q + 2] >> 4, al: buf[q + 2] & 15 }
      // 熵数据：逐字节找下一个真标记（FF00 是字面量、FFD0..D7 是重启标记，都要继续走）
      let r = end
      while (r < buf.length - 1) {
        if (buf[r] !== 0xFF) { r++; continue }
        const b = buf[r + 1]
        if (b === 0x00 || (b >= 0xD0 && b <= 0xD7)) { r += 2; continue }
        if (b === 0xFF) { r++; continue }
        break
      }
      scans.push({ ...header, start: end, end: r })
      p = r
    } else {
      p = end
    }
  }
  if (frame === null) throw new Error('JPEG 里没有 SOF（帧头）')
  return { frame, scans, qt, huff, restartInterval, trace }
}

// 解码 JPEG，返回 {width, height, data}（RGBA）。
// maxScans 只解前 N 个扫描（受控实验用）；onDiagnostic 收诊断信息（排查解码问题时用）。
export function decodeJpeg(buf, { onDiagnostic = () => {}, maxScans = Infinity } = {}) {
  const { frame, scans: allScans, qt, huff, restartInterval, trace } = parseStructure(buf)
  const scans = allScans.slice(0, maxScans)
  const progressive = frame.marker === 0xC2
  if (frame.precision !== 8) throw new Error(`只支持 8bit 采样（该图 ${frame.precision}bit）`)
  if (scans.length === 0) throw new Error('JPEG 里没有 SOS（扫描头）')
  onDiagnostic('frame', { marker: `0x${frame.marker.toString(16)}`, progressive, width: frame.width, height: frame.height, comps: frame.comps.length, scans: scans.length, restartInterval, trace: trace.join(' ') })

  const hMax = Math.max(...frame.comps.map((c) => c.h))
  const vMax = Math.max(...frame.comps.map((c) => c.v))
  const byId = new Map()
  for (const c of frame.comps) {
    c.blocksPerLine = Math.ceil((frame.width * c.h) / hMax / 8)
    c.blocksPerColumn = Math.ceil((frame.height * c.v) / vMax / 8)
    c.coeffs = new Int32Array(c.blocksPerLine * c.blocksPerColumn * 64)
    c.pred = 0
    byId.set(c.id, c)
  }
  const mcusX = Math.ceil(frame.width / (hMax * 8))
  const mcusY = Math.ceil(frame.height / (vMax * 8))

  // 逐扫描解码，先算到临时缓冲、整段成功才提交：扫描失败时若把半截结果留在树上，
  // 后续细化扫会在被污染的系数上继续解，一个扫描失败会滚成后面全崩。
  const scratch = frame.comps.map((c) => ({ id: c.id, coeffs: Int32Array.from(c.coeffs), pred: 0 }))
  const scratchById = new Map(scratch.map((s) => [s.id, s]))
  const failures = []
  let okScans = 0
  for (const [si, sc] of scans.entries()) {
    for (const s of scratch) { s.pred = 0; s.coeffs.set(byId.get(s.id).coeffs) }
    try {
      const consumed = decodeScan({
        buf, sc, frame, huff, restartInterval, progressive, byId, mcusX, mcusY, onDiagnostic,
        coeffsOf: (comp) => scratchById.get(comp.id).coeffs,
        predOf: (comp) => scratchById.get(comp.id),
      })
      for (const s of scratch) byId.get(s.id).coeffs.set(s.coeffs)
      okScans += 1
      onDiagnostic(`scan[${si}] ok`, {
        range: `${sc.start}-${sc.end}`, scanBytes: sc.end - sc.start, consumed,
        ss: sc.ss, se: sc.se, ah: sc.ah, al: sc.al,
      })
    } catch (e) {
      failures.push({ scan: si, range: `${sc.start}-${sc.end}`, scanBytes: sc.end - sc.start, ss: sc.ss, se: sc.se, ah: sc.ah, al: sc.al, message: e.message })
      onDiagnostic(`scan[${si}] failed`, failures[failures.length - 1])
    }
  }
  // 失败处理口径：单扫描失败时保留它已写进去的系数（细化扫是"补充"语义），失败项经 onDiagnostic 暴露，
  // 绝不伪造数据；只有一个成功扫描都没有、或 DC 首扫（ss=0, ah=0）失败时才判整图失败。
  const dcScanFailed = failures.some((f) => f.ss === 0 && f.ah === 0)
  if (okScans === 0 || dcScanFailed) {
    const detail = failures.map((f) => `#${f.scan}(ss=${f.ss},se=${f.se},ah=${f.ah}): ${f.message}`).join('；')
    throw new Error(`JPEG 解码失败（成功扫描 ${okScans}/${scans.length}${dcScanFailed ? '，且 DC 首扫失败' : ''}）：${detail}`)
  }
  if (failures.length > 0) {
    onDiagnostic('partial-failure-summary', {
      note: '部分扫描失败：结果仍可用，但高频细化不完整（画面会偏软/轻微成块）',
      failedScans: failures.map((f) => f.scan),
      okScans, totalScans: scans.length,
    })
  }

  // 反量化 + 反 DCT
  const T = new Float32Array(64)
  for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++) T[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16)
  const reconstruct = (coeffs, off, q) => {
    const c = new Float32Array(64)
    for (let i = 0; i < 64; i++) c[i] = coeffs[off + i] * q[i]
    const out = new Float32Array(64)
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        let sum = 0
        for (let v = 0; v < 8; v++) {
          const cv = v === 0 ? Math.SQRT1_2 : 1
          for (let u = 0; u < 8; u++) {
            const cu = u === 0 ? Math.SQRT1_2 : 1
            sum += cu * cv * c[v * 8 + u] * T[u * 8 + x] * T[v * 8 + y]
          }
        }
        out[y * 8 + x] = sum / 4 + 128
      }
    }
    return out
  }
  const planes = frame.comps.map((comp) => {
    const w = comp.blocksPerLine * 8
    const h = comp.blocksPerColumn * 8
    const plane = new Float32Array(w * h)
    const q = qt[comp.tq] ?? qt[0]
    for (let by = 0; by < comp.blocksPerColumn; by++) {
      for (let bx = 0; bx < comp.blocksPerLine; bx++) {
        const px = reconstruct(comp.coeffs, (by * comp.blocksPerLine + bx) * 64, q)
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) plane[(by * 8 + y) * w + bx * 8 + x] = px[y * 8 + x]
        }
      }
    }
    return { plane, w, h }
  })

  const W = frame.width
  const H = frame.height
  const sample = (i, x, y) => {
    const comp = frame.comps[i]
    const pl = planes[i]
    const sx = Math.min(pl.w - 1, Math.floor((x * comp.h) / hMax))
    const sy = Math.min(pl.h - 1, Math.floor((y * comp.v) / vMax))
    return pl.plane[sy * pl.w + sx]
  }
  const gray = frame.comps.length === 1
  const rgba = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r, g, b
      if (gray) { r = g = b = sample(0, x, y) }
      else {
        const Y = sample(0, x, y)
        const Cb = sample(1, x, y) - 128
        const Cr = sample(2, x, y) - 128
        r = Y + 1.402 * Cr
        g = Y - 0.344136 * Cb - 0.714136 * Cr
        b = Y + 1.772 * Cb
      }
      const o = (y * W + x) * 4
      rgba[o] = r < 0 ? 0 : r > 255 ? 255 : Math.round(r)
      rgba[o + 1] = g < 0 ? 0 : g > 255 ? 255 : Math.round(g)
      rgba[o + 2] = b < 0 ? 0 : b > 255 ? 255 : Math.round(b)
      rgba[o + 3] = 255
    }
  }
  onDiagnostic('decoded', { width: W, height: H, comps: frame.comps.length, gray, okScans, failedScans: failures.length })
  return { width: W, height: H, data: rgba }
}

export { decodeHuff as _decodeHuff }
