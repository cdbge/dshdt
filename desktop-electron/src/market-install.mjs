// market-install.mjs — 市场条目的**下载 → 校验 → 解包 → 落盘 → 挂载**链路（纯逻辑，依赖全部注入）
//
// 设计口径（2026-09-17，用户授权"壳内一键安装（带确认框，会写 $DSH_HOME）"）：
//   · 本模块**不 import electron**，也不自己联网：`fetchImpl` / `destRoot` / `profileDir` 全由调用方注入
//     ⇒ 可以脱网单测，每条失败分支都能造夹具（本项目的规矩：不可逆操作每条失败分支都要有单测）。
//   · **不覆盖已存在的包**：目标目录已存在即拒绝。理由是"静默覆盖"会让用户失去他自己装的那份，
//     而本项目对不可逆操作的既定姿态是"必须先经确认"而不是"顺手替换"。
//   · **绝不碰壳自带的三个插件**：那三个由壳每次启动从 vendor 重建，市场装的同名包会被覆盖，
//     表现为"装完就没了"。所以撞名直接拒绝并说明原因。
//   · 任何一步失败都**不留半成品**：解包在 `.tmp-*` 里做，只有全部检查通过才 rename 进正式位置。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { extractZipSafe } from './zip-safe.mjs'

/** 壳自带的插件名（与 main.mjs 的 PROFILE_PLUGIN_NAMES 同源，由调用方传入以免两处漂移）。 */
export const DEFAULT_BUILTIN_NAMES = ['dsh-desktop-ui', 'dsh-auto-approval', 'dsh-market']

/** 下载体积上限：插件包不该有 64MB 以上（超了本身就是可疑信号，也防内存被撑爆）。 */
export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024

/** 计算 sha256（十六进制小写）。 */
export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/**
 * 默认下载器：https only、限重定向、限体积、带超时。
 *
 * **https 与重定向都在这儿判**（不是只在目录校验时判一次）：下载链接可能经过一次 302，
 * 若允许降到 http，就等于把"审核过的那份"换成了一个途中可被篡改的通道。
 * @param {string} url
 * @param {{fetchImpl?:Function, timeoutMs?:number, maxBytes?:number}} [o]
 * @returns {Promise<{ok:true, buffer:Buffer}|{ok:false, error:string}>}
 */
export async function httpDownload(url, { fetchImpl = fetch, timeoutMs = 60000, maxBytes = MAX_PACKAGE_BYTES } = {}) {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return { ok: false, error: `拒绝非 https 下载地址：${url}` }
  let res
  try {
    res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    return { ok: false, error: `下载请求失败：${e && e.message}` }
  }
  if (!res || typeof res.ok !== 'boolean') return { ok: false, error: '下载器返回了非法响应' }
  if (!res.ok) return { ok: false, error: `下载失败：HTTP ${res.status}` }
  // 跟随重定向之后仍要确认最终落点是 https（fetch 的 response.url 是最终地址）
  const finalUrl = typeof res.url === 'string' && res.url !== '' ? res.url : url
  if (!/^https:\/\//i.test(finalUrl)) return { ok: false, error: `重定向后落到非 https 地址，已拒绝：${finalUrl}` }
  const len = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN)
  if (Number.isFinite(len) && len > maxBytes) return { ok: false, error: `包体积 ${len} 字节超过上限 ${maxBytes}` }
  let buf
  try {
    buf = Buffer.from(await res.arrayBuffer())
  } catch (e) {
    return { ok: false, error: `读取响应失败：${e && e.message}` }
  }
  if (buf.length > maxBytes) return { ok: false, error: `包体积 ${buf.length} 字节超过上限 ${maxBytes}` }
  return { ok: true, buffer: buf }
}

/**
 * 安装一条市场条目。
 *
 * @param {object} entry 目录里的条目（已由壳的 readMarketCatalog 规范化过）
 * @param {object} deps
 * @param {string} deps.destRoot   插件位根目录（`$DSH_HOME/profiles/web/node_modules`）
 * @param {string} deps.profileDir profile 目录（挂载行写在它的 cordis.patch.yml）
 * @param {string[]} [deps.builtinNames] 壳自带插件名（撞名即拒绝）
 * @param {Function} [deps.download] 下载器（默认 httpDownload；测试注入假实现）
 * @param {Function} deps.mount    写挂载行（`ensureProfilePluginMount`）
 * @param {Function} deps.removeTree 安全删除（`safeRemoveTree`），用于清理临时目录
 * @param {(m:string)=>void} [deps.log]
 * @returns {Promise<{ok:true, dir:string, files:number, bytes:number, mounted:boolean, needsRestart:true, notes:string[]}
 *                  |{ok:false, error:string, stage:string}>}
 */
