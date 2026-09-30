# dsh-desktop-ui — 桌面壳设置分区（客户端插件）

**这是什么**：一个纯客户端 DSH 插件，往 DSH 自带设置面板里注册两个分区——「桌面」（自启 / 托盘 / 工作区 / 状态 / 更新按钮）与「个性化」（壁纸、亮度、模糊、四种遮罩、左侧栏背景），并注入一批皮肤 CSS（自动隐藏滚动条、轮次标记轨、遮罩层、左侧栏背景）。

**它现在还能怎么用**：它只跟 **dshdt 壳的 admin API**（`http://127.0.0.1:25439`）对话，**本身不实现任何后端能力**。所以：

| 场景 | 结论 |
|---|---|
| 壳（dshdt，含自建 DSH + 本壳）还在跑 | 照常可用，见 [装进自建 DSH](#装进自建-dsh017) |
| 换成官方 DSH 桌面端（0.2+） | 两个分区**能出现**，但**每个按钮都会失败**——官方端没有这套 admin API，见 [⚠️ 耦合与限制](#-耦合与限制最重要) |
| 想改嫁到别的后端 | 先看契约表，再按「要复用需要改什么」逐项对齐；皮肤部分是唯一与后端无关的资产 |

文件构成：

| 文件 | 侧 | 内容 |
|---|---|---|
| [lib/client.js](lib/client.js) | 浏览器（`.dsh.client`） | 全部界面、全部 admin 调用、全部注入 CSS（约 45 KB） |
| [lib/index.js](lib/index.js) | 宿主 | **空实现**（`export function apply() {}`），只为让 modules 插件看到 `dsh.client` 元数据 |
| [package.json](package.json) | — | `dsh.client.inject` 四项官方依赖、`platform: "web"`、`private: true`（未发布 npm） |

> 它不注册 settings 命名空间：`settings.yaml` 里**没有**本插件的段。桌面那些开关存在**壳的** `%LOCALAPPDATA%\DSHDesktop\settings.json`（Windows）里，由 admin API 读写。

## 装进官方 DSH 桌面端（0.2+）

> ⚠️ **先分清 profile**：官方桌面端启动的是 **`desktop`** profile（`official-shell/app-lib/main.js`、`dsh-desktop-host/lib/index.js`；本机 GUI 端口 19387，其 `node_modules` 里有官方装的 `dsh-plugin-wallpaper-engine`），而 dshdt 壳用 **`web`**。装错 profile 等于没装。

| 项 | 位置 / 做法 |
|---|---|
| 插件位 | `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-desktop-ui\`（即 `$DSH_HOME/profiles/desktop/node_modules/`），目录内容 = 本目录的 `package.json` + `lib/` |
| 挂载 | `$DSH_HOME/profiles/desktop/cordis.patch.yml` 里加一条 `- insert:` |
| 本体配置 | `$DSH_HOME/settings.yaml` 是**本体**配置面（模型、主题等），**与本插件无关**（host 半身是空的，不注册命名空间） |
| 官方 CLI 安装 | 官方端把这个 profile 当**保留 profile** 独占管理：CLI 里有硬判据，启动类命令会报 `error: profile "desktop" is managed exclusively by the Electron application`（0.2.0-rc.2 的 `app.asar` 内实测原文）；但同一份 CLI 的帮助文本又提示「先启动一次 DeepSeek Desktop 初始化 profile、完全退出后再跑 `dsh plugin --profile desktop`」⇒ **插件管理**这条路是给官方端留的（官方壳自己以 `manageDesktopProfile: true` 调 CLI）。本次**未实测**安装；本包 `private: true` 且未发 npm，**不能** `dsh plugin add dsh-desktop-ui`，稳妥做法仍是手工拷贝 |
| 装了也没用 | 官方端没有本插件要的 admin API（`127.0.0.1:25439`），两个分区能出现但按钮全失败 —— 见末尾「耦合与限制」 |

```powershell
# 1) 拷到官方桌面端的 profile 插件位（desktop profile）
$dst = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-desktop-ui"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item -Force .\plugins\dsh-desktop-ui\package.json $dst\
Copy-Item -Recurse -Force .\plugins\dsh-desktop-ui\lib $dst\
```

```yaml
# 2) $DSH_HOME/profiles/desktop/cordis.patch.yml 追加（文件末尾是 [] 时要替换它，别追加第二个 YAML 节点）
- insert:
    - id: dsh-desktop-ui
      name: dsh-desktop-ui
```

### 改完客户端插件怎么生效

| 环境 | 方式 |
|---|---|
| dshdt 壳里 | 当前源码**没有**把重载暴露成路由：`reloadWindow` 只在 [main.mjs](../../desktop-electron/src/main.mjs) 里装配（`reloadIgnoringCache`），[admin.mjs](../../desktop-electron/src/admin.mjs) 里找不到对应路由 ⇒ 改完客户端插件要**重启应用**（打包态菜单被置空、DevTools 快捷键被屏蔽，Ctrl+R 是否仍可用**未验证**） |
| 官方桌面端 / 自建 DSH | 重启应用或重新加载窗口（官方端是否提供重载入口**未验证**）；补丁层热加载、插件源码不热加载（见 [../dsh-auto-approval/README.md](../dsh-auto-approval/README.md) 的同一结论） |

**未验证**：官方桌面端 0.2+ 对 `cordis.patch.yml` 的解析是否与本仓库壳一致；官方端是否会在启动时重写/清理 profile 目录；本地目录坐标（`file:` / `link:`）能否被 `dsh plugin add` 接受。（`$DSH_HOME` 与 profile 名本轮已实测：官方端用 `$DSH_HOME\profiles\desktop`，dshdt 用 `web`，见本节开头。）

## 装进自建 DSH（0.1.7+）

不需要 pnpm：手工拷贝目录 + 补丁层挂载即可（壳自己就是这么做的：整目录 `cpSync` 到 profile 插件位，再写 `insert` 行）。

```powershell
$dst = "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-desktop-ui"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item -Force .\plugins\dsh-desktop-ui\package.json $dst\
Copy-Item -Recurse -Force .\plugins\dsh-desktop-ui\lib $dst\
```

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml（profile 名按你启动的那个：dshdt 是 web，官方桌面端是 desktop）
- insert:
    - id: dsh-desktop-ui
      name: dsh-desktop-ui
```

要点：

| 事项 | 说明 |
|---|---|
| 改哪个文件 | 只改 `cordis.patch.yml`。`cordis.yml` 是空的入口列表，模板注释明确要求别动它 |
| `[]` 陷阱 | 模板结尾是 `[]` 时必须**替换**该 token，写成两个 YAML 节点会让宿主启动即抛 YAMLException（判据在 [profile-mount.mjs](../../desktop-electron/src/profile-mount.mjs)） |
| 另一种挂法 | 壳是把 `$DSH_HOME/desktop.patch.yml` 经 `dsh web --patch <file>` 传给宿主的（[host.mjs](../../desktop-electron/src/host.mjs)）；自建时可以照做：`dsh web --patch .\desktop.patch.yml` |
| 只挂客户端半身行不行 | 必须有 `insert` 行：宿主侧要先装载本包（空 `apply`），`dsh.client` 元数据才会被扫描并供给浏览器（见 [desktop.patch.yml](../../desktop-electron/src/desktop.patch.yml) 的注释） |
| `bundles` 要不要加 | 不需要。profile 的 `dsh.profile.bundles` 只列基础包；`dsh-auto-approval` / `dsh-market` 同样只靠 `insert` 挂载 |
| settings 命名空间 | **没有**。`settings.yaml` 里不需要、也不会有 `dsh-desktop-ui:` 段 |

装好后打开 DSH 设置面板，应能在侧栏看到「个性化」与「桌面」两项。看不到就是装载失败：先看 `$DSH_HOME/logs/*` 与宿主日志里的 `Failed to load plugins`。

## 配置项（都写在壳的 settings.json 里）

Windows 路径：`%LOCALAPPDATA%\DSHDesktop\settings.json`（`SETTINGS_FILE`，见 [main.mjs](../../desktop-electron/src/main.mjs)）。默认值与钳制规则来自 [admin.mjs](../../desktop-electron/src/admin.mjs) 与 [skin-settings.mjs](../../desktop-electron/src/skin-settings.mjs)。

| 键 | 界面项 | 取值 / 默认 | 写入端点 |
|---|---|---|---|
| `backgroundImage` | 背景图片 | 绝对路径；未设置 = 无 | `POST /api/background`（清除传 `""`） |
| `bgBrightness` | 背景亮度 | 0.2~2，默认 1 | `POST /api/settings` |
| `bgBlur` | 背景模糊 | 0~40 px，默认 0 | `POST /api/settings` |
| `railMaskOpacity` | 跳转轨道遮罩 | 0~1，默认 0.35 | `POST /api/settings` |
| `conversationMaskOpacity` | 对话区遮罩 | 0~1，默认 0.25 | `POST /api/settings` |
| `fullscreenMaskOpacity` | 右侧栏全屏遮罩 | 0~1，默认 0.8 | `POST /api/settings` |
| `sidebarBgMode` | 左侧栏背景模式 | `extend`（默认）/ `own` | `POST /api/settings` |
| `sidebarBgImage` | 左侧栏图片 | 绝对路径；仅 `own` 模式使用 | `POST /api/sidebar-background` |
| `sidebarOpacity` | 左侧栏遮罩 | 0~1，默认 0.45；**渲染值 = max(它, 对话区遮罩)**，由客户端写 CSS 变量时取 max | `POST /api/settings` |
| `autostart` | 开机自启 | 布尔，默认 false | `POST /api/autostart` |
| `minimizeToTray` | 关闭窗口时最小化到托盘 | 布尔，默认 true（`!== false`） | `POST /api/settings` |
| `workspace` | Agent 工作区 | 绝对路径，默认 `%USERPROFILE%\DSH-Workspace`（或 `DSH_WS`） | `POST /api/workspace` |

> `/api/settings` 的布尔白名单里还有 `warnedPs7`、四个 `*MaskEnabled` 与 `glassChat*` / `glassInput*`——本插件界面没有这些项，它们属于壳自带的设置页（`settings.html`）。

## 实现契约：壳 admin API

基址写死在 [lib/client.js](lib/client.js) 第 15 行：`const ADMIN = "http://127.0.0.1:25439"`。全部调用走 `post()` / 直接 `fetch`。

### 端点表（本插件用到的全部）

| 方法 | 路径 | 请求体 | 响应（用到 / 全量） | 用途 | 客户端超时 |
|---|---|---|---|---|---|
| GET | `/api/status` | — | 见下方「status 快照」 | 两个分区的唯一数据源；分区挂载期间每 5 秒轮询一次 | 3 s |
| POST | `/api/settings` | `{sidebarBgMode\|bgBrightness\|bgBlur\|railMaskOpacity\|conversationMaskOpacity\|fullscreenMaskOpacity\|sidebarOpacity\|minimizeToTray}` 任一子集 | `{ok:true, settings}` | 写外观与托盘开关；带 `bgBrightness`/`bgBlur` 时壳会重绘壁纸 | 4 s（默认） |
| POST | `/api/pick-background` | `{}` | `{ok:true, path}` / `{ok:true, canceled:true}` / `{ok:false, error}` | 弹系统选图框并直接落为背景 | 无（`timeoutMs=0`） |
| POST | `/api/background` | `{path:""}` 清除 / `{path:"绝对路径"}` 设置 | 200 `{ok:true, cleared:true}` 或 `{ok:true, path}`；失败 400 `{ok:false, error}` | 清除背景图 | 4 s |
| POST | `/api/pick-sidebar-background` | `{}` | 同 `pick-background` | 选左侧栏独立图片 | 无 |
| POST | `/api/sidebar-background` | `{path:""}`（清除只摘路径，不改模式） | `{ok:true, cleared:true}` / `{ok:true, path}` / 400 `{ok:false, error}` | 清除左侧栏图片 | 4 s |
| POST | `/api/autostart` | `{on:boolean}` | `{ok:true, autostart}` | 开机自启 | 4 s |
| POST | `/api/pick-directory` | `{}` | `{ok:true, path, applied:true}` / `{ok:true, canceled:true}` / `{ok:false, error}` | 选目录并一步落地工作区（`applied=true` 时不必再点「应用」） | 无 |
| POST | `/api/workspace` | `{path:"绝对路径"}` | 200 `{ok:true, workspace}`；空/相对路径 400 `{ok:false, error:"需要绝对路径"}` | 应用工作区 | 4 s |
| POST | `/api/dsh/check` | `{}` | `{ok:true, …dshUpdateSnapshot}` / `{ok:false, error}` | 联网查 DSH 新版本 | 15 s |
| POST | `/api/dsh/update` | `{allowUnsafeJump:boolean}` | `{ok:true, …}` / `{ok:false, error}` | 启动分钟级构建（立即返回，进度靠 `/api/status` 轮询） | 15 s |
| POST | `/api/dsh/apply` | `{}` | `{ok:true, …}` | 写标记、重启应用完成换树 | 4 s（不等结果） |
| GET | `/api/repo-update/state` | — | `{ok:true, shell:{pending, files, canSwap, reason}, …}`（不联网） | 「换壳并重启」按钮可用性；404 → 认定为旧壳 | 3 s |
| POST | `/api/repo-update/check` | `{}` | `{ok:true, coords, summary, components, message}` / `{ok:false, error, coords}` | 与仓库清单比对（只读，不落盘） | 30 s |
| POST | `/api/repo-update/apply` | `{}` | `{ok, coords, written, removed, restarted, shellPending, shellCanSwap, shellReason, results, failed:[{id,error}], message}` | 增量补文件（自带插件 / 补丁层 / 市场目录 / 壳源码暂存） | 120 s |
| POST | `/api/repo-update/shell` | `{}` | `{ok:true, restarting:true, helperPid, written, staged, swapLog, message}` / `{ok:false, error}`；成功后应用随即退出 | 换 `app.asar` 并重启（助手换完先 `--smoke` 校验，不过自动回滚） | 15 s |
| POST | `/api/open-data-dir` | `{}` | `{ok:true}` | 打开数据目录 | 4 s |
| POST | `/api/focus` | `{}` | `{ok:true, note}` / `{ok:false, note}` | 回到会话（唤起/重建窗口） | 4 s |
| POST | `/api/quit` | `{}` | `{ok:true}`（响应送达后约 100 ms 退出，3 s 兜底） | 退出应用 | 4 s |
| POST | `/api/open-settings-document` | `{}` | `{ok:true, …}` / `{ok:false, error}` | 接管官方「打开配置文件」按钮，改走壳打开 `$DSH_HOME/settings.yaml` | 5 s（直连 `fetch`，不走 `post()`） |
| GET | `/sidebar-image` | query 被服务端忽略 | 图片字节；无图/文件不存在 → 404 `{ok:false, error}` | 作为左侧栏 `background-image` 的 URL；客户端额外拼 `?p=<路径>&t=<mtime>` 破缓存 | 浏览器加载 |

壳里存在、但本插件不调用：`GET /health`、`GET /api/dsh/status`、`GET /api/market/catalog`、`GET /api/market/preflight`、`POST /api/market/install`、`POST /api/market/open-download`、`POST /api/restart-host`、`GET /api/logs`、`POST /api/diag/*`、`GET /bg-image?t=<mtime>`（壁纸本体，由壳注入的 CSS 用）、`GET /settings.html`。

### status 快照（client.js 真正读的字段）

`dshUpdate{phase, hint, npmOk, needsConfirm, hasUpdate, pending, jump.reason, current, target, progress{percent,label}, elapsedMs, compat.blocked}`、`backgroundImage`、`bgBrightness`、`bgBlur`、`railMaskOpacity`、`conversationMaskOpacity`、`fullscreenMaskOpacity`、`sidebarBgMode`、`sidebarBgImage`、`sidebarBgImageVersion`、`sidebarOpacity`、`autostart`、`minimizeToTray`、`version`、`electron`、`node`、`home`、`ws`、`uptimeSec`、`restarts`。

> 更新按钮的可用性**只由这份快照推导**（`canCheck` / `canUpdate` / `canApply` / `blocked`），客户端不另存状态。快照里还有 `skin`、`trayUsable`、`dshBin`、`pwsh`、`webPort` 等字段，本插件没用到。

### CORS 与固定端口

- admin 服务只监听 `127.0.0.1`，首选端口 `25439`（`ADMIN_PORT`）。
- CORS 只对 `Origin` 匹配 `^http://127.0.0.1(:\d+)?$` 的请求回 `Access-Control-Allow-Origin`；`OPTIONS` 预检回 204。DSH 页面 origin 是 `http://127.0.0.1:<随机 webPort>`，所以当前形态能通；`Content-Type: application/json` 必然触发预检，这条 CORS 是硬前提。
- 端口被占用时壳回退到系统分配端口（`listenAdmin` 的 `EADDRINUSE` 分支），而客户端**写死 25439** ⇒ 面板永远停在「正在连接桌面壳…」；壳的日志里有一句明确写着这个后果。

### 壳不在时的降级表现

| 情形 | 界面表现 |
|---|---|
| 壳没起 / admin 不通 | 两个分区都停在「正在连接桌面壳…（若持续显示，请从托盘重新启动应用）」 |
| 壳在，但端点 404（旧壳） | `post()` 返回 `{ok:false, error:"当前壳版本没有这个接口（旧壳，需要先换一次壳）"}`；多数调用点把非 ok 一律显示成「操作失败（壳未响应？）」 |
| `/api/repo-update/state` 404 | 仓库更新一栏改成「当前壳版本不支持仓库更新（旧壳）…」，「换壳并重启」保持禁用 |
| **完全**没有壳 | 皮肤 CSS 照旧注入，用样式表 `:root` 里的默认值（轨道 0.35 / 对话区 0.25 / 全屏 0.8 / 左侧栏 0.45 / 左侧栏图片 `none`）；设置面板依旧渲染，但所有读写失效 |
| 点击「打开配置文件」失败 | 弹窗「桌面壳未响应，无法打开配置文件」 |

> 皮肤变量写入时机：插件装载时取一次 `/api/status`，此外只在「桌面」分区被渲染时随 5 秒轮询更新（`applySkinVars` 挂在 `DesktopSection` 的 effect 上）。

## ⚠️ 耦合与限制（最重要）

**一句话**：这是**壳的配套插件**，不是通用外观插件。它硬依赖 dshdt 壳的 `http://127.0.0.1:25439` admin API，**不能原样装进官方桌面端就跑起来**。

| # | 耦合点 | 依据 / 后果 |
|---|---|---|
| 1 | 硬编码基址 `http://127.0.0.1:25439`，无发现机制 | [lib/client.js](lib/client.js) 第 15 行；壳回退端口、或换别的后端即断联 |
| 2 | 官方桌面端**没有**这套 admin API | [official-shell/app-lib/main.js](../../official-shell/app-lib/main.js) 里没有 25439 上的 HTTP 服务（只有 `--inspect` 端口）⇒ 端点全部不存在，按钮全失败 |
| 3 | 左侧栏图片 URL **也**写死 25439 | [lib/client.js](lib/client.js) 第 138 行拼 `url("${ADMIN}/sidebar-image…")`；换后端要改两处 |
| 4 | 壁纸的**画面**不归本插件 | 背景图 / 亮度 / 模糊由壳注入 CSS（[bg-css.mjs](../../desktop-electron/src/bg-css.mjs) 的 `body::before` + `GET /bg-image?t=`，经 `insertCSS`）；没有壳自己实现注入，这三项写了也没画面 |
| 5 | 路径与扩展名校验在壳侧 | `BG_ALLOWED_EXT`（jpg/jpeg/png/webp/gif/bmp/avif/ico）；插件不做校验，只读回显 |
| 6 | 皮肤 CSS 依赖 DSH 客户端的 DOM 细节 | 类名后缀 `_frame`/`_marks`/`_centerCol`/`_scroll`/`_column`/`_body`/`_scrollBody`/`_sidebarCol`、属性 `data-sidebar-right-panel`、变量 `--dsh-chat-content-width` / `--dsw-*`；DSH 改结构即静默失效（代码注释记着 0.1.7-rc.1 那次「对话整块不可见」） |
| 7 | 依赖官方原语与种子模块 | `@deepseek-ai/dsh-client-ui-primitives`（`Switch` / `DisclosureRow`）+ `dsh.client.inject` 四项；目标 DSH 缺任何一个就是装载期 ReferenceError → 整页 `Failed to load plugins` |
| 8 | 「打开配置文件」是**文案匹配**的点击拦截 | 匹配 `打开配置文件` / `Open configuration file`（`settings.action` 插槽禁止同 id 注册）；文案或语言一变即失效，且不报错 |
| 9 | 分区 id 固定 | `desktop`（order 100）、`personalize`（order 90）；目标端已有同 id section 是否冲突**未验证** |
| 10 | 「仓库功能更新」的清单必须与文件同步 | 插件部分在 [components.json](../../desktop-electron/components.json) 里的 `repoPath` 现指 `plugins/dsh-desktop-ui/…`（2026-09-30 摘出时由 [gen-components.mjs](../../desktop-electron/scripts/gen-components.mjs) 重算过）；改了插件不重算清单，壳按旧摘要取文件就会校验失败 |
| 11 | 开发态的插件来源 | [main.mjs](../../desktop-electron/src/main.mjs) 的 `PACKAGES_DIR` / `pluginSourceDir()` 在非打包态读仓库顶层 `../plugins/<name>`（打包态仍读包内 `vendor/profile/node_modules`） |
| 12 | 不依赖壳注入的全局变量 | 插件不读任何壳注入的 `window.*`；`window.__DSH_BOOT__` 是**宿主**（`dsh web`）注入的启动信息，与壳无关 |

### 要复用需要改什么

| 目标 | 改哪里 | 说明 |
|---|---|---|
| 换 admin 基址 | [lib/client.js](lib/client.js) 第 15 行 `const ADMIN = …`，以及第 138 行的 `/sidebar-image` URL | 两处；改完仍要求目标后端**同名端点、同形状响应** |
| 只保留皮肤 | 复用 `apply()` 里第二个 `<style>` 与 `applySkinVars()` | 皮肤不依赖 admin；但没有后端就只能吃样式表默认值，且左侧栏独立图片无图可加载 |
| 砍掉不需要的能力 | 删对应按钮 / 行 | 每个能力是独立端点，缺一个只影响那一项，其余照常 |
| 在无壳环境里跑通「桌面」分区 | 至少实现 `GET /api/status` | 面板全靠它；缺它则永远停在「正在连接桌面壳…」 |
| 让外观项真正生效 | 实现 `POST /api/settings` + 自己注入壁纸 CSS | 见耦合点 4；`sidebarOpacity` 的 max 钳制在客户端，后端只需存原值 |
| 目标后端没有 404 语义 | 改 `post()` 的错误映射 | 目前 404 被当作「旧壳」，其它非 2xx 显示 `壳返回 HTTP <code>`，网络异常显示「壳未响应」 |
| 目标页面不是 `http://127.0.0.1:<port>` 源 | 目标后端放宽 CORS | 当前白名单只放 `127.0.0.1`，`localhost` / `file://` / 自定义协议都会被浏览器拦掉 |

## 相关文件

| 文件 | 与本插件的关系 |
|---|---|
| [../../desktop-electron/src/admin.mjs](../../desktop-electron/src/admin.mjs) | admin API 全部端点（契约的唯一权威） |
| [../../desktop-electron/src/main.mjs](../../desktop-electron/src/main.mjs) | `statusPayload()` 形状、`ADMIN_PORT`、各 action 的实现与 settings.json 读写 |
| [../../desktop-electron/src/skin-settings.mjs](../../desktop-electron/src/skin-settings.mjs) | 遮罩默认值、旧设置迁移、`skin` 快照 |
| [../../desktop-electron/src/bg-css.mjs](../../desktop-electron/src/bg-css.mjs) | 壁纸 CSS 注入与亮度/模糊钳制 |
| [../../desktop-electron/src/desktop.patch.yml](../../desktop-electron/src/desktop.patch.yml) | 壳把本插件挂进宿主的那条 `insert` |
| [../../desktop-electron/src/profile-mount.mjs](../../desktop-electron/src/profile-mount.mjs) | 补丁层写入 / 自愈规则（`[]` 陷阱的判据） |
| [../dsh-auto-approval/README.md](../dsh-auto-approval/README.md) | 同批移出的 Host 插件，文档风格与「生效方式」口径一致 |

许可：[MIT](../../LICENSE)。
