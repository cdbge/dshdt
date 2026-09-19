// vendor-build.mjs — vendor 树构建原语：装依赖、剪枝、插件同步、ABI/启动门禁、写版本锁。
// 绝不写现网 vendor/profile：所有写入都发生在调用方给定的 targetDir/profileDir 内。
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_REGISTRY } from './dsh-update.mjs'
import { extractHostUrl, freePort, killTree, probeHostReady, startHost } from './host.mjs'
import { safeRemoveTree } from './junction-safe.mjs'

/** 随包分发的自研插件名（不在 npm 依赖里）。与 `main.mjs` 的 `PROFILE_PLUGIN_NAMES` 必须两处同改。 */
export const DEFAULT_PLUGIN_NAMES = ['dsh-desktop-ui', 'dsh-auto-approval', 'dsh-market']

/** 运行时永不加载、且直接决定安装耗时的内容（Defender 逐文件扫描是安装慢的主因）。 */
const PRUNE_DIRS = new Set(['test', 'tests', '__tests__', 'docs', 'examples', 'benchmark', 'benchmarks'])

/** @typedef {{os:'win32'|'linux'|'darwin', arch:'x64'|'arm64', libc?:'glibc'|'musl'}} TargetPlatform */

/** 当前运行进程的平台三元组（Linux 上按 glibc 探测 libc；容器里 musl 会命中 alpine 的包名）。 */
export function currentTarget() {
  let libc
  if (process.platform === 'linux') {
    try {
      const report = process.report?.getReport?.()
      libc = report?.header?.glibcVersionRuntime ? 'glibc' : 'musl'
    } catch { libc = 'glibc' }
  }
  return { os: process.platform, arch: process.arch, libc }
}

/** 把目标平台归一成 `os-arch`（ABI 门禁与日志统一用这个口径）。 */
export function platformTag(target) {
  return `${target.os}-${target.arch}`
}

/** ConPTY 的目录名：架构在前、平台在后（`win10-x64` / `win10-arm64`），与 `platformTag` 不同形。 */
export function conptyDirName(arch) {
  return arch === 'arm64' ? 'win10-arm64' : arch === 'ia32' ? 'win10-ia32' : 'win10-x64'
}

/** 一个包/路径名里是否带目标平台的 `<os>-<arch>` 标记（npm 的平台专属包都按这个惯例命名）。 */
export function isPlatformTaggedPath(rel, target) {
  return rel.toLowerCase().includes(platformTag(target).toLowerCase())
}

/** 把 donor 树里目标平台专属的包并进 target 树（macOS 双架构一棵树）；missing 非空表示 donor 缺件。 */
export function mergePlatformPackages({ donorProfileDir, profileDir, target, donorRoot, log = () => {} }) {
  const donorNm = path.join(donorProfileDir, 'node_modules')
  const nmDir = path.join(profileDir, 'node_modules')
  const copied = []
  const missing = []
  if (!fs.existsSync(donorNm)) return { copied, missing: [`donor 树没有 node_modules：${donorNm}`] }

  // donor 树必须真的是那个平台的；平台锁在 donor 的**暂存根**里（`<root>/vendor.lock.json`）。
  const donorLock = path.join(donorRoot ?? path.join(donorProfileDir, '..'), 'vendor.lock.json')
  if (fs.existsSync(donorLock)) {
    try {
      const dtag = JSON.parse(fs.readFileSync(donorLock, 'utf8')).platform?.tag
      if (dtag !== undefined && dtag !== platformTag(target)) {
        return { copied, missing: [`donor 树的平台是 ${dtag}，与目标 ${platformTag(target)} 不符`] }
      }
    } catch { /* lock 读不出就不作为否决理由 */ }
  }

  /** 收集路径里带目标平台标记的最外层条目（包、`@scope/包`、`node-pty/prebuilds/<tag>`）。 */
  const collect = () => {
    const out = []
    let top = []
    try { top = fs.readdirSync(donorNm, { withFileTypes: true }) } catch { return out }
    for (const e of top) {
      if (!e.isDirectory()) continue
      if (e.name.startsWith('@')) {
        for (const sub of (() => { try { return fs.readdirSync(path.join(donorNm, e.name), { withFileTypes: true }) } catch { return [] } })()) {
          if (!sub.isDirectory()) continue
          const rel = `${e.name}/${sub.name}`
          if (isPlatformTaggedPath(rel, target)) out.push(rel)
        }
        continue
      }
      if (isPlatformTaggedPath(e.name, target)) { out.push(e.name); continue }
      // node-pty 的平台件藏在普通包里面：prebuilds/<os>-<arch>
      if (e.name === 'node-pty') {
        const prebuilds = path.join(donorNm, 'node-pty', 'prebuilds')
        for (const d of (() => { try { return fs.readdirSync(prebuilds, { withFileTypes: true }) } catch { return [] } })()) {
          if (d.isDirectory() && isPlatformTaggedPath(`node-pty/prebuilds/${d.name}`, target)) out.push(`node-pty/prebuilds/${d.name}`)
        }
      }
    }
    return out
  }
  const wanted = collect()
  if (wanted.length === 0) missing.push(`donor 树里没有任何 ${platformTag(target)} 专属条目（判断是否装错平台）`)

  for (const rel of wanted) {
    const from = path.join(donorNm, rel)
    const to = path.join(nmDir, rel)
    if (!fs.existsSync(from)) { missing.push(rel); continue }
    if (fs.existsSync(to)) safeRemoveTree(to)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.cpSync(from, to, { recursive: true, dereference: false, verbatimSymlinks: true })
    copied.push(rel)
  }
  log(`[vendor-build] 平台专属包合并（${platformTag(target)} ← donor）：${copied.length} 项${missing.length > 0 ? `，缺 ${missing.length} 项` : ''}`)
  for (const c of copied) log(`[vendor-build]   + ${c}`)
  return { copied, missing }
}

