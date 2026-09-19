// dsh-apply.mjs — 待应用更新的落盘状态与换树动作（纯 Node，零 Electron 依赖，全同步）。
// 换树是同卷内的两次 rename，必须发生在主进程极早期、早于 findDshBin 求值。
import fs from 'node:fs'
import path from 'node:path'
import { safeRemoveTree } from './junction-safe.mjs'

/** 待应用更新的落盘标记（在 APP_DATA 下，供重启后的新进程读取）。 */
export const PENDING_FILE = 'pending-vendor.json'

/** 换树时旧树的改名前缀。删除推迟到新树确认可用之后。 */
export const OLD_PREFIX = 'profile.old-'

/** 旧 lock 的改名前缀（与 OLD_PREFIX 配套，一起清理）。 */
export const OLD_LOCK_PREFIX = 'vendor.lock.json.old-'

/** 读待应用标记，任何异常都返回 null（标记损坏不该阻断启动）。 */
export function readPending(appData) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(appData, PENDING_FILE), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    if (typeof parsed.stagingRoot !== 'string' || typeof parsed.target !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 写待应用标记。非原子写最坏留下坏 JSON，readPending 对此容错。
 * @param {{stagingRoot:string, target:string, from?:string}} payload 待应用内容
 */
export function writePending(appData, payload) {
  fs.mkdirSync(appData, { recursive: true })
  const body = { ...payload, createdAt: new Date().toISOString() }
  fs.writeFileSync(path.join(appData, PENDING_FILE), JSON.stringify(body, null, 2) + '\n')
  return body
}

/** 清除待应用标记（应用成功或标记已判定不可用后调用）。 */
export function clearPending(appData) {
  fs.rmSync(path.join(appData, PENDING_FILE), { force: true })
}

/** 校验暂存树是否完整可换：挡构建半途中断的残树，以及构建后被改过的树。 */
export function validateStaging(stagingRoot, { target } = {}) {
  if (typeof stagingRoot !== 'string' || stagingRoot === '') return { ok: false, error: '标记缺少 stagingRoot' }
  const profileDir = path.join(stagingRoot, 'profile')
  const lockPath = path.join(stagingRoot, 'vendor.lock.json')
  // bin.js 是宿主入口，少了它就是半途中断的构建
  const dshBin = path.join(profileDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!fs.existsSync(dshBin)) return { ok: false, error: `暂存树不完整（缺 dsh bin.js）：${dshBin}` }
  if (!fs.existsSync(lockPath)) return { ok: false, error: `暂存树不完整（缺 vendor.lock.json）：${lockPath}` }
  let lock
  try {
    lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
  } catch (e) {
    return { ok: false, error: `vendor.lock.json 不可解析：${e.message}` }
  }
  const actual = lock?.dshVersions?.['@deepseek-ai/dsh']
  if (target !== undefined && actual !== target) {
    return { ok: false, error: `暂存树版本（${String(actual)}）与目标（${target}）不一致` }
  }
  return { ok: true, profileDir, lockPath, lock }
}

/**
 * 执行换树：旧 profile 让位改名 → 暂存树 rename 就位 → lock 跟随。
 * stagingRoot 必须与 vendorDir 同卷（跨卷 rename 会 EXDEV），本函数不做兜底复制。
 */
export function swapVendorTree({ vendorDir, stagingRoot, log = () => {} }) {
  const profileDir = path.join(vendorDir, 'profile')
  const lockPath = path.join(vendorDir, 'vendor.lock.json')
  const stageProfile = path.join(stagingRoot, 'profile')
  const stageLock = path.join(stagingRoot, 'vendor.lock.json')
  const stamp = Date.now()
  const oldProfile = path.join(vendorDir, `${OLD_PREFIX}${stamp}`)
  const oldLock = path.join(vendorDir, `${OLD_LOCK_PREFIX}${stamp}`)

  // 旧树改名让位而不是直接删除：删了就没退路，改名零成本
  const hadProfile = fs.existsSync(profileDir)
  if (hadProfile) fs.renameSync(profileDir, oldProfile)
  try {
    fs.renameSync(stageProfile, profileDir)
  } catch (e) {
    // 交换失败必须把旧树放回原位，否则应用连启动都做不到
    if (hadProfile) { try { fs.renameSync(oldProfile, profileDir) } catch { /* 放不回只能留人工处理 */ } }
    return { ok: false, error: `换树失败（旧树已放回原位）：${e.message}` }
  }
  // lock 必须跟着换，否则"当前版本"会显示旧值
  const hadLock = fs.existsSync(lockPath)
  if (hadLock) { try { fs.renameSync(lockPath, oldLock) } catch { /* lock 非关键，失败不阻断换树 */ } }
  try {
    fs.copyFileSync(stageLock, lockPath)
  } catch (e) {
    log(`[dsh-apply] vendor.lock.json 写入失败（树已换好，非致命）：${e.message}`)
  }
  log(`[dsh-apply] 换树完成：${path.join(stagingRoot, 'profile')} → ${profileDir}`)
  return { ok: true, oldProfileDir: hadProfile ? oldProfile : null, oldLockPath: hadLock ? oldLock : null }
}

/** 启动时应用待更新。失败一律不阻断启动（旧树还在原位，应用照常能用）。 */
export function applyPending({ appData, vendorDir, log = () => {} }) {
  const pending = readPending(appData)
  if (pending === null) return { applied: false, skipped: true }

  const check = validateStaging(pending.stagingRoot, { target: pending.target })
  if (!check.ok) {
    // 坏标记必须清掉，否则每次启动都重试而它永远不会变好
    clearPending(appData)
    log(`[dsh-apply] 丢弃待应用更新：${check.error}`)
    return { applied: false, error: check.error }
  }

  const swap = swapVendorTree({ vendorDir, stagingRoot: pending.stagingRoot, log })
  if (!swap.ok) {
    clearPending(appData)
    log(`[dsh-apply] 换树失败，保持旧树运行：${swap.error}`)
    return { applied: false, error: swap.error }
  }
  clearPending(appData)
  // 暂存区只剩空壳，删掉避免下次被误判成可用暂存；可能含构建期链接场，走安全删除
  try { safeRemoveTree(pending.stagingRoot, { log }) } catch { /* 非关键 */ }
  return { applied: true, oldProfileDir: swap.oldProfileDir, oldLockPath: swap.oldLockPath }
}

/**
 * 兜底回滚：把旧树换回来（旧树已在磁盘上，换回去只是一次 rename）。
 * 只在换树之后、宿主就绪之前失败的场景下有意义。
 */
export function restoreOldTree({ vendorDir, oldProfileDir, oldLockPath, log = () => {} }) {
  const profileDir = path.join(vendorDir, 'profile')
  const lockPath = path.join(vendorDir, 'vendor.lock.json')
  if (typeof oldProfileDir !== 'string' || oldProfileDir === '' || !fs.existsSync(oldProfileDir)) {
    return { ok: false, error: `旧树不存在，无法回滚：${String(oldProfileDir)}` }
  }
  const failedDir = path.join(vendorDir, `profile.failed-${Date.now()}`)
  try {
    if (fs.existsSync(profileDir)) fs.renameSync(profileDir, failedDir)
    fs.renameSync(oldProfileDir, profileDir)
  } catch (e) {
    // 回滚半途失败时尽量把现场摆回去，别让两条路径都不存在
    if (!fs.existsSync(profileDir) && fs.existsSync(failedDir)) {
      try { fs.renameSync(failedDir, profileDir) } catch { /* 留给人工 */ }
    }
    return { ok: false, error: `回滚失败：${e.message}` }
  }
  if (typeof oldLockPath === 'string' && oldLockPath !== '' && fs.existsSync(oldLockPath)) {
    try { fs.copyFileSync(oldLockPath, lockPath) } catch (e) { log(`[dsh-apply] 回滚 vendor.lock.json 失败（非致命）：${e.message}`) }
  }
  log(`[dsh-apply] 已回滚到旧树；起不来的新树留在 ${failedDir}`)
  return { ok: true, failedDir }
}

/** 列出遗留的旧树目录（清理时机：新树确认可用之后）。 */
export function listOldProfiles(vendorDir) {
  try {
    return fs.readdirSync(vendorDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(OLD_PREFIX))
      .map((e) => path.join(vendorDir, e.name))
  } catch {
    return []
  }
}

/** 列出遗留的旧 lock 文件。 */
export function listOldLocks(vendorDir) {
  try {
    return fs.readdirSync(vendorDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.startsWith(OLD_LOCK_PREFIX))
      .map((e) => path.join(vendorDir, e.name))
  } catch {
    return []
  }
}

/**
 * 清理旧树与旧 lock，只在新树确认可用之后调用。
 * 旧树里含构建期链接场，必须走安全删除。@returns 删除的条目数
 */
export function cleanupOldTrees(vendorDir, log = () => {}) {
  let removed = 0
  for (const target of [...listOldProfiles(vendorDir), ...listOldLocks(vendorDir)]) {
    try {
      const swept = safeRemoveTree(target, { log })
      if (swept.unlinked > 0) log(`[dsh-apply] 清理旧树时解开 ${swept.unlinked} 个链接（未进入其目标）`)
      removed += 1
    } catch (e) {
      log(`[dsh-apply] 旧树清理失败（非致命，下次启动会重试）：${target} — ${e.message}`)
    }
  }
  return removed
}
