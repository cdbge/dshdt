// gen-components.mjs — 生成/校验「从仓库热更新」用的组件清单（`components.json`）
//
// 清单是**唯一一份"仓库里有哪些可热更新的文件"的声明**：壳按它比对本地、按需下载、逐个 sha256 校验。
// 所以它必须进仓库、且必须**与 packages/ 和 src/ 的真实内容一致**——不一致的后果很隐蔽：
//   清单少了一条 → 那个文件永远不会被热更新（用户点了按钮也没变化）；
//   清单多了一条 → 下载下来永远是 404，整个组件失败（比少一条更容易发现）。
//
// 用法：
//   node scripts/gen-components.mjs           # 写清单（改了插件/壳源码后必跑）
//   node scripts/gen-components.mjs --check    # 只校验：清单是不是当前内容生成的（CI 门禁用）
//
// 口径（刻意保守）：
//   · profile-plugin 只收 `package.json` + `lib/**`——运行时真正加载的就是这两处；
//     `test/**` 不进（占字节、且热更新到用户机器上毫无意义）；
//   · home-file 是"落到 $DSH_HOME 的单文件"：补丁层、市场目录；
//   · shell-asar 收 `src/**` + `VERSION` + `package.json`——与 electron-builder.yml 的 `files:`
//     完全同源（那三项就是打进 app.asar 的东西），少一项就会出现"壳源码被热更新了一半"。
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'components.json')
/** 仓库根相对路径的前缀：清单里所有 repoPath 都以它开头（壳用 raw.githubusercontent 拼 URL）。 */
const REPO_PREFIX = 'desktop-electron/'
/** 顺序固定，保证生成物可复现（diff 干净）。 */
const PLUGINS = ['dsh-desktop-ui', 'dsh-auto-approval', 'dsh-market']

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/** 递归列目录下的文件（相对路径，POSIX 分隔符，字典序）。跳过 node_modules 与点文件。 */
function listFiles(dir) {
  const out = []
  const walk = (d, rel) => {
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const abs = path.join(d, e.name)
      const r = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) walk(abs, r)
      else if (e.isFile()) out.push(r)
    }
  }
  walk(dir, '')
  return out.sort()
}

/** 一条文件记录（repoPath 是仓库根相对路径）。 */
function fileRecord(relInComponent, abs, repoRelDir) {
  const buf = fs.readFileSync(abs)
  const prefix = repoRelDir === '.' || repoRelDir === '' ? REPO_PREFIX : `${REPO_PREFIX}${repoRelDir}/`
  return { path: relInComponent, repoPath: `${prefix}${relInComponent}`, sha256: sha256(buf), size: buf.length }
}

function pluginComponent(name) {
  const dir = path.join(ROOT, 'packages', name)
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const files = []
  files.push(fileRecord('package.json', path.join(dir, 'package.json'), `packages/${name}`))
  for (const rel of listFiles(path.join(dir, 'lib'))) files.push(fileRecord(`lib/${rel}`, path.join(dir, 'lib', rel), `packages/${name}`))
  return { id: name, kind: 'profile-plugin', dest: name, title: (pkg.description ?? name).split('：')[0].slice(0, 40), version: pkg.version ?? null, files }
}

function homeFileComponent({ id, title, dest, repoPath }) {
  const abs = path.join(ROOT, repoPath)
  const buf = fs.readFileSync(abs)
  return { id, kind: 'home-file', dest, title, files: [{ path: dest, repoPath: `${REPO_PREFIX}${repoPath}`, sha256: sha256(buf), size: buf.length }] }
}

