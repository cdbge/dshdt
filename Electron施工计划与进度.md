# Electron 桌面化 · 施工计划与进度

> 方案依据：《Electron构建安装包计划书.md》｜ 架构依据：《DeepSeek-Harness桌面应用封装计划书.md》
> **本文件是唯一进度事实源**：每完成一个阶段就更新第 2 节快照表；中断后从这里恢复。

---

## 0. 恢复协议（中断后怎么续）

1. 每次开工：读本文件"进度快照"→ 找到最后一个 ✅ 检查点 → **重跑该检查点命令**确认环境没变 → 从下一阶段继续。
2. 每阶段结束：跑检查点 → 更新快照表 → `git commit`。**不 commit 不进下一阶段**（commit 是中断恢复与回滚的锚点）。
3. 所有检查点命令均幂等、可重复执行（已按此设计）。
4. 环境类改动（装 pwsh 等）完成后，立刻回填第 1 节"实测"列。
5. 代码改动原则：先跑相关检查点确认基线绿，再动代码；动完重跑检查点。

---

## 1. 前置依赖核对（2026-08 本机实测）

| 项 | 要求 | 实测 | 动作 |
|---|---|---|---|
| Windows | Win10/11 x64 | ✅ 11 26100 | — |
| Node.js | ≥ 22（DSH 硬性） | ✅ v22.21.0 | — |
| npm | 随 Node | ✅ 10.9.4 | — |
| **PowerShell 7+** | agent 的 shell 工具硬依赖（系统 5.1 不满足） | ✅ **7.6.5 已装**（`C:\Users\31893\AppData\Local\Microsoft\WindowsApps\pwsh.exe`） | 完成 |
| **包管理器** | vendor/profile 构建期安装依赖；DSH 双锚解析（dsh-app-boot 源码实证）与包管理器无关 | ✅ npm 10.9.4（本机 DSH npx 缓存即 npm 布局，运行正常） | **无需 pnpm**；仅当 v2.5 引入 `dsh plugin` CLI 装插件时再 `corepack enable pnpm` |
| git | 版本管理（恢复协议依赖它） | ✅ 已装；**但 workspace 不是 git 仓库** | 阶段 0 执行 `git init` + 首次 commit |
| winget | 装 PS7 用 | ✅ 存在（若首次无输出，从 Microsoft Store 更新"应用安装程序"） | — |
| VS Code | 编辑器 | ✅ | — |
| Docker | 本项目用不上（CI 走 GitHub Actions Windows runner） | ✅（保留，无需动） | — |
| makensis / ISCC | **不需要**（electron-builder 自带 NSIS 工具链） | ❌ 未装 | 不装 |
| Google Chrome | 不再必需（Electron 自带 Chromium）；仅作 `dsh web` 对照测试 | ✅ 已装 | — |
| 磁盘余量 | 建议 ≥ 5GB（node_modules ~1GB + Electron/electron-builder 缓存 ~2GB + dist） | ✅ **D 盘 200GB 余量**（用户确认，绰绰有余） | — |
| 网络加速（可选） | 国内下载 Electron 二进制慢 | registry 为官方源 | 可选：`setx ELECTRON_MIRROR https://npmmirror.com/mirrors/electron/`（新终端生效） |
| 代码签名证书 | M2 起需要；开发期用自签 | ❌ | M2 生成自签证书；EV 证书正式发布前再买 |

**结论：前置依赖现已全部就绪（PS7 7.6.5 ✅、npm 10 ✅、Node 22 ✅、磁盘 200GB ✅）；开工只差阶段 0 的 git init。**

---

## 2. 进度快照

