// host 托管（模式 B，《Electron构建安装包计划书》2.2）：
//   ELECTRON_RUN_AS_NODE=1 + --expose-internals（M0 实测：Electron 内建 Node 必须带该 V8 旗标，
//   否则 dsh web 的 hmr 回退抛 "--expose-internals is required"）+ dsh 包自带 bin.js（入口零重写）。
// 监管逻辑移植自 v1 desktop-shell/launcher.mjs：数组参数 spawn（避免空格路径被拆）、
// 自选空闲端口、就绪轮询、taskkill 进程树。stdio 走文件描述符重定向（沙箱管道限制 + 天然落盘日志）。
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'

/** 发现 dsh bin.js：DSH_BIN 环境 > 全局 npm > 各候选 npx 缓存（取最新） > 随包 vendor/profile。 */
export function findDshBin(extraRoots = []) {
  if (process.env.DSH_BIN && fs.existsSync(process.env.DSH_BIN)) return process.env.DSH_BIN
  const candidates = []
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  candidates.push('C:\\Program Files\\nodejs\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js')
  for (const dir of extraRoots) candidates.push(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  for (const p of candidates) if (fs.existsSync(p)) return p

  // npx 缓存扫描根：Electron 壳里 execPath 是 electron.exe（锚点错），
  // 必须显式纳入系统 Node 目录（v1 壳在 Node 下 execPath 即系统 Node，故无需）
  const cacheRoots = new Set([path.dirname(process.execPath)])
  if (process.env.ProgramFiles) cacheRoots.add(path.join(process.env.ProgramFiles, 'nodejs'))
  if (process.env.LOCALAPPDATA) cacheRoots.add(process.env.LOCALAPPDATA)
  try {
    const where = spawnSync('where', ['node'], { encoding: 'utf8', windowsHide: true })
    if (where.status === 0) for (const line of where.stdout.split(/\r?\n/)) if (line) cacheRoots.add(path.dirname(line.trim()))
  } catch { /* where 不可用则跳过 */ }

  for (const root of cacheRoots) {
    let cache = path.join(root, 'node_cache', '_npx')
    if (!fs.existsSync(cache)) cache = path.join(root, 'npm-cache', '_npx')
    if (!fs.existsSync(cache)) continue
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

/** 自选空闲端口（监听 0 取号再释放），避免与用户手开的 dsh web 冲突。 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)) })
    srv.on('error', reject)
  })
}

/**
 * 从宿主日志里取它自己宣告的根 URL（行形如 `dsh web: http://127.0.0.1:PORT/?token=…`）。
 *
 * 为什么必须走日志：**DSH 0.1.5 起根 URL 带进程级启动令牌**（`?token=`，首次访问用它换签名
 * cookie）。拿不到 token 就永远过不了鉴权——症状是"宿主进程活着、日志也在滚，但前端永远拉不起来"，
 * 而壳只会报一句笼统的"未在 30000ms 内就绪"。
 * 壳是独立进程，够不到宿主的 cordis 上下文，宿主 stdout 是唯一通道（故 printUrl 必须为 true）。
 * @param {string} logFile 宿主 stdout 落盘路径
 * @returns {string|null} 最后一次宣告的 URL；读不到返回 null
 */
export function extractHostUrl(logFile) {
  if (!logFile) return null
  try {
    const text = fs.readFileSync(logFile, 'utf8')
    const re = /dsh web:\s+(https?:\/\/127\.0\.0\.1:\d+\/\S*)/g
    let last = null
    // 取最后一次：日志是追加写的，宿主可能重启过，早先的 URL 行还留在文件里
    for (let m = re.exec(text); m !== null; m = re.exec(text)) last = m[1]
    return last
  } catch {
    return null
  }
}

/**
 * 完整走一次 0.1.5+ 的 token→cookie 换票，**只在"服务器真能服务"时返回 true**。
 *
 * 为什么不能只 `fetch(url)` 看 `res.ok`：根 URL 是一个 **303 换 cookie** 的重定向，而 Node 的
 * `fetch`(undici) **没有 cookie jar**——默认跟随重定向时 `Set-Cookie` 被丢掉，下一跳 `/` 回 401，
 * 于是永远探不到就绪（实测：裸 URL→401、带 token 跟随重定向→401、`redirect:'manual'`→303+cookie、
 * 带上该 cookie 请求 `/`→200）。
 *
 * 为什么这个函数**只给门禁用**：它会把 token 消费掉。壳的就绪探测不能消费 token（见 {@link waitReady}）。
 * @param {string} url 宿主宣告的 URL（0.1.5+ 带 `?token=`）
 * @param {string} fallbackUrl 裸端口 URL（rc.8 形态）
 * @returns {Promise<boolean>} 服务器是否真的在服务
 */
export async function probeHostReady(url, fallbackUrl) {
  const attempt = async (u, opts) => {
    try { return await fetch(u, { signal: AbortSignal.timeout(3000), ...opts }) } catch { return null }
  }
  // rc.8 形态：裸 URL 直接 200
  const bare = await attempt(fallbackUrl)
  if (bare !== null && bare.ok) return true
  // 0.1.5+ 形态：先拿到换票重定向，再带上 cookie 验证
  const hop1 = await attempt(url, { redirect: 'manual' })
  if (hop1 === null) return false
  if (hop1.ok) return true
  if (hop1.status < 300 || hop1.status >= 400) return false
  const cookies = typeof hop1.headers.getSetCookie === 'function' ? hop1.headers.getSetCookie() : [hop1.headers.get('set-cookie')].filter(Boolean)
  if (cookies.length === 0) return false
  const cookie = cookies.map((c) => c.split(';')[0]).join('; ')
  const hop2 = await attempt(fallbackUrl, { headers: { cookie } })
  return hop2 !== null && hop2.ok
}

/**
 * 就绪探测：轮询到宿主能对外服务为止，返回**可直接给窗口加载的 URL**。
 *
 * 优先用宿主自己宣告的 URL（0.1.5+ 带 token），回退裸端口 URL（rc.8 形态，也兜住"日志未 flush
 * 但 HTTP 已可用"的时序）。两代 harness 都覆盖，是这次跨版本事故的根治点。
 *
 * **判据是"服务器回了任何 HTTP 响应"，不是 `res.ok`**（0.1.5 实测）：根 URL 是 303 换 cookie，而
 * `fetch` 没有 cookie jar，跟随重定向后必然是 401。只要它答了话就说明宿主在服务，**换票交给窗口
 * 自己走**——窗口有真正的 cookie jar；同时也避免探测先把这个一次性 token 消费掉。
 * @param {number} port 本次监听的端口（用于剔除日志里上一轮的残留 URL 行）
 * @param {number} timeoutMs 超时
 * @param {{logFile?:string}} [opts] opts
 * @returns {Promise<string>} 就绪 URL（可能含 token 查询串）
 * @throws 超时未就绪；错误信息带日志尾巴，直接可定位
 */
export async function waitReady(port, timeoutMs = 30000, { logFile } = {}) {
  const fallbackUrl = `http://127.0.0.1:${port}/`
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const declared = extractHostUrl(logFile)
    const declaredForPort = declared !== null && declared.includes(`:${port}`) ? declared : null
    if (declaredForPort !== null) {
      // 宿主已宣告本端口 URL（0.1.5+ 带 token）→ **只认它**：它答任何 HTTP 码都说明在服务
      // （303 是换票跳转；不跟随就不会动这个一次性 token，换票交给窗口的 cookie jar）。
      try {
        const res = await fetch(declaredForPort, { signal: AbortSignal.timeout(2000), redirect: 'manual' })
        if (res.status > 0) return declaredForPort
      } catch { /* 未就绪，继续轮询 */ }
    } else {
      // 宿主还没宣告（URL 行尚未落进日志）→ 只能试裸 URL，且**只接受 2xx**。
      // 401/403 的语义是"服务在、但这次请求没通过鉴权"，把它当就绪会让窗口加载一个必然提示
      // "authentication required" 的地址——0.1.5 上"前端拉不起来"的最后一环正在这里：
      // 早期轮询探到裸 URL 的 401，被 `status > 0` 接受并当场定稿。
      try {
        const res = await fetch(fallbackUrl, { signal: AbortSignal.timeout(2000), redirect: 'manual' })
        if (res.status >= 200 && res.status < 300) return fallbackUrl
      } catch { /* 未就绪，继续轮询 */ }
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  let tail = ''
  try { tail = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).slice(-6).join(' | ') } catch { /* 不可读就不带 */ }
  throw new Error(`host 未在 ${timeoutMs}ms 内就绪（端口 ${port}）${tail === '' ? '' : `；宿主日志尾部：${tail}`}`)
}

export function killTree(pid) {
  try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已退出 */ }
}

/**
 * 启动 DSH host 子进程（模式 B）。runtime 默认 process.execPath：
 * Electron 主进程内即 electron.exe，RUN_AS_NODE 下等同 Node（零额外运行时）。
 * --patch 由 web 子命令收集，--host/--port 透传进 web 应用层。
 */
export function startHost({ runtime = process.execPath, bin, home, ws, port, patchFile, logFile, extraEnv = {} }) {
  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    fs.appendFileSync(logFile, `\n--- run ${new Date().toISOString()} ---\n`)
  }
  const fdOut = logFile ? fs.openSync(logFile, 'a') : 'ignore'
  const inner = []
  if (patchFile) inner.push('--patch', patchFile)
  inner.push('--host', '127.0.0.1', '--port', String(port))
  const child = spawn(runtime, ['--expose-internals', bin, 'web', ...inner], {
    cwd: ws,
    env: {
      ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home,
      // 钉住"应用内浏览"目录选择器（0.4.4）：rc.6 的 native 选择器（koffi COM worker）
      // 在真实选取目录时崩溃（worker 静默死亡 → "win32 folder dialog worker exited
      // before reporting a result"）。auto 解析器读取 SSH_CONNECTION 即回退 browse
      // （vendor 全树仅此一处读取该变量，语义安全），GUI 改用纯 Node 的应用内目录浏览。
      SSH_CONNECTION: 'dsh-desktop-browse',
      ...extraEnv,
    },
    stdio: ['ignore', fdOut, fdOut],
    windowsHide: true,
  })
  child.on('exit', () => { if (logFile) { try { fs.closeSync(fdOut) } catch { /* 已关 */ } } })
  return child
}
