# DeepSeek Harness 桌面应用 · Electron 模式构建与安装包计划书（优化稿）

> 版本：v2.0（评审稿）· 日期：2026-08
> 关联文档：《DeepSeek-Harness桌面应用封装计划书.md》——本文是其第二部分"方案 C（Electron）"的落地细化与优化稿；第一部分架构分析与第二部分非构建类结论（数据策略、安全姿态、非目标）沿用不重复。
> 本计划书只做方案陈述，不涉及任何代码改动；经评审确认后再按里程碑实施。

---

## 0. 摘要

一句话：**把已验证的 v1 桌面壳（Node + Chrome app-mode，`desktop-shell/` 已交付 0.3.0 安装包）的宿主托管逻辑原样迁入 Electron 主进程，用 electron-builder 重建安装包与更新通道**，一次性解决 v1 的三大结构性缺口：

1. **运行时缺口**：v1 依赖用户已装 Google Chrome；Electron 自带 Chromium + Node 22，安装即用。
2. **打包缺口**：v1 的 `build-installer.ps1` 因本机无 makensis 走了 csc 自解压回退，无签名、无差分更新、易被杀软启发式误报；electron-builder 自带 NSIS 工具链，签名与差分更新一步到位。
3. **原生能力缺口**：v1 托盘/通知依赖系统 PowerShell 5.1 + WinForms 的脆弱实现；Electron 的 Tray / Notification / setLoginItemSettings / setAsDefaultProtocolClient 全部原生。

### 相对评审稿的优化点

| # | 评审稿 | 本优化稿 | 理由 |
|---|---|---|---|
| 1 | host 托管"进程内 `boot()` 优先" | **子进程优先**：`ELECTRON_RUN_AS_NODE=1 electron.exe profile-boot.js`，捆绑 Node 22 作回退；进程内降为 v2.5 候选 | 规避 Electron 内建 Node 与 DSH 原生模块的 ABI/升级耦合；直接复用 v1 已验证的子进程监管经验（单实例、admin 端口、就绪探测、崩溃联动），不重写 |
| 2 | 打包器选型未定（本机无 makensis/ISCC） | electron-builder **自带 NSIS 工具链**，构建机零外部依赖 | v1 实测 iexpress `/N` 在 Win11 26100 失效、csc SFX 需回退；electron-builder 是 Windows 分发事实标准 |
| 3 | 15~20 人日（全链路从零） | **8~12 人日**（v1 资产全量复用，见第五章映射表） | launcher.mjs / admin API / settings.html / smoke.mjs / doctor 均为已交付资产 |
| 4 | 自动更新挂 v1.5 | electron-updater（NSIS blockmap 差分）随 v2.0 首发 | 签名 + 发布源是更新通道的唯一前置，随打包链一并解决 |
| 5 | 轻量分支为 WebView2（假设） | 轻量回退分支 = **已交付的 Node+Chrome 壳**（保留 `build-installer.ps1` 链路） | 不再维护假设方案，B 分支是现成可回退物 |

---

## 一、基线事实与约束（构建前必须成立）

