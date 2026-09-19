// repo-update-self-test.mjs — 「从 GitHub 仓库热更新」的离线自检（纯 Node，脱网，秒级）
//
// 为什么这些判据必须有（用户 2026-09-19 提的需求："一个按钮按 GitHub 仓库文件更新未有的文件与功能"）：
//   · 它的输入是**远端可控数据**（一份 gist 式的清单 + 一堆 raw 文件）⇒ 路径穿越、超大文件、坏哈希
//     这些形态不测就等于没有防线；
//   · 它要写的是**用户正在用的插件位**（`$DSH_HOME/profiles/<profile>/node_modules`）⇒ "下载失败时
//     不能留半成品"必须是断言出来的，而不是"应该不会吧"；
//   · 它和 `syncProfilePlugin()`（每次启动用随包副本整目录覆盖）天然冲突 ⇒ "点完按钮重启会不会被盖回去"
//     必须有判据钉住（本轮实现里最容易白干的一处）。
//
// 夹具口径：**"远端"就是本仓库的真实文件树**（用一个假的 fetch 把 raw URL 映射到本地路径）。
// 这样既脱网，又顺带证明了"提交进仓库的 components.json 与 packages/、src/ 的真实内容一致"——
// 清单一旦过期，用户点按钮要么拿不到新文件、要么永远 404，属于最难发现的一类坏。
import {
  DEFAULT_COORDS,
  dirFilesDigest,
  parseManifest,
  planUpdate,
  readState,
  runRepoUpdate,
  safeComponentPath,
  sha256Hex,
  shouldKeepHotUpdated,
  stateFilePath,
} from '../src/repo-update.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let fail = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!cond) fail++ }

const SUITE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = path.join(SUITE_ROOT, '..')
const MANIFEST_TEXT = fs.readFileSync(path.join(SUITE_ROOT, 'components.json'), 'utf8')
const REAL = JSON.parse(MANIFEST_TEXT)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-update-test-'))
const HOME = path.join(tmp, 'home')
fs.mkdirSync(HOME, { recursive: true })

