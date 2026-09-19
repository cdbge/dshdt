// market-install-official.mjs — 市场安装的**官方路径**：转发给 `dsh plugin --profile <name> add <spec>`
//
// 为什么改成这条路（2026-09-17，用户拍板"模仿他的构建思路弄安装路径，确保安装良好"）：
//   我原先那条路是"下载 zip → 展开到 node_modules"，它有个致命短板：**不解析依赖**。
//   而社区插件本来就是 npm 包，几乎都会 import 第三方库 ⇒ 自包含 zip 方案对真实插件
//   基本装不起来，除非维护者手工把依赖预先 bundle 进去。
//   官方机制（`dsh plugin` → pnpm）会：解析依赖、锁版本、跑 prepare（需显式授权）、
//   并把声明了 `dsh.bundle` 的包**自动写进 `dsh.profile.bundles`** —— 连挂载行都不用我们手工写。
//   ⇒ "确保装得好"这条，官方那条路显著更强；我们只把审核过的**包坐标**喂给它。
//
// 本模块不 import electron：`spawn` 与 `bin` 由调用方注入，因此可脱网单测每条失败分支。
import fs from 'node:fs'
import path from 'node:path'

/** 官方 CLI 里 pnpm 缺失时的退出码（`plugin-Bk_PbPwP.js`：`pnpm not found on PATH` → 127）。 */
export const EXIT_PNPM_MISSING = 127

/**
 * 把审核过的条目转成**安装坐标**（喂给 pnpm 的 spec）。
 *
 * 为什么坐标要由目录显式给出、而不是让我们拼：官方文档明确"锁定 commit
 * （`github:you/hello-plugin#<sha>`）让后续推送无法悄悄改变实际运行的内容"——
 * 这跟"审核过的那一份"是同一件事。所以本函数只做**校验与归一化**，不猜坐标。
 *
 * 支持的形态（都直接透传给 pnpm，与 `dsh plugin add` 完全一致）：
 *   · `name@1.2.3` / `@scope/name@1.2.3`  —— npm 预构建包（**官方推荐**：无需构建授权）
 *   · `github:owner/repo#<40位sha>`        —— git 源码（需 pnpm 构建授权，见下）
 *   · `https://…/x.tgz`                    —— tarball（无需构建授权）
 * @param {object} entry 目录条目
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
    // 必须钉到 commit：`github:owner/repo#<sha>`。只给分支/标签会被 pnpm 解析成可变内容，
    // "审核过的那一份"就守不住了。40 位十六进制是 git 的完整 SHA-1。
    const m = /^github:([^#\s]+)#([0-9a-f]{40})$/i.exec(raw)
    if (m === null) return { ok: false, error: `github 坐标必须钉到 40 位 commit（github:owner/repo#<sha>）：${raw}` }
    return { ok: true, spec: raw, kind: 'github' }
  }
  // 其余交给 npm 解析（name / name@version / @scope/name@version）；做一次形状校验，
  // 免得把奇怪的字符串透传给 spawn 的实参数组之外的地方。
  if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(@[^\s]+)?$/i.test(raw)) return { ok: false, error: `无法识别的安装坐标：${raw}` }
  return { ok: true, spec: raw, kind: 'registry' }
}

/**
 * 探测 pnpm 是否可用（**只按 PATH**，老判据）。
 *
 * ⚠️ 2026-09-18 起生产路径**不要**再用它 —— 改用 `pnpm-resolve.mjs` 的 `resolvePnpm()`：
 *   它先按绝对路径候选（`pnpm.cjs`）找、找到就用 `node <pnpm.cjs>` 调，**完全不依赖 PATH**，
 *   再退回按 PATH 探。只按 PATH 探会漏掉"pnpm 装在用户级全局目录、而壳进程的 PATH 不含它"
 *   这一大类 —— 那正是"界面说缺 pnpm、用户装了还说缺"的根因。
 * 本函数保留给注入式单测（判据简单、可脱网）与 `resolvePnpm` 的 PATH 兜底。
 * @param {(cmd:string, args:string[], opts:object)=>object} spawnSyncImpl 注入的 spawnSync
 * @param {{env?:object}} [o]
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

/**
 * 缺 pnpm 时给出的**可直接照做**的处置（不自动执行：装全局工具属于改用户环境，须他点头）。
 *
 * 措辞按"最可能一次成功"排序（2026-09-18 改）：先试 `npm i -g pnpm`（多数人机器上有 npm），
 * 再给 corepack（Node 自带，但要联网拉 pnpm），最后说明"装在非标准位置也认" ——
 * 因为我们现在是**按候选路径找**的，装到自定义 prefix 同样能被认出来。
 * @returns {string}
 */
