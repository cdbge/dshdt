# dsh-market — DSH 市场（左侧栏入口 + 插件 / 美化包两页目录）

**这是什么**：DSH **客户端插件**（浏览器半身）。左侧栏底部加「市场」入口，点开自绘遮罩弹窗，内含两页目录（`插件` / `美化包`）；卡片给出图标、名称、版本、审核标记、来源、摘要与 `源地址` / `主页` / `下载` / `安装方法` / `安装` 五个动作；安装前有确认面板（来源、作者、sha256 前缀、披露项）。

**它自己不做任何 I/O**：目录数据、下载交接、安装全部走 **dshdt 壳的回环 admin API `http://127.0.0.1:25439`**（`lib/client.js:14` 硬编码）；落盘安装由壳转发官方机制 `dsh plugin --profile web add <坐标>`。**因此不能原样装进官方 DSH 桌面端工作** —— 官方端没有这个 admin API（见 §2、§8）。

| 场景 | 能否工作 |
|---|---|
| dshdt 壳（本仓库 `desktop-electron/`，自建 DSH 0.1.7+）内 | ✅ 设计用途：入口 + 目录 + 安装都通（壳实现 `/api/market/*`，`admin.mjs:91,93,162,169`） |
| 手工拷进**官方** DSH 桌面端（0.2+） | ⚠️ 入口能挂上、目录读不到：弹窗显示「目录读取失败：桌面壳未响应（市场目录由壳供给）」，安装按钮同理不可用。官方端无 25439 admin API，`official-shell/` 内 `25439` / `market` 零命中 |
| 只想要这份目录浏览 UI 给别的宿主 | ❌ 需替换 4 个端点或整段改写数据源，见 §8 |

仓库内路径相对仓库根；`file:line` 锚点指本仓库当前代码；`$DSH_HOME` = `%USERPROFILE%\.dsh`。

## 1. 文件构成与两侧契约

| 文件 | 角色 / 要点 |
|---|---|
| `lib/client.js` | **浏览器半身**（主体，785 行 / 38857 B）。`window.__ModuleLoader__.load({ id: "dsh-market", factory })`；`factory` 里 `require("react")` 与 `require("@deepseek-ai/dsh-client-ui-primitives")`；导出 `inject = ["slots"]` 与 `apply(ctx)` |
| `lib/index.js` | **host 半身**（135 B）：`export function apply() {}` 空实现。作用是让宿主装载本条目，从而让 modules 插件按 `dsh.client` 元数据把浏览器半身供给前端 |
| `package.json` | `main: lib/index.js`；`exports: { ".": "./lib/index.js", "./client": "./lib/client.js" }`；`dsh.client.inject = ["@deepseek-ai/dsh-client-ui-sidebar"]`；`dsh.client.platform = "web"` |

以下均在本插件目录之外，**缺了它市场就是空壳**：

| 文件 | 作用 |
|---|---|
| `desktop-electron/src/admin.mjs` | 4 个 `/api/market/*` 路由 + CORS（只放行 `http://127.0.0.1(:port)` 来源） |
| `desktop-electron/src/main.mjs:1150-1350` | `readMarketCatalog()` / `marketOpenDownload()` / `marketInstall()` / `marketPreflight()` |
| `desktop-electron/src/market-install-official.mjs` | **现行安装路径**：坐标校验 + 转发官方 CLI + 失败分档 |
| `desktop-electron/src/market-install.mjs` + `zip-safe.mjs` | **备用安装路径**（sha256 强校验 + 自实现安全解包）；⚠️ 当前**没有被壳调用**，见 §6.2 |
| `desktop-electron/src/market-catalog.json` | 随包样例目录（格式基准，见 §5） |
| `desktop-electron/electron-builder.yml:42-43` | 把样例拷成打包后的 `resources/market-catalog.json` |
| `desktop-electron/scripts/` | 自检（在 `desktop-electron` 下执行）：`test-suite.mjs --only market`（market-install 30 + market-install-official 27）、`zip-safe-self-test.mjs`（27 条解包安全判据）、`client-plugin-load-self-test.mjs`（34 条，真跑三个插件 `client.js` 的 factory/apply/渲染） |

## 2. 装进官方 DSH 桌面端（0.2+）

### 2.1 官方桌面端用 `desktop` profile，不是 `web`

