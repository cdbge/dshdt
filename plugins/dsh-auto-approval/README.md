# dsh-auto-approval — AI 自检权限申请（Codex 式自动审批）

DSH 的审批原本只有两档会话策略：`ask`（每条都问）与 `never`（统统拒绝）。本插件在 harness 的**审批瀑布**上插一层**风险分级**：

```
模型发起需要审批的动作 → approval/request 瀑布 ←── dsh-auto-approval 在这里分级
    ├── 低风险 / 有界操作(medium) ──► 返回 'allowed-once'（放行，用户看不到弹窗）
    └── 高风险 / 判不准           ──► return next()，落到既有 answerer
```

可独立复用的 Host 插件：只依赖 DSH 本体的服务（`approval` / `settings` / 命令面 / 可选的 `llm`），不依赖任何桌面壳的 admin API。

| 文件 | 作用 |
|---|---|
| `lib/index.js` | Host 半身：审批裁决 + 设置 + `/approval` 命令（唯一有行为的部分） |
| `lib/client.js` | 浏览器半身：只给指令菜单里的 `/approval` 补一个图标（可选，纯装饰） |
| `test/grade-self-test.mjs` | 分级器纯函数自检（10 断言） |
| `test/apply-self-test.mjs` | 接线级自检：mock ctx 驱动 `apply()`（47 断言） |
| `package.json` | 包名 / `exports` / `dsh.client` 元数据（客户端半身的两个硬要求） |

版本基线：harness **0.1.7-rc.1**（`@deepseek-ai/dsh` / `dsh-base` / `dsh-web-app` 三包同版）、Node 22.21.0、`@deepseek-ai/schemastery` **3.18.4**（`dsh-settings` 以 peer 要求 `~3.18.4`）。插件 `version` 是 `1.0.0`，**不随 harness 走**；harness 换版时按第四、五节重新核对。官方桌面端宿主包 `@deepseek-ai/dsh-desktop-host` 标 `0.2.0-rc.2`，内核同为 0.1.7-rc.1。

## 一、裁决流程：预筛 + 独立模型审查

关键词表分不出 `Remove-Item -Recurse -Force` 在 workspace 内（该放）与在 `C:\Windows` 下（该拦）的区别。故关键词表**降级为"证据"**，最终裁决交给一次**独立的模型调用**：全新上下文、只做一件事 —— 判该不该放。关键词命中会被原样喂给它，但不再直接判死。

| 步 | 条件 | 处理 |
|---|---|---|
| ① **快路** | 工具在 `lowRiskTools` **且**没有任何风险词命中 | 直接 `allowed-once`（**不花模型调用**） |
| ② **硬拦** | 工具在 `alwaysAskTools`、或请求没带 `reason` | `next()` 问用户（**永远不给模型放行权**） |
| ③ **模型审查** | 其余全部 | 一次独立模型调用；判 `allow` → `allowed-once`，否则 `next()` |

`enabled=false` 时整条链路第一条就退出（`next()`，完全不介入）。

**审查器看到真实命令，不只是理由**：审批请求只有 `{agent, toolName, callId, reason, signal}`，**没有 args**，只看理由最容易被误导。

| 环节 | 实现 |
|---|---|
| 取参数 | 挂 `tools/pre-execute`（在沙箱提权**之前**触发）记 `callId → {name, arguments}`，存一张**上限 20 条**（`RECENT_CALL_LIMIT`）的小表；审批到来时按 `callId` 取回 |
| 压文本 | `summarizeArgs()`：**喂给模型 1200 字、审计日志里留 300 字预览** |
| 审查输入 | `buildReviewPrompt()` 用 JSON 包住四个字段，免得用户内容伪造结构：`{"tool":"pwsh","reason":"…智能体自述…","matchedRiskKeywords":["danger-full-access"],"command":"…真实参数…"}` |
| 判据 | 系统提示 `REVIEW_SYSTEM`（写死在这里）要求**以 `command` 为准，与 `reason` 冲突时判 ask**；取不到参数时显式写 `(未取到该次调用的参数)`。`ToolExecutionInput` 声明中 `arguments: unknown` 即那次调用的真实参数 |

模型来源：路由取自 `agentDefaultModel.currentSelection()`（profile 补丁层里的 `agent-default-model` 段），凭据由 `ctx.llm` 用本体的统一 Key；插件**不配置、也不接触** provider / model / apiKey。`reviewWithLlm()` 只在 `sel.provider` 与 `sel.model` **同时非空**时才发调用，只取回复里的 `text` 块。

**失败方向永远是"问用户"（fail-closed）**：没有 llm 服务 / 本体没配默认模型 / 调用超时 / 抛错 / 输出不是可解析 JSON / 未知裁决 —— 一律 `ask`。`reviewerEnabled: false` 或 `autoApproveUpTo: 'low'` 时，除快路外一律问用户，且**不发起任何模型调用**。

