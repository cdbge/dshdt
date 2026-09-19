// vendor-baseline.mjs — vendor 依赖完整性的**基线读取与判据**（纯 Node，零依赖）
//
// 为什么单独成文件（而不是留在 main.mjs 里）：
//   ① main.mjs 顶层 `import 'electron'`，**不能被离线单测导入**，于是这段判据一直没有断言守着；
//   ② 它的初版是个**假绿门禁**：`VENDOR_EXPECT_FILES` 在模块求值时读一个尚未声明的 `const`
//      （TDZ），ReferenceError 被 `catch { return 0 }` 吞掉 ⇒ 基线恒 0；而判据写成
//      `vendorFiles < 0 || expect <= 0 || vendorFiles >= expect * 0.98` ⇒ **基线缺失也算通过**。
//      两者叠加的结果是：这个检查从上线起就**从来没有真正拦过任何东西**。
//   ③ 同类缺陷的通用修法是"把判据从环境里拿出来，交给可注入参数的纯函数"——本文件即是。
//
// 口径（三态必须分开，别再合并成一个真假值——"一个标志位兼表多种失败原因"是踩过的坑）：
//   · baseline === 0  → **基线缺失**：跳过比对，但要如实说明（不是"通过"）
//   · files  < 基线×0.98 → **依赖缺件**：杀软隔离/解压不全的典型形态，要能拦住启动
//   · 其余            → 通过
import fs from 'node:fs'
import path from 'node:path'

/** 判定"依赖缺件"的阈值（低于基线的这个比例就判缺件）。 */
export const SHORTFALL_RATIO = 0.98

/**
 * 读打包期写进 `vendor.lock.json` 的文件数基线。
 * @param {string} vendorDir vendor 目录（含 vendor.lock.json）
 * @param {{readFile?: (p:string)=>string, exists?: (p:string)=>boolean}} [io] 可注入 IO（单测用）
 * @returns {{files:number, platform:string|null, dshVersions:object|null}}
 *   `files` 为 0 表示读不到基线（文件缺失/字段缺失/内容损坏），**不是**"依赖为空"
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
 *   `ok` 只表示"没有发现缺件"；`status` 才是完整语义（调用方据此决定文案与是否阻断）
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

/** 目录文件数（只数文件，不跟随符号链接；打包期与运行期共用同一算法）。 */
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
