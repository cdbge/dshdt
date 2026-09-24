# DSH Desktop（Electron 壳）

把 **DeepSeek Harness（DSH）** 的 Web 界面托管成桌面应用：主进程以 `ELECTRON_RUN_AS_NODE` + `--expose-internals`
把 electron 可执行文件当 Node 用，托管 `dsh web` 宿主子进程，再用 `BrowserWindow` 加载回环地址。
界面始终是 DSH 自己的界面，**DSH 本体零改动**。

支持平台：**Windows 10/11（x64，NSIS）** 与 **Linux（x64，AppImage / deb）**。
两平台差异集中在 `src/platform-paths.mjs` 与 vendor 树（必须按目标平台构建）。

功能总览与安装引导见仓库根 [README](../README.md)。

## 版本锚点

| 项 | 值 | 来源 |
|---|---|---|
| 壳版本 | 1.0.0 | [`VERSION`](VERSION) |
| DSH 运行时 | `@deepseek-ai/dsh` / `dsh-base` / `dsh-web-app` 均为 0.1.7-rc.1 | [`vendor/vendor.lock.json`](vendor/vendor.lock.json)（三包同进同退） |
| Node / Electron | 24.18.1 / 44.0.0 | 同上（Electron 必须是 harness 白名单内的精确版本，见下） |
| 目标平台 | Windows x64 / Linux x64（`platform` 段记 `{os, arch, libc}`） | 同上 |

## 目录结构

```
desktop-electron/
├─ src/                       # 壳代码（进 asar：files: src/** + VERSION + package.json）
│  ├─ main.mjs                #   主进程：窗口、宿主编排、托盘、深链、背景图注入、更新入口
│  ├─ host.mjs                #   宿主托管：dsh 入口发现 / 端口 / 就绪探测 / 进程树终止
│  ├─ admin.mjs               #   回环 admin HTTP（/api/*、静态页、背景图与图标供给）
│  ├─ platform-paths.mjs      #   平台路径与可执行文件解析
│  ├─ dsh-update.mjs          #   DSH 更新：版本发现（纯 Node，不落盘）
│  ├─ vendor-build.mjs        #   DSH 更新：vendor 树构建原语（install / 剪枝 / 平台包与 ABI 门禁）
│  ├─ dsh-apply.mjs           #   DSH 更新：换树与回滚
│  ├─ repo-update.mjs         #   仓库文件热更新：清单校验 / 增量下载 / 原子落盘 / 账本
│  ├─ asar-patch.mjs          #   asar 原地换件（保留 node_modules、重算 integrity）
│  ├─ shell-update.mjs        #   换壳编排与助手脚本（应用退出后替换 + 冒烟校验 + 失败回滚）
│  ├─ junction-safe.mjs       #   含链接目录的安全删除（自己删树一律走它）
│  ├─ repair.mjs              #   会话日志自愈
│  └─ settings.html           #   壳内设置页
├─ packages/                  # 自带插件：dsh-desktop-ui / dsh-auto-approval / dsh-market
├─ scripts/                   # 构建、门禁与工具（不进安装包）
├─ build/                     # 图标资源：icon.ico / icon.png / icons/*.png
├─ vendor/vendor.lock.json    # 运行时版本与文件数基线（vendor/profile 由 build:host 生成，不入库）
└─ dist/                      # 安装包产物（不入库）
```

新增"打包态要调用"的能力不能放 `scripts/`——它不进安装包。

## 快速开始

前提：Node.js 22+；构建 vendor 时可访问 npm registry。

```bash
npm install
npm run build:host      # 生成 vendor/profile（含插件同步、平台包门禁、ABI 门禁）；首次或依赖变更后必跑
npm start               # 窗口模式；npm run dev 保留 DevTools
```

| 命令 | 作用 |
|---|---|
| `npm run build:host` | 生成 / 重建 vendor/profile（`--os/--cpu/--libc` 可交叉构建，`--prune-only` 在现网树上原地剪枝） |
| `npm start` / `npm run dev` | 窗口模式（dev 保留 DevTools 与默认菜单） |
| `npx electron . --headless` | 无窗口常驻（设置页 `http://127.0.0.1:<port>/`，端口见宿主锁或壳日志） |
| `npx electron . --doctor` | 环境体检：系统版本 / dsh 入口 / agent shell / 沙箱后端 / `DSH_HOME` / 工作区 / 磁盘余量 |
| `npx electron . --diag` | 一键取证：路径、环境变量、preflight、宿主锁、依赖文件数、日志尾部 → 写 `diag-report.txt` |
| `npm run smoke` | 端到端冒烟（72 断言，需完整权限）；打包产物用 `<unpacked>/… --smoke` |
| `npm run dist` / `npm run dist:linux` | 打安装包：NSIS / AppImage+deb（`dist:current` 按当前平台自动选） |