| profile 目录 | 属于谁 | 依据 |
|---|---|---|
| `$DSH_HOME\profiles\desktop\` | **官方 DSH 桌面端**（0.2.0-rc.2） | `official-shell/app-lib/main.js:70-71`：`profile: join(dshHome, "profiles", "desktop")` + `lock: …/profiles/desktop/lock`；`dsh-desktop-host/lib/index.js:215-235`：`runProfile({ profile: "desktop", args: ["--no-open", "--port", "19387"] })` |
| `$DSH_HOME\profiles\web\` | **dshdt 壳（自建 DSH）** | `desktop-electron/src/main.mjs:2079-2080`：`PROFILE_NAME = 'web'`；`PROFILE_DIR = path.join(HOME, 'profiles', PROFILE_NAME)` |

`profiles\web\node_modules\dsh-market\` 那份副本由 dshdt 壳同步进去，官方桌面端启动 `desktop` profile，对该副本不可见。给官方桌面端装，落点是 `$DSH_HOME\profiles\desktop\node_modules\dsh-market\`；判断落点以目标桌面端**实际启动的 profile 名**为准。

### 2.2 手工装的四步

| 步 | 做什么 |
|---|---|
| ① | 拷 `plugins\dsh-market\` → `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-market\`（三个文件：`package.json` + `lib\index.js` + `lib\client.js`；`README.md` 不影响） |
| ② | `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`（顶层 YAML **数组**）追加下方片段 |
| ③ | 重启官方桌面端：客户端半身不热加载（ESM 模块缓存），宿主要在启动时装载该条目，前端才会去取它的 bundle |
| ④ | settings：**不需要**（本插件无 settings 命名空间，`lib/index.js` 是空 `apply()`，无 provider/model/apiKey） |

②的片段（形状与壳写入的一致，`desktop-electron/src/profile-mount.mjs:21`）：

```yaml
# 左侧栏底部入口，插件 / 美化包两页目录（目录数据由壳的 admin API 供给）
- insert:
    - id: dsh-market
      name: dsh-market