设计取舍：只做加法（判不准就 `next()`，失败方向是"问用户"）；一次一授权（返回 `'allowed-once'`，不做长期白名单）；不干扰原生机制（`never` 策略由 harness 在瀑布之前就拒，`permissionPresets` 照旧生效）；可审计（每条决策写 JSONL：`pre` 走哪条路、`hits` 命中词、`ruleGrade` 规则怎么看、`verdict` / `model` / `verdictWhy` 模型怎么判，`/approval why` 看最近几条）。

| 请求 | 裁决 | 结果 |
|---|---|---|
| `escalate sandbox to danger-full-access: 最终验收…` | `ask` · "理由与动作不匹配，意图存疑" | 弹卡片给用户 |
| `escalate sandbox to workspace-write: 在工作区内写一个临时文件…` | **`allow`** · "仅将沙箱提至工作区写，临时文件写入后即删，范围有界可逆" | **自动放行，零点击** |

第二条 reason 含"提权"（`hits:["提权"]`），命中词表只作证据，模型读懂"范围有界可逆"即放行。请求面：沙箱越宽，能触发的提权越危险，模型越倾向 `ask`；`workspace-write` 会话里唯一能升的是 `danger-full-access`，故自动放行**本来极少触发**；沙箱收窄时（如 read-only）才有大量"有界提权"可放心放行。

## 二、装进官方 DSH 桌面端

本节按 **0.1.7-rc.1 内核契约**写。官方桌面端**没有**「把 `plugins/` 自动同步进 profile」逻辑，也没有 `PROFILE_PLUGIN_NAMES` 表，手工把插件放到位：

官方桌面端：`$DSH_HOME` = `%USERPROFILE%\.dsh`（可用环境变量 `DSH_HOME` 覆盖），是会话 / 凭据 / 日志 / profile 的唯一根；profile 名是 **`desktop`**（`DSH_PROFILE=desktop`，宿主以 `--profile desktop` 起，官方桌面端自带；`dsh` CLI 拒绝手动 `--profile desktop`：`profile "desktop" is managed exclusively by the Electron application`），profile 目录 `%USERPROFILE%\.dsh\profiles\desktop\`；插件落在 `%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-auto-approval\`（该 profile 自己的 `node_modules`，实例：`dsh-plugin-wallpaper-engine`）；补丁层 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 是 profile 用户层、最后叠加（`dsh.profile.bundles` 的层 → 这一层 → `--patch`）；机器级 home 层 `%USERPROFILE%\.dsh\cordis.patch.yml` 叠加在**每个** profile 的用户层之上（**未验证**）；审查器的 provider/model 读 profile 补丁层里的 `- id: agent-default-model` 段，凭据是 `%USERPROFILE%\.dsh\.credentials.yaml` 里的统一 Key（插件不碰）。

home 层未验证，用前先 `dsh --profile <别的 profile> --dump-config` 看它有没有被叠加（不能拿 `desktop` 去 dump —— CLI 拒绝）。

```powershell
$prof = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
New-Item -ItemType Directory -Force -Path (Join-Path $prof 'node_modules') | Out-Null
robocopy 'D:\Desktop\deepseek\plugins\dsh-auto-approval' (Join-Path $prof 'node_modules\dsh-auto-approval') /E
```

拷完确认 `...\node_modules\dsh-auto-approval\package.json` 存在，且 `main` 指向 `lib/index.js`（`test/` 可不拷）。CLI 的等价做法是 `dsh plugin --profile <name> add <spec>`（转发给 pnpm，spec 可以是 registry / `github:owner/repo#<40位commit>` / `https://…/x.tgz`），但 **`desktop` profile 不能这样装**（CLI 明确拒绝），桌面端只能手工拷或用别的方式把包放进 profile 的 `node_modules`。CLI 形态有自测夹具（`desktop-electron\scripts\market-install-official-self-test.mjs`，含成功/失败分支），**端到端装到官方桌面端未实测**。

挂载（写进 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`）：

```yaml
- insert:
    - id: dsh-auto-approval
      name: dsh-auto-approval
