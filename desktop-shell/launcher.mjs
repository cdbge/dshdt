// DSH Desktop Shell — Stage 3 (Node + Chrome app-mode, Chromium engine)
// Stage 1: 空闲端口 → spawn `dsh web --port N` → 等就绪 → Chrome 内嵌窗口加载
// Stage 2: settings.json 存储、开机自启(注册表)、dsh:// 协议注册、深链参数、--smoke
// Stage 3: admin HTTP 服务 + 壳内设置页、托盘托管、通知预授权、单实例聚焦转发、
//          close-to-tray、host 崩溃通知、--doctor、--headless、安装/注册 CLI
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ---------- 路径解析（仅 Chrome，避免 Edge 相关使用） ----------
const BROWSER_CANDIDATES = [
  process.env.ProgramFiles + '\\Google\\Chrome\\Application\\chrome.exe',
  process.env['ProgramFiles(x86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
]
const BROWSER = BROWSER_CANDIDATES.find((p) => fs.existsSync(p))

function findDshBin() {
  if (process.env.DSH_BIN && fs.existsSync(process.env.DSH_BIN)) return process.env.DSH_BIN
  const roots = [path.join(process.env.APPDATA, 'npm'), 'C:\\Program Files\\nodejs']
  for (const root of roots) {
    const p = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (fs.existsSync(p)) return p
  }
  const npxRoot = path.dirname(process.execPath)
  const cache = path.join(npxRoot, 'node_cache', '_npx')
  if (fs.existsSync(cache)) {
    const hits = []
    for (const entry of fs.readdirSync(cache)) {
      const p = path.join(cache, entry, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      if (fs.existsSync(p)) hits.push({ p, t: fs.statSync(p).mtimeMs })
    }
    hits.sort((a, b) => b.t - a.t)
    if (hits.length) return hits[0].p
  }
  return null
}
const DSH_BIN = findDshBin()

// ---------- 路径与常量 ----------
const APP_NAME = 'DSH Desktop'
const APP_DIR = path.dirname(fileURLToPath(import.meta.url))
const APP_DATA = process.env.DSH_APP_DATA || path.join(process.env.LOCALAPPDATA, 'DSHDesktop')
const HOME = process.env.DSH_HOME || (fs.existsSync(path.join(os.homedir(), '.dsh')) ? path.join(os.homedir(), '.dsh') : path.join(APP_DATA, 'dsh-home'))
let WS = process.env.DSH_WS || path.join(os.homedir(), 'DSH-Workspace')
const BROWSER_PROFILE = path.join(APP_DATA, 'browser-profile')
const LOG_DIR = path.join(APP_DATA, 'logs')
const LOCK = path.join(APP_DATA, 'app.lock')
const STATE_FILE = path.join(APP_DATA, 'app.state.json')
const SETTINGS_FILE = path.join(APP_DATA, 'settings.json')
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const RUN_VALUE = 'DSHDesktop'
const PROTO_ROOT = 'HKCU\\Software\\Classes\\dsh'
const VERSION_FILE = path.join(APP_DIR, 'VERSION')
const PS5 = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

const args = process.argv.slice(2)
const SMOKE = args.includes('--no-window') || args.includes('--smoke')
const HEADLESS = args.includes('--headless')
const NO_TRAY = args.includes('--no-tray') || SMOKE || HEADLESS
const DOCTOR = args.includes('--doctor')
const SKIP_REG = process.env.DSH_SMOKE === '1' // 冒烟测试不写注册表

let readyUrl = null
let webPort = 0
let adminPort = 0
let adminServer = null
let hostProc = null
let browserProc = null
let trayProc = null
let quitting = false
const startedAt = Date.now()

function readVersion() {
  try { return fs.readFileSync(VERSION_FILE, 'utf8').trim() } catch { return '0.0.0-dev' }
}

// ---------- 设置 / 状态 / 注册表 ----------
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

function reg(cmd) { spawnSync('reg', cmd, { stdio: 'ignore', windowsHide: true }) }
function regQuery(...parts) {
  const r = spawnSync('reg', ['query', ...parts], { windowsHide: true, encoding: 'utf8' })
  return r.status === 0 ? (r.stdout || '') : ''
}
function applyAutostart(on) {
  if (SKIP_REG) return
  const vbs = path.join(APP_DIR, 'autostart.vbs')
  if (on) {
    fs.writeFileSync(vbs, `Set sh = CreateObject("WScript.Shell")\r\nsh.Run """${path.join(APP_DIR, 'run.cmd')}""", 0, False\r\n`)
    reg(['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', `wscript.exe "${vbs}"`, '/f'])
    log(`autostart: on (${vbs})`)
  } else {
    reg(['delete', RUN_KEY, '/v', RUN_VALUE, '/f'])
    try { fs.unlinkSync(vbs) } catch { /* 无 vbs */ }
    log('autostart: off')
  }
}
function applyProtocol() {
  if (SKIP_REG) return
  reg(['add', PROTO_ROOT, '/ve', '/d', 'URL:DSH Desktop', '/f'])
  reg(['add', PROTO_ROOT, '/v', 'URL Protocol', '/d', '', '/f'])
  reg(['add', PROTO_ROOT + '\\shell\\open\\command', '/ve', '/d', `"${path.join(APP_DIR, 'run.cmd')}" "%1"`, '/f'])
  log('protocol: dsh:// registered')
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { fs.appendFileSync(path.join(LOG_DIR, 'app.log'), line) } catch { /* 日志目录不可写 */ }
  console.log(line.trimEnd())
}

// ---------- 辅助进程（全部走系统 PowerShell 5.1，WinForms 最稳） ----------
function ps(scriptArgs, detached = false) {
  const p = spawn(PS5, ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...scriptArgs], {
    detached, stdio: 'ignore', windowsHide: true,
  })
  if (detached) { try { p.unref() } catch { /* 无需 */ } }
  return p
}
function notify(title, message) {
  try {
    ps(['-File', path.join(APP_DIR, 'notify.ps1'), '-Title', title, '-Message', message, '-Icon', path.join(APP_DIR, 'icon.ico')], true)
    log(`notify: ${title} — ${message}`)
  } catch (e) { log(`notify 失败: ${e.message}`) }
}
function spawnTray() {
  if (NO_TRAY || !fs.existsSync(path.join(APP_DIR, 'tray.ps1'))) return
  trayProc = ps(['-File', path.join(APP_DIR, 'tray.ps1'), '-State', STATE_FILE, '-AdminPort', String(adminPort), '-Name', APP_NAME, '-Icon', path.join(APP_DIR, 'icon.ico')], true)
  log(`tray: pid=${trayProc.pid}`)
}
function openExplorer(dir) {
  try { spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref() } catch { /* 忽略 */ }
}
function openBrowser(url) {
  try { spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref() } catch { /* 忽略 */ }
}
function ps7Available() {
  try { return spawnSync('where', ['pwsh'], { stdio: 'ignore' }).status === 0 } catch { return false }
}
function psFocus() {
  // 按浏览器 profile 路径精确定位 Chrome 窗口并前置
  const profile = BROWSER_PROFILE.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
  const script =
    `$c = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match '${profile}' } | Select-Object -First 1; ` +
    `if ($c) { $w = New-Object -ComObject WScript.Shell; [void]$w.AppActivate($c.ProcessId) }`
  ps(['-Command', script], true)
}

// ---------- CLI 快捷命令（不启动宿主） ----------
if (args.includes('--version')) { console.log(readVersion()); process.exit(0) }
if (args.includes('--register')) {
  if (!SKIP_REG) { applyAutostart(!!readSettings().autostart); applyProtocol() }
  console.log('registered'); process.exit(0)
}
if (args.includes('--autostart')) {
  const v = args[args.indexOf('--autostart') + 1]
  if (v === 'on' || v === 'off') {
    const s = readSettings(); s.autostart = v === 'on'
    writeSettings(s); applyAutostart(s.autostart)
    process.exit(0)
  }
  console.error('用法: --autostart on|off'); process.exit(2)
}
if (args.includes('--set-ws')) {
  const p = args[args.indexOf('--set-ws') + 1]
  if (p && path.isAbsolute(p)) {
    try { fs.mkdirSync(p, { recursive: true }) } catch (e) { console.error(`目录不可用: ${e.message}`); process.exit(2) }
    const s = readSettings(); s.workspace = p
    writeSettings(s); console.log(`workspace: ${p}`); process.exit(0)
  }
  console.error('用法: --set-ws <绝对路径>'); process.exit(2)
}
if (DOCTOR) {
  runDoctor()
  process.exit(0)
}

// ---------- 空闲端口 / 就绪探测 / 进程树 ----------
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
    srv.on('error', reject)
  })
}
async function waitReady(port, timeoutMs = 30000) {
  const url = `http://127.0.0.1:${port}/`
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return url
    } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`host 未在 ${timeoutMs}ms 内就绪`)
}
function killTree(pid) {
  try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已退出 */ }
}

