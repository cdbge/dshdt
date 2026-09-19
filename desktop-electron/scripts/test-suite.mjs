// test-suite.mjs — 离线自检总入口（"一条命令跑完全部门禁"）
//
// 用法：node scripts/test-suite.mjs [--list] [--only <子串>]
//
// 为什么需要它：门禁散在 11 个脚本里，本地要背一串命令，CI 里要写重复的 step —— 两边的清单
// 一定会漂移（README 声称"改动后必跑"，而 CI 里可能一条都没跑，这正是跨平台改造前的状态）。
// 这里把清单收敛成**唯一一份**，本地与 CI 共用；断言数也由它统计，README 的数字不再靠人记。
//
// 口径：全部脱网、秒级；不启动 Electron（`smoke.mjs` 需完整权限的 GUI 会话，单独跑，不在本清单里）。
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 清单顺序：先平台/基础层，再构建原语，最后业务面。名字即路径，避免"清单里写的是一个不存在的文件"。 */
const SUITES = [
  'scripts/platform-self-test.mjs',
  'scripts/host-platform-self-test.mjs',
  'scripts/ci-self-test.mjs',
  'scripts/jpeg-decode-self-test.mjs',
  'scripts/vendor-baseline-self-test.mjs',
  'scripts/vendor-home-self-test.mjs',
  'scripts/junction-safe-self-test.mjs',
  'scripts/vendor-build-self-test.mjs',
  'scripts/cross-tree-self-test.mjs',
  'scripts/check-assets-self-test.mjs',
  'scripts/check-vendor-lock-self-test.mjs',
  'scripts/dsh-apply-self-test.mjs',
  'scripts/update-self-test.mjs',
  'scripts/repair-self-test.mjs',
  'scripts/patch-mount-self-test.mjs',
  // 外观设置的**迁移规则**：只在存量用户机器上跑一次、跑错就永久写坏 settings.json，
  // 而它原来内联在 main.mjs 里（测试进程根本 import 不了）—— 所以抽成 src/skin-settings.mjs 后必须挂上来。
  'scripts/skin-settings-self-test.mjs',
  // 壁纸注入 CSS 的**生成物**门禁（2026-09-18）：那一段"把不透明层置透明"的规则里
  // 曾写着 `#root > div`（只匹配直接子元素），而框架层在第三层 ⇒ 从来没命中过，
  // 表现为"毛玻璃看不出效果"（背后是纯黑，糊了等于没糊）。它同样内联在 main.mjs 里没有门禁，
  // 一并抽成 src/bg-css.mjs。⚠️ 这一门测的是**选择器能不能命中真实路径**，不是"源码里有没有这个词"。
  'scripts/bg-css-self-test.mjs',
  'scripts/admin-bg-test.mjs',
  // 市场安装链路：解包的**安全判据**（zip-slip / ADS / 歧义路径等恶意形态）必须每次改动都跑——
  // 这类判据只有恶意夹具能证明，靠"正常包能解开"什么都证明不了。
  'scripts/zip-safe-self-test.mjs',
  'scripts/market-install-self-test.mjs',
  // 官方安装路径（`dsh plugin add`）：坐标校验 + 缺 pnpm / 构建脚本被拦 / 超时 / "假成功"分档
  'scripts/market-install-official-self-test.mjs',
  // pnpm 的**定位**判据（2026-09-18）：老判据只 `spawn('pnpm')` 靠 PATH，而壳里那份 PATH 常常
  // 不含用户级全局目录 ⇒ 用户装了还说缺。新判据先按绝对路径候选找（`node <pnpm.cjs>` 直调）
  // 再退回 PATH，并把 pnpm 目录注入子进程 PATH。这条必须在**不 spawn 真进程**的前提下被测到。
  'scripts/pnpm-resolve-self-test.mjs',
  // harness × Electron 的**运行时兼容判据**：0.1.6-alpha.2 起 DSH 默认改用
  // runtime 解析，必须给 Node 内部 loader 打补丁，而补丁按**精确 V8 指纹**放行——壳里钉的
  // Electron 43.4.0（V8 15.0.245.28）不在白名单（43.0.0/44.0.0/45.0.0-alpha.6）⇒ 宿主启动即退。
  // 这门钉两件事：白名单能从 addon 二进制里解析出来，以及判据**接在构建之前**（不是装完才发现）。
  'scripts/harness-compat-self-test.mjs',
  // 托盘/窗口图标的**平台判据** + 三条"打开主窗"入口：Linux/macOS 的图标解码
  // 不认 .ico（实测解成 0×0 空图）⇒ 托盘建了却没像素可画、Waybar 什么也不显示；而 Linux 上
  // `double-click` 事件根本不存在（文档标注 _macOS_ _Windows_）、`click` 里又排除了非 darwin
  // ⇒ 点了没反应。两条都是平台分支，集成测试跑不到，只能靠纯函数 + 源码接线断言钉住。
  'scripts/tray-icon-self-test.mjs',
  'packages/dsh-auto-approval/test/grade-self-test.mjs',
  'packages/dsh-auto-approval/test/apply-self-test.mjs',
  // 客户端插件的**装载期**自检：真跑 factory，等价于 DSH 的 import 阶段。
  // 这一门是 2026-09-17 一次"整页 Failed to load plugins"换来的 —— `node --check` 只解析不求值，
  // 抓不到"模块体里引用了只在 apply() 里声明过的名字"这类错（它会让整个应用卡在启动页）。
  'scripts/client-plugin-load-self-test.mjs',
]

