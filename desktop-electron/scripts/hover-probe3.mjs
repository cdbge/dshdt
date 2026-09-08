// hover-probe3.mjs — 诊断桌面 section 状态：按钮为何未渲染（加载态/旧bundle/admin连通性）
import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

app.commandLine.appendSwitch('disable-gpu')
const TARGET = process.env.PROBE_URL || 'http://127.0.0.1:14113/'
const OUT = process.env.PROBE_OUT || path.join(path.dirname(fileURLToPath(import.meta.url)), 'hover-probe3-out.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const report = {}
  const win = new BrowserWindow({
    show: false, width: 1280, height: 860, paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  try {
    await win.loadURL(TARGET)
    await sleep(9000)
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('button[aria-haspopup="dialog"]')].forEach((b) => b.click())`)
    await sleep(6000)
    report.diag = await win.webContents.executeJavaScript(`(async () => {
      const out = {}
      out.adminDirect = await fetch('http://127.0.0.1:25439/api/status').then(r => r.ok ? 'ok:' + r.status : 'bad:' + r.status).catch(e => 'err:' + e.message)
      const label = [...document.querySelectorAll('*')].find((el) => el.children.length === 0 && (el.textContent || '').trim() === '桌面')
      out.labelFound = !!label
      out.loadingText = document.body.textContent.includes('正在连接桌面壳')
      const btns = [...document.querySelectorAll('button')].map((b) => ({ t: (b.textContent || '').trim().slice(0, 10), cls: b.className && String(b.className).slice(0, 30) })).filter((x) => x.t)
      out.buttons = btns.slice(0, 12)
      out.hasDshBtn = !!document.querySelector('.dsh-desktop-btn')
      return out
    })()`)
    console.log('HOVER3:', JSON.stringify(report, null, 2))
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
  } catch (e) {
    console.error('HOVER3 FAILED:', e)
    fs.writeFileSync(OUT, JSON.stringify({ failed: String(e) }, null, 2))
  }
  app.exit(0)
})
