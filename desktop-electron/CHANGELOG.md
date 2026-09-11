# CHANGELOG — DSH Desktop（Electron 主路线）

版本策略：壳版本独立 semver（v1 Node+Chrome 壳止步 0.3.0）；DSH 依赖经 `vendor/profile` 锁定
`@deepseek-ai/dsh@0.1.0-rc.8`，升级走独立流程（build-host + 双冒烟门禁）。

## 0.4.6 (2026-09-11)

- **右侧栏遮罩 + 按钮固定黑底 + 左侧栏背景（用户一次性提的四项诉求）**：
  ① **右侧栏面板遮罩**与对话主页**共用** `--dsh-conversation-mask-opacity`，所以两边天然同步、
  不需要任何联动代码。面板自带 `background:var(--dsw-alias-bg-base)`（配壁纸时壳已把它置透明），
  这里再显式置透明一次，保证没配壁纸时遮罩也看得见；面板自己有 `z-index:10`（独立层叠上下文），
  故 `::before{z-index:-1}` 正好落在面板内容之下、底色之上——正文清晰，只是底色暗一档。
  ② **右侧栏按钮固定黑底** `rgba(0,0,0,.5)`，覆盖面板顶部两颗图标按钮（全屏切换 / 收起）与
  折叠态那个「展开」按钮，**刻意不做成可调项**（用户明确要求）。选择器写成
  `button[data-sidebar-right-toggle]` 这种"元素+属性"形式（特异性 (0,1,1)）：**压得过**插件自己的
  类选择器 (0,1,0)，又**压不过**它的 `:hover` (0,2,0)——于是黑底生效而**悬停高亮照旧**，
  不像 `!important` 会把悬停反馈一起吃掉。
  ③ **左侧栏背景**：新增 `sidebarBgMode`（`extend` 延伸主页面壁纸 / `own` 独立图片）
  + `sidebarOpacity`。**渲染值恒为 `max(设置值, 对话区遮罩)`**——"左侧栏比主页面更不透明"是用户的
  硬要求，而且必须挡得住"用户把对话区遮罩拖到 0.9"这种情况，所以由客户端在写 CSS 变量时取 max
  （壳侧只存用户拖出来的原始值，否则滑块回读会凭空跳一格）。两种模式**共用一条 CSS**：侧栏铺一层
  黑纱，`own` 时纱下再叠 `--dsh-sidebar-bg-image`；`extend` 留 `none`，壁纸由 `body::before`
  从透明侧栏里透出来。把 `--dsw-specific-sidebar-fill` 就地置透明，侧栏列与它内部的 `_root`
  一起变透（不必和各自的 background 抢 `!important`）。背景**画在元素自身上**而非 `::before`：
  没配壁纸时 `_frame` 底色不透明，负层级会被它整个盖住。
  ④ 新增壳路由 `GET /sidebar-image`、`POST /api/pick-sidebar-background`、
  `POST /api/sidebar-background`，与 `/bg-image` 同一种回环 HTTP 供给（`file://` 会被 Chromium 拒）。
  「个性化」面板新增三行：左侧栏背景（模式）/ 左侧栏图片（浏览·清除）/ 左侧栏遮罩（滑块）。
  smoke **55 → 66**（新增 11 条：模式/遮挡写入与回读、越界钳制、模式非法值忽略、
  sidebar-image 未设→404 / 供给字节一致 / 清除后→404、非图片拒绝、headless 选图端点）。

- **右侧栏「全屏」态遮罩单独一档**（用户实测反馈："侧边全屏模式下透明度过低了"）。
  全屏时面板改成 `position:fixed; inset:0` 铺满整个视口，**它不再是"旁边一栏"而是整个工作面**，
  正文直接压在壁纸上，沿用对话区那档（默认 0.25）读着费劲。故新增 `fullscreenMaskOpacity`
  （默认 **0.8**）与「右侧栏全屏遮罩」滑块，`[data-sidebar-right-panel=fullscreen]` 单独走这一档；
  两条规则特异性相同，靠书写顺序后者胜出，**退出全屏立刻回到与对话区同步的那档**。
  smoke **66 → 69**（新增 3 条：写入 / status 回读 / 越界钳制）。