// C 库变体目录名的识别模式（预编译成常量：内联正则会被 `ci-self-test` 的"被调用但从未声明"体检误报）
const LIBC_MUSL_RE = /^musl(_|-|$)/
const LIBC_MUSL_EXACT = /^musl$/
const LIBC_GLIBC_RE = /^glibc(_|-|$)/
const LIBC_GNU_EXACT = /^gnu$/
const LIBC_GNU_EABIHF = /^gnueabihf$/
// koffi 用 `linux_x64` 表示 glibc 版（同包的 musl 版叫 `musl_x64`）。
const LIBC_KOFFI_GLIBC = /^linux_(x64|arm64|ia32|arm)$/

/** 路径是否属于**另一种 C 库**（glibc ↔ musl）的制品：平台包会同时带两套同名的 C 库子目录。 */
export function isForeignLibcPath(rel, target) {
  const segs = rel.toLowerCase().split(/[\\/]/)
  const has = (re) => segs.some((s) => re.test(s))
  const isMusl = has(LIBC_MUSL_RE) || has(LIBC_MUSL_EXACT)
  const isGnu = has(LIBC_GLIBC_RE) || has(LIBC_GNU_EXACT) || has(LIBC_GNU_EABIHF) || has(LIBC_KOFFI_GLIBC)
  if (!isMusl && !isGnu) return false
  const want = target.libc === 'musl' ? 'musl' : 'gnu'
  // 两套都在（包内并列）时不算"外来"——真正的取舍由加载器按系统决定，门禁不该拦
  if (isMusl && isGnu) return false
  return isMusl ? want !== 'musl' : want !== 'gnu'
}

/** 某个 .node 是否属于本平台必需的原生包（决定 ABI 失败是 FAIL 还是 SKIP）。 */
export function isEssentialNativePath(rel, target) {
  if (isForeignLibcPath(rel, target)) return false
  if (/[\\/]node_modules[\\/](koffi|node-pty|sharp)[\\/]/.test(rel)) return true
  return rel.includes(platformTag(target))
}

/** 路径里是否**只**出现其它平台的标记（这类 .node 在本平台加载失败属预期，记 SKIP）。 */
export function isForeignPlatformPath(rel, target) {
  const TAGS = ['win32-x64', 'win32-arm64', 'win32-ia32', 'linux-x64', 'linux-arm64', 'linux-arm',
    'linux-ia32', 'linux-ppc64', 'linux-riscv64', 'linux-s390x', 'linuxmusl-x64', 'linuxmusl-arm64',
    'linuxmusl-arm', 'darwin-x64', 'darwin-arm64', 'freebsd-x64', 'freebsd-wasm32',
    'webcontainers-wasm32', 'android-arm64', 'android-x64', 'openbsd-x64', 'sunos-x64',
    // ConPTY 的目录名自成一格（`win10-arm64` / `win10-x64`），缺了它门禁会放行另一架构的 .node/.dll
    'win10-x64', 'win10-arm64', 'win10-ia32']
  const lower = rel.toLowerCase()
  const tags = TAGS.filter((t) => lower.includes(t))
  if (tags.length === 0) return false
  const mine = platformTag(target)
  const own = target.os === 'linux' && target.libc === 'musl' ? `linuxmusl-${target.arch}` : mine
  return !tags.some((t) => t === mine || t === own)
}

/** 目标平台上**必需**的原生包（缺失即"装上也起不来"）；Windows 行用 conpty 系列文件而非 Unix 的 pty.node。 */
const REQUIRED_PACKAGES = {
  always: ['koffi', 'node-pty', 'sharp'],
  byOs: {
    win32: {
      koffi: '@koromix/koffi-win32-x64',
      'node-pty(conpty)': 'node-pty/prebuilds/win32-x64/conpty.node',
      'node-pty(conpty_console_list)': 'node-pty/prebuilds/win32-x64/conpty_console_list.node',
      'node-pty(conpty.dll)': 'node-pty/prebuilds/win32-x64/conpty/conpty.dll',
      'node-pty(OpenConsole.exe)': 'node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe',
      sharp: '@img/sharp-win32-x64',
      ripgrep: '@vscode/ripgrep-win32-x64',
    },
    linux: { koffi: '@koromix/koffi-linux-{arch}', 'node-pty': 'node-pty/prebuilds/linux-{arch}/pty.node', sharp: '@img/sharp-linux-{arch}', ripgrep: '@vscode/ripgrep-linux-{arch}', flock: '@deepseek-ai/node-addon-system-linux-{arch}' },
    darwin: { koffi: '@koromix/koffi-darwin-{arch}', 'node-pty': 'node-pty/prebuilds/darwin-{arch}/pty.node', sharp: '@img/sharp-darwin-{arch}', ripgrep: '@vscode/ripgrep-darwin-{arch}', flock: '@deepseek-ai/node-addon-system-darwin-{arch}' },
  },
}

/** 校验目标平台必需的原生包是否真的落进了树里（ABI 门禁对"包根本没装进来"无感）。 */
export function verifyTargetPackages(profileDir, target) {
  const nmDir = path.join(profileDir, 'node_modules')
  const table = REQUIRED_PACKAGES.byOs[target.os] ?? REQUIRED_PACKAGES.byOs.linux
  const probe = (spec) => spec.replaceAll('{arch}', target.arch)
  const present = []
  const missing = []
  const check = (label, spec, kind) => {
    const s = probe(spec)
    const abs = path.join(nmDir, s)
    let found = false
    let why = ''
    if (kind === 'file') {
      found = fs.existsSync(abs)
    } else {
      // 不用 require.resolve：它会缓存已解析的路径，目录删掉后第二次仍返回旧路径
      const pj = path.join(abs, 'package.json')
      if (fs.existsSync(pj)) {
        found = true
        try {
          const declared = JSON.parse(fs.readFileSync(pj, 'utf8')).name
          if (typeof declared === 'string' && declared !== '' && declared !== s) { found = false; why = `包名不符：${declared}` }
        } catch { /* 读不出就当存在性已足够说明问题 */ }
      }
    }
    if (found) present.push(label)
    else missing.push(`${label}（${s}${why === '' ? '' : `，${why}`}）`)
  }
  for (const name of REQUIRED_PACKAGES.always) check(name, name, 'package')
  for (const [label, spec] of Object.entries(table)) {
    const kind = /\.(node|exe|dll|so|dylib)$/.test(spec) ? 'file' : 'package'
    const name = label === 'flock' ? 'node-addon-system(flock)' : `${label}:${platformTag(target)}`
    check(name, spec, kind)
  }
  return { ok: missing.length === 0, present, missing }
}

