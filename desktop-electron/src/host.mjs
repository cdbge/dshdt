// host.mjs — DSH host 子进程的托管：定位 bin.js、自选空闲端口、就绪轮询、进程树终止。
// 以 ELECTRON_RUN_AS_NODE=1 + --expose-internals 启动 bin.js 的 web 子命令；stdio 走管道，受限环境退化为 fd 重定向。
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

/** 各平台的全局 npm 安装根候选。@param {{env?:object, platform?:string}} [o] 可注入以便单测 */
function globalNpmRoots({ env = process.env, platform = process.platform } = {}) {
  const roots = []
  const add = (p) => { if (typeof p === 'string' && p !== '') roots.push(p) }
  if (platform === 'win32') {
    if (env.APPDATA) add(path.join(env.APPDATA, 'npm', 'node_modules'))
    if (env.ProgramFiles) add(path.join(env.ProgramFiles, 'nodejs', 'node_modules'))
    add('C:\\Program Files\\nodejs\\node_modules')
  } else {
    for (const prefix of ['/usr/local', '/usr', '/opt/homebrew', '/opt/local']) add(path.join(prefix, 'lib', 'node_modules'))
    add('/usr/share/nodejs')
    const home = env.HOME
    if (home) {
      add(path.join(home, '.npm-global', 'lib', 'node_modules'))
      add(path.join(home, '.volta', 'tools', 'image', 'node', 'lib', 'node_modules'))
      const nvmRoot = env.NVM_DIR ?? path.join(home, '.nvm')
      let versions = []
      try { versions = fs.readdirSync(path.join(nvmRoot, 'versions', 'node')) } catch { versions = [] }
      for (const v of versions) add(path.join(nvmRoot, 'versions', 'node', v, 'lib', 'node_modules'))
    }
  }
  return roots
}

/**
 * 发现 dsh bin.js：DSH_BIN > 全局 npm（三平台候选） > npx 缓存（取最新） > extraRoots（随包 vendor/profile）。
 * @param {string[]} [extraRoots] 额外候选根
 * @param {{env?:object, platform?:string, execPath?:string, exists?:(p:string)=>boolean}} [o] 可注入以便单测
 * @returns {string|null}
 */