| 阶段 | 内容 | 状态 | 最后检查点 | 备注 |
|---|---|---|---|---|
| 0 | 工程底座（git init + 骨架 + 依赖） | ✅ 完成 | electron **43.4.0** / electron-builder **26.15.3** / electron-updater **6.8.9**；commit `30ee2c8` 骨架 + 依赖 commit | 检查点：`electron.exe --version` → v43.4.0 ✅ |
| 1 | M0 技术验证（RUN_AS_NODE + sqlite + ABI 扫描） | ✅ 完成 | 断言 1~4 全绿：Node 24.18.1 / sqlite OK / ABI 6OK+5SKIP 0失败 / boot→GET 200→优雅关停 | **关键发现**：Electron 内建 Node 需 `--expose-internals`（hmr 回退要求，系统 Node 无需）；实现为 `scripts/boot-smoke.mjs`（含旗标开关） |
| 2 | M1a 壳迁移（host 托管 + BrowserWindow + 安全基线） | ✅ 完成 | `--smoke` 全绿 + admin API 契约验证 + **用户实测 `npm start` 窗口正常**（findDshBin 锚点 bug 已修 `c4ac566`） | — |
| 3 | M1b 原生集成（托盘/通知/自启/深链/设置页） | 🔄 进行中 | **全量 smoke 21/21 PASS**（含 workspace 回写修复）；托盘/close-to-tray/dsh:// 协议/通知白名单/自启代码就位 | 剩：用户侧托盘五项手测（打开/设置/数据目录/工作区/退出）+ close-to-tray + `start dsh://` 聚焦 |
| 4 | M2 构建与分发（剪枝 + electron-builder + 签名 + 更新器） | ✅ 完成 | **最终安装包 128.8MB**（vendor 剪枝 207→132MB、文件数 32760→15375 减半；自签 + blockmap）；打包产物 smoke exit 0；v1 残留已清 | 安装计时需用户交互会话（后台无 UI，SmartScreen 类提示会挂起）；发布源按需激活 |
| 5 | M3 加固与矩阵（Win10/11、断网、崩溃、AV） | ⬜ 排期 | — | v0.4.0 之后：Win10×x64 矩阵、VirusTotal 抽查、日志轮转、EV 证书采购 |

---

## 3. 阶段目标与方法（每个阶段 = 目标 + 方法 + 检查点 + 产出）

### 阶段 0 · 工程底座（约 0.5 小时）

- **目标**：workspace 变 git 仓库，`desktop-electron/` 骨架 + 依赖就位，可随时回滚。
- **方法**
  1. `git init`（在 `D:\Desktop\deepseek` 仓库根；`.gitignore` 先排除 `node_modules/`、`dist/`、`vendor/profile/`——后者由 build-host.mjs 生成）。
  2. 建骨架：`desktop-electron/{package.json, .gitignore, electron-builder.yml(占位), src/, scripts/}`。
  3. 依赖：`npm i -D electron@latest electron-builder electron-updater --ignore-scripts` 后手动 `node node_modules\electron\install.js`（沙箱管道限制，见通用约定；实测装到 electron 43.4.0）。
  4. `git add -A && git commit -m "M0: skeleton"`。
- **检查点**
  ```powershell
  git -C D:\Desktop\deepseek status            # 期望：clean
  .\node_modules\electron\dist\electron.exe --version   # 期望：v43.x（≥35）；沙箱下避免 npx（管道受限）
  ```
- **产出**：git 仓库 + 骨架 + package.json。

### 阶段 1 · M0 技术验证（约 0.5 天）——通过前不写壳代码

