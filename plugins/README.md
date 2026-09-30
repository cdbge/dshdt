# plugins/ — 从 dshdt 摘出来的自研插件

这里有三个插件，原先是 dshdt 桌面壳的自带插件（放在 `desktop-electron/packages/`），2026-09-30 壳停更时**摘到仓库顶层**，与壳解耦，方便日后复用：

| 插件 | 侧 | 一句话 | 复用结论 |
|---|---|---|---|
| [`dsh-auto-approval`](dsh-auto-approval/README.md) | 宿主（Host） | 审批瀑布上抢在用户弹窗之前裁决权限申请：关键词只作证据，裁决交给一次独立模型调用（fail-closed） | ✅ **可独立复用**：装进官方桌面端或任意自建 DSH 即可（⚠️ 配置面有已知问题：`settings.register` 在 DSH 0.1.7-rc.1 上不存在，插件实际按代码默认值跑 —— 见它 README 的「已知问题」） |
| [`dsh-desktop-ui`](dsh-desktop-ui/README.md) | 客户端（浏览器） | 设置面板里的「桌面」「个性化」两个分区 + 皮肤 CSS | ⚠️ **壳配套**：只跟 dshdt 的 admin API 对话，换后端要按文档改 |
| [`dsh-market`](dsh-market/README.md) | 客户端（浏览器） | 左侧栏底部「市场」入口：插件 / 美化包目录与壳内安装 | ⚠️ **壳配套**：目录数据、下载、落盘全走壳的 admin API |

> 为什么只有一个是通用的：壳（dshdt）把"能力"做在了 Node 侧的 admin API 上（`http://127.0.0.1:25439`），两个客户端插件只是它的界面；`dsh-auto-approval` 挂在 DSH 自己的审批瀑布上，跟壳无关。

## 装到哪儿（先分清 profile）

插件位是**按 profile 分的**，装错 profile 等于没装：

| 宿主 | profile | 插件位（Windows） |
|---|---|---|
| 官方 DSH 桌面端（0.2+） | `desktop` | `%USERPROFILE%\.dsh\profiles\desktop\node_modules\<包名>\` |
| dshdt 壳 / 自建 `dsh web`（默认） | `web` | `%USERPROFILE%\.dsh\profiles\web\node_modules\<包名>\` |

> 实测（2026-09-30，官方端 `0.2.0-rc.2`）：官方端把宿主起在 `profiles\desktop`（它的 `node_modules` 里有官方 CLI 装的 `dsh-plugin-wallpaper-engine`），dshdt 用 `profiles\web`。下面示例里的 `web` 请按目标宿主替换成 `desktop`。

| 项 | 位置 |
|---|---|
| 插件位 | `$DSH_HOME/profiles/<profile>/node_modules/<包名>/`；目录内容 = 该插件的 `package.json` + `lib/` |
| 挂载 | `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里加 `- insert:` 行（模板结尾是 `[]` 时要**替换**它，写成两个 YAML 节点会让宿主启动即抛 YAMLException） |
| 生效 | 客户端插件：重启应用（宿主的 ESM 模块缓存按 URL 取，做不到"改完即见"）；宿主插件：**必须重启宿主**（补丁层是热加载的，插件源码不是） |

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

> 官方端把 `desktop` 当**保留 profile** 独占管理：CLI 对启动类命令直接拒绝（`profile "desktop" is managed exclusively by the Electron application`，0.2.0-rc.2 实测原文），但帮助文本又提示「初始化后可以跑 `dsh plugin --profile desktop`」——插件管理这条路是留给官方端的，本次**未实测**。手工拷贝 + 补丁层是确定可行的路径。

## 实现契约在哪儿

| 要复用什么 | 看哪一节 |
|---|---|
| 壳 admin API 的全部端点（方法 / 请求 / 响应 / 超时）与 `status` 快照字段 | [`dsh-desktop-ui/README.md`](dsh-desktop-ui/README.md) 的「实现契约：壳 admin API」 |
| 市场的 admin API 与 `catalog.json` 目录格式 | [`dsh-market/README.md`](dsh-market/README.md) 的「实现契约」 |
| 审批瀑布挂点（`approval/request`、`tools/pre-execute`）与返回语义（`allowed-once` / `next()`） | [`dsh-auto-approval/README.md`](dsh-auto-approval/README.md) 的「实现契约」 |
| 「要复用需要改什么」清单 | 每份 README 末尾的「⚠️ 耦合与限制」 |

## 改插件时别忘的两件事

1. **重算清单**：壳的「仓库功能更新」按 `desktop-electron/components.json` 里的 `repoPath` + `sha256` 取文件，插件部分现在指 `plugins/<包名>/…`。改了插件就要
   ```powershell
   cd desktop-electron
   node scripts/gen-components.mjs          # 重新生成
   node scripts/gen-components.mjs --check  # CI 用的校验（不一致就红）
   ```
2. **跑自检**：`npm run test:suite`（30 套离线自检，含插件自己的两套：`plugins/dsh-auto-approval/test/*.mjs`）。

## 许可
[MIT](../LICENSE)（与仓库一致）。
