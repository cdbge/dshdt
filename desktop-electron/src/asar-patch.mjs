// asar-patch.mjs — 给 app.asar 做**原地换件**（只替换/删除指定文件，其余原样保留）
//
// 为什么需要它（1.0.0 的唯一功能："一个按钮热更新 dshdt 自身"）：
//   壳自身的代码在 `resources/app.asar` 里（`electron-builder.yml` 的 `files:` = `src/**` + `VERSION`
//   + `package.json`）。要"按仓库文件更新壳"，就得把仓库里那几个源码文件换进 asar——
//   但 asar 里还有 `node_modules/electron-updater/**` 等**不能丢**的东西（那是运行期依赖），
//   所以不能"从源码重新打一个包"，只能**保留原条目、只换目标文件**。
//
// 格式（asar v1，已对照 `@electron/asar` 的 pickle.js 与真实产物核实）：
//   [u32 4] [u32 headerPickle 长度] [u32 JSON 长度] [JSON] [对齐补零] [文件数据区…]
//   其中「headerPickle」自身也是一个 pickle：headerSize=4（放 payload 长度），随后 writeString 先写
//   u32 长度、再写字符串并按 4 字节对齐。⇒ JSON 起点固定在偏移 16。
//   条目：目录 = `{files:{…}}`；文件 = `{size, offset, integrity?}`（offset 相对**数据区起点**）；
//   `unpacked:true` 的条目数据在 `app.asar.unpacked/` 下、**没有 offset**，必须原样保留。
//
// ⚠️ integrity：真实产物里**每个文件条目都带** `integrity`（SHA256 + blockSize + blocks）。
//   替换过的文件必须**重算**，否则一旦 Electron 开了 `EnableEmbeddedAsarIntegrityValidation`
//   就会拒绝加载整个 asar（表现为"换完壳应用起不来"）。本实现只支持单块（文件 ≤ blockSize，
//   我们最大的壳源码也就 150 KB 量级），超过就直接拒绝——宁可不换，也不写一个校验对不上的头。
import crypto from 'node:crypto'
import fs from 'node:fs'

/** 单块 integrity 的默认块大小（与真实产物里的 blockSize 一致）。 */
const DEFAULT_BLOCK_SIZE = 4194304

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/** 对齐到 4 字节（Chromium pickle 的粒度）。 */
const align4 = (n) => n + ((4 - (n % 4)) % 4)

/**
 * 解析 asar 头部。
 * @param {Buffer} buf 整个 asar 文件
 * @returns {{header:object, headerBufLen:number, dataStart:number, jsonLen:number}}
 */
export function parseAsar(buf) {
  if (buf.length < 16) throw new Error('asar 太短（<16 字节），不是合法容器')
  const four = buf.readUInt32LE(0)
  if (four !== 4) throw new Error(`asar 头不合法：第一个 u32 应为 4，实得 ${four}`)
  const headerBufLen = buf.readUInt32LE(4)
  const jsonLen = buf.readUInt32LE(12)
  if (headerBufLen < 8 || 8 + headerBufLen > buf.length) throw new Error(`asar 头长度不合法：headerBufLen=${headerBufLen}`)
  if (jsonLen <= 0 || 16 + jsonLen > 8 + headerBufLen) throw new Error(`asar 头 JSON 长度不合法：jsonLen=${jsonLen}`)
  const json = buf.subarray(16, 16 + jsonLen).toString('utf8')
  let header
  try { header = JSON.parse(json) } catch (e) { throw new Error(`asar 头 JSON 解析失败：${e.message}`) }
  if (header === null || typeof header !== 'object' || typeof header.files !== 'object') throw new Error('asar 头里没有 files 表')
  return { header, headerBufLen, dataStart: 8 + headerBufLen, jsonLen }
}

/** 遍历 asar 树，返回 `文件相对路径 → 条目` 的扁平映射（目录不出现）。路径用正斜杠。 */
export function listAsarFiles(header) {
  const out = new Map()
  const walk = (node, prefix) => {
    for (const [name, v] of Object.entries(node.files ?? {})) {
      const p = prefix === '' ? name : `${prefix}/${name}`
      if (v !== null && typeof v === 'object' && v.files !== undefined) walk(v, p)
      else out.set(p, v)
    }
  }
  walk(header, '')
  return out
}