其他启动参数：`--autostart on|off`、`--set-ws <绝对路径>`、`--register`、`--version`、`--smoke`。

> 在被托管环境里运行 electron 前先清掉 `ELECTRON_RUN_AS_NODE`，否则可执行文件会退化成纯 Node（症状是"无窗口、无日志"）。

## 数据与日志目录

| 平台 | 应用数据（设置 / 状态 / Electron profile） | 日志 | DSH 用户数据 |
|---|---|---|---|
| Windows | `%LOCALAPPDATA%\DSHDesktop` | 同左 `\logs` | `%USERPROFILE%\.dsh` |
| Linux | `$XDG_DATA_HOME/dsh-desktop`（缺省 `~/.local/share/dsh-desktop`） | `$XDG_STATE_HOME/dsh-desktop/log` | `~/.dsh` |

设置 `DSH_APP_DATA` 后日志跟着它走（冒烟隔离与便携部署依赖这一点）。

## 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_HOME` | 覆盖 DSH 用户数据目录 |
| `DSH_WS` | 覆盖默认工作区 |
| `DSH_BIN` | 指定 dsh 入口（自动发现顺序：全局 npm → npx 缓存 → 包内 vendor） |
| `DSH_APP_DATA` | 覆盖应用数据目录 |
| `DSH_SMOKE=1` | 跳过注册表 / 登录项 / 协议写入 |
| `DSH_HOST_STDIO=fd` | 强制宿主用 fd 直通 stdio（诊断管道是否被系统拒绝时用） |

## 门禁

**30 套离线自检 + `smoke` 72 断言**，改动后全绿才算完成；权威数字以 `npm run test:suite` 的输出为准。

```bash
npm run test:suite                            # 全部套件
node scripts/test-suite.mjs --list            # 只列清单
node scripts/test-suite.mjs --only platform   # 只跑匹配的套件
```

| 脚本 | 断言 | 说明 |
|---|---|---|
| `scripts/smoke.mjs` | 72 | 端到端冒烟：admin 面、背景图、皮肤遮罩、浏览钉住、更新面、优雅退出 |
| `scripts/vendor-build-self-test.mjs` | 113 | vendor 构建原语：按平台剪枝、平台包门禁（Windows 含 ConPTY 三件套）、交叉构建门禁延后、glibc/musl 判定 |
| `scripts/ci-self-test.mjs` | 159 | CI 配置与门禁清单自查：平台矩阵、产物 glob、清单与磁盘一致、打包配置、行尾/BOM、README 数字 |
| `scripts/repo-update-self-test.mjs` | 61 | 仓库文件热更新：清单整份校验、增量下载、校验失败不落盘、账本、与启动同步的冲突、接线 |
| `packages/dsh-auto-approval/test/apply-self-test.mjs` | 47 | 审批插件接线（mock ctx 驱动 apply） |
| `scripts/dsh-apply-self-test.mjs` | 44 | 换树与标记状态机（每条失败分支一条断言） |
| `scripts/cross-tree-self-test.mjs` | 44 | vendor 树静态体检（缺件 / 串平台 / 假绿 / 并入架构缺件 / 跨平台污染都要报错） |
| `scripts/skin-settings-self-test.mjs` | 44 | 外观设置迁移：只补缺失、已有键不覆盖（含 `false`/`0`）、`null` 不当成 0 |
| `scripts/shell-hot-update-self-test.mjs` | 43 | 换壳：asar 补丁（保留 `node_modules`、重算 integrity）+ 独立裁判交叉验证 + 助手脚本成功与回滚两条路 |
| `scripts/harness-compat-self-test.mjs` | 38 | harness × Electron 兼容判据（白名单从 addon 二进制解析、三态判定、显式逃生口） |
| `scripts/update-self-test.mjs` | 36 | DSH 版本发现与比较（脱网） |
| `scripts/client-plugin-load-self-test.mjs` | 34 | 客户端插件装载期 + 渲染期（真跑 factory 并真渲染） |
| `scripts/market-install-self-test.mjs` | 30 | 市场安装的失败分支，每条都断言不留半成品 |
| `scripts/market-install-official-self-test.mjs` | 27 | 官方安装路径（`dsh plugin add`）：坐标校验、缺 pnpm 的处置、超时、假成功分档 |
| `scripts/zip-safe-self-test.mjs` | 27 | 安全解包（zip-slip / 绝对路径 / ADS / zip64 / 加密包） |
| `scripts/bg-css-self-test.mjs` | 27 | 壁纸注入 CSS 的生成物（选择器必须命中真实元素路径） |
| `scripts/vendor-home-self-test.mjs` | 25 | vendor 归属与种子迁移 |
| `scripts/pnpm-resolve-self-test.mjs` | 24 | pnpm 定位：候选路径派生、`node <pnpm.cjs>` 直调、PATH 兜底 |
| `scripts/junction-safe-self-test.mjs` | 23 | 含链接目录的安全删除 + 残留门禁目录的年龄护栏 |
| `scripts/check-vendor-lock-self-test.mjs` | 9 | 版本锁一致性判据 |
| `scripts/platform-self-test.mjs` | 21 | 平台路径与二进制解析 |
| `scripts/tray-icon-self-test.mjs` | 21 | 托盘图标平台判据 + 三条"打开主窗"入口 |
| `scripts/vendor-baseline-self-test.mjs` | 21 | 依赖完整性判据（基线读取三态 + 缺件阈值） |
| `scripts/patch-mount-self-test.mjs` | 17 | profile 补丁层挂载与自愈 |
| `scripts/host-platform-self-test.mjs` | 14 | 宿主托管的平台分支与进程树终止 |
| `scripts/jpeg-decode-self-test.mjs` | 10 | 图标解码器（自写 JPEG 解码） |
| `packages/dsh-auto-approval/test/grade-self-test.mjs` | 10 | 审批分级器（纯函数） |
| `scripts/check-assets-self-test.mjs` | 9 | 打包前置检查（vendor 平台与打包目标不符必须挡住） |
| `scripts/repair-self-test.mjs` | 8 | 会话日志自愈 |
| `scripts/admin-bg-test.mjs` | 7 | admin 背景图 |
| `scripts/ci-shell-syntax-self-test.mjs` | 3 | CI shell 脚本语法（引号配平 + `bash -n`） |

