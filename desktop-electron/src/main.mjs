// DSH Desktop 主进程：编排 admin 服务与 dsh host 子进程（模式 B），承载窗口 / 托盘 / 深链，
// 并负责 vendor 树就位、皮肤与壁纸注入、三层更新（harness / 安装包 / 仓库功能）。
// 关键约束：下面两个副作用导入必须最先执行；electron-updater 是 CJS，只能默认导入后解构。
import './node-guard.mjs' // 防 ELECTRON_RUN_AS_NODE 泄漏导致主进程以纯 Node 启动
import './early-errors.mjs' // 诊断钩子：未捕获异常落盘（打包态无控制台）
import { app, BrowserWindow, Menu, Notification, Tray, dialog, globalShortcut, nativeImage, shell, session } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAdminServer, listenAdmin } from './admin.mjs'
import { findDshBin, freePort, waitReady, killTree, startHost } from './host.mjs'
import { appDataDir, logDir as resolveLogDir, dshHomeDir, defaultWorkspace } from './platform-paths.mjs'
import { assessVendorIntegrity, countFiles as countVendorFiles, readVendorBaseline } from './vendor-baseline.mjs'
import { inspectVendorHome, resolveVendorHome, seedVendorHome } from './vendor-home.mjs'
import { repairSessionLogs } from './repair.mjs'
import { safeRemoveTree } from './junction-safe.mjs'
import { ensureProfilePluginMount as ensureProfilePluginMountIn, repairProfilePatchYaml as repairProfilePatchYamlIn } from './profile-mount.mjs'
import { installMarketEntryOfficial, pnpmHint } from './market-install-official.mjs'
import { pnpmCandidates, resolvePnpm, envWithPnpmOnPath } from './pnpm-resolve.mjs'
import { applyPending, cleanupOldTrees, readPending, restoreOldTree, writePending } from './dsh-apply.mjs'
import { assessJump, checkForUpdate, readCurrentVersions } from './dsh-update.mjs'
import { iconFilePath } from './tray-icon.mjs'
import { assessHarnessCompat, readAddonFingerprints } from './harness-compat.mjs'
// npmCandidates 用于 pnpm 体检（传给 pnpmCandidates 当 npm 候选来源），漏导入会在市场体检时抛 ReferenceError
import { buildStaging, findNpm, npmCandidates } from './vendor-build.mjs'
import { cleanStaleBootGateHomes } from './junction-safe.mjs'
import { migrateSkinSettings as migrateSkinSettingsPure, skinSnapshot as skinSnapshotPure } from './skin-settings.mjs'
import { bgCssText, bgTuningOf } from './bg-css.mjs'
import {
  DEFAULT_COORDS,
  dirFilesDigest,
  // 别名：main.mjs 自己有一个 readState()（壳状态文件），不能同名覆盖
  readState as readRepoUpdateState,
  runRepoUpdate,
  shouldKeepHotUpdated,
  stateFilePath as repoUpdateStateFile,
} from './repo-update.mjs'
import { planShellSwap, probeShellWritable, spawnSwapHelper } from './shell-update.mjs'
import electronUpdater from 'electron-updater'
const { autoUpdater } = electronUpdater

const APP_NAME = 'DSH Desktop'
/** 排障文案里的可执行文件名（三平台不同，必须按平台给）。 */
const CLI_HINT = process.platform === 'win32'
  ? `${APP_NAME}.exe`
  : process.platform === 'darwin'
    ? `"${APP_NAME}.app/Contents/MacOS/${APP_NAME}"`
    : 'dsh-desktop'
// 固定回环 admin 端口：DSH「桌面」设置面板以此为 CORS 目标；被占用时 listenAdmin 回退系统分配。
const ADMIN_PORT = 25439
const APP_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.dirname(APP_DIR)
// 数据目录按平台解析（appDataDir）。不能在模块求值阶段直接用 LOCALAPPDATA（非 Windows 为 undefined）。
const APP_DATA = appDataDir()
app.setPath('userData', path.join(APP_DATA, 'electron-data'))
app.setPath('crashDumps', path.join(APP_DATA, 'crash-dumps'))
const HOME = dshHomeDir()
let WS = defaultWorkspace()
const LOG_DIR = resolveLogDir()
const STATE_FILE = path.join(APP_DATA, 'app.state.json')
const SETTINGS_FILE = path.join(APP_DATA, 'settings.json')
const RES = app.isPackaged ? process.resourcesPath : ROOT_DIR
const PACKAGED_VENDOR = path.join(RES, 'vendor')
const VERSION_FILE = path.join(ROOT_DIR, 'VERSION')
const PATCH_FILE_BUNDLED = app.isPackaged ? path.join(RES, 'desktop.patch.yml') : path.join(APP_DIR, 'desktop.patch.yml')
// 宿主补丁层落点：用户目录 $DSH_HOME/desktop.patch.yml 优先（仓库热更新只写它）> 随包副本。
// 用函数而非模块级常量：刚更新过补丁层后重启宿主必须能读到新那份。
function patchFile() {
  const user = path.join(HOME, 'desktop.patch.yml')
  try {
    if (fs.statSync(user).size > 0) return user
  } catch { /* 没有用户副本：用随包的那份 */ }
  return PATCH_FILE_BUNDLED
}
const SETTINGS_HTML = path.join(APP_DIR, 'settings.html')
const LOGS_HTML = path.join(APP_DIR, 'logs.html')
// 启动页（宿主就绪前先显示它）。
const SPLASH_HTML = path.join(APP_DIR, 'splash.html')
// 浏览器面板用的 favicon（路由固定 /icon.ico）：开发态必须指 build/ 生成物，不能指 ROOT_DIR。
// 托盘/窗口图标不能用它（Linux/macOS 解 .ico 是空图）——见下面 TRAY_ICON_FILE。
const ICON_FILE = app.isPackaged ? path.join(RES, 'icon.ico') : path.join(ROOT_DIR, 'build', 'icon.ico')
/** 托盘与窗口图标按平台选文件：Linux/macOS 要 .png，.ico 在那两个平台解成空图。 */
const TRAY_ICON_FILE = iconFilePath({ packaged: app.isPackaged, res: RES, rootDir: ROOT_DIR })
// ── vendor 树归属（决策 D8）──
// 可变的那棵树放用户数据目录（与 APP_DATA 同卷，换树靠 rename，跨卷会 EXDEV），包内那份只作种子。
// 开发态仍用仓库里的树，不进用户目录。
const VENDOR_HOME = app.isPackaged
  ? resolveVendorHome({ appData: APP_DATA, packagedVendor: PACKAGED_VENDOR })
  : { dir: PACKAGED_VENDOR, seedDir: PACKAGED_VENDOR, source: 'packaged', needsSeed: false }
// 用 let 而非 const：prepareVendorHome() 可能把两者回退到包内种子（启动早期一次性决定）。
let VENDOR_DIR = VENDOR_HOME.dir
let VENDOR_STAGING_ROOT = path.join(VENDOR_DIR, 'staging')
const HOST_LOG = path.join(LOG_DIR, 'host.log')
// 宿主 stderr 单独落盘：崩溃真因在这里，必须由父进程实时接管才留得住（见 host.mjs）。
const HOST_ERR_LOG = path.join(LOG_DIR, 'host.stderr.log')
// 日志目录必须在这里建好：log() 在模块顶层（单实例锁那段）就会被调用，晚建会丢最早期日志。
// 建目录失败不阻断启动（log() 自己有 console 兜底）。
try { fs.mkdirSync(LOG_DIR, { recursive: true }) } catch { /* 日志目录不可写：不阻断启动 */ }

// ── 单实例"重复启动"的文件信号兜底通道 ──
// 拿不到锁的进程写它，拿到锁的进程（本进程）轮询它：只用文件系统，不依赖平台事件送达。
const RESTORE_REQUEST_FILE = path.join(APP_DATA, 'restore-request.json')
let restoresWatchTimer = null
let lastRestoreHandledMs = 0
// 打包期写进 vendor.lock.json 的依赖文件数基线（按平台不同）；低于它 = 依赖缺件，0 表示读不到。
// 惰性求值：prepareVendorHome() 可能把 VENDOR_DIR 回退到包内种子，基线要跟着那次决定走。
let vendorBaselineCache = null
function vendorBaseline() {
  if (vendorBaselineCache === null) vendorBaselineCache = readVendorBaseline(VENDOR_DIR)
  return vendorBaselineCache
}

// 启动早期把 vendor 树就位（打包态）：用户目录缺失则拷种子；不可用则回退包内种子并留痕；
// 两处都不可用就保持原样，交给后面的 dshBin() 报错。无论走哪条路，VENDOR_DIR / 暂存区 / 基线都随之对齐。
function prepareVendorHome() {
  if (VENDOR_HOME.source !== 'userData') return
  const seed = VENDOR_HOME.seedDir
  if (!fs.existsSync(path.join(VENDOR_DIR, 'profile', 'package.json'))) {
    const r = seedVendorHome({ dir: VENDOR_DIR, seedDir: seed, log })
    if (!r.seeded) log(`vendor 种子未落地（${r.reason ?? '未知'}），本次改用包内 vendor`)
  }
  const check = inspectVendorHome(VENDOR_DIR)
  if (check.usable) {
    log(`vendor: 使用用户数据目录里的树（${VENDOR_DIR}）`)
    return
  }
  const seedCheck = inspectVendorHome(seed)
  if (seedCheck.usable) {
    log(`vendor: 用户数据目录里的树不可用（${check.reason}）→ 回退用包内 vendor ${seed}（本次不换树）`)
    VENDOR_DIR = seed
    VENDOR_STAGING_ROOT = path.join(VENDOR_DIR, 'staging')
    vendorBaselineCache = null
    return
  }
  log(`vendor: 用户数据目录与包内都没有可用的树（${check.reason} / ${seedCheck.reason}）`)
}

// DSH_BIN 是解析结果（vendor 内的某个路径），必须惰性求值：换树会把该目录改名走开，
// 求值早了会缓存住失效路径。所有调用点一律用 dshBin()，不要退回常量。
let dshBinCache
function dshBin() {
  if (dshBinCache === undefined) dshBinCache = findDshBin([path.join(VENDOR_DIR, 'profile')])
  return dshBinCache
}

const args = process.argv.slice(process.defaultApp ? 2 : 1)
const SMOKE = args.includes('--smoke') || args.includes('--no-window')
const HEADLESS = args.includes('--headless')
const DEV = args.includes('--dev')
const DOCTOR = args.includes('--doctor')
const DIAG = args.includes('--diag') || args.includes('--diagnose')
const SKIP_REG = process.env.DSH_SMOKE === '1' || SMOKE // 冒烟测试不写注册表/登录项

let readyUrl = null
let webPort = 0
let adminPort = 0
let adminServer = null
let hostProc = null
let win = null
let quitting = false
let restarts = 0
let bgCssKey = null // 注入的自定义背景 CSS 句柄（removeInsertedCSS 用）
const startedAt = Date.now()

// ── dsh:// 深链的送达（决策 D9）── macOS 走 open-url 事件；Windows/Linux 走 second-instance
// 带来的 argv（要求已启用单实例锁）。壳只记录最近收到的 URL，路径语义交给 DSH 前端自己。
let lastProtocolUrl = null
/** 从一串 argv 里挑出 `dsh://` 参数（Windows/Linux 的 second-instance 与冷启动都会带）。 */
function pickProtocolUrl(argv) {
  for (const a of argv) if (typeof a === 'string' && /^dsh:\/\//i.test(a)) return a
  return null
}
// 处理一次深链：切到主窗口并把 URL 记进壳状态文件。壳不解释 dsh:// 的路径语义
// （DSH 本体零改动），记录 + 聚焦是壳能保证的部分。
function handleProtocolUrl(url, source) {
  if (typeof url !== 'string' || url === '') return
  lastProtocolUrl = url
  log(`[deep-link] 收到 dsh:// 深链（来源 ${source}）：${url}`)
  try { writeState({ lastDeepLink: url, lastDeepLinkAt: new Date().toISOString() }) } catch { /* 尽力而为 */ }
  void focusAction()
}

function readVersion() {
  try { return fs.readFileSync(VERSION_FILE, 'utf8').trim() } catch { return '0.0.0-dev' }
}
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { fs.appendFileSync(path.join(LOG_DIR, 'app.log'), line) } catch { /* 日志目录不可写 */ }
  // console.log 也要兜住：stdout 可能是已关闭的管道（EPIPE），在 Electron 里会变 uncaughtException。
  try { console.log(line.trimEnd()) } catch { /* stdout 不可用 */ }
}

/** 宿主日志尾部若干行，用于把"启动即退出"的真因直接摆到壳日志里。 */
function hostLogTail(limit = 6) {
  try { return fs.readFileSync(HOST_LOG, 'utf8').split('\n').filter(Boolean).slice(-limit).join(' | ') } catch { return '' }
}
/** 宿主进程最后遗言（环形缓冲，含 stderr），崩溃通知直接展示这几行：真因只在宿主 stderr 里。 */
function hostRingTail(limit = 3, maxChars = 300) {
  try {
    const lines = (hostProc && typeof hostProc.dshRingLines === 'function' ? hostProc.dshRingLines() : [])
      .map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim().length > 0)
    if (lines.length === 0) {
      const f = fs.readFileSync(HOST_ERR_LOG, 'utf8').split('\n').filter((l) => l.trim().length > 0).slice(-limit)
      return f.join(' | ').slice(0, maxChars)
    }
    return lines.slice(-limit).join(' | ').slice(0, maxChars)
  } catch { return '' }
}
function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8').replace(/^\uFEFF/, '')) } catch { return {} }
}
function writeSettings(s) {
  fs.mkdirSync(APP_DATA, { recursive: true })
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2))
}
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}
function writeState(partial) {
  try {
    fs.mkdirSync(APP_DATA, { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...partial, pid: process.pid }, null, 2))
  } catch { /* 状态文件尽力而为 */ }
}
function clearState() { try { fs.unlinkSync(STATE_FILE) } catch { /* 已删 */ } }

// agent shell 的可用性探测（分平台：Windows 问 pwsh，POSIX 问 bash）。
// @returns {{kind:'pwsh'|'bash', path:string|null, ok:boolean}}
function agentShell() {
  const want = process.platform === 'win32' ? 'pwsh' : 'bash'
  const found = whichCommand(want)
  return { kind: want, path: found, ok: found !== null }
}

// 在 PATH 中查找可执行文件（三平台）。POSIX 上不 spawn `which`（精简镜像常没有），直接查 PATH。
// @returns {string|null} 绝对路径或 null
function whichCommand(name) {
  if (process.platform === 'win32') {
    try {
      const r = spawnSync('where', [name], { encoding: 'utf8', windowsHide: true })
      if (r.status === 0) {
        const first = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
        if (first) return first
      }
    } catch { /* where 不可用 */ }
    return null
  }
  for (const dir of String(process.env.PATH ?? '').split(':')) {
    if (dir === '') continue
    const p = path.join(dir, name)
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch { /* 继续找 */ }
  }
  return null
}

function ps7Available() {
  return agentShell().ok
}
function setAutostart(on) {
  if (SKIP_REG) return
  if (process.platform === 'linux') {
    setLinuxAutostart(on)
    log(`autostart: ${on ? 'on' : 'off'}（XDG autostart）`)
    return
  }
  // Windows：写 HKCU 的 Run 键（Electron 内部完成）；macOS：登录项（path/args 仅 Windows 生效，忽略即可）
  app.setLoginItemSettings({
    openAtLogin: on,
    ...(process.platform === 'win32' ? { path: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] } : {}),
  })
  log(`autostart: ${on ? 'on' : 'off'}`)
}

// Linux 开机自启：写/删 XDG autostart 的 .desktop（setLoginItemSettings 在 Linux 上是 no-op）。
// 只在内容不一致时才写：每次启动都重写会让 mtime 抖动，GNOME 会弹"是否保留此应用"。
// @param {boolean} on 是否开机自启
function setLinuxAutostart(on) {
  const base = process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config')
  const file = path.join(base, 'autostart', 'dsh-desktop.desktop')
  try {
    if (!on) { if (fs.existsSync(file)) fs.rmSync(file, { force: true }); return }
    // .desktop 的 Exec 值里 % 要转义成 %%，引号用于包住含空格的路径
    const exec = `"${process.execPath.replaceAll('%', '%%')}"${app.isPackaged ? '' : ` "${app.getAppPath().replaceAll('%', '%%')}"`}`
    const body = [
      '[Desktop Entry]',
      'Type=Application',
      'Version=1.0',
      `Name=${APP_NAME}`,
      'Comment=DeepSeek Harness 桌面壳',
      `Exec=${exec}`,
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      'StartupNotify=false',
      '',
    ].join('\n')
    let cur = null
    try { cur = fs.readFileSync(file, 'utf8') } catch { cur = null }
    if (cur === body) return
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body)
    log(`autostart: 已写入 ${file}`)
  } catch (e) {
    log(`autostart: 写入失败（非致命）：${e.message}`)
  }
}
function applyProtocol() {
  if (SKIP_REG) return
  if (process.defaultApp) app.setAsDefaultProtocolClient('dsh', process.execPath, [app.getAppPath()])
  else app.setAsDefaultProtocolClient('dsh')
  log('protocol: dsh:// registered')
}

