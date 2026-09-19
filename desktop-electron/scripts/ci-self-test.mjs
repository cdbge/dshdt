// ci-self-test.mjs — CI 配置与门禁清单的自查（纯 Node、脱网）
//
// 为什么需要：跨平台改造前，README 声称"改动后必跑"的
// 9 套自检**在 CI 里一条都没跑**——文档与流水线各说各话，谁也没发现。这类漂移只能在**机器上**查。
//
// 本文件查三件事，全部用文本/结构判据，不需要 YAML 解析器（GitHub Actions 的 YAML 里
// `on:` 会被 YAML 1.1 解析成布尔真，任何按 1.1 解析出来的结构都不可信，所以这里只做**结构断言**）：
//   ① `release.yml` 的手术式检查：哪些平台、哪些门禁、产物 glob 是否覆盖三平台；
//   ② `scripts/test-suite.mjs` 的清单与磁盘上的套件文件一一对应（清单里不能有幽灵，反之亦然）；
//   ③ `package.json` 的 scripts 里不该再出现写死的平台（`--win` 之外的平台参数必须成对存在）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
let fail = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!cond) fail++ }
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---------- 1) release.yml 的三平台矩阵 ----------
console.log('[release.yml]')
const ci = read('../.github/workflows/release.yml')
ok('三平台 runner 都在（windows/ubuntu/macos）',
  ci.includes('windows-latest') && ci.includes('ubuntu-latest') && ci.includes('macos-14'),
  ['windows-latest', 'ubuntu-latest', 'macos-14'].filter((s) => !ci.includes(s)).join(',') || 'all')
ok('触发方式含 tag 与手动（tag 走发布、手动用于验证）',
  /push:\s*\n\s*tags:\s*\['v\*'\]/.test(ci) && ci.includes('workflow_dispatch'))
ok('离线自检作为独立 job 在三平台各跑一遍',
  /self-test:/.test(ci) && /node scripts\/test-suite\.mjs/.test(ci) && /matrix:/.test(ci))
ok('每个打包 job 都依赖自检（needs: self-test）',
  (ci.match(/needs:\s*self-test/g) ?? []).length >= 3,
  `needs 计数=${(ci.match(/needs:\s*self-test/g) ?? []).length}`)
ok('Linux 打包 AppImage 与 deb', /--linux AppImage deb/.test(ci))
ok('macOS 打包 dmg 与 zip，且两个架构都出', /--mac dmg zip --arm64 --x64/.test(ci))
// macOS 双架构的**前置条件**：`--mac ... --arm64 --x64` 会把同一棵 vendor 树打进两个架构的 .app，
// 而 npm install 一次只能按一个 --cpu 解析可选依赖 ⇒ 必须用 build-mac-universal.mjs 产出
// "两个架构平台包并存"的树。少了这一步，x64 的 .app 装上也起不来（koffi/node-pty import 期崩）。
ok('macOS job 建的是双架构树（否则 x64 产物里只有 arm64 的预编译）',
  /node scripts\/build-mac-universal\.mjs --host arm64 --add x64/.test(ci))
ok('另两个 job 仍用单平台 build-host（不要顺手改成双架构）',
  (ci.match(/node scripts\/build-host\.mjs/g) ?? []).length === 2,
  `build-host 调用数=${(ci.match(/node scripts\/build-host\.mjs/g) ?? []).length}`)
ok('Windows 仍打 NSIS', /--win nsis/.test(ci))
ok('三个打包 job 都跑 vendor 树静态体检（原生平台的补充证据）',
  (ci.match(/verify-cross-tree\.mjs --dir vendor/g) ?? []).length >= 3,
  `计数=${(ci.match(/verify-cross-tree\.mjs --dir vendor/g) ?? []).length}`)
ok('Linux 冒烟有显示环境（xvfb-run）', /xvfb-run -a/.test(ci))
ok('Linux 装了 deb 打包依赖与沙箱依赖',
  ci.includes('libarchive-tools') && ci.includes('fakeroot') && ci.includes('rpm') && ci.includes('libfuse2'))
ok('macOS 在打包前生成 icns 并校验其存在', /gen-icon\.mjs/.test(ci) && /test -s build\/icon\.icns/.test(ci))
// .icns 改成**纯 Node 容器**之后，非 macOS 也能生成它（原来只能在 macOS 上靠 sips/iconutil）。
// 这条钉住"别再退回 macOS-only 的实现"——退回去会让 macOS 打包又多一个与打包本身无关的卡点。
// 判据看**是否真的去执行**（execFileSync/spawn 的实参里出现工具名），不看文件里有没有这两个词：
// 注释里提到它们是正常的历史记录（第一版断言就是被自己的注释绊倒的）。
const genIconSrc = read('scripts/gen-icon.mjs')
ok('.icns 生成不依赖 macOS（纯 Node 容器）',
  !/(execFileSync|execSync|spawnSync|spawn)\s*\([^)]*['"](sips|iconutil)['"]/.test(genIconSrc)
  && /'icns'/.test(genIconSrc),
  /execFileSync\([^)]*(sips|iconutil)/.test(genIconSrc) ? '仍在调用 sips/iconutil' : '纯 Node 拼容器')
ok('有独立核验 .icns 容器结构的脚本', fs.existsSync(path.join(ROOT, 'scripts', 'verify-icns.mjs')))
ok('打包态 smoke 的判据不依赖退出码（按 PASS 计数或 SMOKE OK）',
  (ci.match(/PASS/g) ?? []).length >= 3 && !/if \(\$LASTEXITCODE -ne 0\) \{ throw "packaged smoke exit/.test(ci),
  '包装态 smoke 判据')
ok('产物上传覆盖三平台扩展名（exe/AppImage/deb/dmg/zip）',
  ['.exe', '.AppImage', '.deb', '.dmg', '.zip'].every((ext) => ci.includes(ext)))
ok('签名 Secrets 接进 CI（未配置则出未签名包）',
  ci.includes('WINDOWS_CERT_PFX') && ci.includes('CSC_LINK') && ci.includes('APPLE_TEAM_ID'))

// ---------- 2) 自检清单与磁盘一致 ----------
console.log('[scripts/test-suite.mjs]')
const suite = read('scripts/test-suite.mjs')
const listed = [...suite.matchAll(/^\s*'((?:scripts|packages)\/[^']+)',\s*$/gm)].map((m) => m[1])
ok('清单非空', listed.length >= 10, `列出 ${listed.length} 个`)
const missing = listed.filter((rel) => !fs.existsSync(path.join(ROOT, rel)))
ok('清单里的每个套件都真实存在', missing.length === 0, missing.join(', '))
ok('vendor 平台化自检在清单里', listed.includes('scripts/vendor-build-self-test.mjs'))
ok('两套平台自检在清单里',
  listed.includes('scripts/platform-self-test.mjs') && listed.includes('scripts/host-platform-self-test.mjs'))

/** 磁盘上所有 *-self-test.mjs / *-test.mjs（排除清单本身与 smoke、辅助工具）。 */
const onDisk = []
const walk = (dir) => {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) walk(rel)
    else if (e.name.endsWith('-self-test.mjs')) onDisk.push(rel.split(path.sep).join('/'))
  }
}
walk('scripts')
walk(path.join('packages', 'dsh-auto-approval', 'test'))
const notListed = onDisk.filter((rel) => !listed.includes(rel))
ok('磁盘上的自检套件都已进清单（不许有漏网的）', notListed.length === 0, notListed.join(', '))

// ---------- 3) package.json 的平台参数成对 ----------
console.log('[package.json]')
const pkg = JSON.parse(read('package.json'))
ok('三个平台的打包入口都在',
  pkg.scripts['dist'] !== undefined && pkg.scripts['dist:linux'] !== undefined && pkg.scripts['dist:mac'] !== undefined)
ok('有统一跑自检的入口 test:suite', typeof pkg.scripts['test:suite'] === 'string')
ok('license 字段存在（deb 打包必需）', typeof pkg.license === 'string' && pkg.license !== '')
ok('build:host 只调脚本、不带写死的平台参数（平台由 --os/--cpu 决定）',
  pkg.scripts['build:host'] === 'node scripts/build-host.mjs', pkg.scripts['build:host'])
ok('有双架构 macOS 构建入口', pkg.scripts['build:mac-universal'] === 'node scripts/build-mac-universal.mjs',
  pkg.scripts['build:mac-universal'])

// ---------- 4) 图标资源与打包配置对得上 ----------
console.log('[electron-builder.yml]')
const eb = read('electron-builder.yml')
ok('linux 图标指向 png 目录（.ico 会被 electron-builder 拒）', /icon:\s*build\/icons/.test(eb))
ok('mac 图标指向 icns', /icon:\s*build\/icon\.icns/.test(eb))
ok('windows 图标指向 ico', /icon:\s*build\/icon\.ico/.test(eb))
ok('extraResources 带上 png（Linux/macOS 托盘与窗口要用）', /build\/icon\.png/.test(eb))
ok('声明了 dsh:// 深链（macOS/Linux 靠它注册）', /protocols:/.test(eb) && /schemes:/.test(eb))
ok('deb 建议安装 bubblewrap（DSH 的 Linux 沙箱后端）', /bubblewrap/.test(eb))
ok('macOS 有 entitlements 与 hardenedRuntime', /entitlements\.mac\.plist/.test(eb) && /hardenedRuntime:\s*true/.test(eb))
ok('三平台各自声明了 artifactName（否则退化成含空格的默认产物名）',
  (eb.match(/artifactName:\s*DSHDesktop-/g) ?? []).length >= 3,
  `声明数=${(eb.match(/artifactName:\s*DSHDesktop-/g) ?? []).length}`)
