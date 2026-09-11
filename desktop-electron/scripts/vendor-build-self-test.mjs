// vendor-build-self-test.mjs — vendor 树构建原语离线单测（纯 Node，不联网、不跑真 npm、不碰仓库文件）
//
// 为什么这些必须能离线测：这些原语是"换树"这条不可逆路径的全部机械动作，而 Q4 已决定不做回滚
// 备份——ABI 门禁与插件同步的每一条失败分支都必须在**没有真实依赖树**的情况下可复现，否则只能
// 靠真换一次树去试，代价是用户重装。
// 编排逻辑（buildVendorTree）通过注入 abiGate / installFn 做到完全脱网可测。
import {
  DEFAULT_PLUGIN_NAMES,
  buildInstallEnv,
  buildStaging,
  buildVendorTree,
  countFiles,
  dirSize,
  findNpm,
  formatMb,
  npmCandidates,
  pruneVendorTree,
  resetDir,
  runAbiGate,
  runBootGate,
  syncVendorPlugins,
  vendorStats,
  writeManifest,
} from '../src/vendor-build.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let fail = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!cond) fail++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vb-test-'))
const write = (p, content = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content) }

// ---------- 1) 统计与目录原语 ----------
console.log('[stats]')
const statDir = path.join(tmp, 'stat')
write(path.join(statDir, 'a.txt'), 'aaaa')
write(path.join(statDir, 'sub', 'b.txt'), 'bb')
ok('dirSize 递归求和', dirSize(statDir) === 6, String(dirSize(statDir)))
ok('countFiles 只数文件', countFiles(statDir) === 2, String(countFiles(statDir)))
ok('不存在目录返回 0 而不抛', dirSize(path.join(tmp, 'nope')) === 0 && countFiles(path.join(tmp, 'nope')) === 0)
ok('formatMb 口径', formatMb(1048576) === '1.0 MB', formatMb(1048576))
ok('vendorStats 形状', (() => { const s = vendorStats(statDir); return typeof s.totalBytes === 'number' && typeof s.totalFiles === 'number' })())

console.log('[resetDir]')
write(path.join(statDir, 'stale.txt'), 'old')
resetDir(statDir)
ok('resetDir 清空旧内容', fs.readdirSync(statDir).length === 0)
ok('resetDir 目录存在', fs.existsSync(statDir))

// ---------- 2) manifest ----------
console.log('[writeManifest]')
const treeDir = path.join(tmp, 'tree')
const VERSIONS = { '@deepseek-ai/dsh': '9.9.9-rc.1', '@deepseek-ai/dsh-base': '9.9.9-rc.1', '@deepseek-ai/dsh-web-app': '9.9.9-rc.1' }
const manifest = writeManifest(treeDir, VERSIONS)
ok('manifest 含 bundles 两件套', manifest.dsh.profile.bundles.join(',') === '@deepseek-ai/dsh-base,@deepseek-ai/dsh-web-app')
ok('manifest 锁三个包版本', JSON.stringify(manifest.dependencies) === JSON.stringify(VERSIONS))
ok('manifest 落盘且可解析', JSON.parse(fs.readFileSync(path.join(treeDir, 'package.json'), 'utf8')).private === true)

// ---------- 3) npm 探测与安装环境（Q2 / 坑 20） ----------
console.log('[findNpm]')
const cands = npmCandidates({ env: { ProgramFiles: 'C:\\Program Files', DSH_NODE_DIR: 'D:\\node' }, execPath: 'C:\\app\\DSH Desktop.exe', extraNodeDirs: ['C:\\sysnode'] })
ok('候选含 DSH_NODE_DIR', cands.some((p) => p.startsWith('D:\\node')))
ok('候选含 Program Files\\nodejs', cands.some((p) => p.startsWith(path.join('C:\\Program Files', 'nodejs'))))
ok('候选含 where node 推导目录', cands.some((p) => p.startsWith('C:\\sysnode')))
ok('候选含 execPath 同级（打包态通常不存在）', cands.some((p) => p.startsWith('C:\\app')))
ok('全部指向 npm-cli.js', cands.every((p) => p.endsWith(path.join('node_modules', 'npm', 'bin', 'npm-cli.js'))))
ok('命中第一优先存在项', findNpm({ exists: (p) => p.startsWith('C:\\sysnode'), candidates: cands })?.startsWith('C:\\sysnode') === true)
ok('全部不存在返回 null（按钮置灰依据）', findNpm({ exists: () => false, candidates: cands }) === null)

