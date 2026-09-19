// zip-safe.mjs — 自实现的 zip 读取与安全解包（纯 Node，零依赖）。
// 只支持 store(0) / deflate(8)、无加密、无 zip64；自行解压是为了不把写入路径的决定权交给外部工具。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_LOCAL = 0x04034b50

/**
 * 条目名能否安全地落在 destRoot 之内（本模块的安全核心）。
 * 判据按"先规范化、再比对前缀"，顺序反了会被 `a/../..` 绕过。
 * @returns {{ok:true, rel:string}|{ok:false, reason:string}} rel 是相对目标根的路径
 */
export function safeEntryPath(entryName, destRoot) {
  if (typeof entryName !== 'string' || entryName === '') return { ok: false, reason: '条目名为空' }
  if (entryName.includes('\0')) return { ok: false, reason: '条目名含 NUL 字节' }
  if (entryName.includes('\\')) return { ok: false, reason: '条目名含反斜杠（规范要求用 /，出现 \\ 属歧义路径）' }
  if (entryName.startsWith('/')) return { ok: false, reason: '条目名是绝对路径' }
  if (/^[A-Za-z]:/.test(entryName)) return { ok: false, reason: '条目名带盘符（绝对或驱动器相对路径）' }
  // 必须在规范化之前按原名字判冒号，否则会漏掉 `a.txt:evil` 这种单段 ADS 形态
  if (entryName.includes(':')) return { ok: false, reason: '条目名含冒号（盘符或 Windows 备用数据流）' }
  const segs = entryName.split('/')
  if (segs.some((s) => s === '..')) return { ok: false, reason: '条目名含 ..（试图逃出目标目录）' }
  const rel = segs.filter((s) => s !== '' && s !== '.').join('/')
  if (rel === '') return { ok: false, reason: '条目名指向目标目录自身' }
  // 前面已挡 `..`，这里兜底防没想到的形态
  const rootAbs = path.resolve(destRoot)
  const abs = path.resolve(rootAbs, rel)
  const withSep = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep
  if (!abs.startsWith(withSep)) return { ok: false, reason: '规范化后落在目标目录之外' }
  return { ok: true, rel }
}

/** 从 buffer 尾部找 EOCD（注释最长 65535，故最多回看 64KB+22）。 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - (0xffff + 22))
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i
  }
  return -1
}

/**
 * 读出 zip 的中央目录（只读元数据，不解压）。
 * @returns {{ok:true, entries:Array<{name:string, method:number, compSize:number, size:number, localOffset:number}>}
 *          |{ok:false, error:string}}
 */
export function readZipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return { ok: false, error: '文件太小，不是合法 zip' }
  const eocd = findEocd(buf)
  if (eocd < 0) return { ok: false, error: '找不到 zip 结束记录（EOCD）' }
  const total = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  // zip64 的 EOCD 占位值：一律拒绝
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    return { ok: false, error: 'zip64 包不受支持（体积异常，拒绝解包）' }
  }
  if (cdOffset + cdSize > buf.length) return { ok: false, error: '中央目录越界（文件被截断或伪造）' }
  const entries = []
  let p = cdOffset
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length) return { ok: false, error: `中央目录第 ${i + 1} 项越界` }
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) return { ok: false, error: `中央目录第 ${i + 1} 项签名不对` }
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    if (p + 46 + nameLen > buf.length) return { ok: false, error: `第 ${i + 1} 项名字越界` }
    // 条目名按 UTF-8 读：老 CP437 包会读错名字，随后卡在 safeEntryPath 的判据上
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8')
    entries.push({ name, method, compSize, size, localOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return { ok: true, entries }
}

/** 取一个条目的原始（可能压缩过的）数据。 */
function readEntryData(buf, entry) {
  const lo = entry.localOffset
  if (lo + 30 > buf.length) return { ok: false, error: `条目 ${entry.name} 的本地头越界` }
  if (buf.readUInt32LE(lo) !== SIG_LOCAL) return { ok: false, error: `条目 ${entry.name} 的本地头签名不对` }
  const nameLen = buf.readUInt16LE(lo + 26)
  const extraLen = buf.readUInt16LE(lo + 28)
  const start = lo + 30 + nameLen + extraLen
  const end = start + entry.compSize
  if (end > buf.length) return { ok: false, error: `条目 ${entry.name} 的数据越界` }
  const raw = buf.slice(start, end)
  if (entry.method === 0) return { ok: true, data: raw }
  if (entry.method === 8) {
    try { return { ok: true, data: zlib.inflateRawSync(raw, { maxOutputLength: 256 * 1024 * 1024 }) } }
    catch (e) { return { ok: false, error: `条目 ${entry.name} 解压失败：${e.message}` } }
  }
  return { ok: false, error: `条目 ${entry.name} 用了不支持的压缩方式 ${entry.method}（只支持 store/deflate，加密包一律拒绝）` }
}

/**
 * 安全解包到目录：逐条校验路径后才写，任一条不合法即整体失败（不做"跳过坏条目"）。
 * destRoot 会被创建，已存在的内容不清理；stripSingleRoot 会自动剥掉包内唯一的顶层目录。
 * @returns {{ok:true, files:number, bytes:number, stripped:string|null}|{ok:false, error:string}}
 */
export function extractZipSafe(buf, destRoot, { stripSingleRoot = true } = {}) {
  const read = readZipEntries(buf)
  if (!read.ok) return { ok: false, error: read.error }
  const raw = read.entries.filter((e) => !e.name.endsWith('/'))   // 目录条目靠写文件时建
  if (raw.length === 0) return { ok: false, error: '包里没有任何文件' }

  // 只有当所有文件都在同一个顶层目录下才剥，否则会把混合结构的包搞坏
  let strip = null
  if (stripSingleRoot) {
    const tops = new Set(raw.map((e) => e.name.split('/')[0]))
    if (tops.size === 1 && raw.every((e) => e.name.includes('/'))) strip = [...tops][0]
  }
  const stripPrefix = strip === null ? '' : `${strip}/`

  const rootAbs = path.resolve(destRoot)
  const plan = []
  for (const e of raw) {
    const name = stripPrefix !== '' && e.name.startsWith(stripPrefix) ? e.name.slice(stripPrefix.length) : e.name
    const safe = safeEntryPath(name, rootAbs)
    if (!safe.ok) return { ok: false, error: `拒绝解包：${e.name} —— ${safe.reason}` }
    plan.push({ entry: e, rel: safe.rel })
  }

  let files = 0
  let bytes = 0
  for (const { entry, rel } of plan) {
    const data = readEntryData(buf, entry)
    if (!data.ok) return { ok: false, error: data.error }
    const abs = path.join(rootAbs, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, data.data)
    files++
    bytes += data.data.length
  }
  return { ok: true, files, bytes, stripped: strip }
}
