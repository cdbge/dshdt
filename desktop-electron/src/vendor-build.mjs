// vendor-build.mjs — vendor 树构建原语（纯 Node；只有跑 ABI 门禁/读版本时才 spawn 运行时）
//
// 为什么放在 src/ 而不是 scripts/：electron-builder.yml 的 files 只含 `src/**`、`VERSION`、
// `package.json` —— **scripts/ 不进包**。而装好的应用必须能在本地重建 vendor 暂存树，所以这些
// 原语得随包分发；ABI 门禁尤其如此：Q4 决定不做回滚备份后，门禁是唯一防线，它不能在打包后消失。
//
// 与 scripts/build-host.mjs 的关系：build-host 退化为 CLI 薄封装，两边共用本模块**一份**实现。
// 规范 §25③ 的教训（改名后漏改调用点直接让壳起不来）要求"安装/剪枝/插件同步"只能有一处代码。
//
// 本模块**绝不写现网 vendor/profile**：所有写入都发生在调用方给定的 targetDir 内（坑 17：宿主
// 映射着 vendor 里的 *.node，运行中替换会失败/损坏）。
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_REGISTRY } from './dsh-update.mjs'
// 启动门禁复用壳自己的宿主启动与 URL 解析：门禁测的必须与壳跑的是**同一套**逻辑，
// 否则门禁会放行一个"门禁里能起、壳里起不来"的树（0.4.6 事故正是这个形状）。
import { extractHostUrl, freePort, killTree, probeHostReady, startHost } from './host.mjs'
import { safeRemoveTree } from './junction-safe.mjs'

/**
 * 随包分发的自研插件。它们**不在 npm 依赖里**，只经 vendor 树分发（extraResources 的
 * vendor → resources/vendor），electron-builder 的 files 也覆盖不到它们——所以换树时必须手工
 * 拷进新树，漏掉的后果是"换树成功之后"设置面板的"桌面"section 与 /approval 命令一起消失。
 */
export const DEFAULT_PLUGIN_NAMES = ['dsh-desktop-ui', 'dsh-auto-approval']

/** 运行时永不加载、且直接决定安装耗时的内容（Defender 逐文件扫描是安装慢的主因）。 */
const PRUNE_DIRS = new Set(['test', 'tests', '__tests__', 'docs', 'examples', 'benchmark', 'benchmarks'])

/** 非 win32-x64 的 node-pty 预编译包（win32-x64 是必需项，保留）。 */
const NON_WIN32_PTY_PREBUILDS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64']

/** 判定"平台专属包"的路径标记：这类 .node 加载失败属预期（SKIP 而非 FAIL）。 */
const PLATFORM_MARKERS = /(darwin|linux|freebsd|openbsd|android|sunos|aix|arm64|armv|ia32|ppc64|s390x)/

/** dlopen 探针：成功写 OK 退 0，失败写原因退 1。 */
const ABI_PROBE = "try{process.dlopen(module,process.argv[1]);process.stdout.write('OK')}catch(e){process.stdout.write(String(e.message));process.exit(1)}"

