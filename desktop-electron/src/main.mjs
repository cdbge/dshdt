// DSH Desktop — Electron 主进程（M1a，施工计划阶段 2）
// 多窗口 → admin 服务 → host（模式 B：RUN_AS_NODE + --expose-internals）→ 就绪探测
// → BrowserWindow 加载 loopback（走既有信任栅栏，DSH 零改动）→ 崩溃联动/通知 → 退出编排。
// 迁移自 v1 desktop-shell/launcher.mjs：admin API 面、settings/app.state 格式、
// --smoke/--headless/--doctor/--autostart/--set-ws CLI 语义全部保持（双分支契约一致）。
// 运行环境保护（最先执行）：防 ELECTRON_RUN_AS_NODE 泄漏导致主进程以纯 Node 启动
import './node-guard.mjs'
// 诊断钩子必须最先导入：注册未捕获异常落盘（打包态无控制台，错误对话框吞现场）
import './early-errors.mjs'
import { app, BrowserWindow, Menu, Notification, Tray, dialog, nativeImage, shell, session } from 'electron'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAdminServer, listenAdmin } from './admin.mjs'
import { findDshBin, freePort, waitReady, killTree, startHost } from './host.mjs'
import { repairSessionLogs } from './repair.mjs'
import { applyPending, cleanupOldTrees, readPending, writePending } from './dsh-apply.mjs'
import { checkForUpdate, readCurrentVersions } from './dsh-update.mjs'
import { buildStaging, findNpm } from './vendor-build.mjs'
// electron-updater 是 CommonJS：Node 24 的 ESM 互操作检测不到命名导出，
// 必须默认导入后解构（M2 实测坑：命名导入在运行时抛 SyntaxError）。
import electronUpdater from 'electron-updater'
const { autoUpdater } = electronUpdater

const APP_NAME = 'DSH Desktop'
// 固定回环 admin 端口：DSH 设置面板里的"桌面"section（dsh-desktop-ui 插件）以此为 CORS 目标。
// 宿主复用保证唯一；被第三方占用时 listenAdmin 回退系统分配（插件届时显示"壳未响应"）。
const ADMIN_PORT = 25439
const APP_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.dirname(APP_DIR)
const APP_DATA = process.env.DSH_APP_DATA || path.join(process.env.LOCALAPPDATA, 'DSHDesktop')
// Electron 数据目录收进 APP_DATA（DSH_APP_DATA 覆盖时冒烟可隔离）；必须在 ready 前设置
app.setPath('userData', path.join(APP_DATA, 'electron-data'))
app.setPath('crashDumps', path.join(APP_DATA, 'crash-dumps'))
const HOME = process.env.DSH_HOME || (fs.existsSync(path.join(os.homedir(), '.dsh')) ? path.join(os.homedir(), '.dsh') : path.join(APP_DATA, 'dsh-home'))
let WS = process.env.DSH_WS || path.join(os.homedir(), 'DSH-Workspace')
const LOG_DIR = path.join(APP_DATA, 'logs')
const STATE_FILE = path.join(APP_DATA, 'app.state.json')
const SETTINGS_FILE = path.join(APP_DATA, 'settings.json')
// 打包态（app.isPackaged）：
//   VERSION 在 app.asar 内（主进程 fs 有 asar 支持，可读）；
//   vendor/profile / desktop.patch.yml / icon.ico 走 extraResources 在 resources/ 下——RUN_AS_NODE
//   宿主子进程读的是普通文件系统路径，不依赖 asar 支持。
const RES = app.isPackaged ? process.resourcesPath : ROOT_DIR
const VENDOR_PROFILE = app.isPackaged ? path.join(RES, 'vendor', 'profile') : path.join(ROOT_DIR, 'vendor', 'profile')
const VERSION_FILE = path.join(ROOT_DIR, 'VERSION')
const PATCH_FILE = app.isPackaged ? path.join(RES, 'desktop.patch.yml') : path.join(APP_DIR, 'desktop.patch.yml')
const SETTINGS_HTML = path.join(APP_DIR, 'settings.html')
const ICON_FILE = app.isPackaged ? path.join(RES, 'icon.ico') : path.join(ROOT_DIR, 'build', 'icon.ico')
const HOST_LOG = path.join(LOG_DIR, 'host.log')
// vendor 目录（含 profile/ 与 vendor.lock.json）。暂存区放在它下面而**不是** APP_DATA：
// 换树是 rename，跨卷会 EXDEV；APP_DATA 在 C:、开发态仓库在 D:，只有放到 vendor 同级才能保证同卷。
const VENDOR_DIR = path.dirname(VENDOR_PROFILE)
const VENDOR_STAGING_ROOT = path.join(VENDOR_DIR, 'staging')

