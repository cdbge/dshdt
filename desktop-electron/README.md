# DSH Desktop · Electron 壳

把 **DeepSeek Harness（DSH）** 的 Web 界面托管成一个真正的桌面应用：主进程用
`ELECTRON_RUN_AS_NODE` + `--expose-internals` 把 electron 可执行文件当 Node 用，托管 `dsh web` 宿主子进程，
再用 `BrowserWindow` 加载回环地址 —— 界面始终是 DSH 自己的界面，**DSH 本体零改动**。

**支持 Windows 10/11（x64）、Linux（x64，AppImage/deb）、macOS（arm64/x64，dmg/zip）**。
三平台的差异集中在 `src/platform-paths.mjs` 与 `vendor` 树（必须按目标平台构建），
构建链路见 `scripts/`（`build-host.mjs` 建树、`linux/` 出 Linux 包、`build-mac-universal.mjs` 合并双架构）。

> **这是代码侧 README**：本目录怎么开发、怎么构建、怎么排障。
> 功能总览、安装引导与常见问题见仓库根 [`../README.md`](../README.md)。

## 版本锚点

| 项 | 值 | 来源 |
|---|---|---|
| 壳版本 | **0.4.7** | [`VERSION`](VERSION) |
| DSH 运行时 | `@deepseek-ai/dsh`、`dsh-base`、`dsh-web-app` 均为 **0.1.6-alpha.1** | [`vendor/vendor.lock.json`](vendor/vendor.lock.json)（三包同进同退） |
| Node / Electron | 24.18.1 / 43.4.0 | 同上 |
| 自包含运行时 | **11,168 个文件 / 104.4 MB**（构建期剪枝掉 14,279 个文件；Linux 103.1 MB / macOS 100.3 MB） | 同上（`totalFiles` / `totalBytes` / `prunedFiles`） |
| 原生模块 ABI 门禁 | `PASS` | 同上 |
| 目标平台 | Windows x64 / Linux x64 / macOS arm64+x64 | 同上（`platform` 段记录 `{os, arch, libc}`） |

## 目录结构

