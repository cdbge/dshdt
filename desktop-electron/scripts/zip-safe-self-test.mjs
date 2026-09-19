// zip-safe-self-test.mjs — 安全解包的判据自检（纯 Node、脱网、临时目录用完即删）
//
// 为什么这套自检值得单独存在：安全解包的判据**只能用恶意样本证明**。
// "正常包能解开"证明不了任何事——真正的风险是 `../` 逃逸、反斜杠歧义、ADS、zip64 等形态。
// 所以下面**自己构造 zip**（含恶意条目），逐条断言被拒绝，并断言**确实没有文件落到目标目录之外**。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { safeEntryPath, readZipEntries, extractZipSafe } from '../src/zip-safe.mjs'

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zipsafe-'))

// ---------- 极简 zip 构造器（只为夹具服务，不是产品代码）----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = 0 ^ -1
  for (const b of buf) c = (c >>> 8) ^ CRC_TABLE[(c ^ b) & 0xff]
  return (c ^ -1) >>> 0
}
/**
 * 打一个 zip。entries: [{name, data?, dir?}]，全部 store（不压缩）——
 * 夹具要测的是路径判据，不是压缩算法。
 */
function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const data = e.dir ? Buffer.alloc(0) : Buffer.from(e.data ?? '', 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)          // method 0 = store
    local.writeUInt32LE(0, 10)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 8)
    cd.writeUInt16LE(0, 10)            // method 0
    cd.writeUInt32LE(0, 12)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(e.dir ? 0x10 : 0, 38)
    cd.writeUInt32LE(offset, 42)
    centrals.push(cd, nameBuf)
    offset += local.length + nameBuf.length + data.length
  }
  const cdBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, cdBuf, eocd])
}

// ---------- 1) safeEntryPath：纯函数判据（安全核心）----------
console.log('[safeEntryPath]')
const R = path.join(tmp, 'root')
const bad = (n) => !safeEntryPath(n, R).ok
ok('正常相对路径通过', safeEntryPath('lib/client.js', R).ok && safeEntryPath('lib/client.js', R).rel === 'lib/client.js')
ok('拒绝 ../ 逃逸', bad('../escape.txt') && bad('a/../../escape.txt'))
ok('拒绝绝对 POSIX 路径', bad('/etc/passwd'))
ok('拒绝带盘符路径', bad('C:/Windows/x.txt') && bad('C:evil.txt'))
ok('拒绝 UNC 路径', bad('//server/share/x.txt'))
ok('拒绝反斜杠（歧义路径：两平台含义不同）', bad('lib\\client.js'))
ok('拒绝 NUL 字节', bad('lib/\0evil.js'))
ok('拒绝 ADS（备用数据流冒号）', bad('a.txt:evil'))
ok('拒绝指向目标目录自身', bad('.') && bad('./') && bad(''))
ok('拒绝需要规范化的 /./ 之外的空壳', safeEntryPath('lib/./client.js', R).ok, 'lib/./client.js 应被规范化为 lib/client.js')

// ---------- 2) readZipEntries：结构判据 ----------
console.log('[readZipEntries]')
const goodZip = makeZip([
  { name: 'pkg/', dir: true },
  { name: 'pkg/package.json', data: '{"name":"x"}' },
  { name: 'pkg/lib/index.js', data: 'export const a=1' },
])
const ents = readZipEntries(goodZip)
ok('正常 zip 读出 3 条目（含目录条目）', ents.ok && ents.entries.length === 3, ents.ok ? String(ents.entries.length) : ents.error)
ok('文件名与内容类型正确', ents.ok && ents.entries[1].name === 'pkg/package.json' && ents.entries[1].size === Buffer.byteLength('{"name":"x"}'),
  ents.ok ? `${ents.entries[1].name} size=${ents.entries[1].size}` : ents.error)
ok('非 zip 数据被拒', readZipEntries(Buffer.from('这根本不是 zip 文件，只是一段中文')).ok === false)
ok('空 buffer 被拒', readZipEntries(Buffer.alloc(0)).ok === false)
ok('截断的 zip 被拒', readZipEntries(goodZip.slice(0, goodZip.length - 10)).ok === false)
{
  // zip64 占位值必须拒绝：把 EOCD 的总数改成 0xffff
  const evil = Buffer.from(goodZip)
  evil.writeUInt16LE(0xffff, evil.length - 22 + 10)
  const r = readZipEntries(evil)
  ok('zip64 占位值被拒（体积异常即可疑）', r.ok === false && /zip64/.test(r.error), r.ok ? '竟然通过了' : r.error)
}

