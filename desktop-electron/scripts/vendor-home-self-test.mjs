// vendor-home-self-test.mjs — vendor 树归属与种子迁移的离线单测（纯 Node、脱网）：
// 归属解析（Windows 用包内，Linux 用用户数据目录）、种子迁移一次且绝不覆盖用户已换的树、可用性判定边界。
import { VENDOR_DIR_NAME, dirStats, inspectVendorHome, resolveVendorHome, seedVendorHome } from '../src/vendor-home.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let fail = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!cond) fail++ }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vendor-home-'))
const write = (p, c = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c) }

// 造一棵"看起来可用"的 vendor 树（有 profile/lock/bin）
const makeVendor = (dir, marker = 'v1') => {
  write(path.join(dir, 'profile', 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', marker }))
  write(path.join(dir, 'profile', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '// bin')
  write(path.join(dir, 'vendor.lock.json'), JSON.stringify({ nodeModulesFiles: 3, totalFiles: 3, platform: { tag: 'linux-x64' } }))
  return dir
}

console.log('[resolveVendorHome]')
const appData = path.join(tmp, 'appdata')
const packaged = makeVendor(path.join(tmp, 'app', 'resources', 'vendor'))
const win = resolveVendorHome({ appData, packagedVendor: packaged, platform: 'win32' })
ok('Windows：仍用包内 resources/vendor（不改既有行为）', win.dir === packaged && win.source === 'packaged', JSON.stringify(win))
ok('Windows：不需要种子迁移', win.needsSeed === false)

const lin = resolveVendorHome({ appData, packagedVendor: packaged, platform: 'linux' })
ok('Linux：用用户数据目录下的 vendor', lin.dir === path.join(appData, VENDOR_DIR_NAME) && lin.source === 'userData', JSON.stringify(lin))
ok('Linux：目标不存在 ⇒ needsSeed=true', lin.needsSeed === true)
ok('种子指向包内那份', lin.seedDir === packaged)
ok('开发态可显式要求 packaged 模式', resolveVendorHome({ appData, packagedVendor: packaged, platform: 'linux', mode: 'packaged' }).source === 'packaged')

console.log('[seedVendorHome]')
const home = { dir: lin.dir, seedDir: packaged }
const first = seedVendorHome(home)
ok('首次拷贝成功', first.seeded === true, JSON.stringify(first))
ok('拷贝后目标可用', inspectVendorHome(lin.dir).usable === true)
ok('拷贝带统计（文件数/字节）', first.files > 0 && first.bytes > 0, `files=${first.files} bytes=${first.bytes}`)
ok('种子里的 bin.js 到位', fs.existsSync(path.join(lin.dir, 'profile', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')))

const second = seedVendorHome(home)
ok('目标已存在时不动它（幂等）', second.seeded === false && second.reason === 'already-present', JSON.stringify(second))

// 关键回归：用户已经换过的树不能被种子覆盖（否则等于把用户的更新回退）
write(path.join(lin.dir, 'USERS_UPGRADED_MARKER'), 'user changed this tree')
seedVendorHome(home)
ok('**回归**：用户换过的树不被种子覆盖', fs.existsSync(path.join(lin.dir, 'USERS_UPGRADED_MARKER')))

// 种子不存在时如实报告（而不是抛）
const missingSeed = seedVendorHome({ dir: path.join(tmp, 'nope', 'vendor'), seedDir: path.join(tmp, 'no-seed') })
ok('种子缺失时返回 seed-missing（不抛）', missingSeed.seeded === false && missingSeed.reason === 'seed-missing', JSON.stringify(missingSeed))

// 拷贝结果不可用时必须拒绝落地，而不是留下一个空/残缺的 vendor：
// 所以只判"cpSync 没抛"会让"全或全无"落空。这里两种失败形态都测：种子是文件、种子目录缺入口。
const badSeed = path.join(tmp, 'bad-seed')
write(badSeed, 'i am a file')
const badRes = seedVendorHome({ dir: path.join(tmp, 'bad-target', 'vendor'), seedDir: badSeed })
ok('种子是文件时不落地目标目录（全或全无）',
  badRes.seeded === false && !fs.existsSync(path.join(tmp, 'bad-target', 'vendor')),
  JSON.stringify(badRes))
ok('失败会留下可读原因', typeof badRes.reason === 'string' && badRes.reason.length > 0, badRes.reason)

const emptySeed = path.join(tmp, 'empty-seed')
fs.mkdirSync(emptySeed, { recursive: true })  // 存在但没有 profile/lock/bin
const emptyRes = seedVendorHome({ dir: path.join(tmp, 'empty-target', 'vendor'), seedDir: emptySeed })
ok('种子目录不完整时同样拒绝落地（拷完必须校验）',
  emptyRes.seeded === false && !fs.existsSync(path.join(tmp, 'empty-target', 'vendor')),
  JSON.stringify(emptyRes))
ok('不完整的原因可读（seed-incomplete）', /seed-incomplete/.test(emptyRes.reason ?? ''), emptyRes.reason)

console.log('[inspectVendorHome]')
const good = makeVendor(path.join(tmp, 'good'))
ok('完整树判可用', inspectVendorHome(good).usable === true)

const noBin = makeVendor(path.join(tmp, 'no-bin'))
fs.rmSync(path.join(noBin, 'profile', 'node_modules'), { recursive: true, force: true })
const noBinRes = inspectVendorHome(noBin)
ok('缺 bin.js 判不可用（否则宿主 import 期就崩）', noBinRes.usable === false && noBinRes.hasBin === false, JSON.stringify(noBinRes))
ok('不可用时给出原因', /vendor 不完整/.test(noBinRes.reason ?? ''), noBinRes.reason)

const noLock = makeVendor(path.join(tmp, 'no-lock'))
fs.rmSync(path.join(noLock, 'vendor.lock.json'), { force: true })
ok('缺 lock 判不可用（依赖完整性基线也随之丢失）', inspectVendorHome(noLock).usable === false)

ok('目录不存在判不可用（不抛）', inspectVendorHome(path.join(tmp, 'nothing')).usable === false)

// 判据边界：内容层面（版本对不对、模块能不能加载）各有归属，不在这里管。
console.log('  NOTE  存在性判据的边界（lock 内容不合法仍判"存在"）')
const badLock = makeVendor(path.join(tmp, 'bad-lock'))
fs.writeFileSync(path.join(badLock, 'vendor.lock.json'), '{ 这不是合法 JSON')
ok('lock 内容损坏时仍判"存在"（内容校验归 vendor-baseline 管）',
  inspectVendorHome(badLock).hasLock === true,
  JSON.stringify(inspectVendorHome(badLock)))

console.log('[dirStats]')
const stats = dirStats(good)
ok('统计到全部文件', stats.files === 3, JSON.stringify(stats))
ok('不存在的目录返回 0', dirStats(path.join(tmp, 'nothing')).files === 0)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(fail === 0 ? '\nVENDOR HOME SELF TEST: ALL PASS' : `\nVENDOR HOME SELF TEST: ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
