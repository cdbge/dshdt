// shell-update.mjs — 把"仓库里下载好的壳源码"换成**正在运行的这个壳**（1.0.0 的唯一功能）
//
// 为什么不能就地换（这是整件事的难点）：
//   `resources/app.asar` 是**当前进程正在读**的文件（主进程的代码就在里面）。Windows 上文件被占用，
//   直接覆盖会失败；就算写成功，正在跑的进程也还是旧代码。所以必须：
//     ① 先在**没被占用**的地方把新 asar 打好（`$DSH_HOME/repo-updates/app.asar.new`）；
//     ② 由一个**独立助手进程**在本应用退出之后做替换 —— 助手脚本放在 `$DSH_HOME` 下（**必须在 asar 之外**，
//        否则"换 asar"这个动作本身会被它要替换的那份代码执行）；
//     ③ 替换完**先用 `--smoke` 校验新壳**，失败立刻回滚并启动旧壳（0.4.6 那次"坏 asar 双击即崩"
//        的教训：产物级门禁比任何静态检查都值）。
//
// 助手怎么跑：`ELECTRON_RUN_AS_NODE=1 <应用可执行文件> <助手脚本> <配置 json>` —— 用应用自带的
// Electron 二进制当 Node 用，不要求用户机器上有 node（比"找系统 node"可靠得多）。
//
// 可写性：这个能力**只在安装目录可写时**成立（Windows 的按用户 NSIS 安装 ✓、用户自己解压的目录 ✓、
// macOS 拖拽安装的 .app ✓）；Linux 的 deb（/opt，root 所有）与 AppImage（squashfs 只读挂载）✗。
// 写不了就**如实拒绝**（明确告诉用户"用安装包更新"），绝不假装成功。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { patchAsarFile } from './asar-patch.mjs'

/** 壳源码在 `$DSH_HOME` 下的暂存目录（平面 C 的 `shell-asar` 组件就落在这里）。 */
export function shellSourceDir(home) {
  return path.join(home, 'repo-updates', 'shell-src')
}
/** 换壳用的工作目录（新 asar、助手脚本、配置、日志都放这里）。 */
export function shellWorkDir(home) {
  return path.join(home, 'repo-updates', 'shell-swap')
}
/** 打包态的 asar 路径。 */
export function asarPathOf(resourcesPath) {
  return path.join(resourcesPath, 'app.asar')
}