console.log('[buildInstallEnv]')
const ienv = buildInstallEnv({ cacheDir: 'D:\\repo\\.npm-cache', baseEnv: { npm_config_cache: 'C:\\Program Files\\nodejs\\node_cache', PATH: 'x' } })
ok('cacheDir 无条件覆盖外部坏值（坑 20）', ienv.npm_config_cache === 'D:\\repo\\.npm-cache', ienv.npm_config_cache)
ok('registry 默认 npmmirror', ienv.npm_config_registry === 'https://registry.npmmirror.com')
ok('保留基础环境', ienv.PATH === 'x')

// ---------- 4) 剪枝 ----------
console.log('[pruneVendorTree]')
const pdir = path.join(tmp, 'prune')
write(path.join(pdir, 'node_modules', 'pkg', 'index.js'), 'code')
write(path.join(pdir, 'node_modules', 'pkg', 'index.js.map'), 'map')
write(path.join(pdir, 'node_modules', 'pkg', 'types.d.ts'), 'types')
write(path.join(pdir, 'node_modules', 'pkg', 'README.md'), 'readme')
write(path.join(pdir, 'node_modules', 'pkg', 'LICENSE'), 'lic')
write(path.join(pdir, 'node_modules', 'pkg', 'test', 't.js'), 'test')
write(path.join(pdir, 'node_modules', 'pkg', 'deep', 'docs', 'd.md'), 'docs')
write(path.join(pdir, 'node_modules', 'node-pty', 'prebuilds', 'linux-x64', 'pty.node'), 'bin')
write(path.join(pdir, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'pty.node'), 'bin')
const pr = pruneVendorTree(pdir)
ok('保留真实代码', fs.existsSync(path.join(pdir, 'node_modules', 'pkg', 'index.js')))
ok('删掉 .map / .d.ts / .md / LICENSE', !fs.existsSync(path.join(pdir, 'node_modules', 'pkg', 'index.js.map'))
  && !fs.existsSync(path.join(pdir, 'node_modules', 'pkg', 'types.d.ts'))
  && !fs.existsSync(path.join(pdir, 'node_modules', 'pkg', 'README.md'))
  && !fs.existsSync(path.join(pdir, 'node_modules', 'pkg', 'LICENSE')))
ok('删掉 test/ 与嵌套 docs/', !fs.existsSync(path.join(pdir, 'node_modules', 'pkg', 'test'))
  && !fs.existsSync(path.join(pdir, 'node_modules', 'pkg', 'deep', 'docs')))
ok('删掉非本平台 node-pty 预编译', !fs.existsSync(path.join(pdir, 'node_modules', 'node-pty', 'prebuilds', 'linux-x64')))
ok('保留 win32-x64 node-pty 预编译', fs.existsSync(path.join(pdir, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'pty.node')))
// 逐个点数（别心算）：index.js.map / types.d.ts / README.md / LICENSE / test 内 1 个 /
// 嵌套 deep/docs 内 1 个 / linux-x64 预编译内 1 个 = 7
ok('剪枝计数正确', pr.prunedFiles === 7 && pr.prunedBytes > 0, `files=${pr.prunedFiles}`)

// ---------- 5) 插件同步 ----------
console.log('[syncVendorPlugins]')
const pkgs = path.join(tmp, 'packages')
for (const name of DEFAULT_PLUGIN_NAMES) write(path.join(pkgs, name, 'package.json'), JSON.stringify({ name }))
const sdir = path.join(tmp, 'sync')
write(path.join(sdir, 'node_modules', 'dsh-desktop-ui', 'stale.js'), 'old')  // 旧残留必须被整目录替换
const sy = syncVendorPlugins(sdir, { packagesDir: pkgs })
ok('两个插件都拷入', sy.copied.length === 2 && sy.missing.length === 0, JSON.stringify(sy))
ok('整目录替换（旧残留消失）', !fs.existsSync(path.join(sdir, 'node_modules', 'dsh-desktop-ui', 'stale.js')))
ok('目标有 package.json', fs.existsSync(path.join(sdir, 'node_modules', 'dsh-auto-approval', 'package.json')))
const syMiss = syncVendorPlugins(path.join(tmp, 'sync2'), { packagesDir: path.join(tmp, 'empty-pkgs') })
ok('源缺失时报告 missing（不静默）', syMiss.missing.length === 2 && syMiss.copied.length === 0, JSON.stringify(syMiss))