const argv = process.argv.slice(2)
const onlyIdx = argv.indexOf('--only')
const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null

if (argv.includes('--list')) {
  for (const s of SUITES) console.log(s)
  process.exit(0)
}

const picked = only === null ? SUITES : SUITES.filter((s) => s.includes(only))
if (picked.length === 0) {
  console.error(`[test-suite] --only ${only} 没有匹配到任何套件`)
  process.exit(2)
}

/** 统计 PASS 行（各套件都打印 `PASS` / `✓` 前缀，口径统一）。 */
const countPass = (text) => (text.match(/^\s*(?:PASS|✓)\s/gm) ?? []).length
const countFail = (text) => (text.match(/^\s*(?:FAIL|✗)\s/gm) ?? []).length

/**
 * 跑一个套件并把输出取回来。
 *
 * **不能用管道 stdio**：受限会话里创建匿名管道会被拒（`spawnSync` 返回 `EPERM`，`status=null`、
 * `stdout` 为空）——项目里反复记录过这个坑（宿主 stdio 两级化的成因）。子进程的输出一律
 * **重定向到临时文件再读**，这样在沙箱与 CI 里是同一套行为。
 * @param {string} abs 套件绝对路径
 * @returns {{status:number|null, out:string, spawnError?:string}}
 */
function runSuite(abs) {
  const logFile = path.join(os.tmpdir(), `dsh-suite-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.log`)
  let fd = 'ignore'
  try { fd = fs.openSync(logFile, 'w') } catch { fd = 'ignore' }
  let r
  try {
    r = spawnSync(process.execPath, [abs], { cwd: ROOT, stdio: ['ignore', fd, fd] })
  } finally {
    if (fd !== 'ignore') { try { fs.closeSync(fd) } catch { /* 已关 */ } }
  }
  let out = ''
  try { out = fs.readFileSync(logFile, 'utf8') } catch { out = '' }
  fs.rmSync(logFile, { force: true })
  return {
    status: r === undefined ? null : r.status,
    out,
    spawnError: r?.error === undefined ? undefined : String(r.error.message ?? r.error),
  }
}

let totalPass = 0
let totalFail = 0
const broken = []

for (const rel of picked) {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) { broken.push(`${rel}（文件不存在）`); continue }
  const t0 = Date.now()
  const r = runSuite(abs)
  const out = r.out
  const pass = countPass(out)
  const fail = countFail(out)
  totalPass += pass
  totalFail += fail
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  const ok = r.status === 0
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${rel.padEnd(52)} pass=${String(pass).padStart(3)} fail=${fail} exit=${r.status} ${secs}s`)
  if (!ok) {
    // 失败就地把输出打出来：CI 里最怕"只知道红了、不知道为什么"
    if (r.spawnError !== undefined) console.log(`        子进程启动失败：${r.spawnError}`)
    console.log(out.split('\n').filter((l) => /FAIL|Error|error:/.test(l)).slice(0, 12).map((l) => `        ${l}`).join('\n'))
  }
}

console.log(`\n[test-suite] 共 ${picked.length} 套：pass=${totalPass} fail=${totalFail}`)
if (broken.length > 0) {
  console.error(`[test-suite] 清单里有不存在的套件：${broken.join(' / ')}`)
  process.exit(2)
}
process.exit(totalFail === 0 ? 0 : 1)