export function findDshBin(extraRoots = [], { env = process.env, platform = process.platform, execPath = process.execPath, exists = fs.existsSync } = {}) {
  if (env.DSH_BIN && exists(env.DSH_BIN)) return env.DSH_BIN
  const candidates = []
  for (const root of globalNpmRoots({ env, platform })) candidates.push(path.join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  for (const dir of extraRoots) candidates.push(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  for (const p of candidates) if (exists(p)) return p

  // npx 缓存扫描根：Electron 壳里 execPath 是 electron 可执行文件（锚点错），必须显式纳入系统 Node 目录
  const cacheRoots = new Set([path.dirname(execPath)])
  if (env.ProgramFiles) cacheRoots.add(path.join(env.ProgramFiles, 'nodejs'))
  if (env.LOCALAPPDATA) cacheRoots.add(env.LOCALAPPDATA)
  if (env.HOME) {
    cacheRoots.add(env.HOME)
    cacheRoots.add(path.join(env.HOME, '.npm'))
  }
  for (const dir of whichNodeDirs({ env, platform, exists })) cacheRoots.add(dir)
  for (const root of cacheRoots) {
    // npx 缓存有两种布局，且 ~/.npm 本身就是缓存根
    for (const cache of [path.join(root, 'node_cache', '_npx'), path.join(root, 'npm-cache', '_npx'), path.join(root, '_npx')]) {
      if (!exists(cache)) continue
      let entries = []
      try { entries = fs.readdirSync(cache) } catch { continue }
      const hits = []
      for (const entry of entries) {
        const p = path.join(cache, entry, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
        if (exists(p)) hits.push({ p, t: fs.statSync(p).mtimeMs })
      }
      hits.sort((a, b) => b.t - a.t)
      if (hits.length) return hits[0].p
    }
  }
  return null
}

/** 系统 Node 的安装目录（用于定位 npx 缓存）。POSIX 上不能 spawn `which`，改在 PATH 里逐个查。 */
function whichNodeDirs({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  const dirs = []
  if (platform === 'win32') {
    try {
      const where = spawnSync('where', ['node'], { encoding: 'utf8', windowsHide: true })
      if (where.status === 0) for (const line of where.stdout.split(/\r?\n/)) if (line.trim()) dirs.push(path.dirname(line.trim()))
    } catch { /* where 不可用则跳过 */ }
    return dirs
  }
  for (const dir of String(env.PATH ?? '').split(':')) {
    if (dir === '') continue
    if (exists(path.join(dir, 'node'))) dirs.push(dir)
  }
  return dirs
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
 * 从宿主日志取它宣告的根 URL（`dsh web: http://127.0.0.1:PORT/?token=…`，取最后一次）。
 * 0.1.5 起根 URL 带进程级令牌，壳够不到宿主的 cordis 上下文，stdout 是唯一通道。
 * @param {string} logFile 宿主 stdout 落盘路径
 * @returns {string|null} 读不到返回 null
 */
export function extractHostUrl(logFile) {
  if (!logFile) return null
  try {
    const text = fs.readFileSync(logFile, 'utf8')
    const re = /dsh web:\s+(https?:\/\/127\.0\.0\.1:\d+\/\S*)/g
    let last = null
    // 日志是追加写的，宿主可能重启过，取最后一次
    for (let m = re.exec(text); m !== null; m = re.exec(text)) last = m[1]
    return last
  } catch {
    return null
  }
}

/**
 * 完整走一次 0.1.5+ 的 token→cookie 换票，只在服务器真能服务时返回 true。
 * 不能只看 `res.ok`：根 URL 是 303 换 cookie 的重定向，而 Node 的 fetch 没有 cookie jar。
 * 本函数会消费掉 token，只给门禁用。
 * @param {string} url 宿主宣告的 URL（带 `?token=`）
 * @param {string} fallbackUrl 裸端口 URL（rc.8 形态）
 */
export async function probeHostReady(url, fallbackUrl) {
  const attempt = async (u, opts) => {
    try { return await fetch(u, { signal: AbortSignal.timeout(3000), ...opts }) } catch { return null }
  }
  // rc.8 形态：裸 URL 直接 200
  const bare = await attempt(fallbackUrl)
  if (bare !== null && bare.ok) return true
  // 0.1.5+ 形态：先拿换票重定向，再带 cookie 验证
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
 * 就绪探测：轮询到宿主能对外服务为止，返回可直接给窗口加载的 URL。
 * 判据是"服务器回了任何 HTTP 响应"而不是 `res.ok`：根 URL 是 303 换 cookie，而 fetch 没有 cookie jar，
 * 跟随重定向必然 401；换票交给窗口的 cookie jar，同时避免探测消费掉一次性 token。
 * @param {number} port 本次监听的端口（用于剔除日志里上一轮的残留 URL 行）
 * @returns {Promise<string>} 就绪 URL（可能含 token 查询串）
 * @throws 超时未就绪；错误信息带宿主日志尾部
 */
export async function waitReady(port, timeoutMs = 30000, { logFile } = {}) {
  const fallbackUrl = `http://127.0.0.1:${port}/`
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const declared = extractHostUrl(logFile)
    const declaredForPort = declared !== null && declared.includes(`:${port}`) ? declared : null
    if (declaredForPort !== null) {
      // 宿主已宣告本端口 URL（带 token）→ 只认它；不跟随重定向就不会动这个一次性 token
      try {
        const res = await fetch(declaredForPort, { signal: AbortSignal.timeout(2000), redirect: 'manual' })
        if (res.status > 0) return declaredForPort
      } catch { /* 未就绪，继续轮询 */ }
    } else {
      // 宿主还没宣告 → 只能试裸 URL，且只接受 2xx；401/403 是"服务在但没通过鉴权"，
      // 当成就绪会让窗口加载一个必然提示 authentication required 的地址
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

/**
 * 杀整棵进程树：Windows 用 `taskkill /T /F`（必须判 spawnSync 返回值，被策略拒绝时是 {error} 而非异常）；
 * POSIX 对 detached 的进程组组长发 `-pid` 信号，先 SIGTERM 宽限再 SIGKILL。
 * @param {number} pid 宿主进程（组组长）pid
 * @param {{platform?:string, graceMs?:number, log?:(m:string)=>void}} [o] 可注入以便单测
 * @returns {boolean} 是否确认进程已消失（false 时调用方需自己告警）
 */
export function killTree(pid, { platform = process.platform, graceMs = 2500, log = (m) => console.error(m) } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
  const sleepSync = (ms) => {
    const sab = new SharedArrayBuffer(4)
    Atomics.wait(new Int32Array(sab), 0, 0, ms)
  }
  const waitGone = (timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline && alive()) sleepSync(50)
    return !alive()
  }
  const killPidOnly = (sig) => { try { process.kill(pid, sig); return true } catch { return false } }

  if (platform === 'win32') {
    let r = null
    try { r = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true }) } catch (e) {
      log(`[killTree] taskkill 调用失败：${e.message}`)
    }
    if (r !== null && r.error === undefined && r.status === 0) return true
    const why = r === null ? '调用异常' : (r.error !== undefined ? r.error.message : `status=${r.status} ${String(r.stderr ?? '').trim()}`)
    log(`[killTree] taskkill 未能终止 ${pid}（${why}），退回直接终止该进程`)
    // 兜底只杀宿主本体：树里的深层子进程可能残留，调用方应据此告警
    killPidOnly('SIGKILL')
    // 判据是"进程是否真的没了"而不是"信号有没有发出去"；POSIX 分支同样返回 waitGone 的结果
    return waitGone(1000)
  }

  const signalGroup = (sig) => {
    try { process.kill(-pid, sig); return true } catch (e) {
      // 该 pid 不是组长时退回杀单进程，至少别把宿主留着
      const ok = killPidOnly(sig)
      if (!ok) log(`[killTree] 无法终止 ${pid}（${sig}）：${e.code ?? e.message}`)
      return ok
    }
  }
  signalGroup('SIGTERM')
  if (waitGone(graceMs)) return true
  const killed = signalGroup('SIGKILL')
  waitGone(500)
  return killed
}

/**
 * 启动 DSH host 子进程。runtime 默认 process.execPath；--patch 由 web 子命令收集。
 * stdio 两级方案：管道优先（能拿到子进程遗言），受限环境建不了管道时退化为 fd 直通（保功能）。
 */
export function startHost({ runtime = process.execPath, bin, home, ws, port, patchFile, logFile, stderrLogFile, ringLines = 60, extraEnv = {} }) {
  let fdOut = null
  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    fs.appendFileSync(logFile, `\n--- run ${new Date().toISOString()} ---\n`)
    fdOut = fs.openSync(logFile, 'a')
  }
  fs.mkdirSync(path.dirname(stderrLogFile || logFile || path.join(process.cwd(), 'x')), { recursive: true })
  if (stderrLogFile) fs.appendFileSync(stderrLogFile, `\n--- run ${new Date().toISOString()} ---\n`)
  const fdErr = stderrLogFile ? fs.openSync(stderrLogFile, 'a') : null
  const inner = []
  if (patchFile) inner.push('--patch', patchFile)
  inner.push('--host', '127.0.0.1', '--port', String(port))
  const argv = ['--expose-internals', bin, 'web', ...inner]
  const env = {
    ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home,
    // 钉住"应用内浏览"目录选择器：rc.6 的 native 选择器（koffi COM worker）在真实选取目录时崩溃。
    // auto 解析器读 SSH_CONNECTION 即回退 browse（vendor 全树仅此一处读取该变量）。
    SSH_CONNECTION: 'dsh-desktop-browse',
    ...extraEnv,
  }

  // 探针不能拿真 argv 跑：spawnSync 会等子进程退出，真 argv 会把宿主完整启动一遍 → 冷启动白等约 2 分钟。
  // 探针只需证明同一 runtime + 同一 stdio 形状下能建管道，所以改跑一个立刻退出的等价进程。
  // 也不能用 try/catch 包 spawn 探测：Windows 上 spawn 失败是异步 'error' 事件，同步 catch 接不到。
  // 调试：DSH_HOST_STDIO=fd 强制退化。
  const probePipes = () => spawnSync(runtime, ['-e', ''], { cwd: ws, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30000 })
  let mode = process.env.DSH_HOST_STDIO === 'fd' ? 'fd' : 'pipe'
  let degradeReason = ''
  if (mode === 'pipe') {
    const probe = probePipes()
    if (probe.error && (probe.error.code === 'EPERM' || probe.error.code === 'EACCES')) {
      degradeReason = probe.error.code
      mode = 'fd'
    }
  }
  const stdio = mode === 'pipe'
    ? ['ignore', 'pipe', 'pipe']
    : ['ignore', fdOut === null ? 'ignore' : fdOut, (fdErr === null ? fdOut : fdErr) === null ? 'ignore' : (fdErr === null ? fdOut : fdErr)]
  // detached：POSIX 上让宿主自成进程组，killTree 才能一次信号收掉整棵树；Windows 由 taskkill /T 负责
  const child = spawn(runtime, argv, {
    cwd: ws, env, stdio, windowsHide: true,
    detached: process.platform !== 'win32',
  })
  child.dshStdioMode = mode
  child.dshStdioDegraded = mode === 'fd'
  child.dshStdioDegradeReason = degradeReason

  // 环形缓冲：最近 ringLines 行（stdout+stderr 合并时间序），崩溃时取尾部进通知/日志
  const buf = []
  const pushLine = (line) => {
    buf.push(line)
    if (buf.length > ringLines) buf.splice(0, buf.length - ringLines)
  }
  const pump = (stream, fd) => {
    if (!stream) return
    const dec = new StringDecoder('utf8')
    let partial = ''
    const write = (text) => {
      if (fd === null) return
      try { fs.writeSync(fd, text) } catch { /* 磁盘满/被占用：尽力而为 */ }
    }
    stream.on('data', (chunk) => {
      const text = dec.write(chunk)
      write(text)
      partial += text
      let i
      while ((i = partial.indexOf('\n')) >= 0) { pushLine(partial.slice(0, i)); partial = partial.slice(i + 1) }
      if (partial.length > 8192) { pushLine(partial); partial = '' } // 无换行的超长行也要留痕
    })
    stream.on('end', () => {
      const tail = partial + dec.end()
      if (tail.length > 0) { write(tail); pushLine(tail) }
    })
    stream.on('error', () => { /* 管道异常不影响宿主生命周期 */ })
  }
  pump(child.stdout, fdOut)
  pump(child.stderr, fdErr)
  child.dshRingLines = () => buf.slice()
  child.on('exit', () => {
    for (const fd of [fdOut, fdErr]) if (fd !== null) { try { fs.closeSync(fd) } catch { /* 已关 */ } }
  })
  return child
}
