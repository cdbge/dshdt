// bg-probe3.mjs — DOM 结构诊断：找出真实 SPA 里盖住整个视口的不透明层与 shadow DOM
import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

app.commandLine.appendSwitch('disable-gpu')
const TARGET = process.env.PROBE_URL || 'http://127.0.0.1:8021/'
const OUT = process.env.PROBE_OUT || path.join(path.dirname(fileURLToPath(import.meta.url)), 'bg-probe3-out.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1200, height: 800, paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  try {
    await win.loadURL(TARGET)
    await sleep(10000)
    const report = await win.webContents.executeJavaScript(`(() => {
      const out = {}
      out.ua = navigator.userAgent.slice(0, 60)
      // 1) shadow DOM 统计
      let shadowCount = 0
      const walker = (root) => {
        const all = root.querySelectorAll('*')
        for (const el of all) {
          if (el.shadowRoot) { shadowCount++; walker(el.shadowRoot) }
        }
      }
      walker(document)
      out.shadowRoots = shadowCount
      out.bodyShadow = !!document.body.shadowRoot
      out.rootShadow = !!document.getElementById('root')?.shadowRoot
      // 2) 盖满视口的顶层元素（面积 >= 70% 视口），取前 8 个，按 z/顺序
      const vw = document.documentElement.clientWidth
      const vh = document.documentElement.clientHeight
      const hits = []
      for (const el of document.querySelectorAll('div, section, main')) {
        const r = el.getBoundingClientRect()
        if (r.width >= vw * 0.7 && r.height >= vh * 0.7 && r.width <= vw * 1.5 && r.height <= vh * 1.5) {
          const cs = getComputedStyle(el)
          hits.push({
            tag: el.tagName, cls: String(el.className).slice(0, 50), id: el.id,
            w: Math.round(r.width), h: Math.round(r.height),
            bg: cs.backgroundColor, bgImage: cs.backgroundImage.slice(0, 60),
            pos: cs.position, z: cs.zIndex, inShadow: el.getRootNode() !== document,
          })
        }
      }
      out.fullViewport = hits.slice(0, 8)
      // 3) html/body/#root 层
      out.htmlBg = getComputedStyle(document.documentElement).backgroundColor
      out.bodyBg = getComputedStyle(document.body).backgroundColor
      out.bodyH = Math.round(document.body.getBoundingClientRect().height)
      const root = document.getElementById('root')
      out.rootChildren = root ? root.children.length : -1
      out.rootFirstChild = root && root.firstElementChild ? { tag: root.firstElementChild.tagName, cls: String(root.firstElementChild.className).slice(0, 50), h: Math.round(root.firstElementChild.getBoundingClientRect().height), bg: getComputedStyle(root.firstElementChild).backgroundColor } : null
      // 4) 主题变量到底定义在哪
      const probes = ['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1']
      out.varLocations = {}
      for (const v of probes) {
        out.varLocations[v] = { html: getComputedStyle(document.documentElement).getPropertyValue(v).trim() }
        if (out.bodyShadow) out.varLocations[v].bodyShadow = getComputedStyle(document.body.shadowRoot?.firstElementChild || document.body).getPropertyValue(v).trim()
      }
      return out
    })()`)
    console.log('PROBE3 REPORT:', JSON.stringify(report, null, 2))
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
  } catch (e) {
    console.error('PROBE3 FAILED:', e)
    fs.writeFileSync(OUT, JSON.stringify({ failed: String(e) }, null, 2))
  }
  app.exit(0)
})
