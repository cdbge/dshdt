// harness-compat.mjs — 「这个 DSH 版本能不能在当前 Electron 上跑」的判据（纯 Node，零 Electron 依赖）
//
// 为什么需要它：
//   用户在壳内点「DSH 更新」（0.1.6-alpha.1 → 0.1.6-alpha.2），npm 装完 121 MB 的树、ABI 门禁全绿，
//   然后**启动门禁**报「宿主提前退出（code=1）」——宿主启动不到 1 秒就死了，而当时的门禁不落盘
//   stderr，日志里只剩一行分隔行。拿暂存树手工复现，真因是：
//     node-addon-require-builtin unsupported: Unsupported/no-context
//     (unsupported Electron runtime fingerprint: Node 24.18.1, V8 15.0.245.28-electron.0
//      (supported Electron versions: 43.0.0, 44.0.0, 45.0.0-alpha.6))
//
//   两个事实叠在一起才成灾：
//     ① 0.1.6-alpha.2 起，harness 的 profile 解析默认模式从 `link` 变成 `runtime`
//        （两个产物里的原文：alpha.1 `options.resolutionMode ?? "link"`，alpha.2 `?? "runtime"`）。
//        runtime 模式**必须**给 Node 内部 loader 打补丁（PluginPackages → installProfileResolution
//        → requireBuiltin('internal/modules/esm/loader')），而 link 模式直接传 `{}` 跳过它——
//        这就是同一棵 Electron 43.4.0 上 alpha.1 活得好好的原因。
//     ② 那套补丁是原生 addon 靠**扫 V8 内存布局**（realm vptr / vtable）实现的，所以它按
//        **精确 V8 指纹**白名单放行，而不是按 Electron 主版本。白名单编译在 .node 里，
//        实测字符串表（从 `node-addon-require-builtin-win32-x64-msvc/prebuilt/*.node` dump）：
//            43.0.0          → 15.0.245.13-electron.0
//            44.0.0          → 15.2.124.13-electron.0
//            45.0.0-alpha.6  → 15.4.80-electron.0
//        壳里钉的 `^43.4.0` 装出来是 43.4.0，V8 = 15.0.245.**28**（白名单里是 …13）⇒ 不在表里。
//        registry 上 node-addon-require-builtin / node-addon-native-custom-loader **最新就是 0.1.6**
//        （与树里同版本），所以"换个 addon 版本"这条路不存在。
//
//   结论：这个冲突**在下载任何东西之前就能算出来**——白名单就在本机已装的 addon 二进制里，
//   当前 Electron 的指纹就在 process.versions.v8 里。本模块只做这件事，**不写文件、不起进程**。
import fs from 'node:fs'
import path from 'node:path'
import { compareVersions, parseVersion } from './dsh-update.mjs'

/**
 * 从哪个 harness 版本起，profile 解析默认走 `runtime`（即必须打 Node 内部 loader 补丁）。
 *
 * 证据是两个产物的 profile-boot 源码，不是猜的：
 *   0.1.6-alpha.1  `const resolutionMode = process.pkg !== void 0 ? "runtime" : options.resolutionMode ?? "link"`
 *   0.1.6-alpha.2  `… : options.resolutionMode ?? "runtime"`
 * 早于它的版本走 link，不需要那个补丁 ⇒ 不受 V8 白名单约束（本机 43.4.0 能跑）。
 */
export const RUNTIME_RESOLUTION_FROM = '0.1.6-alpha.2'

/** addon 平台包名前缀（白名单在它的 `prebuilt/*.node` 里）。 */
export const ADDON_PACKAGE_PREFIX = 'node-addon-require-builtin-'

/**
 * 解析 addon 二进制里编译进的运行时白名单（label ↔ V8 指纹成对）。
 *
 * 为什么读二进制：白名单没有任何 JS/JSON 副本（`prebuilds.json` 只写文件名，版本检查在 C++ 里），
 * 所以只能按字符串表解析。字符串表形态是 `标签\0V8 指纹\0electron-NN tagged default=0\0`。
 * 用 latin1 解码：它逐字节保序，`\0` 不会被吞（utf8 也不吞，但 latin1 对任意二进制都安全）。
 * @param {Buffer|string} buf .node 文件内容（或已解码文本）
 * @returns {{pairs:{label:string,v8:string}[], labels:string[], fingerprints:string[]}}
 */
