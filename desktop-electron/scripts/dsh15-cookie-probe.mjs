// dsh15-cookie-probe.mjs — 验证 0.1.5 的 token→cookie 换票流程，定位"永远不就绪"的真因
//
// 已观测：token URL 用默认 fetch（跟随重定向）返回 401，而 redirect:'manual' 返回 303 +
// Set-Cookie: dsh-auth-…。Node 的 fetch(undici) **没有 cookie jar**，跟随重定向时不会带上该 cookie，
// 因此下一跳 `/` 仍然是 401 —— 而 runBootGate 与 shell 的 waitReady 都只认 `res.ok`。
//
// 本脚本要证的是：**手动接住 Set-Cookie 再请求 `/` 能不能拿到 200**。
//   · 能 → HTTP 服务完全可用，问题纯在探针（假阴性）；换树后窗口用真实 cookie jar 是能打开的。
//   · 不能 → 还有别的问题。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startHost, extractHostUrl, freePort, killTree } from '../src/host.mjs'

const ROOT = path.join(path.dirname(import.meta.url.replace('file:///', '')), '..')
const INSTALL = 'D:\\Desktop\\DSH Desktop'
const PROFILE = path.join(INSTALL, 'resources', 'vendor', 'staging', '0.1.5-rc.2', 'profile')
const PATCH = path.join(INSTALL, 'resources', 'desktop.patch.yml')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const OUT = path.join(ROOT, '..', '.dsh-inspect', 'dsh15-cookie-probe.json')
const report = {}

const bin = path.join(PROFILE, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (!fs.existsSync(bin)) { console.error('暂存树缺 bin.js，先跑 dsh15-probe.mjs'); process.exit(1) }

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh15-cookie-'))
const profileWeb = path.join(home, 'profiles', 'web')
fs.mkdirSync(path.join(profileWeb, 'node_modules'), { recursive: true })
for (const name of ['dsh-desktop-ui', 'dsh-auto-approval']) {
  const src = path.join(PROFILE, 'node_modules', name)
  if (fs.existsSync(path.join(src, 'package.json'))) fs.cpSync(src, path.join(profileWeb, 'node_modules', name), { recursive: true })
}
fs.writeFileSync(path.join(profileWeb, 'cordis.patch.yml'), '- insert:\n    - id: dsh-auto-approval\n      name: dsh-auto-approval\n')

const logFile = path.join(home, 'host.log')
const port = await freePort()
const child = startHost({ runtime: ELECTRON, bin, home, ws: os.tmpdir(), port, patchFile: PATCH, logFile })
report.port = port
report.pid = child.pid

try {
  let declared = null
  const deadline = Date.now() + 45000
  while (Date.now() < deadline && child.exitCode === null) {
    declared = extractHostUrl(logFile)
    if (declared !== null) break
    await new Promise((r) => setTimeout(r, 400))
  }
  report.declared = declared
  console.log('token URL:', declared)

  if (declared !== null) {
    // 第 1 跳：不跟随重定向，接住 Set-Cookie
    const hop1 = await fetch(declared, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    const rawCookie = hop1.headers.getSetCookie ? hop1.headers.getSetCookie() : [hop1.headers.get('set-cookie')].filter(Boolean)
    report.hop1 = { status: hop1.status, location: hop1.headers.get('location'), cookies: rawCookie.map((c) => c.split(';')[0].slice(0, 40)) }
    console.log('第 1 跳:', JSON.stringify(report.hop1, null, 2))

    if (rawCookie.length > 0) {
      const cookieHeader = rawCookie.map((c) => c.split(';')[0]).join('; ')
      // 第 2 跳：带上 cookie 请求根路径
      const hop2 = await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie: cookieHeader }, signal: AbortSignal.timeout(5000) })
      const body = await hop2.text()
      report.hop2 = { status: hop2.status, ok: hop2.ok, contentType: hop2.headers.get('content-type'), bytes: body.length, isHtml: /<html|<!doctype/i.test(body), head: body.slice(0, 80) }
      console.log('第 2 跳（带 cookie）:', JSON.stringify(report.hop2, null, 2))
      report.verdict = hop2.ok
        ? '带 cookie 即可 200 → HTTP 服务完全可用，问题**纯在探针**（runBootGate/waitReady 只认 res.ok 且 fetch 无 cookie jar）'
        : '带 cookie 仍非 200 → 另有问题，需继续排查'
    } else {
      report.verdict = '第 1 跳没给 Set-Cookie，无法换票'
    }
  }
  console.log('结论:', report.verdict)
} catch (e) {
  report.failed = String(e)
  console.error('异常:', e)
} finally {
  if (child.exitCode === null) { killTree(child.pid); await new Promise((r) => setTimeout(r, 1200)) }
  fs.rmSync(home, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
  console.log('报告:', OUT)
}
process.exit(0)
