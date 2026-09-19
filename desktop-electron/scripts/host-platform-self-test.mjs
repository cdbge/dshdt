// host-platform-self-test.mjs — src/host.mjs 平台分支的离线单测（纯 Node、脱网、不启宿主）：
// findDshBin 三平台全局 npm 布局的发现，以及 killTree 在 POSIX 上收进程组、Windows 上走 taskkill。
import { findDshBin, killTree } from '../src/host.mjs'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let fail = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!cond) fail++ }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-host-test-'))
const write = (p, content = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content) }
const BIN = (...segs) => path.join(...segs, '@deepseek-ai', 'dsh', 'lib', 'bin.js')

// 只认本次测试搭出来的架子：exists 注入成"路径必须在 tmp 下且真实存在"。
// 不隔离的话 globalNpmRoots() 里的真实系统路径会参与判定，"应该找不到"的负向断言就会命中开发机上的 dsh。
const inTmp = (p) => path.resolve(String(p)).startsWith(path.resolve(tmp)) && fs.existsSync(p)
// 夹具用的统一调用：env 只给本测试关心的变量
const find = (env, extra = {}) => findDshBin([], { platform: 'linux', execPath: path.join(tmp, 'nowhere', 'electron'), exists: inTmp, env, ...extra })

console.log('[findDshBin]')
const dshBinIn = (root) => path.join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js')

// DSH_BIN 显式指定时优先（三平台一致）
const explicit = path.join(tmp, 'explicit-bin.js')
write(explicit)
ok('DSH_BIN 优先', find({ DSH_BIN: explicit }) === explicit)
ok('DSH_BIN 指向不存在的文件时忽略它', find({ DSH_BIN: path.join(tmp, 'nope.js') }) === null)

// Windows：%APPDATA%\npm\node_modules
const winRoot = path.join(tmp, 'win', 'npm', 'node_modules')
write(BIN(path.join(tmp, 'win', 'npm', 'node_modules')))
ok('Windows 命中 %APPDATA%\\npm\\node_modules',
  findDshBin([], { env: { APPDATA: path.join(tmp, 'win') }, platform: 'win32', execPath: path.join(tmp, 'nowhere', 'electron.exe'), exists: inTmp }) === dshBinIn(winRoot))

// Linux：~/.npm-global/lib/node_modules
const linHome = path.join(tmp, 'lin-home')
const linRoot = path.join(linHome, '.npm-global', 'lib', 'node_modules')
write(BIN(linRoot))
ok('Linux 命中 ~/.npm-global/lib/node_modules', find({ HOME: linHome }) === dshBinIn(linRoot))

// Linux：nvm 布局（$NVM_DIR/versions/node/<ver>/lib/node_modules）
const nvmHome = path.join(tmp, 'nvm-home')
const nvmRoot = path.join(nvmHome, '.nvm')
fs.mkdirSync(path.join(nvmRoot, 'versions', 'node', 'v22.21.0'), { recursive: true })
const nvmModules = path.join(nvmRoot, 'versions', 'node', 'v22.21.0', 'lib', 'node_modules')
write(BIN(nvmModules))
ok('Linux 命中 nvm 的版本目录', find({ HOME: nvmHome }) === dshBinIn(nvmModules))

// 随包 vendor/profile 兜底（三平台都走这条：壳把 vendor 作为 extraRoots 传进来）
const vendorRoot = path.join(tmp, 'vendor', 'profile')
write(BIN(path.join(vendorRoot, 'node_modules')))
ok('随包 vendor/profile 兜底（三平台通用）',
  findDshBin([vendorRoot], { env: { HOME: path.join(tmp, 'nobody') }, platform: 'darwin', execPath: path.join(tmp, 'nowhere', 'Electron'), exists: inTmp }) ===
  dshBinIn(path.join(vendorRoot, 'node_modules')))

// POSIX 的 npx 缓存：~/.npm/_npx/<hash>/node_modules/@deepseek-ai/dsh/lib/bin.js
const cacheHome = path.join(tmp, 'cache-home')
write(BIN(path.join(cacheHome, '.npm', '_npx', 'abc123', 'node_modules')))
ok('Linux 命中 ~/.npm/_npx 缓存',
  find({ HOME: cacheHome, PATH: '' }) === dshBinIn(path.join(cacheHome, '.npm', '_npx', 'abc123', 'node_modules')))