// 冷启动时 Windows/Linux 的深链在本进程自己的 argv 里（open-url 与 second-instance 都覆盖不到）；
// macOS 不走 argv（LaunchServices 只发 open-url）。
// 变量名是 args（不是 argv）：写错会在模块加载期 ReferenceError，而离线单测看不见。
const COLD_START_URL = process.platform === 'darwin' ? null : pickProtocolUrl(args)

// ---------- 单实例锁与深链送达（决策 D9，必须在任何 await/ready 之前完成）----------
// 启用理由：second-instance 只在拿到锁之后才触发，而 Windows/Linux 的深链正是靠它送进来；
// 附带避免多进程并发写同一个 userData；冒烟/无头/体检类命令不抢锁（要在 CI 并行跑或用于诊断）。
const SINGLE_INSTANCE = !SMOKE && !HEADLESS && !DOCTOR && !DIAG
// 【临时诊断】DSH_TRACE_SINGLE=1 时把"走到哪一步"同时写 stdout 与 stderr
// （打包态没有控制台，但可外部重定向 exe 的输出抓到）。
const TRACE = process.env.DSH_TRACE_SINGLE === '1'
function trace(m) {
  if (!TRACE) return
  const line = `[trace ${new Date().toISOString()}] ${m}`
  try { process.stdout.write(line + '\n') } catch { /* 忽略 */ }
  try { process.stderr.write(line + '\n') } catch { /* 忽略 */ }
}
trace(`main.mjs 模块顶层执行到单实例段：pid=${process.pid} argv=${args.slice(0, 4).join(' ')}`)
let userDataNow = '(取不到)'
try { userDataNow = String(app.getPath('userData')) } catch (e) { userDataNow = `(异常 ${e && e.message})` }
trace(`userData=${userDataNow} SINGLE_INSTANCE=${SINGLE_INSTANCE}`)
let lockOk = null
try { lockOk = SINGLE_INSTANCE ? app.requestSingleInstanceLock() : '(不抢锁)' } catch (e) { lockOk = `(抛异常 ${e && e.message})` }
trace(`requestSingleInstanceLock → ${lockOk}`)
// 先把这次启动的基本事实落盘再抢锁：抢锁失败会立刻 exit，之后什么日志都来不及写。
try {
  log(`启动：pid=${process.pid} 参数=${args.slice(0, 4).join(' ')} userData=${userDataNow} 单实例=${SINGLE_INSTANCE} 锁=${lockOk}`)
} catch { /* 尽力而为 */ }
if (SINGLE_INSTANCE && lockOk !== true) {
  // 打包态没有控制台，这些 stdout 谁也看不见；留壳日志才能区分"被单实例挡下"与"闪一下就没了"
  log('单实例：未取得锁（已有实例在运行），本次启动退出 —— 已请求既有实例把窗口调出来')
  // 兜底通道：写一个"请把窗口调出来"的请求文件。拿不到锁的进程可能在任何日志生效之前就退出，
  // 所以这一步必须尽量靠前，并且自己兜住异常。
  try {
    fs.mkdirSync(APP_DATA, { recursive: true })
    fs.writeFileSync(RESTORE_REQUEST_FILE, JSON.stringify({ at: Date.now(), pid: process.pid, argv: args.slice(0, 4) }))
  } catch (e) {
    try { process.stderr.write(`[DSH Desktop] 写重复启动请求文件失败：${e && e.message}\n`) } catch { /* 忽略 */ }
  }
  console.log('[DSH Desktop] 已有实例在运行，本次启动退出（把焦点交给那个实例）')
  trace('即将 app.exit(3)')
  app.exit(3)
} else {
  // ── 单实例"重复启动"的兜底通道：文件信号 ──
  // 拿不到锁的进程可能在本进程代码跑起来之前就退出（事件送没送达无法从壳内部证实），
  // 于是改为它写请求文件、本进程轮询；事件是快路径，文件是保底，重复调用无害。
  if (SINGLE_INSTANCE) {
    try {
      if (fs.existsSync(RESTORE_REQUEST_FILE)) fs.unlinkSync(RESTORE_REQUEST_FILE)   // 清掉上一轮的残留
    } catch { /* 忽略 */ }
    restoresWatchTimer = setInterval(() => {
      try {
        const st = fs.statSync(RESTORE_REQUEST_FILE)
        if (st.mtimeMs <= lastRestoreHandledMs) return
        lastRestoreHandledMs = st.mtimeMs
        log(`单实例：看到"重复启动"请求文件（${new Date(st.mtimeMs).toISOString()}），把窗口调出来`)
        void focusAction().then((r) => log(`单实例：兜底置前结果 ${r.note}`))
      } catch { /* 文件不在或读不到：正常情况（没有重复启动） */ }
    }, 1500)
    log(`单实例：已取得锁（本进程是唯一实例）；重复启动兜底通道已就绪（${RESTORE_REQUEST_FILE}）`)
  }
  app.on('second-instance', (_event, argv) => {
    // 留痕：否则"重复启动没把窗口调出来"无法归因（事件没触发，还是触发了但置前失败）
    log(`单实例：收到第二个实例的启动请求（argv=${(argv || []).slice(0, 4).join(' ')}）`)
    const url = pickProtocolUrl(argv)
    if (url !== null) handleProtocolUrl(url, 'second-instance')
    else void focusAction().then((r) => log(`单实例：置前结果 ${r.note}`))
  })
  // macOS：深链与文件打开都走事件（`open-url` 可能在 ready 之前到达，先记下来）
  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleProtocolUrl(url, 'open-url')
  })
}

// ---------- 壳设置入口：直接带主窗口打开 DSH 自带设置面板 ----------
// 触发方式只有一种：点击带 aria-haspopup="dialog" 的按钮（CSS 模块哈希类名不可依赖）。
function openDshSettings() {
  if (HEADLESS || SMOKE) { shell.openExternal(`http://127.0.0.1:${adminPort}/`); return }
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    win.webContents
      .executeJavaScript(`document.querySelector('button[aria-haspopup="dialog"]')?.click()`, true)
      .catch(() => { /* SPA 未就绪则仅聚焦 */ })
  }
}

// ---------- 自定义背景图片 ----------
// 壳级壁纸：不碰 DSH 源码，只注入一层 CSS；SPA 的不透明框架底色必须一并置透明才看得见
// 规则在 src/bg-css.mjs。图片经壳 admin 回环 HTTP 供给（Chromium 禁止 http 页加载 file://）。
const BG_ALLOWED_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.ico']

// 壁纸调参（亮度/模糊）：读设置 → 钳制（钳制规则在 src/bg-css.mjs，那边有门禁）。
function bgTuning() {
  return bgTuningOf(readSettings())
}

const SKIN_RAIL_MASK_DEFAULT = 0.35
const SKIN_CONVERSATION_MASK_DEFAULT = 0.25
// 右侧栏全屏态单独一档且更重：全屏时它铺满整个工作面，正文直接压在壁纸上，沿用对话区那档读不清。
const SKIN_FULLSCREEN_MASK_DEFAULT = 0.8
function skinTuning() {
  const s = readSettings()
  const num = (v, dflt) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : dflt
  }
  return {
    railMaskOpacity: num(s.railMaskOpacity, SKIN_RAIL_MASK_DEFAULT),
    conversationMaskOpacity: num(s.conversationMaskOpacity, SKIN_CONVERSATION_MASK_DEFAULT),
    fullscreenMaskOpacity: num(s.fullscreenMaskOpacity, SKIN_FULLSCREEN_MASK_DEFAULT),
  }
}

// 左侧栏背景模式：extend 延伸主页面壁纸（默认）/ own 独立选一张图。
// 「左侧栏必须比主页面更不透明」由客户端写 CSS 变量时取 max(本值, 对话区遮罩) 实现；
// 壳只存用户拖出来的原始值（把 max 放进壳会让滑块回读时跳一下）。
const SIDEBAR_BG_MODES = ['extend', 'own']
const SIDEBAR_OPACITY_DEFAULT = 0.45

// ── 遮罩/毛玻璃的开关与强度分开存 ──
// 「关」必须是独立布尔状态，不能靠"强度 = 0"表示：每个可调项都是 xxxEnabled + xxxOpacity 两个键。
// 键名与默认值、迁移规则都来自 ./skin-settings.mjs，不要在这里再定义一份。

/** 文件的 mtime 当"版本号"。取不到返回 0——文件被删/不可读时不能让状态快照跟着炸。 */
function fileMtimeMs(p) {
  if (!p) return 0
  try { return Math.round(fs.statSync(p).mtimeMs) } catch { return 0 }
}

// 把旧设置补齐到新模型（开关 + 强度）并落盘。规则在 skin-settings.mjs，这层只做读盘 → 写回 → 记日志。
// 注意：写回是整体覆盖，必须基于 readSettings() 的完整对象，否则会抹掉用户已有设置。
// @returns {boolean} 是否真的写了盘（调用方据此记日志）
function migrateSkinSettings() {
  let r
  try {
    r = migrateSkinSettingsPure(readSettings())
  } catch (e) {
    log("设置迁移读取失败：" + e.message)
    return false
  }
  if (r.changed.length === 0) return false
  try {
    writeSettings(r.settings)
    log("设置迁移：补齐 " + r.changed.length + " 个键（" + r.changed.join(", ") + "；有壁纸=" + r.hasWallpaper + "）")
  } catch (e) {
    log("设置迁移写入失败：" + e.message)
  }
  return true
}

// 皮肤快照：每个可调项 = 开关 + 强度，外加毛玻璃两项（规则在 skin-settings.mjs）。
// @param {object} [s] 已读好的 settings（省一次读盘）
function skinSnapshot(s = readSettings()) {
  return skinSnapshotPure(s, skinTuning(s))
}

// 允许传入已读好的 settings：statusPayload 每 5 秒被调一次，而 readSettings() 是真实读盘。
function sidebarTuning(s = readSettings()) {
  const mode = SIDEBAR_BG_MODES.includes(s.sidebarBgMode) ? s.sidebarBgMode : 'extend'
  const n = Number(s.sidebarOpacity)
  return {
    mode,
    image: typeof s.sidebarBgImage === 'string' ? s.sidebarBgImage : '',
    opacity: Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : SIDEBAR_OPACITY_DEFAULT,
  }
}

function bgCssFor(filePath) {
  // ?t=mtime 破缓存（换图后立即生效）；mtime 在这里读，src/bg-css.mjs 因此是纯函数、可测。
  let t = 0
  try { t = Math.round(fs.statSync(filePath).mtimeMs) } catch { /* 忽略 */ }
  const { brightness, blur } = bgTuning()
  return bgCssText({ adminPort, brightness, blur, mtime: t })
}
async function applyBackgroundCss() {
  if (!win || win.isDestroyed()) return
  if (bgCssKey !== null) {
    try { win.webContents.removeInsertedCSS(bgCssKey) } catch { /* 已随页面销毁 */ }
    bgCssKey = null
  }
  const img = readSettings().backgroundImage || ''
  if (!img || !fs.existsSync(img)) return
  try {
    bgCssKey = await win.webContents.insertCSS(bgCssFor(img))
    log(`背景图片已应用: ${img}`)
  } catch (e) { log(`背景图片注入失败: ${e.message}`) }
}

function setBackgroundImage(filePath) {
  const s = readSettings()
  if (filePath) {
    if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在' }
    const ext = path.extname(filePath).toLowerCase()
    if (!BG_ALLOWED_EXT.includes(ext)) {
      return { ok: false, error: `不支持的图片格式 ${ext || '(无扩展名)'}，请使用 jpg/jpeg/png/webp 等` }
    }
    s.backgroundImage = filePath
    writeSettings(s)
    applyBackgroundCss()
    return { ok: true, path: filePath }
  }
  delete s.backgroundImage
  writeSettings(s)
  applyBackgroundCss()
  return { ok: true, cleared: true }
}

async function pickBackgroundImage() {
  if (HEADLESS || SMOKE) return { ok: true, canceled: true, note: 'headless（不弹选择器）' }
  const r = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, {
    title: '选择背景图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'] }],
  })
  if (r.canceled || r.filePaths.length === 0) return { ok: true, canceled: true }
  return setBackgroundImage(r.filePaths[0])
}

// 左侧栏独立图片：与主壁纸同一套校验（存在 + 扩展名），只是存另一个键。
// 刻意不调 applyBackgroundCss()：左侧栏那层背景由客户端插件注入，壳侧没有可重绘的东西。
function setSidebarBackgroundImage(filePath) {
  const s = readSettings()
  if (filePath) {
    if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在' }
    const ext = path.extname(filePath).toLowerCase()
    if (!BG_ALLOWED_EXT.includes(ext)) {
      return { ok: false, error: `不支持的图片格式 ${ext || '(无扩展名)'}，请使用 jpg/jpeg/png/webp 等` }
    }
    s.sidebarBgImage = filePath
    writeSettings(s)
    return { ok: true, path: filePath }
  }
  // 清除只摘路径，不动模式：用户清完图通常还想再选一张，模式被顺手改掉会很烦。
  delete s.sidebarBgImage
  writeSettings(s)
  return { ok: true, cleared: true }
}

async function pickSidebarBackgroundImage() {
  if (HEADLESS || SMOKE) return { ok: true, canceled: true, note: 'headless（不弹选择器）' }
  const r = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, {
    title: '选择左侧栏背景图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'] }],
  })
  if (r.canceled || r.filePaths.length === 0) return { ok: true, canceled: true }
  return setSidebarBackgroundImage(r.filePaths[0])
}

// ---------- 日志轮转（按天归档，保留 7 天；M3 个人使用版） ----------
const LOG_KEEP_DAYS = 7
function rotateLogs() {
  try {
    const now = new Date()
    const cutoff = Date.now() - LOG_KEEP_DAYS * 86400000
    for (const name of ['app.log', 'host.log']) {
      const p = path.join(LOG_DIR, name)
      if (!fs.existsSync(p)) continue
      const st = fs.statSync(p)
      if (st.size === 0) continue
      const d = new Date(st.mtimeMs)
      if (d.toDateString() !== now.toDateString()) {
        const tag = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
        fs.renameSync(p, path.join(LOG_DIR, `${name}.${tag}`))
      }
    }
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!/\.log\.\d{8}$/.test(f)) continue
      const p = path.join(LOG_DIR, f)
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p) } catch { /* 占用中跳过 */ }
    }
  } catch { /* 轮转尽力而为 */ }
}

// 有发布源才启用自动更新/托盘检查：app-update.yml（配了 publish 才打进 resources/）缺了就静默降级。
const HAS_UPDATE_SOURCE = app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))

// 「有发布源」≠「能自我替换」：Linux 上 electron-updater 只支持 AppImage（靠替换该文件自更新）；
// deb 装到 /opt 既无可替换的文件也无写权限，所以非 AppImage 的 Linux 把"检查更新"降级为打开下载页。
const IS_APPIMAGE = process.platform === 'linux' && (process.env.APPIMAGE ?? '') !== ''
const UPDATABLE = HAS_UPDATE_SOURCE && (process.platform !== 'linux' || IS_APPIMAGE)

// 从 app-update.yml 里取出发布页地址（GitHub Releases）。读文件而非写死 owner/repo：
// electron-builder.yml 才是唯一来源，写死第二份必然漂移；只用两行正则，不引入 yaml 依赖。
// @returns {string|null} 发布页 URL；读不到返回 null
function releasesUrl() {
  try {
    const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8')
    const owner = /^owner:\s*(.+)$/m.exec(yml)?.[1]?.trim()
    const repo = /^repo:\s*(.+)$/m.exec(yml)?.[1]?.trim()
    return owner !== undefined && repo !== undefined ? `https://github.com/${owner}/${repo}/releases/latest` : null
  } catch { return null }
}

