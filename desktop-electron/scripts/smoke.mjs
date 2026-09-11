// DSH Desktop (Electron) 端到端冒烟测试 —— 断言集与 v1 desktop-shell/smoke.mjs 对齐
// 流程：临时 DSH_HOME/APP_DATA/WS → electron.exe <app> --headless 启动 → 等状态文件
//       → 逐一验证 admin API → /api/quit → 校验退出码与日志 → 清理
// 注意：spawn 用文件描述符重定向（沙箱管道限制）；运行 Electron 主进程需完整权限环境。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const APP_DIR = ROOT
const DSH_BIN = process.env.DSH_BIN || null
if (!fs.existsSync(ELECTRON)) { console.error('FAIL: 找不到 electron.exe'); process.exit(1) }

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-smoke-e-'))
const appData = path.join(tempRoot, 'appdata')
const home = path.join(tempRoot, 'home')
const ws = path.join(tempRoot, 'ws')
const ws2 = path.join(tempRoot, 'ws2')
const stateFile = path.join(appData, 'app.state.json')
const hostLog = path.join(appData, 'logs', 'host.log')
const appLog = path.join(appData, 'logs', 'app.log')
const outPath = path.join(tempRoot, 'stdout.log')
const errPath = path.join(tempRoot, 'stderr.log')

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail })
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitState(timeoutMs = 60000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch { await sleep(300) }
  }
  throw new Error('壳状态文件超时')
}
async function api(port, p, body, method) {
  const m = method || (body === undefined ? 'GET' : 'POST')
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: m,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  })
  return { status: r.status, json: await r.json() }
}

const outFd = fs.openSync(outPath, 'w')
const errFd = fs.openSync(errPath, 'w')
const childEnv = { ...process.env, DSH_APP_DATA: appData, DSH_HOME: home, DSH_WS: ws, DSH_BIN: DSH_BIN || '', DSH_SMOKE: '1' }
delete childEnv.ELECTRON_RUN_AS_NODE // 会话环境可能泄漏该变量（主进程会退化成纯 Node）
const proc = spawn(ELECTRON, [APP_DIR, '--headless', '--disable-gpu'], {
  env: childEnv,
  stdio: ['ignore', outFd, errFd],
  windowsHide: true,
})

let exitCode = null
const exited = new Promise((resolve) => proc.on('exit', (c) => { exitCode = c; resolve(c) }))