`smoke.mjs` 会起 Electron，需要完整权限；Linux CI 用 `xvfb-run -a` 提供显示。
打包产物的 `--smoke` 退出码不可信，判据取输出里的 `N/N PASS`（或 `SMOKE OK`）。

### CI 与发布

`../.github/workflows/release.yml`：`self-test`（两平台矩阵跑 `test:suite` + 版本锁 strict 核验）→
`windows`（NSIS）与 `linux`（AppImage + deb）各自在目标平台原生构建 → `release` job 建 Release 并挂安装包与
`latest*.yml`。推 `v*` tag 触发；`workflow_dispatch` 只验证构建。

发布前另有一条联网门禁（不在离线套件里）：

```bash
node scripts/check-vendor-lock.mjs            # 脱网：直接依赖在锁里且版本满足范围
node scripts/check-vendor-lock.mjs --strict   # 联网：npm ci --dry-run，校验锁与 manifest 是同一套
```

标签、`package.json`、`VERSION` 三处版本必须一致，CI 会拦。签名 Secrets（未配置则出未签名包）：
`WINDOWS_CERT_PFX` / `WINDOWS_CERT_PASSWORD`。

`清单门禁` 工作流在每次推 main 时校验热更新清单与源码一致——改了插件或壳源码要跑 `node scripts/gen-components.mjs`
重新生成 `components.json`。

## 构建与打包

```bash
# Windows（x64）
npm run build:host && npm run dist          # → dist/DSHDesktop-Setup-<版本>.exe

# Linux（x64；需 libarchive-tools / fakeroot / rpm，AppImage 运行端建议装 libfuse2）
npm run build:host && npm run dist:linux    # → dist/DSHDesktop-<版本>-x86_64.AppImage + .deb
```

- **vendor 树必须按目标平台构建**：`vendor.lock.json` 的 `platform` 段记目标平台，`platformPackages` 记本平台
  必需的原生包（koffi / node-pty / node-addon-system / sharp / ripgrep）；缺任一项即拒绝产出。
- **交叉构建**：`npm run build:host -- --os linux --cpu x64 --out .tmp-cross/linux-x64`。必须带 `--out`（否则会顶替
  现网 `vendor/`）；交叉构建的 ABI 与启动门禁会标成 `DEFERRED`，需在目标平台补跑。
- **打包自动核对 vendor 平台**：`predist*` 钩子里的 `scripts/check-assets.mjs` 比对 lock 与打包目标，不符直接拒绝；
  交叉打包用 `DSH_PACK_PLATFORM=<os>` 声明目标。
- **包体较大**：安装包内含整棵 DSH 运行时；安装耗时主要跟文件数相关，剪枝优先砍文件数（`.map`/`.d.ts`/`.md`/许可证）。
- **Linux 打包与验证**：`scripts/linux/build-linux.ps1`（依赖 → 准备 → 打包 → 冒烟 → 校验分阶段）；AppImage/deb 必须在
  Linux 上出，`chrome-sandbox` 要 `4755`、`mksquashfs`/`fpm`/`ar` 在 Windows 上不存在。
