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
        └── 高风险 / 判不准        ──► return next()，落到既有 answerer（用户确认弹窗）
```

## 安装位置与挂载

- 代码：`$DSH_HOME/profiles/web/node_modules/dsh-auto-approval/`（out-of-tree 插件位，与 `dsh-host-lock-registry` 同级）
- 挂载：`$DSH_HOME/profiles/web/cordis.patch.yml` 的用户补丁层

```yaml
- insert:
    - id: dsh-auto-approval
      name: dsh-auto-approval
```

> 实测要点：**补丁层是热加载的，插件源码不是**（ESM 模块缓存）。改完 `lib/index.js` 必须重启宿主
> （托盘「退出」→ 启动应用，或让壳的宿主崩溃自动重启）才会生效。

## 配置（走 DSH 本体的 settings 命名空间）

`$DSH_HOME/settings.yaml`：

```yaml
auto-approval:
  enabled: true              # 总开关
  autoApproveUpTo: medium    # low=只走白名单快路；medium=另允许模型审查放行
  highRiskPatterns: [...]    # 风险**证据**（命中会喂给审查模型，不再直接判死）
  lowRiskTools: [...]        # 白名单工具（read/grep/glob/web_search/...）→ 快路直接放行
  alwaysAskTools: [...]      # 必问工具（cordis_run/workflow/ralph...）→ 硬拦，不交模型
  reviewerEnabled: true      # 独立模型审查开关
  reviewTimeoutMs: 8000      # 单次审查超时；超时即按 ask 处理
  reviewMaxTokens: 200       # 只要一行 JSON，不需要大额度
  logDecisions: true
  logFile: ''                # 默认 $DSH_HOME/logs/auto-approval.log
