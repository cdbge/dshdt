// junction-safe-self-test.mjs — junction 安全删除的离线单测（纯 Node，不联网、不碰仓库外的东西）。
// 核心断言：删掉含 junction 的目录后，junction 指向的目标必须完好无损。
import {
  BOOTGATE_PREFIX,
  cleanStaleBootGateHomes,
  listStaleBootGateHomes,
  safeRemoveTree,
} from '../src/junction-safe.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let fail = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!cond) fail++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'junction-safe-test-'))
const write = (p, c = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c) }
const count = (d) => { let n = 0; (function w(x) { let es = []; try { es = fs.readdirSync(x, { withFileTypes: true }) } catch { return } for (const e of es) { const q = path.join(x, e.name); if (e.isDirectory()) w(q); else n++ } })(d); return n }

console.log('[safeRemoveTree 不跟随 junction]')
const target = path.join(tmp, 'vendor-target')
write(path.join(target, 'pkg-a', 'package.json'), '{"name":"pkg-a"}')
write(path.join(target, 'pkg-a', 'lib', 'bin.js'), '// bin')
write(path.join(target, 'pkg-b', 'package.json'), '{"name":"pkg-b"}')
const before = count(target)

const victim = path.join(tmp, 'home', 'profiles', 'node_modules')
fs.mkdirSync(victim, { recursive: true })
fs.symlinkSync(target, path.join(victim, 'linked-pkg'), 'junction')
// 再加一个嵌套层级的 junction（@scope/pkg 形态）
const scopeTarget = path.join(target, 'pkg-a')
fs.symlinkSync(scopeTarget, path.join(victim, 'scoped'), 'junction')
write(path.join(victim, 'plain.txt'), 'own file')

ok('夹具就位（目标 3 文件）', before === 3, String(before))
const res = safeRemoveTree(path.join(tmp, 'home'))
ok('删除返回 removed=true', res.removed === true)
ok('解开了 2 个 junction', res.unlinked === 2, String(res.unlinked))
ok('宿主目录已消失', !fs.existsSync(path.join(tmp, 'home')))
ok('**目标树完好无损**', fs.existsSync(target) && count(target) === before, `目标文件数=${count(target)}（应为 ${before}）`)
ok('目标里的 bin.js 还在', fs.existsSync(path.join(target, 'pkg-a', 'lib', 'bin.js')))
ok('目标 package.json 还在', fs.existsSync(path.join(target, 'pkg-a', 'package.json')))
ok('干净删除时 leftovers=0（没清干净必须能看出来）', res.leftovers === 0, String(res.leftovers))

console.log('[safeRemoveTree 目录型链接]')
const linkTarget = path.join(tmp, 'link-target')
write(path.join(linkTarget, 'inner', 'keep.txt'), 'keep')
const linkHome = path.join(tmp, 'link-home')
fs.mkdirSync(linkHome, { recursive: true })
let dirLinkKind = 'none'
try { fs.symlinkSync(linkTarget, path.join(linkHome, 'dir-link'), 'dir'); dirLinkKind = 'dir' } catch {
  try { fs.symlinkSync(linkTarget, path.join(linkHome, 'dir-link'), 'junction'); dirLinkKind = 'junction' } catch { dirLinkKind = 'unsupported' }
}
if (dirLinkKind === 'none' || dirLinkKind === 'unsupported') {
  ok('目录型链接在本平台可用（否则跳过）', true, `kind=${dirLinkKind}`)
} else {
  const linkRes = safeRemoveTree(linkHome)
  ok(`目录型链接（${dirLinkKind}）被删除且只删链接`, !fs.existsSync(linkHome) && linkRes.unlinked === 1, `unlinked=${linkRes.unlinked}`)
  ok('**链接目标未被触及**', fs.existsSync(path.join(linkTarget, 'inner', 'keep.txt')))
}

console.log('[safeRemoveTree 常规删除]')
const plain = path.join(tmp, 'plain-tree')
write(path.join(plain, 'a', 'b', 'c.txt'))
write(path.join(plain, 'a', 'd.txt'))
safeRemoveTree(plain)
ok('普通目录树被完整删除', !fs.existsSync(plain))
ok('不存在的路径返回 not-found', safeRemoveTree(path.join(tmp, 'nope')).reason === 'not-found')
const oneFile = path.join(tmp, 'single.txt'); write(oneFile)
safeRemoveTree(oneFile)
ok('单文件也可删', !fs.existsSync(oneFile))