- **目标**：证明计划书模式 B 成立：`ELECTRON_RUN_AS_NODE` 下 Node ≥ 22、`node:sqlite` 可用、rc.6 依赖树原生模块全部可加载。
- **方法**
  1. **断言 1（内建 Node 版本）**：
     ```powershell
     $env:ELECTRON_RUN_AS_NODE='1'
     .\node_modules\electron\dist\electron.exe -e "console.log(process.versions.node)"
     # 期望 ≥ 22.14
     ```
  2. **断言 2（node:sqlite）**：同上执行 `require('node:sqlite')`，期望无异常。（✅ 已实测：`DatabaseSync=function`，仅 experimental 警告）
  3. **断言 3（ABI 扫描）**：写 `scripts/abi-scan.mjs` —— 把 rc.6 依赖装进 `vendor/profile/node_modules` 后，逐个 `require`/`dlopen` 所有 `.node` 二进制并断言可加载（node-pty/sharp/koffi/@img）。任一失败 → 记入 vendor.lock.json 并切换"模式 C（捆绑 Node 22）"决策。
  4. **断言 4（真实 boot）**：复用 dsh 包自带入口（免重写 runProfile 逻辑）：`ELECTRON_RUN_AS_NODE=1 electron.exe --expose-internals <dsh>/lib/bin.js web --port 0`；实现为 `scripts/boot-smoke.mjs`（spawn 数组参数 + 文件描述符重定向 + URL 轮询 + fetch + kill；`--expose-internals` 开关）。（✅ 已实测：就绪 URL → GET 200 → SIGTERM 优雅关停；**Electron 内建 Node 必须带 `--expose-internals`**，系统 Node 对照组无需）
  5. 产出 `vendor.lock.json`（DSH 版本、Node ABI 目标、扫描结果、体积）。
- **检查点**
  ```powershell
  node scripts/abi-scan.mjs       # 期望输出：N 个 .node 全部 load OK；0 失败
  node scripts/smoke.mjs          # 期望：boot → 就绪 → 关停 全绿（v1 脚本适配 profile-boot 入口）
  ```
- **产出**：`scripts/abi-scan.mjs`、`scripts/build-host.mjs`（初版：锁定安装+扫描）、`vendor/profile/`（初版，不剪枝）、`vendor.lock.json`。

### 阶段 2 · M1a 壳迁移（2~4 天）

- **目标**：双击能开窗，窗口内是完整的 DSH UI，与 `dsh web` 等价。
- **方法**
  1. `src/host.mjs`：移植 launcher.mjs 的宿主监管逻辑 → `spawn(electron.exe, [profile-boot.js, --port <自选>, --patch desktop.patch.yml], {env:{ELECTRON_RUN_AS_NODE:'1', ...}})`；自选空闲端口（监听 0 取号再释放）；就绪探测轮询 admin `/api/status`。
  2. `src/main.mjs`：`app.requestSingleInstanceLock()` → 起 host → 就绪后建 `BrowserWindow` 加载 `http://127.0.0.1:<port>`；`webPreferences: {contextIsolation:true, nodeIntegration:false, sandbox:true}`；`will-navigate`/`setWindowOpenHandler` 拦截非回环导航；生产禁 DevTools（`--dev` 开关保留）。
  3. `src/admin.mjs` + `src/settings.html`：v1 的 admin API（status/autostart/workspace/focus/quit）与设置页**原样移植**。
  4. host 崩溃联动：exit → Notification + 一键重启（最小实现）。
  5. `desktop.patch.yml`：port 由壳传入、`printUrl: false`（评审稿 2.5，DSH 零改动）。
- **检查点**
  ```powershell
  npm start                        # 期望：窗口出现 → 建会话 → 带工具任务跑通
  node scripts/smoke.mjs           # 期望：开发态全量断言全绿
  git commit -m "M1a: shell works"
  ```
- **产出**：`src/{main,host,admin}.mjs`、`src/settings.html`、`src/desktop.patch.yml`。

### 阶段 3 · M1b 原生集成（1~2 天）

- **目标**：v1 README 功能表在 Electron 下全绿（托盘/通知/自启/深链/设置页/单实例）。
- **方法**
  1. `Tray` 菜单：打开主窗 / 新建会话 / 打开数据目录 / 检查更新 / 退出；窗口关闭 → 托盘化（沿用 v1 默认策略）。
  2. `Notification`：host 崩溃、更新可用；`session.setPermissionRequestHandler` 放行 notifications（SPA 用）。
  3. `app.setLoginItemSettings({openAtLogin})` 替换 v1 的 HKCU Run；设置页开关经 admin API 写回。
  4. `app.setAsDefaultProtocolClient('dsh')` + `second-instance` 事件解析 argv → 聚焦窗口（v1 语义）。
  5. 单实例：第二实例 `window.focus()`（对应 v1 的 `/api/focus` 转发）。
