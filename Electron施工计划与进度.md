# Electron 桌面化 · 施工计划与进度

> 方案依据：《Electron构建安装包计划书.md》｜ 架构依据：《DeepSeek-Harness桌面应用封装计划书.md》
> **本文件是唯一进度事实源**：每完成一个阶段就更新第 2 节快照表；中断后从这里恢复。

---

## 0. 恢复协议（中断后怎么续）

0. **新会话开工**：先读《代码规范与范例.md》第 0 节"新会话开工清单"（含当前状态锚点：0.4.5 阶段收尾、门禁基线 33/33、已装应用与备份清单），再按本节执行。
1. 每次开工：读本文件"进度快照"→ 找到最后一个 ✅ 检查点 → **重跑该检查点命令**确认环境没变 → 从下一阶段继续。
2. 每阶段结束：跑检查点 → 更新快照表 → `git commit`。**不 commit 不进下一阶段**（commit 是中断恢复与回滚的锚点）。
3. 所有检查点命令均幂等、可重复执行（已按此设计）。
4. 环境类改动（装 pwsh 等）完成后，立刻回填第 1 节"实测"列。
5. 代码改动原则：先跑相关检查点确认基线绿，再动代码；动完重跑检查点。
6. **打包 / asar 热更新 / 插件副本替换必须先经用户同意**（2026-09-08 用户确认的硬规矩，细节见《代码规范与范例.md》第 1.3 节）。

---

## 1. 前置依赖核对（2026-08 本机实测）

