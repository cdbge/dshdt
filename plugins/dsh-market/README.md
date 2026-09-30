# dsh-market — DSH 市场（左侧栏入口 + 插件 / 美化包两页目录）

**这是什么**：一个 DSH **客户端插件**（浏览器半身）——在左侧栏底部加「市场」入口，点开一个自绘遮罩弹窗，
两页目录（`插件` / `美化包`），每张卡片给出图标、名称、版本、审核标记、来源、摘要，以及
`源地址` / `主页` / `下载` / `安装方法` / `安装` 五个动作，安装前有一块确认面板（来源、作者、sha256 前缀、披露项）。

**它自己不做任何 I/O**：目录数据、下载交接、安装全部走 **dshdt 壳的回环 admin API `http://127.0.0.1:25439`**
（`plugins/dsh-market/lib/client.js:14` 硬编码）。真正落盘的安装由壳转发给官方机制
`dsh plugin --profile web add <坐标>`。**因此本插件不能原样装进官方 DSH 桌面端工作** —— 官方桌面端没有这个 admin API
（见 §2、§8）。

**现在还能怎么用**：

| 场景 | 能否工作 | 依据 |
|---|---|---|
| dshdt 壳（本仓库 `desktop-electron/`，自建 DSH 0.1.7+）内 | ✅ 设计用途：入口 + 目录 + 安装都通 | 壳实现 `/api/market/*`（`desktop-electron/src/admin.mjs:91,93,162,169`） |
| 手工拷进**官方** DSH 桌面端（0.2+） | ⚠️ 入口能挂上、目录读不到：弹窗会显示「目录读取失败：桌面壳未响应（市场目录由壳供给）」，安装按钮同理不可用 | 官方端无 25439 admin API；仓库内官方抽取件 `official-shell/` 里 `25439` / `market` 零命中 |
| 只想要这份"目录浏览 UI"给别的宿主 | ❌ 需替换 4 个端点或整段改写数据源，见 §8 | 客户端与壳的契约在 §4、§5 |

> 约定：本文所有仓库内路径都相对**仓库根**（`dshdt/`），`file:line` 形式的锚点都指本仓库当前代码。
> `$DSH_HOME` = `%USERPROFILE%\.dsh`。

---

## 1. 文件构成与两侧契约

| 文件 | 角色 | 要点 |
|---|---|---|
| `plugins/dsh-market/lib/client.js` | **浏览器半身**（主体，785 行 / 38857 B） | `window.__ModuleLoader__.load({ id: "dsh-market", factory })`；`factory` 里 `require("react")` 与 `require("@deepseek-ai/dsh-client-ui-primitives")`；导出 `inject = ["slots"]` 与 `apply(ctx)` |
| `plugins/dsh-market/lib/index.js` | **host 半身**（135 B） | `export function apply() {}` —— 空实现。它存在的唯一理由是让宿主装载这个条目，从而让 modules 插件按 `dsh.client` 元数据把浏览器半身供给前端（文件内注释原话） |
| `plugins/dsh-market/package.json` | 元数据 | `main: lib/index.js`、`exports: { ".": "./lib/index.js", "./client": "./lib/client.js" }`、`dsh.client.inject = ["@deepseek-ai/dsh-client-ui-sidebar"]`、`dsh.client.platform = "web"` |

壳侧配套（**不在本插件目录内，但缺了它市场就是空壳**）：

| 文件 | 作用 |
|---|---|
| `desktop-electron/src/admin.mjs` | 4 个 `/api/market/*` 路由 + CORS（只放行 `http://127.0.0.1(:port)` 来源） |
| `desktop-electron/src/main.mjs:1150-1350` | `readMarketCatalog()` / `marketOpenDownload()` / `marketInstall()` / `marketPreflight()` 的实现 |
| `desktop-electron/src/market-install-official.mjs` | **现行安装路径**：坐标校验 + 转发官方 CLI + 失败分档 |
| `desktop-electron/src/market-install.mjs` + `zip-safe.mjs` | **备用安装路径**（sha256 强校验 + 自实现安全解包）。⚠️ 当前**没有被壳调用**，见 §6.2 |
| `desktop-electron/src/market-catalog.json` | 随包样例目录（格式基准，见 §5） |
| `desktop-electron/electron-builder.yml:42-43` | 把样例拷成打包后的 `resources/market-catalog.json` |

自检（本机 2026-09-29 实跑，全绿）：

```powershell
cd desktop-electron
node scripts/test-suite.mjs --only market   # market-install 30 + market-install-official 27
node scripts/zip-safe-self-test.mjs         # 27 条（解包安全判据）
node scripts/client-plugin-load-self-test.mjs  # 34 条（真跑三个插件 client.js 的 factory/apply/渲染）
```

---

## 2. 装进官方 DSH 桌面端（0.2+）

### 2.1 先纠正一个容易搞错的点：官方桌面端用的是 `desktop` profile，不是 `web`

