# dsh-auto-approval — AI 自检权限申请（Codex 式自动审批）

DSH 的审批原本只有两档会话策略：`ask`（每条都问）与 `never`（统统拒绝）。
本插件在 harness 的**审批瀑布**上插一层**风险分级**，让"该问的才问"：

```
模型发起需要审批的动作
        │
        ▼
approval/request 瀑布  ←── dsh-auto-approval 在这里分级
        │
        ├── 低风险 / 有界操作(medium) ──► 直接返回 'allowed-once'（放行，用户看不到弹窗）
        └── 高风险 / 判不准        ──► return next()，落到既有 answerer
```

**这是一个可独立复用的 Host 插件**：只依赖 DSH 本体的服务（`approval` / `settings` / 命令面 / 可选的 `llm`），
不依赖任何桌面壳的 admin API —— 所以它可以从壳里搬出来，装到别的 DSH 上。

包内文件：

| 文件 | 作用 |
|---|---|
| `lib/index.js` | Host 半身：审批裁决 + 设置 + `/approval` 命令（唯一有行为的部分） |
| `lib/client.js` | 浏览器半身：只给指令菜单里的 `/approval` 补一个图标（可选，纯装饰） |
| `test/grade-self-test.mjs` | 分级器纯函数自检（10 断言） |
| `test/apply-self-test.mjs` | 接线级自检：mock ctx 驱动 `apply()`（47 断言） |
| `package.json` | 包名 / `exports` / `dsh.client` 元数据（客户端半身的两个硬要求） |

## 快速导航

| 想干什么 | 去哪一节 |
|---|---|
| 看它为什么这么裁决（预筛 + 独立模型审查） | 一 |
| **装到别的 DSH 上（官方桌面端）** | 二 |
| **装到别的 DSH 上（自建 / `dsh web`）** | 三 |
| 看它挂了哪些扩展点、返回什么、fail-closed 边界、移植前提 | 四 |
| 改配置 / 已知的配置面问题 | 五 |
| 命令、生效方式、`{global,prepend}` 陷阱 | 六 / 七 / 八 |
| 自检、已知问题、未验证事项 | 十一 / 十二 / 十三 |

## 版本基线（写这份文档时）

| 项 | 值 | 来源 |
|---|---|---|
| DSH（harness 本体） | **0.1.7-rc.1**（`@deepseek-ai/dsh` / `dsh-base` / `dsh-web-app` 三包同版） | `desktop-electron\vendor\vendor.lock.json` |
| 已打包壳的 vendor 锁 | `vendor.lock.json`，`generatedAt=2026-09-24T13:17:57Z` | 同上 |
| Node | 22.21.0 | 同上 `runtime.node` |
| schemastery | **3.18.4**（`@deepseek-ai/schemastery`，只被 `dsh-settings` 以 peer 方式要求 `~3.18.4`） | vendor 树 `schemastery\package.json` |
| 自研壳版本 | `desktop-electron\VERSION`；自带插件表 `PROFILE_PLUGIN_NAMES` 见 `desktop-electron\src\main.mjs` | — |

> 插件的 `version` 是 `1.0.0`（`package.json`），**不随 harness 走**；harness 换版时按「实现契约」一节重新核对。
> 官方 DSH 桌面端的宿主包 `@deepseek-ai/dsh-desktop-host` 标 `0.2.0-rc.2`，但它依赖的 harness 仍然是 **0.1.7-rc.1**：
> 两套壳的内核契约是同一份（已核对 `dsh-settings` / `dsh-user-approval` / `dsh-tools` 的 `package.json` 版本）。

---

## 一、它怎么裁决：预筛 + **独立模型审查**（v2）

**为什么不是关键词表**：v1 是 17 行字符串匹配，它分不出这两种情况的区别 ——

```
Remove-Item -Recurse -Force   在 workspace 内 → 正常开发，该放
Remove-Item -Recurse -Force   在 C:\Windows 下 → 灾难，该拦
```

两者命中的是**同一个词**。所以关键词表**降级为"证据"**，最终裁决交给一次**独立的模型调用**：
全新上下文、只做一件事 —— 判该不该放。关键词命中会被原样喂给它，但不再直接判死。

裁决分三步（`approval/request` 到达后）：

| 步 | 条件 | 处理 |
|---|---|---|
| ① **快路** | 工具在 `lowRiskTools` **且**没有任何风险词命中 | 直接 `allowed-once`（**不花模型调用**） |
| ② **硬拦** | 工具在 `alwaysAskTools`、或请求没带 `reason` | `next()` 问用户（**永远不给模型放行权**） |
| ③ **模型审查** | 其余全部 | 一次独立模型调用；判 `allow` → `allowed-once`，否则 `next()` |

`enabled=false` 时整条链路第一条就退出（`next()`，完全不介入）。

### 审查器看到什么：**真实命令**，不只是理由

审批请求本身只有 `{agent, toolName, callId, reason, signal}` —— **没有 args**。而"只看理由"恰恰是最容易被误导的地方
（实测中模型自己抱怨过"理由与动作不匹配"）。所以插件额外做了一件事：

- 挂 `tools/pre-execute`（它在沙箱提权**之前**触发）记下 `callId → {name, arguments}`，
  存一张**上限 20 条**（`RECENT_CALL_LIMIT`）的小表；
- 审批到来时按 `callId` 取回，用 `summarizeArgs()` 压成有上限的可读文本：
  **喂给模型 1200 字、审计日志里留 300 字预览**。

于是审查输入里有四个字段（`buildReviewPrompt()` 用 JSON 包住，免得用户内容伪造结构）：

```json
{"tool":"pwsh","reason":"…智能体自述…","matchedRiskKeywords":["danger-full-access"],"command":"…真实参数…"}
```

系统提示（`REVIEW_SYSTEM`，判据写死在这里，改它就是改这个功能的判据）明确要求 **以 `command` 为准，与 `reason` 冲突时判 ask**；
取不到参数时会显式写 `(未取到该次调用的参数)`，免得模型误以为"命令为空"。

> 依据来自 Inspect 的 `ToolExecutionInput` 声明：`arguments: unknown` 就是那次调用的真实参数。

