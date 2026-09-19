// vendor-home.mjs — vendor 树的归属解析与种子迁移（纯 Node，零依赖，可离线单测）。
// Linux/macOS 用用户数据目录下的 vendor，包内那份只作种子；Windows 仍直接用包内 vendor。
import fs from 'node:fs'
import path from 'node:path'

/** vendor 目录名。 */
export const VENDOR_DIR_NAME = 'vendor'

/**
 * 解析当前应使用哪棵 vendor 树。
 * `packaged` 用包内 `resources/vendor`，`userData` 用 `<APP_DATA>/vendor`（包内那份是种子）。
 * @param {{appData:string, packagedVendor:string, platform?:string, mode?:'packaged'|'userData'}} o
 * @returns {{dir:string, seedDir:string, source:'packaged'|'userData', needsSeed:boolean}}
 *   `needsSeed` 只在 userData 模式首次为真
 */
export function resolveVendorHome({ appData, packagedVendor, platform = process.platform, mode }) {
  const effective = mode ?? (platform === 'win32' ? 'packaged' : 'userData')
  if (effective === 'packaged') {
    return { dir: packagedVendor, seedDir: packagedVendor, source: 'packaged', needsSeed: false }
  }
  const dir = path.join(appData, VENDOR_DIR_NAME)
  return { dir, seedDir: packagedVendor, source: 'userData', needsSeed: !fs.existsSync(dir) }
}

/**
 * 把包内 vendor 作为种子拷到用户数据目录（仅在目标不存在时）。
 * 不覆盖已存在的目标；链接按链接拷；先写 `<dir>.seeding` 再 rename，保证全或全无。
 * @param {{dir:string, seedDir:string, log?:(m:string)=>void}} o
 * @returns {{seeded:boolean, reason?:string, bytes?:number, files?:number}}
 */
export function seedVendorHome({ dir, seedDir, log = () => {} }) {
  if (fs.existsSync(dir)) return { seeded: false, reason: 'already-present' }
  if (!fs.existsSync(seedDir)) return { seeded: false, reason: 'seed-missing' }
  const staging = `${dir}.seeding`
  try {
    fs.rmSync(staging, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    fs.cpSync(seedDir, staging, { recursive: true, dereference: false, verbatimSymlinks: true })
    // 种子缺声明式入口时 cpSync 会静默产出空目录而不报错，所以必须校验结果
    const staged = inspectVendorHome(staging)
    if (!staged.usable) {
      fs.rmSync(staging, { recursive: true, force: true })
      log(`[vendor-home] 种子拷贝结果不可用（${staged.reason}）→ 放弃，改用包内 vendor`)
      return { seeded: false, reason: `seed-incomplete: ${staged.reason}` }
    }
    fs.renameSync(staging, dir)
    const stats = dirStats(dir)
    log(`[vendor-home] 已把随包 vendor 拷为种子 → ${dir}（${stats.files} 文件 / ${(stats.bytes / 1048576).toFixed(1)} MB）`)
    return { seeded: true, ...stats }
  } catch (e) {
    try { fs.rmSync(staging, { recursive: true, force: true }) } catch { /* 尽力清理 */ }
    log(`[vendor-home] 种子拷贝失败（将回退用包内 vendor）：${e.message}`)
    return { seeded: false, reason: `copy-failed: ${e.message}` }
  }
}

/** 递归统计目录的文件数与字节数；目录不存在返回 0。 */
export function dirStats(dir) {
  let files = 0
  let bytes = 0
  const walk = (d) => {
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) {
        files += 1
        try { bytes += fs.statSync(p).size } catch { /* 并发删除则略过 */ }
      }
    }
  }
  walk(dir)
  return { files, bytes }
}

/**
 * 判断 vendor 目录是否可用（存在 profile / lock / dsh 入口）。
 * 只查存在性，不解析内容；不可用时调用方回退到包内种子。
 * @param {string} dir vendor 目录
 * @returns {{usable:boolean, hasProfile:boolean, hasLock:boolean, hasBin:boolean, reason?:string}}
 */
export function inspectVendorHome(dir) {
  const hasProfile = fs.existsSync(path.join(dir, 'profile', 'package.json'))
  const hasLock = fs.existsSync(path.join(dir, 'vendor.lock.json'))
  const hasBin = fs.existsSync(path.join(dir, 'profile', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  const usable = hasProfile && hasLock && hasBin
  return {
    usable, hasProfile, hasLock, hasBin,
    reason: usable ? undefined : `vendor 不完整（profile=${hasProfile} lock=${hasLock} bin=${hasBin}）`,
  }
}