```

⚠️ 该文件必须始终是**单一**顶层 YAML 数组：同时留着模板末尾的 `[]` 又追加条目，宿主启动即抛 `YAMLException`（壳有自愈函数 `repairProfilePatchYaml`，`profile-mount.mjs:49-68`）。官方桌面端还有一项恢复动作会「禁用第三方插件、备份 profile patch 并重启」（`official-shell/app-lib/main.js:6550,6717`），手工改之前先备份。

### 2.3 装进去之后会发生什么

点开弹窗、点「下载」、点「安装」都因 6 秒超时后 `fetch` 失败而报「目录读取失败：桌面壳未响应（市场目录由壳供给）」或「桌面壳未响应」；侧栏底部「市场」入口（插槽 `sidebar.footer.action`，`kind: list`，官方 cordis 面板也在这一格）应当出现，**未实机验证**；安装按钮可能可点（判据只看目录条目，见 §7 已知不一致 ③）。

### 2.4 官方自带的安装通道

| 项 | 值 |
|---|---|
| argv | `<dshBin> plugin --profile <profile> add <spec>`（`market-install-official.mjs:92`） |
| cwd | 该 profile 的目录（`profileDir`） |
| runtime | Electron 二进制 + `ELECTRON_RUN_AS_NODE=1`（`main.mjs:1277-1288`） |
| 超时 / pnpm 缺失 | 10 分钟（`market-install-official.mjs:70`）；退出码 **127**（`EXIT_PNPM_MISSING`，同文件 `:7`） |
| 官方端自带包管理器 | `official-shell/dsh-desktop-host/lib/cli.js:91-105`：`runDesktopCli` 用自带 `pnpm/bin/pnpm.mjs`，把 `supportDir/bin` 前置进 PATH，`manageDesktopProfile: true` |

随包样例 `install.steps` 写的 `dsh plugin --profile web add …`（`market-catalog.json:53`）对应 dshdt 的 `web` profile；官方桌面端要换成自己的 profile 名（`desktop`）。官方 CLI 是否自动补 `--profile`：**未验证**（§10 ③）。

## 3. 装进自建 DSH（dshdt 壳，0.1.7+）

### 3.1 壳自己装（正常路径）

壳每次启动做三件事（`desktop-electron/src/main.mjs:2122-2127`）：`syncProfilePlugin('dsh-market')` 把整目录拷到 `$DSH_HOME\profiles\web\node_modules\dsh-market\`（先 `safeRemoveTree` 再 `cpSync`，幂等）；`repairProfilePatchYaml()` 把坏形态补丁层改回合法 YAML；`ensureProfilePluginMount('dsh-market', …)` 把 §2.2 那条 insert 写进 `$DSH_HOME\profiles\web\cordis.patch.yml`。

源目录：打包态取 `VENDOR_DIR/profile/node_modules/dsh-market`（vendor 树，`main.mjs:2076-2083`，由 `scripts/build-host.mjs` 从仓库顶层 `plugins/` 拷入）；源码态取仓库顶层 `plugins/dsh-market`（`main.mjs` 的 `PACKAGES_DIR` / `pluginSourceDir()` 指向 `../plugins`）。读不到包时只记一行 `插件包缺失` 并跳过同步（`main.mjs:2091`），**不会**删掉插件位里已有的副本。

### 3.2 手工装

| 步 | 做什么 |
|---|---|
| ① | `plugins\dsh-market\` → `%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-market\` |
| ② | `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` 追加 §2.2 那段 insert |
| ③ | 托盘「重启宿主（重载插件）」——补丁层热加载，**插件源码不是**（ESM 模块缓存） |
| ④ | settings：**不需要**（同 §2.2 ④）。目录来源是文件不是 settings，见 §5.2 |

⚠️ **手工改这个插件位是易失的**：壳下次启动整目录覆盖（`syncProfilePlugin`），「仓库功能更新」也会把自带插件按仓库内容重写（`repo-update.mjs` 的 `DEFAULT_COORDS` 指向本仓库）。要长期改，改仓库里的 `plugins/dsh-market/`。

⚠️ 改了 `plugins/dsh-market/` 里任何文件后**要重算清单**：`desktop-electron/components.json` 里 `id: "dsh-market"`（`kind: "profile-plugin"`、`dest: "dsh-market"`）逐文件记着 `repoPath` + `sha256` + `size`，是壳热更新链路与 CI 的判据。重算 `node scripts/gen-components.mjs`，校验 `node scripts/gen-components.mjs --check`（不一致就红），均在 `desktop-electron` 下执行。

## 4. 实现契约：壳 admin API

`desktop-electron/src/admin.mjs`（`createAdminServer`）只监听 `127.0.0.1`，**固定端口 25439**（`main.mjs:49` 的 `ADMIN_PORT`）；`listenAdmin` 在端口被占用时**回退系统分配端口**（`admin.mjs:208-219`），此时客户端硬编码的 25439 连不上，界面只说壳未响应。

| 方法 | 路径 | 请求体 | 响应体 | 用途 | 锚点 |
|---|---|---|---|---|---|
| GET | `/api/market/catalog` | 无 | `{ ok: true, schema, updatedAt, source, plugins: [], themes: [], dropped }` 或 `{ ok: false, error: "市场目录不可读" }` | 两页目录数据 | `admin.mjs:91` → `main.mjs:1158` |
| GET | `/api/market/preflight` | 无 | `{ ok, profile, pnpm: bool, pnpmVersion, pnpmDetail, pnpmHow, pnpmPath, hint }` | 安装前置体检：pnpm 在不在（不在就在左栏显示装法） | `admin.mjs:93` → `main.mjs:1337` |
| POST | `/api/market/open-download` | `{ id: string }` | 成功 `{ ok: true, url, note }`；失败 `{ ok: false, error }` | **把下载地址交给系统**（`shell.openExternal`）——壳不下载、不解包、不写盘 | `admin.mjs:162` → `main.mjs:1242` |
| POST | `/api/market/install` | `{ id: string }` | 成功 `{ ok: true, spec, kind, bundleAdded, inDependencies, needsRestart, output, notes[] }`；失败 `{ ok: false, stage, error, hint?, output? }` | 走官方机制安装该条目（分钟级） | `admin.mjs:169` → `main.mjs:1265` |
| POST | `/api/diag/market-geom` | `{ }` | 探针快照 | **临时排障端点**（量弹窗真实几何），插件不调用；注释写明「用完即删」 | `admin.mjs:164` |

`admin.mjs:96-205`：POST 一律返回 **HTTP 200**，成败看响应体 `ok`；请求体上限 64 KiB（超出即 destroy 连接）；未知路径 404 `{ok:false,error:'not found'}`；处理中抛异常 → 400 `{ok:false,error:e.message}`。CORS 仅当 `Origin` 匹配 `^http://127\.0\.0\.1(:\d+)?$` 才回 `Access-Control-Allow-Origin`，允许 `GET,POST,OPTIONS`；页面从不匹配来源加载（非 127.0.0.1、https、自定义协议）时浏览器直接拦掉请求 ⇒ 界面同样表现为壳未响应。

客户端调用与失败文案（`plugins/dsh-market/lib/client.js:35-78, 543-584`）：

