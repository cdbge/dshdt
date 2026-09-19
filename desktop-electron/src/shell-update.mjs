// shell-update.mjs — 把仓库里下好的壳源码换进 app.asar（必须由助手进程在应用退出后做）
//
// app.asar 是当前进程正在读的文件，不能就地覆盖；助手脚本放在 $DSH_HOME（必须在 asar 之外），
// 用 `ELECTRON_RUN_AS_NODE=1 <应用可执行文件> <助手> <配置>` 跑。替换后先用 --smoke 校验新壳，
// 失败自动回滚旧壳。安装目录不可写时（deb / AppImage）如实拒绝。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { patchAsarFile } from './asar-patch.mjs'

export function shellSourceDir(home) {
  return path.join(home, 'repo-updates', 'shell-src')
}
export function shellWorkDir(home) {
  return path.join(home, 'repo-updates', 'shell-swap')
}
export function asarPathOf(resourcesPath) {
  return path.join(resourcesPath, 'app.asar')
}

/**
 * 可写性探测：直接试写临时文件（权限位不足以判断只读挂载）。
 * @param {string} resourcesPath 打包态 resources 目录
 * @returns {{writable:boolean, reason:string}}
 */
export function probeShellWritable(resourcesPath) {
  const probe = path.join(resourcesPath, `.dsh-write-probe-${process.pid}`)
  try {
    fs.writeFileSync(probe, 'ok')
    fs.rmSync(probe, { force: true })
    return { writable: true, reason: '' }
  } catch (e) {
    return { writable: false, reason: `安装目录不可写（${e.code ?? e.message}）：这个安装形态的壳文件是只读的，请用安装包更新` }
  }
}

/**
 * 用暂存的壳源码打一个新 asar（保留 asar 里的其它一切）。
 * @param {{home:string, resourcesPath:string, files:string[], log?:(m:string)=>void}} o 参数
 *        `files` = 要替换的 asar 内路径（如 `src/main.mjs`、`VERSION`、`package.json`）
 * @returns {{ok:true, stagedAsar:string, written:string[], bytes:number}|{ok:false, error:string}}
 */
export function buildPatchedAsar({ home, resourcesPath, files, log = () => {} }) {
  const srcDir = shellSourceDir(home)
  const srcAsar = asarPathOf(resourcesPath)
  if (!fs.existsSync(srcAsar)) return { ok: false, error: `找不到 app.asar：${srcAsar}（开发态没有 asar，换壳只在打包态可用）` }
  const replace = new Map()
  for (const rel of files) {
    const abs = path.join(srcDir, rel)
    let buf
    try { buf = fs.readFileSync(abs) } catch { return { ok: false, error: `暂存的壳源码缺文件：${rel}（先点"更新"把它下下来）` } }
    replace.set(rel, buf)
  }
  if (replace.size === 0) return { ok: false, error: '没有可替换的壳源码' }
  const work = shellWorkDir(home)
  fs.mkdirSync(work, { recursive: true })
  const stagedAsar = path.join(work, 'app.asar.new')
  const r = patchAsarFile(srcAsar, stagedAsar, { replace, log })
  if (!r.ok) return r
  log(`[shell-update] 新 asar 已打好：${stagedAsar}（换 ${r.written.length} 个文件，共 ${r.bytes} 字节）`)
  return { ok: true, stagedAsar, written: r.written, bytes: r.bytes }
}

/**
 * 助手脚本正文：自包含、零依赖（它要跑在"旧壳已退出、新壳还没起"的窗口里）。
 * 流程：等父进程退出 → 备份并替换 asar → `--smoke` 校验 → 通过则重启，失败则回滚后重启。
 * @returns {string} 脚本文本
 */