- **【重要事实纠正】已装应用跑的是 DSH `0.1.5-rc.2`，不是仓库 vendor 的 `rc.8`。**
  本轮为取右侧栏选择器去**仓库** vendor 搜类名，`_marks` / `eGxaPq` / `yAWgPa` **一个都搜不到**，
  差点据此误判"这些选择器早就失效了"。真相是两棵树版本不同：`dsh-client-ui-chat`、
  `dsh-client-ui-sidebar-right` 是 0.1.5 才有的包（rc.8 里没有），CSS-modules 哈希也整套不同。
  证据两条：已装 `resources\vendor\vendor.lock.json` 的三个包全写 `0.1.5-rc.2`（生成于那次成功
  换树的时刻）；运行中的应用自己在 `/api/status` 的 `dshUpdate.installed` 里也是这么报的。
  ⇒ **为"运行中的界面"取选择器，只读已装树**
  （`D:\Desktop\DSH Desktop\resources\vendor\profile\node_modules\@deepseek-ai\...`）。
  教训入规范坑 45。**同时提醒**：将来一打安装包，装出来的应用跑的是 rc.8 那棵树，
  **本轮所有皮肤选择器都要重取一遍**。

- **已热更新本机已装应用**（坑 13 流程）：插件三份副本（仓库 + 已装 vendor + `$DSH_HOME\profiles\web`）
  哈希一致并已 `POST /api/reload-window` 重载；asar 重建后与已装树 **268 文件逐字节比对 0 差异**，
  备份 `app.asar.bak-0.4.6-sidebar`、`app.asar.bak-0.4.6-fullscreen`。
  ⚠️ **asar 需整体重启应用才生效（坑 26）**——重启之前，新加的三条壳路由一律 404，
  点「左侧栏图片 → 浏览…」会提示"操作失败（壳未响应？）"，**属预期而非故障**。

- **对话区中央遮罩延伸到覆盖两侧拖动滑块**（用户反馈"延伸一下覆盖滑块"）。原宽度
  `min(calc(var(--dsh-chat-content-width, 680px)), 100%)` 只盖住内容列本体，左右两条拖动滑块
  仍露在遮罩之外。改为 `min(calc(var(--dsh-chat-content-width, 680px) + 128px), 100%)`——
  内容列左右各 24px 内缩 + 40px 手柄宽，正好把两条滑块包进来。
  只改客户端插件，`POST /api/reload-window` 重载即生效，**不需要重启应用**。

- **`/api/diag/ui` 首次调用即失败——是诊断脚本自己写错了（已修）**。现象：稳定返回
  `{"ok":false,"error":"Script failed to execute, this normally means an error was thrown. Check the
  renderer console for the error."}`。**这句话只是 Electron 的外壳**，真因在渲染进程控制台里，
  壳侧看不到——排查因此空转一轮。真因是脚本里底部按钮那段写了 `rect: R(r)`：辅助函数
  `R = (el) => el.getBoundingClientRect()` 收的是**元素**，而 `r` 已经是算好的 **`DOMRect`**
  （`DOMRect` 没有 `getBoundingClientRect` 方法）→ `TypeError`。修为 `R(el)`。
  教训入规范坑 44：① **凡 `executeJavaScript` 的诊断脚本，函数体一律自带 try/catch 并把
  `e.stack` 返回给 Node 侧**，别依赖那句不透明的壳错误；② **诊断工具本身也要被验证**——
  它是"看真相的眼睛"，眼睛报错时最容易被误读成"被测对象坏了"；③ 同一段脚本里"元素"和"rect"
  别用 `el`/`r` 这种相似单字母名，把结果喂回取矩形辅助函数的行要逐个核对入参类型。

- **本次收尾的门禁与部署**：离线 **172 断言全绿**（dsh-apply 44 / update 36 / junction-safe 18 /
  vendor-build 66 / repair 8）+ smoke **55/55**；asar 重建后与已装树 **268 文件逐字节比对 0 差异**；
  `dsh-desktop-ui` 三份副本（仓库 + `resources\vendor` + `$DSH_HOME\profiles\web`）哈希一致。
  **已热更新本机已装应用**（坑 13 流程，备份 `app.asar.bak-0.4.6-diagui`）。
  **⚠️ 本次 asar 已换入，但运行中的进程仍是旧的（坑 26）——需整体重启应用，`/api/diag/ui` 的修复
  才会生效**（用户当次直接关机，次日重开应用即自动完成）。
  中央遮罩那项改的是客户端插件，已 `/api/reload-window` 重载生效，但用户未及目视确认。

