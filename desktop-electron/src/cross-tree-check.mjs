// cross-tree-check.mjs — vendor 树的平台向静态体检判据（纯函数，可离线单测）
import fs from 'node:fs'
import path from 'node:path'

/** 目标平台必需的原生件清单（与 `src/vendor-build.mjs` 的 `REQUIRED_PACKAGES` 有意重复）。 */
export function requiredNativeItems(target) {
  const { os, arch } = target
  if (os === 'win32') {
    return [
      ['@koromix/koffi-win32-x64', 'koffi 预编译'],
      // Windows 的 node-pty 加载 conpty.node / conpty_console_list.node，不是 pty.node。
      [`node-pty/prebuilds/win32-${arch}/conpty.node`, 'node-pty 预编译（conpty）'],
      [`node-pty/prebuilds/win32-${arch}/conpty_console_list.node`, 'node-pty 预编译（console list）'],
      [`node-pty/prebuilds/win32-${arch}/conpty/conpty.dll`, 'ConPTY 运行时'],
      [`node-pty/prebuilds/win32-${arch}/conpty/OpenConsole.exe`, 'ConPTY 宿主'],
      [`@img/sharp-win32-${arch}`, 'sharp 预编译'],
      ['@vscode/ripgrep-win32-x64', 'ripgrep 二进制'],
    ]
  }
  if (os === 'linux') {
    return [
      [`@koromix/koffi-linux-${arch}`, 'koffi 预编译'],
      [`node-pty/prebuilds/linux-${arch}/pty.node`, 'node-pty 预编译'],
      [`@img/sharp-linux-${arch}`, 'sharp 预编译'],
      [`@vscode/ripgrep-linux-${arch}`, 'ripgrep 二进制'],
      [`@deepseek-ai/node-addon-system-linux-${arch}`, 'POSIX flock'],
    ]
  }
  return []
}

/**
 * 对一棵 vendor 树做平台向静态体检，返回断言汇总与判出的目标平台。
 * @param {{dir:string, lock:object, referenceLock?:object|null}} o dir 树根、已解析 lock、现网 lock（可选）
 * @returns {{pass:number, fail:number, checks:string[], target:object, tag:string}}
 */