// ---------- 托盘（M1b；菜单面精简，双击托盘 = 打开主窗） ----------
let tray = null
// 托盘是否真的可用（创建成功且图标非空）：Linux 上 new Tray() 可能"成功"却不可见，
// 若 close-to-tray 只看 tray !== null，窗口会被隐藏且用户没有任何恢复入口。
// 两个条件任一不成立即判不可用，close-to-tray 自动关闭。
let trayUsable = false
function spawnTray() {
  if (SMOKE || HEADLESS) return
  try {
    const icon = fs.existsSync(TRAY_ICON_FILE) ? nativeImage.createFromPath(TRAY_ICON_FILE) : nativeImage.createEmpty()
    if (icon.isEmpty()) {
      log(`tray: 图标解不出来（${path.basename(TRAY_ICON_FILE)} 解成空图），托盘按不可用处理——`
        + 'Linux/macOS 上 .ico 是空图，本平台应取 .png（见 src/tray-icon.mjs）')
    }
    tray = new Tray(icon)
    // 两条路径都要挂，因为各平台的"激活"语义不一样：Windows 靠 double-click；
    // macOS/Linux 只有 click（Linux 上 double-click 事件根本不存在）。
    tray.on('double-click', () => focusAction())
    tray.on('click', () => { if (process.platform !== 'win32') focusAction() })
    trayUsable = !icon.isEmpty()
  } catch (e) {
    // 创建失败（Linux 缺托盘服务是最常见原因）→ 明确降级，而不是让窗口消失得无影无踪
    trayUsable = false
    tray = null
    log(`tray: 创建失败（${e.message}）→ 关闭"最小化到托盘"，窗口保持可见`)
    return
  }
  tray.setToolTip(APP_NAME)
  tray.setContextMenu(Menu.buildFromTemplate([
    // 第一项必须是"把窗口叫回来"：部分 Linux 桌面连 click 都不发，菜单是唯一保底的入口。
    { label: '打开主窗口', click: () => { void focusAction() } },
    { label: '设置', click: () => openDshSettings() },
    { label: '后台日志（Ctrl+Shift+L）', click: () => { log(`托盘：打开后台日志窗口 ${JSON.stringify(toggleLogWindow())}`) } },
    { label: '数据目录', click: () => shell.openPath(APP_DATA) },
    { label: '工作区', click: () => shell.openPath(WS) },
    { type: 'separator' },
    { label: '重启宿主（重载插件）', click: () => restartHostManual().then((r) => log(r.ok ? `手动重启完成: ${r.webUrl}` : `手动重启失败: ${r.error}`)) },
    // 这条查 DSH（harness）版本；下面那条是壳自更新。手动动作必须有可见反馈，所以用通知回显结果。
    {
      label: '检查 DSH 更新',
      click: () => {
        void (async () => {
          const r = await dshCheck()
          let body
          if (!r.ok) body = `检查失败：${r.error ?? '未知原因'}`
          else if (r.hasUpdate) body = `发现新版本 ${r.target}（设置 → 桌面 里可更新）`
          else body = `已是最新版本（${r.current ?? '未知'}）`
          try { new Notification({ title: APP_NAME, body }).show() } catch { /* 无通知权限则忽略 */ }
        })()
      },
    },
    {
      // 有发布源且形态支持才走自更新；Linux 非 AppImage（deb）降级为打开下载页（按钮始终可点）。
      label: UPDATABLE ? '检查更新' : (HAS_UPDATE_SOURCE ? '检查更新（打开下载页）' : '检查更新'),
      enabled: HAS_UPDATE_SOURCE,
      click: () => {
        if (!UPDATABLE) {
          const url = releasesUrl()
          if (url !== null) { void shell.openExternal(url); log(`托盘：不支持自更新，已打开下载页 ${url}`) }
          else log('托盘：不支持自更新，且读不到发布页地址（app-update.yml）')
          return
        }
        void autoUpdater.checkForUpdates()
          .then((r) => log(`托盘：检查更新完成（${r?.updateInfo?.version ?? '无新版本'}）`))
          .catch((e) => log(`update check: ${e.message}`))
      },
    },
    {
      // 平面 C：从仓库拉"缺的文件与功能"（自带插件 / 补丁层 / 市场目录），不换安装包。
      label: '从仓库更新功能',
      click: () => {
        void (async () => {
          const r = await repoUpdateApply()
          let body
          if (r.ok !== true && r.failed?.length > 0) body = `部分失败：${r.failed.map((f) => f.id).join(' / ')}`
          else if (r.ok !== true) body = `更新失败：${r.error ?? '未知原因'}`
          else body = r.message
          try { new Notification({ title: `${APP_NAME}·仓库功能更新`, body }).show() } catch { /* 无通知权限则忽略 */ }
        })()
      },
    },
    {
      // 壳自身那一层：把仓库里下好的壳源码换进 app.asar 并重启应用（插件那条只需重启宿主）。
      label: '换壳并重启',
      click: () => {
        void (async () => {
          const r = repoUpdateShellSwap()
          if (r.ok !== true) {
            try { new Notification({ title: `${APP_NAME}·换壳`, body: r.error ?? '无法换壳' }).show() } catch { /* 无通知权限则忽略 */ }
          }
          // 成功时应用马上会自己退出并重启，不再发通知（发了也看不到）
        })()
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => cleanup(0) },
  ]))
  log(`tray: ready（可用=${trayUsable}）`)
}

// ---------- 后台日志窗口（Ctrl+Shift+L / 托盘「后台日志」）----------
// 打包版没有 F12/控制台，这里把四份日志收进一个壳内窗口（自动刷新 + 关键字过滤）。
// 安全边界：只读；文件名白名单固定四份（不吃任意路径）；页面与数据都只走回环 admin 端口。
const LOG_FILES = [
  { name: 'app.log', title: '壳日志' },
  { name: 'host.log', title: '宿主日志（dsh web 输出）' },
  { name: 'host.stderr.log', title: '宿主错误（插件装载失败等）' },
  { name: 'auto-approval.log', title: '自动审批决策' },
]
let logWin = null

function logFileEntries() {
  const out = []
  for (const f of LOG_FILES) {
    const p = f.name === 'auto-approval.log' ? path.join(HOME, 'logs', 'auto-approval.log') : path.join(LOG_DIR, f.name)
    try {
      const st = fs.statSync(p)
      out.push({ name: f.name, title: f.title, path: p, bytes: st.size, mtime: st.mtimeMs })
    } catch { /* 还没生成的文件（例如本次没触发审批）就不列出来 */ }
  }
  return out
}

// 读一份日志的末尾若干行。大文件不能整个 readFileSync（会同步阻塞主进程，窗口看着像卡住），
// 只读末尾 min(size, 512KB) 再往前数行。
// @param {string} name 白名单里的文件名；@param {number} lines 最多返回多少行
function readLogTail(name, lines) {
  const entry = logFileEntries().find((f) => f.name === name)
  if (entry === undefined) return { ok: false, error: '不在日志白名单里' }
  const want = Math.max(1, Math.min(5000, Number.isFinite(lines) ? Math.floor(lines) : 400))
  const CAP = 512 * 1024
  let fd = null
  try {
    fd = fs.openSync(entry.path, 'r')
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - CAP)
    const len = size - start
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, start)
    const all = buf.toString('utf8').split('\n')
    const truncated = start > 0
    const tail = all.slice(-want)
    return {
      ok: true,
      file: entry.name,
      title: entry.title,
      bytes: size,
      mtime: entry.mtime,
      truncated,
      text: (truncated ? '…（只显示文件末尾 ' + Math.round(CAP / 1024) + ' KB 内的内容）\n' : '') + tail.join('\n'),
    }
  } catch (e) {
    return { ok: false, error: `读取失败：${e && e.message}` }
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* 已关 */ } }
  }
}

function openLogWindow() {
  if (logWin !== null && !logWin.isDestroyed()) {
    if (logWin.isMinimized()) logWin.restore()
    logWin.show()
    logWin.focus()
    return { ok: true, note: 'shown' }
  }
  const url = `http://127.0.0.1:${adminPort}/logs`
  logWin = new BrowserWindow({
    width: 1080, height: 720, show: false, title: 'DSH Desktop 后台日志',
    icon: fs.existsSync(TRAY_ICON_FILE) ? TRAY_ICON_FILE : undefined,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: DEV },
  })
  logWin.once('ready-to-show', () => { try { logWin.show() } catch { /* 已销毁 */ } })
  logWin.on('closed', () => { logWin = null })
  // 页面里的链接（日志正文一般没有，但保留一致性）一律交给系统浏览器，绝不进壳内
  logWin.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:\/\//.test(u)) shell.openExternal(u)
    return { action: 'deny' }
  })
  logWin.loadURL(url).catch((e) => log(`日志窗口装载失败：${e && e.message}`))
  return { ok: true, note: 'created', url }
}

function toggleLogWindow() {
  if (logWin !== null && !logWin.isDestroyed()) { logWin.close(); return { ok: true, note: 'closed' } }
  return openLogWindow()
}

function registerLogShortcut() {
  if (SMOKE || HEADLESS) return
  try {
    const ok = globalShortcut.register('CommandOrControl+Shift+L', () => { toggleLogWindow() })
    log(ok
      ? '日志窗口快捷键已注册：Ctrl+Shift+L（托盘「后台日志」同效）'
      : '日志窗口快捷键 Ctrl+Shift+L 注册失败（可能被别的应用占用）——仍可用托盘「后台日志」')
  } catch (e) {
    log(`日志窗口快捷键注册异常（不影响托盘入口）：${e && e.message}`)
  }
}

// ---------- 自动更新（仅打包态；无发布源或形态不支持时明确降级） ----------
function initUpdater() {
  if (!HAS_UPDATE_SOURCE) return
  if (!UPDATABLE) {
    // deb 等非 AppImage 安装：电子更新器没有可替换的目标，直接说清楚，别让用户点了没反应
    log('updater: 该安装形态不支持自更新（Linux 非 AppImage）——托盘「检查更新」改为打开下载页')
    return
  }
  try {
    autoUpdater.autoDownload = true
    autoUpdater.on('update-available', (info) => log(`updater: 发现新版本 ${info?.version ?? '?'}，开始下载`))
    autoUpdater.on('update-not-available', () => log('updater: 已是最新版本'))
    // 进度只按 10% 记一行：日志窗口是给人看的，逐字节刷屏等于没有进度
    let lastPct = -10
    autoUpdater.on('download-progress', (p) => {
      const pct = Math.floor(Number(p?.percent ?? 0) / 10) * 10
      if (pct > lastPct) { lastPct = pct; log(`updater: 下载 ${pct}%（${Math.round((p?.transferred ?? 0) / 1048576)} MB）`) }
    })
    autoUpdater.on('error', (e) => log(`updater 错误：${e?.message ?? e}`))
    autoUpdater.on('update-downloaded', () => {
      const n = new Notification({ title: APP_NAME, body: '新版本已下载，点击重启安装。' })
      n.on('click', () => autoUpdater.quitAndInstall())
      n.show()
    })
    autoUpdater.checkForUpdatesAndNotify().catch((e) => log(`update check: ${e.message}`))
  } catch (e) { log(`updater init: ${e.message}`) }
}

// ---------- 窗口（安全基线：评审稿 2.7） ----------
async function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, show: false,
    title: APP_NAME,
    icon: fs.existsSync(TRAY_ICON_FILE) ? TRAY_ICON_FILE : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: DEV,
    },
  })
  win.once('ready-to-show', () => { if (!HEADLESS) win.show() })
  // 不等 ready-to-show：createWindow() 跑在 bootHost 之前，先把窗口摆出来（见下方 loadURL）。
  win.on('closed', () => { win = null })
  win.webContents.on('dom-ready', () => { applyBackgroundCss() })
  // close-to-tray：窗口关闭 → 隐藏到托盘（可在设置里关掉），托盘"退出"才真正退出。
  // 判据必须用 trayUsable：Linux 上"托盘存在但不可见"时隐藏窗口等于把应用变成不可达进程。
  win.on('close', (event) => {
    if (quitting || HEADLESS) return
    if (readSettings().minimizeToTray !== false && trayUsable) {
      event.preventDefault()
      win.hide()
      log('最小化到托盘，宿主保持运行')
    }
  })
  // 装载之前先清旧的宿主认证 cookie：不清会越堆越多，最终让宿主对主文档回 431（黑窗口）。
  // pruneAuthCookies 自己吞异常，永远不会 reject。
  await pruneAuthCookies()
  // 这里不等宿主就绪：没就绪就先装自包含的启动页（file://，不依赖 admin 服务），
  // 就绪后由 main() 调 win.loadURL(readyUrl) 切到真实页面。宿主启动要 10~16 秒，不能空屏等。
  if (readyUrl) win.loadURL(readyUrl)
  else win.loadURL(pathToFileURL(SPLASH_HTML).href).catch((e) => log(`启动页装载失败：${e && e.message}`))
  // 立刻显示：启动页是本地文件，几乎瞬时可绘，先 show() 出来（见 main() 的启动顺序）。
  if (!HEADLESS) { try { win.show() } catch { /* 已销毁 */ } }
  // 拦截一切非本应用 origin 的导航与 window.open
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url) // 外链交给默认浏览器，绝不进壳内
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    // webPort 必须在事件里现读：窗口建在 bootHost() 之前，注册时它还是 0，写死会把切页导航也拦掉。
    if (!webPort) return
    if (!url.startsWith(`http://127.0.0.1:${webPort}`)) event.preventDefault()
  })
  if (!DEV) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const k = input.key.toLowerCase()
      if (k === 'f12' || (input.control && (k === 'i' || k === 'j'))) event.preventDefault()
    })
  }
}

// ---------- host 生命周期（模式 B） ----------
const MAX_RESTARTS = 3
let bootSeq = 0 // 每次 boot 递增；旧一轮的退出事件/就绪探测结果据此丢弃

async function bootHost() {
  const seq = ++bootSeq
  // 同一 DSH_HOME 已有活着的 host → 复用（两个宿主并发写会话日志会撞 seq，历史永久损坏）
  const existing = await findExistingHostUrl()
  if (existing) {
    webPort = Number(new URL(existing).port) || 0
    readyUrl = existing
    writeState({ webPort, webUrl: readyUrl, ready: true, reused: true })
    log(`复用已有 dsh host（DSH_HOME 已被占用）: ${existing}`)
    return
  }
  // 本壳独占该 DSH_HOME：先修"非计划关机/历史损坏"留下的坏日志，保证会话读取器能启动
  // （有其他 host 在跑时绝不碰这些文件）
  const repaired = repairSessionLogs(HOME, (msg) => log(msg))
  if (repaired.truncated || repaired.reencoded || repaired.quarantined) {
    log(`repair: 截断 ${repaired.truncated} / 重编码 ${repaired.reencoded} / 隔离 ${repaired.quarantined}`)
  }
  const port = await freePort()
  log(`boot: dsh web --host 127.0.0.1 --port ${port}`)
  log(`home: ${HOME}\nws:   ${WS}`)
  hostProc = startHost({
    bin: dshBin(), home: HOME, ws: WS, port, patchFile: patchFile(), logFile: HOST_LOG,
    stderrLogFile: HOST_ERR_LOG,
    // 宿主启动前就能判定的环境问题（preflight 结果）一并带进宿主进程日志，便于事后对齐
    extraEnv: preflightEnvOverrides(),
  })
  if (hostProc.dshStdioDegraded) {
    log(`注意：管道 stdio 被系统拒绝（${hostProc.dshStdioDegradeReason || '受限会话'}），已退化为 fd 直通——宿主仍可运行，但崩溃时的"最后遗言"不可用`)
  }
  log(`host pid=${hostProc.pid} stdio=${hostProc.dshStdioMode} logFile=${HOST_LOG}`)
  hostProc.on('exit', (code) => {
    releaseHostLockIfOurs(hostProc.pid)
    if (quitting || seq !== bootSeq) return
    if (code === 3) {
      // 同一 DSH_HOME 已有实例（code=3）；重启流程会经 findExistingHostUrl 复用锁持有者。
      log('host 退出 (code=3：同一 DSH_HOME 已有实例)，重启流程将复用已有 host')
    } else {
      // 带上宿主日志尾巴 + 最后遗言：宿主"启动即退出"的真因只在它自己的 stderr 里，只报 code 没用。
      const last = hostRingTail()
      const tail = code === 0 ? '' : `；宿主日志尾部：${hostLogTail() || '（空）'}`
      log(`host 退出 (code=${code})${last === '' ? '' : `；最后遗言：${last}`}${tail}`)
      if (code !== 0 && preflightFailed.length > 0) {
        log(`  ↑ 另外 preflight 已发现 ${preflightFailed.length} 项环境问题：${preflightFailed.map((f) => f.name).join(' / ')}`)
      }
    }
    const clue = hostRingTail(2, 220)
    const hint = clue !== ''
      ? `真因（宿主最后输出）：${clue}`
      : (preflightFailed.length > 0 ? `疑似环境问题：${preflightFailed[0].detail}` : `宿主未输出任何错误——请运行 \`${CLI_HINT} --diag\` 一键取证`)
    const n = new Notification({ title: 'DSH 宿主意外退出', body: `exit code=${code}，正在自动重启宿主。\n${hint}` })
    n.on('click', () => restartHost())
    n.show()
    restartHost()
  })
  // logFile 必须传：DSH 0.1.5+ 的根 URL 带进程级 token，只在宿主 stdout 里（见 host.mjs）。
  const url = await waitReady(port, 30000, { logFile: HOST_LOG }).catch((e) => {
    if (seq !== bootSeq) return null // 已被新一轮 boot 取代，丢弃旧探测
    throw e
  })
  // url === null 表示本次探测已被新一轮 boot 取代；但绝不能静默返回 null —— 调用方会拿它去
  // loadURL 报一句与真因无关的错，而且换树回滚只在 bootHost 抛错时触发（返回 null 不触发）。
  if (url === null) throw new Error(`宿主未取得可加载 URL（就绪探测已被重启取代）；宿主日志尾部：${hostLogTail() || '（空）'}`)
  webPort = port
  readyUrl = url
  writeHostLock(hostProc.pid, port) // 就绪后补写锁（含端口），供后续窗口/实例探测复用
  writeState({ webPort, webUrl: readyUrl, ready: true })
  log(`ready: ${readyUrl}`)
}

// 手动重启宿主（托盘「重启宿主」与 POST /api/restart-host 共用）。与崩溃自动重启的区别：
// 优雅停（等会话日志静止，避免留半个 zstd 帧）+ 重置 restarts 计数 + 返回结构化结果供断言。
let manualRestarting = false
// 清掉回环地址上的 DSH 认证 cookie：cookie 不区分端口，宿主每次换端口都会新签一个，堆到请求头
// 超限时宿主对主文档回 431（渲染器只拿到空文档）。认领新 token 时会重签，整片清掉是安全的。
// @returns {Promise<{ok:boolean, removed?:number, why?:string}>}
async function pruneAuthCookies() {
  try {
    const ses = session.defaultSession
    const cookies = await ses.cookies.get({})
    const mine = cookies.filter((c) => /dsh-auth/i.test(c.name) && (c.domain === '127.0.0.1' || c.domain === 'localhost'))
    await Promise.all(mine.map((c) => ses.cookies.remove(`http://${c.domain}${c.path}`, c.name).catch(() => undefined)))
    if (mine.length > 0) log(`已清理旧的宿主认证 cookie ${mine.length} 条（避免请求头超限触发 431）`)
    return { ok: true, removed: mine.length }
  } catch (e) {
    log(`清理认证 cookie 失败（不影响启动）：${e && e.message}`)
    return { ok: false, why: String(e && e.message) }
  }
}

