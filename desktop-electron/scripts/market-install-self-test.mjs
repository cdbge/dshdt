// market-install-self-test.mjs — 市场安装链路的失败分支夹具（纯 Node、脱网、临时目录用完即删）：
// 每条失败分支都断言"没有留下半成品"（目标目录不存在、无 .tmp-install-* 残留），并覆盖下载器判据。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installMarketEntry, sha256Hex, httpDownload, DEFAULT_BUILTIN_NAMES } from '../src/market-install.mjs'
import { ensureProfilePluginMount } from '../src/profile-mount.mjs'
import { safeRemoveTree } from '../src/junction-safe.mjs'

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mktinstall-'))

// zip 夹具构造（与 zip-safe-self-test 同法：store 压缩）
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c }
  return t
})()
function crc32(buf) { let c = -1; for (const b of buf) c = (c >>> 8) ^ CRC_TABLE[(c ^ b) & 0xff]; return (c ^ -1) >>> 0 }
function makeZip(entries) {
  const locals = [], centrals = []
  let offset = 0
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const data = Buffer.from(e.data ?? '', 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, data)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6)
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42)
    centrals.push(cd, nameBuf)
    offset += local.length + nameBuf.length + data.length
  }
  const cdBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cdBuf, eocd])
}
// 一个"形状正确"的插件包
const goodPkg = (name = 'demo-plugin') => makeZip([
  { name: `${name}/`, data: '' },
  { name: `${name}/package.json`, data: JSON.stringify({ name, version: '1.0.0', type: 'module', exports: { '.': './lib/index.js' } }) },
  { name: `${name}/lib/index.js`, data: 'export function apply() {}' },
])

// 每个用例一个独立的沙箱（destRoot + profileDir），互不干扰
let seq = 0
function sandbox() {
  const base = path.join(tmp, `s${seq++}`)
  const destRoot = path.join(base, 'node_modules')
  const profileDir = path.join(base, 'web')
  fs.mkdirSync(destRoot, { recursive: true })
  fs.mkdirSync(profileDir, { recursive: true })
  return { base, destRoot, profileDir }
}
// 假下载器：返回给定 buffer（或错误）
const fakeDownload = (buffer) => async () => ({ ok: true, buffer })
const failDownload = (error) => async () => ({ ok: false, error })
// 组装依赖（真的用 profile-mount 与 junction-safe，只有下载是假的）
const deps = (sb, { download, builtinNames } = {}) => ({
  destRoot: sb.destRoot,
  profileDir: sb.profileDir,
  builtinNames,
  download: download ?? fakeDownload(goodPkg()),
  mount: (name, comment) => ensureProfilePluginMount({ profileDir: sb.profileDir, name, comment }),
  removeTree: (p, o) => safeRemoveTree(p, o),
})
// 一条条目的模板
const entryOf = (buf, over = {}) => ({
  id: 'demo-plugin', name: '演示插件',
  download: { url: 'https://example.com/demo.zip', sha256: sha256Hex(buf), bytes: buf.length },
  ...over,
})
// 半成品判据：目标目录不该存在，且不该留 .tmp-install-* 临时目录
const noHalfProduct = (sb, id = 'demo-plugin') =>
  !fs.existsSync(path.join(sb.destRoot, id))
  && !fs.readdirSync(sb.destRoot).some((n) => n.startsWith('.tmp-install-'))

console.log('[市场安装：正向]')
{
  const sb = sandbox()
  const buf = goodPkg()
  const r = await installMarketEntry(entryOf(buf), deps(sb, { download: fakeDownload(buf) }))
  ok('正向：安装成功', r.ok === true && r.needsRestart === true, JSON.stringify(r).slice(0, 160))
  ok('正向：包落在 node_modules/<id>', fs.existsSync(path.join(sb.destRoot, 'demo-plugin', 'package.json')))
  ok('正向：剥掉了包内顶层目录', fs.existsSync(path.join(sb.destRoot, 'demo-plugin', 'lib', 'index.js')))
  ok('正向：写了挂载行', fs.readFileSync(path.join(sb.profileDir, 'cordis.patch.yml'), 'utf8').includes('id: demo-plugin'))
  ok('正向：没有残留临时目录', !fs.readdirSync(sb.destRoot).some((n) => n.startsWith('.tmp-install-')))
}

