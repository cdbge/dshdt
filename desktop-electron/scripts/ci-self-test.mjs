// ci-self-test.mjs — CI 配置与门禁清单的自查（纯 Node、脱网），只用文本/结构判据，不解析 YAML。
// 查三件事：① release.yml 的平台/门禁/产物 glob；② test-suite.mjs 清单与磁盘套件一一对应；
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
let fail = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!cond) fail++ }
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

console.log('[release.yml]')
const ci = read('../.github/workflows/release.yml')
// 平台矩阵只有 windows / linux 两端：多一个 runner 就是"又偷偷加回了别的平台"的信号。
// 按 workflow 里的 matrix.os 实测，不看注释。
const matrixOs = [...ci.matchAll(/os:\s*\[([^\]]*)\]/g)].flatMap((m) => m[1].split(',').map((s) => s.trim())).filter(Boolean)
const runnerLines = ci.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('runs-on:'))
ok('平台矩阵只有两端（windows-latest / ubuntu-latest）',
  matrixOs.length === 2 && matrixOs.includes('windows-latest') && matrixOs.includes('ubuntu-latest'),
  `matrix=${matrixOs.join(' / ') || '（没解析到）'}；runs-on 共 ${runnerLines.length} 条`)
ok('触发方式含 tag 与手动（tag 走发布、手动用于验证）',
  /push:\s*\n\s*tags:\s*\['v\*'\]/.test(ci) && ci.includes('workflow_dispatch'))
ok('离线自检作为独立 job 在两平台各跑一遍',
  /self-test:/.test(ci) && /node scripts\/test-suite\.mjs/.test(ci) && /matrix:/.test(ci))
ok('每个打包 job 都依赖自检（needs: self-test）',
  (ci.match(/needs:\s*self-test/g) ?? []).length >= 2,
  `needs 计数=${(ci.match(/needs:\s*self-test/g) ?? []).length}`)
ok('Linux 打包 AppImage 与 deb', /--linux AppImage deb/.test(ci))
ok('两个打包 job 都用单平台 build-host（本机构建，不拼第二架构）',
  (ci.match(/node scripts\/build-host\.mjs/g) ?? []).length === 2,
  `build-host 调用数=${(ci.match(/node scripts\/build-host\.mjs/g) ?? []).length}`)
ok('Windows 仍打 NSIS', /--win nsis/.test(ci))
ok('两个打包 job 都跑 vendor 树静态体检（原生平台的补充证据）',
  (ci.match(/verify-cross-tree\.mjs --dir vendor/g) ?? []).length >= 2,
  `计数=${(ci.match(/verify-cross-tree\.mjs --dir vendor/g) ?? []).length}`)
ok('Linux 冒烟有显示环境（xvfb-run）', /xvfb-run -a/.test(ci))
ok('自检失败时把 FAIL 行打成公开可读的注解（日志要 admin 才能下载）',
  /::error::/.test(ci) && /PIPESTATUS/.test(ci) && /tee\s+"\$RUNNER_TEMP\/suite\.log"/.test(ci))
ok('Linux 装了 deb 打包依赖与沙箱依赖',
  ci.includes('libarchive-tools') && ci.includes('fakeroot') && ci.includes('rpm') && ci.includes('libfuse2'))
ok('两个打包 job 都在打包前生成图标（ico + png + icons，纯 Node）',
  (ci.match(/gen-icon\.mjs/g) ?? []).length >= 2,
  `gen-icon 调用数=${(ci.match(/gen-icon\.mjs/g) ?? []).length}`)