```
desktop-electron/
├─ package.json / .npmrc / electron-builder.yml / VERSION
├─ src/                       # 壳代码（会进 asar，`files: src/**`）
│  ├─ main.mjs                #   主进程：多窗口、宿主编排（复用已有实例）、托盘、协议、退出、背景图注入
│  ├─ platform-paths.mjs      #   平台路径与二进制解析（三平台数据/日志/home/workspace + electron 可执行文件）
│  ├─ node-guard.mjs          #   最先导入：防 ELECTRON_RUN_AS_NODE 泄漏（主进程退化成纯 Node 时明确报错）
│  ├─ early-errors.mjs        #   第二个导入：打包态未捕获异常落盘（零依赖，自己算日志路径）
│  ├─ host.mjs                #   宿主托管：findDshBin / freePort / waitReady / killTree / startHost
│  ├─ admin.mjs               #   回环 admin HTTP（/api/* + /bg-image 背景图供给）
│  ├─ dsh-update.mjs          #   DSH 更新 S1：版本发现与比较（纯 Node，不写文件不起进程）
│  ├─ vendor-build.mjs        #   DSH 更新 S2：vendor 树构建原语（install / 剪枝 / 插件同步 / 平台包门禁 / ABI 门禁）
│  ├─ dsh-apply.mjs           #   DSH 更新 S3：换树与回滚（唯一不可逆操作，每条失败分支都有单测）
│  ├─ junction-safe.mjs       #   含链接目录的安全删除（自己删树一律走它）
│  ├─ repair.mjs              #   会话日志自愈：半个 zstd 尾帧 / 首帧异常 / 坏日志隔离改名
│  ├─ settings.html           #   壳内设置页
│  └─ desktop.patch.yml       #   形态层 patch（config 整体替换语义）
├─ packages/                  # 自带插件（构建期同步进 vendor，启动时同步到 profile 插件位）
│  ├─ dsh-desktop-ui/         #   客户端插件：设置面板「桌面」分区 + 按钮交互样式
│  └─ dsh-auto-approval/      #   服务端插件：审批瀑布上由独立模型裁决权限申请
├─ scripts/                   # 构建、门禁与工具（不进安装包）
├─ build/                     # 图标与签名资源：icon.ico / icon.png / icon.icns / icons/*.png / entitlements.mac.plist
├─ vendor/vendor.lock.json    # 运行时版本、平台三元组与文件数基线（vendor/profile 由 build:host 生成，不入库）
└─ dist/                      # 安装包产物（不入库，发布走 GitHub Releases）
```

> **会进安装包的只有 `src/**` + `VERSION` + `package.json`**（外加 `extraResources` 里的 vendor 树、
> patch 与图标）。新增"打包态要调用"的能力**不能放 `scripts/`**——它不进包。

## 开发运行

前提：Node.js 22+、能访问 npm registry（构建 vendor 时）。**支持 Windows / Linux / macOS**：
壳侧的平台差异集中在 `src/platform-paths.mjs`（路径与二进制名），vendor 树则**必须按目标平台构建**
（`koffi` / `node-pty` / `node-addon-system-<plat>` 都是预编译二进制，装错平台宿主起不来）。

```bash
npm install
npm run build:host        # 生成 vendor/profile（首次或依赖变更后必跑；默认本机平台）
npm start                 # 窗口模式；npm run dev 保留 DevTools
```

| 命令 | 作用 |
|---|---|
| `npm start` / `npm run dev` | 窗口模式（后者保留 DevTools 与默认菜单） |
| `npx electron . --headless` | 无窗口常驻（设置页在 `http://127.0.0.1:<port>/`，端口见宿主锁或壳日志） |
| `npx electron . --doctor` | 环境体检：系统版本 / dsh CLI 路径 / agent shell（Win: pwsh，POSIX: bash）/ 沙箱后端（POSIX）/ `DSH_HOME` / 工作区 / 磁盘余量 |
| `npx electron . --diag` | 一键取证：路径、环境变量、preflight、宿主锁与 stdio 模式、依赖文件数、三份日志尾部 → 同时写日志目录下的 `diag-report.txt`（"别人机器起不来"时让对方跑这条） |
| `npm run smoke` | 端到端全量冒烟（**72 断言**，需完整权限）；打包产物用 `dist/<平台 unpacked 目录>/… --smoke` |
| `npm run build:host` | 重建 vendor/profile（含插件同步、平台包门禁与 ABI 门禁） |
| `npm run build:host -- --os linux --cpu x64` | **交叉构建**另一平台的 vendor 树（npm 10 起支持；发布仍建议在目标平台原生构建） |
| `npm run dist` / `dist:linux` / `dist:mac` | 打安装包：NSIS（Windows）/ AppImage+deb（Linux）/ dmg+zip（macOS）；`dist:current` 按当前平台自动选 |

启动参数还有 `--autostart on|off`、`--set-ws <绝对路径>`、`--register`（注册开机自启与 `dsh://` 协议）、`--version`。

> ⚠️ 在 AI 会话/被托管环境里跑 electron 之前，先清掉 `ELECTRON_RUN_AS_NODE`
> （Windows `Remove-Item Env:ELECTRON_RUN_AS_NODE`，POSIX `unset ELECTRON_RUN_AS_NODE`）：
> 该变量会让 electron 可执行文件退化成纯 Node，症状是"无窗口、无日志"。

### 各平台的数据与日志目录

| 平台 | 应用数据（设置/状态/Electron profile） | 日志 | DSH 用户数据 |
|---|---|---|---|
| Windows | `%LOCALAPPDATA%\DSHDesktop` | 同左 `\logs` | `%USERPROFILE%\.dsh` |
| macOS | `~/Library/Application Support/DSHDesktop` | `~/Library/Logs/DSHDesktop` | `~/.dsh` |
| Linux | `$XDG_DATA_HOME/dsh-desktop`（缺省 `~/.local/share/dsh-desktop`） | `$XDG_STATE_HOME/dsh-desktop/log` | `~/.dsh` |

`DSH_APP_DATA` 一旦设置，日志会跟着它走（冒烟隔离与便携部署要能断言日志位置）。

## 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_HOME` | 覆盖 DSH 用户数据目录（已存在 `%USERPROFILE%\.dsh` 则默认沿用） |
| `DSH_WS` | 覆盖默认工作区 |
| `DSH_BIN` | 指定 dsh 入口路径（自动发现顺序：全局 npm > npx 缓存 > 包内 vendor） |
| `DSH_APP_DATA` | 覆盖应用数据目录（日志 / 设置 / Electron profile；冒烟隔离用） |
| `DSH_SMOKE=1` | 跳过注册表、登录项与协议写入 |
| `DSH_HOST_STDIO=fd` | 强制宿主用 fd 直通 stdio（跳过管道探测，仅在诊断"管道是否被系统拒绝"时用） |

## 门禁（改动后必跑）

**27 套离线自检 + `smoke` 72 断言**。改动后全绿才算完成。**权威数字由 `npm run test:suite` 打印**
（下表是分项说明；断言数变动时以脚本输出为准，别手抄——`scripts/ci-self-test.mjs` 会核对套件数与"表里
每一套都有行"，但**逐行断言数只能靠人更新**，表里的数字与脚本不一致时改表）。

一条命令跑完全部离线自检（本地与 CI 共用同一份清单，见 `scripts/test-suite.mjs`）：

```bash
npm run test:suite            # 全部套件，输出每套的 pass/fail 与总数
node scripts/test-suite.mjs --list           # 只列清单
node scripts/test-suite.mjs --only platform  # 只跑匹配的套件（改哪块跑哪块）
```

| 脚本 | 断言 | 说明 |
|---|---|---|
| `scripts/smoke.mjs` | **72** | 端到端全量冒烟：admin 面 + 背景图 + 皮肤遮罩 + browse 钉住 + DSH 更新面 + 优雅退出 |
| `scripts/vendor-build-self-test.mjs` | 113 | vendor 构建原语 + **平台化**（剪枝按目标平台、平台包门禁含 Windows 的 conpty 三件套、spawn-helper 权限位、交叉构建门禁延后、**glibc/musl 变体的 ABI 判定**）、**启动门禁的取证**（宿主秒退时要把子进程 stderr 的遗言带回报错，且不得把 `--- run … ---` 分隔行当证据） |
| `scripts/ci-self-test.mjs` | 153 | **CI 配置与门禁清单自查**（三平台矩阵、产物 glob、清单与磁盘一致、打包配置、**递归删除入口**、交叉构建延后契约、**macOS 双架构前置条件**、**打包前 vendor 平台核对**、**shell 脚本行尾/BOM**、**`.icns` 纯 Node 生成不许退回 macOS-only**、**跨平台内容一致性（版本锁）**、**托盘三条"打开主窗"入口**、README 数字） |
| `scripts/dsh-apply-self-test.mjs` | 44 | 换树与标记状态机（全同步，每条失败分支一条断言） |
| `scripts/cross-tree-self-test.mjs` | 43 | **vendor 树静态体检判据 + 双架构合并**（三平台正确树必须全过；缺件/串平台/假绿/并入架构缺件/别的平台+别的架构的污染都必须报错） |
| `packages/dsh-auto-approval/test/apply-self-test.mjs` | 47 | 审批接线（mock ctx 驱动 apply） |
| `scripts/update-self-test.mjs` | 36 | 版本发现与比较（脱网） |
| `scripts/vendor-home-self-test.mjs` | 26 | **vendor 归属与种子迁移** |
| `scripts/platform-self-test.mjs` | 23 | **平台路径与二进制解析**（三平台 data/log/home/workspace + electron 可执行文件） |
| `scripts/vendor-baseline-self-test.mjs` | 21 | **依赖完整性判据**（基线读取三态 + 缺件阈值 + "基线缺失不得判为通过"的回归断言） |
| `scripts/junction-safe-self-test.mjs` | 21 | 含链接目录的安全删除（建真 junction 验证目标不被掏空） |
| `scripts/patch-mount-self-test.mjs` | 17 | profile 补丁层挂载与自愈（**测的是 `src/profile-mount.mjs` 的真实现**，含真实坏文件样本与"注释里的名字不算已挂载"） |
| `scripts/skin-settings-self-test.mjs` | 44 | **外观设置迁移规则**（测的是 `src/skin-settings.mjs` 的真实现：只补缺失/**已有键绝不覆盖**（含 `false` 与 `0` 这类"像空值其实是设定"的）/毛玻璃只在有壁纸时默认开/快照给存储值而非渲染值/`null` 不得被当成 `0`/**强度小于 0.5 时归位到默认值且只做一次**） |
| `scripts/bg-css-self-test.mjs` | 27 | **壁纸注入 CSS 的生成物**（测的是 `src/bg-css.mjs`：固定层/z-index/外扩/破缓存参数、**"置透明"规则的选择器必须能命中真实元素路径**（`body > div > div > div._frame` 那一层，旧写法 `#root > div` 就是命不中它才让毛玻璃看不出效果）、主题变量四处覆盖、`null` 不得被当成 0。**判据是"能不能命中"，不是"源码里有没有这个词"**） |
| `scripts/host-platform-self-test.mjs` | 14 | **宿主托管平台分支**（dsh 入口发现的三平台布局 + 进程树终止） |
| `packages/dsh-auto-approval/test/grade-self-test.mjs` | 10 | 审批分级器（纯函数） |
| `scripts/jpeg-decode-self-test.mjs` | 10 | **图标解码器**（自写 JPEG 解码：非纯色/彩色保留/**无块状伪影**/多扫描/异常路径） |
| `scripts/check-assets-self-test.mjs` | 9 | **打包前置检查**（vendor 平台与打包目标不符必须挡住；交叉打包声明目标后不得误挡） |
| `scripts/check-vendor-lock-self-test.mjs` | 9 | **版本锁一致性判据**（缺直接依赖 / 版本不满足范围 / lockfileVersion 不对 / 锁损坏都必须拦住） |
| `scripts/repair-self-test.mjs` | 8 | 会话日志自愈 |
| `scripts/admin-bg-test.mjs` | 7 | admin 背景图（纯 Node） |
| `scripts/market-install-self-test.mjs` | 30 | **市场安装链路的失败分支**（哈希不符 / 包名与 id 不一致 / 撞自带插件名 / 已装过 / 下载失败…每条都断言**不留半成品**） |
| `scripts/market-install-official-self-test.mjs` | 27 | **官方安装路径**（`dsh plugin add`）：坐标校验（分支/标签必须钉成 40 位 commit）、缺 pnpm 的处置、构建脚本被拦单独分档、超时，以及"退出码 0 但清单无痕迹 → 判失败" |
| `scripts/tray-icon-self-test.mjs` | 20 | **托盘/窗口图标的平台判据 + 三条"打开主窗"入口**：Linux/macOS 的图标解码**不认 .ico**（实测 `empty=true 0×0`，而 .png 是 512×512）⇒ 托盘建了却没像素可画、Waybar 什么都不显示、`trayUsable` 还把「关闭到托盘」一起关掉；Linux 上 `double-click` **事件根本不存在**（Electron 文档标注 _macOS_ _Windows_）、`click` 里又排除了非 darwin ⇒ 点了没反应，而菜单里没有"打开主窗口"。判据含**图标文件自身的魔数与尺寸**、打包配置是否把两份图标都放进 `resources/`、以及"菜单第一项必须是打开主窗口"的顺序断言 |
| `scripts/harness-compat-self-test.mjs` | 38 | **harness × Electron 的运行时兼容判据**（2026-09-18 事故）：白名单**从 addon 二进制原字节里解析**（它是唯一副本，没有 JS/JSON 版；V8 串是四段数字、字段间 NUL 按对齐补零——两处写错都会变成"读不到 ⇒ 放行"的静默失效，所以夹具直接内联真二进制那 260 字节）、三态判定（确定拦 / 只警告 / 放行）、**读不到白名单时必须放行**（把用户卡死比不判更糟）、显式逃生口（`DSH_UPDATE_ALLOW_INCOMPATIBLE=1`，默认不放行）、以及判据**接在 `npm install` 之前**（不是装完 121 MB 才发现） |
| `scripts/pnpm-resolve-self-test.mjs` | 24 | **pnpm 的定位判据**（2026-09-18）：候选路径派生（与 npm 锚点同源）、`node <pnpm.cjs>` 直调优先、PATH 兜底、找不到时报出"找了哪些地方"、以及把 pnpm 目录**注入子进程 PATH**（官方 CLI 内部 `spawn('pnpm')` 靠它才找得到） |
| `scripts/zip-safe-self-test.mjs` | 27 | **安全解包**（自己构造恶意 zip：zip-slip、绝对路径、反斜杠歧义、ADS、zip64、加密包） |
| `scripts/client-plugin-load-self-test.mjs` | 34 | **客户端插件装载期 + 渲染期**（真跑 `factory`，再**真渲染**每个注册到的组件）：模块体引用未定义标识符 / `apply()` 抛错 / 模块面形状不对 / **组件渲染期抛错**（可选参数没给默认值那类）。**这门是两次事故换来的**——`node --check` 只解析不求值，抓不到前者；只跑 `apply` 又抓不到后者 |