**模型从哪来：完全走本体配置。**
路由取自 `agentDefaultModel.currentSelection()`（也就是 profile 补丁层里的 `agent-default-model` 段），
凭据由 `ctx.llm` 用**本体的统一 Key**。插件**不配置、也不接触** provider / model / apiKey ——
本体换模型、换 Key，这里自动跟着换。

注意 `reviewWithLlm()` 只在 `sel.provider` 与 `sel.model` **同时非空**时才发调用，且只取回复里的 `text` 块
（推理块不计入裁决文本 —— 这正是下面那个事故的根因）。

**失败方向永远是"问用户"（fail-closed）**：没有 llm 服务 / 本体没配默认模型 / 调用超时 /
抛错 / 输出不是可解析的 JSON / 未知裁决 —— 一律 `ask`。审查器被关掉（`reviewerEnabled: false`）
或 `autoApproveUpTo: 'low'` 时，除快路外一律问用户，且**不发起任何模型调用**。

设计取舍：

1. **只做加法**：判不准就走 `next()`——失败方向永远是"问用户"，不是"放行"。
2. **一次一授权**：返回 `'allowed-once'`，与 DSH 语义一致，不做长期白名单。
3. **不干扰原生机制**：会话策略为 `never` 时 harness 自己就拒（**且在瀑布之前**）；`permissionPresets` 的两个旋钮照旧生效。
4. **可审计**：每条决策写 JSONL，含 `pre`（走哪条路）、`hits`（命中哪些词）、
   `ruleGrade`（v1 规则怎么看）、`verdict` / `model` / `verdictWhy`（模型怎么判）——
   事后可以直接对比"规则怎么想 / 模型怎么判"。`/approval why` 看最近几条。

### 已实测的分支行为（2026-09-12）

| 请求 | 裁决 | 结果 |
|---|---|---|
| `escalate sandbox to danger-full-access: 最终验收…` | `ask` · "理由与动作不匹配，意图存疑" | 弹卡片给用户 |
| `escalate sandbox to workspace-write: 在工作区内写一个临时文件…` | **`allow`** · "仅将沙箱提至工作区写，临时文件写入后即删，范围有界可逆" | **自动放行，零点击** |

第二行还顺带证明了 v2 的核心价值：那条 reason 里含"**提权**"二字（`hits:["提权"]`）——
**旧版规则会在这里硬拦**（命中词表 → `grade=high` → 问用户）；v2 里它**只是证据**，
模型读懂"范围有界可逆"就放行了。

> ⚠️ **注意请求面**：沙箱越宽，能触发的提权就越危险，模型也就越倾向 `ask`。
> 在 `workspace-write` 会话里唯一能升的是 `danger-full-access`，所以自动放行**本来就极少触发**；
> 沙箱收窄时（如 read-only）才有大量"有界提权"可以被放心放行。**别把"很少放行"当成插件坏了。**

---

## 二、装进官方 DSH 桌面端（0.2+）

> ⚠️ **先读这一条**：本节按 **0.1.7-rc.1 内核契约**写（官方桌面端 `dsh-desktop-host` 标 0.2.0-rc.2，但内核是 0.1.7-rc.1，已核对包版本）。
> 官方桌面端**没有**本仓壳那样的「把 `plugins/` 自动同步进 profile」逻辑，也没有 `PROFILE_PLUGIN_NAMES` 这张表 ——
> 那套是自研壳的，别指望它。下面的步骤是"手工把插件放到位"。

### 先认清目录

| 名字 | 官方桌面端的值 | 说明 |
|---|---|---|
| `$DSH_HOME` | `%USERPROFILE%\.dsh`（可用环境变量 `DSH_HOME` 覆盖） | 所有用户数据（会话 / 凭据 / 日志 / profile）的唯一根 |
| profile 名 | **`desktop`**（`DSH_PROFILE=desktop`，宿主以 `--profile desktop` 起） | 官方桌面端**自带**这个 profile；`dsh` CLI **拒绝**你手动 `--profile desktop`（`profile "desktop" is managed exclusively by the Electron application`） |
| profile 目录 | `%USERPROFILE%\.dsh\profiles\desktop\` | 第三方插件的落点就在这里 |
| 插件位 | `%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-auto-approval\`（本机是 `…\profiles\desktop\`；老文档写的 `…\profiles\web\` 是自研壳的 profile 名） | 该 profile 自己的 `node_modules`；实例：`dsh-plugin-wallpaper-engine` |
| 补丁层 | `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` | profile 用户层，最后叠加（`dsh.profile.bundles` 的层 → 这一层 → `--patch`） |
| 机器级补丁层 | `%USERPROFILE%\.dsh\cordis.patch.yml` | **home 层**：叠加在**每个** profile 的用户层之上；本机不存在，**本次未验证** |
| 模型配置 | profile 补丁层里的 `- id: agent-default-model` 段 | 审查器用的 provider/model 就从这里读 |
| 凭据 | `%USERPROFILE%\.dsh\.credentials.yaml` | 统一 Key；插件不碰 |

> 上面这一段里，`$DSH_HOME` / `profiles\desktop\` / 插件位 / 补丁层都**已在本机实读核对**（读的是只读目录 `C:\Users\31893\.dsh\profiles\desktop\`）；
> **home 层 `cordis.patch.yml` 未验证**（本机没有这个文件），用之前先 `dsh --profile <别的 profile> --dump-config` 看它有没有被叠加进去
> （不能拿 `desktop` 去 dump —— CLI 拒绝）。

### 放插件

```powershell
$prof = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
New-Item -ItemType Directory -Force -Path (Join-Path $prof 'node_modules') | Out-Null
# 把包目录整个拷进去（含 lib/ 与 package.json；test/ 可不拷）
robocopy 'D:\Desktop\deepseek\plugins\dsh-auto-approval' (Join-Path $prof 'node_modules\dsh-auto-approval') /E
```

拷完确认 `...\node_modules\dsh-auto-approval\package.json` 存在，且里面的 `main` 指向 `lib/index.js`。

> 官方 CLI 的等价做法是 `dsh plugin --profile <name> add <spec>`（转发给 pnpm，spec 可以是 registry / `github:owner/repo#<40位commit>` / `https://…/x.tgz`）。
> **官方桌面端的 `desktop` profile 不能这样装**（CLI 明确拒绝 `--profile desktop`），所以桌面端只能手工拷或用别的方式把包放进 profile 的 `node_modules`。
> 这条 CLI 形态有自测夹具（`desktop-electron\scripts\market-install-official-self-test.mjs`，含成功/失败分支），**但端到端装到官方桌面端未实测**。