| profile 目录 | 属于谁 | 证据 |
|---|---|---|
| `$DSH_HOME\profiles\desktop\` | **官方 DSH 桌面端**（本机 0.2.0-rc.2） | `official-shell/app-lib/main.js:70-71`：`profile: join(dshHome, "profiles", "desktop")` + `lock: …/profiles/desktop/lock`；`official-shell/dsh-desktop-host/lib/index.js:215-235`：`runProfile({ profile: "desktop", args: ["--no-open", "--port", "19387"] })`。本机该目录里有官方装的 `dsh-plugin-wallpaper-engine`（`package.json` 的 dependencies + `dsh.profile.bundles` + `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`） |
| `$DSH_HOME\profiles\web\` | **dshdt 壳（自建 DSH）** | `desktop-electron/src/main.mjs:2079-2080`：`PROFILE_NAME = 'web'` / `PROFILE_DIR = path.join(HOME, 'profiles', PROFILE_NAME)`。本机该目录里正好是壳自带的 `dsh-desktop-ui` / `dsh-auto-approval` / `dsh-market` / `dsh-host-lock-registry` |

**所以**：`%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-market\` 这个位置确实存在这个包，但它是 **dshdt 壳**同步进去的，
官方桌面端启动的是 `desktop` profile ⇒ 那份副本对官方桌面端不可见（就本机 0.2.0-rc.2 的代码与目录状态而言；见 §10 未验证 ⑥）。
给官方桌面端装，落点是 `$DSH_HOME\profiles\desktop\node_modules\dsh-market\`。

> 与 `plugins/README.md`（同批插件的总览）的口径：那份文档现在也按「宿主 → profile」分列
> （官方桌面端 `desktop` / dshdt 壳·自建 `dsh web` `web`），与本节的结论一致。
> 装之前以"目标桌面端**实际启动的 profile 名**"为准（本机官方端为 `desktop`）。

### 2.2 手工装的四步

| 步 | 做什么 | 细节 |
|---|---|---|
| ① | 拷包到插件位 | `plugins\dsh-market\` → `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-market\`（三个文件：`package.json` + `lib\index.js` + `lib\client.js`；`README.md` 拷不拷都不影响） |
| ② | 在 profile 补丁层加挂载行 | `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`（顶层 YAML **数组**）追加： |
| ③ | 重启官方桌面端 | 客户端半身不热加载（ESM 模块缓存）；宿主要在启动时装载这个条目，前端才会去取它的 bundle |
| ④ | settings | **不需要**。本插件没有 settings 命名空间（`lib/index.js` 是空 `apply()`），也没有 provider/model/apiKey |

②的片段（与壳自己写进去的形状一致，`desktop-electron/src/profile-mount.mjs:21`）：

```yaml
# DSH 市场：左侧栏底部入口，插件 / 美化包两页目录（目录数据由壳的 admin API 供给）
- insert:
    - id: dsh-market
      name: dsh-market
