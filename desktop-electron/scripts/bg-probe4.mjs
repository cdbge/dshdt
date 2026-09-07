// bg-probe4.mjs — 精确结构 + 候选修复 CSS 像素验证
// 1) 输出 #root 内关键节点的祖先链（child index）与所有大块不透明层
// 2) 注入候选修复 CSS → 截帧对比像素是否变化（壁纸真正画出来）
import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

app.commandLine.appendSwitch('disable-gpu')
const TARGET = process.env.PROBE_URL || 'http://127.0.0.1:8021/'
const IMG = process.env.PROBE_IMG || 'D:\\Desktop\\photo\\edge_background.jpg'
const OUT = process.env.PROBE_OUT || path.join(path.dirname(fileURLToPath(import.meta.url)), 'bg-probe4-out.json')
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

function sample(img, points) {
  const size = img.getSize()
  const b = img.toBitmap()
  const out = {}
  for (const [name, [x, y]] of Object.entries(points)) {
    const px = ((y * size.width) + x) * 4
    out[name] = `#${b[px + 2].toString(16).padStart(2, '0')}${b[px + 1].toString(16).padStart(2, '0')}${b[px].toString(16).padStart(2, '0')}`
  }
  return out
}

app.whenReady().then(async () => {
  const report = {}
  const win = new BrowserWindow({
    show: false, width: 1200, height: 800, paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  try {
    await win.loadURL(TARGET)
    await sleep(10000)
    report.structure = await win.webContents.executeJavaScript(`(() => {
      const out = {}
      const chain = (el) => {
        const parts = []
        let n = el
        while (n && n !== document.documentElement) {
          const p = n.parentElement
          const idx = p ? Array.prototype.indexOf.call(p.children, n) : -1
          parts.unshift(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.className && String(n.className).slice(0, 24) ? '.' + String(n.className).split(' ')[0].slice(0, 24) : '') + '[' + idx + ']')
          n = p
        }
        return parts.join(' > ')
      }
      const vw = document.documentElement.clientWidth
      const vh = document.documentElement.clientHeight
      out.full = []
      for (const el of document.querySelectorAll('div, section, main, aside')) {
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        const opaque = cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)'
        if (r.width >= vw * 0.5 && r.height >= vh * 0.5) {
          out.full.push({
            path: chain(el),
            w: Math.round(r.width), h: Math.round(r.height),
            bg: cs.backgroundColor,
          })
        }
      }
      out.sidebar = []
      for (const el of document.querySelectorAll('aside, [class$="_sidebar"], [class*="sidebar"]')) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > vh * 0.5) {
          out.sidebar.push({ path: chain(el), cls: String(el.className).slice(0, 60), bg: getComputedStyle(el).backgroundColor, w: Math.round(r.width) })
        }
      }
      out.bgClasses = {}
      for (const el of document.querySelectorAll('#root [class]')) {
        const cs = getComputedStyle(el)
        if (cs.backgroundColor === 'rgb(21, 21, 23)') {
          const cls = String(el.className).split(' ')[0]
          out.bgClasses[cls] = (out.bgClasses[cls] || 0) + 1
        }
      }
      return out
    })()`)

    const base = await win.webContents.capturePage()
    const size = base.getSize()
    const points = { TL: [40, 40], TR: [size.width - 40, 40], BL: [40, size.height - 40], BR: [size.width - 40, size.height - 40], C: [Math.floor(size.width / 2), Math.floor(size.height / 2)], L: [Math.floor(size.width / 2) - 300, Math.floor(size.height / 2)] }
    report.baseline = sample(base, points)

    await win.webContents.insertCSS(FIX_CSS('http://127.0.0.1:25439/bg-image?t=9'))
    await sleep(2500)
    const after = await win.webContents.capturePage()
    report.afterFix = sample(after, points)

    console.log('PROBE4 REPORT:', JSON.stringify(report, null, 2))
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
  } catch (e) {
    console.error('PROBE4 FAILED:', e)
    fs.writeFileSync(OUT, JSON.stringify({ failed: String(e) }, null, 2))
  }
  app.exit(0)
})
