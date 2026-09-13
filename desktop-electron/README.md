# DSH Desktop（Electron 主路线）

DeepSeek Harness 的 Electron 桌面壳（模式 B）：主进程用 `ELECTRON_RUN_AS_NODE` + `--expose-internals` 把 electron.exe 当 Node 用，托管 `dsh web` 宿主子进程；BrowserWindow 加载 loopback 地址走既有信任栅栏，**DSH 零改动**。

方案与进度见 `../docs/项目/计划/Electron构建安装包计划书.md` 与 `../docs/项目/计划/Electron施工计划与进度.md`（**唯一进度事实源**）；
规范与坑清单见 `../docs/项目/00-文档导航.md`（入口）与 `../docs/项目/03-坑清单.md`（坑 1~63）；
变更日志在仓库根 [`../CHANGELOG.md`](../CHANGELOG.md)（2026-09-13 由本目录移出，避免文书提交反复占用本目录在 GitHub 文件列表的「最后提交」列）。

## 开发运行

```powershell
npm start                 # 窗口模式（沿用真实 ~/.dsh，老用户零迁移）
npm run dev               # 同上，保留 DevTools 与默认菜单
npm run smoke             # 端到端全量冒烟（**72 断言**：admin 面 + 背景图 + 皮肤遮罩 + browse 钉住 + DSH 更新面 + 优雅退出）
node scripts\admin-bg-test.mjs      # admin 背景图单测（7 断言，纯 Node）
node scripts\repair-self-test.mjs   # 会话日志自愈单测（8 断言）
electron.exe scripts\gen-icon.mjs   # workspace 根 dsh.jpeg → build/icon.ico（换图标后跑）
                                    # 9 套离线自检合计 242 断言的完整清单见 ../docs/项目/04-范例与检查点.md §6
npm run build:host        # 生成 vendor/profile（M2）
npm run dist              # electron-builder 打 NSIS 安装包（**需用户同意**；无网络时不要带 CSC 环境变量）

npx electron . --headless # 无窗口常驻（admin 设置页 http://127.0.0.1:<port>/）
npx electron . --doctor   # 环境体检（与启动前 preflight 同一套判据）
npx electron . --diag     # 一键取证：路径/环境变量/preflight/宿主锁/依赖文件数/三份日志尾部
                          # → 打印到控制台并写 logs\diag-report.txt（"别人机器起不来"时让对方跑这条）
# 自带插件自检（在 profile 副本里跑才能解析 zod）：
cd $env:DSH_HOME\profiles\web\node_modules\dsh-auto-approval; node test\grade-self-test.mjs; node test\apply-self-test.mjs
npx electron . --autostart on|off
npx electron . --set-ws <绝对路径>
npx electron . --register # 注册开机自启 + dsh:// 协议
npx electron . --version
```

## 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_HOME` | 覆盖 DSH 用户数据目录（已存在 `~/.dsh` 则默认沿用） |
| `DSH_WS` | 覆盖默认工作区 |
| `DSH_BIN` | 指定 dsh bin.js 路径（自动发现：全局 npm > npx 缓存 > vendor） |
| `DSH_APP_DATA` | 覆盖应用数据目录（日志/设置/Electron profile；冒烟隔离用） |
| `DSH_SMOKE=1` | 跳过注册表/登录项/协议写入 |
| `DSH_HOST_STDIO=fd` | 强制宿主用 fd 直通 stdio（跳过管道探测；仅在诊断"管道是否被系统拒绝"时用） |

## 功能状态

