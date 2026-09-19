// test-suite.mjs — 离线自检总入口（"一条命令跑完全部门禁"），本地与 CI 共用同一份清单。
// 用法：node scripts/test-suite.mjs [--list] [--only <子串>]
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// 清单顺序：先平台/基础层，再构建原语，最后业务面。名字即路径
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
  // 外观迁移规则只在存量用户机器上跑一次、跑错就永久写坏 settings.json，且它原本内联在 main.mjs 里
  'scripts/skin-settings-self-test.mjs',
  // 壁纸注入 CSS 的生成物门禁：测的是"选择器能不能命中真实路径"，不是"源码里有没有这个词"
  'scripts/bg-css-self-test.mjs',
  'scripts/admin-bg-test.mjs',
  // 市场安装链路：解包的安全判据只有恶意夹具能证明
  'scripts/zip-safe-self-test.mjs',
  'scripts/market-install-self-test.mjs',
  // 官方安装路径（dsh plugin add）：坐标校验 + 缺 pnpm / 构建脚本被拦 / 超时 / "假成功"分档
  'scripts/market-install-official-self-test.mjs',
  // pnpm 的定位判据：先在绝对路径候选里找（node <pnpm.cjs> 直调）再退回 PATH，不 spawn 真进程
  'scripts/pnpm-resolve-self-test.mjs',
  // harness × Electron 运行时兼容：白名单能从 addon 二进制里解析出来，且判据接在构建之前
  'scripts/harness-compat-self-test.mjs',
  // 托盘/窗口图标的平台判据 + 三条"打开主窗"入口（都是集成测试跑不到的平台分支）
  'scripts/tray-icon-self-test.mjs',
  // 按 GitHub 仓库文件更新：输入是远端可控数据、落点是用户正在用的插件位，并校验 components.json 与真实内容一致
  'scripts/repo-update-self-test.mjs',
  // 壳自身热更新：asar 补丁保留 node_modules、重算 integrity、由独立助手在退出后替换并失败回滚
  'scripts/shell-hot-update-self-test.mjs',
  // CI 自己的 shell 脚本也要有门禁：诊断工具必须先被诊断
  'scripts/ci-shell-syntax-self-test.mjs',
  'packages/dsh-auto-approval/test/grade-self-test.mjs',
  'packages/dsh-auto-approval/test/apply-self-test.mjs',
  // 客户端插件装载期自检：真跑 factory，抓"模块体引用了只在 apply() 里声明过的名字"这类 node --check 抓不到的错
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

// 统计 PASS 行（各套件都打印 PASS / ✓ 前缀，口径统一）
const countPass = (text) => (text.match(/^\s*(?:PASS|✓)\s/gm) ?? []).length
const countFail = (text) => (text.match(/^\s*(?:FAIL|✗)\s/gm) ?? []).length

// 跑一个套件并把输出取回来，返回 {status, out, spawnError}。
// 子进程输出一律重定向到临时文件再读。
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