async function restartHostManual() {
  if (quitting) return { ok: false, error: '正在退出' }
  if (manualRestarting) return { ok: false, error: '已有重启在进行' }
  manualRestarting = true
  try {
    log('手动重启宿主：优雅停旧宿主 → 重新拉起 → 重载窗口')
    if (hostProc) {
      try { await stopHostGracefully(hostProc, HOME) } catch (e) { log(`停宿主失败: ${e.message}`) }
      releaseHostLockIfOurs(hostProc.pid)
      hostProc = null
    }
    restarts = 0
    readyUrl = null
    // 重启期间把窗口切回启动页：否则旧页面会顶着一个已经死掉的宿主，看着像卡住（~16 秒）
    if (win && !win.isDestroyed()) win.loadURL(pathToFileURL(SPLASH_HTML).href).catch(() => { /* 忽略 */ })
    await bootHost()
    if (win && !win.isDestroyed() && readyUrl) { await pruneAuthCookies(); win.loadURL(readyUrl) }
    return { ok: true, webUrl: readyUrl || '', webPort }
  } catch (e) {
    log(`手动重启失败: ${e.message}`)
    return { ok: false, error: e.message }
  } finally { manualRestarting = false }
}

async function restartHost() {
  if (quitting) return
  if (restarts >= MAX_RESTARTS) {
    log(`host 连续重启 ${MAX_RESTARTS} 次仍失败，停止自动重启`)
    try {
      const n = new Notification({ title: APP_NAME, body: 'DSH 宿主连续崩溃，已停止自动重启，请查看日志。' })
      n.show()
    } catch { /* 通知失败不影响退出 */ }
    cleanup(1)
    return
  }
  restarts++
  log(`host 重启 (第 ${restarts} 次)`)
  try {
    if (hostProc) { killTree(hostProc.pid); releaseHostLockIfOurs(hostProc.pid) }
    readyUrl = null
    await bootHost()
    if (win && !win.isDestroyed()) win.loadURL(readyUrl)
  } catch (e) {
    log(`host 重启失败: ${e.message}`)
    cleanup(1)
  }
}

// ---------- 全局 dsh host 复用（多壳窗口共用同一 host，防并发写会话日志） ----------
// 同一 DSH_HOME 必须只有一个 dsh web 进程（并发写会话日志会 seq 撞号、历史永久损坏）。
// 自起就绪后写 $DSH_HOME/.dsh-host.lock（含端口），启动前探测已有 host 并复用（netstat/ss/lsof）。
const DEFAULT_WEB_PORT = 3080

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

// 某 pid 正在 LISTEN 的 TCP 端口（Windows: netstat；Linux: ss 优先、lsof 兜底；macOS: lsof）。
function listeningPortsOf(pid) {
  const ports = new Set()
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true })
      for (const line of (r.stdout || '').split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue
        const parts = line.trim().split(/\s+/)
        if (parts.length < 5) continue
        if (Number(parts[parts.length - 1]) !== pid) continue
        const m = /:(\d{1,5})$/.exec(parts[1] || '')
        if (m) ports.add(Number(m[1]))
      }
      return ports
    }
    // Linux：ss -ltnpH 输出形如 `LISTEN 0 511 127.0.0.1:3080 0.0.0.0:* users:(("node",pid=1234,fd=20))`
    if (process.platform === 'linux') {
      const r = spawnSync('ss', ['-ltnpH'], { encoding: 'utf8' })
      if (r.status === 0) {
        for (const line of (r.stdout || '').split(/\r?\n/)) {
          const m = /pid=(\d+)/.exec(line)
          if (m === null || Number(m[1]) !== pid) continue
          const p = /[:.](\d{1,5})\s/.exec(line)
          if (p) ports.add(Number(p[1]))
        }
        if (ports.size > 0) return ports
      }
    }
    // macOS 与 Linux 兜底：lsof -nP -iTCP -sTCP:LISTEN（第 2 列即 pid，第 9 列形如 127.0.0.1:3080）
    const r = spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' })
    if (r.status === 0) {
      for (const line of (r.stdout || '').split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/)
        if (cols.length < 9) continue
        if (Number(cols[1]) !== pid) continue
        const m = /[:.](\d{1,5})$/.exec(cols[8])
        if (m) ports.add(Number(m[1]))
      }
    }
    // 走到这里说明三平台工具都没给出结果：返回空集，调用方会退回"只信锁里的端口 + 默认端口"
  } catch { /* 系统工具都不可用则跳过（复用退化为只信锁里的端口） */ }
  return ports
}

// 真 dsh web 宿主判定：宿主 index 注入 window.__DSH_BOOT__（Vite/普通 HTTP 服务没有）
async function probeHost(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return false
    return (await res.text()).includes('__DSH_BOOT__')
  } catch { return false }
}

// 候选端口：锁内 port → 锁持有者的 netstat 监听端口 → 上次 state.webPort → 默认 3080
function candidatePorts(lock) {
  const ports = new Set()
  if (Number.isInteger(lock?.port) && lock.port > 0) ports.add(lock.port)
  if (lock && pidAlive(lock.pid)) for (const p of listeningPortsOf(lock.pid)) ports.add(p)
  const st = readState()
  if (Number.isInteger(st.webPort) && st.webPort > 0) ports.add(st.webPort)
  ports.add(DEFAULT_WEB_PORT)
  return ports
}

async function probeCandidates(ports, rounds = 3, gapMs = 500) {
  const list = [...ports].filter((p) => Number.isInteger(p) && p > 0 && p < 65536)
  for (let round = 0; round < rounds; round++) {
    for (const port of list) {
      const url = `http://127.0.0.1:${port}/`
      if (await probeHost(url)) return url
    }
    if (round < rounds - 1) await new Promise((r) => setTimeout(r, gapMs))
  }
  return null
}

function readHostLock() {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(HOME, '.dsh-host.lock'), 'utf8'))
    return lock && Number.isSafeInteger(lock.pid) ? lock : null
  } catch { return null }
}

function writeHostLock(pid, port) {
  try {
    fs.writeFileSync(path.join(HOME, '.dsh-host.lock'),
      JSON.stringify({ pid, port, home: HOME, startedAt: Date.now() }))
  } catch { /* 锁写入失败不阻断启动 */ }
}

function releaseHostLockIfOurs(pid) {
  if (!pid) return
  const lock = readHostLock()
  if (lock && lock.pid === pid) {
    try { fs.unlinkSync(path.join(HOME, '.dsh-host.lock')) } catch { /* 已删 */ }
  }
}

// 只采纳"本 DSH_HOME 的锁"指向的宿主：HTTP 面无法验证对方 DSH_HOME，错接其他 home 的宿主更糟。
async function findExistingHostUrl() {
  const lock = readHostLock()
  if (lock && pidAlive(lock.pid)) {
    const reused = await probeCandidates(candidatePorts(lock))
    if (reused) return reused
  } else if (lock) {
    releaseHostLockIfOurs(lock.pid) // 陈旧锁（持有者已退出）→ 删除，避免误判
  }
  return null
}

// ---------- 市场（catalog + 安装） ----------
// 目录数据由壳供给（不让渲染进程直连 GitHub）：壳已有出站 HTTPS 路径，且"下载 → 校验 → 落盘 →
// 挂载 → 重启宿主"只能在 Node 侧做。目录来源两级：$DSH_HOME/market/catalog.json > 随包样例。
const MARKET_CATALOG_USER = path.join(HOME, 'market', 'catalog.json')

// 读目录。任一字段不合法就整条丢弃并计数，不让坏数据流到界面上（坏 URL 会变成"点了没反应"）。
// @returns {{ok:boolean, schema?:number, updatedAt?:string, source?:string, plugins?:object[], themes?:object[],
//            dropped?:number, error?:string}}
function readMarketCatalog() {
  const readOne = (p) => {
    try {
      const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
      const j = JSON.parse(raw)
      return j && typeof j === 'object' ? j : null
    } catch { return null }
  }
  let data = readOne(MARKET_CATALOG_USER)
  let source = 'user'
  if (data === null) {
    data = readOne(path.join(RES, 'market-catalog.json'))
    source = 'bundled'
  }
  if (data === null) return { ok: false, error: '市场目录不可读' }
  const isText = (v) => typeof v === 'string' && v.trim() !== ''
  const isHttps = (v) => isText(v) && /^https:\/\//i.test(v)
  let dropped = 0
  const clean = (list, kind) => {
    if (!Array.isArray(list)) return []
    const out = []
    const seen = new Set()
    for (const e of list) {
      // 硬判据（缺一即丢）：id / name / source(https) 必须有，id 不许重复；sha256 允许为空。
      if (!e || typeof e !== 'object') { dropped++; continue }
      if (!isText(e.id) || !isText(e.name) || !isHttps(e.source) || seen.has(e.id)) { dropped++; continue }
      const dl = e.download && typeof e.download === 'object' ? e.download : {}
      // download 可选：缺了 = 还没挂下载资产；给了就必须是空串或 https（http 途中可被替换）。
      const dlUrl = dl.url === undefined ? '' : dl.url
      if (typeof dlUrl !== 'string' || (dlUrl !== '' && !isHttps(dlUrl))) { dropped++; continue }
      const dlSha = dl.sha256 === undefined ? '' : dl.sha256
      if (typeof dlSha !== 'string' || (dlSha !== '' && !/^[0-9a-f]{64}$/i.test(dlSha))) { dropped++; continue }
      seen.add(e.id)
      // install：spec 是喂给 dsh plugin add 的安装坐标（必须由维护者显式给出，形状校验在
      // market-install-official.mjs）；steps 是给人看的说明文字（install 为字符串时当作 steps）。
      const installObj = e.install && typeof e.install === 'object' ? e.install : {}
      const installSpec = isText(installObj.spec) ? installObj.spec : ''
      const installSteps = isText(typeof e.install === 'string' ? e.install : installObj.steps)
        ? (typeof e.install === 'string' ? e.install : installObj.steps)
        : ''
      // reviewed / disclosure：审核结论与必须披露项，只做形状收敛，不做语义解释或自动判定。
      const rev = e.reviewed && typeof e.reviewed === 'object' ? e.reviewed : {}
      const disc = e.disclosure && typeof e.disclosure === 'object' ? e.disclosure : {}
      const strList = (v) => (Array.isArray(v) ? v.filter(isText).slice(0, 10) : [])
      out.push({
        id: e.id, name: e.name,
        summary: isText(e.summary) ? e.summary : '',
        author: isText(e.author) ? e.author : '',
        icon: isText(e.icon) ? e.icon : (kind === 'themes' ? '🎨' : '📦'),
        source: e.source,
        homepage: isHttps(e.homepage) ? e.homepage : '',
        version: isText(e.version) ? e.version : '',
        install: { spec: installSpec, steps: installSteps },
        reviewed: isText(rev.at)
          ? {
            at: rev.at,
            verdict: isText(rev.verdict) ? rev.verdict : '',
            spec: isText(rev.spec) ? rev.spec : '',
            record: isText(rev.record) ? rev.record : '',
          }
          : null,
        disclosure: { notes: strList(disc.notes), warnings: strList(disc.warnings) },
        // 下载地址应当指向 tag 或 commit（不是分支）：分支 HEAD 会变，会出现"审的是 A、下到的是 B"。
        immutable: e.download && e.download.immutable === true,
        tags: Array.isArray(e.tags) ? e.tags.filter(isText).slice(0, 6) : [],
        download: { url: dlUrl, sha256: dlSha, bytes: Number.isFinite(dl.bytes) ? dl.bytes : 0 },
      })
    }
    return out
  }
  return {
    ok: true,
    schema: Number.isFinite(data.schema) ? data.schema : 0,
    updatedAt: isText(data.updatedAt) ? data.updatedAt : '',
    source,
    plugins: clean(data.plugins, 'plugins'),
    themes: clean(data.themes, 'themes'),
    dropped,
  }
}

// 下载一条目 = 把下载地址交给系统（默认浏览器/下载器）：壳不落盘、不安装，是否让第三方代码
// 进入用户机器 100% 由用户决定。只放行 https（openExternal 会交给系统默认处理程序，放行
// http/file/自定义协议等于把任意协议交给外部程序）。返回值带上 url 供界面显示。
async function marketOpenDownload(entryId) {
  const cat = readMarketCatalog()
  if (!cat.ok) return { ok: false, error: cat.error }
  const all = [...(cat.plugins || []), ...(cat.themes || [])]
  const entry = all.find((e) => e.id === entryId)
  if (!entry) return { ok: false, error: `目录里没有 id=${entryId} 的条目` }
  const url = entry.download && entry.download.url ? entry.download.url : ''
  if (url === '') return { ok: false, error: `「${entry.name}」还没有下载地址（该条目没挂下载包）` }
  if (!/^https:\/\//i.test(url)) return { ok: false, error: `拒绝打开非 https 地址：${url}` }
  if (SMOKE || HEADLESS) return { ok: true, url, note: 'headless/smoke 不真的打开外部程序' }
  try {
    await shell.openExternal(url)
    log(`market: 已把下载地址交给系统打开 ${entry.id} → ${url}`)
    return { ok: true, url, note: '已交给系统默认下载方式' }
  } catch (e) {
    return { ok: false, error: `打开下载地址失败：${e.message}` }
  }
}

// 市场安装一条目：走官方机制（dsh plugin --profile web add <spec>），只把审核过的包坐标喂给它。
// 官方机制会解析依赖、锁版本并自动写 dsh.profile.bundles；自建解包对真实插件基本装不起来。
// 坐标来自目录条目的 install.spec，必须显式给出（猜坐标等于放弃"审核过的那一份"）。
let marketInstalling = false
async function marketInstall(entryId) {
  if (marketInstalling) return { ok: false, error: '已有一次安装正在进行，请等它结束' }
  const cat = readMarketCatalog()
  if (!cat.ok) return { ok: false, error: cat.error }
  const entry = [...(cat.plugins || []), ...(cat.themes || [])].find((e) => e.id === entryId)
  if (!entry) return { ok: false, error: `目录里没有 id=${entryId} 的条目` }
  if (SMOKE || HEADLESS) return { ok: false, error: 'headless/smoke 模式不执行安装' }

  marketInstalling = true
  try {
    // pnpm 目录要注入子进程 PATH：官方 dsh plugin add 内部靠子进程 PATH 找 pnpm，
    // 不注入会把失败从"体检说缺"推迟到"安装时退出码 127"。
    const pnpmEnv = envWithPnpmOnPath({
      pnpmPath: pnpmStatus().path,
      nodePath: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: HOME },
    }).env
    const r = installMarketEntryOfficial(entry, {
      bin: dshBin(),
      profile: PROFILE_NAME,
      profileDir: PROFILE_DIR,
      // 子进程用 Electron 自己的 Node（本机没有系统 node 时也能跑），并保持 RUN_AS_NODE
      runtime: process.execPath,
      spawnSync,
      env: pnpmEnv,
      // 与市场体检**共用同一份解析结果**，避免"体检说缺、其实在别处"
      pnpm: pnpmStatus(),
      log,
    })
    if (r.ok) log(`market: 已安装 ${entry.id}（${r.spec}）→ profile ${PROFILE_NAME}；需重启宿主生效`)
    else log(`market: 安装 ${entry.id} 失败于 ${r.stage}：${r.error}`)
    return r
  } finally {
    marketInstalling = false
  }
}

// pnpm 的解析结果（启动后解析一次即缓存；用户装完 pnpm 需重启应用生效）：先按绝对路径候选找并
// 用 node <pnpm.cjs> 直调，再退回按 PATH 探（壳进程的 PATH 常不含用户级 npm 全局目录）。
// @returns {{ok:boolean, version:string, how:string, detail:string, path:string, prepended:string[]}}
let pnpmCache = null
function pnpmStatus() {
  if (pnpmCache !== null) return pnpmCache
  const candidates = pnpmCandidates({ npmCandidates: npmCandidates(), env: process.env })
  const r = resolvePnpm({ spawnSync, nodePath: process.execPath, candidates, env: process.env })
  const injected = r.ok
    ? envWithPnpmOnPath({ pnpmPath: r.path, nodePath: process.execPath, env: process.env }).prepended
    : []
  pnpmCache = { ...r, prepended: injected }
  log(`pnpm 解析：${r.ok ? `ok ${r.version}（${r.how}）` : '未找到'}；候选 ${candidates.length} 条，PATH 前缀注入 ${injected.length} 条`)
  if (!r.ok) log(`pnpm 解析失败原因：${r.detail}`)
  return pnpmCache
}