// ---------- admin HTTP 服务（127.0.0.1 仅回环） ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 65536) { reject(new Error('body too large')); req.destroy() } })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}
function json(res, code, obj) {
  const s = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s), 'Cache-Control': 'no-store' })
  res.end(s)
}
function statusPayload() {
  const s = readSettings()
  return {
    ok: true, name: APP_NAME, version: readVersion(), pid: process.pid,
    mode: readState().mode || 'windowed', adminPort, webPort, webUrl: readyUrl, ready: !!readyUrl,
    home: HOME, ws: WS, autostart: !!s.autostart, minimizeToTray: s.minimizeToTray !== false,
    dshBin: DSH_BIN, browser: BROWSER, node: process.version, pwsh: ps7Available(),
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
  }
}
function focusAction() {
  if (HEADLESS) return { ok: true, note: 'headless（不拉起窗口）' }
  if (browserProc && browserProc.exitCode === null) { psFocus(); return { ok: true, note: 'focus' } }
  if (readyUrl) { spawnChrome(); return { ok: true, note: 'relaunch' } }
  return { ok: false, note: 'host 尚未就绪' }
}

async function startAdmin() {
  adminServer = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    try {
      if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/settings.html')) {
        const html = fs.readFileSync(path.join(APP_DIR, 'settings.html'))
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(html)
        return
      }
      if (req.method === 'GET' && u.pathname === '/icon.ico') {
        const ico = fs.readFileSync(path.join(APP_DIR, 'icon.ico'))
        res.writeHead(200, { 'Content-Type': 'image/x-icon' })
        res.end(ico)
        return
      }
      if (req.method === 'GET' && u.pathname === '/health') { return json(res, 200, { ok: true, pid: process.pid }) }
      if (req.method === 'GET' && u.pathname === '/api/status') { return json(res, 200, statusPayload()) }
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        switch (u.pathname) {
          case '/api/autostart': {
            const s = readSettings(); s.autostart = !!body.on
            writeSettings(s); applyAutostart(s.autostart)
            return json(res, 200, { ok: true, autostart: s.autostart })
          }
          case '/api/settings': {
            const s = readSettings()
            for (const k of ['minimizeToTray', 'warnedPs7']) if (typeof body[k] === 'boolean') s[k] = body[k]
            writeSettings(s)
            return json(res, 200, { ok: true, settings: s })
          }
          case '/api/workspace': {
            const p = String(body.path || '').trim()
            if (!p || !path.isAbsolute(p)) return json(res, 400, { ok: false, error: '需要绝对路径' })
            try { fs.mkdirSync(p, { recursive: true }) } catch (e) { return json(res, 400, { ok: false, error: `目录不可用: ${e.message}` }) }
            const s = readSettings(); s.workspace = p; writeSettings(s); WS = p
            log(`workspace: ${p}`)
            return json(res, 200, { ok: true, workspace: p })
          }
          case '/api/focus': return json(res, 200, focusAction())
          case '/api/open-data-dir': openExplorer(APP_DATA); return json(res, 200, { ok: true })
          case '/api/open-workspace': openExplorer(WS); return json(res, 200, { ok: true })
          case '/api/open-settings': openBrowser(`http://127.0.0.1:${adminPort}/`); return json(res, 200, { ok: true })
          case '/api/quit': {
            // 等响应完整送达再退出，避免 keep-alive 连接被 process.exit 掐断
            res.setHeader('Connection', 'close')
            json(res, 200, { ok: true })
            res.once('close', () => setTimeout(() => cleanup(0), 100))
            setTimeout(() => cleanup(0), 3000) // 兜底：客户端消失也要退出
            return
          }
          default: return json(res, 404, { ok: false, error: 'not found' })
        }
      }
      return json(res, 404, { ok: false, error: 'not found' })
    } catch (e) {
      try { json(res, 400, { ok: false, error: e.message }) } catch { /* 连接已断 */ }
    }
  })
  adminPort = await new Promise((resolve, reject) => {
    adminServer.listen(0, '127.0.0.1', () => resolve(adminServer.address().port))
    adminServer.on('error', reject)
  })
  writeState({ adminPort })
  log(`admin: http://127.0.0.1:${adminPort}/`)
}