console.log('[市场安装：失败分支（每条都要不留半成品）]')
{
  const sb = sandbox()
  const r = await installMarketEntry({ id: 'x', download: { url: 'https://e.com/a.zip', sha256: '' } }, deps(sb))
  ok('缺 sha256 → 拒绝（无法确认与审核一致）', r.ok === false && r.stage === 'validate' && /sha256/.test(r.error), r.error)
  ok('缺 sha256 → 没落盘', noHalfProduct(sb, 'x'))
}
{
  const sb = sandbox()
  const r = await installMarketEntry({ id: 'x', download: { url: 'http://e.com/a.zip', sha256: 'a'.repeat(64) } }, deps(sb))
  ok('http 地址 → 拒绝', r.ok === false && r.stage === 'validate' && /https/.test(r.error), r.error)
}
{
  const sb = sandbox()
  const r = await installMarketEntry(entryOf(goodPkg(), { id: 'dsh-market' }), deps(sb))
  ok('撞壳自带插件名 → 拒绝（说明会被覆盖）', r.ok === false && /自带插件/.test(r.error), r.error)
  ok('撞名 → 没落盘', noHalfProduct(sb, 'dsh-market'))
  ok('自带名单与 main.mjs 同源（含市场自身）', DEFAULT_BUILTIN_NAMES.includes('dsh-market'))
}
{
  const sb = sandbox()
  // 内容被换掉：条目里写的是 A 的哈希，实际下到 B
  const honest = goodPkg()
  const tampered = makeZip([{ name: 'demo-plugin/', data: '' }, { name: 'demo-plugin/package.json', data: '{"name":"demo-plugin","version":"9.9.9"}' }])
  const r = await installMarketEntry(entryOf(honest), deps(sb, { download: fakeDownload(tampered) }))
  ok('哈希不符 → 拒绝安装（"装的是你审过的哪一份"靠这条）', r.ok === false && r.stage === 'verify' && /不一致/.test(r.error), r.error)
  ok('哈希不符 → 没落盘', noHalfProduct(sb))
}
{
  const sb = sandbox()
  const r = await installMarketEntry(entryOf(goodPkg()), deps(sb, { download: failDownload('HTTP 404') }))
  ok('下载失败 → 报下载阶段', r.ok === false && r.stage === 'download', r.error)
}
{
  const sb = sandbox()
  const okBuf = goodPkg()
  const slip = makeZip([
    { name: 'demo-plugin/package.json', data: '{"name":"demo-plugin"}' },
    { name: '../evil.js', data: 'pwned' },
  ])
  const r = await installMarketEntry(entryOf(slip), deps(sb, { download: fakeDownload(slip) }))
  ok('包内含 zip-slip → 拒绝解包', r.ok === false && r.stage === 'extract' && /拒绝解包/.test(r.error), r.error)
  ok('zip-slip → 没落盘、也没逃到外面', noHalfProduct(sb) && !fs.existsSync(path.join(sb.base, 'evil.js')))
  void okBuf
}
{
  const sb = sandbox()
  const noPkg = makeZip([{ name: 'demo-plugin/README.md', data: 'hi' }])
  const r = await installMarketEntry(entryOf(noPkg), deps(sb, { download: fakeDownload(noPkg) }))
  ok('缺 package.json → 拒绝并说明（GitHub Download ZIP 两层目录就是这形态）',
    r.ok === false && r.stage === 'shape' && /package.json/.test(r.error), r.error)
  ok('缺 package.json → 没落盘', noHalfProduct(sb))
}
{
  const sb = sandbox()
  const badJson = makeZip([{ name: 'demo-plugin/package.json', data: '{ 这不是 JSON' }])
  const r = await installMarketEntry(entryOf(badJson), deps(sb, { download: fakeDownload(badJson) }))
  ok('package.json 非法 JSON → 拒绝', r.ok === false && r.stage === 'shape', r.error)
  ok('非法 JSON → 没落盘', noHalfProduct(sb))
}
{
  const sb = sandbox()
  // 包名与 id 不一致：挂载行会挂到一个不存在的模块上
  const mismatched = makeZip([{ name: 'other-name/package.json', data: '{"name":"other-name"}' }])
  const r = await installMarketEntry(entryOf(mismatched), deps(sb, { download: fakeDownload(mismatched) }))
  ok('包名与条目 id 不一致 → 拒绝（挂载会挂空）',
    r.ok === false && r.stage === 'shape' && /不一致/.test(r.error), r.error)
  ok('包名不一致 → 没落盘', noHalfProduct(sb))
}
{
  const sb = sandbox()
  const buf = goodPkg()
  fs.mkdirSync(path.join(sb.destRoot, 'demo-plugin'), { recursive: true })   // 先"装过"
  fs.writeFileSync(path.join(sb.destRoot, 'demo-plugin', 'mine.txt'), 'user own copy')
  const r = await installMarketEntry(entryOf(buf), deps(sb, { download: fakeDownload(buf) }))
  ok('目标已存在 → 拒绝覆盖（不静默替换用户自己装的那份）', r.ok === false && r.stage === 'stage' && /已经装过/.test(r.error), r.error)
  ok('拒绝时用户的文件原样还在', fs.readFileSync(path.join(sb.destRoot, 'demo-plugin', 'mine.txt'), 'utf8') === 'user own copy')
}
{
  const sb = sandbox()
  const buf = goodPkg()
  const r = await installMarketEntry(entryOf(buf, { id: 'bad id!' }), deps(sb, { download: fakeDownload(buf) }))
  ok('id 含非法字符 → 拒绝（会变成路径穿越的入口）', r.ok === false && r.stage === 'validate', r.error)
}