口径：跨平台改造前是 242 断言（9 套）；当前 **27 套**（以 `npm run test:suite` 的输出为准）。
⚠️ 上表的**逐行断言数**由人维护（`ci-self-test` 只核对套件总数与"每一套都有行"），
所以它们会滞后于脚本输出 —— 改动后请以 `npm run test:suite` 打印的数字为准，并顺手改表。

**权限口径**：`smoke.mjs` 会起 Electron，**需要完整权限**（受限沙箱下 mojo 命名管道被拦，表现为"壳状态文件超时"，
不是壳的缺陷）；Linux CI 上用 `xvfb-run -a` 提供显示。打包产物的 `--smoke` **退出码不可信**，
判据取输出里的 `N/N PASS`（`smoke.mjs` 的口径），必要时再核 `SMOKE OK`。

### CI（三平台矩阵）

`../.github/workflows/release.yml` 有四个 job：`self-test`（三平台 matrix 各跑一遍 22 套自检 + 版本锁 strict 核验）、
`windows`（NSIS）、`linux`（AppImage+deb）、`macos`（dmg+zip，arm64+x64）。
推 `v*` tag 或手动 `workflow_dispatch` 触发。**每个 job 都在目标平台原生构建**
（vendor 树按平台装，交叉构建只在开发态省事）。