| 调用 | 超时 | 失败时界面显示 |
|---|---|---|
| `fetchCatalog()` | 6000 ms | HTTP 非 2xx → `壳返回 HTTP <status>`；JSON `ok !== true` → 其 `error` 或 `目录格式不正确`；`fetch` 抛错 → `桌面壳未响应（市场目录由壳供给）` |
| `fetchPreflight()` | 6000 ms | 静默失败（返回 `null`，只是不显示缺 pnpm 提示） |
| `openDownload()` | 10000 ms | `桌面壳未响应` 或 `返回内容不是 JSON` |
| `installEntry()` | **不设超时**（装包分钟级） | `<error>（失败于：<stage>）` |

壳侧失败文案（`main.mjs:1242-1300`）：`目录里没有 id=<id> 的条目`、`「<name>」还没有下载地址（该条目没挂下载包）`、`拒绝打开非 https 地址：<url>`、`已有一次安装正在进行，请等它结束`（`marketInstalling` 单飞闸门）、`headless/smoke 模式不执行安装`。

## 5. `catalog.json` 的完整格式

逐条对应 `main.mjs:1158-1237` 的读取实现。样例见 `desktop-electron/src/market-catalog.json`（105 行，两条插件 + 一条美化包）。JSON 必须能 `JSON.parse` 且是对象，否则视为这份不可读并回退到下一来源；BOM 会被剥掉（`main.mjs:1161`）。全份 JSON 解析失败**不会**让接口失败，只要有另一份可读；两份都不可读才回 `{ok:false,error:'市场目录不可读'}`。

**顶层字段**（全部可选）：

| 字段 | 类型 / 壳怎么处理 |
|---|---|
| `schema` | number；原样回显，非数字 → `0`。客户端不用 |
| `updatedAt` | 非空字符串；原样回显，脚注显示前 10 个字符（`client.js:714`）。ISO 时间串即可 |
| `plugins` / `themes` | array；插件页 / 美化包页，缺或非数组 → `[]` |
| `_说明` | array of string；**壳完全不读**，纯给人看 |
| 其它字段 | 忽略 |

**条目硬判据**（违反任一条，整条被丢弃并计入 `dropped`，不报错、不显示）：`id` 非空字符串且**同一页内不重复**（`seen` 集合按页独立，插件与美化包可以同名）；`name` 非空字符串；`source` 非空且 `^https://`（http 会被丢，不是降级）；`download.url` 可不给，给了必须是 `""` 或 `https://…`；`download.sha256` 可不给，给了必须是 `""` 或 64 位十六进制（大小写均可，壳不改）。

**条目软字段**（缺失或类型不对 → 用默认值，条目不丢）：

| 字段 | 默认 / 语义 |
|---|---|
| `summary` | `''`；卡片摘要（一行小字） |
| `author` | `''`；卡片元信息，空则显示「未知作者」 |
| `version` | `''`；卡片上的 `v<version>` 标签，空则不显示 |
| `icon` | `plugins` → `📦`；`themes` → `🎨`；卡片左侧图标（emoji 或短文本） |
| `homepage` | `''`；必须 https 才保留（http 静默丢弃）；与 `source` **规范化后实质不同**时才多给一个「主页」按钮（`client.js:259-274` 的 `isDistinctUrl`：去协议/`www.`/锚点/查询串/尾斜杠/`.git` 后比较，同仓库子路径算同一个） |
| `tags` | `[]`；字符串数组，滤掉空值，**最多 6 个**，卡片上以 ` / ` 连接显示 |
| `install` / `reviewed` | `install` 见 5.1；`reviewed` 默认 `null`，见 5.1 |
| `disclosure` | `{notes:[],warnings:[]}`；字符串数组，各滤空、**各最多 10 条**；确认面板与「安装方法」页逐条显示，「注意」用警示色块 |
| `download.immutable` | 严格 `=== true` 才算；**输出到响应条目的顶层** `immutable`，不在 `download` 里 |
| `download.bytes` | `0`；仅 `Number.isFinite` 才保留，客户端不读 |

### 5.1 `install` / `reviewed` / `disclosure`

| 字段 | 解析结果 |
|---|---|
| `install: { spec, steps }` | `spec` = 安装坐标（喂给 `dsh plugin add`），`steps` = 给人看的说明文字 |
| `install: "一段文字"` | 整串当作 `steps`，`spec` 为 `''`（旧格式兼容） |
| `reviewed: { at, verdict, spec, record }` | 仅当 `at` 是非空字符串时整块成立，否则变 `null`；`verdict` / `spec` / `record` 各自非空字符串才保留 |
| `disclosure: { notes: [], warnings: [] }` | 字符串数组，各滤空、各最多 10 条 |

