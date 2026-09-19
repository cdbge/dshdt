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
  buildVendorLock,
  buildVendorTree,
  countFiles,
  countPackages,
  currentTarget,
  dirSize,
  ensureSpawnHelpers,
  findNpm,
  foreignPtyPrebuilds,
  formatMb,
  findVendorLockfile,
  installDependencies,
  isEssentialNativePath,
  isForeignPlatformPath,
  npmCandidates,
  platformTag,
  pruneVendorTree,
  resetDir,
  runAbiGate,
  runBootGate,
  syncVendorPlugins,
  verifyTargetPackages,
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

// ---------- 3) npm 探测与安装环境 ----------
console.log('[findNpm]')
// ⚠️ execPath 的夹具必须**按宿主平台拼**（2026-09-19 CI 首跑抓到）：写死 `C:\app\...` 时，
// `path.dirname()` 在 Linux 上找不到 `/` ⇒ 返回 `.`，于是"execPath 同级"那条候选变成相对路径、
// 断言落空（Windows 上恰好成立）。用 path.join 拼出来的路径在两边都对。
const appDir = path.join(path.sep === '\\' ? 'C:\\' : '/', 'app')
const cands = npmCandidates({ env: { ProgramFiles: 'C:\\Program Files', DSH_NODE_DIR: 'D:\\node' }, execPath: path.join(appDir, 'DSH Desktop.exe'), extraNodeDirs: ['C:\\sysnode'] })
ok('候选含 DSH_NODE_DIR', cands.some((p) => p.startsWith('D:\\node')))
ok('候选含 Program Files\\nodejs', cands.some((p) => p.startsWith(path.join('C:\\Program Files', 'nodejs'))))
ok('候选含 where node 推导目录', cands.some((p) => p.startsWith('C:\\sysnode')))
ok('候选含 execPath 同级（打包态通常不存在）', cands.some((p) => p.startsWith(appDir)), appDir)
ok('全部指向 npm-cli.js', cands.every((p) => p.endsWith(path.join('node_modules', 'npm', 'bin', 'npm-cli.js'))))
ok('命中第一优先存在项', findNpm({ exists: (p) => p.startsWith('C:\\sysnode'), candidates: cands })?.startsWith('C:\\sysnode') === true)
ok('全部不存在返回 null（按钮置灰依据）', findNpm({ exists: () => false, candidates: cands }) === null)

console.log('[buildInstallEnv]')
const ienv = buildInstallEnv({ cacheDir: 'D:\\repo\\.npm-cache', baseEnv: { npm_config_cache: 'C:\\Program Files\\nodejs\\node_cache', PATH: 'x' } })
ok('cacheDir 无条件覆盖外部坏值', ienv.npm_config_cache === 'D:\\repo\\.npm-cache', ienv.npm_config_cache)
ok('registry 默认 npmmirror', ienv.npm_config_registry === 'https://registry.npmmirror.com')
ok('保留基础环境', ienv.PATH === 'x')

// ---------- 4) 剪枝 ----------
// ---------- 4) 剪枝（含**按目标平台**保留 node-pty 预编译） ----------
//
// 这一节是平台化改造的核心回归：旧实现写死"删非 win32-x64"，在 Linux 上删掉的正是本平台
// 唯一能用的那份。现在两张平台的树都验一遍：谁被保留由 target 决定。
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
const pr = pruneVendorTree(pdir, { os: 'win32', arch: 'x64' })
ok('保留真实代码', fs.existsSync(path.join(pdir, 'node_modules', 'pkg', 'index.js')))
ok('删掉 .map / .d.ts / .md / LICENSE', !fs.existsSync(path.join(pdir, 'node_modules', 'pkg', 'index.js.map'))
  && !fs.existsSync(path.join(pdir, 'node_modules', 'pkg', 'types.d.ts'))
  && !fs.existsSync(path.join(pdir, 'node_modules', 'pkg', 'README.md'))
  && !fs.existsSync(path.join(pdir, 'node_modules', 'pkg', 'LICENSE')))
ok('删掉 test/ 与嵌套 docs/', !fs.existsSync(path.join(pdir, 'node_modules', 'pkg', 'test'))
  && !fs.existsSync(path.join(pdir, 'node_modules', 'pkg', 'deep', 'docs')))
ok('目标 win32-x64：删掉 linux-x64 预编译', !fs.existsSync(path.join(pdir, 'node_modules', 'node-pty', 'prebuilds', 'linux-x64')))
ok('目标 win32-x64：保留 win32-x64 预编译', fs.existsSync(path.join(pdir, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'pty.node')))
// 逐个点数（别心算）：index.js.map / types.d.ts / README.md / LICENSE / test 内 1 个 /
// 嵌套 deep/docs 内 1 个 / linux-x64 预编译内 1 个 = 7
ok('剪枝计数正确', pr.prunedFiles === 7 && pr.prunedBytes > 0, `files=${pr.prunedFiles}`)
ok('剪枝报告了被删的平台预编译', pr.droppedPtyPrebuilds.includes('linux-x64'), JSON.stringify(pr.droppedPtyPrebuilds))

