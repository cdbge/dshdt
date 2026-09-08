# DeepSeek Harness 桌面应用封装计划书

> 版本：v1.0（评审稿） · 日期：2026-02 · 依据版本：`@deepseek-ai/dsh@0.1.0-rc.6`（本机实际部署实证）
> 本计划书只做方案陈述，不涉及任何代码改动；经评审确认后再按里程碑实施。

---

## 0. 摘要

DeepSeek Harness（下称 DSH）本质上是一个 **"Node.js 宿主进程 + Cordis 插件组合运行时 + 浏览器 SPA 前端"** 的三层架构。它当前的官方交互形态是 `dsh web` —— 在 `127.0.0.1:3080` 起一个本地 HTTP 服务，用户用浏览器访问。因此"桌面化"的核心工作不是重写，而是 **给它配一个原生的 Windows 窗口壳（shell）**：把宿主进程托管进壳的生命周期，把现有 SPA 装进原生窗口，再补齐托盘、通知、单实例、开机自启、自动更新等桌面能力。

本文第一部分基于对本机 `~/.dsh` 实际部署的源码与配置逐层拆解，讲清楚 DSH 的底层逻辑与架构；第二部分给出方案选型对比、推荐架构、实施路线与验收标准。

---

## 一、DeepSeek Harness 底层逻辑与架构

### 1.1 一句话总览

> **DSH = 一个"可热重组的插件操作系统"，运行在 Node.js 上，前端是纯静态 SPA，与宿主通过本地 HTTP + WebSocket 通信。**

一切能力（LLM 路由、工具、会话、沙箱、权限、Web UI）都是 **Cordis 插件**；"运行 DSH"就是 **按分层 patch 把几百行插件配置组合成一颗依赖图并激活**；"扩展 DSH"就是 **在某个 patch 层插入一行插件配置**，甚至无需重启（HMR 支持配置热更新）。

### 1.2 进程与目录拓扑（本机实证）

```
┌─ 启动链路（进程侧）
│  npx dsh web            # 极薄启动器 @deepseek-ai/dsh (lib/bin.js)
│    └─ parseDshArgs()    # 只解析启动器自有 flag：--profile / --patch / --dump-config
│    └─ loadLayeredEnv()  # 冻结环境快照：继承环境 > 项目 .env > 用户 .env
│    └─ runProfile()      # dsh-app-boot.boot()：建 Cordis 根上下文、装 Loader、挂 include 树
│       └─ 组合配置树（见 1.3）→ Loader 并发激活全部插件 → 树结算断言
│       └─ webserver 绑定 127.0.0.1:3080 → 打印 URL 行 → 常驻
│
├─ 数据侧 $DSH_HOME（默认 ~/.dsh，本机 C:\Users\31893\.dsh）
│  ├─ profiles/web/          # web profile：package.json(清单) + cordis.patch.yml(用户层)
│  ├─ profiles/node_modules/ # 扁平符号链接场：healProfilesModuleFallback 维护，
│  │                         #   使任意 profile 的裸插件名都能被 Node 解析
│  ├─ sessions/…/session.jsonl.zstd   # 会话日志：追加式压缩 JSONL + 请求前检查点
│  ├─ storages/              # JSON 存储：会话投影缓存、workspace 记录
│  ├─ settings.yaml          # 用户设置文档（热重载）：模型、locale、默认 preset
│  ├─ .credentials.yaml      # 受管凭据（Models 页只写这里，不落环境变量）
│  └─ .agent-presets/        # 用户自研 agent preset 目录
│
└─ 浏览器侧（访问 http://127.0.0.1:3080）
   └─ dist/ 静态 SPA（@deepseek-ai/dsh-web-frontend，Vite 构建 ~1.2MB JS）
      └─ window.__DSH_BOOT__ 由 host 端 modules 插件按 dsh.client 行扫描合成
      └─ 壳内核在 Cordis 存在前先构建 client 内核 → 装载约 30 个 dsh-client-ui-* 插件
      └─ 与 host 通信：HTTP POST /api（unary/respond）+ 2 条只下行 WebSocket
```

### 1.3 组合（Composition）机制 —— DSH 的灵魂

组合树从**空根**开始，按顺序叠加 patch 层，**后写覆盖先写（按行 id）**：

