// hover-probe2.mjs — 打开设置面板并实测悬停（带诊断：触发按钮、面板状态、桌面 section 存在性）
import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

app.commandLine.appendSwitch('disable-gpu')
const TARGET = process.env.PROBE_URL || 'http://127.0.0.1:14113/'
const OUT = process.env.PROBE_OUT || path.join(path.dirname(fileURLToPath(import.meta.url)), 'hover-probe2-out.json')
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
    // 找设置触发按钮：优先 aria-haspopup="dialog"；都点一遍
    report.triggers = await win.webContents.executeJavaScript(`(() => {
      const btns = [...document.querySelectorAll('button[aria-haspopup="dialog"]')]
      btns.forEach((b) => b.click())
      return btns.map((b) => (b.textContent || '').trim().slice(0, 20)).filter(Boolean)
    })()`)
    // 轮询找桌面 section 的按钮 / "桌面"标签
    let found = null
    for (let i = 0; i < 40 && !found; i++) {
      await sleep(500)
      found = await win.webContents.executeJavaScript(`(() => {
        const btn = document.querySelector('.dsh-desktop-btn')
        if (btn) {
          const r = btn.getBoundingClientRect()
          return { via: 'btn', x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), label: btn.textContent }
        }
        const label = [...document.querySelectorAll('*')].find((el) => el.children.length === 0 && (el.textContent || '').trim() === '桌面')
        if (label) return { via: 'label', foundLabel: true }
        return null
      })()`)
    }
    report.found = found
    if (found && found.via === 'btn') {
      const bg = () => win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.dsh-desktop-btn')).backgroundColor`)
      report.styleInjected = await win.webContents.executeJavaScript(`!!Array.from(document.head.querySelectorAll('style')).find(s => s.textContent.includes('.dsh-desktop-btn:hover'))`)
      report.bgRest = await bg()
      const dbg = win.webContents.debugger
      dbg.attach('1.3')
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: found.x, y: found.y, button: 'none' })
      await sleep(400)
      report.bgHover = await bg()
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, button: 'none' })
      await sleep(400)
      report.bgAway = await bg()
      dbg.detach()
    }
    console.log('HOVER2:', JSON.stringify(report, null, 2))
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
  } catch (e) {
    console.error('HOVER2 FAILED:', e)
    fs.writeFileSync(OUT, JSON.stringify({ failed: String(e) }, null, 2))
  }
  app.exit(0)
})
