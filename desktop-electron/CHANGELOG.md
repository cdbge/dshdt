# CHANGELOG — DSH Desktop（Electron 主路线）

版本策略：壳版本独立 semver（v1 Node+Chrome 壳止步 0.3.0）；DSH 依赖经 `vendor/profile` 锁定
`@deepseek-ai/dsh@0.1.0-rc.8`，升级走独立流程（build-host + 双冒烟门禁）。

## 0.4.6 (2026-09-11)

- **【更新复测：门禁正确挡住，但探针有假阴性】0.1.5 的根 URL 是 303 换 cookie，实测流程为**
  裸 URL → `401 dsh web authentication required`；带 token 但**默认跟随重定向** → `401`（**Node 的
  `fetch`(undici) 没有 cookie jar，303 跳转时丢掉 `Set-Cookie`**）；带 token + `redirect:'manual'`
  → `303 + Set-Cookie: dsh-auth-…`；**带上该 cookie 请求 `/` → `200`（28029 字节完整 SPA HTML）**。
  而 `runBootGate`（vendor-build）与壳的 `waitReady`（host）都只认 `if (res.ok)`，**因此对任何
  0.1.5+ 的树都会永远探不到就绪**——症状与原始事故完全一致。第一轮只加了「token 感知的 URL 提取」，
  拿得到 URL 但没人能验证它，**换票这一跳没解决**。
  建议修法（本轮未实施）：**两处判据分开**——门禁做完整 303→接 cookie→200 握手（它起的是用完即杀的
  宿主，可以消费 token）；**壳的 `waitReady` 只要求「服务器回了任何 HTTP 响应」**，把带 token 的 URL
  原样交给窗口（窗口有真正的 cookie jar 会自己走完换票），**避免探针先把一次性 token 消费掉**。
- **【新增】`src/junction-safe.mjs` — junction 场安全删除**。`$DSH_HOME\profiles\node_modules` 有
  **199 个 junction** 指向 `resources\vendor\profile\node_modules\*`（含整个 `@deepseek-ai`）。实测
  **Node 的 `fs.rmSync(recursive)` 不跟随 junction**（最小复现：目标 3 文件，删后仍 3），但 **Windows
  的 `rmdir /s /q` 与 `del /s /q` 会跟随**。观测到的损坏形态极具辨识度：暂存树里 **240 个
  `@deepseek-ai/*` 包被掏空成空目录、`package.json` 全没**（11000 → 4000 文件）——**「目录还在、
  文件全没」正是 `del /s /q` 的特征**，一次经 `@deepseek-ai` 那条 junction 的删除就能一次性掏空全部
  240 个。处置：门禁 `finally` 与壳启动都改走 `safeRemoveTree()`（逐个 unlink 链接本身，绝不递归进
  目标）；新增 `cleanStaleBootGateHomes()` 在壳启动时收掉上次没走完 `finally` 的隔离目录，判年龄用
  **birthtime 而非 mtime**（内容一变 mtime 就刷新，会把正在跑的门禁误判成遗留）。
- **【核查】0.4.5 安装其实是完整的**：顶层每个文件与 `dist\win-unpacked` **逐字节同尺寸**
  （`DSH Desktop.exe` = 225,663,488）。安装程序拒绝运行是正确的——`DSH Desktop.exe` 有 6 个进程在跑。
  用户按 "dsh" 搜不到进程，是因为**壳的宿主子进程用 `ELECTRON_RUN_AS_NODE` 跑的就是 `DSH Desktop.exe`**，
  不叫 `dsh`。**重跑 0.4.5 安装包会把 `app.asar` 覆盖回 0.4.5（2,229,316 字节），丢掉更新按钮与事故修复**
  ——除非确实要退回干净基线，否则不要重装。