/** 从 asar 缓冲里取一个文件的内容（`unpacked` 条目返回 null——它的数据不在这里面）。 */
export function readAsarFile(buf, parsed, entry) {
  if (entry.unpacked === true) return null
  if (entry.offset === undefined) throw new Error('条目既没有 offset 也不是 unpacked，asar 头已损坏')
  const off = parsed.dataStart + Number(entry.offset)
  const size = Number(entry.size)
  if (!Number.isFinite(off) || !Number.isFinite(size) || off + size > buf.length) throw new Error(`条目越界（offset=${entry.offset} size=${entry.size}）`)
  return buf.subarray(off, off + size)
}

/**
 * 算一个文件的 integrity 记录（与真实产物同构）。
 * @param {Buffer} content 文件内容
 * @param {number} blockSize 块大小（从原头里取，取不到用默认值）
 * @returns {{ok:true, integrity:object}|{ok:false, error:string}}
 */
export function computeIntegrity(content, blockSize = DEFAULT_BLOCK_SIZE) {
  if (content.length > blockSize) {
    return { ok: false, error: `文件 ${content.length} 字节超过单块上限 ${blockSize}——本实现不写多块 integrity（换了会校验不过）` }
  }
  const hash = sha256Hex(content)
  return { ok: true, integrity: { algorithm: 'SHA256', hash, blockSize, blocks: [hash] } }
}

/** 取原头里用的 blockSize（没有 integrity 就用默认值）。 */
function blockSizeOf(header) {
  for (const v of listAsarFiles(header).values()) {
    if (v !== null && typeof v === 'object' && v.integrity !== undefined && Number.isFinite(Number(v.integrity.blockSize))) {
      return Number(v.integrity.blockSize)
    }
  }
  return DEFAULT_BLOCK_SIZE
}

/** 在克隆出来的树里定位（必要时创建）某个文件的父目录节点。 */
function ensureDir(root, segments) {
  let node = root
  for (const seg of segments) {
    if (node.files === undefined) node.files = {}
    if (node.files[seg] === undefined) node.files[seg] = { files: {} }
    node = node.files[seg]
    if (node.files === undefined) throw new Error(`路径冲突：${segments.join('/')} 中间有一段是文件`)
  }
  return node
}

/** 删除空目录（从叶子往上收，别把有内容的目录删了）。 */
function pruneEmptyDirs(root, segments) {
  const chain = []
  let node = root
  for (const seg of segments) {
    const next = node.files?.[seg]
    if (next === undefined) return
    chain.push([node, seg])
    node = next
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    const [parent, seg] = chain[i]
    const child = parent.files[seg]
    if (child !== null && typeof child === 'object' && child.files !== undefined && Object.keys(child.files).length === 0) delete parent.files[seg]
    else break
  }
}

/**
 * 打补丁：返回**新的 asar 缓冲**（原缓冲不动）。
 * @param {Buffer} buf 原 asar
 * @param {{replace?:Map<string,Buffer>, remove?:string[], log?:(m:string)=>void}} opts 变更
 * @returns {{ok:true, buffer:Buffer, written:string[], removed:string[], files:number}|{ok:false, error:string}}
 */
