// update-self-test.mjs — DSH 更新引擎离线单测（纯 Node，不依赖 Electron、不联网、不写仓库）
//
// 为什么必须离线：版本比较与 registry 解析是本功能里最容易出错的部分，而且出错时是**静默**的
// （判错方向 = 永远提示"已是最新"，没有任何报错）。所以断言全部用注入的 fetchImpl 与临时目录，
// 绝不依赖真实网络——否则 CI/断网环境会给出假绿。
import {
  DEFAULT_REGISTRY,
  UPDATE_PACKAGES,
  assessJump,
  compareVersions,
  pickHighestVersion,
  parseVersion,
  readCurrentVersions,
  fetchPackument,
  checkForUpdate,
} from '../src/dsh-update.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let fail = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!cond) fail++ }

// ---------- 1) parseVersion ----------
console.log('[parseVersion]')
const p1 = parseVersion('0.1.0-rc.8')
ok('合法 prerelease 解析', p1 && p1.major === 0 && p1.minor === 1 && p1.patch === 0 && p1.pre.join('.') === 'rc.8', JSON.stringify(p1))
ok('正式版 pre 为空数组', (parseVersion('1.2.3')?.pre ?? null)?.length === 0)
ok('build 元数据被忽略', parseVersion('1.2.3+build.7')?.patch === 3)
ok('非法串返回 null', parseVersion('not-a-version') === null && parseVersion('1.2') === null && parseVersion(undefined) === null)

// ---------- 2) compareVersions（本模块存在的核心理由） ----------
console.log('[compareVersions]')
ok('rc.9 > rc.8（字符串比较会判反）', compareVersions('0.1.0-rc.9', '0.1.0-rc.8') === 1)
ok('rc.10 > rc.9（数值段，字符串比较会判反）', compareVersions('0.1.0-rc.10', '0.1.0-rc.9') === 1)
ok('正式版 > 同号预发布版', compareVersions('0.1.0', '0.1.0-rc.9') === 1)
ok('主次修订优先于 prerelease', compareVersions('0.2.0-rc.1', '0.1.0') === 1)
ok('相等返回 0', compareVersions('0.1.0-rc.8', '0.1.0-rc.8') === 0)
ok('数字标识符低于非数字', compareVersions('0.1.0-1', '0.1.0-alpha') === -1)
let threw = false
try { compareVersions('bogus', '0.1.0') } catch { threw = true }
ok('非法入参抛错（不静默）', threw)

// ---------- 3) pickHighestVersion ----------
console.log('[pickHighestVersion]')
const pool = ['0.1.0-rc.8', '0.1.0-rc.9', '0.1.0-rc.10', 'garbage', '0.1.0']
ok('取全量最高（含 prerelease）', pickHighestVersion(pool) === '0.1.0', String(pickHighestVersion(pool)))
ok('跳过非法项', pickHighestVersion(['x', 'y', '0.1.0-rc.8']) === '0.1.0-rc.8')
ok('includePrerelease=false 只取正式版', pickHighestVersion(['0.1.0-rc.10', '0.1.0-rc.9'], { includePrerelease: false }) === null)
ok('空集返回 null', pickHighestVersion([]) === null && pickHighestVersion(['bad']) === null)

// ---------- 4) readCurrentVersions（临时目录夹具） ----------
// 夹具版本取真实的现网锁定值（0.1.0-rc.8），不要用 9.9.9 之类——过高的假版本会让后续
// "是否有更新"的断言恒为 false，从而把脚本 bug 伪装成产品缺陷（规范的教训）。
console.log('[readCurrentVersions]')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-update-test-'))
const INSTALLED = '0.1.0-rc.8'
const writeProfile = (dir, version) => {
  for (const name of UPDATE_PACKAGES) {
    const d = path.join(dir, 'node_modules', ...name.split('/'))
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name, version }))
  }
}
const profile = path.join(tmp, 'profile')
writeProfile(profile, INSTALLED)
const cur = readCurrentVersions(profile)
ok('读到全部包版本', UPDATE_PACKAGES.every((n) => cur[n] === INSTALLED), JSON.stringify(cur))
const curMissing = readCurrentVersions(path.join(tmp, 'nope'))
ok('树缺失记 null 而不抛', UPDATE_PACKAGES.every((n) => curMissing[n] === null))