### 挂载（`cordis.patch.yml` 的 `- insert:` 片段）

```yaml
# %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml
- insert:
    - id: dsh-auto-approval
      name: dsh-auto-approval
```

要点：

| 要点 | 说明 |
|---|---|
| `id` 与 `name` 都写包名 | `name` 是模块标识：加载器的 `baseUrl` 锚在 profile 的 `cordis.yml` 上，所以裸标识符从 `profiles\<profile>\node_modules\` 起解析（再往上是 `profiles\node_modules\`、安装树）；`id` 是这一行的唯一标识，设置面也按它认名字 |
| **不用**改 `package.json` 的 `dsh.profile.bundles` | 本包没有 `dsh.bundle` 元数据，不能当 bundle 层；`insert` 行是独立的加载器条目（本机 `profiles\web` 就是这个形态，已长期运行） |
| 别在同一份文件里同时留 `[]` 和顶层条目 | 那是两个 YAML 节点，宿主启动直接抛 `YAMLException`（壳里有自愈代码 `repairProfilePatchYaml()`，官方端没有） |
| 补丁层是**热加载**的 | 改这一层立刻生效；改 `lib/index.js`**不**生效（见「生效方式」） |

### 配置

**现状（以代码为准）**：插件的配置面目前在 0.1.7-rc.1 上**是坏的** —— 它调用 `settings.register('auto-approval', schema)`，
而这个版本里 `ctx.settings` **根本没有 `register()` 方法**（它只有 `configure` / `describe` / `update` / `replace` / `mutate`）。
后果：

1. 装载时抛 `settings.register is not a function` → 被 `try/catch` 兜住 → **回退到代码里的 `DEFAULTS`**；
2. 决策日志里那条 `plugin-loaded` 会写 `settings=settings.register 抛错：…`（**本机实测日志就是这个**）；
3. `/approval on|off` 报 `设置命名空间未注册（…），无法持久化开关`；设置面板里也不会出现这个命名空间；
4. 但审批本身**照常工作**（走默认配置）。

所以：**现在能改的只有代码里的 `DEFAULTS`，或让插件按下面的正确形态重写配置面。**
把 `auto-approval:` 段写进某个 yaml 文件是**没有用的**（详见「五、配置」里的「原文的 settings.yaml 写法」）。

**正确的形态（本体内核的做法，未在本插件上实现/验证）**：本体的设置命名空间**不是**插件自己注册出来的，
而是"**profile 里的加载器条目 + 该插件的 `Config` 导出**"：

```js
// 期望形态（示意，本插件尚未这样写）
import z from '@deepseek-ai/schemastery'
export const Config = z.object({
  enabled: z.boolean().default(true),
}).volatile()   // 顶层 .volatile() ⇒ 整个对象当表单；也可以逐字段 .volatile()（如 agent-default-model 的 provider/model）
```

`dsh-settings` 只把"落在 `volatile` 节点下"的字段当可编辑项（`volatileForm()` / `isVolatilePath()`），
所以**不给 schema 加 `volatile` 就等于没有配置面**（`Plugin entry "…" has no volatile fields`）。

`dsh-settings` 用 `entry.fiber.runtime.Config` 当 schema，命名空间 = **条目 id**（这里是 `dsh-auto-approval`，**不是** `auto-approval`），
写入落点是 profile 的 `cordis.patch.yml`（`configEditor.documentPath == profileContext.patchPath`）。
也就是说，正确的用户配置长相是：

```yaml
# %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml
- id: dsh-auto-approval
  name: dsh-auto-approval
  config:
    enabled: true
    autoApproveUpTo: medium
```

### 让服务端插件生效：**必须重启宿主**

Host 半身在宿主（`dsh web`）进程里，模块缓存（ESM）不会因为文件变了就重载：

| 改了什么 | 怎么生效 |
|---|---|
| `cordis.patch.yml`（挂载行） | 补丁层热加载，通常立即生效 |
| `lib/index.js` / `lib/client.js`（Host 半身） | **重启宿主** |
| `lib/client.js`（浏览器半身） | 刷新页面即可（若客户端 bundle 走 HMR 则更快） |

官方桌面端**没有**本仓壳的托盘「重启宿主（重载插件）」按钮 —— 官方端该怎么重启宿主**未实测**：
稳妥做法是**完全退出桌面端再启动**（只关窗口可能只是最小化到托盘）。
**本仓壳**里对应的是托盘「重启宿主（重载插件）」。

### 装完怎么验

```powershell
# 1) 宿主 stderr 里插件自己打的日志（路径按环境换；下面是本仓自研壳的实测落点）
Select-String -Path "$env:LOCALAPPDATA\DSHDesktop\logs\host.stderr.log" -Pattern 'dsh-auto-approval' | Select-Object -Last 5

# 2) 决策日志最后一条 plugin-loaded：看 settings= 是不是 ok
Get-Content "$env:USERPROFILE\.dsh\logs\auto-approval.log" -Tail 3

# 3) 会话里敲 /approval
```

| 期望 | 含义 |
|---|---|
| `[dsh-auto-approval] 已装载：enabled=true autoApproveUpTo=medium 日志=…` | 插件进了宿主 |
| `plugin-loaded` 的 `why` 里 `commands=ok` | `/approval` 可用 |
| `plugin-loaded` 的 `why` 里 `settings=ok` | 配置面可用（**当前代码在 0.1.7-rc.1 上必然不是 ok**，见「配置」一节） |
| `plugin-loaded` 的 `why` 里 `settings=settings.register 抛错：…` | 复现了已知问题：配置面不可用，审批仍按默认值工作 |

---

## 三、装进自建 DSH（0.1.7+）

自建 DSH = 自己有一份 `dsh` 安装（`@deepseek-ai/dsh` ≥ 0.1.7），跑 `dsh web` 起宿主，profile 目录在 `$DSH_HOME/profiles/<name>/`。
**没有壳**，所以下面全部手写。可直接复制（PowerShell）：

### 手工拷贝 + patch 层 + 配置

```powershell
# ── 变量：按自己的机器改 ───────────────────────────────────────────────
$src     = 'D:\Desktop\deepseek\plugins\dsh-auto-approval'      # 本仓库里的插件
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$prof    = 'web'                                                 # 你的 profile 名（官方桌面端是 desktop）
$profDir = Join-Path $dshHome "profiles\$prof"

