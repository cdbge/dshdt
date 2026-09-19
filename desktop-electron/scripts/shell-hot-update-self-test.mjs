// shell-hot-update-self-test.mjs — 「按钮热更新 dshdt 自身」的离线自检（纯 Node，脱网，秒级）：
// 拿 @electron/asar 当独立裁判交叉验证 asar 打补丁/重算 integrity，并端到端真跑助手脚本的成功与回滚两条路径。
import {
  computeIntegrity,
  listAsarFiles,
  parseAsar,
  patchAsarBuffer,
  readAsarFile,
} from '../src/asar-patch.mjs'
import {
  buildPatchedAsar,
  helperScriptText,
  planShellSwap,
  probeShellWritable,
  shellSourceDir,
} from '../src/shell-update.mjs'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let fail = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!cond) fail++ }

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-hot-update-test-'))
const write = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c) }

// 夹具：用 @electron/asar（devDependency）造一个"像真产物"的 asar
let asarLib = null
try { asarLib = (await import('@electron/asar')).default ?? (await import('@electron/asar')) } catch { asarLib = null }
ok('@electron/asar 可用（当独立裁判读回我们写的 asar）', asarLib !== null)

const appDir = path.join(tmp, 'app-src')
write(path.join(appDir, 'package.json'), JSON.stringify({ name: 'dsh-desktop', main: 'src/main.mjs', version: '0.4.7' }))
write(path.join(appDir, 'VERSION'), '0.4.7')
write(path.join(appDir, 'src', 'main.mjs'), '// 旧壳 main\nexport const v = "0.4.7"\n')
write(path.join(appDir, 'src', 'helper.mjs'), '// 旧壳 helper\nexport const x = 1\n')
write(path.join(appDir, 'node_modules', 'dep', 'index.js'), 'module.exports = 42\n')
write(path.join(appDir, 'node_modules', 'dep', 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0' }))
const baseAsar = path.join(tmp, 'app.asar')
if (asarLib !== null) await asarLib.createPackage(appDir, baseAsar, { unpack: false })
ok('夹具 asar 造好了', fs.existsSync(baseAsar) && fs.statSync(baseAsar).size > 0)

// @electron/asar 的 extractFile 要的是平台分隔符形态（内部用 path.sep 切分），
// 两种形态都试。check-packaged-asar.mjs 也踩过同一处。
const asarExtract = (asarFile, rel) => {
  const win = rel.split('/').join(path.sep)
  const forms = [rel, win, path.sep + win, `/${rel}`, `\\${rel.split('/').join('\\')}`]
  let last = ''
  for (const f of forms) {
    try { return asarLib.extractFile(asarFile, f) } catch (e) { last = e.message }
  }
  throw new Error(`取不出 ${rel}：${last}`)
}
// listPackage 会把目录也算进来；这里只留文件（用"是不是别人的父路径"判定）
const asarFileList = (asarFile) => {
  const raw = [...asarLib.listPackage(asarFile)].map((e) => e.split('\\').join('/').replace(/^\//, ''))
  return raw.filter((p) => !raw.some((q) => q !== p && q.startsWith(`${p}/`))).sort()
}

console.log('[asar 头解析]')
{
  const buf = fs.readFileSync(baseAsar)
  const parsed = parseAsar(buf)
  const mine = [...listAsarFiles(parsed.header).keys()].sort()
  const theirs = asarLib === null ? [] : asarFileList(baseAsar)
  ok('条目集合与 @electron/asar 的 listPackage 一致', asarLib !== null && JSON.stringify(mine) === JSON.stringify(theirs),
    `mine=${mine.length} 条 / asar=${theirs.length} 条`)
  ok('能按 offset 取出文件内容（原文一致）',
    readAsarFile(buf, parsed, listAsarFiles(parsed.header).get('src/main.mjs')).toString('utf8').includes('旧壳 main'))
  ok('坏头被拒（第一个 u32 不是 4）', (() => { try { parseAsar(Buffer.alloc(32)); return false } catch { return true } })())
  ok('截断的头被拒', (() => { try { parseAsar(buf.subarray(0, 20)); return false } catch { return true } })())
}

console.log('[asar 打补丁]')
const newMain = '// 新壳 main（来自仓库）\nexport const v = "1.0.0"\n'
const newVersion = '1.0.0'
let patched = null
{
  const buf = fs.readFileSync(baseAsar)
  const r = patchAsarBuffer(buf, { replace: new Map([['src/main.mjs', Buffer.from(newMain)], ['VERSION', Buffer.from(newVersion)]]), log: () => {} })
  ok('打补丁成功', r.ok === true, r.ok ? '' : r.error)
  patched = r.buffer
  const out = path.join(tmp, 'patched.asar')
  fs.writeFileSync(out, patched)

  // 用 @electron/asar 读回来：替换生效、未动的条目逐字节相同
  const gotMain = asarExtract(out, 'src/main.mjs').toString('utf8')
  const gotVer = asarExtract(out, 'VERSION').toString('utf8')
  const gotHelper = asarExtract(out, 'src/helper.mjs').toString('utf8')
  const gotDep = asarExtract(out, 'node_modules/dep/index.js').toString('utf8')
  ok('替换过的文件是新内容', gotMain === newMain && gotVer === newVersion)
  ok('**没动的文件原样保留**（helper.mjs）', gotHelper.includes('旧壳 helper'))
  ok('**asar 里的 node_modules 也在**（漏搬就等于新壳缺依赖）', gotDep.includes('42'))
  ok('条目总数不变（2 换 2）', listAsarFiles(parseAsar(patched).header).size === listAsarFiles(parseAsar(buf).header).size)

  // integrity 必须重算，且与原实现同构
  const p = parseAsar(patched)
  const entry = listAsarFiles(p.header).get('src/main.mjs')
  ok('替换过的条目带重算后的 integrity',
    entry.integrity !== undefined && entry.integrity.hash === computeIntegrity(Buffer.from(newMain)).integrity.hash,
    JSON.stringify(entry.integrity).slice(0, 80))
  ok('原条目的 integrity 结构被保留（算法/块大小）',
    entry.integrity.algorithm === 'SHA256' && entry.integrity.blocks.length === 1)
  ok('新增文件也能进 asar（offset 被正确分配）',
    (() => {
      const r2 = patchAsarBuffer(buf, { replace: new Map([['src/brand-new.mjs', Buffer.from('// 新文件\n')]]), log: () => {} })
      if (!r2.ok) return false
      const out2 = path.join(tmp, 'patched2.asar')
      fs.writeFileSync(out2, r2.buffer)
      return asarExtract(out2, 'src/brand-new.mjs').toString('utf8') === '// 新文件\n'
    })())
  ok('删除条目也支持（并收掉空目录）',
    (() => {
      const r3 = patchAsarBuffer(buf, { remove: ['src/helper.mjs'], log: () => {} })
      if (!r3.ok) return false
      const out3 = path.join(tmp, 'patched3.asar')
      fs.writeFileSync(out3, r3.buffer)
      const list = asarFileList(out3)
      return r3.removed.length === 1 && !list.some((e) => e.endsWith('helper.mjs'))
    })())
  ok('超单块上限时拒绝（不写校验对不上的 integrity）',
    computeIntegrity(Buffer.alloc(5 * 1024 * 1024), 4194304).ok === false)
  ok('路径穿越被拒', patchAsarBuffer(buf, { replace: new Map([['../escape.js', Buffer.from('x')]]), log: () => {} }).ok === false)
}

console.log('[真实产物形态（本地有 dist 才跑）]')
{
  const realAsar = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar')
  if (!fs.existsSync(realAsar)) {
    ok('本地没有 dist/win-unpacked 的 app.asar ⇒ 跳过这一段（CI 的正常情况）', true, 'skipped')
  } else {
    const buf = fs.readFileSync(realAsar)
    const before = listAsarFiles(parseAsar(buf).header)
    const withIntegrity = [...before.values()].filter((v) => v.integrity !== undefined).length
    ok('真 asar 的条目带 integrity（换了必须重算）', withIntegrity === before.size, `${withIntegrity}/${before.size}`)
    const r = patchAsarBuffer(buf, { replace: new Map([['VERSION', Buffer.from('9.9.9-test')]]), log: () => {} })
    ok('真 asar 打补丁成功', r.ok === true, r.ok ? '' : r.error)
    if (r.ok) {
      const out = path.join(tmp, 'real-patched.asar')
      fs.writeFileSync(out, r.buffer)
      const after = listAsarFiles(parseAsar(r.buffer).header)
      ok('条目数不变（node_modules 一个都没丢）', after.size === before.size, `${after.size} vs ${before.size}`)
      ok('VERSION 换成新值', asarExtract(out, 'VERSION').toString('utf8') === '9.9.9-test')
      // 逐个条目比字节：没被替换的必须逐字节相同（证明数据区搬迁没出错位）
      let same = 0
      let diff = 0
      for (const [rel, entry] of after) {
        if (rel === 'VERSION' || entry.unpacked === true) continue
        const a = asarExtract(realAsar, rel)
        const b = asarExtract(out, rel)
        if (Buffer.compare(a, b) === 0) same += 1
        else diff += 1
      }
      ok('未替换的条目逐字节相同（偏移搬迁正确）', diff === 0, `相同 ${same} / 不同 ${diff}`)
    }
  }
}

console.log('[换壳编排]')
const HOME = path.join(tmp, 'home')
const RES = path.join(tmp, 'install', 'resources')
fs.mkdirSync(RES, { recursive: true })
fs.copyFileSync(baseAsar, path.join(RES, 'app.asar'))
{
  const files = ['src/main.mjs', 'VERSION', 'package.json']
  const r0 = buildPatchedAsar({ home: HOME, resourcesPath: RES, files, log: () => {} })
  ok('还没下源码时：明确报"缺文件"而不是崩', r0.ok === false && String(r0.error).includes('缺文件'), r0.error ?? '')

  for (const f of files) write(path.join(shellSourceDir(HOME), f), f === 'src/main.mjs' ? newMain : (f === 'VERSION' ? '1.0.0' : JSON.stringify({ name: 'dsh-desktop', main: 'src/main.mjs', version: '1.0.0' })))
  const r = buildPatchedAsar({ home: HOME, resourcesPath: RES, files, log: () => {} })
  ok('打出新 asar（暂存区里，不动现网文件）', r.ok === true && fs.existsSync(r.stagedAsar), r.ok ? r.stagedAsar : r.error)
  ok('现网 app.asar 没被动（换件必须由助手在退出后做）',
    asarExtract(path.join(RES, 'app.asar'), 'src/main.mjs').toString('utf8').includes('旧壳 main'))
  ok('新 asar 里是新内容', asarExtract(r.stagedAsar, 'src/main.mjs').toString('utf8') === newMain)

  const probe = probeShellWritable(RES)
  ok('可写目录探测通过', probe.writable === true, probe.reason)
  const ro = path.join(tmp, 'nope-dir', 'resources')
  ok('不存在的目录探测为不可写（Linux deb/AppImage 的形态）', probeShellWritable(ro).writable === false)
}

console.log('[助手脚本端到端]')
{
  const script = helperScriptText()
  const scriptPath = path.join(tmp, 'helper-check.mjs')
  fs.writeFileSync(scriptPath, script)
  const check = spawnSync(process.execPath, ['--check', scriptPath], { stdio: ['ignore', 'ignore', 'inherit'] })
  ok('生成的助手脚本能通过语法检查（它就是要在换壳窗口里跑的那段代码）', check.status === 0, `status=${check.status}`)

  // 假应用：把 smokeArgs 指向一个打印 PASS 计数（或失败）的小脚本
  const fakePass = path.join(tmp, 'fake-app-pass.mjs')
  write(fakePass, 'process.stdout.write("72/72 PASS\\nSMOKE OK\\n")\nprocess.exit(0)\n')
  const fakeFail = path.join(tmp, 'fake-app-fail.mjs')
  write(fakeFail, 'process.stdout.write("FAIL 壳起不来\\n")\nprocess.exit(1)\n')

  // 跑一次助手：返回 {status, asar 内容, 标记文件, 残留文件, 是否重启过}
  const runHelper = (smokeScript, tag, { stageMissing = false, stageDir = false } = {}) => {
    const home = path.join(tmp, `helper-home-${tag}`)
    const res = path.join(tmp, `helper-install-${tag}`, 'resources')
    fs.mkdirSync(res, { recursive: true })
    fs.copyFileSync(baseAsar, path.join(res, 'app.asar'))
    // "新壳"：把 main.mjs 换成新内容
    const p = patchAsarBuffer(fs.readFileSync(baseAsar), { replace: new Map([['src/main.mjs', Buffer.from(newMain)]]), log: () => {} })
    const staged = path.join(home, 'repo-updates', 'shell-swap', 'app.asar.new')
    fs.mkdirSync(path.dirname(staged), { recursive: true })
    if (!stageMissing && !stageDir) fs.writeFileSync(staged, p.buffer)
    // stageDir：让"暂存路径"是个目录 —— 拷贝必然失败，用来验证失败分支也重启应用
    if (stageDir) { fs.mkdirSync(staged, { recursive: true }); fs.writeFileSync(path.join(staged, 'x'), 'x') }
    const work = path.dirname(staged)
    const markerFile = path.join(work, 'last-swap.json')
    const relaunchFile = path.join(work, 'relaunched.txt')
    // 假"重启"：记一笔就走。顺带记下当时的环境变量——助手自己是 ELECTRON_RUN_AS_NODE=1 起来的，
    // 把这份环境继承给"重启"会让新壳退化成纯 Node（bad option: --smoke）。
    const fakeRelaunch = path.join(tmp, `fake-relaunch-${tag}.mjs`)
    const relaunchEnvFile = path.join(work, 'relaunch-env.txt')
    write(fakeRelaunch, `import fs from 'node:fs'\nfs.appendFileSync(${JSON.stringify(relaunchFile)}, 'relaunched\\n')\nfs.appendFileSync(${JSON.stringify(relaunchEnvFile)}, String(process.env.ELECTRON_RUN_AS_NODE) + '\\n')\n`)
    const cfg = {
      resourcesPath: res,
      stagedAsar: staged,
      parentPid: 0, // 0 = 不用等（单测）
      execPath: process.execPath,
      relaunchArgs: [fakeRelaunch],
      // 真实实现由 planShellSwap 算：摘掉 ELECTRON_RUN_AS_NODE 的干净环境
      relaunchEnv: (() => { const e = { ...process.env }; delete e.ELECTRON_RUN_AS_NODE; return e })(),
      appCwd: tmp,
      smokeArgs: [smokeScript],
      smokeEnv: { ...process.env },
      smokeTimeoutMs: 20000,
      waitTimeoutMs: 1000,
      workDir: work,
      logFile: path.join(work, 'swap.log'),
      markerFile,
    }
    const helper = path.join(work, 'apply-shell.mjs')
    const cfgPath = path.join(work, 'apply-shell.json')
    fs.writeFileSync(helper, helperScriptText())
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
    // 故意让助手进程带着 ELECTRON_RUN_AS_NODE=1 跑（真实情况就是这样）
    const r = spawnSync(process.execPath, [helper, cfgPath], {
      stdio: ['ignore', 'ignore', 'inherit'],
      timeout: 60000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    const asarNow = path.join(res, 'app.asar')
    const content = fs.existsSync(asarNow) ? asarExtract(asarNow, 'src/main.mjs').toString('utf8') : '(缺失)'
    const marker = (() => { try { return JSON.parse(fs.readFileSync(markerFile, 'utf8')) } catch { return null } })()
    const leftovers = fs.readdirSync(res).filter((n) => n.includes('.bak-') || n.includes('.broken-'))
    // 假重启是 detached 的：轮询等它落盘（同步 sleep，别把 suite 变成异步）
    const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* 略 */ } }
    let waited = 0
    while (!fs.existsSync(relaunchFile) && waited < 5000) { sleepSync(200); waited += 200 }
    const relaunchEnv = (() => { try { return fs.readFileSync(relaunchEnvFile, 'utf8').trim() } catch { return '(没记到)' } })()
    return { status: r.status, content, marker, leftovers, relaunched: fs.existsSync(relaunchFile), relaunchEnv, all: fs.readdirSync(res) }
  }

  const pass = runHelper(fakePass, 'pass')
  ok('成功路径：新壳就位（内容来自仓库）', pass.content === newMain, pass.content.slice(0, 40))
  ok('成功路径：助手退出码 0 且写了"成功"标记', pass.status === 0 && pass.marker?.ok === true, `status=${pass.status} marker=${JSON.stringify(pass.marker)}`)
  ok('成功路径：**保留备份**（换取件后仍能人工回滚）', pass.leftovers.length === 1, pass.leftovers.join(','))
  ok('成功路径：应用被重新启动（否则用户看到"点了按钮应用就没了"）', pass.relaunched === true)
  ok('**重启时摘掉了 ELECTRON_RUN_AS_NODE**（否则新壳退化成纯 Node、应用再也起不来）',
    pass.relaunchEnv === 'undefined', `重启进程看到的 ELECTRON_RUN_AS_NODE=${pass.relaunchEnv}`)

  const bad = runHelper(fakeFail, 'fail')
  ok('回滚路径：新壳没通过自检 ⇒ 换回旧壳', bad.content.includes('旧壳 main'), bad.content.slice(0, 40))
  ok('回滚路径：退出码非 0 且标记为失败', bad.status !== 0 && bad.marker?.ok === false, `status=${bad.status} marker=${JSON.stringify(bad.marker)}`)
  ok('回滚路径：坏包被留在旁边（可取证），备份已归位', bad.leftovers.some((n) => n.includes('.broken-')), bad.leftovers.join(','))
  ok('回滚路径：旧壳同样被启动回来', bad.relaunched === true)

  // 实测教训（本机换壳真的这么失败过）：应用刚退出时 Windows 还没释放 app.asar 的文件映射，
  // 立刻改名会 EBUSY。所以助手必须①对改名重试 ②**任何失败都要把应用拉起来**（不能让用户面对"点了按钮应用没了"）。
  const helperSrc = helperScriptText()
  ok('助手对改名做了重试（EBUSY/EPERM/EACCES 且有限等）',
    /renameWithRetry/.test(helperSrc) && /EBUSY/.test(helperSrc) && /lockWaitMs/.test(helperSrc))
  ok('替换失败分支也会重启应用（不是直接退出）',
    /替换失败[\s\S]{0,600}?relaunch\(\)[\s\S]{0,80}?process\.exit\(12\)/.test(helperSrc))
  // 实测教训 2：暂存区在 $DSH_HOME（C:），安装目录可能在 D: —— 跨盘 rename 直接 EXDEV。
  // 所以必须"先拷进安装目录（同盘）再改名"，不能再对暂存路径直接 rename。
  ok('新件先拷进安装目录再同盘改名（跨盘 rename 会 EXDEV）',
    /copyFileSync\(cfg\.stagedAsar, incoming\)/.test(helperSrc) && !/renameWithRetry\(cfg\.stagedAsar/.test(helperSrc))
  ok('成功路径：安装目录里不留 .staged- 临时件', !pass.all.some((n) => n.includes('.staged-')), pass.all.join(','))
  const badStage = runHelper(fakePass, 'stage-broken', { stageDir: true })
  ok('拷不进安装目录时：退出码 11、标记 stage-copy、**并把应用拉回来**',
    badStage.status === 11 && badStage.marker?.stage === 'stage-copy' && badStage.relaunched === true,
    `status=${badStage.status} marker=${JSON.stringify(badStage.marker)} relaunched=${badStage.relaunched}`)
  ok('拷不进去时不动现网 app.asar（先拷后换，顺序不能反）', badStage.content.includes('旧壳 main'))
  const missing = runHelper(fakeFail, 'stage-missing', { stageMissing: true })
  ok('新件缺失时：退出码 11、写失败标记、**并把应用拉回来**',
    missing.status === 11 && missing.marker?.ok === false && missing.relaunched === true,
    `status=${missing.status} marker=${JSON.stringify(missing.marker)} relaunched=${missing.relaunched}`)
}

console.log('[接线]')
{
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.mjs'), 'utf8')
  const admin = fs.readFileSync(path.join(ROOT, 'src', 'admin.mjs'), 'utf8')
  const client = fs.readFileSync(path.join(ROOT, 'packages', 'dsh-desktop-ui', 'lib', 'client.js'), 'utf8')
  ok('main.mjs 用 planShellSwap/spawnSwapHelper（不是只 import）', /planShellSwap\(/.test(main) && /spawnSwapHelper\(/.test(main))
  ok('main.mjs 在打包态才允许换壳（开发态没有 asar）', /app\.isPackaged/.test(main) && /换壳/.test(main))
  ok('admin.mjs 有换壳路由', admin.includes("'/api/repo-update/shell'"))
  ok('界面有「换壳并重启」按钮并接上该路由', client.includes('换壳并重启') && client.includes('/api/repo-update/shell'))
  ok('托盘有换壳入口', main.includes('换壳并重启'))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(fail === 0 ? '\nSHELL HOT UPDATE SELF TEST: ALL PASS' : `\nSHELL HOT UPDATE SELF TEST: ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
