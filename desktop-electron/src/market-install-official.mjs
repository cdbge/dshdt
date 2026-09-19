// market-install-official.mjs — 市场安装的官方路径：转发给 `dsh plugin --profile <name> add <spec>`。
// 不 import electron，spawn 与 bin 由调用方注入，可脱网单测每条失败分支。
import fs from 'node:fs'
import path from 'node:path'

/** 官方 CLI 里 pnpm 缺失时的退出码。 */
export const EXIT_PNPM_MISSING = 127

/**
 * 把审核过的条目转成安装坐标（喂给 pnpm 的 spec）：只做校验与归一化，不猜坐标；
 * github 形态必须钉到 40 位 commit，否则审核过的那一份守不住。
 * @returns {{ok:true, spec:string, kind:'registry'|'github'|'tarball'}|{ok:false, error:string}}
 */
export function toInstallSpec(entry) {
  const raw = entry && entry.install && typeof entry.install.spec === 'string' ? entry.install.spec.trim() : ''
  if (raw === '') return { ok: false, error: '条目没有 install.spec（维护者需写明安装坐标）' }
  if (/\s/.test(raw)) return { ok: false, error: `install.spec 含空白字符：${raw}` }
  if (/^https:\/\//i.test(raw)) {
    if (!/\.tgz($|\?)/i.test(raw)) return { ok: false, error: `tarball 地址应以 .tgz 结尾：${raw}` }
    return { ok: true, spec: raw, kind: 'tarball' }
  }
  if (/^http:\/\//i.test(raw)) return { ok: false, error: `拒绝 http 坐标：${raw}` }
  if (/^github:/i.test(raw)) {
    // 必须钉到 commit：分支/标签会被 pnpm 解析成可变内容，40 位十六进制是完整 SHA-1
    const m = /^github:([^#\s]+)#([0-9a-f]{40})$/i.exec(raw)
    if (m === null) return { ok: false, error: `github 坐标必须钉到 40 位 commit（github:owner/repo#<sha>）：${raw}` }
    return { ok: true, spec: raw, kind: 'github' }
  }
  // 其余交给 npm 解析（name / name@version / @scope/name@version），先做一次形状校验
  if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(@[^\s]+)?$/i.test(raw)) return { ok: false, error: `无法识别的安装坐标：${raw}` }
  return { ok: true, spec: raw, kind: 'registry' }
}

/**
 * 只按 PATH 探测 pnpm 是否可用（生产路径应改用 resolvePnpm()；此处留给单测与其 PATH 兜底）。
 * @returns {{ok:boolean, detail:string}}
 */
export function probePnpm(spawnSyncImpl, { env = process.env } = {}) {
  try {
    const r = spawnSyncImpl('pnpm', ['--version'], { env, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32', timeout: 15000 })
    if (r && typeof r.status === 'number' && r.status === 0) return { ok: true, detail: String(r.stdout || '').trim() }
    if (r && r.error && r.error.code === 'ENOENT') return { ok: false, detail: 'pnpm 不在 PATH 上' }
    return { ok: false, detail: (r && r.error && r.error.message) || `pnpm --version 退出码 ${r && r.status}` }
  } catch (e) {
    return { ok: false, detail: e && e.message }
  }
}

/** 缺 pnpm 时给出的可直接照做的处置（不自动执行：装全局工具属于改用户环境）。 @returns {string} */
export function pnpmHint() {
  return '这台机器上没有找到 pnpm，而 DSH 的插件安装机制依赖它。三选一：\n'
    + '  · 用 npm 装（最省事）：npm i -g pnpm\n'
    + '  · 用 Node 自带的 corepack：corepack enable && corepack prepare pnpm@latest --activate\n'
    + '  · 已经装了但装在非标准位置：装好后**重启一次应用**即可（壳在启动时解析工具路径）。\n'
    + '装好后回到市场再点一次安装；若仍显示"缺 pnpm"，按 Ctrl+Shift+L 打开「后台日志」，\n'
    + '看 `pnpm 解析` 那几行 —— 它会列出找过的候选路径与每步的判定依据。'
}

/**
 * 走官方机制安装一个条目（用 `entry.install.spec` 作为坐标）。
 * deps: { bin(dsh CLI 入口), profile(本壳固定 web), profileDir($DSH_HOME/profiles/<profile>),
 *   runtime(Electron 下 execPath + ELECTRON_RUN_AS_NODE), spawnSync, env?, timeoutMs?, log?, pnpm? }
 * pnpm 由调用方用 `resolvePnpm()` 解析好传入，不传则退回只按 PATH 探测。
 * @returns {{ok:true, spec:string, kind:string, bundleAdded:boolean, needsRestart:boolean, output:string, notes:string[]}
 *          |{ok:false, stage:string, error:string, hint?:string, output?:string}}
 */
export function installMarketEntryOfficial(entry, deps) {
  const {
    bin, profile, profileDir, runtime, spawnSync: spawnSyncImpl, env = process.env,
    timeoutMs = 10 * 60 * 1000, log = () => {}, pnpm: pnpmResolved = undefined,
  } = deps
  const notes = []
  const bad = (stage, error, extra = {}) => ({ ok: false, stage, error, ...extra })

  if (typeof bin !== 'string' || bin === '') return bad('validate', '找不到 dsh CLI 入口（dshBin）')
  if (typeof profile !== 'string' || profile === '') return bad('validate', '没有目标 profile')
  if (typeof spawnSyncImpl !== 'function') return bad('validate', '内部装配缺失（spawnSync）')

  const spec = toInstallSpec(entry)
  if (!spec.ok) return bad('validate', spec.error)

  // 官方 CLI 硬依赖 pnpm，缺它一定失败；优先用调用方已解析好的结果（与市场体检同一套判据）
  const pnpm = pnpmResolved !== undefined && pnpmResolved !== null
    ? pnpmResolved
    : probePnpm(spawnSyncImpl, { env })
  if (!pnpm.ok) {
    return bad('pnpm', `pnpm 不可用（${pnpm.detail}）`, { hint: pnpmHint() })
  }
  notes.push(`pnpm ${pnpm.version || pnpm.detail}${pnpm.how ? `（${pnpm.how}）` : ''}`)

  // argv 与官方 `dsh plugin` 完全同形（`--profile <name>` + 透传给 pnpm 的参数）
  const argv = [bin, 'plugin', '--profile', profile, 'add', spec.spec]
  log(`market: 官方路径安装 ${spec.kind} ${spec.spec}（cwd=${profileDir}）`)
  let res
  try {
    res = spawnSyncImpl(runtime, argv, {
      cwd: profileDir, env, encoding: 'utf8', windowsHide: true, timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    })
  } catch (e) {
    return bad('spawn', `调用 dsh CLI 失败：${e && e.message}`)
  }
  const out = `${(res && res.stdout) || ''}${(res && res.stderr) || ''}`
  if (res && res.error) {
    if (res.error.code === 'ENOENT') return bad('spawn', `运行时或 dsh CLI 不存在：${res.error.message}`)
    if (res.error.code === 'ETIMEDOUT') return bad('timeout', '安装超时（网络慢或包很大）', { output: out })
    return bad('spawn', `调用 dsh CLI 出错：${res.error.message}`, { output: out })
  }
  const code = typeof res.status === 'number' ? res.status : 1

  // 按官方 CLI 的已知失败形态分档，给可执行的下一步
  if (code === EXIT_PNPM_MISSING) return bad('pnpm', 'dsh 报告 pnpm not found on PATH', { hint: pnpmHint(), output: out })
  if (code !== 0) {
    // pnpm ≥10 默认拦截 git 依赖的构建脚本；这是"允许第三方代码在安装时执行"的授权，不能由我们自动写
    if (/allowBuilds|blocked build scripts|Ignored build scripts|prepare/i.test(out)) {
      return bad('build-script', '该插件是 git 源码包，装它需要授权 pnpm 运行它的构建脚本（等于允许它在安装时执行代码）。'
        + '按 pnpm 输出里给出的包键，写进 profile 的 pnpm-workspace.yaml 的 allowBuilds 后重试。', { output: out })
    }
    return bad('pnpm', `安装失败（退出码 ${code}）`, { output: out })
  }

  // 核对真装上了，不能只看退出码
  const expectedName = manifestKeyOf(spec)
  let bundleAdded = false
  let inDependencies = false
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    const depsNames = Object.keys(manifest.dependencies || {})
    inDependencies = expectedName !== '' && depsNames.includes(expectedName)
    bundleAdded = Array.isArray(manifest.dsh?.profile?.bundles) && manifest.dsh.profile.bundles.length > 0
  } catch (e) {
    notes.push(`读 profile 清单失败（非致命）：${e && e.message}`)
  }
  if (!inDependencies && !bundleAdded) {
    return bad('verify', 'pnpm 报告成功，但 profile 清单里看不到这次安装的痕迹——安装可能没真正落地', { output: out })
  }
  return { ok: true, spec: spec.spec, kind: spec.kind, bundleAdded, inDependencies, needsRestart: true, output: out, notes }
}

/**
 * 从安装坐标推算它会在 profile 清单里出现的依赖键。
 * @returns {string} 依赖键；推算不出时返回空串（调用方据此不做强判）
 */
export function manifestKeyOf(spec) {
  if (spec.kind === 'tarball') return ''   // tarball 的键由包内 name 决定，从 URL 猜不出来
  if (spec.kind === 'github') {
    const repo = spec.spec.replace(/^github:/i, '').split('#')[0].split('/').pop() || ''
    return repo
  }
  // registry：先切掉 `@version`，再处理 scope
  const at = spec.spec.lastIndexOf('@')
  return at > 0 ? spec.spec.slice(0, at) : spec.spec
}