```

⚠️ 该文件必须始终是**单一**顶层 YAML 数组：既留着模板末尾的 `[]`、又追加了条目，宿主启动即抛 `YAMLException`。
壳为此专门写了自愈函数 `repairProfilePatchYaml`（`desktop-electron/src/profile-mount.mjs:49-68`）。
官方桌面端里还有一项恢复动作会"禁用第三方插件、备份 profile patch 并重启"
（`official-shell/app-lib/main.js:6550,6717` 的文案表），手工改之前先把该文件备份一份。

### 2.3 装进去之后会发生什么

| 动作 | 结果 |
|---|---|
| 侧栏底部「市场」入口 | 应当出现（插槽 `sidebar.footer.action`，`kind: list`，官方 cordis 面板也在这一格）。**未实机验证** |
| 点开弹窗 | 6 秒超时后 `fetch` 失败 → 界面显示「目录读取失败：桌面壳未响应（市场目录由壳供给）」 |
| 「下载」 | 显示「桌面壳未响应」 |
| 「安装」 | 按钮本身可能可点（判据只看目录条目，见 §7 已知不一致 ③），点下去同样是"壳未响应" |

### 2.4 官方自带的安装通道（参考口径，不是本插件在用的那条）

官方 CLI 的调用形状与失败分档在 `desktop-electron/scripts/market-install-official-self-test.mjs` 里被逐条钉死：

| 项 | 值 |
|---|---|
| argv | `<dshBin> plugin --profile <profile> add <spec>`（`market-install-official.mjs:92`） |
| cwd | 该 profile 的目录（`profileDir`） |
| runtime | Electron 二进制 + `ELECTRON_RUN_AS_NODE=1`（`main.mjs:1277-1288`） |
| 超时 | 10 分钟（`market-install-official.mjs:70`） |
| pnpm 缺失 | 退出码 **127**（`EXIT_PNPM_MISSING`，`market-install-official.mjs:7`） |
| 官方端自带包管理器 | `official-shell/dsh-desktop-host/lib/cli.js:91-105`：`runDesktopCli` 用自带 `pnpm/bin/pnpm.mjs` 并把 `supportDir/bin` 前置进 PATH，且 `manageDesktopProfile: true`（profile 由官方 CLI 自己管） |

注意随包样例目录里 `install.steps` 写的命令是 `dsh plugin --profile web add …`（`desktop-electron/src/market-catalog.json:53`）——
那是 **dshdt 的口径**（web profile）。官方桌面端要换成它自己的 profile 名（本机为 `desktop`），
且官方 CLI 是否会自动补 `--profile`：**未验证**（§10 ③）。

---

## 3. 装进自建 DSH（dshdt 壳，0.1.7+）

### 3.1 壳本来就会自己装（正常路径）

壳每次启动都做三件事（`desktop-electron/src/main.mjs:2122-2127`）：

1. `syncProfilePlugin('dsh-market')`：把包整目录拷到 `$DSH_HOME\profiles\web\node_modules\dsh-market\`
   （先 `safeRemoveTree` 再 `cpSync`，幂等）；
2. `repairProfilePatchYaml()`：把坏形态的补丁层改回合法 YAML；
3. `ensureProfilePluginMount('dsh-market', …)`：把 §2.2 那条 insert 写进 `$DSH_HOME\profiles\web\cordis.patch.yml`。

源目录：打包态取 `VENDOR_DIR/profile/node_modules/dsh-market`（vendor 树，`main.mjs:2076-2083`；由 `scripts/build-host.mjs` 从仓库顶层 `plugins/` 拷入）；
**源码态**取仓库顶层 `plugins/dsh-market`（`main.mjs` 的 `PACKAGES_DIR` / `pluginSourceDir()` 已随 2026-09-30 的迁移改指 `../plugins`）。
读不到包时只记一行 `插件包缺失` 并跳过同步（`main.mjs:2091`），**不会**删掉插件位里已有的副本。

### 3.2 手工装（不想跑壳的同步时）

| 步 | 做什么 |
|---|---|
| ① | `plugins\dsh-market\` → `%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-market\` |
| ② | `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` 追加 §2.2 那段 insert |
| ③ | 托盘「重启宿主（重载插件）」——补丁层是热加载的，**插件源码不是**（ESM 模块缓存） |
| ④ | settings：**不需要**（同 §2.2 ④）。目录来源是文件不是 settings，见 §5.5 |

⚠️ **手工改这个插件位是易失的**：壳下次启动会整目录覆盖（`syncProfilePlugin`），
「仓库功能更新」也会把自带插件按仓库内容重写（`desktop-electron/src/repo-update.mjs` 的 `DEFAULT_COORDS` 指向本仓库）。
要长期改，改仓库里的 `plugins/dsh-market/`，不要改 `$DSH_HOME` 里那份。

⚠️ 改了 `plugins/dsh-market/` 里任何一个文件后，**要重算清单**：`desktop-electron/components.json` 里 `id: "dsh-market"`
（`kind: "profile-plugin"`、`dest: "dsh-market"`）逐文件记着 `repoPath` + `sha256` + `size`，是壳那条热更新链路与 CI 的判据：

```powershell
cd desktop-electron
node scripts/gen-components.mjs          # 重新生成
node scripts/gen-components.mjs --check  # CI 校验（不一致就红）
```

---

## 4. 实现契约：壳 admin API

服务：`desktop-electron/src/admin.mjs`（`createAdminServer`），只监听 `127.0.0.1`，**固定端口 25439**
（`main.mjs:49` 的 `ADMIN_PORT`；`admin.mjs:208-219` 的 `listenAdmin` 在该端口被占用时**回退系统分配端口** ——
此时客户端硬编码的 25439 会连不上，界面只会说"壳未响应"）。

| 方法 | 路径 | 请求体 | 响应体 | 用途 | 实现锚点 |
|---|---|---|---|---|---|
| GET | `/api/market/catalog` | 无 | `{ ok: true, schema, updatedAt, source, plugins: [], themes: [], dropped }` 或 `{ ok: false, error: "市场目录不可读" }` | 两页目录数据 | `admin.mjs:91` → `main.mjs:1158` |
| GET | `/api/market/preflight` | 无 | `{ ok, profile, pnpm: bool, pnpmVersion, pnpmDetail, pnpmHow, pnpmPath, hint }` | 安装前置体检：pnpm 在不在（不在就在左栏显示装法） | `admin.mjs:93` → `main.mjs:1337` |
| POST | `/api/market/open-download` | `{ id: string }` | 成功 `{ ok: true, url, note }`；失败 `{ ok: false, error }` | **把下载地址交给系统**（`shell.openExternal`）——壳不下载、不解包、不写盘 | `admin.mjs:162` → `main.mjs:1242` |
| POST | `/api/market/install` | `{ id: string }` | 成功 `{ ok: true, spec, kind, bundleAdded, inDependencies, needsRestart, output, notes[] }`；失败 `{ ok: false, stage, error, hint?, output? }` | 走官方机制安装该条目（分钟级） | `admin.mjs:169` → `main.mjs:1265` |
| POST | `/api/diag/market-geom` | `{ }` | 探针快照 | **临时排障端点**（量弹窗真实几何），插件不调用；注释写明"用完即删" | `admin.mjs:164` |

通用行为（`admin.mjs:96-205`）：

- 这些 POST 一律返回 **HTTP 200**，成败看响应体里的 `ok`；请求体上限 64 KiB（超出即 destroy 连接）；
  未知路径 404 `{ok:false,error:'not found'}`；处理中抛异常 → 400 `{ok:false,error:e.message}`。
- CORS：仅当 `Origin` 匹配 `^http://127\.0\.0\.1(:\d+)?$` 才回 `Access-Control-Allow-Origin`，允许 `GET,POST,OPTIONS`。
  页面若从不匹配的来源加载（非 127.0.0.1、https、自定义协议），浏览器会直接拦掉请求 ⇒ 界面表现同样是"壳未响应"。

