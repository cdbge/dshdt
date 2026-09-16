// check-packaged-asar.mjs — 校验**打包产物里**的 asar 代码能不能被解析
//
// 为什么必须单独有这一道（2026-09-15/16 的真实事故）：
//   我在改 `vendor-build.mjs` 时写坏了一处语法（`const lockDir = null` 混进解构形参），
//   **当场被离线门禁抓到并修好了**——但那个瞬间恰好有一次 `electron-builder --win nsis` 在跑，
//   于是打出了一个含坏代码的安装包，发到别人机器上**双击即崩**：
//
//       Uncaught Exception: SyntaxError: Unexpected identifier 'lockDir'
//         at compileSourceTextModule … ModuleLoader.getOrCreateModuleJob
//
//   为什么原有门禁全都没拦住：它们查的是**仓库 src/**（`node --check src/*.mjs` 之类），
//   而用户加载的是 **asar 里那一份**。两者之间隔着一个"打包时刻"——源在那一刻是好是坏，
//   决定了产物是好是坏，而**产物打出来之后就再没人看过它**。
//   更糟的是 `dist/win-unpacked` 会跨次复用：即使源已修好，只要不删旧目录，装出来的还是旧的坏代码。
//
// 判据：取出 asar 里**每一个** `.mjs`/`.js`，逐个做语法检查（等价于模块加载期的解析）。
// 用法：node scripts/check-packaged-asar.mjs <app.asar 路径 | 含 app.asar 的目录> [更多路径…]
//   不带参数时自动找 `dist/win-unpacked/resources/app.asar` 等常见位置。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
let fail = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!cond) fail++ }

/** 把参数归一到"存在的 app.asar 文件"列表；无参数时自动发现。 */
function resolveTargets(argv) {
  const out = []
  const push = (p) => { if (fs.existsSync(p) && fs.statSync(p).isFile() && p.endsWith('.asar') && !out.includes(p)) out.push(p) }
  if (argv.length > 0) {
    for (const a of argv) {
      const p = path.resolve(ROOT, a)
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        push(path.join(p, 'resources', 'app.asar'))
        push(path.join(p, 'app.asar'))
      } else push(p)
    }
  } else {
    for (const d of ['dist/win-unpacked', 'dist/linux-unpacked', 'dist/mac', 'dist/mac-arm64', 'dist/mac-x64']) {
      push(path.join(ROOT, d, 'resources', 'app.asar'))
    }
  }
  return out
}

/**
 * 检查一批 app.asar（打包产物里的那份代码能不能被解析）。
 *
 * 抽成函数是为了**两种调用方式共用同一份判据**：
 *   · CLI：`node scripts/check-packaged-asar.mjs [路径…]`（无参数时自动找 dist/ 下的解包目录）
 *   · electron-builder 的 `afterPack` 钩子（`electron-builder.yml` 里挂着）——产出一份就查一份
 * @param {string[]} paths app.asar 文件路径，或含 `resources/app.asar` 的目录
 * @returns {number} 失败数（0 = 全过）
 */
