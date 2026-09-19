// vendor-baseline.mjs — vendor 依赖完整性的基线读取与判据（纯 Node，零依赖）。
// 三态必须分开：基线缺失（跳过比对但如实说明）、依赖缺件（阻断启动）、通过。
import fs from 'node:fs'
import path from 'node:path'

/** 低于基线的这个比例即判"依赖缺件"。 */
export const SHORTFALL_RATIO = 0.98

/**
 * 读打包期写进 `vendor.lock.json` 的文件数基线。
 * @param {string} vendorDir 含 vendor.lock.json 的目录
 * @param {{readFile?: (p:string)=>string, exists?: (p:string)=>boolean}} [io] 可注入 IO（单测用）
 * @returns {{files:number, platform:string|null, dshVersions:object|null}}
 *   `files` 为 0 表示读不到基线，不是"依赖为空"
 */
export function readVendorBaseline(vendorDir, io = {}) {
  const readFile = io.readFile ?? ((p) => fs.readFileSync(p, 'utf8'))
  try {
    const lock = JSON.parse(readFile(path.join(vendorDir, 'vendor.lock.json')))
    const files = Number(lock.nodeModulesFiles || lock.totalFiles || 0)
    return {
      files: Number.isFinite(files) && files > 0 ? files : 0,
      platform: typeof lock.platform?.tag === 'string' ? lock.platform.tag : null,
      dshVersions: lock.dshVersions ?? null,
    }
  } catch {
    return { files: 0, platform: null, dshVersions: null }
  }
}

/**
 * 依赖完整性判据。
 * @param {{files:number, baseline:number}} o 实测文件数与基线
 * @returns {{status:'ok'|'missing-baseline'|'unreadable'|'short', ok:boolean, level:'warn'|'critical',
 *   detail:string, ratio:number|null}}
 *   `ok` 只表示没发现缺件；`status` 才是完整语义
 */
export function assessVendorIntegrity({ files, baseline }) {
  if (!Number.isFinite(files) || files < 0) {
    return { status: 'unreadable', ok: false, level: 'warn', ratio: null, detail: '无法统计 vendor 文件数（目录不可读或不存在）' }
  }
  if (!Number.isFinite(baseline) || baseline <= 0) {
    return {
      status: 'missing-baseline', ok: false, level: 'warn', ratio: null,
      detail: `${files} 个文件，但读不到打包基线（vendor.lock.json 的 nodeModulesFiles/totalFiles）——本次跳过比对`,
    }
  }
  const ratio = files / baseline
  if (ratio < SHORTFALL_RATIO) {
    return {
      status: 'short', ok: false, level: 'critical', ratio,
      detail: `${files} 个文件（打包基线 ${baseline}，仅 ${(ratio * 100).toFixed(1)}%）—— 依赖缺件（杀软隔离/解压不全），请重装并加白名单`,
    }
  }
  return { status: 'ok', ok: true, level: 'warn', ratio, detail: `${files} 个文件（打包基线 ${baseline}）` }
}

/** 目录文件数（只数文件，不跟随符号链接）。 */
export function countFiles(dir) {
  let n = 0
  const walk = (d) => {
    let ents
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (e.isDirectory()) walk(path.join(d, e.name))
      else if (e.isFile()) n += 1
    }
  }
  walk(dir)
  return n
}