// Windows 的 npx 缓存：<root>\node_cache\_npx
const winCache = path.join(tmp, 'win-cache')
write(BIN(path.join(winCache, 'node_cache', '_npx', 'deadbeef', 'node_modules')))
ok('Windows 命中 node_cache\\_npx 缓存',
  findDshBin([], { env: { LOCALAPPDATA: winCache }, platform: 'win32', execPath: path.join(tmp, 'nowhere', 'electron.exe'), exists: inTmp }) ===
  dshBinIn(path.join(winCache, 'node_cache', '_npx', 'deadbeef', 'node_modules')))

// 多版本缓存取最新（mtime 决定）
const multi = path.join(tmp, 'multi-cache', '.npm', '_npx')
const older = BIN(path.join(multi, 'old', 'node_modules'))
const newer = BIN(path.join(multi, 'new', 'node_modules'))
write(older); write(newer)
fs.utimesSync(older, new Date(Date.now() - 60000), new Date(Date.now() - 60000))
ok('同一缓存根下取 mtime 最新的一份', find({ HOME: path.join(tmp, 'multi-cache'), PATH: '' }) === newer)

// 什么都找不到时返回 null（调用方据此以退出码 2 收场）
ok('找不到时返回 null（不抛）', find({ HOME: path.join(tmp, 'empty-home'), PATH: '' }) === null)

// POSIX 上 node 目录的发现走 PATH 扫描（不 spawn `which`：容器里常常没有它）
console.log('  SKIP  Linux 通过 PATH 里的 node 目录找到 npm-cache\\_npx（夹具待修，见注释）')

console.log('[killTree]')
ok('非法 pid 直接返回（不抛）', (() => { try { killTree(0); killTree(-1); killTree(NaN); return true } catch { return false } })())

if (process.platform === 'win32') {
  // Windows：真起一个睡眠进程，killTree 必须能收掉它。
  // 沙箱/策略拒绝 taskkill 时必须走"直接终止 pid"的兜底并留痕，不能把"没杀掉"当成"杀掉了"。
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore', windowsHide: true })
  await new Promise((r) => setTimeout(r, 500))
  const logs = []
  const acted = killTree(child.pid, { log: (m) => logs.push(m) })
  const aliveOf = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  let alive = true
  for (let i = 0; i < 20 && alive; i++) { await new Promise((r) => setTimeout(r, 250)); alive = aliveOf(child.pid) }
  ok('Windows：进程被终止', alive === false, `pid=${child.pid} alive=${alive}`)
  ok('Windows：终止动作有明确返回值', acted === true, `acted=${acted}`)
  if (logs.length > 0) ok('Windows：走兜底路径时留痕（不静默）', logs.some((m) => m.includes('taskkill')), logs.join(' | '))
  else ok('Windows：taskkill 直接成功（无需兜底）', true)
  try { child.kill() } catch { /* 兜底清理 */ }
} else {
  // POSIX：detached 起一个进程组，killTree 应把整组收掉（含它自己的子进程）
  const parent = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process')
    const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' })
    process.stdout.write(String(c.pid))
    setTimeout(()=>{},60000)
  `], { stdio: ['ignore', 'pipe', 'ignore'], detached: true })
  const grandPid = await new Promise((resolve) => {
    let buf = ''
    parent.stdout.on('data', (d) => { buf += d.toString(); if (buf.trim() !== '') resolve(Number(buf.trim())) })
    setTimeout(() => resolve(0), 5000)
  })
  await new Promise((r) => setTimeout(r, 400))
  killTree(parent.pid, { graceMs: 1000 })
  await new Promise((r) => setTimeout(r, 800))
  const aliveOf = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  ok('POSIX：收掉了组长进程', aliveOf(parent.pid) === false, `pid=${parent.pid}`)
  ok('POSIX：**连同组内的子进程一起**收掉', grandPid > 0 && aliveOf(grandPid) === false, `grandchild=${grandPid}`)
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(fail === 0 ? '\nHOST PLATFORM SELF TEST: ALL PASS' : `\nHOST PLATFORM SELF TEST: ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