# ── 1) 放插件 ────────────────────────────────────────────────────────
New-Item -ItemType Directory -Force -Path (Join-Path $profDir 'node_modules') | Out-Null
robocopy $src (Join-Path $profDir "node_modules\dsh-auto-approval") /E

# ── 2) 挂载行：追加到 profile 的用户补丁层 ──────────────────────────────
$patch = Join-Path $profDir 'cordis.patch.yml'
if (-not (Test-Path $patch)) { Set-Content -Path $patch -Value "[]`n" -Encoding utf8 }
$has = Select-String -Path $patch -Pattern 'dsh-auto-approval' -Quiet
if ($has) {
  "补丁层里已有 dsh-auto-approval，跳过"
} else {
  # ⚠️ 若文件里只有一行 `[]`，必须替换它，不能追加（两个 YAML 节点 = 宿主启动即抛）
  $text = (Get-Content $patch -Raw).TrimEnd()
  $block = "`n# AI 自检权限申请：审批瀑布前置分级（低风险自动放行 / 高风险问用户）`n- insert:`n    - id: dsh-auto-approval`n      name: dsh-auto-approval`n"
  if ($text -eq '[]') { Set-Content -Path $patch -Value $block.TrimStart() -Encoding utf8 }
  else { Add-Content -Path $patch -Value $block -Encoding utf8 }
  "已写入挂载行：$patch"
}

# ── 3) 确认 profile 清单（不需要把插件加进 bundles，但确认文件在） ────────
Get-Content (Join-Path $profDir 'package.json')
```

`cordis.patch.yml` 里最终应该长这样（片段）：

```yaml
- insert:
    - id: dsh-auto-approval
      name: dsh-auto-approval
```

### 配置文件（同上：**当前代码没有可用的配置面**）

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml ——「应该」的形态，需先按「配置」一节把配置面修好
- id: dsh-auto-approval
  name: dsh-auto-approval
  config:
    enabled: true
    autoApproveUpTo: medium
```

不改代码的前提下，唯一能改配置的办法是编辑 `plugins\dsh-auto-approval\lib\index.js` 里的 `DEFAULTS`（见「五、配置」的默认值表）。

### 依赖

| 依赖 | 谁提供 | 缺失后果 |
|---|---|---|
| `@deepseek-ai/schemastery`（`~3.18.4`） | 宿主 vendor 树（`dsh-settings` 的 peer）。插件用**动态 import** 取它 | 拿不到 → 日志 `schemastery 解析不到` → 配置面不可用（**故障，不是降级**） |
| `@deepseek-ai/dsh-llm`（`BlockAssembler` / `createUserMessage`） | 同上，动态 import | 拿不到 → 审查器恒 `ask`（日志写 `dsh-llm 辅助模块解析不到`） |
| `agent-default-model` 条目 | 本体 bundle（`@deepseek-ai/dsh-base`）里的一行，配置写在 profile 补丁层 | 没有 provider/model → 审查器恒 `ask` |
| 统一 Key | `$DSH_HOME\.credentials.yaml`（本体 `dsh-credentials-local` 负责读） | LLM 调用失败 → 审查器恒 `ask` |
| `approval` / `settings` 服务 | 本体 bundle | 缺任一 → `inject` 不满足，插件不 `apply` |

**包目录上不放 `node_modules`** 是有意的：插件在仓库里时解析不到上面两个包，所以走"动态 import + 拿不到就降级"的写法；
生产态由宿主 vendor 树提供。自检则通过 `__injectSchemaLib()` / `__injectReviewer()` 显式注入。

### 生效与验证

宿主（`dsh web`）**必须整个重启**：

```powershell
# 杀掉宿主再起；同一 DSH_HOME 不要并发起两个宿主（会话日志会撞 seq）
Get-Content (Join-Path $dshHome 'logs\auto-approval.log') -Tail 3
# 期望：{"action":"plugin-loaded","why":"settings=… commands=ok"}
```

会话里敲 `/approval` 看状态；`/approval rules` 看当前生效的规则表。

> 如果你的"自建"其实就是官方桌面端（profile = `desktop`），重启宿主那一步见「二、装进官方 DSH 桌面端」的说明（那边同样未实测）。

---

## 四、实现契约（移植到别的 harness 前先读这一节）

> 本节是给"换一个 DSH / 换一个 harness 再复用"的人看的：挂点、形状、返回语义、失败边界、移植前提。

### 挂载点：它挂在哪些扩展点

| 扩展点 | 注册选项 | 输入形状 | 返回语义 |
|---|---|---|---|
| `approval/request` | `{ global: true, prepend: true }` | `ApprovalRequest`：`{ agent, toolName, callId?, reason?, signal? }` | 返回 `'allowed-once'` = **自动放行**；`return next()` = **落到既有 answerer**（用户弹窗） |
| `tools/pre-execute` | `{ global: true }`（**不** prepend） | `ToolExecution`：`{ callId, rootCallId?, name, schema?, arguments, agent?, parent?, signal, token }` | 只观察：`return next()`（该方法默认放行为 `{ kind: 'allow' }`，本插件不改判） |

两者都在 **`apply()` 的同步段**注册（第一个 `await` 之前）—— 注册时机决定 Cordis 的 effect 落在哪个
fiber/作用域上（`apply-self-test.mjs` 有专门断言钉住这一点）。

`inject = ['approval', 'settings']` 是**硬依赖**：这两个服务不到齐，插件根本不 `apply`。
`llm` / `agentDefaultModel` / `commands` 是**软依赖**（`ctx.get()` 拿不到就降级：审查器转 ask、命令不注册）。

### 审批语义（来自本体源码，写代码时别猜）

