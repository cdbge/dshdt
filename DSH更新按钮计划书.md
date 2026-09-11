# DSH 更新按钮计划书（dshdt 内置 DSH 更新）

> 配套文档：《代码规范与范例.md》（硬约束）、《开发注意事项与命名规则.md》、《Electron施工计划与进度.md》（唯一进度事实源）。
> 本计划书只覆盖**第一阶段：DSH（harness）更新**。**壳自更新（dshdt 自身）不在本阶段**，见 §11。

---

## 0. 术语与两个更新平面（先分清，否则会做错）

本项目里「更新」有两个**完全独立**的平面，二者不可混为一谈：

| 平面 | 更新的对象 | 现状 | 本阶段 |
|---|---|---|---|
| **A. DSH 更新** | harness 运行时（`vendor/profile` 里的 `@deepseek-ai/dsh` + `dsh-base` + `dsh-web-app`） | 手工按坑 17 换树 | ✅ **本期实现** |
| **B. 壳自更新（dshdt）** | DSH Desktop 自身（`app.asar` + exe + 安装包） | `main.mjs:847 initUpdater()` 已就位，`HAS_UPDATE_SOURCE` 门控关闭 | ⏸ 待 GitHub（用户已定：上传仓库后再做） |

**本阶段做 A。** 两者共用的只有「重启/换树」这一小段机械动作；B 走 `electron-updater` + GitHub Releases 差分更新，A 走本地 npm 重建 + 原地换树。**不要把 A 实现成 `autoUpdater` 的调用**，那是 B 的地盘。

---

## 1. 现状锚点（开工前先核对，变了要先同步）

引自《代码规范与范例.md》§0，若与仓库实际不一致以仓库为准：

- 版本 **0.4.6**（**铁律 7：未经用户允许不得推进版本号**）
- DSH 依赖锁 **`0.1.0-rc.8`**（`scripts/build-host.mjs:16 VERSIONS`，`vendor/vendor.lock.json` 同源）
- 门禁基线：语法 OK / repair 8/8 / admin-bg 7/7 / 插件自检 10+12 / smoke **40/40**
- `vendor/profile` = **122.5 MB / 15208 文件**（`vendor.lock.json` 实测值）
- 已装应用 = 0.4.6 asar + rc.8 vendor + 两个自带插件（`dsh-desktop-ui` / `dsh-auto-approval`）
- git HEAD：`395f0cc`，工作树干净

---

## 2. 目标与非目标

### 2.1 目标

在「壳设置 → 桌面」section（以及托盘菜单）提供一个**按钮**，让用户在不重装应用、不手工敲命令的前提下完成：

1. 查询 npm registry 上 `@deepseek-ai/*` 的最新可用版本；
2. 与当前 vendor 实际版本比对，明确告知「有新版本 / 已是最新 / 查询失败」；
3. 一键构建新版本 vendor 到**暂存区**（不碰正在使用的 `vendor/profile`）；
4. 构建通过 ABI 门禁后，**由用户确认**重启并应用；
5. 应用失败时**可回滚**到旧 vendor。

### 2.2 非目标（本阶段明确不做）

- ❌ 壳自更新（平面 B，等 GitHub）
- ❌ 自动静默更新（**必须由用户点击触发**，见 §8）
- ❌ 多版本并存 / 版本切换器（只保留 1 份回滚备份）
- ❌ 跨 DSH 大版本（rc→正式版）的自动迁移承诺——只做「构建 + 门禁 + 换树」，语义变更由门禁拦截而非猜测

---

## 3. 关键设计决策（本方案的三个真正难点）

### 3.1 难点一：打包态没有 npm

`scripts/build-host.mjs` 的 `resolveNpm()` 从 `dirname(process.execPath)/node_modules/npm/bin/npm-cli.js` 推导 npm。开发态 `process.execPath` 是系统 Node，成立；**打包态 `process.execPath` 是 `DSH Desktop.exe`，旁边没有 npm**，此路不通。

三条候选路线：

