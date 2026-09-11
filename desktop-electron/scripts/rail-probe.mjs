// rail-probe.mjs — 只读探针：dump DSH 会话右侧「导航轨道」的真实 DOM 与计算样式
//
// 用途：这类元素的"看不见"有多种成因（被壳的壁纸透明层吃掉 / 位置计算为 0 / 颜色与壁纸同色 /
// 根本没渲染），光看代码猜不出来。规范坑 3b 的教训：**计算样式正确 ≠ 视觉可见**，
// 必须拿真实渲染结果说话。本探针不改任何东西，只读。
//
// 用法：electron.exe scripts\rail-probe.mjs
//   PROBE_URL  目标（默认取 DSH_WEB_URL）
//   PROBE_OUT  报告输出（默认写工作区 .dsh-inspect，不落仓库脚本目录——坑 21）
import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

app.commandLine.appendSwitch('disable-gpu')
const TARGET = process.env.PROBE_URL || process.env.DSH_WEB_URL || 'http://127.0.0.1:3547/'
const WORKSPACE = 'D:\\Desktop\\deepseek'
const OUT = process.env.PROBE_OUT || path.join(WORKSPACE, '.dsh-inspect', 'rail-probe-out.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 页内取样式摘要：只留判断"可见性"必需的几项，避免报告爆炸。 */
const SNAPSHOT_FN = `(el) => {
  const cs = getComputedStyle(el)
  const r = el.getBoundingClientRect()
  return {
    tag: el.tagName.toLowerCase(),
    cls: String(el.className || '').slice(0, 120),
    id: el.id || '',
    rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    position: cs.position, display: cs.display, visibility: cs.visibility,
    opacity: cs.opacity, zIndex: cs.zIndex,
    bg: cs.backgroundColor, bgImage: cs.backgroundImage === 'none' ? 'none' : cs.backgroundImage.slice(0, 60),
    borderLeft: cs.borderLeftWidth + ' ' + cs.borderLeftStyle + ' ' + cs.borderLeftColor,
    borderTop: cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor,
    overflow: cs.overflow,
    childCount: el.children.length,
    text: (el.textContent || '').trim().slice(0, 40),
  }
}`

app.whenReady().then(async () => {
  const report = { target: TARGET, at: new Date().toISOString() }
  const win = new BrowserWindow({
    show: false, width: 1280, height: 860, paintWhenInitiallyHidden: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  try {
    await win.loadURL(TARGET)
    await sleep(9000)   // 坑 21①：隐藏窗口不重绘，注入后要等，否则拿到陈旧帧

    report.viewport = await win.webContents.executeJavaScript(
      `({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })`)

    // 1) 右侧 20% 区域内的"细长竖直"元素——导航轨道及其刻度都在这里
    report.rightStrip = await win.webContents.executeJavaScript(`(() => {
      const snap = ${SNAPSHOT_FN}
      const vw = innerWidth
      const out = []
      for (const el of document.querySelectorAll('#root *')) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        if (r.x < vw * 0.80) continue
        if (r.width > 60) continue          // 只关心细长条
        if (r.height < 20) continue
        out.push(snap(el))
      }
      return out.slice(0, 40)
    })()`)

    // 2) 类名含 rail / track / marker / tick / indicator 的元素（全视口，不限右侧）
    report.byName = await win.webContents.executeJavaScript(`(() => {
      const snap = ${SNAPSHOT_FN}
      const re = /rail|track|marker|tick|indicator|scrollbar|overview|timeline/i
      const out = []
      for (const el of document.querySelectorAll('#root *')) {
        const cls = String(el.className || '')
        if (!re.test(cls)) continue
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        out.push(snap(el))
      }
      return out.slice(0, 40)
    })()`)

    // 3) 根层不透明层清单——壳的壁纸功能依赖把这几类置透明（坑 3b/22），
    //    顺便看右侧轨道是否落在了某个被置透明的层里
    report.opaqueRoots = await win.webContents.executeJavaScript(`(() => {
      const snap = ${SNAPSHOT_FN}
      const out = []
      for (const el of document.querySelectorAll('#root > *, #root > * > *')) {
        const cs = getComputedStyle(el)
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        out.push(snap(el))
      }
      return out.slice(0, 20)
    })()`)

    // 4) 复现壳的壁纸透明规则（只取透明部分，不带图）——探针直接开 URL 是**绕过壳**的，
    //    不注入这段就测不到壳注入 CSS 之后的样子。用纯色底模拟壁纸，便于看"线"是否刺眼。
    await win.webContents.insertCSS(`
      html { background-color: #2b3a4a !important; }
      body { background-color: transparent !important; background-image: none !important; }
      #root > div,
      #root [class$="_frame"],
      #root [class$="_root"],
      #root [class$="_centerCol"] { background-color: transparent !important; }
      :root, body, body[data-ds-dark-theme], body[data-ds-light-theme] { --dsw-alias-bg-base: transparent !important; }
    `)
    await sleep(1500)

    // 5) 全视口扫"视觉上是细线"的元素：极窄或极扁，且不是整页容器
    report.thinLines = await win.webContents.executeJavaScript(`(() => {
      const snap = ${SNAPSHOT_FN}
      const out = []
      for (const el of document.querySelectorAll('#root, #root *')) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 && r.height === 0) continue
        const vertical = r.width <= 4 && r.height >= 16          // 竖细线
        const horizontal = r.height <= 4 && r.width >= 16        // 横细线
        if (!vertical && !horizontal) continue
        const cs = getComputedStyle(el)
        // 只有"看得见"的线才算：背景或边框有非透明色
        const hasBg = cs.backgroundColor && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(cs.backgroundColor)
        const hasBorder = ['Top','Right','Bottom','Left'].some((s) => {
          const w = cs['border' + s + 'Width'], st = cs['border' + s + 'Style']
          return parseFloat(w) > 0 && st !== 'none'
        })
        if (!hasBg && !hasBorder) continue
        const s = snap(el)
        s.orient = vertical ? '竖直' : '横向'
        s.borders = ['Top','Right','Bottom','Left']
          .map((k) => cs['border' + k + 'Width'] + '/' + cs['border' + k + 'Color'])
          .join(' ')
        out.push(s)
      }
      return out.slice(0, 60)
    })()`)

    // 6) 截图：文字与数字描述不了"看起来是什么样"，直接出图最省事（规范坑 3b：必须以视觉为准）
    try {
      const img = await win.webContents.capturePage()
      const shot = path.join(path.dirname(OUT), 'rail-probe-shot.png')
      fs.writeFileSync(shot, img.toPNG())
      report.screenshot = shot
      console.log('截图: ' + shot)
    } catch (e) { report.screenshotError = String(e) }

    console.log('RAIL-PROBE OK')
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
    console.log('报告已写入: ' + OUT)
  } catch (e) {
    console.error('RAIL-PROBE FAILED:', e)
    fs.writeFileSync(OUT, JSON.stringify({ failed: String(e) }, null, 2))
  }
  app.exit(0)
})