function pnpmDiagnostics() {
  const p = pnpmStatus()
  return {
    ok: p.ok,
    version: p.version,
    how: p.how,
    path: p.path,
    detail: p.detail,
    pathPrepended: p.prepended || [],
    candidates: pnpmCandidates({ npmCandidates: npmCandidates(), env: process.env }),
    npmCli: findNpm(),
    node: process.execPath,
    pathEntries: String(process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter((x) => x !== ''),
  }
}

// 安装前置体检：pnpm 在不在。官方 CLI 硬依赖 pnpm（缺它退出码 127，且不告诉用户怎么装），
// 所以界面提前显示"要先装 pnpm"。这里只探测，不自动装（改用户环境要他自己点头）。
function marketPreflight() {
  const p = pnpmStatus()
  return {
    ok: true,
    profile: PROFILE_NAME,
    pnpm: p.ok,
    pnpmVersion: p.ok ? (p.version || p.detail) : '',
    pnpmDetail: p.ok ? '' : p.detail,
    // 带上"从哪里找到的"：排障时"说缺 pnpm"与"在哪儿找到的"是同一件事的两面
    pnpmHow: p.ok ? p.how : '',
    pnpmPath: p.ok ? p.path : '',
    hint: p.ok ? '' : pnpmHint(),
  }
}

// ---------- 【临时排障】量市场弹窗的真实几何 ----------
// 只读 computed style 与 getBoundingClientRect，不改 DOM、不点任何东西；定位完即删。
async function diagMarketGeom() {
  if (!win || win.isDestroyed()) return { ok: false, error: 'no window' }
  const script = `(() => {
    const out = { viewport: [innerWidth, innerHeight, devicePixelRatio] }
    const R = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }
    const pick = (sel) => document.querySelector(sel)
    const info = (el, label) => {
      if (!el) return null
      const cs = getComputedStyle(el)
      return { label, rect: R(el), display: cs.display, flexDirection: cs.flexDirection, alignItems: cs.alignItems,
        width: cs.width, maxWidth: cs.maxWidth, minWidth: cs.minWidth, padding: cs.padding, gap: cs.gap,
        overflow: cs.overflow, gridTemplateColumns: cs.gridTemplateColumns }
    }
    out.styleTagCount = document.querySelectorAll('style[data-plugin="dsh-market"]').length
    out.dialogAnyCount = document.querySelectorAll('[role="dialog"]').length
    out.myDialog = !!pick('.dsh-market-dialog')
    out.probe = []
    out.probe.push(info(pick('.dsh-market-dialog'), 'myDialog'))
    out.probe.push(info(pick('.dsh-market-scope'), 'myScope'))
    const dlg = pick('.dsh-market-dialog')
    if (dlg) {
      const kids = Array.from(dlg.children)
      out.dialogChildCount = kids.length
      out.dialogChildren = kids.map((k, i) => info(k, 'dlgKid' + i + ':' + k.tagName + '.' + (k.className || '')))
      for (const k of kids) {
        if (getComputedStyle(k).display === 'contents') {
          out.contentsChildren = Array.from(k.children).map((c, i) => info(c, 'scopeKid' + i + ':' + c.tagName))
        }
      }
    }
    const pres = Array.from(document.querySelectorAll('.dsh-market-dialog pre'))
    out.pres = pres.slice(0, 2).map((p, i) => info(p, 'pre' + i))
    if (pres[0]) {
      const chain = []
      let el = pres[0]
      for (let i = 0; i < 8 && el && el !== document.body; i++) { chain.push(info(el, 'ancestor' + i + ':' + el.tagName + '.' + (el.className || ''))); el = el.parentElement }
      out.preAncestors = chain
    }
    return out
  })()`
  try { return await win.webContents.executeJavaScript(script, true) } catch (e) { return { ok: false, error: String(e.message) } }
}

// ---------- admin actions ----------
// 把主窗口"抬到前台"（还原 → 显示 → 置顶 → 聚焦），托盘双击/单实例/--focus 共用：最小化的窗口
// show/focus 都作用不到，Windows 又有前台锁，所以逐级加码。note 是既有契约：smoke 断言 headless
// 档必须回 ok:true + 原文案（别改动它）。
// @returns {{ok:boolean, note:string}} 是否已处置，以及用了哪一档
function surfaceWindow() {
  if (HEADLESS || SMOKE) return { ok: true, note: 'headless（不拉起窗口）' }
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    // 关到托盘后 isVisible() 为 false：单实例请求必须把窗口重新显示出来，否则像没反应。
    if (!win.isVisible()) win.show()
    // alwaysOnTop 一档：Windows 的前台锁会让普通 focus() 被静默忽略；用完立即恢复 false。
    try { win.setAlwaysOnTop(true) } catch { /* 个别平台/WM 不支持 */ }
    try { win.moveTop() } catch { /* 同上 */ }
    try { win.focus() } catch { /* 同上 */ }
    try { app.focus({ steal: true }) } catch { /* 同上 */ }
    try { win.setAlwaysOnTop(false) } catch { /* 同上 */ }
    try { win.webContents.focus() } catch { /* 渲染器可能还没就绪 */ }
    return { ok: true, note: 'raised（restore+show+top+focus）' }
  }
  if (readyUrl) { void createWindow(); return { ok: true, note: 'relaunch（窗口已销毁，按宿主地址重建）' } }
  return { ok: false, note: 'host 尚未就绪' }
}
async function focusAction() {
  return surfaceWindow()
}
// 诊断：列出窗口里"不透明背景"的元素（默认只看视口底部 25%），用于定位壁纸/皮肤的遮挡层。只读。
async function diagOpaqueLayers(region = 'bottom') {
  if (!win || win.isDestroyed()) return { ok: false, error: 'no window' }
  const cond = region === 'all' ? 'true' : 'r.bottom >= vh * 0.75'
  const script = `(() => {
    const vw = innerWidth, vh = innerHeight
    const out = []
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width < 20 || r.height < 4) continue
      if (!(${cond})) continue
      const cs = getComputedStyle(el)
      const bg = cs.backgroundColor
      const opaque = bg && bg !== 'rgba(0, 0, 0, 0)' && !/, 0\\)$/.test(bg)
      const bi = cs.backgroundImage !== 'none' ? cs.backgroundImage.slice(0, 50) : ''
      if (!opaque && !bi) continue
      out.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 70), bg, bgImage: bi,
                 rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] })
    }
    return { ok: true, viewport: [vw, vh, devicePixelRatio], count: out.length, layers: out.slice(0, 80) }
  })()`
  try { return await win.webContents.executeJavaScript(script, true) } catch (e) { return { ok: false, error: String(e.message) } }
}

async function diagUi() {
  if (!win || win.isDestroyed()) return { ok: false, error: 'no window' }
  const script = `(() => {
    const vw = innerWidth, vh = innerHeight
    const R = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }
    const C = (el) => String(el.className || '').slice(0, 90)
    const all = document.querySelectorAll('*')

    // ① 可滚动容器（右侧滚动条的宿主）：overflow-y 可滚 + 确有溢出；顺带量出滚动条占的沟槽宽度
    const scrollers = []
    for (const el of all) {
      const cs = getComputedStyle(el)
      if (!/auto|scroll/.test(cs.overflowY)) continue
      const r = el.getBoundingClientRect()
      if (r.width < 30 || r.height < 30) continue
      const gutter = el.offsetWidth - el.clientWidth
      if (el.scrollHeight <= el.clientHeight + 2 && gutter <= 0) continue
      scrollers.push({ tag: el.tagName, cls: C(el), rect: R(el), overflowY: cs.overflowY,
        gutter, scrollH: el.scrollHeight, clientH: el.clientHeight,
        sbWidth: cs.scrollbarWidth, sbColor: cs.scrollbarColor })
    }

    // ② 拖动条（resize 光标 / separator 角色 / data-*-resize* 属性）
    const handles = []
    for (const el of all) {
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      if (r.width + r.height < 2) continue
      const attrs = el.getAttributeNames ? el.getAttributeNames() : []
      const attrHit = attrs.filter((n) => /resize|separator|splitter/i.test(n))
      const hit = /resize/.test(cs.cursor) || el.getAttribute('role') === 'separator' || attrHit.length > 0
      if (!hit) continue
      handles.push({ tag: el.tagName, cls: C(el), role: el.getAttribute('role') || '',
        cursor: cs.cursor, attrs: attrHit.slice(0, 4), rect: R(el) })
    }

    // ③ 右侧竖长条候选（"定位文本的多条状跳转小组件"）：落在视口右 22% 内、够高、够窄
    const rails = []
    for (const el of all) {
      const r = el.getBoundingClientRect()
      if (r.width < 4 || r.width > vw * 0.18) continue
      if (r.height < vh * 0.2) continue
      if (r.left < vw * 0.78) continue
      rails.push({ tag: el.tagName, cls: C(el), rect: R(el), childCount: el.children.length,
        kidTags: [...el.children].slice(0, 12).map((k) => k.tagName + '.' + String(k.className || '').slice(0, 26)),
        kidRects: [...el.children].slice(0, 12).map(R) })
    }

    // ④ 底部按钮（找 composer 的「+」）
    const bottomBtns = []
    for (const el of document.querySelectorAll('button,[role="button"],[aria-haspopup]')) {
      const r = el.getBoundingClientRect()
      if (r.top < vh * 0.55 || r.width < 8 || r.height < 8) continue
      bottomBtns.push({ tag: el.tagName, cls: C(el), text: (el.textContent || '').trim().slice(0, 24),
        aria: el.getAttribute('aria-label') || '', title: el.getAttribute('title') || '',
        haspopup: el.getAttribute('aria-haspopup') || '', rect: R(el) })
    }

    return { ok: true, viewport: [vw, vh, devicePixelRatio],
      scrollerCount: scrollers.length, scrollers: scrollers.slice(0, 16),
      handleCount: handles.length, handles: handles.slice(0, 16),
      railCount: rails.length, rails: rails.slice(0, 25),
      bottomBtnCount: bottomBtns.length, bottomBtns: bottomBtns.slice(0, 30) }
  })()`
  try { return await win.webContents.executeJavaScript(script, true) } catch (e) { return { ok: false, error: String(e.message) } }
}

// 重载窗口：客户端插件按 URL 取 ESM 模块，只有 reloadIgnoringCache 才拿得到新文件
// （打包态菜单被置空，Ctrl+R 也没了）。
async function reloadWindow() {
  if (!win || win.isDestroyed()) return { ok: false, error: 'no window' }
  win.webContents.reloadIgnoringCache()
  return { ok: true }
}

function statusPayload() {
  const s = readSettings()
  const side = sidebarTuning(s)
  return {
    ok: true, name: APP_NAME, version: readVersion(), pid: process.pid,
    mode: readState().mode || 'windowed', adminPort, webPort, webUrl: readyUrl, ready: !!readyUrl,
    home: HOME, ws: WS, autostart: !!s.autostart, minimizeToTray: s.minimizeToTray !== false,
    backgroundImage: s.backgroundImage || '',
    bgBrightness: bgTuning().brightness, bgBlur: bgTuning().blur,
    railMaskOpacity: skinTuning().railMaskOpacity,
    conversationMaskOpacity: skinTuning().conversationMaskOpacity,
    skin: skinSnapshot(s),
    // 右侧栏全屏态的独立遮罩（默认 0.8，比对话区那档重）。
    fullscreenMaskOpacity: skinTuning().fullscreenMaskOpacity,
    // 左侧栏背景：模式 / 独立图片路径 / 遮罩原值（渲染用的不透明度由客户端取 max 保证不比主页面透）。
    sidebarBgMode: side.mode,
    sidebarBgImage: side.image,
    sidebarOpacity: side.opacity,
    // 图片版本号（mtime）：URL 不变时浏览器不会重新请求 background-image，缓存头也救不了。
    sidebarBgImageVersion: fileMtimeMs(side.image),
    dshBin: dshBin(), engine: 'Electron', electron: process.versions.electron, node: process.versions.node,
    pwsh: ps7Available(), restarts,
    // 托盘是否真的可用：暴露给客户端，设置页据此提示/置灰"关闭到托盘"开关。
    trayUsable,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    // DSH 更新快照内嵌：客户端已有 5 秒轮询 /api/status，更新进度复用它，不新增一条轮询。
    dshUpdate: dshUpdateSnapshot(),
  }
}

// ---------- DSH 更新 ----------
// 状态常驻主进程：构建是分钟级后台任务，UI 靠 /api/status 的 5 秒轮询读快照（只报阶段，不报百分比）。
// phase: idle | checking | building | ready | applying | failed
const dshUpdate = { phase: 'idle', error: null, current: null, latest: null, target: null, hasUpdate: false, npmOk: null, startedAt: null, finishedAt: null, lastRollback: null, progress: null }
let dshUpdateBusy = false
let dshCurrentCache = null

/** 当前已安装版本（缓存；换树与检查更新后失效重建）。 */
function dshCurrentVersions() {
  if (dshCurrentCache === null) dshCurrentCache = readCurrentVersions(path.join(VENDOR_DIR, 'profile'))
  return dshCurrentCache
}

// ---------- harness × Electron 兼容判据 ----------
// DSH 0.1.6-alpha.2 起给 Node 内部 loader 打补丁，那套补丁按精确 V8 指纹白名单放行；
// 白名单就在本机已装的 addon 二进制里，所以"跑不起来"这个结论在下载/构建之前就能算出来。
let dshAddonTableCache = null
function dshAddonTable() {
  if (dshAddonTableCache === null) {
    dshAddonTableCache = readAddonFingerprints({ addonDir: path.join(VENDOR_DIR, 'profile', 'node_modules') })
    if (!dshAddonTableCache.known) log(`[dsh-update] 兼容判据：${dshAddonTableCache.error ?? '读不到 addon 白名单'}（跳过，由启动门禁兜住）`)
  }
  return dshAddonTableCache
}

/** 目标 harness 版本的兼容性评估（廉价；结果随 v8 与 vendor 树变化，进程内缓存白名单即可）。 */
function harnessCompat(version) {
  return assessHarnessCompat({
    version,
    addon: dshAddonTable(),
    v8: process.versions.v8,
    electron: process.versions.electron,
    // 逃生口：守卫读的是本机已装那棵树的 addon，将来可能过期；硬拦 + 没出口会把用户永久卡死。
    allowUnsupported: process.env.DSH_UPDATE_ALLOW_INCOMPATIBLE === '1',
  })
}

/** 只读快照：/api/status 内嵌与 GET /api/dsh/status 共用。必须廉价（每 5 秒被调一次）。 */
function dshUpdateSnapshot() {
  const inst = dshUpdate.current ?? dshCurrentVersions()
  const pending = readPending(APP_DATA)
  if (dshUpdate.npmOk === null) dshUpdate.npmOk = findNpm() !== null
  const ver = inst['@deepseek-ai/dsh'] ?? null
  // 跨版本升级需要人显式确认，且确认动作必须能从界面给出来（只说"请带某参数"等于把 GUI 用户卡死），
  // 所以把评估结果放进快照，让客户端能渲染确认流程。
  const jump = (ver !== null && dshUpdate.target !== null) ? assessJump(ver, dshUpdate.target) : null
  const needsConfirm = jump !== null && jump.safe === false
  // 兼容性：只对"要更新的那个版本"评估；没查过更新时（target 为 null）不评估，免得对着当前版本报无关的话。
  const compatTarget = dshUpdate.target ?? dshUpdate.latest
  const compat = compatTarget === null ? null : harnessCompat(compatTarget)
  let hint
  if (dshUpdate.lastRollback !== null) hint = `上次更新失败已自动回滚（${dshUpdate.lastRollback.reason}）`
  else if (dshUpdate.phase === 'failed') hint = `上次操作失败：${dshUpdate.error ?? '未知原因'}`
  else if (dshUpdate.phase === 'building') hint = `正在构建 ${dshUpdate.target ?? ''}（分钟级，请勿关闭应用）`
  else if (dshUpdate.phase === 'ready') hint = `已构建完成，重启应用后生效（${dshUpdate.target ?? ''}）`
  else if (pending !== null) hint = `有待应用的更新 ${pending.target}（重启应用生效）`
  else if (!dshUpdate.npmOk) hint = '未找到系统 Node.js（本应用不内置 npm），更新功能不可用'
  else if (dshUpdate.latest === null) hint = `已安装 ${ver ?? '未知'}（点“检查更新”查询最新版）`
  else if (dshUpdate.hasUpdate && compat !== null && compat.blocked) hint = `可更新到 ${dshUpdate.target}，但当前壳跑不起来它：${compat.reason}`
  else if (dshUpdate.hasUpdate && compat !== null && compat.warn) hint = `可更新到 ${dshUpdate.target}（注意：${compat.reason}）`
  else if (dshUpdate.hasUpdate) hint = needsConfirm
    ? `可更新到 ${dshUpdate.target}，但属于跨版本升级（${jump.reason}）——点“更新（跨版本）”后会先请你确认`
    : `可更新到 ${dshUpdate.target}（当前 ${ver ?? '未知'}）`
  else hint = `已是最新（${ver ?? '未知'}）`
  return {
    ok: true,
    phase: dshUpdate.phase,
    error: dshUpdate.error,
    current: ver,
    installed: inst,
    latest: dshUpdate.latest,
    target: dshUpdate.target,
    hasUpdate: dshUpdate.hasUpdate,
    npmOk: dshUpdate.npmOk,
    pending: pending !== null,
    pendingTarget: pending?.target ?? null,
    startedAt: dshUpdate.startedAt,
    finishedAt: dshUpdate.finishedAt,
    lastRollback: dshUpdate.lastRollback,
    jump,
    needsConfirm,
    // 兼容性快照：blocked=true 表示目标版本在本机 Electron 上确定跑不起来，客户端据此禁用更新按钮。
    compat,
    // 进度：step/label 说明"现在在做什么"，percent 只是大致刻度，elapsedMs 才是用户真正等的那个数。
    progress: dshUpdate.progress,
    elapsedMs: dshUpdate.startedAt === null
      ? null
      : (dshUpdate.finishedAt !== null ? Date.parse(dshUpdate.finishedAt) : Date.now()) - Date.parse(dshUpdate.startedAt),
    hint,
  }
}

