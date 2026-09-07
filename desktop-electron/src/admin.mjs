// admin HTTP 服务（127.0.0.1 仅回环）。API 面与 v1 desktop-shell/launcher.mjs 完全一致
// （/ /settings.html /icon.ico /health /api/status /api/autostart /api/settings /api/workspace
//  /api/focus /api/open-data-dir /api/open-workspace /api/open-settings /api/quit），
// 保证 settings.html 与 smoke 断言在两个分支（Node+Chrome / Electron）通用。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 65536) { reject(new Error('body too large')); req.destroy() } })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function json(res, code, obj) {
  const s = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s), 'Cache-Control': 'no-store' })
  res.end(s)
}

// 背景图片支持的格式（扩展名白名单 + MIME；jpg/png/webp 为主流）
const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif', '.ico': 'image/x-icon',
}

/**
 * deps: {
 *   log(msg), readSettings(), writeSettings(s), statusPayload(),
 *   actions: { setAutostart(on), focus(), openDataDir(), openWorkspace(), openSettings(), quit(code) },
 *   staticFiles: { settingsHtml, icon? }
 * }
 */
export function createAdminServer(deps) {
  const { log = () => {}, readSettings, writeSettings, statusPayload, actions, staticFiles } = deps
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    // CORS：仅放行回环来源（DSH SPA 运行在随机 webPort，设置面板 section 跨端口访问本服务）
    const origin = req.headers.origin
    if (origin && /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    try {
      // 自定义背景图片：经回环 HTTP 供给 SPA。Chromium 禁止 http(s) 页面加载 file:// 本地资源
      // （0.4.1 背景图在朋友机器上不显示的根因），所以图片必须走本回环服务，绝不出主机。
      if (req.method === 'GET' && u.pathname === '/bg-image') {
        const p = String((readSettings() || {}).backgroundImage || '')
        if (!p || !fs.existsSync(p)) return json(res, 404, { ok: false, error: 'no background image' })
        const data = fs.readFileSync(p)
        const mime = MIME_BY_EXT[path.extname(p).toLowerCase()] || 'application/octet-stream'
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length, 'Cache-Control': 'no-store' })
        return res.end(data)
      }
      if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/settings.html')) {
        const html = fs.readFileSync(staticFiles.settingsHtml)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        return res.end(html)
      }
      if (req.method === 'GET' && u.pathname === '/icon.ico' && staticFiles.icon) {
        const ico = fs.readFileSync(staticFiles.icon)
        res.writeHead(200, { 'Content-Type': 'image/x-icon' })
        return res.end(ico)
      }
      if (req.method === 'GET' && u.pathname === '/health') return json(res, 200, { ok: true, pid: process.pid })
      if (req.method === 'GET' && u.pathname === '/api/status') return json(res, 200, statusPayload())
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}')
        switch (u.pathname) {
          case '/api/autostart': {
            const s = readSettings(); s.autostart = !!body.on
            writeSettings(s); actions.setAutostart(s.autostart)
            return json(res, 200, { ok: true, autostart: s.autostart })
          }
          case '/api/settings': {
            const s = readSettings()
            for (const k of ['minimizeToTray', 'warnedPs7']) if (typeof body[k] === 'boolean') s[k] = body[k]
            writeSettings(s)
            return json(res, 200, { ok: true, settings: s })
          }
          case '/api/workspace': {
            const p = String(body.path || '').trim()
            if (!p || !path.isAbsolute(p)) return json(res, 400, { ok: false, error: '需要绝对路径' })
            try { fs.mkdirSync(p, { recursive: true }) } catch (e) { return json(res, 400, { ok: false, error: `目录不可用: ${e.message}` }) }
            actions.setWorkspace(p)
            return json(res, 200, { ok: true, workspace: p })
          }
          case '/api/focus': return json(res, 200, await actions.focus())
          case '/api/open-settings-document': return json(res, 200, await actions.openSettingsDocument())
          case '/api/pick-directory': return json(res, 200, await actions.pickDirectory())
          case '/api/pick-background': return json(res, 200, await actions.pickBackground())
          case '/api/background': {
            const p = String(body.path || '').trim()
            const r = actions.setBackground(p)
            return json(res, r.ok ? 200 : 400, r)
          }
          case '/api/open-data-dir': await actions.openDataDir(); return json(res, 200, { ok: true })
          case '/api/open-workspace': await actions.openWorkspace(); return json(res, 200, { ok: true })
          case '/api/open-settings': await actions.openSettings(); return json(res, 200, { ok: true })
          case '/api/quit': {
            // 等响应完整送达再退出，避免 keep-alive 连接被掐断
            res.setHeader('Connection', 'close')
            json(res, 200, { ok: true })
            res.once('close', () => setTimeout(() => actions.quit(0), 100))
            setTimeout(() => actions.quit(0), 3000) // 兜底：客户端消失也要退出
            return
          }
          default: return json(res, 404, { ok: false, error: 'not found' })
        }
      }
      return json(res, 404, { ok: false, error: 'not found' })
    } catch (e) {
      try { json(res, 400, { ok: false, error: e.message }) } catch { /* 连接已断 */ }
    }
  })
}

export function listenAdmin(server, preferredPort) {
  return new Promise((resolve, reject) => {
    server.on('error', (e) => {
      // 固定端口被占（罕见：单实例锁下只有端口冲突）→ 回退系统分配
      if (preferredPort && e.code === 'EADDRINUSE') {
        server.listen(0, '127.0.0.1')
        return
      }
      reject(e)
    })
    server.listen(preferredPort || 0, '127.0.0.1', () => resolve(server.address().port))
  })
}