const genIconSrc = read('scripts/gen-icon.mjs')
ok('图标生成不调外部命令（纯 Node 拼容器，不依赖平台专有工具）',
  !/(execFileSync|execSync|spawnSync|spawn)\s*\(/.test(genIconSrc)
  && /icon\.ico/.test(genIconSrc) && /icon\.png/.test(genIconSrc),
  /(execFileSync|execSync|spawnSync|spawn)\s*\(/.test(genIconSrc) ? '仍在调用外部命令' : '纯 Node')
ok('打包态 smoke 的判据不依赖退出码（按 PASS 计数或 SMOKE OK）',
  (ci.match(/PASS/g) ?? []).length >= 3 && !/if \(\$LASTEXITCODE -ne 0\) \{ throw "packaged smoke exit/.test(ci),
  '包装态 smoke 判据')
ok('产物上传覆盖两平台扩展名（exe/AppImage/deb）',
  ['.exe', '.AppImage', '.deb'].every((ext) => ci.includes(ext)))
ok('签名 Secrets 接进 CI（Windows 代码签名；未配置则出未签名包）',
  ci.includes('WINDOWS_CERT_PFX') && ci.includes('WINDOWS_CERT_PASSWORD'))

console.log('[scripts/test-suite.mjs]')
const suite = read('scripts/test-suite.mjs')
const listed = [...suite.matchAll(/^\s*'((?:scripts|packages)\/[^']+)',\s*$/gm)].map((m) => m[1])
ok('清单非空', listed.length >= 10, `列出 ${listed.length} 个`)
const missing = listed.filter((rel) => !fs.existsSync(path.join(ROOT, rel)))
ok('清单里的每个套件都真实存在', missing.length === 0, missing.join(', '))
ok('vendor 平台化自检在清单里', listed.includes('scripts/vendor-build-self-test.mjs'))
ok('两套平台自检在清单里',
  listed.includes('scripts/platform-self-test.mjs') && listed.includes('scripts/host-platform-self-test.mjs'))

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

console.log('[package.json]')
const pkg = JSON.parse(read('package.json'))
ok('两个平台的打包入口都在',
  pkg.scripts['dist'] !== undefined && pkg.scripts['dist:linux'] !== undefined)
ok('有统一跑自检的入口 test:suite', typeof pkg.scripts['test:suite'] === 'string')
ok('license 字段存在（deb 打包必需）', typeof pkg.license === 'string' && pkg.license !== '')
ok('build:host 只调脚本、不带写死的平台参数（平台由 --os/--cpu 决定）',
  pkg.scripts['build:host'] === 'node scripts/build-host.mjs', pkg.scripts['build:host'])

console.log('[electron-builder.yml]')
const eb = read('electron-builder.yml')
ok('linux 图标指向 png 目录（.ico 会被 electron-builder 拒）', /icon:\s*build\/icons/.test(eb))
ok('windows 图标指向 ico', /icon:\s*build\/icon\.ico/.test(eb))
ok('extraResources 带上 png（Linux 托盘与窗口要用）', /build\/icon\.png/.test(eb))
ok('声明了 dsh:// 深链（Linux 靠它注册）', /protocols:/.test(eb) && /schemes:/.test(eb))
ok('deb 建议安装 bubblewrap（DSH 的 Linux 沙箱后端）', /bubblewrap/.test(eb))
ok('两平台各自声明了 artifactName（否则退化成含空格的默认产物名）',
  (eb.match(/artifactName:\s*DSHDesktop-/g) ?? []).length >= 2,
  `声明数=${(eb.match(/artifactName:\s*DSHDesktop-/g) ?? []).length}`)
ok('两平台 artifactName 的后缀能区分产物（Setup / arch ext 两套口径都在）',
  /DSHDesktop-Setup-\$\{version\}\.\$\{ext\}/.test(eb) && (eb.match(/DSHDesktop-\$\{version\}-\$\{arch\}\.\$\{ext\}/g) ?? []).length >= 1)

console.log('[删除入口一致性]')
const SRC_FILES = ['src/main.mjs', 'src/vendor-build.mjs', 'src/dsh-apply.mjs', 'src/host.mjs', 'src/repair.mjs', 'src/admin.mjs']
const offenders = []
for (const rel of SRC_FILES) {
  const text = read(rel)
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

console.log('[D8/D9 落地痕迹]')
const mainSrc = read('src/main.mjs')
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
ok('D9：second-instance 接了（两平台的深链都靠第二个实例把 URL 送进来）',
  /on\('second-instance'/.test(mainSrc))
ok('D9：冷启动 argv 里的 dsh:// 也被消费', /COLD_START_URL/.test(mainSrc) && /pickProtocolUrl/.test(mainSrc))
ok('D9：诊断类命令不抢锁（否则跑在应用里时 --doctor/--diag 直接失效）',
  /SINGLE_INSTANCE = [^\n]*DOCTOR[^\n]*DIAG/.test(mainSrc))
ok('单实例：第二个实例必须把窗口抬到前台（restore 最小化 / show 托盘）',
  /function surfaceWindow\(/.test(mainSrc) && /win\.isMinimized\(\)\)\s*win\.restore\(\)/.test(mainSrc)
  && /!\s*win\.isVisible\(\)\)\s*win\.show\(\)/.test(mainSrc))
ok('单实例：走的是"置顶再取消"的 Windows 前台锁绕行（普通 focus() 会被系统静默忽略）',
  /setAlwaysOnTop\(true\)/.test(mainSrc) && /setAlwaysOnTop\(false\)/.test(mainSrc)
  && /app\.focus\(\{\s*steal:\s*true\s*\}\)/.test(mainSrc))
ok('单实例：second-instance 分支留痕（日志是打包态唯一能区分"没触发"与"置前失败"的线索）',
  /on\('second-instance'[\s\S]{0,900}?log\(/.test(mainSrc))
ok('单实例：重复启动有"文件信号"兜底通道（不依赖 second-instance 事件是否送达）',
  /RESTORE_REQUEST_FILE\s*=/.test(mainSrc)
  && /writeFileSync\(RESTORE_REQUEST_FILE/.test(mainSrc)
  && /statSync\(RESTORE_REQUEST_FILE\)/.test(mainSrc)
  && /setInterval\(/.test(mainSrc))
ok('单实例：兜底轮询定时器在退出时被回收（不留悬挂定时器）',
  /clearInterval\(restoresWatchTimer\)/.test(mainSrc))
ok('日志目录在模块顶层就建好（否则单实例段的第一句日志会被静默丢掉）',
  /mkdirSync\(LOG_DIR, \{ recursive: true \}\)/.test(mainSrc.slice(0, mainSrc.indexOf('requestSingleInstanceLock'))),
  '判据：建目录要出现在 requestSingleInstanceLock 之前')
const vendorHome = read('src/vendor-home.mjs')
ok('D8：种子迁移"全或全无"（先写 .seeding 再 rename）',
  /\.seeding/.test(vendorHome) && /renameSync\(staging, dir\)/.test(vendorHome))
ok('D8：种子不覆盖已有目标（否则会把用户换过的树回退）',
  /already-present/.test(vendorHome))

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
// 市场包的 names 表只放随包自带：syncProfilePlugin 是"整目录删除 + 重拷"，
// 第三方包写进去 = 每次启动都用包内副本覆盖用户装的东西。这条注释就是守卫的判据（注释即契约，勿删）。
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
  const marketClient = read('packages/dsh-market/lib/client.js')
  ok('市场入口挂在官方底部插槽 sidebar.footer.action 上',
    /slots\.inject\(\s*["']sidebar\.footer\.action["']/.test(marketClient)
    && /name:\s*["']sidebar\.footer\.action["']/.test(marketClient))
  ok('市场弹窗有对话框语义且只用 DSH 设计令牌（不锁"必须用官方 Modal"，锁用户体验）',
    /role:\s*["']dialog["']/.test(marketClient)
    && /"aria-modal":\s*["']true["']/.test(marketClient)
    && /--dsw-alias-/.test(marketClient) && /--dsw-elevation-/.test(marketClient))
  ok('市场不注册同名 contribution 之外的命令（避免整组「指令」消失那类事故）',
    !/commandUi\.register/.test(marketClient))
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
{
  const body = (mainSrc.match(/async function marketOpenDownload[\s\S]*?\n}/) ?? [''])[0]
  ok('下载 = 把 https 地址交给系统（shell.openExternal + 非 https 拒绝）',
    /async function marketOpenDownload/.test(mainSrc) && /shell\.openExternal\(url\)/.test(mainSrc)
    && /拒绝打开非 https 地址/.test(mainSrc))
  ok('下载那条路**不落盘**（下载只把地址交出去，落盘只发生在安装那条路）',
    body !== '' && !/fs\.(write|mkdir|rm|unlink|rename|cp|appendFile)/.test(body),
    body === '' ? '取不到 marketOpenDownload 函数体（判据失效，当失败）' : `bodyLen=${body.length}`)
}
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
  // pnpm 体检用到了 npmCandidates（来自 vendor-build），漏导入会在运行到体检时 ReferenceError。
  // 既有的"未声明标识符"检查会跳过含 `({` 的行，而调用处正好是 `pnpmCandidates({ npmCandidates: npmCandidates(), ... })`，
  // 所以这里单钉一条：凡是 main.mjs 调用了 npmCandidates，就必须从 vendor-build 导入它。
  ok('npmCandidates 确实从 vendor-build 导入（漏了会在市场体检时 ReferenceError）',
    !/\bnpmCandidates\s*\(/.test(mainSrc) || /import[^\n]*\bnpmCandidates\b[^\n]*from\s*'\.\/vendor-build\.mjs'/.test(mainSrc))
}
ok('市场目录随包分发（electron-builder extraResources 里有 market-catalog.json）',
  /market-catalog\.json/.test(read('electron-builder.yml')))

console.log('[热更新通道]')
const builderCfg = read('electron-builder.yml')
ok('打包配置配了 GitHub 发布源（否则不产 app-update.yml / latest*.yml）',
  /^publish:\s*$/m.test(builderCfg) && /provider:\s*github/.test(builderCfg)
  && /owner:\s*\S+/.test(builderCfg) && /repo:\s*\S+/.test(builderCfg))
ok('本地打包一律 --publish never（配了 provider 之后，本地误发是很容易犯的错）',
  ['dist', 'dist:linux', 'dist:current'].every((k) => String(pkg.scripts[k] ?? '').includes('--publish never')),
  JSON.stringify(pkg.scripts.dist))
ok('CI 有写权限（建 Release 需要 contents: write）', /permissions:\s*\n\s*contents:\s*write/.test(ci))
ok('两个打包 job 与 release job 都认 latest*.yml（热更新元数据）',
  (ci.match(/dist\/latest\*\.yml/g) ?? []).length >= 3,
  `计数=${(ci.match(/dist\/latest\*\.yml/g) ?? []).length}`)
ok('有独立的 release job：等 Windows 与 Linux 产完再建 Release（避免并发抢同一 tag 的 Release）',
  /^  release:\s*$/m.test(ci) && /needs:\s*\[windows, linux\]/.test(ci))
ok('release job 只在 tag 推送时跑（手动 dispatch 不动线上发布）',
  /if:\s*startsWith\(github\.ref, 'refs\/tags\/v'\)/.test(ci))
const ebCmdLines = ci.split('\n').filter((l) => l.includes('npx electron-builder'))
ok('CI 的两个打包命令都 --publish never（配了 provider 之后，tag 构建会各自尝试发布 ⇒ 两个 job 抢同一个 Release）',
  ebCmdLines.length === 2 && ebCmdLines.every((l) => l.includes('--publish never')),
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

console.log('[干净 checkout 可跑性]')
const trayTestSrc = read('scripts/tray-icon-self-test.mjs')
ok('托盘图标套件不裸读生成物（build/icon.png 存在才验真实字节，否则验生成器契约）',
  /existsSync\(pngPath\)/.test(trayTestSrc) && /gen-icon\.mjs/.test(trayTestSrc))
const assetsTestSrc = read('scripts/check-assets-self-test.mjs')
ok('check-assets 套件自带生成物夹具，且收尾只删自己建的（干净 clone 里也成立）',
  /function ensureGeneratedAssets\(\)/.test(assetsTestSrc) && /fs\.rmSync\(path\.join\(ROOT, 'build', rel\)/.test(assetsTestSrc))
const gitignore = read('../.gitignore')
ok('vendor/profile/package.json 已从 .gitignore 反选（版本声明必须入库）',
  /^desktop-electron\/vendor\/profile\/\*$/m.test(gitignore)
  && /^!desktop-electron\/vendor\/profile\/package\.json$/m.test(gitignore))

console.log('[导入/导出契约]')
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

for (const [sym, from] of [['appDataDir', 'src/platform-paths.mjs'], ['readVendorBaseline', 'src/vendor-baseline.mjs'],
  ['resolveVendorHome', 'src/vendor-home.mjs'], ['safeRemoveTree', 'src/junction-safe.mjs']]) {
  ok(`main.mjs 使用的 ${sym} 由 ${from} 导出`, exportMap.get(from).has(sym), `${sym} @ ${from}`)
}
ok('main.mjs 已无被重命名残留的旧常量', !/VENDOR_PROFILE|VENDOR_EXPECT_FILES/.test(mainSrc))
const declOrder = (src, decl, use) => src.indexOf(decl) !== -1 && src.indexOf(decl) < src.indexOf(use)
ok('VENDOR_DIR 的声明早于 prepareVendorHome（避免又一次 TDZ）',
  declOrder(mainSrc, 'let VENDOR_DIR =', 'function prepareVendorHome'))

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

console.log('[托盘可用性]')
ok('托盘创建被 try/catch 包住（缺托盘服务时明确降级）',
  /try\s*\{[\s\S]{0,400}new Tray\(/.test(mainSrc))
ok('close-to-tray 用 trayUsable 判定，而不是 tray 非空',
  /minimizeToTray !== false && trayUsable/.test(mainSrc) && !/minimizeToTray !== false && tray\)/.test(mainSrc))
ok('图标为空也算托盘不可用（.ico 在 Linux 上常解不出图）',
  /isEmpty\(\)/.test(mainSrc) && /trayUsable = !icon\.isEmpty\(\)/.test(mainSrc))
ok('托盘可用性暴露给客户端（设置页可据此提示）', /^[ \t]*trayUsable,$/m.test(mainSrc))
ok('先起托盘再建窗口（否则关窗判据读到初始 false）',
  /spawnTray\(\)[\s\S]{0,400}?await createWindow\(\)/.test(mainSrc),
  `spawnTray@${mainSrc.indexOf('spawnTray()')} createWindow@${mainSrc.indexOf('await createWindow()')}`)
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
ok('单击唤回窗口覆盖 Linux（非 Windows 都不是双击语义）',
  /tray\.on\('click', \(\) => \{ if \(process\.platform !== 'win32'\) focusAction\(\) \}\)/.test(mainSrc))
ok('托盘菜单第一项是「打开主窗口」（SNI 下 click 未必发得出来，菜单是兜底入口）',
  /setContextMenu\(Menu\.buildFromTemplate\(\[\s*\n(?:\s*\/\/[^\n]*\n)+\s*\{ label: '打开主窗口'/.test(mainSrc))
ok('托盘/窗口图标按平台取（Linux 取 .png；.ico 在那个平台解成空图）',
  /const TRAY_ICON_FILE = iconFilePath\(/.test(mainSrc)
  && /nativeImage\.createFromPath\(TRAY_ICON_FILE\)/.test(mainSrc))

//
// 它的价值是"把这类打错字提前到秒级"，**不是**替代 `smoke`：真正的加载期验证由 smoke 负责
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
  'gradient', 'getComputedStyle', 'window', 'document', 'requestAnimationFrame'])
// 解构形参白名单：本项目约定俗成的解构选项名。正则在 JS 里区分不了"解构默认值"与"函数调用"，
// 与其把分析写得又长又脆，不如显式列出这些名字（只放形参名，绝不放"可能是函数"的猜测）。
const DESTRUCTURED_PARAMS = new Set(['log', 'onDiagnostic', 'onProgress', 'target', 'coeffsOf', 'predOf', 'opts', 'o',
  'env', 'exists', 'write', 'read', 'io', 'meta', 'settings', 'logFile', 'filter', 'map', 'reduce', 'callback',
  'verifyPackages', 'abiGate', 'installFn', 'bootGate', 'npmCli', 'runtime', 'packagesDir', 'cacheDir'])
function calledIdentifiers(src) {
  const found = new Set()
  const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'new', 'function',
    'do', 'else', 'case', 'delete', 'void', 'in', 'of', 'instanceof', 'yield', 'throw', 'async', 'var', 'let'])
  // 用状态机跟踪块注释：纯文字续行（没有 *）用逐行正则认不出来，注释里写的 `musl(` 会被当成真调用
  let inBlockComment = false
  for (const raw of src.split('\n')) {
    if (inBlockComment) { if (raw.includes('*/')) inBlockComment = false; continue }
    if (/^\s*\/\*/.test(raw)) { if (!raw.includes('*/')) inBlockComment = true; continue }
    if (/^\s*(\/\/|\*)/.test(raw)) continue
    if (/=\s*\{|}\s*=|\(\{/.test(raw)) continue
    // 跳过含正则字面量的行：正则里的 ^musl(_| 这种片段会被"标识符紧跟左括号"误判成调用，
    // 而"函数调用里内嵌正则字面量"在本项目里不存在，所以整行跳过是划算的
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
// 具体钉住那个加载期崩溃：深链解析必须用 args。别写成"文件里不许出现 pickProtocolUrl(argv)"——
// 函数定义本身就是 function pickProtocolUrl(argv)，那样会得到一条永远红的断言。
ok('冷启动深链解析用的是 `args`',
  /pickProtocolUrl\(args\)/.test(read('src/main.mjs')))

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
ok('构建器用同一份 DSH 版本常量（不许各写一份）',
  /from '\.\.\/src\/dsh-versions\.mjs'/.test(buildHostSrc) && !/'@deepseek-ai\/dsh': '/.test(buildHostSrc))

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

console.log('[打包前 vendor 平台核对]')
const checkAssetsSrc = read('scripts/check-assets.mjs')
ok('check-assets 会核对 vendor 平台与打包目标',
  /vendor 树的平台必须与打包目标一致/.test(checkAssetsSrc) && /DSH_PACK_PLATFORM/.test(checkAssetsSrc))
ok('平台不符时报错而不是只提示（必须挡住打包）',
  /problems\.push\(`vendor 树是给/.test(checkAssetsSrc))
ok('两个平台的打包入口都挂了 predist 前置检查',
  ['predist', 'predist:linux'].every((k) => typeof pkg.scripts[k] === 'string'))

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
  const lockText = fs.readFileSync(VENDOR_LOCKFILE, 'utf8')
  ok('锁覆盖三个 DSH 包', ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
    .every((n) => lockText.includes(`node_modules/${n}"`)))
}
ok('build-host 把 lockDir 显式传给构建（暂存布局下推不出 OUT_DIR）',
  /lockDir:\s*OUT_DIR/.test(read('scripts/build-host.mjs')))
ok('findVendorLockfile 考虑了暂存布局（不能只靠 dirname 上一级）',
  /path\.dirname\(path\.dirname\(profileDir\)\)/.test(read('src/vendor-build.mjs')))
ok('有跨平台包内容比对脚本', fs.existsSync(path.join(ROOT, 'scripts', 'compare-packaged-vendor.mjs')))

console.log('[打包产物 asar 可解析性]')
const asarGateSrc = read('scripts/check-packaged-asar.mjs')
ok('有打包产物 asar 检查脚本', fs.existsSync(path.join(ROOT, 'scripts', 'check-packaged-asar.mjs')))
ok('它挂在 electron-builder 的 afterPack 上（产物一出来就查它自己）',
  /^afterPack:\s*scripts\/check-packaged-asar\.mjs\s*$/m.test(read('electron-builder.yml')),
  (read('electron-builder.yml').match(/^afterPack:.*$/m) ?? ['(没有 afterPack)'])[0])
ok('脚本有 default 导出（afterPack 钩子的形态要求）', /export default async function afterPack/.test(asarGateSrc))
ok('钩子拿到 appOutDir 后**拒绝产出**而不是只打印', /throw new Error\(`打包产物里有无法解析的源码/.test(asarGateSrc))
ok('防止判据空转（一个都没真检查时必须判失败）', /至少真正检查过一个文件/.test(asarGateSrc))
ok('把"起不来"与"代码语法错"分开报（避免假红）', /无法执行语法检查/.test(asarGateSrc))
ok('两个打包 job 都显式跑了这道检查（钩子之外的兜底）',
  (ci.match(/check-packaged-asar\.mjs/g) ?? []).length >= 2,
  `CI 里出现 ${(ci.match(/check-packaged-asar\.mjs/g) ?? []).length} 次`)

console.log(fail === 0 ? '\nCI SELF TEST: ALL PASS' : `\nCI SELF TEST: ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