// ────────────────────────── 平面 C：按 GitHub 仓库文件热更新 ──────────────────────────
// 三个更新平面刻意分开：A「DSH 更新」换 harness 依赖树；B「检查更新」换整个安装包；
// C「从仓库更新功能」按 components.json 补/换功能文件（自带插件、补丁层、市场目录、壳源码），
// 不用重装、宿主重启即生效。坐标从 app-update.yml 读，开发态退回默认值。

/** 仓库坐标。ref 默认 `main`（用户口径："按 main 分支最新文件"）；`DSH_REPO_REF` 可临时改（排障/试验）。 */
function repoCoords() {
  let owner = DEFAULT_COORDS.owner
  let repo = DEFAULT_COORDS.repo
  try {
    const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8')
    owner = /^owner:\s*(.+)$/m.exec(yml)?.[1]?.trim() ?? owner
    repo = /^repo:\s*(.+)$/m.exec(yml)?.[1]?.trim() ?? repo
  } catch { /* 开发态没有 app-update.yml：用默认坐标 */ }
  return { owner, repo, ref: process.env.DSH_REPO_REF ?? DEFAULT_COORDS.ref }
}

/** 组件的"随包副本目录"（账本里要记它的摘要，见 shouldKeepHotUpdated）。非插件组件返回 null。 */
function bundledDirOfComponent(id) {
  if (!PROFILE_PLUGIN_NAMES.includes(id)) return null
  const src = pluginSourceDir(id)
  return fs.existsSync(path.join(src, 'package.json')) ? src : null
}

/** 联网比对：仓库清单 vs 本地文件。**只读**，不落盘。 */
async function repoUpdateCheck() {
  const coords = repoCoords()
  const r = await runRepoUpdate({ home: HOME, coords, profileName: PROFILE_NAME, dryRun: true, log })
  if (r.plan === null) return { ok: false, error: r.error ?? '清单不可用', coords: `${coords.owner}/${coords.repo}@${coords.ref}` }
  const components = r.plan.components.map((c) => ({
    id: c.id, title: c.title, kind: c.kind, version: c.version,
    upToDate: c.upToDate,
    missing: c.missing.length + c.changed.length,
    remove: c.remove.length,
  }))
  const s = r.plan.summary
  log(`[repo-update] 检查 ${coords.owner}/${coords.repo}@${coords.ref}：${s.update} 项待更新（缺 ${s.missingFiles} / 变 ${s.changedFiles}）`)
  return {
    ok: true,
    coords: `${coords.owner}/${coords.repo}@${coords.ref}`,
    summary: s,
    components,
    message: s.update === 0
      ? '已是最新（仓库里没有新文件）'
      : `${s.update} 项可更新：缺 ${s.missingFiles} 个文件、内容变了 ${s.changedFiles} 个`,
  }
}

/** 从仓库更新：下载 → 逐个 sha256 校验 → 原子落盘 → 写账本；动了插件就重启宿主让新功能立刻可用。 */
async function repoUpdateApply() {
  const coords = repoCoords()
  const r = await runRepoUpdate({
    home: HOME,
    coords,
    profileName: PROFILE_NAME,
    log,
    bundledDigestOf: (id, files) => {
      const dir = bundledDirOfComponent(id)
      return dir === null ? null : dirFilesDigest(dir, files)
    },
  })
  if (r.plan === null) return { ok: false, error: r.error ?? '清单不可用' }
  const failed = r.results.filter((x) => x.ok === false).map((x) => ({ id: x.id, error: x.error }))
  const done = r.results.filter((x) => x.ok === true && x.skipped !== true)
  const written = done.reduce((n, x) => n + (x.written?.length ?? 0), 0)
  const removed = done.reduce((n, x) => n + (x.removed?.length ?? 0), 0)
  const touchedPlugins = done.some((x) => PROFILE_PLUGIN_NAMES.includes(x.id) && (x.written?.length ?? 0) > 0 && x.kind !== 'shell-asar')
  // 插件半身在宿主进程里，改完文件必须重启宿主才会被加载（客户端半身靠窗口重载即可，这里一并做）。
  let restarted = false
  let restartError = null
  if (touchedPlugins) {
    const rr = await restartHostManual()
    restarted = rr.ok === true
    restartError = rr.ok === true ? null : (rr.error ?? '重启宿主失败')
    // 刻意**不**强制重载窗口：宿主重启期间界面会自己重连，而强制重载会把设置面板关掉，
    // 用户就看不到这次更新的结果了（"点了按钮界面一闪什么都没说"是最糟的反馈）。
  }
  const parts = []
  if (written > 0) parts.push(`写入 ${written} 个文件`)
  if (removed > 0) parts.push(`删除 ${removed} 个`)
  if (done.length === 0) parts.push('已是最新，无需改动')
  if (restarted) parts.push('宿主已重启')
  else if (touchedPlugins) parts.push(`宿主重启失败：${restartError}`)
  const shellPending = r.plan.components.some((c) => c.id === 'shell' && !c.upToDate)
  const swap = shellSwapReadiness()
  if (shellPending) parts.push(swap.ok ? '壳源码已下到暂存区（点「换壳并重启」生效）' : `壳源码已下到暂存区，但本机换不了壳：${swap.error}`)
  const message = parts.join('；')
  log(`[repo-update] 应用完成：${message}${failed.length > 0 ? `（失败 ${failed.length} 项）` : ''}`)
  return {
    ok: failed.length === 0 && r.ok,
    coords: `${coords.owner}/${coords.repo}@${coords.ref}`,
    written,
    removed,
    restarted,
    shellPending,
    shellCanSwap: swap.ok,
    shellReason: swap.ok ? '' : swap.error,
    results: done.map((x) => ({ id: x.id, action: x.action, written: x.written?.length ?? 0 })),
    failed,
    message,
  }
}

/** 账本快照（不联网）：界面用它显示"上次是什么时候更新的"。 */
function repoUpdateSnapshot() {
  const st = readRepoUpdateState(HOME)
  const rec = st.components?.shell
  const swap = shellSwapReadiness()
  return {
    ok: true,
    stateFile: repoUpdateStateFile(HOME),
    ref: st.ref ?? null,
    coords: st.owner !== undefined && st.repo !== undefined ? `${st.owner}/${st.repo}@${st.ref ?? '?'}` : null,
    appliedAt: st.appliedAt ?? null,
    components: Object.entries(st.components ?? {}).map(([id, v]) => ({ id, version: v.version ?? null, appliedAt: v.appliedAt ?? null, files: (v.files ?? []).length })),
    broken: st.broken ?? null,
    // 壳自身那一层：有没有下好源码、能不能换（见 shellSwapReadiness）
    shell: {
      pending: Array.isArray(rec?.files) && rec.files.length > 0,
      files: Array.isArray(rec?.files) ? rec.files.length : 0,
      canSwap: swap.ok,
      reason: swap.ok ? '' : swap.error,
    },
  }
}

// 换壳（平面 C 最后一层）：把仓库里下好的壳源码换进 app.asar 并重启应用。必须重启整个应用，
// 因为壳是主进程代码，只在进程启动时加载一次（流程：退出 → 助手换 asar 并自检 → 重新起来）。
function shellSwapReadiness() {
  if (!app.isPackaged) return { ok: false, error: '开发态没有 app.asar，换壳只在打包态可用' }
  const asar = path.join(process.resourcesPath, 'app.asar')
  if (!fs.existsSync(asar)) return { ok: false, error: `找不到 app.asar：${asar}` }
  const probe = probeShellWritable(process.resourcesPath)
  if (!probe.writable) return { ok: false, error: probe.reason }
  return { ok: true, error: '' }
}

function repoUpdateShellSwap() {
  const ready = shellSwapReadiness()
  if (!ready.ok) return { ok: false, error: ready.error }
  const st = readRepoUpdateState(HOME)
  const rec = st.components?.shell
  if (!Array.isArray(rec?.files) || rec.files.length === 0) {
    return { ok: false, error: '还没有从仓库下载过壳源码：请先点「更新」（它会把 src/** 下到暂存区）' }
  }
  const files = rec.files.map((f) => f.path)
  const plan = planShellSwap({
    home: HOME,
    resourcesPath: process.resourcesPath,
    execPath: process.execPath,
    files,
    appDataDir: APP_DATA,
    dshHome: HOME,
    relaunchArgs: [],
    parentPid: process.pid,
    log,
  })
  if (!plan.ok) return { ok: false, error: plan.error }
  const spawned = spawnSwapHelper({ execPath: process.execPath, helperArgs: plan.helperArgs, helperEnv: plan.helperEnv, cwd: HOME })
  if (!spawned.ok) return { ok: false, error: `换壳助手启动失败：${spawned.error}` }
  log(`[shell-update] 助手已启动（pid=${spawned.pid}）；本进程即将退出，助手会在退出后替换 asar、用 --smoke 校验新壳，失败自动回滚`)
  // 应用马上要退出（新壳要先跑一次完整冒烟，界面会消失几十秒），先给通知，否则像"点了按钮应用没了"。
  try {
    new Notification({
      title: `${APP_NAME}·正在换壳`,
      body: `已换 ${plan.written?.length ?? 0} 个文件。应用即将退出，校验新壳后会自动重启（校验不过会自动回滚到旧壳）。`,
      timeoutType: 'never',
    }).show()
  } catch { /* 无通知权限则忽略 */ }
  // 给响应一点点时间发出去，然后退出（助手在等本进程消失）
  setTimeout(() => cleanup(0), 400)
  return {
    ok: true,
    restarting: true,
    helperPid: spawned.pid,
    written: plan.written,
    staged: plan.stagedAsar,
    swapLog: plan.logFile,
    message: `已开始换壳：换了 ${plan.written?.length ?? 0} 个文件，应用将退出并自动重启（助手会先校验新壳，失败自动回滚）`,
  }
}

/** 联网查最新版本。失败收敛成 { ok:false }（与 admin.mjs 既有风格一致：异常不穿透路由）。 */
async function dshCheck() {
  if (dshUpdateBusy) return { ok: false, error: '已有更新任务在进行中，请稍候' }
  dshUpdateBusy = true
  dshUpdate.phase = 'checking'
  dshUpdate.error = null
  dshCurrentCache = null
  try {
    const r = await checkForUpdate({ profileDir: path.join(VENDOR_DIR, 'profile'), log })
    dshUpdate.current = r.current
    dshCurrentCache = r.current
    if (!r.ok) {
      dshUpdate.phase = 'failed'
      dshUpdate.error = r.error
      return { ok: false, error: r.error }
    }
    dshUpdate.latest = r.latest
    dshUpdate.target = r.target
    dshUpdate.hasUpdate = r.hasUpdate
    dshUpdate.npmOk = findNpm() !== null
    dshUpdate.phase = 'idle'
    log(`[dsh-update] 检查完成：当前 ${r.current['@deepseek-ai/dsh'] ?? '未知'} / 最新 ${r.target ?? '未知'} / hasUpdate=${r.hasUpdate}`)
    return dshUpdateSnapshot()
  } catch (e) {
    dshUpdate.phase = 'failed'
    dshUpdate.error = e.message
    log(`[dsh-update] 检查异常：${e.message}`)
    return { ok: false, error: e.message }
  } finally {
    dshUpdateBusy = false
  }
}

// 启动暂存构建，立即返回（构建是分钟级任务，await 会撞上 admin 请求超时）；进度走 /api/status 快照。
// @param {string} version 目标版本（必须是"检查更新"查回来的那一个）
// @param {{allowUnsafeJump?:boolean}} [opts] 跨 minor/主版本时需显式置 allowUnsafeJump
function dshUpdateTo(version, opts = {}) {
  if (dshUpdateBusy) return { ok: false, error: '已有更新任务在进行中，请稍候' }
  const target = (String(version ?? '').trim()) || dshUpdate.target || ''
  if (target === '') return { ok: false, error: '未指定目标版本，请先“检查更新”' }
  // 只接受"检查更新"查回来过的精确版本，绝不把任意字符串拼进 npm 依赖（供应链面）；
  // target 为 null 时也要拒绝——那是"从未检查过"，不是"版本随便填"的许可。
  if (dshUpdate.target === null) return { ok: false, error: '请先“检查更新”确定目标版本' }
  if (target !== dshUpdate.target) {
    return { ok: false, error: `目标 ${target} 与已查得的最新版 ${dshUpdate.target} 不一致，请重新“检查更新”` }
  }
  // 版本距离守卫：跨 minor/主版本意味着交互合同可能已变，而两道门禁都测不出这一点。
  const installedVersion = dshUpdate.current?.['@deepseek-ai/dsh'] ?? dshCurrentVersions()['@deepseek-ai/dsh']
  if (typeof installedVersion === 'string') {
    const jump = assessJump(installedVersion, target)
    if (!jump.safe && opts.allowUnsafeJump !== true) {
      // 措辞只说要做什么，不提"带某个参数"（界面按钮带不了参数，那样说等于把人卡死）。
      return {
        ok: false,
        needsConfirm: true,
        jump,
        error: `这一步属于跨版本升级，需要你先确认：${jump.reason}。请在“桌面”设置里点“更新（跨版本）”，确认后即可继续。`,
      }
    }
    if (!jump.safe) log(`[dsh-update] 用户显式确认跨版本升级：${jump.reason}`)
  }
  if (findNpm() === null) {
    dshUpdate.npmOk = false
    return { ok: false, error: '未找到系统 Node.js（本应用不内置 npm）：请先安装 Node.js，或设置 DSH_NODE_DIR' }
  }
  // 兼容性守卫放在 npm install 之前：能省掉一次 255 MB 安装 + 90 秒门禁等待，且给的是能照做的原因。
  const compat = harnessCompat(target)
  if (compat.blocked) {
    log(`[dsh-update] 兼容性守卫拦下 ${target}：${compat.reason}`)
    dshUpdate.phase = 'failed'
    dshUpdate.error = compat.reason
    return { ok: false, error: compat.reason, compat }
  }
  if (compat.warn) log(`[dsh-update] 兼容性警告（不拦）：${compat.reason}`)
  dshUpdateBusy = true
  dshUpdate.phase = 'building'
  dshUpdate.error = null
  dshUpdate.target = target
  dshUpdate.startedAt = new Date().toISOString()
  dshUpdate.finishedAt = null
  const stagingRoot = path.join(VENDOR_STAGING_ROOT, target)
  const versions = { '@deepseek-ai/dsh': target, '@deepseek-ai/dsh-base': target, '@deepseek-ai/dsh-web-app': target }
  // packagesDir：打包态取现网 vendor 里的插件副本，开发态取仓库 packages/（与 ensureProfilePlugins 同源）
  const packagesDir = PACKAGES_DIR
  void (async () => {
    try {
      // 暂存区可能是上一次失败留下的半成品（含构建期造的链接场）→ 走安全删除，不直接 rmSync
      safeRemoveTree(stagingRoot, { log })
      const built = await buildStaging({
        stagingRoot,
        versions,
        packagesDir,
        cacheDir: path.join(APP_DATA, '.npm-cache'),
        runtime: process.execPath,   // Electron 内建 Node（ELECTRON_RUN_AS_NODE 由 vendor-build 自己设）
        // 启动门禁必须拿到壳真正会用的那个补丁，否则门禁测的是另一套契约。
        patchFile: patchFile(),
        ws: WS,
        logFile: path.join(LOG_DIR, 'dsh-update.log'),
        log,
        // 进度：构建约 8 分钟，只给一句"分钟级"等于没进度。快照经 /api/status 的 5 秒轮询回显。
        onProgress: (p) => { dshUpdate.progress = { ...p, at: new Date().toISOString() } },
      })
      if (!built.ok) {
        dshUpdate.phase = 'failed'
        dshUpdate.error = built.error
        return
      }
      writePending(APP_DATA, { stagingRoot, target, from: dshUpdate.current?.['@deepseek-ai/dsh'] ?? null })
      dshUpdate.phase = 'ready'
      log(`[dsh-update] 构建完成，待重启应用生效：${target}`)
    } catch (e) {
      dshUpdate.phase = 'failed'
      dshUpdate.error = e.message
      log(`[dsh-update] 构建异常：${e.message}`)
    } finally {
      dshUpdateBusy = false
      dshUpdate.finishedAt = new Date().toISOString()
    }
  })()
  return { ok: true, accepted: true, target, note: '构建已开始（分钟级），进度见 /api/dsh/status' }
}

// 写标记后重启应用：换树发生在新进程启动的最早期（见 main() 里的调用点与 dshBin() 的注释）。
// @returns {{ok:boolean, error?:string, restarting?:boolean, target?:string}}
function dshApply() {
  const pending = readPending(APP_DATA)
  if (pending === null) return { ok: false, error: '没有待应用的更新（请先执行“更新”）' }
  dshUpdate.phase = 'applying'
  log(`[dsh-update] 用户确认重启以应用更新：${pending.target}`)
  // 先让 HTTP 响应送达再重启；cleanup 会优雅停宿主并释放 host 锁，否则新进程复用旧宿主等于没换树。
  setTimeout(() => {
    try { app.relaunch() } catch (e) { log(`relaunch 失败：${e.message}`) }
    void cleanup(0)
  }, 300)
  return { ok: true, restarting: true, target: pending.target }
}