`steps` 在「安装方法」子页以等宽块原样显示，支持 `\n`。`spec` 形状在安装时另行校验（`market-install-official.mjs:14-32`）：npm 精确版本 / `@scope/name@ver` / `github:owner/repo#<40 位 commit>` / `https://….tgz`；含空白、`http://`、非 `.tgz` 的 https、`github:` 未钉 commit —— 一律 `stage: 'validate'` 拒装。CI 口径：随包样例里**每条**都必须有非空 `install.steps`（`scripts/ci-self-test.mjs:250-254`）。

界面：卡片上是绿色「已审核 <at>」或灰色「未审核」；确认面板里无审核记录时是**红色警告**（「装之前请自行核对来源与代码」）；「安装方法」子页显示 `at / verdict / spec`。审核**不是**安全审查（口径见 `docs/项目/计划/DSH市场审核标准.md`）。

### 5.2 目录从哪来（两级，本地文件，无网络）

| 优先级 | 路径 | `source` | 说明 |
|---|---|---|---|
| 1 | `$DSH_HOME\market\catalog.json` | `"user"` | 用户/离线覆盖 |
| 2 | `<resources>\market-catalog.json` | `"bundled"` | 随包样例。打包态 = `resources/`（`electron-builder.yml:42-43`）；**开发态 `RES` 是 `desktop-electron/`，该路径下没有这个文件** ⇒ 源码态只有用户覆盖那份生效 |

界面脚注据此显示「目录来源：用户目录覆盖」或「目录来源：随包内置样例」，后接 `updatedAt` 前 10 字符（`client.js:713-714`）。⚠️ **没有远端目录**：样例 `_说明` 里写的「将来由独立仓库托管、客户端从 GitHub Pages 取同名 JSON」**尚未实现**。要做远端见 §8。

### 5.3 条目样例

真实条目（`desktop-electron/src/market-catalog.json:28-61`，长文本已折行）：

```jsonc
{ "id": "dsh-whale-widget", "name": "余额小鲸鱼挂件", "author": "MeteorNOX", "icon": "🐋", "version": "0.3.2",
  "summary": "Web 界面右下角的 DeepSeek 余额挂件：……", "tags": ["余额", "用量", "外观", "挂件"],
  "source": "https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget",
  "reviewed": { "at": "2026-09-17", "verdict": "pass", "spec": "dsh-whale-widget@0.3.2", "record": "docs/项目/审核记录/dsh-whale-widget.md" },
  "disclosure": { "notes": ["…"], "warnings": ["界面会多出右下角挂件，且自带音效（可在挂件设置里关）。"] },
  "install": { "spec": "dsh-whale-widget@0.3.2", "steps": "已发布 npm ⇒ 走官方机制安装，**不触发任何构建脚本**：\n  dsh plugin --profile web add dsh-whale-widget@0.3.2\n…" },
  "download": { "url": "https://www.npmjs.com/package/dsh-whale-widget", "sha256": "", "bytes": 0, "immutable": false } }
```

最小可用（自己造目录时照抄；`download` 整块可以不给）：

```json
{ "schema": 1, "updatedAt": "2026-09-16T00:00:00Z", "themes": [],
  "plugins": [
    { "id": "dsh-hello-plugin", "name": "示例插件", "summary": "一句话说明它干什么。", "author": "someone",
      "source": "https://github.com/someone/dsh-hello-plugin", "version": "1.0.0",
      "install": { "spec": "dsh-hello-plugin@1.0.0", "steps": "npm 包 ⇒ dsh plugin add dsh-hello-plugin@1.0.0" } } ] }
```

### 5.4 按钮判据 ≠ 安装判据

卡片上「安装」按钮可点要求 `download.url` 非空 **且** `download.sha256` 非空（变量名 `pinned`，`client.js:278-281, 353-363`）；真正安装**只吃 `install.spec`**，`download` 完全不参与（`market-install-official.mjs:14-32`）。⇒ 要让一键安装可用，`install.spec` 与 `download.sha256` **两个都得有**（`sha256` 只作按钮开关，现行链路不校验它）。随包样例 `sha256` 全为空 ⇒ 样例条目一律带「无下载包」标签、安装按钮灰，连有合法 `spec` 的 `dsh-whale-widget` 也点不动。

## 6. 安装链路：分档与判据

### 6.1 现行链路（`POST /api/market/install`）—— 官方机制

