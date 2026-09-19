// vendor-build.mjs — vendor 树构建原语（纯 Node；只有跑 ABI 门禁/读版本时才 spawn 运行时）
//
// 为什么放在 src/ 而不是 scripts/：electron-builder.yml 的 files 只含 `src/**`、`VERSION`、
// `package.json` —— **scripts/ 不进包**。而装好的应用必须能在本地重建 vendor 暂存树，所以这些
// 原语得随包分发；ABI 门禁尤其如此：不做回滚备份后，门禁是唯一防线，它不能在打包后消失。
//
// 与 scripts/build-host.mjs 的关系：build-host 退化为 CLI 薄封装，两边共用本模块**一份**实现。
// 这条教训（改名后漏改调用点直接让壳起不来）要求"安装/剪枝/插件同步"只能有一处代码。
//
// 本模块**绝不写现网 vendor/profile**：所有写入都发生在调用方给定的 targetDir 内（宿主
// 映射着 vendor 里的 *.node，运行中替换会失败/损坏）。
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_REGISTRY } from './dsh-update.mjs'
// 启动门禁复用壳自己的宿主启动与 URL 解析：门禁测的必须与壳跑的是**同一套**逻辑，
// 否则门禁会放行一个"门禁里能起、壳里起不来"的树（0.4.6 事故正是这个形状）。
import { extractHostUrl, freePort, killTree, probeHostReady, startHost } from './host.mjs'
import { safeRemoveTree } from './junction-safe.mjs'

/**
 * 随包分发的自研插件。它们**不在 npm 依赖里**，只经 vendor 树分发（extraResources 的
 * vendor → resources/vendor），electron-builder 的 files 也覆盖不到它们——所以换树时必须手工
 * 拷进新树，漏掉的后果是"换树成功之后"设置面板的"桌面"section、/approval 命令与侧栏的
 * 市场入口一起消失。
 *
 * ⚠️ 这个表与 `main.mjs` 的 `PROFILE_PLUGIN_NAMES` 是**同一份名单的两个落点**（一个管构建期拷进
 * vendor、一个管启动期同步到 profile 插件位），加插件必须**两处同改**，否则表现为"构建通过、
 * 装上也起不来该插件"。两边都有断言守着（`vendor-build-self-test` 与 `ci-self-test`）。
 */
export const DEFAULT_PLUGIN_NAMES = ['dsh-desktop-ui', 'dsh-auto-approval', 'dsh-market']

/** 运行时永不加载、且直接决定安装耗时的内容（Defender 逐文件扫描是安装慢的主因）。 */
const PRUNE_DIRS = new Set(['test', 'tests', '__tests__', 'docs', 'examples', 'benchmark', 'benchmarks'])

/**
 * 目标平台三元组。
 *
 * 为什么必须显式建模：这棵树里 7 个包是**平台专属**的，
 * 而旧实现把"保留 win32-x64、删掉其它"写成了常量——在 Linux/macOS 上构建时它删掉的正是
 * 本平台唯一可用的那份（node-pty 预编译）。同一份定义还要喂给 ABI 门禁，否则两边判据会互相打脸。
 * @typedef {{os:'win32'|'linux'|'darwin', arch:'x64'|'arm64', libc?:'glibc'|'musl'}} TargetPlatform
 */

/** 当前运行进程的平台三元组（Linux 上按 glibc 探测 libc，容器里 musl 会命中 alpine 的包名）。 */
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

/**
 * ConPTY 的目录名：**架构在前、平台在后**（`win10-x64` / `win10-arm64`），与 `platformTag`
 * 的 `win32-x64` 不同形 —— 这个差别让"按平台三元组过滤"的通用规则看不见它（剪枝实测漏过一次）。
 * @param {string} arch 架构
 * @returns {string} ConPTY 目录名
 */
export function conptyDirName(arch) {
  return arch === 'arm64' ? 'win10-arm64' : arch === 'ia32' ? 'win10-ia32' : 'win10-x64'
}

/**
 * 一个包/路径名里是否带**目标平台的三元组标记**。
 *
 * 用途（只此一处）：`mergePlatformPackages` 要往树里补另一个架构的**平台专属包**。
 * 判据用目录名里的 `<os>-<arch>` 标记，与 npm 给这些 optionalDependencies 起的名字同形
 * （`@koromix/koffi-<os>-<arch>`、`@img/sharp-<os>-<arch>`、`@vscode/ripgrep-<os>-<arch>`、
 * `@deepseek-ai/node-addon-system-<os>-<arch>`、`node-addon-require-builtin-<os>-<arch>-<abi>`），
 * 再加上两个不同形的特例：`sharp-libvips-<os>-<arch>` 与 `node-pty/prebuilds/<os>-<arch>`。
 *
 * **为什么不按"包名白名单"写**：白名单会随依赖升级静默失效——新增一个平台包时它不会报错，
 * 只会让另一个架构的包悄悄漏掉（而漏掉的表现是"那个架构的 .app 起不来"，离原因非常远）。
 * 标记判据是"名字里必须出现 `<os>-<arch>`"，新包只要还按 Node 生态的惯例命名就自动被覆盖。
 * @param {string} rel 相对 node_modules 的路径
 * @param {TargetPlatform} target 目标平台
 * @returns {boolean} 是否属于该平台专属
 */
export function isPlatformTaggedPath(rel, target) {
  return rel.toLowerCase().includes(platformTag(target).toLowerCase())
}

/**
 * 把 donor 树里**目标平台专属**的包并进 target 树 —— 用于 macOS 的"双架构一棵树"。
 *
 * 为什么需要（2026-09-14 实测发现的真缺口）：`electron-builder --mac dmg zip --arm64 --x64`
 * 会把**同一棵 vendor 树**打进两个架构的 .app，而 npm install 一次只能按一个 `--cpu` 解析可选依赖
 * ⇒ arm64 的产物里只有 arm64 的预编译，x64 的产物**装上也起不来**（koffi/node-pty 在 import 期崩）。
 * 而 CLI 传了 `--arm64 --x64` 时 electron-builder 不让 target 指定 arch 把两个架构分开。
 * 解法：一棵树同时装两套平台专属二进制。npm 的 `prebuilds/<os>-<arch>` 与
 * `@img/sharp-<os>-<arch>` 这类布局**本来就是为多平台共存的**，运行时按 `process.arch` 自己挑。
 *
 * 门禁：**只补目标平台的条目**，不整树拷贝——脚本、JS 代码在 donor 里与 target 是同一份
 * （同一份 `dshVersions` 装出来的），搬过来只会带来"两份可能漂移的代码"这个新问题。
 * @param {{donorProfileDir:string, profileDir:string, target:TargetPlatform, donorRoot?:string,
 *   log?:(m:string)=>void}} o donorRoot 默认取 `donorProfileDir` 的父目录（staging 布局就是
 *   `<root>/profile` + `<root>/vendor.lock.json`；传错这一层会让平台核对静默失效）
 * @returns {{copied:string[], missing:string[]}} copied=补进来的相对路径；missing=donor 里没有的
 */
