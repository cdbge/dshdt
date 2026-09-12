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
import { applyPending, cleanupOldTrees, readPending, restoreOldTree, writePending } from './dsh-apply.mjs'
import { assessJump, checkForUpdate, readCurrentVersions } from './dsh-update.mjs'
import { buildStaging, findNpm } from './vendor-build.mjs'
import { cleanStaleBootGateHomes } from './junction-safe.mjs'
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
// 宿主 stderr 单独落盘（2026-09-12）：崩溃真因在这里，且必须由父进程实时接管才留得住
// ——见 host.mjs 的 startHost 注释（fd 直通会随进程消失，实测让排查空转三轮）。
const HOST_ERR_LOG = path.join(LOG_DIR, 'host.stderr.log')
// 打包期写进 vendor.lock.json 的依赖文件数基线；启动时低于它=依赖缺件（杀软隔离/解压不全）。
// 优先读 nodeModulesFiles（2026-09-12 起新写），旧 lock 没有该字段时退回 totalFiles。
const VENDOR_EXPECT_FILES = (() => {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(VENDOR_DIR, 'vendor.lock.json'), 'utf8'))
    return lock.nodeModulesFiles || lock.totalFiles || 0
  } catch { return 0 }
})()
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
  // console.log 也要兜住：stdout 可能是已关闭的管道（EPIPE），而它在 Electron 里是
  // uncaughtException —— 一条日志失败不该把整个启动流程带走（实测踩过）。
  try { console.log(line.trimEnd()) } catch { /* stdout 不可用 */ }
}

/** 宿主日志尾部若干行，用于把"启动即退出"的真因直接摆到壳日志里。 */
function hostLogTail(limit = 6) {
  try { return fs.readFileSync(HOST_LOG, 'utf8').split('\n').filter(Boolean).slice(-limit).join(' | ') } catch { return '' }
}
/**
 * 宿主进程最后遗言（环形缓冲，含 stderr）——崩溃通知直接展示这几行。
 *
 * 为什么要它：`exit code=1` 本身不是结论（真因只写在宿主 stderr 里），而 2026-09-12 的
 * 他人机器事故里，用户看到的就是一句"意外退出"，没有任何可行动线索，导致排查完全依赖
 * 对方回传日志。把最后几行塞进通知 = 用户看一眼就知道该做什么。
 */
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

// 桌面皮肤遮罩透明度（0~1）。两个遮罩分开可调：右侧轮次标记轨的竖状椭圆、正文两侧拖动条的底层。
// 缺省给一点（能看见可拖/可点，但不喧宾夺主）；0 = 完全隐藏。
const SKIN_RAIL_MASK_DEFAULT = 0.35
const SKIN_CONVERSATION_MASK_DEFAULT = 0.25
// 右侧栏**全屏态**单独一档，且默认明显更重（用户实测反馈："侧边全屏模式下透明度过低了"）。
// 理由：全屏时这块面板不再是"旁边一栏"，而是**整个工作面**，正文直接压在壁纸上；
// 沿用 0.25 那档会读得很费劲。所以它不复用对话区遮罩，而是自己一个值。
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

// 左侧栏背景：两种模式——`extend` 延伸主页面壁纸 / `own` 独立选一张图（默认 extend）。
// 为什么要有独立图片：主壁纸是"整页气氛"，左侧栏是"导航面"，两者常常需要不同明暗；
// 但用户又不想每次都为侧栏单独配图，所以默认跟随主壁纸。
// 「左侧栏必须比主页面更不透明」是**硬约束**：它由客户端在写 CSS 变量时取
// max(本值, 对话区遮罩) 实现，壳这边只负责存用户拖出来的那个原始值——
// 把 max 放在壳里会让滑块回读时"跳一下"，那个手感更差。
const SIDEBAR_BG_MODES = ['extend', 'own']
const SIDEBAR_OPACITY_DEFAULT = 0.45

// 文件的 mtime 当"版本号"。取不到返回 0——文件被删/不可读时不能让状态快照跟着炸。
function fileMtimeMs(p) {
  if (!p) return 0
  try { return Math.round(fs.statSync(p).mtimeMs) } catch { return 0 }
}

// 允许外部传入已读好的 settings：statusPayload 每 5 秒被调一次，
// 而 readSettings() 是一次真实读盘——能少读一次是一次。
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

