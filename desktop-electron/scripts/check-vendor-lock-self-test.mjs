// check-vendor-lock-self-test.mjs — check-vendor-lock.mjs 的单测（纯 Node、脱网、秒级）。
// 正/负向都用真实 vendor/ 组合驱动，负向靠临时改写真实锁再还原。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'scripts', 'check-vendor-lock.mjs')
const LOCK = path.join(ROOT, 'vendor', 'package-lock.json')
let fail = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!cond) fail++ }

// 跑一次判据收集输出（stdio 走文件：受限会话下管道会被拒）
function run(args = []) {
  const log = path.join(os.tmpdir(), `dsh-lockst-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.log`)
  const fd = fs.openSync(log, 'w')
  let r
  try {
    r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, stdio: ['ignore', fd, fd] })
  } finally { fs.closeSync(fd) }
  const out = fs.readFileSync(log, 'utf8')
  fs.rmSync(log, { force: true })
  return { status: r?.status ?? null, out }
}

console.log('[脱网模式 · 正向]')
const pass = run()
ok('真实的锁 + manifest 通过', pass.status === 0, `status=${pass.status}`)
ok('报告了直接依赖与锁定版本（版本号从 manifest 现读，不写死）',
  (() => {
    // 版本号从 manifest 现读，不写死：判据守的是"输出了依赖名 + 锁定版本"，不是某个具体版本号
    const decl = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor', 'profile', 'package.json'), 'utf8'))
    const v = decl.dependencies['@deepseek-ai/dsh']
    return new RegExp(`@deepseek-ai/dsh — ${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(pass.out)
  })())
ok('提示了 strict 才是完整判据', /--strict/.test(pass.out))

if (!fs.existsSync(LOCK)) {
  console.log('  NOTE  没有 vendor/package-lock.json，跳过负向断言')
} else {
  const original = fs.readFileSync(LOCK, 'utf8')
  try {
    console.log('[脱网模式 · 负向：直接依赖对不上时必须拦住]')
    // ① 锁里删掉一个直接依赖
    const l1 = JSON.parse(original)
    delete l1.packages['node_modules/@deepseek-ai/dsh']
    fs.writeFileSync(LOCK, JSON.stringify(l1, null, 2))
    const r1 = run()
    ok('锁里缺直接依赖 → 判失败', r1.status === 1 && /锁里有 @deepseek-ai\/dsh/.test(r1.out), `status=${r1.status}`)

    // ② 锁定版本不满足 manifest 的范围（改成一个明显不合的版本）
    const l2 = JSON.parse(original)
    l2.packages['node_modules/@deepseek-ai/dsh'].version = '9.9.9'
    fs.writeFileSync(LOCK, JSON.stringify(l2, null, 2))
    const r2 = run()
    ok('锁定版本不满足声明范围 → 判失败', r2.status === 1 && /满足声明/.test(r2.out), `status=${r2.status}`)

    // ③ lockfileVersion 不对
    const l3 = JSON.parse(original)
    l3.lockfileVersion = 2
    fs.writeFileSync(LOCK, JSON.stringify(l3, null, 2))
    const r3 = run()
    ok('lockfileVersion ≠ 3 → 判失败', r3.status === 1 && /lockfileVersion/.test(r3.out), `status=${r3.status}`)

    // ④ 锁损坏
    fs.writeFileSync(LOCK, '{ 这不是 json')
    const r4 = run()
    ok('锁损坏 → 判失败且不崩', r4.status === 1, `status=${r4.status}`)
  } finally {
    fs.writeFileSync(LOCK, original)
  }
  ok('锁已还原（逐字节）', fs.readFileSync(LOCK, 'utf8') === original)
  ok('还原后重新通过', run().status === 0)
}

console.log(fail === 0 ? '\nVENDOR LOCK SELF TEST: ALL PASS' : `\nVENDOR LOCK SELF TEST: ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