export function mergePlatformPackages({ donorProfileDir, profileDir, target, donorRoot, log = () => {} }) {
  const donorNm = path.join(donorProfileDir, 'node_modules')
  const nmDir = path.join(profileDir, 'node_modules')
  const copied = []
  const missing = []
  if (!fs.existsSync(donorNm)) return { copied, missing: [`donor 树没有 node_modules：${donorNm}`] }

  // donor 树必须真的是那个平台的（否则会把同一个平台的包再拷一遍，白忙且看不出问题）。
  // lock 在 donor 的**暂存根**里（`<root>/vendor.lock.json`），不在 profile 里——
  // 拼错这一层会让这道核对永远读不到文件、于是静默失效（第一版就是这么写的）。
  const donorLock = path.join(donorRoot ?? path.join(donorProfileDir, '..'), 'vendor.lock.json')
  if (fs.existsSync(donorLock)) {
    try {
      const dtag = JSON.parse(fs.readFileSync(donorLock, 'utf8')).platform?.tag
      if (dtag !== undefined && dtag !== platformTag(target)) {
        return { copied, missing: [`donor 树的平台是 ${dtag}，与目标 ${platformTag(target)} 不符`] }
      }
    } catch { /* lock 读不出就不作为否决理由（存在性判据已经足够说明这是棵树） */ }
  }

  /**
   * 收集"路径里带目标平台标记"的**最外层**条目。
   *
   * 写成显式的三层，而不是"见目录就递归"：这些平台包的布局只有三种已知形状，
   * 递归写法会在 `@scope/pkg/sub/...` 里把同一个包切成碎片搬过去，也会越界爬到无关目录。
   *   ① `node_modules/<tag 标记的包>` —— koffi / sharp / ripgrep / node-addon-system / node-addon-require-builtin
   *   ② `node_modules/@scope/<tag 标记的包>` —— 上面那些其实都在 @scope 下
   *   ③ `node_modules/node-pty/prebuilds/<os>-<arch>`（ConPTY 的运行时在 `<prebuilds>/<tag>/conpty/`）
   * 标记判据见 `isPlatformTaggedPath`，所以新增一个"按惯例命名"的平台包会自动被覆盖。
   */
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
      // node-pty 是唯一"平台件藏在普通包里面"的：prebuilds/<os>-<arch>
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
    // 覆盖式替换：目标树里可能已经有同名目录（但内容不全，例如只装了本架构的 prebuilds 子目录）
    if (fs.existsSync(to)) safeRemoveTree(to)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.cpSync(from, to, { recursive: true, dereference: false, verbatimSymlinks: true })
    copied.push(rel)
  }
  log(`[vendor-build] 平台专属包合并（${platformTag(target)} ← donor）：${copied.length} 项${missing.length > 0 ? `，缺 ${missing.length} 项` : ''}`)
  for (const c of copied) log(`[vendor-build]   + ${c}`)
  return { copied, missing }
}

/**
 * 路径是否属于**另一种 C 库**（glibc ↔ musl）的制品。
 *
 * 为什么必须单独判（2026-09-14 在 Debian 上实测踩到）：Linux 平台包会**同时**带两套 C 库的二进制，
 * 而且是同名包里的子目录，平台三元组标记完全看不见它们：
 *   · `@koromix/koffi-linux-x64/musl_x64/koffi.node`（同包内还有 `linux_x64/koffi.node`）
 *   · `@deepseek-ai/node-addon-system-linux-x64/bin/{glibc,musl}/system.node`
 * 在 glibc 系统上 dlopen musl 那份**必然失败**（`libc.musl-x86_64.so.1: cannot open shared object`），
 * 而 `isEssentialNativePath` 会因为路径里有 `linux-x64` 判它是"本平台必需" ⇒ **ABI 门禁误判 FAIL**，
 * 一棵完全健康的树被说成坏的（本机 Debian 上真实发生：koffi 与 flock 各报一条）。
 * 判据按目录名取值：`musl`/`musl_x64`/`musl-arm64`… 与 `glibc`/`glibc_x64`/`gnu`/`gnueabihf`。
 * @param {string} rel 相对 node_modules 的路径
 * @param {TargetPlatform} target 目标平台
 * @returns {boolean} 是否与目标的 libc 不符
 */
/**
 * C 库变体目录名的识别模式（预编译成常量，不写成内联正则）。
 *
 * 为什么不内联：`ci-self-test` 有一道**低误报的"被调用但从未声明"体检**，它只看「标识符紧跟左括号」
 * 这一种形态，于是内联正则里的 musl / glibc / linux_ 这些**模式片段**会被当成函数调用，
 * 门禁就报"未声明的标识符"（实测踩到）。预编译既避开这个假阳性，也让这张表更易读。
 * （注：本段刻意不写出"标识符加左括号"的原文，以免又触发同一道体检。）
 */
const LIBC_MUSL_RE = /^musl(_|-|$)/
const LIBC_MUSL_EXACT = /^musl$/
const LIBC_GLIBC_RE = /^glibc(_|-|$)/
const LIBC_GNU_EXACT = /^gnu$/
const LIBC_GNU_EABIHF = /^gnueabihf$/
// koffi 用 `linux_x64` 表示 glibc 版（同包的 musl 版叫 `musl_x64`）——最不直观的一种写法，显式认下来。
const LIBC_KOFFI_GLIBC = /^linux_(x64|arm64|ia32|arm)$/

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

/**
 * 判定某个 .node 是否属于"本平台必需的原生包"（决定 ABI 失败是 FAIL 还是 SKIP）。
 *
 * 注意：**另一种 C 库的制品不算"必需"**（见 `isForeignLibcPath`）——它在本平台上注定加载不了，
 * 判 FAIL 会把健康的树说成坏的。
 * @param {string} rel 相对 node_modules 的路径
 * @param {TargetPlatform} target 目标平台
 */
export function isEssentialNativePath(rel, target) {
  if (isForeignLibcPath(rel, target)) return false
  if (/[\\/]node_modules[\\/](koffi|node-pty|sharp)[\\/]/.test(rel)) return true
  return rel.includes(platformTag(target))
}

/**
 * 路径里是否**只**出现其它平台的标记（这类 .node 在本平台加载失败属预期，记 SKIP）。
 *
 * 判据用"平台三元组标记"（`linux-x64`、`darwin-arm64`、`win32-x64`…）而不是宽泛的
 * `arm64|linux|darwin` 子串——旧写法会把 `@deepseek-ai/node-addon-system-darwin-arm64` 这类
 * **其它平台的包**误判成本平台，也会把路径里偶然出现的 `arm64` 当成平台证据。
 * @param {string} rel 相对 node_modules 的路径
 * @param {TargetPlatform} target 目标平台
 */
export function isForeignPlatformPath(rel, target) {
  const TAGS = ['win32-x64', 'win32-arm64', 'win32-ia32', 'linux-x64', 'linux-arm64', 'linux-arm',
    'linux-ia32', 'linux-ppc64', 'linux-riscv64', 'linux-s390x', 'linuxmusl-x64', 'linuxmusl-arm64',
    'linuxmusl-arm', 'darwin-x64', 'darwin-arm64', 'freebsd-x64', 'freebsd-wasm32',
    'webcontainers-wasm32', 'android-arm64', 'android-x64', 'openbsd-x64', 'sunos-x64',
    // ConPTY 的目录名自成一格：`win10-arm64` / `win10-x64`。
    // 缺了它，`.node`/`.dll` 的 ABI 门禁会把 `win10-arm64/conpty.dll` 当成"与本平台无关的文件"
    // 而放行（平台标记表必须与树上真实出现的目录名对齐）。
    'win10-x64', 'win10-arm64', 'win10-ia32']
  const lower = rel.toLowerCase()
  const tags = TAGS.filter((t) => lower.includes(t))
  if (tags.length === 0) return false
  const mine = platformTag(target)
  const own = target.os === 'linux' && target.libc === 'musl' ? `linuxmusl-${target.arch}` : mine
  // 大小写归一：node-pty 的目录名是 win32-x64/linux-x64/darwin-arm64，与标签同形
  return !tags.some((t) => t === mine || t === own)
}