// ---------- Chrome 通知权限预授权（每次启动前播种当前端口） ----------
function seedNotifications(port) {
  try {
    const dir = path.join(BROWSER_PROFILE, 'Default')
    fs.mkdirSync(dir, { recursive: true })
    const pf = path.join(dir, 'Preferences')
    let prefs = {}
    try { prefs = JSON.parse(fs.readFileSync(pf, 'utf8')) } catch { /* 首次运行 */ }
    prefs.profile ??= {}
    prefs.profile.content_settings ??= {}
    prefs.profile.content_settings.exceptions ??= {}
    prefs.profile.content_settings.exceptions.notifications ??= {}
    prefs.profile.content_settings.exceptions.notifications[`http://127.0.0.1:${port},*`] = {
      last_modified: new Date().toISOString(), setting: 1, source: 'preference',
    }
    fs.writeFileSync(pf, JSON.stringify(prefs, null, 2))
    log(`notifications: 已预授权 http://127.0.0.1:${port}`)
  } catch (e) { log(`通知预授权失败(忽略): ${e.message}`) }
}

function spawnChrome() {
  if (!BROWSER || !readyUrl) return
  seedNotifications(webPort)
  browserProc = spawn(BROWSER, [
    `--app=${readyUrl}`,
    `--user-data-dir=${BROWSER_PROFILE}`,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1440,900',
  ], { detached: true, stdio: 'ignore' })
  browserProc.on('exit', () => {
    log('窗口关闭')
    if (quitting) return
    const s = readSettings()
    if (s.minimizeToTray !== false && trayProc && trayProc.exitCode === null) {
      log('最小化到托盘，宿主保持运行')
    } else {
      cleanup(0)
    }
  })
  log(`chrome pid=${browserProc.pid}，窗口已打开`)
}