function shellComponent() {
  const files = []
  for (const rel of listFiles(path.join(ROOT, 'src'))) {
    // 路径形如 `src/admin.mjs`（asar 内的路径），repoPath 则是仓库根相对路径 `desktop-electron/src/admin.mjs`
    files.push(fileRecord(`src/${rel}`, path.join(ROOT, 'src', rel), '.'))
  }
  for (const rel of ['VERSION', 'package.json']) {
    const abs = path.join(ROOT, rel)
    if (!fs.existsSync(abs)) continue
    files.push(fileRecord(rel, abs, '.'))
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  return {
    id: 'shell',
    kind: 'shell-asar',
    title: '桌面壳本体（app.asar 内的源码）',
    version: pkg.version ?? null,
    files,
  }
}

/** 生成清单对象（纯函数式的"按当前磁盘内容算一遍"）。 */
export function buildManifest() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  return {
    schema: 1,
    // 生成时间**不进清单**：它每次都会变，会让 `--check` 永远失败、diff 全是噪声。
    // 需要"这份清单多老"时看 git 提交时间即可（清单进仓库）。
    generator: 'scripts/gen-components.mjs',
    shellVersion: pkg.version ?? null,
    components: [
      ...PLUGINS.map(pluginComponent),
      homeFileComponent({ id: 'desktop-patch', title: '宿主补丁层（desktop.patch.yml）', dest: 'desktop.patch.yml', repoPath: 'src/desktop.patch.yml' }),
      homeFileComponent({ id: 'market-catalog', title: '市场目录（catalog.json）', dest: 'market/catalog.json', repoPath: 'src/market-catalog.json' }),
      shellComponent(),
    ],
  }
}

const text = `${JSON.stringify(buildManifest(), null, 2)}\n`
const check = process.argv.includes('--check')
if (check) {
  let old = ''
  try { old = fs.readFileSync(OUT, 'utf8') } catch { /* 缺失按"不一致"处理 */ }
  if (old === text) {
    console.log(`components.json 与当前内容一致（${buildManifest().components.length} 个组件）`)
    process.exit(0)
  }
  // 说清楚"差在哪"，而不是只说"不一致"：这条门禁的用途就是抓"改了插件忘了刷清单"
  const parse = (t) => { try { return JSON.parse(t) } catch { return null } }
  const a = parse(old)
  const b = parse(text)
  if (a === null || b === null) {
    console.error('FAIL: components.json 缺失或不是合法 JSON ⇒ 跑 `node scripts/gen-components.mjs` 重新生成')
    process.exit(1)
  }
  const ids = new Set([...(a.components ?? []).map((c) => c.id), ...(b.components ?? []).map((c) => c.id)])
  const lines = []
  for (const id of ids) {
    const ca = (a.components ?? []).find((c) => c.id === id)
    const cb = (b.components ?? []).find((c) => c.id === id)
    if (ca === undefined) { lines.push(`  + 组件 ${id}（清单里缺，应补上）`); continue }
    if (cb === undefined) { lines.push(`  - 组件 ${id}（清单里有，但当前内容里没有）`); continue }
    const fa = new Map((ca.files ?? []).map((f) => [f.path, f.sha256]))
    const fb = new Map((cb.files ?? []).map((f) => [f.path, f.sha256]))
    for (const [p, h] of fb) if (fa.get(p) !== h) lines.push(`  ~ ${id}/${p}（${fa.has(p) ? '内容变了' : '新增'}）`)
    for (const p of fa.keys()) if (!fb.has(p)) lines.push(`  - ${id}/${p}（已删除，清单里还留着）`)
  }
  console.error('FAIL: components.json 与当前内容不一致（改了插件/壳源码就要重生成）：')
  for (const l of lines.slice(0, 40)) console.error(l)
  if (lines.length > 40) console.error(`  …还有 ${lines.length - 40} 处`)
  console.error('修法：node scripts/gen-components.mjs')
  process.exit(1)
}
fs.writeFileSync(OUT, text)
const m = JSON.parse(text)
console.log(`已写 ${path.relative(process.cwd(), OUT)}：${m.components.length} 个组件 / ${m.components.reduce((n, c) => n + c.files.length, 0)} 个文件`)
for (const c of m.components) console.log(`  · ${c.id.padEnd(16)} ${String(c.kind).padEnd(15)} ${String(c.files.length).padStart(3)} 文件`)