```

**这里没有 provider / model / apiKey**，刻意的：审查走**本体配置**（`agent-default-model` 命名空间）
与**统一 Key**（`$DSH_HOME/.credentials.yaml`）。要换审查用的模型，改本体设置即可，本插件不用动。

命名空间用 **schemastery**（`@deepseek-ai/schemastery`）注册——**不是 zod**：
`dsh-settings` 的 `resolve()` 会把 schema **当函数调用**（`schema(mergeLayers(base, section))`），
zod 的对象不可调用，注册会抛 `schema is not a function`，命名空间就永远注册不上
（这个坑真踩过，见《代码规范与范例.md》坑 48）。注册成功后它会出现在 DSH 设置面板的表单里。

## 开关命令

在 DSH 会话里输入：

| 命令 | 作用 |
|---|---|
| `/approval` | 查看当前状态（开关、上限、最近决策条数） |
| `/approval on` / `/approval off` | 开/关自动审批（写入 settings） |
| `/approval why` | 最近 8 条审批决策（放行还是问用户、为什么） |
| `/approval rules` | 当前生效的规则表 |

## 审批裁决：预筛 + **独立模型审查**（v2）

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

### 审查器看到什么：**真实命令**，不只是理由

审批请求本身只有 `{toolName, reason, callId}` —— **没有 args**。而"只看理由"恰恰是最容易被误导的地方
（实测中模型自己抱怨过"理由与动作不匹配"）。所以插件额外做了一件事：

- 挂 `tools/pre-execute`（它在沙箱提权**之前**触发）记下 `callId → {name, arguments}`，
  存一张**上限 20 条**的小表；
- 审批到来时按 `callId` 取回，用 `summarizeArgs()` 压成有上限的可读文本：
  **喂给模型 1200 字、审计日志里留 300 字预览**。

于是审查输入里有三个字段：`reason`（智能体自述）、`matchedRiskKeywords`（证据）、
**`command`（真实参数）**。系统提示明确要求 **以 `command` 为准，与 `reason` 冲突时判 ask**；
取不到参数时会显式写 `(未取到该次调用的参数)`，免得模型误以为"命令为空"。

> 依据来自 Inspect 的 `ToolExecutionInput` 声明：`arguments: unknown` 就是那次调用的真实参数。

**模型从哪来：完全走本体配置。**
路由取自 `agentDefaultModel.currentSelection()`（也就是 `settings.yaml` 的 `agent-default-model` 段），
凭据由 `ctx.llm` 用**本体的统一 Key**。插件**不配置、也不接触** provider / model / apiKey ——
本体换模型、换 Key，这里自动跟着换。

**失败方向永远是"问用户"（fail-closed）**：没有 llm 服务 / 本体没配默认模型 / 调用超时 /
抛错 / 输出不是可解析的 JSON / 未知裁决 —— 一律 `ask`。审查器被关掉（`reviewerEnabled: false`）
或 `autoApproveUpTo: 'low'` 时，除快路外一律问用户，且**不发起任何模型调用**。

设计取舍：

1. **只做加法**：判不准就走 `next()`——失败方向永远是"问用户"，不是"放行"。
2. **一次一授权**：返回 `'allowed-once'`，与 DSH 语义一致，不做长期白名单。
3. **不干扰原生机制**：会话策略为 `never` 时 harness 自己就拒；`permissionPresets` 的两个旋钮照旧生效。
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

## 自检

```powershell
cd desktop-electron\packages\dsh-auto-approval
node test\grade-self-test.mjs    # v1 规则分级器纯函数（10 断言，作为审计信号仍保留）
node test\apply-self-test.mjs    # 接线级：mock ctx 驱动 apply()，27 断言
```

两套都已纳入离线门禁（合计 37 断言，见《代码规范与范例.md》第 6 节）。

> `apply-self-test` 的 mock **照真实服务的契约来**：`settings.register(ns, schema)` 会检查
> `typeof schema === 'function'` 并真的调用它解析默认值。初版 mock 把这个参数整个忽略，
> 于是"传了个不可调用的 schema"这个真实故障在自检里永远看不见——**mock 松一寸，故障就多藏一层**。
>
> 仓库包目录上面没有 `node_modules`，解析不到 schemastery / dsh-llm（它们在 vendor 树里），
> 所以自检通过 `__injectSchemaLib()` 与 `__injectReviewer()` 显式注入；
> 生产路径永远走插件自己的动态导入。
>
> 决策层 v2 的断言覆盖：预筛四条路径（硬拦 / 快路 / 交审查）、`parseVerdict` 的三种失败收敛、
> 以及四个端到端分支 —— **模型判 allow 时即使命中高风险词也放行**（证明词表已降级为证据）、
> 模型判 ask → 转问用户、审查器抛错 → fail-closed、审查器关闭 → 不问模型直接问用户。

## 生效方式（**必须重启宿主**）

`dsh-auto-approval` 是 out-of-tree 插件：**补丁层是热加载的，插件源码不是**（ESM 模块缓存）。
改完 `lib/index.js` 后，从托盘「重启宿主（重载插件）」让新代码进内存。
重启后确认 `$DSH_HOME/logs/auto-approval.log` 里最新那条 `plugin-loaded` 的 `settings=` 是 **`ok`**
（若是 `unavailable` 或 `settings.register 抛错…`，说明配置面又坏了，`/approval on|off` 也会报错）。

## ⚠️ 不要动这个：`{ global: true, prepend: true }`（少一个，插件就静默失效）

```js
ctx.on('approval/request', handler, { global: true, prepend: true })
```

**两个选项各管一个维度，缺一不可**，而且**缺了不会有任何报错** —— 插件照常装载、
`settings=ok` 照写、日志照打，但请求永远轮不到它，用户照旧看到卡片、照旧手点。

| 选项 | 管什么 | 缺了会怎样 |
|---|---|---|
| `prepend` | **顺序** | 审批瀑布按**注册顺序**执行（`waterfall()` 里是 `cbs.shift()`），而 DSH 自己的桥（`dsh-api-remotes`）注册得早、且**拿到用户答复就终止整条链（不调 `next()`）** → 排在桥后面的监听**永远不会被执行** |
| `global` | **作用域** | 绕过 `dsh-scope` 的作用域过滤（`dispatch` 里的 `hook.global` 短路） |

**2026-09-12 实测教训**：本插件曾"看起来一直正常"却从不自动放行 —— 用户以为"没有弹窗"，
实际上**那张卡片一直在弹、他亲手点了 54 次**（会话日志里 `approval/asked` 54 条、全部
`allowed-once`，间隔中位数 2640 ms）。根因就是注册排在桥之后。详见《代码规范与范例.md》坑 50。

## 与本体"权限预设"的关系（重要）

本体**没有**自动审批：它只有 `ask`（每次都问）与 `never`（**拒绝**，且不进审批瀑布），
唯一的"准予"结果是 `allowed-once`，本体自己从不主动产出它。权限预设「完全权限」不弹窗，
是因为它把沙箱开到最大、**让审批请求根本不再产生**——那是**绕开**审批，不是**通过**审批，
而且它与本插件**互斥**（`never` 在瀑布之前就短路，本插件收不到请求）。
要"AI 自己判断该不该放行"，只有本插件这条路。

## 与 Codex 自动审批的对应关系

| Codex | 本插件 |
|---|---|
| auto 模式：有界操作自动过 | **独立模型审查**（`reviewerEnabled`）：看懂这次请求要干什么再放 |
| 危险操作仍需确认 | 模型判 `ask`，或命中 `alwaysAskTools` / 无 reason 硬拦 → `next()` |
| 固定规则表 | `highRiskPatterns` 只作**证据**喂给模型，不再单独裁决 |
| 用户可切换模式 | `enabled` 开关（settings / `/approval on|off`） |
| 决策可追溯 | `logs/auto-approval.log` + `/approval why` |
