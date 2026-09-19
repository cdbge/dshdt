// junction-safe.mjs — 对 **junction 场**安全的递归删除（纯 Node，零 Electron 依赖）
//
// 为什么必须有它（0.4.6 事故第二现场）：
//   `$DSH_HOME\profiles\node_modules` 是 harness 的「profile 模块解析双锚」——**199 个 junction
//   指向 `resources\vendor\profile\node_modules\*`**。启动门禁跑隔离 HOME 时，也会在被测树旁边
//   造出同样一套 junction 场。
//
//   实测到的损坏形态：`vendor\staging\<ver>\profile` 里 **240 个 @deepseek-ai/* 包被掏空成空目录**
//   （连 package.json 都没了），磁盘从 ~11000 文件掉到 4000。**"目录还在、文件全没"是
//   `del /s /q` 这类"只删文件不删目录"操作的特征**——而只要那条路径上有一个指向 `@deepseek-ai`
//   的 junction，一次这样的删除就顺带掏出全部 240 个包。这与观测完全吻合。
//
//   已验证的事实：`fs.rmSync(dir, {recursive:true})` **不会**跟随 junction（最小复现：目标 2 个
//   文件，删除后仍是 2 个）。所以危险不在 Node 的 API，而在"别人怎么删这个目录"——Windows 上
//   **`rmdir /s /q` 与 `del /s /q` 会跟随 junction**，那是系统级行为，我们改不了。
//
// 结论：凡是**我们自己**删除可能含 junction 的目录（门禁的隔离 HOME、%TEMP% 残留），
// 一律走本模块——先逐个 unlink 链接本身，绝不递归进链接目标。别人怎么删管不了，
// 但至少我们能保证"自己经手的删除不会掏空被测树或现网树"。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** 门禁隔离 HOME 的目录名前缀（`fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bootgate-'))`）。 */
export const BOOTGATE_PREFIX = 'dsh-bootgate-'

/**
 * 递归删除，**遇到 junction/symlink 只 unlink 链接本身，绝不进入目标**。
 *
 * 两处失败回落（2026-09-14 补，此前只记日志就跳过）：
 *   · **链接 unlink 失败** → 退 `rmdirSync`。POSIX 上 `unlink` 对目录型链接本应成功，但某些
 *     文件系统（FUSE/NFS）会返回 `EISDIR/EPERM`；Windows 上被占用的 junction 也会失败。
 *     不回落的话父目录永远非空、整个删除半途而废，而调用方看到的是"清理过了"。
 *   · **目录 rmdir 失败** → 若里面确实什么都不剩（都被删掉了），再试一次并记日志；
 *     仍失败就如实记"残留"，**不假装删干净**（调用方据此决定是否重试或告警）。
 * 无论哪种回落，都**不会**进入链接目标 —— 本模块的安全性不因失败回落而降低。
 * @param {string} target 待删路径
 * @param {{log?:(m:string)=>void}} [opts] 选项
 * @returns {{removed:boolean, unlinked:number, leftovers:number, reason?:string}} 统计
 *   `leftovers` 是"删不掉、留在原地"的条目数（>0 表示没清干净，调用方可据此告警/重试）
 */
export function safeRemoveTree(target, { log = () => {} } = {}) {
  const stats = { removed: false, unlinked: 0, leftovers: 0 }
  const unlinkOrRmdir = (p, isLink) => {
    try {
      fs.unlinkSync(p)
      if (isLink) stats.unlinked += 1
      return true
    } catch (e) {
      // 回落 1：目录型链接（POSIX 的 symlink→dir / Windows 的 junction）用 rmdir 同样只删链接本身
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
    // 链接（含 Windows junction）只删链接本身——这是本模块存在的全部理由
    if (lst.isSymbolicLink()) { unlinkOrRmdir(p, true); return }
    if (!lst.isDirectory()) { unlinkOrRmdir(p, false); return }
    let entries = []
    try { entries = fs.readdirSync(p, { withFileTypes: true }) } catch (e) {
      stats.leftovers += 1
      log(`[junction-safe] 读取失败（残留）：${p} — ${e.message}`)
      return
    }
    for (const e of entries) walk(path.join(p, e.name))
    // 目录删除失败通常是"里面还有删不掉的东西"：重试一次再放弃，并把残留计数交给调用方
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
 * 列出遗留的门禁隔离 HOME。
 *
 * 为什么要清理遗留：门禁正常路径会在 finally 里自删，**留下的都意味着上次"没走完 finally"**
 * （壳被强杀、断电、用户重启应用）。而这些残留目录里带着指向被测树的 junction 场——
 * 交给任何"跟随 junction"的清理动作就会掏空目标。所以壳每次启动先自己安全地收掉。
 * @param {{tmpDir?:string, minAgeMs?:number, now?:number}} [opts] 选项（minAgeMs 用于避开正在跑的实例）
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
    // 链接本身不碰（那可能是别的什么），只收真实目录
    if (st.isSymbolicLink() || !st.isDirectory()) continue
    // 必须用**创建时间**而不是修改时间：目录内容的任何变动都会刷新 mtime，会让"正经在跑的
    // 门禁"被误判成遗留——写这条单测时正是这么被自己的测试坑了一次。birthtime 在 NTFS 上可用。
    const born = Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs
    // 年龄判据是**粗粒度**的，不能当秒表用：POSIX 上 btime 与 `Date.now()` 走的是不同时钟源
    // （ext4/overlayfs 的 btime 可能比 wall clock 大几毫秒），负年龄一律按 0 处理——保守方向是
    // "当成刚创建、这次不动它"，否则残留门禁目录在 Linux/macOS 上会被**永久跳过**（CI 实测：
    // minAgeMs=0 时刚建好的目录一个都收不上来，见坑 99）。
    const age = Math.max(0, now - born)
    // 年轻的不动：可能正有一次门禁在跑（门禁超时上限 90s，默认 10 分钟足够宽松）
    if (age < minAgeMs) continue
    out.push(p)
  }
  return out
}

/**
 * 安全清理遗留门禁目录。壳启动时调用（失败不阻断启动）。
 * @param {{tmpDir?:string, minAgeMs?:number, now?:number, log?:(m:string)=>void}} [opts] 选项
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