// 左侧栏独立图片：与主壁纸同一套校验（存在 + 扩展名），只是存另一个键。
// 刻意**不调 applyBackgroundCss()**：左侧栏那层背景由客户端插件注入（它在
// dsh-desktop-ui 的皮肤样式表里，靠 --dsh-sidebar-bg-image 变量取本路由的 URL），
// 壳侧不参与，所以这里没有可重绘的东西。切模式同理——纯粹是客户端读快照的事。
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
    // 与下面那条「检查更新」是**两个更新平面**：这条查 DSH（harness）版本，下面那条是壳自更新
    // （electron-updater，需发布源 app-update.yml）。措辞刻意区分，避免误点。
    // 手动动作必须有可见反馈，否则点了像没反应——所以用通知回显结果。
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
  hostProc = startHost({
    bin: dshBin(), home: HOME, ws: WS, port, patchFile: PATCH_FILE, logFile: HOST_LOG,
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
      // profile 若重挂了单实例锁插件，第二个 host 会被拒（code=3）；
      // 重启流程会经 findExistingHostUrl 复用锁持有者，不会无限拉起。
      log('host 退出 (code=3：同一 DSH_HOME 已有实例)，重启流程将复用已有 host')
    } else {
      // 带上宿主日志尾巴 + **最后遗言**（环形缓冲，含 stderr）：宿主"启动即退出"时真因
      // （插件树加载失败、凭证/设置文件不兼容、依赖缺件、路径编码问题）只在它自己的
      // stderr 里，只报一个 code 会把排查引向完全错误的方向（0.4.6 事故多绕了一整轮；
      // 2026-09-12 他人机器那次更是三轮拿不到一句话）。
      const last = hostRingTail()
      const tail = code === 0 ? '' : `；宿主日志尾部：${hostLogTail() || '（空）'}`
      log(`host 退出 (code=${code})${last === '' ? '' : `；最后遗言：${last}`}${tail}`)
      if (code !== 0 && preflightFailed.length > 0) {
        log(`  ↑ 另外 preflight 已发现 ${preflightFailed.length} 项环境问题：${preflightFailed.map((f) => f.name).join(' / ')}`)
      }
    }
    // 通知内容升级：把"最后遗言"和 preflight 线索直接给到屏幕，用户不必翻日志
    const clue = hostRingTail(2, 220)
    const hint = clue !== ''
      ? `真因（宿主最后输出）：${clue}`
      : (preflightFailed.length > 0 ? `疑似环境问题：${preflightFailed[0].detail}` : '宿主未输出任何错误——请运行 `DSH Desktop.exe --diag` 一键取证')
    const n = new Notification({ title: 'DSH 宿主意外退出', body: `exit code=${code}，正在自动重启宿主。\n${hint}` })
    n.on('click', () => restartHost())
    n.show()
    restartHost()
  })
  // logFile 必须传：DSH 0.1.5+ 的根 URL 带进程级 token，只有宿主 stdout 里能看到它
  // （见 host.mjs 的 extractHostUrl）。不传就退化成裸 URL 探测 → 0.1.5+ 永远不判定就绪。
  const url = await waitReady(port, 30000, { logFile: HOST_LOG }).catch((e) => {
    if (seq !== bootSeq) return null // 已被新一轮 boot 取代，丢弃旧探测
    throw e
  })
  // url === null 表示本次探测已被新一轮 boot 取代（重启流程的正常路径）。但**绝不能让调用方
  // 在 readyUrl 仍为 null 的情况下继续**：main() 会拿 null 去 loadURL，Electron 抛的是
  // "Error processing argument at index 0, conversion failure from null"——一句与真因毫无关系的
  // 报错；更严重的是它会让换树兜底回滚**失效**（回滚只在 bootHost 抛错时触发，返回 null 不触发）。
  // 0.4.6 事故的持久化阶段正是栽在这里：宿主因凭证文件格式不兼容而启动即退出 →
  // 重启计数用尽 → 本函数静默返回 → 回滚没跑 → 用户面对一个起不来的应用和一个看不懂的报错。
  if (url === null) throw new Error(`宿主未取得可加载 URL（就绪探测已被重启取代）；宿主日志尾部：${hostLogTail() || '（空）'}`)
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

// 诊断：报回"皮肤类改动"要改的那几处 UI 锚点。**固定用途的只读脚本，不是通用 eval**——
// 它与 diagOpaqueLayers 同等风险画像（回环 admin、只读取、不回写）。
// 为什么需要它：0.1.5 的 SPA 用哈希前缀 CSS-modules，类名无法靠猜；而壳的窗口已经完成鉴权，
// 直接问它比另开探测窗口安全（后者会消费掉一次性 token，见规范坑 39）。
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