export function parseAddonFingerprints(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf)
  // 两个细节都是实测逼出来的，改的时候别再"顺手简化"：
  //   ① V8 串是**四段**数字（15.0.245.13-electron.0）——只写 `\d+\.\d+\.\d+` 会漏掉所有四段条目
  //      （第一版正是这么写的，于是白名单只剩 "15.4.80-electron.0" 一条，守卫把该放行的也拦了）；
  //   ② 字段之间的 NUL **不止一个**（编译器按对齐补 0：实测 `43.0.0` 后面是 6 个 `\0`，
  //      `44.0.0` 后面是 2 个）——只认单个 `\x00` 在真实二进制上**一个都匹配不到**。
  const re = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\x00{1,8}(\d+(?:\.\d+)+-electron\.\d+)\x00{1,8}/g
  const pairs = []
  let m = re.exec(text)
  while (m !== null) {
    pairs.push({ label: m[1], v8: m[2] })
    m = re.exec(text)
  }
  return { pairs, labels: pairs.map((p) => p.label), fingerprints: pairs.map((p) => p.v8) }
}

/**
 * 从已安装的 vendor 树里读出运行时白名单。
 *
 * 读不到**不是**错误：开发态可能没有随包 vendor，或 addon 换了目录布局。此时 `known:false`，
 * 调用方应**放行**（让启动门禁去兜），而不是把用户卡死——判据读不到时拒绝一切更新，比不判更糟。
 * @param {{addonDir?:string, readdir?:Function, readFile?:Function, exists?:Function}} [o] 选项（可注入以便单测）
 * @returns {{known:boolean, fingerprints:string[], labels:string[], file?:string, error?:string}}
 */
export function readAddonFingerprints({ addonDir, readdir = fs.readdirSync, readFile = fs.readFileSync, exists = fs.existsSync } = {}) {
  if (typeof addonDir !== 'string' || addonDir === '') return { known: false, fingerprints: [], labels: [], error: '未提供 addon 目录' }
  if (!exists(addonDir)) return { known: false, fingerprints: [], labels: [], error: `读不到 addon 目录：${addonDir}` }
  let entries = []
  try { entries = readdir(addonDir) } catch (e) {
    return { known: false, fingerprints: [], labels: [], error: `列不出 ${addonDir}：${e.message}` }
  }
  const platformDirs = entries.filter((n) => String(n).startsWith(ADDON_PACKAGE_PREFIX))
  for (const name of platformDirs) {
    const prebuilt = path.join(addonDir, String(name), 'prebuilt')
    let files = []
    try { files = readdir(prebuilt) } catch { continue }  // 该平台包没有 prebuilt/（本地编译形态）→ 换下一个
    for (const file of files) {
      if (!String(file).endsWith('.node')) continue
      const abs = path.join(prebuilt, String(file))
      let parsed
      try { parsed = parseAddonFingerprints(readFile(abs)) } catch { continue }
      if (parsed.fingerprints.length === 0) continue
      return {
        known: true,
        file: abs,
        // 去重但保序：同一张表可能被引用两次
        fingerprints: [...new Set(parsed.fingerprints)],
        labels: [...new Set(parsed.labels)],
      }
    }
  }
  return { known: false, fingerprints: [], labels: [], error: `${addonDir} 下没找到带运行时白名单的预编译（${ADDON_PACKAGE_PREFIX}*/prebuilt/*.node）` }
}

/**
 * 这个 harness 版本是否需要"运行时解析补丁"。
 * @param {string} version harness 版本
 * @returns {{needed:boolean, assumed:boolean, reason:string}} assumed=true 表示版本串没法比，只能按新版本处置
 */
export function needsRuntimeResolution(version) {
  const v = String(version ?? '').trim()
  if (parseVersion(v) === null) {
    return { needed: true, assumed: true, reason: `版本串无法解析（${JSON.stringify(version)}），按"需要运行时解析"处置` }
  }
  if (compareVersions(v, RUNTIME_RESOLUTION_FROM) >= 0) {
    return { needed: true, assumed: false, reason: `${v} ≥ ${RUNTIME_RESOLUTION_FROM}，默认用 runtime 解析` }
  }
  return { needed: false, assumed: false, reason: `${v} < ${RUNTIME_RESOLUTION_FROM}，默认用 link 解析（不需要运行时补丁）` }
}

