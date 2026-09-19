# DSH Desktop · Electron 壳

把 **DeepSeek Harness（DSH）** 的 Web 界面托管成桌面应用：主进程以 `ELECTRON_RUN_AS_NODE` +
`--expose-internals` 把 electron 可执行文件当 Node 用，托管 `dsh web` 宿主子进程，再用 `BrowserWindow`
加载回环地址 —— 界面始终是 DSH 自己的界面，**DSH 本体零改动**。

**支持平台**：Windows 10/11（NSIS x64）与 Linux（AppImage/deb x64）**均已实测出包**。两平台差异集中在
`src/platform-paths.mjs` 与 `vendor` 树（必须按目标平台构建）；构建链路在 `scripts/`（`build-host.mjs` 建树、
`linux/` 出 Linux 包）。

> 本目录是**代码侧 README**（开发 / 构建 / 排障）；功能总览与安装引导见仓库根 [`../README.md`](../README.md)。

## 版本锚点
| 项 | 值 | 来源 |
|---|---|---|
| 壳版本 | **0.4.7** | [`VERSION`](VERSION) |
| DSH 运行时 | `@deepseek-ai/dsh`、`dsh-base`、`dsh-web-app` 均为 **0.1.6-alpha.1** | [`vendor/vendor.lock.json`](vendor/vendor.lock.json)（三包同进同退） |
| Node / Electron | 24.18.1 / 43.4.0 | 同上 |
| 自包含运行时 | **11,168 个文件 / 104.4 MB**（构建期剪枝掉 14,279 个文件；Linux 103.1 MB） | 同上（`totalFiles` / `totalBytes` / `prunedFiles`） |
| 原生模块 ABI 门禁 | `PASS` | 同上 |
| 目标平台 | Windows x64 / Linux x64 | 同上（`platform` 段记录 `{os, arch, libc}`） |