```
空配置根 []
  └─ @deepseek-ai/dsh-base      # 共享核心：~90 行插件条目（见 1.4）
  └─ @deepseek-ai/dsh-web-app   # Web 形态层：传输、存储、浏览器插件名册（见 1.5）
  └─ profiles/web/cordis.patch.yml   # 用户 profile 层
  └─ $DSH_HOME/cordis.patch.yml      # 用户 home 层（优先级更高）
  └─ --patch 覆盖层（优先级最高）
```

- patch 是 YAML 数组：`insert`（插入新条目）或按 `id` 定位的 `config` 整体替换；支持 `!!js` 表达式在挂载期插值（例如 `port: !!js ctx.webStartup.port ?? 3080`）。
- 插件条目 = `{id, name(package), config, inject, disabled}`；Loader 按**服务可用性**决定激活顺序（不是文件顺序），谁 inject 谁等待。
- profile 是一个目录（`$DSH_HOME/profiles/<name>`），含 `package.json`（manifest 声明 `dsh.profile.bundles` 有序 bundle 列表 + 树外插件依赖）与用户 `cordis.patch.yml`；`web`、`headless` 两个 profile 首次使用自动初始化。
- **agent preset**（`$DSH_HOME/.agent-presets/<id>/cordis.yml`）是同一套机制在会话层的复用：每个会话在自己的 isolate realm 里挂一个 preset，preset 决定该 agent 的工具、人设、提示词段落。Web 形态下 base 层的 agent 平面行（tool-bash、tool-fs、tool-subagent、plan-mode 等）被**禁用**，改由各会话的 preset 挂载 —— 这是"多会话隔离"的关键设计。

### 1.4 dsh-base：主机平面（host plane，所有形态共享）

按功能分组（行 id 为证，取自本机 `dsh-base/cordis.patch.yml`）：

| 域 | 代表条目 |
|---|---|
| 模型 | `llm`（适配器注册）、`llm-deepseek`（原生 DeepSeek 适配，密钥/端点按请求从凭据与 settings 解析）、`llm-pi-ai`（多供应商休眠孪生）、`llm-retry`、`agent-default-model` |
| 会话 | `session`、`session-persistence-jsonl`（追加式压缩日志 + 请求前检查点）、`session-title(-llm)`、`session-projection(-cache)`、`session-query-sqlite`（默认 `:memory:` + 永不打开）、`session-telemetry-otel`（默认 DISABLED） |
| 类型化 RPC | `typert`（注册表）、`typert-loader`、`api-gateway` → 全形态共享的传输无关分发面 |
| 安全 | `sandbox` + `sandbox-policy`（默认 workspace-write）、`approval`（默认 ask）、`permission-presets`（read-only / workspace-write / danger-full-access 三档）、`bash-sandbox`（win32 禁用）、`pwsh-sandbox`（非 win32 禁用）、`sandbox-windows-acl` |
| 工具 | `tool-bash`/`tool-pwsh`（平台互斥）、`tool-fs`/`tool-fs-search`、`tool-skill`、`tool-goal`、`tool-todo`、`tool-subagent`/`tool-subagent-fork`、`tool-workflow`、`tool-ralph`、`tool-web`（searchProvider: deepseek-official，fetch 禁用）、`tool-str-replace-editor`、`tool-jobs`、`tool-ask-user`、`tool-cordis` |
| 编排 | `agent`、`agent-loop`、`subagent` + `subagent-spawn/fork-in-process`（进程内子代理，可续谈）、`workflow-worker-thread`、`goal` + `goal-round-driver`、`schedule`、`jobs-local` |
| 上下文管理 | `token-meter`、`compaction-basic`、`compaction-tool-result-pruner`、`spill` + `spill-policy`、`timeout-policy`、`repeat-tool-reminder` |
| 其他 | `settings-file`（热重载）、`credentials-local`、`shell-env`、`system-prompt`（persona 空，由形态层填）、`plan-mode`、`web` + `web-search-deepseek`、`hmr`、`timer` |

**设计要点**：这些行绝大多数是"注册表 / 服务 / 工具注册"三者分离 —— 例如 skill 注册表在 host 平面、`tool-skill` 在 preset；`tool-jobs` 在 host、job 控制工具在 preset。注释里明确写着判定标准：**"一个 Service 若被其 realm 之外的兄弟行读取，就必须属于双方都能看见的平面"**。