// ---------- 6) ABI 门禁 ----------
console.log('[runAbiGate]')
const abiDir = path.join(tmp, 'abi')
ok('空树 → 报错而非"通过"', (() => { const r = runAbiGate({ nodeModulesDir: path.join(abiDir, 'empty'), runtime: process.execPath }); return r.ok === false && r.total === 0 && typeof r.error === 'string' })())
write(path.join(abiDir, 'pkg', 'build', 'Release', 'bogus.node'), 'definitely not a native module')
const abiFail = runAbiGate({ nodeModulesDir: abiDir, runtime: process.execPath })
ok('非法 .node 判 FAIL', abiFail.failCount === 1 && abiFail.ok === false, JSON.stringify(abiFail.failures))
// 断言名不要以 "FAIL" 开头：`  PASS  FAIL xxx` 会被任何 `grep FAIL` 的门禁当成真失败（实测踩过）。
ok('失败项带上了具体原因', (abiFail.failures[0] ?? '').includes('bogus.node'))

const abiPlat = path.join(tmp, 'abi-plat')
write(path.join(abiPlat, 'node-pty', 'prebuilds', 'linux-x64', 'pty.node'), 'not a native module')
const abiSkip = runAbiGate({ nodeModulesDir: abiPlat, runtime: process.execPath })
ok('平台专属包判 SKIP 而非 FAIL', abiSkip.skipCount === 1 && abiSkip.failCount === 0 && abiSkip.ok === true, JSON.stringify(abiSkip))

// ---------- 7) 编排（注入 abiGate / installFn，完全脱网） ----------
console.log('[buildVendorTree]')
const okGate = ({ nodeModulesDir }) => ({ ok: true, total: 1, okCount: 1, skipCount: 0, failCount: 0, failures: [], scannedDir: nodeModulesDir })
const badGate = () => ({ ok: false, total: 1, okCount: 0, skipCount: 0, failCount: 1, failures: ['x.node — boom'] })
const base = {
  versions: VERSIONS, packagesDir: pkgs, cacheDir: path.join(tmp, 'cache'), install: false, log: () => {},
  // bootGate: null —— 离线单测**必须**显式跳过启动门禁，否则它会去真起一个宿主（分钟级且依赖环境）。
  // 真实更新路径绝不能这么传（main.mjs 不传该参数即用默认的 runBootGate）。
  bootGate: null,
}
// install=false 的语义是"复用现有树"，所以夹具必须先有 node_modules——否则测的是前置校验而不是编排。
const makeTree = (dir) => { fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true }); return dir }

const noTree = await buildVendorTree({ ...base, profileDir: path.join(tmp, 'absent'), abiGate: okGate })
ok('install=false 且无 node_modules → 明确报错', noTree.ok === false && noTree.error.includes('需要已有'), noTree.error)

const good = await buildVendorTree({ ...base, profileDir: makeTree(path.join(tmp, 'good')), abiGate: okGate })
ok('happy path 成功', good.ok === true, good.error)
ok('happy path 产出统计', good.stats?.totalFiles > 0 && good.stats?.totalBytes > 0)
ok('happy path 记下插件', good.plugins?.copied.length === 2)
ok('happy path 记下门禁结果', good.abi?.ok === true)

const noPlugin = await buildVendorTree({ ...base, profileDir: makeTree(path.join(tmp, 'good2')), packagesDir: path.join(tmp, 'empty-pkgs'), abiGate: okGate })
ok('插件缺失是硬失败（不产出缺插件的树）', noPlugin.ok === false && noPlugin.error.includes('插件包缺失'), noPlugin.error)

const gateFail = await buildVendorTree({ ...base, profileDir: makeTree(path.join(tmp, 'good3')), abiGate: badGate })
ok('门禁不过 → 整体失败', gateFail.ok === false && gateFail.error.includes('ABI 门禁未通过'), gateFail.error)
ok('门禁失败仍在返回值里带 abi 详情', gateFail.abi?.failures.length === 1)

