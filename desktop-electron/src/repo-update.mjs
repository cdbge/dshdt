// repo-update.mjs — **按 GitHub 仓库文件**更新"缺的文件与功能"（平面 C，纯 Node，零 Electron 依赖）
//
// 为什么需要它（用户 2026-09-19 明确口径："dshdt 要有一个按钮，能根据 GitHub 仓库文件更新未有的
// 文件以及功能"）：
//   · 平面 A（`dsh-update.mjs`）换的是 **harness 依赖树**，源是 npm registry；
//   · 平面 B（electron-updater）换的是**整个安装包**，源是 Release 资产，且只在 0.4.7+ 的安装上生效；
//   · 而"自带插件/补丁层/市场目录"这些**功能文件**原先只能靠"重新打包 + 重装"才会变——
//     本模块就是补上这一层：从仓库的 raw 文件按需拉取**缺失的或变了的**文件，落到**可写**的位置，
//     宿主重启后新功能立刻可用。
//
// 设计要点（每一条都对应一类真实失败）：
//   1. **清单驱动 + 逐个 sha256 校验**：清单（`desktop-electron/components.json`）与文件同源（同一个
//      仓库、同一个 ref），每条文件都带 sha256/size。校验不是为了防"仓库作恶"（那和安装包渠道同一个
//      信任根），而是为了防**半截响应、CDN 缓存错配、代理插页**——这类错误的特征是"文件看着下下来了，
//      内容是别的东西"，不校验就会把一个坏插件写进正在用的树里。
//   2. **只写清单列出的路径**：路径一律过 `safeComponentPath`（拒绝绝对路径、`..`、反斜杠、盘符、NUL、
//      协议头），否则一份恶意/写错的清单就能往用户目录外写文件。
//   3. **部分更新**：只下载"本地缺的或哈希不符的"，所以"仓库新增一个文件"这类更新是秒级、按 KB 计的。
//   4. **原子落盘**：先写同目录下的 `.tmp` 再 `rename`——中途断电不会留下半个文件（半个 `client.js`
//      会让整页"Failed to load plugins"）。
//   5. **账本（state.json）**：记录每个组件"这次应用的是哪份内容"（filesDigest）以及**应用当时随包副本
//      的哈希**。后者是给 `syncProfilePlugin()` 用的：壳每次启动会把自带插件从随包副本**整目录重写**，
//      不认账本的话热更新的文件一重启就被盖回去；而一旦壳被新安装包换过（随包副本哈希变了），
//      账本自动失效、以新包为准。
//   6. **kind 决定落点**：`profile-plugin` → `$DSH_HOME/profiles/<profile>/node_modules/<dest>`；
//      `home-file` → `$DSH_HOME/<dest>`（补丁层、市场目录）；`shell-asar` → 只**暂存**源码文件到
//      `$DSH_HOME/repo-updates/shell-src/`，真正的 asar 重建与替换由 `shell-update.mjs` 负责
//      （那一步要重启进程，风险等级不同，不能混在这里）。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** 清单在仓库里的位置（相对仓库根）。 */
export const COMPONENT_MANIFEST_PATH = 'desktop-electron/components.json'
/** 清单 schema 版本。字段不兼容时**拒绝应用**，而不是"尽力而为"地猜。 */
export const MANIFEST_SCHEMA = 1
/** 默认坐标；打包态由 main.mjs 从 `app-update.yml` 解析后覆盖（不写死第二份）。 */
export const DEFAULT_COORDS = Object.freeze({ owner: 'cdbge', repo: 'dshdt', ref: 'main' })

// 上限：清单是远端可控输入，必须有闸门，否则一份写坏的清单能把磁盘写满。
const MAX_FILES = 400
const MAX_FILE_BYTES = 32 * 1024 * 1024
const MAX_TOTAL_BYTES = 128 * 1024 * 1024

/** sha256 十六进制。 */
export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/** 一条文件记录 → 稳定的摘要行（组件级 digest 的输入）。 */
function digestLine(f) {
  return `${f.path}:${f.sha256}`
}

/**
 * 组件级内容摘要：只由"路径 + sha256"决定（与顺序无关）。
 * 用来回答两个问题：① 本地这份内容是不是清单里那份？② 账本里记的那份和现在这份一样吗？
 * @param {{path:string, sha256:string}[]} files 文件记录
 * @returns {string} 十六进制摘要
 */
