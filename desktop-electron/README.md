# DSH Desktop · Electron 壳

把 **DeepSeek Harness（DSH）** 的 Web 界面托管成一个真正的 Windows 桌面应用：主进程用
`ELECTRON_RUN_AS_NODE` + `--expose-internals` 把 `electron.exe` 当 Node 用，托管 `dsh web` 宿主子进程，
再用 `BrowserWindow` 加载回环地址 —— 界面始终是 DSH 自己的界面，**DSH 本体零改动**。

> **这是代码侧 README**：本目录怎么开发、怎么构建、怎么排障。
> 功能总览、安装引导与常见问题见仓库根 [`../README.md`](../README.md)；变更与事故复盘见 [`../CHANGELOG.md`](../CHANGELOG.md)。

## 版本锚点

| 项 | 值 | 来源 |
|---|---|---|
| 壳版本 | **0.4.6** | [`VERSION`](VERSION) |
| DSH 运行时 | `@deepseek-ai/dsh`、`dsh-base`、`dsh-web-app` 均为 **0.1.5-rc.2** | [`vendor/vendor.lock.json`](vendor/vendor.lock.json)（三包同进同退） |
| Node / Electron | 24.18.1 / 43.4.0 | 同上 |
| 自包含运行时 | **11,177 个文件 / 124 MB**（构建期剪枝掉 14,279 个文件） | 同上（`totalFiles` / `totalBytes` / `prunedFiles`） |
| 原生模块 ABI 门禁 | `PASS` | 同上 |

## 目录结构