/** 字节 → MB 文案（日志统一口径）。 */
export function formatMb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`
}

/** 递归累计目录字节数。目录不存在返回 0（暂存区尚未创建是常态，不该抛）。 */
export function dirSize(dir) {
  let total = 0
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(p)
    else if (entry.isFile()) { try { total += fs.statSync(p).size } catch { /* 并发删除则略过 */ } }
  }
  return total
}

/** 递归累计文件数（不含目录本身）。目录不存在返回 0。 */
export function countFiles(dir) {
  let n = 0
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) n += countFiles(p)
    else n += 1
  }
  return n
}

/** 整目录重建：先删后建，避免残留旧文件让"新树"其实是新旧混合。 */
export function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 写 profile manifest（bundles 锁 dsh-base + dsh-web-app；dsh 本体提供 bin.js 入口）。
 * @param {string} profileDir 目标 profile 目录
 * @param {Record<string,string>} versions 三个 @deepseek-ai 包的精确版本
 * @returns {object} 写下的 manifest
 */
export function writeManifest(profileDir, versions) {
  const manifest = {
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: versions,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
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
 * @returns {string|null} npm-cli.js 绝对路径；找不到返回 null，调用方据此把按钮置灰
 */
export function findNpm({ exists = fs.existsSync, candidates = npmCandidates() } = {}) {
  for (const p of candidates) if (exists(p)) return p
  return null
}

/**
 * 构造 npm 子进程环境。
 *
 * cacheDir **无条件覆盖** `npm_config_cache`：坑 20 实证本机 npm 默认 cache 落在
 * `C:\Program Files\nodejs\node_cache`（普通用户不可写 → EPERM），而"环境变量优先"的写法会让
 * 外部已设的坏值顶掉仓库内的可写缓存——所以这里显式压过去，不给它被顶掉的机会。
 * @param {{cacheDir:string, registry?:string, baseEnv?:Record<string,string|undefined>}} o 选项
 * @returns {Record<string,string|undefined>} 子进程环境
 */
export function buildInstallEnv({ cacheDir, registry = DEFAULT_REGISTRY, baseEnv = process.env }) {
  return { ...baseEnv, npm_config_cache: cacheDir, npm_config_registry: registry }
}

/**
 * 跑 npm install（异步 spawn：构建是分钟级操作，同步会冻住 Electron 主进程的窗口与 admin 服务）。
 *
 * stdio 一律走文件描述符重定向：规范 §4.1 实证沙箱下默认 pipe stdio 会 EPERM。
 * 给了 logFile 就写文件（GUI 应用没有可用的 stdout）；没给则 inherit（CLI 场景看得到进度）。
 * @param {{profileDir:string, npmCli:string, runtime?:string, env:Record<string,string|undefined>, logFile?:string}} o 选项
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export function installDependencies({ profileDir, npmCli, runtime = process.execPath, env = process.env, logFile }) {
  return new Promise((resolve) => {
    if (logFile) fs.mkdirSync(path.dirname(logFile), { recursive: true })
    let fd = 'ignore'
    if (logFile) {
      try { fd = fs.openSync(logFile, 'a') } catch { fd = 'ignore' }
    }
    const closeFd = () => { if (fd !== 'ignore') { try { fs.closeSync(fd) } catch { /* 已关 */ } } }
    let settled = false
    const done = (result) => { if (settled) return; settled = true; closeFd(); resolve(result) }
    let child
    try {
      child = spawn(runtime, [npmCli, 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
        cwd: profileDir,
        // ELECTRON_RUN_AS_NODE 让打包态的 electron.exe 当纯 Node 用（宿主子进程同款做法）；
        // 对真 node 是无害的多余变量。作用域仅限本子进程，不会污染壳自身（规范 §4.2）。
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      })
    } catch (e) { done({ ok: false, error: `无法启动 npm：${e.message}` }); return }
    child.on('error', (e) => done({ ok: false, error: `npm 进程错误：${e.message}` }))
    child.on('exit', (code) => done(code === 0 ? { ok: true } : { ok: false, error: `npm install 退出码 ${code}` }))
  })
}

/**
 * 剪枝：删掉运行时永不加载的内容。文件数砍半直接缩短安装时间——Defender 逐文件扫描是主因。
 * @param {string} profileDir profile 目录
 * @returns {{prunedBytes:number, prunedFiles:number}} 剪掉的量
 */
export function pruneVendorTree(profileDir) {
  let prunedBytes = 0
  let prunedFiles = 0
  const drop = (p) => {
    prunedBytes += dirSize(p)
    prunedFiles += countFiles(p)
    fs.rmSync(p, { recursive: true, force: true })
  }
  for (const p of NON_WIN32_PTY_PREBUILDS) {
    const d = path.join(profileDir, 'node_modules', 'node-pty', 'prebuilds', p)
    if (fs.existsSync(d)) drop(d)
  }
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (PRUNE_DIRS.has(entry.name)) { drop(p); continue }
        walk(p)
      } else if (entry.name.endsWith('.map') || entry.name.endsWith('.d.ts') || entry.name.endsWith('.md')
        || /^(LICENSE|LICENCE|COPYING|NOTICE|CHANGELOG|CHANGES|HISTORY|AUTHORS|CONTRIBUTING)(\.|$)/.test(entry.name)) {
        try { prunedBytes += fs.statSync(p).size } catch { /* 已删 */ }
        prunedFiles += 1
        fs.rmSync(p, { force: true })
      }
    }
  }
  walk(path.join(profileDir, 'node_modules'))
  return { prunedBytes, prunedFiles }
}

/**
 * 把自研插件包拷进 vendor 树的 node_modules。
 *
 * 源目录由调用方给：开发态是仓库 `packages/`；打包态是**当前** vendor 树自己的
 * `node_modules`（壳启动时正是这么把插件同步到 HOME profile 插件位的，见 main.mjs
 * pluginSourceDir）。missing 必须由调用方当硬失败处理——静默跳过会让新树缺插件，而症状
 * （设置面板少一节、/approval 命令消失）离原因很远，且发生在换树"成功"之后。
 * @param {string} profileDir 目标 profile 目录
 * @param {{packagesDir:string, pluginNames?:string[]}} o 选项
 * @returns {{copied:string[], missing:string[]}}
 */
export function syncVendorPlugins(profileDir, { packagesDir, pluginNames = DEFAULT_PLUGIN_NAMES }) {
  const copied = []
  const missing = []
  for (const name of pluginNames) {
    const src = path.join(packagesDir, name)
    if (!fs.existsSync(path.join(src, 'package.json'))) { missing.push(name); continue }
    const dst = path.join(profileDir, 'node_modules', name)
    fs.rmSync(dst, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.cpSync(src, dst, { recursive: true })
    copied.push(name)
  }
  return { copied, missing }
}

/** 抓一次探针的失败原因（文件描述符重定向，沙箱安全）。 */
function probeFailureReason(runtime, file, env) {
  const tmp = path.join(os.tmpdir(), `dsh-abi-probe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.log`)
  let fd
  try {
    fd = fs.openSync(tmp, 'w')
    spawnSync(runtime, ['-e', ABI_PROBE, file], { stdio: ['ignore', fd, fd], env, windowsHide: true })
    fs.closeSync(fd)
    fd = undefined
    const text = fs.readFileSync(tmp, 'utf8').trim()
    return text.split('\n').filter(Boolean).pop() || '未知错误（无输出）'
  } catch (e) {
    return `探针执行失败：${e.message}`
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* 已关 */ } }
    fs.rmSync(tmp, { force: true })
  }
}

/**
 * ABI 门禁：在目标运行时下逐个 dlopen 所有 .node，验证预编译二进制与 Electron 内建 Node 兼容。
 *
 * 为什么失败项才去抓输出：规范 §4.1 实证沙箱下默认 pipe stdio 会 EPERM。常态用
 * `stdio:'ignore'` 只看退出码（快且沙箱通用），只有失败的那一个才走文件描述符重定向取详细
 * 原因——避免为每个文件开临时文件。
 * @param {{nodeModulesDir:string, runtime:string, env?:Record<string,string|undefined>}} o 选项
 * @returns {{ok:boolean, total:number, okCount:number, skipCount:number, failCount:number, failures:string[], error?:string}}
 */
export function runAbiGate({ nodeModulesDir, runtime, env = process.env }) {
  const files = []
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name.endsWith('.node')) files.push(p)
    }
  }
  walk(nodeModulesDir)
  files.sort()
  if (files.length === 0) return { ok: false, total: 0, okCount: 0, skipCount: 0, failCount: 0, failures: [], error: `未发现任何 .node（路径错？）：${nodeModulesDir}` }

  const childEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' }
  let okCount = 0
  let skipCount = 0
  const failures = []
  for (const file of files) {
    const rel = path.relative(nodeModulesDir, file)
    const r = spawnSync(runtime, ['-e', ABI_PROBE, file], { stdio: 'ignore', env: childEnv, windowsHide: true })
    if (r.status === 0) { okCount += 1; continue }
    if (PLATFORM_MARKERS.test(rel)) { skipCount += 1; continue }
    const why = r.error ? `无法启动运行时：${r.error.message}` : probeFailureReason(runtime, file, childEnv)
    failures.push(`${rel} — ${why}`)
  }
  return { ok: failures.length === 0, total: files.length, okCount, skipCount, failCount: failures.length, failures }
}

/**
 * 读运行时的 Node / Electron 版本（写进 vendor.lock.json 供事后诊断）。
 * @param {{runtime:string, env?:Record<string,string|undefined>}} o 选项
 * @returns {{node:string|null, electron:string|null}}
 */
export function readRuntimeVersions({ runtime, env = process.env }) {
  const tmp = path.join(os.tmpdir(), `dsh-nodever-${process.pid}-${Date.now()}.tmp`)
  let fd
  try {
    fd = fs.openSync(tmp, 'w')
    spawnSync(runtime, ['-e', "process.stdout.write(process.versions.node + '|' + process.versions.electron)"], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', fd, fd], windowsHide: true,
    })
    fs.closeSync(fd)
    fd = undefined
    const [nodeVer, electronVer] = fs.readFileSync(tmp, 'utf8').split('|')
    return { node: nodeVer || null, electron: electronVer || null }
  } catch {
    return { node: null, electron: null }
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* 已关 */ } }
    fs.rmSync(tmp, { force: true })
  }
}

/** 收集 vendor 树统计（写进 lock，也是 S2 等价性验证的客观口径）。 */
export function vendorStats(profileDir) {
  return { totalBytes: dirSize(profileDir), totalFiles: countFiles(profileDir) }
}

/** 启动门禁默认超时。留足冷启动余量（首启要建 profile、扫插件）。 */
export const BOOT_GATE_TIMEOUT_MS = 90000

/**
 * 启动门禁：拿**暂存树真起一次宿主**并探到就绪，才允许后续发 marker。
 *
 * 为什么必须有它（0.4.6 事故的根因）：ABI 门禁只验证 `.node` 能否 dlopen，它**完全不关心宿主
 * 能不能对外服务**。0.1.5-rc.2 的 ABI 门禁 5/5 全绿，但它的根 URL 引入了进程级 token，而壳的
 * 就绪探测探的是裸 URL → 永远不就绪 → 用户的应用起不来。计划书 §8 原本写的就是"ABI 门禁 +
 * 启动冒烟双绿才发 marker"，实现时漏了后者。
 *
 * 复用 host.mjs 的 startHost/extractHostUrl 而非另写一套：门禁与壳必须用同一套启动参数与
 * 就绪判定，否则门禁会放行"门禁里能起、壳里起不来"的树。
 * @param {{profileDir:string, runtime:string, patchFile?:string, ws?:string, timeoutMs?:number, log?:(m:string)=>void}} o 选项
 * @returns {Promise<{ok:boolean, url?:string, error?:string, logTail?:string}>}
 */
export async function runBootGate({ profileDir, runtime, patchFile, ws, timeoutMs = BOOT_GATE_TIMEOUT_MS, log = () => {} }) {
  const bin = path.join(profileDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!fs.existsSync(bin)) return { ok: false, error: `暂存树缺 bin.js：${bin}` }
  if (patchFile !== undefined && !fs.existsSync(patchFile)) return { ok: false, error: `启动门禁缺 patch 文件：${patchFile}` }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bootgate-'))
  const logFile = path.join(home, 'host.log')
  const readTail = (n = 12) => {
    try { return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-n).join(' | ') } catch { return '' }
  }
  let child = null
  try {
    // 复刻壳启动时的 ensureProfilePlugins()：desktop.patch.yml 会 insert `dsh-desktop-ui`，
    // 而 loader 对插件条目做 ESM 解析的基准是 profile 目录本身——不把包放进隔离 profile 就会
    // 得到 ERR_MODULE_NOT_FOUND 的**假失败**（本门禁第一版正是栽在这里，误判好树起不来）。
    const profileWeb = path.join(home, 'profiles', 'web')
    const nmDir = path.join(profileWeb, 'node_modules')
    for (const name of DEFAULT_PLUGIN_NAMES) {
      const src = path.join(profileDir, 'node_modules', name)
      if (!fs.existsSync(path.join(src, 'package.json'))) continue
      fs.mkdirSync(nmDir, { recursive: true })
      fs.cpSync(src, path.join(nmDir, name), { recursive: true })
    }
    fs.mkdirSync(profileWeb, { recursive: true })
    fs.writeFileSync(path.join(profileWeb, 'cordis.patch.yml'),
      '# 启动门禁用的隔离 profile 补丁层\n- insert:\n    - id: dsh-auto-approval\n      name: dsh-auto-approval\n')

    const port = await freePort()
    child = startHost({ runtime, bin, home, ws: ws ?? os.tmpdir(), port, patchFile, logFile })

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        return { ok: false, error: `宿主提前退出（code=${child.exitCode}）`, logTail: readTail() }
      }
      const declared = extractHostUrl(logFile)
      const fallback = `http://127.0.0.1:${port}/`
      // 判据必须是"真能服务"，不是 res.ok：0.1.5 的根 URL 是 303 换 cookie，而 fetch 没有 cookie jar
      // ——只认 res.ok 会对任何 0.1.5+ 的树永远报不就绪（假阴性）。probeHostReady 会走完换票。
      // 门禁起的是用完即杀的宿主，消费掉那个 token 无所谓；壳的就绪探测则刻意不消费（见 host.mjs）。
      if (declared !== null && declared.includes(`:${port}`)) {
        if (await probeHostReady(declared, fallback)) return { ok: true, url: declared }
      } else if (await probeHostReady(fallback, fallback)) {
        return { ok: true, url: fallback }
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    return { ok: false, error: `宿主未在 ${timeoutMs}ms 内就绪`, logTail: readTail() }
  } catch (e) {
    return { ok: false, error: `启动门禁异常：${e.message}`, logTail: readTail() }
  } finally {
    if (child !== null && child.pid !== undefined && child.exitCode === null) {
      try { killTree(child.pid) } catch { /* 已退出 */ }
    }
    // 必须走 junction 安全删除：隔离 HOME 里是**指向被测树**的 junction 场，
    // 用"跟随链接"的方式删它会掏空被测树（0.4.6 事故第二现场，见 junction-safe.mjs 头注释）。
    const swept = safeRemoveTree(home, { log })
    if (swept.unlinked > 0) log(`[vendor-build] 门禁收尾：解开 ${swept.unlinked} 个 junction（未进入其目标）`)
  }
}