/**
 * 目标平台上**必需**的原生包（缺失即"装上也起不来"）。三条启动级阻断：
 * koffi 与 node-pty 被静态导入、`node-addon-system-<plat>` 承载 POSIX 会话写锁（flock）。
 * sharp 与 ripgrep 缺失属功能退化（wasm32 兜底 / 懒加载），因此它们在表里但失败信息会分开说明。
 * 注意 `node-addon-system` 的 flock 只支持 POSIX（`lib/flock.js:10-11` 在 win32 上直接抛），
 * 所以 Windows 不进这张表——它的 `node-addon-require-builtin-win32-x64-msvc` 是另一码事。
 *
 * **Windows 行的 `node-pty` 项曾经写成 `prebuilds/win32-x64/pty.node`，那是错的**，而且错了没人发现：
 * `pty.node` 是 **Unix** 的实现，Windows 的 node-pty 加载的是另外两个模块——
 *   · `conpty.node` —— `lib/windowsPtyAgent.js:42` `loadNativeModule('conpty')`
 *   · `conpty_console_list.node` —— `lib/conpty_console_list_agent.js:11` `loadNativeModule('conpty_console_list')`
 *   · 再加 `conpty/conpty.dll` + `conpty/OpenConsole.exe`（ConPTY 运行时，缺了 pty 建不起来）
 * 后果不是"少查一项"：Windows 树上**永远没有** `pty.node`，于是这道门禁在 Windows 上必然判"缺件"，
 * 把一棵完好的树说成坏的（`--prune-only` 因此在 Windows 上 100% 失败，实测于 2026-09-14）。
 * 门禁喊狼来了，真缺件那次就没人信了——这比不设门禁更坏。
 */
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

/**
 * 校验目标平台必需的平台包是否真的落进了树里。
 *
 * 为什么单列这一步（而不是只靠 ABI 门禁）：ABI 门禁只能验证"**在树里**的 .node 能否加载"，
 * 对"这个包**根本没装进来**"完全无感——而 koffi 缺件时宿主是在 import 期抛错，
 * 门禁会因为"一个 .node 都没扫到"或"扫到的全是无关模块"而给出一片绿。
 *
 * 两个判据按目标物类型分开（别用 require.resolve 一把梭）：
 *   · **包**：解析它的 `package.json`——这个子路径由 Node 保证可解析（exports/main 都不参与），
 *     正是"包在不在树里"的语义（运行时加载失败的一种成因就是包压根没装）。
 *   · **文件**：直接查存在性（例如 node-pty 的 `prebuilds/<tag>/pty.node`）。
 * 相对 spec 按 profileDir/node_modules 解析，模块名走 Node 自己的解析算法。
 * @param {string} profileDir profile 目录
 * @param {TargetPlatform} target 目标平台
 * @returns {{ok:boolean, present:string[], missing:string[]}}
 */
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
      // 文件判据：查**这棵树内**的存在性（node-pty 的预编译就是按目录被加载的）
      found = fs.existsSync(abs)
    } else {
      // 包判据：直接查这棵树内的 package.json。
      //
      // 为什么不用 require.resolve：**它会把已解析的路径缓存起来**——实测同一进程内先解析、
      // 再删掉目录，第二次仍返回那条已不存在的路径（本自检的负向断言正是这么被它骗过的）。
      // 门禁的负向断言（"缺件要报错"）是唯一防线，判据必须每次真读盘。
      const pj = path.join(abs, 'package.json')
      if (fs.existsSync(pj)) {
        found = true
        // 顺带核一下包名：路径对、包名不对的树（错版/错平台包被塞进来）同样是装的坏的
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
    // kind 由**路径本身**判：带扩展名的视为文件，否则视为包目录。旧写法靠 `label === 'node-pty'`
    // 认这一项，一旦标签改成 `node-pty(conpty)` 就会退化成"当包查"，而包目录名是 `node-pty`，
    // 于是它去查 `<树>/node_modules/node-pty/prebuilds/win32-x64/conpty.node` 这个包——必然报不存在。
    const kind = /\.(node|exe|dll|so|dylib)$/.test(spec) ? 'file' : 'package'
    const name = label === 'flock' ? 'node-addon-system(flock)' : `${label}:${platformTag(target)}`
    check(name, spec, kind)
  }
  return { ok: missing.length === 0, present, missing }
}

/**
 * 让 POSIX 上需要可执行位的辅助程序真的可执行。
 *
 * 为什么需要：安装用了 `--ignore-scripts`（Windows 上省事且安全），
 * 而 `node-pty` 的 `prebuilds/<plat>-<arch>/spawn-helper` 靠 postinstall 才 `chmod 0755`——
 * 在目标平台上少了这一步，pty 起不来，症状是"终端/持久 shell 静默不可用"。
 * 交叉构建时显式 chmod 是唯一可行解；原生安装时它与 postinstall 重复也无害。
 *
 * **只有 macOS 有 spawn-helper**（2026-09-14 交叉构建实测，别再按"POSIX 都有"想当然）：
 * `node-pty@1.2.0-beta.15` 的 `prebuilds/linux-x64` 只有 `pty.node`，`prebuilds/darwin-arm64`
 * 才有 `pty.node` + `spawn-helper`。源码里 `src/unix/pty.cc` 的 helper 分支被 `#if defined(__APPLE__)`
 * 包着，Linux 走 `forkpty()`（forkpty 自己就把子进程挂成 pty 的控制终端），压根不读 helperPath。
 * 所以 Linux 上"没有 spawn-helper"是**正常**的，不构成缺件；把这句写在这里，是为了让下一个人
 * 不必再翻一遍 pty.cc 才能确认它不是漏装。
 * @param {string} profileDir profile 目录
 * @param {TargetPlatform} target 目标平台
 * @returns {{changed:number, skipped:number}}
 */
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

/** 字节 → MB 文案（日志统一口径）。 */
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

/**
 * npm install 的预期包数（进度分母）。实测 0.1.5-rc.2 的依赖树是 520 个包——
 * 它是**估计值**，只是让进度条有个刻度；数不准也不骗人（label 里写的是真实已就位数）。
 */
export const DEFAULT_EXPECTED_PACKAGES = 520

/**
 * 数 `node_modules` 下已就位的"包"数（`@scope/x` 记 1、跳过 `.bin` 这类点开头目录）。
 *
 * 为什么用它当 npm install 的进度代理：npm 自己的进度输出只对它有意义的，而它是**边解包边建目录**
 * 的——目录数会实时往上走，是最省事又不撒谎的信号。目录正在被写时读取失败一律当 0，不抛。
 * @param {string} nodeModulesDir node_modules 路径
 * @returns {number} 已就位的包数
 */
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