### 1.5 dsh-web-app：Web 形态层（本次封装的目标层）

```
传输层
  web-startup      # 解析 --host/--port/--trusted-host（--port 0 = 系统分配）
  webserver        # node:http 服务，默认 127.0.0.1:3080；精确路由 → 最长前缀 → fallback
  web-runtime      # 解析前端 dist、挂 fallback、打印 URL 行、提供 webRuntime（信任边界事实）
  connection       # /api 唯一路由（Fetch 桥 + typert interceptor 先认领）+
                   #   /api/events.mux、/api/events.host 两条只下行 WebSocket
                   #   信任栅栏：Host 必须回环或命中 trustedHosts；--host 0.0.0.0 被明确拒绝
  api-gateway      # 特权方法集（pickDirectory/openPath/settings/credentials/agentPreset 管理面）
浏览器名册（dsh.client 行，node 半侧扫描进 window.__DSH_BOOT__）
  client-runtime / cordis-client-runner / modules / api-remotes / locale / theme
  ui-layout / ui-sidebar / ui-conversation / ui-tool / ui-cordis / ui-workflow-run
  ui-settings(+general/models/plugins/plugin-inventory) / ui-workspace / ui-jobs / ui-goal
  ui-plan / ui-trajectory / ui-subagent / ui-skill / ui-input-trigger / ui-commands
  ui-permission / ui-agent-preset / ui-message-feedback / ui-model-selection
  ui-directory-picker-{auto,browse,native} / ui-deliverables / ui-user-questions
宿主附加
  storage(+json/domain)、workspace、message-feedback、session-log-export、
  plugin-inventory、cordis-host-runner、code-runtime-worker-thread、directory-picker-auto、
  agent-presets（默认 preset: standard）、client-hmr（闲置，等 dev:web 重建）
```

**关键结论（对桌面化最有利的事实）**：

1. **前端是纯静态 SPA**，与宿主之间只有 `/api` 这一条契约（HTTP POST + 2 条 WebSocket 下行）。任何能执行 fetch/WebSocket 的 WebView 都可以做壳。
2. **webserver README 白纸黑字预留了 Electron 形态**："该服务器只服务浏览器；Electron 通过 `file://` 加载 dist，并经 IPC 桥接承载 fetch" —— 官方架构已为桌面壳留了落点（fallback seat / 特权 IPC），只是尚未实现。
3. **信任栅栏天然支持桌面壳**：壳窗口加载 `http://127.0.0.1:3080` 时，请求的 Host 就是回环地址，直接通过栅栏，DSH 一行代码都不用改。
4. dist 里有 `manifest.webmanifest`（name: "DeepSeek Harness"）—— 说明前端本身按 PWA 设计，可作零成本验证路径。

### 1.6 数据与状态落盘（桌面化必须善待的部分）

| 数据 | 位置 | 形态 |
|---|---|---|
| 会话历史 | `$DSH_HOME/sessions/**/session.jsonl.zstd` | 追加式压缩 JSONL，请求前检查点 |
| 投影/缓存 | `$DSH_HOME/storages/*.json` | 会话投影缓存、workspace 记录 |
| 用户设置 | `$DSH_HOME/settings.yaml` | 热重载文档，Web Models 页写入 |
| 凭据 | `$DSH_HOME/.credentials.yaml` | 受管凭据，绝不物化进环境 |
| 匿名 ID | `$DSH_HOME/.anonymous-user-id` | 遥测身份（默认遥测关闭） |
| profile / preset | `$DSH_HOME/profiles/`、`$DSH_HOME/.agent-presets/` | 组合层文件 |

### 1.7 对打包有决定性影响的运行时事实

