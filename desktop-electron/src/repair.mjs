// repair.mjs — 会话日志自愈：截断半个 zstd 尾帧、重编码首帧异常的文件、无法修复的隔离改名。
// 仅在"没有其他 host 占用同一 DSH_HOME、本壳即将自己拉起宿主"时调用。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ZSTD_MAGIC = 0xFD2FB528

/**
 * 扫描 zstd 帧结构，返回全部完整帧区间与半个尾帧起点；结构非法抛错。
 * 移植自 deepseek-harness session-persistence-jsonl/src/zstd.ts。
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error(`reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

const hasZstd = typeof zlib.zstdDecompressSync === 'function' && typeof zlib.zstdCompressSync === 'function'

function isHeaderLine(line) {
  try {
    const obj = JSON.parse(line)
    return !!obj && obj.type === 'session' && typeof obj.id === 'string' && Number.isFinite(obj.createdAt)
  } catch { return false }
}

// 解出全部完整帧的 JSONL 行（半个尾帧不参与）；任一行不是完整 JSON 记录即失败
function decodeLines(buf, frames) {
  const lines = []
  for (const f of frames) {
    const plain = zlib.zstdDecompressSync(buf.subarray(f.start, f.end))
    for (const line of plain.toString('utf8').split('\n')) {
      if (line.length === 0) continue
      JSON.parse(line)
      lines.push(line)
    }
  }
  return lines
}

// 每行一个独立 zstd 帧，首帧即 header 行
function reencodeLines(lines) {
  const chunks = []
  for (const line of lines) chunks.push(zlib.zstdCompressSync(Buffer.from(line + '\n', 'utf8')))
  return Buffer.concat(chunks)
}

// 修复单个文件；返回 'truncated' | 'reencoded' | 'quarantined' | null（无需修复）
function repairFile(file) {
  const buf = fs.readFileSync(file)
  if (buf.length === 0) return null
  let scan = null
  try { scan = scanZstdFrames(buf) } catch { scan = null }
  if (!scan || scan.frames.length === 0 || !hasZstd) {
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`)
    return 'quarantined'
  }
  let lines = null
  let firstFrameLineCount = -1
  try {
    lines = decodeLines(buf, scan.frames)
    const firstPlain = zlib.zstdDecompressSync(buf.subarray(scan.frames[0].start, scan.frames[0].end))
    firstFrameLineCount = firstPlain.toString('utf8').split('\n').filter((l) => l.length > 0).length
  } catch { lines = null }
  if (lines === null || lines.length === 0 || !isHeaderLine(lines[0])) {
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`)
    return 'quarantined'
  }
  // 首帧必须恰好一行 header，否则整体重编码
  if (firstFrameLineCount !== 1) {
    fs.writeFileSync(file, reencodeLines(lines))
    return 'reencoded'
  }
  // 半个尾帧 → 截断到最后一个完整帧
  if (scan.tornStart !== undefined && scan.tornStart < buf.length) {
    fs.truncateSync(file, scan.tornStart)
    return 'truncated'
  }
  return null
}

/** 扫描并修复 $DSH_HOME/sessions 下全部 session.jsonl.zstd，返回各动作计数。 */
export function repairSessionLogs(home, log = () => {}) {
  const root = path.join(home, 'sessions')
  const out = { truncated: 0, reencoded: 0, quarantined: 0 }
  if (!fs.existsSync(root)) return out
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name === 'session.jsonl.zstd') {
        try {
          const r = repairFile(p)
          if (r === 'truncated') { out.truncated++; log(`repair: 截断半个尾帧 ${p}`) }
          else if (r === 'reencoded') { out.reencoded++; log(`repair: 首帧异常，已重编码 ${p}`) }
          else if (r === 'quarantined') { out.quarantined++; log(`repair: 无法修复，已隔离 ${p}`) }
        } catch (e) { log(`repair: 处理失败 ${p}: ${e.message}`) }
      }
    }
  }
  walk(root)
  return out
}