export async function installMarketEntry(entry, deps) {
  const {
    destRoot, profileDir, builtinNames = DEFAULT_BUILTIN_NAMES, download = httpDownload,
    mount, removeTree, log = () => {},
  } = deps
  const notes = []
  /** 统一的失败出口：带上"在哪一步失败"，排障时比一句错误有用得多。 */
  const bad = (stage, error) => ({ ok: false, stage, error })

  // ── 0) 入参自检 ──────────────────────────────────────────────
  if (!entry || typeof entry !== 'object') return bad('validate', '条目不是对象')
  const id = String(entry.id || '')
  if (id === '') return bad('validate', '条目缺少 id')
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) return bad('validate', `id 含非法字符：${id}`)
  if (builtinNames.includes(id)) {
    return bad('validate', `「${id}」是 dshdt 自带插件，不能从市场安装：壳每次启动都会用包内那份重建它，装了也会被覆盖`)
  }
  const url = entry.download && entry.download.url ? String(entry.download.url) : ''
  const wantSha = entry.download && entry.download.sha256 ? String(entry.download.sha256).toLowerCase() : ''
  if (url === '') return bad('validate', '该条目没有下载地址')
  if (!/^https:\/\//i.test(url)) return bad('validate', `下载地址必须是 https：${url}`)
  // **sha256 是硬要求**：没有它就无法判断"下到的是不是你审过的那一份"，宁可不装。
  if (!/^[0-9a-f]{64}$/.test(wantSha)) {
    return bad('validate', '该条目没有有效的 sha256，无法确认下载内容与你审核的一致，已拒绝安装')
  }
  if (typeof mount !== 'function' || typeof removeTree !== 'function') return bad('validate', '内部装配缺失（mount/removeTree）')

  // ── 1) 下载 ─────────────────────────────────────────────────
  const dl = await download(url)
  if (!dl || dl.ok !== true) return bad('download', (dl && dl.error) || '下载失败')
  const buf = dl.buffer

  // ── 2) 校验哈希（"确保装的是你审过的那一份"就靠这一步）──────
  const gotSha = sha256Hex(buf)
  if (gotSha !== wantSha) {
    return bad('verify', `下载内容与你审核时不一致，已拒绝安装（期望 ${wantSha.slice(0, 12)}…，实际 ${gotSha.slice(0, 12)}…）。`
      + '可能是作者改动了内容或链接指向变了——请让维护者重新审核该条目')
  }

  // ── 3) 解包到临时目录（安全解包：zip-slip/ADS/歧义路径都在这里被拒）──
  const target = path.join(destRoot, id)
  if (fs.existsSync(target)) {
    return bad('stage', `已经装过「${id}」（${target}）。先卸载或改名，避免静默覆盖你自己装的那一份`)
  }
  const staging = path.join(destRoot, `.tmp-install-${id}-${Date.now().toString(36)}`)
  let movedIn = false
  try {
    fs.mkdirSync(staging, { recursive: true })

    // ⚠️ 这里开始到 rename 之间的**每一次 early return 都必须走同一个 finally**。
    // 第一版把"解包 + 结构检查"放在 `try { ... } finally { 清理 }` 里，但中间的 `return bad(...)`
    // 是在 finally **之外**（在 try 之前的另一层）——实测每失败一次就在插件位留下一个
    // `.tmp-install-*` 目录（自检里的"没有残留临时目录"断言当场抓到）。现在整段都在 try 内。
    const ex = extractZipSafe(buf, staging)
    if (!ex.ok) return bad('extract', ex.error)
    if (ex.stripped) notes.push(`已剥掉包内顶层目录 ${ex.stripped}/`)

    // ── 4) 结构检查：必须是一个能被 DSH 装载的包 ──
    const pkgPath = path.join(staging, 'package.json')
    if (!fs.existsSync(pkgPath)) {
      return bad('shape', '包里没有 package.json（DSH 按模块解析插件，缺它根本加载不了）。'
        + 'GitHub 的 "Download ZIP" 如果带了两层以上目录，需要维护者重新打包')
    }
    let pkg
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) } catch (e) { return bad('shape', `package.json 不是合法 JSON：${e.message}`) }
    if (!pkg || typeof pkg !== 'object' || typeof pkg.name !== 'string' || pkg.name === '') {
      return bad('shape', 'package.json 里没有 name 字段')
    }
    // 包名必须与条目 id 一致：否则挂载行写的是 id、模块解析找的是 name，两边对不上 → 宿主启动时报找不到模块
    if (pkg.name !== id) {
      return bad('shape', `包名与条目 id 不一致（package.json 里是「${pkg.name}」，条目 id 是「${id}」）——挂载行会挂到一个不存在的模块上`)
    }

    // ── 5) 落盘（同卷 rename，原子）────────────────────────────
    fs.renameSync(staging, target)
    movedIn = true
    notes.push(`已落盘到 ${target}`)
  } catch (e) {
    return bad('stage', `落盘失败：${e && e.message}`)
  } finally {
    // 只要没成功 rename 进去，临时目录就必须消失——留半个包比没装更糟（下次撞"已装过"直接拒绝）
    if (!movedIn) {
      try { removeTree(staging, { log }) } catch (e) { log(`临时目录清理失败（非致命）：${e && e.message}`) }
    }
  }

  // ── 6) 挂载（补丁层是热加载的，但插件源码不热加载 ⇒ 仍需重启宿主）──
  let mounted = false
  try {
    mounted = mount(id, `从 DSH 市场安装：${entry.name || id}`)
    notes.push(mounted ? '已写入 profile 挂载行' : '挂载行已存在（无需重复写入）')
  } catch (e) {
    // 包已经落盘了，挂载失败不该把包删掉，但必须如实报出来
    return { ok: false, stage: 'mount', error: `包已落盘，但写挂载行失败：${e && e.message}` }
  }

  return { ok: true, dir: target, files: 0, bytes: buf.length, mounted, needsRestart: true, notes }
}
