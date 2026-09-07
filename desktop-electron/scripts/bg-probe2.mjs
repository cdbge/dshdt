// bg-probe2.mjs — 像素级验证：真实窗口场景下背景图是否真的"画"出来了
// 方法：加载真实 SPA → 记录 body/html 高度与布局 → 注入 CSS 前后各截一帧，
// 对比角落像素；再用"画在 html 上"的修复 CSS 截第三帧对比。
// 用法：electron.exe scripts/bg-probe2.mjs（会话环境需先 Remove-Item Env:ELECTRON_RUN_AS_NODE）
import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

app.commandLine.appendSwitch('disable-gpu')

const TARGET = process.env.PROBE_URL || 'http://127.0.0.1:8021/'
const IMG = process.env.PROBE_IMG || 'D:\\Desktop\\photo\\edge_background.jpg'
const OUT = process.env.PROBE_OUT || path.join(path.dirname(fileURLToPath(import.meta.url)), 'bg-probe2-out.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CSS_BODY = (url) => `
  html { background-color: #101216 !important; }
  body {
    background-image: linear-gradient(rgba(10, 12, 16, 0.35), rgba(10, 12, 16, 0.35)), url("${url}") !important;
    background-size: cover !important;
    background-position: center !important;
    background-repeat: no-repeat !important;
    background-attachment: fixed !important;
  }
  :root { --dsw-alias-bg-base: transparent !important; }
`
const CSS_HTML = (url) => `
  html {
    background-image: linear-gradient(rgba(10, 12, 16, 0.35), rgba(10, 12, 16, 0.35)), url("${url}") !important;
    background-size: cover !important;
    background-position: center !important;
    background-repeat: no-repeat !important;
    background-attachment: fixed !important;
  }
  :root { --dsw-alias-bg-base: transparent !important; }
`

function sample(img, size, points) {
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
    await sleep(10000) // 等 SPA 客户端包就绪
    report.layout = await win.webContents.executeJavaScript(`(() => {
      const b = document.body.getBoundingClientRect()
      const root = document.getElementById('root')
      const child = root && root.firstElementChild
      const c = child ? getComputedStyle(child) : null
      return {
        bodyH: Math.round(b.height), bodyW: Math.round(b.width),
        htmlClientH: document.documentElement.clientHeight,
        rootChildTag: child ? child.tagName : null,
        rootChildPos: c ? c.position : null,
        rootChildH: child ? Math.round(child.getBoundingClientRect().height) : null,
        baseVar: getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-bg-base').trim(),
      }
    })()`)

    const base = await win.webContents.capturePage()
    const size = base.getSize()
    const points = { cornerTL: [30, 30], cornerTR: [size.width - 30, 30], cornerBL: [30, size.height - 30], cornerBR: [size.width - 30, size.height - 30], center: [Math.floor(size.width / 2), Math.floor(size.height / 2)] }
    report.baseline = sample(base, size, points)

    await win.webContents.insertCSS(CSS_BODY('http://127.0.0.1:25439/bg-image?t=1'))
    await sleep(2500)
    const afterBody = await win.webContents.capturePage()
    report.cssOnBody = sample(afterBody, size, points)
    report.bodyBgComputed = await win.webContents.executeJavaScript(`getComputedStyle(document.body).backgroundImage.slice(0, 80)`)

    // 移除 body 方案，换"画在 html 上"的修复方案
    await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('style')).forEach(s => { if (s.textContent.includes('25439/bg-image')) s.remove() })`)
    await win.webContents.insertCSS(CSS_HTML('http://127.0.0.1:25439/bg-image?t=2'))
    await sleep(2500)
    const afterHtml = await win.webContents.capturePage()
    report.cssOnHtml = sample(afterHtml, size, points)

    console.log('PROBE2 REPORT:', JSON.stringify(report, null, 2))
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
  } catch (e) {
    console.error('PROBE2 FAILED:', e)
    fs.writeFileSync(OUT, JSON.stringify({ failed: String(e) }, null, 2))
  }
  app.exit(0)
})