| 项 | 要求 | 实测 | 动作 |
|---|---|---|---|
| Windows | Win10/11 x64 | ✅ 11 26100 | — |
| Node.js | ≥ 22（DSH 硬性） | ✅ 系统 Node 已装（Electron 内建 Node **24.18.1** 实测） | — |
| npm | 随 Node | ✅ 10.9.4 | — |
| **PowerShell 7+** | agent 的 shell 工具硬依赖（系统 5.1 不满足） | ✅ **7.6.5 已装**（`C:\Users\31893\AppData\Local\Microsoft\WindowsApps\pwsh.exe`） | 完成 |
| **包管理器** | vendor/profile 构建期安装依赖；DSH 双锚解析（dsh-app-boot 源码实证）与包管理器无关 | ✅ npm 10.9.4（本机 DSH npx 缓存即 npm 布局，运行正常） | **无需 pnpm**；仅当 v2.5 引入 `dsh plugin` CLI 装插件时再 `corepack enable pnpm` |
| git | 版本管理（恢复协议依赖它） | ✅ 已装；workspace 已是 git 仓库（`D:\Desktop\deepseek`，主分支 main） | 每阶段 commit |
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
| 6 | **0.4.1 修复线**（多窗口 host 复用 / 会话日志自愈 / 优雅退出 / 背景图 v1 / 移除硬互斥） | ✅ 完成 | 全量 smoke **26/26**；repair 单测 8/8；打包 `DSHDesktop-Setup-0.4.1.exe`（**未签名**——时间戳服务器网络不可达） | **遗留 bug**：背景图用 `file://` 供给，被 Chromium 拒绝（0.4.2 修复）；dist 新旧包共存易误发 |
| 7 | **0.4.2 修复线**（背景图改回环 HTTP 供给 + 新图标 + 代码规范文档 + 计划书同步） | ✅ 完成 | 无头探针实证：file:// 拒绝 / HTTP 供给 ok 512×512；admin-bg-test 7/7；全量 smoke **31/31**；`build/icon.ico` 已由 workspace 根 `dsh.jpeg` 重建；**打包 `DSHDesktop-Setup-0.4.2.exe`（未签名）+ blockmap，打包产物 --smoke 全绿（SMOKE OK + 优雅退出）**；dist 旧包已清 | 遗留：背景图"注入成功但看不见"（0.4.3 修复） |
| 8 | **0.4.3 修复线**（背景图穿透 rc.6 硬编码不透明层） | ✅ 完成 | 像素级探针（bg-probe2~5）实证根因：rc.6 SPA 用写死的 rgb(21,21,23) 铺满视口、不用 --dsw-* 变量；新选择器集合（`#root > div`/`[class$="_frame"]`/`[class$="_root"]`/`[class$="_centerCol"]`）注入后角落像素 #151517→#888887/#030f11 壁纸可见；**打包 `DSHDesktop-Setup-0.4.3.exe`（未签名）+ 打包产物 SMOKE OK；本机已装应用 asar 已热更新（备份 app.asar.0.4.2.bak）** | 用户重启应用后确认壁纸显示；朋友侧发 0.4.3 |
| 9 | **0.4.4 修复线**（工作区选取：native 目录选择器崩溃 → 钉住应用内浏览） | ✅ 完成 | 进程级实证：rc.6 native 选择器 koffi COM worker 选取时静默崩溃（worker 存活数十秒后消失、host.log 无任何输出）→ "exited before reporting"；修复：宿主 env 注入 `SSH_CONNECTION=dsh-desktop-browse` 使 auto 解析器回退 browse；全量 smoke **33/33**（新增 pickDirectory→unavailable、listDirectory→ok 两条防回归）；**本机已装应用 asar 已热更新（用户选择"只热更新本机"；备份 app.asar.0.4.3.bak）** | 新规矩（用户 2026-09-08 确认）：**打包与 asar 热更新必须先经用户同意**；0.4.4 安装包未打，待用户点头后执行 |
| 10 | **0.4.5 交互增强**（"桌面"section 按钮悬停高亮，对齐官方按钮） | ✅ 完成 | ghost 透明基底 + `:hover`→interactive-bg-hover、`:active`→interactive-bg-active、focus-visible 描边、0.15s 过渡（`.dsh-desktop-btn` 注入样式表，带 disposer）；CDP 交互实测：静止 rgba(0,0,0,0) → 悬停 rgba(255,255,255,0.08)；**打包 `DSHDesktop-Setup-0.4.5.exe`（经用户同意，本阶段最终版）+ 门禁全绿（smoke 33/33 + 打包产物 SMOKE OK）**；dist 仅留 0.4.5 | 阶段收尾：0.4.5 为现阶段最终版；后续如需 EV 签名/发布源再议 |
| 11 | **阶段收尾：文书冻结（本行）** | ✅ 完成 | 《代码规范与范例.md》补"新会话开工清单"（0 节）+ 坑 13~16 + 范例二；本进度文档恢复协议加第 0/6 条、0.4.x 修复线补全至 0.4.5、前置表修正（git 仓库/Node 24.18.1）；两份计划书与两份 README 核对同步 | | 12 | **0.4.6：harness rc.8 升级 + 壁纸全覆盖与调参** | ✅ 完成 | 仓库 `build-host.mjs` 锁 rc.8、`vendor.lock.json` 刷新（abiScan PASS / 15203 文件）；已装应用 vendor 换 rc.8 并实机验证（ABI 5/5 OK、宿主真启动、插件供给、smoke 33/33、repair 8/8）；壁纸改 `body::before` 固定层后像素验收 0 点露底（旧 56 点）；新增亮度/模糊滑块，smoke 33 → **37** | **已热更新本机已装应用**（经用户同意；asar 重建 + 插件双副本，备份 `app.asar.bak-0.4.5` / `client.js.bak-0.4.5`）；用户重启后确认**黑条消失、亮度/模糊滑块可用**并已自设壁纸与参数（0.85 / 2px）。发版打包仍待用户点头 |
| 13 | **0.4.6 增量：自带插件 + 托盘重启宿主** | ✅ 完成 | `dsh-auto-approval` 进仓库 `packages/`（build-host 拷进 vendor、壳启动自动挂载 profile）；托盘「重启宿主（重载插件）」+ `POST /api/restart-host`；门禁：admin-bg 7/7、repair 8/8、插件自检 10+12、smoke **40/40** | 版本号仍为 **0.4.6**（用户 2026-09-11 指示：未经允许不推进版本号）；未打包；已装应用需**重启一次**才有托盘按钮（asar 只在启动时加载） |
| 14 | **DSH 更新按钮 S1~S5：更新引擎 + 构建原语 + 换树 + UI + 门禁** | 🟡 代码完成并已热更新本机应用（真实换树验收待用户同意） | **S1** `src/dsh-update.mjs`（版本发现，29 断言）；**S2** `src/vendor-build.mjs`（npm 探测/install/剪枝/插件同步/ABI 门禁/lock/`buildStaging`）+ `build-host`/`abi-scan` 退化为 CLI 薄封装（49 断言）+ `vendor-equivalence.mjs`；**S3** `src/dsh-apply.mjs`（marker/校验/换树/清理，38 断言）+ `admin` 四个 `/api/dsh/*` 端点 + `main` 装配（`DSH_BIN` 改惰性 `dshBin()`，换树落在其首次求值前）；**S4** 客户端「DSH 版本」行（快照驱动可用性）+ 托盘「检查 DSH 更新」；**S5** smoke 新增 9 条更新面断言（**40 → 49**）。门禁：**131 离线断言 + smoke 49/49 全绿**；**真实端到端**：完整 npm install 441s → 剪枝 16580 文件 → ABI `OK=5 FAIL=0` → **暂存树真起宿主**（就绪 URL + `GET /` 200 + 优雅关停），全程未触碰现网 vendor。**已热更新本机已装应用**（用户同意）：提取→覆写 src→重打包 asar，`node_modules` 254 文件逐字节比对一致、11 个 src 与仓库哈希一致；备份 `app.asar.bak-0.4.6-dshupdate`；两份 client.js 副本同换 | **Q1** 换树须征得用户同意（开发期逐次）；**Q2** 不内置 npm；**Q3** registry=npmmirror；**Q4** 不做回滚备份 → 门禁成唯一防线。**关键发现**：① `electron-builder` 的 `files` 只含 `src/**`，**`scripts/` 不进包**，门禁代码必须落 `src/`；② `vendor.lock.json` 体积基线是 **pnpm** 建的，拿 npm 树比它文件数差 14.4% 属预期，判据改为功能性；③ 暂存区必须放 `<vendorDir>/staging/` 否则 rename 跨卷 EXDEV；④ 受限沙箱下 smoke 因 mojo 命名管道被拦而"壳状态文件超时"，需完整权限；⑤ **抓到真漏洞**：`null` 兼表"未初始化"与"无约束"使版本守卫静默失效（规范坑 29）；⑥ **又踩规范坑 24①**：PowerShell 变量名不区分大小写，`$asar`/`$ASAR` 互相覆盖，害我误判 asar 工具损坏——验收脚本本身也要独立复算。**遗留**：未对已装应用真换树（走 S 系列验收路径）；未打包 |
| 15 | **【事故】DSH 更新按钮把应用更新到起不来 → 已修复并热更新** | ✅ 修复完成（已装应用实测 SMOKE OK） | **事故**：用户点「更新 → 重启并应用」后 harness 从 `0.1.0-rc.8` 跨到 `0.1.5-rc.2`，此后前端永远拉不起来（只剩进程）。**根因两条**：① **DSH 0.1.5 起根 URL 带进程级启动令牌**（`?token=…`），而 `waitReady()` 探的是裸 URL → 永远不就绪 → 30s 超时 → `cleanup(1)`；② **更新流程漏了计划书 §8 明写的"启动冒烟"**，只接了 ABI 门禁——它只看 `.node` 能否 dlopen，对这棵起不来的树给出 `OK=5 FAIL=0` 全绿。**四项修复**：`runBootGate`（真起一次宿主，复用 `host.mjs` 的 `startHost`/`extractHostUrl`）+ `extractHostUrl`/token 感知 `waitReady` + `printUrl: true` + `assessJump` 版本守卫 + `restoreOldTree` 换树兜底回滚。**恢复**：旧树因宿主从未就绪而未被清理，完整留在 `profile.old-*`，rename 回去即为 rc.8。门禁：离线 **149 断言** + smoke **49/49** + **已装 exe `--smoke` 实测 SMOKE OK**（`ready: http://127.0.0.1:6413/`，1.1s）。备份 `app.asar.bak-0.4.6-dshfix` / `desktop.patch.yml.bak-0.4.6-dshfix` | **血泪教训（已入规范坑 31~34）**：① **门禁必须有"功能性"证据**——"能加载"≠"能用"；② 壳与宿主之间 **stdout 是唯一通道**，不能为日志干净把它关掉；③ **守卫要守对版本位**：`assessJump` 第一版只比 major/minor，把真实事故 `0.1.0-rc.8→0.1.5-rc.2`（差的是 **patch**）判成"安全"，等于没挡住——**单测逼出来的修正**；④ `desktop.patch.yml` **双份**（asar 内 + extraResources，打包态读后者）。另：**手上唯一的安装包内含 9/8 时代 vendor，重装会把 harness 退回旧版**，不能当修复手段。**遗留**：未打包新安装包 |
| 16 | **【事故第二轮】真正的持久根因：`$DSH_HOME\.credentials.yaml` 被 0.1.5 改写成不兼容格式** | ✅ 修复完成（真实 HOME 复验 1 秒就绪 + SMOKE OK） | 第一轮换回 rc.8 后前端**仍起不来**。真因：0.1.5-rc.2 运行期间把 `$DSH_HOME\.credentials.yaml` 改写成**带版本嵌套文档**（`version: 1` 是数字），而 rc.8 的 `credentials-local` 要求「凭证名 → 非空字符串」的**严格扁平映射**（`dsh-credentials-local/lib/index.js:110-137`）→ 抛 TypeError → 插件树加载失败 → 宿主 `code=1` 退出。**这就是"重装也解决不了"的答案**：文件在 `$DSH_HOME`，卸载程序不删它（`deleteAppDataOnUninstall: false`）。修复：还原为扁平格式（备份 `.credentials.yaml.bak-<ts>-0.1.5-format`）。另修两处可诊断性：`bootHost()` 拿不到 URL 时**改为抛错**（原先静默 `return` → main 拿 null 去 loadURL 抛 `conversion failure from null`，**且让换树回滚从未触发**）；宿主非零退出时**带上其日志尾巴**。`log()` 兜住 EPIPE。已装 exe + 真实 HOME 复验：`boot` → `ready`（1s）→ `SMOKE OK` | **教训（规范坑 35~37）**：① 启动门禁用**隔离 HOME**，天生测不出"新树与用户现有 `$DSH_HOME` 状态不兼容"——那一格只能靠换树后的**兜底回滚**接住；② **失败路径必须 `throw` 而不是 `return`**，静默返回会藏起故障并废掉所有基于异常的兜底；③ 打码要按**值形态**匹配，按行首键名匹配会因缩进全部落空（本轮把用户真实 API key 打进了会话记录，需吊销重发）。**遗留**：未打包；用户 API key 待轮换 |
| 17 | **更新复测（门禁挡住）→ 探针已修 + junction 加固 + 跨版本确认流程（均已热更新）** | ✅ 修复完成并已热更新（0.1.5 更新现在可从界面走完） | **④ 用户实测反馈"什么叫拒绝更新"→ 修掉守卫死锁**：`assessJump` 拒绝时返回 `…请带 allowUnsafeJump: true`，而界面「更新」按钮只发 `{}`、永远带不了该参数——**更新在 GUI 里被永久卡死**。修法：快照增加 `jump`/`needsConfirm`；拒绝文案改为"你该做什么"；客户端在 `needsConfirm` 时**不禁用按钮**（禁用=没有确认入口），改标签为**「更新（跨版本）」**，点击后 `window.confirm` 展示 当前→目标 与不兼容原因，确认后**代传 `allowUnsafeJump: true`**。教训入规范坑 40。 | **① 定位并修复就绪探针假阴性**：0.1.5 的根 URL 是 **303 换 cookie**——裸 URL→401、带 token 但默认跟随重定向→401（**Node 的 fetch 无 cookie jar，303 丢掉 `Set-Cookie`**）、带 token + `redirect:'manual'`→303+`Set-Cookie: dsh-auth-…`、**带上该 cookie 请求 `/` → 200（28029 字节完整 SPA）**。原 `runBootGate` 与 `waitReady` 都只认 `res.ok`，**对任何 0.1.5+ 的树永远探不到就绪**。修法：新增 `probeHostReady()` 走完整换票给门禁用；**壳的 `waitReady` 改为"服务器回了任何 HTTP 响应即就绪"**、把带 token 的 URL 交给窗口（窗口有真 cookie jar），**避免探测消费掉一次性 token**。**实测回归**：真实 0.1.5-rc.2 事故树跑修好的门禁，**90s 超时失败 → 5.8s PASS**。**② junction 加固**：`src/junction-safe.mjs`（`safeRemoveTree` 逐个 unlink 链接、绝不递归进目标；`cleanStaleBootGateHomes` 收遗留，判年龄用 **birthtime**），接入门禁 finally 与壳启动。**实测印证：门禁收尾报告"解开 482 个 junction（未进入其目标）"**——临时 HOME 里确有 482 个指向被测树的 junction，规模比估计更大。**③ 0.4.5 安装核查**：顶层文件与 `dist\win-unpacked` **逐字节同尺寸**（`DSH Desktop.exe` 225,663,488），**安装其实完整**；安装程序拒绝是对的——`DSH Desktop.exe` 有 6 个进程在跑，用户按 "dsh" 搜不到是因为**壳的宿主子进程就叫 `DSH Desktop.exe`**。**已热更新**（备份 `app.asar.bak-0.4.6-junction`；`node_modules` 254 项逐项一致、12 个 src 与仓库哈希一致） | **三个假设全部被实验证伪**（好过直接断言）：`fs.rmSync` 不跟随 junction；门禁不破坏被测树（`15210→15210`）；0.1.5 宿主不破坏自己的树（`11173→11173`）。**未证实但极强的线索**：损坏形态"**目录还在、文件全没**"是 `del /s /q` 的特征，而 `$DSH_HOME\profiles\node_modules` 有 junction 指向现网 vendor（含整个 `@deepseek-ai`）——**已按此加固**。坏树被排查脚本自己的 `rmSync(staging)` 删掉、无法再取证（失误已记：排查脚本不得删现场）。**门禁：167 离线断言 0 失败 + smoke 49/49。** |
| 18 | **桌面皮肤：滚动条与跳转轨道自动隐藏 + 两处黑色遮罩（透明度可调）** | ✅ 完成并已热更新（含两轮用户纠正） | 三项界面改造，**纯注入 CSS（DSH 零改动）**：① 滚动条滑块默认透明、悬停显形（**保留 8px 槽宽**——宽度收 0 会让正文悬停瞬间横向重排）；② 右侧**轮次标记轨**（用户说的"多条状跳转小组件"）默认 `opacity:0` 并右移 8px、悬停/聚焦浮现，加**圆角矩形黑遮罩**（`border-radius:8px`；初版误做成 `50%` 椭圆，用户纠正为"方形圆角"）；③ **对话区底层黑遮罩**，覆盖**能拖动的对话栏中间的内容列**（左右拖动条所夹的那段，居中、宽 `--dsh-chat-content-width`），靠 `z-index:-1` 落在内容之下。**这一项改了三版才对**——第一版挂在拖动条上（"不是两个滑动栏"）、第二版盖住整个 `_root` 会话面板（"不是整个页面，是中间那条"）、第三版落到内容列（锚点取自拖动条自己的定位规则：它们是 `wSkVaW_body` 的子元素，其 `calc(50% ± contentWidth/2 + 24px)` 正好界定这条列）。两项透明度各自可调（`railMaskOpacity` 0.35 / `conversationMaskOpacity` 0.25，0=隐藏）。**新增只读诊断 `/api/diag/ui`** 与 **`POST /api/reload-window`**（客户端插件的热加载手段） | **① 最严重的一次事故（已修）**：`:has()` 匹配**任意后代**而非直接子元素，而标记轨在布局根框架内部，于是 `[class$="_frame"]:has([class$="_marks"])` **同时命中** `pI_x6G_frame`（整个对话页面）与 `eGxaPq_frame`（标记轨）——`opacity:0` + `translateY(-50%)` 把**整页隐藏并上移半屏**（用户："对话页面飞到上半段"）。修法 `:not(:has([class$="_centerCol"]))` 排除祖先。**② 自伤失误（已修）**：注释里写反引号（`` `:has()` ``）**终止了模板字符串** → SyntaxError，而部署脚本没按 `node --check` 退出码中止，坏文件写进了已装应用。**③ 定位手法（入规范坑 42）**：CSS-modules 哈希前缀每次构建都变（`eGxaPq_`/`wSkVaW_`/`pI_x6G_`），**只有局部名后缀跨版本稳定**；**没有重启去探 DOM**（本会话就跑在该应用里，杀进程=自杀），改为直接读 vendor 源码里内联的 CSS-modules 字符串与类名映射表，零重启拿到全部精确选择器。**门禁：离线全绿 + smoke 51 → 55**。备份 `app.asar.bak-0.4.6-skin2` |
| 19 | **设置面板拆栏：外观类设置独立成「个性化」** | ✅ 完成并已热更新 | 原先「桌面」一栏混着功能开关（自启/托盘/工作区）与外观（背景图片/亮度/模糊/两处遮罩）两类东西。外观五项整体挪到新栏位 **「个性化」**（`settings.section` 的第二个注册项，`id: "personalize"`，`order: 90` 排在桌面之前）。「桌面」只留功能开关 + DSH 更新 + 状态行。**实现方式**：用**按索引拼接**的脚本整块剪切 121 行 JSX，**不手抄**（规范坑 25①）——脚本自带结构自检（块首必须是 `createElement(`、块末必须是自带逗号的 `),`、块内必须含预期首尾设置项），并报行数变化（**603 → 637**）供交叉验证 | **门禁：smoke 55/55**；插件已部署两份副本（哈希一致）。**未重启**——客户端插件改动本就只需重载页面，`/api/reload-window` 已在 asar 里待命（需下次重启激活） |
| 20 | **皮肤收尾：中央遮罩延伸覆盖两侧滑块 + 修掉 `diagUi` 自身的手滑** | ✅ 完成并已热更新（**待用户重启后目视确认**） | ① 用户反馈"中央遮罩延伸一下覆盖滑块"——原宽度 `min(calc(var(--dsh-chat-content-width, 680px)), 100%)` 只盖住内容列本体，两侧拖动滑块露在遮罩之外；改为 **`min(calc(var(--dsh-chat-content-width, 680px) + 128px), 100%)`**（内容列 + 24px 内缩 + 两侧各 40px 手柄）。② 新端点 `/api/diag/ui` 首次调用即稳定失败，只回 Electron 的不透明文案；定位为脚本内 `rect: R(r)`——把**已经算好的 `DOMRect`** 又喂回 `R(el)`（`R` 内部调 `el.getBoundingClientRect()`）→ TypeError。修为 `R(el)` | **门禁：离线 172 断言全绿**（dsh-apply 44 / update 36 / junction-safe 18 / vendor-build 66 / repair 8）+ **smoke 55/55**；插件三份副本哈希一致；asar 重建后与已装树 **268 文件逐字节比对 0 差异**。备份 `app.asar.bak-0.4.6-diagui`。**⚠️ 本次 asar 已换入但进程未重启（坑 26），`/api/diag/ui` 的修复要次日重开应用才生效**；中央遮罩改的是客户端插件（已 `/api/reload-window` 重载生效），但用户未及目视确认，**次日第一步就是请用户看一眼** | **教训入规范坑 44**：`executeJavaScript` 抛的错误是**不透明的**（真因在渲染进程，"Script failed to execute"只是外壳），注入的诊断脚本必须自带 try/catch 才能把真因带回 Node 侧；**诊断工具本身也要被验证**——它是看真相的眼睛，眼睛报错时最容易被误读成"被测对象坏了" |
| 21 | **右侧栏遮罩与按钮黑底 + 左侧栏背景三件套** | ✅ 完成并已热更新（**壳侧待重启生效**） | 用户四个诉求一次做完：① **右侧栏面板遮罩**——与对话主页**共用** `--dsh-conversation-mask-opacity`，因此天然同步、零联动代码；面板自带 `z-index:10` 自成层叠上下文，故 `::before{z-index:-1}` 正好落在面板内容之下、底色之上，正文照常清晰。② **右侧栏按钮固定黑底** `rgba(0,0,0,.5)`：面板顶部全屏/收起两颗 + 折叠态「展开」一颗，**刻意不做成可调项**（用户明确要求）。③ **左侧栏背景**：`sidebarBgMode`（`extend` 延伸主背景 / `own` 独立图片）+ `sidebarOpacity`；**渲染值恒为 `max(设置值, 对话区遮罩)`**，即侧栏永远不比主页面透。两种模式**共用一条 CSS**——侧栏铺一层黑纱，`own` 时纱下再叠 `--dsh-sidebar-bg-image`；`extend` 则留 `none`，壁纸由 `body::before` 从透明侧栏里透出来。把 `--dsw-specific-sidebar-fill` 就地置透明，侧栏列与它内部的 `_root` 一起变透（不必和各自 background 抢 `!important`）。背景画在元素自身上而非 `::before`：没壁纸时 `_frame` 底色不透明，负层级会被它盖住。④ 新增壳路由 `GET /sidebar-image`、`POST /api/pick-sidebar-background`、`POST /api/sidebar-background`，与 `/bg-image` 同一种回环 HTTP 供给（`file://` 会被 Chromium 拒） | **门禁：离线 172 断言全绿 + smoke 55 → 66**（新增 11 条：模式/遮挡写入与回读、越界钳制、模式非法值忽略、sidebar-image 未设→404 / 供给字节一致 / 清除后→404、非图片拒绝、headless 选图端点、收尾复位）。asar 重建后与已装树 **268 文件逐字节 0 差异**；插件三份副本哈希一致。备份 `app.asar.bak-0.4.6-sidebar`。**⚠️ 插件部分已 `/api/reload-window` 立即生效；壳侧（选图对话框 + 设置持久化）要重开应用才生效**——今晚点「独立图片 → 浏览…」必然失败，属预期 | **本轮最大教训（规范坑 45）**：为取选择器去**仓库** vendor 搜类名，`_marks`/`eGxaPq`/`yAWgPa` **一个都搜不到**，差点据此误判"选择器早就失效了"。真相：**已装应用跑 0.1.5-rc.2，仓库 vendor 是 rc.8**，两棵树的包名与 CSS-modules 哈希完全不同（`dsh-client-ui-chat` / `dsh-client-ui-sidebar-right` 是 0.1.5 独有，rc.8 里没有）。**为运行中的界面取选择器，只读已装树**。另入坑 46：注入 CSS 要垫底又不想吃掉插件的 `:hover`，用 `button[data-x]` 抬特异性（(0,1,1)）而不是 `!important`；结构不确定时逐项各垫一块，别赌 `:has()` 能猜中父容器（dockkit 是模块加载器解析的、磁盘无源码）。**遗留**：仓库/已装两棵 vendor 不一致这件事本身没人处理过，将来打安装包时全部皮肤选择器要按 rc.8 重取一遍 |
| 22 | **右侧栏「全屏」态遮罩单独一档（用户实测反馈）** | ✅ 完成并已热更新（插件即时生效；壳侧待重启持久化） | 用户反馈"侧边全屏模式下透明度过低了"。真因：全屏时面板是 `position:fixed; inset:0` **铺满整个视口**，它从"旁边一栏"变成**整个工作面**，正文直接压在壁纸上；而它此前与对话主页共用同一档（默认 0.25），于是透得读不清。修法：新增独立设置 `fullscreenMaskOpacity`（默认 **0.8**）+ 「右侧栏全屏遮罩」滑块，`[data-sidebar-right-panel=fullscreen]::before` 单独走这一档；两条规则特异性相同，靠**书写顺序**后者胜出，**退出全屏立刻回到与对话区同步的那档**（全屏是临时态，不该污染常驻值） | **门禁：离线 172 断言全绿 + smoke 66 → 69**（新增 3 条：全屏遮罩写入 / status 回读 / 越界钳制）。asar 重建后与已装树 268 文件逐字节 0 差异；插件三份副本哈希一致。备份 `app.asar.bak-0.4.6-fullscreen` | **插件部分重载即生效**（`/api/status` 缺该字段时按默认 0.8 兜底，所以**今晚就能看到效果、不必等重启**）；壳侧只负责持久化。**顺手确证了坑 45**：用运行中的壳复核 `/api/status`，`dshUpdate.installed` 三个包**全是 `0.1.5-rc.2`** —— 已装 harness 版本从应用自己嘴里得到直接证据（同一响应里 `version` 读出乱码 `��响�`，也是坑 26"进程挂着旧 asar 索引"的现场） |
| 23 | **修掉"左侧栏已有图片时换一张不生效"** | ✅ 完成并已热更新（插件重载即生效，不必等重启） | 用户实测反馈。**先排除服务端**：`GET /sidebar-image` 返回的字节与磁盘文件**逐字节一致**（1776001 字节）→ 壳侧无辜。真因在客户端：侧栏图片的 CSS 变量写的是**常量 URL**，换图后 URL 不变 → 浏览器认定 `background-image` 没有变化、**根本不重新发请求**，壳端的 `Cache-Control: no-store` 因此永远没机会生效（请求都不发，缓存头无从谈起）。修法：URL 带 `?p=<图片路径>&t=<mtime>`；壳侧 `statusPayload` 新增 `sidebarBgImageVersion`（图片 mtime，配 `fileMtimeMs()` 小工具），并把 `sidebarTuning(s = readSettings())` 改成可复用已读好的 settings——statusPayload 每 5 秒被调一次，能少读一次盘是一次 | **门禁：离线 172 断言全绿 + smoke 69 → 71**（新增"图片版本号存在且为正"、"换图后版本号改变"；后者用 `fs.utimesSync` 把 mtime 显式拉开 5 秒，避免同一毫秒写两个文件导致断言随机红）。asar 重建后与已装树 268 文件逐字节 0 差异；插件三份副本哈希一致。备份 `app.asar.bak-0.4.6-imgver` | **`?p=` 是刻意设计**：路径一变 URL 就变，于是这次修复**不依赖新壳**——插件一重载就生效，用户不必等重启；`t=` 只在"同一路径的文件被换掉内容"时才需要，是更严的那一档。**排查中的一个插曲**：验证时先撞上 404，一度像是"路由坏了"，读 `settings.json` 才发现用户已把左侧栏图片**清空**（`sidebarBgImage` 于 10:34 被移除、`sidebarBgMode` 仍为 `own`）——**"接口 404"要先分清是"路由不存在"还是"资源不存在"**。教训入规范坑 47 |
| 24 | **修复 `dsh-auto-approval`：本体没有自动审批，且插件的配置面一直是坏的** | ✅ 已修复并**已生效核实**（壳日志 03:00:25 结束旧宿主进程树 → 03:00:39 插件以 `settings=ok` 装载） | 用户问"自动审批有没有生效"。**结论一：本体没有这个功能**——`APPROVAL_POLICIES = ['ask','never']`，而 `never` 在 `dsh-user-approval` 的 `decide()` 里**直接返回 `rejected` 且根本不进审批瀑布**；本体唯一的"准予"结果是 `allowed-once`（源码原话 `allowed-once is the only grant`），能产出它的只有**弹窗里的人**（客户端只有"拒绝 / 允许一次"两个按钮）和**挂在 `approval/request` 瀑布上的插件**。权限预设「完全权限」之所以不弹窗，是**沙箱开到最大让请求根本不再产生**（绕开审批），不是自动审批；且它与本插件**互斥**。**结论二：插件确实没生效**——① 用了 **zod**，而 `settings.register` 要 **schemastery**（`resolve()` 里 `schema(mergeLayers(base, section))` 把 schema **当函数调用**）→ 每次装载 `schema is not a function` → 命名空间从未注册 → `/approval on|off` 永久报错、规则表不可改、设置面板根本不出现；② 77 条决策日志里 `auto-allowed` **0 条**（本环境唯一审批来源是沙箱提权，而 `escalate sandbox to danger-full-access` 的模式名本身命中高风险词表 → 在 workspace-write 会话里**结构上不可能自动放行**）；③ 自带 `apply-self-test` **8 通过 4 失败**，且从未纳入过门禁。**修法**：换 schemastery（枚举是 `z.union`，没有 `z.enum`）、四种失败情况分开记、`record()` 的静默 catch 改成"只报一次"、mock 按真实契约拒绝非可调用 schema、`apply` 转 async 并让自检 await | **门禁：离线 172 → 195 断言**（新增 `dsh-auto-approval` 分级 10 + 接线 13，**apply 自检从 4 红变 13 全绿**）；**生产路径实测**（不注入、让插件自己去解析 schemastery）：注册成功、`/approval on` 返回成功、低风险 `read` → `allowed-once`、高风险提权 → `NEXT`。三份副本哈希一致 | **三条元教训入规范坑 48**：① **mock 要照被替代物的契约来**——初版 mock 把 schema 参数整个忽略，于是"传了个不可调用的 schema"这个真实故障在自检里永远看不见；② **一个标志位不能兼表多种失败原因**——"服务缺失"与"注册抛错"混进同一个真假值，实机报成 `settings=unavailable`，把排查带偏一整轮（与坑 29 同源）；③ **静默 catch 会让"可审计"静默失效**——`record()` 的 `catch {}` 是空的，受限沙箱下 append 被拒（EPERM）而 77 条日志一条都看不出。"本体没有自动审批"这条入**坑 49**。**遗留**：插件源码不热加载，需托盘「重启宿主」才生效 |
| 25 | **审批投递异常排查：插件从 14:49Z 起收不到任何审批请求（怀疑已定位，待重启验证）** | 🟡 已做防御性修复并部署，**结论待一次宿主重启后的实测** | 用户要求"来一次会自动放行、不拦截的权限请求"，据此做真实提权测试时发现异常。**现象**：① 向 `$DSH_HOME\logs` 裸写探针被沙箱拒 → 依规重试并请求 `danger-full-access` → **命令成功执行，但用户确认"没有任何弹窗，直接跑了"**，插件也**一条决策都没记**；② 统计全部 78 条日志：`plugin-loaded` 42、`asked-user` 36、**`auto-allowed` 0**、grade **36 条全是 high**；③ **最后一次决策是 09/11 14:49:08Z**，此后宿主又装载 **6 次**（15:26 / 15:53 / 02:27 / 02:40 / 03:00，其中**前 4 次跑的是旧代码**），期间本会话做过多次提权，**零记录**。**已确证的事实**：`dsh-tool-pwsh` 的 `sandbox_permissions`+`justification` 是**无条件**走 `approveEscalation` → `approval.approver.request()`（L363），而 `approveEscalation` 只有拿到 `allowed-once` 才会放行 → 所以**审批请求确实发出且被 `allowed-once` 批准了**，但**既没问用户、也没经过插件**。`ctx.get('approval')` 只有 `dsh-user-approval` 提供，无其他答复方；`$DSH_HOME\.agent-presets` 不存在，也没有 preset 级答复方。**怀疑根因（待验证）**：Cordis 的 `dispatch()`（`cordis/lib/index.js:263`）**只读派发目标 ctx 自己的 `_hooks`，不向上遍历作用域链**，而审批瀑布按 **agent 作用域**派发（`waterfall(scopeTarget(req.agent, req.agent), …)`）；`ctx.on` 挂到哪个作用域取决于注册时机。**防御性修复（已部署）**：把 `ctx.on('approval/request', …)` 从"设置注册（含 `await loadSchemaLib()`）之后"**移回 apply 的同步段**——即恢复成改动前的相位；`settings.register` 因为把 effect 挂在 settings 服务自己的 ctx 上，晚注册不受影响（这也是它当初"看起来没坏"的原因）。新增回归断言"监听在 apply 的同步段就已挂上（不依赖 await）" | **门禁**：`apply-self-test` **13 → 14 断言全绿**（新增同步段回归），`grade` 10/10；三份副本哈希一致（`A1D1E75D…`） | **两个独立障碍要分清**：**(甲) 投递**——上条的异常，**早于本次改动**（那 6 次装载里 4 次是旧代码），所以不是我改坏的；**(乙) 分类**——从 `workspace-write` 出发 `WIDER_MODES` 只允许升到 `danger-full-access`，而 harness 的 reason 是 `` `escalate sandbox to ${mode}: ${justification}` ``，**模式名必然出现在 reason 里**且默认词表第一个就是它 → **结构上必然判 high**，自动放行分支在此配置下不可能触发。要演示自动放行，安全的做法是把会话预设切成**「仅可查看」**，此时请求 `workspace-write` 的 reason 为 `escalate sandbox to workspace-write: …`、**不含任何高风险词** → 判 **medium → 自动放行**（方向是收紧，更安全）。**遗留**：插件源码不热加载；重启后立刻做一次提权实测——日志出现决策条目则投递恢复，仍无则说明在作用域/挂载层面，改用 `ctx.on(..., { global: true })` 实验 |
新会话从《代码规范与范例.md》0 节 + 本表最后一行开工
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