1. **Node.js ≥ 22**（本机 v22.21.0；用到 `node:sqlite`、`process.loadEnvFile`、Node SEA 能力）。
2. **存在原生模块**：`node-pty`（终端）、`sharp`（图片处理）、`koffi`（FFI）、`node-addon-api`、`@img/*`（sharp 原生二进制）——**不能**被 pkg/SEA 内联，必须以 `.node` 文件与 node_modules 形式随包分发。
3. **完整运行时依赖 ≈ 255 MB**（本机 npx 缓存实测，含 AWS SDK/React/原生二进制；`@deepseek-ai/*` 本身仅 ~20 MB）。裁剪空间存在但优先保正确性。
4. **Windows 上 agent 的 shell 工具走 pwsh**（`tool-pwsh`/`pwsh-sandbox` 在 win32 启用，bash 禁用）—— **需要 PowerShell 7+**，这是安装器的前置检查项（系统自带的是 5.1，不满足）。
5. 会话日志已用 zstd 压缩（`session.jsonl.zstd`），落盘体积可控。
6. `dsh plugin` 依赖 pnpm —— 桌面版应把 profile 作为**自包含目录**随包分发，终端用户不需要 Node/pnpm。

---

## 二、桌面化封装方案

### 2.1 目标与非目标

**目标**
- 一键安装、双击启动的 Windows 桌面应用；窗口内呈现与 `dsh web` 完全一致的 UI。
- 宿主进程（DSH runtime）由壳托管：随窗启动、随窗退出、崩溃自动拉起。
- 桌面原生能力：系统托盘、通知、单实例、开机自启、原生目录选择、自动更新。
- 用户数据位置明确、可迁移、可备份（沿用 `$DSH_HOME` 语义）。

**非目标（v1 明确不做）**
- 不重写前端 UI；不改 DSH 的 host 代码（除非确有必要的小 patch）。
- 不做多用户/远程访问（信任栅栏的 `--host 0.0.0.0` 继续禁用）。
- 不做移动端/跨平台（只做 Windows；架构上保留后续 macOS 空间）。

### 2.2 方案选型对比

| 方案 | 壳体积 | 与 DSH 契合度 | 原生能力 | 维护成本 | 结论 |
|---|---|---|---|---|---|
| **A. PWA 安装**（Edge/Chrome"安装应用"） | 0 | 高（dist 自带 webmanifest） | 无托盘/单实例/自启 | 0 | 只做 Phase-0 验证，不做交付形态 |
| **B. WebView2 + 轻壳**（C# WinForms/WPF 或 Go，~50KB 壳） | 小（+Node 运行时 ~50MB） | 高（Win10/11 自带 WebView2 Evergreen） | 托盘/通知需自写 | 中 | 推荐给"体积敏感"场景 |
| **C. Electron**（主进程托管 Node 宿主） | 大（+~100MB Chromium） | 最高（Node 主进程可直接 require DSH 包；托盘/通知/更新生态最成熟） | 全 | 低（生态最全） | **推荐主路线** |
| **D. Tauri**（Rust + WebView2） | 最小 | 低（宿主仍是 Node，还得另带 Node；Rust 工具链门槛） | 全 | 高 | 不推荐 v1 |

**推荐：C（Electron）为主，B 作为"轻量分支"保留可选**。理由：
1. Electron 主进程本身就是 Node，**可以把 DSH host 作为库直接 `require` 进主进程**（复用 `dsh-app-boot.boot()`），省掉子进程托管与端口发现的一半复杂度；退一步也可以子进程模式（更稳，崩溃隔离）。
2. `electron-builder`（NSIS）+ `electron-updater` 是 Windows 桌面分发的事实标准：安装器、图标、代码签名、自动更新全部现成。
3. webserver README 预留的正是 Electron 形态（file:// + IPC fetch 桥），官方方向一致。
4. 前端 UI 一行不改：BrowserWindow 直接加载 `http://127.0.0.1:3080`，走现有信任栅栏。

### 2.3 推荐架构（Electron 主路线）

```
┌──────────────────────────── Windows 桌面应用 ────────────────────────────┐
│  Electron 主进程 (Node 22)                                                │
│  ├─ 生命周期管理：单实例锁 → 启动 host → 就绪探测 → 建窗 → 退出编排        │
│  ├─ DSH Host（进程内 or 子进程两种模式，见 2.4）                           │
│  │    boot() ← composeProfile('desktop')                                  │
│  │    = dsh-base + dsh-web-app + desktop 形态层 patch（新增，见 2.5）      │
│  ├─ 原生桥：托盘 / 通知 / 目录选择 / 开机自启 / 深链                         │
│  └─ 更新器：electron-updater（NSIS + 签名 + GitHub Releases）              │
│                                                                           │
│  BrowserWindow (contextIsolation: true, nodeIntegration: false)           │
│  └─ 加载 http://127.0.0.1:3080（走既有 /api 信任栅栏，零改动）              │
└────────────────────────────────────────────────────────────────────────────┘
        │ spawn 前置（子进程模式）
        ▼
   [host] node profile-boot.js --profile desktop --port <N> --trusted-host ...
```