```

| 要点 | 说明 |
|---|---|
| `id` 与 `name` 都写包名 | `name` 是模块标识：加载器的 `baseUrl` 锚在 profile 的 `cordis.yml` 上，裸标识符从 `profiles\<profile>\node_modules\` 起解析（再往上是 `profiles\node_modules\`、安装树）；`id` 是这一行的唯一标识，设置面也按它认名字 |
| **不用**改 `package.json` 的 `dsh.profile.bundles` | 本包没有 `dsh.bundle` 元数据，不能当 bundle 层；`insert` 行是独立的加载器条目 |
| 别在同一份文件里同时留 `[]` 和顶层条目 | 那是两个 YAML 节点，宿主启动直接抛 `YAMLException`（本仓壳有自愈代码 `repairProfilePatchYaml()`，官方端没有） |
| 补丁层是**热加载**的 | 改这一层立刻生效；改 `lib/index.js` **不**生效 |

### 配置面

插件调用 `settings.register('auto-approval', schema)`，而 0.1.7-rc.1 的 `ctx.settings` **没有 `register()` 方法**（只有 `configure` / `describe` / `update` / `replace` / `mutate`）。装载时抛 `settings.register is not a function` → 被 `try/catch` 兜住 → **回退到代码里的 `DEFAULTS`**。后果：决策日志 `plugin-loaded` 写 `settings=settings.register 抛错：…`；`/approval on|off` 报 `设置命名空间未注册（…），无法持久化开关`；设置面板里不出现这个命名空间；审批本身**照常工作**。即**现在能改的只有代码里的 `DEFAULTS`**，把 `auto-approval:` 段写进任何 yaml 文件都没有用。

**正确形态（本体内核做法，未在插件上实现/验证）**：命名空间来自"**profile 里的加载器条目 + 该插件的 `Config` 导出**"，不是插件自己注册的。schema 取 `entry.fiber.runtime.Config`，命名空间 = **条目 id**（`dsh-auto-approval`，**不是** `auto-approval`），写入落点是 profile 的 `cordis.patch.yml`（`configEditor.documentPath == profileContext.patchPath`）。

```js
import z from '@deepseek-ai/schemastery'
export const Config = z.object({ enabled: z.boolean().default(true) }).volatile()  // 顶层 .volatile() ⇒ 整个对象当表单；也可逐字段
```

`dsh-settings` 只把"落在 `volatile` 节点下"的字段当可编辑项（`volatileForm()` / `isVolatilePath()`），不给 schema 加 `volatile` 就等于没有配置面（`Plugin entry "…" has no volatile fields`）。正确的用户配置长相：

```yaml
# %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml
- id: dsh-auto-approval
  name: dsh-auto-approval
  config:
    enabled: true
    autoApproveUpTo: medium
```

### 生效与验证

| 改了什么 | 怎么生效 |
|---|---|
| `cordis.patch.yml`（挂载行） | 补丁层热加载，通常立即生效 |
| `lib/index.js` / `lib/client.js`（Host 半身） | **重启宿主**（Host 半身在宿主进程里，ESM 模块缓存不会因为文件变了就重载） |
| `lib/client.js`（浏览器半身） | 刷新页面即可（客户端 bundle 走 HMR 则更快） |

官方桌面端**没有**托盘「重启宿主（重载插件）」按钮，官方端重启路径**未实测**：稳妥做法是**完全退出桌面端再启动**（只关窗口可能只是最小化到托盘）。

```powershell
# 1) 宿主 stderr 里插件自己打的日志
Select-String -Path "$env:LOCALAPPDATA\DSHDesktop\logs\host.stderr.log" -Pattern 'dsh-auto-approval' | Select-Object -Last 5
# 2) 决策日志最后一条 plugin-loaded：看 settings= 是不是 ok
Get-Content "$env:USERPROFILE\.dsh\logs\auto-approval.log" -Tail 3
# 3) 会话里敲 /approval
```

| 期望 | 含义 |
|---|---|
| `[dsh-auto-approval] 已装载：enabled=true autoApproveUpTo=medium 日志=…` | 插件进了宿主 |
| `plugin-loaded` 的 `why` 里 `commands=ok` / `settings=ok` | `/approval` 可用 / 配置面可用（当前代码在 0.1.7-rc.1 上必然不是 ok） |
| `plugin-loaded` 的 `why` 里 `settings=settings.register 抛错：…` | 已知问题：配置面不可用，审批仍按默认值工作 |

## 三、装进自建 DSH

自建 DSH = 自己有一份 `dsh` 安装（`@deepseek-ai/dsh` ≥ 0.1.7），跑 `dsh web` 起宿主，profile 目录在 `$DSH_HOME/profiles/<name>/`。没有壳，全部手写。可直接复制（PowerShell）：

```powershell
$src     = 'D:\Desktop\deepseek\plugins\dsh-auto-approval'       # 本仓库里的插件
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$prof    = 'web'                                                  # 你的 profile 名（官方桌面端是 desktop）
$profDir = Join-Path $dshHome "profiles\$prof"
New-Item -ItemType Directory -Force -Path (Join-Path $profDir 'node_modules') | Out-Null
robocopy $src (Join-Path $profDir "node_modules\dsh-auto-approval") /E
$patch = Join-Path $profDir 'cordis.patch.yml'
if (-not (Test-Path $patch)) { Set-Content -Path $patch -Value "[]`n" -Encoding utf8 }
if (Select-String -Path $patch -Pattern 'dsh-auto-approval' -Quiet) {
  "补丁层里已有 dsh-auto-approval，跳过"
} else {
  $text  = (Get-Content $patch -Raw).TrimEnd()
  $block = "`n# AI 自检权限申请：审批瀑布前置分级（低风险自动放行 / 高风险问用户）`n- insert:`n    - id: dsh-auto-approval`n      name: dsh-auto-approval`n"
  # 若文件里只有一行 `[]`，必须替换它，不能追加（两个 YAML 节点 = 宿主启动即抛）
  if ($text -eq '[]') { Set-Content -Path $patch -Value $block.TrimStart() -Encoding utf8 }
  else { Add-Content -Path $patch -Value $block -Encoding utf8 }
  "已写入挂载行：$patch"
}
Get-Content (Join-Path $profDir 'package.json')   # 不需要把插件加进 bundles，确认文件在
```

挂载行最终形态是 `- insert:` + `- id: dsh-auto-approval` + `name: dsh-auto-approval`。配置同上：需先按「二、配置面」修好配置面，形态为 `- id: dsh-auto-approval` + `name:` + `config:` 下的 `enabled: true` / `autoApproveUpTo: medium`，写进 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`。不改代码时唯一能改配置的办法是编辑 `plugins\dsh-auto-approval\lib\index.js` 里的 `DEFAULTS`。