// DSH_BIN 是**解析结果**（可能是 vendor 内的某个路径），不是固定路径——所以必须惰性求值。
// 坑（S3 实测前就预判到、已写进计划书 §3.2）：待应用的 vendor 换树会把该路径指向的目录改名走开，
// 若在模块顶层就把它求值成常量，换树后宿主的 bin 入口就失效，表现为"更新成功但应用再也起不来"。
// ⇒ 所有调用点一律用 dshBin()，不要退回常量。
let dshBinCache
function dshBin() {
  if (dshBinCache === undefined) dshBinCache = findDshBin([VENDOR_PROFILE])
  return dshBinCache
}

const args = process.argv.slice(process.defaultApp ? 2 : 1)
const SMOKE = args.includes('--smoke') || args.includes('--no-window')
const HEADLESS = args.includes('--headless')
const DEV = args.includes('--dev')
const DOCTOR = args.includes('--doctor')
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

function readVersion() {
  try { return fs.readFileSync(VERSION_FILE, 'utf8').trim() } catch { return '0.0.0-dev' }
}
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { fs.appendFileSync(path.join(LOG_DIR, 'app.log'), line) } catch { /* 日志目录不可写 */ }
  console.log(line.trimEnd())
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
function ps7Available() {
  try { return spawnSync('where', ['pwsh'], { stdio: 'ignore' }).status === 0 } catch { return false }
}
function setAutostart(on) {
  if (SKIP_REG) return
  app.setLoginItemSettings({
    openAtLogin: on,
    path: process.execPath,
    args: app.isPackaged ? [] : [app.getAppPath()],
  })
  log(`autostart: ${on ? 'on' : 'off'}`)
}
function applyProtocol() {
  if (SKIP_REG) return
  if (process.defaultApp) app.setAsDefaultProtocolClient('dsh', process.execPath, [app.getAppPath()])
  else app.setAsDefaultProtocolClient('dsh')
  log('protocol: dsh:// registered')
}

// ---------- 壳设置入口：不再单开页面，直接带主窗口打开 DSH 自带设置面板 ----------
// 设置面板是 SPA 内的组件本地状态，外部触发 = 点击带 aria-haspopup="dialog" 的触发按钮
// （官方设置插件的稳定语义属性，CSS 模块哈希类名不可依赖）。
// 我们的壳设置项经 dsh-desktop-ui 客户端插件注册为面板里的"桌面"section。
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
// 壳级壁纸：不碰 DSH 源码，只在页面里注入一层 CSS。
// 关键认知（0.4.3，像素级探针实证）：vendor 锁定的 rc.6 SPA 不使用 --dsw-* 主题变量，
// 而是用写死的 rgb(21,21,23) 不透明背景铺满视口（.pI_x6G_frame / .wSkVaW_root 等
// CSS-modules 类）。只设 body 背景图 + 变量透明 = 注入成功但完全不可见。
// 因此必须把"单类名的 frame/root/centerCol"这些实打实的不透明层置透明，壁纸才会
// 从 body 透出来；侧栏（多类名 *_quietBars）与输入框卡片保持不透明，保证可读性。
// 图片必须经壳 admin 回环 HTTP 供给：Chromium 禁止 http 页面加载 file:// 本地资源
// （0.4.1 的根因），主流格式 jpg/jpeg/png/webp 均支持。
const BG_SCRIM = 'rgba(10, 12, 16, 0.35)' // 轻微暗化遮罩，保证浅色文字在亮图上可读
const BG_ALLOWED_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.ico']
const BG_BRIGHTNESS_RANGE = [0.2, 2] // 亮度倍数
const BG_BLUR_RANGE = [0, 40]        // 模糊半径 px