**端口策略**：壳启动时自选空闲端口（监听 0 拿一个再释放，或 3080 起向上探测），以 `--port <N>` 传入；就绪探测 = 轮询 `GET /` 直到 200（或解析 host stdout 的 URL 行），然后建窗。避免与用户手开的 `dsh web`（占用 3080）冲突。

**数据策略**：`DSH_HOME` 解析优先级 —— ① 已存在的 `~/.dsh`（老用户直接沿用，零迁移）；② 否则 `%APPDATA%\DeepSeekHarness`（新装用户，避免污染用户目录根）。安装器把这条写成注册表/快捷方式环境变量即可，host 侧 `resolveDshHome` 原生支持。

**前置依赖检查**（安装器 + 首启双保险）：Node ≥ 22（Electron 自带，无需检查）、**PowerShell 7+**（缺失时提示 `winget install Microsoft.PowerShell`，或安装器静默装）、WebView2（Electron 自带，无需检查）。

### 2.4 Host 托管模式对比

| | 模式 1：进程内（推荐） | 模式 2：子进程（备选） |
|---|---|---|
| 实现 | 主进程 import `dsh-app-boot` 直接 `boot()` | `child_process.spawn(process.execPath, [profile-boot.js, ...])` |
| 优点 | 无 IPC 序列化开销；端口/日志天然可控；单进程内存更省 | 崩溃隔离；host 崩溃可自动拉起；profile 独立升级 |
| 缺点 | host 异常会拖垮壳 | 需管 stdout/退出码/信号；多一层进程 |
| 就绪感知 | 直接拿 `ctx.webServer.port` | 解析 URL 行 / 轮询健康检查 |
| 建议 | **v1 用进程内，最快落地** | v1.5 若出现 host 稳定性问题再切 |

### 2.5 需要新增/改动的 DSH 侧内容（最小集）

1. **新增形态层 patch**（仿照 dsh-web-app 的写法，一个 `desktop.patch.yml`，作为 `--patch` 或新 bundle 应用）：
   - `webserver` 行：`host: 127.0.0.1`、`port` 由壳传入（`--port` 已是 web-startup 原生 flag，**无需改代码**）。
   - `web-runtime` 行：`printUrl: false`（桌面壳不需要 URL 行）；`surfaceContext` 保持。
   - 可选：加一行 `desktop-shell` 插件，向浏览器暴露 `shell.describe` 远程端点（经 typert gateway），让前端可查询"是否运行在桌面壳中"并渲染托盘联动 UI。
2. **新增一个 profile 模板** `desktop`（= dsh-base + dsh-web-app + desktop patch），或**直接复用 `web` profile + 启动器 `--patch desktop.patch.yml`** —— v1 建议后者，零新增 profile 管理面。
3. **可选项（不阻塞 v1）**：`dsh-client-ui-directory-picker-native` 与壳的 `dialog.showOpenDialog` 对接 —— 现有 `directory-picker-auto` 已按绑定主机自动选型，浏览器形态下走 in-browser browse 也可接受，原生对话框作为体验增强排期。

### 2.6 原生集成点清单

