// cross-tree-check.mjs — vendor 树的"平台向静态体检"判据（纯函数，可离线单测）
//
// 为什么把判据与 CLI 分开：判据里每一条都对着一个真实失败模式，而**判断本身必须能被单测钉住**——
// CLI 只是取目录、打印、定退出码。判据写在 CLI 里就没法造夹具测（要真造一棵 100 MB 的树）。
//
// 判据清单（逐条对应一个踩过的坑）：
//   ① lock 平台段与门禁结论自洽 —— 门禁**延后**了却写 `PASS` 就是假绿（比不写更坏）
//   ② 目标平台必需原生包 —— 缺件会让宿主在 import 期起不来（koffi/node-pty）或会话写不进去（flock）
//   ③ 别平台残留 —— 交叉安装最常见的污染；包体白涨，还可能被加载到错的架构
//   ④ node-pty prebuilds —— 剪枝最容易剪错的地方：剪掉目标平台那份 = 没有终端
//   ⑤ spawn-helper —— **只有 macOS 有**（`src/unix/pty.cc` 的 helper 分支仅 `__APPLE__` 编译，
//      Linux 走 `forkpty()`）；对 Linux 显式断言"不该有"，免得有人去修一个不存在的缺件
//   ⑥ 同一份源码装出来的三棵树体量应当相当 —— 差一个数量级说明装漏了
import fs from 'node:fs'
import path from 'node:path'

/**
 * 各平台**必需**的原生件。与 `src/vendor-build.mjs` 的 `REQUIRED_PACKAGES` 是**有意重复**的：
 * 那份是"构建期拒绝产出"的门禁（写死在做树的那一侧），这份是"事后体检"的判据。
 * 两者独立写，才能互相发现漂移（Windows 行曾因为把它们当成一回事而漏掉 conpty 三件套）。
 * @param {{os:string, arch:string}} target 目标平台
 * @returns {Array<[string, string]>} [相对 node_modules 的路径, 人读说明]
 */
