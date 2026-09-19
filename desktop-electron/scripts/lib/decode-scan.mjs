// decode-scan.mjs — JPEG 单扫描段解码（从 jpeg-decode.mjs 拆出来单独成文件）
//
// 为什么拆出来：这段逻辑在同一个函数里同时处理"基线 / 渐进首扫 / 渐进细化扫"三种形态，
// 圈复杂度高，而它在 jpeg-decode.mjs 里被多次增量编辑后**括号层级被改乱、语法都过不去**。
// 单独成文件后：结构一眼可见、可以单独 node --check、也便于后续按形态再拆。
//
// 三种形态（同一份循环骨架，按扫描头参数分派）：
//   · 基线（progressive === false）：一次解完 0..63 全部系数；
//   · 渐进首扫（ah === 0）：DC 写初值，或某段 AC（ss..se）写初值；
//   · 渐进细化扫（ah > 0）：DC 只补一位；AC 按 eobrun 与"逐位修正"规则细化。
// 失败时抛出，由调用方捕获 —— 并附上现场（段内偏移 / MCU 坐标 / eobrun / 非零系数个数），
// 没有这些数字，"码流错位"这类问题只能靠猜。

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]

/**
 * 熵编码段的比特读取器。**只在 [start, end) 内读**（end 由结构解析给出的下一个真标记位置），
 * 因此不必猜测数据边界，也就不会把扫描数据里的 `FF 00` 误当成标记。
 * 段内仍需处理字节填充：`FF 00` 表示字面量 0xFF。
 */
function makeBitReader(buf, start, end, onLookup = null) {
  let pos = start
  let cur = 0
  let left = 0
  const nextByte = () => {
    if (pos >= end) return 0
    const b = buf[pos++]
    if (b !== 0xFF) return b
    // 段内出现 0xFF：后面必须是 0x00（字面量）；RSTn 由 restartInterval 逻辑处理
    if (buf[pos] === 0x00) { pos++; return 0xFF }
    return 0xFF
  }
  return {
    bit() {
      if (left === 0) { cur = nextByte(); left = 8 }
      left--
      return (cur >> left) & 1
    },
    bits(n) { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | this.bit(); return v },
    /** 丢弃当前字节剩余位（重启边界前调用）。 */
    align() { left = 0 },
    /** 跳到指定偏移（重启时用于跨过 RST 标记）。 */
    seek(offset) { pos = offset; left = 0 },
    pos: () => pos,
    /** 诊断钩子：把"霍夫曼查找的比特与命中结果"报给调用方（仅在开启时使用）。 */
    onLookup: onLookup,
  }
}

/** 从霍夫曼表读一个符号；读不出来即视为码流错位（带段内偏移，便于定位）。 */
export function decodeHuff(br, table) {
  const startPos = br.pos()
  let code = 0
  for (let len = 1; len <= 16; len++) {
    code = (code << 1) | br.bit()
    const row = table[len]
    if (row === undefined) continue
    for (const [c, sym] of row) {
      if (c === code) {
        if (br.onLookup) br.onLookup({ tableDefined: true, bits: code.toString(2).padStart(len, '0'), codeLen: len, symbol: sym, byteOffset: startPos })
        return sym
      }
    }
  }
  if (br.onLookup) br.onLookup({ tableDefined: table !== undefined, bits: code.toString(2), codeLen: '未命中', symbol: null, byteOffset: startPos })
  throw new Error(`霍夫曼解码失败（码流错位或损坏：段内偏移 ${br.pos()}）`)
}

/** JPEG 的"扩展"：把 t 位有符号幅值还原成带符号整数。 */
const extend = (v, t) => (v < 1 << (t - 1) ? v - (1 << t) + 1 : v)

/**
 * 解码一个扫描段，把系数写进 `coeffsOf(comp)`。
 * @param {object} o 选项
 * @param {Buffer} o.buf 整个文件
 * @param {object} o.sc 扫描头（start/end/ss/se/ah/al/comps）
 * @param {object} o.frame 帧信息（comps 含采样率与块尺寸）
 * @param {object} o.huff 霍夫曼表（`0-0` / `1-0` 形式）
 * @param {number} o.restartInterval DRI 的重启间隔（0 表示无）
 * @param {boolean} o.progressive 是否渐进式
 * @param {Map<number,object>} o.byId 分量 id → 分量
 * @param {number} o.mcusX/o.mcusY MCU 网格
 * @param {(comp:object)=>Int32Array} o.coeffsOf 取系数数组（可指向临时缓冲）
 * @param {(comp:object)=>object} o.predOf 取 DC 预测视图（可指向临时缓冲）
 * @param {(m:string,d?:object)=>void} [o.onDiagnostic] 诊断回调
 * @returns {number} 本次扫描实际消耗的字节数
 */