// 壁纸调参（亮度/模糊）：从 settings 读取并钳制到合法区间，缺省 1 / 0
function bgTuning() {
  const s = readSettings()
  const num = (v, lo, hi, dflt) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
  }
  return {
    brightness: num(s.bgBrightness, BG_BRIGHTNESS_RANGE[0], BG_BRIGHTNESS_RANGE[1], 1),
    blur: num(s.bgBlur, BG_BLUR_RANGE[0], BG_BLUR_RANGE[1], 0),
  }
}

function bgCssFor(filePath) {
  // ?t=mtime 破缓存；换图后立即生效
  let t = 0
  try { t = fs.statSync(filePath).mtimeMs } catch { /* 忽略 */ }
  const { brightness, blur } = bgTuning()
  const bleed = Math.ceil(blur * 2) // 模糊会让图层边缘发虚：固定层外扩 2×半径，避免四周露边
  const filter = (brightness !== 1 || blur > 0)
    ? `filter: brightness(${brightness})${blur > 0 ? ` blur(${blur}px)` : ''};`
    : ''
  // 0.4.6 全覆盖要点：壁纸放在 **position:fixed 的 body::before 固定层**（覆盖整个视口，
  // 与 body 盒子大小无关，也不会像 body 背景那样被裁剪），并 z-index:-1 压到内容之下。
  // 旧写法把图放在 body 上：body 盒子之外的区域会露出 html 的底色 —— 那就是"对话框底下那条黑条"。
  return `
    html { background-color: #101216 !important; }
    body { background-color: transparent !important; background-image: none !important; }
    body::before {
      content: ''; position: fixed; pointer-events: none; z-index: -1;
      top: -${bleed}px; right: -${bleed}px; bottom: -${bleed}px; left: -${bleed}px;
      background-image: linear-gradient(${BG_SCRIM}, ${BG_SCRIM}), url("http://127.0.0.1:${adminPort}/bg-image?t=${t}");
      background-size: cover; background-position: center; background-repeat: no-repeat;
      ${filter}
    }
    /* 实打实的不透明层 → 透明，让壁纸透出（单类名后缀定位，随锁定版本稳定） */
    #root > div,
    #root [class$="_frame"],
    #root [class$="_root"],
    #root [class$="_centerCol"] {
      background-color: transparent !important;
    }
    /* 主题变量：必须覆盖在**最近的定义处**。主题插件把深色别名定义在 body[data-ds-dark-theme]
       （--dsw-alias-bg-base = --dsw-static-neutral-bluish-950 = #151517），只写 :root 会被 body 顶掉，
       于是所有用 var(--dsw-alias-bg-base) 做背景的元素仍然不透明——这就是"对话框底下那条黑条"的根因。 */
    :root,
    body,
    body[data-ds-dark-theme],
    body[data-ds-light-theme] { --dsw-alias-bg-base: transparent !important; }
  `
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

// 发布源存在才启用自动更新/托盘检查（个人使用未配发布源时静默降级）
const HAS_UPDATE_SOURCE = app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))

// ---------- 托盘（M1b；菜单面精简，双击托盘 = 打开主窗） ----------
let tray = null
function spawnTray() {
  if (SMOKE || HEADLESS) return
  const icon = fs.existsSync(ICON_FILE) ? nativeImage.createFromPath(ICON_FILE) : nativeImage.createEmpty()
  tray = new Tray(icon)
  tray.setToolTip(APP_NAME)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '设置', click: () => openDshSettings() },
    { label: '数据目录', click: () => shell.openPath(APP_DATA) },
    { label: '工作区', click: () => shell.openPath(WS) },
    { type: 'separator' },
    { label: '重启宿主（重载插件）', click: () => restartHostManual().then((r) => log(r.ok ? `手动重启完成: ${r.webUrl}` : `手动重启失败: ${r.error}`)) },
    { label: '检查更新', enabled: HAS_UPDATE_SOURCE, click: () => autoUpdater.checkForUpdates().catch((e) => log(`update check: ${e.message}`)) },
    { type: 'separator' },
    { label: '退出', click: () => cleanup(0) },
  ]))
  tray.on('double-click', () => focusAction())
  log('tray: ready')
}

// ---------- 自动更新（M2；仅打包态启用，无 app-update.yml 时静默降级） ----------
function initUpdater() {
  if (!HAS_UPDATE_SOURCE) return
  try {
    autoUpdater.autoDownload = true
    autoUpdater.on('update-downloaded', () => {
      const n = new Notification({ title: APP_NAME, body: '新版本已下载，点击重启安装。' })
      n.on('click', () => autoUpdater.quitAndInstall())
      n.show()
    })
    autoUpdater.checkForUpdatesAndNotify().catch((e) => log(`update check: ${e.message}`))
  } catch (e) { log(`updater init: ${e.message}`) }
}