/** 补 POSIX 上 spawn-helper 的可执行位（`--ignore-scripts` 吃掉了 postinstall 的 chmod）；只有 macOS 带它。 */
export function ensureSpawnHelpers(profileDir, target) {
  if (target.os === 'win32') return { changed: 0, skipped: 0 }
  let changed = 0
  let skipped = 0
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { walk(p); continue }
      if (e.name !== 'spawn-helper') continue
      try {
        const cur = fs.statSync(p).mode & 0o777
        if (cur === 0o755) { skipped += 1; continue }
        fs.chmodSync(p, 0o755)
        changed += 1
      } catch { skipped += 1 }
    }
  }
  walk(path.join(profileDir, 'node_modules'))
  return { changed, skipped }
}

/** 剪枝时应当删除的 node-pty 预编译目录：**除目标平台之外**的全部。 */
export function foreignPtyPrebuilds(target) {
  const all = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64', 'win32-arm64']
  const keep = `${target.os}-${target.arch}`
  return all.filter((p) => p !== keep)
}

/** dlopen 探针：成功写 OK 退 0，失败写原因退 1。 */
const ABI_PROBE = "try{process.dlopen(module,process.argv[1]);process.stdout.write('OK')}catch(e){process.stdout.write(String(e.message));process.exit(1)}"

