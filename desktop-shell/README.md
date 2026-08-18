# DSH Desktop — DeepSeek Harness 桌面壳

Node + Chrome app-mode 实现的 Windows 桌面壳：托管 `dsh web` 宿主进程，原生窗口内呈现与浏览器版完全一致的 UI（走既有 `/api` 信任栅栏，DSH 零改动）。

## 功能

| 能力 | 状态 |
|---|---|
| dsh web 托管（自选端口、就绪探测、崩溃联动） | ✅ |
| Chrome app-mode 窗口（独立浏览器 profile） | ✅ |
| 系统托盘（打开/设置/数据目录/工作区/退出） | ✅ |
| 壳内设置页（自启、托盘化、工作区、状态体检） | ✅ |
| 单实例 + 第二实例聚焦转发 | ✅ |
| 通知（host 崩溃、PS7 缺失、SPA 通知预授权） | ✅ |
| 开机自启 / `dsh://` 深链 | ✅ |
| 安装包（iexpress 回退 / NSIS 备用）与卸载 | ✅ |
| `--doctor` 环境体检 / `smoke.mjs` 端到端冒烟 | ✅ |

## 快速开始（开发态）

```bat
run.cmd                 rem 启动（选空闲端口 → 起 dsh web → 开窗口）
run.cmd --smoke         rem 冒烟：boot → 就绪 → 关停
run.cmd --headless      rem 无窗口常驻（admin 设置页 http://127.0.0.1:<port>/）
run.cmd --doctor        rem 环境体检
run.cmd --autostart on  rem 开机自启（注册表 HKCU Run）
run.cmd --set-ws D:\Work rem 切换 agent 工作区
run.cmd --version
node smoke.mjs          rem 端到端全量冒烟
node diag-session.mjs <session.jsonl.zstd>  rem 会话日志诊断
```

## 安装（分发态）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File build-installer.ps1
rem 产出 dist\DSHDesktop-Setup-<ver>.exe（真正的 PE 安装包）
rem 打包器优先级: makensis (NSIS) > iscc (Inno) > csc 自解压 .exe > base64 自解压 .cmd（保底）
```

- **csc 自解压 .exe**（默认路径）：用系统自带 .NET Framework `csc.exe` 编译 `setup-bootstrap.cs`，内嵌 zip 载荷 + 应用图标，双击即装，零外部依赖。
- 仅在既无 NSIS/Inno 又无 csc 时才回退 `.cmd`。

安装到 `%LOCALAPPDATA%\Programs\DSH Desktop`（免管理员），创建桌面/开始菜单快捷方式（隐藏控制台启动），注册 `dsh://` 协议与卸载项；控制面板或开始菜单"卸载 DSH Desktop"卸载（用户数据默认保留，可选删除）。

## 数据位置

| 项 | 位置 |
|---|---|
| 应用数据（日志/设置/浏览器 profile） | `%LOCALAPPDATA%\DSHDesktop` |
| DSH 用户数据（沿用老用户零迁移） | 已存在 `~/.dsh` 用之；否则 `%LOCALAPPDATA%\DSHDesktop\dsh-home` |
| agent 工作区 | 默认 `~/DSH-Workspace`（设置页可改） |
| 会话/凭据/设置（DSH 侧） | 见计划书 1.6 节 |

## 结构

```
desktop-shell/
├─ launcher.mjs          # 主流程：单实例→admin→host→就绪→窗口/托盘→退出编排
├─ tray.ps1 / notify.ps1 # 托盘 / 气泡通知（系统 PowerShell 5.1 + WinForms）
├─ settings.html         # 壳内设置页（admin 服务直出）
├─ setup.cmd / uninstall.cmd / make-shortcuts.ps1 / launch-hidden.vbs
├─ run.cmd               # 双击入口
├─ icon.ico / icon-gen.ps1   # 应用图标 + 生成脚本
└─ CHANGELOG.md / VERSION / README.md
```

以上为随安装包分发的运行时文件。以下为**开发/构建工具**，不随包分发：

```
├─ build-installer.ps1 / installer.nsi   # 打包（NSIS > Inno > csc .exe > base64 SFX）
├─ setup-bootstrap.cs     # csc 自解压安装器源码（内嵌 zip 载荷）
├─ smoke.mjs             # 端到端冒烟（headless + admin API 全量断言）
└─ diag-session.mjs      # 会话日志 zstd 逐帧诊断
```

## 前置依赖

- Node.js ≥ 22（开发态；分发态由安装包携带说明）
- Google Chrome（窗口模式）
- PowerShell 7+（agent 的 shell 工具需要；`--doctor` 与安装器会检查，缺失提示 `winget install Microsoft.PowerShell`）
- dsh CLI（全局 npm 或 npx 缓存均可自动发现；可用 `DSH_BIN` 指定）

## 环境变量（测试/定制用）

| 变量 | 作用 |
|---|---|
| `DSH_HOME` | 覆盖 DSH 用户数据目录 |
| `DSH_WS` | 覆盖默认工作区 |
| `DSH_BIN` | 指定 dsh bin.js 路径 |
| `DSH_APP_DATA` | 覆盖应用数据目录（冒烟测试隔离用） |
| `DSH_SMOKE=1` | 跳过注册表写入（冒烟测试用） |

## 安全姿态

- admin 服务仅绑定 127.0.0.1；DSH host 保持 `--host 127.0.0.1`（延续拒绝 `0.0.0.0`）
- Chrome 专用 profile 隔离；凭据仍只经 `/api` 特权面读写
- 深链 v1 仅聚焦窗口，不向渲染进程注入任何能力
