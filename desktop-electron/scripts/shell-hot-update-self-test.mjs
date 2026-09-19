// shell-hot-update-self-test.mjs — 「按钮热更新 dshdt 自身」的离线自检（纯 Node，脱网，秒级）
//
// 这是 1.0.0 的**唯一功能**，而它的失败形态全都很难看：
//   · 换坏了 asar ⇒ 用户双击应用直接崩（0.4.6 已经真实发生过一次，见 check-packaged-asar.mjs 头注释）；
//   · 漏搬了 asar 里的 node_modules ⇒ 新壳缺依赖，起不来；
//   · integrity 没重算 ⇒ Electron 一旦开启 asar 完整性校验就拒绝加载；
//   · 备份/回滚没做对 ⇒ 新壳起不来时用户**没有任何自救路径**。
// 所以这里既有"格式对不对"的交叉验证（拿 `@electron/asar` 当独立裁判读回来），也有"助手脚本真跑一遍"
// 的端到端验证——**成功路径与回滚路径都要跑**，只测成功路径等于没测回滚。
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

// ── 夹具：用 @electron/asar（devDependency）造一个"像真产物"的 asar ──
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

// `@electron/asar` 的 extractFile 要的是**平台分隔符**形态（Windows 上是 `\`）：它内部
// `searchNodeFromDirectory` 用 `path.sep` 切分，而 `path.dirname('a/b')` 在 Windows 上又会把 `/` 归一
// ⇒ 只有一层嵌套时正斜杠"看起来能用"，两层以上就会 "was not found in this archive"。
// check-packaged-asar.mjs 也踩过同一处（它选择"两种形态都试一遍"），这里同样两种都试。
const asarExtract = (asarFile, rel) => {
  const win = rel.split('/').join(path.sep)
  const forms = [rel, win, path.sep + win, `/${rel}`, `\\${rel.split('/').join('\\')}`]
  let last = ''
  for (const f of forms) {
    try { return asarLib.extractFile(asarFile, f) } catch (e) { last = e.message }
  }
  throw new Error(`取不出 ${rel}：${last}`)
}
/** listPackage 会把目录也算进来；这里只留文件（用"是不是别人的父路径"判定）。 */
const asarFileList = (asarFile) => {
  const raw = [...asarLib.listPackage(asarFile)].map((e) => e.split('\\').join('/').replace(/^\//, ''))
  return raw.filter((p) => !raw.some((q) => q !== p && q.startsWith(`${p}/`))).sort()
}

// ── 1) 头部解析：自解析结果必须与独立裁判一致 ──
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

// ── 2) 打补丁：只换指定文件，其它一个字节都不动 ──
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

  // 用 @electron/asar 读回来：替换生效、未动的条目**逐字节相同**
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

// ── 2b) 真实产物形态：本地有 dist 时，直接在**真 asar** 上打补丁并逐条目验证 ──
// （CI 的 self-test job 跑在打包之前，没有 dist ⇒ 这一段在 CI 里自动跳过；本地验证时它才是主力）
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
      // 逐个条目比字节：没被替换的必须**逐字节相同**（证明数据区搬迁没出错位）
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

// ── 3) 编排层：暂存源码 → 打新 asar；可写性探测 ──
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

// ── 4) 助手脚本：真跑一遍（成功 + 回滚），用假"应用可执行文件" ──
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

  /** 跑一次助手：返回 {status, asar 内容, 标记文件, 残留文件, 是否重启过} */
  const runHelper = (smokeScript, tag) => {
    const home = path.join(tmp, `helper-home-${tag}`)
    const res = path.join(tmp, `helper-install-${tag}`, 'resources')
    fs.mkdirSync(res, { recursive: true })
    fs.copyFileSync(baseAsar, path.join(res, 'app.asar'))
    // "新壳"：把 main.mjs 换成新内容
    const p = patchAsarBuffer(fs.readFileSync(baseAsar), { replace: new Map([['src/main.mjs', Buffer.from(newMain)]]), log: () => {} })
    const staged = path.join(home, 'repo-updates', 'shell-swap', 'app.asar.new')
    fs.mkdirSync(path.dirname(staged), { recursive: true })
    fs.writeFileSync(staged, p.buffer)
    const work = path.dirname(staged)
    const markerFile = path.join(work, 'last-swap.json')
    const relaunchFile = path.join(work, 'relaunched.txt')
    // 假"重启"：记一笔就走（真实的 execPath 是应用可执行文件）。
    // 顺带把**当时的环境变量**记下来：这是本地实测抓到的真 bug 的回归断言——助手进程自己是
    // `ELECTRON_RUN_AS_NODE=1` 起来的，若把这份环境继承给"重启"，新壳会退化成纯 Node
    // （`bad option: --smoke`），表现为"换壳成功但应用再也起不来"。
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
    return { status: r.status, content, marker, leftovers, relaunched: fs.existsSync(relaunchFile), relaunchEnv }
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
}

// ── 5) 接线：壳/界面/托盘真的接上了 ──
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
