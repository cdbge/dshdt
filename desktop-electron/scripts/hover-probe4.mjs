// hover-probe4.mjs — 打开设置面板 → 点"桌面"导航 → CDP 悬停实测按钮高亮
import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

app.commandLine.appendSwitch('disable-gpu')
const TARGET = process.env.PROBE_URL || 'http://127.0.0.1:14113/'
const OUT = process.env.PROBE_OUT || path.join(path.dirname(fileURLToPath(import.meta.url)), 'hover-probe4-out.json')
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
    await sleep(2500)
    report.navClicked = await win.webContents.executeJavaScript(`(() => {
      const cell = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '桌面')
      if (!cell) return false
      cell.click()
      return true
    })()`)
    // 轮询等按钮渲染
    let rect = null
    for (let i = 0; i < 40 && !rect; i++) {
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
      report.styleInjected = await win.webContents.executeJavaScript(`!!Array.from(document.head.querySelectorAll('style')).find(s => s.textContent.includes('.dsh-desktop-btn:hover'))`)
      report.bgRest = await bg()
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
    console.log('HOVER4:', JSON.stringify(report, null, 2))
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
  } catch (e) {
    console.error('HOVER4 FAILED:', e)
    fs.writeFileSync(OUT, JSON.stringify({ failed: String(e) }, null, 2))
  }
  app.exit(0)
})
