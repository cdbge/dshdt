# DSH Desktop（Electron 主路线）

DeepSeek Harness 的 Electron 桌面壳（模式 B）：主进程用 `ELECTRON_RUN_AS_NODE` + `--expose-internals` 把 electron.exe 当 Node 用，托管 `dsh web` 宿主子进程；BrowserWindow 加载 loopback 地址走既有信任栅栏，**DSH 零改动**。

方案与进度见仓库根目录《Electron构建安装包计划书.md》《Electron施工计划与进度.md》。

## 开发运行

```powershell
npm start                 # 窗口模式（沿用真实 ~/.dsh，老用户零迁移）
npm run dev               # 同上，保留 DevTools 与默认菜单
npm run smoke             # 端到端全量冒烟（31 断言：headless + admin API + 背景图防回归 + 优雅退出）
node scripts\admin-bg-test.mjs      # admin 背景图单测（7 断言，纯 Node）
node scripts\repair-self-test.mjs   # 会话日志自愈单测（8 断言）
electron.exe scripts\gen-icon.mjs   # workspace 根 dsh.jpeg → build/icon.ico（换图标后跑）
npm run build:host        # 生成 vendor/profile（M2）
npm run dist              # electron-builder 打 NSIS 安装包（M2；无网络时不要带 CSC 环境变量）

npx electron . --headless # 无窗口常驻（admin 设置页 http://127.0.0.1:<port>/）
npx electron . --doctor   # 环境体检
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

## 功能状态

| 能力 | 状态 |
|---|---|
| dsh web 托管（自选端口、就绪探测、崩溃自动重启×3） | ✅ |
| BrowserWindow（contextIsolation/sandbox/导航拦截/生产禁 DevTools） | ✅ |
| 壳内设置页（独立窗口，不走外部浏览器）+ admin API（与 v1 契约一致） | ✅ |
| 托盘"设置" → 主窗口 DSH 设置面板（"桌面"section：自启/托盘化/工作区/状态，经 dsh-desktop-ui 插件注册） | ✅ |
| 多窗口 + 全局 dsh host 复用（同一 DSH_HOME 只跑一个 host，多壳窗口共享） | ✅ |
| 会话日志自愈 + 完整退出（启动前修复半个尾帧/坏日志；退出前等日志静止再结束宿主） | ✅ |
| 自定义背景图片（设置面板"桌面"→ 背景图片：浏览…/清除；jpg/jpeg/png/webp/gif/bmp/avif/ico；经回环 HTTP 供给，主题中立） | ✅ |
| 系统托盘（双击开主窗；菜单：设置/数据目录/工作区/检查更新/退出） | ✅ |
| close-to-tray（窗口关闭 → 托盘，可配置） | ✅ |
| 通知（host 崩溃、SPA 通知白名单） | ✅ |
| 开机自启（setLoginItemSettings + 设置页开关） | ✅ |
| `dsh://` 协议注册 + 深链聚焦 | ✅（仅聚焦，会话路由 v2.1） |
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
2. 发送 `dist\DSHDesktop-Setup-0.4.2.exe`（**当前唯一发布包**；旧版已从 dist 清理，不会拿错文件）→ 双击安装（免管理员）。
3. SmartScreen 弹"Windows 已保护你的电脑"→ 更多信息 → 仍要运行（自签证书暂不发布/未签名包属预期）。
4. agent 的 shell 工具不可用 → 装 PowerShell 7（首启 doctor 会提示 `winget install Microsoft.PowerShell`）。
5. 版本更新：未配发布源时托盘"检查更新"为灰；新版直接覆盖安装即可，用户数据独立保留。
6. 自定义背景图片：设置 → "桌面" → 背景图片 → 浏览… 选 jpg/png/webp 等（0.4.2 起可用；0.4.1 及更早该功能失效，属已知 bug）。

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
│  ├─ host.mjs            # 模式 B 托管：findDshBin / freePort / waitReady / startHost
│  ├─ admin.mjs           # admin HTTP 服务（API 面与 v1 一致 + /bg-image 背景图供给）
│  ├─ settings.html       # 壳内设置页（v1 原样复用）
│  └─ desktop.patch.yml   # 形态层 patch（printUrl:false；config 整体替换语义）
├─ scripts/
│  ├─ boot-smoke.mjs      # M0 断言：RUN_AS_NODE 真实 boot 冒烟
│  ├─ abi-scan.mjs        # 原生模块 ABI 门禁（打包前必跑）
│  ├─ smoke.mjs           # 端到端全量冒烟（31 断言，含背景图防回归）
│  ├─ repair-self-test.mjs# 会话自愈单测（8 断言）
│  ├─ admin-bg-test.mjs   # admin 背景图单测（7 断言，纯 Node）
│  ├─ bg-probe.mjs        # 无头渲染探针（验证 SPA 内背景图加载）
│  └─ gen-icon.mjs        # workspace 根 dsh.jpeg → build/icon.ico（多尺寸）
└─ build/icon.ico         # 唯一图标源（窗口/托盘/安装包共用；gen-icon.mjs 生成）
```
