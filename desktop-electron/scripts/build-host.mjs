// vendor/profile 自包含构建：锁定 rc.8 依赖安装 → ABI 门禁 → 剪枝 → vendor.lock.json
// 用法：node scripts/build-host.mjs [--runtime <electron.exe 路径>] [--prune-only]
//   --prune-only：跳过安装，只对现有 vendor/profile 做剪枝 + ABI 门禁 + 刷新 lock（安装提速迭代用）。
// 说明：npm install 用 --ignore-scripts（原生依赖全走平台预编译包，无编译脚本）；
//       spawn 一律 stdio 直通（沙箱管道限制），需要捕获的输出去文件描述符。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE_DIR = path.join(ROOT, 'vendor', 'profile')
const RUNTIME_IDX = process.argv.indexOf('--runtime')
const RUNTIME = (RUNTIME_IDX >= 0 ? process.argv[RUNTIME_IDX + 1] : null) || path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const PRUNE_ONLY = process.argv.includes('--prune-only')
const VERSIONS = { '@deepseek-ai/dsh': '0.1.0-rc.8', '@deepseek-ai/dsh-base': '0.1.0-rc.8', '@deepseek-ai/dsh-web-app': '0.1.0-rc.8' }

function dirSize(dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(p)
    else if (entry.isFile()) total += fs.statSync(p).size
  }
  return total
}
function countFiles(dir) {
  let n = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) n += countFiles(p)
    else n++
  }
  return n
}
const mb = (b) => (b / 1048576).toFixed(1) + ' MB'

// 1. manifest：bundles 锁 dsh-base + dsh-web-app；dsh 本体提供 bin.js 入口
if (!PRUNE_ONLY) {
  const manifest = {
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: VERSIONS,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true })
  fs.mkdirSync(PROFILE_DIR, { recursive: true })
  fs.writeFileSync(path.join(PROFILE_DIR, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log('[build-host] manifest 写入（bundles 锁定 rc.8）')
} else {
  if (!fs.existsSync(path.join(PROFILE_DIR, 'node_modules'))) { console.error('[build-host] --prune-only 需要已有 vendor/profile'); process.exit(1) }
  console.log('[build-host] prune-only 模式：跳过安装')
}

// 解析 npm 真实入口：Windows 下 spawn('npm') 找不到 .cmd/.ps1 垫片（ENOENT），
// 本机 PATH 上甚至只有 npm.ps1；npm 随 Node 发布，直接从 node.exe 位置推导 npm-cli.js（零 spawn，沙箱/CI 通用）。
function resolveNpm() {
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (fs.existsSync(cli)) return { cmd: process.execPath, args: [cli] }
  return null
}

// 2. npm install（缓存留在工作区；--ignore-scripts 无编译脚本；
//    强制 npmmirror 源：registry.npmjs.org 在无代理环境直连不可达会无限挂起）
const env = {
  ...process.env,
  npm_config_cache: process.env.npm_config_cache || path.join(ROOT, '.npm-cache'),
  npm_config_registry: 'https://registry.npmmirror.com',
}
if (!PRUNE_ONLY) {
  const npmResolved = resolveNpm()
  if (!npmResolved) { console.error('[build-host] 找不到 npm，终止'); process.exit(1) }
  console.log(`[build-host] npm 入口: ${npmResolved.cmd} ${npmResolved.args.join(' ')}`)
  console.log('[build-host] npm install --omit=dev --ignore-scripts（首次约 255MB 依赖，耐心等待）...')
  const install = spawnSync(npmResolved.cmd, [...npmResolved.args, 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: PROFILE_DIR, stdio: 'inherit', env })
  if (install.status !== 0) {
    console.error(`[build-host] npm install 失败（status=${install.status} error=${install.error?.message ?? 'none'}），终止`)
    process.exit(1)
  }
}

// 3. 剪枝（安全面：运行时永不加载的内容；文件数砍半直接缩短安装时间——Defender 逐文件扫描是安装慢主因）
//    - 非本平台 node-pty 预编译（win32-x64 必需项保留）
//    - test/tests/__tests__/docs/examples/benchmark(s) 目录
//    - *.map（源映射）与 *.d.ts（类型声明）
let prunedBytes = 0
let prunedFiles = 0
const pruneDirs = new Set(['test', 'tests', '__tests__', 'docs', 'examples', 'benchmark', 'benchmarks'])
function walkPrune(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (pruneDirs.has(entry.name)) {
        prunedBytes += dirSize(p)
        prunedFiles += countFiles(p)
        fs.rmSync(p, { recursive: true, force: true })
        continue
      }
      walkPrune(p)
    } else if (entry.name.endsWith('.map') || entry.name.endsWith('.d.ts') || entry.name.endsWith('.md') || /^(LICENSE|LICENCE|COPYING|NOTICE|CHANGELOG|CHANGES|HISTORY|AUTHORS|CONTRIBUTING)(\.|$)/.test(entry.name)) {
      prunedBytes += fs.statSync(p).size
      prunedFiles++
      fs.rmSync(p)
    }
  }
}
for (const p of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64']) {
  const d = path.join(PROFILE_DIR, 'node_modules', 'node-pty', 'prebuilds', p)
  if (fs.existsSync(d)) { prunedBytes += dirSize(d); prunedFiles += countFiles(d); fs.rmSync(d, { recursive: true, force: true }) }
}
walkPrune(path.join(PROFILE_DIR, 'node_modules'))
console.log(`[build-host] 剪枝完成: ${mb(prunedBytes)} / ${prunedFiles} 个文件`)