客户端的调用参数与失败文案（`plugins/dsh-market/lib/client.js:35-78, 543-584`）：

| 调用 | 超时 | 失败时界面显示 |
|---|---|---|
| `fetchCatalog()` | 6000 ms | HTTP 非 2xx → `壳返回 HTTP <status>`；JSON `ok !== true` → 其 `error` 或 `目录格式不正确`；`fetch` 抛错 → `桌面壳未响应（市场目录由壳供给）` |
| `fetchPreflight()` | 6000 ms | 静默失败（返回 `null`，只是不显示"缺 pnpm"提示） |
| `openDownload()` | 10000 ms | `桌面壳未响应` 或 `返回内容不是 JSON` |
| `installEntry()` | **不设超时**（装包分钟级） | `<error>（失败于：<stage>）` |

`/api/market/open-download` 与 `/api/market/install` 的失败文案（壳侧，`main.mjs:1242-1300`）：
`目录里没有 id=<id> 的条目`、`「<name>」还没有下载地址（该条目没挂下载包）`、`拒绝打开非 https 地址：<url>`、
`已有一次安装正在进行，请等它结束`（`marketInstalling` 单飞闸门）、`headless/smoke 模式不执行安装`。

---

## 5. `catalog.json` 的完整格式

**这是后人自己造一份目录所需的全部信息**，逐条对应 `main.mjs:1158-1237` 的读取实现。
样例见 `desktop-electron/src/market-catalog.json`（105 行，两条插件 + 一条美化包，全是占位/真实混合）。

### 5.1 顶层字段

| 字段 | 类型 | 必填 | 壳怎么处理 |
|---|---|---|---|
| `schema` | number | 否 | 原样回显；非数字 → `0`。客户端不用它 |
| `updatedAt` | 非空字符串 | 否 | 原样回显；脚注显示前 10 个字符（`client.js:714`）。ISO 时间串即可 |
| `plugins` | array | 否 | 插件页。缺/非数组 → `[]` |
| `themes` | array | 否 | 美化包页。缺/非数组 → `[]` |
| `_说明` | array of string | 否 | **壳完全不读**。随包样例用它写格式说明与上架流程，纯给人看 |
| 其它字段 | — | 否 | 忽略 |

- JSON 必须能 `JSON.parse` 且是对象，否则视为"这份不可读"并回退到下一来源；BOM 会被剥掉（`main.mjs:1161`）。
- 全份 JSON 解析失败**不会**让接口失败，只要有另一份可读；两份都不可读才回 `{ok:false,error:'市场目录不可读'}`。

### 5.2 条目字段

**硬判据（违反任一条，整条被丢弃并计入 `dropped`，不报错、不显示）：**

| 字段 | 判据 |
|---|---|
| `id` | 非空字符串；**同一页内不得重复**（`seen` 集合按页各自独立，插件与美化包可以同名） |
| `name` | 非空字符串 |
| `source` | 非空字符串且必须 `^https://`（http 会被丢，不是降级） |
| `download.url` | 可不给；给了必须是 `""` 或 `https://…` |
| `download.sha256` | 可不给；给了必须是 `""` 或 64 位十六进制（大小写均可，壳不改大小写） |

**软字段（缺失或类型不对 → 用默认值，条目不丢）：**

| 字段 | 默认 | 语义 / 界面用途 |
|---|---|---|
| `summary` | `''` | 卡片摘要（一行小字） |
| `author` | `''` | 卡片元信息；空则显示"未知作者" |
| `version` | `''` | 卡片上的 `v<version>` 标签；空则不显示 |
| `icon` | `plugins` → `📦`；`themes` → `🎨` | 卡片左侧图标（emoji 或短文本） |
| `homepage` | `''` | 必须是 https 才保留（http 静默丢弃）；与 `source` **规范化后实质不同**时才在卡片上多给一个「主页」按钮（`client.js:259-274` 的 `isDistinctUrl`：去协议/`www.`/锚点/查询串/尾斜杠/`.git` 后比较，同仓库子路径算同一个） |
| `tags` | `[]` | 字符串数组，滤掉空值，**最多 6 个**；卡片上以 ` / ` 连接显示 |
| `install` | `{spec:'', steps:''}` | 见 5.3 |
| `reviewed` | `null` | 见 5.4 |
| `disclosure` | `{notes:[],warnings:[]}` | 字符串数组，各滤空、**各最多 10 条**；确认面板与「安装方法」页逐条显示，"注意"用警示色块 |
| `download.immutable` | — | 严格 `=== true` 才算；**输出到响应条目的顶层** `immutable`，不在 `download` 里 |
| `download.bytes` | `0` | 仅 `Number.isFinite` 才保留；客户端不读 |

### 5.3 `install` —— 真正决定能不能一键装

