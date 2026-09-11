// dsh-apply.mjs — 待应用更新的落盘状态与"换树"动作（纯 Node、零 Electron 依赖、全同步）
//
// 为什么全同步：换树本身只是**同卷内的两次 rename**（瞬时、零拷贝），且它必须发生在主进程极早期
// ——早于 `findDshBin` 的求值。时序原因见 main.mjs 里 `dshBin()` 旁的注释（坑：DSH_BIN 若先求值，
// 换树会让它指向已被改名走开的旧树，宿主直接起不来）。
//
// 为什么单独成模块：与 admin.mjs / repair.mjs 同款姿态——纯 Node 可离线单测。换树是本功能里
// **唯一不可逆**的动作（Q4 已决定不做回滚备份），它的每一条失败分支都必须能在没有真实 vendor 树的
// 情况下复现，否则只能靠真换一次树去试，而试错的代价是用户重装。
import fs from 'node:fs'
import path from 'node:path'

/** 待应用更新的落盘标记（在 APP_DATA 下，供"重启后新进程"读取）。 */
export const PENDING_FILE = 'pending-vendor.json'

/**
 * 换树时旧树的改名前缀。删除时机推迟到**新树确认可用之后**——这不是回滚功能（Q4 已取消备份），
 * 只是删除时机：rename 与删除同价，晚删一步不花任何成本，却能在新树起不来时保留现场。
 */
export const OLD_PREFIX = 'profile.old-'

/** 旧 lock 的改名前缀（与 OLD_PREFIX 配套，一起清理）。 */
export const OLD_LOCK_PREFIX = 'vendor.lock.json.old-'

/**
 * 读待应用标记。**任何异常都返回 null**——标记损坏不该阻断应用启动，那不是用户能处理的故障。
 * @param {string} appData 壳数据目录
 * @returns {{stagingRoot:string, target:string, from?:string, createdAt?:string}|null}
 */
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
 * 写待应用标记。非原子写在最坏情况下留下一个坏 JSON，而 readPending 对此是容错的（当作"没有待
 * 应用更新"），所以不引入额外的原子写机制。
 * @param {string} appData 壳数据目录
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

/**
 * 校验暂存树是否完整可换。挡的是两类东西：构建半途中断留下的残树，以及"构建完又被别的东西改过"。
 * @param {string} stagingRoot 暂存根（含 profile/ 与 vendor.lock.json）
 * @param {{target?:string}} [opts] target 存在时额外校验版本一致性
 * @returns {{ok:boolean, error?:string, profileDir?:string, lockPath?:string, lock?:object}}
 */
export function validateStaging(stagingRoot, { target } = {}) {
  if (typeof stagingRoot !== 'string' || stagingRoot === '') return { ok: false, error: '标记缺少 stagingRoot' }
  const profileDir = path.join(stagingRoot, 'profile')
  const lockPath = path.join(stagingRoot, 'vendor.lock.json')
  // bin.js 是宿主入口：它在，树才起得来。少了它就是半途中断的构建。
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
 * 执行换树：`vendor/profile` 让位改名 → 暂存树 rename 就位 → lock 跟随。
 *
 * stagingRoot 必须与 vendorDir **同卷**（rename 跨卷会 EXDEV）。调用方把暂存区放在 `<vendorDir>/staging/`
 * 下就是为了保证这一点，本函数不做兜底复制——静默退化成复制 120MB 会让"瞬时换树"的假设失效。
 * @param {{vendorDir:string, stagingRoot:string, log?:(m:string)=>void}} o 选项
 * @returns {{ok:boolean, error?:string, oldProfileDir?:string|null, oldLockPath?:string|null}}
 */
export function swapVendorTree({ vendorDir, stagingRoot, log = () => {} }) {
  const profileDir = path.join(vendorDir, 'profile')
  const lockPath = path.join(vendorDir, 'vendor.lock.json')
  const stageProfile = path.join(stagingRoot, 'profile')
  const stageLock = path.join(stagingRoot, 'vendor.lock.json')
  const stamp = Date.now()
  const oldProfile = path.join(vendorDir, `${OLD_PREFIX}${stamp}`)
  const oldLock = path.join(vendorDir, `${OLD_LOCK_PREFIX}${stamp}`)

  // 旧树改名让位而不是直接删除：删了就没退路，而改名零成本。
  const hadProfile = fs.existsSync(profileDir)
  if (hadProfile) fs.renameSync(profileDir, oldProfile)
  try {
    fs.renameSync(stageProfile, profileDir)
  } catch (e) {
    // 交换失败必须把旧树放回原位，否则应用连启动都做不到。这是交换的**原子性**，不是回滚功能。
    if (hadProfile) { try { fs.renameSync(oldProfile, profileDir) } catch { /* 放不回只能留人工处理 */ } }
    return { ok: false, error: `换树失败（旧树已放回原位）：${e.message}` }
  }
  // lock 必须跟着换：只换树不换 lock，"当前版本"会显示旧值，误导后续判断与 UI。
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

/**
 * 启动时应用待更新。**失败一律不阻断启动**——此时旧树还在原位（见 main.mjs 的调用点），
 * 应用照常能用，只是没升上去。
 * @param {{appData:string, vendorDir:string, log?:(m:string)=>void}} o 选项
 * @returns {{applied:boolean, skipped?:boolean, error?:string, oldProfileDir?:string|null}}
 */
export function applyPending({ appData, vendorDir, log = () => {} }) {
  const pending = readPending(appData)
  if (pending === null) return { applied: false, skipped: true }

  const check = validateStaging(pending.stagingRoot, { target: pending.target })
  if (!check.ok) {
    // 坏标记必须清掉：留着它每次启动都会重试，而它永远不会变好。
    clearPending(appData)
    log(`[dsh-apply] 丢弃待应用更新：${check.error}`)
    return { applied: false, error: check.error }
  }

  const swap = swapVendorTree({ vendorDir, stagingRoot: pending.stagingRoot, log })
  if (!swap.ok) {
    // 换树失败保留标记？不——旧树已放回原位且可用，留着标记只会让下次启动再失败一次。
    clearPending(appData)
    log(`[dsh-apply] 换树失败，保持旧树运行：${swap.error}`)
    return { applied: false, error: swap.error }
  }
  clearPending(appData)
  // 暂存区此时只剩空壳（profile 已被 rename 走），删掉避免下次被误判成可用暂存。
  try { fs.rmSync(pending.stagingRoot, { recursive: true, force: true }) } catch { /* 非关键 */ }
  return { applied: true, oldProfileDir: swap.oldProfileDir }
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
 * 清理旧树与旧 lock。**只在新树确认可用之后调用**——提前调用就等于放弃了唯一的现场。
 * @param {string} vendorDir vendor 目录
 * @param {(m:string)=>void} [log] 日志
 * @returns {number} 删除的条目数
 */
export function cleanupOldTrees(vendorDir, log = () => {}) {
  let removed = 0
  for (const target of [...listOldProfiles(vendorDir), ...listOldLocks(vendorDir)]) {
    try {
      fs.rmSync(target, { recursive: true, force: true })
      removed += 1
    } catch (e) {
      log(`[dsh-apply] 旧树清理失败（非致命，下次启动会重试）：${target} — ${e.message}`)
    }
  }
  return removed
}