console.log('[下载器]')
{
  const r = await httpDownload('http://insecure.example.com/x.zip')
  ok('httpDownload 拒绝非 https', r.ok === false && /非 https/.test(r.error), r.error)
}
{
  const fake = async () => ({
    ok: true, status: 200, url: 'https://cdn.example.com/a.zip',
    headers: { get: () => null }, arrayBuffer: async () => new Uint8Array([1, 2, 3]),
  })
  const r = await httpDownload('https://example.com/a.zip', { fetchImpl: fake })
  ok('httpDownload 正常路径返回 buffer', r.ok === true && r.buffer.length === 3)
}
{
  // 重定向后落到 http：必须拒绝（否则"审核过的通道"变成可篡改的通道）
  const fake = async () => ({
    ok: true, status: 200, url: 'http://evil.example.com/a.zip',
    headers: { get: () => null }, arrayBuffer: async () => new Uint8Array([1]),
  })
  const r = await httpDownload('https://example.com/a.zip', { fetchImpl: fake })
  ok('重定向到 http → 拒绝', r.ok === false && /重定向后落到非 https/.test(r.error), r.error)
}
{
  const fake = async () => ({ ok: true, status: 200, url: 'https://e.com/a.zip', headers: { get: () => String(999 * 1024 * 1024) }, arrayBuffer: async () => new Uint8Array([1]) })
  const r = await httpDownload('https://e.com/a.zip', { fetchImpl: fake, maxBytes: 1024 })
  ok('超体积上限 → 拒绝（content-length 先判）', r.ok === false && /超过上限/.test(r.error), r.error)
}
{
  const fake = async () => ({ ok: false, status: 500, url: 'https://e.com/a.zip', headers: { get: () => null }, arrayBuffer: async () => new Uint8Array() })
  const r = await httpDownload('https://e.com/a.zip', { fetchImpl: fake })
  ok('HTTP 500 → 报出状态码', r.ok === false && /HTTP 500/.test(r.error), r.error)
}

try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { console.log('  ⚠️ 临时目录清理失败：' + tmp) }
console.log(`\nMARKET INSTALL SELF TEST: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