| # | 事实 | 对 Electron 构建的约束 |
|---|---|---|
| 1 | DSH 要求 **Node ≥ 22**（`node:sqlite`、`process.loadEnvFile`；本机 v22.21.0） | Electron **≥ 35**（本机实测 **43.4.0**：内建 Node **24.18.1** / Chromium 150，满足要求；参考 [releases.electronjs.org](https://releases.electronjs.org/schedule)）。构建期以 smoke 断言 `process.versions.node ≥ 22` 且 `require('node:sqlite')` 可用（**含 `ELECTRON_RUN_AS_NODE` 模式**，M0 已实测通过 ✅） |
| 2 | 原生模块：`node-pty`、`sharp`、`koffi`、`@img/*`（libvips 二进制） | 均为 **N-API / node-addon-api / 纯平台二进制**，理论跨 Electron ABI 可用；但"理论"必须由构建期门禁验证（3.3 ABI 扫描 + 3.4 打包后 smoke），失败即回退捆绑 Node 22（2.2） |
| 3 | 完整运行时依赖 ≈ 255 MB（本机 npx 缓存实测；`@deepseek-ai/*` 本体仅 ~20 MB，大头在 AWS SDK/React/原生二进制） | 安装包预计 **130~180 MB**（评审稿 80~120 MB 偏乐观）；剪枝后目标 ≤ 120 MB（3.3） |
| 4 | 前端是纯静态 SPA，与宿主仅 `/api` 一条契约（POST + 2 条下行 WS）；信任栅栏放行回环 | BrowserWindow 加载 `http://127.0.0.1:<port>` 即天然通过栅栏，**DSH 零改动**；`file://` + IPC 桥是官方预留的后续路线，v2 不做 |
| 5 | Windows 上 agent shell 工具走 pwsh（`tool-pwsh`/`pwsh-sandbox` 在 win32 启用） | **PowerShell 7+ 仍是硬前置**：NSIS preflight 检测 + 首启 `--doctor` 双保险（v1 已实现 doctor，逻辑复用） |
| 6 | 用户数据沿用 `$DSH_HOME` 语义：已存在 `~/.dsh` 零迁移，否则 `%LOCALAPPDATA%\DSHDesktop\dsh-home` | 安装器不触碰用户数据；卸载默认保留（NSIS `deleteAppDataOnUninstall: false`，数据目录本就在安装目录之外） |
| 7 | 会话落盘已是 zstd 压缩 JSONL；profile 可作**自包含目录**随包分发 | 终端用户不需要 Node/pnpm；`vendor/profile` 构建期生成（3.3） |
| 8 | v1 实测教训：Win11 26100 上 iexpress `/N` 静默失效；csc SFX 有杀软启发式误报面 | electron-builder NSIS 是被广泛签名的成熟形态，误报面显著小于自解压 zip；正式发布仍必须签名（3.5） |

---

## 二、关键决策

### 2.1 壳形态：Electron 为唯一交付形态

- Electron 主进程托管 host、BrowserWindow 呈现 SPA、Tray/Notification/更新器全部原生；现有 Node+Chrome 壳降级为**轻量回退分支**（3.7），不再作为并行主路线维护。
- 窗口加载 `http://127.0.0.1:<port>`（不是 `file://`）：零改动、走既有信任栅栏；`file://` + IPC fetch 桥留待 DSH 官方实现后作为 v2.5 优化。

### 2.2 Host 托管模式：子进程优先

| | 模式 A：进程内 `boot()` | 模式 B：`ELECTRON_RUN_AS_NODE` 子进程（**推荐**） | 模式 C：捆绑 Node 22 子进程（回退） |
|---|---|---|---|
| 实现 | 主进程 `import` dsh-app-boot 直接 boot | `spawn(electron.exe, ['--expose-internals', <dsh>/lib/bin.js, 'web', '--port', N, ...], {env: {ELECTRON_RUN_AS_NODE:'1'}})` | `spawn(node.exe, [profile-boot.js])`，Node zip 随包分发 |
| 体积 | +0 | **+0（复用 electron.exe）** | +~50 MB |
| ABI 风险 | 高：全部原生模块须与 Electron ABI 匹配，DSH 升级即重验 | 与 A 同源风险（同一 Node），但崩溃隔离 | 无（与用户自装 Node 同语义） |
| 崩溃隔离 | 无，host 异常拖垮壳 | 有，自动拉起（v1 已验证） | 有 |
| 就绪感知 | 直接读 `ctx.webServer.port` | 轮询 admin `/api/status`（v1 已验证） | 同 B |
| DSH 升级 | 主进程依赖树与 DSH 耦合，升级=重打包验证 | host 独立 profile 目录，可单独热升级 | 同 B |
| 建议 | v2.5 候选（等官方 file://+IPC 桥落地再评估） | **v2.0 默认** | `DSH_HOST_RUNTIME=node` 切换开关 |

选 B 的理由：v1 的 launcher.mjs 全部价值就在于"外部监管一个独立 host 进程"（单实例、自选端口、就绪探测、崩溃联动、admin 端口），迁入 Electron 时**这套逻辑一行不丢**；B 模式不捆绑额外运行时、不引 ABI 耦合、保留崩溃隔离，是三者中最优。A 模式是评审稿原推荐，本稿依据 v1 实证反转该结论。

> **M0 实测要求（2026-08）**：模式 B 必须带 `--expose-internals` V8 旗标——Electron 内建 Node 下 cordis-loader 拿不到 internal 句柄，`dsh web` 的 hmr 回退会抛 `--expose-internals is required`；系统 Node 22 对照组无此要求。这是 Electron 路线与 v1 的唯一运行时差异，已固化进 `scripts/boot-smoke.mjs`。宿主入口直接复用 dsh 包自带 `lib/bin.js`（argv 解析、layered env、runProfile、关停编排全部现成），无需自写 profile-boot。

### 2.3 端口 / 数据 / 前置检查

- 端口：自选空闲端口（监听 0 取号再释放，或 3080 起向上探测），以 `--port <N>` 传入 —— v1 逻辑原样保留，避免与用户手开的 `dsh web` 冲突。
- 数据：`DSH_HOME` 解析优先级与 v1 完全一致（① 已存在 `~/.dsh` 沿用；② 否则 `%LOCALAPPDATA%\DSHDesktop\dsh-home`）。
- 前置：PS7 双保险 —— 安装器 NSIS preflight 脚本探测 `pwsh`（无则引导 `winget install Microsoft.PowerShell`）+ 首启 `--doctor` 体检标红。

### 2.4 更新通道：electron-updater

- electron-builder `publish: github`（GitHub Releases 主源；企业内网可换 generic/S3 自建源）。
- NSIS **blockmap 差分**更新（electron-builder 自动产出 `.blockmap`，差分体积预计 10~30 MB 量级）；差分失败自动回退全量安装包。
- 版本策略：桌面壳独立 semver（当前基线 0.3.0 → Electron 首发 0.4.0），`vendor/profile` 内锁定 DSH rc 版本并写进 CHANGELOG；DSH 升级与壳升级解耦。
- 更新点：启动后静默 `checkForUpdatesAndNotify` + 托盘"检查更新"手动入口；更新失败不清状态、不阻塞启动。

---

## 三、构建流水线（核心章节）

### 3.1 目录结构

```
desktop-electron/
├─ package.json                  # electron ≥35 + electron-builder + electron-updater（devDependencies）
├─ electron-builder.yml          # NSIS x64/arm64、appId、图标、签名、publish（见 3.2）
├─ src/
│  ├─ main.mjs                   # 主进程：单实例锁 → 起 host → 就绪探测 → BrowserWindow → 托盘/通知/自启/深链/更新器
│  ├─ host.mjs                   # host 托管：模式 B（RUN_AS_NODE，必须带 --expose-internals，M0 实测）/ C（捆绑 Node）切换 + 崩溃自动拉起
│  ├─ admin.mjs                  # admin 服务：移植自 launcher.mjs（status/autostart/workspace/focus/quit + settings.html 直出）
│  ├─ settings.html              # 壳内设置页：v1 原样复用
│  └─ desktop.patch.yml          # 形态层 patch：port 由壳传入、printUrl false（评审稿 2.5，无代码改动）
├─ vendor/
│  └─ profile/                   # 构建期生成：自包含 profile（bundles 锁定 rc.6 + node_modules，见 3.3）
└─ scripts/
   ├─ build-host.mjs             # 生成 vendor/profile：锁定安装 → N-API 扫描 → 剪枝 → 校验清单
   ├─ smoke.mjs                  # v1 原样复用：boot → 就绪 → admin API 全量 → 关停；对打包产物再跑一遍
   ├─ sign.ps1                   # Authenticode 签名（证书注入 CI）
   └─ .github/workflows/release.yml   # CI：门禁 → 打包 → 签名 → 发布 draft release
```

### 3.2 electron-builder 配置要点

```yaml
appId: com.deepseek.dsh-desktop
productName: DSH Desktop
directories:
  output: dist
  buildResources: build            # icon.ico 等
files:
  - src/**
  - vendor/profile/**              # DSH 自包含 profile 整体随包
  - package.json
extraResources: []                 # vendor 已在 files 内，无需重复
asar: true
asarUnpack:
  - "**/*.node"                    # 原生二进制必须解包（asar 内不可加载）
  - "**/node_modules/@img/**"      # libvips 平台二进制同理解包
win:
  target: [{ target: nsis, arch: [x64] }]   # arm64 视需要（v2.1 评估）
  icon: build/icon.ico
  signtoolOptions:                 # 或 certificateFile 静态配置；CI 注入见 3.5
    certificateSubjectName: ${env.CERT_SUBJECT}
nsis:
  oneClick: true
  perMachine: false                # 免管理员，安装到 %LOCALAPPDATA%\Programs\DSH Desktop
  allowToChangeInstallationDirectory: false
  runAfterFinish: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
  deleteAppDataOnUninstall: false  # 卸载保留用户数据（提示备份）
  differentialPackage: true        # blockmap 差分（electron-updater 前提）
  include: build/installer-extra.nsh   # PS7 preflight + 卸载保留数据提示（可选）
publish:
  provider: github
  owner: <org>
  repo: dsh-desktop-releases
```

要点说明：
- **asarUnpack 是硬要求**：`.node` 与 `@img/*` 二进制在 asar 内无法被系统加载器读取，必须解包；这是 Electron 打包 DSH 最常见的翻车点，写入 smoke 门禁。
- 体积：Electron win-x64 ~100 MB + vendor/profile（剪枝后 ~150~200 MB）→ NSIS LZMA 压缩后预计 **130~180 MB**；剪枝与 `@img` 平台单一化后目标 ≤ 120 MB。
- electron-builder 自动下载 NSIS 工具链与 Electron 发行包，**构建机无需安装 makensis/ISCC**（v1 的本机痛点直接消除）。

### 3.3 vendor/profile 自包含构建（build-host.mjs）

输入：锁定 `@deepseek-ai/dsh@<rc 版本>` 的依赖清单；输出：`vendor/profile/{package.json, node_modules, profile-boot.js}` + `vendor.lock.json` 校验清单。步骤：

1. **锁定安装**：`npm ci --omit=dev`（npm 10 已内建，无需 pnpm——DSH 双锚解析与包管理器无关，dsh-app-boot 源码实证；pnpm 仅在 `dsh plugin` CLI 装插件场景需要，v2 不涉及），bundles 锁定 `dsh-base` + `dsh-web-app` + `desktop.patch.yml` 应用位。
2. **ABI 扫描**：遍历 `node_modules`，枚举所有 `.node`/原生绑定，校验其声明为 N-API（`process.dlopen` 前逐项断言导出 `napi_register_module` 符号）；任何非 N-API 项 → 构建失败并列出，转模式 C（捆绑 Node 22）或 electron-rebuild 处理。
3. **剪枝**（v2 先做低风险项，AWS SDK 等评估后跟进）：剔除可选依赖、纯 dev 依赖残留、`@img` 非 win32-x64 平台包、重复 license/README。
4. **产出清单**：`vendor.lock.json` 记录 DSH 版本、Node ABI 目标、N-API 扫描结果、文件数/体积，随安装包发布，用于支持排查与升级决策。

### 3.4 打包前门禁（全自动，任一失败即止）

```
语法校验（node --check main/host/admin + YAML parse）
  → smoke.mjs 开发态全量（v1 原样：boot → 就绪 → admin API 全量断言 → 关停）
  → electron-builder --win nsis 打包
  → 对 dist 产物解包/安装到沙盒目录 → smoke.mjs 再跑一遍（验证 asarUnpack 完整性）
  → 签名校验（signtool verify）→ 产出 draft release + blockmap
```

### 3.5 签名与信任

- 开发/内测：自签证书（本机可生成）+ 测试机信任；**CI 不落盘私钥**（证书与密码走 GH Secrets / Azure Key Vault）。
- 正式：EV/OV Authenticode 证书（`signtool` / electron-builder `win.signAndEditExecutable`）。签名是 electron-updater 稳定差分与降低 SmartScreen/杀软误报的前提；更新链上**保持同一签名主体不变**。
- 预期：未签名 → "Windows 已保护你的电脑" + SmartScreen 警告；自签 → 需手动信任；EV → 逐步积累信誉，提示显著减少。

### 3.6 CI（GitHub Actions，windows-latest）

```
push tag v* 触发：
  checkout → setup-node 22 → npm ci（构建工具）→ node scripts/build-host.mjs
  → 3.4 门禁（smoke 开发态）→ electron-builder 打包 → signtool 签名
  → smoke 打包产物 → 上传 draft release（exe + blockmap + vendor.lock.json）
  → 通知维护者人工发布；发布即触发已装端 electron-updater
```

### 3.7 轻量回退分支（不废弃、不主推）

- 保留 `desktop-shell/build-installer.ps1` 链路（NSIS > Inno > csc > cmd 多级回退）作为**无 Electron 环境/体积敏感场景**的 B 分支。
- 两分支共享同一套门禁契约：`smoke.mjs`、`--doctor`、admin API 语义、`VERSION`/CHANGELOG 格式 —— 保证任一分支回退时行为规格一致。
- 分支间资产关系：launcher.mjs 是 Electron main.mjs 的移植母本；每次功能改动先改契约（smoke/doctor），再落两个实现。

---

## 四、安装包行为规格（与 v1 规格对齐，NSIS 化）

| 项 | 规格 |
|---|---|
| 安装目录 | `%LOCALAPPDATA%\Programs\DSH Desktop`（per-user，免管理员，oneClick） |
| 快捷方式 | 桌面 + 开始菜单；启动隐藏控制台（Electron GUI 子进程无控制台窗口） |
| 协议注册 | `dsh://` → `setAsDefaultProtocolClient('dsh')`；second-instance 事件解析 argv（v1 语义：聚焦窗口；`dsh://session/<id>` 会话直达排期 v2.1） |
| 开机自启 | `app.setLoginItemSettings({openAtLogin})`（替换 v1 的 HKCU Run 注册表写）；设置页开关经 admin API 写回 |
| 卸载 | NSIS 标准卸载器；`deleteAppDataOnUninstall: false`，用户数据（`dsh-home`/日志/浏览器数据）保留，卸载器提示备份路径 |
| PS7 前置 | NSIS preflight 探测（可选，installer-extra.nsh）+ 首启 `--doctor` 强制体检（缺失提示 winget 安装，不阻断） |
| 日志 | 壳日志 + host stdout/stderr → `%LOCALAPPDATA%\DSHDesktop\logs\`，按天轮转（评审稿 2.6，v1 已有雏形） |
| 版本展示 | 壳内设置页显示壳版本 + DSH rc 版本（读 vendor.lock.json / `VERSION`） |

---

## 五、v1 资产复用映射表（工作量压缩依据）

| v1 实现（已交付） | Electron 对应实现 | 复用度 |
|---|---|---|
| launcher.mjs：单实例、自选端口、就绪探测、崩溃联动、退出编排 | main.mjs + host.mjs（主进程） | 逻辑 1:1 移植 |
| admin 服务（status/autostart/workspace/focus/quit）+ settings.html | admin.mjs + settings.html（原样直出，BrowserWindow 加载） | 100% |
| smoke.mjs / diag-session.mjs | 原样复用（含打包产物复跑） | 100% |
| tray.ps1（WinForms 托盘）/ notify.ps1（气泡） | Tray API / Notification API | 交互规格复用，实现替换为原生 |
| make-shortcuts.ps1 / launch-hidden.vbs / HKCU Run 自启 | NSIS 快捷方式 / setLoginItemSettings | 需求复用，实现替换 |
| build-installer.ps1 多级回退链 | electron-builder（NSIS 直出 + 签名 + 差分） | 链路保留为回退分支（3.7） |
| 深链（`dsh://` 注册 + 聚焦转发） | setAsDefaultProtocolClient + second-instance | 需求复用，实现替换 |

---

## 六、里程碑与工作量

| 里程碑 | 内容 | 验收出口 | 工期 |
|---|---|---|---|
| **M0 技术验证** | `ELECTRON_RUN_AS_NODE` 下 `process.versions.node ≥ 22` + `node:sqlite` 可用性断言；N-API 扫描脚本对 rc.6 依赖树实测；electron-builder 空壳打一个签名安装包 | ABI 扫描零非 N-API 项（或确认需模式 C） | 0.5 天 |
| **M1 壳迁移** | main.mjs/host.mjs 移植 launcher 逻辑；BrowserWindow 加载 loopback；托盘/通知/自启/深链原生化；安全加固（见评审稿 2.7，含 `sandbox:true`、`will-navigate` 拦截、通知权限白名单、生产禁 DevTools） | 双击 exe → 窗口 → 建会话 → 与 v1 功能等价；smoke 开发态全绿 | 2~4 天 |
| **M2 构建与分发** | build-host.mjs + vendor/profile；electron-builder 配置（asarUnpack/NSIS/publish）；签名接入 CI；electron-updater 接入 | 安装包产出 + 签名有效 + 沙盒安装后 smoke 全绿 + 差分更新实测 | 2~3 天 |
| **M3 加固与矩阵** | Win10/11 × x64：全新安装 vs 老 `~/.dsh` 迁移；断网启动；host 崩溃恢复；长会话；AV/SmartScreen 观察；日志轮转 | 第八章节全部验收项 | 2~4 天 |
| **合计** | | | **主程 8~12 人日**（v1 资产复用）+ 测试/发布 2~4 人日 |

---

## 七、风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| 原生模块与 Electron ABI 失配（理论 N-API，实测有例外） | 高 | 3.3 ABI 扫描 + 打包后 smoke 双门禁；命中即切模式 C（捆绑 Node 22），壳侧零改动 |
| `ELECTRON_RUN_AS_NODE` 语义差异（个别库探测 Electron 环境误判） | 中 | M0 首日全量冒烟覆盖 DSH 全链路；异常切模式 C 开关（`DSH_HOST_RUNTIME`） |
| 安装包体积超预期（130~180 MB） | 中 | 剪枝路线图（AWS SDK 等）；NSIS 差分更新让"每次更新体积"远小于"首次安装体积"；体积敏感者走 3.7 回退分支 |
| SmartScreen / 杀软对未签名或新签名主体的警告与误报 | 中 | 签名 + 信誉积累；保留回退分支；发布前 VirusTotal 抽查 |
| electron-updater 发布链故障（release 不齐、blockmap 缺失） | 中 | 门禁脚本校验 release 资产完整性；更新失败静默降级"仅提示手动下载"，不阻塞应用 |
| DSH 上游升级导致 desktop patch / vendor 失效 | 中 | patch 只动行 config 不改行 id；vendor 锁定版本 + vendor.lock.json；升级前跑全套 smoke |
| 端口冲突（用户已开 `dsh web`） | 低 | v1 自选空闲端口策略原样保留 |
| PowerShell 7 缺失 | 中 | NSIS preflight + 首启 doctor 双保险；不阻断安装（PS7 仅影响 agent shell 工具） |

---

## 八、验收标准

1. 全新 Win11 机器：**安装（免管理员）→ 双击 → 建会话 → 完成一次带工具调用的任务**，全程零命令行交互、零 Node/pnpm/Chrome 依赖。
2. 已有 `~/.dsh` 的老用户：安装后直接看到原会话历史与设置，无迁移操作；卸载后数据完整保留。
3. 托盘：最小化/退出/新建会话/打开数据目录/检查更新全部可用；通知可达；自启开关即时生效。
4. 断网启动不白屏、不崩溃；host 异常退出后壳给出可读提示并支持一键重启；更新检查失败不影响启动。
5. **打包产物门禁**：smoke.mjs 对安装后的打包产物全绿（boot → 就绪 → admin API 全量 → 关停）；`signtool verify` 签名有效；asarUnpack 项可加载。
6. **差分更新实测**：发布 v+1 测试 release → 已装端收到更新 → blockmap 差分安装 → 版本号与 CHANGELOG 正确。
7. 杀软/SmartScreen 抽查：VirusTotal 检出率低于阈值（签名后）；有问题的哈希记录在案并复测。
8. 与 `dsh web` 浏览器版功能等价性抽查：会话、设置、模型切换、子代理、workflow、goal、插件管理页（沿用评审稿 2.11）。
9. 双分支契约一致性：回退分支（3.7）与 Electron 分支通过同一份 smoke 与 doctor 断言。

---

## 附录 A：版本矩阵（构建期断言，非纸面承诺）

| 组件 | 基线 | 说明 |
|---|---|---|
| Electron | 实测 **43.4.0**（内建 Node 24.18.1 / Chromium 150；下限 ≥ 35 满足） | 锁定后不再随意升级；升级前跑全套 smoke 与 ABI 扫描 |
| DSH | `@deepseek-ai/dsh@0.1.0-rc.6` 锁定 | vendor/profile 内锁定；升级走独立流程（评审稿 2.10 对策） |
| electron-builder / electron-updater | 当前稳定线（26.x / 6.x 系） | 以 npm 发布为准；升级随 CI 验证 |
| Node（构建机） | 22.x | 仅构建期使用，终端用户零依赖 |
| PowerShell 7+ | 前置检查项（非捆绑） | 缺失引导 winget，不阻断安装 |

## 附录 B：命令速查（评审后实施）

```powershell
# 开发态
node scripts/build-host.mjs          # 生成 vendor/profile + ABI 扫描 + 剪枝
npx electron src/main.mjs --dev      # 壳直启（--dev 保留 DevTools）
node scripts/smoke.mjs               # 门禁冒烟（开发态）
# 打包态
npx electron-builder --win nsis      # 打包 + blockmap（无需本机 makensis）
node scripts/smoke.mjs --dist dist   # 对安装产物复跑冒烟
scripts\sign.ps1 -File dist\*.exe    # Authenticode 签名（CI 注入证书）
# 发布
git tag v0.4.0 && git push --tags    # CI 打包签名 → draft release → 人工发布 → 差分更新生效
```