export function checkCrossTree({ dir, lock, referenceLock = null }) {
  const checks = []
  let pass = 0
  let fail = 0
  const ok = (name, cond, detail = '') => {
    if (cond) { pass++; checks.push(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`) }
    else { fail++; checks.push(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`) }
  }
  const section = (t) => checks.push(`\n${t}`)

  const target = { os: lock?.platform?.os, arch: lock?.platform?.arch, libc: lock?.platform?.libc }
  const tag = lock?.platform?.tag ?? `${target.os}-${target.arch}`
  const nm = path.join(dir, 'profile', 'node_modules')
  const has = (rel) => fs.existsSync(path.join(nm, rel))

  section(`① lock（目标平台 ${tag}${target.libc ? ` / libc=${target.libc}` : ''}）`)
  ok('lock 记录了 platform 段', typeof target.os === 'string' && typeof tag === 'string', JSON.stringify(lock?.platform))
  ok('lock.platformPackages 非空', Array.isArray(lock?.platformPackages) && lock.platformPackages.length > 0,
    (lock?.platformPackages ?? []).join(' / ') || '（空）')
  ok('lock.nodeModulesFiles 有基线值（依赖完整性判据）',
    Number.isFinite(lock?.nodeModulesFiles) && lock.nodeModulesFiles > 1000, String(lock?.nodeModulesFiles))
  ok('门禁结论与 gatesDeferred 自洽（延后不得写 PASS）',
    lock?.gatesDeferred?.abi === true ? /DEFERRED/.test(String(lock?.abiScan)) : String(lock?.abiScan) === 'PASS',
    `abiScan=${lock?.abiScan} gatesDeferred=${JSON.stringify(lock?.gatesDeferred)}`)

  section('② 目标平台必需原生包')
  for (const [rel, what] of requiredNativeItems(target)) ok(`${what}：${rel}`, has(rel))
  if (target.os === 'win32') {
    ok('Windows 树上没有（也不需要）unix 的 pty.node', !has(`node-pty/prebuilds/win32-${target.arch}/pty.node`))
  }

  // mergedPlatforms 兼容 `"linux-x64"` 字符串与 `{os,arch,tag}` 对象两种写法。
  const merged = (Array.isArray(lock?.mergedPlatforms) ? lock.mergedPlatforms : [])
    .map((m) => (typeof m === 'string' ? { tag: m } : m))
    .filter((m) => typeof m?.tag === 'string')
  const mergedTags = merged.map((m) => m.tag)
  section(`②b 并入的架构（${merged.length === 0 ? '无，单平台树' : mergedTags.join(' / ')}）`)
  if (mergedTags.length > 0) {
    const missingMerged = []
    for (const m of merged) {
      const [os, arch] = m.tag.split('-')
      const mt = typeof m.os === 'string' && typeof m.arch === 'string' ? { os: m.os, arch: m.arch, libc: m.libc } : { os, arch }
      for (const [rel, what] of requiredNativeItems(mt)) {
        if (!fs.existsSync(path.join(nm, rel))) missingMerged.push(`[${m.tag}] ${what}`)
      }
    }
    ok('并入架构的平台专属件逐项齐全（不只看主架构）', missingMerged.length === 0,
      missingMerged.slice(0, 6).join(', ') || `${mergedTags.join('/')} 全部就位`)
  }

  section('③ 其他平台残留（交叉安装最常见的污染）')
  const foreignKoffi = target.os === 'win32' ? `linux-${target.arch}` : 'win32-x64'
  ok(`koffi 不含 ${foreignKoffi}`, !fs.existsSync(path.join(nm, '@koromix', foreignKoffi)))
  const ptyRoot = path.join(nm, 'node-pty', 'prebuilds')
  const ptyDirs = fs.existsSync(ptyRoot) ? fs.readdirSync(ptyRoot) : []
  const keepTags = new Set([tag, ...mergedTags])
  ok('node-pty/prebuilds 只留目标（与并入的）平台', ptyDirs.every((d) => keepTags.has(d)), ptyDirs.join(' / ') || '（空）')
  const foreignOS = ['win32', 'linux'].filter((o) => o !== target.os)
  if (foreignOS.length > 0) {
    const foreignHits = []
    for (const fo of foreignOS) {
      for (const fa of [target.arch, target.arch === 'arm64' ? 'x64' : 'arm64']) {
        const tag = `${fo}-${fa}`
        for (const [label, rel] of [
          ['koffi', `@koromix/koffi-${tag}`],
          ['sharp', `@img/sharp-${tag}`],
          ['ripgrep', `@vscode/ripgrep-${tag}`],
          ['node-addon-system', `@deepseek-ai/node-addon-system-${tag}`],
          ['node-pty 预编译', `node-pty/prebuilds/${tag}`],
        ]) if (fs.existsSync(path.join(nm, rel))) foreignHits.push(`${label}（${rel}）`)
      }
    }
    ok(`不含 ${foreignOS.join('/')} 平台的专属件（逐类 × 逐架构）`, foreignHits.length === 0,
      foreignHits.join(', ') || `探了 ${foreignOS.length * 2 * 5} 处`)
    const strayDirs = ptyDirs.filter((d) => !keepTags.has(d))
    ok('node-pty/prebuilds 下没有别平台的目录（按目录名扫，不靠模板）', strayDirs.length === 0,
      strayDirs.join(', ') || ptyDirs.join(' / ') || '（空）')
  }
  // ConPTY 目录名是 win10-*，按平台命名的通用规则扫不到。
  const conptyRoot = path.join(nm, 'node-pty', 'third_party', 'conpty')
  if (target.os === 'win32') {
    const winDirs = fs.existsSync(conptyRoot)
      ? fs.readdirSync(conptyRoot).flatMap((v) => {
        const vd = path.join(conptyRoot, v)
        return fs.statSync(vd).isDirectory() ? fs.readdirSync(vd).map((a) => `${v}/${a}`) : []
      })
      : []
    const want = target.arch === 'arm64' ? 'win10-arm64' : target.arch === 'ia32' ? 'win10-ia32' : 'win10-x64'
    ok('ConPTY 只留目标架构那一份', winDirs.every((d) => d.endsWith(want)), winDirs.join(' / ') || '（空）')
  } else {
    ok('非 Windows 目标不含 ConPTY 运行时（Windows 专属）', !fs.existsSync(conptyRoot))
  }
  ok('不含 sharp 的 wasm32 兜底（按需方永远轮不到）', !has(path.join('@img', 'sharp-wasm32')))

  section('④ node-pty prebuilds')
  ok(`保留了 ${tag}`, ptyDirs.filter((d) => d === tag).length === 1)
  for (const d of ptyDirs) {
    let files = []
    try { files = fs.readdirSync(path.join(ptyRoot, d)) } catch {}
    checks.push(`        ${d}/: ${files.join(', ') || '（空）'}`)
  }

  section('⑤ spawn-helper（pty 的辅助程序，两平台都不该有）')
  const helper = path.join(ptyRoot, tag, 'spawn-helper')
  ok('不含 spawn-helper', !fs.existsSync(helper), fs.existsSync(helper) ? '意外存在' : 'prebuilds 里只有 pty.node')

  section('⑥ 与现网树对比')
  if (referenceLock && !(path.resolve(dir) === path.resolve(referenceLock.__dir ?? ''))) {
    const ratio = lock.totalFiles / referenceLock.totalFiles
    checks.push(`        本树 ${lock.totalFiles} 文件 / ${(lock.totalBytes / 1048576).toFixed(1)} MB（${tag}）`)
    checks.push(`        现网 ${referenceLock.totalFiles} 文件 / ${(referenceLock.totalBytes / 1048576).toFixed(1)} MB（${referenceLock.platform?.tag ?? '（lock 未记录平台：旧格式）'}）`)
    ok('文件数量级相当（0.8–1.3 倍）', ratio > 0.8 && ratio < 1.3, `比值 ${ratio.toFixed(3)}`)
    ok('现网 lock 已记录平台段（平台口径一致）', typeof referenceLock.platform?.tag === 'string',
      referenceLock.platform?.tag ?? '（lock 未记录平台：旧格式，重新构建后会有）')
  } else {
    checks.push('        传的就是现网树本身（或未提供现网 lock），跳过对比')
  }

  return { pass, fail, checks, target, tag }
}
