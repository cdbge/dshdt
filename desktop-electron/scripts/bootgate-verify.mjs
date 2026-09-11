// bootgate-verify.mjs — 验证修好的启动门禁能正确判定 0.1.5 的 ready
//
// 回归样本就是真实事故树：0.1.0-rc.8 → 0.1.5-rc.2。修之前它必然超时失败（只认 res.ok，
// 而 0.1.5 的根 URL 是 303 换 cookie、fetch 无 cookie jar）。修之后必须 PASS。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBootGate } from '../src/vendor-build.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const INSTALL = 'D:\\Desktop\\DSH Desktop'
const CANDIDATES = [
  path.join(INSTALL, 'resources', 'vendor', 'staging', '0.1.5-rc.2', 'profile'),
  path.join(ROOT, 'vendor', 'profile'),
]

let profileDir = null
for (const c of CANDIDATES) {
  if (fs.existsSync(path.join(c, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) { profileDir = c; break }
}
if (profileDir === null) { console.error('找不到可用的 profile 树'); process.exit(1) }
const ver = JSON.parse(fs.readFileSync(path.join(profileDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version
console.log(`[verify] 被测树: ${profileDir}`)
console.log(`[verify] dsh 版本: ${ver}`)

const t0 = Date.now()
const r = await runBootGate({
  profileDir,
  runtime: path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
  patchFile: path.join(INSTALL, 'resources', 'desktop.patch.yml'),
  ws: os.tmpdir(),
  timeoutMs: 90000,
  log: (m) => console.log('[gate]', m),
})
const secs = ((Date.now() - t0) / 1000).toFixed(1)

console.log(`\n[verify] 耗时 ${secs}s`)
console.log(`[verify] ok=${r.ok}`)
console.log(`[verify] url=${r.url ?? '（无）'}`)
if (!r.ok) console.log(`[verify] error=${r.error}\n[verify] logTail=${r.logTail}`)
console.log(r.ok ? `\nBOOT GATE: PASS（${ver}，${secs}s）` : `\nBOOT GATE: FAIL（${ver}）`)
process.exit(r.ok ? 0 : 1)