## 目录结构
```
desktop-electron/
├─ package.json / .npmrc / electron-builder.yml / VERSION
├─ src/                       # 壳代码（会进 asar，`files: src/**`）
│  ├─ main.mjs                #   主进程：多窗口、宿主编排（复用已有实例）、托盘、协议、退出、背景图注入
│  ├─ platform-paths.mjs      #   平台路径与二进制解析（两平台 data/log/home/workspace + electron 可执行文件）
│  ├─ node-guard.mjs          #   最先导入：防 ELECTRON_RUN_AS_NODE 泄漏
│  ├─ early-errors.mjs        #   第二个导入：打包态未捕获异常落盘（零依赖，自算日志路径）
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
├─ build/                     # 图标资源：icon.ico / icon.png / icons/*.png
├─ vendor/vendor.lock.json    # 运行时版本、平台三元组与文件数基线（vendor/profile 由 build:host 生成，不入库）
└─ dist/                      # 安装包产物（不入库，发布走 GitHub Releases）
```
> **会进安装包的只有 `src/**` + `VERSION` + `package.json`**（外加 `extraResources` 里的 vendor 树、patch 与
> 图标）：新增"打包态要调用"的能力**不能放 `scripts/`**，它不进包。

## 开发运行
前提：Node.js 22+、构建 vendor 时可访问 npm registry。**支持 Windows / Linux**：壳侧平台差异集中在
`src/platform-paths.mjs`（路径与二进制名），vendor 树**必须按目标平台构建**（`koffi` / `node-pty` /
`node-addon-system-<plat>` 都是预编译二进制，装错平台宿主起不来）。

| 命令 | 作用 |
|---|---|
| `npm install` | 安装壳的依赖 |
| `npm run build:host` | 生成/重建 vendor/profile（含插件同步、平台包门禁与 ABI 门禁；首次或依赖变更后必跑） |
| `npm start` / `npm run dev` | 窗口模式（后者保留 DevTools 与默认菜单） |
| `npx electron . --headless` | 无窗口常驻（设置页在 `http://127.0.0.1:<port>/`，端口见宿主锁或壳日志） |
| `npx electron . --doctor` | 环境体检：系统版本 / dsh CLI 路径 / agent shell（Win: pwsh，POSIX: bash）/ 沙箱后端（POSIX）/ `DSH_HOME` / 工作区 / 磁盘余量 |
| `npx electron . --diag` | 一键取证：路径、环境变量、preflight、宿主锁与 stdio 模式、依赖文件数、三份日志尾部 → 同时写日志目录下的 `diag-report.txt` |
| `npm run smoke` | 端到端全量冒烟（**72 断言**，需完整权限）；打包产物用 `dist/<平台 unpacked 目录>/… --smoke` |
| `npm run build:host -- --os linux --cpu x64` | **交叉构建**另一平台的 vendor 树（npm 10 起支持；发布仍建议在目标平台原生构建） |
| `npm run dist` / `dist:linux` | 打安装包：NSIS（Windows）/ AppImage+deb（Linux）；`dist:current` 按当前平台自动选 |

启动参数还有 `--autostart on|off`、`--set-ws <绝对路径>`、`--register`（注册开机自启与 `dsh://` 协议）、`--version`。
> **注意**：被托管环境里跑 electron 前先清掉 `ELECTRON_RUN_AS_NODE`（Windows `Remove-Item Env:ELECTRON_RUN_AS_NODE`，
> POSIX `unset ELECTRON_RUN_AS_NODE`）：它会让 electron 执行文件退化成纯 Node，症状是"无窗口、无日志"。

### 各平台的数据与日志目录
| 平台 | 应用数据（设置/状态/Electron profile） | 日志 | DSH 用户数据 |
|---|---|---|---|
| Windows | `%LOCALAPPDATA%\DSHDesktop` | 同左 `\logs` | `%USERPROFILE%\.dsh` |
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
**30 套离线自检 + `smoke` 72 断言**；改动后全绿才算完成，**权威数字由 `npm run test:suite` 打印**。
清单以 `scripts/test-suite.mjs` 为唯一来源（本地与 CI 共用）：

```bash
npm run test:suite            # 全部套件，输出每套的 pass/fail 与总数
node scripts/test-suite.mjs --list           # 只列清单
node scripts/test-suite.mjs --only platform  # 只跑匹配的套件（改哪块跑哪块）
```
下表逐行断言数由人维护（`scripts/ci-self-test.mjs` 只核对套件总数与"每一套都有行"）；与脚本输出不一致时以脚本为准并改表。

| 脚本 | 断言 | 说明 |
|---|---|---|
| `scripts/smoke.mjs` | **72** | 端到端全量冒烟：admin 面 + 背景图 + 皮肤遮罩 + browse 钉住 + DSH 更新面 + 优雅退出 |
| `scripts/vendor-build-self-test.mjs` | 113 | vendor 构建原语：按目标平台剪枝、平台包门禁（Windows 含 conpty 三件套）、spawn-helper 权限位、交叉构建门禁延后、glibc/musl ABI 判定；宿主秒退时须把子进程 stderr 带回报错 |
| `scripts/ci-self-test.mjs` | 159 | CI 配置与门禁清单自查：两平台矩阵（多一个 runner 即红）、产物 glob、清单与磁盘一致、打包配置、递归删除入口、交叉构建延后契约、打包前 vendor 平台核对、shell 脚本行尾/BOM、图标纯 Node 生成、跨平台内容一致性（版本锁）、托盘三条"打开主窗"入口、README 数字 |
| `scripts/dsh-apply-self-test.mjs` | 44 | 换树与标记状态机（全同步，每条失败分支一条断言） |
| `scripts/cross-tree-self-test.mjs` | 44 | vendor 树静态体检判据 + 并入同平台另一架构的合并（缺件 / 串平台 / 假绿 / 并入架构缺件 / 跨平台+跨架构污染都必须报错） |
| `packages/dsh-auto-approval/test/apply-self-test.mjs` | 47 | 审批接线（mock ctx 驱动 apply） |
| `scripts/update-self-test.mjs` | 36 | 版本发现与比较（脱网） |
| `scripts/vendor-home-self-test.mjs` | 25 | vendor 归属与种子迁移 |
| `scripts/platform-self-test.mjs` | 21 | 平台路径与二进制解析（两平台 data/log/home/workspace + electron 可执行文件） |
| `scripts/vendor-baseline-self-test.mjs` | 21 | 依赖完整性判据（基线读取三态 + 缺件阈值 + "基线缺失不得判为通过"） |
| `scripts/junction-safe-self-test.mjs` | 23 | 含链接目录的安全删除（建真 junction 验证目标不被掏空）+ 残留门禁目录年龄判据的时钟护栏（POSIX btime 与 `Date.now()` 双时钟源） |
| `scripts/patch-mount-self-test.mjs` | 17 | profile 补丁层挂载与自愈（测 `src/profile-mount.mjs` 真实现，含真实坏文件样本） |
| `scripts/skin-settings-self-test.mjs` | 44 | 外观设置迁移规则（测 `src/skin-settings.mjs`：只补缺失、已有键绝不覆盖（含 `false`/`0`）、毛玻璃仅在壁纸存在时默认开、快照写存储值而非渲染值、`null` 不当成 0、强度 < 0.5 归位默认且只做一次） |
| `scripts/bg-css-self-test.mjs` | 27 | 壁纸注入 CSS 生成物（测 `src/bg-css.mjs`：固定层/z-index/外扩/破缓存参数、置透明选择器必须命中真实元素路径、主题变量四处覆盖、`null` 不当成 0） |
| `scripts/host-platform-self-test.mjs` | 14 | 宿主托管平台分支（dsh 入口发现的两平台布局 + 进程树终止） |
| `packages/dsh-auto-approval/test/grade-self-test.mjs` | 10 | 审批分级器（纯函数） |
| `scripts/jpeg-decode-self-test.mjs` | 10 | 图标解码器（自写 JPEG 解码：非纯色/彩色保留/无块状伪影/多扫描/异常路径） |
| `scripts/check-assets-self-test.mjs` | 9 | 打包前置检查（vendor 平台与打包目标不符必须挡住；交叉打包声明目标后不得误挡） |
| `scripts/check-vendor-lock-self-test.mjs` | 9 | 版本锁一致性判据（缺直接依赖 / 版本不满足范围 / lockfileVersion 不对 / 锁损坏都必须拦住） |
| `scripts/repair-self-test.mjs` | 8 | 会话日志自愈 |
| `scripts/admin-bg-test.mjs` | 7 | admin 背景图（纯 Node） |
| `scripts/market-install-self-test.mjs` | 30 | 市场安装链路的失败分支（哈希不符 / 包名与 id 不一致 / 撞自带插件名 / 已装过 / 下载失败），每条都断言**不留半成品** |
| `scripts/market-install-official-self-test.mjs` | 27 | 官方安装路径（`dsh plugin add`）：坐标校验（分支/标签必须钉成 40 位 commit）、缺 pnpm 的处置、构建脚本被拦单独分档、超时、"退出码 0 但清单无痕迹判失败" |
| `scripts/tray-icon-self-test.mjs` | 21 | 托盘/窗口图标平台判据 + 三条"打开主窗"入口：Linux 的图标解码**不认 `.ico`**、Linux 上 `double-click` 事件不存在、菜单第一项必须是"打开主窗口" |
| `scripts/harness-compat-self-test.mjs` | 38 | harness × Electron 运行时兼容判据：白名单**从 addon 二进制原字节解析**（唯一副本，无 JS/JSON 版）、三态判定（拦 / 警告 / 放行）、**读不到白名单必须放行**、显式逃生口 `DSH_UPDATE_ALLOW_INCOMPATIBLE=1`、判据**接在 `npm install` 之前** |
| `scripts/pnpm-resolve-self-test.mjs` | 24 | pnpm 定位判据：候选路径派生（与 npm 锚点同源）、`node <pnpm.cjs>` 直调优先、PATH 兜底、找不到时报出找过哪些地方、把 pnpm 目录**注入子进程 PATH** |
| `scripts/zip-safe-self-test.mjs` | 27 | 安全解包（恶意 zip 夹具：zip-slip、绝对路径、反斜杠歧义、ADS、zip64、加密包） |
| `scripts/client-plugin-load-self-test.mjs` | 34 | 客户端插件装载期 + 渲染期（真跑 `factory` 并**真渲染**每个注册组件：模块体引用未定义标识符 / `apply()` 抛错 / 模块面形状不对 / 组件渲染期抛错） |
| `scripts/repo-update-self-test.mjs` | 61 | 平面 C「按 GitHub 仓库文件更新功能」：清单整份校验（schema / 重复 id / 未知 kind / 路径穿越 / sha256 形状 / 尺寸与文件数上限）、只下"缺的或变了的"、**校验失败一个字节都不写**、分档失败、账本健壮性、与"每次启动同步随包副本"的冲突，以及壳/界面/托盘接线；并证明入库的 `components.json` 与 `packages/`、`src/` 内容逐字节一致 |
| `scripts/shell-hot-update-self-test.mjs` | 43 | 按钮热更新 dshdt 自身：asar 补丁器（只换指定文件、保留 asar 内 `node_modules`、重算 integrity、拒绝路径穿越与超单块上限）+ `@electron/asar` 充当独立裁判读回校验 + 换壳编排（换新 asar 时现网文件不动）+ 可写性探测（Linux deb/AppImage 必须如实拒绝）+ 助手脚本端到端（成功与回滚两条路都测） |
| `scripts/ci-shell-syntax-self-test.mjs` | 3 | CI shell 脚本语法门禁：引号/反引号配平扫描（单引号内容不计）+ `bash -n` 真语法检查（无 bash 时**如实标注跳过**） |

**权限口径**：`smoke.mjs` 会起 Electron，**需要完整权限**（受限沙箱下 mojo 命名管道被拦，表现为"壳状态文件
超时"，不是壳的缺陷）；Linux CI 用 `xvfb-run -a` 提供显示。打包产物的 `--smoke` **退出码不可信**，判据取输出里的
`N/N PASS`，必要时再核 `SMOKE OK`。

### CI（两平台矩阵）
`../.github/workflows/release.yml` 有三个 job：`self-test`（两平台 matrix 各跑一遍 `test:suite` + 版本锁 strict
核验）、`windows`（NSIS）、`linux`（AppImage+deb）；推 `v*` tag 或手动
`workflow_dispatch` 触发。**每个 job 都在目标平台原生构建**（vendor 树按平台装，交叉构建只在开发态省事）。
**CI 配置本身也有门禁**：`scripts/ci-self-test.mjs` 在 `test:suite` 里，改 CI 或清单写错会当场红，不必等推 tag。

发布前另有一条联网门禁（不在离线套件里，因为它要联网）：

```bash
node scripts/check-vendor-lock.mjs            # 脱网：直接依赖在锁里且版本满足范围
node scripts/check-vendor-lock.mjs --strict   # 联网：npm ci --dry-run，校验"锁与 manifest 是同一套"
```
`--strict` 是完整判据（能拦住 DSH 版本变了、清单多了依赖、锁缺失、锁损坏四种漂移），CI 里挂在两个打包 job
**之前**的 `self-test` job 上——锁不对，两平台产物就不该被生产出来。

签名 Secrets（未配置则出未签名包）：Windows `WINDOWS_CERT_PFX` / `WINDOWS_CERT_PASSWORD`。

**辅助工具**（非门禁）：`scripts/boot-smoke.mjs`（宿主链路冒烟，无 GUI 也能跑）、`scripts/bootgate-verify.mjs` 与
`scripts/bootgate-destruct-test.mjs`（启动门禁正/负测试，需 `DSH_INSTALL_DIR` 指向已安装应用）、
`scripts/vendor-equivalence.mjs`（暂存树等价性验证，换树前跑）、`scripts/abi-scan.mjs` 与 `scripts/build-host.mjs`
（CLI 薄封装，实现在 `src/`，支持 `--os/--cpu/--libc` 交叉构建）、`scripts/gen-icon.mjs`（Windows/Linux 图标 ico/png + linux 图标目录）、
`scripts/dev-sign.ps1`（Windows 自签）。

## 构建与打包
两平台各自在目标平台上执行（`build:host` 产出的是**该平台**的 vendor 树）：

```bash
# Windows（x64）
npm run build:host && npm run dist          # → dist/DSHDesktop-Setup-<版本>.exe（NSIS）

# Linux（x64）
npm run build:host && npm run dist:linux    # → dist/DSHDesktop-<版本>-x86_64.AppImage + .deb
# 依赖：libarchive-tools/fakeroot/rpm（deb 打包用）；AppImage 运行端建议装 libfuse2
# 建议随包声明 bubblewrap：DSH 的 Linux 沙箱后端，缺失时 agent 命令会被 fail-closed 拒绝
```
- **vendor 树按平台构建**：`vendor.lock.json` 的 `platform` 段记 `{os, arch, libc}`，`platformPackages` 记本平台
  必需的原生包（koffi / node-pty / node-addon-system(flock) / sharp / ripgrep）；**平台包门禁**缺任一项即拒绝产出
  （否则宿主 `import` 期起不来或会话写不进去）。Windows 的"node-pty 齐备"指 **conpty 三件套**（`conpty.node` +
  `conpty_console_list.node` + `conpty/conpty.dll` + `conpty/OpenConsole.exe`）；`pty.node` 是 Unix 实现，Windows 没有。
- **交叉构建**：`npm run build:host -- --os linux --cpu x64 --out .tmp-cross/linux-x64`（npm 10 起支持
  `--os/--cpu/--libc`，7 个平台包都是预编译产物；发布仍建议在目标平台原生构建）。① **必须带 `--out`**，否则顶替
  现网 `vendor/` 会让本机应用起不来；② **ABI 与启动门禁延后**（都要 spawn 目标平台运行时）：lock 里写
  `abiScan: "DEFERRED（交叉构建，需在目标平台补跑）"` 与 `gatesDeferred: {abi:true, boot:true}`，**"PASS" 只会出现在
  真跑过门禁的平台上**；③ `node scripts/verify-cross-tree.mjs --dir <目录>` 静态体检（平台包、别平台残留、prebuilds、
  体量），目标平台默认取 lock 的 `platform` 段——**它替代不了目标平台上的门禁**。
- **`--prune-only` 是维护入口**：`npm run build:host -- --prune-only` 在现网树上原地做剪枝 + 插件同步 +
  平台包/ABI/启动门禁并刷新 `vendor.lock.json`，与完整构建的区别是**不重装依赖**（共用 `buildVendorLock`）。
- **产物不进仓库**：`dist/` 在 `.gitignore` 里，安装包只作为 **GitHub Release 附件**分发。
- **在哪台机器上能打出哪个包**：

  | 目标 | Windows 直出 | 经 WSL Debian | 说明 |
  |---|---|---|---|
  | Windows NSIS | ✅ | — | 不需要 makensis（electron-builder 自带工具链） |
  | Linux `dir` / `tar.gz` | ✅ | ✅ | 需 `--publish never`，且 `vendor/` 必须是 linux 树 |
  | Linux `AppImage` | ❌ | ✅ | 要 `mksquashfs`（electron-builder 的 appimage 工具链只带 POSIX 那一份） |
  | Linux `deb` | ❌ | ✅ | 要 `fakeroot`/`rpm`/`ar`（`ar` 来自 `binutils`，漏了报 `Need executable 'ar' to convert dir to deb`） |

- **在 WSL 里出 Linux 安装包**：

  ```powershell
  # 前置（一次性）：wsl --install -d Debian
  pwsh -File scripts\linux\build-linux.ps1              # 依赖 → 准备 → 打包 → 冒烟，全流程
  pwsh -File scripts\linux\build-linux.ps1 -Stage pack  # 只打包
  ```
  分阶段脚本：`install-deps.sh`（系统依赖）、`prepare-build-tree.sh`（拷进 ext4 + `npm ci` + 建 linux vendor 树）、
  `build-installers.sh`（AppImage + deb）、`packaged-smoke.sh`（在真 Linux 内核上跑打包产物）、`verify-installers.sh`
  （deb 真装一遍、AppImage 解开跑一遍）。必须在 Linux 里跑：`mksquashfs`/`fpm`/`ar` 在 Windows 上不存在；`chrome-sandbox`
  要 `4755`，drvfs 保不住权限位（仓库先拷进 ext4）。
- **Linux 产物**：`packaged-smoke.sh` 输出 `SMOKE OK`、`cleanup: code=0`；首启把包内 vendor 拷成用户数据目录里的种子
  （11,142 文件 / 103.1 MB），之后用用户数据目录那棵树。环境要求：`xvfb-run`（含 `xauth`，漏了报 `xauth command not found`、
  退出码 3）；root 跑 Chromium 需 `--no-sandbox`（仅测试环境）。
- **AppImage 双击路径单独验**（`scripts/linux/appimage-direct-run.sh`）：双击走 **FUSE 挂载**，与 `--appimage-extract`
  是两条不同的路，故障点也不同（缺 fuse、libfuse 版本、`/tmp` noexec）；每次运行单独落日志并打印走的是哪条路。
  前置：`apt install fuse3 libfuse2t64`（否则无 `/dev/fuse`，脚本明确跳过并标注未测）。
- **两平台包内容一致靠一份版本锁**：manifest 只钉三个 DSH 包的精确版本，**传递依赖是范围声明**
  （`zod: ^4.4.3`、`node-addon-require-builtin: ^0.1.4`、`@types/node` 由 `protobufjs` 的 `>=13.7.0` 拉进来）。仓库里放
  一份**平台中立**的 `vendor/package-lock.json`（587 个包，含全部平台专属条目），两平台都用它装；装前把锁拷进
  `profile/`（npm 只认 cwd 下的锁）；**用 `npm install` 消费而不是 `npm ci`**（锁来自某一个平台，其
  `optionalDependencies` 带平台专属包，`npm ci` 的全量校验在别的平台必然失败）；缺锁退回"各装各的"并打提示。
  核对工具：`node scripts/compare-packaged-vendor.mjs`（逐包比对各平台**打包产物内**的树）；改 DSH 版本后
  `npm install --package-lock-only` 重新生成锁。
- **打包自动核对 vendor 平台**：`predist*` 钩子里的 `scripts/check-assets.mjs` 比对 `vendor.lock.json` 的 `platform.os`
  与打包目标，不符**直接拒绝打包**（`extraResources` 是整目录照拷，electron-builder 不看二进制属于哪个平台）；
  交叉打包用 `DSH_PACK_PLATFORM=<os>` 声明目标即可放行。
- **包体为什么大**：安装包内自带整棵 DSH 运行时（Windows 104.4 MB / Linux 103.1 MB）。安装耗时主要跟**文件数**相关
  （解压 + Defender 逐文件扫描），所以剪枝优先砍文件数而不是字节数
  （`.map` / `.d.ts` / `.md` / 许可证 / `.pdb` 都会剪掉）。
- **签名**：Windows 未签名时首次运行有 SmartScreen 提示（本地开发可自签，见下）；壳自更新要求已签名。
- **构建机无需 makensis**：electron-builder 自带 NSIS 工具链；直调
  `node node_modules/electron-builder/out/cli/cli.js --win nsis` 可绕开 npx 垫片。

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
装上之后安装目录里会有一个 **100–105 MB 的 `vendor` 目录**，即自带的那棵 DSH 运行时（"免装 DSH、双击即用"的代价）：

| 平台 | 实际使用的那棵树 | 包内那份的角色 |
|---|---|---|
| Windows | `resources\vendor`（安装目录内，可写） | 就是它本身 |
| Linux | `$XDG_DATA_HOME/dsh-desktop/vendor`（缺省 `~/.local/share/…`） | **种子**：首次启动拷贝一份 |

**为什么 Linux 要拷一份**：DSH 更新按钮要"换树"，而换树靠目录改名（rename）。Linux AppImage 的 `resources` 是
**只读挂载**、deb 装到 `/opt` 又属 root —— 所以可变的那棵树必须放在用户可写的位置。

- **首启会慢一点**（拷 100 MB 上下）；之后启动不再拷贝。
- **它不会被种子覆盖**：包内那份只在"目标不存在"时拷一次；换到更新版本的树之后，重装/升级应用**不会**退回旧版。
- **包内那份坏不了你的应用**：用户目录里的树残缺（拷贝失败/磁盘满/手工删过）时，回退用包内种子并在日志里写明。
- **想重置**：删掉上表"实际使用"的那一行目录，下次启动会重新从包内种子拷一份。
- 排障入口：`--doctor` 打印 **vendor 归属**（用的是用户数据目录那棵还是包内种子、各自可不可用）；`--diag` 的
  路径段把**实际使用的树 / 包内种子 / staging 暂存区**三者并列列出。

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
托盘通知里那句「DSH 宿主意外退出 exit code=1」是**壳**发的，`code` 只是宿主子进程的退出码。DSH 侧 `code=1` 的
唯一来路是启动期插件树装载失败（`dsh-app-boot` 的 `installFailLoud()` 把 `fatal load failure: <stack>` 写进
stderr），而壳把宿主 stdout/stderr 全量重定向进上面这个文件。

**先按日志一分为二**：日志为空或只有一行 `--- run … ---` ⇒ 宿主根本没起来（外部因素）；出现
`fatal load failure` + 堆栈 ⇒ 宿主起来了但装载失败（数据/依赖因素）。

### ② 两类机器，排查方向完全不同
**第 1 类：留着旧数据的机器**（装过早期版本，或恢复出厂但保留了用户目录）。卸载程序**不删用户数据**
（`deleteAppDataOnUninstall: false`），而新版一定会去读那棵旧目录，解析顺序是 `DSH_HOME` 环境变量 →
`%USERPROFILE%\.dsh`（存在就用）→ `%LOCALAPPDATA%\DSHDesktop\dsh-home`。**不要反复卸载重装**（重装碰不到
`%USERPROFILE%\.dsh`），处置是**改名**（不删数据，可随时改回）：

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

### ⑤ Linux 专属故障（Windows 上不会遇到）
**先按这张表分类，别去翻 Windows 的排障思路**：

| 现象 | 真因 | 处置 |
|---|---|---|
| 启动即退、**连日志都没有** | 旧版模块顶层的病理（`LOCALAPPDATA` 未定义） | 先确认版本；`--diag` 会打印系统与路径段 |
| 命令一律被拒（"refusing to run the command unconfined" 之类） | **DSH 的沙箱后端不可用**：Linux 缺 `bwrap`（bubblewrap），或内核不支持 Landlock | Linux：`apt install bubblewrap`；或把会话预设切到"完全权限"（`danger-full-access`）。**这是 fail-closed，不是壳坏了** |
| 窗口关掉后再也找不回来 | 托盘"创建成功但不可见"（GNOME 未装 AppIndicator 扩展 / 缺 libappindicator），旧版仍会隐藏窗口 | 优先从**托盘**唤回；`trayUsable=false` 时新版会自动关闭"关闭到托盘"（设置面板可查看）。兜底：`pkill -f 'DSH Desktop'` 后重开 |
| 终端/持久 shell 不可用，但文件读写正常 | Linux 上出现这个症状要查 `node-pty` 的预编译（`prebuilds/linux-<arch>/pty.node`）是否就位；两平台都不带 `spawn-helper`，看到它就是串了别的平台的树 | 跑 `--doctor` 看原生模块加载结论，或 `node scripts/verify-cross-tree.mjs` 查平台包 |
| 附件/图片处理异常 | `sharp` 缺本平台二进制（会退到 wasm32，功能受限但不崩） | 跑 `--doctor` 看"依赖完整性"；必要时删掉用户数据目录里的 vendor 让它重新拷种子 |
| `dsh://` 点了没反应 | 协议未注册（Linux 需 `.desktop` + `xdg-mime`）或**没有已运行实例**（两平台都靠第二个实例把 URL 送进来） | 先启动应用再点；`--doctor` 的"vendor 归属"下方会显示最近一次深链是否送达（记在 `app.state.json` 的 `lastDeepLink`） |
| 多开窗口后出现两个宿主、日志 seq 撞号 | 宿主复用靠端口探测（`netstat.exe` 在非 Windows 上失效） | Linux 上用 `ss`/`lsof`；确认只有一个 `dsh web` 进程（`pgrep -af 'dsh.*web'`） |
| 日志找不到 | Linux **不在**应用数据目录下 | Linux `$XDG_STATE_HOME/dsh-desktop/log`（见上文"各平台的数据与日志目录"） |

> 排查顺序：先 `--diag`（打印系统、路径、vendor 归属、宿主锁、三份日志尾部），再按上表分类。
> **不要**用 Windows 的记忆去猜 Linux 的路径与证书行为。

## 许可
[MIT](../LICENSE)
