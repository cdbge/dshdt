// compare-packaged-vendor.mjs — 对比各平台打包产物内的 vendor 树：① 非平台专属包集合一致；
// ② 同名包版本一致；③ 用户可见的关键件每棵树都有。平台专属包的存在性由 verify-cross-tree 与各平台构建门禁负责。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// 平台专属的包名片段：这些包在各平台本就不同，比对时必须剔除
const PLATFORM_TAGS = ['win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64',
  'sharp-libvips', 'sharp-wasm32']

// 读一棵 vendor 树的包表，返回 {packages, tag, files} 或 null
function readTree(vendorDir) {
  const nm = path.join(vendorDir, 'profile', 'node_modules')
  if (!fs.existsSync(nm)) return null
  const lockPath = path.join(vendorDir, 'vendor.lock.json')
  let tag = null
  try { tag = JSON.parse(fs.readFileSync(lockPath, 'utf8')).platform?.tag ?? null } catch { /* 没 lock 也读树 */ }
  const packages = new Map()
  const addPkg = (absDir, name) => {
    if (packages.has(name)) return
    let version = '?'
    try { version = JSON.parse(fs.readFileSync(path.join(absDir, 'package.json'), 'utf8')).version ?? '?' } catch { /* 略 */ }
    packages.set(name, version)
  }
  for (const e of fs.readdirSync(nm, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    if (e.name.startsWith('@')) {
      for (const s of fs.readdirSync(path.join(nm, e.name), { withFileTypes: true })) {
        if (s.isDirectory()) addPkg(path.join(nm, e.name, s.name), `${e.name}/${s.name}`)
      }
    } else if (e.name !== 'node_modules') {
      addPkg(path.join(nm, e.name), e.name)
    }
  }
  let files = 0
  const count = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) count(path.join(d, e.name)); else files += 1 } }
  try { count(nm) } catch { /* 略 */ }
  return { packages, tag, files }
}

const isPlatformSpecific = (name) => PLATFORM_TAGS.some((t) => name.includes(t))

// 待比对的对象：命令行传入，或自动发现 dist/ 里的产物
const args = process.argv.slice(2)
const targets = []
if (args.length > 0) {
  for (const a of args) targets.push({ label: a, dir: path.resolve(ROOT, a) })
} else {
  const dist = path.join(ROOT, 'dist')
  // Windows：解包目录（installer 内部就是它）
  if (fs.existsSync(path.join(dist, 'win-unpacked', 'resources', 'vendor'))) {
    targets.push({ label: 'win-unpacked', dir: path.join(dist, 'win-unpacked', 'resources', 'vendor') })
  }
  // Linux 侧：解包目录，以及从 deb / AppImage 里取出来的（本机由 WSL 验证脚本解到 .tmp-cross 下）
  if (fs.existsSync(path.join(dist, 'linux-unpacked', 'resources', 'vendor'))) {
    targets.push({ label: 'linux-unpacked', dir: path.join(dist, 'linux-unpacked', 'resources', 'vendor') })
  }
  for (const [label, rel] of [
    ['deb（装完后取出）', '.tmp-cross/extracted-deb/resources/vendor'],
    ['appimage（extract 后）', '.tmp-cross/extracted-appimage/resources/vendor'],
  ]) {
    const p = path.join(ROOT, rel)
    if (fs.existsSync(p)) targets.push({ label, dir: p })
  }
}

if (targets.length < 2) {
  console.error(`[parity] 至少需要两个可读的 vendor 树，当前 ${targets.length} 个：`)
  for (const t of targets) console.error(`  - ${t.label}: ${t.dir}`)
  process.exit(2)
}

let fail = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!cond) fail++ }

const trees = targets.map((t) => ({ ...t, data: readTree(t.dir) })).filter((t) => t.data !== null)
console.log(`[parity] 比对 ${trees.length} 棵打包树：`)
for (const t of trees) {
  const shown = t.dir.startsWith(ROOT) ? path.relative(ROOT, t.dir) : t.dir
  console.log(`  - ${t.label.padEnd(22)} ${t.data.tag ?? '(无 lock)'}  ${t.data.packages.size} 个包 / ${t.data.files} 文件  ${shown}`)
}

// ① 非平台专属包的集合必须一致
const baseline = trees[0]
const baseNames = [...baseline.data.packages.keys()].filter((n) => !isPlatformSpecific(n)).sort()
console.log(`\n[① 包集合] 以「${baseline.label}」为基准，非平台专属包 ${baseNames.length} 个`)
for (const t of trees.slice(1)) {
  const names = new Set([...t.data.packages.keys()].filter((n) => !isPlatformSpecific(n)))
  const missing = baseNames.filter((n) => !names.has(n))
  const extra = [...names].filter((n) => !baseNames.includes(n))
  ok(`「${t.label}」包含基准的全部非平台专属包`, missing.length === 0,
    missing.length > 0 ? `缺 ${missing.length} 个：${missing.slice(0, 8).join(', ')}` : `${names.size} 个`)
  if (extra.length > 0) console.log(`        （多出 ${extra.length} 个：${extra.slice(0, 8).join(', ')}）`)
}

console.log('\n[② 版本一致性]')
for (const t of trees.slice(1)) {
  const diff = []
  for (const [name, ver] of t.data.packages) {
    const baseVer = baseline.data.packages.get(name)
    if (baseVer !== undefined && baseVer !== ver) diff.push(`${name}: ${baseVer} vs ${ver}`)
  }
  ok(`「${t.label}」与基准的同名包版本一致`, diff.length === 0,
    diff.length > 0 ? `${diff.length} 处不同：${diff.slice(0, 5).join(' | ')}` : '全部一致')
}

console.log('\n[③ 关键件存在性]')
const REQUIRED = [
  ['@deepseek-ai/dsh', 'DSH 本体'],
  ['@deepseek-ai/dsh-web-app', 'Web 应用'],
  ['dsh-desktop-ui', '自带插件：桌面皮肤/设置面板'],
  ['dsh-auto-approval', '自带插件：审批'],
  ['koffi', '原生依赖（COM/目录选择）'],
  ['node-pty', '终端/持久 shell'],
  ['sharp', '图片处理'],
]
for (const t of trees) {
  for (const [name, what] of REQUIRED) {
    ok(`「${t.label}」含 ${what}（${name}）`, t.data.packages.has(name), t.data.packages.get(name) ?? '缺失')
  }
}

console.log(fail === 0 ? '\nPACKAGED VENDOR PARITY: ALL PASS' : `\nPACKAGED VENDOR PARITY: ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
