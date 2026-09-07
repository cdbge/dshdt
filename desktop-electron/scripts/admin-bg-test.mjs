// admin-bg-test.mjs — 单独验证 admin 服务 /bg-image 供给与格式校验（纯 Node，不依赖 Electron）
import { createAdminServer } from '../src/admin.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
let bg = ''
let lastSet = null
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-admin-bg-'))
const jpg = path.join(tmp, 'wall.jpg')
const png = path.join(tmp, 'wall.png')
fs.copyFileSync(path.join(ROOT, '..', 'dsh.jpeg'), jpg) // workspace 根 dsh.jpeg
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
fs.writeFileSync(png, PNG_1PX)

const deps = {
  log: (m) => console.log('[admin]', m),
  readSettings: () => ({ backgroundImage: bg }),
  writeSettings: () => {},
  statusPayload: () => ({ ok: true }),
  actions: {
    setAutostart: () => {}, focus: async () => ({}), openDataDir: () => {}, openWorkspace: () => {},
    openSettings: () => {}, openSettingsDocument: async () => ({}), pickDirectory: async () => ({}),
    pickBackground: async () => ({}), quit: () => {},
    setBackground: (p) => { lastSet = p; if (p === '') { bg = ''; return { ok: true, cleared: true } } return { ok: true, path: p } },
  },
  staticFiles: { settingsHtml: path.join(process.cwd(), 'src', 'settings.html') },
}

const srv = createAdminServer(deps)
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const port = srv.address().port
const base = `http://127.0.0.1:${port}`
let fail = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!cond) fail++ }

async function req(p, method = 'GET', body) {
  const r = await fetch(base + p, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const type = r.headers.get('content-type') || ''
  const buf = Buffer.from(await r.arrayBuffer())
  return { status: r.status, type, text: buf.toString('utf8'), len: buf.length }
}

// 1) 未设置背景 → 404
let r = await req('/bg-image')
ok('未设置背景时 /bg-image → 404', r.status === 404, `status=${r.status}`)

// 2) 设置 jpg 后 → 200 + image/jpeg + 字节数一致
const setR = await req('/api/background', 'POST', { path: jpg })
ok('POST /api/background (jpg)', setR.status === 200 && setR.text.includes('"ok":true'), setR.text)
bg = jpg
r = await req('/bg-image')
ok('/bg-image jpg → 200 image/jpeg', r.status === 200 && r.type === 'image/jpeg', `type=${r.type}`)
ok('/bg-image 字节一致', r.len === fs.statSync(jpg).size, `len=${r.len}`)

// 3) png → image/png
bg = png
r = await req('/bg-image')
ok('/bg-image png → 200 image/png', r.status === 200 && r.type === 'image/png', `type=${r.type}`)

// 4) 清除后 → 404
r = await req('/api/background', 'POST', { path: '' })
ok('清除背景', r.status === 200 && r.text.includes('cleared'), r.text)
r = await req('/bg-image')
ok('清除后 /bg-image → 404', r.status === 404, `status=${r.status}`)

srv.close()
fs.rmSync(tmp, { recursive: true, force: true })
console.log(fail === 0 ? '\nADMIN BG TEST: ALL PASS' : `\nADMIN BG TEST: ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