| 能力 | 状态 |
|---|---|
| dsh web 托管（自选端口、就绪探测、崩溃自动重启×3） | ✅ |
| BrowserWindow（contextIsolation/sandbox/导航拦截/生产禁 DevTools） | ✅ |
| 壳内设置页（独立窗口，不走外部浏览器）+ admin API（与 v1 契约一致） | ✅ |
| 托盘"设置" → 主窗口 DSH 设置面板（"桌面"section：自启/托盘化/工作区/状态，经 dsh-desktop-ui 插件注册） | ✅ |
| 多窗口 + 全局 dsh host 复用（同一 DSH_HOME 只跑一个 host，多壳窗口共享） | ✅ |
| 宿主崩溃可诊断（**管道 stdio + 环形缓冲**：最后遗言直接进托盘通知与 `host.stderr.log`；管道被系统拒绝时自动退化 fd 保功能） | ✅ 0.4.6 |
| 启动前 preflight（路径非 ASCII / `NODE_OPTIONS`·`DSH_BIN` / 数据目录可写 / 磁盘 / **依赖完整性**）——critical 时弹明确说明而不是退化成退出码 | ✅ 0.4.6 |
| `--diag` 一键取证（路径·环境变量·preflight·宿主锁与 stdio 模式·依赖文件数·三份日志尾部 → 打印并落 `logs\diag-report.txt`） | ✅ 0.4.6 |
| 会话日志自愈 + 完整退出（启动前修复半个尾帧/坏日志；退出前等日志静止再结束宿主） | ✅ |
| 自定义背景图片（设置面板"桌面"→ 背景图片：浏览…/清除；jpg/jpeg/png/webp/gif/bmp/avif/ico；经回环 HTTP 供给，主题中立） | ✅ |
| 系统托盘（双击开主窗；菜单：设置/数据目录/工作区/检查更新/退出） | ✅ |
| close-to-tray（窗口关闭 → 托盘，可配置） | ✅ |
| 通知（host 崩溃、SPA 通知白名单） | ✅ |
| 开机自启（setLoginItemSettings + 设置页开关） | ✅ |
| `dsh://` 协议注册 + 深链聚焦 | ✅（仅聚焦，会话路由 v2.1） |
| 系统托盘"重启宿主（重载插件）"（`POST /api/restart-host`） | ✅ 0.4.6 |
| 自带插件 `dsh-auto-approval`（AI 自检权限申请：低风险自动放行 / 高风险问用户） | ✅ 0.4.6 |
| 自动更新 | ⏳ M2（electron-updater；托盘"检查更新"为占位） |
| 托盘"新建会话" | ⏳ 需 SPA 路由支持，v2.1 评估 |

## 构建与分发（M2）

```powershell
npm run build:host        # 生成自包含 vendor/profile（锁 rc.6 + ABI 门禁 + 剪枝，207MB）
npm run dist              # electron-builder 打 NSIS 安装包（无需本机 makensis）
```

签名（本地开发版，自签）：

```powershell
pwsh -File scripts\dev-sign.ps1        # 生成/复用自签证书 → 导出 dev.pfx/dev.cer
# 本机信任（一次性，消除 SmartScreen 警告）：右键 dev.cer → 安装证书 → 当前用户 → 受信任的根证书颁发机构
$env:CSC_LINK = [Convert]::ToBase64String([IO.File]::ReadAllBytes("scripts\certs\dev.pfx"))
$env:CSC_KEY_PASSWORD = 'dshdev'
npm run dist                            # 带签名打包
Get-AuthenticodeSignature dist\DSHDesktop-Setup-*.exe | Select Status   # Valid（信任根后）
```

发布与差分更新：建 GitHub 仓库 → 取消 `electron-builder.yml` 中 publish 注释并填 owner/repo
→ 仓库 Secrets 配 `GH_TOKEN` → `git tag v0.4.x` 推送即触发 CI 自动发布，已装端经
electron-updater 差分升级。

## 分享给朋友（个人使用指引，证书暂缓）

