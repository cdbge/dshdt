// market-install-official-self-test.mjs — 官方安装路径（`dsh plugin add`）的失败分支夹具
//
// 口径：**不联网、不真装**。`spawnSync` 是注入的假实现，所以每条分支（缺 pnpm / 构建脚本被拦 /
// 退出码非 0 / 超时 / 装完核对不上）都能精确构造。真实安装联不了网也跑不动，但"报错分档对不对、
// 有没有把可执行的下一步给出来"是能在这里钉死的。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { toInstallSpec, probePnpm, pnpmHint, installMarketEntryOfficial } from '../src/market-install-official.mjs'

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mktofficial-'))
const SHA = 'a'.repeat(40)

// ---------- 1) 坐标校验（"审核过的那一份"能不能被钉住，全看这里）----------
console.log('[toInstallSpec 坐标校验]')
{
  const okSpec = (v) => toInstallSpec({ install: { spec: v } })
  ok('npm 精确版本 → 通过', okSpec('dsh-hello-plugin@1.0.0').ok)
  ok('scope 包 + 版本 → 通过', okSpec('@scope/x@1.0.0').ok && okSpec('@scope/x@1.0.0').kind === 'registry')
  ok('github 钉 40 位 commit → 通过', okSpec(`github:o/r#${SHA}`).ok && okSpec(`github:o/r#${SHA}`).kind === 'github')
  ok('https tarball → 通过', okSpec('https://e.com/x-1.0.0.tgz').ok && okSpec('https://e.com/x-1.0.0.tgz').kind === 'tarball')
  // 这几条是核心：允许可变引用 = "审核过的那一份"守不住
  ok('github 只给分支/标签 → 拒绝（必须钉 commit）', !okSpec('github:o/r#main').ok, JSON.stringify(okSpec('github:o/r#main')))
  ok('github 不带 ref → 拒绝', !okSpec('github:o/r').ok)
  ok('http 坐标 → 拒绝', !okSpec('http://e.com/x.tgz').ok)
  ok('非 .tgz 的 http 地址 → 拒绝', !okSpec('https://e.com/x.zip').ok)
  ok('含空白 → 拒绝', !okSpec('a b').ok)
  ok('空 → 拒绝并说明要写 install.spec', !okSpec('').ok && /install\.spec/.test(okSpec('').error))
}