export function filesDigest(files) {
  const lines = files.map(digestLine).sort()
  return sha256Hex(Buffer.from(lines.join('\n'), 'utf8'))
}

/**
 * 校验并规范化组件内的相对路径。
 *
 * 为什么不用 `path.resolve` 之后比对前缀：`resolve` 会把 `..` 折叠掉，等你比对时"穿越"这件事已经被
 * 抹平了（`a/../../b` 解析出来是合法的 `b`）。这里直接在**字符串层**拒绝可疑形态，再由调用方
 * `path.join(dest, rel)`——两条一起才挡得住。
 * @param {unknown} p 待校验路径
 * @returns {string|null} 规范化后的相对路径（POSIX 形式）；不合法返回 null
 */
export function safeComponentPath(p) {
  if (typeof p !== 'string' || p === '') return null
  if (p.includes('\0')) return null
  if (p.includes('\\')) return null // 反斜杠一律拒：Windows 上是分隔符，且 `..\\` 会被上面漏掉
  if (/^[a-zA-Z]:/.test(p)) return null // 盘符
  if (p.startsWith('/') || p.startsWith('//')) return null // 绝对路径 / UNC
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p)) return null // 协议头（file: 之类）
  const segs = p.split('/')
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return null
  return segs.join('/')
}

/**
 * 解析并校验清单。**先整份校验、再决定用不用**：宁可整份拒绝，也不要"跳过坏的那条"——
 * 清单是"这次要变成什么样"的完整描述，缺一条就可能留下半套文件（插件半新半旧最难查）。
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
        const rel = safeComponentPath(r)
        if (rel === null) return { ok: false, error: `组件 ${id} 的 remove 路径不合法：${String(r)}` }
      }
    }
  }
  if (fileCount > MAX_FILES) return { ok: false, error: `清单文件数超上限（${fileCount} > ${MAX_FILES}）` }
  if (totalBytes > MAX_TOTAL_BYTES) return { ok: false, error: `清单总字节数超上限（${totalBytes} > ${MAX_TOTAL_BYTES}）` }
  return { ok: true, manifest: j }
}

/** raw.githubusercontent 直链（CDN，无 API 限流，适合"很多小文件"这种形态）。 */
export function rawUrl(coords, repoPath) {
  const { owner, repo, ref } = coords
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${repoPath}`
}

/** 默认取字节：带超时的 fetch。测试一律注入假的，不联网。 */
export async function defaultFetchBytes(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'dsh-desktop-repo-update' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

// ────────────────────────── 账本（state.json） ──────────────────────────

/** 账本/暂存区的根：`$DSH_HOME/repo-updates`。 */
export function repoUpdatesDir(home) {
  return path.join(home, 'repo-updates')
}
export function stateFilePath(home) {
  return path.join(repoUpdatesDir(home), 'state.json')
}

/**
 * 读账本。**坏了就当没有**（返回空账本并记账）——账本只是"我们做过什么"的备忘，
 * 读不出来最坏的结果是"再更新一次"，不该因此让整个更新入口不可用。
 * @param {string} home DSH_HOME
 * @returns {{schema:number, ref?:string, appliedAt?:string, components:object, broken?:string}}
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

/** 写账本（原子）。 */
export function writeState(home, state) {
  const dir = repoUpdatesDir(home)
  fs.mkdirSync(dir, { recursive: true })
  const file = stateFilePath(home)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  fs.renameSync(tmp, file)
  return file
}

// ────────────────────────── 本地比对 ──────────────────────────

/** 组件在**本地**的落点目录/文件（绝对路径）。 */
export function componentDestPath(home, component, opts = {}) {
  const profileName = opts.profileName ?? 'web'
  if (component.kind === 'profile-plugin') return path.join(home, 'profiles', profileName, 'node_modules', component.dest)
  if (component.kind === 'home-file') return path.join(home, component.dest)
  // shell-asar：只暂存源码，等 shell-update 去重建 asar
  return path.join(repoUpdatesDir(home), 'shell-src')
}

/** 单个文件的本地 sha256；不存在返回 null。 */
export function localFileHash(abs) {
  try { return sha256Hex(fs.readFileSync(abs)) } catch { return null }
}

/**
 * 把清单里的相对路径映射到绝对路径（`safeComponentPath` 已在 parseManifest 里做过）。
 *
 * `home-file` 是**单文件组件**：`dest` 本身就是那个文件（`$DSH_HOME/desktop.patch.yml`），
 * 所以不能再 join 一次 `path`（那样会得到 `…/desktop.patch.yml/desktop.patch.yml`）。
 */
export function resolveComponentFile(home, component, rel, opts = {}) {
  if (component.kind === 'home-file') return componentDestPath(home, component, opts)
  return path.join(componentDestPath(home, component, opts), rel)
}

/**
 * 算出"这个组件要做什么"。纯函数（只读本地），不联网 ⇒ 可以被离线单测完整覆盖。
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
    // 每个组件都算出 digest：`upToDate` 不止"文件都对"，还要"账本记得这次应用"——
    // 否则"用户手动改回旧文件"这种情况会被当成"没事"（文件确实变回来了，但账本没记，应重放一次）。
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

// ────────────────────────── 应用（下载 + 校验 + 落盘） ──────────────────────────

/** 原子写一个文件（同目录 `.tmp` + rename）。 */
export function writeFileAtomic(abs, buf) {
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  const tmp = `${abs}.tmp-${process.pid}`
  fs.writeFileSync(tmp, buf)
  fs.renameSync(tmp, abs)
  return abs
}

/**
 * 应用一个组件的计划。
 *
 * 顺序刻意是"**全部下载并校验完，再开始写**"：先写后校验的话，中途失败就会留下"一半新一半旧"的
 * 插件——那种状态最难诊断（界面报的是别处的错）。所以内存里收齐 → 逐个原子写。
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
 * 一次完整更新：拉清单 → 比对 → 应用 → 写账本。
 *
 * 失败语义是**逐组件**的：一个组件坏了不影响别的组件落地（比如市场目录拿到了、插件暂时没拿到），
 * 但整体 `ok=false`，界面上要如实显示"哪一项失败、为什么"。
 * @param {object} args 参数
 * @returns {Promise<{ok:boolean, ref:string, results:Array, plan:object, error?:string}>}
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
    const r = await applyComponent({ component: { ...c, files: manifest.components.find((x) => x.id === c.id).files, remove: c.remove }, home, coords, profileName, fetchBytes, log })
    results.push({ ...r, action: r.ok ? (c.missing.length > 0 ? 'added' : 'updated') : 'failed' })
    if (!r.ok) { anyFailed = true; continue }
    const mc = manifest.components.find((x) => x.id === c.id)
    // 账本里额外记住"应用当时随包副本的摘要"：壳的启动同步靠它判断"随包副本有没有被新安装包换过"。
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
 * 启动同步的判据：**这个自带插件该不该被随包副本覆盖回去**。
 *
 * 背景：`syncProfilePlugin()` 每次启动都用随包副本整目录重写插件位。如果用户点过"从仓库更新"，
 * 那份热更新的内容就会被旧副本盖回去（表现为"点了按钮、重启就没了"）。判据只看两样东西，
 * 都在账本里：热更新时那份清单的**文件表**（`rec.files`）与**当时随包副本的摘要**（`rec.bundledDigest`）。
 *   · 账本里没有这个组件 → 照旧覆盖（没热更新过）；
 *   · 随包副本按同一张文件表算出来的摘要 == 账本记录 → 壳本身没换过 ⇒ 保留热更新（keep=true）；
 *   · 摘要变了 → 壳被新安装包换过，新包里的插件版本才是权威 ⇒ 让它覆盖（keep=false，并把账本条目作废）。
 * @param {{home:string, id:string, bundledDir:string}} args 参数（`bundledDir` = 随包副本目录）
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
 * 算一个目录下**清单所列文件**的内容摘要（用于"随包副本摘要"）。
 * 只算清单列出的那几个：随包目录里可能还有别的文件（测试、文档），它们不参与热更新语义。
 * @param {string} dir 目录
 * @param {{path:string, sha256:string}[]} files 清单文件表
 * @returns {string|null} 摘要；目录不存在返回 null
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
