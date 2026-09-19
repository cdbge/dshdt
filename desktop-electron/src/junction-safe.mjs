// junction-safe.mjs — 对 junction 场安全的递归删除：遇到 junction/symlink 只 unlink 链接本身，绝不进入目标。
// 凡是我们自己删除可能含 junction 的目录（门禁隔离 HOME、%TEMP% 残留）都走这里。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** 门禁隔离 HOME 的目录名前缀。 */
export const BOOTGATE_PREFIX = 'dsh-bootgate-'

/**
 * 递归删除，遇到 junction/symlink 只 unlink 链接本身，不进入目标。
 * 链接 unlink 失败回落 rmdirSync，目录 rmdir 失败重试一次并记残留，不假装删干净。
 * @returns {{removed:boolean, unlinked:number, leftovers:number, reason?:string}}
 *   `leftovers` > 0 表示没清干净，调用方可据此告警/重试
 */
export function safeRemoveTree(target, { log = () => {} } = {}) {
  const stats = { removed: false, unlinked: 0, leftovers: 0 }
  const unlinkOrRmdir = (p, isLink) => {
    try {
      fs.unlinkSync(p)
      if (isLink) stats.unlinked += 1
      return true
    } catch (e) {
      // 目录型链接（POSIX symlink→dir / Windows junction）用 rmdir 同样只删链接本身
      try {
        fs.rmdirSync(p)
        if (isLink) stats.unlinked += 1
        log(`[junction-safe] unlink 失败但 rmdir 成功（只删了链接本身）：${p} — ${e.message}`)
        return true
      } catch (e2) {
        stats.leftovers += 1
        log(`[junction-safe] ${isLink ? '删除链接' : '删除文件'}失败（残留）：${p} — ${e.message} / ${e2.message}`)
        return false
      }
    }
  }
  const walk = (p) => {
    let lst
    try { lst = fs.lstatSync(p) } catch { return }
    if (lst.isSymbolicLink()) { unlinkOrRmdir(p, true); return }
    if (!lst.isDirectory()) { unlinkOrRmdir(p, false); return }
    let entries = []
    try { entries = fs.readdirSync(p, { withFileTypes: true }) } catch (e) {
      stats.leftovers += 1
      log(`[junction-safe] 读取失败（残留）：${p} — ${e.message}`)
      return
    }
    for (const e of entries) walk(path.join(p, e.name))
    // 目录删除失败通常是里面还有删不掉的条目：重试一次再放弃
    try { fs.rmdirSync(p) } catch (e) {
      try { fs.rmdirSync(p) } catch {
        stats.leftovers += 1
        log(`[junction-safe] 删目录失败（残留，内含删不掉的条目）：${p} — ${e.message}`)
      }
    }
  }
  try { fs.lstatSync(target) } catch { return { ...stats, reason: 'not-found' } }
  walk(target)
  stats.removed = true
  return stats
}

/**
 * 列出遗留的门禁隔离 HOME（正常路径会在 finally 里自删，留下的说明上次没走完）。
 * @param {{tmpDir?:string, minAgeMs?:number, now?:number}} [opts] minAgeMs 用于避开正在跑的实例
 * @returns {string[]} 候选目录绝对路径
 */
export function listStaleBootGateHomes({ tmpDir = os.tmpdir(), minAgeMs = 10 * 60 * 1000, now = Date.now() } = {}) {
  let entries = []
  try { entries = fs.readdirSync(tmpDir, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const e of entries) {
    if (!e.name.startsWith(BOOTGATE_PREFIX)) continue
    const p = path.join(tmpDir, e.name)
    let st
    try { st = fs.lstatSync(p) } catch { continue }
    if (st.isSymbolicLink() || !st.isDirectory()) continue
    // 必须用创建时间：目录内容变动会刷新 mtime，会把正在跑的门禁误判成遗留
    const born = Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs
    // btime 与 Date.now() 可能不同源，负年龄一律按 0（当成刚创建、这次不动）
    const age = Math.max(0, now - born)
    if (age < minAgeMs) continue
    out.push(p)
  }
  return out
}

/**
 * 安全清理遗留门禁目录，壳启动时调用（失败不阻断启动）。
 * @param {{tmpDir?:string, minAgeMs?:number, now?:number, log?:(m:string)=>void}} [opts]
 * @returns {{cleaned:number, unlinked:number}}
 */
export function cleanStaleBootGateHomes(opts = {}) {
  const { log = () => {} } = opts
  let cleaned = 0
  let unlinked = 0
  for (const dir of listStaleBootGateHomes(opts)) {
    const r = safeRemoveTree(dir, { log })
    if (r.removed) cleaned += 1
    unlinked += r.unlinked
    log(`[junction-safe] 已清理遗留门禁目录 ${path.basename(dir)}（解开 junction ${r.unlinked} 个，未进入其目标）`)
  }
  return { cleaned, unlinked }
}