读目录 → 按 id 找条目 → 单飞闸门 → 解析 pnpm（与 `/preflight` **共用同一份缓存结果**）→ `<dshBin> plugin --profile web add <spec>`（cwd = profile 目录，env 注入 pnpm PATH / `DSH_HOME` / `ELECTRON_RUN_AS_NODE=1`）→ 按退出码与输出分档 → **回读 profile 的 `package.json` 核对痕迹**。

| `stage` | 触发条件 | 用户看到什么 |
|---|---|---|
| `validate` | 缺 `dshBin`/`profile`/`spawnSync`；`install.spec` 为空、含空白、`http://`、非 `.tgz` 的 https、`github:` 未钉 40 位 commit、形状不认识 | 坐标形状错误的具体说明 |
| `pnpm` | pnpm 不可用（与体检同一判据）；dsh 退出码 **127**（`pnpm not found on PATH`）；其它非 0 退出码 | 退出码 + `hint`（缺 pnpm 时 `pnpmHint()` 给 `npm i -g pnpm` / `corepack enable` / 装好后重启应用 / 看后台日志的 `pnpm 解析` 行） |
| `spawn` | `spawnSync` 抛异常、运行时或 CLI 不存在（ENOENT）、其它 spawn 错误 | 错误原文 |
| `timeout` | `ETIMEDOUT`（默认 10 分钟） | 「网络慢或包很大」，附已捕获输出 |
| `build-script` | 输出命中 `allowBuilds` / `blocked build scripts` / `Ignored build scripts` / `prepare` | 明说这等于允许它在安装时执行代码，要求用户把 pnpm 打印的包键写进 profile 的 `pnpm-workspace.yaml` 后重试——**插件不替你点这个授权** |
| `verify` | 退出码 0，但 profile 的 `dependencies` 里没有该依赖键、且 `dsh.profile.bundles` 为空 | 「安装可能没真正落地」（**不许假成功**） |
| 成功 | 命中 `dependencies` 或 `bundles` 任一 | `{ok:true, spec, kind, bundleAdded, inDependencies, needsRestart:true, notes}`；提示重启 dshdt（或托盘「重启宿主」）后生效 |

补充：`kind` 分 `registry` / `github` / `tarball`；依赖键由 `manifestKeyOf()` 从坐标推算（tarball 推不出则不做强判）；现行链路**没有**撞自带插件名这道判据（只在 §6.2 备用链路里）。

### 6.2 备用链路（`market-install.mjs` + `zip-safe.mjs`）—— ⚠️ 当前未接线

仓库里保留、有 57 条夹具，但壳不调它：`installMarketEntry` 仅被 `scripts/market-install-self-test.mjs` 引用；`main.mjs` 只 `import { installMarketEntryOfficial, pnpmHint }`（`main.mjs:20`）；`scripts/ci-self-test.mjs:296-298` 断言「安装不再由壳自己下载解包」。保留理由是比官方链路多两样东西：**sha256 强校验**与**自实现的安全解包判据**。落位是同卷 `fs.renameSync(staging, target)`（原子）；回滚在 `finally` 里把没 rename 成功的临时目录 `removeTree` 删掉，自检对**每条**失败分支都断言「目标目录不存在且无 `.tmp-install-*` 残留」。将来接回去（如换掉 pnpm、做离线包）按它的分档：

| `stage` | 判据（以代码为准） |
|---|---|
| `validate` | 条目不是对象 / 缺 `id` / `id` 不匹配 `^[a-z0-9][a-z0-9._-]*$` / `id` 撞自带三插件（`dsh-desktop-ui`、`dsh-auto-approval`、`dsh-market`） / 无 `download.url` / 地址非 https / `sha256` 不是 64 位十六进制 / 内部装配缺 `mount` 或 `removeTree` |
| `download` | `httpDownload()`：**只接受 https**；重定向**跟随后仍需 https**（否则拒绝）；60 s 超时；`content-length` 或实收字节 **> 64 MiB** 即拒；HTTP 非 2xx 报状态码 |
| `verify` | 下载内容 sha256 ≠ 条目 sha256 → **拒绝安装**（提示让维护者重新审核该条目） |
| `extract` | 解包到临时目录 `.tmp-install-<id>-<36 进制时间戳>`；`extractZipSafe` 任一判据不过即整体失败 |
| `shape` | 没有 `package.json` / 不是合法 JSON / 无 `name` / `package.json` 的 `name` ≠ 条目 `id`（挂载行会挂到不存在的模块上） |
| `stage` | 目标目录 `node_modules/<id>` **已存在** → 拒绝覆盖（不静默替换用户自己那份）；`renameSync` 失败 |
| `mount` | 包已落盘但写挂载行抛错 → `{ok:false, stage:'mount'}`，**不删包**，如实报出 |

