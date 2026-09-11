// dsh15-probe.mjs — 重建 0.1.5-rc.2 暂存树（跳过门禁）并**亲手探测 token URL**
//
// 要回答的唯一问题：壳到底能不能与 0.1.5 对话？
//   · 若探得到 → 门禁那次失败是假阴性（很可能与树被掏空有关），更新其实可行；
//   · 若探不到 → 壳与 0.1.5 的交互合同仍有未修的裂缝，更新不可能成功，门禁的判断是对的。
//
// 为什么先跳过门禁：门禁会在失败时把它自己的现场清掉，而我要看的是**宿主运行时的真实 HTTP 行为**。
// 本脚本只写 staging 目录（绝不碰现网 vendor/profile），并在结束后把宿主进程杀干净。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { buildStaging, findNpm } from '../src/vendor-build.mjs'
import { startHost, extractHostUrl, freePort, killTree } from '../src/host.mjs'

const ROOT = path.join(path.dirname(import.meta.url.replace('file:///', '')), '..')
const INSTALL = 'D:\\Desktop\\DSH Desktop'
const STAGING = path.join(INSTALL, 'resources', 'vendor', 'staging', '0.1.5-rc.2')
const PATCH = path.join(INSTALL, 'resources', 'desktop.patch.yml')
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const TARGET = '0.1.5-rc.2'

function walk(dir) {
  let files = 0
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let es
    try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) stack.push(p); else files += 1 }
  }
  return files
}

const out = {}
try {
  console.log('=== 1) 重建暂存树（bootGate: null）===')
  fs.rmSync(STAGING, { recursive: true, force: true })
  const built = await buildStaging({
    stagingRoot: STAGING,
    versions: {
      '@deepseek-ai/dsh': TARGET,
      '@deepseek-ai/dsh-base': TARGET,
      '@deepseek-ai/dsh-web-app': TARGET,
    },
    packagesDir: path.join(ROOT, 'packages'),
    cacheDir: path.join(ROOT, '.npm-cache'),
    runtime: ELECTRON,
    bootGate: null,
    logFile: path.join(STAGING, '..', 'build.log'),
    log: (m) => console.log(m),
  })
  out.built = { ok: built.ok, error: built.error, lock: built.lock }
  if (!built.ok) { console.log('构建失败:', built.error); fs.writeFileSync(path.join(ROOT, '..', '.dsh-inspect', 'dsh15-probe.json'), JSON.stringify(out, null, 2)); process.exit(1) }

  const profileDir = built.profileDir
  const bin = path.join(profileDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  out.afterBuild = { files: walk(profileDir), binExists: fs.existsSync(bin), profileDir }
  console.log(`[探针] 构建后: ${out.afterBuild.files} 文件, bin.js=${out.afterBuild.binExists}`)

  console.log('')
  console.log('=== 2) 手工起宿主并探测 token URL ===')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh15-probe-'))
  const profileWeb = path.join(home, 'profiles', 'web')
  fs.mkdirSync(path.join(profileWeb, 'node_modules'), { recursive: true })
  for (const name of ['dsh-desktop-ui', 'dsh-auto-approval']) {
    const src = path.join(profileDir, 'node_modules', name)
    if (fs.existsSync(path.join(src, 'package.json'))) fs.cpSync(src, path.join(profileWeb, 'node_modules', name), { recursive: true })
  }
  fs.writeFileSync(path.join(profileWeb, 'cordis.patch.yml'),
    '- insert:\n    - id: dsh-auto-approval\n      name: dsh-auto-approval\n')

  const logFile = path.join(home, 'host.log')
  const port = await freePort()
  const child = startHost({ runtime: ELECTRON, bin, home, ws: os.tmpdir(), port, patchFile: PATCH, logFile })
  out.hostPid = child.pid
  out.port = port

  const probes = []
  const deadline = Date.now() + 60000
  let declared = null
  while (Date.now() < deadline) {
    if (child.exitCode !== null) { probes.push({ t: Date.now(), note: `宿主退出 code=${child.exitCode}` }); break }
    declared = extractHostUrl(logFile)
    if (declared !== null) break
    await new Promise((r) => setTimeout(r, 500))
  }
  out.declared = declared
  console.log('[探针] 宿主宣告的 URL:', declared)

  if (declared !== null) {
    // 逐条试：裸 URL / 带 token URL / 带 token 且不跟随重定向
    const bare = `http://127.0.0.1:${port}/`
    for (const [label, url, opts] of [
      ['裸 URL', bare, {}],
      ['带 token URL', declared, {}],
      ['带 token + redirect:manual', declared, { redirect: 'manual' }],
    ]) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5000), ...opts })
        const body = await res.text()
        probes.push({ label, url, status: res.status, ok: res.ok, location: res.headers.get('location'), setCookie: (res.headers.get('set-cookie') || '').slice(0, 60), bodyHead: body.slice(0, 120) })
      } catch (e) {
        probes.push({ label, url, error: e.message })
      }
    }
  }
  out.probes = probes
  for (const p of probes) console.log('[探针]', JSON.stringify(p))

  console.log('')
  console.log('=== 3) 收尾 ===')
  if (child.exitCode === null) { killTree(child.pid); await new Promise((r) => setTimeout(r, 1500)) }
  out.afterProbe = { files: walk(profileDir) }
  console.log(`[探针] 宿主跑完后: ${out.afterProbe.files} 文件（构建后是 ${out.afterBuild.files}）`)
  out.treeDamaged = out.afterProbe.files < out.afterBuild.files
  fs.writeFileSync(path.join(ROOT, '..', '.dsh-inspect', 'dsh15-probe.json'), JSON.stringify(out, null, 2))
  console.log('[探针] 报告已写入 .dsh-inspect/dsh15-probe.json')
} catch (e) {
  console.error('[探针] 异常:', e)
  out.failed = String(e)
  try { fs.writeFileSync(path.join(ROOT, '..', '.dsh-inspect', 'dsh15-probe.json'), JSON.stringify(out, null, 2)) } catch { /* 尽力而为 */ }
}
process.exit(0)
