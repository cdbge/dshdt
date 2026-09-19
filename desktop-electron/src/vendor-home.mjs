// vendor-home.mjs — vendor 树的**归属解析与种子迁移**（纯 Node、零依赖、可离线单测）
//
// 为什么要有它：
//   打包态原先直接在 `resources/vendor` 上换树，而这在 Linux/macOS 上根本走不通 ——
//   · macOS：vendor 在 `DSH Desktop.app/Contents/Resources` 里，改包内容会**破坏代码签名**
//     （hardened runtime/公证后甚至直接拒绝启动）；
//   · Linux AppImage：`resources` 位于**只读 squashfs 挂载**（`/tmp/.mount_*/resources`），rename 直接 EROFS；
//   · Linux deb：`/opt/<name>/resources` 属 root，普通用户 rename 失败。
//   ⇒ 可变的那棵树必须搬到**用户可写、且与 APP_DATA 同卷**的位置（同卷是换树的硬要求：跨卷 rename 会 EXDEV）。
//   包内那份降级为**种子**：首启拷贝一次，之后所有换树都发生在用户数据目录里。
//
// Windows 保持原行为（`resources/vendor` 可写、既有用户已经在那里跑），避免无谓的数据搬迁 ——
// 但解析函数同样适用，将来要统一时只改一个开关。
import fs from 'node:fs'
import path from 'node:path'

/** vendor 目录名。 */
export const VENDOR_DIR_NAME = 'vendor'

/**
 * 解析"当前应当使用哪棵 vendor 树"。
 *
 * 两态：
 *   · `seeded`（Windows 的默认，或调用方显式传 mode:'packaged'）→ 直接用包内 `resources/vendor`；
 *   · `userData`（Linux/macOS 默认）→ 用 `<APP_DATA>/vendor`，包内那份是种子。
 * @param {{appData:string, packagedVendor:string, platform?:string, mode?:'packaged'|'userData'}} o 选项
 * @returns {{dir:string, seedDir:string, source:'packaged'|'userData', needsSeed:boolean}}
 *   `needsSeed` 只在 userData 模式的**首次**为真
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
 * 把包内 vendor 作为**种子**拷到用户数据目录（仅在目标不存在时）。
 *
 * 语义要点：
 *   · **不覆盖**已存在的目标 —— 那是用户正在用的树（可能已经换过版本），覆盖等于把更新回退；
 *   · 链接按链接拷（`dereference:false`）：种子树里若有链接，展开成实体副本会让体积与语义都变；
 *   · 拷贝是"全或全无"：先写到 `<dir>.seeding` 再 rename，中途失败不会留下半棵树被当成可用 vendor
 *     （rename 与目标同目录、必然同卷，不会 EXDEV）。
 * @param {{dir:string, seedDir:string, log?:(m:string)=>void}} o 选项
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
    // 拷完必须**校验结果真的可用**，不能只看"cpSync 没抛错"。
    // 实测（本轮门禁）：种子目录不存在声明式入口时，`cpSync(..., {recursive:true})` 会
    // 静默产出一个**空目录**而不报错 ⇒ 于是"全或全无"落空、还留下一个空 vendor 让后续判断更乱。
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

/** 递归统计目录（文件数与字节数）；目录不存在返回 0。 */
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
 * 判断用户数据目录里的 vendor 是否**可用**（有 profile 与 lock，且 dsh 入口在位）。
 *
 * 为什么要这一步：种子拷贝失败、用户手工删了半个目录、磁盘满导致解压不全 —— 这些情况下
 * 直接用它会让宿主在 import 期就崩，而**包内那份是好的**。所以宁可回退到包内种子，
 * 也不要让应用起不来（回退是降级，不是静默：调用方把这件事写进日志与 `--diag`）。
 *
 * 判据只查**存在性**，不解析内容 —— 内容层面的判据各有归属：
 *   · lock 能否解析、文件数够不够 → `vendor-baseline.mjs` 的 `readVendorBaseline` / `assessVendorIntegrity`；
 *   · 原生模块能否加载 → 构建期/换树前的 ABI 门禁。
 * 这里混进内容校验只会让"能不能用"这句话有多个互相矛盾的定义。
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