// ---------- 5) fetchPackument（注入 fetchImpl，不联网） ----------
console.log('[fetchPackument]')
let seenUrl = ''
const fakeOk = (versions) => async (url) => { seenUrl = url; return { ok: true, status: 200, json: async () => ({ versions }) } }
const pk = await fetchPackument('@deepseek-ai/dsh', { fetchImpl: fakeOk({ '0.1.0-rc.8': {} }), registry: DEFAULT_REGISTRY })
ok('scope 包名百分号编码', seenUrl.startsWith(`${DEFAULT_REGISTRY}/@deepseek-ai%2fdsh`), seenUrl)
ok('packument 原样返回', pk.versions['0.1.0-rc.8'] !== undefined)
let netErr = null
try { await fetchPackument('@deepseek-ai/dsh', { fetchImpl: async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' }) }) } catch (e) { netErr = e }
ok('非 2xx 抛错', netErr !== null && netErr.message.includes('503'), netErr?.message)

// ---------- 6) checkForUpdate ----------
console.log('[checkForUpdate]')
const packFor = (v) => async () => ({ ok: true, status: 200, json: async () => ({ versions: { [v]: {} } }) })
// 每包给不同版本；dsh 本体决定 target
const fakeFetch = async (url) => {
  const name = decodeURIComponent(String(url).split('/').slice(3).join('/'))
  const v = name === '@deepseek-ai/dsh' ? '0.1.0-rc.10' : '0.1.0-rc.9'
  return { ok: true, status: 200, json: async () => ({ versions: { [v]: {}, '0.1.0-rc.8': {} } }) }
}
const up = await checkForUpdate({ profileDir: profile, fetchImpl: fakeFetch })
ok('成功路径 ok=true', up.ok === true)
ok('target 取 dsh 本体的最高版', up.target === '0.1.0-rc.10', String(up.target))
ok('registry 0.1.0-rc.10 > 安装 0.1.0-rc.8 判为有更新', up.hasUpdate === true)

const sameDir = path.join(tmp, 'profile-same')
writeProfile(sameDir, '0.1.0-rc.10')
const same = await checkForUpdate({ profileDir: sameDir, fetchImpl: fakeFetch })
ok('已是最新时 hasUpdate=false', same.ok === true && same.hasUpdate === false)

// 本地树比 registry 新（开发态：本地已在跑未发布的 rc）时不得提示"可更新"
const newerDir = path.join(tmp, 'profile-newer')
writeProfile(newerDir, '0.2.0')
const newer = await checkForUpdate({ profileDir: newerDir, fetchImpl: fakeFetch })
ok('本地比 registry 新时不提示更新', newer.ok === true && newer.hasUpdate === false)

let logged = ''
const offline = await checkForUpdate({ profileDir: profile, fetchImpl: async () => { throw new Error('ENOTFOUND') }, log: (m) => { logged = m } })
ok('查询失败收敛为 ok=false 而不抛', offline.ok === false && typeof offline.error === 'string')
ok('失败时保留 current 供 UI 显示', offline.current['@deepseek-ai/dsh'] === INSTALLED)
ok('失败逐层留痕（log 被调用）', logged.includes('registry 查询失败'), logged)
ok('不存在的版本候选不会误报', (await checkForUpdate({ profileDir: profile, fetchImpl: packFor('0.0.0-rc.1') })).hasUpdate === false)

// ---------- 7) assessJump（版本距离守卫，0.4.6 事故的直接产物） ----------
console.log('[assessJump]')
// 事故原形：0.1.0-rc.8 → 0.1.5-rc.2。**差的不是 minor 而是 patch（0→5）**——
// 第一版守卫只比 major/minor，于是把它判成"安全"，等于完全没挡住事故。单测逼出来的修正。
const jumpIncident = assessJump('0.1.0-rc.8', '0.1.5-rc.2')
ok('事故原形判为不安全（修订位变更）', jumpIncident.safe === false)
ok('理由里指明是修订位变更', jumpIncident.reason.includes('修订 0→5'), jumpIncident.reason)
ok('跨主版本判为不安全', assessJump('0.1.0-rc.8', '1.0.0').safe === false)
ok('跨次版本判为不安全', assessJump('0.1.0', '0.2.0').safe === false)
ok('仅预发布号变化放行（rc.8 → rc.10）', assessJump('0.1.0-rc.8', '0.1.0-rc.10').safe === true)
ok('同版本放行', assessJump('0.1.0-rc.8', '0.1.0-rc.8').safe === true)
ok('版本串非法时判为不安全而非抛', assessJump('bogus', '0.1.0').safe === false && assessJump('0.1.0', 'x').safe === false)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(fail === 0 ? '\nUPDATE SELF TEST: ALL PASS' : `\nUPDATE SELF TEST: ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
