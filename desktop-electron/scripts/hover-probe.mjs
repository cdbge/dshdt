// hover-probe.mjs — 交互实测：打开设置面板，CDP 移动鼠标到"桌面"section 按钮上，
// 读取悬停前后 computed background，验证悬停高亮真实生效。
import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

app.commandLine.appendSwitch('disable-gpu')
const TARGET = process.env.PROBE_URL || 'http://127.0.0.1:6901/'
const OUT = process.env.PROBE_OUT || path.join(path.dirname(fileURLToPath(import.meta.url)), 'hover-probe-out.json')
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
    // 打开设置面板（与壳 openDshSettings 相同的稳定触发语义）
    const opened = await win.webContents.executeJavaScript(`(() => {
      const btn = document.querySelector('button[aria-haspopup="dialog"]')
      if (!btn) return 'no-trigger'
      btn.click()
      return 'clicked'
    })()`)
    report.trigger = opened
    // 等"桌面"section 的按钮渲染
    let rect = null
    for (let i = 0; i < 30 && !rect; i++) {
      await sleep(500)
      rect = await win.webContents.executeJavaScript(`(() => {
        const btn = document.querySelector('.dsh-desktop-btn')
        if (!btn) return null
        const r = btn.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), label: btn.textContent }
      })()`)
    }
    report.button = rect
    if (rect) {
      const bg = () => win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.dsh-desktop-btn')).backgroundColor`)
      const styleOk = await win.webContents.executeJavaScript(`!!Array.from(document.head.querySelectorAll('style')).find(s => s.textContent.includes('.dsh-desktop-btn:hover'))`)
      report.styleInjected = styleOk
      report.bgRest = await bg()
      // CDP 驱动真实鼠标移动 → :hover 生效
      const dbg = win.webContents.debugger
      dbg.attach('1.3')
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none' })
      await sleep(400)
      report.bgHover = await bg()
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, button: 'none' })
      await sleep(400)
      report.bgAway = await bg()
      dbg.detach()
    }
    console.log('HOVER PROBE:', JSON.stringify(report, null, 2))
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
  } catch (e) {
    console.error('HOVER PROBE FAILED:', e)
    fs.writeFileSync(OUT, JSON.stringify({ failed: String(e) }, null, 2))
  }
  app.exit(0)
})
