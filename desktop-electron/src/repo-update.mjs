// repo-update.mjs — 按 GitHub 仓库清单更新本地文件（平面 C；纯 Node，零 Electron 依赖）
//
// 清单 `desktop-electron/components.json` 与文件同源，逐条带 sha256/size：
// 与本地比对后只下载"缺的或变了的"，全部校验通过再原子落盘。
// 组件 kind 决定落点：profile-plugin → $DSH_HOME/profiles/<profile>/node_modules/<dest>；
// home-file → $DSH_HOME/<dest>；shell-asar → 只暂存到 $DSH_HOME/repo-updates/shell-src/。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const COMPONENT_MANIFEST_PATH = 'desktop-electron/components.json'
export const MANIFEST_SCHEMA = 1
export const DEFAULT_COORDS = Object.freeze({ owner: 'cdbge', repo: 'dshdt', ref: 'main' })

const MAX_FILES = 400
const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_TOTAL_BYTES = 128 * 1024 * 1024

export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/**
 * 组件内容摘要（只由"路径 + sha256"决定，与顺序无关）。
 * @param {{path:string, sha256:string}[]} files 文件记录
 * @returns {string} 十六进制摘要
 */
export function filesDigest(files) {
  const lines = files.map((f) => `${f.path}:${f.sha256}`).sort()
  return sha256Hex(Buffer.from(lines.join('\n'), 'utf8'))
}

/**
 * 校验组件内的相对路径（字符串层拒绝可疑形态，不做 resolve）。
 * @param {unknown} p 待校验路径
 * @returns {string|null} 规范化后的相对路径；不合法返回 null
 */
export function safeComponentPath(p) {
  if (typeof p !== 'string' || p === '') return null
  if (p.includes('\0')) return null
  if (p.includes('\\')) return null
  if (/^[a-zA-Z]:/.test(p)) return null
  if (p.startsWith('/') || p.startsWith('//')) return null
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p)) return null
  const segs = p.split('/')
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return null
  return segs.join('/')
}

/**
 * 整份校验清单，任何一条不合法就拒绝（不做"跳过坏的那条"）。
 * @param {string} text 清单文本
 * @returns {{ok:true, manifest:object}|{ok:false, error:string}}
 */
export function parseManifest(text) {
  let j
  try { j = JSON.parse(String(text).replace(/^\uFEFF/, '')) } catch (e) { return { ok: false, error: `清单不是合法 JSON：${e.message}` } }
  if (j === null || typeof j !== 'object' || Array.isArray(j)) return { ok: false, error: '清单顶层必须是对象' }
  if (j.schema !== MANIFEST_SCHEMA) return { ok: false, error: `清单 schema 不支持：${String(j.schema)}（本版只认 ${MANIFEST_SCHEMA}）` }
  if (!Array.isArray(j.components) || j.components.length === 0) return { ok: false, error: '清单没有任何组件' }
  const seenIds = new Set()
  let totalBytes = 0
  let fileCount = 0
  for (const c of j.components) {
    if (c === null || typeof c !== 'object') return { ok: false, error: '组件必须是对象' }
    const id = c.id
    if (typeof id !== 'string' || id === '') return { ok: false, error: '组件缺 id' }
    if (seenIds.has(id)) return { ok: false, error: `组件 id 重复：${id}` }
    seenIds.add(id)
    if (!['profile-plugin', 'home-file', 'shell-asar'].includes(c.kind)) return { ok: false, error: `组件 ${id} 的 kind 不认识：${String(c.kind)}` }
    if (c.kind !== 'shell-asar') {
      const dest = safeComponentPath(c.dest)
      if (dest === null) return { ok: false, error: `组件 ${id} 的 dest 不合法：${String(c.dest)}` }
      c.dest = dest
    }
    if (!Array.isArray(c.files) || c.files.length === 0) return { ok: false, error: `组件 ${id} 没有文件` }
    if (c.kind === 'home-file' && c.files.length !== 1) return { ok: false, error: `组件 ${id} 是单文件组件（home-file），但列了 ${c.files.length} 个文件` }
    for (const f of c.files) {
      if (f === null || typeof f !== 'object') return { ok: false, error: `组件 ${id} 的文件记录必须是对象` }
      const rel = safeComponentPath(f.path)
      if (rel === null) return { ok: false, error: `组件 ${id} 的文件路径不合法：${String(f.path)}` }
      f.path = rel
      if (typeof f.repoPath !== 'string' || safeComponentPath(f.repoPath) === null) {
        return { ok: false, error: `组件 ${id} 的 repoPath 不合法：${String(f.repoPath)}` }
      }
      if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) return { ok: false, error: `组件 ${id} 的文件 ${rel} 缺合法 sha256` }
      if (!Number.isInteger(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES) return { ok: false, error: `组件 ${id} 的文件 ${rel} 尺寸不合法：${String(f.size)}` }
      totalBytes += f.size
      fileCount += 1
    }
    if (Array.isArray(c.remove)) {
      for (const r of c.remove) {
        if (safeComponentPath(r) === null) return { ok: false, error: `组件 ${id} 的 remove 路径不合法：${String(r)}` }
      }
    }
  }
  if (fileCount > MAX_FILES) return { ok: false, error: `清单文件数超上限（${fileCount} > ${MAX_FILES}）` }
  if (totalBytes > MAX_TOTAL_BYTES) return { ok: false, error: `清单总字节数超上限（${totalBytes} > ${MAX_TOTAL_BYTES}）` }
  return { ok: true, manifest: j }
}