**CI 配置本身也有门禁**：`scripts/ci-self-test.mjs`（108 断言）核对三平台 runner、产物 glob、
自检清单与磁盘一致、打包配置与图标路径、交叉构建的门禁延后契约、打包前 vendor 平台核对、
shell 脚本行尾、以及**跨平台内容一致性（版本锁）**；它在 `test:suite` 里，
改 CI 或清单写错会当场红，不必等推 tag 才发现。

**发布前另有一条联网门禁**（不在离线套件里，因为它要联网）：

```bash
node scripts/check-vendor-lock.mjs            # 脱网：直接依赖在锁里且版本满足范围
node scripts/check-vendor-lock.mjs --strict   # 联网：npm ci --dry-run，校验"锁与 manifest 是同一套"
```

`--strict` 是完整判据（实测能拦住：DSH 版本变了、清单多了依赖、锁缺失、锁损坏四种漂移）。
CI 里它挂在三个打包 job **之前**的 `self-test` job 上——锁不对，三平台产物就不该被生产出来。

签名 Secrets（未配置则出未签名包）：Windows `WINDOWS_CERT_PFX` / `WINDOWS_CERT_PASSWORD`；
macOS `CSC_LINK` / `CSC_KEY_PASSWORD` 与公证用 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`。

**辅助工具**（非门禁）：`scripts/boot-smoke.mjs`（宿主链路冒烟，无 GUI 也能跑）、
`scripts/bootgate-verify.mjs` 与 `scripts/bootgate-destruct-test.mjs`（启动门禁的正/负测试，
需要 `DSH_INSTALL_DIR` 指向已安装应用）、`scripts/vendor-equivalence.mjs`（暂存树等价性验证，
分钟级，换树前跑）、`scripts/abi-scan.mjs` 与 `scripts/build-host.mjs`（CLI 薄封装，实现在 `src/`，
支持 `--os/--cpu/--libc` 交叉构建）、`scripts/gen-icon.mjs`（三平台图标：ico/png/icns，icns 需 macOS）、
`scripts/dev-sign.ps1`（Windows 自签）。

## 构建与打包

**三平台各自的完整流程**（在目标平台上执行；`build:host` 产出的是**该平台**的 vendor 树）：

```bash
# Windows（x64）
npm run build:host && npm run dist          # → dist/DSHDesktop-Setup-<版本>.exe（NSIS）

# Linux（x64）
npm run build:host && npm run dist:linux    # → dist/DSHDesktop-<版本>-x86_64.AppImage + .deb
# 依赖：libarchive-tools/fakeroot/rpm（deb 打包用）；AppImage 运行端建议装 libfuse2
# 建议随包声明 bubblewrap：DSH 的 Linux 沙箱后端，缺失时 agent 命令会被 fail-closed 拒绝