// 启动门禁：0.4.6 事故就是漏了它（ABI 全绿但那棵树起不来）
const bootFail = await buildVendorTree({
  ...base, profileDir: makeTree(path.join(tmp, 'good6')), abiGate: okGate,
  bootGate: async () => ({ ok: false, error: '宿主未在 90000ms 内就绪', logTail: 'dsh-auto-approval 已装载' }),
})
ok('启动门禁不过 → 整体失败', bootFail.ok === false && bootFail.error.includes('启动门禁未通过'), bootFail.error)
ok('启动门禁失败的报错带宿主日志尾巴', (bootFail.error ?? '').includes('dsh-auto-approval'))
ok('启动门禁失败时仍回报 abi 结果（便于定位是哪道门）', bootFail.abi?.ok === true)

const bootOk = await buildVendorTree({
  ...base, profileDir: makeTree(path.join(tmp, 'good7')), abiGate: okGate,
  bootGate: async () => ({ ok: true, url: 'http://127.0.0.1:12345/?token=abc' }),
})
ok('启动门禁通过 → 成功且记下 URL', bootOk.ok === true && bootOk.boot?.url.includes('token='), bootOk.error)

// 缺 bin.js 时必须快速失败（不能傻等 90 秒）
const noBin = await runBootGate({ profileDir: path.join(tmp, 'no-bin-at-all'), runtime: process.execPath, timeoutMs: 5000 })
ok('启动门禁：缺 bin.js 快速失败', noBin.ok === false && noBin.error.includes('bin.js'), noBin.error)

const badNpm = await buildVendorTree({ ...base, install: true, profileDir: path.join(tmp, 'good4'), npmCli: path.join(tmp, 'nope', 'npm-cli.js'), abiGate: okGate })
ok('install=true 且 npm 不可用 → 明确报错', badNpm.ok === false && badNpm.error.includes('系统 npm'), badNpm.error)

// 注入 installFn 验证 install=true 的编排顺序（不跑真 npm）。fake npm 必须真实存在：
// 探测到的路径会被存在性校验挡住（这是有意的硬化，不是测试障碍）。
let installCalledWith = null
const fakeInstall = async (o) => { installCalledWith = o; fs.mkdirSync(path.join(o.profileDir, 'node_modules'), { recursive: true }); return { ok: true } }
const fakeNpm = path.join(tmp, 'fake-npm.js')
write(fakeNpm, '// 假的 npm 入口，仅用于通过存在性校验')
const installed = await buildVendorTree({ ...base, install: true, profileDir: path.join(tmp, 'good5'), npmCli: fakeNpm, abiGate: okGate, installFn: fakeInstall })
ok('install=true 走注入的安装实现', installCalledWith !== null && installed.ok === true, installed.error)
ok('安装前已写好 manifest', fs.existsSync(path.join(installCalledWith?.profileDir ?? '', 'package.json')))
ok('传入 npm 的环境带可写 cache', installCalledWith?.env?.npm_config_cache === path.join(tmp, 'cache'))

// buildStaging 是"真构建"形态（install=true），所以同样注入假 npm 与假安装实现。
const staging = await buildStaging({
  ...base, install: true, npmCli: fakeNpm, installFn: fakeInstall, abiGate: okGate,
  stagingRoot: path.join(tmp, 'staging'),
})
ok('buildStaging 产出 profile 与 lock', staging.ok === true && fs.existsSync(staging.lockPath) && fs.existsSync(path.join(staging.profileDir, 'package.json')), staging.error)
ok('lock 含版本与门禁结论', staging.lock?.dshVersions?.['@deepseek-ai/dsh'] === '9.9.9-rc.1' && staging.lock?.abiScan === 'PASS')
ok('lock 含统计（等价性验证口径）', typeof staging.lock?.totalFiles === 'number' && typeof staging.lock?.totalBytes === 'number')

fs.rmSync(tmp, { recursive: true, force: true })
console.log(fail === 0 ? '\nVENDOR BUILD SELF TEST: ALL PASS' : `\nVENDOR BUILD SELF TEST: ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