| 能力 | 实现 |
|---|---|
| 单实例 | ~~`app.requestSingleInstanceLock()`~~（0.4.1 起移除）→ **多窗口 + 全局 host 复用**：`.dsh-host.lock`（壳自起宿主就绪后登记，含端口）+ netstat pid→端口 探测 + `__DSH_BOOT__` 内容校验；host 侧由 profile 的 `dsh-host-lock-registry` 纯登记（不拦截不退出）；只复用"本 DSH_HOME 锁"指向的宿主 |
| 托盘 | Tray + 菜单（打开主窗 / 新建会话 / 打开数据目录 / 退出）；窗口关闭 → 最小化到托盘（可配置） |
| 通知 | 渲染进程 Notification API + `session.setPermissionRequestHandler` 放行 notifications |
| 开机自启 | `app.setLoginItemSettings({openAtLogin})` + 设置页开关（经 `desktop-shell` 远程端点写回） |
| 目录选择 | 双通道：壳设置"Agent 工作区"用 Electron `dialog.showOpenDialog`（admin `/api/pick-directory`）；DSH GUI 的"选择工作区目录"自 0.4.4 起**钉住应用内浏览选择器**（宿主 env 注入 `SSH_CONNECTION=dsh-desktop-browse` 使 auto 解析器回退 browse——rc.6 的 native koffi COM worker 选取时会静默崩溃） |
| 深链 | `dsh://` 协议注册：`dsh://session/<id>` 直达某会话 |
| 自动更新 | electron-updater：NSIS 差分 + GitHub Releases/自建源；安装包 Authenticode 签名 |
| 日志 | 壳日志 + host stdout/stderr 统一写 `%LOCALAPPDATA%\DeepSeekHarness\logs\`，轮转 |
| **会话日志自愈**（0.4.1+） | 启动前扫描 `$DSH_HOME/sessions/**/session.jsonl.zstd`：半个 zstd 尾帧截断 / 首帧异常逐行重编码 / 无法修复隔离改名——保证 rc.6 读取器能启动、历史会话可读 |
| **完整退出**（0.4.1+） | 退出前等会话日志静止（写批落盘、停在帧边界）再结束宿主进程树，不再"写一半就杀" |
| **自定义背景图片**（0.4.1+ / 0.4.2 修复） | 设置"桌面"section 浏览/清除；图片经壳 admin 回环 HTTP `/bg-image` 供给（**Chromium 禁 http 页面加载 `file://`，0.4.1 的 file:// 方案已废弃**），jpg/jpeg/png/webp/gif/bmp/avif/ico 白名单；CSS 注入 body 铺图 + `--dsw-alias-bg-base` 透明 + 暗化遮罩 |

### 2.7 安全加固（桌面壳特有）

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`（渲染进程）。
- `webSecurity` 保持开启；拦截一切非 `http://127.0.0.1:*` 导航与 window.open（`will-navigate` / `setWindowOpenHandler`）。
- 渲染进程不接触任何 DSH 凭据：凭据继续只经 `/api` 特权面读写，与现状一致。
- 生产构建禁用 DevTools 快捷键（保留 `--dev` 开关）。
- host 绑定保持 `127.0.0.1`；绝不对外网开放（延续现有拒绝 `--host 0.0.0.0` 的安全姿态）。

### 2.8 目录结构与关键文件

```
desktop-app/
├─ package.json                 # electron + electron-builder + 运行时依赖(@deepseek-ai/*)
├─ electron-builder.yml         # NSIS x64、appId、图标、签名、publish 源
├─ src/
│  ├─ main/index.ts             # 主进程：单实例、host 启动、建窗、托盘、更新器
│  ├─ main/host.ts              # host 托管（进程内 boot / 子进程两模式）
│  ├─ main/desktop-patch.yml    # 形态层 patch（2.5）
│  ├─ preload.ts                # contextBridge 暴露最小 API（版本/托盘动作）
│  └─ renderer/                 # 可选：设置页/关于页的壳内页面
├─ vendor/profile/              # 构建期生成：自包含 profile（bundles 锁定 rc.6）
│  ├─ package.json              #   dsh.profile.bundles = [dsh-base, dsh-web-app]
│  └─ node_modules/             #   npm ci --omit=dev 产出（~255MB，可再裁剪）
└─ scripts/
   ├─ build-host.mjs            # 构建期生成 vendor/profile + 校验清单
   ├─ smoke.mjs                 # 打包前冒烟：boot → 就绪 → 关停
   └─ sign.ps1                  # Authenticode 签名（证书注入 CI）
```

### 2.9 实施路线（里程碑）

**Phase 0 —— 可行性验证（0.5 天）**
- 用 Edge/Chrome 打开 `http://127.0.0.1:3080` → "安装为应用"，确认 SPA 在独立窗口中的完整体验（验证前端无环境依赖假设）。
- 记录风险点：通知、拖拽文件、下载行为在 PWA 壳中的表现。

**Phase 1 —— 最小可用壳（3~5 天）**
- 搭 Electron 工程；主进程进程内 `boot()` 加载 `web` profile + desktop patch；自选端口 + 就绪探测 + BrowserWindow 加载。
- 单实例、窗口关闭行为、host 异常退出兜底（日志 + 提示）。
- 验收：双击 exe → 窗口出现 → 建会话 → 与浏览器版功能等价。

