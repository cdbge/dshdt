# CHANGELOG — DSH Desktop（Electron 主路线）

版本策略：壳版本独立 semver（v1 Node+Chrome 壳止步 0.3.0）；DSH 依赖经 `vendor/profile` 锁定
`@deepseek-ai/dsh@0.1.0-rc.6`，升级走独立流程（build-host + 双冒烟门禁）。

## 0.4.4 (2026-09-08)

- **修复：工作区选取报错 "directory picker failed: win32 folder dialog worker exited before
  reporting a result"**。根因（进程级实证）：rc.6 的 native 目录选择器（koffi COM worker 子进程）
  在真实选取目录时硬崩溃——worker 进程启动后数十秒静默消失（无 stderr，host.log 为空），
  驱动侧只能报"exited before reporting"。修复（DSH 零改动）：宿主子进程环境注入
  `SSH_CONNECTION=dsh-desktop-browse`——auto 解析器读到该变量即回退**应用内浏览选择器**
  （纯 Node 后端，vendor 全树仅此一处读取该变量）；GUI 改用应用内目录浏览，选取立即生效。
  冒烟新增 2 条防回归断言：`host.pickDirectory`→`directory-picker-unavailable`（证明已钉住
  browse）、`host.listDirectory`→ok。
- **流程**：自本版起，打包（electron-builder 产安装包）与已装应用热更新均**先经用户同意**。

## 0.4.3 (2026-09-07)

- **修复：背景图"注入成功但看不见"**（0.4.2 遗留 bug，用户实测复现）。根因：vendor 锁定的
  rc.6 SPA 不使用 `--dsw-*` 主题变量，而是用**写死的不透明背景**（rgb(21,21,23)）铺满视口
  （CSS-modules 类 `.*_frame` / `.*_root`）。0.4.2 的"body 铺图 + 变量透明"方案注入成功、
  图片加载成功，但被这些不透明层完全盖住。
  修复：新增把 rc.6 真实不透明层置透明的选择器集合（`#root > div`、`[class$="_frame"]`、
  `[class$="_root"]`、`[class$="_centerCol"]`；侧栏与输入框卡片保持不透明以保可读性）。
  像素级探针实证：注入后角落像素由 #151517 变为壁纸色（#888887 / #030f11），壁纸真实可见；
  诊断工具沉淀为 `scripts/bg-probe2~5.mjs`（结构/像素探针）。

## 0.4.2 (2026-09-07)

- **修复：自定义背景图片不显示**（朋友机器实测复现的 0.4.1 bug）——Chromium 禁止 http 页面加载
  `file://` 本地资源（渲染器 "Not allowed to load local resource"）。图片改由壳 admin 回环 HTTP
  `/bg-image` 供给：按扩展名给 MIME（jpg/jpeg/png/webp/gif/bmp/avif/ico）、`Cache-Control: no-store`、
  `?t=mtime` 破缓存；`/api/background` 增加扩展名白名单（主流 jpg/png/webp 全支持）。
  无头探针实证（file:// 拒绝 / HTTP 供给 512×512 加载成功）+ `scripts/admin-bg-test.mjs`（7 断言）
  + 全量 smoke 31/31（新增 5 条背景图断言防回归）。
- **更换应用图标**：workspace 根 `dsh.jpeg`（512×512）经 `scripts/gen-icon.mjs` 生成
  `build/icon.ico`（PNG-in-ICO，256/128/64/48/32/16，回读校验通过）；窗口/托盘/安装包共用。
- **主进程防 `ELECTRON_RUN_AS_NODE` 泄漏**：`src/node-guard.mjs` 最先导入，主进程被环境变量
  退化成纯 Node 时明确报错退出（不再无窗口无日志静默失败）；smoke 子进程环境同步剔除该变量。
- **文书**：新增 workspace 根《代码规范与范例.md》（供后续 AI 会话参考：铁律/工程地图/坑清单/
  端到端范例/门禁/提交规范）；CHANGELOG、README、两份计划书、施工进度文档同步更新。
- **打包**：`DSHDesktop-Setup-0.4.2.exe`（未签名；时间戳服务器不可达）+ blockmap；打包产物
  `--smoke` 全绿（SMOKE OK + 优雅退出）；dist 旧版安装包已清理，仅留 0.4.2。

## 0.4.1 (2026-08-20)

三项修复/增强（对应清单：完整退出、历史会话可读、自定义背景图片）：

- **完整退出**：托盘"退出"/关机前先等会话日志静止（写批全部落盘、文件停在帧边界），
  再结束宿主进程树——不再"写一半就杀"，从源头消除半个 zstd 尾帧。
- **历史会话可读**：新增 `src/repair.mjs` 启动前自愈——半个尾帧截断到最后一个完整帧、
  首帧异常重编码为逐行帧、无法修复的坏日志隔离改名（`.corrupt-<ts>`），
  旧版 rc.6 会话读取器不再因"corrupt Zstandard session log"崩掉整棵启动树。
- **自定义背景图片**：设置面板"桌面"section 新增"背景图片"行（浏览…/清除）；
  壳级 CSS 注入实现（body 铺图 + 基底背景变量透明 + 暗化遮罩），不碰 DSH 源码，
  深浅色主题均可用；设置持久化于 `settings.json`，经 `/api/background`、`/api/pick-background` 读写。
- 顺带：移除 Electron 单实例锁与 HOME profile 的 dsh-host-single-instance 硬互斥，
  多窗口共享同一 dsh host（锁登记 + netstat 端口探测 + `__DSH_BOOT__` 内容校验）。
  旧实现（Get-CimInstance 扫 node.exe 命令行）在 dev host 上探测失败，
  导致壳在已有 host 运行时拉起第二个宿主或直接打不开。

## 0.4.0 (2026-08-19)

首个 Electron 发行版（对应 v1 0.3.0 的全部能力 + 分发体系升级）。

### 壳能力（迁移自 v1，Electron 原生实现）
- 模式 B 宿主托管：`ELECTRON_RUN_AS_NODE` + `--expose-internals` 子进程跑 dsh web（DSH 零改动）
- 单实例 + 第二实例聚焦；`dsh://` 协议注册；系统托盘；close-to-tray；开机自启
- 通知（host 崩溃自动重启×3 + SPA 通知白名单）；壳内设置页（独立窗口，不走外部浏览器）
- 安全基线：contextIsolation/sandbox、非回环导航拦截、生产禁 DevTools

### 构建与分发（M2）
- 自包含 vendor/profile：530 包 / 207MB / ABI 门禁 0 失败 / 剪枝 11.4MB / vendor.lock.json
- electron-builder NSIS：per-user 一键安装 146.8MB + blockmap 差分；卸载保留用户数据
- 自签代码签名（CN=DSH Desktop Dev，scripts/dev-sign.ps1）；CI（.github/workflows/release.yml）
- electron-updater 接线（打包态自动检查；publish 配置待 GitHub 仓库激活）

### 门禁（全绿）
- dev smoke 21/21；打包产物 smoke exit 0；abi-scan 0 FAIL；vendor 独立 boot 冒烟
- 关键修复：findDshBin Electron 锚点、extraResources 根级 node_modules 被跳过、
  electron-updater CJS 命名导入（打包态挂起元凶）、workspace 状态回写
