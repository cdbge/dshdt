// check-vendor-lock.mjs — 核验"版本锁"与 manifest 是不是同一套版本
//
// 为什么需要：`vendor/package-lock.json` 钉死了三平台共用的传递依赖版本，是"各平台包内容一致"的唯一保证。
// 但它**需要人工重新生成**（改 DSH 版本时 `npm install --package-lock-only`），而"忘了重新生成"这种失误
// 不会报错——只会让某一平台装出与锁不符的树。2026-09-15 就是靠 `compare-packaged-vendor` 才发现的漂移，
// 那条路是"事后比对产物"，太晚。这里把它提前到"构建/发布之前"。
//
// 两种模式（**同一份判据，两种强度**）：
//   · 默认（脱网，进离线自检套件）：纯字节/JSON 判据——
//       ① 锁存在且可解析、lockfileVersion=3
//       ② 锁覆盖 manifest 声明的**每一个直接依赖**（包名 + 声明版本）
//       ③ 锁里直接依赖的解析版本确实**满足** manifest 的范围（自带一份够用的 semver 判定）
//     跑不了"传递依赖是否还能解析到同一组版本"这类需要 registry 的判断——那要联网，见下。
//   · `--strict`（联网，用于发布前/CI）：把 manifest + 锁拷到临时目录跑 `npm ci --dry-run`。
//     npm 自己会校验两者是否一套，**任何不一致都拒绝**（实测能拦住：版本变了、多了依赖、锁缺失、锁损坏）。
//     这条才是完整的判据，所以发布前必须跑它。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCK = path.join(ROOT, 'vendor', 'package-lock.json')
const MANIFEST = path.join(ROOT, 'vendor', 'profile', 'package.json')
const STRICT = process.argv.includes('--strict')

let fail = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!cond) fail++ }

/** 极简 semver 判定：够用的子集（^ / ~ / 精确 / x 范围）。避免为此引入依赖。 */
function satisfies(version, range) {
  if (range === undefined || range === null || range === '' || range === '*' || range === 'latest') return true
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v).trim())
    return m === null ? null : { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null }
  }
  const v = parse(version)
  if (v === null) return false
  // 支持 `a || b` 与逗号分隔的集合
  const alternatives = String(range).split('||').map((s) => s.trim())
  return alternatives.some((alt) => alt.split(/\s+/).every((part) => {
    if (part === '') return true
    const caret = part.startsWith('^')
    const tilde = part.startsWith('~')
    const body = caret || tilde ? part.slice(1) : part
    const r = parse(body)
    if (r === null) return true   // 认不出的写法（如 file:/git:）一律放行，交给 --strict 兜底
    if (version === body) return true
    if (caret) {
      if (v.major !== r.major) return false
      if (v.minor < r.minor) return false
      if (v.minor === r.minor && v.patch < r.patch) return false
      // 预发布版本不满足范围（简化处理，与 npm 默认行为一致的方向）
      if (r.pre === null && v.pre !== null) return false
      return true
    }
    if (tilde) return v.major === r.major && v.minor === r.minor && v.patch >= r.patch
    return v.major === r.major && v.minor === r.minor && v.patch === r.patch
  }))
}

console.log(`[vendor-lock] ${STRICT ? 'strict（联网，跑 npm ci --dry-run）' : '脱网判据'}`)
ok('锁文件存在', fs.existsSync(LOCK), LOCK)
if (!fs.existsSync(LOCK)) { console.log(fail === 0 ? '\nVENDOR LOCK: ALL PASS' : `\nVENDOR LOCK: ${fail} FAILED`); process.exit(1) }
ok('manifest 存在', fs.existsSync(MANIFEST), MANIFEST)

let lock = null
let manifest = null
try { lock = JSON.parse(fs.readFileSync(LOCK, 'utf8')) } catch (e) { ok('锁可解析', false, e.message) }
try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) } catch (e) { ok('manifest 可解析', false, e.message) }

if (lock !== null && manifest !== null) {
  ok('lockfileVersion = 3', lock.lockfileVersion === 3, String(lock.lockfileVersion))
  const packages = lock.packages ?? {}
  const deps = manifest.dependencies ?? {}
  const depNames = Object.keys(deps)
  ok('manifest 有直接依赖', depNames.length > 0, depNames.join(', '))
  for (const name of depNames) {
    const entry = packages[`node_modules/${name}`]
    ok(`锁里有 ${name}`, entry !== undefined, entry?.version ?? '缺失')
    if (entry !== undefined) {
      ok(`${name} 的锁定版本 ${entry.version} 满足声明 ${deps[name]}`,
        satisfies(entry.version, deps[name]), `声明 ${deps[name]}`)
    }
  }
  // 锁必须覆盖 manifest 里写的 bundles（DSH 的 profile 机制）
  const bundles = manifest.dsh?.profile?.bundles ?? []
  for (const b of bundles) ok(`锁里有 bundles 成员 ${b}`, packages[`node_modules/${b}`] !== undefined)
}

if (STRICT) {
  // npm 入口：`npm_execpath` 只在"由 npm 脚本调起"时才存在（`npm run xxx`），直接 `node scripts/...` 时没有，
  // 所以用项目自己的 `findNpm()` 探测（它已经处理了三平台布局与 DSH_NODE_DIR 兜底）。
  // 探测不到就**明确报失败**，不能静默跳过：strict 是发布前唯一的完整判据。
  const { findNpm } = await import('../src/vendor-build.mjs')
  const npmCli = process.env.npm_execpath ?? findNpm()
  ok('找得到 npm（strict 模式需要它来跑 npm ci --dry-run）', typeof npmCli === 'string' && fs.existsSync(npmCli),
    String(npmCli ?? '未找到'))
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lockcheck-'))
  try {
    fs.copyFileSync(MANIFEST, path.join(tmp, 'package.json'))
    fs.copyFileSync(LOCK, path.join(tmp, 'package-lock.json'))
    const log = path.join(tmp, 'npm.log')
    const fd = fs.openSync(log, 'w')
    let r = { status: null }
    try {
      if (typeof npmCli === 'string' && fs.existsSync(npmCli)) {
        r = spawnSync(process.execPath, [npmCli, 'ci', '--dry-run', '--omit=dev',
          '--no-audit', '--no-fund', '--ignore-scripts', '--prefix', tmp], {
          stdio: ['ignore', fd, fd],
          env: { ...process.env, npm_config_cache: path.join(ROOT, '.npm-cache') },
        })
      }
    } finally { fs.closeSync(fd) }
    const out = fs.readFileSync(log, 'utf8')
    const npmErr = (out.split('\n').find((l) => /npm error/i.test(l)) ?? '').trim()
    const lastLine = (out.trim().split('\n').pop() ?? '').trim()
    ok('npm ci --dry-run 认可"这份锁 + 这份 manifest"', r.status === 0,
      npmErr || lastLine || `状态 ${r.status}`)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
} else {
  console.log('  NOTE  脱网模式只核"直接依赖在锁里且版本满足范围"；')
  console.log('        传递依赖是否还能解析到同一组版本需要联网 —— 发布前跑 `--strict`。')
}

console.log(fail === 0 ? '\nVENDOR LOCK: ALL PASS' : `\nVENDOR LOCK: ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
