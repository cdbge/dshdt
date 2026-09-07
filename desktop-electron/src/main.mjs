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
const DSH_BIN = findDshBin([VENDOR_PROFILE])

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
// 壳级壁纸：不碰 DSH 源码，只在页面里注入一层 CSS——
// 图片铺在 body 上，并把应用基底背景变量（--dsw-alias-bg-base）置透明，
// 侧栏/面板/卡片仍用自己的填充色，可读性不受影响。深浅色主题都适用。
// 图片必须经壳 admin 回环 HTTP 供给：Chromium 禁止 http 页面加载 file:// 本地资源
// （0.4.1 在朋友机器上背景不显示的根因），主流格式 jpg/jpeg/png/webp 均支持。
const BG_SCRIM = 'rgba(10, 12, 16, 0.35)' // 轻微暗化遮罩，保证浅色文字在亮图上可读
const BG_ALLOWED_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif', '.ico']

function bgCssFor(filePath) {
  // ?t=mtime 破缓存；换图后立即生效
  let t = 0
  try { t = fs.statSync(filePath).mtimeMs } catch { /* 忽略 */ }
  return `
    html { background-color: #101216 !important; }
    body {
      background-image: linear-gradient(${BG_SCRIM}, ${BG_SCRIM}), url("http://127.0.0.1:${adminPort}/bg-image?t=${t}") !important;
      background-size: cover !important;
      background-position: center !important;
      background-repeat: no-repeat !important;
      background-attachment: fixed !important;
    }
    :root { --dsw-alias-bg-base: transparent !important; }
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
  hostProc = startHost({ bin: DSH_BIN, home: HOME, ws: WS, port, patchFile: PATCH_FILE, logFile: HOST_LOG })
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
function statusPayload() {
  const s = readSettings()
  return {
    ok: true, name: APP_NAME, version: readVersion(), pid: process.pid,
    mode: readState().mode || 'windowed', adminPort, webPort, webUrl: readyUrl, ready: !!readyUrl,
    home: HOME, ws: WS, autostart: !!s.autostart, minimizeToTray: s.minimizeToTray !== false,
    backgroundImage: s.backgroundImage || '',
    dshBin: DSH_BIN, engine: 'Electron', electron: process.versions.electron, node: process.versions.node,
    pwsh: ps7Available(), restarts,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
  }
}

// ---------- doctor ----------
function runDoctor() {
  const rows = []
  const add = (name, ok, detail) => rows.push({ name, ok, detail })
  const winBuild = Number(os.release().split('.')[2] || 0)
  add('Windows 版本', winBuild >= 19045, `build ${os.release()}${winBuild >= 19045 ? '' : '（需 Win10 22H2 及以上）'}`)
  add('窗口引擎', true, `Electron ${process.versions.electron}（内建 Node ${process.versions.node} / Chromium ${process.versions.chrome}）`)
  add('dsh CLI', !!DSH_BIN, DSH_BIN || '未找到（全局 npm / npx 缓存 / vendor）')
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
const PLUGIN_SRC = app.isPackaged
  ? path.join(VENDOR_PROFILE, 'node_modules', 'dsh-desktop-ui')
  : path.join(ROOT_DIR, 'packages', 'dsh-desktop-ui')
function ensureProfilePlugin() {
  try {
    if (!fs.existsSync(path.join(PLUGIN_SRC, 'package.json'))) {
      log(`插件包缺失: ${PLUGIN_SRC}`)
      return
    }
    const dst = path.join(HOME, 'profiles', 'web', 'node_modules', 'dsh-desktop-ui')
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.rmSync(dst, { recursive: true, force: true })
    fs.cpSync(PLUGIN_SRC, dst, { recursive: true })
  } catch (e) { log(`profile 插件同步失败: ${e.message}`) }
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

  if (!DSH_BIN) {
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
      pickBackground: pickBackgroundImage,
      quit: (code) => cleanup(code),
    },
    staticFiles: { settingsHtml: SETTINGS_HTML, icon: fs.existsSync(ICON_FILE) ? ICON_FILE : undefined },
  })
  adminPort = await listenAdmin(adminServer, ADMIN_PORT)
  if (adminPort !== ADMIN_PORT) log(`admin 端口 ${ADMIN_PORT} 被占用，回退 ${adminPort}（设置面板将显示"壳未响应"）`)
  writeState({ adminPort, mode: HEADLESS ? 'headless' : 'windowed', startedAt: new Date().toISOString(), version: readVersion(), home: HOME, ws: WS, dshBin: DSH_BIN, engine: 'Electron' })

  if (!SKIP_REG) { setAutostart(!!settings.autostart); applyProtocol() }

  ensureProfilePlugin()

  try {
    await bootHost()
    if (SMOKE) { log('SMOKE OK'); cleanup(0); return }
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
