#!/usr/bin/env node
// M0 断言 4：ELECTRON_RUN_AS_NODE 下真实 boot DSH web（隔离 DSH_HOME），探测就绪后关停。
// 用法：node scripts/boot-smoke.mjs <electron.exe> <dsh-bin.js> [--home <dir>] [--timeout <秒>] [--expose-internals]
// 说明：stdio 走文件描述符重定向（沙箱管道限制，不能用默认 pipe）；
//       这也是未来 host.mjs 的宿主监管雏形（spawn 参数用数组，避免空格路径被拆）。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, closeSync } from 'node:fs'
import { join } from 'node:path'

const runtime = process.argv[2]
const bin = process.argv[3]
const homeIdx = process.argv.indexOf('--home')
const home = homeIdx >= 0 ? process.argv[homeIdx + 1] : join(process.cwd(), '.dsh-m0')
const timeoutIdx = process.argv.indexOf('--timeout')
const timeoutMs = (timeoutIdx >= 0 ? Number(process.argv[timeoutIdx + 1]) : 90) * 1000
mkdirSync(home, { recursive: true })

const outPath = join(home, 'boot.out.log')
const errPath = join(home, 'boot.err.log')
const outFd = openSync(outPath, 'w')
const errFd = openSync(errPath, 'w')

const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home }
// Electron 内建 Node 下 cordis-loader 拿不到 internal 句柄（hmr 回退会抛
// "--expose-internals is required"），必须显式带 V8 旗标；系统 Node 不需要。
const v8Flags = process.argv.includes('--expose-internals') ? ['--expose-internals'] : []
const child = spawn(runtime, [...v8Flags, bin, 'web', '--port', '0', '--host', '127.0.0.1'], {
  stdio: ['ignore', outFd, errFd],
  env,
  windowsHide: true,
})
process.stdout.write('[boot-smoke] pid=' + child.pid + ' home=' + home + '\n')

let exited = null
child.on('exit', (code, sig) => { exited = { code, sig } })

const deadline = Date.now() + timeoutMs
let url = null
while (Date.now() < deadline && !exited) {
  if (existsSync(outPath)) {
    const m = readFileSync(outPath, 'utf8').match(/https?:\/\/127\.0\.0\.1:\d+/)
    if (m) { url = m[0]; break }
  }
  await new Promise((r) => setTimeout(r, 500))
}

if (url) {
  process.stdout.write('[boot-smoke] 就绪 URL: ' + url + '\n')
  process.stdout.write('[boot-smoke] profiles/web 已建出: ' + existsSync(join(home, 'profiles', 'web', 'package.json')) + '\n')
  try {
    const res = await fetch(url + '/', { signal: AbortSignal.timeout(10000) })
    process.stdout.write('[boot-smoke] GET / -> ' + res.status + '\n')
  } catch (error) {
    process.stdout.write('[boot-smoke] GET / 未通过（非致命，URL 行已证明就绪）: ' + error.message + '\n')
  }
  child.kill()
  await new Promise((r) => { if (exited) r(); else child.once('exit', r) })
  process.stdout.write('[boot-smoke] 关停完成 exit=' + JSON.stringify(exited) + '\n')
  closeSync(outFd); closeSync(errFd)
  const tail = readFileSync(outPath, 'utf8').split('\n').filter(Boolean).slice(-8).join('\n')
  process.stdout.write('[boot-smoke] --- stdout tail ---\n' + tail + '\n')
  process.exit(0)
} else {
  process.stdout.write('[boot-smoke] 就绪超时或提前退出: ' + JSON.stringify(exited) + '\n')
  closeSync(outFd); closeSync(errFd)
  if (existsSync(outPath)) process.stdout.write('[boot-smoke] --- stdout tail ---\n' + readFileSync(outPath, 'utf8').split('\n').filter(Boolean).slice(-8).join('\n') + '\n')
  if (existsSync(errPath)) process.stdout.write('[boot-smoke] --- stderr tail ---\n' + readFileSync(errPath, 'utf8').split('\n').filter(Boolean).slice(-12).join('\n') + '\n')
  process.exit(1)
}