解包安全判据（`zip-safe.mjs`，自实现，零依赖，只支持 store/deflate）——以下任一即**拒绝整包**（不做跳过坏条目）：条目名含 `..`、反斜杠、前导 `/`、盘符、`:`（ADS/盘符歧义）、NUL 字节、指向目录自身；规范化后仍在目标根之外（须先规范化再比前缀，顺序反了会被 `a/../..` 绕过）；zip64 占位值（`0xffff` / `0xffffffff`）；中央目录越界、签名不对、条目越界、EOCD 找不到、文件 < 22 字节；压缩方式非 0/8（含加密）；没有任何文件（只有目录条目）。包内只有唯一顶层目录且所有条目都带 `/` 时自动剥掉该层（`stripped`），多顶层不剥。

### 6.3 两条链路的差异

| 维度 | 现行（官方机制） | 备用（自包含 zip） |
|---|---|---|
| 依赖解析 / 锁版本 | ✅ pnpm 做 | ❌ 完全不做 |
| 内容校验 | ❌ 不校验下载内容（`download.sha256` 只当按钮开关） | ✅ sha256 强校验 |
| 构建脚本 | pnpm 拦截并要求**用户显式授权**（`build-script` 档） | 不执行任何脚本 |
| 自带插件保护 | ❌ 无判据 | ✅ `id` 撞三个自带插件即拒 |
| 网络 | pnpm（registry / git / tarball） | 单文件 https + 跟随重定向 |
| 失败粒度 | 7 档（含「退出码 0 但无痕迹」的 `verify`） | 7 档（含「不留半成品」的回滚） |

## 7. 客户端 UI 契约

| 项 | 值（含 `client.js` 锚点） |
|---|---|
| 装载入口 | `window.__ModuleLoader__.load({ id: "dsh-market", factory })`；**id 必须等于包目录名**（`:4-6`） |
| 依赖注入 | `dsh.client.inject = ["@deepseek-ai/dsh-client-ui-sidebar"]`、`platform: "web"`；`exports` 必须有 `./client`（`package.json`） |
| 插件面 | `exports.inject = ["slots"]`；`apply(ctx)` 里 `ctx.slots.inject("sidebar.footer.action", …)` 再 `ctx.slots.register({ name, id: "market", locale: undefined, label: () => "市场" }, MarketEntry)`（`:757-767`） |
| 插槽形态 | `sidebar.footer.action` 是 **list 型**（官方 cordis 面板也占这一格）⇒ 只能**追加**自己那一项；入口组件收 `props.wide`，窄栏时只留图标（`:725-755, 759`） |
| 图标 / 弹窗 | `primitives.IconArchiveOutline20`（入口）、`primitives.IconCloseOutline16`（关闭）（`:676,748`）；弹窗为**自绘遮罩**（不用官方 Modal），`role="dialog"`，左右两栏：左栏 188px 导航，右栏右上是唯一的 ×；Esc / 点遮罩 / × 三种关闭；固定宽 800px、高 `min(800px, 100vh-48px)`（`:94-113, 505-521, 605-613`） |
| 样式 | 全部走官方 CSS 变量（`--dsw-*`）；hover/active 用注入的 `<style data-plugin="dsh-market">`（行内样式压不住伪类），卸载时移除；DOM 类名 `dsh-market-*`（`:80-252, 769-781`） |
| 目录数据 | 只在弹窗打开时拉一次（`useEffect` 依赖 `open`），失败后靠重开弹窗重试（`:522-541`） |

已知不一致（改代码时顺手修，不是配置问题）：① 页面标题 `<h3>` 引用 `css.contentTitle`，但样式表里没有这个键 ⇒ 走浏览器默认样式（`client.js:692` 有引用，`css` 对象里无定义）；② 「固定版本」标签读 `entry.download.immutable`，而壳把它放在响应条目**顶层** ⇒ 标签**永不出现**（`client.js:298` vs `main.mjs:1221-1223`）；③ 「安装」按钮判据是 `download.url` + `download.sha256`，实际安装只吃 `install.spec` ⇒ 样例条目按钮全灰（见 §5.4）。

## 8. ⚠️ 耦合与限制：要替换哪些接口、哪些能力会失效