// 同一棵树换成"目标是 linux-x64"：这次该保留 linux、删掉 win32
const ldir = path.join(tmp, 'prune-linux')
write(path.join(ldir, 'node_modules', 'node-pty', 'prebuilds', 'linux-x64', 'pty.node'), 'bin')
write(path.join(ldir, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64', 'pty.node'), 'bin')
write(path.join(ldir, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64', 'pty.node'), 'bin')
const prLinux = pruneVendorTree(ldir, { os: 'linux', arch: 'x64', libc: 'glibc' })
ok('目标 linux-x64：保留 linux-x64 预编译', fs.existsSync(path.join(ldir, 'node_modules', 'node-pty', 'prebuilds', 'linux-x64', 'pty.node')))
ok('目标 linux-x64：删掉 win32-x64 与 darwin-arm64 预编译',
  !fs.existsSync(path.join(ldir, 'node_modules', 'node-pty', 'prebuilds', 'win32-x64'))
  && !fs.existsSync(path.join(ldir, 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64')))

// 另外两处"平台专属但目录名不同形"的残留（2026-09-14 对照真实树发现）：
// ConPTY 的目录名是 `win10-x64` / `win10-arm64`（既不是 win32-* 也不叫 pty.node），
// sharp 的 wasm32 兜底在三个平台上都永远轮不到。旧剪枝对这两处完全无感。
console.log('[pruneVendorTree · 平台专属目录]')
const cdir = path.join(tmp, 'prune-conpty')
const cp = (...p) => path.join(cdir, 'node_modules', ...p)
write(cp('node-pty', 'third_party', 'conpty', '1.25.0', 'win10-x64', 'conpty.dll'), 'dll')
write(cp('node-pty', 'third_party', 'conpty', '1.25.0', 'win10-x64', 'OpenConsole.exe'), 'exe')
write(cp('node-pty', 'third_party', 'conpty', '1.25.0', 'win10-arm64', 'conpty.dll'), 'dll')
write(cp('@img', 'sharp-wasm32', 'lib', 'sharp-wasm32-1.0.node.wasm'), 'wasm')
write(cp('@img', 'sharp-win32-x64', 'lib', 'sharp-win32-x64.node'), 'bin')
const prWin = pruneVendorTree(cdir, { os: 'win32', arch: 'x64' })
ok('win32-x64：删掉 win10-arm64 那一份 ConPTY', !fs.existsSync(cp('node-pty', 'third_party', 'conpty', '1.25.0', 'win10-arm64')))
ok('win32-x64：保留 win10-x64 那一份（本机要用的 pty 运行时）',
  fs.existsSync(cp('node-pty', 'third_party', 'conpty', '1.25.0', 'win10-x64', 'conpty.dll'))
  && fs.existsSync(cp('node-pty', 'third_party', 'conpty', '1.25.0', 'win10-x64', 'OpenConsole.exe')))
ok('三个平台都删掉 sharp 的 wasm32 兜底', !fs.existsSync(cp('@img', 'sharp-wasm32')))
ok('本平台 sharp 预编译不受影响', fs.existsSync(cp('@img', 'sharp-win32-x64', 'lib', 'sharp-win32-x64.node')))
ok('剪枝报告了被删的平台专属目录', (prWin.droppedPlatformDirs ?? []).some((d) => d.includes('win10-arm64')), JSON.stringify(prWin.droppedPlatformDirs))

const cdir2 = path.join(tmp, 'prune-conpty-linux')
write(path.join(cdir2, 'node_modules', 'node-pty', 'third_party', 'conpty', '1.25.0', 'win10-x64', 'conpty.dll'), 'dll')
const prLin = pruneVendorTree(cdir2, { os: 'linux', arch: 'x64', libc: 'glibc' })
ok('非 Windows 目标：整棵 third_party/conpty 都删掉（ConPTY 是 Windows 专属）',
  !fs.existsSync(path.join(cdir2, 'node_modules', 'node-pty', 'third_party', 'conpty')),
  JSON.stringify(prLin.droppedPlatformDirs))

// ---------- 4b) 平台三元组工具 ----------
console.log('[platform helpers]')
ok('platformTag 形状', platformTag({ os: 'darwin', arch: 'arm64' }) === 'darwin-arm64')
ok('foreignPtyPrebuilds 排除目标平台', !foreignPtyPrebuilds({ os: 'darwin', arch: 'arm64' }).includes('darwin-arm64')
  && foreignPtyPrebuilds({ os: 'darwin', arch: 'arm64' }).includes('win32-x64'))
ok('本平台预编译判为"非外来"', isForeignPlatformPath(path.join('node-pty', 'prebuilds', 'darwin-arm64', 'pty.node'), { os: 'darwin', arch: 'arm64' }) === false)
ok('其它平台预编译判为"外来"', isForeignPlatformPath(path.join('node-pty', 'prebuilds', 'linux-x64', 'pty.node'), { os: 'darwin', arch: 'arm64' }) === true)
ok('其它平台的原生包判为"外来"', isForeignPlatformPath(path.join('@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node'), { os: 'linux', arch: 'x64' }) === true)
ok('本平台的原生包判为"必需"', isEssentialNativePath(path.join('@koromix', 'koffi-linux-x64', 'linux_x64', 'koffi.node'), { os: 'linux', arch: 'x64' }) === true)
ok('与本平台无关的 .node 不算外来（该 FAIL 就 FAIL）', isForeignPlatformPath(path.join('pkg', 'build', 'Release', 'x.node'), { os: 'linux', arch: 'x64' }) === false)

// ---------- 4c) 目标平台必需包门禁 ----------
//
// 这是"装上也起不来"的拦截点：ABI 门禁对"包根本没装进来"完全无感。
console.log('[verifyTargetPackages]')
const vtree = path.join(tmp, 'verify-pkgs')
write(path.join(vtree, 'package.json'), '{"name":"t","private":true}')
const vtreeNm = path.join(vtree, 'node_modules')
for (const spec of [
  ['koffi', 'package.json'], ['node-pty', 'package.json'], ['sharp', 'package.json'],
  ['node-pty', 'prebuilds', 'linux-x64', 'pty.node'],
  ['@koromix', 'koffi-linux-x64', 'package.json'],
  ['@img', 'sharp-linux-x64', 'package.json'],
  ['@vscode', 'ripgrep-linux-x64', 'package.json'],
  ['@deepseek-ai', 'node-addon-system-linux-x64', 'package.json'],
]) write(path.join(vtreeNm, ...spec), '{}')
const vOk = verifyTargetPackages(vtree, { os: 'linux', arch: 'x64', libc: 'glibc' })
ok('必需包齐备时通过', vOk.ok === true, JSON.stringify(vOk.missing))
ok('通过时列出已就位的包', vOk.present.length >= 7, JSON.stringify(vOk.present))
fs.rmSync(path.join(vtreeNm, '@koromix'), { recursive: true, force: true })
const vMissing = verifyTargetPackages(vtree, { os: 'linux', arch: 'x64', libc: 'glibc' })
ok('缺 koffi 平台二进制时明确失败',
  vMissing.ok === false && vMissing.missing.some((m) => m.includes('koffi')),
  JSON.stringify({ missing: vMissing.missing, present: vMissing.present, exists: fs.existsSync(path.join(vtreeNm, '@koromix')) }))
fs.rmSync(path.join(vtreeNm, 'node-pty', 'prebuilds', 'linux-x64'), { recursive: true, force: true })
const vMissingPty = verifyTargetPackages(vtree, { os: 'linux', arch: 'x64', libc: 'glibc' })
ok('缺 node-pty 本平台预编译时明确失败', vMissingPty.missing.some((m) => m.includes('node-pty')), JSON.stringify(vMissingPty.missing))

// Windows 行曾经写成 `prebuilds/win32-x64/pty.node` —— 而 Windows 上**根本没有** pty.node
// （那是 Unix 的实现；Windows 加载 conpty.node / conpty_console_list.node）。
// 后果是这道门禁在 Windows 上必然判"缺件"，把完好的树说成坏的。
// 这里按**真实的 Windows 树**造夹具：能通过才算修好，且删掉 conpty.node 必须能判失败。
console.log('[verifyTargetPackages · win32 行]')
const wtree = path.join(tmp, 'verify-pkgs-win')
const wtreeNm = path.join(wtree, 'node_modules')
for (const spec of [
  ['koffi', 'package.json'], ['node-pty', 'package.json'], ['sharp', 'package.json'],
  ['node-pty', 'prebuilds', 'win32-x64', 'conpty.node'],
  ['node-pty', 'prebuilds', 'win32-x64', 'conpty_console_list.node'],
  ['node-pty', 'prebuilds', 'win32-x64', 'conpty', 'conpty.dll'],
  ['node-pty', 'prebuilds', 'win32-x64', 'conpty', 'OpenConsole.exe'],
  ['@koromix', 'koffi-win32-x64', 'package.json'],
  ['@img', 'sharp-win32-x64', 'package.json'],
  ['@vscode', 'ripgrep-win32-x64', 'package.json'],
]) write(path.join(wtreeNm, ...spec), '{}')
// 夹具里也要有 pty.node 造出的"假必需"吗？不：真实 Windows 树**没有**它，夹具必须照实造。
const wOk = verifyTargetPackages(wtree, { os: 'win32', arch: 'x64' })
ok('Windows 树（conpty 三件套齐备）判定通过', wOk.ok === true, JSON.stringify(wOk.missing))
ok('Windows 行不再索要 unix 的 pty.node', !JSON.stringify(wOk.missing).includes('pty.node'), JSON.stringify(wOk.missing))
fs.rmSync(path.join(wtreeNm, 'node-pty', 'prebuilds', 'win32-x64', 'conpty.node'), { force: true })
const wMissing = verifyTargetPackages(wtree, { os: 'win32', arch: 'x64' })
ok('少了 conpty.node 仍能判失败（真缺件时门禁有用）',
  wMissing.ok === false && wMissing.missing.some((m) => m.includes('conpty.node')), JSON.stringify(wMissing.missing))
fs.rmSync(path.join(wtreeNm, 'node-pty', 'prebuilds', 'win32-x64', 'conpty'), { recursive: true, force: true })
const wNoDll = verifyTargetPackages(wtree, { os: 'win32', arch: 'x64' })
ok('少了 conpty.dll / OpenConsole.exe 也判失败（ConPTY 运行时缺了 pty 建不起来）',
  wNoDll.ok === false && wNoDll.missing.some((m) => m.includes('conpty.dll')), JSON.stringify(wNoDll.missing))

// ---------- 4d) spawn-helper 可执行位 ----------
console.log('[ensureSpawnHelpers]')
if (process.platform === 'win32') {
  ok('Windows 上不触碰 spawn-helper（无 POSIX 权限位）', ensureSpawnHelpers(vtree, { os: 'win32', arch: 'x64' }).changed === 0)
} else {
  const helper = path.join(vtreeNm, 'node-pty', 'prebuilds', 'linux-x64', 'spawn-helper')
  write(helper, 'bin')
  fs.chmodSync(helper, 0o644)
  const fixed = ensureSpawnHelpers(vtree, { os: 'linux', arch: 'x64', libc: 'glibc' })
  ok('补上 spawn-helper 的 0755', fixed.changed === 1 && (fs.statSync(helper).mode & 0o777) === 0o755, JSON.stringify(fixed))
  ok('已正确的不会被重复改', ensureSpawnHelpers(vtree, { os: 'linux', arch: 'x64', libc: 'glibc' }).changed === 0)
}

// ---------- 5) 插件同步 ----------
console.log('[syncVendorPlugins]')
const pkgs = path.join(tmp, 'packages')
for (const name of DEFAULT_PLUGIN_NAMES) write(path.join(pkgs, name, 'package.json'), JSON.stringify({ name }))
const sdir = path.join(tmp, 'sync')
write(path.join(sdir, 'node_modules', 'dsh-desktop-ui', 'stale.js'), 'old')  // 旧残留必须被整目录替换
const sy = syncVendorPlugins(sdir, { packagesDir: pkgs })
// 判据**跟着名单走**而不是写死数字：写死数字的结果是"每加一个自带插件，这一套就假红一次"，
// 而假红会训练人忽略它（真漏拷时就不看了）。跟着名单走同样能抓到漏拷（数量不等即失败），
// 且新增插件时**夹具按名单生成**、判据按名单比对，两边天然同步。
ok('名单里的插件全部拷入', sy.copied.length === DEFAULT_PLUGIN_NAMES.length && sy.missing.length === 0, JSON.stringify(sy))
ok('整目录替换（旧残留消失）', !fs.existsSync(path.join(sdir, 'node_modules', 'dsh-desktop-ui', 'stale.js')))
ok('目标有 package.json', fs.existsSync(path.join(sdir, 'node_modules', 'dsh-auto-approval', 'package.json')))
const syMiss = syncVendorPlugins(path.join(tmp, 'sync2'), { packagesDir: path.join(tmp, 'empty-pkgs') })
ok('源缺失时报告 missing（不静默）', syMiss.missing.length === DEFAULT_PLUGIN_NAMES.length && syMiss.copied.length === 0, JSON.stringify(syMiss))

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
const abiSkip = runAbiGate({ nodeModulesDir: abiPlat, runtime: process.execPath, target: { os: 'win32', arch: 'x64' } })
ok('平台专属包判 SKIP 而非 FAIL', abiSkip.skipCount === 1 && abiSkip.failCount === 0 && abiSkip.ok === true, JSON.stringify(abiSkip))

// **另一套 C 库的制品**也必须判 SKIP（2026-09-14 在 Debian 上实测踩到）：
// Linux 平台包会同时带 glibc 与 musl 两套二进制，而它们是**同名包里的子目录**
// （`koffi-linux-x64/musl_x64/koffi.node`、`node-addon-system-linux-x64/bin/{glibc,musl}/system.node`）——
// 路径里带着本平台标记，所以"别平台"判据看不见它们；glibc 系统上 dlopen musl 那份必然失败，
// 于是一棵健康的树被报成坏的（koffi 与 flock 各一条）。
const abiLibc = path.join(tmp, 'abi-libc')
write(path.join(abiLibc, '@koromix', 'koffi-linux-x64', 'musl_x64', 'koffi.node'), 'not a native module')
write(path.join(abiLibc, '@deepseek-ai', 'node-addon-system-linux-x64', 'bin', 'musl', 'system.node'), 'not a native module')
const abiLibcSkip = runAbiGate({ nodeModulesDir: abiLibc, runtime: process.execPath, target: { os: 'linux', arch: 'x64', libc: 'glibc' } })
ok('glibc 目标上 musl 制品判 SKIP 而非 FAIL',
  abiLibcSkip.failCount === 0 && abiLibcSkip.skipCount === 2 && abiLibcSkip.ok === true, JSON.stringify(abiLibcSkip))
// 反向：目标是 musl 时，同一批文件就是**必需**的，加载失败必须 FAIL（判据不能一味放水）
const abiMuslFail = runAbiGate({ nodeModulesDir: abiLibc, runtime: process.execPath, target: { os: 'linux', arch: 'x64', libc: 'musl' } })
ok('musl 目标上同一批文件判 FAIL（判据不放水）', abiMuslFail.failCount === 2, JSON.stringify(abiMuslFail.failures))
// 包内**两套并列**时不算"外来"：取舍交给加载器，门禁不该拦
const abiBoth = path.join(tmp, 'abi-both')
write(path.join(abiBoth, '@koromix', 'koffi-linux-x64', 'musl_x64', 'koffi.node'), 'x')
write(path.join(abiBoth, '@koromix', 'koffi-linux-x64', 'linux_x64', 'koffi.node'), 'not a native module')
const abiBothR = runAbiGate({ nodeModulesDir: abiBoth, runtime: process.execPath, target: { os: 'linux', arch: 'x64', libc: 'glibc' } })
ok('同包内 glibc 那份坏掉仍判 FAIL（不会因为旁边有 musl 就放过）', abiBothR.failCount === 1, JSON.stringify(abiBothR.failures))

// ---------- 7) 编排（注入 abiGate / installFn，完全脱网） ----------
console.log('[buildVendorTree]')
const okGate = ({ nodeModulesDir }) => ({ ok: true, total: 1, okCount: 1, skipCount: 0, failCount: 0, failures: [], scannedDir: nodeModulesDir })
const badGate = () => ({ ok: false, total: 1, okCount: 0, skipCount: 0, failCount: 1, failures: ['x.node — boom'] })
const base = {
  versions: VERSIONS, packagesDir: pkgs, cacheDir: path.join(tmp, 'cache'), install: false, log: () => {},
  // bootGate: null —— 离线单测**必须**显式跳过启动门禁，否则它会去真起一个宿主（分钟级且依赖环境）。
  // 真实更新路径绝不能这么传（main.mjs 不传该参数即用默认的 runBootGate）。
  bootGate: null,
  // verifyPackages: null —— 同理：夹具是手搓的空树，没有 koffi/node-pty 等真依赖。
  // 平台包门禁本身由下面的 verifyTargetPackages 专项断言覆盖（用真造的目录树）。
  verifyPackages: null,
}
// install=false 的语义是"复用现有树"，所以夹具必须先有 node_modules——否则测的是前置校验而不是编排。
const makeTree = (dir) => { fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true }); return dir }

const noTree = await buildVendorTree({ ...base, profileDir: path.join(tmp, 'absent'), abiGate: okGate })
ok('install=false 且无 node_modules → 明确报错', noTree.ok === false && noTree.error.includes('需要已有'), noTree.error)

const good = await buildVendorTree({ ...base, profileDir: makeTree(path.join(tmp, 'good')), abiGate: okGate })
ok('happy path 成功', good.ok === true, good.error)
ok('happy path 产出统计', good.stats?.totalFiles > 0 && good.stats?.totalBytes > 0)
ok('happy path 记下插件', good.plugins?.copied.length === DEFAULT_PLUGIN_NAMES.length, JSON.stringify(good.plugins))
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

// 门禁的**取证**：宿主启动期崩溃只会往 stderr 打字，而旧实现既不落盘
// stderr、也只看 host.log 的尾巴 ⇒ 报错退化成「宿主提前退出（code=1）（宿主日志：--- run … ---）」，
// 那一行还是 startHost 自己写的分隔行。这里用一棵"故意秒退"的假树把遗言钉住：
// 断言必须能读到子进程 stderr 里那句话，且**不许**把分隔行当证据。
const crashTree = path.join(tmp, 'crash-tree')
write(path.join(crashTree, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  "process.stderr.write('boom: 宿主启动即崩\\n'); process.exit(1)\n")
const crash = await runBootGate({ profileDir: crashTree, runtime: process.execPath, timeoutMs: 8000 })
ok('门禁：宿主秒退 → 判失败并报退出码', crash.ok === false && crash.error.includes('宿主提前退出'), crash.error)
ok('门禁：报错带回子进程 stderr 的遗言（旧实现这里永远是空的）',
  (crash.logTail ?? '').includes('boom'), JSON.stringify(crash.logTail ?? ''))
ok('门禁：分隔行不许当证据（`--- run … ---` 必须被过滤掉）',
  !/--- run .* ---/.test(crash.logTail ?? ''), JSON.stringify(crash.logTail ?? ''))

const badNpm = await buildVendorTree({ ...base, install: true, profileDir: path.join(tmp, 'good4'), npmCli: path.join(tmp, 'nope', 'npm-cli.js'), abiGate: okGate })
ok('install=true 且 npm 不可用 → 明确报错', badNpm.ok === false && badNpm.error.includes('系统 npm'), badNpm.error)

// ---------- 进度回调----------
console.log('[onProgress]')
const progressSeen = []
const progressDir = path.join(tmp, 'prog')
// 自带一个假 npm 入口：探测到的路径会被存在性校验挡住（那是有意的硬化），所以必须真实存在
const progressNpm = path.join(tmp, 'fake-npm-progress.js')
write(progressNpm, '// 假的 npm 入口，仅用于通过存在性校验')
const progressInstall = async (o) => {
  // 模拟 npm 边解包边建目录：进度轮询应该数得出来
  fs.mkdirSync(path.join(o.profileDir, 'node_modules', '@scope', 'pkgA'), { recursive: true })
  fs.mkdirSync(path.join(o.profileDir, 'node_modules', 'plainB'), { recursive: true })
  return { ok: true }
}
const progressRun = await buildVendorTree({
  ...base, install: true, profileDir: progressDir, npmCli: progressNpm,
  abiGate: okGate, installFn: progressInstall, bootGate: null,
  onProgress: (p) => progressSeen.push(p), installPollMs: 50, expectedPackages: 10,
})
await new Promise((r) => setTimeout(r, 120))   // 让轮询至少跑一次
ok('进度回调有输出', progressSeen.length > 0, String(progressSeen.length))
ok('进度首次为 install 阶段', progressSeen[0]?.step === 'install', JSON.stringify(progressSeen[0]))
ok('包含剪枝阶段', progressSeen.some((p) => p.step === 'prune'), '')
ok('包含 ABI 阶段', progressSeen.some((p) => p.step === 'abi'), '')
ok('结束时 percent=100', progressSeen[progressSeen.length - 1]?.percent === 100, JSON.stringify(progressSeen[progressSeen.length - 1]))
ok('percent 单调不减', progressSeen.every((p, i) => i === 0 || p.percent >= progressSeen[i - 1].percent), JSON.stringify(progressSeen.map((p) => p.percent)))
ok('每条都有可读 label', progressSeen.every((p) => typeof p.label === 'string' && p.label.length > 0))
ok('percent 恒在 0..100', progressSeen.every((p) => p.percent >= 0 && p.percent <= 100))
ok('构建确实成功了（进度回调不该影响结果）', progressRun.ok === true, progressRun.error)
ok('进度回调抛异常不影响构建', (await buildVendorTree({
  ...base, install: true, profileDir: path.join(tmp, 'prog2'), npmCli: progressNpm,
  abiGate: okGate, installFn: progressInstall, bootGate: null,
  onProgress: () => { throw new Error('boom') },
})).ok === true)
// countPackages 用**独立夹具**测：直接对着构建产物数会被 syncVendorPlugins 拷进去的插件干扰
// （那两个也是包，数出来当然不止 2 个）——这是第四次栽在"期望值没算上夹具的副作用"上了。
const cpDir = path.join(tmp, 'count-pkgs', 'node_modules')
fs.mkdirSync(path.join(cpDir, '@scope', 'a'), { recursive: true })
fs.mkdirSync(path.join(cpDir, '@scope', 'b'), { recursive: true })
fs.mkdirSync(path.join(cpDir, 'plain1'), { recursive: true })
fs.mkdirSync(path.join(cpDir, '.bin'), { recursive: true })   // 点开头不算包
fs.writeFileSync(path.join(cpDir, 'loose.js'), '// 文件不算包')
ok('countPackages：@scope/a + @scope/b + plain1 = 3', countPackages(cpDir) === 3, String(countPackages(cpDir)))
ok('countPackages 目录不存在返回 0', countPackages(path.join(tmp, 'no-such-nm')) === 0)

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

// 版本锁：三平台必须共用同一份 `vendor/package-lock.json` 来钉死**传递依赖**的版本。
// 背景（2026-09-15 实测）：manifest 只钉死三个 DSH 包的精确版本，传递依赖是范围声明
// （`zod: ^4.4.3`、`node-addon-require-builtin: ^0.1.4`、`@types/node` 由 `protobufjs` 的 `>=13.7.0` 拉进来），
// 于是**同一个 DSH 版本在不同日期装出两棵内容不同的树**——实测 Windows 树与 Linux 树有 5 个同名包版本不同。
console.log('[版本锁（package-lock.json）]')
{
  const lockDir = path.join(tmp, 'lock-scope')
  const lockProfile = path.join(lockDir, 'profile')
  fs.mkdirSync(lockProfile, { recursive: true })
  const fakeLock = path.join(lockDir, 'package-lock.json')
  fs.writeFileSync(fakeLock, JSON.stringify({ name: 'dsh-profile-desktop', lockfileVersion: 3, packages: {} }))
  ok('findVendorLockfile 找得到 profile 上一级的锁', findVendorLockfile(lockProfile) === fakeLock, String(findVendorLockfile(lockProfile)))
  const noLockProfile = path.join(tmp, 'lock-scope-none', 'profile')
  fs.mkdirSync(noLockProfile, { recursive: true })
  ok('没有锁时返回 null 而不是抛', findVendorLockfile(noLockProfile) === null)
  // 消费侧：installDependencies 必须把锁**拷进 profile** 再装（npm 只认 cwd 下的锁）
  const consumeProfile = path.join(tmp, 'lock-consume', 'profile')
  fs.mkdirSync(consumeProfile, { recursive: true })
  const okInstall = await installDependencies({
    profileDir: consumeProfile, npmCli: path.join(tmp, 'unused-npm.js'),
    runtime: process.execPath, env: { ...process.env },
    lockfile: fakeLock,
    // 用一个"假 npm"：真 npm 会去联网；这里只验证锁被拷进去了（装失败无所谓）
    _test: true,
  }).catch(() => ({ ok: false }))
  void okInstall
  ok('installDependencies 把锁拷进了 profile（npm 只认 cwd 下的锁）',
    fs.existsSync(path.join(consumeProfile, 'package-lock.json')),
    fs.existsSync(path.join(consumeProfile, 'package-lock.json')) ? '已拷入' : '没拷进去')
  // 构建编排必须把锁**透传**给安装实现
  const lockSeen = []
  const spyInstall = async (o) => { lockSeen.push(o.lockfile ?? null); fs.mkdirSync(path.join(o.profileDir, 'node_modules'), { recursive: true }); return { ok: true } }
  const lockBuildDir = path.join(tmp, 'lock-orchestrate')
  const lockBuild = await buildVendorTree({
    ...base, install: true, profileDir: path.join(lockBuildDir, 'profile'), npmCli: fakeNpm,
    abiGate: okGate, installFn: spyInstall, bootGate: null,
  })
  // 注意：这里 profileDir 的上一级是 lockBuildDir，没有锁 ⇒ 透传的应是 null（**没有锁也要能装**）
  ok('没有锁时编排照常工作（不把"缺锁"变成硬失败）',
    lockBuild.ok === true && lockSeen.length === 1 && lockSeen[0] === null, JSON.stringify({ ok: lockBuild.ok, seen: lockSeen }))
  fs.writeFileSync(path.join(lockBuildDir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }))
  const lockBuild2Dir = path.join(tmp, 'lock-orchestrate2')
  const lockSeen2 = []
  const spyInstall2 = async (o) => { lockSeen2.push(o.lockfile ?? null); fs.mkdirSync(path.join(o.profileDir, 'node_modules'), { recursive: true }); return { ok: true } }
  fs.mkdirSync(lockBuild2Dir, { recursive: true })
  fs.writeFileSync(path.join(lockBuild2Dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}')
  const lockBuild2 = await buildVendorTree({
    ...base, install: true, profileDir: path.join(lockBuild2Dir, 'profile'), npmCli: fakeNpm,
    abiGate: okGate, installFn: spyInstall2, bootGate: null,
  })
  ok('有锁时编排把锁路径透传给安装实现',
    lockBuild2.ok === true && typeof lockSeen2[0] === 'string' && lockSeen2[0].endsWith('package-lock.json'),
    JSON.stringify(lockSeen2))
}

// buildStaging 是"真构建"形态（install=true），所以同样注入假 npm 与假安装实现。
const staging = await buildStaging({
  ...base, install: true, npmCli: fakeNpm, installFn: fakeInstall, abiGate: okGate,
  stagingRoot: path.join(tmp, 'staging'),
})
ok('buildStaging 产出 profile 与 lock', staging.ok === true && fs.existsSync(staging.lockPath) && fs.existsSync(path.join(staging.profileDir, 'package.json')), staging.error)
ok('lock 含版本与门禁结论', staging.lock?.dshVersions?.['@deepseek-ai/dsh'] === '9.9.9-rc.1' && staging.lock?.abiScan === 'PASS')
ok('lock 含统计（等价性验证口径）', typeof staging.lock?.totalFiles === 'number' && typeof staging.lock?.totalBytes === 'number')
ok('lock 记录了门禁是否延后', staging.lock?.gatesDeferred?.abi === false && staging.lock?.gatesDeferred?.boot === true, JSON.stringify(staging.lock?.gatesDeferred))
ok('lock 记录 node_modules 基线（依赖完整性判据）', Number.isFinite(staging.lock?.nodeModulesFiles), String(staging.lock?.nodeModulesFiles))

// 交叉构建：显式延后 ABI 门禁。这里最要紧的一条是"**不许写 PASS**"——lock 里的假绿会被
// 后来的人当成"已经验过了"，而交叉产物根本没跑过门禁。
console.log('[交叉构建门禁延后]')
const crossStaging = await buildStaging({
  ...base, install: true, npmCli: fakeNpm, installFn: fakeInstall,
  abiGate: badGate,                       // 故意给一个必 FAIL 的门禁：延后了就不该被调用
  skipAbiGate: true,
  target: { os: 'linux', arch: 'x64', libc: 'glibc' },
  stagingRoot: path.join(tmp, 'staging-cross'),
})
ok('交叉构建不跑 ABI 门禁（必 FAIL 的门禁未被触发）', crossStaging.ok === true, crossStaging.error)
ok('交叉构建 lock 的 abiScan 不是 PASS', crossStaging.lock?.abiScan !== 'PASS', String(crossStaging.lock?.abiScan))
ok('交叉构建 lock 的 abiScan 标注 DEFERRED', /DEFERRED/.test(String(crossStaging.lock?.abiScan)), String(crossStaging.lock?.abiScan))
ok('交叉构建 lock 的 gatesDeferred.abi=true', crossStaging.lock?.gatesDeferred?.abi === true, JSON.stringify(crossStaging.lock?.gatesDeferred))
ok('交叉构建 lock 的 platform.tag 是目标平台', crossStaging.lock?.platform?.tag === 'linux-x64', JSON.stringify(crossStaging.lock?.platform))
ok('交叉构建未记录 abi 结果（没跑就没有）', crossStaging.lock?.abi === undefined || crossStaging.lock?.abi === null)
ok('ABI 门禁没跑时 abiScan 仍写在 lock 里（不得静默省略）', 'abiScan' in (crossStaging.lock ?? {}))

// install=false + staging 是**用错层次**：暂存区是空的，没有树可剪。旧写法会报"需要已有
// node_modules <暂存路径>"，把用户指向一个他根本没打算用的目录。这条钉住"当场拒绝并说清去处"。
const badStaging = await buildStaging({
  ...base, install: false, stagingRoot: path.join(tmp, 'staging-bad'), log: () => {},
})
ok('buildStaging 拒绝 install=false（prune-only 不属于它）', badStaging.ok === false && /install=true/.test(badStaging.error), badStaging.error)

// lock 字段集只有一处定义（buildVendorLock），两个写入方共用——漂移会让"同一个应用两个 lock 形状"。
const lockSrc = fs.readFileSync(new URL('../src/vendor-build.mjs', import.meta.url), 'utf8')
ok('lock 字段集只定义一次（buildVendorLock 是唯一写入方）',
  (lockSrc.match(/abiScan:/g) ?? []).length === 1 && typeof buildVendorLock === 'function',
  `abiScan 赋值处 ${(lockSrc.match(/abiScan:/g) ?? []).length} 处`)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(fail === 0 ? '\nVENDOR BUILD SELF TEST: ALL PASS' : `\nVENDOR BUILD SELF TEST: ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