| 形态 | 解析结果 |
|---|---|
| `install: { spec, steps }` | `spec` = 安装坐标（喂给 `dsh plugin add`），`steps` = 给人看的说明文字 |
| `install: "一段文字"` | 整串当作 `steps`，`spec` 为 `''`（旧格式兼容） |

- `steps` 在「安装方法」子页以等宽块原样显示，支持 `\n`。
- `spec` 的形状在安装时另行校验（`market-install-official.mjs:14-32`）：npm 精确版本 / `@scope/name@ver` / `github:owner/repo#<40 位 commit>` / `https://….tgz`；
  含空白、`http://`、非 `.tgz` 的 https、`github:` 未钉 commit —— 一律 `stage: 'validate'` 拒装。
- CI 口径：随包样例里**每条**都必须有非空 `install.steps`（`desktop-electron/scripts/ci-self-test.mjs:250-254`）。

### 5.4 `reviewed` / `disclosure`

```json
"reviewed": { "at": "2026-09-17", "verdict": "pass", "spec": "dsh-whale-widget@0.3.2", "record": "docs/项目/审核记录/dsh-whale-widget.md" },
"disclosure": { "notes": ["…"], "warnings": ["…"] }
```

- `reviewed` 只有在 `reviewed.at` 是非空字符串时才成立，否则整块变 `null`；`verdict` / `spec` / `record` 各自非空字符串才保留。
- 界面：卡片上是绿色「已审核 <at>」或灰色「未审核」；确认面板里无审核记录时是**红色警告**（"装之前请自行核对来源与代码"）；
  「安装方法」子页显示 `at / verdict / spec`。审核**不是**安全审查（口径见 `docs/项目/计划/DSH市场审核标准.md`）。

### 5.5 目录从哪来（两级，本地文件，无网络）

| 优先级 | 路径 | `source` 字段 | 说明 |
|---|---|---|---|
| 1 | `$DSH_HOME\market\catalog.json` | `"user"` | 用户/离线覆盖。本机存在，内容与随包样例一致（本次逐行核对） |
| 2 | `<resources>\market-catalog.json` | `"bundled"` | 随包样例。打包态 = `resources/`（`electron-builder.yml:42-43`）；**开发态 `RES` 是 `desktop-electron/`，该路径下没有这个文件** ⇒ 源码态只有用户覆盖那份生效 |

- 界面的脚注据此显示「目录来源：用户目录覆盖」或「目录来源：随包内置样例」，后面接 `updatedAt` 前 10 字符（`client.js:713-714`）。
- ⚠️ **没有远端目录**：样例 `_说明` 里写的"将来由独立仓库托管、客户端从 GitHub Pages 取同名 JSON"**尚未实现**，
  代码里只有上面两级本地读取。要做远端，见 §8。

### 5.6 条目样例

真实（`desktop-electron/src/market-catalog.json:28-61`，删去说明性文字）：

```json
{
  "id": "dsh-whale-widget",
  "name": "余额小鲸鱼挂件",
  "summary": "Web 界面右下角的 DeepSeek 余额挂件：……",
  "author": "MeteorNOX",
  "icon": "🐋",
  "source": "https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget",
  "version": "0.3.2",
  "tags": ["余额", "用量", "外观", "挂件"],
  "reviewed": { "at": "2026-09-17", "verdict": "pass", "spec": "dsh-whale-widget@0.3.2", "record": "docs/项目/审核记录/dsh-whale-widget.md" },
  "disclosure": { "notes": ["…"], "warnings": ["界面会多出右下角挂件，且自带音效（可在挂件设置里关）。"] },
  "install": { "spec": "dsh-whale-widget@0.3.2", "steps": "已发布 npm ⇒ 走官方机制安装，**不触发任何构建脚本**：\n  dsh plugin --profile web add dsh-whale-widget@0.3.2\n…" },
  "download": { "url": "https://www.npmjs.com/package/dsh-whale-widget", "sha256": "", "bytes": 0, "immutable": false }
}
```

最小可用（自己造目录时照这个抄；`download` 整块可以不给）：

```json
{
  "schema": 1,
  "updatedAt": "2026-09-16T00:00:00Z",
  "plugins": [
    {
      "id": "dsh-hello-plugin",
      "name": "示例插件",
      "summary": "一句话说明它干什么。",
      "author": "someone",
      "source": "https://github.com/someone/dsh-hello-plugin",
      "version": "1.0.0",
      "install": { "spec": "dsh-hello-plugin@1.0.0", "steps": "npm 包 ⇒ dsh plugin add dsh-hello-plugin@1.0.0" }
    }
  ],
  "themes": []
}
```

⚠️ 但这样造出来的条目，界面上的「安装」按钮是**灰的** —— 见下条。

### 5.7 一个必须知道的坑：按钮判据 ≠ 安装判据

| | 判据 | 代码 |
|---|---|---|
| 卡片上「安装」按钮可点 | `download.url` 非空 **且** `download.sha256` 非空（变量名 `pinned`） | `client.js:278-281, 353-363` |
| 真正安装吃什么 | **只吃 `install.spec`**；`download` 完全不参与 | `market-install-official.mjs:14-32` |

