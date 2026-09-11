// dsh-update.mjs — DSH（harness）更新引擎：版本发现与比较（纯 Node，零 Electron 依赖）
//
// 为什么单独成模块：admin.mjs 与 repair.mjs 都是"纯 Node + 可离线单测"的姿态，本模块沿用同一
// 姿态——版本比较与 registry 解析是本功能里最容易出错、又最难在 GUI 里调试的部分，必须能脱网
// 跑断言（scripts/update-self-test.mjs）。本模块**不写任何文件、不起任何进程**。
//
// 与 scripts/build-host.mjs 的分工：本模块只回答"有没有新版本、新版本是哪个"；真正的 vendor 树
// 构建（npm install / 剪枝 / 插件同步 / ABI 门禁）复用 build-host 的实现（S2 抽成可复用函数）。
import fs from 'node:fs'
import path from 'node:path'

/** 默认 registry（Q3 决定）。坑 05 实证：registry.npmjs.org 在无代理环境直连会无限挂起、无报错。 */
export const DEFAULT_REGISTRY = 'https://registry.npmmirror.com'

/**
 * 参与版本比对的包。三者由 build-host 的 VERSIONS 锁同进同退：
 * 只升其中一个会让 vendor 树不自洽（bundles 指向的 dsh-base/dsh-web-app 与 dsh 本体错版）。
 */
export const UPDATE_PACKAGES = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/** 查询超时（Q3 决定）：registry 不可达必须快速失败，否则"检查更新"会永远转圈。 */
export const DEFAULT_TIMEOUT_MS = 4000

/** 严格 semver 形态（build 元数据允许存在但按规范不参与比较）。 */
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * 解析版本串。不合法返回 null（调用方自行决定是过滤还是抛）。
 * @param {string} v 版本串
 * @returns {{major:number,minor:number,patch:number,pre:string[]}|null}
 */
export function parseVersion(v) {
  if (typeof v !== 'string') return null
  const m = VERSION_RE.exec(v.trim())
  if (m === null) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    // 无 prerelease 段 → 空数组，由 comparePrerelease 表达"正式版 > 同号预发布版"
    pre: m[4] === undefined ? [] : m[4].split('.'),
  }
}

/**
 * 按 semver 规范比较 prerelease 标识符序列。
 *
 * 这是本模块存在的**核心理由**：DSH 目前只发 prerelease（如 0.1.0-rc.8）。若按字符串比较，
 * '0.1.0-rc.9' < '0.1.0-rc.8' 成立（逐字符 '9' > '8' 为假），'rc.10' 更会被判成小于 'rc.9'
 * ——结果是"永远提示已是最新"，而且是静默的、没有任何报错的错。
 *
 * 规则（semver 11.4）：无 prerelease > 有 prerelease；两侧都是数字标识符时按数值比；
 * 数字标识符优先级低于非数字；前缀全等时标识符个数少者小。
 * @param {string[]} a 左序列
 * @param {string[]} b 右序列
 * @returns {number} -1 / 0 / 1
 */
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1  // 正式版 > 同号预发布版
  if (b.length === 0) return -1
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    const x = a[i]
    const y = b[i]
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      const dx = Number(x)
      const dy = Number(y)
      if (dx !== dy) return dx < dy ? -1 : 1
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1  // 数字标识符优先级低于非数字
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  if (a.length === b.length) return 0
  return a.length < b.length ? -1 : 1
}

/**
 * 比较两个版本。任一侧不合法即抛——这是编程错误，不该被静默吞掉（与 parseVersion 的分工）。
 * @param {string} a 左版本
 * @param {string} b 右版本
 * @returns {number} -1 / 0 / 1
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (pa === null) throw new TypeError(`不是合法版本串: ${JSON.stringify(a)}`)
  if (pb === null) throw new TypeError(`不是合法版本串: ${JSON.stringify(b)}`)
  for (const k of ['major', 'minor', 'patch']) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1
  }
  return comparePrerelease(pa.pre, pb.pre)
}

/**
 * 从版本串集合里取最高者。非法项直接跳过（packument 里可能混入历史脏版本号）。
 *
 * 为什么不用 dist-tags.latest：纯 prerelease 包（DSH 当前形态）的 latest 标记不保证指向最新
 * rc，甚至可能缺失；只有遍历全量版本取最高才是确定的。因此 includePrerelease 默认为 true——
 * 排除 prerelease 会让本功能在当前阶段完全失效。
 * @param {Iterable<string>} versions 候选版本串
 * @param {{includePrerelease?:boolean}} [opts] 选项
 * @returns {string|null} 最高版本，无合法项时 null
 */
export function pickHighestVersion(versions, { includePrerelease = true } = {}) {
  let best = null
  for (const v of versions) {
    const p = parseVersion(v)
    if (p === null) continue
    if (!includePrerelease && p.pre.length > 0) continue
    if (best === null || compareVersions(v, best) > 0) best = v
  }
  return best
}

