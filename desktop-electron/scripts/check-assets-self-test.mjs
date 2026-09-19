// check-assets-self-test.mjs — 打包前置资源检查的回归单测（纯 Node、脱网、秒级）
//
// 为什么值得单测：`check-assets.mjs` 是 `predist*` 钩子的判据，**它红的时候打包根本不会开始**。
// 它自己有缺陷的话，后果是"要么打包起不来、要么该挡的没挡住"，两种都离原因很远。
// 尤其是 2026-09-14 加的那条 **vendor 平台核对**：它挡的正是"能打包、装不上"这个陷阱
// （在 Windows 上产 Linux 包时忘了换 vendor，electron-builder 照样报成功）。
//
// 手法：不重造仓库，而是**临时改写真实 `vendor/vendor.lock.json` 的 `platform` 段**再还原——
// 判据读的就是这个文件，只有碰它才算真测到。改写内容严格限定在 platform 一个字段，
// 且用 try/finally 保证还原（万一中断，下一轮跑 `--prune-only` 即可重建 lock）。
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

/**
 * 补齐 `check-assets` 需要的**生成物**（build/icons/*.png、build/icon.png、build/icon.icns），
 * 跑完再删掉——只补它缺的那些。
 *
 * 为什么必须这么做（2026-09-19，CI 首次真跑时暴露）：这些图标是 `scripts/gen-icon.mjs` 生成的
 * 且**被 .gitignore 挡着**，而 CI 的自检 job 跑的是**全新 checkout**、也不会（不该）为了跑离线自检
 * 去启动 Electron 生成图标 ⇒ `check-assets` 必然报"缺图标"，本套件四条断言一起变红。
 * 这条判据的价值在"lock 与打包目标不符要挡住"，所以夹具补齐生成物、把注意力留给真正要测的东西。
 * 判据本身不许依赖"本机有没有跑过 npm run icons"——它必须在干净克隆里同样成立。
 * @returns {string[]} 本次**由本函数创建**的文件（收尾只删这些，绝不动真实产物）
 */
function ensureGeneratedAssets() {
  const created = []
  const put = (rel, content) => {
    const abs = path.join(ROOT, 'build', rel)
    if (fs.existsSync(abs)) return
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
    created.push(rel)
  }
  // check-assets 对 ico/png/icns 只看"存在且非 0 字节"，对 icons/ 只看有没有 512/1024 档的 png 名
  put('icons/512x512.png', 'fixture')
  put('icon.png', 'fixture')
  if (process.platform === 'darwin') put('icon.icns', 'fixture')
  return created
}

/**
 * 跑一次 check-assets，把 stdout/stderr 收回来。
 *
 * **不能用管道 stdio**：受限会话里创建匿名管道会被拒（spawnSync 返回 EPERM、stdout 为空）——
 * 项目里反复记录过这个坑，所以子进程输出统一重定向到临时文件再读。
 */
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

console.log('[基线：真实 lock + 默认目标]')
const fixtures = ensureGeneratedAssets()
if (fixtures.length > 0) console.log(`  NOTE  补齐了缺失的生成物夹具：${fixtures.join(', ')}（跑完删除）`)
try {
  const baseline = runCheckAssets()
  ok('默认（本机平台）通过', baseline.status === 0, `exit=${baseline.status} ${baseline.error ?? ''}`)
  ok('输出里报告了 vendor 平台已核对', /vendor 平台已核对/.test(baseline.out))

  if (!fs.existsSync(LOCK)) {
    console.log('  NOTE  没有 vendor/vendor.lock.json，跳过平台核对相关断言（先跑 build:host）')
  } else {
    const original = fs.readFileSync(LOCK, 'utf8')
    try {
      const lock = JSON.parse(original)
      const realOs = lock.platform?.os ?? process.platform

      console.log('[vendor 平台与打包目标不符 → 必须挡住打包]')
      const otherOs = realOs === 'linux' ? 'win32' : 'linux'
      // 改的只有 platform.os/tag：judge 读到的就是这两个字段
      fs.writeFileSync(LOCK, JSON.stringify({ ...lock, platform: { ...lock.platform, os: otherOs, tag: `${otherOs}-${lock.platform?.arch ?? 'x64'}` } }, null, 2))
      const mismatchedDefault = runCheckAssets()
      ok('树与目标不符时判失败（默认目标）', mismatchedDefault.status === 1, `exit=${mismatchedDefault.status}`)
      ok('失败信息点名了树的平台与打包目标',
        /vendor 树是给/.test(mismatchedDefault.out) && mismatchedDefault.out.includes(otherOs),
        mismatchedDefault.out.split('\n').find((l) => l.includes('vendor 树是给')) ?? '(无)')

      // 反过来：用 DSH_PACK_PLATFORM 声明"我就是要打这个平台的包"，此时应当通过。
      // 这条很重要——它证明判据比的是"树 vs 目标"而不是"树 vs 宿主"，交叉打包才不会被误挡。
      const declared = runCheckAssets({ DSH_PACK_PLATFORM: otherOs })
      ok('DSH_PACK_PLATFORM 声明目标后通过（交叉打包不被误挡）', declared.status === 0, `exit=${declared.status}`)

      console.log('[lock 缺 platform 段（旧格式）→ 必须判失败]')
      const noPlatform = { ...lock }
      delete noPlatform.platform
      fs.writeFileSync(LOCK, JSON.stringify(noPlatform, null, 2))
      const oldFormat = runCheckAssets()
      ok('lock 无 platform 段时判失败并说明是旧格式',
        oldFormat.status === 1 && /旧格式/.test(oldFormat.out), `exit=${oldFormat.status}`)

      console.log('[lock 内容损坏 → 判失败但不抛异常]')
      fs.writeFileSync(LOCK, '{ this is not json')
      const broken = runCheckAssets()
      ok('lock 解析失败时判失败而不是崩', broken.status === 1 && /解析失败/.test(broken.out), `exit=${broken.status}`)
    } finally {
      // 无论上面哪条断言炸了都要还原：这个文件是现网树的身份证明
      fs.writeFileSync(LOCK, original)
    }
    const restored = JSON.parse(fs.readFileSync(LOCK, 'utf8'))
    ok('lock 已还原（platform 段与实验前一致）', JSON.stringify(restored.platform) === JSON.stringify(JSON.parse(original).platform))
    ok('还原后重新通过', runCheckAssets().status === 0)
  }
} finally {
  // 只删本函数建的夹具（真实产物一个都不碰）；顺带清掉可能建出来的空目录
  for (const rel of fixtures) { try { fs.rmSync(path.join(ROOT, 'build', rel), { force: true }) } catch { /* 略 */ } }
  try { fs.rmdirSync(path.join(ROOT, 'build', 'icons')) } catch { /* 目录里还有真实产物就不动它 */ }
}

console.log(fail === 0 ? '\nCHECK ASSETS SELF TEST: ALL PASS' : `\nCHECK ASSETS SELF TEST: ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
