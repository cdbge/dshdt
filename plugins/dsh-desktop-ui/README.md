# dsh-desktop-ui — 桌面壳设置分区（客户端插件）

**这是什么**：纯客户端 DSH 插件，往设置面板注册两个分区——「桌面」（自启 / 托盘 / 工作区 / 状态 / 更新按钮）与「个性化」（壁纸、亮度、模糊、四种遮罩、左侧栏背景），并注入皮肤 CSS（自动隐藏滚动条、轮次标记轨、遮罩层、左侧栏背景）。它只跟 dshdt 壳的 admin API（`http://127.0.0.1:25439`）对话，本身不实现任何后端能力。

| 场景 | 结论 |
|---|---|
| 壳（dshdt，含自建 DSH + 本壳）在跑 | 照常可用，见[安装](#安装) |
| 官方 DSH 桌面端（0.2+） | 两个分区能出现，每个按钮都失败：官方端没有这套 admin API，见[耦合与限制](#️-耦合与限制最重要) |
| 改嫁别的后端 | 先看契约表，再按「要复用需要改什么」对齐；皮肤是唯一与后端无关的资产 |

不注册 settings 命名空间：`settings.yaml` 里没有本插件的段；桌面开关存在壳的 `%LOCALAPPDATA%\DSHDesktop\settings.json`（Windows），由 admin API 读写。
| 文件 | 内容 |
|---|---|
| [lib/client.js](lib/client.js)（浏览器，`.dsh.client`） | 全部界面、全部 admin 调用、全部注入 CSS（约 45 KB） |
| [lib/index.js](lib/index.js)（宿主） | **空实现**（`export function apply() {}`），只为让 modules 插件看到 `dsh.client` 元数据 |
| [package.json](package.json) | `dsh.client.inject` 四项官方依赖、`platform: "web"`、`private: true`（未发布 npm） |
| [../../desktop-electron/src/admin.mjs](../../desktop-electron/src/admin.mjs) | admin API 全部端点（契约的唯一权威） |
| [../../desktop-electron/src/main.mjs](../../desktop-electron/src/main.mjs) | `statusPayload()` 形状、`ADMIN_PORT`、各 action 实现与 settings.json 读写 |
| [../../desktop-electron/src/skin-settings.mjs](../../desktop-electron/src/skin-settings.mjs) | 遮罩默认值、旧设置迁移、`skin` 快照 |
| [../../desktop-electron/src/bg-css.mjs](../../desktop-electron/src/bg-css.mjs) | 壁纸 CSS 注入与亮度/模糊钳制 |
| [../../desktop-electron/src/desktop.patch.yml](../../desktop-electron/src/desktop.patch.yml) | 把本插件挂进宿主的那条 `insert` |
| [../../desktop-electron/src/profile-mount.mjs](../../desktop-electron/src/profile-mount.mjs) | 补丁层写入 / 自愈规则（`[]` 陷阱的判据） |

## 安装

两个 profile 都走同两步：拷 `package.json` + `lib/` 到 profile 插件位，再写一条 `insert`。不用 pnpm。

| 项 | 官方 DSH 桌面端（0.2+，profile `desktop`，GUI 端口 19387） | 自建 DSH（0.1.7+，profile `web`） |
|---|---|---|
| 插件位 | `$DSH_HOME/profiles/desktop/node_modules/dsh-desktop-ui/` | `$DSH_HOME/profiles/web/node_modules/dsh-desktop-ui/` |
| 挂载文件 | `$DSH_HOME/profiles/desktop/cordis.patch.yml` | `$DSH_HOME/profiles/web/cordis.patch.yml` |
| 官方 CLI 装 | profile 由官方端独占管理，启动类命令报 `error: profile "desktop" is managed exclusively by the Electron application`；`dsh plugin --profile desktop` 留给官方壳（它以 `manageDesktopProfile: true` 调 CLI）。本包 `private: true` 且未发 npm，**不能** `dsh plugin add dsh-desktop-ui` | 不可用 |
| 完事效果 | 分区能出现，按钮全失败（无 admin API） | 分区与功能都可用 |
| 只挂客户端半身行不行 | 不行：宿主侧要先装载本包（空 `apply`），`dsh.client` 元数据才会被扫描并供给浏览器 | 同 |
| `bundles` 要不要加 | 不需要；profile 的 `dsh.profile.bundles` 只列基础包 | 同 |
| settings 命名空间 | **没有**，`settings.yaml` 里不会有 `dsh-desktop-ui:` 段 | 同 |
| 改完怎么生效 | 客户端插件没有重载路由 ⇒ **重启应用**（打包态菜单置空、DevTools 快捷键屏蔽，Ctrl+R 是否仍可用**未验证**） | 重启应用或重新加载窗口；补丁层热加载，插件源码不热加载 |
| 装完自检 | 设置面板侧栏应出现「个性化」与「桌面」；看不到就是装载失败，查 `$DSH_HOME/logs/*` 与宿主日志里的 `Failed to load plugins` | 同 |

`$DSH_HOME/settings.yaml` 是本体配置面（模型、主题等），与本插件无关（host 半身是空的）。只改 `cordis.patch.yml`；`cordis.yml` 是空的入口列表，别动。结尾是 `[]` 时必须**替换**该 token，两个 YAML 节点会让宿主启动即抛 YAMLException。壳把 `$DSH_HOME/desktop.patch.yml` 经 `dsh web --patch <file>` 传给宿主，自建可照做：`dsh web --patch .\desktop.patch.yml`。

```powershell
# 拷到 profile 插件位；desktop / web 二选一
$dst = "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-desktop-ui"   # 官方端改成 profiles\desktop
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item -Force .\plugins\dsh-desktop-ui\package.json $dst\
Copy-Item -Recurse -Force .\plugins\dsh-desktop-ui\lib $dst\
```

```yaml
# 追加到 $DSH_HOME/profiles/<profile>/cordis.patch.yml
# 文件末尾是 [] 时要替换它，别追加第二个 YAML 节点
- insert:
    - id: dsh-desktop-ui
      name: dsh-desktop-ui
```

**未验证**（结论）：官方端 0.2+ 对 `cordis.patch.yml` 的解析与壳是否一致；官方端是否在启动时重写或清理 profile 目录；本地目录坐标（`file:` / `link:`）能否被 `dsh plugin add` 接受；官方端是否提供重载入口。

## 配置项（都写在壳的 settings.json 里）

Windows 路径：`%LOCALAPPDATA%\DSHDesktop\settings.json`（`SETTINGS_FILE`）。

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
| `sidebarOpacity` | 左侧栏遮罩 | 0~1，默认 0.45；**渲染值 = max(它, 对话区遮罩)** | `POST /api/settings` |
| `autostart` | 开机自启 | 布尔，默认 false | `POST /api/autostart` |
| `minimizeToTray` | 关闭窗口时最小化到托盘 | 布尔，默认 true（`!== false`） | `POST /api/settings` |
| `workspace` | Agent 工作区 | 绝对路径，默认 `%USERPROFILE%\DSH-Workspace`（或 `DSH_WS`） | `POST /api/workspace` |

`/api/settings` 的布尔白名单里还有 `warnedPs7`、四个 `*MaskEnabled` 与 `glassChat*` / `glassInput*`，属于壳自带设置页，本插件界面没有这些项。

## 实现契约：壳 admin API

基址写死在 [lib/client.js](lib/client.js) 第 15 行：`const ADMIN = "http://127.0.0.1:25439"`。全部调用走 `post()` / 直接 `fetch`。
| 端点（本插件用到的全部） | 请求体 | 响应（用到 / 全量） | 用途 | 超时 |
|---|---|---|---|---|
| `GET /api/status` | — | 见「status 快照」 | 两个分区的唯一数据源；挂载期间每 5 秒轮询 | 3 s |
| `POST /api/settings` | `{sidebarBgMode\|bgBrightness\|bgBlur\|railMaskOpacity\|conversationMaskOpacity\|fullscreenMaskOpacity\|sidebarOpacity\|minimizeToTray}` 任一子集 | `{ok:true, settings}` | 写外观与托盘开关；带 `bgBrightness`/`bgBlur` 时壳重绘壁纸 | 4 s（默认） |
| `POST /api/pick-background` | `{}` | `{ok:true, path}` / `{ok:true, canceled:true}` / `{ok:false, error}` | 弹系统选图框并直接落为背景 | 无（`timeoutMs=0`） |
| `POST /api/background` | `{path:""}` 清除 / `{path:"绝对路径"}` 设置 | 200 `{ok:true, cleared:true}` 或 `{ok:true, path}`；失败 400 `{ok:false, error}` | 清除背景图 | 4 s |
| `POST /api/pick-sidebar-background` | `{}` | 同 `pick-background` | 选左侧栏独立图片 | 无 |
| `POST /api/sidebar-background` | `{path:""}`（清除只摘路径，不改模式） | `{ok:true, cleared:true}` / `{ok:true, path}` / 400 `{ok:false, error}` | 清除左侧栏图片 | 4 s |
| `POST /api/autostart` | `{on:boolean}` | `{ok:true, autostart}` | 开机自启 | 4 s |
| `POST /api/pick-directory` | `{}` | `{ok:true, path, applied:true}` / `{ok:true, canceled:true}` / `{ok:false, error}` | 选目录并一步落地工作区（`applied=true` 时不必再点「应用」） | 无 |
| `POST /api/workspace` | `{path:"绝对路径"}` | 200 `{ok:true, workspace}`；空/相对路径 400 `{ok:false, error:"需要绝对路径"}` | 应用工作区 | 4 s |
| `POST /api/dsh/check` | `{}` | `{ok:true, …dshUpdateSnapshot}` / `{ok:false, error}` | 联网查 DSH 新版本 | 15 s |
| `POST /api/dsh/update` | `{allowUnsafeJump:boolean}` | `{ok:true, …}` / `{ok:false, error}` | 启动分钟级构建（立即返回，进度靠 `/api/status` 轮询） | 15 s |
| `POST /api/dsh/apply` | `{}` | `{ok:true, …}` | 写标记、重启应用完成换树 | 4 s（不等结果） |
| `GET /api/repo-update/state` | — | `{ok:true, shell:{pending, files, canSwap, reason}, …}`（不联网） | 「换壳并重启」按钮可用性；404 → 认定为旧壳 | 3 s |
| `POST /api/repo-update/check` | `{}` | `{ok:true, coords, summary, components, message}` / `{ok:false, error, coords}` | 与仓库清单比对（只读，不落盘） | 30 s |
| `POST /api/repo-update/apply` | `{}` | `{ok, coords, written, removed, restarted, shellPending, shellCanSwap, shellReason, results, failed:[{id,error}], message}` | 增量补文件（自带插件 / 补丁层 / 市场目录 / 壳源码暂存） | 120 s |
| `POST /api/repo-update/shell` | `{}` | `{ok:true, restarting:true, helperPid, written, staged, swapLog, message}` / `{ok:false, error}`；成功后应用随即退出 | 换 `app.asar` 并重启（助手换完先 `--smoke` 校验，不过自动回滚） | 15 s |
| `POST /api/open-data-dir` | `{}` | `{ok:true}` | 打开数据目录 | 4 s |
| `POST /api/focus` | `{}` | `{ok:true, note}` / `{ok:false, note}` | 回到会话（唤起/重建窗口） | 4 s |
| `POST /api/quit` | `{}` | `{ok:true}`（响应送达后约 100 ms 退出，3 s 兜底） | 退出应用 | 4 s |
| `POST /api/open-settings-document` | `{}` | `{ok:true, …}` / `{ok:false, error}` | 接管官方「打开配置文件」按钮，改走壳打开 `$DSH_HOME/settings.yaml` | 5 s（直连 `fetch`，不走 `post()`） |
| `GET /sidebar-image` | query 被服务端忽略 | 图片字节；无图/文件不存在 → 404 `{ok:false, error}` | 左侧栏 `background-image` 的 URL；客户端拼 `?p=<路径>&t=<mtime>` 破缓存 | 浏览器加载 |

壳里存在、但本插件不调用：`GET /health`、`GET /api/dsh/status`、`GET /api/market/catalog`、`GET /api/market/preflight`、`POST /api/market/install`、`POST /api/market/open-download`、`POST /api/restart-host`、`GET /api/logs`、`POST /api/diag/*`、`GET /bg-image?t=<mtime>`（壁纸本体，由壳注入的 CSS 用）、`GET /settings.html`。

### status 快照（client.js 真正读的字段）

`dshUpdate{phase, hint, npmOk, needsConfirm, hasUpdate, pending, jump.reason, current, target, progress{percent,label}, elapsedMs, compat.blocked}`、`backgroundImage`、`bgBrightness`、`bgBlur`、`railMaskOpacity`、`conversationMaskOpacity`、`fullscreenMaskOpacity`、`sidebarBgMode`、`sidebarBgImage`、`sidebarBgImageVersion`、`sidebarOpacity`、`autostart`、`minimizeToTray`、`version`、`electron`、`node`、`home`、`ws`、`uptimeSec`、`restarts`。更新按钮的可用性只由这份快照推导（`canCheck` / `canUpdate` / `canApply` / `blocked`），客户端不另存状态。快照里还有 `skin`、`trayUsable`、`dshBin`、`pwsh`、`webPort` 等字段，本插件没用到。皮肤变量写入时机：插件装载时取一次 `/api/status`，此外只在「桌面」分区被渲染时随 5 秒轮询更新（`applySkinVars` 挂在 `DesktopSection` 的 effect 上）。

### CORS 与固定端口

- admin 服务只监听 `127.0.0.1`，首选端口 `25439`（`ADMIN_PORT`）。
- CORS 只对 `Origin` 匹配 `^http://127.0.0.1(:\d+)?$` 的请求回 `Access-Control-Allow-Origin`；`OPTIONS` 预检回 204。DSH 页面 origin 是 `http://127.0.0.1:<随机 webPort>`，`Content-Type: application/json` 必然触发预检，这条 CORS 是硬前提。
- 端口被占用时壳回退到系统分配端口（`listenAdmin` 的 `EADDRINUSE` 分支），客户端写死 25439 ⇒ 面板永远停在「正在连接桌面壳…」。

### 壳不在时的降级表现

| 情形 | 界面表现 |
|---|---|
| 壳没起 / admin 不通 | 两个分区都停在「正在连接桌面壳…（若持续显示，请从托盘重新启动应用）」 |
| 壳在但端点 404（旧壳） | `post()` 返回 `{ok:false, error:"当前壳版本没有这个接口（旧壳，需要先换一次壳）"}`；多数调用点把非 ok 显示成「操作失败（壳未响应？）」 |
| `/api/repo-update/state` 404 | 仓库更新一栏改成「当前壳版本不支持仓库更新（旧壳）…」，「换壳并重启」保持禁用 |
| **完全**没有壳 | 皮肤 CSS 照旧注入，用样式表 `:root` 默认值（轨道 0.35 / 对话区 0.25 / 全屏 0.8 / 左侧栏 0.45 / 左侧栏图片 `none`）；设置面板仍渲染，但读写全失效 |
| 「打开配置文件」失败 | 弹窗「桌面壳未响应，无法打开配置文件」 |

## ⚠️ 耦合与限制（最重要）

壳的配套插件，不是通用外观插件：硬依赖 dshdt 壳的 `http://127.0.0.1:25439` admin API，不能原样装进官方桌面端就跑起来。

| # | 耦合点 | 后果 |
|---|---|---|
| 1 | 硬编码基址 `http://127.0.0.1:25439`，无发现机制 | [lib/client.js](lib/client.js) 第 15 行；壳回退端口或换后端即断联 |
| 2 | 官方桌面端没有这套 admin API | [official-shell/app-lib/main.js](../../official-shell/app-lib/main.js) 里没有 25439 上的 HTTP 服务（只有 `--inspect` 端口）⇒ 端点全不存在，按钮全失败 |
| 3 | 左侧栏图片 URL 也写死 25439 | [lib/client.js](lib/client.js) 第 138 行 `url("${ADMIN}/sidebar-image…")`；换后端要改两处 |
| 4 | 壁纸画面不归本插件 | 背景图 / 亮度 / 模糊由壳注入 CSS（[bg-css.mjs](../../desktop-electron/src/bg-css.mjs) 的 `body::before` + `GET /bg-image?t=`，经 `insertCSS`）；无壳则这三项无画面 |
| 5 | 路径与扩展名校验在壳侧 | `BG_ALLOWED_EXT`（jpg/jpeg/png/webp/gif/bmp/avif/ico）；插件只读回显 |
| 6 | 皮肤 CSS 依赖 DSH 客户端 DOM 细节 | 类名后缀 `_frame`/`_marks`/`_centerCol`/`_scroll`/`_column`/`_body`/`_scrollBody`/`_sidebarCol`、属性 `data-sidebar-right-panel`、变量 `--dsh-chat-content-width` / `--dsw-*`；DSH 改结构即静默失效 |
| 7 | 依赖官方原语与种子模块 | `@deepseek-ai/dsh-client-ui-primitives`（`Switch` / `DisclosureRow`）+ `dsh.client.inject` 四项；缺任一 → 整页 `Failed to load plugins` |
| 8 | 「打开配置文件」是文案匹配的点击拦截 | 匹配 `打开配置文件` / `Open configuration file`（`settings.action` 插槽禁止同 id 注册）；文案或语言一变即失效且不报错 |
| 9 | 分区 id 固定 | `desktop`（order 100）、`personalize`（order 90）；同 id section 冲突**未验证** |
| 10 | 「仓库功能更新」清单必须与文件同步 | [components.json](../../desktop-electron/components.json) 的 `repoPath` 指 `plugins/dsh-desktop-ui/…`；改了插件不重算清单（[gen-components.mjs](../../desktop-electron/scripts/gen-components.mjs)），壳按旧摘要取文件即校验失败 |
| 11 | 开发态插件来源 | [main.mjs](../../desktop-electron/src/main.mjs) 的 `PACKAGES_DIR` / `pluginSourceDir()` 非打包态读 `../plugins/<name>`，打包态读包内 `vendor/profile/node_modules` |
| 12 | 不依赖壳注入的全局变量 | 插件不读 `window.*`；`window.__DSH_BOOT__` 由宿主（`dsh web`）注入，与壳无关 |

### 要复用需要改什么

| 目标 | 改哪里 | 说明 |
|---|---|---|
| 换 admin 基址 | [lib/client.js](lib/client.js) 第 15 行 `const ADMIN = …` 与第 138 行 `/sidebar-image` URL | 两处；目标后端必须同名端点、同形状响应 |
| 只保留皮肤 | `apply()` 里第二个 `<style>` 与 `applySkinVars()` | 皮肤不依赖 admin；没有后端就只能吃样式表默认值，左侧栏独立图片无图可加载 |
| 砍掉不需要的能力 | 删对应按钮 / 行 | 每个能力是独立端点，缺一个只影响那一项 |
| 无壳环境里跑通「桌面」分区 | 至少实现 `GET /api/status` | 面板全靠它；缺它永远停在「正在连接桌面壳…」 |
| 让外观项真正生效 | 实现 `POST /api/settings` + 自己注入壁纸 CSS | 见耦合点 4；`sidebarOpacity` 的 max 钳制在客户端，后端只需存原值 |
| 目标后端没有 404 语义 | 改 `post()` 的错误映射 | 404 现被当作「旧壳」，其它非 2xx 显示 `壳返回 HTTP <code>`，网络异常显示「壳未响应」 |
| 目标页面不是 `http://127.0.0.1:<port>` 源 | 目标后端放宽 CORS | 当前白名单只放 `127.0.0.1`，`localhost` / `file://` / 自定义协议都会被浏览器拦掉 |

许可：[MIT](../../LICENSE)。