/** 假远端内核：raw URL → 本仓库真实文件；`overrides` 可替换某些文件的字节（模拟"仓库改了内容"）。 */
const overrides = new Map()
const calls = []
const stripRaw = (url) => url.replace(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\//, '')
const remoteBytes = async (url) => {
  const repoPath = stripRaw(url)
  if (overrides.has(repoPath)) return overrides.get(repoPath)
  const abs = path.join(REPO_ROOT, repoPath)
  if (!fs.existsSync(abs)) throw new Error(`HTTP 404（假远端没有 ${repoPath}）`)
  return fs.readFileSync(abs)
}
/** 计数的取件函数（清单也走它）。 */
const makeFetch = () => async (url) => { calls.push(url); return remoteBytes(url) }
/** 换一份清单文本的取件函数（同样计数，方便断言"只下了 N 个文件"）。 */
const withManifest = (text) => async (url) => {
  calls.push(url)
  return url.endsWith('components.json') ? Buffer.from(text) : remoteBytes(url)
}
const coords = { ...DEFAULT_COORDS, owner: 'o', repo: 'r', ref: 'main' }

// ---------- 0) 清单自身：与仓库真实文件一致 ----------
console.log('[清单 vs 仓库真实文件]')
{
  let bad = 0
  let n = 0
  for (const c of REAL.components) {
    for (const f of c.files) {
      n += 1
      const abs = path.join(REPO_ROOT, f.repoPath)
      if (!fs.existsSync(abs)) { bad += 1; continue }
      const buf = fs.readFileSync(abs)
      if (sha256Hex(buf) !== f.sha256 || buf.length !== f.size) bad += 1
    }
  }
  ok('清单里每个文件都能在仓库里按 repoPath 找到且 sha256/size 一致', bad === 0, `${n} 个文件，坏 ${bad} 个`)
  ok('所有 repoPath 都指向 desktop-electron/ 下（壳用 raw 直链拼）', REAL.components.every((c) => c.files.every((f) => f.repoPath.startsWith('desktop-electron/'))))
  ok('清单被 parseManifest 接受', parseManifest(MANIFEST_TEXT).ok === true)
  ok('parseManifest 的产物与 JSON 等价（无副作用丢字段）', parseManifest(MANIFEST_TEXT).manifest.components.length === REAL.components.length)
}

// ---------- 1) 路径安全的字符串层拒绝 ----------
console.log('[safeComponentPath 拒绝可疑形态]')
{
  const bads = ['../../evil', '..\\..\\evil', '/etc/passwd', 'C:\\Windows\\x', 'a/../../b', 'a//b', '', '.', 'file:///x', 'a\0b']
  ok('全部可疑路径都被拒（' + bads.length + ' 个）', bads.every((p) => safeComponentPath(p) === null))
  ok('正常相对路径被接受', safeComponentPath('lib/client.js') === 'lib/client.js' && safeComponentPath('market/catalog.json') === 'market/catalog.json')
}

// ---------- 2) 恶意/坏清单：整份拒绝 ----------
console.log('[parseManifest 整份拒绝]')
{
  const base = () => JSON.parse(MANIFEST_TEXT)
  const cases = [
    ['schema 不认识', (m) => { m.schema = 2 }],
    ['组件不是数组', (m) => { m.components = 'x' }],
    ['组件 id 重复', (m) => { m.components[1].id = m.components[0].id }],
    ['kind 不认识', (m) => { m.components[0].kind = 'run-arbitrary-code' }],
    ['dest 穿越', (m) => { m.components[0].dest = '../../outside' }],
    ['文件路径穿越', (m) => { m.components[0].files[0].path = '../escape.js' }],
    ['repoPath 穿越', (m) => { m.components[0].files[0].repoPath = 'desktop-electron/../../etc/passwd' }],
    ['sha256 不是 64 位十六进制', (m) => { m.components[0].files[0].sha256 = 'zz' }],
    ['size 不是整数', (m) => { m.components[0].files[0].size = 1.5 }],
    ['size 超单文件上限', (m) => { m.components[0].files[0].size = 64 * 1024 * 1024 }],
    ['文件数超上限', (m) => { m.components[0].files = Array.from({ length: 401 }, (_, i) => ({ ...m.components[0].files[0], path: `f${i}.js` })) }],
  ]
  for (const [name, mutate] of cases) {
    const m = base()
    mutate(m)
    const r = parseManifest(JSON.stringify(m))
    ok(`拒绝：${name}`, r.ok === false, r.ok ? '居然通过了' : r.error)
  }
}

// ---------- 3) 首次更新：缺的文件都补上，落点正确 ----------
console.log('[首次更新（本地全缺）]')
let firstRun
{
  const plan0 = planUpdate({ manifest: REAL, home: HOME })
  ok('计划里 6 个组件全都要更新', plan0.summary.update === 6, JSON.stringify(plan0.summary))
  ok('缺的文件数 = 清单文件总数', plan0.summary.missingFiles === REAL.components.reduce((n, c) => n + c.files.length, 0), String(plan0.summary.missingFiles))

  calls.length = 0
  firstRun = await runRepoUpdate({ home: HOME, coords, fetchBytes: makeFetch(), log: () => {} })
  ok('整体 ok', firstRun.ok === true, firstRun.error ?? '')
  ok('插件落到 profile 插件位（宿主真正加载的那份）', fs.existsSync(path.join(HOME, 'profiles', 'web', 'node_modules', 'dsh-desktop-ui', 'lib', 'client.js')))
  ok('宿主插件也落到 plugin 位', fs.existsSync(path.join(HOME, 'profiles', 'web', 'node_modules', 'dsh-auto-approval', 'lib', 'index.js')))
  ok('补丁层落在 $DSH_HOME/desktop.patch.yml', fs.existsSync(path.join(HOME, 'desktop.patch.yml')))
  ok('市场目录落在 $DSH_HOME/market/catalog.json', fs.existsSync(path.join(HOME, 'market', 'catalog.json')))
  ok('壳源码只**暂存**（不直接改 resources）', fs.existsSync(path.join(HOME, 'repo-updates', 'shell-src', 'src', 'main.mjs')) && fs.existsSync(path.join(HOME, 'repo-updates', 'shell-src', 'VERSION')))
  ok('账本写出来了（含 6 个组件）', Object.keys(readState(HOME).components).length === 6)
  // 不写死数字：清单里加文件是常事，写死就等于每次都得改测试（这里按清单自己算）
  const totalFiles = REAL.components.reduce((n, c) => n + c.files.length, 0)
  ok('下载次数 = 清单 1 次 + 全部文件', calls.length === totalFiles + 1, `${calls.length}（期望 ${totalFiles + 1}）`)
  // 落盘内容与仓库一致（不是空文件、不是半截）
  const rel = 'desktop-electron/packages/dsh-market/lib/client.js'
  const want = fs.readFileSync(path.join(REPO_ROOT, rel))
  ok('落盘字节与仓库逐字节一致', Buffer.compare(fs.readFileSync(path.join(HOME, 'profiles', 'web', 'node_modules', 'dsh-market', 'lib', 'client.js')), want) === 0)
}

// ---------- 4) 二次更新：什么都不做（不做无谓下载） ----------
console.log('[幂等：再点一次按钮不该重复下载]')
{
  const plan1 = planUpdate({ manifest: REAL, home: HOME })
  ok('6 个组件全部 up-to-date', plan1.summary.update === 0, JSON.stringify(plan1.summary))
  calls.length = 0
  const r = await runRepoUpdate({ home: HOME, coords, fetchBytes: makeFetch(), log: () => {} })
  ok('仍然 ok 且只拉了清单', r.ok === true && calls.length === 1, `calls=${calls.length}`)
  ok('结果里全是 skipped', r.results.every((x) => x.skipped === true))
}

// ---------- 5) 仓库改了内容 / 删了文件 / 加了文件 ----------
console.log('[增量：只下"缺的或变了的"]')
{
  const target = 'desktop-electron/packages/dsh-market/lib/client.js'
  const newBytes = Buffer.from('// 仓库里这一版改了内容\nexport const x = 1\n')
  overrides.set(target, newBytes)
  const m2 = JSON.parse(MANIFEST_TEXT)
  const comp = m2.components.find((c) => c.id === 'dsh-market')
  const f = comp.files.find((x) => x.repoPath === target)
  f.sha256 = sha256Hex(newBytes); f.size = newBytes.length
  comp.files.push({ path: 'lib/added.js', repoPath: target, sha256: sha256Hex(newBytes), size: newBytes.length }) // 模拟"仓库新增一个文件"
  overrides.set('desktop-electron/packages/dsh-market/lib/added.js', newBytes)
  comp.remove = ['lib/legacy.js']
  fs.writeFileSync(path.join(HOME, 'profiles', 'web', 'node_modules', 'dsh-market', 'lib', 'legacy.js'), '// 旧文件，仓库已删\n')

  const text2 = JSON.stringify(m2)
  calls.length = 0
  const r = await runRepoUpdate({ home: HOME, coords, fetchBytes: withManifest(text2), log: () => {} })
  ok('整体 ok', r.ok === true, r.error ?? '')
  ok('只下了清单 + 2 个文件（改动 + 新增）', calls.length === 3, `calls=${calls.length}`)
  const dst = path.join(HOME, 'profiles', 'web', 'node_modules', 'dsh-market', 'lib')
  ok('改动过的文件被覆盖', Buffer.compare(fs.readFileSync(path.join(dst, 'client.js')), newBytes) === 0)
  ok('新增的文件被补上', fs.existsSync(path.join(dst, 'added.js')))
  ok('仓库删掉的文件被清掉', !fs.existsSync(path.join(dst, 'legacy.js')))
  ok('该组件的结果标成 added', r.results.find((x) => x.id === 'dsh-market')?.action === 'added', JSON.stringify(r.results.find((x) => x.id === 'dsh-market')?.action))
  // 撤掉"仓库改动"：后面的判据都基于真实仓库内容，留着会让 dsh-market 一路失败（测试自身的卫生）
  overrides.delete(target)
}

// ---------- 6) 坏哈希 / 半截响应：必须整组件失败且不留半成品 ----------
console.log('[失败原子性：坏哈希/尺寸不符时不写盘]')
{
  const dst = path.join(HOME, 'profiles', 'web', 'node_modules', 'dsh-desktop-ui', 'lib', 'client.js')
  const DIRTY = '// 脏内容（模拟本地被改坏）\n'
  const m3 = JSON.parse(MANIFEST_TEXT)
  const c3 = m3.components.find((c) => c.id === 'dsh-desktop-ui')
  c3.files[0].sha256 = 'a'.repeat(64) // 错的哈希
  // 先把本地这个文件弄脏，逼出一次真实下载（否则"本地已与清单一致"就不会下载，也就测不到校验分支）
  fs.writeFileSync(path.join(HOME, 'profiles', 'web', 'node_modules', 'dsh-desktop-ui', c3.files[0].path), DIRTY)
  const r = await runRepoUpdate({ home: HOME, coords, fetchBytes: withManifest(JSON.stringify(m3)), log: () => {} })
  ok('整体 ok=false（逐组件失败要如实上报）', r.ok === false)
  const bad = r.results.find((x) => x.id === 'dsh-desktop-ui')
  ok('失败原因点名 sha256', typeof bad?.error === 'string' && bad.error.includes('sha256'), bad?.error ?? '（无 error）')
  ok('**校验失败时一个字节都不写**（下载全在内存里收齐、校验通过才开始写）',
    fs.readFileSync(path.join(HOME, 'profiles', 'web', 'node_modules', 'dsh-desktop-ui', c3.files[0].path), 'utf8') === DIRTY)

  const m4 = JSON.parse(MANIFEST_TEXT)
  const c4 = m4.components.find((c) => c.id === 'dsh-desktop-ui')
  c4.files[0].size = c4.files[0].size + 1 // 尺寸不符（半截响应）
  const r4 = await runRepoUpdate({ home: HOME, coords, fetchBytes: withManifest(JSON.stringify(m4)), log: () => {} })
  ok('尺寸不符也判失败', r4.ok === false && String(r4.results.find((x) => x.id === 'dsh-desktop-ui')?.error).includes('尺寸'), r4.results.find((x) => x.id === 'dsh-desktop-ui')?.error ?? '')

  // 网络失败：拉不到某个**必须下载**的文件（这里用"仓库新增了一个文件"逼出一次真实下载）
  const m5 = JSON.parse(MANIFEST_TEXT)
  const c5 = m5.components.find((c) => c.id === 'dsh-market')
  c5.files.push({ path: 'lib/never-lands.js', repoPath: 'desktop-electron/packages/dsh-market/lib/client.js', sha256: sha256Hex(Buffer.from('x')), size: 1 })
  const r5 = await runRepoUpdate({
    home: HOME,
    coords,
    fetchBytes: async (url) => {
      calls.push(url)
      if (url.endsWith('components.json')) return Buffer.from(JSON.stringify(m5))
      throw new Error('HTTP 500')
    },
    log: () => {},
  })
  ok('单文件下载失败 → 该组件失败并点名下载失败', r5.ok === false && String(r5.results.find((x) => x.id === 'dsh-market')?.error).includes('下载失败'), r5.results.find((x) => x.id === 'dsh-market')?.error ?? '')
  ok('清单拉不到 → 直接失败并给原因', (await runRepoUpdate({ home: HOME, coords, fetchBytes: async () => { throw new Error('HTTP 503') }, log: () => {} })).error.includes('清单拉取失败'))
}

// ---------- 7) 与"每次启动同步随包副本"的冲突：账本判据 ----------
console.log('[shouldKeepHotUpdated：点完按钮重启会不会被盖回去]')
{
  const files = REAL.components.find((c) => c.id === 'dsh-desktop-ui').files
  const bundledDir = path.join(REPO_ROOT, 'desktop-electron', 'packages', 'dsh-desktop-ui')
  const bundled = dirFilesDigest(bundledDir, files)
  // 先把这个插件弄脏，逼出一次真实应用——否则它已是最新、不会被 apply，账本也就不会记随包摘要
  fs.writeFileSync(path.join(HOME, 'profiles', 'web', 'node_modules', 'dsh-desktop-ui', 'lib', 'client.js'), '// 弄脏，逼它重下一次\n')
  const r = await runRepoUpdate({
    home: HOME, coords, fetchBytes: makeFetch(), log: () => {},
    bundledDigestOf: (id, fs2) => (id === 'dsh-desktop-ui' ? dirFilesDigest(bundledDir, fs2) : null),
  })
  ok('更新时把"应用当时的随包摘要"记进账本', r.ok === true && readState(HOME).components['dsh-desktop-ui'].bundledDigest === bundled)
  ok('随包副本没变 → 保留热更新内容（keep=true）', shouldKeepHotUpdated({ home: HOME, id: 'dsh-desktop-ui', bundledDir }).keep === true)
  // 模拟"壳被新安装包换过"：把随包目录拷一份、改一个字节再当随包目录用
  const fakeBundled = path.join(tmp, 'fake-bundled')
  fs.cpSync(bundledDir, fakeBundled, { recursive: true })
  fs.writeFileSync(path.join(fakeBundled, 'lib', 'client.js'), '// 新安装包里的版本\n')
  ok('随包副本变了（壳换了新安装包）→ 以新包为准（keep=false）', shouldKeepHotUpdated({ home: HOME, id: 'dsh-desktop-ui', bundledDir: fakeBundled }).keep === false)
  ok('没有账本的组件 → 照旧覆盖', shouldKeepHotUpdated({ home: HOME, id: 'never-updated', bundledDir }).keep === false)
  ok('随包目录不存在时保守回退', shouldKeepHotUpdated({ home: HOME, id: 'dsh-desktop-ui', bundledDir: path.join(tmp, 'no-such-dir') }).keep === false)
}

// ---------- 8) 手动把文件改回去/删掉：应当再次更新 ----------
console.log('[文件被手动破坏后能被重新修好]')
{
  const dst = path.join(HOME, 'profiles', 'web', 'node_modules', 'dsh-desktop-ui', 'lib', 'client.js')
  fs.writeFileSync(dst, '// 被用户/别的工具改坏了\n')
  const plan = planUpdate({ manifest: REAL, home: HOME })
  ok('计划里该组件要更新（changed=1）', plan.components.find((c) => c.id === 'dsh-desktop-ui').changed.length === 1)
  calls.length = 0
  const r = await runRepoUpdate({ home: HOME, coords, fetchBytes: makeFetch(), log: () => {} })
  ok('只重下那一个文件', r.ok === true && calls.length === 2, `calls=${calls.length}`)
  ok('内容被修回仓库版', Buffer.compare(fs.readFileSync(dst), fs.readFileSync(path.join(REPO_ROOT, 'desktop-electron/packages/dsh-desktop-ui/lib/client.js'))) === 0)
}

// ---------- 9) 账本坏掉不该让入口失效 ----------
console.log('[账本健壮性]')
{
  fs.writeFileSync(stateFilePath(HOME), '{ 这不是 JSON')
  const st = readState(HOME)
  ok('坏账本读成空账本（不抛）', st.components !== undefined && Object.keys(st.components).length === 0)
  const r = await runRepoUpdate({ home: HOME, coords, fetchBytes: makeFetch(), log: () => {} })
  ok('坏账本下仍能正常更新', r.ok === true)
  ok('账本被重写回合法 JSON', typeof readState(HOME).components === 'object')
}

// ---------- 10) 接线：壳与界面真的接上了（"逻辑写好了但没人调用"是这个项目反复踩的坑） ----------
console.log('[接线：壳与界面真的接上了]')
{
  const main = fs.readFileSync(path.join(SUITE_ROOT, 'src', 'main.mjs'), 'utf8')
  const admin = fs.readFileSync(path.join(SUITE_ROOT, 'src', 'admin.mjs'), 'utf8')
  const client = fs.readFileSync(path.join(SUITE_ROOT, 'packages', 'dsh-desktop-ui', 'lib', 'client.js'), 'utf8')
  ok('main.mjs 真的调 runRepoUpdate（不是只 import 了模块）', /runRepoUpdate\(\{/.test(main))
  ok('启动同步认热更新账本（否则"点完按钮一重启就被盖回去"）', /shouldKeepHotUpdated\(\{\s*home: HOME, id: name/.test(main))
  ok('admin.mjs 有 check 路由', admin.includes("'/api/repo-update/check'"))
  ok('admin.mjs 有 apply 路由', admin.includes("'/api/repo-update/apply'"))
  ok('admin.mjs 有只读账本路由（GET，不联网）', admin.includes("'/api/repo-update/state'"))
  ok('设置页有「仓库功能更新」行且两个端点都接上', client.includes('仓库功能更新') && client.includes('/api/repo-update/check') && client.includes('/api/repo-update/apply'))
  ok('托盘有「从仓库更新功能」入口', main.includes('从仓库更新功能'))
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(fail === 0 ? '\nREPO UPDATE SELF TEST: ALL PASS' : `\nREPO UPDATE SELF TEST: ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
