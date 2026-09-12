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
  autoApproveUpTo: medium    # low=只放行白名单工具；medium=另放行"带明确 reason 且无高风险词"的请求
  highRiskPatterns: [...]    # 命中即必问（覆盖默认表）
  lowRiskTools: [...]        # 白名单工具（read/grep/glob/web_search/...）
  alwaysAskTools: [...]      # 必问工具（cordis_run/workflow/ralph...）
  logDecisions: true
  logFile: ''                # 默认 $DSH_HOME/logs/auto-approval.log
```

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

## 分级规则（默认）

| 判定 | 条件 | 处理 |
|---|---|---|
| **high** | 命中 `highRiskPatterns`（`danger-full-access`/`sudo`/`registry`/`taskkill`/`C:\Windows`/`工作区外`…）、或工具在 `alwaysAskTools`、或**请求没带 reason** | 问用户 |
| **medium** | 有明确 reason 且不含高风险词 | `autoApproveUpTo=medium` 时放行，否则问用户 |
| **low** | 工具在 `lowRiskTools`（纯读/查询类） | 放行 |

设计取舍（安全方向）：

1. **只做加法**：任何判不准的情况都走 `next()`——失败方向永远是"问用户"，不是"放行"。
2. **一次一授权**：返回的是 `'allowed-once'`，与 DSH 语义一致，不做长期白名单。
3. **不干扰原生机制**：会话策略为 `never` 时 harness 自己就拒；`permissionPresets` 的两个旋钮（沙箱模式 + 审批策略）照旧生效，本插件只是在 `ask` 路径上做前置裁决。
4. **可审计**：每条决策都写 JSONL（时间、工具、reason、等级、放行/转问），`/approval why` 直接看最近几条。

## 自检

```powershell
cd desktop-electron\packages\dsh-auto-approval
node test\grade-self-test.mjs    # 分级器纯函数（10 断言，含大小写/中文关键词/空入参）
node test\apply-self-test.mjs    # 接线级：mock ctx 驱动 apply()，13 断言
```

两套都已纳入离线门禁（合计 23 断言，见《代码规范与范例.md》第 6 节）。

> `apply-self-test` 的 mock **照真实服务的契约来**：`settings.register(ns, schema)` 会检查
> `typeof schema === 'function'` 并真的调用它解析默认值。初版 mock 把这个参数整个忽略，
> 于是"传了个不可调用的 schema"这个真实故障在自检里永远看不见——**mock 松一寸，故障就多藏一层**。
>
> 仓库包目录上面没有 `node_modules`，解析不到 schemastery（它在 vendor 树里），
> 所以自检通过 `__injectSchemaLib()` 显式注入一份（从 `desktop-electron/vendor/profile` 取）；
> 生产路径永远走插件自己的动态导入。

## 生效方式（**必须重启宿主**）

`dsh-auto-approval` 是 out-of-tree 插件：**补丁层是热加载的，插件源码不是**（ESM 模块缓存）。
改完 `lib/index.js` 后，从托盘「重启宿主（重载插件）」让新代码进内存。
重启后确认 `$DSH_HOME/logs/auto-approval.log` 里最新那条 `plugin-loaded` 的 `settings=` 是 **`ok`**
（若是 `unavailable` 或 `settings.register 抛错…`，说明配置面又坏了，`/approval on|off` 也会报错）。

## 与本体"权限预设"的关系（重要）

本体**没有**自动审批：它只有 `ask`（每次都问）与 `never`（**拒绝**，且不进审批瀑布），
唯一的"准予"结果是 `allowed-once`，本体自己从不主动产出它。权限预设「完全权限」不弹窗，
是因为它把沙箱开到最大、**让审批请求根本不再产生**——那是**绕开**审批，不是**通过**审批，
而且它与本插件**互斥**（`never` 在瀑布之前就短路，本插件收不到请求）。
要"AI 自己判断该不该放行"，只有本插件这条路。

## 与 Codex 自动审批的对应关系

| Codex | 本插件 |
|---|---|
| auto 模式：有界操作自动过 | `autoApproveUpTo: medium` + 高风险词表拦截 |
| 危险操作仍需确认 | `highRiskPatterns` / `alwaysAskTools` → `next()` |
| 用户可切换模式 | `enabled` 开关（settings / `/approval on|off`） |
| 决策可追溯 | `logs/auto-approval.log` + `/approval why` |