export async function checkPackagedAsar(paths) {
  let asar = null
  try { asar = await import('@electron/asar') } catch { asar = null }
  if (asar === null) {
    console.error('  FAIL  找不到 @electron/asar（它是 electron-builder 的依赖，应当在 node_modules 里）')
    return 1
  }

  const targets = []
  for (const p of paths) {
    const abs = path.resolve(p)
    const push = (q) => { if (fs.existsSync(q) && fs.statSync(q).isFile() && q.endsWith('.asar') && !targets.includes(q)) targets.push(q) }
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      push(path.join(abs, 'resources', 'app.asar'))
      push(path.join(abs, 'app.asar'))
    } else push(abs)
  }
  if (targets.length === 0) {
    console.log(`  FAIL  指定的路径里没有 app.asar：${paths.join(', ')}`)
    return 1
  }

  let fail = 0
  const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!cond) fail++ }
  const tmp = fs.mkdtempSync(path.join(ROOT, '.tmp-asar-check-'))
  try {
    for (const asarPath of targets) {
      const rel = path.relative(ROOT, asarPath).split(path.sep).join('/')
      console.log(`[asar] ${rel}`)
      let entries = []
      try { entries = asar.listPackage(asarPath) } catch (e) {
        ok(`${rel} 可读`, false, e.message)
        continue
      }
      // 注意：`asar.extractFile` 要的是 **asar 内记录的原样路径**（Windows 上是反斜杠），
      // 不做分隔符归一——第一版我把它转成了正斜杠，结果每个文件都"取不出"（假失败）。
      const srcEntries = entries.filter((e) => /\.(mjs|js|cjs)$/.test(e))
      ok(`${rel} 里有源码文件`, srcEntries.length > 0, `${srcEntries.length} 个（asar 共 ${entries.length} 条）`)

      const broken = []
      const environmentFailures = []
      for (const [i, entry] of srcEntries.entries()) {
        // 取文件：asar 内路径在不同平台/版本上可能带前导分隔符，所以**先原样试、再去掉前导分隔符试**。
        // （第一版按正斜杠归一 ⇒ 全部"取不出"；第二版原样传 ⇒ 仍因前导 `\` 失败。两次都是假失败。）
        let code = null
        let lastErr = ''
        for (const cand of [entry, entry.replace(/^[\\/]+/, '')]) {
          try { code = asar.extractFile(asarPath, cand); break } catch (e) { lastErr = e.message }
        }
        if (code === null) { broken.push(`${entry}（取不出：${lastErr}）`); continue }
        // 用临时文件做语法检查：`node --check` 只认文件路径，不吃 stdin。
        const base = entry.split(/[\\/]/).pop() ?? `file${i}.js`
        const tmpFile = path.join(tmp, `${i}-${base}`)
        fs.writeFileSync(tmpFile, code)
        // **输出走文件重定向，不用管道**：受限会话里创建匿名管道会被拒，
        // 子进程可能直接 `EPERM` 起不来（status=null、无输出）——本项目反复记录过这个坑。
        const errFile = `${tmpFile}.err`
        let status = null
        let spawnErr = null
        try {
          const fd = fs.openSync(errFile, 'w')
          try {
            const r = spawnSync(process.execPath, ['--check', tmpFile], { stdio: ['ignore', fd, fd] })
            status = r.status
            spawnErr = r.error?.message ?? null
          } finally { fs.closeSync(fd) }
        } catch (e) { spawnErr = e.message }
        if (status === 0) { try { fs.rmSync(errFile, { force: true }) } catch { /* 略 */ } ; continue }

        // **必须把"起不来"与"代码有语法错"分开**：前者是环境问题（结论不可用），后者才是产物的问题。
        // 混在一起会把"没跑成"报成"这个文件坏了"，那是假红——比漏报更坏。
        if (status === null) {
          environmentFailures.push(`${entry} — 无法执行语法检查（${spawnErr ?? '子进程未启动'}）`)
          continue
        }
        let detail
        try {
          const raw = fs.readFileSync(errFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l !== '')
          const kind = raw.find((l) => /^(SyntaxError|ReferenceError|TypeError|Error)/.test(l)) ?? raw[0] ?? `解析失败（status=${status}）`
          const at = raw.find((l) => /:\d+\s*$/.test(l)) ?? ''
          detail = at === '' ? kind : `${kind} @ ${at}`
        } catch { detail = `解析失败（status=${status}）` }
        broken.push(`${entry} — ${detail}`)
      }
      ok(`${rel} 里每个源码文件都能被解析（等价于模块加载期）`, broken.length === 0,
        broken.length === 0 ? `${srcEntries.length} 个全部通过` : broken.slice(0, 4).join(' | '))
      if (environmentFailures.length > 0) {
        // 环境问题**不判失败**，但必须显式说出来：否则"没跑成"会被读成"查过了、是好的"。
        //
        // **但有一条硬底线**：如果一个文件都没能真正检查过，整条判据就是**空转**——
        // 这时候报 ALL PASS 是假绿（本脚本第一版就因为 `spawnSync` 没 import 而"全过"，
        // 恰好放过了本来要拦的那个坏包）。空转必须判失败。
        const checked = srcEntries.length - environmentFailures.length
        ok(`${rel} 至少真正检查过一个文件（防止判据空转成假绿）`, checked > 0,
          `实际检查 ${checked}/${srcEntries.length}；未能检查的原因：${environmentFailures[0]}`)
        console.log(`  NOTE  ${environmentFailures.length}/${srcEntries.length} 个文件因**环境**未能检查（非产物问题）：${environmentFailures[0]}`)
      }
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }

  console.log(fail === 0 ? '\nPACKAGED ASAR: ALL PASS' : `\nPACKAGED ASAR: ${fail} FAILED`)
  return fail
}

// ── electron-builder 的 `afterPack` 钩子 ──
// 挂在 `electron-builder.yml` 的 `afterPack` 上：**每产出一个包就立刻查它自己**。
// 参数是 electron-builder 的 context（含 `appOutDir`），不是命令行参数——所以这里只认钩子形态。
export default async function afterPack(context) {
  const appOutDir = context?.appOutDir
  if (typeof appOutDir !== 'string' || appOutDir === '') {
    console.error(`  FAIL  afterPack 没拿到 appOutDir（context=${JSON.stringify(Object.keys(context ?? {}))}）`)
    throw new Error('afterPack：缺少 appOutDir')
  }
  const cnt = await checkPackagedAsar([appOutDir])
  if (cnt !== 0) throw new Error(`打包产物里有无法解析的源码（${cnt} 项）—— 这个包装上也起不来，拒绝产出`)
}

// ── CLI 入口：只有"被 node 直接执行"时才跑（被 afterPack import 时不跑）──
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const targets = resolveTargets(process.argv.slice(2))
  if (targets.length === 0) {
    console.log('  NOTE  没找到任何 app.asar（还没打包？）—— 本检查在打包后才有意义')
    console.log('\nPACKAGED ASAR: ALL PASS')
    process.exit(0)
  }
  const cnt = await checkPackagedAsar(targets)
  process.exit(cnt === 0 ? 0 : 1)
}