依赖：`@deepseek-ai/schemastery`（`~3.18.4`）与 `@deepseek-ai/dsh-llm`（`BlockAssembler` / `createUserMessage`）由宿主 vendor 树提供（前者是 `dsh-settings` 的 peer），插件用**动态 import** 取它们 —— `schemastery` 拿不到则日志写 `schemastery 解析不到`、配置面不可用（**故障，不是降级**），`dsh-llm` 拿不到则审查器恒 `ask`（日志写 `dsh-llm 辅助模块解析不到`）；`agent-default-model` 条目在本体 bundle（`@deepseek-ai/dsh-base`）里、配置写在 profile 补丁层，没有 provider/model 则审查器恒 `ask`；统一 Key 在 `$DSH_HOME\.credentials.yaml`（本体 `dsh-credentials-local` 负责读），读不到则 LLM 调用失败、审查器恒 `ask`；`approval` / `settings` 服务缺任一则 `inject` 不满足、插件不 `apply`。

包目录上不放 `node_modules`：插件在仓库里时解析不到上面两个包，所以走"动态 import + 拿不到就降级"；生产态由宿主 vendor 树提供，自检通过 `__injectSchemaLib()` / `__injectReviewer()` 显式注入。宿主（`dsh web`）**必须整个重启**，之后 `Get-Content (Join-Path $dshHome 'logs\auto-approval.log') -Tail 3` 期望 `{"action":"plugin-loaded","why":"settings=… commands=ok"}`（同一 `DSH_HOME` 不要并发起两个宿主，会话日志会撞 seq）。会话里敲 `/approval` 看状态、`/approval rules` 看当前生效的规则表。

## 四、实现契约（移植到别的 harness 前先读这一节）

| 扩展点 | 注册选项 | 输入形状 | 返回语义 |
|---|---|---|---|
| `approval/request` | `{ global: true, prepend: true }` | `ApprovalRequest`：`{ agent, toolName, callId?, reason?, signal? }` | 返回 `'allowed-once'` = **自动放行**；`return next()` = **落到既有 answerer**（用户弹窗） |
| `tools/pre-execute` | `{ global: true }`（**不** prepend） | `ToolExecution`：`{ callId, rootCallId?, name, schema?, arguments, agent?, parent?, signal, token }` | 只观察：`return next()`（该方法默认放行为 `{ kind: 'allow' }`，本插件不改判） |

两者都在 **`apply()` 的同步段**注册（第一个 `await` 之前）—— 注册时机决定 Cordis 的 effect 落在哪个 fiber/作用域上（`apply-self-test.mjs` 有专门断言钉住这一点）。`inject = ['approval', 'settings']` 是**硬依赖**：这两个服务不到齐，插件根本不 `apply`。`llm` / `agentDefaultModel` / `commands` 是**软依赖**（`ctx.get()` 拿不到就降级：审查器转 ask、命令不注册）。

审批语义（来自本体源码）：裁决结果词表 `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`（`@deepseek-ai/dsh-user-approval`），其中 `allowed-once` 是**唯一**的"准予"，非词表返回值一律归一成 `'unavailable'`（fail closed），answerer 缺失/抛错也是 `'unavailable'`，signal 中断是 `'cancelled'`；请求必须发生在**一个打开的 turn 之内**（`approval/asked` + `approval/decided` 审计对要落在 turn 边界内），否则 `approval.request()` 直接抛错；会话策略 `never` 在**瀑布之前**直接返回 `'rejected'` —— 本插件**收不到**请求（故「权限预设 = 完全权限」与本插件互斥）；瀑布按 agent 作用域派发（`scopeTarget(req.agent, req.agent)`），故需要 `global` 绕过作用域过滤（`dsh-scope`）；瀑布是 `waterfall`、**按注册顺序**执行，而 DSH 自己的桥（`dsh-api-remotes`）**拿到用户答复就直接 resolve 整条链（不走 `next()`）**，故需要 `prepend`（`dsh-api-remotes\lib\index.js` 的 `forwardWaterfall()`：`outcome.kind === 'result'` 时 `settled.resolve(outcome.value)`，否则才 `next()`）；工具审批的搬运工是 `tools`（`{kind:'ask'}` → `ctx.approval.request({agent, toolName, callId, reason, signal})`，`allowed-once` → `{kind:'allow'}`，其余三种 → `deny` + 不同理由）；当前环境里审批请求主要来自沙箱提权（`escalate sandbox to <mode>: <justification>`，走 `dsh-sandbox` 的 `approveEscalation()`）。