export function requiredNativeItems(target) {
  const { os, arch } = target
  if (os === 'win32') {
    return [
      ['@koromix/koffi-win32-x64', 'koffi 预编译'],
      // Windows 的 node-pty 加载 conpty.node / conpty_console_list.node，**不是** pty.node。
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
  if (os === 'darwin') {
    return [
      [`@koromix/koffi-darwin-${arch}`, 'koffi 预编译'],
      [`node-pty/prebuilds/darwin-${arch}/pty.node`, 'node-pty 预编译'],
      [`@img/sharp-darwin-${arch}`, 'sharp 预编译'],
      [`@vscode/ripgrep-darwin-${arch}`, 'ripgrep 二进制'],
      [`@deepseek-ai/node-addon-system-darwin-${arch}`, 'POSIX flock'],
    ]
  }
  return []
}

/**
 * 对一棵 vendor 树做平台向静态体检。
 * @param {{dir:string, lock:object, referenceLock?:object|null, hostPlatform?:string}} o
 *   dir 树根（含 profile/ 与 vendor.lock.json）、lock 已解析的 lock、referenceLock 现网 lock（可选）
 * @returns {{pass:number, fail:number, checks:string[], target:object, tag:string}}
 */
export function checkCrossTree({ dir, lock, referenceLock = null, hostPlatform = process.platform }) {
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

  // ── ① lock 平台段与门禁结论 ──
  section(`① lock（目标平台 ${tag}${target.libc ? ` / libc=${target.libc}` : ''}）`)
  ok('lock 记录了 platform 段', typeof target.os === 'string' && typeof tag === 'string', JSON.stringify(lock?.platform))
  ok('lock.platformPackages 非空', Array.isArray(lock?.platformPackages) && lock.platformPackages.length > 0,
    (lock?.platformPackages ?? []).join(' / ') || '（空）')
  ok('lock.nodeModulesFiles 有基线值（依赖完整性判据）',
    Number.isFinite(lock?.nodeModulesFiles) && lock.nodeModulesFiles > 1000, String(lock?.nodeModulesFiles))
  // 门禁结论必须与 gatesDeferred 自洽：说了"延后"就不得写 PASS。这是本体检最要紧的一条。
  ok('门禁结论与 gatesDeferred 自洽（延后不得写 PASS）',
    lock?.gatesDeferred?.abi === true ? /DEFERRED/.test(String(lock?.abiScan)) : String(lock?.abiScan) === 'PASS',
    `abiScan=${lock?.abiScan} gatesDeferred=${JSON.stringify(lock?.gatesDeferred)}`)

  // ── ② 目标平台必需原生包 ──
  section('② 目标平台必需原生包')
  for (const [rel, what] of requiredNativeItems(target)) ok(`${what}：${rel}`, has(rel))
  if (target.os === 'win32') {
    // 反向断言：Windows 树上**不该有** pty.node。旧的门禁表按"POSIX 都有 pty.node"写，
    // 在 Windows 上必然误报缺件（把完好的树说成坏的）。这条把那个错误方向钉死。
    ok('Windows 树上没有（也不需要）unix 的 pty.node', !has(`node-pty/prebuilds/win32-${target.arch}/pty.node`))
  }

  // ── ②b 并进来的其它架构（macOS 双架构打包；见 mergePlatformPackages）──
  // 接受两种写法：`"darwin-x64"`（字符串）与 `{os,arch,tag}`（对象）——lock 是人读的，
  // 而两代格式在真实文件里都可能出现，体检不该因为写法不同就判失败。
  //
  // 判据放在 ③ 段里**一条聚合断言**（"并入架构的平台专属件逐项齐全"），这里不逐项再报一遍：
  // 同一件事报两条会让人以为"两个独立问题"，也让"按名字取某条结论"的测试辅助函数命中多行
  // （本轮实测踩到：`cross-tree-self-test` 的 verdict 因此返回 null，两条断言莫名变红）。
  const merged = (Array.isArray(lock?.mergedPlatforms) ? lock.mergedPlatforms : [])
    .map((m) => (typeof m === 'string' ? { tag: m } : m))
    .filter((m) => typeof m?.tag === 'string')
  const mergedTags = merged.map((m) => m.tag)
  section(`②b 并入的架构（${merged.length === 0 ? '无，单平台树' : mergedTags.join(' / ')}）`)
  // 并入的架构也要逐项验必需件（只验主架构会漏掉"另一架构整批没进来"——那会让那个架构的包装上也起不来）
  if (mergedTags.length > 0) {
    const missingMerged = []
    for (const m of merged) {
      const mt = typeof m.os === 'string' && typeof m.arch === 'string'
        ? { os: m.os, arch: m.arch, libc: m.libc }
        : (([os, arch]) => ({ os, arch }))(m.tag.split('-'))
      for (const [rel, what] of requiredNativeItems(mt)) {
        if (!fs.existsSync(path.join(nm, rel))) missingMerged.push(`[${m.tag}] ${what}`)
      }
    }
    ok('并入架构的平台专属件逐项齐全（不只看主架构）', missingMerged.length === 0,
      missingMerged.slice(0, 6).join(', ') || `${mergedTags.join('/')} 全部就位`)
  }

  // ── ③ 别平台残留 ──
  section('③ 其他平台残留（交叉安装最常见的污染）')
  const foreignKoffi = target.os === 'win32' ? `linux-${target.arch}` : 'win32-x64'
  ok(`koffi 不含 ${foreignKoffi}`, !fs.existsSync(path.join(nm, '@koromix', foreignKoffi)))
  const ptyRoot = path.join(nm, 'node-pty', 'prebuilds')
  const ptyDirs = fs.existsSync(ptyRoot) ? fs.readdirSync(ptyRoot) : []
  // 双架构树里，**并入的那个架构**的 prebuilds 是必需项，不是残留
  const keepTags = new Set([tag, ...mergedTags])
  ok('node-pty/prebuilds 只留目标（与并入的）平台', ptyDirs.every((d) => keepTags.has(d)), ptyDirs.join(' / ') || '（空）')
  // **反向断言**：上面只查了"该有的在"，没查"不该有的不在"。而对 macOS 双架构树来说，
  // "另一台机器上装的树被别平台污染"是打包阶段完全不报错的一类问题（`extraResources` 是整目录照拷），
  // 症状是那个架构的包"装上也起不来"。
  //
  // 第一版只探了**目标架构**（`koffi-<other>-<target.arch>`），于是 `koffi-win32-arm64` 这种
  // "别的平台 + 别的架构"的污染它看不见 —— 探针当场证明了这一点。现在两头都探：
  //   · 逐类点名：foreignOS × {目标架构, 另一个架构}
  //   · 目录扫描：`node-pty/prebuilds/` 下**任何**非目标平台的目录都算残留（不依赖命名模板）
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
    // 目录扫描：`prebuilds/` 下只允许目标平台族（含并入的架构）
    const strayDirs = ptyDirs.filter((d) => !keepTags.has(d))
    ok('node-pty/prebuilds 下没有别平台的目录（按目录名扫，不靠模板）', strayDirs.length === 0,
      strayDirs.join(', ') || ptyDirs.join(' / ') || '（空）')
  }
  // ConPTY：Windows 专属运行时，目录名是 `win10-*`（既非 win32-* 也不叫 pty.node），通用规则看不见它
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
  // sharp 的 wasm32 兜底：按需加载，本平台预编译在时永远轮不到，三个平台都该剪掉（~9 MB）
  ok('不含 sharp 的 wasm32 兜底（按需方永远轮不到）', !has(path.join('@img', 'sharp-wasm32')))

  // ── ④ node-pty prebuilds 明细 ──
  section('④ node-pty prebuilds')
  ok(`保留了 ${tag}`, ptyDirs.filter((d) => d === tag).length === 1)
  for (const d of ptyDirs) {
    let files = []
    try { files = fs.readdirSync(path.join(ptyRoot, d)) } catch { /* 读不到就不列 */ }
    checks.push(`        ${d}/: ${files.join(', ') || '（空）'}`)
  }

  // ── ⑤ spawn-helper ──
  section('⑤ spawn-helper（pty 的辅助程序；仅 macOS 用）')
  const helper = path.join(ptyRoot, tag, 'spawn-helper')
  if (target.os === 'win32') {
    ok('Windows 不需要 spawn-helper', !fs.existsSync(helper))
  } else if (target.os === 'linux') {
    ok('Linux 上 spawn-helper 缺席属正常（pty.cc 的 helper 分支仅 __APPLE__ 编译）', !fs.existsSync(helper),
      fs.existsSync(helper) ? '意外存在' : 'prebuilds 里只有 pty.node')
  } else {
    const exists = fs.existsSync(helper)
    ok(`spawn-helper 存在：prebuilds/${tag}/spawn-helper`, exists)
    if (exists) {
      const st = fs.statSync(helper)
      const mode = st.mode & 0o7777
      // 只有 POSIX 宿主读得到真实 mode。Windows 的 NTFS 一律报 0o666/0o444，
      // 此时"位"由 ensureSpawnHelpers 与打包工具链承担，这里不判 FAIL、只记录。
      if (hostPlatform !== 'win32') {
        ok('spawn-helper 有可执行位（0755）', (mode & 0o111) === 0o111, `mode=${mode.toString(8)}`)
      } else {
        checks.push(`        size=${st.size} mode=${mode.toString(8)}（NTFS 不保存 x 位，无法在 Windows 宿主上判定；由确保步骤与打包工具链承担）`)
      }
    }
  }

  // ── ⑥ 体量对比 ──
  section('⑥ 与现网树对比')
  if (referenceLock && !(path.resolve(dir) === path.resolve(referenceLock.__dir ?? ''))) {
    const ratio = lock.totalFiles / referenceLock.totalFiles
    checks.push(`        本树 ${lock.totalFiles} 文件 / ${(lock.totalBytes / 1048576).toFixed(1)} MB（${tag}）`)
    checks.push(`        现网 ${referenceLock.totalFiles} 文件 / ${(referenceLock.totalBytes / 1048576).toFixed(1)} MB（${referenceLock.platform?.tag ?? '（lock 未记录平台：旧格式）'}）`)
    ok('文件数量级相当（0.8–1.3 倍）', ratio > 0.8 && ratio < 1.3, `比值 ${ratio.toFixed(3)}`)
    ok('现网 lock 已记录平台段（三平台口径一致）', typeof referenceLock.platform?.tag === 'string',
      referenceLock.platform?.tag ?? '（lock 未记录平台：旧格式，重新构建后会有）')
  } else {
    checks.push('        传的就是现网树本身（或未提供现网 lock），跳过对比')
  }

  return { pass, fail, checks, target, tag }
}
