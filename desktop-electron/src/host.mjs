// host 托管：
//   ELECTRON_RUN_AS_NODE=1 + --expose-internals（M0 实测：Electron 内建 Node 必须带该 V8 旗标，
//   否则 dsh web 的 hmr 回退抛 "--expose-internals is required"）+ dsh 包自带 bin.js（入口零重写）。
// 监管逻辑移植自 v1 desktop-shell/launcher.mjs：数组参数 spawn（避免空格路径被拆）、
// 自选空闲端口、就绪轮询、taskkill 进程树。stdio 走文件描述符重定向（沙箱管道限制 + 天然落盘日志）。
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

/**
 * 各平台的"全局 npm 安装根"候选（三平台）。
 *
 * 旧实现里只有 `%APPDATA%\npm` 与一个写死的 `C:\Program Files\nodejs\...`：
 * 在 Linux/macOS 上这两条永不命中，于是"用户自己装了全局 dsh"的场景在非 Windows 上静默失效
 * （打包态还有随包 vendor 兜底，开发态则直接报"找不到 dsh"）。
 * @param {{env?:Record<string,string|undefined>, platform?:string}} [o] 选项（可注入以便单测）
 */
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
 * 发现 dsh bin.js：DSH_BIN 环境 > 全局 npm（三平台候选） > 各候选 npx 缓存（取最新） > 随包 vendor/profile。
 * @param {string[]} [extraRoots] 额外候选根（壳传的是随包 vendor/profile）
 * @param {{env?:Record<string,string|undefined>, platform?:string, execPath?:string, exists?:(p:string)=>boolean}} [o] 选项（可注入以便单测）
 * @returns {string|null}
 */