// 重载窗口 —— 客户端插件改动的热加载手段。
// 宿主插件有托盘「重启宿主（重载插件）」，而客户端插件（dsh-desktop-ui 等）改完只受 ESM 模块
// 缓存影响，不重载页面就看不到新版；打包态 Menu.setApplicationMenu(null) 又把 Ctrl+R 一起去掉了
// ——结果是"改一行 CSS 也要重启整个应用"。reloadIgnoringCache 才是有效的那一步：插件是按 URL
// 取模块的，忽略缓存才拿得到新文件。
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
    // 右侧栏全屏态的独立遮罩（默认 0.8，比对话区那档重）：全屏时它铺满视口，太透就读不清正文。
    fullscreenMaskOpacity: skinTuning().fullscreenMaskOpacity,
    // 左侧栏背景：模式 / 独立图片路径 / 遮罩原值。真正渲染用的不透明度由客户端取
    // max(sidebarOpacity, conversationMaskOpacity)，保证侧栏永远不比主页面透。
    sidebarBgMode: side.mode,
    sidebarBgImage: side.image,
    sidebarOpacity: side.opacity,
    // 图片"版本号"（mtime）。客户端拿它拼 URL 的 ?t= —— **必须有**：
    // URL 不变时浏览器认为 background-image 没变化、**根本不会重新请求**，
    // 壳端的 Cache-Control: no-store 也救不了（那次请求压根不会发出去）。
    // 这和主壁纸 bgCssFor 里的 ?t=mtime 是同一招，只是壁纸走壳侧 insertCSS、
    // 侧栏走客户端插件，所以版本号得经这里递过去。
    sidebarBgImageVersion: fileMtimeMs(side.image),
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
const dshUpdate = { phase: 'idle', error: null, current: null, latest: null, target: null, hasUpdate: false, npmOk: null, startedAt: null, finishedAt: null, lastRollback: null, progress: null }
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
  // 跨版本位升级需要「人显式确认」——但确认动作必须**能从界面给出来**。原实现只把参数写在报错里
  // （"请带 allowUnsafeJump: true"），而界面那个按钮永远不会带它，等于把 GUI 用户**永久卡死**
  // （用户实测反馈："什么叫拒绝更新"）。所以把评估结果放进快照，让客户端能渲染确认流程。
  const jump = (ver !== null && dshUpdate.target !== null) ? assessJump(ver, dshUpdate.target) : null
  const needsConfirm = jump !== null && jump.safe === false
  let hint
  if (dshUpdate.lastRollback !== null) hint = `上次更新失败已自动回滚（${dshUpdate.lastRollback.reason}）`
  else if (dshUpdate.phase === 'failed') hint = `上次操作失败：${dshUpdate.error ?? '未知原因'}`
  else if (dshUpdate.phase === 'building') hint = `正在构建 ${dshUpdate.target ?? ''}（分钟级，请勿关闭应用）`
  else if (dshUpdate.phase === 'ready') hint = `已构建完成，重启应用后生效（${dshUpdate.target ?? ''}）`
  else if (pending !== null) hint = `有待应用的更新 ${pending.target}（重启应用生效）`
  else if (!dshUpdate.npmOk) hint = '未找到系统 Node.js（本应用不内置 npm），更新功能不可用'
  else if (dshUpdate.latest === null) hint = `已安装 ${ver ?? '未知'}（点“检查更新”查询最新版）`
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
    // 进度：step/label 说明"现在在做什么"，percent 只是大致刻度，elapsedMs 才是用户真正等的那个数。
    progress: dshUpdate.progress,
    elapsedMs: dshUpdate.startedAt === null
      ? null
      : (dshUpdate.finishedAt !== null ? Date.parse(dshUpdate.finishedAt) : Date.now()) - Date.parse(dshUpdate.startedAt),
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
 * @param {{allowUnsafeJump?:boolean}} [opts] 跨 minor/主版本时需显式置 allowUnsafeJump
 */
