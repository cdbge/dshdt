# plugins/ — 从 dshdt 摘出来的自研插件

dshdt 停更时从壳里摘出的三个自研插件，与壳解耦，可单独复用：

| 插件 | 侧 | 一句话 | 复用结论 |
|---|---|---|---|
| [`dsh-auto-approval`](dsh-auto-approval/README.md) | 宿主（Host） | 审批瀑布上抢在用户弹窗之前裁决权限申请：关键词只作证据，裁决交给一次独立模型调用（fail-closed） | ✅ **可独立复用**：装进官方桌面端或任意自建 DSH（配置面有已知问题，见它的 README） |
| [`dsh-desktop-ui`](dsh-desktop-ui/README.md) | 客户端（浏览器） | 设置面板里的「桌面」「个性化」两个分区 + 皮肤 CSS | ⚠️ **壳配套**：只跟 dshdt 的 admin API 对话，换后端要按文档改 |
| [`dsh-market`](dsh-market/README.md) | 客户端（浏览器） | 左侧栏底部「市场」入口：插件 / 美化包目录与壳内安装 | ⚠️ **壳配套**：目录数据、下载、落盘全走壳的 admin API |

> 只有 `dsh-auto-approval` 通用：另两个的能力都做在壳的 admin API（`http://127.0.0.1:25439`）上。

## 装到哪儿

插件位按 profile 分：

| 宿主 | profile | 插件位（Windows） |
|---|---|---|
| 官方 DSH 桌面端（0.2+） | `desktop` | `%USERPROFILE%\.dsh\profiles\desktop\node_modules\<包名>\` |
| dshdt 壳 / 自建 `dsh web`（默认） | `web` | `%USERPROFILE%\.dsh\profiles\web\node_modules\<包名>\` |

> 官方端用 `desktop` profile，dshdt 用 `web`；下面示例按目标宿主替换。

| 项 | 位置 |
|---|---|
| 插件位 | `$DSH_HOME/profiles/<profile>/node_modules/<包名>/`；目录内容 = 该插件的 `package.json` + `lib/` |
| 挂载 | `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里加 `- insert:` 行（结尾是 `[]` 时要替换它，别写成两个 YAML 节点） |
| 生效 | 客户端插件：重启应用；宿主插件：重启宿主（补丁层热加载，插件源码不热加载） |

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml（dshdt 是 web，官方桌面端是 desktop）
- insert:
    - id: dsh-auto-approval
      name: dsh-auto-approval
    - id: dsh-desktop-ui
      name: dsh-desktop-ui
    - id: dsh-market
      name: dsh-market
```

```powershell
# 手工拷一份（以 dsh-auto-approval 装进官方桌面端为例）
$dst = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-auto-approval"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item -Force .\plugins\dsh-auto-approval\package.json $dst\
Copy-Item -Recurse -Force .\plugins\dsh-auto-approval\lib $dst\
```

三个包都是 `private: true`、未发 npm，所以**不能**用 `dsh plugin add dsh-auto-approval` 这类坐标安装，走手工拷贝。

> 官方端把 `desktop` 当保留 profile 管理，第三方命令行安装未验证；手工拷贝 + 补丁层是可行路径。

## 实现契约在哪儿

| 要复用什么 | 看哪一节 |
|---|---|
| 壳 admin API 的全部端点（方法 / 请求 / 响应 / 超时）与 `status` 快照字段 | [`dsh-desktop-ui/README.md`](dsh-desktop-ui/README.md) 的「实现契约：壳 admin API」 |
| 市场的 admin API 与 `catalog.json` 目录格式 | [`dsh-market/README.md`](dsh-market/README.md) 的「实现契约」 |
| 审批瀑布挂点（`approval/request`、`tools/pre-execute`）与返回语义（`allowed-once` / `next()`） | [`dsh-auto-approval/README.md`](dsh-auto-approval/README.md) 的「实现契约」 |
| 「要复用需要改什么」清单 | 每份 README 末尾的「⚠️ 耦合与限制」 |

## 改插件后

1. **重算清单**（壳的「仓库功能更新」按 `desktop-electron/components.json` 的 `repoPath` + `sha256` 取文件）：
   ```powershell
   cd desktop-electron
   node scripts/gen-components.mjs          # 重新生成
   node scripts/gen-components.mjs --check  # 校验（不一致就红）
   ```
2. **跑自检**：`npm run test:suite`（含插件自己的两套：`plugins/dsh-auto-approval/test/*.mjs`）。

## 许可
[MIT](../LICENSE)（与仓库一致）。