// ---------- 3) extractZipSafe：正向 + 逐条恶意形态 ----------
console.log('[extractZipSafe]')
{
  const dest = path.join(tmp, 'ok-dest')
  const r = extractZipSafe(goodZip, dest)
  ok('正常包解包成功并剥掉单层顶层目录', r.ok && r.files === 2 && r.stripped === 'pkg', JSON.stringify(r))
  ok('落盘结构正确（package.json 在根、lib/index.js 在子目录）',
    fs.existsSync(path.join(dest, 'package.json')) && fs.existsSync(path.join(dest, 'lib', 'index.js')))
}
{
  // **核心判据**：条目名 ../ 逃逸 —— 解包必须整体失败，且目标目录之外不能出现文件
  const dest = path.join(tmp, 'slip-dest')
  const slip = makeZip([{ name: 'pkg/ok.txt', data: 'fine' }, { name: '../escaped.txt', data: 'pwned' }])
  const r = extractZipSafe(slip, dest)
  ok('zip-slip（../）整体拒绝', r.ok === false && /拒绝解包/.test(r.error), r.ok ? '竟然通过了' : r.error)
  ok('zip-slip：目标目录之外没有被写出文件', !fs.existsSync(path.join(tmp, 'escaped.txt')))
}
{
  // 绝对路径：**直接调 safeEntryPath 判**。走 extractZipSafe 会被"剥单层顶层目录"先削掉那个前导 `/`，
  // 于是测到的其实是剥壳逻辑而不是绝对路径判据（第一版就这么误判过——夹具没打中判据，
  // 断言却"看起来在测那件事"）。
  ok('绝对路径条目被拒', !safeEntryPath('/tmp/pwned-abs.txt', R).ok, JSON.stringify(safeEntryPath('/tmp/pwned-abs.txt', R)))
  const dest = path.join(tmp, 'abs-dest')
  const r = extractZipSafe(makeZip([{ name: '/tmp/pwned-abs.txt', data: 'x' }]), dest, { stripSingleRoot: false })
  ok('绝对路径条目在解包路径上也被拒（关掉剥壳后）', r.ok === false && /绝对路径/.test(r.error), r.ok ? '竟然通过了' : String(r.error))
}
{
  const dest = path.join(tmp, 'bs-dest')
  const r = extractZipSafe(makeZip([{ name: 'a\\b.txt', data: 'x' }]), dest)
  ok('反斜杠条目被拒（平台歧义）', r.ok === false && /反斜杠/.test(r.error), r.ok ? '竟然通过了' : String(r.error))
}
{
  const dest = path.join(tmp, 'ads-dest')
  const r = extractZipSafe(makeZip([{ name: 'pkg/x.txt:hidden', data: 'x' }]), dest)
  ok('ADS 条目被拒', r.ok === false, r.ok ? '竟然通过了' : String(r.error))
}
{
  const dest = path.join(tmp, 'empty-dest')
  const r = extractZipSafe(makeZip([{ name: 'pkg/', dir: true }]), dest)
  ok('只有目录条目的包被拒（没有任何文件）', r.ok === false && /没有任何文件/.test(r.error), r.ok ? '竟然通过了' : String(r.error))
}
{
  // 混合顶层结构：不该剥（剥了会把两个目录的内容混在一起）
  const dest = path.join(tmp, 'mixed-dest')
  const r = extractZipSafe(makeZip([
    { name: 'a/x.txt', data: '1' },
    { name: 'b/y.txt', data: '2' },
  ]), dest)
  ok('多顶层目录时不剥离（避免把两个目录内容混在一起）',
    r.ok && r.stripped === null && fs.existsSync(path.join(dest, 'a', 'x.txt')) && fs.existsSync(path.join(dest, 'b', 'y.txt')),
    JSON.stringify(r))
}
{
  // 压缩方式不支持（如加密包 method=99）必须拒绝而不是"跳过"
  const dest = path.join(tmp, 'method-dest')
  const z = makeZip([{ name: 'pkg/a.txt', data: 'x' }])
  // 把中央目录与本地头的 method 都改成 99
  const cdOff = z.readUInt32LE(z.length - 22 + 16)
  z.writeUInt16LE(99, cdOff + 10)
  z.writeUInt16LE(99, 0 + 8)
  const r = extractZipSafe(z, dest)
  ok('不支持的压缩方式被拒（加密包不静默跳过）', r.ok === false && /不支持的压缩方式/.test(r.error), r.ok ? '竟然通过了' : String(r.error))
}

// ---------- 收尾 ----------
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { console.log('  ⚠️ 临时目录清理失败：' + tmp) }
console.log(`\nZIP SAFE SELF TEST: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