**Phase 2 —— 原生集成（2~3 天）**
- 托盘 + 通知 + 开机自启 + 深链 + 壳内设置页（版本、数据目录、自启开关）。
- `desktop-shell` 远程端点（2.5）让前端感知桌面形态。

**Phase 3 —— 分发（2~3 天）**
- electron-builder NSIS 安装包；图标/安装目录/卸载；PowerShell 7 前置检查；代码签名（自签或 EV 证书）。
- electron-updater 接入发布源；CHANGELOG 与版本策略（跟随 DSH rc 版本）。

**Phase 4 —— 加固与质量（2~4 天）**
- 测试矩阵：Win10/Win11 × x64（ARM64 视需要）；全新安装 vs 已有 `~/.dsh` 迁移；断网启动；host 崩溃恢复；长会话内存。
- 日志轮转、崩溃上报（可选 sentry）、卸载清理（保留用户数据，提示备份）。

### 2.10 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| 原生模块（node-pty/sharp/koffi）在打包后加载失败 | 高 | 构建期以**目录随包**分发而非 pkg/SEA 内联；smoke 脚本在打包机上真实加载一遍；锁定 Node ABI |
| host 进程内模式崩溃拖垮壳 | 中 | v1 即预留子进程模式开关；崩溃自动拉起 + 日志现场 |
| 255MB 依赖导致安装包过大 | 中 | NSIS 压缩后预计 80~120MB（Electron 路线）；裁剪 AWS SDK 等可选依赖做 v1.5 优化；体积敏感者走 WebView2 轻壳分支 |
| 端口冲突（用户已开 dsh web） | 低 | 自选空闲端口策略（2.3） |
| PowerShell 7 缺失导致 agent 命令全挂 | 中 | 安装器前置检查 + 首启引导（winget 安装） |
| DSH 上游更新导致 desktop patch 失效 | 中 | patch 只动行 config 不改行 id；版本锁定 rc.6 基线；升级前跑 smoke |
| 信任栅栏对 Electron 渲染进程的判定差异 | 低 | 加载 loopback 地址即天然通过；Phase 1 首日即验证 |

### 2.11 验收标准

1. 全新 Win11 机器：安装 → 启动 → 建会话 → 完成一次带工具调用的任务，全程无命令行交互。
2. 已有 `~/.dsh` 的老用户：安装后直接看到原会话历史与设置，无需迁移操作。
3. 托盘：最小化/退出/新建会话/打开数据目录全部可用；通知可达。
4. 断网启动不白屏、不崩溃；host 异常退出后壳给出可读提示并支持重启。
5. 打包后 `smoke` 通过：boot → 就绪 → 关停零错误；安装包签名有效。
6. 与 `dsh web` 浏览器版功能等价性抽查：会话、设置、模型切换、子代理、workflow、goal、插件管理页。

### 2.12 工作量与资源

| 角色 | 投入 |
|---|---|
| 主程（Electron/Node） | 10~15 人日（Phase 1~3 主体） |
| DSH 侧小改（desktop patch / shell 端点） | 2~3 人日 |
| 测试/发布（矩阵、签名、更新源） | 3~5 人日 |
| 合计 | ≈ 15~20 人日 到可用 v1；加固另计 |

---

## 三、实施状态记录（2026-08-17 更新）

### 3.1 阶段完成度

| 阶段 | 计划内容 | 状态 | 说明 |
|---|---|---|---|
| Phase 0 | PWA 可行性验证 | ✅ | 前端纯静态 SPA 确认，仅 `/api` 契约 |
| Phase 1 | 最小可用壳 | ✅ | 实现为 **Node + Chrome app-mode**（非 Electron，见 3.2） |
| Phase 2 | 原生集成 | ✅ | 设置页、托盘、通知、单实例聚焦转发、close-to-tray、崩溃通知、通知预授权 |
| Phase 3 | 分发 | ✅ | iexpress 安装包（NSIS 脚本备用）、卸载、PS7 前置检查、doctor、smoke、CHANGELOG/版本 |
| Phase 4 | 加固与质量 | ⏳ | 测试矩阵、日志轮转、崩溃上报排期 |