- **设置面板拆栏：外观类设置独立成「个性化」**。原先「桌面」一栏混着两类东西——功能开关
  （开机自启 / 关闭到托盘 / Agent 工作区）与外观（背景图片 / 亮度 / 模糊 / 两处遮罩）。
  现把外观五项整体挪到新栏位 **「个性化」**（`settings.section` 的第二个注册项，`id: "personalize"`，
  `order: 90` 排在「桌面」之前，符合"先调外观、后调功能"）。「桌面」只留功能开关 + DSH 更新 + 状态行。
  实现方式：**用按索引拼接的脚本整块剪切 121 行 JSX，不手抄**（规范坑 25①）——脚本自带结构自检
  （块首必须是 `createElement(`、块末必须是自带逗号的 `),`、块内必须含预期首尾设置项），
  并报出行数变化（603 → 637）供交叉验证。

- **桌面皮肤（三项界面改造 + 一处修正，纯注入 CSS，DSH 零改动）**：
  ① **滚动条自动隐藏**：滑块默认透明（视觉上"收起"），鼠标移进滚动容器才显形。
  **刻意保留 8px 槽宽**（theme 插件的 `--dsh-scrollbar-width`）——若把宽度收到 0，正文会在悬停
  瞬间横向重排，那种抖动比"看不见滚动条"更难受。
  ② **右侧"多条状跳转小组件"（轮次标记轨）自动隐藏** + **圆角矩形黑遮罩**：默认 `opacity:0`
  并向右退开 8px，鼠标进入（或键盘聚焦）才浮现；遮罩是 `inset` 外扩后的 `border-radius:8px`
  圆角矩形（初版误做成 `50%` 椭圆，用户纠正为"方形圆角"），放在 `::before` 上（同为定位元素、
  先绘制，天然落在标记条之下）。
  ③ **对话区底层黑遮罩**：覆盖**能拖动的那条对话栏中间的内容列**——也就是左右拖动条所夹的那段宽度
  （居中、宽 `var(--dsh-chat-content-width)`），`z-index:-1` 让它落在内容之下、页面底色之上，
  正文照常可读。锚点取自拖动条自己的定位规则：拖动条是 `wSkVaW_body`（`position:relative`）的
  子元素，其 `left/right: calc(50% ± contentWidth/2 + 24px)` 正好界定这条内容列。
  **这一项改了三版才对**：第一版挂在两条拖动条上（用户："不是两个滑动栏"）、第二版盖住整个会话
  面板 `_root`（用户："不是整个页面，是中间那条"）、第三版落到内容列。
  选择器 `[class$="_body"]:has(> [class$="_scrollBody"])`：`_scrollBody` 是**直接子元素**
  （`_body` 这个后缀在多个插件里都有，必须限定；用直接子选择器也顺带避开坑 42 的祖先陷阱）。
  两项遮罩透明度**各自可调**（0 = 完全隐藏），设置面板「桌面」新增两个滑块，落 `settings.json` 的
  `railMaskOpacity` / `conversationMaskOpacity`（0~1，越界钳制）。
- **`[class$="_frame"]:has(...)` 一度把整个对话页面隐藏并上移半屏（严重，已修）**：
  `:has()` 匹配的是**任意后代**，而标记轨位于布局根框架内部，所以
  `[class$="_frame"]:has([class$="_marks"])` **同时命中两个元素**——`pI_x6G_frame`（布局根三栏框架
  = 整个对话页面）与 `eGxaPq_frame`（标记轨）。后果：整页 `opacity:0`（页面消失）且被
  `translateY(-50%)` 上移半屏（用户描述"对话页面飞到上半段"）。修法：
  `:not(:has([class$="_centerCol"]))` 精确排除（布局根含 `_centerCol`、标记轨没有）。
  教训入规范坑 42。
- **一次自己的低级失误（已修）**：把修复注释写进模板字符串时用了反引号（`:has()`），
  **反引号会终止模板字符串** → 语法错误，而我的部署脚本没按 `node --check` 的退出码中止，
  坏文件被写进了已装应用。已改为注释内不用反引号，并在部署脚本里加"语法不过就不部署"的硬门。