/**
 * 构建一棵 vendor 树到 targetDir。**调用方必须保证 targetDir 不是现网 vendor/profile**。
 *
 * 步骤与 scripts/build-host.mjs 原流程一一对应（manifest → npm install → 剪枝 → 插件同步 →
 * ABI 门禁 → 读运行时版本 → 写 lock），差别只在于：目标是参数、install 是异步的、插件缺失
 * 是硬失败而非静默跳过。
 * @param {{profileDir:string, versions:Record<string,string>, packagesDir:string, runtime?:string,
 *   cacheDir:string, registry?:string, npmCli?:string, install?:boolean, pluginsRequired?:boolean,
 *   logFile?:string, pluginNames?:string[], abiGate?:Function, installFn?:Function,
 *   bootGate?:Function|null, bootGateTimeoutMs?:number, patchFile?:string, ws?:string,
 *   log?:(m:string)=>void}} o 选项（install=false 即
 *   build-host 的 --prune-only 形态：复用现有树，只做剪枝/插件/门禁/lock；bootGate=null 可跳过
 *   启动门禁——**只允许在离线单测里这么做**，真实更新路径必须保留）
 * @returns {Promise<{ok:boolean, error?:string, manifest?:object, stats?:object, runtime?:object,
 *   pruned?:object, plugins?:object, abi?:object}>}
 */
