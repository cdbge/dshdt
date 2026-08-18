// DSH Desktop — Electron 主进程（M1a，施工计划阶段 2）
// 单实例锁 → admin 服务 → host（模式 B：RUN_AS_NODE + --expose-internals）→ 就绪探测
// → BrowserWindow 加载 loopback（走既有信任栅栏，DSH 零改动）→ 崩溃联动/通知 → 退出编排。
// 迁移自 v1 desktop-shell/launcher.mjs：admin API 面、settings/app.state 格式、
// --smoke/--headless/--doctor/--autostart/--set-ws CLI 语义全部保持（双分支契约一致）。
import { app, BrowserWindow, Menu, Notification, shell, session } from 'electron'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAdminServer, listenAdmin } from './admin.mjs'
import { findDshBin, freePort, waitReady, killTree, startHost } from './host.mjs'

const APP_NAME = 'DSH Desktop'
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
const VERSION_FILE = path.join(ROOT_DIR, 'VERSION')
const PATCH_FILE = path.join(APP_DIR, 'desktop.patch.yml')
const SETTINGS_HTML = path.join(APP_DIR, 'settings.html')
const ICON_FILE = path.join(ROOT_DIR, 'build', 'icon.ico')
const HOST_LOG = path.join(LOG_DIR, 'host.log')
const DSH_BIN = findDshBin([path.join(ROOT_DIR, 'vendor', 'profile')])

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
  const port = await freePort()
  log(`boot: dsh web --host 127.0.0.1 --port ${port}`)
  log(`home: ${HOME}\nws:   ${WS}`)
  hostProc = startHost({ bin: DSH_BIN, home: HOME, ws: WS, port, patchFile: PATCH_FILE, logFile: HOST_LOG })
  hostProc.on('exit', (code) => {
    if (quitting || seq !== bootSeq) return
    log(`host 退出 (code=${code})`)
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
    if (hostProc) killTree(hostProc.pid)
    readyUrl = null
    await bootHost()
    if (win && !win.isDestroyed()) win.loadURL(readyUrl)
  } catch (e) {
    log(`host 重启失败: ${e.message}`)
    cleanup(1)
  }
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
    dshBin: DSH_BIN, engine: 'Electron', electron: process.versions.electron, node: process.versions.node,
    pwsh: ps7Available(), restarts,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
  }
}

// ---------- doctor ----------
function runDoctor() {
  const rows = []
  const add = (name, ok, detail) => rows.push({ name, ok, detail })
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
function cleanup(code = 0) {
  if (quitting) return
  quitting = true
  log(`cleanup: code=${code}`)
  if (hostProc) killTree(hostProc.pid)
  try { adminServer?.close() } catch { /* 已关 */ }
  clearState()
  app.exit(code)
}
process.on('SIGINT', () => cleanup(130))
process.on('SIGTERM', () => cleanup(143))
app.on('window-all-closed', () => cleanup(0))

// ---------- 主流程 ----------
async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true })
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
    console.log('registered'); app.exit(0); return
  }
  if (DOCTOR) { runDoctor(); app.exit(0); return }

  if (!DSH_BIN) { console.error('[DSH Desktop] 找不到 dsh CLI (bin.js)，请检查安装'); app.exit(2); return }

  // 单实例锁
  if (!app.requestSingleInstanceLock()) { app.quit(); return }
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus() }
  })

  if (!DEV) Menu.setApplicationMenu(null)
  // 通知权限白名单（SPA 的 Notification API）
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(permission === 'notifications'))

  adminServer = createAdminServer({
    log, readSettings, writeSettings, statusPayload,
    actions: {
      setAutostart,
      focus: focusAction,
      openDataDir: () => shell.openPath(APP_DATA),
      openWorkspace: () => shell.openPath(WS),
      openSettings: () => shell.openExternal(`http://127.0.0.1:${adminPort}/`),
      quit: (code) => cleanup(code),
    },
    staticFiles: { settingsHtml: SETTINGS_HTML, icon: fs.existsSync(ICON_FILE) ? ICON_FILE : undefined },
  })
  adminPort = await listenAdmin(adminServer)
  writeState({ adminPort, mode: HEADLESS ? 'headless' : 'windowed', startedAt: new Date().toISOString(), version: readVersion(), home: HOME, ws: WS, dshBin: DSH_BIN, engine: 'Electron' })

  if (!SKIP_REG) setAutostart(!!settings.autostart)

  try {
    await bootHost()
    if (SMOKE) { log('SMOKE OK'); cleanup(0); return }
    createWindow()
    if (HEADLESS) { log(`HEADLESS 就绪: http://127.0.0.1:${adminPort}/`); return }
    log('窗口已打开')
  } catch (e) {
    log(`启动失败: ${e.message}`)
    cleanup(1)
  }
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1) })