console.log('[listStaleBootGateHomes]')
const fakeTmp = path.join(tmp, 'fake-tmp')
const oldDir = path.join(fakeTmp, `${BOOTGATE_PREFIX}old`)
const newDir = path.join(fakeTmp, `${BOOTGATE_PREFIX}new`)
const otherDir = path.join(fakeTmp, 'something-else')
write(path.join(oldDir, 'host.log'))
write(path.join(newDir, 'host.log'))
write(path.join(otherDir, 'x.txt'))

// minAgeMs=0 + 默认 now：刚建好的目录也必须收得到
/** 失败时打印函数看见了什么（readdir 条目 + 时间戳判据）。 */
const dirDiag = () => {
  try {
    return fs.readdirSync(fakeTmp).map((n) => {
      const s = fs.lstatSync(path.join(fakeTmp, n))
      return `${n}{dir=${s.isDirectory()},link=${s.isSymbolicLink()},born=${Math.round(s.birthtimeMs)},mtime=${Math.round(s.mtimeMs)}}`
    }).join(' ')
  } catch (e) { return `readdir 失败：${e.code ?? e.message}` }
}
const all = listStaleBootGateHomes({ tmpDir: fakeTmp, minAgeMs: 0, now: Date.now() })
ok('只收门禁前缀目录（忽略无关目录）', all.length === 2 && !all.some((p) => p.endsWith('something-else')),
  `all=${JSON.stringify(all.map((p) => path.basename(p)))} prefix="${BOOTGATE_PREFIX}" now=${Date.now()} ${dirDiag()}`)
ok('minAgeMs=1h 时两个都太新，全跳过', listStaleBootGateHomes({ tmpDir: fakeTmp, minAgeMs: 60 * 60 * 1000 }).length === 0)
// 时钟粒度护栏：POSIX 上 btime 可能比 Date.now() 大几毫秒，负年龄必须按 0 处理
// （否则刚建好的目录一个都收不到）；但默认阈值下仍不当作遗留，避免误删正在跑的门禁。
const skewNow = Date.now() - 30
ok('born 比 now 大几毫秒也收得到（minAgeMs=0）', listStaleBootGateHomes({ tmpDir: fakeTmp, minAgeMs: 0, now: skewNow }).length === 2,
  `现在收上来 ${listStaleBootGateHomes({ tmpDir: fakeTmp, minAgeMs: 0, now: skewNow }).length} 个（应为 2）`)
ok('但负年龄仍不当作遗留（默认阈值下保守跳过，绝不误删可能正在跑的门禁）',
  listStaleBootGateHomes({ tmpDir: fakeTmp, minAgeMs: 60 * 1000, now: skewNow }).length === 0,
  `现在收上来 ${listStaleBootGateHomes({ tmpDir: fakeTmp, minAgeMs: 60 * 1000, now: skewNow }).length} 个（应为 0）`)
ok('不存在的 tmpDir 返回空数组', listStaleBootGateHomes({ tmpDir: path.join(tmp, 'no-such') }).length === 0)

console.log('[cleanStaleBootGateHomes]')
// 在遗留目录里放一个指向"被测树"的 junction，验证清理不会掏空它
const payloadTarget = path.join(tmp, 'payload-vendor')
write(path.join(payloadTarget, 'pkg', 'package.json'), '{"name":"pkg"}')
fs.symlinkSync(payloadTarget, path.join(oldDir, 'profiles-link'), 'junction')

const logs = []
const r = cleanStaleBootGateHomes({ tmpDir: fakeTmp, minAgeMs: 0, now: Date.now(), log: (m) => logs.push(m) })
ok('清理了 2 个遗留目录', r.cleaned === 2, String(r.cleaned))
ok('解开 1 个 junction', r.unlinked === 1, String(r.unlinked))
ok('遗留目录已删除', !fs.existsSync(oldDir))
ok('**被测树未被掏空**', fs.existsSync(path.join(payloadTarget, 'pkg', 'package.json')), `目标文件数=${count(payloadTarget)}`)
ok('留了日志', logs.some((m) => m.includes('未进入其目标')), logs[0] ?? '（无日志）')

fs.rmSync(tmp, { recursive: true, force: true })
console.log(fail === 0 ? '\nJUNCTION SAFE SELF TEST: ALL PASS' : `\nJUNCTION SAFE SELF TEST: ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