### 3.2 与方案的偏差（有意为之）

| 项 | 计划（评审稿） | 实际 | 理由 |
|---|---|---|---|
| 壳技术栈 | Electron（方案 C） | Node 启动器 + Chrome `--app` 窗口 | 零 Chromium 内置体积、复用系统 Chrome；托盘/通知用系统 PowerShell 5.1 + WinForms 补齐；Electron 作为升级路径保留（webserver README 的 file:// + IPC 落点仍在） |
| 桌面形态感知端点 | `desktop-shell` typert 插件（改 DSH 侧） | 未做（DSH 零改动承诺优先） | 以"壳内设置页 + admin API"替代，前端感知形态排期 v1.5 |
| 目录选择原生对话框 | directory-picker-native 对接 | 未做 | 现有 in-browser browse 可用，排期 v1.5 |
| 安装器 | electron-builder NSIS | `build-installer.ps1` 自动选 NSIS > Inno > **csc 自解压 `.exe`** > base64 自解压 `.cmd` | 本机无 makensis/ISCC；实测 Win11 26100 上 iexpress `/N` 静默模式失效；用系统自带 .NET Framework `csc.exe` 编译 `setup-bootstrap.cs`（内嵌 zip 载荷 + 图标）产出真正 PE `.exe`，零外部依赖；`installer.nsi` 备用 |
| 自动更新 | electron-updater | 未做（无 Electron 基线） | 排期 v1.5（随 Electron 迁移或独立检查器） |

### 3.3 实测结论

- `smoke.mjs` 端到端全绿：admin API（status/autostart/settings/workspace/focus/quit）、设置页、图标、干净退出、锁清理
- host 崩溃通知、PS7 缺失提示（本机确实未装 PS7，`--doctor` 会标红）
- 单实例：第二实例经 `app.state.json` 的 adminPort 转发 `/api/focus`，由 PowerShell CIM 定位 Chrome 窗口前置
- 已知边界：深链 v1 仅聚焦；Chrome 窗口关闭依赖 `minimizeToTray` 设置（默认托盘化）

### 3.4 后续建议（v1.5）

> 评审结论：Electron 迁移已立项。构建与安装包的落地方案见同目录《Electron构建安装包计划书.md》（本文第二部分"方案 C"的细化与优化稿，含 v1 资产复用映射与 8~12 人日工作量测算）。

1. Electron 迁移按《Electron构建安装包计划书.md》执行：host 子进程托管（优先 `ELECTRON_RUN_AS_NODE`，捆绑 Node 22 为回退），解锁 electron-updater 与原生目录对话框
2. `desktop-shell` typert 端点让前端感知桌面形态（需 DSH 侧最小 patch，2~3 人日）
3. 日志轮转与崩溃现场采集；Win10/11 × x64 测试矩阵
4. 依赖裁剪（AWS SDK 等可选依赖）与 Authenticode 签名

---

## 附录：本机实证事实速查

| 项 | 值 |
|---|---|
| 启动器版本 | `@deepseek-ai/dsh@0.1.0-rc.6`（npx 缓存包，仅 66B 依赖清单） |
| 部署形态 | `dsh web` → profile `web`，bundles = `dsh-base` + `dsh-web-app` |
| 运行时 | Node v22.21.0；依赖总量 ≈ 255MB（含原生模块） |
| 默认监听 | 127.0.0.1:3080（`--port 0` 可让 OS 分配；`--host 0.0.0.0` 被拒） |
| 前端 | `dsh-web-frontend/dist`（Vite SPA，~1.2MB JS + KaTeX 字体，含 webmanifest） |
| 传输 | POST `/api` + WS `/api/events.mux`、`/api/events.host`（只下行） |
| 会话落盘 | `sessions/**/session.jsonl.zstd`（zstd 压缩，请求前检查点） |
| 设置 | `settings.yaml`（热重载；当前：model=deepseek-v4-flash, reasoningEffort=max, locale=zh） |
| Windows 专用 | `pwsh-sandbox`/`tool-pwsh` 启用、`bash-sandbox`/`tool-bash` 禁用（需 PowerShell 7+） |
| 官方预留 | webserver README 明确"Electron 经 file:// + IPC fetch 桥"的设计落点，尚未实现 |