⇒ 要让「一键安装」可用，条目的 `install.spec` 与 `download.sha256` **两个都得有**（`sha256` 目前只作按钮开关用，
现行安装链路并不校验它）。随包样例的 `sha256` 全为空 ⇒ 样例条目一律带「无下载包」标签、安装按钮灰，
连有合法 `spec` 的 `dsh-whale-widget` 也点不动（这是当前状态，不是配置错误）。

---

## 6. 安装链路：分档与判据

### 6.1 现行链路（`POST /api/market/install`）—— 官方机制

链路：读目录 → 按 id 找条目 → 单飞闸门 → 解析 pnpm（与 `/preflight` **共用同一份缓存结果**）→
`<dshBin> plugin --profile web add <spec>`（cwd = profile 目录，env 注入 pnpm PATH / `DSH_HOME` / `ELECTRON_RUN_AS_NODE=1`）
→ 按退出码与输出分档 → **回读 profile 的 `package.json` 核对痕迹**。

| `stage` | 触发条件 | 用户看到什么 |
|---|---|---|
| `validate` | 缺 `dshBin`/`profile`/`spawnSync`；`install.spec` 为空、含空白、`http://`、非 `.tgz` 的 https、`github:` 未钉 40 位 commit、形状不认识 | 坐标形状错误的具体说明 |
| `pnpm` | pnpm 不可用（与体检同一判据）；dsh 退出码 **127**（`pnpm not found on PATH`）；其它非 0 退出码 | 退出码 + `hint`（`pnpmHint()`：`npm i -g pnpm` / `corepack enable` / 装好后重启应用 / 看后台日志的 `pnpm 解析` 行） |
| `spawn` | `spawnSync` 抛异常、运行时或 CLI 不存在（ENOENT）、其它 spawn 错误 | 错误原文 |
| `timeout` | `ETIMEDOUT`（默认 10 分钟） | "网络慢或包很大"，附已捕获输出 |
| `build-script` | 输出命中 `allowBuilds` / `blocked build scripts` / `Ignored build scripts` / `prepare` | 明说"这等于允许它在安装时执行代码"，要求用户自己把 pnpm 打印的包键写进 profile 的 `pnpm-workspace.yaml` 后重试——**插件不替你点这个授权** |
| `verify` | 退出码 0，但 profile 的 `dependencies` 里没有该依赖键、且 `dsh.profile.bundles` 为空 | "安装可能没真正落地"（**不许假成功**，这条由自检专门钉住） |
| 成功 | 命中 `dependencies` 或 `bundles` 任一 | `{ok:true, spec, kind, bundleAdded, inDependencies, needsRestart:true, notes}`；界面提示"请重启 dshdt（或托盘「重启宿主」）后生效" |

补充事实：`kind` 分 `registry` / `github` / `tarball`；依赖键由 `manifestKeyOf()` 从坐标推算（tarball 推不出，返回空串则不做强判）；
**现行链路里没有"撞自带插件名"这道判据**（那条只在 §6.2 的备用链路里）。

### 6.2 备用链路（`market-install.mjs` + `zip-safe.mjs`）—— ⚠️ 当前未接线

**它在仓库里、有 57 条夹具护着，但壳已经不调它了**：

- `installMarketEntry` 全仓只有 `desktop-electron/scripts/market-install-self-test.mjs` 引用；
- `desktop-electron/src/main.mjs` 只 `import { installMarketEntryOfficial, pnpmHint }`（`main.mjs:20`）；
- `desktop-electron/scripts/ci-self-test.mjs:296-298` 有断言："安装不再由壳自己下载解包（`marketInstall` 里没有下载/解包/落盘）"。

保留理由是它比官方链路多两样东西：**sha256 强校验**与**自实现的安全解包判据**。将来要用（比如换掉 pnpm、或做离线包），按它的分档接回去：

| `stage` | 判据（以代码为准） |
|---|---|
| `validate` | 条目不是对象 / 缺 `id` / `id` 不匹配 `^[a-z0-9][a-z0-9._-]*$` / `id` 撞自带三插件（`dsh-desktop-ui`、`dsh-auto-approval`、`dsh-market`） / 无 `download.url` / 地址非 https / `sha256` 不是 64 位十六进制 / 内部装配缺 `mount` 或 `removeTree` |
| `download` | `httpDownload()`：**只接受 https**；重定向**跟随后仍需 https**（否则拒绝）；60 s 超时；`content-length` 或实收字节 **> 64 MiB** 即拒；HTTP 非 2xx 报状态码 |
| `verify` | 下载内容的 sha256 ≠ 条目里的 sha256 → **拒绝安装**（"可能是作者改动了内容或链接指向变了——请让维护者重新审核该条目"） |
| `extract` | 解包到临时目录 `.tmp-install-<id>-<36 进制时间戳>`；`extractZipSafe` 任一判据不过即整体失败（见下） |
| `shape` | 没有 `package.json` / 不是合法 JSON / 无 `name` / `package.json` 的 `name` ≠ 条目 `id`（"挂载行会挂到一个不存在的模块上"） |
| `stage` | 目标目录 `node_modules/<id>` **已存在** → 拒绝覆盖（不静默替换用户自己那份）；`renameSync` 失败 |
| `mount` | 包已落盘但写挂载行抛错 → `{ok:false, stage:'mount'}`，**不删包**，如实报出 |