| 事实 | 出处 |
|---|---|
| 裁决结果词表：`'allowed-once' \| 'rejected' \| 'cancelled' \| 'unavailable'`；`allowed-once` 是**唯一**的"准予" | `@deepseek-ai/dsh-user-approval` |
| 非词表返回值一律被归一成 `'unavailable'`（fail closed）；answerer 缺失/抛错也是 `'unavailable'`；signal 中断是 `'cancelled'` | 同上 |
| 会话策略 `never` 在**瀑布之前**直接返回 `'rejected'` —— 本插件**收不到**请求（这一点决定了「权限预设 = 完全权限」与本插件互斥） | 同上 |
| 瀑布按 agent 作用域派发（`scopeTarget(req.agent, req.agent)`），故需要 `global` 绕过作用域过滤 | 同上 + `dsh-scope` |
| 瀑布是 `waterfall`，**按注册顺序**执行；DSH 自己的桥（`dsh-api-remotes`）**拿到用户答复就直接 resolve 整条链（不走 `next()`）** → 故需要 `prepend` | `dsh-api-remotes\lib\index.js` 的 `forwardWaterfall()`：`outcome.kind === 'result'` 时 `settled.resolve(outcome.value)`，否则才 `next()` |
| 请求必须发生在**一个打开的 turn 之内**（`approval/asked` + `approval/decided` 审计对要落在 turn 边界内），否则 `approval.request()` 直接抛错 | 同上 |
| 工具审批的搬运工：`tools` 把 `{kind:'ask'}` 变成 `ctx.approval.request({agent, toolName, callId, reason, signal})`；`allowed-once` → `{kind:'allow'}`，其余三种 → `deny` + 不同理由 | `@deepseek-ai/dsh-tools` |
| 当前环境里审批请求的主要来源：沙箱提权（`escalate sandbox to <mode>: <justification>`），走 `dsh-sandbox` 的 `approveEscalation()` | `@deepseek-ai/dsh-sandbox` |

### fail-closed 边界清单

| 失败情形 | 结果 |
|---|---|
| `enabled=false` | `next()`（不介入） |
| 工具在 `alwaysAskTools` | `next()`（不给模型放行权） |
| 请求没带 `reason` | `next()` |
| `reviewerEnabled=false` 或 `autoApproveUpTo='low'` 且未走快路 | `next()`，**不发起模型调用** |
| `agentDefaultModel` 未配 provider/model | `ask` |
| `llm` 服务不可用 | `ask` |
| `dsh-llm` 的 `BlockAssembler` / `createUserMessage` 解析不到 | `ask` |
| 审查超时（`reviewTimeoutMs`，默认 12000ms） | `ask` |
| 审查抛错 / 输出不是可解析 JSON / 空内容 / 未知裁决 | `ask` |

### 要移植到别的 harness，前置条件清单

| # | 前提 | 缺失时的表现 |
|---|---|---|
| 1 | 有一个 `approval` 服务，且提供 `request({agent, toolName, callId, reason, signal})` → 四值词表 | `inject` 不满足，插件不 `apply` |
| 2 | 审批决策走**可插拔的 waterfall**（而不是硬编码弹窗），且默认值不是"放行" | 插件挂不上；本体的默认 fail-closed（`unavailable`）是这套设计成立的前提 |
| 3 | 事件派发支持 `{ global: true }` 绕过作用域过滤 | 审批按 agent 作用域派发时收不到请求，且**不报错**（见「不要动这个」） |
| 4 | 事件派发支持 `{ prepend: true }`（或等价地：插件的注册早于本体自带的桥） | 请求被桥先拿走，插件静默失效 |
| 5 | 瀑布回调签名是 `(req, next)`，且 `next()` 能拿到既有 answerer 的结论 | 无法"只做加法" |
| 6 | 存在一个"参数已知、审批未决"的**前置钩子**（这里是 `tools/pre-execute`），带稳定 `callId` 与 `arguments` | 审查器只能看到 `reason`，判据质量显著下降（仍可工作） |
| 7 | 有一个可读的"默认模型选择"（provider+model）与一个可用的 LLM 流式接口（`llm.stream`）+ 凭据 | 审查器永远 `ask`，插件退化成"只放白名单快路" |
| 8 | 设置面允许插件暴露可写的配置项（或至少允许改代码里的 `DEFAULTS`） | 只能改代码，`/approval on\|off` 无法持久化 |
| 9 | 模块解析：`@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-llm` 能从插件所在位置解析到 | `schemastery` 缺失 → 配置面整个不可用；`dsh-llm` 缺失 → 审查器恒 `ask` |

**结论**：这插件是"DSH 形状"的插件（Cordis 事件 + 服务 + schemastery），不是跨框架通用件。
换 harness = 换第 1/2/6/7 条的实现，其余（预筛、提示词、解析器、fail-closed 策略、审计日志）可以直接搬。

---

## 五、配置

### 原文的 settings.yaml 写法（**当前内核不生效，保留备查**）

原文给的形态是"走 DSH 本体的 settings 命名空间，写 `$DSH_HOME/settings.yaml`"：

```yaml
auto-approval:
  enabled: true
  autoApproveUpTo: medium
  highRiskPatterns: [...]
  lowRiskTools: [...]
  alwaysAskTools: [...]
  reviewerEnabled: true
  reviewTimeoutMs: 12000
  reviewMaxTokens: 1200
  logDecisions: true
  logFile: ''
```

**为什么现在不生效（三处，都以 0.1.7-rc.1 的源码为准）**：

| # | 事实 | 后果 |
|---|---|---|
| 1 | `ctx.settings` 没有 `register(ns, schema)`；配置 schema 来自**插件条目的 `Config` 导出**，命名空间 = **条目 id** | 插件注册失败 → 永远用 `DEFAULTS`（**这条是主因**） |
| 2 | `$DSH_HOME/settings.yaml` 已被"导入 + 改名"处理：`dsh-settings` 在 loader 就绪后把它读成 `settings.yaml.imported`，逐段 `update()` 进 profile，**之后不再读它** | 手写进去的段最多被导入一次，改它不会再有效果（本机就留着一个 `settings.yaml.imported`）；而且导入要求那一段是**已注册**的命名空间 —— 上面第 1 条坏了，整段就会被丢掉（日志 `section %s … was not imported`） |
| 3 | 真正的用户配置落点是 **profile 的 `cordis.patch.yml`**（`configEditor.documentPath == profileContext.patchPath`），形态是 `- id: <条目 id>` + `config:` | 要落配置，就得写进这一层，且 `id` 用条目 id |