| 路线 | 做法 | 优点 | 代价 | 结论 |
|---|---|---|---|---|
| **B. 复用系统 Node/npm** | 按 `findDshBin`（`src/host.mjs:12`）同款多锚点探测系统 npm | 零体积增量；**与本项目既有假设一致**——`findDshBin` 本来就优先找全局 npm 安装与 npx 缓存，说明目标用户几乎必有 Node | 无 Node 的机器不可用（按钮置灰 + 明确提示） | ✅ **本期采用** |
| C. 预编译 vendor 归档 | 下载 GitHub Releases 上的 `vendor-<ver>.zip` | 更新最快（无需依赖解析）、客户端最简 | **依赖平面 B 的 GitHub 仓库先就位** | ⏸ 阶段二接入，接口本期预留 |
| A. 随包内置 npm | `extraResources` 带一份 npm | 无 Node 也能用 | **坑 06：安装速度 ∝ 文件数**，npm 数千文件会显著拖慢安装；且需绕开坑 07（`from` 不能以 `node_modules` 为根） | ❌ 本期不做，仅在用户反馈「无 Node 机器」时再评估 |

**决策（Q2 已定：不内置 npm）**：本期实现 **B**，并把「vendor 来源」抽象成可替换的 `source`，使阶段二的 **C** 只是新增一个 source 实现，而不是重写引擎。**路线 A 本期不考虑**——探测不到系统 npm 时按钮置灰并给出安装指引，不做静默降级。

> 探测顺序（沿用 `findDshBin` 的锚点集合，命名与注释保持同款）：
> `DSH_NPM` 环境变量 > `where node` 推导 > `%ProgramFiles%\nodejs` > `%APPDATA%\npm` > npx 缓存 > `dirname(process.execPath)`。

### 3.2 难点二：换树时机（坑 17 的硬约束）

坑 17 已实证：**换 harness 必须先退出应用**——宿主进程映射着 vendor 里的 `*.node`，直接覆盖会失败/损坏。

本方案**绝不在运行中就地改写 `vendor/profile`**。采用两段式：

```
[构建期] npm install → 暂存区 staging/vendor-<ver>/ → 剪枝 → ABI 门禁 → 启动冒烟
              ↓ 全部通过才写 marker
[应用期] 用户点「重启并应用」→ 写 pending marker → app.relaunch() + app.exit()
              ↓ 新进程 main() 最早期（bootHost 之前）
         rename 交换目录（正在运行的旧进程已退出，无锁）→ 删旧 → 清 marker → 正常启动
```

**为什么用「下次启动应用」而不是「外挂 detached 应用器」**：外挂应用器需要等待本进程完全退出、处理竞态、还要在失败时把用户救回来，复杂度与风险都高；而「启动前应用」把换树放在一个**没有任何 vendor 文件被打开**的时刻，等价于坑 17 的手工流程，且失败时应用根本不会启动到宿主阶段，天然可回滚。

> ⚠️ **实现陷阱（必须在写代码前知道）**：`src/main.mjs:50` 的 `const DSH_BIN = findDshBin([VENDOR_PROFILE])` 是**模块顶层常量，在 `import` 阶段就求值**，早于 `main()` 被调用。若把换树放在 `main()` 里，`DSH_BIN` 会指向**已被 rename 掉的旧路径**（vendor 命中分支时），宿主直接起不来。
> **正确落点**：换树必须在 `DSH_BIN` 求值**之前**执行——即放在 `src/early-errors.mjs` 之后、`src/main.mjs:50` 之前的模块顶部区域，或把 `DSH_BIN` 改为惰性求值（`let` + 首次使用前赋值）。**开工第一件事就是定这个落点并写进注释**，否则会得到一个「更新成功后应用再也起不来」的假象。

### 3.3 难点三：换树后自带插件会丢

`build-host.mjs` §3.5 把 `packages/dsh-desktop-ui` 与 `packages/dsh-auto-approval` **手工拷进** `vendor/profile/node_modules`（它们不在 npm 依赖里）。坑 17 也明确记着「回拷 `dsh-desktop-ui`」。

因此构建暂存树时**必须复刻 §3.5 这一步**，否则换树后设置面板的「桌面」section 与自动审批插件会同时消失（而且是在换树成功之后才发现，代价高）。

**做法**：把 §3.5 抽成可复用函数（`syncVendorPlugins(profileDir)`），`build-host.mjs` 与更新引擎共用一份实现，**禁止两处各写一遍**（规范 §25③ 的教训：改名后漏改调用点会直接让壳起不来）。

---

## 4. 架构与文件落点

严格遵循规范 §2 工程地图的职责划分；**新增纯 Node 模块以便离线单测**（与 `admin.mjs` / `repair.mjs` 同款姿态）。