- **【方法论】三个假设全部被实验证伪，好过直接断言**：`fs.rmSync` 不跟随 junction；门禁不破坏被测树
  （拿现网拷贝跑真门禁，`15210 → 15210`，且返回 `ok=true`）；0.1.5 宿主不破坏自己的树（`11173 → 11173`）。
  **未证实但极强的线索**是上面那条 junction 形态。坏树被排查过程自己的探针脚本 `rmSync(staging)` 删掉，
  **无法再取证**——排查类脚本不得随意删现场，这条要记。
- 门禁：**167 离线断言 0 失败**（update 36 / vendor-build 54 / dsh-apply 44 / junction-safe 18 /
  repair 8 / admin-bg 7）。

- **【事故第二轮·真正的持久根因】`$DSH_HOME\.credentials.yaml` 被 0.1.5 改写成不兼容格式 → 已修复**。
  第一轮只把 vendor 换回 rc.8，前端仍然起不来。真因：**0.1.5-rc.2 运行期间把 `.credentials.yaml`
  改写成了它自己的带版本嵌套文档**（`version: 1` / `refs` / `records`），而 rc.8 的
  `credentials-local` 要求该文件是「凭证名 → 非空字符串」的**严格扁平映射**
  （见 `dsh-credentials-local/lib/index.js:110-137`）——读到顶层 `version: 1` 是**数字**就抛
  `TypeError` → 插件树加载失败 → 宿主 `code=1` 退出 → 前端永远拉不起来。
  **这就是"重装也解决不了"的答案**：该文件在 `$DSH_HOME`，而卸载程序不删 `$DSH_HOME`
  （`deleteAppDataOnUninstall: false`），重装根本碰不到它。
  修复：把它还原成扁平格式（备份 `.credentials.yaml.bak-<时间戳>-0.1.5-format`），
  用真实 `DSH_HOME` 复验 —— `boot` → **1 秒就绪** → `SMOKE OK`。
- **两处可诊断性修复（这才是本轮真正的价值）**：
  ① **`bootHost()` 在拿不到 URL 时改为抛错**。原先 `if (url === null) return` 是**静默返回**：
  `main()` 接着拿 `null` 去 `loadURL`，Electron 抛的是一句与真因毫无关系的
  `Error processing argument at index 0, conversion failure from null`；**更严重的是它让换树兜底
  回滚彻底失效**——回滚只在 `bootHost` 抛错时触发，返回 null 不触发。所以第一轮加的
  `restoreOldTree` 在这个场景里根本没跑。0.4.6 事故的持久化阶段正是栽在这里。
  ② **宿主非零退出时把它的日志尾巴写进壳日志**（`hostLogTail()`）。宿主"启动即退出"的真因
  （插件树加载失败、凭证文件格式不兼容）只在宿主日志里，只报一个 `code=1` 会把排查引向完全
  错误的方向——本轮因此多绕了一整轮。
  另：`log()` 现在兜住 `console.log` 的 `EPIPE`（stdout 是已关闭管道时，一条日志失败不该
  通过 uncaughtException 把整个启动流程带走）。
- **启动门禁有一个已记录的盲区**：`runBootGate` 用**隔离 DSH_HOME**（否则会污染用户真实状态），
  因此**测不出"新树与用户 `$DSH_HOME` 现有状态不兼容"**——本轮凭证文件事故正是这一类。
  这类问题只能靠**换树后的兜底回滚**接住（见修复①，它必须真的能触发）。
  备份：`app.asar.bak-0.4.6-dshfix2`。门禁：离线 149 断言 + smoke 49/49 + 已装 exe `--smoke` SMOKE OK。
- **安全提醒**：本轮排查中一条 PowerShell 打码正则漏了缩进行，把用户真实的
  `DEEPSEEK_API_KEY` 打印进了会话记录（该 key 需吊销重发）。教训：**打码要按"值形态"匹配，
  不能按"键位置"匹配**——缩进层级会让行首锚点全部落空。