/**
 * 综合判据：目标 harness 版本 × 当前 Electron 指纹 × 本机 addon 白名单。
 *
 * 三态语义（调用方按 `blocked` / `warn` 分流）：
 *   - `blocked:true` —— **确定跑不起来**（版本确定需要补丁，而当前指纹不在白名单里）⇒ 必须拦在构建之前；
 *   - `warn:true`    —— **判不准**（版本串无法解析）但指纹不在白名单里 ⇒ 只提示，不拦；
 *   - 其余           —— 放行（在表里，或该版本根本不需要补丁，或本机读不到白名单）。
 * @param {{version:string, addonDir?:string, addon?:object, v8?:string, electron?:string, allowUnsupported?:boolean}} o 选项
 *   `allowUnsupported`：人**显式**要求"就算跑不起来也试一次"（壳由 `DSH_UPDATE_ALLOW_INCOMPATIBLE=1` 传进来）。
 *   为什么必须有这个口子：白名单读的是**本机已装**那棵树里的 addon，将来若新 harness 换了更宽的 addon，
 *   本机这份就会过期 ⇒ 守卫会拦下一次其实能成的更新。硬拦 + 无出口 = 把用户永久卡死。
 * @returns {{ok:boolean, blocked:boolean, warn:boolean, unknown:boolean, needed:boolean, supported:boolean|null,
 *   overridden?:boolean, v8:string, electron:string, labels:string[], fingerprints:string[], reason:string}}
 */
export function assessHarnessCompat({ version, addonDir, addon, v8, electron, allowUnsupported = false } = {}) {
  const table = addon ?? readAddonFingerprints({ addonDir })
  const need = needsRuntimeResolution(version)
  const v8v = v8 ?? process.versions.v8
  const ev = electron ?? process.versions.electron
  const base = { ok: true, blocked: false, warn: false, unknown: false, needed: need.needed, supported: null, v8: v8v, electron: ev, labels: table.labels ?? [], fingerprints: table.fingerprints ?? [] }
  if (table.known !== true) {
    return { ...base, unknown: true, reason: `读不到本机 addon 的运行时白名单（${table.error ?? '未知原因'}），跳过兼容判据（启动门禁会兜住）` }
  }
  const supported = table.fingerprints.includes(v8v)
  if (supported) {
    return { ...base, supported: true, reason: `当前 Electron ${ev}（V8 ${v8v}）在运行时白名单里（${table.labels.join(' / ')}）` }
  }
  // 不在白名单里，但该版本不需要补丁（link 解析直接跳过 requireBuiltin）⇒ 照样能跑
  if (!need.needed) {
    return { ...base, supported: false, reason: `${need.reason}，不需要运行时补丁 ⇒ 当前 Electron ${ev} 可用` }
  }
  const detail = `当前壳是 Electron ${ev}（V8 ${v8v}），不在白名单（${table.labels.join(' / ')}）里`
  if (allowUnsupported === true) {
    return {
      ...base,
      supported: false,
      warn: true,
      overridden: true,
      reason: `${need.reason}；而 ${detail} ⇒ 构建很可能卡在启动门禁，但你显式要求放行（DSH_UPDATE_ALLOW_INCOMPATIBLE=1）`,
    }
  }
  if (need.assumed) {
    return { ...base, supported: false, warn: true, reason: `${need.reason}；而 ${detail} ⇒ 构建可能卡在启动门禁（先跑跑看，失败不会动现有树）` }
  }
  return {
    ...base,
    ok: false,
    blocked: true,
    supported: false,
    reason: `${version} 起 DSH 默认用 runtime 解析，必须给 Node 内部 loader 打补丁，而那套补丁按精确 V8 指纹放行：${detail}`
      + ` ⇒ 构建一定卡在启动门禁（宿主启动即退出）。请先更新桌面端（换到白名单内的 Electron），再更新 DSH。`,
  }
}