- **选择器怎么选的（关键，勿改成全名）**：CSS-modules 的**哈希前缀每次构建都会变**
  （实测 `eGxaPq_` / `wSkVaW_` / `pI_x6G_`），**局部名后缀才是稳定的**——项目原有的皮肤注入就是靠
  这个。本次定位：轮次标记轨 `[class$="_frame"]:has([class$="_marks"])`（`_frame` 与布局插件重名，
  故用 `:has(_marks)` 限定；`_marks` 唯一）、会话根 `_root`:has(`_scrollBody`)、拖动条 `_widthHandle`（唯一）。
- **新增只读诊断 `/api/diag/ui`**：报回"皮肤类改动"要改的四处 UI 锚点（可滚动容器 + 滚动条沟槽宽、
  resize 拖动手柄、右侧竖长条轨、底部按钮）。**固定用途的只读脚本，不是通用 eval**——与既有的
  `diag/opaque-layers` 同等风险画像（回环 admin、只读取）。
- **新增 `POST /api/reload-window` —— 客户端插件的热加载手段**：宿主插件有托盘「重启宿主（重载插件）」，
  而客户端插件改完只受 ESM 缓存影响，不重载页面就看不到新版；打包态 `Menu.setApplicationMenu(null)`
  又把 Ctrl+R 一起去掉了，于是"改一行 CSS 也要重启整个应用"。用 `reloadIgnoringCache()`
  （插件按 URL 取模块，忽略缓存才拿得到新文件）。
  **刻意不加 smoke 断言**：它会在测试中途重载壳窗口，把测试自己打乱。
- smoke **51 → 55**（新增皮肤遮罩 4 条：写入 / status 回读 / 越界钳制 / 非法值忽略）。

- **【鉴权页修复】0.1.5 就绪探测把"未鉴权"当成"就绪"，窗口加载了无 token 地址**。
  症状：应用起得来、窗口也开了，但页面停在 `dsh web authentication required; reopen the URL
  printed by dsh web`。根因在 `waitReady` 的判据：轮询**早期**宿主还没把带 token 的 URL 行写进
  `host.log`，此时 `extractHostUrl` 返回 null，只能退而探裸端口 URL——而裸 URL 对未鉴权请求回
  **401**，`if (res.status > 0) return url` 把 401 也当成了"它答了话"并**当场定稿**，于是
  `readyUrl` 是裸 URL，窗口自然过不了鉴权。
  修法（保留原有设计意图——"只要它答了话就说明在服务，换票交给窗口的 cookie jar"）：
  ① **宿主一旦宣告了本端口的 URL，就只认它**（不再并列裸 URL 兜底）；
  ② 尚未宣告时只能探裸 URL，但**只接受 2xx**——401/403 的语义是"服务在、但这次请求没通过鉴权"，
  不是就绪。实测：`ready: http://127.0.0.1:9712/?token=…`（带票），窗口可正常换票进入。
- **纠正一处记录**：`probeHostReady`（走完换票、会消费一次性 token）**只给启动门禁用**是对的——
  门禁的宿主是一次性的，消费无妨；壳的就绪探测绝不能消费它，否则窗口拿不到票。

- **【新增】构建进度显示（用户实测反馈："我怎么知道更新进度，你不能加一个吗"）**：原来构建约 8 分钟，
  界面只给一句"分钟级，请勿关闭应用"——等于没有进度。现在：
  ① `buildVendorTree` 新增 `onProgress` 回调，按阶段上报 `{ step, percent, label, detail }`；
  ② 阶段权重 install 0→68 / prune 72→78 / plugins 80 / ABI 84→88 / boot 90 / done 100；
  ③ **npm install 的子进度用"包目录数"当代理**（`countPackages()`，`@scope/x` 记 1、跳过点开头目录）
  ——npm 不吐精确进度，但它边解包边建目录，这个信号实时且不撒谎，label 里写的是真实已就位数
  （`正在安装依赖（312/520 个包）`）；
  ④ 快照新增 `progress` 与 `elapsedMs`（**已用时间比百分比更实在**，因为百分比只是按包数估算的刻度）；
  ⑤ 客户端在 `phase === 'building'` 时渲染进度条 + `百分比 + 阶段文案 + 已用时间`。
  容错：进度回调抛异常**不影响构建**（有断言覆盖）。已热更新（asar + 客户端插件双副本，备份
  `app.asar.bak-0.4.6-progress`）。smoke 49 → **51**（新增 progress/elapsedMs 与 jump/needsConfirm 字段断言）。