- **检查点**：`node scripts/smoke.mjs` 全量断言（含 admin API 面）+ 托盘五项手测 + 深链 `start dsh://` 聚焦实测。
- **产出**：原生集成代码 + 更新后的 smoke 断言。

### 阶段 4 · M2 构建与分发（2~3 天）

- **目标**：签名有效的 NSIS 安装包 + GitHub Releases 差分更新链路。
- **方法**
  1. `scripts/build-host.mjs` 补剪枝步骤（剔除可选依赖、`@img` 非 win32-x64 平台包）→ 记录剪枝前后体积。
  2. 按计划书 3.2 落地 `electron-builder.yml`（`asar: true` + **`asarUnpack: ["**/*.node","**/node_modules/@img/**"]`** + NSIS per-user oneClick + `deleteAppDataOnUninstall: false` + `differentialPackage: true` + publish）。
  3. `npx electron-builder --win nsis` → 沙盒目录安装 → `node scripts/smoke.mjs --dist`（对打包产物复跑，验证 asarUnpack 完整性）。
  4. 签名：`scripts/sign.ps1` 生成自签证书 → 签名 → 本机信任；CI 用 Secrets 注入（EV 证书正式发布再买）。
  5. GitHub：建 `dsh-desktop-releases` 仓库 → `.github/workflows/release.yml`（门禁 → 打包 → 签名 → draft release）→ tag `v0.4.0` 试跑 → electron-updater 接入 → 发 `v0.4.1` 验证**差分更新实测**。
- **检查点**
  ```powershell
  Get-Item dist\DSHDesktop-Setup-*.exe          # 期望：存在，130~180MB 量级
  signtool verify /pa dist\*.exe                 # 期望：签名有效（自签阶段用本地信任验证）
  node scripts/smoke.mjs --dist                  # 期望：打包产物全绿
  # 差分更新：装 v0.4.0 → 发布 v0.4.1 → 客户端收到更新并成功差分升级
  ```
- **产出**：安装包、CI、更新通道、签名流程。

### 阶段 5 · M3 加固与矩阵（2~4 天）

- **目标**：计划书第八章验收标准 1~9 全过。
- **方法**：Win10/Win11 × x64 矩阵（Hyper-V 虚拟机或借机器；全新安装 vs 老 `~/.dsh` 迁移）；断网启动；host 进程 kill 恢复；长会话内存观察；日志按天轮转落地；VirusTotal 抽查（签名后）。
- **检查点**：验收清单逐项打勾（表见《Electron构建安装包计划书.md》第八章）；每个修复都回填 smoke 断言防回归。
- **产出**：加固实现 + 测试报告。

---

## 4. 通用方法约定

- **不 commit 不进下一阶段**；commit message 带阶段号（M0/M1a/...）。
- 检查点失败 = 阶段未完成；修复后重跑，不"口头通过"。
- 所有对 v1（`desktop-shell/`）的移植以 `smoke.mjs` 语义为准：行为契约先行，实现可换。
- 包管理器统一 **npm**（`npm ci --omit=dev`）；pnpm 仅在 `dsh plugin` CLI 装插件场景需要，v2 不用。
- **沙箱管道限制（本机实测）**：子进程 spawn 用 `stdio:'inherit'`/`'ignore'`，不能用默认 pipe（EPERM）；npm 生命周期脚本用 `--ignore-scripts` 后手动跑 `node node_modules\electron\install.js`；断言脚本输出用 `process.stdout.write(...) + process.exit(0)` 防丢行。用户自己的终端无此限制。
- DSH 零改动承诺维持：壳侧需要的一切走 `--port`/`--patch`/admin API，不动 DSH 源码。