ok('三平台 artifactName 的后缀能区分产物（Setup / arch / ext 三套口径都在）',
  /DSHDesktop-Setup-\$\{version\}\.\$\{ext\}/.test(eb) && (eb.match(/DSHDesktop-\$\{version\}-\$\{arch\}\.\$\{ext\}/g) ?? []).length >= 2)

// ---------- 5) 统一删除入口----------
//
// 为什么用门禁守它：`$DSH_HOME/profiles/**/node_modules`、`profile.old-*`、`vendor/staging/**`
// 这些目标里都有 junction/symlink 场，递归删除"当前恰好不跟随链接"是实现细节、不是契约。
// 而"绕过安全删除"这种退化不会报错、只在别人机器上掏空目录时才暴露 —— 只能靠静态检查挡住。
console.log('[删除入口一致性]')
const SRC_FILES = ['src/main.mjs', 'src/vendor-build.mjs', 'src/dsh-apply.mjs', 'src/host.mjs', 'src/repair.mjs', 'src/admin.mjs']
const offenders = []
for (const rel of SRC_FILES) {
  const text = read(rel)
  // 逐行看：命中 `rmSync(...recursive` 就算违规（注释行除外）
  for (const [i, line] of text.split('\n').entries()) {
    if (/^\s*(\/\/|\*)/.test(line)) continue
    if (/rmSync\([^)]*recursive/.test(line)) offenders.push(`${rel}:${i + 1}`)
  }
}
ok('src/ 下没有递归 rmSync（一律走 safeRemoveTree）', offenders.length === 0, offenders.join(', ') || '无')
const saferUsers = SRC_FILES.filter((rel) => read(rel).includes('safeRemoveTree'))
ok('会删树的四个模块都接入了安全删除（main / vendor-build / dsh-apply + junction-safe 自身）',
  ['src/main.mjs', 'src/vendor-build.mjs', 'src/dsh-apply.mjs'].every((rel) => saferUsers.includes(rel)),
  saferUsers.join(', '))

// ---------- 6) 决策 D8/D9 的落地痕迹（改回去要能被发现）----------
//
// 这两条都是"用户拍板的架构决策"，最怕被后来的改动无意识地回退：
//   D8：可变 vendor 树必须在**用户数据目录**（包内那份只作种子），否则 macOS 换树破坏签名、
//       AppImage 换树 EROFS；
//   D9：启用单实例锁 + 三路深链送达（open-url / second-instance / 冷启动 argv），
//       否则 dsh:// 注册了也没人接。
console.log('[D8/D9 落地痕迹]')
const mainSrc = read('src/main.mjs')
// 后台日志窗口（Ctrl+Shift+L）：一个"看后台"的入口，打包版没有 F12 时这是唯一的路。
// 判据四条：页面文件随壳分发、路由与只读端点都在、快捷键**注册也要注销**、
// 读日志必须走**白名单**（这个端口虽然只在回环，也不该变成任意读文件的口子）。
console.log('[后台日志窗口]')
const adminSrc = read('src/admin.mjs')
const logsHtml = read('src/logs.html')
ok('日志页面随壳分发（asar 的 files 里有 src/**）', logsHtml.includes('DSH Desktop 后台日志') && logsHtml.includes('/api/logs'))
ok('admin 路由都在：GET /logs 与 GET /api/logs',
  /u\.pathname === '\/logs'/.test(adminSrc) && /u\.pathname === '\/api\/logs'/.test(adminSrc))
