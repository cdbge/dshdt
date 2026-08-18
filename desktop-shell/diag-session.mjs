// 诊断会话日志：逐帧解压 zstd → 检查 seq 连续性 → 定位异常
import { zstdDecompressSync } from 'node:zlib'
import fs from 'node:fs'

const file = process.argv[2]
const buf = fs.readFileSync(file)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const starts = []
for (let i = 0; i <= buf.length - 4; i++) {
  if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i)
}
let out = Buffer.alloc(0)
let frameErr = null
for (let f = 0; f < starts.length; f++) {
  const end = f + 1 < starts.length ? starts[f + 1] : buf.length
  try { out = Buffer.concat([out, zstdDecompressSync(buf.subarray(starts[f], end))]) }
  catch (e) { frameErr = `${e.message} @frame${f}(${starts[f]})`; break }
}
if (frameErr) { console.error('frame decompress failed:', frameErr); process.exit(1) }
const lines = out.toString('utf8').split('\n').filter((l) => l.trim())
console.log(`frames: ${starts.length}, bytes ${buf.length} -> ${out.length}, decoded lines: ${lines.length}`)

function range(obj) {
  if (typeof obj.seq === 'number') return { start: obj.seq, end: obj.seq, packed: false }
  if (typeof obj.seq0 === 'number') {
    const n = Array.isArray(obj.data?.dt) ? obj.data.dt.length + 1 : 1
    return { start: obj.seq0, end: obj.seq0 + n - 1, packed: true }
  }
  return null
}

let lastEnd = -1
let anomalies = 0
for (let i = 0; i < lines.length; i++) {
  let obj
  try { obj = JSON.parse(lines[i]) } catch {
    if (anomalies < 5) console.log(`LINE ${i + 1}: unparseable: ${lines[i].slice(0, 120)}`)
    anomalies++
    continue
  }
  const r = range(obj)
  if (!r) continue
  if (lastEnd >= 0) {
    if (r.start <= lastEnd) {
      anomalies++
      if (anomalies <= 6) {
        const kind = r.start === lastEnd ? 'DUPLICATE-BOUNDARY' : r.start < lastEnd ? 'OVERLAP/REGRESSION' : '??'
        console.log(`ANOMALY line ${i + 1} [${kind}]: prev covered ..${lastEnd}, this starts ${r.start}`)
        console.log(`  prev (${i}): ${lines[i - 1].slice(0, 180)}`)
        console.log(`  this (${i + 1}): ${lines[i].slice(0, 180)}`)
      }
    } else if (r.start > lastEnd + 1) {
      anomalies++
      if (anomalies <= 6) console.log(`ANOMALY line ${i + 1} [GAP]: prev ..${lastEnd}, this starts ${r.start} (missing ${lastEnd + 1}..${r.start - 1})`)
    }
  }
  if (r.end > lastEnd) lastEnd = r.end
}
console.log(`anomalies: ${anomalies}, last seq covered: ${lastEnd}`)
console.log(`tail line: ${lines[lines.length - 1].slice(0, 200)}`)
console.log('--- lines 1-6 ---')
for (let i = 0; i < 6; i++) console.log(`${i + 1}: ${lines[i].slice(0, 220)}`)
console.log('--- lines 3130-3136 ---')
for (let i = 3129; i < 3136 && i < lines.length; i++) console.log(`${i + 1}: ${lines[i].slice(0, 400)}`)
console.log('--- lines 25-34 ---')
for (let i = 24; i < 34 && i < lines.length; i++) console.log(`${i + 1}: ${lines[i].slice(0, 400)}`)
const types = {}
for (const l of lines) { const t = JSON.parse(l).type || '?'; types[t] = (types[t] || 0) + 1 }
console.log('--- type histogram ---')
console.log(JSON.stringify(types, null, 0).slice(0, 800))