/**
 * 整目录重建：先删后建，避免残留旧文件让"新树"其实是新旧混合。
 *
 * 删除走 `safeRemoveTree`：这里的目标可能是**上一次构建留下的暂存树**（含链接场），
 * 递归删除只在 Node 的当前实现下"恰好"不跟随链接，换工具/换平台就不保证了

 * **删不干净要抛**：残留会让"全新构建"实际是新旧混合，而那种树的症状（ABI 门禁时好时坏）
 * 离原因极远 —— 宁可当场失败。
 */
export function resetDir(dir) {
  const swept = safeRemoveTree(dir)
  if (swept.leftovers > 0) {
    throw new Error(`resetDir 未能清空 ${dir}（残留 ${swept.leftovers} 项，可能有文件被占用）；拒绝在其上构建，避免产出新旧混合的树`)
  }
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 写 profile manifest（bundles 锁 dsh-base + dsh-web-app；dsh 本体提供 bin.js 入口）。
 * @param {string} profileDir 目标 profile 目录
 * @param {Record<string,string>} versions 三个 @deepseek-ai 包的精确版本
 * @returns {object} 写下的 manifest
 */
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

/**
 * 找出版本锁的候选位置。
 *
 * 为什么需要"锁传递依赖"（2026-09-15 实测发现）：三平台各自 `npm install`，而 manifest 里只钉死三个
 * DSH 包的**精确**版本，**传递依赖是范围声明**（`zod: ^4.4.3`、`node-addon-require-builtin: ^0.1.4`、
 * `@types/node` 由 `protobufjs` 的 `>=13.7.0` 拉进来）。于是**同一个 DSH 版本在不同日期装出两棵内容不同的树**：
 * 本机实测 Windows 树（09-12 装）与 Linux 树（09-14 装）有 5 个同名包版本不同
 * （zod 4.6.2 vs 4.6.5、node-addon-require-builtin 0.1.5 vs 0.1.6、@types/node 22 vs 26 …）。
 * 这不是"以后可能有的风险"，而是**已经在产出的两个安装包里存在的内容差异** —— 正是"功能一致"最怕的形态。
 *
 * 用 lock 文件钉死它：把一份锁提交进仓库（`vendor/package-lock.json`），三平台都用它装。
 * **为什么用 `npm install` 而不是 `npm ci` 消费锁**：`npm ci` 会校验 node_modules 与锁完全一致，
 * 而锁是从某一个平台生成的，其 `optionalDependencies` 里带着平台专属包（koffi/sharp 等按 os/cpu 解析），
 * 在另一个平台上必然对不上 —— 那会让 CI 首跑就红。`npm install` 会**尽量遵守锁里已钉死的版本**，
 * 同时按当前平台补上缺失的可选依赖，正是我们要的语义。
 * @param {string} profileDir profile 目录
 * @param {string} [lockDir] 显式指定锁所在目录
 * @returns {string|null} 存在的锁文件路径；没有则 null
 */
export function findVendorLockfile(profileDir, lockDir) {
  const candidates = []
  if (lockDir !== undefined && lockDir !== null) candidates.push(path.join(lockDir, VENDOR_LOCKFILE_NAME))
  candidates.push(
    // 注意**不能只靠 `path.dirname(profileDir)`**：真实构建走暂存布局
    // `<out>/.staging-build/profile`，上一级是 `.staging-build` 而不是 `<out>`，
    // 于是仓库里那份锁永远找不到（2026-09-14 实测踩到，第一次带锁重建就打了这条提示）。
    // 所以候选里显式补上"上两级的父目录"，让两种布局都能命中。
    path.join(path.dirname(profileDir), VENDOR_LOCKFILE_NAME),
    path.join(path.dirname(path.dirname(profileDir)), VENDOR_LOCKFILE_NAME),
    path.join(profileDir, VENDOR_LOCKFILE_NAME),
  )
  for (const p of candidates) if (fs.existsSync(p)) return p
  return null
}

/**
 * 候选 npm-cli.js 路径（三平台）。
 *
 * 为什么是 npm-cli.js 而不是 npm.cmd：实测 Windows 上 spawn('npm') 报 ENOENT（本机 PATH
 * 上甚至只有 npm.ps1），一律用 node 直调 npm-cli.js。
 * 为什么需要多个锚点：打包态 process.execPath 是 "DSH Desktop.exe"，其同级目录**没有 npm**
 * 本应用不内置 npm，必须靠系统 Node 的安装位置兜底。
 * POSIX 的布局与 Windows 不同（`<prefix>/lib/node_modules/npm/bin/npm-cli.js`）：apt 在
 * `/usr/share/nodejs/npm`，nvm 在 `$NVM_DIR/versions/node/<ver>/lib/node_modules`，
 * Homebrew 在 `/opt/homebrew/lib/node_modules`（Apple Silicon 默认前缀）。漏掉这些会让
 * 装好的应用报"未找到系统 npm"，DSH 更新按钮永久不可用。
 * @param {{env?:Record<string,string|undefined>, execPath?:string, extraNodeDirs?:string[], exists?:(p:string)=>boolean}} [opts] 选项
 * @returns {string[]} 候选路径（按优先级）
 */
export function npmCandidates({ env = process.env, execPath = process.execPath, extraNodeDirs = [], exists = fs.existsSync } = {}) {
  const nodeDirs = []
  const add = (d) => { if (typeof d === 'string' && d !== '') nodeDirs.push(d) }
  if (env.DSH_NODE_DIR) add(env.DSH_NODE_DIR)
  if (env.ProgramFiles) add(path.join(env.ProgramFiles, 'nodejs'))
  // extraNodeDirs 由调用方用 `which node` 的推导结果填入（沿用 host.mjs findDshBin 的锚点思路）
  for (const d of extraNodeDirs) add(d)
  add(path.dirname(execPath))

  const out = nodeDirs.map((d) => path.join(d, 'node_modules', 'npm', 'bin', 'npm-cli.js'))

  if (process.platform !== 'win32') {
    // 常见安装前缀（含 Apple Silicon 的 Homebrew 前缀）
    for (const prefix of ['/usr/local', '/usr', '/opt/homebrew', '/opt/local']) {
      out.push(path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    }
    // Debian/Ubuntu 把 npm 放在这个位置（`/usr/lib` 下没有时才有意义）
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
  // 存在性过滤只作用于 POSIX 的**补充**候选：Windows 上 npmCandidates 的既有契约是"返回候选列表、
  // 由 findNpm 用注入的 exists 判定"，注入单测依赖这一点（不能在这里把候选判死）。
  const supplements = out.slice(nodeDirs.length)
  return [...out.slice(0, nodeDirs.length), ...supplements.filter((p) => exists(p))]
}

/**
 * 探测系统 npm（Q2：不内置 npm）。
 * @param {{exists?:(p:string)=>boolean, candidates?:string[]}} [opts] 选项（exists 可注入以便离线单测）
 * @returns {string|null} npm-cli.js 绝对路径；找不到返回 null，调用方据此把按钮置灰
 */
export function findNpm({ exists = fs.existsSync, candidates = npmCandidates() } = {}) {
  for (const p of candidates) if (exists(p)) return p
  return null
}

/**
 * 构造 npm 子进程环境。
 *
 * cacheDir **无条件覆盖** `npm_config_cache`：实测本机 npm 默认 cache 落在
 * `C:\Program Files\nodejs\node_cache`（普通用户不可写 → EPERM），而"环境变量优先"的写法会让
 * 外部已设的坏值顶掉仓库内的可写缓存——所以这里显式压过去，不给它被顶掉的机会。
 * @param {{cacheDir:string, registry?:string, baseEnv?:Record<string,string|undefined>}} o 选项
 * @returns {Record<string,string|undefined>} 子进程环境
 */
export function buildInstallEnv({ cacheDir, registry = DEFAULT_REGISTRY, baseEnv = process.env }) {
  return { ...baseEnv, npm_config_cache: cacheDir, npm_config_registry: registry }
}

/**
 * 跑 npm install（异步 spawn：构建是分钟级操作，同步会冻住 Electron 主进程的窗口与 admin 服务）。
 *
 * stdio 一律走文件描述符重定向：实测沙箱下默认 pipe stdio 会 EPERM。
 * 给了 logFile 就写文件（GUI 应用没有可用的 stdout）；没给则 inherit（CLI 场景看得到进度）。
 * @param {{profileDir:string, npmCli:string, runtime?:string, env:Record<string,string|undefined>,
 *   logFile?:string, target?:TargetPlatform|null, ignoreScripts?:boolean}} o 选项
 *   target 用于向 npm 透传 `--os/--cpu/--libc`（交叉构建）；null 表示按宿主平台安装
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
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
      // 版本锁：把仓库里那份平台中立的 `package-lock.json` 拷进 profile，让 npm **尽量遵守**它钉死的传递依赖版本。
      // 为什么必须这么做见 `findVendorLockfile` 的说明：不锁的话，同一个 DSH 版本在不同日期装出的树内容不同
      // （本机实测 Windows 树与 Linux 树有 5 个同名包版本不同）。
      if (lockfile !== null && lockfile !== undefined && fs.existsSync(lockfile)) {
        try { fs.copyFileSync(lockfile, path.join(profileDir, VENDOR_LOCKFILE_NAME)) } catch { /* 拷不进去就退回无锁安装 */ }
      }
      // 目标平台三元组透传给 npm：`--os/--cpu/--libc` 决定**可选依赖**按哪个平台解析，
      // 这是"交叉产出另一平台 vendor 树"的关键（npm 10 起支持）。为空时不传，行为与旧版一致。
      const platformArgs = []
      if (target !== undefined && target !== null) {
        platformArgs.push('--os', target.os, '--cpu', target.arch)
        if (target.os === 'linux' && target.libc) platformArgs.push('--libc', target.libc)
      }
      const args = [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund', ...platformArgs]
      // --ignore-scripts：Windows 上省事（预编译包直接用），但会吃掉 node-pty 的
      // `ensure-spawn-helper.mjs`（POSIX 上给 spawn-helper 补 0755）。默认保持开启以不改
      // Windows 行为，由安装后的 ensureSpawnHelpers() 显式补位；需要跑 postinstall 时可关掉。
      if (ignoreScripts) args.push('--ignore-scripts')
      child = spawn(runtime, args, {
        cwd: profileDir,
        // ELECTRON_RUN_AS_NODE 让打包态的 electron.exe 当纯 Node 用（宿主子进程同款做法）；
        // 对真 node 是无害的多余变量。作用域仅限本子进程，不会污染壳自身。
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', fd, fd],
        windowsHide: true,
      })
    } catch (e) { done({ ok: false, error: `无法启动 npm：${e.message}` }); return }
    child.on('error', (e) => done({ ok: false, error: `npm 进程错误：${e.message}` }))
    child.on('exit', (code) => done(code === 0 ? { ok: true } : { ok: false, error: `npm install 退出码 ${code}` }))
  })
}