// ---------- doctor ----------
function runDoctor() {
  const rows = []
  const add = (name, ok, detail) => rows.push({ name, ok, detail })
  add('窗口引擎', true, `Electron ${process.versions.electron}（内建 Node ${process.versions.node} / Chromium ${process.versions.chrome}）`)
  add('dsh CLI', !!dshBin(), dshBin() || '未找到（全局 npm / npx 缓存 / vendor）')
  // shell 体检项分平台：Windows 问 pwsh，POSIX 问 bash
  const shell = agentShell()
  add(shell.kind === 'pwsh' ? 'PowerShell 7 (agent 工具)' : `系统 Shell (${shell.kind})`, shell.ok,
    shell.ok ? shell.path : (shell.kind === 'pwsh' ? '缺失！运行: winget install Microsoft.PowerShell' : `PATH 里找不到 ${shell.kind}`))
  // 非 Windows 追加沙箱后端体检：沙箱不可用时 agent 命令会被 fail-closed 拒绝，容易误判成壳坏了。
  if (process.platform !== 'win32') {
    const backend = process.platform === 'darwin'
      ? (whichCommand('sandbox-exec') !== null ? 'seatbelt（sandbox-exec）' : '缺失：找不到 sandbox-exec')
      : (whichCommand('bwrap') !== null ? 'bwrap（bubblewrap）' : '缺失：建议 apt install bubblewrap，否则回退 landlock')
    add('DSH 沙箱后端', process.platform === 'darwin' ? backend.startsWith('seatbelt') : backend.startsWith('bwrap'), backend)
  }
  add('DSH_HOME', fs.existsSync(HOME), HOME)
  // 环境判据与启动前 preflight 共用同一套实现：Windows 版本 / 路径非 ASCII / NODE_OPTIONS /
  // DSH_BIN / 数据目录可写 / 磁盘 / 依赖完整性。
  for (const r of preflightChecks()) add(r.name, r.ok, r.detail)
  console.log(`\n[DSH Desktop ${readVersion()} doctor]`)
  for (const r of rows) console.log(`  ${r.ok ? '[OK]  ' : '[FAIL]'} ${r.name}: ${r.detail}`)
  const failed = rows.filter((r) => !r.ok)
  console.log(failed.length
    ? `\n${failed.length} 项未通过: ${failed.map((r) => r.name).join(' / ')}\n完整取证报告: ${CLI_HINT} --diag`
    : '\n全部通过')
  // 退出码语义保持原样：只有"找不到 dsh CLI"才返回 2（历史上 build-host/门禁依赖这个口径）
  process.exitCode = failed.some((r) => r.name === 'dsh CLI') ? 2 : 0
}

// ---------- 退出编排 ----------
// 会话日志静止探测：sessions 树下最新 .zstd 的 mtime（写批未落盘时会持续跳动）
function latestSessionLogMtime(home) {
  let latest = 0
  const root = path.join(home, 'sessions')
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.zstd')) {
        try { latest = Math.max(latest, fs.statSync(p).mtimeMs) } catch { /* 忽略 */ }
      }
    }
  }
  walk(root)
  return latest
}

// 完整退出：先等会话日志静止（写批落盘、文件停在帧边界）再结束宿主进程树，避免"写一半就杀"；
// 万一仍留半个帧，启动前 repairSessionLogs 也兜底。
async function stopHostGracefully(proc, home, quietMs = 2500, timeoutMs = 10000) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
  const deadline = Date.now() + timeoutMs
  let last = latestSessionLogMtime(home)
  let quiet = 0
  while (Date.now() < deadline) {
    const m = latestSessionLogMtime(home)
    if (m === last) quiet += 400 // 无日志（m=0）同样视为静止
    else { quiet = 0; last = m }
    if (quiet >= quietMs) break
    await new Promise((r) => setTimeout(r, 400))
  }
  log(`host 退出前日志静止 ${Math.min(quiet, quietMs)}ms，结束宿主进程树`)
  killTree(proc.pid)
}

async function cleanup(code = 0) {
  if (quitting) return
  quitting = true
  log(`cleanup: code=${code}`)
  if (hostProc) {
    try { await stopHostGracefully(hostProc, HOME) } catch (e) { log(`host 优雅退出失败: ${e.message}`) }
    releaseHostLockIfOurs(hostProc.pid)
  }
  try { adminServer?.close() } catch { /* 已关 */ }
  // 全局快捷键必须显式注销：不注销的话，本进程退出前它仍被占用（重开应用时会注册失败）
  try { globalShortcut.unregisterAll() } catch { /* 平台不支持则忽略 */ }
  if (restoresWatchTimer !== null) { try { clearInterval(restoresWatchTimer) } catch { /* 忽略 */ } restoresWatchTimer = null }
  clearState()
  app.exit(code)
}
process.on('SIGINT', () => cleanup(130))
process.on('SIGTERM', () => cleanup(143))
// POSIX 关闭终端/注销/pkill 默认发 SIGHUP：不接它 cleanup 就不会跑，宿主变孤儿 + 锁残留。
process.on('SIGHUP', () => cleanup(129))
app.on('window-all-closed', () => {
  // macOS 惯例：关掉所有窗口后应用仍在 Dock 里活着，点 Dock 图标重新开窗（见 activate）。
  if (process.platform === 'darwin') return
  cleanup(0)
})
app.on('activate', () => {
  if (process.platform !== 'darwin') return
  void focusAction()
})

// ---------- 主流程 ----------
// ---------- 自带插件供给 ----------
// 三个插件随包分发，壳每次启动幂等同步到 profile 的 out-of-tree 插件位（loader 的 ESM 解析基准
// 是 profile 目录本身，打包态 vendor 里的副本不会被解析到）：
//   · dsh-desktop-ui    客户端插件（设置面板"桌面"section）
//   · dsh-auto-approval Host 插件（经 cordis.patch.yml 的 insert 行挂载）
//   · dsh-market        客户端插件（左侧栏底部入口 + 插件/美化包两页目录）
// 这张表只放**随包自带**的插件。市场装进来的第三方包绝不能加进来：syncProfilePlugin 是整目录
// 删除 + 重拷，写进去等于每次启动都拿包内副本覆盖用户装的东西。
const PROFILE_PLUGIN_NAMES = ['dsh-desktop-ui', 'dsh-auto-approval', 'dsh-market']
const PACKAGES_DIR = app.isPackaged ? path.join(VENDOR_DIR, 'profile', 'node_modules') : path.join(ROOT_DIR, 'packages')
// profile 名单独留一个常量：市场走官方 dsh plugin --profile <name> 时也要用它，
// 而 CLI 的 --profile 是相对 $DSH_HOME/profiles 的名字（不是路径），两者必须同源。
const PROFILE_NAME = 'web'
const PROFILE_DIR = path.join(HOME, 'profiles', PROFILE_NAME)

function pluginSourceDir(name) {
  return app.isPackaged ? path.join(VENDOR_DIR, 'profile', 'node_modules', name) : path.join(ROOT_DIR, 'packages', name)
}

// 把包同步到 profile 插件位（幂等：整目录替换，避免残留旧文件）。
// 删除必须走 safeRemoveTree：该目录是 junction/symlink 场，rmSync 不跟随链接只是实现细节。
// 拷贝要显式 dereference: false —— cpSync 默认解引用，会把链接展开成实体副本。
function syncProfilePlugin(name) {
  const src = pluginSourceDir(name)
  if (!fs.existsSync(path.join(src, 'package.json'))) { log(`插件包缺失: ${src}`); return false }
  const dst = path.join(PROFILE_DIR, 'node_modules', name)
  // 热更新优先：点过"从仓库更新功能"后插件位里那份更新，用随包副本整目录重写等于"重启就没了"。
  // 判据只看账本：随包副本摘要没变则保留，变了（壳被新安装包换过）则以新包为准并让条目失效。
  const keep = shouldKeepHotUpdated({ home: HOME, id: name, bundledDir: src })
  if (keep.keep) {
    log(`插件位保留仓库热更新版本：${name}（${keep.why}）`)
    return true
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  const swept = safeRemoveTree(dst, { log })
  if (swept.unlinked > 0) log(`插件位替换：解开 ${swept.unlinked} 个链接（未进入其目标）`)
  if (swept.leftovers > 0) {
    // 没删干净就往下拷 = 新旧文件混合（旧 client.js 与新壳混用），直接判失败，下次启动会重试。
    log(`插件位替换失败：${name} 有 ${swept.leftovers} 项残留（文件被占用？），本次跳过以免产出混合副本`)
    return false
  }
  fs.cpSync(src, dst, { recursive: true, dereference: false, verbatimSymlinks: true })
  return true
}

// 确保 profile 用户补丁层里有该 Host 插件的 insert 行（幂等，只追加不改动用户已有内容）。
// 实现在 profile-mount.mjs（抽成模块是为了让测试 import 真实现，而不是照抄一份）。
function ensureProfilePluginMount(name, comment) {
  return ensureProfilePluginMountIn({ profileDir: PROFILE_DIR, name, comment, log })
}

function repairProfilePatchYaml() {
  return repairProfilePatchYamlIn({ profileDir: PROFILE_DIR, log })
}

function ensureProfilePlugins() {
  for (const name of PROFILE_PLUGIN_NAMES) syncProfilePlugin(name)
  repairProfilePatchYaml() // 必须在写挂载之前：否则对已损坏的文件会跳过写入（名字已在注释里出现过）
  ensureProfilePluginMount('dsh-auto-approval', 'AI 自检权限申请：审批瀑布前置分级，低风险自动放行、高风险仍问用户（配置在 settings.yaml 的 auto-approval 段；开关 /approval on|off）')
  ensureProfilePluginMount('dsh-market', 'DSH 市场：左侧栏底部入口，插件 / 美化包两页目录（目录数据由壳的 admin API 供给）')
}
// 官方"打开配置文件"按钮的确定性实现：shell.openPath（走默认关联程序）+ 记事本兜底。
async function openSettingsDocument() {
  if (SMOKE || HEADLESS) return { ok: true, note: 'headless/smoke 不执行打开' }
  const p = path.join(HOME, 'settings.yaml')
  try {
    if (!fs.existsSync(p)) {
      fs.mkdirSync(HOME, { recursive: true })
      fs.writeFileSync(p, '# DeepSeek Harness settings\n')
    }
    const err = await shell.openPath(p)
    if (err) {
      // 分平台的文本编辑器兜底。spawn 抛 ENOENT 会走异步 'error' 事件（不在 try 里），
      // 未监听的 ChildProcess error 会带走主进程，所以必须挂 error 监听。
      const cand = process.platform === 'win32'
        ? [['notepad.exe', [p]]]
        : process.platform === 'darwin'
          ? [['open', ['-t', p]]]
          : [[process.env.VISUAL || process.env.EDITOR || 'xdg-open', [p]]]
      for (const [bin, args] of cand) {
        if (bin === '' || whichCommand(bin) === null) continue
        try {
          const child = spawn(bin, args, { detached: true, stdio: 'ignore' })
          child.on('error', (e) => log(`打开配置文件的兜底编辑器失败（${bin}）：${e.message}`))
          child.unref()
          return { ok: true, fallback: bin, note: err }
        } catch (e) { log(`spawn ${bin} 失败：${e.message}`) }
      }
      return { ok: false, error: `系统未关联 .yaml 且找不到可用编辑器：${err}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// 原生目录选择（设置面板"浏览…"）：选完即落地工作区，服务端一步完成（headless/冒烟不弹窗）。
async function pickDirectory() {
  if (HEADLESS || SMOKE) return { ok: true, canceled: true, note: 'headless（不弹选择器）' }
  const r = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, {
    title: '选择 Agent 工作区',
    properties: ['openDirectory', 'createDirectory'],
  })
  if (r.canceled || r.filePaths.length === 0) return { ok: true, canceled: true }
  const p = r.filePaths[0]
  try { fs.mkdirSync(p, { recursive: true }) } catch (e) { return { ok: false, error: `目录不可用: ${e.message}` } }
  applyWorkspace(p)
  return { ok: true, path: p, applied: true }
}

function applyWorkspace(p) {
  const s = readSettings(); s.workspace = p; writeSettings(s)
  WS = p
  log(`workspace: ${p}`)
}

// ---------- preflight：启动前就拦下"环境不允许它跑"的情形 ----------
// 检查项都是在宿主启动前就能判定的，宁可在壳这一层说清"改什么"，也不要让它退化成一个退出码。
// 分级：critical 会让壳带着说明退出（继续跑只会重复崩溃）；warn 只记日志并提示。
let preflightFailed = []
/** 给宿主进程的环境补充（目前只用于把工作区钉到 ASCII 路径，见 WS 检查项）。 */
function preflightEnvOverrides() { return {} }

const isAsciiPath = (p) => !/[^\x00-\x7F]/.test(String(p || ''))
/** 只读检查，不修改任何东西；`--doctor` 与启动流程共用同一套判据。 */
function preflightChecks() {
  const rows = []
  const add = (name, ok, detail, level = 'warn') => rows.push({ name, ok, level, detail })

  // 系统版本判据分平台：内核版本不能当 Windows build 解析，否则 Linux 上恒告警"需 Win10 22H2"。
  if (process.platform === 'win32') {
    const winBuild = Number(os.release().split('.')[2] || 0)
    add('Windows 版本', winBuild >= 19045, `build ${os.release()}${winBuild >= 19045 ? '' : '（需 Win10 22H2 / build 19045 及以上）'}`, 'warn')
  } else if (process.platform === 'darwin') {
    const major = Number(os.release().split('.')[0] || 0)
    // Darwin 23 = macOS 14；Electron 43 要求 macOS 12+（Darwin 21）
    add('macOS 版本', major >= 21, `Darwin ${os.release()}（Electron 需 macOS 12 及以上）`, 'warn')
  } else {
    let pretty = os.release()
    try { const t = fs.readFileSync('/etc/os-release', 'utf8'); const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(t); if (m) pretty = `${m[1]}（内核 ${os.release()}）` } catch { /* 非标准发行版 */ }
    add('Linux 发行版', true, pretty, 'warn')
  }

  // agent shell：Windows 要 pwsh，POSIX 要 bash
  const shell = agentShell()
  add(shell.kind === 'pwsh' ? 'PowerShell 7（agent 工具依赖）' : `系统 Shell（${shell.kind}）`,
    shell.ok,
    shell.ok ? shell.path : (shell.kind === 'pwsh' ? '缺失！运行: winget install Microsoft.PowerShell' : `PATH 里找不到 ${shell.kind}`),
    'warn')

  // 非 ASCII 路径：koffi COM worker / sharp 等原生模块在中文路径下的经典故障是"启动即退且无输出"。
  // 分级：Windows 判 critical；macOS 中文用户名是常态（/Users/张三），降为 warn。
  add('DSH_HOME 路径', isAsciiPath(HOME), HOME, process.platform === 'win32' ? 'critical' : 'warn')

  let wsAscii = isAsciiPath(WS)
  if (!wsAscii) {
    const fallback = path.join(APP_DATA, 'workspace') // APP_DATA 在 %LOCALAPPDATA% 下，纯 ASCII
    if (isAsciiPath(fallback)) {
      log(`preflight: 工作区路径含非 ASCII 字符（${WS}），本次改用 ASCII 回退目录 ${fallback}`)
      WS = fallback
      wsAscii = true
    }
  }
  add('工作区路径', wsAscii, WS, 'warn')

  const envNodeOptions = (process.env.NODE_OPTIONS || '').trim()
  add('NODE_OPTIONS', envNodeOptions === '', envNodeOptions === '' ? '未设置' : `已设置：${envNodeOptions}（会注入宿主进程使其启动即崩，请清空该环境变量）`, 'critical')

  const dshBinEnv = (process.env.DSH_BIN || '').trim()
  add('DSH_BIN', dshBinEnv === '' || fs.existsSync(dshBinEnv), dshBinEnv === '' ? '未设置（用包内 vendor）' : `=${dshBinEnv}${fs.existsSync(dshBinEnv) ? '' : '（文件不存在；壳会退回包内 vendor）'}`, 'warn')

  let writable = false
  try { fs.mkdirSync(APP_DATA, { recursive: true }); const probe = path.join(APP_DATA, '.write-probe'); fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe); writable = true } catch { /* 不可写 */ }
  add('应用数据可写', writable, writable ? APP_DATA : `${APP_DATA}（被组策略/杀软拦写；宿主无法建 home，必然启动失败）`, 'critical')

  let freeMb = -1
  try { freeMb = Math.round(fs.statfsSync(APP_DATA).bavail * fs.statfsSync(APP_DATA).bsize / 1048576) } catch { /* 忽略 */ }
  add('磁盘余量', freeMb < 0 || freeMb > 200, freeMb < 0 ? '未知' : `${freeMb} MB`, 'warn')

  const vendorFiles = (() => { try { return countVendorFiles(path.join(VENDOR_DIR, 'profile', 'node_modules')) } catch { return -1 } })()
  {
    const verdict = assessVendorIntegrity({ files: vendorFiles, baseline: vendorBaseline().files })
    // 三态语义由 assessVendorIntegrity 给全：只有"缺件"是 critical，其余 warn，但都不伪装成通过。
    add('依赖完整性', verdict.ok, verdict.detail, verdict.level)
  }

  // vendor 树归属（决策 D8）：先用哪棵、种子在不在——支持场景（"这 124 MB 是什么"）先看这里。
  if (app.isPackaged) {
    const active = inspectVendorHome(VENDOR_DIR)
    const seed = inspectVendorHome(VENDOR_HOME.seedDir)
    const where = VENDOR_HOME.source === 'packaged'
      ? '包内 resources/vendor（本平台不使用种子机制）'
      : (VENDOR_DIR === VENDOR_HOME.seedDir ? '包内种子' : '用户数据目录')
    add('vendor 归属', active.usable, `${where}：${VENDOR_DIR}${active.usable ? '' : ` —— ${active.reason}`}`, 'warn')
    if (VENDOR_HOME.source !== 'packaged') {
      add('vendor 种子', seed.usable, `${VENDOR_HOME.seedDir}${seed.usable ? '' : ` —— ${seed.reason}（包内那棵也坏了，无法回退）`}`, 'warn')
    }
  }

  return rows
}

/** 启动前置检查：critical 失败则记录并返回 false（调用方负责带说明退出）。 */
function runPreflight() {
  const rows = preflightChecks()
  preflightFailed = rows.filter((r) => !r.ok)
  for (const r of preflightFailed) log(`preflight[${r.level}] ${r.name}: ${r.detail}`)
  const critical = preflightFailed.filter((r) => r.level === 'critical')
  if (critical.length > 0) {
    const text = critical.map((r) => `· ${r.name}：${r.detail}`).join('\n')
    log(`preflight: ${critical.length} 项致命问题，启动中止\n${text}`)
    if (!SMOKE && !HEADLESS) {
      try { dialog.showErrorBox(`${APP_NAME} 无法在此环境启动`, `检测到 ${critical.length} 项环境问题：\n\n${text}\n\n修好后重开应用即可；也可以运行 \`${CLI_HINT} --diag\` 生成完整取证报告。`) } catch { /* 无 GUI 会话 */ }
    }
    return false
  }
  return true
}

