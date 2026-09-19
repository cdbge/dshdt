#!/usr/bin/env node
// boot-smoke.mjs — ELECTRON_RUN_AS_NODE 下真实 boot DSH web（隔离 DSH_HOME），探测到就绪 URL 后关停。
// stdio 必须走文件描述符重定向，不能用默认 pipe。
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
// Electron 内建 Node 下必须显式带 V8 旗标，否则 hmr 回退抛 "--expose-internals is required"。
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