export async function buildVendorTree({
  profileDir, versions, packagesDir, runtime = process.execPath, cacheDir, registry = DEFAULT_REGISTRY,
  npmCli, install = true, pluginsRequired = true, logFile, pluginNames = DEFAULT_PLUGIN_NAMES, log = () => {},
  abiGate = runAbiGate, installFn = installDependencies,
  bootGate = runBootGate, bootGateTimeoutMs = BOOT_GATE_TIMEOUT_MS, patchFile, ws,
}) {
  log(`[vendor-build] 目标: ${profileDir}`)
  let manifest = null
  if (install) {
    const npm = npmCli ?? findNpm()
    // 存在性也要查：探测到 npm 之后用户可能卸载了 Node，此时 spawn 会给出难以定位的 ENOENT；
    // 在这里挡住能直接告诉用户该装什么。
    if (npm === null || !fs.existsSync(npm)) {
      const detail = npm === null ? '' : `（探测到的路径不存在：${npm}）`
      return { ok: false, error: `未找到可用的系统 npm${detail}：本应用不内置 npm，请先安装 Node.js，或设置 DSH_NODE_DIR 指向 Node 安装目录` }
    }
    log(`[vendor-build] npm: ${npm}`)
    resetDir(profileDir)
    manifest = writeManifest(profileDir, versions)
    log('[vendor-build] npm install --omit=dev --ignore-scripts（首次约 255MB，耐心等待）...')
    const installed = await installFn({ profileDir, npmCli: npm, runtime, env: buildInstallEnv({ cacheDir, registry }), logFile })
    if (!installed.ok) return { ok: false, error: installed.error }
  } else {
    // --prune-only 形态：在既有树上只做剪枝/插件/门禁/lock，不重装。
    if (!fs.existsSync(path.join(profileDir, 'node_modules'))) {
      return { ok: false, error: `install=false 需要已有 node_modules：${profileDir}` }
    }
    log('[vendor-build] 跳过安装（复用现有树）')
  }

  const pruned = pruneVendorTree(profileDir)
  log(`[vendor-build] 剪枝: ${formatMb(pruned.prunedBytes)} / ${pruned.prunedFiles} 个文件`)

  const plugins = syncVendorPlugins(profileDir, { packagesDir, pluginNames })
  if (plugins.missing.length > 0 && pluginsRequired) {
    return { ok: false, error: `插件包缺失，拒绝产出缺插件的树：${plugins.missing.join(' / ')}（源目录 ${packagesDir}）` }
  }
  log(`[vendor-build] 插件已就位: ${plugins.copied.join(' / ') || '（无）'}`)

  // ── 双门禁：ABI（二进制能否加载）+ 启动（宿主能否对外服务）──
  // 两道缺一不可。0.4.6 事故就是因为只做了前者：0.1.5-rc.2 的 ABI 全绿，但它起不来。
  const abi = abiGate({ nodeModulesDir: path.join(profileDir, 'node_modules'), runtime })
  log(`[vendor-build] ABI 门禁: OK=${abi.okCount} SKIP=${abi.skipCount} FAIL=${abi.failCount}（共 ${abi.total}）`)
  if (!abi.ok) {
    const detail = abi.error ?? abi.failures.slice(0, 10).join('; ')
    return { ok: false, error: `ABI 门禁未通过：${detail}`, abi }
  }

  if (bootGate !== null) {
    log('[vendor-build] 启动门禁：拿暂存树真起一次宿主（最长 ' + String(bootGateTimeoutMs / 1000) + 's）...')
    const boot = await bootGate({ profileDir, runtime, patchFile, ws, timeoutMs: bootGateTimeoutMs, log })
    if (!boot.ok) {
      return { ok: false, error: `启动门禁未通过：${boot.error}${boot.logTail ? `（宿主日志：${boot.logTail}）` : ''}`, abi, boot }
    }
    log(`[vendor-build] 启动门禁通过：${boot.url}`)
    return { ok: true, manifest, stats: vendorStats(profileDir), runtime: readRuntimeVersions({ runtime }), pruned, plugins, abi, boot }
  }

  return { ok: true, manifest, stats: vendorStats(profileDir), runtime: readRuntimeVersions({ runtime }), pruned, plugins, abi }
}

