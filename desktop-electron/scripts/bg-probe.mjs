// bg-probe.mjs — 背景图片功能的无头复现探针（诊断朋友机器"看不到背景"问题）
// 用法: electron.exe scripts/bg-probe.mjs
//   加载真实 rc.6 host 的 SPA → 注入与 0.4.1 壳完全相同的 CSS →
//   读回计算样式 + 实测 file:// 图片能否被渲染器加载。
import { app, BrowserWindow } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

app.commandLine.appendSwitch('disable-gpu')

const TARGET = process.env.PROBE_URL || 'http://127.0.0.1:10714/'
const IMG = process.env.PROBE_IMG || ''
const OUT = process.env.PROBE_OUT || path.join(path.dirname(fileURLToPath(import.meta.url)), 'bg-probe-out.json')

const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }

app.whenReady().then(async () => {
  // 模拟 0.4.1 修复后的 admin 供给：回环 HTTP 提供图片（file:// 会被 Chromium 拒绝）
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/bg')) {
      const data = fs.readFileSync(IMG)
      res.writeHead(200, { 'Content-Type': MIME_BY_EXT[path.extname(IMG).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' })
      res.end(data)
    } else { res.writeHead(404); res.end() }
  })
  await new Promise((r) => srv.listen(25441, '127.0.0.1', r))
  const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { offscreen: true, contextIsolation: true, sandbox: true } })
  win.webContents.on('console-message', (e, level, message) => { if (level >= 2) console.log('[renderer]', message) })
  try {
    await win.loadURL(TARGET)
    await new Promise((r) => setTimeout(r, 8000)) // 等 SPA 客户端包就绪
    const httpUrl = 'http://127.0.0.1:25441/bg'
    const fileUrl = pathToFileURL(IMG).href
    const css = `
      html { background-color: #101216 !important; }
      body {
        background-image: linear-gradient(rgba(10, 12, 16, 0.35), rgba(10, 12, 16, 0.35)), url("${httpUrl}") !important;
        background-size: cover !important;
        background-position: center !important;
        background-repeat: no-repeat !important;
        background-attachment: fixed !important;
      }
      :root { --dsw-alias-bg-base: transparent !important; }
    `
    await win.webContents.insertCSS(css)
    await new Promise((r) => setTimeout(r, 1500))
    const report = await win.webContents.executeJavaScript(`(async () => {
      const out = {}
      out.title = document.title
      out.baseVar = getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-bg-base').trim()
      out.bodyBackgroundImage = getComputedStyle(document.body).backgroundImage.slice(0, 160)
      const load = (src) => new Promise((resolve) => {
        const img = new Image()
        const t = setTimeout(() => resolve('timeout(5s)'), 5000)
        img.onload = () => { clearTimeout(t); resolve('ok ' + img.naturalWidth + 'x' + img.naturalHeight) }
        img.onerror = () => { clearTimeout(t); resolve('error') }
        img.src = src
      })
      out.imgLoadFile = await load(${JSON.stringify(fileUrl)})
      out.imgLoadHttp = await load(${JSON.stringify(httpUrl)})
      return out
    })()`)
    console.log('PROBE REPORT:', JSON.stringify(report, null, 2))
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
  } catch (e) {
    console.error('PROBE FAILED:', e)
    fs.writeFileSync(OUT, JSON.stringify({ failed: String(e) }, null, 2))
  }
  srv.close()
  app.exit(0)
})