/**
 * 可写性探测：**光看权限位不够**（AppImage 的只读挂载、Windows 上被别的进程占用的目录都可能骗过它），
 * 所以直接试着在 `resources/` 下建一个临时文件再删掉。
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
 * 用暂存的壳源码打一个新的 asar（保留 asar 里的其它一切：node_modules 等）。
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
 * 助手脚本正文。
 *
 * 刻意写成**自包含、零依赖**的一段代码：它在"应用已经退出、新壳还没起来"的窗口里跑，
 * 只能用 Node 内建模块（不能用仓库里的任何模块——那些正躺在要被替换的 asar 里）。
 *
 * 顺序（每一步失败都要能回到"应用还能起"的状态）：
 *   ① 等父进程退出（父进程还在时 Windows 上换不掉文件）
 *   ② `app.asar` → `app.asar.bak-<ts>`，`app.asar.new` → `app.asar`
 *   ③ 跑一次 `<exe> --smoke`：**新壳必须自己能启动**
 *   ④ 通过 → 留着 .bak（便于人工回滚）并重启应用；不通过 → 把坏壳挪走、.bak 换回来、启动旧壳
 * @param {object} cfg 配置（见 planShellSwap）
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

/** 等父进程退出。pid<=0 表示"不用等"（单测用）。 */
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
    // 环境必须是"干净的那份"（relaunchEnv）：助手自己是 ELECTRON_RUN_AS_NODE=1 起来的，
    // 继承下去会让新壳退化成纯 Node（本地实测：bad option: --smoke）
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
if (!fs.existsSync(cfg.stagedAsar)) { log(\`找不到新 asar：\${cfg.stagedAsar}\`); process.exit(11) }

// ② 备份 + 就位
try {
  fs.renameSync(asar, backup)
  fs.renameSync(cfg.stagedAsar, asar)
  log(\`已替换：\${asar}（备份 \${path.basename(backup)}）\`)
} catch (e) {
  log(\`替换失败：\${e.message}\`)
  if (!fs.existsSync(asar) && fs.existsSync(backup)) { try { fs.renameSync(backup, asar); log('已把备份放回原位') } catch { /* 略 */ } }
  process.exit(12)
}

// ③ 新壳自检
const pass = smokePasses(cfg.execPath, cfg.smokeArgs, cfg.smokeEnv)

if (pass) {
  log('新壳冒烟通过，保留备份并重启')
  fs.writeFileSync(cfg.markerFile, JSON.stringify({ ok: true, at: new Date().toISOString(), backup }))
  relaunch()
  process.exit(0)
}

// ④ 回滚
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
 * 准备一次换壳：打新 asar → 写助手脚本与配置 → （由调用方）spawn 助手 → （由调用方）退出应用。
 * @param {{home:string, resourcesPath:string, execPath:string, files:string[], appDataDir:string,
 *          dshHome:string, relaunchArgs?:string[], parentPid?:number, smokeTimeoutMs?:number,
 *          waitTimeoutMs?:number, platform?:string, log?:(m:string)=>void}} o 参数
 * @returns {{ok:true, helperPath:string, configPath:string, stagedAsar:string, helperArgs:string[], helperEnv:object}
 *          |{ok:false, error:string}}
 */
export function planShellSwap({
  home, resourcesPath, execPath, files, appDataDir, dshHome,
  relaunchArgs = [], parentPid = process.pid, smokeTimeoutMs = 240000, waitTimeoutMs = 60000,
  platform = process.platform, log = () => {},
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
  // ⚠️ **必须摘掉 `ELECTRON_RUN_AS_NODE`**（本项目反复踩过这个坑，见 smoke.mjs 里同一句）：
  // 助手进程本身就是用 `ELECTRON_RUN_AS_NODE=1` 起来的，而它 `spawn` 出来的"新壳/冒烟"如果继承了这个
  // 变量，Electron 会**退化成纯 Node** ⇒ 报 `bad option: --smoke`（本地实测抓到），
  // 表现为"换壳成功但应用再也起不来"。冒烟与重启两个环境都要干净。
  const baseEnv = { ...process.env }
  delete baseEnv.ELECTRON_RUN_AS_NODE
  // 冒烟环境：**换一个 APP_DATA**（设置/状态不该被自检写坏），但**沿用真实 DSH_HOME**
  // ——后者装着几万个文件的 vendor 树，另起一个临时 home 会触发一次 100 MB 级的首次拷贝（分钟级）。
  const smokeEnv = { ...baseEnv, DSH_APP_DATA: path.join(work, 'smoke-appdata'), DSH_HOME: dshHome, DSH_SMOKE: '1' }
  const smokeArgs = ['--smoke', '--disable-gpu']
  if (platform === 'linux') smokeArgs.push('--no-sandbox') // 见 smoke.mjs 顶部注释（SUID 沙箱在多数 Linux 上没配好）
  const cfg = {
    resourcesPath, stagedAsar: built.stagedAsar, parentPid, execPath,
    relaunchArgs, relaunchEnv: baseEnv, appCwd: path.dirname(execPath), smokeArgs, smokeEnv,
    smokeTimeoutMs, waitTimeoutMs, workDir: work, logFile, markerFile,
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
    // ELECTRON_RUN_AS_NODE=1：用应用自带的 Electron 当 Node 跑助手（不要求用户机器有 node）
    helperArgs: [helperPath, configPath],
    helperEnv: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    written: built.written,
  }
}

/**
 * 启动助手（detached）：它会等本进程退出，然后换壳 → 自检 → 重启。
 * 调用方拿到 ok 之后应**尽快退出应用**（助手在等我们）。
 * @param {{execPath:string, helperArgs:string[], helperEnv:object, cwd?:string}} o 参数
 * @returns {{ok:boolean, error?:string}}
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