- **【事故修复】DSH 更新按钮把应用更新到起不来——已修复并热更新**。用户在界面里点「更新 → 重启并应用」
  后，harness 被从 `0.1.0-rc.8` 跨到 `0.1.5-rc.2`，此后再也无法拉起前端（只剩进程）。根因两条：
  **① DSH 0.1.5 起根 URL 带进程级启动令牌**（`http://127.0.0.1:PORT/?token=…`，首次访问换签名 cookie），
  而 `host.mjs` 的 `waitReady()` 探的是**不带 token 的** `/`，永远拿不到 200 → 30 秒超时 → 判定启动失败
  → `cleanup(1)`，窗口根本没机会创建。这正是 rc.8 源码注释里写的 "until a real authentication layer
  exists"——0.1.5 把它实现了，而壳的编排代码还是 rc.8 时代的契约。
  **② 更新流程漏了计划书 §8 明写的「启动门禁」**：只实现了 ABI 门禁，而 ABI 门禁只看 `.node` 能否
  dlopen，**完全不关心宿主能不能对外服务**——所以它对这棵起不来的树给出 OK=5 FAIL=0 全绿。
  恢复：旧树因宿主从未就绪而未被清理，完整留在 `profile.old-*`，rename 回去即为 rc.8，已用已装运行时
  验证启动 PASS。