// ---------- --diag：一键取证（把排查所需事实打成一段可复制的文本） ----------
function runDiag() {
  const lines = []
  const say = (s = '') => { lines.push(s) }
  const flag = (p) => (isAsciiPath(p) ? 'ASCII' : '⚠ 含非 ASCII')
  say(`=== DSH Desktop 取证报告 ===`)
  say(`生成时间 : ${new Date().toISOString()}`)
  say(`壳版本   : ${readVersion()}`)
  say(`Electron : ${process.versions.electron}（内建 Node ${process.versions.node} / Chromium ${process.versions.chrome}）`)
  say(`系统      : ${process.platform} ${os.release()}（${os.arch()}）`)
  say(`用户名   : ${os.userInfo().username}`)
  say()
  say(`--- 路径 ---`)
  say(`APP_DATA   : ${APP_DATA}  [存在=${fs.existsSync(APP_DATA)} ${flag(APP_DATA)}]`)
  say(`DSH_HOME   : ${HOME}  [存在=${fs.existsSync(HOME)} ${flag(HOME)}]`)
  say(`工作区     : ${WS}  [存在=${fs.existsSync(WS)} ${flag(WS)}]`)
  const activeProfile = path.join(VENDOR_DIR, 'profile')
  say(`vendor     : ${VENDOR_DIR}（来源 ${VENDOR_HOME.source === 'userData' && VENDOR_DIR === VENDOR_HOME.dir ? '用户数据目录' : VENDOR_DIR === VENDOR_HOME.seedDir ? '包内种子' : '包内'}）`)
  say(`  profile  : ${activeProfile}  [存在=${fs.existsSync(activeProfile)} ${flag(activeProfile)}]`)
  if (VENDOR_HOME.source !== 'packaged') {
    const seedCheck = inspectVendorHome(VENDOR_HOME.seedDir)
    say(`  种子     : ${VENDOR_HOME.seedDir}  [可用=${seedCheck.usable}]`)
  }
  say(`  暂存区   : ${VENDOR_STAGING_ROOT}  [存在=${fs.existsSync(VENDOR_STAGING_ROOT)}]`)
  say(`dsh bin.js : ${dshBin() || '（未找到！）'}`)
  // 托盘可用性：Linux 上"托盘不可见"会让"关闭到托盘"变成找不到窗口，排障时这是第一个要看的事实。
  say(`托盘可用   : ${trayUsable}${os.platform() === 'linux' && !trayUsable ? '（Linux 缺托盘服务/扩展时会这样；此时"关闭到托盘"自动关闭）' : ''}`)
  // 深链是否送达过（决策 D9）：`dsh://` 点了没反应时，先确认"最后一次收到"是什么时候。
  const deepLink = (() => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).lastDeepLink ?? null } catch { return null } })()
  say(`最后深链   : ${deepLink ?? '（本次会话没有收到过 dsh://）'}`)
  say()
  say(`--- 环境变量（可能影响宿主启动的） ---`)
  for (const n of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'DSH_BIN', 'DSH_HOME', 'DSH_WS', 'DSH_APP_DATA', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
    const v = process.env[n]
    if (v !== undefined && v !== '') say(`${n} = ${v}`)
  }
  say(`（以上未列出的即为未设置）`)
  say()
  say(`--- preflight 检查结果 ---`)
  for (const r of preflightChecks()) say(`${r.ok ? '[OK]  ' : `[${r.level === 'critical' ? 'FAIL' : 'WARN'}]`} ${r.name}: ${r.detail}`)
  say()
  say(`--- 宿主锁 ---`)
  const lock = readHostLock()
  say(lock ? `pid=${lock.pid} port=${lock.port} 存活=${pidAlive(lock.pid)}` : '（无锁文件）')
  say(`宿主 stdio 模式 : ${hostProc ? (hostProc.dshStdioMode || '未知') : '（本次未启动宿主）'}${hostProc && hostProc.dshStdioDegraded ? '（已退化：管道被系统拒绝，"最后遗言"不可用）' : ''}`)
  say()
  say(`--- 依赖文件数 ---`)
  try {
    const nm = path.join(VENDOR_DIR, 'profile', 'node_modules')
    const base = vendorBaseline()
    say(`node_modules 文件数 = ${countVendorFiles(nm)}（打包基线 ${base.files || '未知'}；平台 ${base.platform ?? '未记录'}）`)
  } catch (e) { say(`统计失败：${e.message}`) }
  say()
  say(`--- host.stderr.log 尾部 30 行（崩溃真因在这里） ---`)
  try { say(fs.readFileSync(HOST_ERR_LOG, 'utf8').split('\n').filter((l) => l.trim()).slice(-30).join('\n') || '（空）') } catch { say('（读不到）') }
  say()
  say(`--- host.log 尾部 20 行 ---`)
  try { say(fs.readFileSync(HOST_LOG, 'utf8').split('\n').filter((l) => l.trim()).slice(-20).join('\n') || '（空）') } catch { say('（读不到）') }
  say()
  say(`--- app.log 尾部 20 行 ---`)
  try { say(fs.readFileSync(path.join(LOG_DIR, 'app.log'), 'utf8').split('\n').filter((l) => l.trim()).slice(-20).join('\n') || '（空）') } catch { say('（读不到）') }

  const text = lines.join('\n')
  const out = path.join(LOG_DIR, 'diag-report.txt')
  try { fs.writeFileSync(out, text + '\n') } catch { /* 落盘失败也要打印 */ }
  console.log(`\n${text}\n`)
  console.log(`[已保存到] ${out}`)
}

async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  rotateLogs()
  const settings = readSettings()
  if (settings.workspace) WS = settings.workspace
  fs.mkdirSync(WS, { recursive: true })
  // 外观设置迁移放在这里：在 readSettings 之后、任何 statusPayload / 客户端轮询之前。
  try { migrateSkinSettings() } catch (e) { log(`设置迁移失败（非致命）：${e.message}`) }

  // ── vendor 树就位（决策 D8）──
  // 必须在 preflight 之前（冒烟跳过 preflight，晚则种子永不落地、dshBin() 判空），
  // 也必须在所有 CLI 命令之前（--version / --doctor / --diag 要基于当前实际使用的树给结论）。
  if (app.isPackaged) prepareVendorHome()

  // ---------- CLI 快捷命令（不启动宿主、不拉窗口） ----------
  // 放在 vendor 就位之后、preflight 之前：这些命令正是用来在可疑环境里查环境的。
  if (args.includes('--version')) { console.log(`${APP_NAME} ${readVersion()}`); app.exit(0); return }
  if (DIAG) { runDiag(); app.exit(0); return }
  if (DOCTOR) { runDoctor(); app.exit(0); return }
  if (args.includes('--set-ws')) {
    const p = args[args.indexOf('--set-ws') + 1]
    if (p && path.isAbsolute(p)) {
      try { fs.mkdirSync(p, { recursive: true }) } catch (e) { console.error(`目录不可用: ${e.message}`); app.exit(2); return }
      const s = readSettings(); s.workspace = p
      writeSettings(s); console.log(`workspace: ${p}`); app.exit(0); return
    }
    console.error('用法: --set-ws <绝对路径>'); app.exit(2); return
  }
  if (args.includes('--autostart')) {
    const v = args[args.indexOf('--autostart') + 1]
    if (v === 'on' || v === 'off') {
      const s = readSettings(); s.autostart = v === 'on'
      writeSettings(s); setAutostart(s.autostart); app.exit(0); return
    }
    console.error('用法: --autostart on|off'); app.exit(2); return
  }
  if (args.includes('--register')) {
    setAutostart(!!readSettings().autostart)
    applyProtocol()
    console.log('registered'); app.exit(0); return
  }

  // 环境前置检查：critical 失败就带说明退出，不要去拉一个注定起不来的宿主。
  if (!SMOKE && !runPreflight()) { cleanup(2); return }

  // 清理上次没走完 finally 的门禁隔离目录：里面有指向被测树/现网树的 junction 场，
  // 任何"跟随 junction"的清理动作都会掏空目标树。失败不阻断启动。
  try { cleanStaleBootGateHomes({ log }) } catch (e) { log(`遗留门禁目录清理失败（非致命）：${e.message}`) }

  // 待应用的 DSH 更新必须在 dshBin() 首次求值之前落地（换树会把旧树改名走开，先求值会缓存失效路径）；
  // 放在 CLI 快捷命令之后：那些命令不该触发换树。
  const applied = applyPending({ appData: APP_DATA, vendorDir: VENDOR_DIR, log })
  if (applied.applied) {
    dshCurrentCache = null
    dshUpdate.phase = 'idle'
    dshUpdate.target = null
    log(`DSH 更新已应用；旧树保留在 ${applied.oldProfileDir ?? '（无）'}，宿主启动成功后自动清理`)
  } else if (applied.error) {
    log(`DSH 更新未应用（旧树照常运行）：${applied.error}`)
  }

  if (!dshBin()) {
    console.error('[DSH Desktop] 找不到 dsh CLI (bin.js)。安装方式：npm i -g @deepseek-ai/dsh，')
    console.error('或设置环境变量 DSH_BIN 指向 bin.js（如 npx 缓存中的 @deepseek-ai/dsh/lib/bin.js）。')
    app.exit(2); return
  }

  // 多窗口：单实例锁只保证"一个壳进程"，窗口仍可在该进程内开多个，都经 bootHost 共用同一 dsh host；
  // 会话日志安全由宿主复用（findExistingHostUrl / .dsh-host.lock）保证。

  if (!DEV) {
    if (process.platform === 'darwin') {
      // macOS 不能把菜单整体置空：会连 ⌘Q、⌘C/⌘V/⌘A 与窗口管理一起拿掉，只保留最小可用集合。
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { role: 'windowMenu' },
      ]))
    } else {
      Menu.setApplicationMenu(null)
    }
  }
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(permission === 'notifications'))

  adminServer = createAdminServer({
    log, readSettings, writeSettings, statusPayload,
    actions: {
      setAutostart,
      setWorkspace: applyWorkspace,
      focus: focusAction,
      openDataDir: () => shell.openPath(APP_DATA),
      openWorkspace: () => shell.openPath(WS),
      openSettings: () => openDshSettings(),
      openSettingsDocument,
      pickDirectory,
      setBackground: setBackgroundImage,
      reapplyBackground: () => applyBackgroundCss(),
      restartHost: () => restartHostManual(),
      dshStatus: () => dshUpdateSnapshot(),
      // 市场：目录只读快照 + 下载（把地址交给系统，壳不落盘）+ 安装（会写 $DSH_HOME）
      marketCatalog: () => readMarketCatalog(),
      marketOpenDownload,
      marketInstall,
      // 安装前置体检（pnpm 在不在）。界面在打开市场时读一次，缺 pnpm 就先告诉用户怎么装。
      marketPreflight,
      dshCheck,
      dshUpdate: dshUpdateTo,
      dshApply,
      // 平面 C：按仓库文件更新"缺的文件与功能"（自带插件 / 补丁层 / 市场目录 / 壳源码暂存）
      repoUpdateCheck,
      repoUpdateApply,
      repoUpdateState: repoUpdateSnapshot,
      // 壳自身那一层（1.0.0）：换 app.asar 必须重启整个应用，所以它单独一个入口，不与上面的"应用"混在一起
      repoUpdateShell: repoUpdateShellSwap,
      diagOpaqueLayers,
      diagUi,
      // 【临时】市场弹窗几何探针（定位完即删）
      diagMarketGeom,
      reloadWindow,
      // 后台日志：列白名单 + 读末尾 N 行（供 /api/logs 与壳内日志窗口用）
      readLogs: (file, lines) => (file ? readLogTail(file, lines) : { ok: true, files: logFileEntries(), active: 'app.log' }),
      openLogWindow,
      toggleLogWindow,
      pickBackground: pickBackgroundImage,
      setSidebarBackground: setSidebarBackgroundImage,
      pickSidebarBackground: pickSidebarBackgroundImage,
      quit: (code) => cleanup(code),
    },
    staticFiles: { settingsHtml: SETTINGS_HTML, logsHtml: LOGS_HTML, icon: fs.existsSync(ICON_FILE) ? ICON_FILE : undefined },
  })
  adminPort = await listenAdmin(adminServer, ADMIN_PORT)
  if (adminPort !== ADMIN_PORT) log(`admin 端口 ${ADMIN_PORT} 被占用，回退 ${adminPort}（设置面板将显示"壳未响应"）`)
  writeState({ adminPort, mode: HEADLESS ? 'headless' : 'windowed', startedAt: new Date().toISOString(), version: readVersion(), home: HOME, ws: WS, dshBin: dshBin(), engine: 'Electron' })

  if (!SKIP_REG) { setAutostart(!!settings.autostart); applyProtocol() }

  ensureProfilePlugins()

  // ── 先把窗口显示出来，再等宿主 ──
  // 顺序有讲究：必须先起托盘再建窗口（close-to-tray 判据读 trayUsable，反过来会读到初始的 false），
  // 且这一组都在 bootHost() 之前跑——窗口先显示启动页，否则用户要盯空屏等十几秒。
  spawnTray()
  // 后台日志窗口的快捷键：托盘项之外再给一条"随时"的路（打包版没有 F12/控制台）。
  registerLogShortcut()
  await createWindow()
  if (!HEADLESS) log('窗口已显示（启动页；宿主就绪后切到界面）')

  try {
    // ── 换树兜底：失败发生在换树之后（新树起不来但旧树还完整躺在 profile.old-*），
    // 所以"延迟删旧树"救不了，必须能换回去。
    try {
      await bootHost()
    } catch (bootErr) {
      if (!applied.applied || !applied.oldProfileDir) throw bootErr
      log(`换树后宿主未就绪（${bootErr.message}），自动回滚到旧树并重试`)
      const rolled = restoreOldTree({
        vendorDir: VENDOR_DIR,
        oldProfileDir: applied.oldProfileDir,
        oldLockPath: applied.oldLockPath,
        log,
      })
      if (!rolled.ok) { log(`自动回滚失败：${rolled.error}`); throw bootErr }
      dshUpdate.lastRollback = { at: new Date().toISOString(), reason: bootErr.message, failedDir: rolled.failedDir }
      dshBinCache = undefined   // 换回旧树后必须重新解析 bin 路径，否则还指着已被改名走开的新树
      dshCurrentCache = null
      await bootHost()          // 再试一次；这次不行就交给外层 catch 走失败退出
      log('已回滚到更新前的 DSH，应用照常可用')
    }
    if (SMOKE) { log('SMOKE OK'); cleanup(0); return }
    // 宿主起来了 = 当前这棵树确认可用，现在才删旧树（无条件尝试，失败非致命，下次启动再试）。
    const cleanedTrees = cleanupOldTrees(VENDOR_DIR, log)
    if (cleanedTrees > 0) log(`DSH 更新：清理遗留旧树 ${cleanedTrees} 项`)
    // 宿主就绪 ⇒ 把窗口从启动页切到真实界面（窗口本身早在 bootHost 之前就显示了）
    if (win && !win.isDestroyed() && readyUrl) {
      await pruneAuthCookies()
      win.loadURL(readyUrl)
    }
    initUpdater()
    // 冷启动深链（Windows/Linux：进程被 dsh:// 直接拉起）：窗口就位后再聚焦并把 URL 记进状态。
    if (COLD_START_URL !== null) handleProtocolUrl(COLD_START_URL, 'cold-start')
    if (HEADLESS) { log(`HEADLESS 就绪: http://127.0.0.1:${adminPort}/`); return }
    log('窗口已打开')
  } catch (e) {
    log(`启动失败: ${e.message}`)
    cleanup(1)
  }
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1) })