/**
 * 读 vendor 树里**实际安装**的版本。
 *
 * 为什么不读 vendor.lock.json：lock 是构建期写下的快照，手工换树（坑 17）后可能不同步；
 * 拿真实 package.json 才不会误判"已是最新"。读不到记 null（表示该包缺失/树不完整）。
 * @param {string} profileDir vendor/profile 绝对路径
 * @returns {Record<string,string|null>} 包名 → 版本
 */
export function readCurrentVersions(profileDir) {
  const out = {}
  for (const name of UPDATE_PACKAGES) {
    const pj = path.join(profileDir, 'node_modules', ...name.split('/'), 'package.json')
    try {
      out[name] = JSON.parse(fs.readFileSync(pj, 'utf8')).version ?? null
    } catch {
      out[name] = null  // 缺失或损坏：调用方据此判断树不完整，不要抛
    }
  }
  return out
}

/**
 * 候选 npm-cli.js 路径。
 *
 * 为什么是 npm-cli.js 而不是 npm.cmd：坑 04 实证 Windows 上 spawn('npm') 报 ENOENT（本机 PATH
 * 上甚至只有 npm.ps1），一律用 node 直调 npm-cli.js。
 * 为什么需要多个锚点：打包态 process.execPath 是 "DSH Desktop.exe"，其同级目录**没有 npm**
 * （Q2 决定不内置 npm），必须靠系统 Node 的安装位置兜底。
 * @param {{env?:Record<string,string|undefined>, execPath?:string, extraNodeDirs?:string[]}} [opts] 选项
 * @returns {string[]} 候选路径（按优先级）
 */
export function npmCandidates({ env = process.env, execPath = process.execPath, extraNodeDirs = [] } = {}) {
  const nodeDirs = []
  if (env.DSH_NODE_DIR) nodeDirs.push(env.DSH_NODE_DIR)
  if (env.ProgramFiles) nodeDirs.push(path.join(env.ProgramFiles, 'nodejs'))
  // extraNodeDirs 由调用方用 `where node` 的推导结果填入（沿用 host.mjs findDshBin 的锚点思路）
  for (const d of extraNodeDirs) if (d) nodeDirs.push(d)
  nodeDirs.push(path.dirname(execPath))
  return nodeDirs.map((d) => path.join(d, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
}

/**
 * 探测系统 npm（Q2：不内置 npm）。
 * @param {{exists?:(p:string)=>boolean, candidates?:string[]}} [opts] 选项（exists 可注入以便离线单测）
 * @returns {string|null} npm-cli.js 绝对路径，找不到 null（调用方据此置灰按钮）
 */
export function findNpm({ exists = fs.existsSync, candidates = npmCandidates() } = {}) {
  for (const p of candidates) if (exists(p)) return p
  return null
}

/**
 * 拉一个包的 packument（只用到 versions/dist-tags）。
 * @param {string} name 包名（可带 scope）
 * @param {{registry?:string, timeoutMs?:number, fetchImpl?:typeof fetch}} [opts] 选项
 * @returns {Promise<object>} packument
 * @throws registry 不可达 / 非 2xx / 非法 JSON 时抛出
 */
export async function fetchPackument(name, { registry = DEFAULT_REGISTRY, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const base = registry.replace(/\/+$/, '')
  if (!fetchImpl || typeof fetchImpl !== 'function') throw new Error('当前运行时没有 fetch，无法访问 registry')
  // scope 包的路径必须百分号编码（npm registry 契约），否则 404
  const url = `${base}/${name.replace('/', '%2f')}`
  const res = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`registry 返回 ${res.status}${res.statusText ? ' ' + res.statusText : ''}`)
  return await res.json()
}

/**
 * 查最新可用版本并给出结论。
 *
 * 任何失败都收敛成 { ok:false, error }，**不抛**——调用方是 HTTP 端点，异常会变成 400 且丢失
 * 上下文（与 admin.mjs 既有风格一致：路由里不让异常穿透）。
 * @param {{profileDir:string, registry?:string, timeoutMs?:number, fetchImpl?:typeof fetch, log?:(m:string)=>void}} opts 选项
 * @returns {Promise<{ok:boolean, current:Record<string,string|null>, latest:Record<string,string|null>, target:string|null, hasUpdate:boolean, error?:string}>}
 */
export async function checkForUpdate({ profileDir, registry = DEFAULT_REGISTRY, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch, log = () => {} } = {}) {
  const current = readCurrentVersions(profileDir)
  const latest = {}
  try {
    for (const name of UPDATE_PACKAGES) {
      const pack = await fetchPackument(name, { registry, timeoutMs, fetchImpl })
      latest[name] = pickHighestVersion(Object.keys(pack.versions ?? {}))
    }
  } catch (e) {
    log(`[dsh-update] registry 查询失败: ${e.message}`)  // 错误逐层留痕，不吞
    return { ok: false, current, latest: {}, target: null, hasUpdate: false, error: `无法访问 ${registry}：${e.message}` }
  }
  const target = latest['@deepseek-ai/dsh'] ?? null
  const installed = current['@deepseek-ai/dsh']
  let hasUpdate = false
  if (installed !== null && target !== null) hasUpdate = compareVersions(target, installed) > 0
  return { ok: true, current, latest, target, hasUpdate }
}
