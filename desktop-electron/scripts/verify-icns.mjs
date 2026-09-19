// verify-icns.mjs — 独立核验 .icns 容器结构（不复用生成器的任何代码，纯读字节）
//
// 为什么要单独验：`.icns` 是"容器 + 若干 PNG"这件事只有验过才算数——生成器自己说 OK 不算证据。
// 判据（对着 Apple 的 icns 格式）：
//   ① 头 4 字节是 'icns'，紧接着 4 字节总长度**必须等于文件实际长度**
//   ② 每个成员：4 字节类型码 + 4 字节长度（含 8 字节头），长度之和必须正好走到文件末尾（不许有缝/越界）
//   ③ 每个成员的载荷必须是**合法 PNG**（签名 + IHDR），且 IHDR 里的宽高要等于该类型码约定的尺寸
//   ④ 必需的尺寸档位齐全（16/32/64/128/256/512/1024），否则 macOS 会在某些场景下取不到图标
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const FILE = process.argv[2] || path.join(ROOT, 'build', 'icon.icns')
let fail = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!cond) fail++ }

if (!fs.existsSync(FILE)) { console.error(`没有 ${FILE}`); process.exit(2) }
const buf = fs.readFileSync(FILE)
console.log(`[icns] ${FILE}  ${buf.length} bytes`)

ok('头 4 字节是 icns', buf.toString('ascii', 0, 4) === 'icns', buf.toString('ascii', 0, 4))
const declared = buf.readUInt32BE(4)
ok('头部声明的总长度 == 文件实际长度', declared === buf.length, `声明 ${declared} / 实际 ${buf.length}`)

// 类型码 → 期望边长（Apple 的现代 PNG 类型码）
const EXPECT = {
  icp4: 16, icp5: 32, icp6: 64, ic07: 128, ic08: 256, ic09: 512, ic10: 1024,
  ic11: 32, ic12: 64, ic13: 256, ic14: 512,
}
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
const members = []
let off = 8
let walked = true
while (off < buf.length) {
  if (off + 8 > buf.length) { walked = false; break }
  const type = buf.toString('ascii', off, off + 4)
  const len = buf.readUInt32BE(off + 4)
  if (len < 8 || off + len > buf.length) {
    console.log(`  FAIL  成员 ${type} 长度越界：len=${len} off=${off} 文件长=${buf.length}`)
    fail++
    walked = false
    break
  }
  const payload = buf.subarray(off + 8, off + len)
  const isPng = payload.subarray(0, 8).equals(PNG_SIG)
  let w = -1
  let h = -1
  if (isPng && payload.length >= 24) { w = payload.readUInt32BE(16); h = payload.readUInt32BE(20) }
  members.push({ type, len, isPng, w, h, bytes: payload.length })
  off += len
}
ok('成员表正好走到文件末尾（无缝隙/无越界）', walked && off === buf.length, `走到 ${off}`)
ok('成员数 ≥ 10', members.length >= 10, `实际 ${members.length}`)
console.log('  成员明细：')
for (const m of members) console.log(`    ${m.type}  len=${String(m.len).padStart(8)}  png=${m.isPng ? 'yes' : 'NO '}  ${m.w}x${m.h}`)
ok('每个成员都是合法 PNG', members.every((m) => m.isPng))
ok('每个成员的 PNG 宽高符合类型码约定',
  members.every((m) => EXPECT[m.type] === undefined || (m.w === EXPECT[m.type] && m.h === EXPECT[m.type])),
  members.filter((m) => EXPECT[m.type] !== undefined && (m.w !== EXPECT[m.type] || m.h !== EXPECT[m.type]))
    .map((m) => `${m.type}=${m.w}`).join(', ') || '全部符合')
const sizes = new Set(members.map((m) => m.w))
for (const need of [16, 32, 64, 128, 256, 512, 1024]) {
  ok(`含 ${need}×${need} 档`, sizes.has(need), [...sizes].join('/'))
}
console.log(fail === 0 ? '\nVERIFY ICNS: ALL PASS' : `\nVERIFY ICNS: ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
