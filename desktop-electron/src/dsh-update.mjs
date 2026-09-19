// dsh-update.mjs — DSH（harness）更新引擎：版本发现与比较（纯 Node，零依赖，不写文件、不起进程）。
import fs from 'node:fs'
import path from 'node:path'

/** 默认 registry：registry.npmjs.org 在无代理环境直连会无限挂起且无报错。 */
export const DEFAULT_REGISTRY = 'https://registry.npmmirror.com'

/** 参与版本比对的包：三者由 build-host 的 VERSIONS 锁同进同退。 */
export const UPDATE_PACKAGES = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/** 查询超时：registry 不可达必须快速失败。 */
export const DEFAULT_TIMEOUT_MS = 4000

/** 严格 semver 形态（build 元数据允许存在但不参与比较）。 */
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/**
 * 解析版本串，不合法返回 null。
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
    pre: m[4] === undefined ? [] : m[4].split('.'),
  }
}

/**
 * 按 semver 规范比较 prerelease 标识符序列，返回 -1/0/1。
 * 无 prerelease > 有 prerelease；两侧都是数字时按数值比；数字优先级低于非数字；前缀全等时少者小。
 */
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
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
      return xNum ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  if (a.length === b.length) return 0
  return a.length < b.length ? -1 : 1
}

/** 比较两个版本，返回 -1/0/1。任一侧不合法即抛（编程错误，不静默吞掉）。 */
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
 * 从版本串集合取最高者（非法项跳过），无合法项返回 null。
 * 不用 dist-tags.latest：纯 prerelease 包的 latest 不保证指向最新 rc，甚至可能缺失。
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
 * 读 vendor 树里实际安装的版本（读真实 package.json 而非 lock，lock 可能与树不同步）。
 * @param {string} profileDir vendor/profile 绝对路径
 * @returns {Record<string,string|null>} 包名 → 版本，读不到记 null
 */
export function readCurrentVersions(profileDir) {
  const out = {}
  for (const name of UPDATE_PACKAGES) {
    const pj = path.join(profileDir, 'node_modules', ...name.split('/'), 'package.json')
    try {
      out[name] = JSON.parse(fs.readFileSync(pj, 'utf8')).version ?? null
    } catch {
      out[name] = null
    }
  }
  return out
}

/**
 * 拉一个包的 packument（只用到 versions/dist-tags）。
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
 * 查最新可用版本并给出结论。任何失败都收敛成 { ok:false, error }，不抛。
 * @returns {Promise<{ok:boolean, current:object, latest:object, target:string|null, hasUpdate:boolean, error?:string}>}
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
    log(`[dsh-update] registry 查询失败: ${e.message}`)
    return { ok: false, current, latest: {}, target: null, hasUpdate: false, error: `无法访问 ${registry}：${e.message}` }
  }
  const target = latest['@deepseek-ai/dsh'] ?? null
  const installed = current['@deepseek-ai/dsh']
  let hasUpdate = false
  if (installed !== null && target !== null) hasUpdate = compareVersions(target, installed) > 0
  return { ok: true, current, latest, target, hasUpdate }
}

/**
 * 版本距离评估：major/minor/patch 任一位变化都不得默认放行，必须由人确认；
 * 只放行同号预发布号变化（如 rc.8 → rc.10）。
 * @returns {{safe:boolean, reason:string}}
 */
export function assessJump(from, to) {
  const a = parseVersion(from)
  const b = parseVersion(to)
  if (a === null) return { safe: false, reason: `当前版本串无法解析：${JSON.stringify(from)}` }
  if (b === null) return { safe: false, reason: `目标版本串无法解析：${JSON.stringify(to)}` }
  const moved = []
  if (b.major !== a.major) moved.push(`主版本 ${a.major}→${b.major}`)
  if (b.minor !== a.minor) moved.push(`次版本 ${a.minor}→${b.minor}`)
  if (b.patch !== a.patch) moved.push(`修订 ${a.patch}→${b.patch}`)
  if (moved.length > 0) {
    return { safe: false, reason: `版本号位变更（${moved.join('、')}）：${from} → ${to}，交互合同可能不兼容` }
  }
  return { safe: true, reason: `仅预发布号变化：${from} → ${to}` }
}