**落位**：同卷 `fs.renameSync(staging, target)`（原子）。
**回滚**：任何 early return 都落在同一个 `try` 内，`finally` 里把没 rename 成功的临时目录用 `removeTree` 删掉
（"留半个包比没装更糟"）；自检对**每条**失败分支都断言"目标目录不存在且无 `.tmp-install-*` 残留"。

解包安全判据（`zip-safe.mjs`，自实现，零依赖，只支持 store/deflate）：

| 判据 | 处理 |
|---|---|
| 条目名含 `..`、反斜杠、前导 `/`、盘符、`:`（ADS/盘符歧义）、NUL 字节、指向目录自身 | 拒绝整包 |
| 先规范化再比前缀（顺序反了会被 `a/../..` 绕过） | 规范化后仍在目标根之外 → 拒绝整包 |
| zip64 占位值（`0xffff` / `0xffffffff`） | 拒绝 |
| 中央目录越界、签名不对、条目越界、EOCD 找不到、文件 < 22 字节 | 拒绝 |
| 压缩方式非 0/8（含加密） | 拒绝，不静默跳过 |
| 没有任何文件（只有目录条目） | 拒绝 |
| 包内只有唯一顶层目录且所有条目都带 `/` | 自动剥掉该层（`stripped`），多顶层则不剥 |
| 任一条目不合法 | **整体失败**，不做"跳过坏条目" |

### 6.3 两条链路的差异

| 维度 | 现行（官方机制） | 备用（自包含 zip） |
|---|---|---|
| 依赖解析 / 锁版本 | ✅ pnpm 做 | ❌ 完全不做（这也是当年把它降级的原因：真实插件几乎都 import 第三方库） |
| 内容校验 | ❌ 不校验下载内容（`download.sha256` 只当按钮开关） | ✅ sha256 强校验 |
| 构建脚本 | pnpm 拦截并要求**用户显式授权**（`build-script` 档） | 不执行任何脚本 |
| 自带插件保护 | ❌ 无判据 | ✅ `id` 撞三个自带插件即拒 |
| 网络 | pnpm（registry / git / tarball） | 单文件 https + 跟随重定向 |
| 失败粒度 | 7 档（含"退出码 0 但无痕迹"的 `verify`） | 7 档（含"不留半成品"的回滚） |

---

## 7. 客户端 UI 契约（改动前先读这一节）

| 项 | 值 | 锚点 |
|---|---|---|
| 装载入口 | `window.__ModuleLoader__.load({ id: "dsh-market", factory })`；**id 必须等于包目录名**（自检断言） | `client.js:4-6` |
| 依赖注入 | `package.json` 的 `dsh.client.inject = ["@deepseek-ai/dsh-client-ui-sidebar"]`、`platform: "web"`；`exports` 必须有 `./client` | `package.json` |
| 插件面 | `exports.inject = ["slots"]`；`apply(ctx)` 里用 `ctx.slots.inject("sidebar.footer.action", …)` 再 `ctx.slots.register({ name, id: "market", locale: undefined, label: () => "市场" }, MarketEntry)` | `client.js:757-767` |
| 插槽形态 | `sidebar.footer.action` 是 **list 型**（官方 cordis 面板也占这一格）⇒ 只能**追加**自己那一项；入口组件收 `props.wide`，窄栏时只留图标 | `client.js:725-755, 759` |
| 图标 | `primitives.IconArchiveOutline20`（入口）、`primitives.IconCloseOutline16`（关闭） | `client.js:676, 748` |
| 弹窗 | **自绘遮罩**（不用官方 Modal），`role="dialog"`，左右两栏：左栏 188px 导航，右栏右上是唯一的 ×；Esc / 点遮罩 / × 三种关闭；固定宽 800px、高 `min(800px, 100vh-48px)` | `client.js:94-113, 505-521, 605-613` |
| 样式 | 全部走官方 CSS 变量（`--dsw-*`）；hover/active 用注入的 `<style data-plugin="dsh-market">`（行内样式压不住伪类），卸载时移除；DOM 类名 `dsh-market-*` | `client.js:80-252, 769-781` |
| 目录数据 | 只在弹窗打开时拉一次（`useEffect` 依赖 `open`），失败后靠重开弹窗重试 | `client.js:522-541` |

### 已知不一致（改代码时顺手修，别当成配置问题）

| # | 现象 | 依据 |
|---|---|---|
| ① | 页面标题 `<h3>` 引用了 `css.contentTitle`，但样式表里**没有这个键** ⇒ 标题走浏览器默认样式 | `client.js:692` 有引用，`css` 对象里无定义 |
| ② | 「固定版本」标签读 `entry.download.immutable`，而壳把它放在响应条目**顶层** ⇒ 这个标签**永远不会出现** | 客户端 `client.js:298` vs 壳 `main.mjs:1221-1223` |
| ③ | 「安装」按钮判据是 `download.url` + `download.sha256`，实际安装只吃 `install.spec` ⇒ 样例条目按钮全灰 | 见 §5.7 |