/** 字节 → MB 文案。 */
export function formatMb(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MB`
}

/** 递归累计目录字节数。目录不存在返回 0（暂存区尚未创建是常态，不该抛）。 */
export function dirSize(dir) {
  let total = 0
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(p)
    else if (entry.isFile()) { try { total += fs.statSync(p).size } catch { /* 并发删除则略过 */ } }
  }
  return total
}

/** 递归累计文件数（不含目录本身）。目录不存在返回 0。 */
export function countFiles(dir) {
  let n = 0
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) n += countFiles(p)
    else n += 1
  }
  return n
}

/** npm install 的预期包数（进度分母，只是估计值）。 */
export const DEFAULT_EXPECTED_PACKAGES = 520

/** 数 `node_modules` 下已就位的"包"数（`@scope/x` 记 1、跳过点开头目录）；读不到当 0，不抛。 */
export function countPackages(nodeModulesDir) {
  let n = 0
  let entries
  try { entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (entry.name.startsWith('@')) {
      try {
        for (const sub of fs.readdirSync(path.join(nodeModulesDir, entry.name), { withFileTypes: true })) {
          if (sub.isDirectory()) n += 1
        }
      } catch { /* 正在写，忽略这一次 */ }
    } else {
      n += 1
    }
  }
  return n
}

/** 整目录重建：先删后建。删不干净即抛，避免产出新旧混合的树。 */
export function resetDir(dir) {
  const swept = safeRemoveTree(dir)
  if (swept.leftovers > 0) {
    throw new Error(`resetDir 未能清空 ${dir}（残留 ${swept.leftovers} 项，可能有文件被占用）；拒绝在其上构建，避免产出新旧混合的树`)
  }
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 写 profile manifest（bundles 锁 dsh-base + dsh-web-app）。 */
export function writeManifest(profileDir, versions) {
  const manifest = {
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: versions,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }
  fs.mkdirSync(profileDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

/** 锁文件的位置：**vendor/ 下**（profile 的上一级）——平台中立，三平台共用同一份。 */
export const VENDOR_LOCKFILE_NAME = 'package-lock.json'

/** 找出版本锁的候选位置，用锁钉死**传递依赖**版本；消费锁用 `npm install`（`npm ci` 在另一平台必然对不上）。 */
export function findVendorLockfile(profileDir, lockDir) {
  const candidates = []
  if (lockDir !== undefined && lockDir !== null) candidates.push(path.join(lockDir, VENDOR_LOCKFILE_NAME))
  candidates.push(
    // 真实构建走暂存布局 `<out>/.staging-build/profile`，所以候选要含上两级的父目录
    path.join(path.dirname(profileDir), VENDOR_LOCKFILE_NAME),
    path.join(path.dirname(path.dirname(profileDir)), VENDOR_LOCKFILE_NAME),
    path.join(profileDir, VENDOR_LOCKFILE_NAME),
  )
  for (const p of candidates) if (fs.existsSync(p)) return p
  return null
}

/** 候选 npm-cli.js 路径（三平台，含 Debian/Homebrew/nvm 等常见前缀）；打包态必须靠系统 Node 的安装位置兜底。 */
export function npmCandidates({ env = process.env, execPath = process.execPath, extraNodeDirs = [], exists = fs.existsSync } = {}) {
  const nodeDirs = []
  const add = (d) => { if (typeof d === 'string' && d !== '') nodeDirs.push(d) }
  if (env.DSH_NODE_DIR) add(env.DSH_NODE_DIR)
  if (env.ProgramFiles) add(path.join(env.ProgramFiles, 'nodejs'))
  for (const d of extraNodeDirs) add(d)
  add(path.dirname(execPath))

  const out = nodeDirs.map((d) => path.join(d, 'node_modules', 'npm', 'bin', 'npm-cli.js'))

  if (process.platform !== 'win32') {
    for (const prefix of ['/usr/local', '/usr', '/opt/homebrew', '/opt/local']) {
      out.push(path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    }
    out.push('/usr/share/nodejs/npm/bin/npm-cli.js')
    // nvm / fnm / volta / asdf：目录名带版本号，取存在的那些
    const nvmRoot = env.NVM_DIR ?? (env.HOME ? path.join(env.HOME, '.nvm') : '')
    if (nvmRoot) {
      const versionsDir = path.join(nvmRoot, 'versions', 'node')
      let entries = []
      try { entries = fs.readdirSync(versionsDir) } catch { entries = [] }
      for (const v of entries) out.push(path.join(versionsDir, v, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    }
    if (env.HOME) {
      out.push(path.join(env.HOME, '.volta', 'tools', 'image', 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    }
  }
  // 存在性过滤只作用于 POSIX 的**补充**候选；Windows 上契约是返回完整候选列表，由 findNpm 判定
  const supplements = out.slice(nodeDirs.length)
  return [...out.slice(0, nodeDirs.length), ...supplements.filter((p) => exists(p))]
}

/** 探测系统 npm（本应用不内置 npm）；找不到返回 null，调用方据此把按钮置灰。 */
export function findNpm({ exists = fs.existsSync, candidates = npmCandidates() } = {}) {
  for (const p of candidates) if (exists(p)) return p
  return null
}

/** 构造 npm 子进程环境：cacheDir **无条件覆盖** `npm_config_cache`，不让外部已设的坏值顶掉可写缓存。 */
export function buildInstallEnv({ cacheDir, registry = DEFAULT_REGISTRY, baseEnv = process.env }) {
  return { ...baseEnv, npm_config_cache: cacheDir, npm_config_registry: registry }
}

/** 跑 npm install（异步 spawn，避免冻住主进程）；stdio 一律走文件描述符重定向，沙箱下 pipe stdio 会 EPERM。 */
export function installDependencies({ profileDir, npmCli, runtime = process.execPath, env = process.env, logFile, target = null, ignoreScripts = true, lockfile = null }) {
  return new Promise((resolve) => {
    if (logFile) fs.mkdirSync(path.dirname(logFile), { recursive: true })
    let fd = 'ignore'
    if (logFile) {
      try { fd = fs.openSync(logFile, 'a') } catch { fd = 'ignore' }
    }
    const closeFd = () => { if (fd !== 'ignore') { try { fs.closeSync(fd) } catch { /* 已关 */ } } }
    let settled = false
    const done = (result) => { if (settled) return; settled = true; closeFd(); resolve(result) }
    let child
    try {
      if (lockfile !== null && lockfile !== undefined && fs.existsSync(lockfile)) {
        try { fs.copyFileSync(lockfile, path.join(profileDir, VENDOR_LOCKFILE_NAME)) } catch { /* 拷不进去就退回无锁安装 */ }
      }
      // `--os/--cpu/--libc` 透传给 npm，决定**可选依赖**按哪个平台解析（交叉构建的关键）
      const platformArgs = []
      if (target !== undefined && target !== null) {
        platformArgs.push('--os', target.os, '--cpu', target.arch)
        if (target.os === 'linux' && target.libc) platformArgs.push('--libc', target.libc)
      }
      const args = [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund', ...platformArgs]
      // `--ignore-scripts` 会吃掉 node-pty 的 postinstall（给 spawn-helper 补 0755），由 ensureSpawnHelpers 补位
      if (ignoreScripts) args.push('--ignore-scripts')
      child = spawn(runtime, args, {
        cwd: profileDir,
        // ELECTRON_RUN_AS_NODE 让打包态的 electron.exe 当纯 Node 用；作用域仅限本子进程
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      })
    } catch (e) { done({ ok: false, error: `无法启动 npm：${e.message}` }); return }
    child.on('error', (e) => done({ ok: false, error: `npm 进程错误：${e.message}` }))
    child.on('exit', (code) => done(code === 0 ? { ok: true } : { ok: false, error: `npm install 退出码 ${code}` }))
  })
}

/** 剪枝：删掉运行时永不加载的内容（Defender 逐文件扫描是安装慢的主因）；keepPlatforms 是还要保住的其它平台。 */
export function pruneVendorTree(profileDir, target = currentTarget(), o = {}) {
  const keep = [target, ...(o.keepPlatforms ?? [])]
  const keepPty = new Set(keep.map((t) => `${t.os}-${t.arch}`))
  let prunedBytes = 0
  let prunedFiles = 0
  const drop = (p) => {
    prunedBytes += dirSize(p)
    prunedFiles += countFiles(p)
    safeRemoveTree(p)
  }
  const droppedPtyPrebuilds = []
  for (const p of foreignPtyPrebuilds(target)) {
    if (keepPty.has(p)) continue
    const d = path.join(profileDir, 'node_modules', 'node-pty', 'prebuilds', p)
    if (fs.existsSync(d)) { drop(d); droppedPtyPrebuilds.push(p) }
  }

  const droppedPlatformDirs = []
  const dropIfPresent = (p, label) => {
    if (fs.existsSync(p)) { drop(p); droppedPlatformDirs.push(label) }
  }
  const conptyRoot = path.join(profileDir, 'node_modules', 'node-pty', 'third_party', 'conpty')
  if (target.os !== 'win32') {
    // ConPTY 是 Windows 的控制台 API，非 Windows 目标上这棵树纯属多余
    dropIfPresent(conptyRoot, 'node-pty/third_party/conpty（非 Windows 目标）')
  } else if (fs.existsSync(conptyRoot)) {
    const winKeeps = new Set(keep.filter((t) => t.os === 'win32').map((t) => conptyDirName(t.arch)))
    for (const ver of fs.readdirSync(conptyRoot)) {
      const verDir = path.join(conptyRoot, ver)
      if (!fs.statSync(verDir).isDirectory()) continue
      for (const archDir of fs.readdirSync(verDir)) {
        if (winKeeps.has(archDir)) continue
        dropIfPresent(path.join(verDir, archDir), `node-pty/third_party/conpty/${ver}/${archDir}`)
      }
    }
  }
  dropIfPresent(path.join(profileDir, 'node_modules', '@img', 'sharp-wasm32'), '@img/sharp-wasm32（wasm 兜底，按需方永远轮不到）')

  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (PRUNE_DIRS.has(entry.name)) { drop(p); continue }
        walk(p)
      } else if (entry.name.endsWith('.map') || entry.name.endsWith('.d.ts') || entry.name.endsWith('.md')
        || entry.name.endsWith('.pdb')
        || /^(LICENSE|LICENCE|COPYING|NOTICE|CHANGELOG|CHANGES|HISTORY|AUTHORS|CONTRIBUTING)(\.|$)/.test(entry.name)) {
        try { prunedBytes += fs.statSync(p).size } catch { /* 已删 */ }
        prunedFiles += 1
        fs.rmSync(p, { force: true })
      }
    }
  }
  walk(path.join(profileDir, 'node_modules'))
  return { prunedBytes, prunedFiles, droppedPtyPrebuilds, droppedPlatformDirs }
}

/** 把自研插件包拷进 vendor 树的 node_modules。missing 必须由调用方当硬失败处理，否则会静默产出缺插件的树。 */
export function syncVendorPlugins(profileDir, { packagesDir, pluginNames = DEFAULT_PLUGIN_NAMES }) {
  const copied = []
  const missing = []
  for (const name of pluginNames) {
    const src = path.join(packagesDir, name)
    if (!fs.existsSync(path.join(src, 'package.json'))) { missing.push(name); continue }
    const dst = path.join(profileDir, 'node_modules', name)
    // 安全删除（目标可能是链接）+ 保留链接形态拷贝；删不干净就抛，避免产出混合副本的树
    const swept = safeRemoveTree(dst)
    if (swept.leftovers > 0) {
      throw new Error(`插件位 ${name} 有 ${swept.leftovers} 项残留无法删除（文件被占用？）；拒绝产出混合副本的树`)
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.cpSync(src, dst, { recursive: true, dereference: false, verbatimSymlinks: true })
    copied.push(name)
  }
  return { copied, missing }
}

/** 抓一次探针的失败原因（文件描述符重定向，沙箱安全）。 */
function probeFailureReason(runtime, file, env) {
  const tmp = path.join(os.tmpdir(), `dsh-abi-probe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.log`)
  let fd
  try {
    fd = fs.openSync(tmp, 'w')
    spawnSync(runtime, ['-e', ABI_PROBE, file], { stdio: ['ignore', fd, fd], env, windowsHide: true })
    fs.closeSync(fd)
    fd = undefined
    const text = fs.readFileSync(tmp, 'utf8').trim()
    return text.split('\n').filter(Boolean).pop() || '未知错误（无输出）'
  } catch (e) {
    return `探针执行失败：${e.message}`
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* 已关 */ } }
    fs.rmSync(tmp, { force: true })
  }
}

/** ABI 门禁：在目标运行时下逐个 dlopen 所有 .node（常态只看退出码，失败项才抓详细原因）。 */
export function runAbiGate({ nodeModulesDir, runtime, env = process.env, target = currentTarget() }) {
  const files = []
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name.endsWith('.node')) files.push(p)
    }
  }
  walk(nodeModulesDir)
  files.sort()
  if (files.length === 0) return { ok: false, total: 0, okCount: 0, skipCount: 0, failCount: 0, failures: [], skipped: [], error: `未发现任何 .node（路径错？）：${nodeModulesDir}` }

  const childEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' }
  let okCount = 0
  let skipCount = 0
  const failures = []
  const skipped = []
  for (const file of files) {
    const rel = path.relative(nodeModulesDir, file)
    const r = spawnSync(runtime, ['-e', ABI_PROBE, file], { stdio: 'ignore', env: childEnv, windowsHide: true })
    if (r.status === 0) { okCount += 1; continue }
    // 判 SKIP 的两个理由（缺一个就会把健康的树报成坏的）：别平台的制品、别**C 库**的制品
    if (!isEssentialNativePath(rel, target) && (isForeignPlatformPath(rel, target) || isForeignLibcPath(rel, target))) {
      skipCount += 1
      skipped.push(rel)
      continue
    }
    const why = r.error ? `无法启动运行时：${r.error.message}` : probeFailureReason(runtime, file, childEnv)
    const hint = isEssentialNativePath(rel, target) ? `（本平台必需模块；目标 ${platformTag(target)} 上必须能加载）` : ''
    failures.push(`${rel} — ${why}${hint}`)
  }
  return { ok: failures.length === 0, total: files.length, okCount, skipCount, failCount: failures.length, failures, skipped }
}

/** 读运行时的 Node / Electron 版本（写进 vendor.lock.json 供事后诊断）；读不到返回两个 null。 */
export function readRuntimeVersions({ runtime, env = process.env }) {
  const tmp = path.join(os.tmpdir(), `dsh-nodever-${process.pid}-${Date.now()}.tmp`)
  let fd
  try {
    fd = fs.openSync(tmp, 'w')
    spawnSync(runtime, ['-e', "process.stdout.write(process.versions.node + '|' + process.versions.electron)"], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', fd, fd], windowsHide: true,
    })
    fs.closeSync(fd)
    fd = undefined
    const [nodeVer, electronVer] = fs.readFileSync(tmp, 'utf8').split('|')
    return { node: nodeVer || null, electron: electronVer || null }
  } catch {
    return { node: null, electron: null }
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* 已关 */ } }
    fs.rmSync(tmp, { force: true })
  }
}

/** 收集 vendor 树统计（写进 lock，也是等价性验证的客观口径）。 */
export function vendorStats(profileDir) {
  return { totalBytes: dirSize(profileDir), totalFiles: countFiles(profileDir) }
}

/** 启动门禁默认超时。留足冷启动余量（首启要建 profile、扫插件）。 */
export const BOOT_GATE_TIMEOUT_MS = 90000

/** 门禁失败时回带多少行宿主输出（内存环形缓冲尾部）。 */
export const BOOT_GATE_RING_LINES = 6

/** 启动门禁：拿**暂存树真起一次宿主**并探到就绪，才允许后续发 marker（logTail 为空表示三处证据都没输出）。 */
export async function runBootGate({ profileDir, runtime, patchFile, ws, timeoutMs = BOOT_GATE_TIMEOUT_MS, log = () => {} }) {
  const bin = path.join(profileDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!fs.existsSync(bin)) return { ok: false, error: `暂存树缺 bin.js：${bin}` }
  if (patchFile !== undefined && !fs.existsSync(patchFile)) return { ok: false, error: `启动门禁缺 patch 文件：${patchFile}` }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bootgate-'))
  const logFile = path.join(home, 'host.log')
  // 宿主 stderr **必须**落盘：启动期崩溃（未捕获异常）只走 stderr，不落盘就只剩一句没信息量的 code=1
  const stderrFile = path.join(home, 'host.stderr.log')
  const linesOf = (file) => {
    try {
      return fs.readFileSync(file, 'utf8').split('\n')
        .map((l) => l.trim())
        // 丢掉 startHost 自己写的 `--- run … ---` 分隔行：它是"日志非空"的假证据
        .filter((l) => l !== '' && !/^--- run .* ---$/.test(l))
    } catch { return [] }
  }
  /** 取日志文件尾部（最后发生了什么）。 */
  const readTail = (file = logFile, n = 12) => linesOf(file).slice(-n).join(' | ')
  /** 取日志文件首部（未捕获异常的那句 `Error: …` 在最前面，尾部只会剩栈帧）。 */
  const readHead = (file = stderrFile, n = 6) => linesOf(file).slice(0, n).join(' | ')
  /** 失败时的诊据：内存环形缓冲 + stderr 首部 + stdout 尾部，谁有真因谁出现。 */
  const diagnose = () => {
    const parts = []
    const ring = typeof child?.dshRingLines === 'function' ? child.dshRingLines() : []
    const ringTail = ring.map((l) => String(l).trim()).filter(Boolean).slice(-BOOT_GATE_RING_LINES).join(' | ')
    if (ringTail !== '') parts.push(`宿主输出尾部：${ringTail}`)
    const errHead = readHead()
    if (errHead !== '') parts.push(`宿主 stderr 首部：${errHead}`)
    const outTail = readTail()
    if (outTail !== '') parts.push(`宿主 stdout 尾部：${outTail}`)
    return parts.join('；')
  }
  let child = null
  try {
    // 复刻壳启动时的 ensureProfilePlugins()：插件包必须放进隔离 profile，否则 ESM 解析会假失败
    const profileWeb = path.join(home, 'profiles', 'web')
    const nmDir = path.join(profileWeb, 'node_modules')
    for (const name of DEFAULT_PLUGIN_NAMES) {
      const src = path.join(profileDir, 'node_modules', name)
      if (!fs.existsSync(path.join(src, 'package.json'))) continue
      fs.mkdirSync(nmDir, { recursive: true })
      fs.cpSync(src, path.join(nmDir, name), { recursive: true })
    }
    fs.mkdirSync(profileWeb, { recursive: true })
    fs.writeFileSync(path.join(profileWeb, 'cordis.patch.yml'),
      '# 启动门禁用的隔离 profile 补丁层\n- insert:\n    - id: dsh-auto-approval\n      name: dsh-auto-approval\n')

    const port = await freePort()
    child = startHost({ runtime, bin, home, ws: ws ?? os.tmpdir(), port, patchFile, logFile, stderrLogFile: stderrFile })

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        return { ok: false, error: `宿主提前退出（code=${child.exitCode}）`, logTail: diagnose() }
      }
      const declared = extractHostUrl(logFile)
      const fallback = `http://127.0.0.1:${port}/`
      // 判据必须是"真能服务"而非 res.ok：0.1.5 的根 URL 是 303 换 cookie，只认 res.ok 会永远假阴性
      if (declared !== null && declared.includes(`:${port}`)) {
        if (await probeHostReady(declared, fallback)) return { ok: true, url: declared }
      } else if (await probeHostReady(fallback, fallback)) {
        return { ok: true, url: fallback }
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    return { ok: false, error: `宿主未在 ${timeoutMs}ms 内就绪`, logTail: diagnose() }
  } catch (e) {
    return { ok: false, error: `启动门禁异常：${e.message}`, logTail: diagnose() }
  } finally {
    if (child !== null && child.pid !== undefined && child.exitCode === null) {
      try { killTree(child.pid) } catch { /* 已退出 */ }
    }
    // 必须走 junction 安全删除：隔离 HOME 里是指向被测树的 junction 场
    const swept = safeRemoveTree(home, { log })
    if (swept.unlinked > 0) log(`[vendor-build] 门禁收尾：解开 ${swept.unlinked} 个 junction（未进入其目标）`)
  }
}