### 0.4.x 修复线（2026-09，阶段 6~11）

- **0.4.1**：移除 Electron 单实例锁与 DSH_HOME profile 的 `dsh-host-single-instance` 硬互斥（它让第二个 `dsh web` 直接 exit 3，桌面壳打不开）→ 多窗口 + host 复用（`.dsh-host.lock` 登记 + netstat pid→端口 + `__DSH_BOOT__` 校验）；新增 `src/repair.mjs` 启动前自愈会话日志（半个尾帧截断 / 首帧异常重编码 / 隔离）；退出前等日志静止再杀宿主（完整退出）；背景图 v1（设置"桌面"section + CSS 注入）。
- **0.4.2**：背景图改 admin 回环 HTTP `/bg-image` 供给（Chromium 禁 http 页面加载 `file://`）+ 格式白名单；新图标（`gen-icon.mjs` 生成 build/icon.ico）；`node-guard.mjs` 防 RUN_AS_NODE 泄漏；新增《代码规范与范例.md》。smoke 31/31。
- **0.4.3**：背景图"注入成功但看不见"——像素级探针（bg-probe2~5）实证 rc.6 SPA 用写死不透明层铺满视口，改为把 `[class$="_frame"]`/`[class$="_root"]`/`[class$="_centerCol"]` 置透明（侧栏/输入框保持不透明）。打包 0.4.3 + 本机 asar 热更新。
- **0.4.4**：工作区选取报错 "win32 folder dialog worker exited before reporting a result"——进程级实证 rc.6 native 选择器（koffi COM worker）选取时静默崩溃；宿主 env 注入 `SSH_CONNECTION=dsh-desktop-browse` 钉住应用内浏览。smoke 33/33（新增 pickDirectory→unavailable、listDirectory→ok）。本机 asar 热更新（用户选择只热更本机）。
- **0.4.5（阶段收尾，当前版本）**：设置面板"桌面"按钮悬停/按下交互（ghost + interactive-bg-hover/-active，CDP 实测）；**打包 `DSHDesktop-Setup-0.4.5.exe`（经用户同意，本阶段最终版）**；dist 仅留 0.4.5；门禁全绿（语法 / repair 8/8 / admin-bg 7/7 / smoke 33/33 / 打包产物 SMOKE OK）。用户声明本阶段不再修 bug。
- **0.4.6**：harness 升级到 **rc.8**（`build-host.mjs` 的 VERSIONS 锁 rc.8；已装应用 vendor 原地替换，ABI 门禁 5/5、宿真实启动、smoke 33/33、repair 8/8，备份 `vendor-20260911-153836`）；**壁纸全覆盖修复**（旧写法 body 背景在 html 有底色时不传播到 canvas → 底部露出平铺 `#101216`，即用户报的"黑条"；改为 `body::before` fixed 固定层，像素验收露底采样点 56 → 0、平均 Δ 80 → 5）；**新增亮度/模糊滑块**（`bgBrightness` 0.2~2、`bgBlur` 0~40px，即时重绘，越界钳制），smoke 33 → **37**。**已热更新本机已装应用**（asar 重建 + `dsh-desktop-ui` 双副本，备份 `app.asar.bak-0.4.5`）；用户重启后确认**底部黑条消失、亮度/模糊滑块可用**；新增诊断端点 `POST /api/diag/opaque-layers` 首用即证实"视口底部 25% 内实心 rgb(21,21,23) 的层 = 0"。- **0.4.6（增量）**：**自带插件**`dsh-auto-approval`（AI 自检权限申请：审批瀑布风险分级，低风险自动放行、高风险问用户；配置走本体 settings `auto-approval`；`/approval` 开关；决策日志）——源码入仓库、build-host 拷进 vendor、壳启动自动挂载 profile 的 out-of-tree 插件位；**托盘「重启宿主（重载插件）」** + `POST /api/restart-host`（插件代码改动后重载用）；smoke 37 → **40**。
- **检查点（当前基线）**：`node scripts\admin-bg-test.mjs`（7）→ `node scripts\repair-self-test.mjs`（8）→ `node scripts\smoke.mjs`（**40**）→ 发版时 `electron-builder --win nsis`（无网络不带 CSC 变量出未签名包；**需用户同意**）。

---

## 4. 通用方法约定

- **不 commit 不进下一阶段**；commit message 带阶段号（M0/M1a/...）。
- 检查点失败 = 阶段未完成；修复后重跑，不"口头通过"。
- 所有对 v1（`desktop-shell/`）的移植以 `smoke.mjs` 语义为准：行为契约先行，实现可换。
- 包管理器统一 **npm**（`npm ci --omit=dev`）；pnpm 仅在 `dsh plugin` CLI 装插件场景需要，v2 不用。
- **沙箱管道限制（本机实测）**：子进程 spawn 用 `stdio:'inherit'`/`'ignore'`，不能用默认 pipe（EPERM）；npm 生命周期脚本用 `--ignore-scripts` 后手动跑 `node node_modules\electron\install.js`；断言脚本输出用 `process.stdout.write(...) + process.exit(0)` 防丢行。用户自己的终端无此限制。
- DSH 零改动承诺维持：壳侧需要的一切走 `--port`/`--patch`/admin API，不动 DSH 源码。