export function patchAsarBuffer(buf, { replace = new Map(), remove = [], log = () => {} } = {}) {
  let parsed
  try { parsed = parseAsar(buf) } catch (e) { return { ok: false, error: e.message } }
  // 归一化替换集的 key（正斜杠），后面只认这一份，避免"同一条目两种写法"导致的静默漏替换
  const norm = new Map()
  for (const [k, v] of replace) {
    const rel = String(k).split('\\').join('/')
    const segs = rel.split('/').filter((s) => s !== '')
    if (segs.length === 0 || segs.some((s) => s === '.' || s === '..')) return { ok: false, error: `路径不合法：${k}` }
    norm.set(segs.join('/'), v)
  }
  const header = JSON.parse(JSON.stringify(parsed.header))
  const oldFiles = listAsarFiles(parsed.header)
  const blockSize = blockSizeOf(parsed.header)
  const dataChunks = []

  // 1) 替换/新增
  const written = []
  for (const [rel, content] of norm) {
    const segs = rel.split('/')
    const integrity = computeIntegrity(content, blockSize)
    if (!integrity.ok) return { ok: false, error: `${rel}：${integrity.error}` }
    const dir = ensureDir(header, segs.slice(0, -1))
    const leaf = segs[segs.length - 1]
    if (dir.files[leaf] !== undefined && dir.files[leaf] !== null && typeof dir.files[leaf] === 'object' && dir.files[leaf].files !== undefined) {
      return { ok: false, error: `${rel} 在原 asar 里是个目录，不能当文件替换` }
    }
    dir.files[leaf] = { size: content.length, offset: '0', integrity: integrity.integrity }
    written.push(rel)
  }

  // 2) 删除
  const removed = []
  for (const relRaw of remove) {
    const rel = String(relRaw).split('\\').join('/')
    const segs = rel.split('/').filter((s) => s !== '')
    if (segs.length === 0) continue
    const dir = ensureDir(header, segs.slice(0, -1))
    if (dir.files[segs[segs.length - 1]] !== undefined) {
      delete dir.files[segs[segs.length - 1]]
      removed.push(rel)
      pruneEmptyDirs(header, segs.slice(0, -1))
    }
  }

  // 3) 重排数据区：**按树序**重新给每个文件分配 offset，未变动的从旧缓冲里原样搬过来。
  let cursor = 0
  const ordered = [...listAsarFiles(header).entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  for (const [rel, entry] of ordered) {
    if (entry.unpacked === true) {
      // 数据在 app.asar.unpacked/ 下：**不能**给它编 offset（Electron 会按 unpacked 走真实路径）
      continue
    }
    const size = Number(entry.size)
    if (!Number.isFinite(size) || size < 0) return { ok: false, error: `条目 ${rel} 的 size 不合法` }
    let data
    if (norm.has(rel)) {
      data = norm.get(rel)
    } else {
      const old = oldFiles.get(rel)
      if (old === undefined) return { ok: false, error: `内部错误：${rel} 既不在旧头里也不在替换集里` }
      try { data = readAsarFile(buf, parsed, old) } catch (e) { return { ok: false, error: `${rel}：${e.message}` } }
      if (data === null) continue // 旧条目是 unpacked：新头里保持 unpacked，无数据
    }
    if (data.length !== size) {
      // 替换集里的内容与刚写进头的 size 必须一致（防止 key 写法不一致导致的静默错位）
      return { ok: false, error: `${rel} 数据长度(${data.length})与头里记录的 size(${size})不一致` }
    }
    entry.offset = String(cursor)
    dataChunks.push(data)
    cursor += size
    log(`[asar-patch] ${rel} → offset ${entry.offset}（${size} 字节）`)
  }

  // 4) 序列化头部（严格复刻 pickle：u32 payload 长度 + u32 JSON 长度 + JSON + 对齐补零）
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b }
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const headerPayload = Buffer.concat([u32(json.length), json, Buffer.alloc(align4(json.length) - json.length)])
  const headerPickle = Buffer.concat([u32(headerPayload.length), headerPayload])
  const sizeBuf = Buffer.concat([u32(4), u32(headerPickle.length)])
  return { ok: true, buffer: Buffer.concat([sizeBuf, headerPickle, ...dataChunks]), written, removed, files: ordered.length }
}

/** 读 asar 文件 → 打补丁 → 写成新文件（原子：先写 `.tmp` 再 rename）。 */
export function patchAsarFile(srcFile, destFile, opts = {}) {
  let buf
  try { buf = fs.readFileSync(srcFile) } catch (e) { return { ok: false, error: `读不到原 asar：${e.message}` } }
  const r = patchAsarBuffer(buf, opts)
  if (!r.ok) return r
  const bytes = r.buffer.length
  try {
    const tmp = `${destFile}.tmp-${process.pid}`
    fs.writeFileSync(tmp, r.buffer)
    fs.renameSync(tmp, destFile)
  } catch (e) {
    return { ok: false, error: `写新 asar 失败：${e.message}` }
  }
  return { ok: true, written: r.written, removed: r.removed, files: r.files, bytes }
}
