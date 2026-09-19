// vendor-baseline-self-test.mjs — 依赖完整性基线判据的离线单测（纯 Node、脱网）
//
// 为什么必须单独守着这一段（2026-09-14 的真实缺陷）：
//   这段判据上线后**从来没有拦过任何东西** ——
//   ① 基线读取在模块求值时撞 TDZ（读了一个后面才声明的 const），ReferenceError 被 `catch` 吞掉 ⇒ 恒为 0；
//   ② 判据写成 `files < 0 || expect <= 0 || files >= expect * 0.98` ⇒ **基线缺失也被算作通过**。
//   两者叠加 = 假绿门禁。任何一条被改回去，这里的断言就要红。
import { SHORTFALL_RATIO, assessVendorIntegrity, countFiles, readVendorBaseline } from '../src/vendor-baseline.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let fail = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!cond) fail++ }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-baseline-test-'))

// ---------- 1) 基线读取：正常 / 缺字段 / 损坏 / 不存在 ----------
console.log('[readVendorBaseline]')
const writeLock = (dir, obj) => {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'vendor.lock.json'), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2))
}
const d1 = path.join(tmp, 'lock-a')
writeLock(d1, { nodeModulesFiles: 11175, totalFiles: 11177, platform: { os: 'linux', arch: 'x64', tag: 'linux-x64' }, dshVersions: { '@deepseek-ai/dsh': '0.1.5-rc.2' } })
const b1 = readVendorBaseline(d1)
ok('读 nodeModulesFiles 优先', b1.files === 11175, JSON.stringify(b1))
ok('带上平台标签（跨平台诊断要用）', b1.platform === 'linux-x64', String(b1.platform))
ok('带上锁定版本', b1.dshVersions?.['@deepseek-ai/dsh'] === '0.1.5-rc.2', JSON.stringify(b1.dshVersions))

const d2 = path.join(tmp, 'lock-b')
writeLock(d2, { totalFiles: 5000 }) // 旧 lock：没有 nodeModulesFiles
ok('旧 lock 退回 totalFiles', readVendorBaseline(d2).files === 5000, JSON.stringify(readVendorBaseline(d2)))

const d3 = path.join(tmp, 'lock-c')
writeLock(d3, { generatedAt: '2026-09-14' }) // 两个字段都没有
ok('字段全缺时 files=0（不是"通过"）', readVendorBaseline(d3).files === 0)

const d4 = path.join(tmp, 'lock-d')
writeLock(d4, '{ 这不是合法 JSON')
ok('内容损坏时 files=0（不抛）', readVendorBaseline(d4).files === 0)

ok('lock 文件不存在时 files=0（不抛）', readVendorBaseline(path.join(tmp, 'no-such-dir')).files === 0)
ok('平台段缺失时 platform=null', readVendorBaseline(d3).platform === null)

// ---------- 2) 判据三态：必须分开，不许合并 ----------
console.log('[assessVendorIntegrity]')
const missing = assessVendorIntegrity({ files: 11175, baseline: 0 })
ok('基线缺失 → missing-baseline，且**不算通过**', missing.status === 'missing-baseline' && missing.ok === false, JSON.stringify(missing))
ok('基线缺失是 warn（不阻断启动）', missing.level === 'warn')

const short = assessVendorIntegrity({ files: 4000, baseline: 11175 })
ok('文件数明显偏少 → short，且**要阻断**', short.status === 'short' && short.ok === false && short.level === 'critical', JSON.stringify(short))
ok('缺件文案给出可执行动作', /重装|白名单/.test(short.detail), short.detail)

const good = assessVendorIntegrity({ files: 11175, baseline: 11175 })
ok('齐备 → ok', good.status === 'ok' && good.ok === true, JSON.stringify(good))
ok('齐备文案含两个数（可核对）', good.detail.includes('11175'), good.detail)

const unreadable = assessVendorIntegrity({ files: -1, baseline: 11175 })
ok('数不出文件 → unreadable（不是通过）', unreadable.status === 'unreadable' && unreadable.ok === false, JSON.stringify(unreadable))

// 边界：恰好 98% 应通过，差一点点就应判缺件（阈值语义要钉住，避免"悄悄放宽"）
const atThreshold = assessVendorIntegrity({ files: Math.ceil(11175 * SHORTFALL_RATIO), baseline: 11175 })
ok(`恰好在 ${SHORTFALL_RATIO * 100}% 阈值上 → ok`, atThreshold.status === 'ok', `files=${Math.ceil(11175 * SHORTFALL_RATIO)} status=${atThreshold.status}`)
const justBelow = assessVendorIntegrity({ files: Math.floor(11175 * SHORTFALL_RATIO) - 1, baseline: 11175 })
ok('低于阈值 1 个文件 → short', justBelow.status === 'short', `files=${Math.floor(11175 * SHORTFALL_RATIO) - 1} status=${justBelow.status}`)

// 回归断言：旧写法把"基线缺失"当成通过，这里显式钉死"不许通过"
ok('**回归**：基线缺失不得被判为 ok（旧缺陷）', assessVendorIntegrity({ files: 1, baseline: 0 }).ok === false)

// ---------- 3) countFiles：只数文件、不跟随链接、目录不存在返回 0 ----------
console.log('[countFiles]')
const tree = path.join(tmp, 'tree')
fs.mkdirSync(path.join(tree, 'sub', 'deep'), { recursive: true })
fs.writeFileSync(path.join(tree, 'a.js'), 'x')
fs.writeFileSync(path.join(tree, 'sub', 'b.js'), 'x')
fs.writeFileSync(path.join(tree, 'sub', 'deep', 'c.js'), 'x')
ok('递归计数', countFiles(tree) === 3, String(countFiles(tree)))
ok('目录不存在返回 0（不抛）', countFiles(path.join(tmp, 'nope')) === 0)
if (process.platform === 'win32') {
  let linked = false
  try {
    fs.symlinkSync(path.join(tree, 'sub'), path.join(tree, 'link'), 'junction')
    linked = true
  } catch { linked = false }
  ok('不跟随链接（只数链接本身之外的真实文件）', !linked || countFiles(tree) === 3, `linked=${linked} count=${countFiles(tree)}`)
} else {
  ok('POSIX 上数文件数（本平台无 junction 语义）', countFiles(tree) === 3)
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(fail === 0 ? '\nVENDOR BASELINE SELF TEST: ALL PASS' : `\nVENDOR BASELINE SELF TEST: ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