/** 构建一棵 vendor 树到 targetDir（**绝不是现网 vendor/profile**）；install=false 即 --prune-only 形态。 */
export async function buildVendorTree({
  profileDir, versions, packagesDir, runtime = process.execPath, cacheDir, registry = DEFAULT_REGISTRY,
  npmCli, install = true, pluginsRequired = true, logFile, pluginNames = DEFAULT_PLUGIN_NAMES, log = () => {},
  abiGate = runAbiGate, installFn = installDependencies,
  bootGate = runBootGate, bootGateTimeoutMs = BOOT_GATE_TIMEOUT_MS, patchFile, ws,
  onProgress = () => {}, expectedPackages = DEFAULT_EXPECTED_PACKAGES, installPollMs = 1000,
  target = currentTarget(), ignoreScripts = true, verifyPackages = verifyTargetPackages,
  // 交叉构建时两道门禁都必须延后到目标平台（这里只有宿主运行时）；延后是**降级**，结果记在 gatesDeferred
  skipAbiGate = false,
  // keepPlatforms：这棵树里**还要保住**的其它平台/架构（macOS 双架构）；必须构建期就传进来
  keepPlatforms = [],
  // lockDir：版本锁所在目录（仓库里是 `vendor/`）；真实构建走暂存布局，从 profileDir 推不出 `<out>`
  lockDir = null,
}) {
  const emit = (step, percent, label, detail = '') => {
    try { onProgress({ step, percent: Math.max(0, Math.min(100, Math.round(percent))), label, detail }) } catch { /* 进度回调不该影响构建 */ }
  }
  log(`[vendor-build] 目标: ${profileDir}`)
  log(`[vendor-build] 目标平台: ${platformTag(target)}${target.libc ? `（libc=${target.libc}）` : ''}`)
  let manifest = null
  if (install) {
    const npm = npmCli ?? findNpm()
    if (npm === null || !fs.existsSync(npm)) {
      const detail = npm === null ? '' : `（探测到的路径不存在：${npm}）`
      return { ok: false, error: `未找到可用的系统 npm${detail}：本应用不内置 npm，请先安装 Node.js，或设置 DSH_NODE_DIR 指向 Node 安装目录` }
    }
    log(`[vendor-build] npm: ${npm}`)
    resetDir(profileDir)
    manifest = writeManifest(profileDir, versions)
    emit('install', 2, '正在安装依赖', '准备中')
    const lockfile = findVendorLockfile(profileDir, lockDir)
    if (lockfile !== null) log(`[vendor-build] 使用版本锁：${path.relative(path.dirname(profileDir), lockfile)}（钉死传递依赖版本）`)
    else log('[vendor-build] 提示：未找到 vendor/package-lock.json —— 各平台会各自解析传递依赖版本，可能造成平台间内容差异')
    log(`[vendor-build] npm install --omit=dev${ignoreScripts ? ' --ignore-scripts' : ''}（首次约 255MB，耐心等待）...`)
    const nmDir = path.join(profileDir, 'node_modules')
    const timer = setInterval(() => {
      const got = countPackages(nmDir)
      const frac = expectedPackages > 0 ? Math.min(1, got / expectedPackages) : 0
      emit('install', 2 + 66 * frac, `正在安装依赖（${got}/${expectedPackages} 个包）`, `${got} 个包已就位`)
    }, installPollMs)
    if (typeof timer.unref === 'function') timer.unref()
    let installed
    try {
      installed = await installFn({
        profileDir, npmCli: npm, runtime, env: buildInstallEnv({ cacheDir, registry }), logFile,
        target: platformTag(target) === platformTag(currentTarget()) ? null : target,
        ignoreScripts,
        lockfile,
      })
    } finally {
      clearInterval(timer)
    }
    if (!installed.ok) return { ok: false, error: installed.error }
    emit('install', 68, '依赖安装完成', `${countPackages(nmDir)} 个包`)
  } else {
    // --prune-only 形态：在既有树上只做剪枝/插件/门禁/lock，不重装
    if (!fs.existsSync(path.join(profileDir, 'node_modules'))) {
      return { ok: false, error: `install=false 需要已有 node_modules：${profileDir}` }
    }
    log('[vendor-build] 跳过安装（复用现有树）')
  }

  emit('prune', 72, '正在剪枝', '剔除运行时永不加载的文件')
  const pruned = pruneVendorTree(profileDir, target, { keepPlatforms })
  log(`[vendor-build] 剪枝: ${formatMb(pruned.prunedBytes)} / ${pruned.prunedFiles} 个文件`)
  if ((pruned.droppedPtyPrebuilds ?? []).length > 0) log(`[vendor-build] 剪掉非目标平台的 node-pty 预编译: ${pruned.droppedPtyPrebuilds.join(' / ')}`)
  if ((pruned.droppedPlatformDirs ?? []).length > 0) log(`[vendor-build] 剪掉非目标平台的专属目录: ${pruned.droppedPlatformDirs.join(' / ')}`)
  emit('prune', 78, '剪枝完成', `剔除 ${pruned.prunedFiles} 个文件`)

  // POSIX 上补 spawn-helper 的可执行位（--ignore-scripts 吃掉了 node-pty 的 postinstall）
  const helpers = ensureSpawnHelpers(profileDir, target)
  if (helpers.changed > 0) log(`[vendor-build] 已给 ${helpers.changed} 个 spawn-helper 补 0755`)

  // 平台包缺件门禁：可注入/可跳过（离线自检用手搓的假树），真实构建路径**永不**跳过
  const pkgs = verifyPackages === null ? { ok: true, present: [], missing: [], skipped: true } : verifyPackages(profileDir, target)
  if (!pkgs.ok) {
    return {
      ok: false,
      error: `目标平台（${platformTag(target)}）必需的原生包缺失：${pkgs.missing.join(' / ')}。`
        + '这会让宿主在 import 期就起不来（koffi/node-pty）或让会话写不进去（node-addon-system 的 POSIX flock）；'
        + `请在目标平台原生安装，或用 build-host.mjs --os ${target.os} --cpu ${target.arch} 交叉安装。`,
      pruned, packages: pkgs,
    }
  }
  log(`[vendor-build] 目标平台必需包齐备: ${pkgs.present.join(' / ')}`)

  emit('plugins', 80, '正在同步自带插件', '')
  const plugins = syncVendorPlugins(profileDir, { packagesDir, pluginNames })
  if (plugins.missing.length > 0 && pluginsRequired) {
    return { ok: false, error: `插件包缺失，拒绝产出缺插件的树：${plugins.missing.join(' / ')}（源目录 ${packagesDir}）` }
  }
  log(`[vendor-build] 插件已就位: ${plugins.copied.join(' / ') || '（无）'}`)

  // ── 双门禁：ABI（二进制能否加载）+ 启动（宿主能否对外服务）──
  emit('abi', 84, 'ABI 门禁', '逐个 dlopen 原生模块')
  let abi = null
  if (skipAbiGate) {
    log('[vendor-build] ⚠ ABI 门禁已延后（交叉构建：宿主运行时 ≠ 目标平台运行时）——必须在目标平台/CI 上补跑')
    emit('abi', 88, 'ABI 门禁延后', '交叉构建：目标平台原生门禁待补')
  } else {
    abi = abiGate({ nodeModulesDir: path.join(profileDir, 'node_modules'), runtime, target })
    log(`[vendor-build] ABI 门禁: OK=${abi.okCount} SKIP=${abi.skipCount} FAIL=${abi.failCount}（共 ${abi.total}）`)
    if (!abi.ok) {
      const detail = abi.error ?? abi.failures.slice(0, 10).join('; ')
      return { ok: false, error: `ABI 门禁未通过：${detail}`, abi }
    }
    emit('abi', 88, 'ABI 门禁通过', `OK=${abi.okCount} FAIL=0`)
  }
  const gatesDeferred = { abi: skipAbiGate === true, boot: bootGate === null }

  if (bootGate !== null) {
    emit('boot', 90, '启动门禁：真起一次宿主', `最长等 ${Math.round(bootGateTimeoutMs / 1000)} 秒`)
    log('[vendor-build] 启动门禁：拿暂存树真起一次宿主（最长 ' + String(bootGateTimeoutMs / 1000) + 's）...')
    const boot = await bootGate({ profileDir, runtime, patchFile, ws, timeoutMs: bootGateTimeoutMs, log })
    if (!boot.ok) {
      return { ok: false, error: `启动门禁未通过：${boot.error}${boot.logTail ? `（宿主日志：${boot.logTail}）` : ''}`, abi, boot }
    }
    log(`[vendor-build] 启动门禁通过：${boot.url}`)
    emit('done', 100, '暂存树就绪', '等待重启应用生效')
    return { ok: true, manifest, stats: vendorStats(profileDir), runtime: readRuntimeVersions({ runtime }), pruned, plugins, abi, boot, packages: pkgs, target, gatesDeferred }
  }

  emit('done', 100, '暂存树就绪', '')
  return { ok: true, manifest, stats: vendorStats(profileDir), runtime: readRuntimeVersions({ runtime }), pruned, plugins, abi, packages: pkgs, target, gatesDeferred }
}