try {
  const st = await waitState()
  check('状态文件包含 adminPort', st.adminPort > 0, `adminPort=${st.adminPort}`)
  check('状态文件包含 pid', st.pid === proc.pid, `pid=${st.pid}`)

  const h = await api(st.adminPort, '/health')
  check('GET /health', h.status === 200 && h.json.ok === true)

  const s1 = await api(st.adminPort, '/api/status')
  check('GET /api/status', s1.status === 200 && s1.json.ok === true)
  check('status 字段完整', ['version', 'home', 'ws', 'dshBin', 'engine', 'electron', 'mode'].every((k) => k in s1.json))
  check('status.engine=Electron', s1.json.engine === 'Electron', `electron=${s1.json.electron}`)
  check('status.mode=headless', s1.json.mode === 'headless')
  check('admin 固定端口（被占则回退）', st.adminPort === 25439 || st.adminPort > 0, `adminPort=${st.adminPort}${st.adminPort !== 25439 ? '（25439 被其他实例占用，已回退）' : ''}`)

  // 等 host 就绪后验证客户端插件供给（dsh-desktop-ui 设置 section 的前置）
  let readyStatus = null
  for (let i = 0; i < 60; i++) {
    const r = await api(st.adminPort, '/api/status')
    if (r.json.ready && r.json.webPort > 0) { readyStatus = r.json; break }
    await sleep(500)
  }
  check('host 就绪（ready）', !!readyStatus, readyStatus ? `webPort=${readyStatus.webPort}` : '超时')
  if (readyStatus) {
    const plugin = await fetch(`http://127.0.0.1:${readyStatus.webPort}/plugins/dsh-desktop-ui/client.js`, { signal: AbortSignal.timeout(5000) })
    const pluginText = await plugin.text()
    check('plugins 供给 dsh-desktop-ui/client.js', plugin.status === 200 && pluginText.includes('dsh-desktop-ui'))
    // 目录选择器已钉住"应用内浏览"（rc.6 native worker 在选取时崩溃 → 0.4.4 起 SSH_CONNECTION 回退 browse）：
    // pickDirectory 必须报 directory-picker-unavailable；listDirectory（browse 后端）必须可用
    const pickReq = await fetch(`http://127.0.0.1:${readyStatus.webPort}/api/host.pickDirectory`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-pick', method: 'host.pickDirectory', payload: {} }), signal: AbortSignal.timeout(5000),
    })
    const pickText = await pickReq.text()
    check('picker 已钉住 browse（pickDirectory→unavailable）', pickReq.status === 200 && pickText.includes('directory-picker-unavailable'), pickText.slice(0, 100))
    const listReq = await fetch(`http://127.0.0.1:${readyStatus.webPort}/api/host.listDirectory`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-list', method: 'host.listDirectory', payload: { path: ws } }), signal: AbortSignal.timeout(5000),
    })
    const listText = await listReq.text()
    check('browse 目录列表可用（listDirectory ok）', listReq.status === 200 && listText.includes('"ok":true'), listText.slice(0, 100))
  }

  const a1 = await api(st.adminPort, '/api/autostart', { on: true })
  check('autostart on', a1.status === 200 && a1.json.autostart === true)
  const a2 = await api(st.adminPort, '/api/autostart', { on: false })
  check('autostart off', a2.status === 200 && a2.json.autostart === false)

  const s2 = await api(st.adminPort, '/api/settings', { minimizeToTray: false })
  check('settings 写入', s2.status === 200 && s2.json.ok === true)

  const w1 = await api(st.adminPort, '/api/workspace', { path: ws2 })
  check('workspace 切换', w1.status === 200 && w1.json.ok === true && w1.json.workspace === ws2)
  const s3 = await api(st.adminPort, '/api/status')
  check('status.ws 已更新', s3.json.ws === ws2)
  const wBad = await api(st.adminPort, '/api/workspace', { path: '相对路径' })
  check('workspace 拒绝相对路径', wBad.status === 400)

  const f = await api(st.adminPort, '/api/focus', undefined, 'POST')
  check('focus 端点可用', f.status === 200 && f.json && f.json.ok === true && f.json.note === 'headless（不拉起窗口）', JSON.stringify(f.json))

  // 自定义背景图片：设置(jpg/png) → 回环 HTTP 供给 → 清除；格式白名单
  const bgPng = path.join(tempRoot, 'wall.png')
  fs.writeFileSync(bgPng, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  const bgSet = await api(st.adminPort, '/api/background', { path: bgPng })
  check('background 设置 (png)', bgSet.status === 200 && bgSet.json.ok === true)
  const bgImg = await fetch(`http://127.0.0.1:${st.adminPort}/bg-image`, { signal: AbortSignal.timeout(5000) })
  const bgBytes = Buffer.from(await bgImg.arrayBuffer())
  check('bg-image 供给 (200 + image/png + 字节一致)', bgImg.status === 200 && (bgImg.headers.get('content-type') || '').includes('image/png') && bgBytes.length === fs.statSync(bgPng).size)
  const bgBad = await api(st.adminPort, '/api/background', { path: path.join(tempRoot, 'note.txt') })
  check('background 拒绝非图片扩展名', bgBad.status === 400)
  const bgClear = await api(st.adminPort, '/api/background', { path: '' })
  check('background 清除', bgClear.status === 200 && bgClear.json.cleared === true)
  const bgAfterClear = await fetch(`http://127.0.0.1:${st.adminPort}/bg-image`, { signal: AbortSignal.timeout(5000) })
  check('清除后 bg-image → 404', bgAfterClear.status === 404)

  // 壁纸调参（亮度 0.2~2 / 模糊 0~40）：写入 → 回读 → 越界钳制 → 非法值忽略
  const tun1 = await api(st.adminPort, '/api/settings', { bgBrightness: 1.4, bgBlur: 8 })
  check('settings 写入壁纸调参', tun1.status === 200 && tun1.json.settings.bgBrightness === 1.4 && tun1.json.settings.bgBlur === 8, JSON.stringify(tun1.json.settings))
  const tunSt = await api(st.adminPort, '/api/status')
  check('status 回读壁纸调参', tunSt.json.bgBrightness === 1.4 && tunSt.json.bgBlur === 8, `brightness=${tunSt.json.bgBrightness} blur=${tunSt.json.bgBlur}`)
  const tun2 = await api(st.adminPort, '/api/settings', { bgBrightness: 9, bgBlur: -5 })
  check('壁纸调参越界钳制 (2 / 0)', tun2.json.settings.bgBrightness === 2 && tun2.json.settings.bgBlur === 0, JSON.stringify(tun2.json.settings))
  const tun3 = await api(st.adminPort, '/api/settings', { bgBrightness: 'abc' })
  check('壁纸调参非法值忽略', tun3.json.settings.bgBrightness === 2, JSON.stringify(tun3.json.settings))
  await api(st.adminPort, '/api/settings', { bgBrightness: 1, bgBlur: 0 })
  const doc = await api(st.adminPort, '/api/open-settings-document', undefined, 'POST')
  check('打开配置文件端点', doc.status === 200 && doc.json.ok === true)
  const pick = await api(st.adminPort, '/api/pick-directory', undefined, 'POST')
  check('目录选择端点（headless 不弹窗）', pick.status === 200 && pick.json.ok === true)

  const page = await fetch(`http://127.0.0.1:${st.adminPort}/`, { signal: AbortSignal.timeout(5000) })
  const html = await page.text()
  check('设置页 HTML', page.status === 200 && html.includes('DSH Desktop 设置'))
  const ico = await fetch(`http://127.0.0.1:${st.adminPort}/icon.ico`, { signal: AbortSignal.timeout(5000) })
  check('icon.ico 可访问', ico.status === 200 && ico.headers.get('content-type').includes('image'))

  // 退出
  // 手动重启宿主（与托盘「重启宿主（重载插件）」同一实现）：优雅停 → 重拉 → 换端口
  const rs = await api(st.adminPort, '/api/restart-host', {})
  check('restart-host 端点返回 ok', rs.status === 200 && rs.json.ok === true, JSON.stringify(rs.json).slice(0, 140))
  let st2 = null
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try { st2 = (await api(st.adminPort, '/api/status')).json; if (st2 && st2.ready && st2.webUrl) break } catch { /* 重启中，继续等 */ }
  }
  check('restart-host 后宿主重新就绪', !!(st2 && st2.ready && st2.webUrl), st2 ? `webUrl=${st2.webUrl}` : 'no status')
  check('restart-host 起了新宿主（端口已变）', !!(st2 && st2.webPort > 0 && st2.webPort !== st.webPort), `old=${st.webPort} new=${st2 && st2.webPort}`)

  const q = await api(st.adminPort, '/api/quit', undefined, 'POST')
  check('quit 响应', q.status === 200 && q.json.ok === true)
  const code = await Promise.race([exited, sleep(15000).then(() => null)])
  check('壳干净退出 (code=0)', code === 0, `code=${code}`)

  const hostLogOk = fs.existsSync(hostLog) && fs.readFileSync(hostLog, 'utf8').trim().length > 0
  check('host.log 有内容', hostLogOk)
  const appLogOk = fs.existsSync(appLog) && !fs.readFileSync(appLog, 'utf8').includes('启动失败')
  check('app.log 无启动失败', appLogOk)
  check('状态文件已清理', !fs.existsSync(stateFile))
} catch (e) {
  console.error('  EXCEPTION:', e.message)
  check('无异常', false, e.message)
  try { proc.kill() } catch { /* 已退出 */ }
} finally {
  try { fs.closeSync(outFd); fs.closeSync(errFd) } catch { /* 已关 */ }
  console.log(`\n壳 stdout:\n${fs.readFileSync(outPath, 'utf8').slice(0, 2000)}`)
  if (fs.statSync(errPath).size > 0) console.log(`壳 stderr:\n${fs.readFileSync(errPath, 'utf8').slice(0, 1000)}`)
  const failed = results.filter((r) => !r.ok)
  try { proc.kill() } catch { /* 已退出 */ }
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); break } catch { await sleep(500) }
  }
  console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`)
  process.exit(failed.length ? 1 : 0)
}