export function pnpmHint() {
  return '这台机器上没有找到 pnpm，而 DSH 的插件安装机制依赖它。三选一：\n'
    + '  · 用 npm 装（最省事）：npm i -g pnpm\n'
    + '  · 用 Node 自带的 corepack：corepack enable && corepack prepare pnpm@latest --activate\n'
    + '  · 已经装了但装在非标准位置：装好后**重启一次应用**即可（壳在启动时解析工具路径）。\n'
    + '装好后回到市场再点一次安装；若仍显示"缺 pnpm"，按 Ctrl+Shift+L 打开「后台日志」，\n'
    + '看 `pnpm 解析` 那几行 —— 它会列出找过的候选路径与每步的判定依据。'
}

/**
 * 走官方机制安装一个条目。
 *
 * @param {object} entry 目录条目（用 `install.spec` 作为坐标）
 * @param {object} deps
 * @param {string} deps.bin dsh CLI 入口（`…/dsh/lib/bin.js`）
 * @param {string} deps.profile 目标 profile 名（本壳固定 `web`）
 * @param {string} deps.profileDir `$DSH_HOME/profiles/<profile>`（用于安装后核对）
 * @param {string} deps.runtime 运行时（Electron 下用 process.execPath + ELECTRON_RUN_AS_NODE）
 * @param {Function} deps.spawnSync 注入的 spawnSync（测试用假的）
 * @param {object} [deps.env] 子进程环境
 * @param {number} [deps.timeoutMs] 超时（分钟级：pnpm 首次装要下载）
 * @param {(m:string)=>void} [deps.log]
 * @param {{ok:boolean, version?:string, detail:string, how?:string}} [deps.pnpm] 已经解析好的 pnpm
 *   （调用方用 `resolvePnpm()` 得到；不传则退回只按 PATH 探测）
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

  // ① 先探 pnpm：官方 CLI 是硬依赖，缺它一定失败（且它的报错文案不会告诉用户"怎么装"）。
  //    优先用调用方**已经解析好的**结果（与市场体检同一套判据，避免"体检说缺、其实在别处"）。
  const pnpm = pnpmResolved !== undefined && pnpmResolved !== null
    ? pnpmResolved
    : probePnpm(spawnSyncImpl, { env })
  if (!pnpm.ok) {
    return bad('pnpm', `pnpm 不可用（${pnpm.detail}）`, { hint: pnpmHint() })
  }
  notes.push(`pnpm ${pnpm.version || pnpm.detail}${pnpm.how ? `（${pnpm.how}）` : ''}`)

  // ② 装：argv 与官方 `dsh plugin` 完全同形（`--profile <name>` + 透传给 pnpm 的参数）
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

  // ③ 按官方 CLI 的**已知失败形态**分档，并给可执行的下一步（不是一句"失败了"）
  if (code === EXIT_PNPM_MISSING) return bad('pnpm', 'dsh 报告 pnpm not found on PATH', { hint: pnpmHint(), output: out })
  if (code !== 0) {
    // pnpm ≥10 默认拦截 git 依赖的构建脚本；官方 CLI 会提示 allowBuilds。
    // 这是"允许第三方代码在安装时于你机器上执行"的授权，**绝不能由我们自动写**——
    // 只把原文与官方指出的改法转达给用户，由他决定。
    if (/allowBuilds|blocked build scripts|Ignored build scripts|prepare/i.test(out)) {
      return bad('build-script', '该插件是 git 源码包，装它需要授权 pnpm 运行它的构建脚本（等于允许它在安装时执行代码）。'
        + '按 pnpm 输出里给出的包键，写进 profile 的 pnpm-workspace.yaml 的 allowBuilds 后重试。', { output: out })
    }
    return bad('pnpm', `安装失败（退出码 ${code}）`, { output: out })
  }

  // ④ 核对**真装上了**：不能只看退出码。官方机制成功了会在 profile 清单里留下依赖，
  //    声明了 dsh.bundle 的还会被自动加进 dsh.profile.bundles。
  //
  //    包名要从 spec 里**正确**取出来：registry 坐标可能是 `name@1.2.3` 或 `@scope/name@1.2.3`，
  //    直接切掉版本号会把 scope 包切成空串（自检的"对照"用例抓到过这个错）。
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
 * 从安装坐标推算它会在 profile 清单里出现的**依赖键**（pnpm 写进 dependencies 的那个名字）。
 * @param {{spec:string, kind:string}} spec
 * @returns {string} 依赖键；推算不出时返回空串（调用方据此不做"必须命中"的强判）
 */
export function manifestKeyOf(spec) {
  if (spec.kind === 'tarball') return ''   // tarball 的键由包内的 name 决定，从 URL 猜不出来
  if (spec.kind === 'github') {
    const repo = spec.spec.replace(/^github:/i, '').split('#')[0].split('/').pop() || ''
    return repo
  }
  // registry：先切掉 `@version`，再处理 scope
  const at = spec.spec.lastIndexOf('@')
  return at > 0 ? spec.spec.slice(0, at) : spec.spec
}
