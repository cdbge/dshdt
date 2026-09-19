// ci-shell-syntax-self-test.mjs — CI shell 脚本的语法门禁（脱网，秒级）：
// ① 引号/反引号配平的启发式扫描（本地任何平台都能跑）；② bash -n 真语法检查（没有 bash 就如实标注跳过，不谎报通过）。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let fail = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!cond) fail++ }

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// 递归收集 .sh（跳过 node_modules / dist / vendor）
function collectSh(dir, out = []) {
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === 'vendor' || e.name.startsWith('.')) continue
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) collectSh(abs, out)
    else if (e.isFile() && e.name.endsWith('.sh')) out.push(abs)
  }
  return out
}

const scripts = collectSh(path.join(ROOT, 'scripts')).sort()
ok('找得到 shell 脚本（ci-run.sh 等）', scripts.length > 0, `${scripts.length} 个：${scripts.map((p) => path.relative(ROOT, p)).join(', ')}`)

console.log('[配平扫描]')
{
  // 返回该行的 {dq, bt, open}：双引号数、反引号数、行尾是否停在未闭合引号里
  const scan = (l) => {
    let inQ = null
    let dq = 0
    let bt = 0
    for (let i = 0; i < l.length; i++) {
      const c = l[i]
      if (inQ === "'") { if (c === "'") inQ = null; continue }
      if (c === '\\') { i++; continue } // 转义：下一个字符是字面量
      if (inQ === '"') {
        if (c === '"') { inQ = null; dq++ } else if (c === '`') bt++
        continue
      }
      if (c === "'") { inQ = "'"; continue }
      if (c === '"') { inQ = '"'; dq++; continue }
      if (c === '`') { bt++; continue }
      if (c === '#') break // 行内注释：后面的内容不参与语法
    }
    return { dq, bt, open: inQ }
  }
  const bad = []
  for (const f of scripts) {
    const rel = path.relative(ROOT, f)
    const lines = fs.readFileSync(f, 'utf8').split('\n')
    lines.forEach((l, i) => {
      const r = scan(l)
      if (r.dq % 2 !== 0 || r.bt % 2 !== 0 || r.open !== null) {
        bad.push(`${rel}:${i + 1} 双引号=${r.dq} 反引号=${r.bt} 行尾未闭合=${r.open ?? '-'} | ${l.trim().slice(0, 90)}`)
      }
    })
  }
  ok('所有 shell 脚本的引号/反引号都配平（本次 v1.0.0 发布翻车的正是这条）', bad.length === 0, bad.slice(0, 3).join(' ;; '))
}

console.log('[bash -n 真语法检查]')
{
  const probe = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' })
  const hasBash = probe.status === 0 && String(probe.stdout).includes('ok')
  if (!hasBash) {
    // 不判失败但必须说出来：静默跳过会被读成"检查过了、是好的"
    console.log('  NOTE  本机没有可用的 bash（受限沙箱/未装 Git Bash）⇒ 只跑了配平扫描；CI 两平台会跑 bash -n')
    ok('本机没有 bash 时如实标注（不谎报通过）', true, 'skipped')
  } else {
    const broken = []
    for (const f of scripts) {
      const r = spawnSync('bash', ['-n', f], { encoding: 'utf8' })
      if (r.status !== 0) broken.push(`${path.relative(ROOT, f)}：${String(r.stderr).trim().split('\n').slice(-1)[0]}`)
    }
    ok('所有 shell 脚本都通过 bash -n', broken.length === 0, broken.slice(0, 3).join(' ;; '))
  }
}

console.log(fail === 0 ? '\nCI SHELL SYNTAX SELF TEST: ALL PASS' : `\nCI SHELL SYNTAX SELF TEST: ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
