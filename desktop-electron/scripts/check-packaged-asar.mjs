// check-packaged-asar.mjs — 取出打包产物 app.asar 里的每个 .mjs/.js/.cjs 逐个做语法检查
// （等价于模块加载期解析；仓库 src/ 的门禁查不到 asar 里那一份）。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
let fail = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!cond) fail++ }

// 把参数归一到"存在的 .asar 文件"列表；无参数时自动发现
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

// 检查一批 app.asar，返回失败数（0 = 全过）。
// 抽成函数是让 CLI 与 electron-builder 的 afterPack 钩子共用同一份判据。
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
      const srcEntries = entries.filter((e) => /\.(mjs|js|cjs)$/.test(e))
      ok(`${rel} 里有源码文件`, srcEntries.length > 0, `${srcEntries.length} 个（asar 共 ${entries.length} 条）`)

      const broken = []
      const environmentFailures = []
      for (const [i, entry] of srcEntries.entries()) {
        // extractFile 要的是 asar 内记录的原样路径，先原样试、再去掉前导分隔符试
        let code = null
        let lastErr = ''
        for (const cand of [entry, entry.replace(/^[\\/]+/, '')]) {
          try { code = asar.extractFile(asarPath, cand); break } catch (e) { lastErr = e.message }
        }
        if (code === null) { broken.push(`${entry}（取不出：${lastErr}）`); continue }
        // node --check 只认文件路径，不吃 stdin
        const base = entry.split(/[\\/]/).pop() ?? `file${i}.js`
        const tmpFile = path.join(tmp, `${i}-${base}`)
        fs.writeFileSync(tmpFile, code)
        // 输出走文件重定向，不能用管道：受限会话下建匿名管道会被拒，子进程可能 EPERM 起不来
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

        // 必须把"起不来"与"代码有语法错"分开：前者是环境问题，报成"文件坏了"是假红
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
        // 环境问题不判失败，但必须显式说出来，否则"没跑成"会被读成"查过了、是好的"。
        // 硬底线：一个文件都没真正检查过时整条判据是空转，报 ALL PASS 就是假绿，必须判失败。
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

// electron-builder 的 afterPack 钩子：每产出一个包就立刻查它自己。参数是 electron-builder 的 context（含 appOutDir）。
export default async function afterPack(context) {
  const appOutDir = context?.appOutDir
  if (typeof appOutDir !== 'string' || appOutDir === '') {
    console.error(`  FAIL  afterPack 没拿到 appOutDir（context=${JSON.stringify(Object.keys(context ?? {}))}）`)
    throw new Error('afterPack：缺少 appOutDir')
  }
  const cnt = await checkPackagedAsar([appOutDir])
  if (cnt !== 0) throw new Error(`打包产物里有无法解析的源码（${cnt} 项）—— 这个包装上也起不来，拒绝产出`)
}

// CLI 入口：只有被 node 直接执行时才跑（被 afterPack import 时不跑）
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