| 文件 | 状态 | 职责 |
|---|---|---|
| `src/dsh-update.mjs` | 🆕 新增 | **纯 Node 更新引擎**（零 Electron 依赖，可单测）：版本查询与比较、staging 构建编排、marker 状态机、目录交换 |
| `src/admin.mjs` | ✏️ 修改 | 新增 `/api/dsh/*` 路由（沿用现有 `switch` 风格） |
| `src/main.mjs` | ✏️ 修改 | 装配 actions；`main()` 最早期调用 `applyPendingVendorUpdate()`；`statusPayload()` 增加更新字段 |
| `scripts/build-host.mjs` | ✏️ 修改 | 抽出 `syncVendorPlugins()` 共用；`VERSIONS` 改为可由参数覆盖 |
| `packages/dsh-desktop-ui/lib/client.js` | ✏️ 修改 | 「桌面」section 新增「DSH 版本」行 + 按钮 + 进度文案 |
| `scripts/update-self-test.mjs` | 🆕 新增 | 更新引擎离线单测（版本比较 / marker 状态机 / 路径校验） |
| `scripts/smoke.mjs` | ✏️ 修改 | 新增更新面断言（防回归） |

### 4.1 新增 admin API（命名遵循规范 §5：`/api/<小写名词>`，`diag/` 为既有命名空间先例）

| 方法 | 路径 | 语义 |
|---|---|---|
| `GET` | `/api/dsh/status` | 更新状态快照（当前版本 / 最新版本 / 阶段 / 进度 / 错误）——**幂等、无副作用、不联网** |
| `POST` | `/api/dsh/check` | 联网查询 registry 最新版本（超时短、失败即返回错误，不挂起） |
| `POST` | `/api/dsh/update` | 启动 staging 构建（异步；立即返回，进度靠 status 轮询） |
| `POST` | `/api/dsh/apply` | 写 marker 并重启应用以应用更新 |

> `statusPayload()` 内嵌一份精简版更新状态（`dshUpdate: {...}`），使客户端**一次轮询拿全**，与现有 5 秒轮询机制复用，而非新增轮询。

---

## 5. 端到端流程

```
① 查最新版本    GET registry.npmmirror.com/@deepseek-ai/dsh  →  semver 取最高（含 prerelease）
② 比对          当前 = vendor/profile/node_modules/@deepseek-ai/dsh/package.json 的 version（真实值，非 lock 缓存）
③ 构建暂存      APP_DATA/staging/vendor-<ver>/  ← 写 manifest → npm install --omit=dev --ignore-scripts
                → 剪枝 → syncVendorPlugins() → abi-scan 门禁 → 写 vendor.lock.json
④ 门禁失败      整体丢弃暂存区，保留现网 vendor，UI 明确报错（不发 marker）
⑤ 门禁通过      写 APP_DATA/pending-vendor.json { staging, target, from, createdAt }
⑥ 用户触发重启   按钮「重启并应用」→ app.relaunch() + app.exit()
⑦ 新进程早期     applyPendingVendorUpdate()：校验 → rename(staging → vendor/profile) → 清 marker → 继续 bootHost
                → 宿主就绪后删除旧树（仅删除时机，非回滚功能；见 §12 Q4）
⑧ 启动异常       不做自动回滚（Q4）；保留 marker 供诊断，app.log 给出「请用安装包重装」的明确指引
```

**关键不变量**：

- 任何一步失败，**现网 vendor 不变**（③④ 期间完全不触碰）。
- 只有 ABI 门禁 + 启动冒烟**双双通过**才允许发 marker。
- 换树动作是 **rename（同卷瞬时）**，不是复制 122 MB。

---

## 6. 代码范例（照规范 §5 体例）

### ① 更新引擎（`src/dsh-update.mjs`，纯 Node）

```js
// 版本比较必须自己实现：DSH 只发 prerelease（0.1.0-rc.8），
// 简单字符串比较会把 rc.9 判成小于 rc.8（'rc.9' < 'rc.8' 逐字符比较），
// 而 registry 的 dist-tags.latest 对纯 prerelease 包不可靠——直接取最高 semver。
export function compareVersions(a, b) { /* 主.次.修订 + prerelease 段逐段比较；返回 -1/0/1 */ }

/**
 * 构建暂存树。绝不写现网 vendor/profile（坑 17：宿主映射 *.node，运行中不可替换）。
 * @param {{target:string, stagingDir:string, appData:string, pluginSync:(p:string)=>void, log:(m:string)=>void}} o
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function buildStaging(o) { /* manifest → npm install → 剪枝 → pluginSync → abi 门禁 → lock */ }

/** marker 状态机（纯函数，便于离线单测）。 */
export function readPending(appData) { /* ... */ }
export function writePending(appData, payload) { /* ... */ }
```

