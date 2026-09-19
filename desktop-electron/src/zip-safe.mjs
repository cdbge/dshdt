// zip-safe.mjs — 自实现的 **zip 读取 + 安全解包**（纯 Node，零依赖，可在 Electron 与纯 Node 下跑）
//
// 为什么自己解压，而不是 `Expand-Archive` / `tar` / `unzip`（2026-09-16 决策）：
//   ① **zip-slip 是活跃威胁**，且解压器是否有防护不能靠猜——同一天查到的实证里，
//      Notepad++ 8.9.7 刚因 zip-slip 出补丁（CVE-2026-40400 / 8.9.7 security patch 一类）。
//      把"写入哪些路径"的决定权交给外部工具的默认行为，等于把安全边界外包给一个我们不看源码的程序。
//   ② 外部工具还有别的代价：PowerShell 在 Linux/macOS 上没有、`tar` 在 Windows 10 以下不一定有、
//      spawn 在受限会话里会被 EPERM 拒（本项目已踩过多次）。
//   ③ 自己解压只需 ~200 行，且**每条路径都能判据化**（下面每个拒绝分支都配了自检夹具）。
//
// 格式依据：ZIP 的中央目录（End of Central Directory + Central Directory Header + Local File Header）。
// 只支持"解包"需要的子集：store(0) 与 deflate(8)、无加密、无 zip64（超过 4GB 的包一律拒绝——
//   插件包不该有那种体积，超了本身就是可疑信号）。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/** zip 中央目录项签名（PK\x01\x02）。 */
const SIG_CENTRAL = 0x02014b50
/** zip 结束记录签名（PK\x05\x06）。 */
const SIG_EOCD = 0x06054b50
/** zip 本地文件头签名（PK\x03\x04）。 */
const SIG_LOCAL = 0x04034b50

/**
 * 一个条目的路径是否**可以安全地落到 destRoot 之内**。
 *
 * 这是整个模块的安全核心，判据按"先规范化、再比对前缀"的顺序（顺序反了会被 `a/../..` 绕过）：
 *   ① 拒绝绝对路径（`C:\…`、`/etc/…`、`\\server\share`）；
 *   ② 拒绝含 NUL 的路径（某些 API 会截断，导致校验的与实际写的不是一个东西）；
 *   ③ 拒绝 Windows 驱动器相对路径（`C:foo`）与 UNC；
 *   ④ 拒绝**反斜杠**——zip 规范要求 `/`，出现 `\` 说明这个包是按 Windows 习惯打的，
 *      而它在 POSIX 上会被当成普通字符、在 Windows 上会被当成分隔符 ⇒ **同一份包两个平台两种含义**，
 *      这种歧义本身就是攻击面，直接拒绝；
 *   ⑤ 规范化后必须仍在 destRoot 之内（挡 `..` 逃逸）；
 *   ⑥ 拒绝指向 destRoot 自身（空路径）；
 *   ⑦ 拒绝 `:` 出现在首段之后（ADS：`name.txt:evil`，Windows 上能写隐藏数据流）。
 * @param {string} entryName zip 里的条目名
 * @param {string} destRoot 解包目标根（绝对路径）
 * @returns {{ok:true, rel:string}|{ok:false, reason:string}} rel 是相对目标根的路径
 */
export function safeEntryPath(entryName, destRoot) {
  if (typeof entryName !== 'string' || entryName === '') return { ok: false, reason: '条目名为空' }
  if (entryName.includes('\0')) return { ok: false, reason: '条目名含 NUL 字节' }
  if (entryName.includes('\\')) return { ok: false, reason: '条目名含反斜杠（规范要求用 /，出现 \\ 属歧义路径）' }
  if (entryName.startsWith('/')) return { ok: false, reason: '条目名是绝对路径' }
  if (/^[A-Za-z]:/.test(entryName)) return { ok: false, reason: '条目名带盘符（绝对或驱动器相对路径）' }
  // ADS（Windows 备用数据流）：`a.txt:evil`。**必须在规范化之前按原名字判**——顺手写成的
  // "首段之后含冒号"会漏掉 `a.txt:evil` 这种单段形态（真缺陷，被自检抓到：4 条红里有 1 条是它）。
  // 冒号在 zip 条目名里没有任何正当用途，一律拒绝最省事也最安全。
  if (entryName.includes(':')) return { ok: false, reason: '条目名含冒号（盘符或 Windows 备用数据流）' }
  const segs = entryName.split('/')
  if (segs.some((s) => s === '..')) return { ok: false, reason: '条目名含 ..（试图逃出目标目录）' }
  const rel = segs.filter((s) => s !== '' && s !== '.').join('/')
  if (rel === '') return { ok: false, reason: '条目名指向目标目录自身' }
  // 最后一道：规范化后必须仍在 destRoot 之内（前面已挡 `..`，这里是兜底，防的是我没想到的形态）
  const rootAbs = path.resolve(destRoot)
  const abs = path.resolve(rootAbs, rel)
  const withSep = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep
  if (!abs.startsWith(withSep)) return { ok: false, reason: '规范化后落在目标目录之外' }
  return { ok: true, rel }
}

/** 从 buffer 尾部找到 EOCD（注释最长 65535，所以最多回看 64KB+22）。 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - (0xffff + 22))
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i
  }
  return -1
}

/**
 * 读出 zip 的中央目录（只读元数据，不解压）。
 * @param {Buffer} buf 整个 zip 文件
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
  // zip64 的 EOCD 占位值是 0xffff/0xffffffff：本项目一律拒绝（插件包不该到 4GB，超了本身就是可疑信号）
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
    // 条目名用 UTF-8：zip 的 CP437 老包会把中文名读错，但那种包在本项目里一律不该出现，
    // 读错名字会直接卡在 safeEntryPath 的判据上（宁可拒绝，不要"猜编码"）。
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
 * 安全解包到目录。**逐条校验路径后才写**，任一条不合法即整体失败（不做"跳过坏条目"——
 * 那会让一个恶意包"部分成功"，而部分成功的包更难判断）。
 * @param {Buffer} buf zip 内容
 * @param {string} destRoot 目标根目录（会被创建；**已存在的内容不清理**，由调用方决定）
 * @param {{stripSingleRoot?:boolean}} [o] stripSingleRoot：包内只有一层顶层目录时自动剥掉
 *        （GitHub 的 "Download ZIP" 就是这个形态），让落盘结果直接是包内容
 * @returns {{ok:true, files:number, bytes:number, stripped:string|null}|{ok:false, error:string}}
 */
export function extractZipSafe(buf, destRoot, { stripSingleRoot = true } = {}) {
  const read = readZipEntries(buf)
  if (!read.ok) return { ok: false, error: read.error }
  const raw = read.entries.filter((e) => !e.name.endsWith('/'))   // 目录条目靠写文件时建，不单独处理
  if (raw.length === 0) return { ok: false, error: '包里没有任何文件' }

  // 剥离单层顶层目录：只有当**所有**文件都在同一个顶层目录下才剥（否则会把混合结构的包搞坏）
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
