// check-vendor-lock.mjs — 核验 vendor/package-lock.json 与 manifest 是不是同一套版本。
// 默认（脱网）：锁可解析、lockfileVersion=3、锁覆盖每个直接依赖且解析版本满足声明范围。
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

// 极简 semver 判定：够用的子集（^ / ~ / 精确 / x 范围），避免为此引入依赖
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
    if (r === null) return true   // 认不出的写法（如 file:/git:）放行，交给 --strict 兜底
    if (version === body) return true
    if (caret) {
      if (v.major !== r.major) return false
      if (v.minor < r.minor) return false
      if (v.minor === r.minor && v.patch < r.patch) return false
      // 预发布版本不满足范围（简化处理）
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
  // 锁必须覆盖 manifest 里写的 bundles
  const bundles = manifest.dsh?.profile?.bundles ?? []
  for (const b of bundles) ok(`锁里有 bundles 成员 ${b}`, packages[`node_modules/${b}`] !== undefined)
}

if (STRICT) {
  // npm 入口：npm_execpath 只在由 npm 脚本调起时存在，直接 node 调用时没有，
  // 故用项目自己的 findNpm() 探测；探测不到必须明确报失败，不能静默跳过。
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
