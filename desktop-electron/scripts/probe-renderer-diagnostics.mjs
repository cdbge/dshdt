// probe-renderer-diagnostics.mjs — 桌面端页面装载取证工具（开发用，不随包分发）：
// 用真实 Electron 渲染一个 DSH 宿主 URL，落盘 console / 页面报错 / 子资源状态码 / 失败请求 / __ModuleLoader__ 现场。
import { app, BrowserWindow, session } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(here, '..', '.probe')
const outFile = path.join(outDir, 'renderer-diagnostics.log')

const url = process.argv[2] || process.env.DSH_PROBE_URL
const waitMs = Number(process.env.DSH_PROBE_WAIT_MS || 12000)

const lines = []
const log = (s) => lines.push(String(s))
const flush = () => {
  try {
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8')
  } catch (e) { process.stderr.write(`flush failed: ${e.message}\n`) }
}

process.on('uncaughtException', (e) => { log(`UNCAUGHT ${e && e.stack || e}`); flush(); app.exit(2) })

if (!url || !/^https?:\/\//.test(url)) {
  process.stderr.write('用法：electron probe-renderer-diagnostics.mjs <宿主 URL（含 ?token=）>\n')
  process.exit(2)
}

app.commandLine.appendSwitch('no-sandbox')

app.whenReady().then(async () => {
  let exitCode = 0
  try {
    const ses = session.defaultSession

    // 只读网络取证：子资源状态码 / 失败原因都留痕
    ses.webRequest.onCompleted((d) => {
      if (/\/plugins\/|\/assets\/|\/\?token=|\/$/.test(d.url)) {
        log(`REQ ${d.statusCode} ${d.resourceType || ''} ${d.url.slice(0, 200)}`)
      }
    })
    ses.webRequest.onErrorOccurred((d) => log(`REQ-ERR ${d.error} ${d.url.slice(0, 200)}`))

    // 独立 userData：不碰桌面壳/其他实例的会话与缓存
    if (process.env.DSH_PROBE_USER_DATA) app.setPath('userData', process.env.DSH_PROBE_USER_DATA)

    const win = new BrowserWindow({
      width: 1280, height: 860, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    })

    win.webContents.on('console-message', (event) => {
      log(`CONSOLE[${event.level ?? ''}] ${String(event.message ?? '').slice(0, 400)}`)
    })
    win.webContents.on('render-process-gone', (_e, d) => log(`RENDER-GONE ${JSON.stringify(d)}`))
    win.webContents.on('did-fail-load', (_e, code, desc, u) => log(`FAIL-LOAD ${code} ${desc} ${u}`))
    win.webContents.on('did-finish-load', () => log('DID-FINISH-LOAD'))

    const target = new URL(url)
    log(`# 探针开始 ${new Date().toISOString()}\n# URL ${target.origin}/ (token 已隐去)`)

    try { await win.loadURL(url) } catch (e) { log(`LOADURL-ERR ${String(e.message || e)}`) }
    await new Promise((r) => setTimeout(r, waitMs))

    const probe = await win.webContents.executeJavaScript(`(() => {
      const q = globalThis.__ModuleLoader__
      const boot = globalThis.__DSH_BOOT__
      const regs = q && q.pendingQueue ? q.pendingQueue.map(r => r.id) : null
      return {
        loaderMode: q ? q.mode : null,
        hasCreate: !!(q && typeof q.create === 'function'),
        pendingCount: regs ? regs.length : null,
        hasClientModulesRegistration: regs ? regs.includes('@deepseek-ai/dsh-client-modules') : null,
        bootRev: boot ? boot.rev : null,
        bootEntries: boot && boot.entries ? boot.entries.length : null,
        batches: boot && boot.batches ? boot.batches.map(b => b.phase + ':' + b.entries.length) : null,
        rootChildren: document.getElementById('root') ? document.getElementById('root').childElementCount : null,
        bodyText: (document.body ? document.body.innerText : '').slice(0, 600),
      }
    })()`, true)
    log('PAGE-PROBE ' + JSON.stringify(probe, null, 2))

    const ok = probe && probe.hasClientModulesRegistration !== null && probe.rootChildren > 0
    log(`# 结论：${ok ? '页面装载且插件注册正常' : '⚠️ 复现了插件装载失败（见上面 PAGE-PROBE 与 REQ 行）'}`)
    if (!ok) exitCode = 3
  } catch (e) {
    log(`PROBE-ERR ${e && e.stack || e}`)
    exitCode = 2
  }
  flush()
  app.exit(exitCode)
})