| 复用目标 | 要动的地方 | 会失效的能力 |
|---|---|---|
| **装进官方桌面端 / 任何非 dshdt 宿主** | 无壳实现可换 —— 必须在目标宿主上**新写这 4 个端点**（或改客户端的数据层） | 目录、下载交接、一键安装**全部失效**（弹窗还能开、还能报壳未响应） |
| 换目录来源（远端 JSON / 打包内置 / 常量） | `fetchCatalog()` 的 URL 与响应契约（`{ok, schema, updatedAt, source, plugins, themes}`） | 脚注的「目录来源/更新时间」要一起改；`dropped` 丢弃计数会没有 |
| 不想要壳内安装 | 只保留 `/api/market/catalog` + `/api/market/open-download`，删掉安装按钮分支 | 一键安装、「安装方法」子页里的坐标语义变纯说明 |
| 换安装器（不用 `dsh plugin add`） | `/api/market/install` 的返回契约：客户端只读 `{ok, notes[], error, stage}` | `stage` 分档文案会失真；`needsRestart` 语义要自己保证 |
| 换宿主 / 端口 | `client.js:14` 的 `ADMIN` 常量（**硬编码**，无配置项） | 壳端口被占用回退系统分配时，市场静默失联 |
| 换侧栏插槽或官方端 UI 版本变了 | `slots.inject` / `slots.register` 的 `name` + `id`，以及 `dsh.client.inject` 列表 | 入口**静默不出现**（没有任何报错） |
| 只想要这套两页目录 UI | 保留 `client.js` 全部渲染，把 4 个调用换成一个 `fetch` | 下载与安装；审核标记/披露项仍可用（纯展示字段） |

耦合点是**目录数据 + 下载交接 + 安装**这三件事，全部经 `http://127.0.0.1:25439` 的壳 admin API；壳不在，本插件只剩一个报壳未响应的空弹窗。

## 9. 相关文档

| 文档 | 内容 |
|---|---|
| `plugins/README.md` | 三个自研插件的总览、统一安装位与「改完要重算 `components.json`」的纪律 |
| `docs/项目/计划/DSH市场计划书.md` | 壳的边界（「壳不安装任何东西」）、目录两级来源、pnpm 前置体检的由来 |
| `docs/项目/计划/DSH市场审核标准.md` | 上架审核判据（R/B 档）、「审核 ≠ 安全审查」 |
| `docs/项目/审核记录/` | 每个已审条目一份记录（`catalog.json` 的 `reviewed.record` 指向这里） |
| `docs/项目/02-架构与铁律.md:58-61` | 本插件与三条安装链路在架构里的定位 |
| `plugins/dsh-auto-approval/README.md` | 同批插件的 README 版式 |

## 10. 未验证事项

| # | 未验证的事 | 已知的部分 |
|---|---|---|
| ① | 手工拷进官方桌面端后，侧栏入口与弹窗是否真的出现并渲染 | 静态契约齐备（`dsh.client` + insert 行 + `exports["./client"]`），没有实机装过 |
| ② | 官方桌面端 0.2.x 是否仍提供 `sidebar.footer.action` 插槽与 `@deepseek-ai/dsh-client-ui-sidebar` 的注入面 | 官方端为 0.2.0-rc.2（`official-shell/dsh-desktop-host/package.json`），客户端包版本未逐一核对 |
| ③ | 官方 CLI 对**只声明 `dsh.client`**（无 `dsh.bundle`）的包，是否会写 `dsh.profile.bundles` 或自动补挂载行 | `bundleAdded` 只在 manifest 有 bundles 时为真，挂载行仍需自己写（`market-install-official.mjs:130,134-137`） |
| ④ | 官方桌面端「插件管理」入口的确切位置与命令名 | 官方 CLI 用自带 pnpm 且 `manageDesktopProfile: true`；恢复入口有「禁用第三方插件、备份 profile patch 并重启」（`official-shell/app-lib/main.js:6550,6717`） |
| ⑤ | `profiles/desktop` 里的 `dsh-plugin-wallpaper-engine` 是否经官方 CLI/市场装入 | 只能从 `package.json`（dependencies + bundles）与 `pnpm-workspace.yaml`（`minimumReleaseAgeExclude`）的痕迹推断 |
| ⑥ | 官方桌面端是否存在「也加载 `profiles/web`」的开关 | 官方端 profile 是 `desktop`；是否有额外开关未发现 |
| ⑦ | 官方桌面端主题变量集（`--dsw-*`）下弹窗的观感 | 本插件全部用官方令牌，理论上跟随深浅主题；未实机截图核对 |
| ⑧ | 备用链路（`market-install.mjs`）将来是否重新接线 | 当前**未接线**是代码事实（§6.2），属有意保留的能力 |
