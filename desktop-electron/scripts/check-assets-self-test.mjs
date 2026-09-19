// check-assets-self-test.mjs — check-assets.mjs 的回归单测（纯 Node、脱网、秒级）。
// 手法：临时改写真实 vendor/vendor.lock.json 的 platform 段再还原，只改 platform 一个字段。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
let fail = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!cond) fail++ }

const LOCK = path.join(ROOT, 'vendor', 'vendor.lock.json')
const SCRIPT = path.join(ROOT, 'scripts', 'check-assets.mjs')

// 补齐 check-assets 需要的生成物（图标被 .gitignore 挡着，干净 checkout / CI 里没有），跑完再删。
// 只补缺的那些，返回本次由本函数创建的文件。判据本身不许依赖"本机跑过 npm run icons"。
function ensureGeneratedAssets() {
  const created = []
  const put = (rel, content) => {
    const abs = path.join(ROOT, 'build', rel)
    if (fs.existsSync(abs)) return
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
    created.push(rel)
  }
  // check-assets 只看"存在且非 0 字节"，icons/ 只看有没有 512/1024 档的 png 名
  put('icons/512x512.png', 'fixture')
  put('icon.png', 'fixture')
  return created
}

// 跑一次 check-assets 收集输出。不能用管道 stdio（受限会话下建匿名管道会被拒，stdout 为空），
// 故子进程输出重定向到临时文件再读。
function runCheckAssets(env = {}) {
  const logFile = path.join(os.tmpdir(), `dsh-assets-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.log`)
  let fd = 'ignore'
  try { fd = fs.openSync(logFile, 'w') } catch { fd = 'ignore' }
  let r
  try {
    r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, stdio: ['ignore', fd, fd], env: { ...process.env, ...env } })
  } finally {
    if (fd !== 'ignore') { try { fs.closeSync(fd) } catch { /* 已关 */ } }
  }
  let out = ''
  try { out = fs.readFileSync(logFile, 'utf8') } catch { out = '' }
  try { fs.rmSync(logFile, { force: true }) } catch { /* 略 */ }
  return { status: r?.status ?? null, out, error: r?.error?.message }
}

console.log('[基线：真实 lock + 显式声明目标 = 树自己的平台]')
const fixtures = ensureGeneratedAssets()
if (fixtures.length > 0) console.log(`  NOTE  补齐了缺失的生成物夹具：${fixtures.join(', ')}（跑完删除）`)
try {
  // 入库的 lock 是 win32-x64 树的身份证明，基线必须"声明目标 = 树自己的平台"，否则非 Windows CI 变红
  const lockOsForBaseline = (() => { try { return JSON.parse(fs.readFileSync(LOCK, 'utf8')).platform?.os ?? process.platform } catch { return process.platform } })()
  const baseline = runCheckAssets({ DSH_PACK_PLATFORM: lockOsForBaseline })
  ok('声明"目标 = 树自己的平台"时通过', baseline.status === 0, `exit=${baseline.status} ${baseline.error ?? ''}`)
  ok('输出里报告了 vendor 平台已核对', /vendor 平台已核对/.test(baseline.out))

  if (!fs.existsSync(LOCK)) {
    console.log('  NOTE  没有 vendor/vendor.lock.json，跳过平台核对相关断言（先跑 build:host）')
  } else {
    const original = fs.readFileSync(LOCK, 'utf8')
    try {
      const lock = JSON.parse(original)
      // 一律用 DSH_PACK_PLATFORM 显式声明目标：默认 = 本机平台会让非 Windows CI 天生不成立。
      // 判据本身无关宿主，只是要喂给它一个明确的目标平台。
      const lockOs = lock.platform?.os ?? process.platform
      const otherOs = lockOs === 'linux' ? 'win32' : 'linux'

      console.log('[vendor 平台与打包目标不符 → 必须挡住打包]')
      // 改的只有 platform.os/tag
      fs.writeFileSync(LOCK, JSON.stringify({ ...lock, platform: { ...lock.platform, os: otherOs, tag: `${otherOs}-${lock.platform?.arch ?? 'x64'}` } }, null, 2))
      const mismatched = runCheckAssets({ DSH_PACK_PLATFORM: lockOs })
      ok('树与目标不符时判失败', mismatched.status === 1, `exit=${mismatched.status}`)
      ok('失败信息点名了树的平台与打包目标',
        /vendor 树是给/.test(mismatched.out) && mismatched.out.includes(otherOs),
        mismatched.out.split('\n').find((l) => l.includes('vendor 树是给')) ?? '(无)')

      // 反过来：声明"我就是要打这个平台的包"时应通过，证明判据比的是"树 vs 目标"而非"树 vs 宿主"
      const declared = runCheckAssets({ DSH_PACK_PLATFORM: otherOs })
      ok('DSH_PACK_PLATFORM 声明目标后通过（交叉打包不被误挡）', declared.status === 0, `exit=${declared.status}`)

      console.log('[lock 缺 platform 段（旧格式）→ 必须判失败]')
      const noPlatform = { ...lock }
      delete noPlatform.platform
      fs.writeFileSync(LOCK, JSON.stringify(noPlatform, null, 2))
      const oldFormat = runCheckAssets({ DSH_PACK_PLATFORM: lockOs })
      ok('lock 无 platform 段时判失败并说明是旧格式',
        oldFormat.status === 1 && /旧格式/.test(oldFormat.out), `exit=${oldFormat.status}`)

      console.log('[lock 内容损坏 → 判失败但不抛异常]')
      fs.writeFileSync(LOCK, '{ this is not json')
      const broken = runCheckAssets({ DSH_PACK_PLATFORM: lockOs })
      ok('lock 解析失败时判失败而不是崩', broken.status === 1 && /解析失败/.test(broken.out), `exit=${broken.status}`)
    } finally {
      // 无论上面哪条断言炸了都要还原：这个文件是现网树的身份证明
      fs.writeFileSync(LOCK, original)
    }
    const restored = JSON.parse(fs.readFileSync(LOCK, 'utf8'))
    ok('lock 已还原（platform 段与实验前一致）', JSON.stringify(restored.platform) === JSON.stringify(JSON.parse(original).platform))
    ok('还原后重新通过', runCheckAssets({ DSH_PACK_PLATFORM: restored.platform?.os ?? process.platform }).status === 0)
  }
} finally {
  // 只删本函数建的夹具（真实产物一个都不碰）；顺带清掉可能建出来的空目录
  for (const rel of fixtures) { try { fs.rmSync(path.join(ROOT, 'build', rel), { force: true }) } catch { /* 略 */ } }
  try { fs.rmdirSync(path.join(ROOT, 'build', 'icons')) } catch { /* 目录里还有真实产物就不动它 */ }
}

console.log(fail === 0 ? '\nCHECK ASSETS SELF TEST: ALL PASS' : `\nCHECK ASSETS SELF TEST: ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
