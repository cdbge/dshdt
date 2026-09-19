// pnpm-resolve.mjs — "pnpm 在哪、能不能跑"的**唯一判据**
//
// 为什么需要单独一个模块（2026-09-18，朋友机器上"缺 pnpm"）：
//   npm 的定位早就有六个候选锚点（`npmCandidates`：Program Files / DSH_NODE_DIR / which node /
//   nvm / volta / Homebrew…），而 **pnpm 只会 `spawn('pnpm')` 靠 PATH**。这两套判据不一致的后果是：
//   用户按界面提示装了 pnpm（`npm i -g pnpm` 装进 `%APPDATA%\npm` 或自定义 prefix），
//   壳里那份 PATH 没刷新/不含用户级全局目录 ⇒ 界面**仍然**说"缺 pnpm"，
//   而提示里那句"装好后回到市场再点一次安装即可"就成了假承诺。
//
// 两条能力：
//   ① `pnpmCandidates()`：按平台列出 pnpm 的**入口脚本**（`pnpm.cjs`）常见位置；
//   ② `resolvePnpm()`：先按候选路径找（找到就用 `node <pnpm.cjs>`，**完全不依赖 PATH**），
//      再退回"按 PATH 探命令"（POSIX 上 / nvm·volta 已经在 PATH 里的情况）。
// 候选路径由 `vendor-build.mjs` 的 `npmCandidates()` 派生 —— 两者锚点同源，不会再漂移。

/**
 * pnpm 的入口脚本候选位置。
 *
 * 两个来源（2026-09-18 实测补全）：
 *   ① 由 `npmCandidates()` **派生** —— 与 npm 的锚点同源，不会再出现"npm 找得到、pnpm 找不到"；
 *   ② 几个常见的**全局 prefix**（`%APPDATA%\npm`、`%LOCALAPPDATA%\pnpm`、`<Node>/node_global`、
 *      `$PNPM_HOME`、`npm_config_prefix`、POSIX 的 `/usr/local`、Homebrew 前缀）。
 *      本机实测 pnpm 就落在 `C:\Program Files\nodejs\node_global\node_modules\pnpm`——
 *      只按 ① 派生会漏（那个 prefix 是用户装 npm 时自选的）。
 * @param {object} [o]
 * @param {string[]} [o.npmCandidates] `npmCandidates()` 的输出
 * @param {Record<string,string|undefined>} [o.env]
 * @returns {string[]} pnpm `pnpm.cjs` 候选绝对路径（按优先级，已去重）
 */
export function pnpmCandidates({ npmCandidates = [], env = process.env } = {}) {
  const out = []
  const seen = new Set()
  const push = (p) => { if (typeof p === 'string' && p !== '' && !seen.has(p)) { seen.add(p); out.push(p) } }

  // ① 从 npm 候选派生（把路径里的 npm 换成 pnpm）
  for (const c of npmCandidates) {
    let d = ''
    if (/node_modules[/\\]npm[/\\]bin[/\\]npm-cli\.js$/.test(c)) d = c.replace(/node_modules[/\\]npm[/\\]bin[/\\]npm-cli\.js$/, 'node_modules/pnpm/bin/pnpm.cjs')
    else if (/lib[/\\]node_modules[/\\]npm[/\\]bin[/\\]npm-cli\.js$/.test(c)) d = c.replace(/lib[/\\]node_modules[/\\]npm[/\\]bin[/\\]npm-cli\.js$/, 'lib/node_modules/pnpm/bin/pnpm.cjs')
    else if (/[/\\]nodejs[/\\]npm[/\\]bin[/\\]npm-cli\.js$/.test(c)) d = c.replace(/[/\\]nodejs[/\\]npm[/\\]bin[/\\]npm-cli\.js$/, '/nodejs/pnpm/bin/pnpm.cjs')
    push(d)
  }

  // ② 常见全局 prefix（Windows 为主，POSIX 用绝对路径兜底）
  const winPrefixes = []
  if (env.APPDATA) winPrefixes.push(`${env.APPDATA}\\npm`)
  if (env.LOCALAPPDATA) winPrefixes.push(`${env.LOCALAPPDATA}\\pnpm`)
  if (env.ProgramFiles) winPrefixes.push(`${env.ProgramFiles}\\nodejs\\node_global`)
  if (env.PNPM_HOME) winPrefixes.push(env.PNPM_HOME)
  if (env.npm_config_prefix) winPrefixes.push(env.npm_config_prefix)
  for (const prefix of winPrefixes) {
    push(`${prefix}\\node_modules\\pnpm\\bin\\pnpm.cjs`)
    push(`${prefix}\\pnpm.exe`)   // pnpm 自带的独立安装形态
  }
  for (const prefix of ['/usr/local', '/usr', '/opt/homebrew', '/opt/local']) {
    push(`${prefix}/lib/node_modules/pnpm/bin/pnpm.cjs`)
  }
  push('/usr/share/nodejs/pnpm/bin/pnpm.cjs')
  return out
}

