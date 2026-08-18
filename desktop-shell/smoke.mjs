// DSH Desktop Stage 3 端到端冒烟测试
// 流程：临时 DSH_HOME/APP_DATA/WS → 以 --headless 启动 launcher → 等状态文件
//       → 逐一验证 admin API → /api/quit → 校验退出码与日志 → 清理
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LAUNCHER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'launcher.mjs')

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
if (!DSH_BIN) { console.error('FAIL: 找不到 dsh CLI'); process.exit(1) }

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-smoke-'))
const appData = path.join(tempRoot, 'appdata')
const home = path.join(tempRoot, 'home')
const ws = path.join(tempRoot, 'ws')
const ws2 = path.join(tempRoot, 'ws2')
const stateFile = path.join(appData, 'app.state.json')
const hostLog = path.join(appData, 'logs', 'host.log')
const appLog = path.join(appData, 'logs', 'app.log')

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail })
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitState(timeoutMs = 45000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch { await sleep(300) }
  }
  throw new Error('launcher 状态文件超时')
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

let out = ''
let err = ''
const proc = spawn(process.execPath, [LAUNCHER, '--headless', '--no-tray'], {
  env: {
    ...process.env,
    DSH_APP_DATA: appData, DSH_HOME: home, DSH_WS: ws,
    DSH_BIN, DSH_SMOKE: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
proc.stdout.on('data', (d) => { out += d })
proc.stderr.on('data', (d) => { err += d })

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
  check('status 字段完整', ['version', 'home', 'ws', 'dshBin', 'node', 'mode'].every((k) => k in s1.json))
  check('status.mode=headless', s1.json.mode === 'headless')

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

  const page = await fetch(`http://127.0.0.1:${st.adminPort}/`, { signal: AbortSignal.timeout(5000) })
  const html = await page.text()
  check('设置页 HTML', page.status === 200 && html.includes('DSH Desktop 设置'))
  const ico = await fetch(`http://127.0.0.1:${st.adminPort}/icon.ico`, { signal: AbortSignal.timeout(5000) })
  check('icon.ico 可访问', ico.status === 200 && ico.headers.get('content-type').includes('image'))

  // 退出
  const q = await api(st.adminPort, '/api/quit', undefined, 'POST')
  check('quit 响应', q.status === 200 && q.json.ok === true)
  const code = await Promise.race([exited, sleep(15000).then(() => null)])
  check('launcher 干净退出 (code=0)', code === 0, `code=${code}`)

  const hostLogOk = fs.existsSync(hostLog) && fs.readFileSync(hostLog, 'utf8').trim().length > 0
  check('host.log 有内容', hostLogOk)
  const appLogOk = fs.existsSync(appLog) && !fs.readFileSync(appLog, 'utf8').includes('启动失败')
  check('app.log 无启动失败', appLogOk)
  check('锁与状态文件已清理', !fs.existsSync(stateFile) && !fs.existsSync(path.join(appData, 'app.lock')))
} catch (e) {
  console.error('  EXCEPTION:', e.message)
  check('无异常', false, e.message)
  try { proc.kill() } catch { /* 已退出 */ }
} finally {
  console.log(`\nlauncher stdout:\n${out.slice(0, 2000)}`)
  if (err) console.log(`launcher stderr:\n${err.slice(0, 1000)}`)
  const failed = results.filter((r) => !r.ok)
  try { proc.kill() } catch { /* 已退出 */ }
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); break } catch { await sleep(500) }
  }
  console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`)
  process.exit(failed.length ? 1 : 0)
}
