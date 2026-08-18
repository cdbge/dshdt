# DSH Desktop（Electron 主路线）

DeepSeek Harness 的 Electron 桌面壳（模式 B）：主进程用 `ELECTRON_RUN_AS_NODE` + `--expose-internals` 把 electron.exe 当 Node 用，托管 `dsh web` 宿主子进程；BrowserWindow 加载 loopback 地址走既有信任栅栏，**DSH 零改动**。

方案与进度见仓库根目录《Electron构建安装包计划书.md》《Electron施工计划与进度.md》。

## 开发运行

```powershell
npm start                 # 窗口模式（沿用真实 ~/.dsh，老用户零迁移）
npm run dev               # 同上，保留 DevTools 与默认菜单
npm run smoke             # 端到端全量冒烟（headless + admin API 断言 + 优雅退出）
npm run build:host        # 生成 vendor/profile（M2）
npm run dist              # electron-builder 打 NSIS 安装包（M2）

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
| 单实例 + 第二实例聚焦转发 | ✅ |
| 系统托盘（双击开主窗；菜单：设置/数据目录/工作区/检查更新/退出） | ✅ |
| close-to-tray（窗口关闭 → 托盘，可配置） | ✅ |
| 通知（host 崩溃、SPA 通知白名单） | ✅ |
| 开机自启（setLoginItemSettings + 设置页开关） | ✅ |
| `dsh://` 协议注册 + 深链聚焦 | ✅（仅聚焦，会话路由 v2.1） |
| 自动更新 | ⏳ M2（electron-updater；托盘"检查更新"为占位） |
| 托盘"新建会话" | ⏳ 需 SPA 路由支持，v2.1 评估 |

## 结构

```
desktop-electron/
├─ package.json / .npmrc / electron-builder.yml(占位) / VERSION
├─ src/
│  ├─ main.mjs            # 主进程：单实例、host 编排、窗口、托盘、协议、退出
│  ├─ host.mjs            # 模式 B 托管：findDshBin / freePort / waitReady / startHost
│  ├─ admin.mjs           # admin HTTP 服务（API 面与 v1 一致）
│  ├─ settings.html       # 壳内设置页（v1 原样复用）
│  └─ desktop.patch.yml   # 形态层 patch（printUrl:false；config 整体替换语义）
├─ scripts/
│  ├─ boot-smoke.mjs      # M0 断言：RUN_AS_NODE 真实 boot 冒烟
│  ├─ abi-scan.mjs        # 原生模块 ABI 门禁（打包前必跑）
│  └─ smoke.mjs           # 端到端全量冒烟
└─ build/icon.ico
```