/** 构建暂存树：`<stagingRoot>/profile` + `<stagingRoot>/vendor.lock.json`，布局与现网 `vendor/` 一致。 */
export async function buildStaging(o) {
  const { stagingRoot, versions, log = () => {}, target = currentTarget() } = o
  const profileDir = path.join(stagingRoot, 'profile')
  // install=false 在暂存层必然是错的（暂存区是空的，没有树可剪）；--prune-only 走现网树
  if (o.install === false) {
    return { ok: false, error: `buildStaging 只做"从零建树"（install=true）：install=false 请在现网树上用 buildVendorTree + buildVendorLock（stagingRoot=${stagingRoot}）` }
  }
  const built = await buildVendorTree({ ...o, profileDir, log, target })
  if (!built.ok) return { ok: false, error: built.error }

  const lock = buildVendorLock({ versions, target, built, profileDir })
  const lockPath = path.join(stagingRoot, 'vendor.lock.json')
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n')
  log(`[vendor-build] 暂存树就绪: ${formatMb(lock.totalBytes)} / ${lock.totalFiles} 个文件`)
  // `built` 也一并返回：合并平台专属包之后调用方要**重写 lock**，buildVendorLock 需要这份构建结果
  return { ok: true, profileDir, lockPath, lock, built }
}