/**
 * 剪枝：删掉运行时永不加载的内容。文件数砍半直接缩短安装时间——Defender 逐文件扫描是主因。
 *
 * 平台相关的有两处（都踩过）：
 *   ① node-pty 的 `prebuilds/<plat>-<arch>`：**保留目标平台、删掉其余**。旧实现写死
 *      "删非 win32-x64"，在 Linux/macOS 上删掉的正是本平台必需的那份。
 *   ② 同一条"只留目标平台"的规则要覆盖另外两处**名字长得不一样**的地方（2026-09-14 实测发现）：
 *      · `node-pty/third_party/conpty/<版本>/win10-{x64,arm64}` —— Windows 上 ARM64 那份躺在
 *        x64 树里白占 ~1.2 MB，而它既不叫 `win32-arm64` 也不叫 `pt​y.node`，先前两条规则都看不见它；
 *      · `@img/sharp-wasm32` —— sharp 的 wasm 兜底，~9 MB。**按需加载**的兜底永远轮不到
 *        （`@img/sharp-<plat>-<arch>` 在，就绝不会去读 wasm 那份），留着只是白占体积。
 *      非 Windows 目标上 `third_party/conpty` 整棵都是 Windows 专用的（ConPTY 是 Windows 的控制台 API）。
 * @param {string} profileDir profile 目录
 * @param {TargetPlatform} [target] 目标平台（默认当前平台）
 * @param {{keepPlatforms?:TargetPlatform[]}} [o] keepPlatforms：**还要保住的其它平台/架构**。
 *   给 macOS 的"双架构一棵树"用（见 `mergePlatformPackages`）：那种树里 darwin-arm64 与 darwin-x64
 *   的预编译都必须在，否则另一个架构的 .app 装上也起不来。默认只留 target 一个。
 * @returns {{prunedBytes:number, prunedFiles:number, droppedPtyPrebuilds:string[], droppedPlatformDirs:string[]}}
 */