// ---------- 窗口（安全基线：评审稿 2.7） ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, show: false,
    title: APP_NAME,
    icon: fs.existsSync(ICON_FILE) ? ICON_FILE : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: DEV,
    },
  })
  win.once('ready-to-show', () => { if (!HEADLESS) win.show() })
  win.on('closed', () => { win = null })
  win.webContents.on('dom-ready', () => { applyBackgroundCss() })
  // close-to-tray：窗口关闭 → 隐藏到托盘（可配置），托盘"退出"才真正退出
  win.on('close', (event) => {
    if (quitting || HEADLESS) return
    if (readSettings().minimizeToTray !== false && tray) {
      event.preventDefault()
      win.hide()
      log('最小化到托盘，宿主保持运行')
    }
  })
  win.loadURL(readyUrl)
  // 拦截一切非本应用 origin 的导航与 window.open
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url) // 外链交给默认浏览器，绝不进壳内
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
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
  // 同一 DSH_HOME 已有活着的 host → 复用，不重复拉起
  // （否则两个宿主并发写会话日志会撞 seq，历史永久损坏）
  const existing = await findExistingHostUrl()
  if (existing) {
    webPort = Number(new URL(existing).port) || 0
    readyUrl = existing
    writeState({ webPort, webUrl: readyUrl, ready: true, reused: true })
    log(`复用已有 dsh host（DSH_HOME 已被占用）: ${existing}`)
    return
  }
  // 本壳将独占该 DSH_HOME：先修复"非计划关机/历史损坏"留下的坏日志，
  // 保证 rc.6 会话读取器能启动、历史会话可读（有其他 host 在跑时绝不碰这些文件）
  const repaired = repairSessionLogs(HOME, (msg) => log(msg))
  if (repaired.truncated || repaired.reencoded || repaired.quarantined) {
    log(`repair: 截断 ${repaired.truncated} / 重编码 ${repaired.reencoded} / 隔离 ${repaired.quarantined}`)
  }
  const port = await freePort()
  log(`boot: dsh web --host 127.0.0.1 --port ${port}`)
  log(`home: ${HOME}\nws:   ${WS}`)
  hostProc = startHost({ bin: dshBin(), home: HOME, ws: WS, port, patchFile: PATCH_FILE, logFile: HOST_LOG })
  hostProc.on('exit', (code) => {
    releaseHostLockIfOurs(hostProc.pid)
    if (quitting || seq !== bootSeq) return
    if (code === 3) {
      // profile 若重挂了单实例锁插件，第二个 host 会被拒（code=3）；
      // 重启流程会经 findExistingHostUrl 复用锁持有者，不会无限拉起。
      log('host 退出 (code=3：同一 DSH_HOME 已有实例)，重启流程将复用已有 host')
    } else {
      log(`host 退出 (code=${code})`)
    }
    const n = new Notification({ title: 'DSH 宿主意外退出', body: `exit code=${code}，正在自动重启宿主。` })
    n.on('click', () => restartHost())
    n.show()
    restartHost()
  })
  const url = await waitReady(port).catch((e) => {
    if (seq !== bootSeq) return null // 已被新一轮 boot 取代，丢弃旧探测
    throw e
  })
  if (url === null) return
  webPort = port
  readyUrl = url
  writeHostLock(hostProc.pid, port) // 就绪后补写锁（含端口），供后续窗口/实例探测复用
  writeState({ webPort, webUrl: readyUrl, ready: true })
  log(`ready: ${readyUrl}`)
}

/**
 * 手动重启宿主（托盘「重启宿主」与 POST /api/restart-host 共用）。
 * 与崩溃自动重启 restartHost() 的区别（这正是它单独存在的原因）：
 *   1) 用 stopHostGracefully 优雅停（等会话日志静止）而不是 killTree 硬杀，避免留半个 zstd 帧；
 *   2) 重置 restarts 计数——手动重启不该消耗"崩溃自动重启 ×N"的预算；
 *   3) 返回结构化结果，供 admin 端点与冒烟断言。
 */
