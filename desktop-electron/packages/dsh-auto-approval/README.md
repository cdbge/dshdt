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

命名空间带 zod schema 注册，因此也应出现在 DSH 设置面板的表单里（`dsh-client-schema-form`）。

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
cd $env:DSH_HOME\profiles\web\node_modules\dsh-auto-approval
node test\grade-self-test.mjs      # 分级器纯函数自检（10 断言，含大小写/中文关键词/空入参）
```

## 与 Codex 自动审批的对应关系

| Codex | 本插件 |
|---|---|
| auto 模式：有界操作自动过 | `autoApproveUpTo: medium` + 高风险词表拦截 |
| 危险操作仍需确认 | `highRiskPatterns` / `alwaysAskTools` → `next()` |
| 用户可切换模式 | `enabled` 开关（settings / `/approval on|off`） |
| 决策可追溯 | `logs/auto-approval.log` + `/approval why` |