- **【修复】跨版本守卫把 GUI 用户永久卡死 → 已加确认流程（用户实测反馈："什么叫拒绝更新"）**：
  `assessJump` 拒绝时返回 `拒绝升级：…确认要跨版本升级请带 allowUnsafeJump: true`——**那是写给程序员的**。
  界面那个「更新」按钮只发 `{}`，永远不会带这个参数，于是**0.1.5 的更新在 GUI 里被彻底卡死**。
  修法：`dshUpdateSnapshot()` 增加 `jump`/`needsConfirm` 两个字段（评估结果进快照，客户端才能渲染）；
  `dshUpdateTo` 的拒绝文案改成"你该做什么"；**客户端在 `needsConfirm` 时不禁用按钮**，改标签为
  **「更新（跨版本）」**，点击后 `window.confirm` 展示 `当前 → 目标` 与不兼容原因，用户确认后**代传
  `allowUnsafeJump: true`**。已热更新（asar + 客户端插件双副本，备份 `app.asar.bak-0.4.6-jumpconfirm`）。
  教训入规范坑 40：**守卫必须给用户一个"能完成的动作"，否则它不是守卫，是死锁**。

- **【更新复测：门禁正确挡住，但探针有假阴性】0.1.5 的根 URL 是 303 换 cookie，实测流程为**
  裸 URL → `401 dsh web authentication required`；带 token 但**默认跟随重定向** → `401`（**Node 的
  `fetch`(undici) 没有 cookie jar，303 跳转时丢掉 `Set-Cookie`**）；带 token + `redirect:'manual'`
  → `303 + Set-Cookie: dsh-auth-…`；**带上该 cookie 请求 `/` → `200`（28029 字节完整 SPA HTML）**。
  而 `runBootGate`（vendor-build）与壳的 `waitReady`（host）都只认 `if (res.ok)`，**因此对任何
  0.1.5+ 的树都会永远探不到就绪**——症状与原始事故完全一致。第一轮只加了「token 感知的 URL 提取」，
  拿得到 URL 但没人能验证它，**换票这一跳没解决**。
  **已修复并热更新**：新增 `probeHostReady()`（host.mjs）走上完整的 303→接 cookie→200 握手，
  `runBootGate` 改用它（门禁起的是用完即杀的宿主，可以消费 token）；**壳的 `waitReady` 改成
  「服务器回了任何 HTTP 响应即就绪」**，把带 token 的 URL 原样交给窗口（窗口有真正的 cookie jar 会
  自己走完换票），**避免探测先把一次性 token 消费掉**。`redirect:'manual'` 也一并加上——默认跟随
  重定向正是丢 `Set-Cookie` 的那一步。
  **实测回归**：拿真实的 0.1.5-rc.2 事故树跑修好的门禁，**从「90 秒超时失败」变为「5.8 秒 PASS」**
  （`ok=true`，返回带 token 的 URL）。
- **【新增】`src/junction-safe.mjs` — junction 场安全删除**。`$DSH_HOME\profiles\node_modules` 有
  **199 个 junction** 指向 `resources\vendor\profile\node_modules\*`（含整个 `@deepseek-ai`）。实测
  **Node 的 `fs.rmSync(recursive)` 不跟随 junction**（最小复现：目标 3 文件，删后仍 3），但 **Windows
  的 `rmdir /s /q` 与 `del /s /q` 会跟随**。观测到的损坏形态极具辨识度：暂存树里 **240 个
  `@deepseek-ai/*` 包被掏空成空目录、`package.json` 全没**（11000 → 4000 文件）——**「目录还在、
  文件全没」正是 `del /s /q` 的特征**，一次经 `@deepseek-ai` 那条 junction 的删除就能一次性掏空全部
  **breach 已拆**：门禁 `finally` 与壳启动都改走 `safeRemoveTree()`（逐个 unlink 链接本身，绝不递归进
  目标）；新增 `cleanStaleBootGateHomes()` 在壳启动时收掉上次没走完 `finally` 的隔离目录，判年龄用
  **birthtime 而非 mtime**（内容一变 mtime 就刷新，会把正在跑的门禁误判成遗留）。
  **实测印证**：修好后跑一次真门禁，收尾报告 `解开 482 个 junction（未进入其目标）`
  ——**那个临时 HOME 里确实有 482 个指向被测树的 junction**，规模比原先估计的还大。
  **已热更新**（备份 `app.asar.bak-0.4.6-junction`）。
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