let manualRestarting = false
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
    await bootHost()
    if (win && !win.isDestroyed() && readyUrl) win.loadURL(readyUrl)
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
// 壳层不再强杀第二实例：Electron 允许多窗口；但同一 DSH_HOME 必须只有一个 dsh web
// 进程（并发写会话日志会 seq 撞号、历史永久损坏，deepseek-ai/deepseek-harness #1452）。
// 本壳在自起 host 就绪后写 $DSH_HOME/.dsh-host.lock（含端口），启动前探测已有 host 并复用。
// 探测不走 WMI/CIM（可能被环境禁用）：netstat -ano 直接给出 pid→监听端口 映射。
const DEFAULT_WEB_PORT = 3080

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

// netstat -ano -p tcp 输出里某 pid 的全部 LISTENING 端口
function listeningPortsOf(pid) {
  const ports = new Set()
  try {
    const r = spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true })
    for (const line of (r.stdout || '').split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue
      const parts = line.trim().split(/\s+/)
      if (parts.length < 5) continue
      if (Number(parts[parts.length - 1]) !== pid) continue
      const m = /:(\d{1,5})$/.exec(parts[1] || '')
      if (m) ports.add(Number(m[1]))
    }
  } catch { /* netstat 不可用则跳过 */ }
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

// 只采纳"本 DSH_HOME 的锁"指向的宿主（锁文件就在 $DSH_HOME 下，天然同 home）。
// 无锁候选一律不采纳：HTTP 面无法验证对方 DSH_HOME，错接其他 home 的宿主
// 比自起宿主更糟；正常场景下锁由 host 侧登记插件（dsh-host-lock-registry）
// 或本壳自起宿主时刷新，始终存在。
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

// ---------- admin actions ----------
async function focusAction() {
  if (HEADLESS || SMOKE) return { ok: true, note: 'headless（不拉起窗口）' }
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return { ok: true, note: 'focus' } }
  if (readyUrl) { createWindow(); return { ok: true, note: 'relaunch' } }
  return { ok: false, note: 'host 尚未就绪' }
}
// 诊断：列出窗口里"不透明背景"的元素（默认只看视口底部 25%）。用于壁纸/皮肤类改动定位遮挡层，
// 是"注入成功但看不见"（坑 3b）这类问题的现场取证工具。只读，且只在回环 admin 上暴露。
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

function statusPayload() {
  const s = readSettings()
  return {
    ok: true, name: APP_NAME, version: readVersion(), pid: process.pid,
    mode: readState().mode || 'windowed', adminPort, webPort, webUrl: readyUrl, ready: !!readyUrl,
    home: HOME, ws: WS, autostart: !!s.autostart, minimizeToTray: s.minimizeToTray !== false,
    backgroundImage: s.backgroundImage || '',
    bgBrightness: bgTuning().brightness, bgBlur: bgTuning().blur,
    dshBin: dshBin(), engine: 'Electron', electron: process.versions.electron, node: process.versions.node,
    pwsh: ps7Available(), restarts,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    // DSH 更新快照内嵌：客户端已有 5 秒轮询 /api/status，更新进度复用它，不新增一条轮询。
    dshUpdate: dshUpdateSnapshot(),
  }
}

// ---------- DSH 更新（计划书 S3） ----------
// 状态常驻主进程：构建是分钟级后台任务，UI 靠 /api/status 的 5 秒轮询读快照。
// 只维护"阶段"不做百分比——npm 的进度百分比对它自己才有意义，透出来只会误导。
// phase: idle | checking | building | ready | applying | failed
const dshUpdate = { phase: 'idle', error: null, current: null, latest: null, target: null, hasUpdate: false, npmOk: null, startedAt: null, finishedAt: null }
let dshUpdateBusy = false
let dshCurrentCache = null

/** 当前已安装版本（缓存；换树与检查更新后失效重建）。 */
function dshCurrentVersions() {
  if (dshCurrentCache === null) dshCurrentCache = readCurrentVersions(VENDOR_PROFILE)
  return dshCurrentCache
}