```
desktop-electron/
├─ package.json / .npmrc / electron-builder.yml / VERSION
├─ src/                       # 壳代码（会进 asar，`files: src/**`）
│  ├─ main.mjs                #   主进程：多窗口、宿主编排（复用已有实例）、托盘、协议、退出、背景图注入
│  ├─ node-guard.mjs          #   最先导入：防 ELECTRON_RUN_AS_NODE 泄漏（主进程退化成纯 Node 时明确报错）
│  ├─ early-errors.mjs        #   第二个导入：打包态未捕获异常落盘
│  ├─ host.mjs                #   宿主托管：findDshBin / freePort / waitReady / killTree / startHost
│  ├─ admin.mjs               #   回环 admin HTTP（/api/* + /bg-image 背景图供给）
│  ├─ dsh-update.mjs          #   DSH 更新 S1：版本发现与比较（纯 Node，不写文件不起进程）
│  ├─ vendor-build.mjs        #   DSH 更新 S2：vendor 树构建原语（install / 剪枝 / 插件同步 / ABI 门禁）
│  ├─ dsh-apply.mjs           #   DSH 更新 S3：换树与回滚（唯一不可逆操作，每条失败分支都有单测）
│  ├─ junction-safe.mjs       #   含链接目录的安全删除（自己删树一律走它）
│  ├─ repair.mjs              #   会话日志自愈：半个 zstd 尾帧 / 首帧异常 / 坏日志隔离改名
│  ├─ settings.html           #   壳内设置页
│  └─ desktop.patch.yml       #   形态层 patch（config 整体替换语义）
├─ packages/                  # 自带插件（构建期同步进 vendor，启动时同步到 profile 插件位）
│  ├─ dsh-desktop-ui/         #   客户端插件：设置面板「桌面」分区 + 按钮交互样式
│  └─ dsh-auto-approval/      #   服务端插件：审批瀑布上由独立模型裁决权限申请
├─ scripts/                   # 构建、门禁与工具（不进安装包）
├─ build/icon.ico             # 唯一图标源（窗口 / 托盘 / 安装包共用，由 gen-icon.mjs 生成）
├─ vendor/vendor.lock.json    # 运行时版本与文件数基线（vendor/profile 由 build:host 生成，不入库）
└─ dist/                      # 安装包产物（不入库，发布走 GitHub Releases）
```

> **会进安装包的只有 `src/**` + `VERSION` + `package.json`**（外加 `extraResources` 里的 vendor 树、
> patch 与图标）。新增"打包态要调用"的能力**不能放 `scripts/`**——它不进包。

## 开发运行

前提：Windows 10 22H2+、Node.js 22+、能访问 npm registry（构建 vendor 时）。

```powershell
npm install
npm run build:host        # 生成 vendor/profile（首次或依赖变更后必跑）
npm start                 # 窗口模式；npm run dev 保留 DevTools
```

| 命令 | 作用 |
|---|---|
| `npm start` / `npm run dev` | 窗口模式（后者保留 DevTools 与默认菜单） |
| `npx electron . --headless` | 无窗口常驻（设置页在 `http://127.0.0.1:<port>/`，端口见宿主锁或壳日志） |
| `npx electron . --doctor` | 环境体检：Windows 版本 / dsh CLI 路径 / PowerShell 7 / `DSH_HOME` / 工作区 / 磁盘余量 |
| `npx electron . --diag` | 一键取证：路径、环境变量、preflight、宿主锁与 stdio 模式、依赖文件数、三份日志尾部 → 同时写 `logs\diag-report.txt`（"别人机器起不来"时让对方跑这条） |
| `npm run smoke` | 端到端全量冒烟（**72 断言**，需完整权限）；打包产物用 `dist\win-unpacked\DSH Desktop.exe --smoke` |
| `npm run build:host` | 重建 vendor/profile（含插件同步与 ABI 门禁） |
| `npm run dist` | electron-builder 打 NSIS 安装包 |

启动参数还有 `--autostart on\|off`、`--set-ws <绝对路径>`、`--register`（注册开机自启与 `dsh://` 协议）、`--version`。

> ⚠️ 在 AI 会话/被托管环境里跑 electron 之前，先 `Remove-Item Env:ELECTRON_RUN_AS_NODE`：
> 该变量会让 `electron.exe` 退化成纯 Node，症状是"无窗口、无日志"。

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

**9 套离线自检 = 242 断言**（脱网、秒级）+ **`smoke` = 72 断言**。改动后全绿才算完成。

| 脚本 | 断言 | 说明 |
|---|---|---|
| `scripts/smoke.mjs` | **72** | 端到端全量冒烟：admin 面 + 背景图 + 皮肤遮罩 + browse 钉住 + DSH 更新面 + 优雅退出 |
| `scripts/vendor-build-self-test.mjs` | 66 | vendor 构建原语（脱网，不跑真 npm） |
| `scripts/dsh-apply-self-test.mjs` | 44 | 换树与标记状态机（全同步，每条失败分支一条断言） |
| `packages/dsh-auto-approval/test/apply-self-test.mjs` | 37 | 审批接线（mock ctx 驱动 apply） |
| `scripts/update-self-test.mjs` | 36 | 版本发现与比较（脱网） |
| `scripts/junction-safe-self-test.mjs` | 18 | 含链接目录的安全删除（建真 junction 验证目标不被掏空） |
| `scripts/patch-mount-self-test.mjs` | 16 | profile 补丁层挂载与自愈（含真实坏文件样本） |
| `packages/dsh-auto-approval/test/grade-self-test.mjs` | 10 | 审批分级器（纯函数） |
| `scripts/repair-self-test.mjs` | 8 | 会话日志自愈 |
| `scripts/admin-bg-test.mjs` | 7 | admin 背景图（纯 Node） |

口径：前 8 套纯逻辑自检合计 **235**，加 `admin-bg` 的 7 = **242**；两者都对，别当成对不上账。

**权限口径**：`smoke.mjs` 会起 Electron，**需要完整权限**（受限沙箱下 mojo 命名管道被拦，表现为"壳状态文件超时"，
不是壳的缺陷）；打包产物的 `--smoke` 同理，且**退出码不可信**（可能返回环境伪影），**以日志里的 `SMOKE OK` 为准**。

**辅助工具**（非门禁）：`scripts/boot-smoke.mjs`（宿主链路冒烟，无 GUI 也能跑）、
`scripts/bootgate-verify.mjs` 与 `scripts/bootgate-destruct-test.mjs`（启动门禁的正/负测试）、
`scripts/vendor-equivalence.mjs`（暂存树等价性验证，分钟级，换树前跑）、`scripts/abi-scan.mjs` 与
`scripts/build-host.mjs`（CLI 薄封装，实现在 `src/`）、`scripts/gen-icon.mjs`、`scripts/dev-sign.ps1`。

## 构建与打包

```powershell
npm run build:host    # install → 剪枝 → 插件同步 → ABI 门禁 → 刷新 vendor.lock.json
npm run dist          # electron-builder → dist/DSHDesktop-Setup-<版本>.exe（NSIS，x64）
```

- **产物不进仓库**：`dist/` 已在 `.gitignore` 里，安装包只作为 **GitHub Release 附件**分发。
- **包体为什么大**：安装包内自带整棵 DSH 运行时（124 MB / 11,177 文件），换来的"免装 DSH、双击即用"。
  安装耗时主要跟**文件数**相关（解压 + Defender 逐文件扫描），所以剪枝优先砍文件数而不是字节数。
- **未签名**：无证书时出未签名包，首次运行 SmartScreen 提示属预期（本地开发可自签，见下）。
- **构建机无需 makensis**：electron-builder 自带 NSIS 工具链；直调
  `node node_modules\electron-builder\out\cli\cli.js --win nsis` 可绕开 npx 垫片。

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

CI 已就位：`.github/workflows/release.yml` 在推 `v*` tag 时构建 + 跑门禁 + 打包；签名证书放仓库 Secrets
（`WINDOWS_CERT_PFX` / `WINDOWS_CERT_PASSWORD`），未配置则出未签名包。

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

## 许可

[MIT](../LICENSE)