export function pruneVendorTree(profileDir, target = currentTarget(), o = {}) {
  const keep = [target, ...(o.keepPlatforms ?? [])]
  const keepTags = new Set(keep.map((t) => platformTag(t)))
  const keepPty = new Set(keep.map((t) => `${t.os}-${t.arch}`))
  let prunedBytes = 0
  let prunedFiles = 0
  const drop = (p) => {
    prunedBytes += dirSize(p)
    prunedFiles += countFiles(p)
    // 安全删除：被剪掉的目录里可能有链接，逐个 unlink 链接本身、绝不递归进目标
    safeRemoveTree(p)
  }
  const droppedPtyPrebuilds = []
  for (const p of foreignPtyPrebuilds(target)) {
    if (keepPty.has(p)) continue
    const d = path.join(profileDir, 'node_modules', 'node-pty', 'prebuilds', p)
    if (fs.existsSync(d)) { drop(d); droppedPtyPrebuilds.push(p) }
  }

  // ── ② 另外两处"平台专属但目录名不同形"的残留 ──
  const droppedPlatformDirs = []
  const dropIfPresent = (p, label) => {
    if (fs.existsSync(p)) { drop(p); droppedPlatformDirs.push(label) }
  }
  const conptyRoot = path.join(profileDir, 'node_modules', 'node-pty', 'third_party', 'conpty')
  if (target.os !== 'win32') {
    // ConPTY 是 Windows 的控制台 API，非 Windows 上这棵树纯属多余
    dropIfPresent(conptyRoot, 'node-pty/third_party/conpty（非 Windows 目标）')
  } else if (fs.existsSync(conptyRoot)) {
    // 只留目标（及 keepPlatforms 里）架构的那几份：win10-x64 / win10-arm64 / win10-ia32
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
  // sharp 的 wasm32 兜底：三个平台都用不到（各自的 @img/sharp-<plat>-<arch> 都在必需包表里）
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
        // `.pdb` 是 Windows 的调试符号（node-pty 的 conpty.node / conpty_console_list.node 各带一个，
        // 合计 10.6 MB —— 比整个包的其他差异都大）。它只在调试崩溃转储时有用，发行包一律不需要。
        // 加它之前，Windows 树比 Linux/macOS 树大 11 MB，差额几乎全在这里（2026-09-14 实测）。
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

/**
 * 把自研插件包拷进 vendor 树的 node_modules。
 *
 * 源目录由调用方给：开发态是仓库 `packages/`；打包态是**当前** vendor 树自己的
 * `node_modules`（壳启动时正是这么把插件同步到 HOME profile 插件位的，见 main.mjs
 * pluginSourceDir）。missing 必须由调用方当硬失败处理——静默跳过会让新树缺插件，而症状
 * （设置面板少一节、/approval 命令消失）离原因很远，且发生在换树"成功"之后。
 * @param {string} profileDir 目标 profile 目录
 * @param {{packagesDir:string, pluginNames?:string[]}} o 选项
 * @returns {{copied:string[], missing:string[]}}
 */
export function syncVendorPlugins(profileDir, { packagesDir, pluginNames = DEFAULT_PLUGIN_NAMES }) {
  const copied = []
  const missing = []
  for (const name of pluginNames) {
    const src = path.join(packagesDir, name)
    if (!fs.existsSync(path.join(src, 'package.json'))) { missing.push(name); continue }
    const dst = path.join(profileDir, 'node_modules', name)
    // 替换插件位：安全删除（目标可能是链接）+ 显式保留链接形态拷贝（cpSync 默认会解引用）。
    // 删不干净就抛：混合副本的后果是"新壳配旧插件"，症状离原因很远（历史上正是这个形态）。
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

/**
 * ABI 门禁：在目标运行时下逐个 dlopen 所有 .node，验证预编译二进制与 Electron 内建 Node 兼容。
 *
 * 为什么失败项才去抓输出：实测沙箱下默认 pipe stdio 会 EPERM。常态用
 * `stdio:'ignore'` 只看退出码（快且沙箱通用），只有失败的那一个才走文件描述符重定向取详细
 * 原因——避免为每个文件开临时文件。
 *
 * 平台语义：
 *   ① 属于**本平台必需**原生包的 .node 加载失败 ⇒ **FAIL**（这是"门禁全绿但一用就崩"的根治点）；
 *   ② 路径里**只**出现其它平台标记的 .node 失败 ⇒ **SKIP**（跨平台包里的非本平台二进制属预期）；
 *   ③ 其余（与平台无关的模块）失败 ⇒ FAIL，并在原因里附一行提示。
 * @param {{nodeModulesDir:string, runtime:string, env?:Record<string,string|undefined>,
 *   target?:TargetPlatform}} o 选项
 * @returns {{ok:boolean, total:number, okCount:number, skipCount:number, failCount:number, failures:string[],
 *   skipped:string[], error?:string}}
 */
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
    // 判 SKIP 的两个理由（**都必须有**，缺一个就会把健康的树报成坏的）：
    //   ① 别平台的制品（`isForeignPlatformPath`）；
    //   ② 别**C 库**的制品（`isForeignLibcPath`）—— glibc 系统上加载 musl 版必然失败，
    //      而它们的路径里带着本平台标记（`koffi-linux-x64/musl_x64/…`），①看不出问题。
    //      2026-09-14 在 Debian 上实测：少了②会让 koffi 与 flock 的 musl 版各报一条 FAIL。
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

/**
 * 读运行时的 Node / Electron 版本（写进 vendor.lock.json 供事后诊断）。
 * @param {{runtime:string, env?:Record<string,string|undefined>}} o 选项
 * @returns {{node:string|null, electron:string|null}}
 */
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

/** 收集 vendor 树统计（写进 lock，也是 S2 等价性验证的客观口径）。 */
export function vendorStats(profileDir) {
  return { totalBytes: dirSize(profileDir), totalFiles: countFiles(profileDir) }
}

/** 启动门禁默认超时。留足冷启动余量（首启要建 profile、扫插件）。 */
export const BOOT_GATE_TIMEOUT_MS = 90000

/** 门禁失败时回带多少行宿主输出（内存环形缓冲尾部）。够看见崩溃那句，又不至于把报错刷成一屏栈。 */
export const BOOT_GATE_RING_LINES = 6

/**
 * 启动门禁：拿**暂存树真起一次宿主**并探到就绪，才允许后续发 marker。
 *
 * 为什么必须有它（0.4.6 事故的根因）：ABI 门禁只验证 `.node` 能否 dlopen，它**完全不关心宿主
 * 能不能对外服务**。0.1.5-rc.2 的 ABI 门禁 5/5 全绿，但它的根 URL 引入了进程级 token，而壳的
 * 就绪探测探的是裸 URL → 永远不就绪 → 用户的应用起不来。设计里原本写的就是"ABI 门禁 +
 * 启动冒烟双绿才发 marker"，实现时漏了后者。
 *
 * 复用 host.mjs 的 startHost/extractHostUrl 而非另写一套：门禁与壳必须用同一套启动参数与
 * 就绪判定，否则门禁会放行"门禁里能起、壳里起不来"的树。
 *
 * 失败时的 `logTail` 是**三处证据合一**（内存环形缓冲 + 宿主 stderr 首部 + stdout 尾部），
 * 不是"host.log 的最后 12 行"：宿主启动期崩溃只会往 stderr 打字，而旧实现不看 stderr，
 * 于是报错长期退化成「code=1（宿主日志：--- run … ---）」——那一行还是 startHost 自己写的分隔行。
 * @param {{profileDir:string, runtime:string, patchFile?:string, ws?:string, timeoutMs?:number, log?:(m:string)=>void}} o 选项
 * @returns {Promise<{ok:boolean, url?:string, error?:string, logTail?:string}>} logTail 为空字符串表示三处都没有输出
 */
export async function runBootGate({ profileDir, runtime, patchFile, ws, timeoutMs = BOOT_GATE_TIMEOUT_MS, log = () => {} }) {
  const bin = path.join(profileDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!fs.existsSync(bin)) return { ok: false, error: `暂存树缺 bin.js：${bin}` }
  if (patchFile !== undefined && !fs.existsSync(patchFile)) return { ok: false, error: `启动门禁缺 patch 文件：${patchFile}` }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bootgate-'))
  const logFile = path.join(home, 'host.log')
  // 宿主 stderr **必须**落盘（0.4.7 事故）。
  // 现象：门禁报「宿主提前退出（code=1）」而宿主日志只有一行 `--- run … ---`——因为 startHost 不传
  // stderrLogFile 时，管道模式下 stderr 只进了内存环形缓冲，磁盘上只有 stdout。而宿主启动期崩溃
  // （未捕获异常 = 栈）**恰恰只走 stderr**：探到的那次真因是
  // `node-addon-require-builtin unsupported…unsupported Electron runtime fingerprint…`，
  // 磁盘上一个字节都没留下，用户只看到一句没有信息量的 code=1。
  const stderrFile = path.join(home, 'host.stderr.log')
  const linesOf = (file) => {
    try {
      return fs.readFileSync(file, 'utf8').split('\n')
        .map((l) => l.trim())
        // 丢掉 startHost 自己写的 `--- run … ---` 分隔行：它对定位毫无用处，却是"日志非空"的假证据
        .filter((l) => l !== '' && !/^--- run .* ---$/.test(l))
    } catch { return [] }
  }
  /** 取某个日志文件的**尾部**（最后发生了什么）。 */
  const readTail = (file = logFile, n = 12) => linesOf(file).slice(-n).join(' | ')
  /** 取某个日志文件的**首部**（未捕获异常的那句 `Error: …` 在最前面，尾部只会剩栈帧）。 */
  const readHead = (file = stderrFile, n = 6) => linesOf(file).slice(0, n).join(' | ')
  /**
   * 门禁失败时的诊据：**三处证据合一**，谁有真因谁出现。
   * 环形缓冲是内存里 stdout+stderr 的合并时间序（管道模式下唯一"一定拿得到遗言"的地方）；
   * 两个日志文件是 fd 直通模式下的落盘副本。旧实现只读 host.log 的尾部，于是
   * "真因在 stderr 首部"这种最常见的崩溃形态被系统性丢掉。
   */
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
    // 复刻壳启动时的 ensureProfilePlugins()：desktop.patch.yml 会 insert `dsh-desktop-ui`，
    // 而 loader 对插件条目做 ESM 解析的基准是 profile 目录本身——不把包放进隔离 profile 就会
    // 得到 ERR_MODULE_NOT_FOUND 的**假失败**（本门禁第一版正是栽在这里，误判好树起不来）。
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
      // 判据必须是"真能服务"，不是 res.ok：0.1.5 的根 URL 是 303 换 cookie，而 fetch 没有 cookie jar
      // ——只认 res.ok 会对任何 0.1.5+ 的树永远报不就绪（假阴性）。probeHostReady 会走完换票。
      // 门禁起的是用完即杀的宿主，消费掉那个 token 无所谓；壳的就绪探测则刻意不消费（见 host.mjs）。
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
    // 必须走 junction 安全删除：隔离 HOME 里是**指向被测树**的 junction 场，
    // 用"跟随链接"的方式删它会掏空被测树（0.4.6 事故第二现场，见 junction-safe.mjs 头注释）。
    const swept = safeRemoveTree(home, { log })
    if (swept.unlinked > 0) log(`[vendor-build] 门禁收尾：解开 ${swept.unlinked} 个 junction（未进入其目标）`)
  }
}

/**
 * 构建一棵 vendor 树到 targetDir。**调用方必须保证 targetDir 不是现网 vendor/profile**。
 *
 * 步骤与 scripts/build-host.mjs 原流程一一对应（manifest → npm install → 剪枝 → 插件同步 →
 * ABI 门禁 → 读运行时版本 → 写 lock），差别只在于：目标是参数、install 是异步的、插件缺失
 * 是硬失败而非静默跳过。
 * @param {{profileDir:string, versions:Record<string,string>, packagesDir:string, runtime?:string,
 *   cacheDir:string, registry?:string, npmCli?:string, install?:boolean, pluginsRequired?:boolean,
 *   logFile?:string, pluginNames?:string[], abiGate?:Function, installFn?:Function,
 *   bootGate?:Function|null, bootGateTimeoutMs?:number, patchFile?:string, ws?:string,
 *   log?:(m:string)=>void}} o 选项（install=false 即
 *   build-host 的 --prune-only 形态：复用现有树，只做剪枝/插件/门禁/lock；bootGate=null 可跳过
 *   启动门禁——**只允许在离线单测里这么做**，真实更新路径必须保留）
 * @returns {Promise<{ok:boolean, error?:string, manifest?:object, stats?:object, runtime?:object,
 *   pruned?:object, plugins?:object, abi?:object}>}
 */
export async function buildVendorTree({
  profileDir, versions, packagesDir, runtime = process.execPath, cacheDir, registry = DEFAULT_REGISTRY,
  npmCli, install = true, pluginsRequired = true, logFile, pluginNames = DEFAULT_PLUGIN_NAMES, log = () => {},
  abiGate = runAbiGate, installFn = installDependencies,
  bootGate = runBootGate, bootGateTimeoutMs = BOOT_GATE_TIMEOUT_MS, patchFile, ws,
  onProgress = () => {}, expectedPackages = DEFAULT_EXPECTED_PACKAGES, installPollMs = 1000,
  target = currentTarget(), ignoreScripts = true, verifyPackages = verifyTargetPackages,
  // 交叉构建（在 A 平台产出 B 平台的树）时，**ABI 门禁与启动门禁都必须延后到目标平台**：
  // 它们都要 spawn 目标平台的运行时，而这里只有宿主的。硬跑的结果是把握手目标平台的 `.node`
  // 全判 FAIL —— 那不是树的错。延后是**降级**，所以这里会显式标注 `gatesDeferred`，
  // 让调用方（与 CI）知道"这棵树只过了剪枝 + 平台包两项门禁"，而不是以为它全过了。
  skipAbiGate = false,
  // keepPlatforms：这棵树里**还要保住**的其它平台/架构（macOS 双架构见 mergePlatformPackages）。
  // 必须从构建期就传进来，不能等合并完再剪：剪枝若只认 target，会把主架构的预编译当"外来"删掉，
  // 而那时 donor 树已经合并、删掉的就再也回不来了。
  keepPlatforms = [],
  // lockDir：版本锁所在目录（仓库里是 `vendor/`）。**必须由调用方显式给**——
  // 真实构建走暂存布局 `<out>/.staging-build/profile`，从 profileDir 推不出 `<out>`。
  lockDir = null,
}) {
  // 阶段权重：构建全程约 8 分钟，其中 npm install 占绝对大头。百分比只是"大致到哪儿了"，
  // 真正诚实的是 step/label（当前在做什么）与 elapsed（已经等了多久）。
  const emit = (step, percent, label, detail = '') => {
    try { onProgress({ step, percent: Math.max(0, Math.min(100, Math.round(percent))), label, detail }) } catch { /* 进度回调不该影响构建 */ }
  }
  log(`[vendor-build] 目标: ${profileDir}`)
  log(`[vendor-build] 目标平台: ${platformTag(target)}${target.libc ? `（libc=${target.libc}）` : ''}`)
  let manifest = null
  if (install) {
    const npm = npmCli ?? findNpm()
    // 存在性也要查：探测到 npm 之后用户可能卸载了 Node，此时 spawn 会给出难以定位的 ENOENT；
    // 在这里挡住能直接告诉用户该装什么。
    if (npm === null || !fs.existsSync(npm)) {
      const detail = npm === null ? '' : `（探测到的路径不存在：${npm}）`
      return { ok: false, error: `未找到可用的系统 npm${detail}：本应用不内置 npm，请先安装 Node.js，或设置 DSH_NODE_DIR 指向 Node 安装目录` }
    }
    log(`[vendor-build] npm: ${npm}`)
    resetDir(profileDir)
    manifest = writeManifest(profileDir, versions)
    emit('install', 2, '正在安装依赖', '准备中')
    // 版本锁：仓库里那份平台中立的 `vendor/package-lock.json`。三平台共用它，钉死**传递依赖**的版本，
    // 否则同一个 DSH 版本在不同日期装出的树内容会不同（实测：zod / node-addon-require-builtin /
    // @types/node 等 5 个包在两个平台的产物里版本不一致）。没有锁也能装，只是回到"各装各的"。
    const lockfile = findVendorLockfile(profileDir, lockDir)
    if (lockfile !== null) log(`[vendor-build] 使用版本锁：${path.relative(path.dirname(profileDir), lockfile)}（钉死传递依赖版本）`)
    else log('[vendor-build] 提示：未找到 vendor/package-lock.json —— 各平台会各自解析传递依赖版本，可能造成平台间内容差异')
    log(`[vendor-build] npm install --omit=dev${ignoreScripts ? ' --ignore-scripts' : ''}（首次约 255MB，耐心等待）...`)
    // npm 自己的进度只对它有意义的，所以用**包目录数**当代理：npm 边解包边建目录，数得出来。
    // 数不准也不会骗人——label 里写的就是"已就位 N 个包"，percent 由它线性映射。
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
    // --prune-only 形态：在既有树上只做剪枝/插件/门禁/lock，不重装。
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

  // 平台包缺件门禁：ABI 门禁对"包根本没装进来"无感，这一步才是"装上也起不来"的拦截点。
  // 可注入/可跳过：离线自检用的是手搓的假树（没有真依赖），必须能关掉这一步，否则自检会在
  // "必需包缺失"上失败——那不是被测逻辑的问题。真实构建路径**永不**跳过。
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
  // 两道缺一不可。0.4.6 事故就是因为只做了前者：0.1.5-rc.2 的 ABI 全绿，但它起不来。
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

/**
 * 构建暂存树：产出 `<stagingRoot>/profile` + `<stagingRoot>/vendor.lock.json`，布局与现网
 * `vendor/` 一致，使换树退化为两次 rename（同卷瞬时，不是复制 122 MB）。
 * @param {{stagingRoot:string, versions:Record<string,string>, packagesDir:string, cacheDir:string,
 *   registry?:string, runtime?:string, npmCli?:string, logFile?:string, log?:(m:string)=>void,
 *   target?:TargetPlatform}} o 选项
 * @returns {Promise<{ok:boolean, error?:string, profileDir?:string, lockPath?:string, lock?:object}>}
 */
export async function buildStaging(o) {
  const { stagingRoot, versions, log = () => {}, target = currentTarget() } = o
  const profileDir = path.join(stagingRoot, 'profile')
  // install=false（build-host --prune-only）在这一层**必然是错的**：暂存区是空的，没有树可剪。
  // 旧写法会让它在空目录上失败并报"需要已有 node_modules"，指向一个用户根本没打算用的路径——
  // 报错指向错的地方，比不报错更费时间。真正的 --prune-only 走现网树，见 scripts/build-host.mjs。
  if (o.install === false) {
    return { ok: false, error: `buildStaging 只做"从零建树"（install=true）：install=false 请在现网树上用 buildVendorTree + buildVendorLock（stagingRoot=${stagingRoot}）` }
  }
  const built = await buildVendorTree({ ...o, profileDir, log, target })
  if (!built.ok) return { ok: false, error: built.error }

  const lock = buildVendorLock({ versions, target, built, profileDir })
  const lockPath = path.join(stagingRoot, 'vendor.lock.json')
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n')
  log(`[vendor-build] 暂存树就绪: ${formatMb(lock.totalBytes)} / ${lock.totalFiles} 个文件`)
  // `built` 也一并返回：调用方（`scripts/build-mac-universal.mjs`）在合并平台专属包之后要**重写 lock**，
  // 而 `buildVendorLock` 需要这份构建结果（门禁结论、剪枝统计、必需包清单）。
  // 从 `lock` 反推会丢掉结构与字段名对应关系——那种"反推"正是两份字段集漂移的来源。
  return { ok: true, profileDir, lockPath, lock, built }
}

/**
 * 组装 `vendor.lock.json` 的内容。
 *
 * 为什么抽成独立函数：lock 是事后诊断**唯一**的依据（这棵树是给哪个平台的、门禁到底跑没跑、
 * node_modules 的完整性基线是多少），而它有两个写入方——暂存构建（buildStaging，换树用）与
 * 现网维护构建（build-host --prune-only）。两份手写字段集一定会漂移，漂移的后果是"同一个应用、
 * 两个 lock 形状"，读的人得先猜是哪一代。所以字段集只在这里定义一次。
 * @param {{versions:Record<string,string>, target:TargetPlatform, built:object, profileDir:string,
 *   mergedPlatforms?:TargetPlatform[]}} o mergedPlatforms：这棵树里**还并进了**哪些平台专属包
 *   （macOS 双架构见 `mergePlatformPackages`）。与 `platform` 并列写清楚，事后才看得出
 *   "这棵树为什么比同源的另一棵大一点"，也才判得出"能不能给那个架构打包"。
 * @returns {object} lock 内容
 */
export function buildVendorLock({ versions, target, built, profileDir, mergedPlatforms = [] }) {
  return {
    generatedAt: new Date().toISOString(),
    dshVersions: versions,
    // 平台三元组：这棵树**只能**在这个平台上用（koffi/node-pty 等是预编译二进制，
    // 跨平台换树会让宿主在 import 期就崩）。有了它，事后能一眼看出"这棵树是给谁的"。
    platform: { os: target.os, arch: target.arch, ...(target.libc ? { libc: target.libc } : {}), tag: platformTag(target) },
    // 并进来的其它架构（macOS 双架构打包用）。空数组＝单平台树，与旧格式等价。
    mergedPlatforms: mergedPlatforms.map((t) => ({ os: t.os, arch: t.arch, tag: platformTag(t) })),
    runtime: built.runtime,
    // 门禁结论要如实写：交叉构建时 ABI 门禁**没跑**，就不能写 PASS ——
    // 那是"假绿"的经典形态（lock 里一个 PASS 会被后来的人当成已经验过）。
    abiScan: built.gatesDeferred?.abi === true ? 'DEFERRED（交叉构建，需在目标平台补跑）' : 'PASS',
    gatesDeferred: built.gatesDeferred ?? { abi: false, boot: false },
    platformPackages: built.packages?.present ?? [],
    prunedBytes: built.pruned.prunedBytes,
    prunedFiles: built.pruned.prunedFiles,
    // 运行期"依赖完整性"判据的基线：壳启动时数 node_modules 文件数与它比对，低于 98% 即判
    // "依赖缺件（杀软隔离/解压不全）"（2026-09-12 全新机器故障的候选之一）。
    // 必须写进 lock：连"只 --dir 打包、不重建 vendor"的场景也读得到基线。
    // 注意：该基线**按平台不同**（各平台的预编译件数量不一样），所以它与 platform 段必须同批写。
    nodeModulesFiles: countFiles(path.join(profileDir, 'node_modules')),
    ...built.stats,
  }
}
