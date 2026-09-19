// harness-compat.mjs — 「这个 DSH 版本能不能在当前 Electron 上跑」的判据（纯 Node，零依赖，不写文件、不起进程）。
import fs from 'node:fs'
import path from 'node:path'
import { compareVersions, parseVersion } from './dsh-update.mjs'

/**
 * 从哪个 harness 版本起 profile 解析默认走 `runtime`（即必须给 Node 内部 loader 打补丁）。
 * 依据是两个版本 profile-boot 源码里 `options.resolutionMode ?? "link"` → `?? "runtime"` 的变化。
 */
export const RUNTIME_RESOLUTION_FROM = '0.1.6-alpha.2'

/** addon 平台包名前缀（白名单在它的 `prebuilt/*.node` 里）。 */
export const ADDON_PACKAGE_PREFIX = 'node-addon-require-builtin-'
/**
 * 解析 addon 二进制里编译进的运行时白名单（label ↔ V8 指纹成对）。
 * 白名单没有 JS/JSON 副本，只能按字符串表解析；用 latin1 解码以逐字节保序。
 */
export function parseAddonFingerprints(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf)
  // V8 串是四段数字（15.0.245.13-electron.0），且字段间的 NUL 不止一个（编译器按对齐补 0）
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
 * 读不到不是错误：此时 `known:false`，调用方应放行（让启动门禁去兜），不能把用户卡死。
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
    try { files = readdir(prebuilt) } catch { continue }  // 本地编译形态没有 prebuilt/ → 换下一个
    for (const file of files) {
      if (!String(file).endsWith('.node')) continue
      const abs = path.join(prebuilt, String(file))
      let parsed
      try { parsed = parseAddonFingerprints(readFile(abs)) } catch { continue }
      if (parsed.fingerprints.length === 0) continue
      return {
        known: true,
        file: abs,
        fingerprints: [...new Set(parsed.fingerprints)],
        labels: [...new Set(parsed.labels)],
      }
    }
  }
  return { known: false, fingerprints: [], labels: [], error: `${addonDir} 下没找到带运行时白名单的预编译（${ADDON_PACKAGE_PREFIX}*/prebuilt/*.node）` }
}

/**
 * 这个 harness 版本是否需要运行时解析补丁。
 * @returns {{needed:boolean, assumed:boolean, reason:string}} assumed=true 表示版本串没法比，按新版本处置
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
 * `blocked` = 确定跑不起来必须拦；`warn` = 判不准只提示；其余放行。
 * `allowUnsupported`（壳传 DSH_UPDATE_ALLOW_INCOMPATIBLE=1）是人显式要求放行，
 * 没有这个口子时本机白名单过期会把用户永久卡死。
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
  // 不在白名单里，但该版本不需要补丁（link 解析跳过 requireBuiltin）⇒ 照样能跑
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