/** 组装 `vendor.lock.json` 的内容（lock 是事后诊断的唯一依据，字段集只在这里定义一次）。 */
export function buildVendorLock({ versions, target, built, profileDir, mergedPlatforms = [] }) {
  return {
    generatedAt: new Date().toISOString(),
    dshVersions: versions,
    // 平台三元组：这棵树**只能**在这个平台上用（koffi/node-pty 等是预编译二进制）
    platform: { os: target.os, arch: target.arch, ...(target.libc ? { libc: target.libc } : {}), tag: platformTag(target) },
    mergedPlatforms: mergedPlatforms.map((t) => ({ os: t.os, arch: t.arch, tag: platformTag(t) })),
    runtime: built.runtime,
    // 门禁结论要如实写：交叉构建时 ABI 门禁**没跑**，写 PASS 就是"假绿"
    abiScan: built.gatesDeferred?.abi === true ? 'DEFERRED（交叉构建，需在目标平台补跑）' : 'PASS',
    gatesDeferred: built.gatesDeferred ?? { abi: false, boot: false },
    platformPackages: built.packages?.present ?? [],
    prunedBytes: built.pruned.prunedBytes,
    prunedFiles: built.pruned.prunedFiles,
    // 运行期"依赖完整性"基线的口径：壳启动时数 node_modules 文件数与它比对（基线按平台不同）
    nodeModulesFiles: countFiles(path.join(profileDir, 'node_modules')),
    ...built.stats,
  }
}