/**
 * 构建暂存树：产出 `<stagingRoot>/profile` + `<stagingRoot>/vendor.lock.json`，布局与现网
 * `vendor/` 一致，使换树退化为两次 rename（同卷瞬时，不是复制 122 MB）。
 * @param {{stagingRoot:string, versions:Record<string,string>, packagesDir:string, cacheDir:string,
 *   registry?:string, runtime?:string, npmCli?:string, logFile?:string, log?:(m:string)=>void}} o 选项
 * @returns {Promise<{ok:boolean, error?:string, profileDir?:string, lockPath?:string, lock?:object}>}
 */
export async function buildStaging(o) {
  const { stagingRoot, versions, log = () => {} } = o
  const profileDir = path.join(stagingRoot, 'profile')
  const built = await buildVendorTree({ ...o, profileDir, log })
  if (!built.ok) return { ok: false, error: built.error }

  const lock = {
    generatedAt: new Date().toISOString(),
    dshVersions: versions,
    runtime: built.runtime,
    abiScan: 'PASS',
    prunedBytes: built.pruned.prunedBytes,
    prunedFiles: built.pruned.prunedFiles,
    ...built.stats,
  }
  const lockPath = path.join(stagingRoot, 'vendor.lock.json')
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n')
  log(`[vendor-build] 暂存树就绪: ${formatMb(lock.totalBytes)} / ${lock.totalFiles} 个文件`)
  return { ok: true, profileDir, lockPath, lock }
}