# macOS（arm64 / x64，**一棵双架构树**）
npm run build:mac-universal && npm run dist:mac   # → dist/DSHDesktop-<版本>-<arch>.dmg + .zip（两个架构）
# 图标：.icns 只能在 macOS 上生成（scripts/gen-icon.mjs 用系统 iconutil/sips）
# 为什么不是 build:host：见下方"macOS 双架构"一条（单棵树会让 x64 产物装上也起不来）
```

- **vendor 树是按平台构建的**：`vendor.lock.json` 里的 `platform` 段记着 `{os, arch, libc}`，
  `platformPackages` 记着本平台必需的原生包（koffi / node-pty / node-addon-system(flock) / sharp / ripgrep）。
  构建期有**平台包门禁**：缺任一项直接拒绝产出，因为那会让宿主在 `import` 期就起不来或让会话写不进去。
  Windows 上"node-pty 齐备"指的是 **conpty 三件套**（`conpty.node` + `conpty_console_list.node` +
  `conpty/conpty.dll` + `conpty/OpenConsole.exe`）—— `pty.node` 是 Unix 的实现，Windows 树上根本没有它。
- **交叉构建**（可选，省去多台机器）：`npm run build:host -- --os linux --cpu x64 --out .tmp-cross/linux-x64`。
  npm 10 起支持 `--os/--cpu/--libc`，这 7 个平台包都是预编译产物；**发布仍建议在目标平台原生构建**。
  三条注意事项：
  1. **必须带 `--out`**：交叉产物属于另一个平台，顶替现网 `vendor/` 等于把本机应用换成起不来的树；
  2. **ABI 门禁与启动门禁会延后**（两者都要 spawn 目标平台的运行时，宿主上跑不了）。这不是静默跳过：
     日志会明说，`vendor.lock.json` 里写 `abiScan: "DEFERRED（交叉构建，需在目标平台补跑）"` 与
     `gatesDeferred: {abi:true, boot:true}`。**"PASS" 只会在真跑过门禁的平台上出现**；
  3. 交叉产物可用 `node scripts/verify-cross-tree.mjs --dir <目录>` 静态体检（平台包齐不齐、有没有别平台的
     残留、prebuilds 对不对、与现网树的体量是否相当）。该脚本的目标平台**默认取 lock 的 `platform` 段**，
     所以 `--dir vendor` 在 CI 的原生 runner 上同样可用（三个打包 job 都会跑）。**它替代不了目标平台上的门禁**。
- **--prune-only 是维护入口**：`npm run build:host -- --prune-only` 在现网树上原地做剪枝 + 插件同步 +
  平台包门禁 + ABI 门禁 + 启动门禁，并刷新 `vendor.lock.json`。与完整构建的区别是**不重装依赖**，
  适合"剪枝规则更新后把旧树对齐"这种场景；两条路径共用同一份 lock 写入实现（`buildVendorLock`）。
- **macOS 双架构必须用 `build:mac-universal`**（不是 `build:host`）：`electron-builder --mac dmg zip --arm64 --x64`
  会把**同一棵 vendor 树**打进两个架构的 .app，而 `npm install` 一次只能按一个 `--cpu` 解析可选依赖 ⇒
  只建一棵树的话，x64 的 .app 里装的是 arm64 的 `koffi` / `node-pty`，**装上也起不来**（import 期崩）。
  所以 macOS job 走 `node scripts/build-mac-universal.mjs --host arm64 --add x64`：
  ```bash
  npm run build:mac-universal            # → vendor/ 里同时有 darwin-arm64 与 darwin-x64 的平台包
  npx electron-builder --mac dmg zip --arm64 --x64
  ```
  它先建宿主架构那棵，再单独建另一架构那棵当 donor，只把 donor 里**平台专属**的条目并进来
  （脚本与 JS 代码两棵树是同一份，整树拷贝只会引入"两份可能漂移的代码"）。
  合并后 `vendor.lock.json` 多一个 `mergedPlatforms` 段，体检脚本会**对这个架构也逐项验必需包**。
  代价是体积：macOS 树 125.9 MB（单架构 99.9 MB），多出来的 26 MB 是两套 `libvips` 原生库 —— 这是必要的。
- **产物不进仓库**：`dist/` 已在 `.gitignore` 里，安装包只作为 **GitHub Release 附件**分发。
- **在哪台机器上能打出哪个包**（2026-09-15 更新：**本机已有可用的 WSL Debian，AppImage/deb 不再需要等 CI**）：
  | 目标 | Windows 直出 | 经 WSL Debian | 说明 |
  |---|---|---|---|
  | Windows NSIS | ✅ | — | 本机构建机不需要 makensis（electron-builder 自带工具链） |
  | Linux `dir` / `tar.gz` | ✅ | ✅ | 需要 `--publish never`（否则它去试发布），并且 **`vendor/` 里必须是 linux 树** |
  | Linux `AppImage` | ❌ | ✅ | 要 `mksquashfs`（electron-builder 的 appimage 包只有 `darwin/`+`linux/` 两个目录）；**已在 WSL 里实测产出 154.1 MB** |
  | Linux `deb` | ❌ | ✅ | 要 `fakeroot`/`rpm`/**`ar`**（`ar` 来自 `binutils`，漏了报 `Need executable 'ar' to convert dir to deb`）；**实测产出 118.5 MB** |
  | macOS `dmg`/`zip`/`dir` | ❌ | ❌ | **硬边界，不是缺工具链**：electron-builder 在代码里直接拒绝非 macOS 主机做 mac 构建（`Build for macOS is supported only on macOS`，实测）。唯一出路是 CI 的 macos runner 或一台真 Mac |
  **结论**：Windows 上能出 NSIS 与 Linux `tar.gz`；**AppImage / deb 走 WSL Debian**；
  只有 macOS 产物必须靠 macOS（CI 的 macos runner 或真机）——这一格 `electron-builder` 自己不让，别浪费时间试。
- **macOS 产物在那边要按什么顺序跑**（准备工作已就绪，到 Mac / macos runner 上照做即可）：
  ```bash
  npx electron scripts/gen-icon.mjs                 # 含 .icns（纯 Node 生成，已不需 sips/iconutil）
  npm run build:mac-universal                       # 双架构一棵树：arm64 + x64 平台包并存
  node scripts/verify-cross-tree.mjs --dir vendor    # 应报"并入架构的平台专属件逐项齐全"
  DSH_SMOKE=1 npm run smoke                          # 开发态冒烟
  npx electron-builder --mac dmg zip --arm64 --x64   # 两个架构的 .dmg/.zip
  ```
  再对 `dist/mac*/*.app` 跑打包态冒烟（CI 的 macos job 已经这么做；判据同 Windows：按输出里的 `PASS` 计数）。
  **双架构树的正确性已在本机离线验证**：`darwin-arm64 + darwin-x64` 两套共 8 类平台专属件逐项齐全、
  无别平台残留（含"别的平台 **+ 别的架构**"这类污染），体检 20 条断言全过。
- **Linux 两个安装包都"装一遍再跑"验过**（2026-09-15，见 `scripts/linux/verify-installers.sh`）：
  - **deb**：`dpkg -i` 真装成功 → `/opt/DSH Desktop/`、`/usr/bin/dsh-desktop`（update-alternatives）、
    `/usr/share/applications/dsh-desktop.desktop`、512 图标全部落盘，`resources/vendor` 平台为 `linux-x64`；**冒烟 PASS**
  - **AppImage**：`--appimage-extract` **rc=0**（这同时证明我们产出的 squashfs 镜像本身可用）→ **冒烟 PASS**
  - 两者跑的是**同一套冒烟判据**（与 Windows 同源：按输出里的 `PASS` 计数，不以退出码为唯一判据）
- **AppImage 的"双击路径"也验过了**（`scripts/linux/appimage-direct-run.sh`）：用户双击走的是 **FUSE 挂载**，
  与 `--appimage-extract` 是**两条不同的路**，故障点也不同（缺 fuse、libfuse 版本、`/tmp` noexec…）。
  实测两条都 PASS，且**路径证据可区分**——直跑那次日志里 `/tmp/.mount_*` 与 `appimage_extracted`
  **各出现 0 次**（说明它真从 squashfs 挂载读，一次都没解包），而 `--appimage-extract-and-run`
  那次 `appimage_extracted` 出现 13694 次。
  > 踩过一次：两条路共用一个日志文件名，后一次覆盖前一次，于是差点拿"解包"的日志去充当"挂载成功"的证据。
  > 现在每次运行单独落日志，并把"走的是哪条路"直接打在结论行上。
  > 前置：WSL 里要 `apt install fuse3 libfuse2t64`（否则没有 `/dev/fuse`，脚本会**明确跳过并标注未测**，
  > 不拿"挂载失败"冒充"应用有问题"）。
- **`.icns` 已改成纯 Node 生成**（不再需要 macOS 的 `sips`/`iconutil`）：`.icns` 本来就是
  "容器 + 若干 PNG"（现代 macOS 接受 PNG 成员），而仓库里已有 PNG 编码器与区域平均缩放，
  所以只需拼容器。核验在 `scripts/verify-icns.mjs`（头/总长/成员表严丝合缝/每个成员是合法 PNG 且
  宽高与类型码一致/7 个档位齐全）。**这一条把 macOS 打包的最后一块跨平台拼图补上了**——
  不过 mac 产物本身仍受上一格的硬边界限制。
- **三平台包内容必须一致 —— 靠一份版本锁，不靠自觉**（2026-09-15 加的）：
  manifest 只钉死三个 DSH 包的精确版本，**传递依赖是范围声明**（`zod: ^4.4.3`、
  `node-addon-require-builtin: ^0.1.4`、`@types/node` 由 `protobufjs` 的 `>=13.7.0` 拉进来），
  于是**同一个 DSH 版本在不同日期装出两棵内容不同的树**——实测 Windows 树与 Linux 树曾有 5~6 个同名包
  版本不同（连 `koffi` 3.2.1 vs 3.3.0 这种核心原生依赖都在漂），而**没有任何报错**。
  修法：仓库里放一份**平台中立**的 `vendor/package-lock.json`（587 个包，含全部平台专属条目），
  三平台都用它装。装之前锁会被拷进 `profile/`（npm 只认 cwd 下的锁）；
  **用 `npm install` 消费而不是 `npm ci`** —— 锁来自某一个平台，其 `optionalDependencies` 带着平台专属包，
  `npm ci` 的全量校验在别的平台上必然失败。缺锁会退回"各装各的"并打提示（不硬失败）。
  核对工具：`node scripts/compare-packaged-vendor.mjs`（逐包比对各平台**打包产物内**的树）——
  当前三棵完整的树（win-unpacked / linux-unpacked / deb 装出来的那棵）**逐包版本全部一致**。
  ⚠️ **改 DSH 版本后要重新生成锁**：`npm install --package-lock-only`（见脚本注释）。
- **在 WSL 里出 Linux 安装包**（一条命令，脚本已入库）：
  ```powershell
  # 前置（一次性）：wsl --install -d Debian
  pwsh -File scripts\linux\build-linux.ps1              # 依赖 → 准备 → 打包 → 冒烟，全流程
  pwsh -File scripts\linux\build-linux.ps1 -Stage pack  # 只打包
  ```
  四个阶段各有独立脚本（可分开跑）：`install-deps.sh`（系统依赖）、`prepare-build-tree.sh`（拷进 ext4 + `npm ci` + 建 linux vendor 树）、
  `build-installers.sh`（AppImage + deb）、`packaged-smoke.sh`（**在真 Linux 内核上跑打包产物**），
  另有 `verify-installers.sh`（**把 deb 真装一遍、把 AppImage 解开跑一遍**）。
  为什么必须在 Linux 里跑：`mksquashfs`/`fpm`/`ar` 在 Windows 上不存在；而且 `chrome-sandbox` 要 `4755`，
  drvfs 上权限位保不住，所以仓库要先拷进 ext4。
- **Linux 打包产物已实测可用**（2026-09-15，WSL Debian 13）：`packaged-smoke.sh` 输出
  **`SMOKE OK`、`cleanup: code=0`**，宿主 6 秒就绪（`ready: http://127.0.0.1:41441/?token=…`）。
  同一次运行还**顺带验证了决策 D8**：首启把包内 vendor 拷成用户数据目录里的种子（11,142 文件 / 103.1 MB），
  然后"使用用户数据目录里的树"——这条换树链路此前只在离线单测里验过。
  两个环境要求：`xvfb-run`（含 **`xauth`**，漏了报 `xauth command not found`、退出码 3）与
  root 身份跑 Chromium 必须 `--no-sandbox`（仅测试环境；用户装的包不需要）。
- **打包会自动核对 vendor 平台**：`predist*` 钩子里的 `scripts/check-assets.mjs` 会比对
  `vendor/vendor.lock.json` 的 `platform.os` 与本次打包目标，不符**直接拒绝打包**。
  这条是踩出来的：`extraResources` 是整目录照拷，electron-builder 不看里面装的是哪个平台的二进制——
  在 Windows 上产 Linux 包时忘了换树，产物**照样"打包成功"**，但里面全是 win32 的 `koffi`/`node-pty`，
  装上也起不来。交叉打包时用 `DSH_PACK_PLATFORM=<os>` 声明目标即可放行。
- **包体为什么大**：安装包内自带整棵 DSH 运行时（**Windows 104.4 MB / Linux 103.1 MB / macOS 单架构 99.9 MB·
  双架构 125.9 MB**），换来的"免装 DSH、双击即用"。安装耗时主要跟**文件数**相关（解压 + Defender 逐文件扫描），
  所以剪枝优先砍文件数而不是字节数（`.map` / `.d.ts` / `.md` / 许可证 / **`.pdb`** 调试符号都会剪掉）。
- **签名**：Windows 未签名时首次运行有 SmartScreen 提示（本地开发可自签，见下）；macOS 未签名/未公证时
  用户需右键"打开"，自更新也要求已签名。entitlements 模板在 `build/entitlements.mac.plist`。
- **构建机无需 makensis**：electron-builder 自带 NSIS 工具链；直调
  `node node_modules/electron-builder/out/cli/cli.js --win nsis` 可绕开 npx 垫片（Linux/macOS 上同理）。

本地自签（消除 SmartScreen 提示，仅本机可信）：

```powershell
pwsh -File scripts\dev-sign.ps1     # 生成/复用自签证书 → scripts\certs\dev.pfx + dev.cer
# 右键 dev.cer → 安装证书 → 当前用户 → 受信任的根证书颁发机构
$env:CSC_LINK = [Convert]::ToBase64String([IO.File]::ReadAllBytes("scripts\certs\dev.pfx"))
$env:CSC_KEY_PASSWORD = 'dshdev'
npm run dist
Get-AuthenticodeSignature dist\DSHDesktop-Setup-*.exe | Select-Object Status   # 信任根之后为 Valid
```

## 更新通道

| 通道 | 状态 |
|---|---|
| **DSH 本体更新**（设置面板按钮） | ✅ 已实现：版本发现 → vendor 树构建 → 换树与回滚；跨版本升级默认拒绝，需显式放行 |
| **壳自更新**（electron-updater） | ⏸ 未启用：`electron-builder.yml` 的 `publish` 仍是注释状态 |

### vendor 树的位置（决策 D8，用户可见）

装上之后你会看到一个 **100–105 MB 的 `vendor` 目录**，这是**正常的**——它是自带的那棵 DSH 运行时
（"免装 DSH、双击即用"的代价）。它在哪个位置、为什么在那儿：

| 平台 | 实际使用的那棵树 | 包内那份的角色 |
|---|---|---|
| Windows | `resources\vendor`（安装目录内，可写） | 就是它本身 |
| macOS | `~/Library/Application Support/DSHDesktop/vendor` | **种子**：首次启动拷贝一份 |
| Linux | `$XDG_DATA_HOME/dsh-desktop/vendor`（缺省 `~/.local/share/…`） | 同上 |

**为什么 macOS/Linux 要拷一份**：DSH 更新按钮要"换树"，而换树靠目录改名（rename）。macOS 的包内
内容不可改（改了就**破坏代码签名**，开 hardened runtime/公证后甚至拒绝启动），Linux AppImage 的
`resources` 是**只读挂载**、deb 装到 `/opt` 又属 root —— 所以可变的那棵树必须放在用户可写的位置。

几条实用事实：

- **首启会慢一点**（拷 100 MB 上下，机械盘上数秒）；之后启动不再拷贝。
- **它不会被种子覆盖**：包内那份只在"目标不存在"时拷一次。你换到更新版本的树之后，重装/升级应用
  **不会**把你的树退回旧版。
- **包内那份坏不了你的应用**：如果用户目录里的树残缺（拷贝失败/磁盘满/手工删过），应用会**回退用包内
  种子**并在日志里写明——本次不换树，但应用照常能起。
- **想重置**？删掉上面表格里"实际使用"的那一行目录即可，下次启动会重新从包内种子拷一份。
- 排障入口：`--doctor` 会打印 **vendor 归属**（用的是用户数据目录那棵还是包内种子、各自可不可用），
  `--diag` 的路径段把**实际使用的树 / 包内种子 / staging 暂存区**三者并列列出。

## 自带插件

两个插件都落在 DSH 的 out-of-tree 插件位（`profiles/web/node_modules/<包名>`），不打补丁进 DSH 源码：

| 插件 | 侧 | 作用 |
|---|---|---|
| `dsh-desktop-ui` | 客户端 | 设置面板新增「桌面」分区（背景图 / 遮罩 / 亮度 / 模糊）并注入按钮交互样式 |
| `dsh-auto-approval` | 服务端 | 审批瀑布上抢在用户弹窗之前裁决：关键词表只作证据，裁决权交给一次独立模型调用（fail-closed）；`/approval` 开关；日志 `$DSH_HOME\logs\auto-approval.log` |

改动生效方式不同：客户端插件改完 `POST /api/reload-window` 刷新即见；服务端插件**必须重启宿主**
（托盘「重启宿主（重载插件）」）；改 `src/*.mjs` 要重打 asar + 重启应用。

## 排障

### ① 先读宿主日志——真因只在这里

```powershell
Get-Content "$env:LOCALAPPDATA\DSHDesktop\logs\host.log" -Tail 30
```

托盘通知里那句「DSH 宿主意外退出 exit code=1」是**壳**发的，`code` 只是宿主子进程的退出码。
DSH 侧 `code=1` 的唯一来路是启动期插件树装载失败（`dsh-app-boot` 的 `installFailLoud()` 把
`fatal load failure: <stack>` 写进 stderr），而壳把宿主 stdout/stderr 全量重定向进上面这个文件。

**先按日志一分为二**：日志为空或只有一行 `--- run … ---` ⇒ 宿主根本没起来（外部因素）；
出现 `fatal load failure` + 堆栈 ⇒ 宿主起来了但装载失败（数据/依赖因素）。

### ② 两类机器，排查方向完全不同

**第 1 类：留着旧数据的机器**（装过早期版本，或恢复出厂但保留了用户目录）。
卸载程序**不删用户数据**（`deleteAppDataOnUninstall: false`），而新版一定会去读那棵旧目录，解析顺序是
`DSH_HOME` 环境变量 → `%USERPROFILE%\.dsh`（存在就用）→ `%LOCALAPPDATA%\DSHDesktop\dsh-home`。
**不要反复卸载重装**（重装碰不到 `%USERPROFILE%\.dsh`），处置是**改名**（不删数据，可随时改回）：

```powershell
Rename-Item "$env:USERPROFILE\.dsh" ".dsh.bak" -ErrorAction SilentlyContinue
Rename-Item "$env:LOCALAPPDATA\DSHDesktop\dsh-home" "dsh-home.bak" -ErrorAction SilentlyContinue
```

别删 `%LOCALAPPDATA%\DSHDesktop\settings.json`——那是壳自己的设置（工作区 / 自启 / 背景图），与故障无关。

**第 2 类：全新环境**（Windows 重装过 / 首次使用这台机器）。旧数据理论不成立，改查"环境是否允许它跑"：

| 现象 / 检查点 | 真因 | 处置 |
|---|---|---|
| `host.log` 空或只有 `--- run … ---` | 进程被外部挡住（杀软 / EDR / 组策略） | 查 Defender 保护历史与第三方杀软隔离区；把 `%LOCALAPPDATA%\Programs\DSH Desktop` 与 `%LOCALAPPDATA%\DSHDesktop` 加白名单 |
| `%USERPROFILE%` 含中文/空格/特殊字符 | 原生模块在非 ASCII 路径下的经典故障 | 新建纯英文账户、或把安装目录与工作区换到纯英文路径试一次 |
| 系统装过 Node/nvm，留下全局环境变量 | `NODE_OPTIONS` 注入 `ELECTRON_RUN_AS_NODE` 子进程使其启动即崩；`DSH_BIN` 让壳优先用全局 npm 的 dsh（版本不匹配） | `[Environment]::GetEnvironmentVariable('NODE_OPTIONS','User')` 等逐个查空，有则清掉后重开应用 |
| `vendor\profile\node_modules` 文件数少于 `vendor.lock.json` 的 `nodeModulesFiles`（当前 11,175） | 解压不完整（杀软吃掉 / 磁盘满） | 重装该安装包；装前确认磁盘余量 |
| Windows 是 N/KN 版，或 build < 19045 | 缺 Media Foundation / 低于基线 | 装 Media Feature Pack；`--doctor` 会直接报 Windows 版本一项 |
| 以上都不适用 | 需要 `host.log` 原文堆栈才能定性 | 把 `host.log` 尾部 30 行发出来 |

### ③ 退出码语义

| code | 含义 |
|---|---|
| `1` | 宿主启动期失败（见上） |
| `2` | 壳没找到可用的 dsh 入口（用了全局 npm 的旧 dsh，或包内 vendor 缺件），或 `ELECTRON_RUN_AS_NODE` 泄漏 |
| `3` | 同一 `DSH_HOME` 已有实例（走复用，不是故障） |

### ④ 常见日志特征

| `host.log` 特征 | 真因 | 处置 |
|---|---|---|
| `credentials-local: …`（`invalid document` / `must be a mapping` / `unknown top-level key`） | `.credentials.yaml` 被手工改坏（标准扁平旧版会自动迁移，不报错） | 改名该文件即可，其余数据不动 |
| `settings-file: invalid document at …` | `settings.yaml` 语法坏了（启动读盘是硬抛，只有热重载才降级为 warn） | 改名 `settings.yaml` |
| `fatal load failure:` + 点名某个包的解析栈 | 包内 node_modules 缺件 / 被杀软隔离 | 核对 `node_modules` 文件数（应等于 `vendor.lock.json` 的 `nodeModulesFiles`） |

### ⑤ Linux / macOS 专属故障（Windows 上不会遇到）

这些形态都在跨平台实现里出现过，处置方式与 Windows 完全不同——**先按这张表分类，别去翻 Windows 的排障思路**。

| 现象 | 真因 | 处置 |
|---|---|---|
| 启动即退、**连日志都没有** | 旧版的模块顶层病理（`LOCALAPPDATA` 未定义）；**0.4.6 起的版本已修** | 若真是这个形态，先确认版本；`--diag` 会打印系统与路径段 |
| 命令一律被拒（"refusing to run the command unconfined" 之类） | **DSH 的沙箱后端不可用**：Linux 缺 `bwrap`（bubblewrap），或内核不支持 Landlock；macOS 缺 `sandbox-exec` | Linux：`apt install bubblewrap`；或把会话预设切到"完全权限"（`danger-full-access`）。**这是 fail-closed，不是壳坏了** |
| 窗口关掉后再也找不回来 | 托盘"创建成功但不可见"（GNOME 未装 AppIndicator 扩展 / 缺 libappindicator），旧版仍会隐藏窗口 | 优先从**托盘或 Dock** 唤回；`trayUsable=false` 时新版会自动关闭"关闭到托盘"（设置面板可查看）。兜底：`pkill -f 'DSH Desktop'` 后重开 |
| 终端/持久 shell 不可用，但文件读写正常 | macOS：`node-pty` 的 `spawn-helper` 缺可执行位。**Linux 上没有 spawn-helper**（`src/unix/pty.cc` 的 helper 分支只编 `__APPLE__`，Linux 走 `forkpty()`），Linux 上出现这个症状要查 `prebuilds/linux-<arch>/pty.node` 在不在、能不能加载 | macOS 确认 `node-pty/prebuilds/darwin-<arch>/spawn-helper` 是 `0755`；Linux 跑 `--doctor` 看原生模块加载结论，或 `node scripts/verify-cross-tree.mjs` 查平台包 |
| 附件/图片处理异常 | `sharp` 缺本平台二进制（会退到 wasm32，功能受限但不崩） | 跑 `--doctor` 看"依赖完整性"；必要时删掉用户数据目录里的 vendor 让它重新拷种子 |
| `dsh://` 点了没反应 | 协议未注册（Linux 需 `.desktop` + `xdg-mime`；macOS 需 `Info.plist`）或**没有已运行实例**（Windows/Linux 靠第二个实例把 URL 送进来） | 先启动应用再点；`--doctor` 的"vendor 归属"下方会显示最近一次深链是否送达（记在 `app.state.json` 的 `lastDeepLink`） |
| 多开窗口后出现两个宿主、日志 seq 撞号 | 旧版端口探测依赖 `netstat.exe`，非 Windows 上失效 ⇒ 宿主复用判断退化 | 0.4.6 起改用 `ss`/`lsof`；确认只有一个 `dsh web` 进程（`pgrep -af 'dsh.*web'`） |
| 日志找不到 | macOS/Linux **不在**应用数据目录下 | macOS `~/Library/Logs/DSHDesktop`；Linux `$XDG_STATE_HOME/dsh-desktop/log`（见上文"各平台的数据与日志目录"） |

> 排查顺序建议与 Windows 一致：先 `--diag`（它会打印系统、路径、vendor 归属、宿主锁、三份日志尾部），
> 再按上表分类。**不要**用 Windows 的记忆去猜 Linux 的路径或 macOS 的证书行为。

## 许可

[MIT](../LICENSE)