ok('读日志只吃白名单（LOG_FILES），不吃任意路径',
  /const LOG_FILES = \[/.test(mainSrc)
  && /logFileEntries\(\)\.find\(\(f\) => f\.name === name\)/.test(mainSrc)
  && /fs\.openSync\(entry\.path, 'r'\)/.test(mainSrc))
ok('大日志只读末尾（512KB 上限，避免每次刷新同步阻塞主进程）',
  /512 \* 1024/.test(mainSrc) && /fs\.readSync\(fd, buf, 0, len, start\)/.test(mainSrc))
ok('窗口用快捷键开/关，且托盘里也有入口（快捷键被占用时不至于没路）',
  /globalShortcut\.register\('CommandOrControl\+Shift\+L'/.test(mainSrc)
  && /label: '后台日志（Ctrl\+Shift\+L）'/.test(mainSrc))
ok('退出时注销全局快捷键（不注销会占着这个键，重开应用注册失败）',
  /globalShortcut\.unregisterAll\(\)/.test(mainSrc))
ok('日志窗口与主窗口同一套硬化（无 node、隔离、沙箱）',
  /function openLogWindow\(\)/.test(mainSrc) && /sandbox: true, devTools: DEV/.test(mainSrc))
// 启动速度（2026-09-17 用户："每次双击桌面快捷方式要等很长时间才能看见窗口"）：
// 实测双击 → 看见窗口 ≈ 19.5s（进程启动 ~3.5s + **宿主 ~16s** + 切页 ~0.1s），
// 因为窗口原先要等宿主就绪才**创建**。修法：窗口提到 bootHost 之前，先装启动页并立刻 show()，
// 宿主就绪后再 loadURL 切到真实页面。
console.log('[启动速度：先出窗口再等宿主]')
ok('启动页随壳分发（file:// 装载，不依赖 admin 服务）',
  read('src/splash.html').includes('正在启动后台服务') && /const SPLASH_HTML =/.test(mainSrc))
ok('createWindow 跑在 bootHost **之前**（否则用户要盯空屏 ~16 秒）',
  /spawnTray\(\)[\s\S]{0,400}?await createWindow\(\)[\s\S]{0,2500}?await bootHost\(\)/.test(mainSrc))
ok('宿主未就绪装启动页、就绪后切真实页面',
  /if \(readyUrl\) win\.loadURL\(readyUrl\)\s*\n\s*else win\.loadURL\(pathToFileURL\(SPLASH_HTML\)\.href\)/.test(mainSrc)
  && /await pruneAuthCookies\(\)\s*\n\s*win\.loadURL\(readyUrl\)/.test(mainSrc))
ok('窗口立刻 show()（不等 ready-to-show，"显示得早"才成立）',
  /if \(!HEADLESS\) \{ try \{ win\.show\(\) \} catch/.test(mainSrc))
ok('will-navigate 里 webPort **现读**（窗口建在 bootHost 之前 ⇒ 写死端口 0 会把切页拦掉）',
  /if \(!webPort\) return\s*\n\s*if \(!url\.startsWith\(/.test(mainSrc))
ok('D8：vendor 归属走 vendor-home',
  /resolveVendorHome\(/.test(mainSrc) && /prepareVendorHome\(/.test(mainSrc))
ok('D8：回退路径存在',
  /inspectVendorHome\(/.test(mainSrc) && /VENDOR_DIR = seed/.test(mainSrc))
ok('D9：启用了单实例锁', /requestSingleInstanceLock\(/.test(mainSrc))
ok('D9：second-instance 与 open-url 都接了', /on\('second-instance'/.test(mainSrc) && /on\('open-url'/.test(mainSrc))
ok('D9：冷启动 argv 里的 dsh:// 也被消费', /COLD_START_URL/.test(mainSrc) && /pickProtocolUrl/.test(mainSrc))
ok('D9：诊断类命令不抢锁（否则跑在应用里时 --doctor/--diag 直接失效）',
  /SINGLE_INSTANCE = [^\n]*DOCTOR[^\n]*DIAG/.test(mainSrc))
// 单实例的**第二半**：拿到锁只解决了"不重复启动"，用户要的是"重复启动把已有窗口调出来"。
// 2026-09-16 实测的缺陷形态：窗口**最小化**时旧的 `win.show(); win.focus()` 两者都作用不到
// 已被最小化的 HWND 上（`isVisible()` 仍为 true ⇒ show 短路），重复启动表现为毫无反应。
// 这两条钉住修复不被回退；判据只看**真的调了那些 API**，不看在不在注释里。
ok('单实例：第二个实例必须把窗口抬到前台（restore 最小化 / show 托盘）',
  /function surfaceWindow\(/.test(mainSrc) && /win\.isMinimized\(\)\)\s*win\.restore\(\)/.test(mainSrc)
  && /!\s*win\.isVisible\(\)\)\s*win\.show\(\)/.test(mainSrc))
ok('单实例：走的是"置顶再取消"的 Windows 前台锁绕行（普通 focus() 会被系统静默忽略）',
  /setAlwaysOnTop\(true\)/.test(mainSrc) && /setAlwaysOnTop\(false\)/.test(mainSrc)
  && /app\.focus\(\{\s*steal:\s*true\s*\}\)/.test(mainSrc))
ok('单实例：second-instance 分支留痕（日志是打包态唯一能区分"没触发"与"置前失败"的线索）',
  /on\('second-instance'[\s\S]{0,900}?log\(/.test(mainSrc))
// 单实例的**第三半**（2026-09-17 实测补上）：前两条钉住"锁生效"与"置顶绕行"，
// 但外部实测发现**第二个进程在壳代码跑起来之前就退出了**（零输出、零日志、退出码 0），
// 于是 `second-instance` 事件有没有送达**无法从壳内部证实** —— 实测最小化后重复启动，
// 12 秒内窗口始终没还原、日志一个字节没加。⇒ 补一条**不依赖平台事件**的兜底通道：
// 拿不到锁的进程写请求文件，拿到锁的进程轮询它。本断言保证它存在且真的接上。
ok('单实例：重复启动有"文件信号"兜底通道（不依赖 second-instance 事件是否送达）',
  /RESTORE_REQUEST_FILE\s*=/.test(mainSrc)
  && /writeFileSync\(RESTORE_REQUEST_FILE/.test(mainSrc)
  && /statSync\(RESTORE_REQUEST_FILE\)/.test(mainSrc)
  && /setInterval\(/.test(mainSrc))
ok('单实例：兜底轮询定时器在退出时被回收（不留悬挂定时器）',
  /clearInterval\(restoresWatchTimer\)/.test(mainSrc))
// 日志目录必须在**模块顶层**就建好：单实例那段的第一句 log() 发生在 app.whenReady() 之前，
// 而建目录原本在 main() 里 ⇒ 第二实例的日志被静默吃掉（这正是"零日志"的成因）。
ok('日志目录在模块顶层就建好（否则单实例段的第一句日志会被静默丢掉）',
  /mkdirSync\(LOG_DIR, \{ recursive: true \}\)/.test(mainSrc.slice(0, mainSrc.indexOf('requestSingleInstanceLock'))),
  '判据：建目录要出现在 requestSingleInstanceLock 之前')
const vendorHome = read('src/vendor-home.mjs')
ok('D8：种子迁移"全或全无"（先写 .seeding 再 rename）',
  /\.seeding/.test(vendorHome) && /renameSync\(staging, dir\)/.test(vendorHome))
ok('D8：种子不覆盖已有目标（否则会把用户换过的树回退）',
  /already-present/.test(vendorHome))

// ---------- 6b) 市场：两份插件名单必须同改（最容易漏、且漏了不报错）----------
//
// 自研插件有**两个落点**：构建期把 `packages/<名>` 拷进 vendor 树（`vendor-build.mjs` 的
// DEFAULT_PLUGIN_NAMES），启动期再从 vendor 同步到 profile 插件位（`main.mjs` 的
// PROFILE_PLUGIN_NAMES）。两处**任一漏改**都不会报错，表现是"包打出来了、装上去那个插件就是不在"
// ——（仓库树与已装树不一致导致皮肤静默失效）同一类哑失效。所以拿机器判据把两份名单钉成一份。
console.log('[市场与插件名单]')
const vendorBuildSrc = read('src/vendor-build.mjs')
const namesOf = (src, re) => {
  const m = src.match(re)
  if (m === null) return null
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).sort()
}
const buildNames = namesOf(vendorBuildSrc, /DEFAULT_PLUGIN_NAMES = \[([^\]]*)\]/)
const profileNames = namesOf(mainSrc, /PROFILE_PLUGIN_NAMES = \[([^\]]*)\]/)
ok('两份插件名单都存在且都含 dsh-market',
  Array.isArray(buildNames) && buildNames.includes('dsh-market')
  && Array.isArray(profileNames) && profileNames.includes('dsh-market'),
  `build=${JSON.stringify(buildNames)} profile=${JSON.stringify(profileNames)}`)
ok('两份插件名单**逐项一致**（加插件必须两处同改）',
  Array.isArray(buildNames) && Array.isArray(profileNames)
  && buildNames.length === profileNames.length
  && buildNames.every((n, i) => n === profileNames[i]),
  `build=${JSON.stringify(buildNames)} profile=${JSON.stringify(profileNames)}`)
// 市场装的第三方包**绝不能**进这份名单：`syncProfilePlugin` 是"整目录删除 + 重拷"，
// 写进去 = 每次启动都用包内副本覆盖用户装的东西。这条注释就是那条守卫的判据（注释即契约）。
ok('PROFILE_PLUGIN_NAMES 明确标注"只放随包自带"（市场装的包不得进这张表）',
  /第三方包\*\*绝不能\*\*加进来|只放\*\*随包自带\*\*/.test(mainSrc))
ok('市场包声明为客户端插件（exports["./client"] + dsh.client.platform=web）',
  (() => {
    try {
      const pkg = JSON.parse(read('packages/dsh-market/package.json'))
      return pkg.exports !== undefined && pkg.exports['./client'] === './lib/client.js'
        && pkg.dsh !== undefined && pkg.dsh.client !== undefined && pkg.dsh.client.platform === 'web'
    } catch { return false }
  })())
{
  // 市场界面必须只占**官方插槽**：这是"风格一致 + 不与 vendor 打架"的全部依据。
  // 判据看真的注册了哪个槽名，不看注释里写了什么。
  const marketClient = read('packages/dsh-market/lib/client.js')
  ok('市场入口挂在官方底部插槽 sidebar.footer.action 上',
    /slots\.inject\(\s*["']sidebar\.footer\.action["']/.test(marketClient)
    && /name:\s*["']sidebar\.footer\.action["']/.test(marketClient))
  // 这条断言改过一次，原因值得记：**它原来要求"必须用官方 Modal"**，而市场后来因为
  // 官方 Modal 的 `.root` padding 与 `.dialog` 的 `width: min(380px,100%)` 两下夹击、
  // 弹窗被挤成窄柱（返工三次），最终改成**自绘遮罩**。
  // ⇒ 断言不该锁死"用哪个组件"，该锁的是**用户能看到的东西**：
  //    ① 有真正的对话框语义（role="dialog" / aria-modal）；
  //    ② 配色只用 DSH 的设计令牌（`--dsw-alias-*` / `--dsw-elevation-*`），不写死颜色。
  ok('市场弹窗有对话框语义且只用 DSH 设计令牌（不锁"必须用官方 Modal"，锁用户体验）',
    /role:\s*["']dialog["']/.test(marketClient)
    && /"aria-modal":\s*["']true["']/.test(marketClient)
    && /--dsw-alias-/.test(marketClient) && /--dsw-elevation-/.test(marketClient))
  ok('市场不注册同名 contribution 之外的命令（避免整组「指令」消失那类事故）',
    !/commandUi\.register/.test(marketClient))
  // ⚠️ 这条是**一次真实事故**换来的（2026-09-17）：我为了修"窄柱"往注入样式表里加过一条
  // `.dsh-market-dialog > * { width:100% !important; ... }`。当时弹窗是**纵向** flex（头/体/脚），
  // 那条规则没问题；后来弹窗改成**横向两栏**（左导航 188px + 右内容 flex:1），它就把两栏一起顶成
  // 100%、溢出被 `overflow:hidden` 裁掉 —— **用户看到"市场页面只剩条目"**。
  // 这类"给某一层结构写的、带 !important 的通用子元素选择器"是最危险的死代码：
  // 结构一变，它不报错、只是静静地把新布局毁掉。所以门禁禁止它再出现在这个插件里。
  //
  // 判据**必须先剥掉注释**：第一版直接对整份源码做正则，结果匹配到的是上面那段"事后说明"
  // 里的示例文本 ⇒ 判据永久假红（"注释把断言绊倒"这个坑，规范里已经记过一次，我又踩了）。
  {
    const withoutComments = marketClient
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))   // 去掉行注释，但保住 `https://` 这类 URL
      .join('\n')
    ok('市场不注入"通用子元素"样式（`> *` 这类 !important 布局兜底会在改结构时静默毁掉布局）',
      !/\.dsh-market-[a-z-]+\s*>\s*\*/.test(withoutComments)
      && !/display:\s*["']contents["']/.test(withoutComments))
  }
}
{
  // 随包样例目录：界面与格式的"事实源"，必须能被解析且两个页面都在。
  // 判据与壳的 readMarketCatalog 同口径（缺 id/name/source 的条目一律丢弃，这里只查骨架）。
  let cat = null
  try { cat = JSON.parse(read('src/market-catalog.json')) } catch { cat = null }
  ok('随包市场目录可解析，且含 plugins / themes 两个数组',
    cat !== null && Array.isArray(cat.plugins) && Array.isArray(cat.themes),
    cat === null ? 'JSON 解析失败' : `plugins=${cat.plugins?.length} themes=${cat.themes?.length}`)
  ok('随包目录的每条都有 id / name / https 源地址',
    cat !== null && [...cat.plugins, ...cat.themes].every(
      (e) => typeof e.id === 'string' && e.id !== '' && typeof e.name === 'string' && e.name !== ''
        && typeof e.source === 'string' && /^https:\/\//.test(e.source)))
  ok('随包目录的每条都有**安装方式**（install.steps：壳只展示；install.spec 才是安装坐标）',
    cat !== null && [...cat.plugins, ...cat.themes].every(
      (e) => e.install && typeof e.install === 'object' && typeof e.install.steps === 'string' && e.install.steps.trim() !== ''),
    cat === null ? 'JSON 解析失败'
      : [...cat.plugins, ...cat.themes].map((e) => `${e.id}:${e.install && e.install.steps ? 'ok' : '缺失'}`).join(' '))
  // 上架时 author 很容易把 homepage 直接填成仓库地址（我自己就这么填过），
  // 于是卡片上并排两个按钮点开**同一个页面** —— 用户一眼就看出是多余的。
  // 判据做规范化（去协议/www/锚点/尾斜杠/.git）后比较：同仓库的子路径也算"同一个"。
  {
    const norm = (u) => {
      let s = String(u || '').trim().toLowerCase()
      if (s === '') return ''
      s = s.replace(/^https?:\/\//, '').replace(/^www\./, '')
      s = s.replace(/[#?].*$/, '').replace(/\/+$/, '').replace(/\.git$/, '')
      return s
    }
    const dup = cat === null ? ['（目录不可解析）'] : [...cat.plugins, ...cat.themes]
      .filter((e) => {
        const a = norm(e.homepage)
        const b = norm(e.source)
        return a !== '' && b !== '' && (a === b || a.startsWith(b + '/') || b.startsWith(a + '/'))
      })
      .map((e) => e.id)
    ok('随包目录里没有"主页与源地址指向同一处"的条目（否则卡片上两个按钮点开同一页）',
      dup.length === 0, dup.join(', '))
  }
  ok('随包目录里没有 http 下载地址（只允许 https 或留空）',
    cat !== null && [...cat.plugins, ...cat.themes].every(
      (e) => e.download === undefined || e.download.url === undefined
        || e.download.url === '' || /^https:\/\//.test(e.download.url)))
}
ok('壳供给市场目录（GET /api/market/catalog）且下载端点存在（POST /api/market/open-download）',
  /u\.pathname === ['"]\/api\/market\/catalog['"]/.test(read('src/admin.mjs'))
  && /case ['"]\/api\/market\/open-download['"]/.test(read('src/admin.mjs')))
// 「下载」= 把 https 地址交给系统（给想自己动手的人；与"一键安装"并存）。
// 判据取**函数体**，不用"附近若干字符"的窗口——第一版用 `market[\s\S]{0,400}?syncProfilePlugin`
// 直接假红（窗口跨到了邻接的 `ensureProfilePlugins()`）。窗口式判据在有邻接代码时必然误判。
{
  const body = (mainSrc.match(/async function marketOpenDownload[\s\S]*?\n}/) ?? [''])[0]
  ok('下载 = 把 https 地址交给系统（shell.openExternal + 非 https 拒绝）',
    /async function marketOpenDownload/.test(mainSrc) && /shell\.openExternal\(url\)/.test(mainSrc)
    && /拒绝打开非 https 地址/.test(mainSrc))
  ok('下载那条路**不落盘**（下载只把地址交出去，落盘只发生在安装那条路）',
    body !== '' && !/fs\.(write|mkdir|rm|unlink|rename|cp|appendFile)/.test(body),
    body === '' ? '取不到 marketOpenDownload 函数体（判据失效，当失败）' : `bodyLen=${body.length}`)
}
// 安装走官方 `dsh plugin --profile <name> add <spec>`，因为只有它会解析依赖、锁版本、
// 并把声明了 `dsh.bundle` 的包自动写进 `dsh.profile.bundles`（连挂载行都不用我们写）。
// 判据看**真的调了官方 CLI**，且外面保留了"缺 pnpm 就先告诉用户怎么装"的体检。
{
  const body = (mainSrc.match(/async function marketInstall[\s\S]*?\n}/) ?? [''])[0]
  ok('市场安装走官方 CLI：`dsh plugin --profile <名> add`',
    /async function marketInstall/.test(mainSrc)
    && /installMarketEntryOfficial\(/.test(mainSrc)
    && /plugin', '--profile', profile, 'add'/.test(read('src/market-install-official.mjs')))
  ok('安装不再由壳自己下载解包（marketInstall 里没有下载/解包/落盘）',
    body !== '' && !/httpDownload|extractZipSafe|fs\.(write|mkdir|rename|cp)/.test(body),
    body === '' ? '取不到 marketInstall 函数体（判据失效，当失败）' : `bodyLen=${body.length}`)
  ok('缺 pnpm 的处置是"告诉用户怎么装"而不是自动改环境（不自动跑 corepack/npm）',
    /function marketPreflight/.test(mainSrc) && /pnpmHint\(\)/.test(mainSrc)
    && !/spawnSync\(['"]corepack|npm['"],\s*\[['"]i['"],\s*['"]-g['"]/.test(mainSrc))
  ok('有安装前置体检端点（GET /api/market/preflight）',
    /u\.pathname === ['"]\/api\/market\/preflight['"]/.test(read('src/admin.mjs')))
}
ok('市场目录随包分发（electron-builder extraResources 里有 market-catalog.json）',
  /market-catalog\.json/.test(read('electron-builder.yml')))

// ---------- 6b) 热更新（electron-updater）的接线 ----------
//
// 这类失效**全是静默的**，所以必须拿机器判据钉住：
//   · 打包配置没有 `publish.provider` ⇒ 包里没有 `app-update.yml` ⇒ 壳里 HAS_UPDATE_SOURCE 永远 false、
//     托盘「检查更新」永远灰着（不报错）；
//   · CI 不建 Release ⇒ 装了旧版的人永远发现不了新版本（界面只会说"已是最新"）——
//     workflow artifact 有稳定 URL、且会过期，electron-updater 读的是 Release 资产里的 latest*.yml。
console.log('[热更新通道]')
const builderCfg = read('electron-builder.yml')
ok('打包配置配了 GitHub 发布源（否则不产 app-update.yml / latest*.yml）',
  /^publish:\s*$/m.test(builderCfg) && /provider:\s*github/.test(builderCfg)
  && /owner:\s*\S+/.test(builderCfg) && /repo:\s*\S+/.test(builderCfg))
ok('本地打包一律 --publish never（配了 provider 之后，本地误发是很容易犯的错）',
  ['dist', 'dist:linux', 'dist:mac', 'dist:current'].every((k) => String(pkg.scripts[k] ?? '').includes('--publish never')),
  JSON.stringify(pkg.scripts.dist))
ok('CI 有写权限（建 Release 需要 contents: write）', /permissions:\s*\n\s*contents:\s*write/.test(ci))
ok('三个平台都把 latest*.yml 纳入产物上传',
  (ci.match(/dist\/latest\*\.yml/g) ?? []).length >= 3,
  `计数=${(ci.match(/dist\/latest\*\.yml/g) ?? []).length}`)
ok('有独立的 release job：等 Windows 与 Linux 产完再建 Release（避免并发抢同一 tag 的 Release）',
  /^  release:\s*$/m.test(ci) && /needs:\s*\[windows, linux\]/.test(ci))
// macOS 目前未在真机验证（未签名/未公证），它的失败不该拦住另外两端的出包——
// 所以这个 job 必须 continue-on-error，且**不能进 release.needs**（否则 release 永远不跑）。
ok('macOS job 不阻塞发布（continue-on-error 且不进 release.needs）',
  /^  macos:\s*$/m.test(ci) && /continue-on-error:\s*true/.test(ci)
  && !/needs:\s*\[[^\]]*macos[^\]]*\]/.test(ci))
ok('release job 只在 tag 推送时跑（手动 dispatch 不动线上发布）',
  /if:\s*startsWith\(github\.ref, 'refs\/tags\/v'\)/.test(ci))
// 逐行判据（不是子串包含）：mac 的命令里 `--publish never` 前面还夹着 `--arm64 --x64`，
// 用 "cmd + 空格 + --publish never" 去 includes 会漏掉它（第一版就是这么写错的）。
const ebCmdLines = ci.split('\n').filter((l) => l.includes('npx electron-builder'))
ok('CI 的三个打包命令都 --publish never（配了 provider 之后，tag 构建会各自尝试发布 ⇒ 三个 job 抢同一个 Release）',
  ebCmdLines.length === 3 && ebCmdLines.every((l) => l.includes('--publish never')),
  ebCmdLines.filter((l) => !l.includes('--publish never')).join(' | ') || `共 ${ebCmdLines.length} 条命令，全部合规`)
ok('release job 把 Windows/Linux 的 latest*.yml 齐备当硬失败（缺了就是静默失效）',
  /latest-linux\.yml/.test(ci) && /latest\.yml/.test(ci) && /门禁：热更新元数据齐备/.test(ci))
ok('壳侧把"有发布源"与"能自我替换"分开建模（Linux 非 AppImage 不能自更新）',
  /const IS_APPIMAGE = process\.platform === 'linux'/.test(mainSrc)
  && /const UPDATABLE = HAS_UPDATE_SOURCE && \(process\.platform !== 'linux' \|\| IS_APPIMAGE\)/.test(mainSrc))
ok('非 AppImage 的 Linux 安装降级为"打开下载页"（而不是灰掉入口或报错）',
  /不支持自更新/.test(mainSrc) && /function releasesUrl\(\)/.test(mainSrc) && /shell\.openExternal\(url\)/.test(mainSrc))
ok('下载进度与错误都落日志（否则"更新卡住了"没有任何线索）',
  /download-progress/.test(mainSrc) && /updater 错误/.test(mainSrc))

// ---------- 6c) 门禁自己必须能在"干净 clone"里成立 ----------
//
// 2026-09-19 CI 首跑：三个平台的自检 job **一起红**。根因不是代码，而是套件读了被 .gitignore
// 挡着的**生成物**（`build/icon.png`、`build/icons/`）——CI 是全新 checkout，也不会为了跑离线自检
// 去启动 Electron 生成图标。判据只要依赖"本机跑过 npm run icons"，它就只在作者机器上绿，
// 而那等于没有门禁（本地全绿、CI 全红，还会拦住发布）。
console.log('[干净 checkout 可跑性]')
const trayTestSrc = read('scripts/tray-icon-self-test.mjs')
ok('托盘图标套件不裸读生成物（build/icon.png 存在才验真实字节，否则验生成器契约）',
  /existsSync\(pngPath\)/.test(trayTestSrc) && /gen-icon\.mjs/.test(trayTestSrc))
const assetsTestSrc = read('scripts/check-assets-self-test.mjs')
ok('check-assets 套件自带生成物夹具，且收尾只删自己建的（干净 clone 里也成立）',
  /function ensureGeneratedAssets\(\)/.test(assetsTestSrc) && /fs\.rmSync\(path\.join\(ROOT, 'build', rel\)/.test(assetsTestSrc))
// vendor/profile/ 整体是构建产物，但**那份 manifest 必须入库**：check-vendor-lock 是拿它和
// vendor/package-lock.json 互核的，缺了它"版本锁"这道门禁在干净 clone 里必然红（2026-09-19 实测）。
// gitignore 的写法也钉住：必须先忽略 `vendor/profile/*` 再用 `!` 反选，写成带斜杠的目录会让反选失效。
const gitignore = read('../.gitignore')
ok('vendor/profile/package.json 已从 .gitignore 反选（版本声明必须入库）',
  /^desktop-electron\/vendor\/profile\/\*$/m.test(gitignore)
  && /^!desktop-electron\/vendor\/profile\/package\.json$/m.test(gitignore))

// ---------- 7) 跨模块导入/导出契约（静态，防低级致命错）----------
//
// 为什么值得单独查：重构把模块拆来拆去时，最容易出的是"import 了一个对方没导出的名字"——
// 这属于**加载期**错误（`SyntaxError: The requested module … does not provide an export named`），
// 表现是应用直接起不来、且报错指向 import 行而不是真正的改动处。逐行 grep 看不出来，
// 静态解析 export 名单却能在离线一秒查完（本轮拆出 platform-paths / vendor-baseline /
// vendor-home 三个模块，正是这条检查的用武之地）。
console.log('[导入/导出契约]')
/** 从源码里抽出 `export function|const|let|class NAME` 与 `export { a, b as c }` 的导出名。 */
function exportedNames(src) {
  const names = new Set()
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim()
      if (seg === '') continue
      const asMatch = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(seg)
      names.add(asMatch === null ? seg.split(/\s+/)[0] : asMatch[1])
    }
  }
  return names
}
/** 从源码里抽出本地模块的 `import { a, b as c } from './x.mjs'` 需求。 */
function localImports(src) {
  const out = []
  for (const m of src.matchAll(/import\s+(?:([A-Za-z_$][\w$]*)\s*,\s*)?(?:\{([^}]*)\})?\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const [, defaultName, namedBlock, spec] = m
    const wanted = []
    if (defaultName !== undefined && defaultName !== '') wanted.push('default')
    if (namedBlock !== undefined) {
      for (const part of namedBlock.split(',')) {
        const seg = part.trim()
        if (seg === '') continue
        const name = seg.split(/\s+as\s+/)[0].trim()
        if (name !== '') wanted.push(name)
      }
    }
    out.push({ spec, wanted, line: src.slice(0, m.index).split('\n').length })
  }
  return out
}

const MODULES = ['src/main.mjs', 'src/vendor-build.mjs', 'src/host.mjs', 'src/dsh-apply.mjs', 'src/repair.mjs',
  'src/admin.mjs', 'src/junction-safe.mjs', 'src/vendor-baseline.mjs', 'src/vendor-home.mjs',
  'src/platform-paths.mjs', 'src/dsh-update.mjs', 'src/early-errors.mjs', 'src/node-guard.mjs',
  'src/cross-tree-check.mjs']
const exportMap = new Map()
for (const rel of MODULES) exportMap.set(rel, exportedNames(read(rel)))

const contractProblems = []
for (const rel of MODULES) {
  const src = read(rel)
  for (const imp of localImports(src)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), imp.spec))
    if (!exportMap.has(target)) continue // 指向非列出的模块（例如仅副作用导入）：跳过
    const have = exportMap.get(target)
    for (const want of imp.wanted) {
      if (!have.has(want)) contractProblems.push(`${rel}:${imp.line} 从 ${target} 导入的 \`${want}\` 不存在`)
    }
  }
}
ok('所有本地 import 的名字都能在对方模块里找到', contractProblems.length === 0, contractProblems.slice(0, 6).join(' | ') || '无')
ok('契约检查本身有覆盖（至少解析出 8 个模块的导出）',
  [...exportMap.values()].filter((s) => s.size > 0).length >= 8,
  `有导出的模块数=${[...exportMap.values()].filter((s) => s.size > 0).length}`)

// main.mjs 里几个"平台化改造新引入"的符号必须真的来自它 import 的模块（防拼错/防漏 import）
// （`mainSrc` 在本节开头已读入，这里复用同一个字符串，别重复读盘）
for (const [sym, from] of [['appDataDir', 'src/platform-paths.mjs'], ['readVendorBaseline', 'src/vendor-baseline.mjs'],
  ['resolveVendorHome', 'src/vendor-home.mjs'], ['safeRemoveTree', 'src/junction-safe.mjs']]) {
  ok(`main.mjs 使用的 ${sym} 由 ${from} 导出`, exportMap.get(from).has(sym), `${sym} @ ${from}`)
}
ok('main.mjs 已无被重命名残留的旧常量', !/VENDOR_PROFILE|VENDOR_EXPECT_FILES/.test(mainSrc))
// 这些符号必须"在用之前有定义"（曾经因为读一个后声明的 const 而 TDZ 静默失效）
const declOrder = (src, decl, use) => src.indexOf(decl) !== -1 && src.indexOf(decl) < src.indexOf(use)
ok('VENDOR_DIR 的声明早于 prepareVendorHome（避免又一次 TDZ）',
  declOrder(mainSrc, 'let VENDOR_DIR =', 'function prepareVendorHome'))

// ---------- 8) main() 的启动顺序（一次误删就能让打包产物在新机器上起不来）----------
//
// 这几个顺序约束都有具体事故背景，而且**破坏了也不会立刻报错**（表现为某个模式悄悄不工作）：
//   · prepareVendorHome 在 preflight 之前 —— 冒烟模式跳过 preflight，放后面则种子永不落地；
//   · prepareVendorHome 在 CLI 分发之前 —— --doctor/--diag/--version 要基于实际使用的树给结论；
//   · applyPending 在 dshBin() 检查之前 —— 换树会把旧树改名走开，先解析 bin 会缓存到失效路径；
//   · SMOKE OK 在所有就位检查之后 —— 它是 CI 判定"这个包能用"的唯一依据。
console.log('[main() 启动顺序]')
const posOf = (needle) => mainSrc.indexOf(needle)
const order = [
  ['prepareVendorHome 调用', 'if (app.isPackaged) prepareVendorHome()'],
  ['CLI 分发（--version）', "if (args.includes('--version'))"],
  ['preflight', 'if (!SMOKE && !runPreflight())'],
  ['applyPending', 'const applied = applyPending({'],
  ['dshBin 检查', 'if (!dshBin()) {'],
  ['SMOKE OK', "log('SMOKE OK')"],
]
let lastPos = -1
let orderOk = true
const seen = []
for (const [name, needle] of order) {
  const p = posOf(needle)
  seen.push(`${name}@${p}`)
  if (p === -1 || p < lastPos) orderOk = false
  lastPos = p
}
ok('六个关键步骤按正确顺序出现且都存在', orderOk, seen.join(' → '))
ok('每个关键步骤只出现一次（防重复块）',
  order.every(([, needle]) => mainSrc.split(needle).length - 1 === 1),
  order.filter(([, needle]) => mainSrc.split(needle).length - 1 !== 1).map(([n]) => n).join(', ') || '无重复')
ok('CLI 五个子命令都还在（--version/--diag/--doctor/--set-ws/--autostart/--register）',
  ["--version", 'if (DIAG)', 'if (DOCTOR)', "'--set-ws'", "'--autostart'", "'--register'"].every((s) => mainSrc.includes(s)))

// ---------- 9) 托盘可用性（Linux 上"隐藏了窗口却找不回来"是最坏的一类体验缺陷）----------
//
// 背景：`new Tray()` 在 Linux 上可能"成功"却不可见（缺 libappindicator/
// ayatana、GNOME 未装 AppIndicator 扩展）。若 close-to-tray 的判据只看 `tray !== null`，
// 窗口会被隐藏且**用户没有任何恢复入口** —— 应用看起来死了。这条断言把这个语义钉住。
console.log('[托盘可用性]')
ok('托盘创建被 try/catch 包住（缺托盘服务时明确降级）',
  /try\s*\{[\s\S]{0,400}new Tray\(/.test(mainSrc))
ok('close-to-tray 用 trayUsable 判定，而不是 tray 非空',
  /minimizeToTray !== false && trayUsable/.test(mainSrc) && !/minimizeToTray !== false && tray\)/.test(mainSrc))
ok('图标为空也算托盘不可用（.ico 在 Linux/macOS 上常解不出图）',
  /isEmpty\(\)/.test(mainSrc) && /trayUsable = !icon\.isEmpty\(\)/.test(mainSrc))
ok('托盘可用性暴露给客户端（设置页可据此提示）', /^[ \t]*trayUsable,$/m.test(mainSrc))
ok('先起托盘再建窗口（否则关窗判据读到初始 false）',
  // 中间允许夹别的启动步骤（例如注册日志窗口快捷键），但顺序必须是托盘在前、建窗在后。
  /spawnTray\(\)[\s\S]{0,400}?await createWindow\(\)/.test(mainSrc),
  `spawnTray@${mainSrc.indexOf('spawnTray()')} createWindow@${mainSrc.indexOf('await createWindow()')}`)
// 【实测】装载窗口之前必须清掉旧的宿主认证 cookie。
// 背景（2026-09-17 实测）：每个宿主进程都新签一个 `dsh-auth-*`，而 **cookie 不区分端口** ——
// 宿主端口每次重启都换、cookie 却都堆在同一个 127.0.0.1 域名下，最终请求头超限 ⇒
// 宿主对**主文档**回 `431 Request Header Fields Too Large` ⇒ 渲染器只有一个空文档 ⇒ **整窗纯黑**。
// 两条断言：① 清理函数存在且只动回环域名；② 两条装载路径（冷启动建窗 / 手动重启宿主）都先清。
console.log('[黑窗口：认证 cookie 堆积]')
ok('存在认证 cookie 清理函数，且只针对 127.0.0.1 / localhost 的 dsh-auth cookie',
  /async function pruneAuthCookies\(\)/.test(mainSrc)
  && /dsh-auth/i.test(mainSrc)
  && /c\.domain === '127\.0\.0\.1' \|\| c\.domain === 'localhost'/.test(mainSrc))
ok('建窗装载前先清（token 换 cookie 会重签，所以清是安全的）',
  /await pruneAuthCookies\(\)\s*\n\s*win\.loadURL\(readyUrl\)/.test(mainSrc))
ok('手动重启宿主后重载窗口前也先清（否则重启越多次越容易 431）',
  /await pruneAuthCookies\(\); win\.loadURL\(readyUrl\)/.test(mainSrc))
ok('清理失败不阻断启动（catch 内只记日志、不抛）',
  /清理认证 cookie 失败（不影响启动）/.test(mainSrc))
// 2026-09-19 改判据：原来这里只要求"darwin 走 click"。Linux 上 `double-click` 事件
// **根本不存在**（Electron 文档标注 _macOS_ _Windows_），而旧代码把 click 排除在 darwin 之外
// ⇒ **Linux 用户点托盘完全没反应**，菜单里又没有"打开主窗口"，窗口一关到托盘就再也回不来。
// 新契约：click 覆盖除 win32 之外的所有平台（win32 保持双击习惯），且菜单第一项必须是打开主窗口
// （托盘菜单是 SNI 环境下**唯一保证按得到**的入口）。判据落在"覆盖到哪些平台"，不写死具体写法。
ok('单击唤回窗口覆盖 macOS 与 Linux（两者都不是双击语义）',
  /tray\.on\('click', \(\) => \{ if \(process\.platform !== 'win32'\) focusAction\(\) \}\)/.test(mainSrc))
ok('托盘菜单第一项是「打开主窗口」（SNI 下 click 未必发得出来，菜单是兜底入口）',
  /setContextMenu\(Menu\.buildFromTemplate\(\[\s*\n(?:\s*\/\/[^\n]*\n)+\s*\{ label: '打开主窗口'/.test(mainSrc))
ok('托盘/窗口图标按平台取（Linux/macOS 的 .png；.ico 在那两个平台解成空图）',
  /const TRAY_ICON_FILE = iconFilePath\(/.test(mainSrc)
  && /nativeImage\.createFromPath\(TRAY_ICON_FILE\)/.test(mainSrc))

// ---------- 10) 调用位置体检（补 smoke 才能抓的那类"加载期崩"，属**低误报子集**）----------
//
// 背景（2026-09-14 实跑 smoke 抓到的真错）：`main.mjs` 里写了 `pickProtocolUrl(argv)`，
// 而那个位置声明的变量叫 `args` ⇒ **模块加载期 `ReferenceError: argv is not defined`**，
// 应用直接起不来。所有离线单测都看不见它（它们不加载 `main.mjs`，那会拉起 electron）。
//
// **这条检查的定位**：细粒度、零误报的"未声明标识符"静态分析，靠正则做不出来
// （试过两版：解构默认值 `{ log = () => {} }`、对象方法简写、模板串里的 CSS 都会被误判，
// 而一条总在红的门禁等于没有门禁）。所以这里只做**低误报子集**：
//   · 只看**函数调用形态** `name(`；
//   · **跳过含解构/默认值赋值的行**（`= {`、`} =`、`({`），那是误报的主要来源；
//   · 白名单放行语言内建与已知全局。
// 它的价值是"把这类打错字提前到秒级"，**不是**替代 `smoke`：真正的加载期验证由 smoke 负责
// （它已经把这次的 `argv` 抓出来了）。**已知不覆盖**：解构行、属性简写、模板串内的代码。
console.log('[调用位置体检]')
/** 收集模块里所有能被引用的名字（声明 / import / 形参 / 解构 / catch）。 */
function declaredNames(src) {
  const names = new Set()
  const add = (n) => { if (n && /^[A-Za-z_$][\w$]*$/.test(n)) names.add(n) }
  for (const m of src.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) add(m[1])
  for (const m of src.matchAll(/import\s+([^'"]+?)\s+from\s+['"]/g)) {
    for (const part of m[1].replace(/[{}]/g, ' ').split(',')) add(part.trim().split(/\s+as\s+/).pop())
  }
  for (const m of src.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const part of m[1].split(',')) add(part.replace(/[:=].*/s, '').replace(/[{}\[\].]/g, '').trim())
  }
  for (const m of src.matchAll(/(?:catch|for)\s*\(([^)]*)\)/g)) {
    for (const part of m[1].split(/[;,]| of | in /)) add(part.replace(/[:=].*/s, '').replace(/[{}\[\].]/g, '').trim())
  }
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}/g)) for (const part of m[1].split(',')) add(part.split(':').pop().trim())
  for (const m of src.matchAll(/(?:const|let|var)\s*\[([^\]]*)\]/g)) for (const part of m[1].split(',')) add(part.trim())
  for (const m of src.matchAll(/(?:^|[^\w$.])(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1])
  return names
}
const GLOBALS = new Set(['process', 'console', 'require', 'module', 'exports', 'Buffer', 'setTimeout', 'setInterval',
  'clearTimeout', 'clearInterval', 'queueMicrotask', 'fetch', 'performance', 'globalThis', 'structuredClone',
  'String', 'Number', 'Boolean', 'Object', 'Array', 'Math', 'JSON', 'Date', 'Map', 'Set', 'Promise', 'Error',
  'RegExp', 'Symbol', 'WeakMap', 'WeakSet', 'Int32Array', 'Uint32Array', 'Uint8Array', 'Uint16Array', 'Float32Array',
  'BigInt', 'Atomics', 'SharedArrayBuffer', 'URL', 'URLSearchParams', 'AbortSignal', 'TextDecoder', 'TextEncoder',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'super', 'this',
  // 页面/DOM 与浏览器全局（注入到渲染进程的代码里会出现）
  'gradient', 'getComputedStyle', 'window', 'document', 'requestAnimationFrame'])
// **解构形参白名单**：本项目约定俗成的解构选项名（`{ log = () => {} }`、`{ onDiagnostic = … }` 等）。
// 正则在 JS 里区分不了"解构默认值"与"函数调用"，与其把分析写得又长又脆，不如显式列出这十几个名字 ——
// 清晰、可审、且新增时一眼能看出该不该加（**只放形参名，绝不放"可能是函数"的猜测**）。
const DESTRUCTURED_PARAMS = new Set(['log', 'onDiagnostic', 'onProgress', 'target', 'coeffsOf', 'predOf', 'opts', 'o',
  'env', 'exists', 'write', 'read', 'io', 'meta', 'settings', 'logFile', 'filter', 'map', 'reduce', 'callback',
  'verifyPackages', 'abiGate', 'installFn', 'bootGate', 'npmCli', 'runtime', 'packagesDir', 'cacheDir'])
/** 只挑"调用位置"的标识符：`name(`，排除属性访问、声明、控制关键字与**解构默认值**。 */
function calledIdentifiers(src) {
  const found = new Set()
  const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'new', 'function',
    'do', 'else', 'case', 'delete', 'void', 'in', 'of', 'instanceof', 'yield', 'throw', 'async', 'var', 'let'])
  // 注释块状态：`/** … */` 的**中间行以 `*` 开头**（旧判据能认），但纯文字续行（没有 `*`）认不出来——
  // 于是"注释里写了 `musl(` 这种例子"会被当成真的调用（2026-09-14 实测踩到）。
  // 用状态机跟踪块注释，比逐行正则可靠。
  let inBlockComment = false
  for (const raw of src.split('\n')) {
    if (inBlockComment) { if (raw.includes('*/')) inBlockComment = false; continue }
    if (/^\s*\/\*/.test(raw)) { if (!raw.includes('*/')) inBlockComment = true; continue }
    if (/^\s*(\/\/|\*)/.test(raw)) continue
    // 跳过解构/默认值行：误报的主要来源，收益远小于噪声
    if (/=\s*\{|}\s*=|\(\{/.test(raw)) continue
    // 跳过**含正则字面量的行**：正则里的 `^musl(_|...` 这种片段会被"标识符紧跟左括号"的形态误判成调用
    // （2026-09-14 实测：`/^musl(_|-|$)/` 报成 `musl(`）。正则与调用在文本上不可区分，
    // 而"函数调用里内嵌正则字面量"在本项目里不存在（真要有，别的断言会先红），所以整行跳过是划算的。
    if (/=\s*\/[^/*]/.test(raw) || /\.(test|match|replace|matchAll|split|exec)\s*\(\s*\//.test(raw)) continue
    const line = raw.replace(/`[^`]*`/g, '``').replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""').replace(/\/\/.*$/, '')
    for (const m of line.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[2]
      if (CONTROL.has(name)) continue
      found.add(name)
    }
  }
  return found
}
const suspectFiles = ['src/main.mjs', 'src/host.mjs', 'src/vendor-build.mjs', 'src/dsh-apply.mjs',
  'src/junction-safe.mjs', 'src/vendor-home.mjs', 'src/vendor-baseline.mjs', 'src/platform-paths.mjs']
const suspects = []
for (const rel of suspectFiles) {
  const src = read(rel)
  const declared = declaredNames(src)
  for (const name of calledIdentifiers(src)) {
    if (declared.has(name) || GLOBALS.has(name) || DESTRUCTURED_PARAMS.has(name)) continue
    suspects.push(`${rel}: ${name}(`)
  }
}
ok('没有"被调用但从未声明"的标识符（防 argv/args 这类加载期崩溃）',
  suspects.length === 0, suspects.slice(0, 8).join(' | ') || '无')
ok('体检本身有覆盖（至少解析出 100 个声明名）',
  declaredNames(read('src/main.mjs')).size > 100, `main.mjs 声明名=${declaredNames(read('src/main.mjs')).size}`)
// 具体钉住本轮踩的那个：深链解析必须用 `args`（写成 argv 会在加载期崩）。
// 注意别写成"文件里不许出现 pickProtocolUrl(argv)"——函数定义本身就是 `function pickProtocolUrl(argv)`，
// 那样会得到一条永远红的断言（第一版就是这么错的）。
ok('冷启动深链解析用的是 `args`',
  /pickProtocolUrl\(args\)/.test(read('src/main.mjs')))

// ---------- 11) 交叉构建的"门禁延后"契约（不许静默跳过、不许写假绿）----------
//
// 背景：在 A 平台产 B 平台的 vendor 树时，ABI 门禁与启动门禁**必然**判 FAIL，
// 且失败与树无关（要把目标平台的 .node 加载进宿主进程、要起目标平台的宿主）。于是交叉构建把两道
// 门禁延后到目标平台（CI 的 runner 上补跑）。这类"降级"最危险的退化有两种，离线都能钉住：
//   ① 悄悄**跳过**却不留痕 —— 事后没人知道这棵树没验过；
//   ② lock 里照写 `abiScan: 'PASS'` —— 假绿比不写更坏。
console.log('[交叉构建门禁延后]')
const buildHostSrc = read('scripts/build-host.mjs')
ok('交叉构建才延后门禁（本机构建不得延后）',
  /const CROSS = platformTag\(TARGET\) !== platformTag\(currentTarget\(\)\)/.test(buildHostSrc)
  && /\.\.\.\(CROSS \? \{ skipAbiGate: true, bootGate: null \} : \{\}\)/.test(buildHostSrc))
ok('延后有显式日志（不静默降级）', /交叉构建：ABI 门禁 \/ 启动门禁延后到目标平台/.test(buildHostSrc))
ok('交叉构建不得顶替现网 vendor/（--out 才允许写别处）',
  /argOf\('--out', path\.join\(ROOT, 'vendor'\)\)/.test(buildHostSrc))
ok('vendor/staging 清理只在写现网目录时执行',
  /path\.resolve\(OUT_DIR\) === path\.resolve\(LIVE_VENDOR\)/.test(buildHostSrc))
// `vendor/` 里只该有 `profile/` 与 `vendor.lock.json`：electron-builder 的 extraResources 是
// `from: vendor` 整目录拷贝，多一个空目录也会被打进安装包（prune-only 实测留过 `.staging-build`）。
ok('--prune-only 也清掉暂存目录（否则它会留在 vendor/ 里被打进包）',
  /if \(fs\.existsSync\(STAGE_ROOT\)\) safeRemoveTree\(STAGE_ROOT\)[\s\S]{0,200}const built = await buildVendorTree\(/.test(buildHostSrc))
const vbSrc = read('src/vendor-build.mjs')
ok('ABI 门禁延后由 buildVendorTree 记录为 gatesDeferred',
  /const gatesDeferred = \{ abi: skipAbiGate === true, boot: bootGate === null \}/.test(vbSrc))
ok('门禁延后时 abiScan 明确写 DEFERRED（不得写 PASS）',
  /abiScan: built\.gatesDeferred\?\.abi === true \? 'DEFERRED/.test(vbSrc))
ok('lock 记录 gatesDeferred 段（事后可判"验过没有"）', /gatesDeferred: built\.gatesDeferred \?\?/.test(vbSrc))
ok('build-host 与 CI 共用同一份 lock 写入实现（不许两份手写字段集）',
  !/abiScan: 'PASS'/.test(buildHostSrc) && /buildStaging\(/.test(buildHostSrc))
// 双架构构建器也要用同一份 lock 实现，并且**合并后重算统计**——
// 拿合并前的 `built.stats` 会写出"少算了整个另一架构"的体积与文件数（实测踩过）。
const macUniSrc = read('scripts/build-mac-universal.mjs')
ok('双架构构建器共用 buildVendorLock', /buildVendorLock\(/.test(macUniSrc) && !/abiScan:/.test(macUniSrc))
ok('双架构 lock 的统计在合并之后重算',
  /vendorStats\(main\.profileDir\)/.test(macUniSrc))
ok('双架构构建器在合并后复验两个架构的必需包',
  /for \(const t of \[target, donorTarget\]\)/.test(macUniSrc) && /verifyTargetPackages\(main\.profileDir, t\)/.test(macUniSrc))
ok('两个构建器共用同一份 DSH 版本常量（不许各写一份）',
  /from '\.\.\/src\/dsh-versions\.mjs'/.test(buildHostSrc) && /from '\.\.\/src\/dsh-versions\.mjs'/.test(macUniSrc)
  && !/'@deepseek-ai\/dsh': '/.test(buildHostSrc) && !/'@deepseek-ai\/dsh': '/.test(macUniSrc))

// ---------- 12) README 的数字不许烂掉 ----------
//
// 2026-09-14 实测：README 里的"14 套离线自检"和整张断言表全是陈旧数字（实际 15 套、
// vendor-build 那行写 81 实际已 102）。文档里的数字是别人判断"该不该信这份 README"的依据，
// 烂掉之后没人会发现——所以这里把**能从磁盘算出来的**部分钉住，只钉能算的（别写死期望值）。
console.log('[README 数字]')
const readme = read('README.md')
const diskSuites = listed.length
ok('README 声明的套件数与脚本清单一致',
  new RegExp(`${diskSuites} 套离线自检`).test(readme) || new RegExp(`${diskSuites} 套自检`).test(readme),
  `磁盘 ${diskSuites} 套；README 写的是 ${(readme.match(/(\d+) 套(?:离线)?自检/) ?? [])[0] ?? '（没提）'}`)
const listedRows = [...readme.matchAll(/^\|\s*`((?:scripts|packages)\/[^`]+)`\s*\|\s*\*{0,2}(\d+)\*{0,2}\s*\|/gm)]
  .map((m) => [m[1], Number(m[2])])
ok('README 的套件表覆盖了清单里的每一套',
  listed.includes('scripts/vendor-build-self-test.mjs') && listedRows.length >= 10,
  `表里 ${listedRows.length} 行`)
const readmeMissing = listed.filter((rel) => !listedRows.some(([r]) => r === rel))
ok('清单里的套件在 README 表里都有行', readmeMissing.length === 0, readmeMissing.join(', ') || '无')

// ---------- 13) 打包前的 vendor 平台核对（实测踩过的"能打包、装不上"陷阱）----------
//
// 背景（2026-09-14 实测）：在 Windows 上产 Linux 包时忘了把 vendor 换成 linux 树，
// electron-builder **照样"打包成功"**——`extraResources` 是 `from: vendor` 的整目录照拷，
// 它不看里面装的是哪个平台的二进制。产物 resources/vendor 里全是 win32-x64 的 koffi / node-pty，
// 在 Linux 上**装上也起不来**。打包日志里没有任何异常迹象。
// 这条只能在**打包前**挡：事后发现要靠拆开产物看 lock。
console.log('[打包前 vendor 平台核对]')
const checkAssetsSrc = read('scripts/check-assets.mjs')
ok('check-assets 会核对 vendor 平台与打包目标',
  /vendor 树的平台必须与打包目标一致/.test(checkAssetsSrc) && /DSH_PACK_PLATFORM/.test(checkAssetsSrc))
ok('平台不符时报错而不是只提示（必须挡住打包）',
  /problems\.push\(`vendor 树是给/.test(checkAssetsSrc))
ok('三个平台的打包入口都挂了 predist 前置检查',
  ['predist', 'predist:linux', 'predist:mac'].every((k) => typeof pkg.scripts[k] === 'string'))

// ---------- 14) 入库的 shell 脚本必须是 LF 行尾 ----------
//
// 这条是**用血换来的**：`.sh` 在 Windows 上写出来是 CRLF，`sh -n`（语法检查）会放行，
// 但真跑起来每条命令都带着尾随的 `\r` —— 命令找不到、参数变形；而外面通常还套着
// `> log 2>&1`，错误就全被吞掉，表现成"脚本卡住、零输出"。2026-09-14 为此白折腾了好几轮，
// 一度还怀疑是 WSL 坏了。这类问题机器一秒能查完，人眼在编辑器里看不出来。
console.log('[shell 脚本行尾]')
function walkSh(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walkSh(rel, out) }
    else if (e.name.endsWith('.sh')) out.push(rel)
  }
  return out
}
const shFiles = walkSh(path.join(ROOT, 'scripts'))
const crlf = []
const bom = []
for (const rel of shFiles) {
  const buf = fs.readFileSync(rel)
  if (buf.includes(Buffer.from('\r\n'))) crlf.push(path.relative(ROOT, rel).split(path.sep).join('/'))
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) bom.push(path.relative(ROOT, rel).split(path.sep).join('/'))
}
ok('scripts/ 下的 .sh 都是 LF 行尾（CRLF 会让 sh 静默全错）', crlf.length === 0,
  crlf.join(', ') || `检查了 ${shFiles.length} 个`)
ok('scripts/ 下的 .sh 没有 UTF-8 BOM（BOM 会被当成命令）', bom.length === 0, bom.join(', ') || '无')
ok('Linux 打包/冒烟脚本都在（本机唯一能出 AppImage/deb 的路径）',
  ['install-deps.sh', 'prepare-build-tree.sh', 'build-installers.sh', 'packaged-smoke.sh', 'verify-installers.sh']
    .every((f) => fs.existsSync(path.join(ROOT, 'scripts', 'linux', f))),
  shFiles.map((f) => path.basename(f)).sort().join(', '))
// AppImage 的**直跑路径**（FUSE 挂载）与 extract 路径是两回事：用户双击走前者。
// 脚本要把"走的是哪条路"打出来——否则容易拿解包的日志去充当"挂载成功"的证据（实测踩到过：
// 两条路共用一个日志文件名，后一次覆盖前一次）。
ok('有 AppImage 直跑（FUSE）验证脚本', fs.existsSync(path.join(ROOT, 'scripts', 'linux', 'appimage-direct-run.sh')))
ok('直跑脚本会区分并打印"挂载 vs 解包"的路径证据',
  /tmp\\?\/\\?\.mount/.test(read('scripts/linux/appimage-direct-run.sh'))
  && /appimage_extracted/.test(read('scripts/linux/appimage-direct-run.sh')))
ok('Linux 打包脚本里跑了打包前置检查（含 vendor 平台核对）',
  /check-assets\.mjs/.test(read('scripts/linux/build-installers.sh')))
ok('Linux 冒烟脚本的判据与 Windows 同源（按 PASS 计数，不靠退出码）',
  /SMOKE OK/.test(read('scripts/linux/packaged-smoke.sh')) && /no-sandbox/.test(read('scripts/linux/packaged-smoke.sh')))
ok('有"装一遍再跑"的 Linux 验证脚本（不只核验文件格式）',
  fs.existsSync(path.join(ROOT, 'scripts', 'linux', 'verify-installers.sh')))
// macOS 产物的**硬边界**（2026-09-15 实测）：electron-builder 在代码里直接拒绝非 macOS 主机做 mac 构建
//（`Build for macOS is supported only on macOS`），所以本机**不可能**产出 dmg/zip —— 这不是"缺个工具链"，
// 而是打包器本身不支持。有断言记着，免得以后又有人花时间去试（我试过了）。
ok('CI 的 macOS job 在 macos runner 上（这是 mac 产物唯一的出路）',
  /macos:[\s\S]{0,400}?runs-on:\s*macos-/.test(ci))

// ---------- 15) 跨平台内容一致性：版本锁 + 包内容比对 ----------
//
// 背景（2026-09-15 实测）：manifest 只钉死三个 DSH 包的**精确**版本，**传递依赖是范围声明**
// （`zod: ^4.4.3`、`node-addon-require-builtin: ^0.1.4`、`@types/node` 由 `protobufjs` 的 `>=13.7.0` 拉进来），
// 于是**同一个 DSH 版本在不同日期装出两棵内容不同的树** —— 实测 Windows 树与 Linux 树有 5 个同名包版本不同
// （zod / node-addon-require-builtin / @types/node / undici-types / node-addon-native-custom-loader），
// 后来两边分别重建又变成 6 处（连 koffi 3.2.1 vs 3.3.0 这种核心原生依赖都在漂）。
// 结论：**"功能与 Windows 包一致"必须有机器判据**，否则它只是一句口号。
// 修法：仓库里放一份平台中立的 `vendor/package-lock.json`，三平台都用它装（用 `npm install` 消费，
// 不用 `npm ci` —— 锁是从某一个平台生成的，其 optionalDependencies 带着平台专属包，`npm ci` 在别的平台必红）。
console.log('[跨平台内容一致性]')
const VENDOR_LOCKFILE = path.join(ROOT, 'vendor', 'package-lock.json')
ok('仓库里有版本锁 vendor/package-lock.json（钉死传递依赖）', fs.existsSync(VENDOR_LOCKFILE))
if (fs.existsSync(VENDOR_LOCKFILE)) {
  let lockOk = false
  let entries = 0
  try {
    const lock = JSON.parse(fs.readFileSync(VENDOR_LOCKFILE, 'utf8'))
    entries = Object.keys(lock.packages ?? {}).length
    lockOk = lock.lockfileVersion === 3 && entries > 100
  } catch { /* 解析失败即判失败 */ }
  ok('锁是 lockfileVersion 3 且条目充足', lockOk, `${entries} 条`)
  // 锁必须覆盖 manifest 钉死的三个 DSH 包（否则它跟 manifest 不是一套）
  const lockText = fs.readFileSync(VENDOR_LOCKFILE, 'utf8')
  ok('锁覆盖三个 DSH 包', ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
    .every((n) => lockText.includes(`node_modules/${n}"`)))
}
ok('build-host 把 lockDir 显式传给构建（暂存布局下推不出 OUT_DIR）',
  /lockDir:\s*OUT_DIR/.test(read('scripts/build-host.mjs')))
ok('findVendorLockfile 考虑了暂存布局（不能只靠 dirname 上一级）',
  /path\.dirname\(path\.dirname\(profileDir\)\)/.test(read('src/vendor-build.mjs')))
ok('有跨平台包内容比对脚本', fs.existsSync(path.join(ROOT, 'scripts', 'compare-packaged-vendor.mjs')))

// ---------- 16) 打包产物里的代码必须能解析（2026-09-16 事故的直接门禁）----------
//
// 背景：改 `vendor-build.mjs` 时写坏一处语法，离线门禁当场抓到并修好了，但那一瞬间恰好有一次打包在跑
// ⇒ 产出的安装包**双击即崩**：`SyntaxError: Unexpected identifier 'lockDir'`（`main.mjs` 在模块加载期
// 就 import 了它）。**所有原有门禁查的都是仓库 `src/`，而用户加载的是 asar 里那一份**——两者之间隔着
// 一个"打包时刻"。所以这道门禁必须挂在**打包器**上（`afterPack`），加进离线套件是没用的（离线时还没产物）。
console.log('[打包产物 asar 可解析性]')
const asarGateSrc = read('scripts/check-packaged-asar.mjs')
ok('有打包产物 asar 检查脚本', fs.existsSync(path.join(ROOT, 'scripts', 'check-packaged-asar.mjs')))
ok('它挂在 electron-builder 的 afterPack 上（产物一出来就查它自己）',
  /^afterPack:\s*scripts\/check-packaged-asar\.mjs\s*$/m.test(read('electron-builder.yml')),
  (read('electron-builder.yml').match(/^afterPack:.*$/m) ?? ['(没有 afterPack)'])[0])
ok('脚本有 default 导出（afterPack 钩子的形态要求）', /export default async function afterPack/.test(asarGateSrc))
ok('钩子拿到 appOutDir 后**拒绝产出**而不是只打印', /throw new Error\(`打包产物里有无法解析的源码/.test(asarGateSrc))
// "判据空转成假绿"是本脚本自己踩过的坑（没 import spawnSync ⇒ 全部记成环境问题 ⇒ 报 ALL PASS，
// 恰好放过了本来要拦的坏包）。这条断言钉住那道底线。
ok('防止判据空转（一个都没真检查时必须判失败）', /至少真正检查过一个文件/.test(asarGateSrc))
ok('把"起不来"与"代码语法错"分开报（避免假红）', /无法执行语法检查/.test(asarGateSrc))
ok('三个打包 job 都显式跑了这道检查（钩子之外的兜底）',
  (ci.match(/check-packaged-asar\.mjs/g) ?? []).length >= 3,
  `CI 里出现 ${(ci.match(/check-packaged-asar\.mjs/g) ?? []).length} 次`)

console.log(fail === 0 ? '\nCI SELF TEST: ALL PASS' : `\nCI SELF TEST: ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