> 顺带记一条容易踩的：自研壳的设置面板/文档按钮仍然指向 `$DSH_HOME/settings.yaml`（`desktop-electron\src\main.mjs` 的 `openSettingsDocument()`），
> 但那个文件在 0.1.7-rc.1 里已经是"一次性 legacy 入口"，不是活配置面。

### 代码里的默认值（**唯一可靠的配置基线**）

`lib/index.js` 的 `DEFAULTS` 与 `buildSettingsSchema(z)` 两处**必须一致**（自检断言了默认 `reviewMaxTokens ≥ 800`）：

| 键 | 类型 / 取值 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关 |
| `autoApproveUpTo` | `'low' \| 'medium'` | `'medium'` | `low` = 只走白名单快路；`medium` = 另允许模型审查放行；**没有 high 档** |
| `highRiskPatterns` | `string[]`（整体替换） | 见下表 | 风险**证据**（命中会喂给审查模型，不再直接判死） |
| `lowRiskTools` | `string[]`（整体替换） | 见下表 | 白名单工具 → 快路直接放行 |
| `alwaysAskTools` | `string[]`（整体替换） | 见下表 | 必问工具 → **硬拦，不交模型** |
| `logFile` | string | `''`（空 = `$DSH_HOME/logs/auto-approval.log`） | 决策日志路径 |
| `logDecisions` | boolean | `true` | 关掉只影响落盘，不影响内存里最近 50 条 |
| `reviewerEnabled` | boolean | `true` | 关掉后除快路外一律问用户，且**不发起模型调用** |
| `reviewTimeoutMs` | number | `12000` | 单次审查超时；超时即按 `ask`。**代码里 `<=0` 会回退到 8000，不是 12000** |
| `reviewMaxTokens` | number | `1200` | **必须大于模型推理阶段的长度**，见下一节。**注意 `<=0` 会回退到 200（就是那个事故值）** |

默认 `highRiskPatterns`（`DEFAULT_HIGH_RISK`，匹配时**大小写不敏感**，且只扫 `reason` 字段）：

```
danger-full-access, full-access, no-sandbox, bypass,
sudo, runas, takeown, icacls, cacls, attrib, set-executionpolicy,
registry, reg add, reg delete, hklm, hkcu, schtasks, sc create, sc delete,
bcdedit, diskpart, format , chkdsk, shutdown, restart-computer, stop-computer,
net user, net localgroup, new-localuser, add-localgroupmember,
taskkill, stop-process, stop-service, remove-item -recurse,
c:\windows, c:\program files, appdata\roaming, system32,
rm -rf /, chmod 777, chown, mkfs, dd if=,
curl |, curl -s |, iwr |, invoke-expression, iex(, powershell -enc,
npm i -g, npm install -g, pnpm add -g, winget install, choco install, pip install --user,
git push, gh release, docker, wsl, ssh , scp , robocopy,
工作区外, 沙箱外, 提权, 管理员
```

默认 `lowRiskTools`（12 项）：`read, read_image, grep, glob, web_search, todo_write, list_agents, job_list, get_goal, skill, ask_user_question, check-dsh-env`

默认 `alwaysAskTools`（4 项）：`cordis_run, cordis_define, ralph, workflow`

> 两张工具表都是**按工具名逐字匹配**（大小写敏感）：`alwaysAskTools` 命中就硬拦，`lowRiskTools` 命中且无风险词就走快路。
> 换一个 DSH 环境时，先看一眼自己那份工具名册再决定要不要改这两张表 —— `check-dsh-env` 只在本仓自研壳里有
> （0.1.7-rc.1 的 vendor 树里搜不到），写在 `lowRiskTools` 里对别的环境是空转；`cordis_run` / `cordis_define` /
> `ralph` / `workflow` 在 0.1.7-rc.1 里都在（`dsh-tool-cordis` / `dsh-tool-ralph` / `dsh-tool-workflow`），
> 但**别的 harness 未必有这些名字**。工具名不对不会报错，只会让那条规则失效。

### ⚠️ `reviewMaxTokens` 为什么不能小（2026-09-17 实机事故）

官方 `deepseek-flash` **是推理模型**：同一个 `max_tokens` 同时装着"思考"和"结论"，而
`reasoning_content` **不计入** `content`。上限太小（原值 200）时，思考把额度吃满、
`content` 直接是**空串**、`finish_reason=length`，于是每次审查都解析不出 JSON、
按 fail-closed 一律变成"**交回用户**"——日志里就是连着几十条
`verdictWhy:"审查模型未输出可解析的 JSON"`，用户看到的是每一次提权都要手点。

实测（同一条请求，`deepseek-flash`）：

| max_tokens | 用时 | completion | 其中 reasoning | content | 能不能解析 |
|---|---|---|---|---|---|
| 200 | 137ms | 200 | 200 | `""` | ❌ 空 |
| 800 | 124ms | 684 | 655 | `{"verdict":"ask","why":"…"}` | ✅ |
| 1200（新默认） | 同量级 | — | — | 完整 JSON | ✅ |