export function helperScriptText() {
  return `// 由 dshdt 自动生成：换 app.asar 的助手（在应用退出后运行，见 src/shell-update.mjs）
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const LOG = cfg.logFile
const log = (m) => { try { fs.appendFileSync(LOG, \`[\${new Date().toISOString()}] \${m}\\n\`) } catch { /* 尽力而为 */ } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等父进程退出。pid<=0 表示不用等（单测用）。 */
async function waitForExit(pid, timeoutMs) {
  if (!(pid > 0)) return true
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try { process.kill(pid, 0) } catch { return true } // ESRCH = 已经没了
    await sleep(250)
  }
  return false
}

/** 用新壳跑一次冒烟：输出里必须出现 PASS 计数或 SMOKE OK。 */
function smokePasses(exe, args, env) {
  const outFile = \`\${cfg.workDir}/smoke.log\`
  let fd
  try { fd = fs.openSync(outFile, 'w') } catch (e) { log(\`冒烟日志打不开：\${e.message}\`); return false }
  try {
    const r = spawnSync(exe, args, { env, stdio: ['ignore', fd, fd], timeout: cfg.smokeTimeoutMs })
    const text = (() => { try { return fs.readFileSync(outFile, 'utf8') } catch { return '' } })()
    if (r.error) { log(\`冒烟进程起不来：\${r.error.message}\`); return false }
    const okCount = /(\\d+)\\/\\1 PASS/.test(text) || text.includes('SMOKE OK')
    log(\`冒烟结果：status=\${r.status} signal=\${r.signal ?? '-'} 命中 PASS 计数=\${okCount}\`)
    if (!okCount) log(\`冒烟输出尾部：\\n\${text.split('\\n').slice(-25).join('\\n')}\`)
    return okCount
  } finally { try { fs.closeSync(fd) } catch { /* 略 */ } }
}

function relaunch() {
  try {
    // 环境用"干净的那份"：助手自己是 ELECTRON_RUN_AS_NODE=1 起的，继承下去新壳会退化成纯 Node
    const p = spawn(cfg.execPath, cfg.relaunchArgs, { env: cfg.relaunchEnv ?? process.env, detached: true, stdio: 'ignore', cwd: cfg.appCwd })
    p.unref()
    log('已重新启动应用')
  } catch (e) { log(\`重启失败（请手动打开应用）：\${e.message}\`) }
}

const asar = path.join(cfg.resourcesPath, 'app.asar')
const backup = \`\${asar}.bak-\${Date.now()}\`
log(\`=== 换壳开始（父进程 \${cfg.parentPid}）===\`)

const gone = await waitForExit(cfg.parentPid, cfg.waitTimeoutMs)
if (!gone) { log('父进程一直没退出，放弃换壳（应用仍在运行）'); process.exit(10) }
if (!fs.existsSync(cfg.stagedAsar)) {
  log(\`找不到新 asar：\${cfg.stagedAsar}\`)
  try { fs.writeFileSync(cfg.markerFile, JSON.stringify({ ok: false, at: new Date().toISOString(), error: 'staged-asin-missing', stage: 'prepare' })) } catch { /* 略 */ }
  relaunch() // 应用已经退出了：必须把它拉回来
  process.exit(11)
}

/** 改名重试：应用刚退出时 Windows 还没释放 app.asar 的文件映射，立刻改名会 EBUSY。 */
function renameWithRetry(from, to, timeoutMs) {
  const t0 = Date.now()
  let last = null
  for (;;) {
    try { fs.renameSync(from, to); return { ok: true, waited: Date.now() - t0 } } catch (e) {
      last = e
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(e.code) || Date.now() - t0 >= timeoutMs) return { ok: false, error: e, waited: Date.now() - t0 }
      const sab = new Int32Array(new SharedArrayBuffer(4))
      Atomics.wait(sab, 0, 0, 500)
    }
  }
}

try {
  const mv = renameWithRetry(asar, backup, cfg.lockWaitMs ?? 180000)
  if (!mv.ok) throw mv.error
  if (mv.waited > 1000) log(\`等文件解锁用了 \${(mv.waited / 1000).toFixed(1)}s（Windows 释放映射需要时间）\`)
  const mv2 = renameWithRetry(cfg.stagedAsar, asar, 10000)
  if (!mv2.ok) {
    // 新件没就位：把备份放回原位，保证应用还能起
    try { fs.renameSync(backup, asar); log('新件就位失败，已把备份放回原位') } catch (e2) { log(\`备份回位失败：\${e2.message}\`) }
    throw mv2.error
  }
  log(\`已替换：\${asar}（备份 \${path.basename(backup)}）\`)
} catch (e) {
  log(\`替换失败：\${e.message}\`)
  if (!fs.existsSync(asar) && fs.existsSync(backup)) { try { fs.renameSync(backup, asar); log('已把备份放回原位') } catch { /* 略 */ } }
  try { fs.writeFileSync(cfg.markerFile, JSON.stringify({ ok: false, at: new Date().toISOString(), error: String(e.message), stage: 'replace' })) } catch { /* 略 */ }
  // **失败也必须把应用拉起来**：否则用户面对的是"点了按钮应用就没了"
  relaunch()
  process.exit(12)
}

const pass = smokePasses(cfg.execPath, cfg.smokeArgs, cfg.smokeEnv)

if (pass) {
  log('新壳冒烟通过，保留备份并重启')
  fs.writeFileSync(cfg.markerFile, JSON.stringify({ ok: true, at: new Date().toISOString(), backup }))
  relaunch()
  process.exit(0)
}

const broken = \`\${asar}.broken-\${Date.now()}\`
try {
  fs.renameSync(asar, broken)
  fs.renameSync(backup, asar)
  log(\`新壳没通过自检，已回滚（坏包留在 \${path.basename(broken)}）\`)
} catch (e) {
  log(\`回滚失败（需要人工处理）：\${e.message}\`)
}
fs.writeFileSync(cfg.markerFile, JSON.stringify({ ok: false, at: new Date().toISOString(), broken }))
relaunch()
process.exit(20)
`
}

