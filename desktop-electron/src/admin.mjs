// admin.mjs — 回环地址（127.0.0.1）上的 admin HTTP 服务。
// API 面与 v1 desktop-shell/launcher.mjs 一致，保证 settings.html 与 smoke 断言在两个分支通用。
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

// 背景图片支持的扩展名与 MIME
const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif', '.ico': 'image/x-icon',
}

/**
 * deps: { log(msg), readSettings(), writeSettings(s), statusPayload(),
 *   actions: { setAutostart, focus, openDataDir, openWorkspace, openSettings, quit, readLogs },
 *   staticFiles: { settingsHtml, logsHtml?, icon? } }
 */
export function createAdminServer(deps) {
  const { log = () => {}, readSettings, writeSettings, statusPayload, actions, staticFiles } = deps
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1')
    // CORS：仅放行回环来源（DSH SPA 跑在随机 webPort，设置面板 section 跨端口访问本服务）
    const origin = req.headers.origin
    if (origin && /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    try {
      // Chromium 禁止 http 页面加载 file:// 本地资源，图片必须走本回环服务，绝不出主机
      if (req.method === 'GET' && u.pathname === '/bg-image') {
        const p = String((readSettings() || {}).backgroundImage || '')
        if (!p || !fs.existsSync(p)) return json(res, 404, { ok: false, error: 'no background image' })
        const data = fs.readFileSync(p)
        const mime = MIME_BY_EXT[path.extname(p).toLowerCase()] || 'application/octet-stream'
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length, 'Cache-Control': 'no-store' })
        return res.end(data)
      }
      // 左侧栏独立图片：供给方式同 /bg-image；URL 不带 ?t=，靠 no-store 保证换图即时生效
      if (req.method === 'GET' && u.pathname === '/sidebar-image') {
        const p = String((readSettings() || {}).sidebarBgImage || '')
        if (!p || !fs.existsSync(p)) return json(res, 404, { ok: false, error: 'no sidebar background image' })
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
      // 后台日志查看页（壳内独立窗口，Ctrl+Shift+L 开/关），页面只读
      if (req.method === 'GET' && u.pathname === '/logs' && staticFiles.logsHtml) {
        const html = fs.readFileSync(staticFiles.logsHtml)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        return res.end(html)
      }
      // 不带 file = 列可看的日志文件；带 file = 返回该文件末尾 N 行，只允许白名单文件名
      if (req.method === 'GET' && u.pathname === '/api/logs') {
        if (typeof actions.readLogs !== 'function') return json(res, 200, { ok: false, error: '日志查看未装配' })
        return json(res, 200, actions.readLogs(String(u.searchParams.get('file') || ''), Number(u.searchParams.get('lines') || 400)))
      }
      if (req.method === 'GET' && u.pathname === '/icon.ico' && staticFiles.icon) {
        const ico = fs.readFileSync(staticFiles.icon)
        res.writeHead(200, { 'Content-Type': 'image/x-icon' })
        return res.end(ico)
      }
      if (req.method === 'GET' && u.pathname === '/health') return json(res, 200, { ok: true, pid: process.pid })
      if (req.method === 'GET' && u.pathname === '/api/status') return json(res, 200, statusPayload())
      // DSH 更新状态：只读快照，构建进度靠客户端 5 秒轮询读它，所以这里不联网、不阻塞
      if (req.method === 'GET' && u.pathname === '/api/dsh/status') return json(res, 200, actions.dshStatus())
      // 市场目录：只读快照，不联网
      if (req.method === 'GET' && u.pathname === '/api/market/catalog') return json(res, 200, actions.marketCatalog())
      // 安装前置体检：pnpm 在不在。不自动装——改用户环境要他自己点头
      if (req.method === 'GET' && u.pathname === '/api/market/preflight') return json(res, 200, actions.marketPreflight())
      // 平面 C 的账本快照（只读，不联网）；真正联网的比对在 POST /api/repo-update/check
      if (req.method === 'GET' && u.pathname === '/api/repo-update/state') return json(res, 200, actions.repoUpdateState())
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
            // 布尔开关只接受显式 true/false，其它类型忽略（避免 "false" 字符串把开关写坏）
            for (const k of [
              'minimizeToTray', 'warnedPs7',
              // 遮罩与毛玻璃的开关与强度分开存：靠"强度=0"表示关的话，用户拖到 0 就再也开不回来。
              // 键名与迁移规则在 `src/skin-settings.mjs`。
              'railMaskEnabled', 'conversationMaskEnabled', 'fullscreenMaskEnabled', 'sidebarMaskEnabled',
              // 白名单不含已删除的 glassDialog*（存量值留在 settings.json 里被忽略）
              'glassChatEnabled', 'glassInputEnabled',
            ]) if (typeof body[k] === 'boolean') s[k] = body[k]
            // 壁纸调参：亮度 0.2~2、模糊 0~40 px；越界钳制、非数字忽略
            for (const k of ['bgBrightness', 'bgBlur']) {
              if (body[k] === undefined) continue
              const v = Number(body[k])
              if (!Number.isFinite(v)) continue
              s[k] = k === 'bgBrightness' ? Math.min(2, Math.max(0.2, v)) : Math.min(40, Math.max(0, v))
            }
            // 遮罩与毛玻璃强度（0~1），必须在 writeSettings 之前赋值
            for (const k of ['railMaskOpacity', 'conversationMaskOpacity', 'fullscreenMaskOpacity', 'glassChatOpacity', 'glassInputOpacity']) {
              if (body[k] === undefined) continue
              const v = Number(body[k])
              if (!Number.isFinite(v)) continue
              s[k] = Math.min(1, Math.max(0, v))
            }
            // 左侧栏背景：模式是枚举（非法值忽略），遮挡 0~1。
            // 只存原值——"左侧栏更不透明"由客户端写 CSS 变量时取 max 实现，否则滑块回读会跳
            if (body.sidebarBgMode !== undefined && ['extend', 'own'].includes(body.sidebarBgMode)) {
              s.sidebarBgMode = body.sidebarBgMode
            }
            if (body.sidebarOpacity !== undefined) {
              const v = Number(body.sidebarOpacity)
              if (Number.isFinite(v)) s.sidebarOpacity = Math.min(1, Math.max(0, v))
            }
            writeSettings(s)
            if (body.bgBrightness !== undefined || body.bgBlur !== undefined) actions.reapplyBackground()
            return json(res, 200, { ok: true, settings: s })
          }
          case '/api/workspace': {
            const p = String(body.path || '').trim()
            if (!p || !path.isAbsolute(p)) return json(res, 400, { ok: false, error: '需要绝对路径' })
            try { fs.mkdirSync(p, { recursive: true }) } catch (e) { return json(res, 400, { ok: false, error: `目录不可用: ${e.message}` }) }
            actions.setWorkspace(p)
            return json(res, 200, { ok: true, workspace: p })
          }
          case '/api/restart-host': return json(res, 200, await actions.restartHost())
          // DSH 更新：check 联网查；update 启动分钟级构建（立即返回，进度看 GET /api/dsh/status）；
          // apply 写标记并重启应用（换树在新进程启动最早期完成）
          case '/api/dsh/check': return json(res, 200, await actions.dshCheck())
          case '/api/dsh/update': return json(res, 200, await actions.dshUpdate(String(body.version || ''), { allowUnsafeJump: body.allowUnsafeJump === true }))
          case '/api/dsh/apply': return json(res, 200, await actions.dshApply())
          // 平面 C（按 GitHub 仓库文件更新）：check 只读比对，apply 才落盘
          case '/api/repo-update/check': return json(res, 200, await actions.repoUpdateCheck())
          case '/api/repo-update/apply': return json(res, 200, await actions.repoUpdateApply())
          // 壳自身那一层：换 app.asar 并重启应用。响应发出后应用即退出，
          // 客户端多半拿到"成功但连接随即断开"——这是预期，不是错误
          case '/api/repo-update/shell': return json(res, 200, await actions.repoUpdateShell())
          // 市场下载：把下载地址交给系统默认方式；壳自己不下载、不解包、不写 $DSH_HOME
          case '/api/market/open-download': return json(res, 200, await actions.marketOpenDownload(String(body.id || '')))
          // 【临时排障端点】量市场弹窗的真实几何，用完即删
          case '/api/diag/market-geom': {
            if (typeof actions.diagMarketGeom !== 'function') return json(res, 200, { ok: false, error: '探针未装配' })
            return json(res, 200, await actions.diagMarketGeom())
          }
          // 市场安装：会写 $DSH_HOME（下载→校验 sha256→安全解包→落盘→挂载），耗时到分钟级
          case '/api/market/install': return json(res, 200, await actions.marketInstall(String(body.id || '')))
          case '/api/diag/opaque-layers': return json(res, 200, await actions.diagOpaqueLayers(String(body.region || 'bottom')))
          case '/api/diag/ui': return json(res, 200, await actions.diagUi())
          case '/api/focus': return json(res, 200, await actions.focus())
          case '/api/open-settings-document': return json(res, 200, await actions.openSettingsDocument())
          case '/api/pick-directory': return json(res, 200, await actions.pickDirectory())
          case '/api/pick-background': return json(res, 200, await actions.pickBackground())
          case '/api/background': {
            const p = String(body.path || '').trim()
            const r = actions.setBackground(p)
            return json(res, r.ok ? 200 : 400, r)
          }
          case '/api/pick-sidebar-background': return json(res, 200, await actions.pickSidebarBackground())
          case '/api/sidebar-background': {
            const p = String(body.path || '').trim()
            const r = actions.setSidebarBackground(p)
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
      // 固定端口被占 → 回退系统分配
      if (preferredPort && e.code === 'EADDRINUSE') {
        server.listen(0, '127.0.0.1')
        return
      }
      reject(e)
    })
    server.listen(preferredPort || 0, '127.0.0.1', () => resolve(server.address().port))
  })
}