/** 只读快照：/api/status 内嵌与 GET /api/dsh/status 共用。必须廉价（每 5 秒被调一次）。 */
function dshUpdateSnapshot() {
  const inst = dshUpdate.current ?? dshCurrentVersions()
  const pending = readPending(APP_DATA)
  if (dshUpdate.npmOk === null) dshUpdate.npmOk = findNpm() !== null
  const ver = inst['@deepseek-ai/dsh'] ?? null
  let hint
  if (dshUpdate.phase === 'failed') hint = `上次操作失败：${dshUpdate.error ?? '未知原因'}`
  else if (dshUpdate.phase === 'building') hint = `正在构建 ${dshUpdate.target ?? ''}（分钟级，请勿关闭应用）`
  else if (dshUpdate.phase === 'ready') hint = `已构建完成，重启应用后生效（${dshUpdate.target ?? ''}）`
  else if (pending !== null) hint = `有待应用的更新 ${pending.target}（重启应用生效）`
  else if (!dshUpdate.npmOk) hint = '未找到系统 Node.js（本应用不内置 npm），更新功能不可用'
  else if (dshUpdate.latest === null) hint = `已安装 ${ver ?? '未知'}（点“检查更新”查询最新版）`
  else if (dshUpdate.hasUpdate) hint = `可更新到 ${dshUpdate.target}（当前 ${ver ?? '未知'}）`
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
    hint,
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
    const r = await checkForUpdate({ profileDir: VENDOR_PROFILE, log })
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

/**
 * 启动暂存构建。**立即返回**——构建是分钟级任务，await 它会撞上 admin 请求超时、也会把连接挂死。
 * 进度由客户端轮询 /api/status 里的 dshUpdate 快照获得。
 * @param {string} version 目标版本（必须是"检查更新"查回来的那一个）
 */
function dshUpdateTo(version) {
  if (dshUpdateBusy) return { ok: false, error: '已有更新任务在进行中，请稍候' }
  const target = (String(version ?? '').trim()) || dshUpdate.target || ''
  if (target === '') return { ok: false, error: '未指定目标版本，请先“检查更新”' }
  // 只接受"检查更新"查回来过的精确版本：绝不把任意字符串拼进 npm 依赖（供应链面）。
  if (dshUpdate.target !== null && target !== dshUpdate.target) {
    return { ok: false, error: `目标 ${target} 与已查得的最新版 ${dshUpdate.target} 不一致，请重新“检查更新”` }
  }
  if (findNpm() === null) {
    dshUpdate.npmOk = false
    return { ok: false, error: '未找到系统 Node.js（本应用不内置 npm）：请先安装 Node.js，或设置 DSH_NODE_DIR' }
  }
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
      fs.rmSync(stagingRoot, { recursive: true, force: true })
      const built = await buildStaging({
        stagingRoot,
        versions,
        packagesDir,
        cacheDir: path.join(APP_DATA, '.npm-cache'),
        runtime: process.execPath,   // Electron 内建 Node（ELECTRON_RUN_AS_NODE 由 vendor-build 自己设）
        logFile: path.join(LOG_DIR, 'dsh-update.log'),
        log,
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

/**
 * 写标记后重启应用——换树发生在新进程启动的**最早期**（见 main() 里的调用点与 dshBin() 的注释）。
 * @returns {{ok:boolean, error?:string, restarting?:boolean, target?:string}}
 */
function dshApply() {
  const pending = readPending(APP_DATA)
  if (pending === null) return { ok: false, error: '没有待应用的更新（请先执行“更新”）' }
  dshUpdate.phase = 'applying'
  log(`[dsh-update] 用户确认重启以应用更新：${pending.target}`)
  // 先让 HTTP 响应送达，再重启；cleanup 负责优雅停宿主并释放 host 锁，
  // 否则新进程会复用旧宿主（那么"换了树"其实没生效）。
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
  const winBuild = Number(os.release().split('.')[2] || 0)
  add('Windows 版本', winBuild >= 19045, `build ${os.release()}${winBuild >= 19045 ? '' : '（需 Win10 22H2 及以上）'}`)
  add('窗口引擎', true, `Electron ${process.versions.electron}（内建 Node ${process.versions.node} / Chromium ${process.versions.chrome}）`)
  add('dsh CLI', !!dshBin(), dshBin() || '未找到（全局 npm / npx 缓存 / vendor）')
  const pwshOk = ps7Available()
  add('PowerShell 7 (agent 工具)', pwshOk, pwshOk ? '已安装' : '缺失！运行: winget install Microsoft.PowerShell')
  add('DSH_HOME', fs.existsSync(HOME), HOME)
  add('工作区', fs.existsSync(WS) || (() => { try { fs.mkdirSync(WS, { recursive: true }); return true } catch { return false } })(), WS)
  let freeMb = -1
  try { freeMb = Math.round(fs.statfsSync(APP_DATA).bavail * fs.statfsSync(APP_DATA).bsize / 1048576) } catch { /* 忽略 */ }
  add('磁盘剩余', freeMb > 200, freeMb > 0 ? `${freeMb} MB` : '未知')
  console.log(`\n[DSH Desktop ${readVersion()} doctor]`)
  for (const r of rows) console.log(`  ${r.ok ? '[OK]  ' : '[FAIL]'} ${r.name}: ${r.detail}`)
  const failed = rows.filter((r) => !r.ok)
  console.log(failed.length ? `\n${failed.length} 项未通过: ${failed.map((r) => r.name).join(' / ')}` : '\n全部通过')
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

// 完整退出：Windows 下隐藏子进程收不到真实信号，先等会话日志静止
// （写批全部落盘、文件停在帧边界），再结束宿主进程树——不再"写一半就杀"。
// 即使极端情况仍留下半个帧，启动前 repairSessionLogs 也会兜底修复。
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
  clearState()
  app.exit(code)
}
process.on('SIGINT', () => cleanup(130))
process.on('SIGTERM', () => cleanup(143))
app.on('window-all-closed', () => cleanup(0))

// ---------- 主流程 ----------
// 把 dsh-desktop-ui 插件同步到 profile 的 out-of-tree 插件位（$DSH_HOME/profiles/web/node_modules）。
// 实证：loader 对条目做 ESM 解析的基准是 profile 目录本身（不是安装包父级），
// 打包态 vendor 里的副本不会自动被解析到——必须落到 profile 插件位。
// 源：打包态 = resources/vendor/profile 内副本；开发态 = packages/ 源码。每次启动幂等同步。
// ---------- 自带插件供给 ----------
// 两个插件都随包分发（build-host 会把 packages/* 拷进 vendor/profile/node_modules），
// 壳每次启动把它们幂等同步到 profile 的 out-of-tree 插件位：
//   · dsh-desktop-ui   —— 客户端插件（设置面板"桌面"section）
//   · dsh-auto-approval—— Host 插件（审批瀑布风险分级，经 cordis.patch.yml 的 insert 行挂载）
// 实证：loader 对条目做 ESM 解析的基准是 profile 目录本身（不是安装包父级），
// 打包态 vendor 里的副本不会自动被解析到——必须落到 profile 插件位。
const PROFILE_PLUGIN_NAMES = ['dsh-desktop-ui', 'dsh-auto-approval']
const PACKAGES_DIR = app.isPackaged ? path.join(VENDOR_PROFILE, 'node_modules') : path.join(ROOT_DIR, 'packages')
const PROFILE_DIR = path.join(HOME, 'profiles', 'web')
const PROFILE_PATCH = path.join(PROFILE_DIR, 'cordis.patch.yml')

function pluginSourceDir(name) {
  return app.isPackaged ? path.join(VENDOR_PROFILE, 'node_modules', name) : path.join(ROOT_DIR, 'packages', name)
}

/** 把包同步到 profile 插件位（幂等：整目录替换，避免残留旧文件）。 */
function syncProfilePlugin(name) {
  const src = pluginSourceDir(name)
  if (!fs.existsSync(path.join(src, 'package.json'))) { log(`插件包缺失: ${src}`); return false }
  const dst = path.join(PROFILE_DIR, 'node_modules', name)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.rmSync(dst, { recursive: true, force: true })
  fs.cpSync(src, dst, { recursive: true })
  return true
}

/**
 * 确保 profile 用户补丁层里有该 Host 插件的 insert 行（幂等，只追加不改动用户已有内容）。
 * 补丁层是热加载的：首次落上后宿主无需重启即可装载；但**插件源码改动不会热加载**（ESM 缓存），
 * 所以改插件代码后要么重启宿主（托盘「重启宿主」），要么改动补丁行触发重载。
 */
function ensureProfilePluginMount(name, comment) {
  try {
    fs.mkdirSync(path.join(PROFILE_DIR, 'node_modules'), { recursive: true })
    let cur = ''
    try { cur = fs.readFileSync(PROFILE_PATCH, 'utf8') } catch { cur = '# dsh profile patch layer\n' }
    if (new RegExp(`(^|\\s)(id|name):\\s*${name}\\s*$`, 'm').test(cur)) return false
    const block = `\n# ${comment}\n- insert:\n    - id: ${name}\n      name: ${name}\n`
    fs.writeFileSync(PROFILE_PATCH, cur.trimEnd() + '\n' + block)
    log(`已把 ${name} 写入 profile 补丁层: ${PROFILE_PATCH}`)
    return true
  } catch (e) { log(`补丁层写入失败(${name}): ${e.message}`); return false }
}

function ensureProfilePlugins() {
  for (const name of PROFILE_PLUGIN_NAMES) syncProfilePlugin(name)
  ensureProfilePluginMount('dsh-auto-approval', 'AI 自检权限申请：审批瀑布前置分级，低风险自动放行、高风险仍问用户（配置在 settings.yaml 的 auto-approval 段；开关 /approval on|off）')
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
      spawn('notepad.exe', [p], { detached: true, stdio: 'ignore' }).unref()
      return { ok: true, fallback: 'notepad', note: err }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// 原生目录选择：设置面板"浏览…"按钮。选完即落地工作区（服务端一步完成，
// 避免客户端二次请求；headless/冒烟不弹窗）。
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

async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  rotateLogs()
  const settings = readSettings()
  if (settings.workspace) WS = settings.workspace
  fs.mkdirSync(WS, { recursive: true })

  // CLI 快捷命令（不启动宿主）
  if (args.includes('--version')) { console.log(readVersion()); app.exit(0); return }
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
  if (DOCTOR) { runDoctor(); app.exit(0); return }

  // 待应用的 DSH 更新必须在 dshBin() **首次求值之前**落地（就在下面两行处）。
  // 换树会把旧树改名走开；若先求值，dshBin() 会缓存住失效路径，表现为"更新成功但应用再也起不来"。
  // 放在 CLI 快捷命令（--version/--doctor 等）之后：那些命令不该触发换树。
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

  // 多窗口：不设 Electron 单实例锁——可同时开多个壳窗口，全部经 bootHost 共用同一 dsh host。
  // 会话日志安全由宿主复用（findExistingHostUrl / .dsh-host.lock）保证，而非进程级互斥。

  if (!DEV) Menu.setApplicationMenu(null)
  // 通知权限白名单（SPA 的 Notification API）
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
      dshCheck,
      dshUpdate: dshUpdateTo,
      dshApply,
      diagOpaqueLayers,
      pickBackground: pickBackgroundImage,
      quit: (code) => cleanup(code),
    },
    staticFiles: { settingsHtml: SETTINGS_HTML, icon: fs.existsSync(ICON_FILE) ? ICON_FILE : undefined },
  })
  adminPort = await listenAdmin(adminServer, ADMIN_PORT)
  if (adminPort !== ADMIN_PORT) log(`admin 端口 ${ADMIN_PORT} 被占用，回退 ${adminPort}（设置面板将显示"壳未响应"）`)
  writeState({ adminPort, mode: HEADLESS ? 'headless' : 'windowed', startedAt: new Date().toISOString(), version: readVersion(), home: HOME, ws: WS, dshBin: dshBin(), engine: 'Electron' })

  if (!SKIP_REG) { setAutostart(!!settings.autostart); applyProtocol() }

  ensureProfilePlugins()

  try {
    await bootHost()
    if (SMOKE) { log('SMOKE OK'); cleanup(0); return }
    // 宿主起来了 = 新树确认可用 → **现在才**删旧树（Q4 决定不做回滚，故这里是删除时机而非回滚功能）。
    // 无条件尝试：上一轮可能因宿主仍占用文件而没删成，本轮补齐。失败非致命，下次启动再试。
    const cleanedTrees = cleanupOldTrees(VENDOR_DIR, log)
    if (cleanedTrees > 0) log(`DSH 更新：清理遗留旧树 ${cleanedTrees} 项`)
    createWindow()
    spawnTray()
    initUpdater()
    if (HEADLESS) { log(`HEADLESS 就绪: http://127.0.0.1:${adminPort}/`); return }
    log('窗口已打开')
  } catch (e) {
    log(`启动失败: ${e.message}`)
    cleanup(1)
  }
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1) })
