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

/** 就绪探测：轮询 GET / 直到 200。 */
export async function waitReady(port, timeoutMs = 30000) {
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