---

## 8. ⚠️ 耦合与限制：要替换哪些接口、哪些能力会失效

| 复用目标 | 要动的地方 | 会失效的能力 |
|---|---|---|
| **装进官方桌面端 / 任何非 dshdt 宿主** | 无壳实现可换 —— 必须在目标宿主上**新写这 4 个端点**（或改客户端的数据层） | 目录、下载交接、一键安装**全部失效**（弹窗还能开、还能报"壳未响应"） |
| 换目录来源（远端 JSON / 打包内置 / 常量） | `fetchCatalog()` 的 URL 与响应契约（`{ok, schema, updatedAt, source, plugins, themes}`） | 脚注的"目录来源/更新时间"要一起改；`dropped` 的丢弃计数会没有 |
| 不想要"壳内安装" | 只保留 `/api/market/catalog` + `/api/market/open-download`，删掉安装按钮分支 | 一键安装、「安装方法」子页里的坐标语义变纯说明 |
| 换安装器（不用 `dsh plugin add`） | `/api/market/install` 的返回契约：客户端只读 `{ok, notes[], error, stage}` | `stage` 分档文案会失真；`needsRestart` 语义要自己保证 |
| 换宿主 / 端口 | `client.js:14` 的 `ADMIN` 常量（**硬编码**，无配置项） | 壳端口被占用回退系统分配时，市场静默失联 |
| 换侧栏插槽或官方端 UI 版本变了 | `slots.inject` / `slots.register` 的 `name` + `id`，以及 `dsh.client.inject` 列表 | 入口**静默不出现**（没有任何报错） |
| 只想要这套两页目录 UI | 保留 `client.js` 全部渲染，把 4 个调用换成一个 `fetch` | 下载与安装；审核标记/披露项仍可用（纯展示字段） |

一句话：**耦合点是"目录数据 + 下载交接 + 安装"这三件事，全部经 `http://127.0.0.1:25439` 的壳 admin API；
壳不在，这个插件就只剩一个会说"桌面壳未响应"的空弹窗。**

---

## 9. 相关文档（口径来源）

| 文档 | 内容 |
|---|---|
| `plugins/README.md` | 三个自研插件的总览、统一安装位与"改完要重算 `components.json`"的纪律 |
| `docs/项目/计划/DSH市场计划书.md` | 壳的边界（"壳不安装任何东西"）、目录两级来源、pnpm 前置体检的由来 |
| `docs/项目/计划/DSH市场审核标准.md` | 上架审核判据（R/B 档）、"审核 ≠ 安全审查" |
| `docs/项目/审核记录/` | 每个已审条目一份记录（`catalog.json` 的 `reviewed.record` 指向这里） |
| `docs/项目/02-架构与铁律.md:58-61` | 本插件与三条安装链路（官方主路径 / 备用自包含路径）在架构里的定位 |
| `plugins/dsh-auto-approval/README.md` | 同批插件的 README 版式（本文与它对齐） |

---

## 10. 未验证事项（本次只做了源码与只读目录核对，没有真装、没有真点）

| # | 未验证的事 | 已知的部分 |
|---|---|---|
| ① | 手工拷进官方桌面端后，侧栏入口与弹窗是否真的出现并渲染 | 静态契约齐备（`dsh.client` + insert 行 + `exports["./client"]`），但没有实机装过 |
| ② | 官方桌面端 0.2.x 是否仍提供 `sidebar.footer.action` 插槽与 `@deepseek-ai/dsh-client-ui-sidebar` 的注入面 | 本机官方端为 0.2.0-rc.2（`official-shell/dsh-desktop-host/package.json`），客户端包版本未逐一核对 |
| ③ | 官方 CLI 对**只声明 `dsh.client`**（无 `dsh.bundle`）的包，是否会写 `dsh.profile.bundles` 或自动补挂载行 | 就代码看：`bundleAdded` 只在 manifest 有 bundles 时为真，挂载行仍需自己写（`market-install-official.mjs:130,134-137`） |
| ④ | 官方桌面端"插件管理"入口的确切位置与命令名 | 只确认到：官方 CLI 用自带 pnpm 且 `manageDesktopProfile: true`；恢复入口有"禁用第三方插件、备份 profile patch 并重启"（`official-shell/app-lib/main.js:6550,6717`） |
| ⑤ | 本机 `profiles/desktop` 里的 `dsh-plugin-wallpaper-engine` 是否经官方 CLI/市场装入 | 只能从 `package.json`（dependencies + bundles）与 `pnpm-workspace.yaml`（`minimumReleaseAgeExclude`）的痕迹推断 |
| ⑥ | 官方桌面端是否存在"也加载 `profiles/web`"的开关 | 按 `official-shell/` 的代码与本机目录状态，官方端的 profile 是 `desktop`；若另有开关，本次未发现 |
| ⑦ | 官方桌面端主题变量集（`--dsw-*`）下弹窗的观感 | 本插件全部用官方令牌，理论上跟随深浅主题；未实机截图核对 |
| ⑧ | 备用链路（`market-install.mjs`）将来是否重新接线 | 当前**未接线**是代码事实（§6.2），属有意保留的能力 |