fail-closed 边界：`enabled=false`、工具在 `alwaysAskTools`、请求没带 `reason` → 一律 `next()`（不介入；后两者不给模型放行权）；`reviewerEnabled=false` 或 `autoApproveUpTo='low'` 且未走快路 → `next()`，**不发起模型调用**；`agentDefaultModel` 未配 provider/model、`llm` 服务不可用、`dsh-llm` 的 `BlockAssembler` / `createUserMessage` 解析不到、审查超时（`reviewTimeoutMs`，默认 12000ms）、审查抛错 / 输出不是可解析 JSON / 空内容 / 未知裁决 → 一律 `ask`。

移植前置条件：① 有一个 `approval` 服务，提供 `request({agent, toolName, callId, reason, signal})` → 四值词表（缺失则 `inject` 不满足，插件不 `apply`）；② 审批决策走**可插拔的 waterfall**（而不是硬编码弹窗），且默认值不是"放行"（本体默认 fail-closed 的 `unavailable` 是这套设计成立的前提）；③ 事件派发支持 `{ global: true }` 绕过作用域过滤（否则按 agent 作用域派发时收不到请求，且**不报错**）；④ 事件派发支持 `{ prepend: true }`（或等价地：插件注册早于本体自带的桥），否则请求被桥先拿走、插件静默失效；⑤ 瀑布回调签名是 `(req, next)`，且 `next()` 能拿到既有 answerer 的结论（否则无法"只做加法"）；⑥ 有一个"参数已知、审批未决"的**前置钩子**（这里是 `tools/pre-execute`），带稳定 `callId` 与 `arguments`（否则审查器只能看到 `reason`，判据质量显著下降，仍可工作）；⑦ 有可读的"默认模型选择"（provider+model）与可用的 LLM 流式接口（`llm.stream`）+ 凭据（否则审查器永远 `ask`，退化成"只放白名单快路"）；⑧ 设置面允许插件暴露可写配置项（或至少允许改代码里的 `DEFAULTS`），否则 `/approval on|off` 无法持久化；⑨ `@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-llm` 能从插件所在位置解析到（前者缺失 → 配置面整个不可用，后者缺失 → 审查器恒 `ask`）。

结论：这是"DSH 形状"的插件（Cordis 事件 + 服务 + schemastery），不是跨框架通用件。换 harness = 换第 ①/②/⑥/⑦ 条的实现，其余（预筛、提示词、解析器、fail-closed 策略、审计日志）可以直接搬。

## 五、配置

`lib/index.js` 的 `DEFAULTS` 与 `buildSettingsSchema(z)` 两处**必须一致**（自检断言了默认 `reviewMaxTokens ≥ 800`）：

| 键 | 类型 / 取值 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关 |
| `autoApproveUpTo` | `'low' \| 'medium'` | `'medium'` | `low` = 只走白名单快路；`medium` = 另允许模型审查放行；**没有 high 档** |
| `highRiskPatterns` | `string[]`（整体替换） | 见下 | 风险**证据**（命中会喂给审查模型，不再直接判死） |
| `lowRiskTools` | `string[]`（整体替换） | 见下 | 白名单工具 → 快路直接放行 |
| `alwaysAskTools` | `string[]`（整体替换） | 见下 | 必问工具 → **硬拦，不交模型** |
| `logFile` | string | `''`（空 = `$DSH_HOME/logs/auto-approval.log`） | 决策日志路径 |
| `logDecisions` | boolean | `true` | 关掉只影响落盘，不影响内存里最近 50 条 |
| `reviewerEnabled` | boolean | `true` | 关掉后除快路外一律问用户，且**不发起模型调用** |
| `reviewTimeoutMs` | number | `12000` | 超时即按 `ask`；**`<=0` 回退到 8000** |
| `reviewMaxTokens` | number | `1200` | **必须大于模型推理阶段的长度**；**`<=0` 回退到 200（事故值）** |

`highRiskPatterns` 默认值（`DEFAULT_HIGH_RISK`，匹配**大小写不敏感**，只扫 `reason` 字段）：

```
danger-full-access, full-access, no-sandbox, bypass, sudo, runas, takeown, icacls, cacls, attrib,
set-executionpolicy, registry, reg add, reg delete, hklm, hkcu, schtasks, sc create, sc delete,
bcdedit, diskpart, format , chkdsk, shutdown, restart-computer, stop-computer, net user,
net localgroup, new-localuser, add-localgroupmember, taskkill, stop-process, stop-service,
remove-item -recurse, c:\windows, c:\program files, appdata\roaming, system32, rm -rf /, chmod 777,
chown, mkfs, dd if=, curl |, curl -s |, iwr |, invoke-expression, iex(, powershell -enc, npm i -g,
npm install -g, pnpm add -g, winget install, choco install, pip install --user, git push, gh release,
docker, wsl, ssh , scp , robocopy, 工作区外, 沙箱外, 提权, 管理员
```