/**
 * 准备一次换壳：打新 asar → 写助手脚本与配置。调用方随后 spawn 助手并退出应用。
 * @param {{home:string, resourcesPath:string, execPath:string, files:string[], appDataDir:string,
 *          dshHome:string, relaunchArgs?:string[], parentPid?:number, smokeTimeoutMs?:number,
 *          waitTimeoutMs?:number, platform?:string, log?:(m:string)=>void}} o 参数
 * @returns {{ok:true, helperPath:string, configPath:string, stagedAsar:string, helperArgs:string[],
 *          helperEnv:object, written:string[], logFile:string, markerFile:string}|{ok:false, error:string}}
 */
export function planShellSwap({
  home, resourcesPath, execPath, files, appDataDir, dshHome,
  relaunchArgs = [], parentPid = process.pid, smokeTimeoutMs = 240000, waitTimeoutMs = 300000,
  lockWaitMs = 180000, platform = process.platform, log = () => {},
}) {
  const probe = probeShellWritable(resourcesPath)
  if (!probe.writable) return { ok: false, error: probe.reason }
  const built = buildPatchedAsar({ home, resourcesPath, files, log })
  if (!built.ok) return built
  const work = shellWorkDir(home)
  fs.mkdirSync(work, { recursive: true })
  const helperPath = path.join(work, 'apply-shell.mjs')
  const configPath = path.join(work, 'apply-shell.json')
  const markerFile = path.join(work, 'last-swap.json')
  const logFile = path.join(work, 'swap.log')
  // 摘掉 ELECTRON_RUN_AS_NODE：助手进程带着它起来，冒烟/重启继承下去会让 Electron 退化成纯 Node
  const baseEnv = { ...process.env }
  delete baseEnv.ELECTRON_RUN_AS_NODE
  // 冒烟换一个 APP_DATA（不写坏用户设置），但沿用真实 DSH_HOME（避免首启拷贝整棵 vendor）
  const smokeEnv = { ...baseEnv, DSH_APP_DATA: path.join(work, 'smoke-appdata'), DSH_HOME: dshHome, DSH_SMOKE: '1' }
  const smokeArgs = ['--smoke', '--disable-gpu']
  if (platform === 'linux') smokeArgs.push('--no-sandbox')
  const cfg = {
    resourcesPath, stagedAsar: built.stagedAsar, parentPid, execPath,
    relaunchArgs, relaunchEnv: baseEnv, appCwd: path.dirname(execPath), smokeArgs, smokeEnv,
    smokeTimeoutMs, waitTimeoutMs, lockWaitMs, workDir: work, logFile, markerFile,
  }
  fs.writeFileSync(helperPath, helperScriptText())
  fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`)
  log(`[shell-update] 助手就绪：${helperPath}（新 asar ${built.stagedAsar}）`)
  return {
    ok: true,
    helperPath,
    configPath,
    stagedAsar: built.stagedAsar,
    logFile,
    markerFile,
    helperArgs: [helperPath, configPath],
    helperEnv: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    written: built.written,
  }
}

/**
 * 启动助手（detached）。调用方拿到 ok 后应尽快退出应用（助手在等）。
 * @param {{execPath:string, helperArgs:string[], helperEnv:object, cwd?:string}} o 参数
 * @returns {{ok:boolean, pid?:number, error?:string}}
 */
export function spawnSwapHelper({ execPath, helperArgs, helperEnv, cwd }) {
  try {
    const p = spawn(execPath, helperArgs, { env: helperEnv, detached: true, stdio: 'ignore', cwd })
    p.unref()
    return { ok: true, pid: p.pid }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}