/** raw.githubusercontent 直链。 */
export function rawUrl(coords, repoPath) {
  const { owner, repo, ref } = coords
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${repoPath}`
}

/** 默读取件（带超时）；测试一律注入假的。 */
export async function defaultFetchBytes(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'dsh-desktop-repo-update' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

export function repoUpdatesDir(home) {
  return path.join(home, 'repo-updates')
}
export function stateFilePath(home) {
  return path.join(repoUpdatesDir(home), 'state.json')
}

/**
 * 读账本；读不出来当没有（最坏只是重新更新一次）。
 * @param {string} home DSH_HOME
 * @returns {{schema:number, components:object, ref?:string, appliedAt?:string, broken?:string}}
 */
export function readState(home) {
  const file = stateFilePath(home)
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (j && typeof j === 'object' && j.components && typeof j.components === 'object') {
      return { schema: MANIFEST_SCHEMA, components: {}, ...j }
    }
    return { schema: MANIFEST_SCHEMA, components: {}, broken: '账本结构不认识' }
  } catch (e) {
    return { schema: MANIFEST_SCHEMA, components: {}, broken: e.code === 'ENOENT' ? undefined : e.message }
  }
}

/** 原子写账本。 */
export function writeState(home, state) {
  const dir = repoUpdatesDir(home)
  fs.mkdirSync(dir, { recursive: true })
  const file = stateFilePath(home)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  fs.renameSync(tmp, file)
  return file
}

/** 组件在本地的落点（profile-plugin / home-file 是目录或文件；shell-asar 是暂存目录）。 */
export function componentDestPath(home, component, opts = {}) {
  const profileName = opts.profileName ?? 'web'
  if (component.kind === 'profile-plugin') return path.join(home, 'profiles', profileName, 'node_modules', component.dest)
  if (component.kind === 'home-file') return path.join(home, component.dest)
  return path.join(repoUpdatesDir(home), 'shell-src')
}

/** 单个文件的本地 sha256；不存在返回 null。 */
export function localFileHash(abs) {
  try { return sha256Hex(fs.readFileSync(abs)) } catch { return null }
}

/** 清单里的相对路径 → 绝对路径（home-file 的 dest 本身就是文件）。 */
export function resolveComponentFile(home, component, rel, opts = {}) {
  if (component.kind === 'home-file') return componentDestPath(home, component, opts)
  return path.join(componentDestPath(home, component, opts), rel)
}

/**
 * 算出每个组件要做什么（只读本地，不联网）。
 * @param {{manifest:object, home:string, profileName?:string, state?:object}} args 参数
 * @returns {{components:Array, summary:{update:number, uptodate:number, missingFiles:number, changedFiles:number}}}
 */
export function planUpdate({ manifest, home, profileName = 'web', state = null }) {
  const st = state ?? readState(home)
  const components = []
  let missingFiles = 0
  let changedFiles = 0
  for (const c of manifest.components) {
    const missing = []
    const changed = []
    for (const f of c.files) {
      const abs = resolveComponentFile(home, c, f.path, { profileName })
      const have = localFileHash(abs)
      if (have === null) missing.push({ ...f, abs, reason: 'missing' })
      else if (have !== f.sha256) changed.push({ ...f, abs, reason: 'changed', localSha256: have })
    }
    const remove = []
    for (const rel of c.remove ?? []) {
      const abs = resolveComponentFile(home, c, rel, { profileName })
      if (fs.existsSync(abs)) remove.push({ path: rel, abs })
    }
    const digest = filesDigest(c.files)
    const recorded = st.components?.[c.id]
    const needsWork = missing.length > 0 || changed.length > 0 || remove.length > 0 || recorded?.filesDigest !== digest
    missingFiles += missing.length
    changedFiles += changed.length
    components.push({
      id: c.id,
      kind: c.kind,
      dest: c.dest ?? null,
      version: c.version ?? null,
      title: c.title ?? c.id,
      digest,
      recordedDigest: recorded?.filesDigest ?? null,
      tracked: recorded !== undefined,
      missing,
      changed,
      remove,
      upToDate: !needsWork,
    })
  }
  const update = components.filter((c) => !c.upToDate).length
  return { components, summary: { update, uptodate: components.length - update, missingFiles, changedFiles } }
}

/** 原子写文件（同目录 .tmp + rename）。 */
export function writeFileAtomic(abs, buf) {
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const tmp = `${abs}.tmp-${process.pid}`
  fs.writeFileSync(tmp, buf)
  fs.renameSync(tmp, abs)
  return abs
}

/**
 * 应用一个组件：先把要下的文件全部下完并校验，再逐个原子写。
 * @param {object} args 参数
 * @returns {Promise<{ok:boolean, id:string, written:string[], removed:string[], error?:string}>}
 */
export async function applyComponent({ component, home, coords, profileName = 'web', fetchBytes = defaultFetchBytes, log = () => {} }) {
  const pending = [...component.missing, ...component.changed]
  const fetched = []
  let total = 0
  for (const f of pending) {
    const url = rawUrl(coords, f.repoPath)
    let buf
    try {
      buf = await fetchBytes(url)
    } catch (e) {
      return { ok: false, id: component.id, written: [], removed: [], error: `下载失败 ${f.path}：${e.message}` }
    }
    total += buf.length
    if (total > MAX_TOTAL_BYTES) return { ok: false, id: component.id, written: [], removed: [], error: `本次下载总量超上限（>${MAX_TOTAL_BYTES} 字节）` }
    if (buf.length !== f.size) return { ok: false, id: component.id, written: [], removed: [], error: `${f.path} 尺寸不符（${buf.length} ≠ ${f.size}）——半截响应或缓存错配` }
    const got = sha256Hex(buf)
    if (got !== f.sha256) return { ok: false, id: component.id, written: [], removed: [], error: `${f.path} sha256 不符（期望 ${f.sha256.slice(0, 12)}…，实得 ${got.slice(0, 12)}…）` }
    fetched.push({ rel: f.path, buf, abs: resolveComponentFile(home, component, f.path, { profileName }) })
  }
  const written = []
  for (const f of fetched) {
    try {
      writeFileAtomic(f.abs, f.buf)
      written.push(f.rel)
    } catch (e) {
      return { ok: false, id: component.id, written, removed: [], error: `写入失败 ${f.rel}：${e.message}` }
    }
  }
  const removed = []
  for (const r of component.remove) {
    try {
      fs.rmSync(r.abs, { force: true })
      removed.push(r.path)
    } catch (e) {
      log(`[repo-update] 删除失败（忽略）：${r.path} — ${e.message}`)
    }
  }
  return { ok: true, id: component.id, written, removed }
}

/**
 * 一次完整更新：拉清单 → 比对 → 应用 → 写账本。失败是逐组件的，但整体 ok=false。
 * @param {object} args 参数
 * @returns {Promise<{ok:boolean, ref:string, results:Array, plan:object|null, error?:string}>}
 */
export async function runRepoUpdate({
  home, coords = DEFAULT_COORDS, profileName = 'web',
  fetchBytes = defaultFetchBytes, fetchText, log = () => {}, dryRun = false,
  bundledDigestOf = null,
}) {
  const getText = fetchText ?? (async (url) => (await fetchBytes(url)).toString('utf8'))
  const manifestUrl = rawUrl(coords, COMPONENT_MANIFEST_PATH)
  let text
  try {
    text = await getText(manifestUrl)
  } catch (e) {
    return { ok: false, ref: coords.ref, results: [], plan: null, error: `清单拉取失败：${e.message}` }
  }
  const parsed = parseManifest(text)
  if (!parsed.ok) return { ok: false, ref: coords.ref, results: [], plan: null, error: parsed.error }
  const manifest = parsed.manifest
  const plan = planUpdate({ manifest, home, profileName })
  if (dryRun) return { ok: true, ref: coords.ref, results: [], plan, dryRun: true }

  const state = readState(home)
  const results = []
  let anyFailed = false
  for (const c of plan.components) {
    if (c.upToDate) { results.push({ id: c.id, ok: true, skipped: true, action: 'up-to-date' }); continue }
    const mc = manifest.components.find((x) => x.id === c.id)
    const r = await applyComponent({ component: { ...c, files: mc.files, remove: c.remove }, home, coords, profileName, fetchBytes, log })
    results.push({ ...r, action: r.ok ? (c.missing.length > 0 ? 'added' : 'updated') : 'failed' })
    if (!r.ok) { anyFailed = true; continue }
    const bundledDigest = typeof bundledDigestOf === 'function' ? bundledDigestOf(c.id, mc.files) : null
    state.components[c.id] = {
      kind: c.kind,
      dest: c.dest,
      version: c.version,
      filesDigest: filesDigest(mc.files),
      files: mc.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
      bundledDigest,
      appliedAt: new Date().toISOString(),
    }
    log(`[repo-update] ${c.id} 已更新：写 ${r.written.length} 个、删 ${r.removed.length} 个（改自 ${coords.owner}/${coords.repo}@${coords.ref}）`)
  }
  state.ref = coords.ref
  state.owner = coords.owner
  state.repo = coords.repo
  state.appliedAt = new Date().toISOString()
  state.schema = MANIFEST_SCHEMA
  try {
    writeState(home, state)
  } catch (e) {
    return { ok: false, ref: coords.ref, results, plan, error: `账本写入失败：${e.message}` }
  }
  return { ok: !anyFailed, ref: coords.ref, results, plan }
}

/**
 * 启动同步时判断：这个自带插件该不该保留热更新内容（而不是被随包副本覆盖）。
 * 账本里记着热更新当时的文件表与"随包副本摘要"，摘要没变就保留。
 * @param {{home:string, id:string, bundledDir:string}} args 参数
 * @returns {{keep:boolean, why:string}}
 */
export function shouldKeepHotUpdated({ home, id, bundledDir }) {
  const st = readState(home)
  const rec = st.components?.[id]
  if (rec === undefined) return { keep: false, why: '没有热更新账本' }
  if (!Array.isArray(rec.files) || rec.files.length === 0) return { keep: false, why: '账本没记文件表（老账本？）' }
  if (rec.bundledDigest === undefined || rec.bundledDigest === null) return { keep: false, why: '账本没记随包摘要（无法判断，宁可用随包副本）' }
  const now = dirFilesDigest(bundledDir, rec.files)
  if (now === null) return { keep: false, why: `随包副本读不全（${bundledDir}）` }
  if (rec.bundledDigest !== now) return { keep: false, why: '随包副本已变（壳被新安装包换过）⇒ 以新包为准' }
  return { keep: true, why: `热更新于 ${rec.appliedAt ?? '?'}，随包副本未变` }
}

/**
 * 按清单文件表算一个目录的内容摘要（用于"随包副本摘要"）。
 * @param {string} dir 目录
 * @param {{path:string, sha256:string}[]} files 清单文件表
 * @returns {string|null} 摘要；目录或文件缺失返回 null
 */
export function dirFilesDigest(dir, files) {
  if (!fs.existsSync(dir)) return null
  const got = []
  for (const f of files) {
    const h = localFileHash(path.join(dir, f.path))
    if (h === null) return null
    got.push({ path: f.path, sha256: h })
  }
  return filesDigest(got)
}