`lowRiskTools` 默认 12 项：`read, read_image, grep, glob, web_search, todo_write, list_agents, job_list, get_goal, skill, ask_user_question, check-dsh-env`；`alwaysAskTools` 默认 4 项：`cordis_run, cordis_define, ralph, workflow`。

两张工具表**按工具名逐字匹配**（大小写敏感）：`alwaysAskTools` 命中就硬拦，`lowRiskTools` 命中且无风险词就走快路。`check-dsh-env` 只在本仓自研壳里有（0.1.7-rc.1 的 vendor 树里搜不到），写在 `lowRiskTools` 里对别的环境是空转；`cordis_run` / `cordis_define` / `ralph` / `workflow` 在 0.1.7-rc.1 里都在（`dsh-tool-cordis` / `dsh-tool-ralph` / `dsh-tool-workflow`），但别的 harness 未必有这些名字。工具名不对不会报错，只会让那条规则失效。

配置文件不生效的原因（三处）：① `ctx.settings` 没有 `register(ns, schema)`，schema 来自**插件条目的 `Config` 导出**、命名空间 = **条目 id** → 插件注册失败、永远用 `DEFAULTS`（**主因**）；② `$DSH_HOME/settings.yaml` 已被"导入 + 改名"处理（`dsh-settings` 在 loader 就绪后把它读成 `settings.yaml.imported`，逐段 `update()` 进 profile，**之后不再读它**）→ 手写进去的段最多被导入一次，且导入要求该段是**已注册**的命名空间，第 ① 条坏了整段被丢掉（日志 `section %s … was not imported`）；③ 用户配置落点是 **profile 的 `cordis.patch.yml`**（`configEditor.documentPath == profileContext.patchPath`），形态 `- id: <条目 id>` + `config:` → 要落配置就得写进这一层，`id` 用条目 id。

自研壳设置面板/文档按钮仍指向 `$DSH_HOME/settings.yaml`（`desktop-electron\src\main.mjs` 的 `openSettingsDocument()`），但该文件在 0.1.7-rc.1 里已是"一次性 legacy 入口"，不是活配置面。

### `reviewMaxTokens` 不能小

官方 `deepseek-flash` **是推理模型**：同一个 `max_tokens` 同时装着"思考"和"结论"，而 `reasoning_content` **不计入** `content`。上限太小（原值 200）时思考吃满额度 → `content` 是**空串**、`finish_reason=length` → 每次审查都解析不出 JSON → 按 fail-closed 一律"交回用户"，日志里连着几十条 `verdictWhy:"审查模型未输出可解析的 JSON"`，用户看到的是每次提权都要手点。

| max_tokens | 用时 | completion | 其中 reasoning | content | 能不能解析 |
|---|---|---|---|---|---|
| 200 | 137ms | 200 | 200 | `""` | ❌ 空 |
| 800 | 124ms | 684 | 655 | `{"verdict":"ask","why":"…"}` | ✅ |
| 1200（新默认） | 同量级 | — | — | 完整 JSON | ✅ |