// ---------- 2) pnpm 探测 ----------
console.log('[probePnpm]')
{
  const yes = () => ({ status: 0, stdout: '11.22.0', stderr: '' })
  const enoent = () => ({ status: null, error: Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' }) })
  const boom = () => ({ status: 1, stdout: '', stderr: 'nope' })
  ok('pnpm 在 → ok 且报出版本', probePnpm(yes).ok === true && probePnpm(yes).detail === '11.22.0')
  ok('pnpm 不在（ENOENT）→ 明确判不可用', probePnpm(enoent).ok === false && /不在 PATH/.test(probePnpm(enoent).detail))
  ok('pnpm 退出码非 0 → 判不可用', probePnpm(boom).ok === false)
  ok('提示里给了 corepack 与 npm 两条可执行做法',
    /corepack enable/.test(pnpmHint()) && /npm i -g pnpm/.test(pnpmHint()))
}

// ---------- 3) 安装：成功与每条失败分支 ----------
console.log('[installMarketEntryOfficial]')
const entry = (spec) => ({ id: 'demo', name: '演示', install: { spec } })
/** 造一个行为可编排的假 spawnSync：按 (cmd, args[1]) 分派。 */
function fakeSpawn({ pnpm = { status: 0, stdout: '11.22.0' }, dsh = { status: 0, stdout: 'done' }, throwOn = null } = {}) {
  return (cmd, args, opts) => {
    if (throwOn !== null && throwOn(cmd, args)) throw new Error('假异常')
    if (cmd === 'pnpm') return pnpm
    return dsh
  }
}
/** 准备一个 profile 目录，并在其中写好 manifest（用于安装后核对）。 */
let seq = 0
function profileWith(manifest) {
  const dir = path.join(tmp, `p${seq++}`)
  fs.mkdirSync(dir, { recursive: true })
  if (manifest !== null) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
  return dir
}
const baseDeps = (dir, over = {}) => ({
  bin: 'C:/dsh/lib/bin.js', profile: 'web', profileDir: dir, runtime: 'node.exe',
  spawnSync: fakeSpawn(), ...over,
})

{
  const dir = profileWith({ name: 'p', dependencies: { 'dsh-hello-plugin': '^1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-hello-plugin'] } } })
  const r = installMarketEntryOfficial(entry('dsh-hello-plugin@1.0.0'), baseDeps(dir))
  ok('正向：成功且标出需要重启', r.ok === true && r.needsRestart === true, JSON.stringify(r).slice(0, 140))
  ok('正向：认出这是 registry 坐标', r.kind === 'registry')
}
{
  const dir = profileWith(null)
  const r = installMarketEntryOfficial(entry('dsh-hello-plugin@1.0.0'), baseDeps(dir, { bin: '' }))
  ok('缺 dsh CLI 入口 → validate', r.ok === false && r.stage === 'validate' && /dshBin|CLI/.test(r.error), r.error)
}
{
  const dir = profileWith(null)
  const r = installMarketEntryOfficial(entry('github:o/r#main'), baseDeps(dir))
  ok('可变坐标（分支）→ validate 拒绝', r.ok === false && r.stage === 'validate', r.error)
}
{
  const dir = profileWith(null)
  const r = installMarketEntryOfficial(entry('x@1.0.0'), baseDeps(dir, { spawnSync: fakeSpawn({ pnpm: { status: null, error: Object.assign(new Error('x'), { code: 'ENOENT' }) } }) }))
  ok('缺 pnpm → pnpm 档 + 给出装法', r.ok === false && r.stage === 'pnpm' && /corepack/.test(r.hint), r.hint && r.hint.split('\n')[0])
}
{
  const dir = profileWith(null)
  const r = installMarketEntryOfficial(entry('x@1.0.0'), baseDeps(dir, { spawnSync: fakeSpawn({ dsh: { status: 127, stdout: '', stderr: 'pnpm not found on PATH' } }) }))
  ok('dsh 报 127（pnpm 缺失）→ 归到 pnpm 档并给装法', r.ok === false && r.stage === 'pnpm' && /corepack/.test(r.hint), r.error)
}
{
  const dir = profileWith(null)
  const blocked = 'Ignored build scripts: dsh-hello-plugin@1.0.0\nadd the exact key pnpm printed above under allowBuilds in .../pnpm-workspace.yaml'
  const r = installMarketEntryOfficial(entry(`github:o/r#${SHA}`), baseDeps(dir, { spawnSync: fakeSpawn({ dsh: { status: 1, stdout: blocked } }) }))
  ok('git 包构建脚本被拦 → 单独分档，不自动授权', r.ok === false && r.stage === 'build-script' && /allowBuilds/.test(r.error), r.error)
  ok('该档明确说明"等于允许它在安装时执行代码"', /执行代码/.test(r.error))
}
{
  const dir = profileWith(null)
  const r = installMarketEntryOfficial(entry('x@1.0.0'), baseDeps(dir, { spawnSync: fakeSpawn({ dsh: { status: 1, stdout: 'ERR_PNPM_FETCH_404' } }) }))
  ok('普通非 0 退出 → pnpm 档并带退出码', r.ok === false && r.stage === 'pnpm' && /退出码 1/.test(r.error), r.error)
}
{
  const dir = profileWith(null)
  const r = installMarketEntryOfficial(entry('x@1.0.0'), baseDeps(dir, { spawnSync: fakeSpawn({ dsh: { status: null, error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) } }) }))
  ok('超时 → 单独分档', r.ok === false && r.stage === 'timeout', r.error)
}
{
  const dir = profileWith(null)
  // 只在**真的调 dsh 装**时抛：pnpm 探测那一步不抛（否则测到的是 pnpm 档，而不是 spawn 档——
  // 第一版就是这么写的，断言"看起来在测 spawn"，实际测的是别的东西）。
  const r = installMarketEntryOfficial(entry('x@1.0.0'), baseDeps(dir, {
    spawnSync: fakeSpawn({ throwOn: (cmd, args) => cmd !== 'pnpm' && args.includes('plugin') }),
  }))
  ok('spawn 抛异常 → spawn 档（不把异常漏出去）', r.ok === false && r.stage === 'spawn' && /假异常/.test(r.error), `${r.stage}: ${r.error}`)
}
{
  // **最关键的一条**：pnpm 说成功、但清单里没有痕迹 ⇒ 不能报成功
  const dir = profileWith({ name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } })
  const r = installMarketEntryOfficial(entry('x@1.0.0'), baseDeps(dir))
  ok('退出码 0 但清单无痕迹 → 报 verify 失败（不许"假成功"）', r.ok === false && r.stage === 'verify', r.error)
  // 同一个用例的对照：清单里有依赖才算成功
  const dir2 = profileWith({ name: 'p', dependencies: { x: '^1.0.0' } })
  const r2 = installMarketEntryOfficial(entry('x@1.0.0'), baseDeps(dir2))
  ok('清单里出现该依赖 → 判成功（对照）', r2.ok === true, JSON.stringify(r2).slice(0, 120))
}

try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { console.log('  ⚠️ 临时目录清理失败：' + tmp) }
console.log(`\nMARKET INSTALL OFFICIAL SELF TEST: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