function dshUpdateTo(version, opts = {}) {
  if (dshUpdateBusy) return { ok: false, error: '已有更新任务在进行中，请稍候' }
  const target = (String(version ?? '').trim()) || dshUpdate.target || ''
  if (target === '') return { ok: false, error: '未指定目标版本，请先“检查更新”' }
  // 只接受"检查更新"查回来过的精确版本：绝不把任意字符串拼进 npm 依赖（供应链面）。
  // 注意 target 为 null 时**也要拒绝**——那是"从未检查过"的状态，不是"版本随便填"的许可。
  if (dshUpdate.target === null) return { ok: false, error: '请先“检查更新”确定目标版本' }
  if (target !== dshUpdate.target) {
    return { ok: false, error: `目标 ${target} 与已查得的最新版 ${dshUpdate.target} 不一致，请重新“检查更新”` }
  }
  // 版本距离守卫（0.4.6 事故教训）：跨 minor/主版本意味着交互合同可能已变，
  // 而那正是两道门禁都测不出来的东西（树能起、二进制能加载，但壳与它的对话方式变了）。
  const installedVersion = dshUpdate.current?.['@deepseek-ai/dsh'] ?? dshCurrentVersions()['@deepseek-ai/dsh']
  if (typeof installedVersion === 'string') {
    const jump = assessJump(installedVersion, target)
    if (!jump.safe && opts.allowUnsafeJump !== true) {
      // 面向用户的措辞：**不要**再让人"带某个参数"——界面按钮带不了参数，那样说等于把人卡死
      // （用户实测反馈："什么叫拒绝更新"）。这里说明"要做什么"，参数由客户端在确认后代传。
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
        // 启动门禁必须拿到壳真正会用的那个补丁——不传它，门禁测的就是另一套契约，
        // 0.4.6 事故里"树能起、壳连不上"的漂移正好会从这道缝里漏过去。
        patchFile: PATCH_FILE,
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
  add('窗口引擎', true, `Electron ${process.versions.electron}（内建 Node ${process.versions.node} / Chromium ${process.versions.chrome}）`)
  add('dsh CLI', !!dshBin(), dshBin() || '未找到（全局 npm / npx 缓存 / vendor）')
  const pwshOk = ps7Available()
  add('PowerShell 7 (agent 工具)', pwshOk, pwshOk ? '已安装' : '缺失！运行: winget install Microsoft.PowerShell')
  add('DSH_HOME', fs.existsSync(HOME), HOME)
  // 环境判据与启动前 preflight **共用同一套实现**（不再各写一份，避免口径漂移）：
  // 那套里包含 Windows 版本 / 路径非 ASCII / NODE_OPTIONS / DSH_BIN / 数据目录可写 / 磁盘 / 依赖完整性。
  for (const r of preflightChecks()) add(r.name, r.ok, r.detail)
  console.log(`\n[DSH Desktop ${readVersion()} doctor]`)
  for (const r of rows) console.log(`  ${r.ok ? '[OK]  ' : '[FAIL]'} ${r.name}: ${r.detail}`)
  const failed = rows.filter((r) => !r.ok)
  console.log(failed.length
    ? `\n${failed.length} 项未通过: ${failed.map((r) => r.name).join(' / ')}\n完整取证报告: DSH Desktop.exe --diag`
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
 *
 * ⚠️ **不能无脑"追加"**（2026-09-12 他人机器事故的真凶）：DSH 给这个文件落的模板
 * （`dsh-app-boot` 的 `PROFILE_PATCH_TEMPLATE`）**结尾就是一个 `[]`**（合法的空 YAML 数组）。
 * 旧写法 `cur.trimEnd() + '\n' + block` 会把 `- insert:` 追加在 `[]` 之后 →
 * **同一文件里两个 YAML 节点** → 宿主每次启动都在 `loadOverlayPatches` 抛
 * `YAMLException: end of the stream or a document separator is expected` → `code=1` 退出。
 * 判据：`curLast === '[]'` 时必须**替换**那个 token，而不是追加。
 * 该文件由用户/DSH 共同持有，所以只做**最小改动**：能替换就替换，绝不重写整份内容
 * （注释、用户自己写的补丁条目都原样保留）。
 */
function ensureProfilePluginMount(name, comment) {
  try {
    fs.mkdirSync(path.join(PROFILE_DIR, 'node_modules'), { recursive: true })
    let cur = ''
    try { cur = fs.readFileSync(PROFILE_PATCH, 'utf8') } catch { cur = '# dsh profile patch layer\n' }
    const mounted = new RegExp(`(^|\\s)(id|name):\\s*${name}\\s*$`, 'm').test(cur)
    const block = `# ${comment}\n- insert:\n    - id: ${name}\n      name: ${name}\n`
    const stripped = cur.trimEnd()
    const curLast = stripped.split('\n').pop().trim()
    const head = stripped === '' || /^#/.test(curLast) ? '' : `${stripped}\n\n`
    let next
    if (curLast === '[]') {
      // 只把最后一个 `[]` token 换成条目：文件里原有的模板注释、用户条目全部原样保留
      next = `${stripped.slice(0, stripped.length - 2)}${mounted ? '' : block}\n`
    } else {
      if (mounted) return false
      next = `${head}${block}`
    }
    if (next === cur) return false
    fs.writeFileSync(PROFILE_PATCH, next)
    log(`已把 ${name} 写入 profile 补丁层（${curLast === '[]' ? '替换空数组' : '追加'}）: ${PROFILE_PATCH}`)
    return true
  } catch (e) { log(`补丁层写入失败(${name}): ${e.message}`); return false }
}

/**
 * 每次启动都跑一次的自愈：把"能证明是坏的"补丁层改回合法 YAML。
 *
 * 为什么必做：已经中招的机器（朋友那台 `.dsh` 是老版本留下的）里，`cordis.patch.yml` 会**永久**停在
 * `[]` + `- insert:` 的坏形态上——而 `ensureProfilePluginMount` 因为"名字已经在文件里出现过"
 * （那句注释里就带着名字）会直接跳过，坏文件于是永远修不好，卸载重装也没用（文件在 `$DSH_HOME`）。
 * 判据是**解析结果**而不是文本匹配：只在"确实以 `[]` 结尾、且它前面出现过一个 `- ` 条目"时才判定为坏，
 * 其余情况一律不动（用户手写的内容我们无权改写）。
 */
function repairProfilePatchYaml() {
  try {
    if (!fs.existsSync(PROFILE_PATCH)) return false
    const raw = fs.readFileSync(PROFILE_PATCH, 'utf8')
    const lines = raw.split('\n')
    // 判据必须是"[] 与顶层条目**同时**存在"，而不是"[] 在最后一行"：
    // 实测坏形态是 `[]` 在第 1 行、条目在它**下面**（追加方向决定）。只判末尾会漏掉真实样本。
    const emptyIdx = lines.findIndex((l) => l.trim() === '[]')
    if (emptyIdx < 0) return false
    const hasEntryAnywhere = lines.some((l) => /^\s*-\s+\S/.test(l))
    if (!hasEntryAnywhere) return false // 干净的 DSH 模板 = 只有注释 + []，这是合法的，不许动
    // 最小改动：只删掉那个 `[]` 行，其余（注释、用户条目、空行）逐行保留
    const kept = lines.filter((l) => l.trim() !== '[]')
    fs.writeFileSync(PROFILE_PATCH, kept.join('\n'))
    log(`已修复损坏的 profile 补丁层（第 ${emptyIdx + 1} 行是空数组 [] 却同时含顶层条目：YAML 双节点，宿主必然解析失败）: ${PROFILE_PATCH}`)
    return true
  } catch (e) { log(`补丁层自愈失败: ${e.message}`); return false }
}

function ensureProfilePlugins() {
  for (const name of PROFILE_PLUGIN_NAMES) syncProfilePlugin(name)
  repairProfilePatchYaml() // 必须在写挂载之前：否则对已损坏的文件会跳过写入（名字已在注释里出现过）
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

// ---------- preflight：启动前就拦下"环境不允许它跑"的情形（2026-09-12） ----------
// 为什么要有它：2026-09-12 他人机器事故里，全新电脑上宿主秒退、通知只给一句 exit code=1，
// 用户与我们都拿不到可行动线索。这里的检查项都是**在宿主启动前就能判定**的，宁可在壳这一层
// 说清"改什么"，也不要让它退化成一个退出码。
// 分级：`critical` 会让壳带着说明退出（继续跑只会重复崩溃）；`warn` 只记日志并提示。
let preflightFailed = []
/** 给宿主进程的环境补充（目前只用于把工作区钉到 ASCII 路径，见 WS 检查项）。 */
function preflightEnvOverrides() { return {} }

const isAsciiPath = (p) => !/[^\x00-\x7F]/.test(String(p || ''))
/** 只读检查，不修改任何东西；`--doctor` 与启动流程共用同一套判据。 */
function preflightChecks() {
  const rows = []
  const add = (name, ok, detail, level = 'warn') => rows.push({ name, ok, level, detail })

  const winBuild = Number(os.release().split('.')[2] || 0)
  add('Windows 版本', winBuild >= 19045, `build ${os.release()}${winBuild >= 19045 ? '' : '（需 Win10 22H2 / build 19045 及以上）'}`, 'warn')

  // 非 ASCII 路径：宿主内 koffi COM worker、sharp/libvips 等 5 个原生模块在中文/特殊字符路径下的
  // 经典故障形态是"启动即退且无输出"。APP_DATA 由壳决定（在 %LOCALAPPDATA% 下，通常 ASCII），
  // 真正可能带中文的是 DSH_HOME 与工作区。
  add('DSH_HOME 路径', isAsciiPath(HOME), HOME, 'critical')

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

  let vendorFiles = -1
  try { vendorFiles = countVendorFiles(path.join(VENDOR_PROFILE, 'node_modules')) } catch { /* 忽略 */ }
  const expect = VENDOR_EXPECT_FILES
  add('依赖完整性', vendorFiles < 0 || expect <= 0 || vendorFiles >= expect * 0.98,
    vendorFiles < 0 ? '无法统计' : `${vendorFiles} 个文件（打包基线 ${expect || '未知'}）${expect > 0 && vendorFiles < expect * 0.98 ? ' —— 依赖缺件（杀软隔离/解压不全），请重装并加白名单' : ''}`,
    'critical')

  return rows
}

/** 目录文件数（只数文件，不跟随符号链接；打包期与运行期共用同一算法）。 */
function countVendorFiles(dir) {
  let n = 0
  const walk = (d) => {
    let ents
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (e.isDirectory()) walk(path.join(d, e.name))
      else if (e.isFile()) n++
    }
  }
  walk(dir)
  return n
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
      try { dialog.showErrorBox(`${APP_NAME} 无法在此环境启动`, `检测到 ${critical.length} 项环境问题：\n\n${text}\n\n修好后重开应用即可；也可以运行 \`DSH Desktop.exe --diag\` 生成完整取证报告。`) } catch { /* 无 GUI 会话 */ }
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
  say(`Windows  : ${os.release()}（${os.arch()}）`)
  say(`用户名   : ${os.userInfo().username}`)
  say()
  say(`--- 路径 ---`)
  say(`APP_DATA   : ${APP_DATA}  [存在=${fs.existsSync(APP_DATA)} ${flag(APP_DATA)}]`)
  say(`DSH_HOME   : ${HOME}  [存在=${fs.existsSync(HOME)} ${flag(HOME)}]`)
  say(`工作区     : ${WS}  [存在=${fs.existsSync(WS)} ${flag(WS)}]`)
  say(`vendor     : ${VENDOR_PROFILE}  [存在=${fs.existsSync(VENDOR_PROFILE)} ${flag(VENDOR_PROFILE)}]`)
  say(`dsh bin.js : ${dshBin() || '（未找到！）'}`)
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
    const nm = path.join(VENDOR_PROFILE, 'node_modules')
    say(`node_modules 文件数 = ${countVendorFiles(nm)}（打包基线 ${VENDOR_EXPECT_FILES || '未知'}）`)
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

  // CLI 快捷命令（不启动宿主）
  if (args.includes('--version')) { console.log(readVersion()); app.exit(0); return }
  if (args.includes('--diag') || args.includes('--diagnose')) { runDiag(); app.exit(0); return }
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

  // 环境前置检查：critical 失败就带说明退出，不要去拉一个注定起不来的宿主
  // （2026-09-12 他人机器事故的教训：让用户看到一个可行动的说明，而不是 `exit code=1`）
  if (!SMOKE && !runPreflight()) { cleanup(2); return }

  // 清理上次没走完 finally 的门禁隔离目录。它们里面有**指向被测树/现网树的 junction 场**，
  // 交给任何"跟随 junction"的清理动作（rmdir /s /q、del /s /q、系统清理工具）就会掏空目标树
  // ——0.4.6 事故第二现场正是这个形态（240 个 @deepseek-ai/* 包被掏空成空目录）。失败不阻断启动。
  try { cleanStaleBootGateHomes({ log }) } catch (e) { log(`遗留门禁目录清理失败（非致命）：${e.message}`) }

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
      diagUi,
      reloadWindow,
      pickBackground: pickBackgroundImage,
      setSidebarBackground: setSidebarBackgroundImage,
      pickSidebarBackground: pickSidebarBackgroundImage,
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
    // ── 换树兜底（对 Q4「不做回滚」的修正，0.4.6 事故教训）──
    // 事故形状：新树通过了两道门禁之外的检查、换树也成功，但宿主就绪探测永远失败——应用直接坏掉，
    // 而旧树还完整躺在 profile.old-*。失败发生在**换树之后**，所以"延迟删旧树"救不了，必须能换回去。
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
    // 宿主起来了 = 当前这棵树确认可用 → **现在才**删旧树。
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
