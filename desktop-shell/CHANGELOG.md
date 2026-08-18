# CHANGELOG

版本策略：跟随 DSH rc 基线（当前 `@deepseek-ai/dsh@0.1.0-rc.6`），壳版本独立递增；升级 DSH 前先跑 `smoke.mjs`。

## 0.3.0 — Stage 3（分发 + 原生集成收尾）

**新增**
- admin HTTP 服务（127.0.0.1 随机端口）：`/health`、`/api/status`、`/api/autostart`、`/api/settings`、`/api/workspace`、`/api/focus`、`/api/open-data-dir`、`/api/open-workspace`、`/api/open-settings`、`/api/quit`，状态写入 `app.state.json`
- 壳内设置页（`settings.html`）：自启开关、最小化到托盘开关、工作区切换、数据目录/工作区/DSH 设置页直达、版本与运行时长、退出
- 系统托盘（`tray.ps1`，系统 PowerShell 5.1 + WinForms）：打开主窗口 / 设置 / 打开数据目录 / 打开工作区 / 退出，双击聚焦，宿主退出自动消失
- 一次性气泡通知（`notify.ps1`）：host 崩溃提示、PS7 缺失提示
- 关闭窗口 → 最小化到托盘（`settings.minimizeToTray`，默认开）
- 单实例升级：第二实例把聚焦请求转发给运行中实例（`/api/focus`）
- Chrome 通知权限预授权：每次启动前向浏览器 profile 播种当前端口的 notifications 例外
- `--doctor`：Node/dsh CLI/Chrome/PS7/DSH_HOME/工作区/磁盘/自启/协议 体检
- `--headless`：不起窗口、不起托盘，仅宿主 + admin（供 smoke/调试）
- `--version`、`--register`（安装器调用的注册命令）
- `smoke.mjs`：端到端冒烟（临时 HOME/APP_DATA/WS，admin API 全量断言）
- 分发：`build-installer.ps1`（自动选 NSIS > Inno > **csc 自解压 `.exe`** > base64 自解压 `.cmd`）、`setup-bootstrap.cs`（C# 自解压安装器，系统 csc 编译，内嵌 zip 载荷 + 图标）、`setup.cmd`/`uninstall.cmd`、`make-shortcuts.ps1`、`launch-hidden.vbs`、`installer.nsi`（备用）、多尺寸 `icon.ico`
- 文档：README、CHANGELOG、VERSION

**修复**
- `--set-ws` 增加绝对路径校验与目录创建
- host 意外退出时气泡提示（原仅记日志）

## 0.2.0 — Stage 2（原生集成起步）

- `settings.json` 存储（`--autostart on|off`、`--set-ws <path>` CLI）
- 开机自启（HKCU Run + 隐藏 VBS）
- `dsh://` 协议注册与深链参数解析（v1 仅聚焦）
- `--smoke`/`--no-window` 冒烟模式：boot → 就绪 → 关停
- `diag-session.mjs`：会话日志 zstd 逐帧解压与 seq 连续性诊断

## 0.1.0 — Stage 1（最小可用壳）

- 空闲端口自选（监听 0）
- `dsh web --port N` 子进程托管（stdout/stderr → `host.log`）
- 就绪探测（轮询 GET /）
- Chrome app-mode 内嵌窗口（独立 browser-profile）
- 单实例锁、进程树清理、host 退出联动
- 日志落盘 `%LOCALAPPDATA%\DSHDesktop\logs\`
