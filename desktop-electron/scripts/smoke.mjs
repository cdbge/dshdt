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
// timeoutMs 可调：**`/api/restart-host` 是同步等待整个重启的**
// （优雅停旧宿主 ~2.5s + 拉起新宿主 + 就绪探测），0.1.5 启动比 rc.8 慢，
// 固定 5s 会在这里超时 —— 报出来是 "The operation was aborted due to timeout"，
// 看着像壳挂了，其实只是客户端等不够。见规范坑 52。
async function api(port, p, body, method, timeoutMs = 5000) {
  const m = method || (body === undefined ? 'GET' : 'POST')
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: m,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
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
    // 0.1.5+ 鉴权：根 URL 带**一次性** `?token=`，首访是 303 换签名 cookie；而 Node 的 fetch
    // (undici) **没有 cookie jar** —— 直接拿裸 URL 打 /plugins 或 /api/* 一律 `unauthorized`。
    // 换票判据与壳的 `probeHostReady`（src/host.mjs）**完全一致**：redirect:'manual' 取
    // Set-Cookie → 带着它请求。smoke 的宿主是一次性的，消费掉 token 无妨
    // （壳的就绪探测才不能消费它——那会把窗口的票吃掉）。
    const bare = `http://127.0.0.1:${readyStatus.webPort}`
    let cookie = ''
    try {
      const hop1 = await fetch(readyStatus.webUrl || `${bare}/`, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
      if (hop1.status >= 300 && hop1.status < 400) {
        const list = typeof hop1.headers.getSetCookie === 'function'
          ? hop1.headers.getSetCookie()
          : [hop1.headers.get('set-cookie')].filter(Boolean)
        cookie = list.map((c) => c.split(';')[0]).join('; ')
      }
    } catch { /* rc.8 形态没有换票这一步，空 cookie 照常可用 */ }
    const authHeaders = cookie ? { cookie } : {}

    // 0.1.5 的插件供给形态与 rc.8 **完全不同**：不再是「一个包一条 URL」，
    // 而是宿主把全部客户端插件**合并成 combo 请求**注入 index：
    //     /plugins/??<包名>/client.js&rev=<rev>-<n>
    // 服务端 `bundleResource()` 用 `pathname+search` **精确查表**，所以拼裸路径
    // （`/plugins/dsh-desktop-ui/client.js`）必然 404 —— 必须用 index 里那条真实 URL。
    const index = await fetch(`${bare}/`, { headers: authHeaders, signal: AbortSignal.timeout(5000) })
    const html = await index.text()
    check('index 可获取（0.1.5 无需裸 URL）', index.status === 200 && html.length > 1000, `status=${index.status} len=${html.length}`)

    const bundleMatch = html.match(/\/plugins\/\?\?[^"'\s]*dsh-desktop-ui[^"'\s]*/)
    if (bundleMatch) {
      const bundleUrl = bundleMatch[0].replace(/&amp;/g, '&')
      const bundle = await fetch(`${bare}${bundleUrl}`, { headers: authHeaders, signal: AbortSignal.timeout(8000) })
      const bundleText = await bundle.text()
      check('plugins 供给 dsh-desktop-ui（0.1.5 combo 形态）',
        bundle.status === 200 && bundleText.includes('dsh-desktop-ui'),
        `status=${bundle.status} url=${bundleUrl.slice(0, 90)}`)
    } else {
      check('plugins 供给 dsh-desktop-ui（0.1.5 combo 形态）', false, 'index 里找不到含 dsh-desktop-ui 的 /plugins/?? URL')
    }

    // 目录选择器钉在「应用内浏览」：0.1.5 里它不再是宿主 RPC（`/api/host.pickDirectory` 已不存在，
    // 现在是客户端服务 `ctx.uiWorkspace`），但**结果可观测** —— 客户端插件名册里应当是
    // `-browse` 而非 `-native`（0.4.4 用 `SSH_CONNECTION=dsh-desktop-browse` 让 auto 解析器回退）。
    const hasBrowse = html.includes('dsh-client-ui-directory-picker-browse')
    const hasNative = html.includes('dsh-client-ui-directory-picker-native')
    check('picker 已钉住 browse（名册里是 -browse、不是 -native）', hasBrowse && !hasNative, `browse=${hasBrowse} native=${hasNative}`)
    // 另有一条独立证据：宿主**没有**装载 native picker 那条 loader 行（名册只列「已装载」的客户端插件）
    check('browse 后端已被供给（combo URL 出现在 index）', /\/plugins\/\?\?[^"'\s]*dsh-client-ui-directory-picker-browse/.test(html), 'look for directory-picker-browse in combo URLs')
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

  // 桌面皮肤遮罩透明度（0~1）：写入 → 回读 → 越界钳制 → 非法值忽略。
  // 这两个值由客户端写进 CSS 变量驱动"右侧跳转轨道遮罩 / 对话区底层遮罩"，所以必须能从 /api/status 读回。
  const skin1 = await api(st.adminPort, '/api/settings', { railMaskOpacity: 0.6, conversationMaskOpacity: 0.15 })
  check('皮肤遮罩写入', skin1.status === 200 && skin1.json.settings.railMaskOpacity === 0.6 && skin1.json.settings.conversationMaskOpacity === 0.15, JSON.stringify(skin1.json.settings))
  const skinSt = await api(st.adminPort, '/api/status')
  check('status 回读皮肤遮罩', skinSt.json.railMaskOpacity === 0.6 && skinSt.json.conversationMaskOpacity === 0.15, `rail=${skinSt.json.railMaskOpacity} conv=${skinSt.json.conversationMaskOpacity}`)
  const skin2 = await api(st.adminPort, '/api/settings', { railMaskOpacity: 9, conversationMaskOpacity: -3 })
  check('皮肤遮罩越界钳制 (1 / 0)', skin2.json.settings.railMaskOpacity === 1 && skin2.json.settings.conversationMaskOpacity === 0, JSON.stringify(skin2.json.settings))
  const skin3 = await api(st.adminPort, '/api/settings', { railMaskOpacity: 'abc' })
  check('皮肤遮罩非法值忽略', skin3.json.settings.railMaskOpacity === 1, JSON.stringify(skin3.json.settings))
  // 右侧栏**全屏态**的遮罩：独立一档、默认更重（0.8）——全屏时面板铺满视口，
  // 沿用对话区那档（0.25）正文压在壁纸上读不清（用户实测反馈）。
  const fs1 = await api(st.adminPort, '/api/settings', { fullscreenMaskOpacity: 0.65 })
  check('全屏遮罩写入', fs1.status === 200 && fs1.json.settings.fullscreenMaskOpacity === 0.65, JSON.stringify(fs1.json.settings))
  const fsSt = await api(st.adminPort, '/api/status')
  check('status 回读全屏遮罩', fsSt.json.fullscreenMaskOpacity === 0.65, `fs=${fsSt.json.fullscreenMaskOpacity}`)
  const fs2 = await api(st.adminPort, '/api/settings', { fullscreenMaskOpacity: 7 })
  check('全屏遮罩越界钳制 (1)', fs2.json.settings.fullscreenMaskOpacity === 1, JSON.stringify(fs2.json.settings))
  await api(st.adminPort, '/api/settings', { fullscreenMaskOpacity: 0.8 })
  await api(st.adminPort, '/api/settings', { railMaskOpacity: 0.35, conversationMaskOpacity: 0.25 })

  // 左侧栏背景：模式（extend/own）+ 遮挡 0~1 + 独立图片的回环供给。
  // 注意断言的是"原值原样存取"——「左侧栏永远比主页面更不透明」是**客户端**取
  // max(本值, 对话区遮罩) 实现的；若哪天有人把 max 挪进壳里，这几条会先红。
  const sb1 = await api(st.adminPort, '/api/settings', { sidebarBgMode: 'own', sidebarOpacity: 0.7 })
  check('左侧栏背景写入', sb1.status === 200 && sb1.json.settings.sidebarBgMode === 'own' && sb1.json.settings.sidebarOpacity === 0.7, JSON.stringify(sb1.json.settings))
  const sbSt = await api(st.adminPort, '/api/status')
  check('status 回读左侧栏背景', sbSt.json.sidebarBgMode === 'own' && sbSt.json.sidebarOpacity === 0.7, `mode=${sbSt.json.sidebarBgMode} op=${sbSt.json.sidebarOpacity}`)
  const sb2 = await api(st.adminPort, '/api/settings', { sidebarOpacity: 9 })
  check('左侧栏遮罩越界钳制 (1)', sb2.json.settings.sidebarOpacity === 1, JSON.stringify(sb2.json.settings))
  const sb3 = await api(st.adminPort, '/api/settings', { sidebarBgMode: 'bogus' })
  check('左侧栏模式非法值忽略', sb3.json.settings.sidebarBgMode === 'own', JSON.stringify(sb3.json.settings))
  const sbNoImg = await fetch(`http://127.0.0.1:${st.adminPort}/sidebar-image`, { signal: AbortSignal.timeout(5000) })
  check('未设左侧栏图片时 sidebar-image → 404', sbNoImg.status === 404)
  const sbSet = await api(st.adminPort, '/api/sidebar-background', { path: bgPng })
  check('sidebar-background 设置 (png)', sbSet.status === 200 && sbSet.json.ok === true)
  const sbImg = await fetch(`http://127.0.0.1:${st.adminPort}/sidebar-image`, { signal: AbortSignal.timeout(5000) })
  const sbBytes = Buffer.from(await sbImg.arrayBuffer())
  check('sidebar-image 供给 (200 + image/png + 字节一致)', sbImg.status === 200 && (sbImg.headers.get('content-type') || '').includes('image/png') && sbBytes.length === fs.statSync(bgPng).size)
  // 图片"版本号"（mtime）：客户端拿它拼 URL 的 ?t=。**换图后它必须变**——
  // URL 不变时浏览器认为 background-image 没变化、压根不会重新请求，
  // 那正是"已经有图片的情况下换一张完全不生效"的根因（no-store 也救不了，请求不会发出）。
  const sbVer1 = (await api(st.adminPort, '/api/status')).json.sidebarBgImageVersion
  check('sidebar 图片版本号存在且为正', typeof sbVer1 === 'number' && sbVer1 > 0, `v=${sbVer1}`)
  const sbPng2 = path.join(tempRoot, 'wall2.png')
  fs.writeFileSync(sbPng2, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
  // 显式把 mtime 拉开：同一毫秒内写两个文件会让版本号相同，断言就随机红了
  const sbT2 = new Date(Date.now() + 5000)
  fs.utimesSync(sbPng2, sbT2, sbT2)
  await api(st.adminPort, '/api/sidebar-background', { path: sbPng2 })
  const sbVer2 = (await api(st.adminPort, '/api/status')).json.sidebarBgImageVersion
  check('换图后图片版本号改变', sbVer2 === Math.round(fs.statSync(sbPng2).mtimeMs) && sbVer2 !== sbVer1, `v1=${sbVer1} v2=${sbVer2}`)
  await api(st.adminPort, '/api/sidebar-background', { path: bgPng })
  const sbBad = await api(st.adminPort, '/api/sidebar-background', { path: path.join(tempRoot, 'note.txt') })
  check('sidebar-background 拒绝非图片', sbBad.status === 400)
  const sbClear = await api(st.adminPort, '/api/sidebar-background', { path: '' })
  check('sidebar-background 清除', sbClear.status === 200 && sbClear.json.cleared === true)
  const sbAfterClear = await fetch(`http://127.0.0.1:${st.adminPort}/sidebar-image`, { signal: AbortSignal.timeout(5000) })
  check('清除后 sidebar-image → 404', sbAfterClear.status === 404)
  const sbPick = await api(st.adminPort, '/api/pick-sidebar-background', undefined, 'POST')
  check('左侧栏选图端点（headless 不弹窗）', sbPick.status === 200 && sbPick.json.ok === true)
  // 收尾复位：后面的断言按默认皮肤跑
  await api(st.adminPort, '/api/settings', { sidebarBgMode: 'extend', sidebarOpacity: 0.45 })

  const doc = await api(st.adminPort, '/api/open-settings-document', undefined, 'POST')
  check('打开配置文件端点', doc.status === 200 && doc.json.ok === true)
  const pick = await api(st.adminPort, '/api/pick-directory', undefined, 'POST')
  check('目录选择端点（headless 不弹窗）', pick.status === 200 && pick.json.ok === true)

  const page = await fetch(`http://127.0.0.1:${st.adminPort}/`, { signal: AbortSignal.timeout(5000) })
  const html = await page.text()
  check('设置页 HTML', page.status === 200 && html.includes('DSH Desktop 设置'))
  const ico = await fetch(`http://127.0.0.1:${st.adminPort}/icon.ico`, { signal: AbortSignal.timeout(5000) })
  check('icon.ico 可访问', ico.status === 200 && ico.headers.get('content-type').includes('image'))

  // DSH 更新（S5）：**只断言形状与拒绝路径——绝不联网、绝不真构建、绝不触发重启**。
  // smoke 必须能离线重复跑；真构建（分钟级 + npm install）由 vendor-equivalence.mjs 单独负责。
  const dshSt = await api(st.adminPort, '/api/dsh/status')
  check('dsh/status 可用', dshSt.status === 200 && dshSt.json.ok === true)
  check('dsh/status 含阶段/当前版本/提示', typeof dshSt.json.phase === 'string' && 'current' in dshSt.json && typeof dshSt.json.hint === 'string',
    JSON.stringify({ phase: dshSt.json.phase, current: dshSt.json.current, hint: dshSt.json.hint }))
  check('dsh/status 报告 npm 可用性', typeof dshSt.json.npmOk === 'boolean', `npmOk=${dshSt.json.npmOk}`)
  // 进度字段必须在快照里（构建约 8 分钟，界面靠它渲染进度条；缺字段就是"用户只能干等"）
  check('dsh/status 带 progress/elapsedMs 字段', 'progress' in dshSt.json && 'elapsedMs' in dshSt.json,
    JSON.stringify({ progress: dshSt.json.progress, elapsedMs: dshSt.json.elapsedMs }))
  check('dsh/status 带 jump/needsConfirm（跨版本确认入口）', 'jump' in dshSt.json && 'needsConfirm' in dshSt.json)
  check('dsh/status 未联网（latest 为空）', dshSt.json.latest === null || dshSt.json.latest === undefined, `latest=${JSON.stringify(dshSt.json.latest)}`)
  // 注意断言对象是 HTTP 响应的 s1.json，**不是** st（st 是 waitState() 读的状态文件，
  // 那是壳自己的重启/宿主复用记账，不含 dshUpdate）。客户端插件轮询的正是 s1 这一份。
  check('status 内嵌 dshUpdate 快照', !!(s1.json.dshUpdate && typeof s1.json.dshUpdate.phase === 'string'),
    JSON.stringify(s1.json.dshUpdate && { phase: s1.json.dshUpdate.phase, npmOk: s1.json.dshUpdate.npmOk }))

  // 未先"检查更新"时必须拒绝——否则任意版本串都能拼进 npm 依赖（供应链面），且 smoke 会误触发真构建
  const dshNoCheck = await api(st.adminPort, '/api/dsh/update', { version: '' })
  check('dsh/update 空版本被拒绝', dshNoCheck.status === 200 && dshNoCheck.json.ok === false, dshNoCheck.json.error)
  const dshBogus = await api(st.adminPort, '/api/dsh/update', { version: '9.9.9-rc.1' })
  check('dsh/update 拒绝未经查证的目标版本', dshBogus.status === 200 && dshBogus.json.ok === false, dshBogus.json.error)
  const dshAfter = await api(st.adminPort, '/api/dsh/status')
  check('两次拒绝后仍停在 idle（未误启动构建）', dshAfter.json.phase === 'idle', `phase=${dshAfter.json.phase}`)

  // 无待应用标记时 apply 必须干净拒绝——否则 smoke 会把壳自己重启掉，测试就地中断
  const dshApply = await api(st.adminPort, '/api/dsh/apply', {})
  check('dsh/apply 无待应用更新时拒绝', dshApply.status === 200 && dshApply.json.ok === false, dshApply.json.error)

  // 退出
  // 手动重启宿主（与托盘「重启宿主（重载插件）」同一实现）：优雅停 → 重拉 → 换端口
  const rs = await api(st.adminPort, '/api/restart-host', {}, 'POST', 60000)
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