1. 朋友机器要求：**Windows 10 22H2 及以上**（Win11 均可）；无需 Node/pnpm/Chrome。
2. 发送 `dist\DSHDesktop-Setup-0.4.6.exe`（127.4 MB，**当前唯一该发的包**；内含 harness `0.1.5-rc.2` 与两个内置插件，产物冒烟 `SMOKE OK`）→ 双击安装（免管理员）。
   ⚠️ **`dist\` 里 0.4.5 老包还在**（129.4 MB，内含 9/8 时代 vendor，**装它会把 harness 退回旧版**）——发人前先看清文件名（规范坑 12）。
3. SmartScreen 弹"Windows 已保护你的电脑"→ 更多信息 → 仍要运行（自签证书暂不发布/未签名包属预期）。
4. agent 的 shell 工具不可用 → 装 PowerShell 7（首启 doctor 会提示 `winget install Microsoft.PowerShell`）。
5. 版本更新：未配发布源时托盘"检查更新"为灰；新版直接覆盖安装即可，用户数据独立保留。
6. 自定义背景图片：设置 → "个性化" → 背景图片 → 浏览… 选 jpg/png/webp 等（**0.4.3 起真正可见**；0.4.2 及更早该功能存在但看不见，属已知 bug）。
7. **先分清对方机器是"全新环境"还是"留着旧数据"** —— 见下节，这两类的排查方向完全不同（**重装过 Windows = 全新环境**，旧数据理论不成立）。

### ⚠️ 对方机器报「DSH 宿主意外退出 exit code=1」时怎么办

> **状态（2026-09-12）**：一台机器装 0.4.6 后启动即弹「DSH 宿主意外退出：exit code=1，正在自动重启宿主」，
> 三次后整个应用退出，**应用直接打不开**。**该安装包已用隔离冒烟证明是好的**（包内那棵树 `--smoke` →
> `SMOKE OK`、宿主 5 秒就绪），所以问题在**那台机器的环境或数据**。**病因尚未定论**——下面的判据表按
> `host.log` 特征对号即可定性；**Windows 重装过的机器请直接看第 2 类**。

#### 第 0 步（两种情况都要做）：读宿主日志，它是唯一的真因来源

```powershell
Get-Content "$env:LOCALAPPDATA\DSHDesktop\logs\host.log" -Tail 30   # 真因在这里，不在通知里
```

机制：通知是**壳**发的（`src/main.mjs:505`），里面的 `code` 只是宿主子进程的退出码；DSH 侧 `code=1` 的唯一来路是
`dsh-app-boot` 的 `installFailLoud()`——启动期插件树装载失败 / unhandledRejection 时，它把
`fatal load failure: <stack>` 写到 **stderr**，而壳把宿主 stdout/stderr 全量重定向进上面这个文件。
⇒ **`host.log` 为空或只有一行 `--- run … ---` = 宿主根本没起来**（外部因素）；
**有 `fatal load failure` + 堆栈 = 宿主起来了但装载失败**（数据/依赖因素）。这一条先把方向一分为二。

#### 第 1 类：留着旧数据的机器（旧版 dshdt / 旧 DSH Desktop，或恢复出厂但保留了用户目录）

**卸载程序不删用户数据**（`electron-builder.yml` 的 `deleteAppDataOnUninstall: false`），而新版**一定会去读**那棵旧目录——
`src/main.mjs` 的解析顺序是 `DSH_HOME` 环境变量 → `%USERPROFILE%\.dsh`（存在就用）→ `%LOCALAPPDATA%\DSHDesktop\dsh-home`。
旧目录里只要有一处新版读不动，宿主就启动即退出。**不要反复卸载重装**（重装碰不到 `%USERPROFILE%\.dsh`），
处置是**改名**（不删数据，可随时改回来）：

```powershell
Rename-Item "$env:USERPROFILE\.dsh" ".dsh.bak" -EA 0
Rename-Item "$env:LOCALAPPDATA\DSHDesktop\dsh-home" "dsh-home.bak" -EA 0
```

重开应用即可（首次进入要重新填一次 API Key，旧值都还在 `.bak` 里）。
**注意别删 `%LOCALAPPDATA%\DSHDesktop\settings.json`**——那是壳自己的设置（工作区/自启/背景图），与故障无关。

#### 第 2 类：全新环境（Windows 重装过 / 从前没用过这台机器）

这一类的 `%USERPROFILE%` 是新的，**旧 `DSH_HOME` 残留不成立**，方向换成"环境是否允许它跑"。按现象对号：

| 现象 / 检查点 | 真因 | 处置 |
|---|---|---|
| `host.log` 空或只有 `--- run … ---` | 进程被外部挡住（杀软 / EDR / 组策略） | 查 Defender 保护历史与第三方杀软隔离区；把 `%LOCALAPPDATA%\Programs\DSH Desktop` 与 `%LOCALAPPDATA%\DSHDesktop` 加白名单 |
| `%USERPROFILE%` 路径含**中文/空格/特殊字符**（如 `C:\Users\张三`） | 原生模块（koffi COM worker、sharp/libvips 等 5 个 `.node`）在非 ASCII 路径下的经典故障 | **最省事的判据**：新建一个纯英文账户（或把安装目录/工作区放到纯英文路径）试一次 |
| 系统里装过 Node/nvm，留下了全局环境变量 | `NODE_OPTIONS` 会注入到 `ELECTRON_RUN_AS_NODE` 子进程使其启动即崩；`DSH_BIN` 会让壳**优先用全局 npm 的 dsh 而不是包内 vendor**（版本不匹配） | `[Environment]::GetEnvironmentVariable('NODE_OPTIONS','User')` 等逐个查空；有则清掉后重开应用 |
| `resources\vendor\profile\node_modules` 文件数明显小于 ≈11175 | 安装解压不完整（杀软吃掉 / 磁盘满） | 重装该安装包；装前确认磁盘余量（包解压后 ≈124 MB，运行期还要更多） |
| 系统是 N/KN 版、或 build < 19045（Win10 21H2 及更早） | 缺 Media Foundation / 低于基线 | 装 Media Feature Pack；`--doctor` 会直接报 `Windows 版本` 一项 |
| 上面都不适用 | 仍需 `host.log` 的原文堆栈才能定性 | 把 `host.log` 尾部 30 行发出来 |

**`--doctor` 一次性体检**（在 `desktop-electron\` 下，或对已装应用的可执行文件）：

```powershell
npx electron . --doctor        # 报 Windows 版本 / dsh CLI 路径 / PowerShell 7 / DSH_HOME / 工作区 / 磁盘余量
```

#### 通用口径（两类都适用）

**退出码不是一回事**：`1` = 上面这套；`2` = 壳自己没找到 dsh CLI（`src/main.mjs:1250`，**恰好就是"用了全局 npm 的旧 dsh"或"包内 vendor 缺件"这种情形**）或 `ELECTRON_RUN_AS_NODE` 泄漏（`src/node-guard.mjs`）；`3` = 同一 `DSH_HOME` 已有实例（走复用，不是故障）。

| `host.log` 特征 | 真因 | 处置 |
|---|---|---|
| `credentials-local: …`（`invalid document` / `must be a mapping` / `unknown top-level key`） | `$DSH_HOME\.credentials.yaml` 格式损坏（**标准扁平版会自动迁移，不会报错**；报错的是被手工改坏的） | 删/改名该文件即可，其余数据不动 |
| `settings-file: invalid document at …` / `… must be a map of namespace sections` | `settings.yaml` 语法坏了（启动读盘是硬抛，只有热重载才降级为 warn） | 改名 `settings.yaml` |
| `fatal load failure:` + 模块解析栈，且点名某个包 | 包内 node_modules 缺件 / 被杀软隔离 | 核对 `node_modules` 文件数（应 ≈11175） |

## 从 v1（Node+Chrome 壳）迁移

v1 与 Electron 版默认安装目录相同，**先卸载 v1 再装本版**：
开始菜单 → "卸载 DSH Desktop" → 数据删除询问选保留（默认回车）→ 安装 Electron 版。
用户数据两版共享（`~/.dsh` 或 `%LOCALAPPDATA%\DSHDesktop\dsh-home`），会话历史零迁移。

## 结构

```
desktop-electron/
├─ package.json / .npmrc / electron-builder.yml(占位) / VERSION
├─ src/
│  ├─ main.mjs            # 主进程：多窗口、host 编排（复用已有实例）、窗口、托盘、协议、退出、背景图
│  ├─ node-guard.mjs      # 最先导入：防 ELECTRON_RUN_AS_NODE 泄漏（主进程退化成纯 Node 时明确报错）
│  ├─ early-errors.mjs    # 打包态未捕获异常落盘（第二个导入）
│  ├─ repair.mjs          # 会话日志自愈：半个 zstd 尾帧截断 / 首帧异常重编码 / 坏日志隔离
│  ├─ host.mjs            # 模式 B 托管：findDshBin / freePort / waitReady / startHost（SSH_CONNECTION 钉住应用内目录浏览）
│  ├─ admin.mjs           # admin HTTP 服务（API 面与 v1 一致 + /bg-image 背景图供给）
│  ├─ settings.html       # 壳内设置页（v1 原样复用）
│  └─ desktop.patch.yml   # 形态层 patch（printUrl:false；config 整体替换语义）
├─ packages/              # 自带插件（build-host 拷进 vendor，壳启动同步到 profile 插件位）
│  ├─ dsh-desktop-ui/     #   客户端插件：设置面板"桌面"section
│  └─ dsh-auto-approval/  #   Host 插件：AI 自检权限申请（审批瀑布风险分级 + /approval 开关 + 决策日志）
├─ scripts/
│  ├─ boot-smoke.mjs      # M0 断言：RUN_AS_NODE 真实 boot 冒烟
│  ├─ abi-scan.mjs        # 原生模块 ABI 门禁（打包前必跑）
│  ├─ smoke.mjs           # 端到端全量冒烟（72 断言，含背景图/皮肤/browse 钉住防回归）
│  ├─ repair-self-test.mjs# 会话自愈单测（8 断言）
│  ├─ admin-bg-test.mjs   # admin 背景图单测（7 断言，纯 Node）
│  ├─ *-self-test.mjs     # 另有 update / vendor-build / dsh-apply / junction-safe / patch-mount 五套（脱网）
│  └─ gen-icon.mjs        # workspace 根 dsh.jpeg → build/icon.ico（多尺寸）
│                         # 一次性排障脚本（bg-probe* / hover-probe* / rail-probe / dsh15-probe* /
│                         # repro-picker-worker）已于 2026-09-13 清理，技法见 ../docs/通用/04-排障方法与通用坑.md §8
└─ build/icon.ico         # 唯一图标源（窗口/托盘/安装包共用；gen-icon.mjs 生成）
```
