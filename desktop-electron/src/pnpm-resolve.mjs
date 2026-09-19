// pnpm-resolve.mjs — pnpm 的定位判据：候选路径解析、调用方式判定、注入子进程 PATH。
// 候选路径由 vendor-build.mjs 的 npmCandidates() 派生，与 npm 锚点同源。
/**
 * pnpm 入口脚本（`pnpm.cjs`）的候选绝对路径，按优先级去重。
 * 来源一：由 `npmCandidates()` 派生；来源二：几个常见全局 prefix（含 Windows 与 Homebrew 惯例）。
 * @returns {string[]}
 */
export function pnpmCandidates({ npmCandidates = [], env = process.env } = {}) {
  const out = []
  const seen = new Set()
  const push = (p) => { if (typeof p === 'string' && p !== '' && !seen.has(p)) { seen.add(p); out.push(p) } }

  // 从 npm 候选派生：把路径里的 npm 换成 pnpm
  for (const c of npmCandidates) {
    let d = ''
    if (/node_modules[/\\]npm[/\\]bin[/\\]npm-cli\.js$/.test(c)) d = c.replace(/node_modules[/\\]npm[/\\]bin[/\\]npm-cli\.js$/, 'node_modules/pnpm/bin/pnpm.cjs')
    else if (/lib[/\\]node_modules[/\\]npm[/\\]bin[/\\]npm-cli\.js$/.test(c)) d = c.replace(/lib[/\\]node_modules[/\\]npm[/\\]bin[/\\]npm-cli\.js$/, 'lib/node_modules/pnpm/bin/pnpm.cjs')
    else if (/[/\\]nodejs[/\\]npm[/\\]bin[/\\]npm-cli\.js$/.test(c)) d = c.replace(/[/\\]nodejs[/\\]npm[/\\]bin[/\\]npm-cli\.js$/, '/nodejs/pnpm/bin/pnpm.cjs')
    push(d)
  }

  // 常见全局 prefix（用户自选的 prefix 不在派生范围内，必须单独列）
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
 * 解析 pnpm 的调用方式：先用绝对路径调 `node <pnpm.cjs>`，再退回按 PATH 探 `pnpm`。
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

  // 绝对路径优先：node 是真可执行文件，不要 shell（加 shell 会先起 cmd.exe，受限环境下会被拒）
  if (typeof nodePath === 'string' && nodePath !== '') {
    for (const c of candidates) {
      if (typeof exists === 'function' && !exists(c)) continue
      const r = run(nodePath, [c, '--version'], false)
      if (r.ok) return { ok: true, version: r.version, how: `绝对路径 ${c}`, detail: `${r.version}（${c}）`, path: c }
    }
  }

  // 退回按 PATH 探命令：先直调，Windows 上再退回 shell（`.cmd` 垫片需要 cmd 解析）
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
 * 把 pnpm 所在目录（及其全局 bin）注进子进程 PATH。
 * 官方 `dsh plugin add` 内部靠子进程 PATH 找 pnpm，只解析出绝对路径并不能让它找到。
 * @returns {{env:Record<string,string|undefined>, prepended:string[]}}
 */
export function envWithPnpmOnPath({ pnpmPath, nodePath, env = process.env, platform = process.platform }) {
  // 只做字符串层面的目录拼接：路径可能来自另一个平台，不能用本机 path.join
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