/**
 * 解析 pnpm 的调用方式。
 *
 * 判定顺序（每一步都记进 `detail`，好在排障时看出"它到底找了哪些地方"）：
 *   ① 候选用**绝对路径**调 `node <pnpm.cjs> --version`（不依赖 PATH，Windows 上最稳）
 *   ② 退回按 PATH 探 `pnpm --version`（POSIX / 已配好 PATH 的机器）
 * @param {object} o
 * @param {(cmd:string,args:string[],opts:object)=>object} o.spawnSync 注入的 spawnSync
 * @param {string} o.nodePath 用来直调 pnpm.cjs 的 node（壳里通常是 Electron 的 execPath）
 * @param {string[]} [o.candidates] 候选 pnpm.cjs（默认由调用方用 `pnpmCandidates()` 算好传进来）
 * @param {object} [o.env]
 * @param {(p:string)=>boolean} [o.exists]
 * @param {number} [o.timeoutMs]
 * @returns {{ok:boolean, version:string, how:string, detail:string, path:string}}
 */
export function resolvePnpm({ spawnSync, nodePath, candidates = [], env = process.env, exists = undefined, timeoutMs = 15000 }) {
  const seenLabel = `${candidates.length} 个候选路径`
  const run = (cmd, args, useShell) => {
    try {
      const r = spawnSync(cmd, args, { env, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, shell: useShell })
      const version = String((r && r.stdout) || '').trim().split('\n')[0] || ''
      if (r && typeof r.status === 'number' && r.status === 0 && version !== '') return { ok: true, version }
      if (r && r.error && r.error.code === 'ENOENT') return { ok: false, why: '不在 PATH 上' }
      return { ok: false, why: (r && r.error && r.error.message) || `退出码 ${r && r.status}` }
    } catch (e) {
      return { ok: false, why: (e && e.message) || 'spawn 抛错' }
    }
  }

  // ① 绝对路径优先：用 node **直调** `pnpm.cjs`（node 是真可执行文件，**不要 shell** ——
  //    加 shell 会在受限环境里先起一个 cmd.exe，那个会被沙箱 EPERM，白白把可用路径判死）
  if (typeof nodePath === 'string' && nodePath !== '') {
    for (const c of candidates) {
      if (typeof exists === 'function' && !exists(c)) continue
      const r = run(nodePath, [c, '--version'], false)
      if (r.ok) return { ok: true, version: r.version, how: `绝对路径 ${c}`, detail: `${r.version}（${c}）`, path: c }
    }
  }

  // ② 退回按 PATH 探命令：先直调，Windows 上再退回 shell（`.cmd` 垫片需要 cmd 解析）
  let last = run('pnpm', ['--version'], false)
  if (!last.ok && process.platform === 'win32') {
    const viaShell = run('pnpm', ['--version'], true)
    if (viaShell.ok) return { ok: true, version: viaShell.version, how: 'PATH 上的 pnpm（经 shell）', detail: `${viaShell.version}（PATH）`, path: '' }
    last = viaShell
  }
  if (last.ok) return { ok: true, version: last.version, how: 'PATH 上的 pnpm', detail: `${last.version}（PATH）`, path: '' }
  return {
    ok: false,
    version: '',
    how: '',
    path: '',
    detail: `按 PATH 没找到（${last.why}），按 ${seenLabel}也没找到可用的 pnpm.cjs`,
  }
}

/**
 * 把 pnpm 所在目录（以及全局 bin 目录）**注进子进程的 PATH**。
 *
 * 为什么必须做（2026-09-18）：官方 `dsh plugin add` 内部是 `spawnSync('pnpm', …)`，
 * 靠**子进程的 PATH** 找命令。我们这边"按绝对路径找到了 pnpm"并不能让官方那条命令找到它
 * ⇒ 只是把失败从"体检说缺"推迟到"安装时 127"。所以解析出路径之后，要把它的目录补进 PATH。
 * 优先级：pnpm.cjs 的两级祖先（`…/pnpm/bin/pnpm.cjs` → `…/pnpm/bin`）与其全局 bin（`…/node_modules/.bin`）。
 * @param {object} o
 * @param {string} o.pnpmPath 已解析出的 pnpm 入口绝对路径（PATH 兜底成功时可为空）
 * @param {string} o.nodePath node 可执行文件（用它同级的目录优先）
 * @param {Record<string,string|undefined>} [o.env]
 * @param {string} [o.platform]
 * @returns {{env:Record<string,string|undefined>, prepended:string[]}}
 */
export function envWithPnpmOnPath({ pnpmPath, nodePath, env = process.env, platform = process.platform }) {
  // 只做**字符串**层面的目录拼接：路径来自不同平台（Windows 路径 / POSIX 路径）时
  // 不能用本机的 path.join（会把分隔符搞混），所以统一按"最后一个分隔符"切。
  const sep = platform === 'win32' ? ';' : ':'
  const dirOf = (p) => p.replace(/[/\\][^/\\]*$/, '')
  const join2 = (a, b) => `${a.replace(/[/\\]+$/, '')}/${b}`
  const prepend = []
  const add = (d) => { if (typeof d === 'string' && d !== '' && !prepend.includes(d)) prepend.push(d) }
  if (typeof nodePath === 'string' && nodePath !== '') add(dirOf(nodePath))
  if (typeof pnpmPath === 'string' && pnpmPath !== '') {
    const binDir = dirOf(pnpmPath)          // …/pnpm/bin
    const pkgDir = dirOf(binDir)            // …/pnpm
    const modulesDir = dirOf(pkgDir)        // …/node_modules
    add(binDir)
    add(pkgDir)
    add(join2(modulesDir, '.bin'))
  }
  const current = String(env.PATH ?? '')
  const merged = prepend.length === 0 ? current : `${prepend.join(sep)}${sep}${current}`
  return { env: { ...env, PATH: merged }, prepended: prepend }
}