### ② admin 路由（`src/admin.mjs`，沿用现有 switch）

```js
case '/api/dsh/status': return json(res, 200, actions.dshStatus())
case '/api/dsh/check': return json(res, 200, await actions.dshCheck())
case '/api/dsh/update': return json(res, 200, await actions.dshUpdate(String(body.version || '')))
case '/api/dsh/apply': return json(res, 200, await actions.dshApply())
case '/api/dsh/rollback': return json(res, 200, await actions.dshRollback())
```

### ③ 客户端设置行（`packages/dsh-desktop-ui/lib/client.js`）

```js
react.createElement("div", { style: css.row },
  react.createElement("div", { style: css.kv },
    react.createElement("span", { style: css.label }, "DSH 版本"),
    react.createElement("span", { style: css.hint }, st.dshUpdate?.hint || "—")),
  react.createElement("button", { style: css.button, className: "dsh-desktop-btn",
    onClick: async () => setMsgOk(await post("/api/dsh/check", {})) }, "检查更新"),
  react.createElement("button", { style: css.button, className: "dsh-desktop-btn",
    onClick: async () => setMsgOk(await post("/api/dsh/update", {})) }, "更新"),
  react.createElement("button", { style: css.button, className: "dsh-desktop-btn",
    onClick: async () => { await post("/api/dsh/apply", {}); } }, "重启并应用"))
```

> 构建是**分钟级**操作：按钮点击后立即返回，进度靠已有的 5 秒 `useAdminStatus()` 轮询回显，**不要用 `await post(...)` 等构建结束**（会撞 4 秒超时）。模态类（目录选择）才用 `timeoutMs=0`，构建不是模态。

### ④ 冒烟断言（`scripts/smoke.mjs`，防回归）

```js
const dshSt = await api(st.adminPort, '/api/dsh/status', {})
check('dsh/status 形状', dshSt.status === 200 && typeof dshSt.json.current === 'string')
check('dsh/status 不联网', dshSt.json.latest === undefined || dshSt.json.checked === false)
const dshUpd = await api(st.adminPort, '/api/dsh/update', { version: '0.0.0-nonexistent' })
check('dsh/update 拒绝非法版本', dshUpd.status === 200 && dshUpd.json.ok === false)
```

> 冒烟**不得联网、不得真构建**（CI/离线必须可重复）。真实构建走人工验收，不进 smoke。

### ⑤ 文档同步（同一次改动内完成，缺一不可）

见 §9。

---

## 7. 门禁与验证