// 3.5 拷贝自研客户端插件包进 vendor（desktop.patch.yml 的 dsh.client 行经锚点 1 父级解析到它）
const PLUGIN_SRC = path.join(ROOT, 'packages', 'dsh-desktop-ui')
const PLUGIN_DST = path.join(PROFILE_DIR, 'node_modules', 'dsh-desktop-ui')
if (fs.existsSync(PLUGIN_SRC)) {
  fs.rmSync(PLUGIN_DST, { recursive: true, force: true })
  fs.cpSync(PLUGIN_SRC, PLUGIN_DST, { recursive: true })
  console.log('[build-host] dsh-desktop-ui 插件已就位 vendor/node_modules')
}

// 4. ABI 门禁：win32-x64 平台包在 Electron 运行时下全部 dlopen 成功
console.log('[build-host] ABI 门禁（abi-scan）...')
const scan = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'abi-scan.mjs'), path.join(PROFILE_DIR, 'node_modules'), RUNTIME], { stdio: 'inherit', env })
if (scan.status !== 0) { console.error('[build-host] ABI 扫描未通过，终止构建'); process.exit(1) }

// 5. 运行时内建 Node 版本（文件描述符捕获，沙箱安全）
const tmpFile = path.join(ROOT, '.node-ver.tmp')
const fd = fs.openSync(tmpFile, 'w')
spawnSync(RUNTIME, ['-e', "process.stdout.write(process.versions.node + '|' + process.versions.electron)"], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', fd, fd] })
fs.closeSync(fd)
const [nodeVer, electronVer] = fs.readFileSync(tmpFile, 'utf8').split('|')
fs.rmSync(tmpFile, { force: true })

// 6. lock
const lock = {
  generatedAt: new Date().toISOString(),
  dshVersions: VERSIONS,
  runtime: { electron: electronVer, node: nodeVer },
  abiScan: 'PASS',
  prunedBytes,
  prunedFiles,
  totalBytes: dirSize(PROFILE_DIR),
  totalFiles: countFiles(PROFILE_DIR),
}
fs.writeFileSync(path.join(ROOT, 'vendor', 'vendor.lock.json'), JSON.stringify(lock, null, 2) + '\n')
console.log(`[build-host] 完成: ${mb(lock.totalBytes)} / ${lock.totalFiles} 个文件 → vendor/profile + vendor.lock.json`)