处置：额度给"推理 + 结论"两段留量；解析器扫**平衡花括号**并剥 ``` 围栏（贪婪的 `\{[\s\S]*\}` 在"推理里出现过示例 JSON"的输出上会跨段拼接）；空输出有专门理由（`审查模型返回空内容（通常是 maxTokens 被推理阶段用满）`），不与"输出不是 JSON"混成一句。这里没有 provider / model / apiKey，刻意的：审查走**本体配置**（`agent-default-model` 条目）与**统一 Key**（`$DSH_HOME/.credentials.yaml`），换审查模型改本体设置即可。

### 命名空间必须用 schemastery

命名空间用 **schemastery**（`@deepseek-ai/schemastery`）——**不是 zod**：`dsh-settings` 会把 schema 交给 `resolveConfig` / 当函数调用（`schema(mergeLayers(base, section))`），zod 的对象不可调用，注册会抛 `schema is not a function`，命名空间永远注册不上。换成 schemastery 是必要条件，不是充分条件 —— 0.1.7-rc.1 的 `ctx.settings` 连 `register()` 都没有，"注册成功 → 出现在设置面板"这条路现在是断的。

## 六、`/approval` 命令

由 `commands.register()` 注册（`commands` 服务不可用时只写一行日志，插件其余功能不变）：

| 命令 | 作用 |
|---|---|
| `/approval` / `/approval status` | 当前状态（开关、放行上限、内存里最近决策条数） |
| `/approval on` / `/approval off` | 开/关自动审批（写设置；**配置面坏时返回 `kind:'error'`**） |
| `/approval why` | 最近 8 条审批决策（放行还是问用户、为什么） |
| `/approval rules` | 当前生效的规则表（上限、前 12 个关键词、白名单、必问表、日志路径） |

已知小瑕疵（`lib/index.js` 的命令 handler）：`/approval why` 每行打印的是 `d.grade`，而决策条目里写的是 `ruleGrade` → 那个中括号位置**永远显示 `-`**；要看规则分级请直接读 JSONL 里的 `ruleGrade`。客户端半身 `lib/client.js` 只做一件事：Host 侧命令描述符白名单是冻结的（写 `icon` 会被丢掉），而注册同名 contribution 会让 `ui-commands` 抛错、**整个「指令」分组消失** ⇒ 只能在候选行返回后给 `/approval` 那一行补一个 `IconShieldOutline16`；任何一步不成立都只是"没有图标"，不影响宿主插件。

## 七、生效方式（必须重启宿主）

`dsh-auto-approval` 是 out-of-tree 插件：**补丁层是热加载的，插件源码不是**（ESM 模块缓存）。重启方式：本仓自研壳用托盘「重启宿主（重载插件）」（或宿主崩溃自动重启）；自建 DSH 结束 `dsh web` 进程重新起（同一 `DSH_HOME` 别并发起两个宿主）；**官方 DSH 桌面端未实测**，稳妥做法是完全退出应用再启动（只关窗口可能只是最小化）。

重启后确认 `$DSH_HOME/logs/auto-approval.log` 里最新那条 `plugin-loaded` 的 `why`：`settings=ok` 表示配置面可用（0.1.7-rc.1 上当前代码必然不是这个）；`settings.register 抛错：…` / `schemastery 解析不到` / `settings 服务不可用` 表示配置面坏了（`/approval on|off` 会报错、规则表改不了，插件按 `DEFAULTS` 工作）；`commands=unavailable` 表示 `/approval` 没注册（其余功能不受影响）。

## 八、不要动这个：`{ global: true, prepend: true }`（少一个，插件就静默失效）

```js
ctx.on('approval/request', handler, { global: true, prepend: true })
```

**两个选项各管一个维度，缺一不可**，缺了不会有任何报错 —— 插件照常装载、`settings=ok` 照写、日志照打，但请求永远轮不到它，用户照旧看到卡片、照旧手点。

| 选项 | 管什么 | 缺了会怎样 |
|---|---|---|
| `prepend` | **顺序** | 审批瀑布按**注册顺序**执行（`waterfall()` 里是 `cbs.shift()`），而 DSH 自己的桥（`dsh-api-remotes`）注册得早、且**拿到用户答复就直接 resolve 整条链（不调 `next()`）** → 排在桥后面的监听**永远不会被执行** |
| `global` | **作用域** | 绕过 `dsh-scope` 的作用域过滤（`dispatch` 里的 `hook.global` 短路）；审批瀑布是按 agent 作用域派发的 |

同一条纪律的另外两面（都写进了自检）：`ctx.on` 必须在 `apply()` 的**同步段**注册 —— Cordis 的 `dispatch()` 只读**派发目标 ctx 自己**的 `_hooks`，不向上遍历作用域链，而注册时机决定 effect 落在哪个作用域；`tools/pre-execute` 同样要 `global`，但**不该** `prepend`（它只观察，不抢顺序）。

## 九、与本体"权限预设"的关系

本体**没有**自动审批：只有 `ask`（每次都问）与 `never`（**拒绝**，且不进审批瀑布），唯一的"准予"结果是 `allowed-once`，本体自己从不主动产出它（源码原话：`allowed-once is the only grant`）。权限预设「完全权限」不弹窗，是因为它把沙箱开到最大、**让审批请求根本不再产生**——那是**绕开**审批，不是**通过**审批，而且它与本插件**互斥**（`never` 在瀑布之前就短路，本插件收不到请求）。要"AI 自己判断该不该放行"，只有本插件这条路。

## 十、与 Codex 自动审批的对应关系

| Codex | 本插件 |
|---|---|
| auto 模式：有界操作自动过 | **独立模型审查**（`reviewerEnabled`）：看懂这次请求要干什么再放 |
| 危险操作仍需确认 | 模型判 `ask`，或命中 `alwaysAskTools` / 无 reason 硬拦 → `next()` |
| 固定规则表 | `highRiskPatterns` 只作**证据**喂给模型，不再单独裁决 |
| 用户可切换模式 | `enabled` 开关（设置面 / `/approval on\|off`） |
| 决策可追溯 | `logs/auto-approval.log` + `/approval why` |

## 十一、自检

在插件目录里跑：

```powershell
cd D:\Desktop\deepseek\plugins\dsh-auto-approval
node test\grade-self-test.mjs    # 规则分级器纯函数：10 断言（作为审计信号仍保留）
node test\apply-self-test.mjs    # 接线级：mock ctx 驱动 apply()，47 断言
```

两套都已纳入仓库门禁清单（`desktop-electron\scripts\test-suite.mjs` 的 `SUITES`，条目写作 `plugins/dsh-auto-approval/test/*.mjs`）；合计 **57 断言**。

| 现象 | 原因 | 处置 |
|---|---|---|
| `自检需要 schemastery：既不在仓库 vendor 树、也不在仓库 node_modules` | `apply-self-test.mjs` 的两条候选路径（`../../../desktop-electron/vendor/profile/node_modules/...` 与 `../../../desktop-electron/node_modules/...`）都缺（例如 CI 的全新 checkout 既没 `npm ci` 也没建 vendor 树） | 跑 `npm ci`（或 `npm run build:host`）把树建起来 |
| `FAIL  settings 命名空间注册成功（schema 被当函数调用）` | 用了 zod（不可调用）而不是 schemastery | 换回 `@deepseek-ai/schemastery`（枚举用 `z.union`，schemastery 没有 `z.enum`） |

`apply-self-test` 的 mock 照真实服务的契约来：`settings.register(ns, schema)` 会检查 `typeof schema === 'function'` 并真的调用它解析默认值。仓库包目录上解析不到 schemastery / dsh-llm（在 vendor 树里），所以自检通过 `__injectSchemaLib()` 与 `__injectReviewer()` 显式注入；生产路径走插件自己的动态导入。断言覆盖：预筛四条路径（硬拦 / 快路 / 交审查）、`parseVerdict` 的多种失败收敛、四个端到端分支（模型判 allow 时即使命中高风险词也放行 / 判 ask → 转问用户 / 审查器抛错 → fail-closed / 审查器关闭 → 不问模型直接问用户）、"真实命令"的取回链路，以及客户端半身的五条打包契约（`exports["./client"]`、保留 `exports["."]`、`dsh.client.platform === "web"`、bundle 用包名自注册、只 require seed 模块）。

## 十二、已知问题

| # | 问题 | 影响 |
|---|---|---|
| 1 | 用了 `settings.register()`，而 0.1.7-rc.1 的 `ctx.settings` 没有这个方法 | 配置面不可用：永远走 `DEFAULTS`，`/approval on\|off` 报错，设置面板无此项 |
| 2 | 命名空间写成 `auto-approval`，与本体做法不符（本体按**条目 id** 认命名空间，`describe()` 用 `entry.options.id`） | 即使修好注册，用户也得把配置写在 `dsh-auto-approval` 这个 id 下 |
| 3 | `reviewTimeoutMs` / `reviewMaxTokens` 的 `<=0` 回退值与默认值不一致（8000 / 200） | 把 `reviewMaxTokens` 填成 0 就静默退化到事故值 200（审查恒 ask） |
| 4 | `/approval why` 打印 `d.grade`，决策条目里叫 `ruleGrade` | 该列恒为 `-`，不影响裁决 |
| 5 | `test/apply-self-test.mjs` 的 schemastery 回退路径相对仓库根，不在插件目录上 | 在仓库根直接 `node plugins/...` 会报"需要 schemastery"；从 `desktop-electron/` 跑正常 |
| 6 | 默认 `lowRiskTools` 里的 `check-dsh-env` 在 0.1.7-rc.1 vendor 树里搜不到 | 该条对别的 DSH 环境是空转；不影响其它规则 |
| 7 | 规则表、`RECENT_CALL_LIMIT=20`、审查提示词等常量不可配 | 只能改代码 |

## 十三、未验证事项

| 事项 | 状态 |
|---|---|
| 官方 DSH 桌面端端到端装一遍（`%USERPROFILE%\.dsh\profiles\desktop\`） | 只读过只读目录结构（`profiles\desktop\` 存在、含 `node_modules\dsh-plugin-wallpaper-engine`、`cordis.patch.yml` 有 `agent-default-model` 段），没有实际拷贝 + 挂载 + 重启 |
| 官方桌面端怎么"重启宿主" | 官方端没有托盘项；完全退出再启动是推断 |
| home 层补丁 `$DSH_HOME\cordis.patch.yml`；`dsh plugin --profile desktop add <spec>` | home 层本体源码会读它（叠加在每个 profile 之上），当前环境无此文件；CLI 明确拒绝 `--profile desktop`，只能手工拷 |
| 修改后的配置面（`Config` 导出 + `.volatile()` + `- id: dsh-auto-approval / config:`）能跑通 | 推断，未在插件上实现，没有实测 |
| `apply-self-test.mjs` 的 47 断言实跑 | 插件树解析不到 schemastery，只实跑了 `grade-self-test.mjs`（10/10）；47 来自测试文件里 47 处 `ok(...)` 调用 |
| 其它 harness 的等价事件名/签名；`dsh-scope` 里 `{ global: true }` 短路的具体代码路径 | 第四节的清单是"要满足什么"，不是"别人已经这么叫"；只核实了桥那一侧的"不调 `next()`"（`forwardWaterfall()`），`hook.global` 短路未重新逐行读 dispatcher |
| `/approval` 各子命令的实际输出 | 命令表来自 `lib/index.js` 的 handler 代码，未逐条执行 |