export function findDshBin(extraRoots = [], { env = process.env, platform = process.platform, execPath = process.execPath, exists = fs.existsSync } = {}) {
  if (env.DSH_BIN && exists(env.DSH_BIN)) return env.DSH_BIN
  const candidates = []
  for (const root of globalNpmRoots({ env, platform })) candidates.push(path.join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  for (const dir of extraRoots) candidates.push(path.join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  for (const p of candidates) if (exists(p)) return p

  // npx 缓存扫描根：Electron 壳里 execPath 是 electron 可执行文件（锚点错），
  // 必须显式纳入系统 Node 目录（v1 壳在 Node 下 execPath 即系统 Node，故无需）
  const cacheRoots = new Set([path.dirname(execPath)])
  if (env.ProgramFiles) cacheRoots.add(path.join(env.ProgramFiles, 'nodejs'))
  if (env.LOCALAPPDATA) cacheRoots.add(env.LOCALAPPDATA)
  if (env.HOME) {
    // POSIX：npx 缓存在 ~/.npm/_npx（三平台命名一致，但根目录不同）
    cacheRoots.add(env.HOME)
    cacheRoots.add(path.join(env.HOME, '.npm'))
  }
  for (const dir of whichNodeDirs({ env, platform, exists })) cacheRoots.add(dir)
  for (const root of cacheRoots) {
    // 逐级尝试两种 npx 缓存布局：<root>/node_cache/_npx（Windows 本机）、<root>/npm-cache/_npx、
    // <root>/_npx（~/.npm 本身就是缓存根）
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

/**
 * 系统 Node 的安装目录（用于定位 npx 缓存）。
 * POSIX 上**不能** spawn `which`：容器/精简镜像里常常没有它，正确做法是在 PATH 里逐个查可执行文件。
 * `exists` 可注入：单测要能把 PATH 指向自己搭的假目录（真实系统路径会污染断言）。
 */
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

/**
 * 杀**整棵进程树**。
 *
 * Windows：`taskkill /T /F`（系统级实现，最可靠）。**必须判 spawnSync 的返回值**：
 *   被策略/沙箱拒绝时它是 `{error: EPERM}` 而**没有异常**——旧写法只看"没抛错"，
 *   于是"没杀掉"会被当成"杀掉了"（本机沙箱实测就是这个形态）。
 * POSIX：宿主是以 `detached: true` 启动的进程组组长，所以对 `-pid` 发信号即覆盖整组；
 *   先 SIGTERM 给宿主一个收尾机会，宽限期内没退再 SIGKILL。
 * 旧实现只有 `taskkill`：POSIX 上 spawnSync 抛 ENOENT 被 catch 吞掉，于是宿主进程树
 * **完全没被杀**——壳退出后 `dsh web` 继续跑、`.dsh-host.lock` 继续占着，下次启动复用到一个
 * 孤儿宿主。
 * @param {number} pid 宿主进程（组组长）pid
 * @param {{platform?:string, graceMs?:number, log?:(m:string)=>void}} [o] 选项（可注入以便单测）
 * @returns {boolean} 是否确认已发出终止动作（false 表示调用方需要自己告警）
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
    // 兜底只杀宿主本体：树里的深层子进程可能残留，调用方（退出编排）应据此告警
    killPidOnly('SIGKILL')
    // ⚠️ 判据是"**进程是否真的没了**"，不是"信号有没有发出去"（2026-09-17 修）。
    // 旧写法 `return killPidOnly('SIGKILL')` 只说明 `process.kill` 没抛异常，
    // 而"发了信号但进程赖着不退"（僵尸/句柄未放/D 状态）时它照样返回 true；
    // 更别扭的是同一函数的 POSIX 分支返回的正是 `waitGone(...)` 的结果 —— 两条路契约不一致。
    // 现在两路统一：**确认已消失才返回 true**，否则 false（调用方据此告警）。
    return waitGone(1000)
  }

  const signalGroup = (sig) => {
    try { process.kill(-pid, sig); return true } catch (e) {
      // 该 pid 不是组长（spawn 时没 detached）时 EPERM/ESRCH：退回杀单进程，至少别把宿主留着
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
 * 启动 DSH host 子进程（模式 B）。runtime 默认 process.execPath：
 * Electron 主进程内即 electron.exe，RUN_AS_NODE 下等同 Node（零额外运行时）。
 * --patch 由 web 子命令收集，--host/--port 透传进 web 应用层。
 *
 * **stdio 用两级方案：管道优先，受限环境退化 fd 直通**（2026-09-12 修正两轮）：
 * 旧写法只有 `stdio: ['ignore', fdOut, fdOut]`（fd 交给子进程、父进程从不读），于是子进程崩溃时
 * 它 stderr 里的真因（`fatal load failure: …` / 裸异常栈）**随进程消失**——实测 `host.log`
 * 反复退化成"只有一行 `--- run … ---`"，三轮排查都拿不到那句话；fd 的共享文件位置还停在打开时的 EOF。
 * 但**只改成管道也会出事**：受限会话里 `stdio:'pipe'` 被拒（`spawn EPERM`），把能跑的机器搞成起不来。
 * ⇒ 现在的口径：`spawnSync` 探一次管道可用性，可用走管道（能拿到遗言），被拒走 fd（保功能）。
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
    // 钉住"应用内浏览"目录选择器（0.4.4）：rc.6 的 native 选择器（koffi COM worker）
    // 在真实选取目录时崩溃（worker 静默死亡 → "win32 folder dialog worker exited
    // before reporting a result"）。auto 解析器读取 SSH_CONNECTION 即回退 browse
    // （vendor 全树仅此一处读取该变量，语义安全），GUI 改用纯 Node 的应用内目录浏览。
    SSH_CONNECTION: 'dsh-desktop-browse',
    ...extraEnv,
  }

  /**
   * 两级启动：**管道优先，受限环境自动退化为 fd 直通**（2026-09-12 实测定的口径）。
   *
   * 为什么要两级：Node 的 `stdio:'pipe'` 要创建匿名管道，在受限/沙箱会话里会被子进程创建
   * 策略拒绝；而 fd 直通（`stdio:['ignore',fd,fd]`）不走管道、反而能起。
   * ⇒ 只留管道版 = 把"本来能跑的机器"变成起不来（自己制造的回归）；
   * ⇒ 只留 fd 版 = 回到"崩溃真因随进程消失"（本函数顶部注释记录的老问题）。
   *
   * **踩过的坑（务必保留这段注释）**：不能用 `try { spawn(pipe) } catch {}` 来探测 ——
   * Windows 上 `spawn` 失败是**异步 `'error'` 事件**（libuv 的 uv_spawn 错误在事件循环里派发），
   * 同步 catch 什么都接不到；实测后果是"假成功"：child 已死、却照常返回给调用方，
   * 表现为宿主一个字节都不输出、30 秒后判不就绪（比原问题更隐蔽）。
   * ⇒ 改用 `spawnSync` 探测（同步拿到 `error`），再用选定的 stdio 正式 `spawn` 一次。
   * 调试：`DSH_HOST_STDIO=fd` 强制退化。
   *
   * ⚠️ **探针不能拿真 argv 跑**：spawnSync 会等子进程退出，而"能建管道的机器"上真 argv 会把
   * 宿主完整启动一遍 → 冷启动白等约 2 分钟（实测 `error=ETIMEDOUT`）。探针只需证明
   * "同一 runtime + 同一 stdio 形状下能建管道"，所以改跑一个立刻退出的等价进程。
   */
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
  // detached: POSIX 上让宿主自成**进程组**，这样 killTree 能一次信号收掉整棵树
  // （宿主自己还会 spawn 目录选择器 worker、npm 等子进程）。Windows 上 detached 语义不同，
  // 且那边由 `taskkill /T` 负责整树，所以只在 POSIX 打开。
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
      try { fs.writeSync(fd, text) } catch { /* 磁盘满/被占用：日志尽力而为 */ }
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