export function decodeScan({ buf, sc, frame, huff, restartInterval, progressive, byId, mcusX, mcusY, coeffsOf, predOf, onDiagnostic = () => {} }) {
  // 诊断开关（环境变量 DSH_JPEG_TRACE=1）：把霍夫曼查找的头几次比特与结果打出来。
  // "刚开读就失败"（consumed 只有几个字节）只能靠这个区分："表选错了""比特流没对齐""边界算错了"
  // 是三种完全不同的原因，而它们的表象一模一样。
  const TRACE = process.env.DSH_JPEG_TRACE === '1'
  const trace = { count: 0 }
  const onHuffLookup = (info) => {
    if (!TRACE || trace.count >= 6) return
    trace.count++
    // 附上"解码器自己看到的"头 8 个字节 + **读取位置相对扫描起点的偏移**：
    // 与外部 dump 对照，能分辨"边界错"（偏移恒为 0 但字节对不上）与"中途错位"（偏移非 0）。
    const head = []
    for (let i = 0; i < 8 && sc.start + i < buf.length; i++) head.push(buf[sc.start + i].toString(16).padStart(2, '0'))
    onDiagnostic('trace-lookup', { ...info, scanHead: head.join(' '), relOffset: info.byteOffset - sc.start })
  }
  const br = makeBitReader(buf, sc.start, sc.end, onHuffLookup)
  // 每个扫描重置一次：否则前一个扫描（动辄几千次查找）会把配额占满，失败的那个扫描一次都看不到。
  trace.count = 0
  trace.scan = { start: sc.start, ss: sc.ss, se: sc.se, ah: sc.ah, al: sc.al }
  let eobrun = 0
  let mcu = 0
  let mx = 0
  let my = 0
  try {
    for (my = 0; my < mcusY; my++) {
      for (mx = 0; mx < mcusX; mx++) {
        // 重启间隔：对齐比特流、跨过 RSTn、清空 eobrun 与 DC 预测
        if (restartInterval > 0 && mcu > 0 && mcu % restartInterval === 0) {
          br.align()
          let p = br.pos()
          while (p < buf.length - 1 && !(buf[p] === 0xFF && buf[p + 1] >= 0xD0 && buf[p + 1] <= 0xD7)) {
            if (buf[p] === 0xFF && buf[p + 1] === 0x00) p += 2
            else if (buf[p] === 0xFF) break
            else p++
          }
          br.seek(Math.min(p + 2, sc.end))
          eobrun = 0
          for (const c of frame.comps) predOf(c).pred = 0
        }
        mcu++

        for (const cs of sc.comps) {
          const comp = byId.get(cs.id)
          if (comp === undefined) throw new Error(`扫描引用了不存在的分量 id=${cs.id}`)
          const coeffs = coeffsOf(comp)
          const view = predOf(comp)
          const dcTable = huff[`0-${cs.td}`]
          const acTable = huff[`1-${cs.ta}`]

          for (let by = 0; by < comp.v; by++) {
            for (let bx = 0; bx < comp.h; bx++) {
              const bl = mx * comp.h + bx
              const bc = my * comp.v + by
              if (bl >= comp.blocksPerLine || bc >= comp.blocksPerColumn) continue
              const off = (bc * comp.blocksPerLine + bl) * 64

              // ── 基线：一次解完全部系数 ──
              if (!progressive) {
                const t = decodeHuff(br, dcTable)
                const diff = t === 0 ? 0 : extend(br.bits(t), t)
                coeffs[off] = diff
                let k = 1
                while (k < 64) {
                  const rs = decodeHuff(br, acTable)
                  const r = rs >> 4
                  const s = rs & 15
                  if (s === 0) {
                    if (r === 15) { k += 16; continue }
                    break
                  }
                  k += r
                  if (k > 63) break
                  coeffs[off + ZIGZAG[k]] = extend(br.bits(s), s)
                  k++
                }
                continue
              }

              // ── 渐进式首扫（ah === 0）：写初值 ──
              if (sc.ah === 0) {
                if (sc.ss === 0) {
                  const t = decodeHuff(br, dcTable)
                  const diff = t === 0 ? 0 : extend(br.bits(t), t)
                  view.pred += diff
                  coeffs[off] = view.pred << sc.al
                }
                if (sc.se > 0) {
                  let k = sc.ss
                  while (k <= sc.se) {
                    const rs = decodeHuff(br, acTable)
                    const r = rs >> 4
                    const s = rs & 15
                    if (s === 0) {
                      if (r < 15) { eobrun = (1 << r) - 1; if (r > 0) eobrun += br.bits(r); break }
                      k += 16
                      continue
                    }
                    k += r
                    if (k > sc.se) break
                    coeffs[off + ZIGZAG[k]] = extend(br.bits(s), s) * (1 << sc.al)
                    k++
                  }
                }
                continue
              }

              // ── 渐进式细化扫（ah > 0）──
              //
              // 这段按**规范算法**写（P1/M1 双掩码 + 位置式细化 + EOBRUN 跨块递减）。
              // 第一版把它写成"先读符号再统一修正"，结果是**块状伪影 + 整体偏亮**：
              // 每块的 p1/m1 掩码被反复重置，同一个系数被加了两次，且 EOBRUN 的递减时机错位。
              // 下面是 libjpeg 的 decode_mcu_AC_refine 结构逐条对照翻译的，别再"简化"。
              const p1 = 1 << sc.al
              const m1 = (-1) << sc.al

              // DC 细化：只补一位（该位为 1 表示绝对值 +1<<al）
              if (sc.ss === 0) {
                if (br.bit() === 1) coeffs[off] += p1
                continue
              }

              let k = sc.ss
              // ① 有效 EOBRUN：本块不读符号，只做细化
              if (eobrun > 0) {
                while (k <= sc.se) {
                  const idx = off + ZIGZAG[k]
                  const cur = coeffs[idx]
                  if (cur !== 0 && br.bit() === 1) {
                    if ((cur & p1) === 0) coeffs[idx] += cur >= 0 ? p1 : m1
                  }
                  k++
                }
                eobrun--
                continue
              }

              // ② 读符号，按"修正—插入"两段走
              while (k <= sc.se) {
                const rs = decodeHuff(br, acTable)
                let r = rs >> 4
                const s = rs & 15
                if (s !== 0) {
                  // 细化扫里只允许 s=1：新的非零系数（符号用 1 位表示）
                  if (s !== 1) throw new Error(`细化扫里出现非法系数长度 s=${s}（段内偏移 ${br.pos()}）`)
                  const positive = br.bit() === 1
                  // 先跳过 r 个零系数，途中对"已非零"的做细化
                  while (k <= sc.se) {
                    const idx = off + ZIGZAG[k]
                    const cur = coeffs[idx]
                    if (cur !== 0) {
                      if (br.bit() === 1 && (cur & p1) === 0) coeffs[idx] += cur >= 0 ? p1 : m1
                    } else {
                      if (r === 0) break
                      r--
                    }
                    k++
                  }
                  if (k > sc.se) break
                  coeffs[off + ZIGZAG[k]] = positive ? p1 : m1
                  k++
                  continue
                }
                if (r < 15) {
                  // EOBRUN：本块之后的 r 个块 + 当前块剩余系数只做细化
                  eobrun = (1 << r) - 1
                  if (r > 0) eobrun += br.bits(r)
                  while (k <= sc.se) {
                    const idx = off + ZIGZAG[k]
                    const cur = coeffs[idx]
                    if (cur !== 0 && br.bit() === 1 && (cur & p1) === 0) coeffs[idx] += cur >= 0 ? p1 : m1
                    k++
                  }
                  eobrun--
                  break
                }
                // ZRL：跳过 16 个零系数，途中细化遇到的非零项
                let zeros = 16
                while (zeros > 0 && k <= sc.se) {
                  const idx = off + ZIGZAG[k]
                  const cur = coeffs[idx]
                  if (cur !== 0) {
                    if (br.bit() === 1 && (cur & p1) === 0) coeffs[idx] += cur >= 0 ? p1 : m1
                  } else {
                    zeros--
                  }
                  k++
                }
              }
            }
          }
        }
      }
    }
  } catch (e) {
    // 现场：段内偏移、MCU 坐标、eobrun、已写入的非零系数个数
    let nonZero = 0
    for (const c of frame.comps) {
      const arr = coeffsOf(c)
      for (let i = 0; i < arr.length; i++) if (arr[i] !== 0) nonZero++
    }
    onDiagnostic('scan-failed', {
      range: `${sc.start}-${sc.end}`,
      ss: sc.ss, se: sc.se, ah: sc.ah, al: sc.al,
      bitPos: br.pos(), consumed: br.pos() - sc.start, scanBytes: sc.end - sc.start,
      mcu: `${mx},${my}`, eobrun, nonZeroCoeffs: nonZero,
      message: e.message,
    })
    throw e
  }
  return br.pos() - sc.start
}

export { ZIGZAG, extend as _extend, makeBitReader as _makeBitReader }