- **四项修复**：
  ① **启动门禁接入 `buildVendorTree`**（`runBootGate`）：拿暂存树**真起一次宿主**并探到就绪才允许发
  marker；复用 `host.mjs` 的 `startHost`/`extractHostUrl`，保证「门禁测的」与「壳跑的」是同一套逻辑。
  ABI + 启动**双门禁**，缺一不可。
  ② **`waitReady` 兼容 token URL**（`extractHostUrl`）：从宿主 stdout 解析它自己宣告的根 URL（0.1.5+
  带 token），回退裸端口 URL（rc.8 形态）。配套把 `desktop.patch.yml` 的 `printUrl` 改回 **true**——
  壳是独立进程、够不到宿主的 cordis 上下文，**stdout 是唯一能看到该 URL 的通道**，关掉它等于自断生路。
  ③ **版本距离守卫**（`assessJump`）：major/minor/**patch** 任一位变化即拒绝默认放行，需显式
  `allowUnsafeJump`。口径定在「只放行预发布号变化」，是因为本项目 harness 的**修订位才是真正的发布轴**
  （`0.1.0` 后面直接跟 `0.1.5`）。**第一版守卫只比 major/minor，于是把 `0.1.0-rc.8 → 0.1.5-rc.2`
  判成「安全」——等于完全没挡住这次事故，是单测逼出来的修正。**
  ④ **换树兜底回滚**（`restoreOldTree`）：宿主在换树后不就绪 → 自动把旧树换回并重试一次。这是对当初
  Q4「不做回滚」的修正：失败发生在**换树之后**，所以「延迟删旧树」救不了。
- **`desktop.patch.yml` 是双份的**：既在 asar 内（`src/desktop.patch.yml`）又在 `extraResources`
  （`resources/desktop.patch.yml`），而**打包态读的是后者**——热更新只换 asar 会漏掉它。
- 门禁：离线单测 **149 断言**（update 36 / vendor-build 54 / dsh-apply 44 / repair 8 / admin-bg 7）
  + smoke **49/49**；**已装应用 `--smoke` 实测 SMOKE OK**（`ready: http://127.0.0.1:6413/`，1.1s）。
- 备份：`app.asar.bak-0.4.6-dshfix`、`desktop.patch.yml.bak-0.4.6-dshfix`。版本号仍为 0.4.6。

- **DSH（harness）更新按钮（S1~S5，已热更新到本机已装应用）**：设置面板「桌面」section 新增
  「DSH 版本」行（与既有的「壳版本」状态行成对，两个更新平面措辞分明），三个按钮
  **检查更新 / 更新 / 重启并应用**；托盘新增「检查 DSH 更新」。四个 admin 端点：
  `GET /api/dsh/status` + `POST /api/dsh/check|update|apply`；`/api/status` 内嵌 `dshUpdate` 快照
  复用已有的 5 秒轮询。与 **壳自更新（electron-updater / 平面 B）是两个独立平面**，后者本期零改动。
  平台约束（用户决策）：**换树须逐次征得同意**（Q1）；**不内置 npm**，探测不到系统 Node 时按钮置灰（Q2）；
  默认 registry = npmmirror（Q3）；**不做回滚备份**，用户有安装包可重装 → 门禁成为唯一防线（Q4）。
  实现：`src/dsh-update.mjs`（版本发现）+ `src/vendor-build.mjs`（npm 探测/install/剪枝/插件同步/
  ABI 门禁/lock/`buildStaging`）+ `src/dsh-apply.mjs`（marker/校验/rename 换树/清理）；
  `build-host.mjs` 与 `abi-scan.mjs` 退化为 CLI 薄封装，与壳**共用同一份**安装逻辑。
  门禁：离线单测 **131 断言**（update 29 / vendor-build 49 / dsh-apply 38 / repair 8 / admin-bg 7）+
  smoke **40 → 49**。真实端到端：完整 npm install 441s → 剪枝 16580 文件 → ABI `OK=5 FAIL=0` →
  **暂存树真起宿主**（就绪 URL + `GET /` 200 + 优雅关停），全程未触碰现网 vendor。
- **三处关键设计（都有实证依据，勿改）**：
  ① **门禁代码必须落 `src/`**——`electron-builder` 的 `files` 只含 `src/**`，**`scripts/` 不进包**；
  `abi-scan.mjs` 原在 `scripts/`，打包后根本不存在，而无回滚备份时它是唯一防线（规范坑 27）。
  ② **换树必须在 `dshBin()` 首次求值之前**——`DSH_BIN` 是解析结果而非固定路径，换树会把旧树改名走开；
  已把该常量改为惰性 `dshBin()`（6 处调用点全替换），否则表现为「更新成功但应用再也起不来」。
  ③ **暂存区放 `<vendorDir>/staging/<版本>`** 而非 `APP_DATA/staging`——换树是 rename，
  `APP_DATA` 在 C: 而开发态仓库在 D:，跨卷会 EXDEV。配套 `.gitignore` + `build-host` 收尾清理
  （`extraResources` 是 `from: vendor` 整目录拷贝，残留会把上百 MB 打进安装包）。
- **修掉一处真漏洞（写 smoke 断言时发现）**：「只接受检查更新查证过的版本」的守卫原写作
  `if (target !== null && …)`，而 `target === null` 的真实含义是**从未检查过更新**而非「版本随便填」
  ——任意版本串都能绕过守卫并启动构建（把用户输入拼进 npm 依赖 = 供应链面）。已改为先判
  `target === null` 直接拒绝（规范坑 29）。
- **实测修正**：`vendor.lock.json` 的体积基线是 **pnpm** 建的（现网 vendor 含 `node_modules/.pnpm`、
  `pnpm-lock.yaml`、`.modules.yaml`，且无任何 npm 锁文件）。拿 npm 建的新树比它：字节差 3.0%、
  **文件数差 14.4%**（13019 vs 15208）——安装器落盘布局差异，不是缺陷。故「树可用」的判据改为
  **功能性证据**（ABI 门禁 PASS + 拿暂存树真起一次宿主），体积对比降级为诊断（规范坑 28）。
- **文档恢复**：`scripts/` 与 `src/` 的职责边界、四个新门禁脚本、DSH 更新面的 9 条 smoke 断言、
  以及规范坑 27~30（`scripts/` 不进包 / pnpm 基线 / 哨兵值兼义 / 断言打错对象）。

- **自带插件 `dsh-auto-approval`（AI 自检权限申请，Codex 式自动审批）**：源码进仓库
  `packages/dsh-auto-approval/`；`build-host.mjs` 会把它拷进 `vendor/profile/node_modules`，
  壳每次启动幂等同步到 profile 的 out-of-tree 插件位，并**自动补** `$DSH_HOME/profiles/web/cordis.patch.yml`
  的 `insert` 行 —— 装完即用，用户无需手工挂载。机制：挂 harness 的 `approval/request` waterfall，
  低风险/有界操作 → `'allowed-once'`（不弹窗），高风险或判不准 → `next()`（落到用户的确认弹窗）。
  配置走**本体** settings 命名空间 `auto-approval`（`enabled` / `autoApproveUpTo` / 三张规则表 /
  日志开关），另有 `/approval on|off|why|rules` 命令与 `$DSH_HOME/logs/auto-approval.log` 决策日志。
  自检：分级器 10 断言 + 接线级 12 断言全绿；zod 缺失时优雅降级（跳过命名空间注册，仍以默认配置工作）。
- **托盘新增「重启宿主（重载插件）」**：`restartHostManual()` —— 优雅停旧宿主（等会话日志静止，
  不留半个 zstd 帧）→ 清空"崩溃自动重启 ×N"预算 → 重拉 → 重载窗口；同一实现经
  `POST /api/restart-host` 暴露，供冒烟断言。**用途：插件源码改动后重载**（补丁层热加载，
  但**插件代码不热加载**——ESM 模块缓存，实测过）。
- smoke 37 → **40**（新增 restart-host 3 条：端点 ok / 重新就绪 / 换了新宿主端口）。
- **实测记录（写进规范坑 26）**：asar 热替换后**必须重启应用**——Electron 的 asar 目录索引在首次访问时缓存，
  换掉文件而不重启会让运行中的进程按旧索引读新文件，实测把 `/api/status` 的 `version` 读成 `ositio`（错位碎片）。
  仅替换 asar 外的 `resources/vendor/**` 或 profile 插件位不受影响，可用托盘「重启宿主（重载插件）」生效。
- **开发中修掉一处自己的低级错误**：把 `ensureProfilePlugin` 改名 `ensureProfilePlugins` 时漏改调用点，
  smoke 当场以 `ReferenceError` 抓到（否则热更后壳直接起不来）——这就是"改完必须跑全量冒烟"的价值。


- **harness 升级 rc.6 → rc.8**（DSH 零改动，经用户同意换树）：`scripts/build-host.mjs` 的 `VERSIONS`
  锁 `0.1.0-rc.8`；已装应用 `resources\vendor` 原地替换（route B：pnpm hoisted 安装 + `build-host --prune-only`
  剪枝/ABI 门禁；备份 `vendor-20260911-153836`）。实机验证：ABI OK=5 / SKIP=6 / FAIL=0、宿主独立 home 真启动
  200 且 stderr 空、`/plugins/dsh-desktop-ui/client.js` 正常供给、smoke **33/33**（跑的是 rc.8）、repair 8/8。
  注意 rc.8 把 markdown 渲染栈（`micromark*`/`mdast-util-*`/`unist-util-*`/`shiki`/`katex` 等 80 个包）
  从运行期依赖降为构建期依赖 ⇒ junction 场会出现大量悬空链接，属预期（DSH 自身容忍）。
- **修复：壁纸未全覆盖（"对话框底下那条黑条"）**。旧写法把壁纸放在 `body` 的背景上，而 `html` 有不透明
  底色时 **body 的背景不会传播到 canvas**，未被 body 盒子覆盖的区域会露出平铺的 `#101216`。改为
  `body::before` **`position: fixed` 固定层**（覆盖整个视口，与 body 盒子无关；`z-index:-1` 压在内容之下）。
  像素级验收（自写探针 `probe-wallpaper-tune.mjs`，65 个采样点逐点比对"壁纸理论值 = cover 映射 × scrim"）：
  旧写法 **56 点**露出兜底底色、平均 Δ=80；新写法 **0 点**、平均 Δ=5。
- **修复（根因）：底部"黑条" = CSS 变量覆盖写错了层级**。壳从 0.4.3 起把
  `--dsw-alias-bg-base: transparent !important` 写在 `:root` 上，而主题插件把深色别名定义在
  **`body[data-ds-dark-theme]`**（`--dsw-alias-bg-base` → `--dsw-static-neutral-bluish-950` = `#151517`）。
  CSS 自定义属性取"最近的定义"，body 打赢 html ⇒ 该覆盖**一直没生效**，所有用
  `var(--dsw-alias-bg-base)` 做背景的元素（输入框下方那条 footer/seat）仍画出实心 `#151517`。
  现改为 `:root, body, body[data-ds-dark-theme], body[data-ds-light-theme]` 同时覆盖。
  取证手段：截图逐行像素分析（底部两条 11px/15px 实心 `rgb(21,21,23)`）+ 主题插件静态定义比对。
- **新增诊断端点 `POST /api/diag/opaque-layers`**（回环 admin）：在**真实应用窗口**里列出指定视口区域
  （默认底部 25%）所有不透明背景/带渐变背景的元素（class、颜色、矩形），用于"注入成功但看不见"类问题的现场取证。
- **新增：壁纸调参（亮度 + 模糊滑块）**。设置面板"桌面"section 与壳内设置页各两个滑块
  （`bgBrightness` 0.2~2.0 步 0.05、`bgBlur` 0~40px 步 1），经 `POST /api/settings` 写入并持久化在壳 settings，
  `GET /api/status` 回读；越界钳制、非数字忽略、改动即时重绘（`actions.reapplyBackground`）；
  模糊时固定层向外扩 2×半径避免四周露边。smoke **33 → 37**（新增写入 / status 回读 / 越界钳制 / 非法值忽略）。
- **已热更新本机已装应用**（经用户同意，坑 13 流程）：重建 asar（`src/main.mjs`/`src/admin.mjs`/`VERSION`/`package.json`）
  并替换 `dsh-desktop-ui` 的两份副本（`resources\vendor\...` 与 `$DSH_HOME\profiles\web\...`）；
  备份 `app.asar.bak-0.4.5`、`client.js.bak-0.4.5`（可回滚）。
  用户重启后确认：**底部黑条消失、亮度/模糊滑块可用**（自设壁纸 + 亮度 0.85 / 模糊 2px）。
- **诊断端点首次实战**：`POST /api/diag/opaque-layers`（region=bottom）在真实窗口里返回
  "视口底部 25% 内实心 rgb(21,21,23) 的层 = **0**"，其余不透明层均为设计如此
  （侧栏 rgb(27,27,28)、输入卡 rgb(44,44,46)、图标/发送按钮）。
## 0.4.5 (2026-09-08)

- **增强：设置面板"桌面"section 按钮加悬停/按下交互**（与面板其他按钮一致）：按钮基底改
  ghost 透明 + 边框，`:hover` → `--dsw-alias-interactive-bg-hover`、`:active` →
  `--dsw-alias-interactive-bg-active`、`:focus-visible` 品牌色描边、0.15s 过渡——样式由
  dsh-desktop-ui 插件注入的 `.dsh-desktop-btn` 样式表提供（带 disposer）。交互实测（CDP 鼠标
  移动）：静止 `rgba(0,0,0,0)` → 悬停 `rgba(255,255,255,0.08)`（官方同款 token，深色主题）。
  诊断工具：`scripts/hover-probe*.mjs`。已同步已装应用 vendor 副本与 HOME profile
  （备份 client.js.0.4.4.bak），刷新窗口即生效。
- **打包（经用户同意，本阶段最终版）**：`DSHDesktop-Setup-0.4.5.exe`（未签名；时间戳服务器
  不可达）+ blockmap；门禁全绿（语法 / repair 8/8 / admin-bg 7/7 / 全量 smoke 33/33 /
  打包产物 --smoke SMOKE OK + 优雅退出）；dist 仅保留 0.4.5，旧版已清。

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
