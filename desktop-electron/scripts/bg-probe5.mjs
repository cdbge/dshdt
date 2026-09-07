// bg-probe5.mjs — 在注入修复 CSS 后，用 elementsFromPoint 找出仍盖住采样点的元素
import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

app.commandLine.appendSwitch('disable-gpu')
const TARGET = process.env.PROBE_URL || 'http://127.0.0.1:8021/'
const OUT = process.env.PROBE_OUT || path.join(path.dirname(fileURLToPath(import.meta.url)), 'bg-probe5-out.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const FIX_CSS = (url) => `
  html, body { background-color: transparent !important; }
  body {
    background-image: linear-gradient(rgba(10, 12, 16, 0.35), rgba(10, 12, 16, 0.35)), url("${url}") !important;
    background-size: cover !important;
    background-position: center !important;
    background-repeat: no-repeat !important;
    background-attachment: fixed !important;
  }
  #root > div,
  #root [class$="_frame"],
  #root [class$="_root"],
  #root [class$="_centerCol"] {
    background-color: transparent !important;
  }
`

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1200, height: 800, paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  try {
    await win.loadURL(TARGET)
    await sleep(10000)
    await win.webContents.insertCSS(FIX_CSS('http://127.0.0.1:25439/bg-image?t=9'))
    await sleep(2500)
    const report = await win.webContents.executeJavaScript(`(() => {
      const pts = { C: [600, 400], L: [300, 400], BL: [40, 700], TL: [40, 40] }
      const out = {}
      for (const [name, [x, y]] of Object.entries(pts)) {
        const els = document.elementsFromPoint(x, y)
        out[name] = els.slice(0, 6).map((el) => {
          const cs = getComputedStyle(el)
          return {
            tag: el.tagName, id: el.id || undefined,
            cls: String(el.className).split(' ').map((c) => c.slice(-28)).join(',').slice(0, 80) || undefined,
            bg: cs.backgroundColor, bgImage: cs.backgroundImage.slice(0, 40),
          }
        })
      }
      return out
    })()`)
    console.log('PROBE5 REPORT:', JSON.stringify(report, null, 2))
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
  } catch (e) {
    console.error('PROBE5 FAILED:', e)
    fs.writeFileSync(OUT, JSON.stringify({ failed: String(e) }, null, 2))
  }
  app.exit(0)
})