- **本地自签（可选）**：`pwsh -File scripts\dev-sign.ps1` 生成证书，再设 `CSC_LINK` / `CSC_KEY_PASSWORD` 后 `npm run dist`。

## 更新通道

| 通道 | 说明 |
|---|---|
| DSH 本体更新 | 设置面板按钮：版本发现 → 构建 vendor 树 → 换树（带启动门禁与回滚） |
| 壳自更新 | electron-updater：从 GitHub Releases 取 `latest*.yml` 与安装包 |
| 仓库文件热更新 | 按仓库 `components.json` 增量更新插件 / 补丁层 / 市场目录 |
| 换壳 | 把仓库里的壳源码换进 `app.asar`：应用退出后由助手替换并跑 `--smoke` 校验，失败自动回滚 |

后两条只支持安装目录可写的形态（Linux deb / AppImage 是只读的，会明确降级为"用安装包更新"）。

### vendor 树的位置

| 平台 | 实际使用的那棵树 | 包内那份的角色 |
|---|---|---|
| Windows | `resources\vendor`（安装目录内，可写） | 就是它本身 |
| Linux | `$XDG_DATA_HOME/dsh-desktop/vendor` | 种子：首次启动拷贝一份 |

Linux 的 `resources` 是只读挂载（AppImage）或 root 所有（deb），而换树靠目录改名，所以可变的那棵树放在用户目录。
包内种子只在目标不存在时拷一次；用户目录里的树残缺时回退用种子并在日志里写明。想重置就删掉"实际使用"那一列。

## 自带插件

三个插件都落在 DSH 的 out-of-tree 插件位（`profiles/web/node_modules/<包名>`），不打补丁进 DSH 源码：

| 插件 | 侧 | 作用 |
|---|---|---|
| `dsh-desktop-ui` | 客户端 | 设置面板「桌面」分区（背景图 / 遮罩 / 亮度 / 模糊）+ 按钮样式 |
| `dsh-auto-approval` | 服务端 | 审批瀑布前置裁决（关键词只作证据，裁决交独立模型调用，fail-closed），`/approval` 开关 |
| `dsh-market` | 客户端 | 左侧栏底部入口：插件 / 美化包目录与壳内安装 |

生效方式：客户端插件改完 `POST /api/reload-window` 即见；服务端插件必须重启宿主；改 `src/*.mjs` 要换 asar + 重启应用。

## 排障

先看宿主日志（真因只在这里）：

```powershell
Get-Content "$env:LOCALAPPDATA\DSHDesktop\logs\host.log" -Tail 30   # Linux: $XDG_STATE_HOME/dsh-desktop/log/host.log
```

- 日志为空或只有一行 `--- run … ---` ⇒ 宿主没起来（看系统/权限/路径）。
- 出现 `fatal load failure` + 堆栈 ⇒ 宿主起来了但插件树装载失败（看依赖完整性）。

| 现象 | 真因 | 处置 |
|---|---|---|
| 首次运行被 SmartScreen 拦 | 安装包未签名 | 「更多信息 → 仍要运行」，或按上文自签 |
| 装过旧版后启动即退 | 用户目录里留着旧数据 | 把 `%USERPROFILE%\.dsh` 与 `%LOCALAPPDATA%\DSHDesktop\dsh-home` **改名**（不要反复卸载重装） |
| 路径含中文 / 空格 | 原生模块在非 ASCII 路径下的经典故障 | 换纯英文安装目录与工作区 |
| `NODE_OPTIONS` 等全局变量 | 注入到宿主使子进程启动即崩 | 清掉用户级 `NODE_OPTIONS` 后重开应用 |
| `node_modules` 文件数少于 lock 里的 `nodeModulesFiles` | 解压不完整（杀软 / 磁盘满） | 重装该安装包 |
| 命令被拒（`refusing to run the command unconfined`） | Linux 缺 `bwrap`（DSH 沙箱后端，fail-closed） | `apt install bubblewrap` |
| 窗口关掉后找不回来 | 托盘"创建成功但不可见" | 从托盘唤回；`trayUsable=false` 时新版会自动关闭"关闭到托盘" |
| `dsh://` 点了没反应 | 协议未注册，或没有已运行实例 | 先启动应用再点；`--doctor` 会显示最近一次深链是否送达 |

退出码：`1` 宿主启动期失败；`2` 找不到可用 dsh 入口或 `ELECTRON_RUN_AS_NODE` 泄漏；`3` 同一 `DSH_HOME` 已有实例（复用）。

更多细节见 `--diag` 生成的报告与仓库根 README。

## 许可

[MIT](../LICENSE)