严格按规范 §1.4 与 §6：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # 会话内跑 electron 前必做
node --check src\dsh-update.mjs src\main.mjs src\admin.mjs packages\dsh-desktop-ui\lib\client.js
node scripts\update-self-test.mjs     # 🆕 更新引擎离线单测（目标 ≥ 10 断言）
node scripts\repair-self-test.mjs     # 8 断言（未动 repair 也应保持绿）
node scripts\admin-bg-test.mjs        # 7 断言（动了 admin.mjs 必跑）
node scripts\smoke.mjs                # 全量 e2e（40 → 43+ 断言）
```

**额外的等价性验证（本方案的专属门禁）**：用同一份 `VERSIONS` 分别跑 `build-host.mjs` 与更新引擎的 `buildStaging()`，比对两棵树的**文件数与总字节数落在同一量级**（`vendor.lock.json` 已有这两个字段可直接用作基线）。这是防止「两处各写一遍安装逻辑」漂移的**唯一客观手段**（§3.3 的教训）。

---

## 8. 安全与回滚

| 风险 | 处置 |
|---|---|
| **静默更新**（用户不知情就被换掉运行时） | 铁律：更新**只能由用户点击触发**；不实现任何后台自动更新；不发遥测 |
| 供应链：registry 返回被投毒的包 | 默认锁定 `registry.npmmirror.com`；**版本必须是 registry 返回的精确版本**，不接受用户任意字符串（`/api/dsh/update` 校验 semver 白名单字符）；门禁不过不发 marker |
| 磁盘占用（每份 vendor 122 MB） | **不做备份**（Q4）：换树成功后即删旧树；暂存区构建完成后立即释放，峰值 = 现网 + 暂存 |
| 门禁过但实际起不来 | 无自动回滚（Q4）。→ 门禁双绿是**唯一防线**；失败时 `app.log` 明确指引「用安装包重装」 |
| 构建中断留下半个暂存区 | 发 marker 前校验暂存树完整性（存在 `node_modules/@deepseek-ai/dsh/lib/bin.js` + `vendor.lock.json`）；启动时发现残留暂存区一律清理 |
| **铁律 3 的边界** | 铁律 3 约束「打包 / asar 热更新」。**DSH 换树不属于二者**（坑 17 明确「换 harness 不必重打包壳」），但**它确实改写用户已装应用**。→ 见 §12 待决问题 Q1 |

---

## 9. 文档同步清单（规范 §5⑤，缺一不可）

- `CHANGELOG.md`：新增条目（**版本号待用户点名，见铁律 7**）
- `Electron施工计划与进度.md`：进度快照表加行 + 阶段小节（唯一进度事实源）
- `代码规范与范例.md`：§2 工程地图加 `src/dsh-update.mjs` 行；**§1.3 铁律 3 扩展「DSH 换树」（Q1 决定）**；§4 坑清单回填本期新坑（预计至少 3 条：registry prerelease 比较、rename 换树时序、`DSH_BIN` 顶层求值）
- `开发注意事项与命名规则.md`：坑清单同步（该文件 §3 末尾明确要求「新坑两边都要回填」）
- `DeepSeek-Harness桌面应用封装计划书.md`、`Electron构建安装包计划书.md`：能力表按需回填
- `README.md`：能力表同步
- `VERSION` / `package.json`：**不动**（铁律 7）

---

## 10. 分阶段实施与成本估算

| 阶段 | 内容 | 交付物 | Token | 时间 | 状态 |
|---|---|---|---|---|---|
| **S1** | 更新引擎骨架 + 版本查询/比较 + 离线单测 | `src/dsh-update.mjs` + `scripts/update-self-test.mjs` | 4–7 万 | 0.5 天 | ✅ **完成**（36 断言全绿） |
| **S2** | staging 构建编排（复用 build-host）+ `syncVendorPlugins` 抽取 | `build-host.mjs` 重构 + `dsh-update.mjs` 扩展 | 4–7 万 | 0.5 天 | ⬜ 未开始 |
| **S3** | admin 路由 + 主进程装配 + marker/换树/回滚 | `admin.mjs` + `main.mjs` | 4–7 万 | 0.5 天 | ⬜ 未开始 |
| **S4** | 客户端 UI 行 + 进度回显 + 托盘项 | `dsh-desktop-ui/lib/client.js` | 3–5 万 | 0.5 天 | ⬜ 未开始 |
| **S5** | 门禁：smoke 断言 + 等价性验证 + 文档同步 + 真实换树验收 | 全门禁绿 + 文档 | 3–6 万 | 0.5–1 天 | ⬜ 未开始 |
| | **合计** | | **18–32 万** | **2.5–4 天** | |

### S1 交付记录（2026-09-11）

- **新增** `src/dsh-update.mjs`：`parseVersion` / `compareVersions` / `pickHighestVersion` / `readCurrentVersions` / `npmCandidates` / `findNpm` / `fetchPackument` / `checkForUpdate`。纯 Node、零 Electron 依赖、不写文件、不起进程。
- **新增** `scripts/update-self-test.mjs`：**36 断言全绿**；全部通过注入 `fetchImpl` 与临时目录完成，**不联网**。
- **门禁**：`node --check` OK；`repair-self-test` 8/8、`admin-bg-test` 7/7 无回归。
- **S1 踩坑（已改正）**：单测夹具原本给"已安装版本"填 `9.9.9-rc.1`，导致 `hasUpdate` 断言恒为 false——**引擎是对的，是断言写错了**，正是规范 §24「把脚本 bug 当成产品缺陷上报」的复现。夹具已改为真实的 `0.1.0-rc.8`，并补了两条边界断言（"已是最新"与"本地比 registry 新"）。

**建议的止损点**：**S1+S2 完成后**（约 8–14 万 token、1 天）即可离线验证「能正确判断有没有新版本」「能构建出一棵等价于 build-host 的暂存树」，此时尚未触碰任何已装应用，**风险为零**。此时再决定是否继续 S3–S5。

**真实换树验收（S5）必须单独征得用户同意**——它会改写用户已装应用（§12 Q1）。

---

## 11. 与下一阶段（壳自更新 / GitHub）的衔接

本期**必须为下一阶段留好接缝**，否则将来要返工：

1. **`source` 抽象**：`buildStaging()` 的 vendor 来源做成可替换实现（`npm` / `archive`）。阶段二新增 `archive` source（从 GitHub Releases 下载预编译 vendor zip）即可，**不改引擎**。
2. **不占用 `autoUpdater`**：`initUpdater()` 与 `HAS_UPDATE_SOURCE` 属平面 B，本期零改动。
3. **UI 位置预留**：「桌面」section 的更新行按「DSH 版本」明确措辞，将来壳自更新行措辞为「壳版本」，两行并存不混淆（现有状态行已有「壳版本」，正好对称）。
4. **共用换树机械动作**：`applyPendingVendorUpdate()` 将来可被壳自更新复用（asar 需重启，同样套路），保持其为独立函数、不写死在 DSH 专用逻辑里。

---

## 12. 决策记录（用户 2026-09-11 已拍板）

| # | 问题 | **决定** | 对方案的影响 |
|---|---|---|---|
| **Q1** | DSH 换树的同意口径 | **换树必须征得用户同意** | 采用最保守口径：**开发/测试期每一次真实换树都要先获得用户明确同意**，绝不自行触发。正式使用中用户点击按钮即为同意，不额外弹二次确认。→ 需把该口径**写入《代码规范与范例.md》§1.3 铁律 3**（见 §9） |
| **Q2** | 无 Node 的机器 | **不内置 npm** | 锁定 §3.1 路线 **B**：复用系统 Node/npm；探测失败时按钮**置灰 + 明确提示**，不做静默失败。路线 A（随包内置 npm）**本期不考虑** |
| **Q3** | 默认 registry | **npmmirror** | `https://registry.npmmirror.com` 为默认；查询超时 3–5 秒，超时即明确报错（坑 05：npmjs.org 无代理会无限挂起） |
| **Q4** | 回滚备份 | **不做备份**（用户有安装包可重装） | **移除**备份、`/api/dsh/rollback`、自动回滚状态机、启动尝试计数。→ 风险后果转移：**marker 前置门禁成为唯一防线**，见 §8 |