// ---------- 清理 ----------
function cleanup(code = 0) {
  if (quitting) return
  quitting = true
  log(`cleanup: code=${code}`)
  if (browserProc) killTree(browserProc.pid)
  if (hostProc) killTree(hostProc.pid)
  if (trayProc) { try { spawnSync('taskkill', ['/pid', String(trayProc.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已退出 */ } }
  clearState()
  try { fs.unlinkSync(LOCK) } catch { /* 已删 */ }
  process.exit(code)
}

// ---------- doctor ----------
function runDoctor() {
  const rows = []
  const add = (name, ok, detail) => rows.push({ name, ok, detail })
  add('Node.js', process.versions.node >= '22', process.version)
  add('dsh CLI', !!DSH_BIN, DSH_BIN || '未找到（全局 npm / npx 缓存）')
  add('Chrome', !!BROWSER, BROWSER || '未找到（窗口模式必需）')
  const pwshOk = ps7Available()
  add('PowerShell 7 (agent 工具)', pwshOk, pwshOk ? '已安装' : '缺失！运行: winget install Microsoft.PowerShell')
  add('DSH_HOME', fs.existsSync(HOME), HOME)
  add('工作区', fs.existsSync(WS) || (() => { try { fs.mkdirSync(WS, { recursive: true }); return true } catch { return false } })(), WS)
  let freeMb = -1
  try { freeMb = Math.round(fs.statfsSync(APP_DATA).bavail * fs.statfsSync(APP_DATA).bsize / 1048576) } catch { /* 忽略 */ }
  add('磁盘剩余', freeMb > 200, freeMb > 0 ? `${freeMb} MB` : '未知')
  // 以下为信息项：只展示状态，不计入失败
  const info = []
  info.push(['开机自启', regQuery(RUN_KEY, '/v', RUN_VALUE).includes('DSHDesktop') ? 'on' : 'off'])
  info.push(['dsh:// 协议', regQuery(PROTO_ROOT, '/ve').includes('URL:DSH') ? '已注册' : '未注册（启动一次后自动注册）'])
  console.log(`\n[DSH Desktop ${readVersion()} doctor]`)
  for (const r of rows) console.log(`  ${r.ok ? '[OK]  ' : '[FAIL]'} ${r.name}: ${r.detail}`)
  for (const [k, v] of info) console.log(`  [..]  ${k}: ${v}`)
  const failed = rows.filter((r) => !r.ok)
  if (failed.length) console.log(`\n${failed.length} 项未通过: ${failed.map((r) => r.name).join(' / ')}`)
  else console.log('\n全部通过')
  process.exitCode = failed.some((r) => r.name === 'dsh CLI' || r.name === 'Chrome') ? 2 : 0
}

// ---------- 主流程 ----------
async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  const settings = readSettings()
  if (settings.workspace) WS = settings.workspace
  fs.mkdirSync(WS, { recursive: true })
  const deepLink = args.find((a) => a.startsWith('dsh://'))
  if (deepLink) log(`deep link: ${deepLink}（v1 仅聚焦窗口，路由映射见 TODO）`)

  if (!DSH_BIN) { console.error('[DSH Desktop] 找不到 dsh CLI (bin.js)，请检查安装'); process.exit(2) }
  if (!BROWSER && !SMOKE && !HEADLESS) { console.error('[DSH Desktop] 找不到 Chrome，请先安装 Google Chrome'); process.exit(2) }

  // 单实例：转发聚焦到已运行实例
  if (fs.existsSync(LOCK)) {
    const pid = Number(fs.readFileSync(LOCK, 'utf8'))
    let alive = false
    try { process.kill(pid, 0); alive = true } catch { /* 已死 */ }
    if (alive) {
      const st = readState()
      if (st.adminPort) {
        try { await fetch(`http://127.0.0.1:${st.adminPort}/api/focus`, { method: 'POST', signal: AbortSignal.timeout(2000) }) } catch { /* 转发失败 */ }
      } else {
        console.error('[DSH Desktop] 已有实例在运行（尚未就绪）')
      }
      process.exit(0)
    }
    try { fs.unlinkSync(LOCK) } catch { /* 已删 */ }
  }
  fs.writeFileSync(LOCK, String(process.pid))

  await startAdmin()
  writeState({ mode: HEADLESS ? 'headless' : 'windowed', startedAt: new Date().toISOString(), version: readVersion(), home: HOME, ws: WS, dshBin: DSH_BIN, browser: BROWSER || null })

  if (!SKIP_REG) { applyAutostart(!!settings.autostart); applyProtocol() }

  const port = await freePort()
  log(`boot: dsh web --host 127.0.0.1 --port ${port}`)
  log(`home: ${HOME}\nws:   ${WS}`)

  hostProc = spawn(process.execPath, [DSH_BIN, 'web', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: WS,
    env: { ...process.env, DSH_HOME: HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  fs.appendFileSync(path.join(LOG_DIR, 'host.log'), `--- run ${new Date().toISOString()} ---\n`)
  hostProc.stdout.on('data', (d) => fs.appendFileSync(path.join(LOG_DIR, 'host.log'), d))
  hostProc.stderr.on('data', (d) => fs.appendFileSync(path.join(LOG_DIR, 'host.log'), d))
  hostProc.on('exit', (c) => {
    log(`host 退出 (code=${c})`)
    if (!quitting) {
      if (c !== 0) notify('DSH 宿主意外退出', `exit code=${c}，应用即将关闭，请重新启动。`)
      cleanup(c !== 0 ? 1 : 0)
    }
  })

  try {
    readyUrl = await waitReady(port)
    webPort = port
    writeState({ webPort, webUrl: readyUrl, ready: true })
    log(`ready: ${readyUrl}`)
    if (!ps7Available() && !settings.warnedPs7) {
      const s = readSettings(); s.warnedPs7 = true; writeSettings(s)
      if (!HEADLESS && !SMOKE) notify('提示：未检测到 PowerShell 7', 'agent 的 shell 工具需要 PowerShell 7+，可运行 winget install Microsoft.PowerShell 安装。')
    }
    if (SMOKE) { log('SMOKE OK'); cleanup(0); return }
    spawnTray()
    if (HEADLESS) { log(`HEADLESS 就绪: http://127.0.0.1:${adminPort}/`); return }
    spawnChrome()
  } catch (e) {
    log(`启动失败: ${e.message}`)
    cleanup(1)
  }
}

process.on('SIGINT', () => cleanup(130))
process.on('SIGTERM', () => cleanup(143))

main()