**结论：额度要给"推理 + 结论"两段留量。** 解析器同时改成扫**平衡花括号**并剥 ``` 围栏
（贪婪的 `\{[\s\S]*\}` 在"推理里出现过示例 JSON"的输出上会跨段拼接），
空输出也有专门理由（`审查模型返回空内容（通常是 maxTokens 被推理阶段用满）`），
不再和"输出不是 JSON"混成一句。

**这里没有 provider / model / apiKey**，刻意的：审查走**本体配置**（`agent-default-model` 条目）
与**统一 Key**（`$DSH_HOME/.credentials.yaml`）。要换审查用的模型，改本体设置即可，本插件不用动。

命名空间用 **schemastery**（`@deepseek-ai/schemastery`）——**不是 zod**：
`dsh-settings` 会把 schema 交给 `resolveConfig` / 当函数调用（`schema(mergeLayers(base, section))`），
zod 的对象不可调用，注册会抛 `schema is not a function`，命名空间就永远注册不上
（这个坑真踩过）。**注意**：换成 schemastery 是必要条件，不是充分条件 —— 0.1.7-rc.1 的
`ctx.settings` 连 `register()` 都没有，所以"注册成功 → 出现在设置面板"这条路现在是断的（见「配置」一节）。

---

## 六、`/approval` 命令

由 `commands.register()` 注册（`commands` 服务不可用时只写一行日志，插件其余功能不变）：

| 命令 | 作用 |
|---|---|
| `/approval` / `/approval status` | 当前状态（开关、放行上限、内存里最近决策条数） |
| `/approval on` / `/approval off` | 开/关自动审批（写设置；**配置面坏时返回 `kind:'error'`**） |
| `/approval why` | 最近 8 条审批决策（放行还是问用户、为什么） |
| `/approval rules` | 当前生效的规则表（上限、前 12 个关键词、白名单、必问表、日志路径） |

已知小瑕疵（`lib/index.js` 的命令 handler）：`/approval why` 每行打印的是 `d.grade`，
而决策条目里写的是 `ruleGrade` → 那个中括号位置**永远显示 `-`**；要看规则分级请直接读 JSONL 里的 `ruleGrade`。

客户端半身 `lib/client.js` 只做一件事：Host 侧命令描述符白名单是冻结的（写 `icon` 会被丢掉），
而注册同名 contribution 会让 `ui-commands` 抛错、**整个「指令」分组消失** ⇒ 只能在候选行返回后
给 `/approval` 那一行补一个 `IconShieldOutline16`。任何一步不成立都只是"没有图标"，不影响宿主插件。

---

## 七、生效方式（**必须重启宿主**）

`dsh-auto-approval` 是 out-of-tree 插件：**补丁层是热加载的，插件源码不是**（ESM 模块缓存）。
改完 `lib/index.js` 后，重启宿主让新代码进内存：

| 环境 | 怎么重启 |
|---|---|
| 本仓自研壳 | 托盘「重启宿主（重载插件）」；或壳的宿主崩溃自动重启 |
| 官方 DSH 桌面端 | **未实测**；稳妥做法是完全退出应用再启动（只关窗口可能只是最小化） |
| 自建 DSH | 结束 `dsh web` 进程重新起（同一 `DSH_HOME` 别并发起两个宿主） |

重启后确认 `$DSH_HOME/logs/auto-approval.log` 里最新那条 `plugin-loaded` 的 `why`：

| `settings=` | 含义 |
|---|---|
| `ok` | 配置面可用（0.1.7-rc.1 上**当前代码必然不是这个**） |
| `settings.register 抛错：…` / `schemastery 解析不到` / `settings 服务不可用` | 配置面坏了：`/approval on\|off` 会报错，规则表改不了，插件按 `DEFAULTS` 工作 |
| `commands=unavailable` | `/approval` 没注册（其余功能不受影响） |

---

## 八、⚠️ 不要动这个：`{ global: true, prepend: true }`（少一个，插件就静默失效）

```js
ctx.on('approval/request', handler, { global: true, prepend: true })
```

**两个选项各管一个维度，缺一不可**，而且**缺了不会有任何报错** —— 插件照常装载、
`settings=ok` 照写、日志照打，但请求永远轮不到它，用户照旧看到卡片、照旧手点。

| 选项 | 管什么 | 缺了会怎样 |
|---|---|---|
| `prepend` | **顺序** | 审批瀑布按**注册顺序**执行（`waterfall()` 里是 `cbs.shift()`），而 DSH 自己的桥（`dsh-api-remotes`）注册得早、且**拿到用户答复就直接 resolve 整条链（不调 `next()`）** → 排在桥后面的监听**永远不会被执行** |
| `global` | **作用域** | 绕过 `dsh-scope` 的作用域过滤（`dispatch` 里的 `hook.global` 短路）；审批瀑布是按 agent 作用域派发的 |

**2026-09-12 实测教训**：本插件曾"看起来一直正常"却从不自动放行 —— 用户以为"没有弹窗"，
实际上**那张卡片一直在弹、他亲手点了 54 次**（会话日志里 `approval/asked` 54 条、全部
`allowed-once`，间隔中位数 2640 ms）。根因就是注册排在桥之后。

同一条纪律的另外两面（都写进了自检）：

1. `ctx.on` 必须在 `apply()` 的**同步段**注册 —— Cordis 的 `dispatch()` 只读**派发目标 ctx 自己**的
   `_hooks`，不向上遍历作用域链，而注册时机决定 effect 落在哪个作用域；
2. `tools/pre-execute` 同样要 `global`，但**不该** `prepend`（它只观察，不抢顺序）。

---

## 九、与本体"权限预设"的关系（重要）

本体**没有**自动审批：它只有 `ask`（每次都问）与 `never`（**拒绝**，且不进审批瀑布），
唯一的"准予"结果是 `allowed-once`，本体自己从不主动产出它（源码原话：`allowed-once is the only grant`）。
权限预设「完全权限」不弹窗，是因为它把沙箱开到最大、**让审批请求根本不再产生**——那是**绕开**审批，
不是**通过**审批，而且它与本插件**互斥**（`never` 在瀑布之前就短路，本插件收不到请求）。
要"AI 自己判断该不该放行"，只有本插件这条路。

---

## 十、与 Codex 自动审批的对应关系

| Codex | 本插件 |
|---|---|
| auto 模式：有界操作自动过 | **独立模型审查**（`reviewerEnabled`）：看懂这次请求要干什么再放 |
| 危险操作仍需确认 | 模型判 `ask`，或命中 `alwaysAskTools` / 无 reason 硬拦 → `next()` |
| 固定规则表 | `highRiskPatterns` 只作**证据**喂给模型，不再单独裁决 |
| 用户可切换模式 | `enabled` 开关（设置面 / `/approval on\|off`） |
| 决策可追溯 | `logs/auto-approval.log` + `/approval why` |

---

## 十一、自检

在插件目录里跑（**新路径**：仓库顶层 `plugins\`）：

```powershell
cd D:\Desktop\deepseek\plugins\dsh-auto-approval
node test\grade-self-test.mjs    # v1 规则分级器纯函数：10 断言（作为审计信号仍保留）
node test\apply-self-test.mjs    # 接线级：mock ctx 驱动 apply()，47 断言
```

两套都已纳入仓库门禁清单（`desktop-electron\scripts\test-suite.mjs` 的 `SUITES`，
条目写作 `plugins/dsh-auto-approval/test/*.mjs`）；合计 **57 断言**。

| 现象 | 原因 | 处置 |
|---|---|---|
| `自检需要 schemastery：既不在仓库 vendor 树、也不在仓库 node_modules` | 迁移后 `apply-self-test.mjs` 已改指壳目录（`../../../desktop-electron/vendor/profile/node_modules/...` 与 `../../../desktop-electron/node_modules/...`），两条都缺才会报这句（例如 CI 的全新 checkout 既没 `npm ci` 也没建 vendor 树） | 跑 `npm ci`（或 `npm run build:host`）把树建起来 |
| `FAIL  settings 命名空间注册成功（schema 被当函数调用）` | 用了 zod（不可调用）而不是 schemastery | 换回 `@deepseek-ai/schemastery`（枚举用 `z.union`，schemastery 没有 `z.enum`） |

> `apply-self-test` 的 mock **照真实服务的契约来**：`settings.register(ns, schema)` 会检查
> `typeof schema === 'function'` 并真的调用它解析默认值。初版 mock 把这个参数整个忽略，
> 于是"传了个不可调用的 schema"这个真实故障在自检里永远看不见——**mock 松一寸，故障就多藏一层**。
> （这也是为什么 mock 里保留了一个 0.1.7-rc.1 已经**不存在**的方法名：它记录的是当时真实的 API 形态。）
>
> 仓库包目录上面没有 `node_modules`，解析不到 schemastery / dsh-llm（它们在 vendor 树里），
> 所以自检通过 `__injectSchemaLib()` 与 `__injectReviewer()` 显式注入；
> 生产路径永远走插件自己的动态导入。
>
> 决策层 v2 的断言覆盖：预筛四条路径（硬拦 / 快路 / 交审查）、`parseVerdict` 的多种失败收敛、
> 四个端到端分支（模型判 allow 时即使命中高风险词也放行 / 判 ask → 转问用户 / 审查器抛错 → fail-closed /
> 审查器关闭 → 不问模型直接问用户）、"真实命令"的取回链路，
> 以及客户端半身的五条打包契约（`exports["./client"]`、保留 `exports["."]`、`dsh.client.platform === "web"`、
> bundle 用包名自注册、只 require seed 模块）。

---

## 十二、移植/复用时的已知问题清单

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| 1 | 用了 `settings.register()`，而 0.1.7-rc.1 的 `ctx.settings` 没有这个方法 | vendor 源码；本机 `host.stderr.log` 实测 `settings 注册失败，改用默认配置：settings.register is not a function` | 配置面不可用：永远走 `DEFAULTS`，`/approval on\|off` 报错，设置面板无此项 |
| 2 | 文档里"命名空间 `auto-approval`"与本体做法不符 | 本体按**条目 id** 认命名空间（`describe()` 用 `entry.options.id`） | 即使修好注册，用户也得把配置写在 `dsh-auto-approval` 这个 id 下 |
| 3 | `reviewTimeoutMs` / `reviewMaxTokens` 的 `<=0` 回退值与默认值不一致（8000 / 200） | `lib/index.js` `reviewWithLlm()` | 谁把 `reviewMaxTokens` 填成 0，就静默退化到事故值 200（审查恒 ask） |
| 4 | `/approval why` 打印 `d.grade`，决策条目里叫 `ruleGrade` | `lib/index.js` 命令 handler | 该列恒为 `-`，不影响裁决 |
| 5 | 自检的 schemastery 回退路径是搬迁前的相对路径 | `test/apply-self-test.mjs` 的 `tries` | 在仓库根直接 `node plugins/...` 会报"需要 schemastery"；从 `desktop-electron/` 跑正常 |
| 6 | 默认 `lowRiskTools` 里的 `check-dsh-env` 在 0.1.7-rc.1 vendor 树里搜不到 | 全树 grep 无命中 | 该条对别的 DSH 环境是空转；不影响其它规则 |
| 7 | 规则表、`RECENT_CALL_LIMIT=20`、审查提示词等常量不可配 | `lib/index.js` | 只能改代码 |

## 十三、写成"未验证"的事项

| 事项 | 为什么未验证 |
|---|---|
| 官方 DSH 桌面端（`%USERPROFILE%\.dsh\profiles\desktop\`）**端到端**装一遍 | 只读了只读目录结构（`profiles\desktop\` 存在、含 `node_modules\dsh-plugin-wallpaper-engine`、`cordis.patch.yml` 有 `agent-default-model` 段），**没有在官方端实际拷贝 + 挂载 + 重启验证** |
| 官方桌面端怎么"重启宿主" | 官方端没有本仓壳的托盘项；本次没有动作去验证官方的重启路径（完全退出再启动是推断） |
| home 层补丁 `$DSH_HOME\cordis.patch.yml` | 本体源码确实会读它（叠加在每个 profile 之上），但**本机不存在这个文件**，未实测 |
| `dsh plugin --profile desktop add <spec>` | CLI 源码明确拒绝 `--profile desktop`；只能手工拷（自测夹具只覆盖了 CLI 的失败分支） |
| 修改后的配置面（`Config` 导出 + `.volatile()` + `- id: dsh-auto-approval / config:`）能跑通 | 这是"应该怎么做"的推断，未在插件上实现，也没有本机实测 |
| `apply-self-test.mjs` 的 47 断言本次实跑 | 本机插件树解析不到 schemastery（见「自检」一节），本次只实跑了 `grade-self-test.mjs`（10/10 绿）；47 这个数字来自测试文件里 47 处 `ok(...)` 调用（搬迁前的记录是 27） |
| 其它 harness 的等价事件名/签名 | 「实现契约」结尾的清单是"要满足什么"，不是"别人已经这么叫" |
| `{ global: true }` 绕过的具体代码路径 | 本次只核实了桥那一侧的"不调 `next()`"（`forwardWaterfall()`）；`dsh-scope` 里的 `hook.global` 短路沿用本插件落地时的实测结论（2026-09-12 前后），**本轮没重新逐行读那个 dispatcher** |
| 本会话里 `/approval` 各子命令的实际输出 | 文档里的命令表来自 `lib/index.js` 的 handler 代码，没有在本机会话里逐条敲过 |