### Q4 的连带后果（重要）

放弃回滚后，**「ABI 门禁 + 启动冒烟双绿才发 marker」从"最佳实践"升级为"唯一安全网"**。任何放宽这条的改动都等于把用户推向重装。具体纪律：

- 门禁未双绿 → **绝不发 marker**，暂存区整体丢弃，现网 vendor 一字不动；
- 门禁实现不得"降级放行"（如把 ABI 失败当警告）；
- 换树后若宿主未能就绪，`app.log` 必须给出**明确的「请用安装包重装」指引**，而不是让用户面对一个静默起不来的应用。

> 注：把旧树 `rename` 到 `vendor/profile.old` 再删，与直接删同价（rename 是瞬时、零拷贝）。因此「删除旧树」这一步放在**新树确认可用之后**执行，不额外花任何成本，也不需要任何回滚 UI——它只是删除时机，不是回滚功能。若用户连这一步也不要，删掉该行即可。

---

## 13. 附：本期预计新增的坑（占位，实测后回填规范 §4）

1. **prerelease 版本比较**：`0.1.0-rc.9` vs `0.1.0-rc.8` 不能按字符串比；`dist-tags.latest` 对纯 prerelease 包不可靠 → 取 packument 里最高 semver。
2. **rename 换树的时序**：必须在新进程、`bootHost()` 之前；且需处理 `vendor/profile.bak-*` 残留清理与同卷校验（跨卷 rename 会退化成复制）。
3. **`DSH_BIN` 顶层求值早于 `main()`**（`src/main.mjs:50`）：换树若放在 `main()` 内，模块顶层已把 `DSH_BIN` 钉在旧路径上 → 宿主起不来。换树落点必须在模块求值前（见 §3.2 实现陷阱）。
4. （待实测补充）

---

## 14. 收尾定义（DoD）

- [ ] 全部改动文件 `node --check` 通过
- [ ] `update-self-test.mjs` 全绿（≥10 断言）
- [ ] `repair-self-test.mjs` 8/8、`admin-bg-test.mjs` 7/7 未回归
- [ ] `smoke.mjs` 全绿（40 → 43+ 断言），且**不联网、不做真实构建**
- [ ] 等价性验证：暂存树与 `build-host` 树文件数/字节数同量级
- [ ] 真实换树人工验收（**Q1：须逐次征得用户同意**）：查版本 → 构建 → 应用 → 宿主正常启动 → 「桌面」section 与 `/approval` 插件均存活
- [ ] 无系统 npm 时按钮置灰路径已实测（Q2）
- [ ] §9 全部文档同步完成（含铁律 3 扩展）
- [ ] 一个 commit（规范 §7：`前缀: 中文动作（关键数字）`），**版本号未动**
