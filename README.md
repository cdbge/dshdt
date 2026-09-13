# dshdt — DeepSeek Harness 桌面版（Electron 壳）

> 把 **DSH（DeepSeek Harness）的 Web 界面装进一个独立的桌面应用**：托盘常驻、独立窗口、一键起停宿主、
> 壁纸与皮肤、DSH 版本更新按钮，以及一个**由模型自行裁决权限申请**的审批插件。
> **DSH 本体零改动** —— 壳侧的能力全部走 `--port` / `--patch` / 回环 admin API / 环境变量 / 浏览器 CSS 注入。
> 平台：**Windows 优先**（安装包为 NSIS），Electron 主路线。

当前版本 **0.4.6**（版本号由项目所有者指定，见 `desktop-electron/VERSION`）。

## 它是什么

- **一个 Electron 壳（模式 B）**：把 DSH 的宿主进程作为子进程托管（`ELECTRON_RUN_AS_NODE`），
  自己负责窗口 / 托盘 / 端口 / 就绪探测 / 优雅退出 / 崩溃诊断，界面仍是 DSH 自己的 Web UI。
- **自带两个 out-of-tree 插件**（落在 DSH 的 profile 插件位，不打补丁进 DSH 源码）：
  - `dsh-desktop-ui`：设置面板里的「桌面」分区（壁纸、遮罩、亮度、模糊等）。
  - `dsh-auto-approval`：在审批瀑布上**抢在用户弹窗之前**，用一次独立模型调用裁决权限申请（fail-closed，可 `/approval` 开关）。

## 它不是什么

- 不是 DSH 的分支或魔改版，**不含** DSH 源码。
- 不是跨平台成品：目前在 Windows 上实测与打包，macOS/Linux 未验证。
- **不含任何密钥**：模型凭证由 DSH 自己管理，壳不读不写（仓库里也永远不会有）。

## 主要能力

| 能力 | 说明 |
|---|---|
| 宿主托管与多窗口复用 | `.dsh-host.lock` + `netstat` 探端口 + 就绪握手；同 home 只起一个宿主，窗口加开时复用 |
| 崩溃可诊断 | 宿主 stdio 两级化（管道优先 + 环形缓冲保留"最后遗言"）、`--diag` 一键取证、启动前 preflight、`--doctor` 体检 |
| 优雅退出 | 退出时停宿主、清状态、留日志；锁与临时文件可回收 |
| 桌面化外观 | 壁纸（含亮度/模糊）、对话区与侧栏遮罩、全屏态独立档位、透明滚动条、按钮 hover/active 交互 |
| DSH 更新按钮 | 版本发现（S1）→ vendor 树构建（S2）→ 换树与回滚（S3）：跨版本升级默认拒绝，需显式 `allowUnsafeJump` |
| 会话日志自愈 | 半个 zstd 尾帧截断 / 首帧异常逐行重编码 / 无法修复则隔离改名 |
| 权限审批自动化 | `dsh-auto-approval`：关键词表只作证据，裁决权交给一次独立模型调用，决策写审计日志 |
| profile 补丁层自愈 | 每次启动修复被写坏的 `cordis.patch.yml`（YAML 双节点事故，见坑 59） |

## 快速开始（开发运行）

前置：Windows、Node.js 24+、能访问 npm registry（构建 vendor 时需要 DSH 的 `@deepseek-ai/*` 包）。

```powershell
cd desktop-electron
npm install
npm run build:host        # 生成 vendor/profile（自包含 DSH 运行时；含剪枝与 ABI 门禁）
npm start                 # 窗口模式；npm run dev 保留 DevTools
```

> ⚠️ 在 AI 会话/被托管的环境里跑 electron 前，先 `Remove-Item Env:ELECTRON_RUN_AS_NODE`：
> 这个变量会让 `electron.exe` 退化成纯 Node，表现为"无窗口无日志"（坑 2）。

常用命令：

```powershell
npm run smoke                     # 端到端全量冒烟（**72 断言**，需完整权限，见坑 1/14）
node scripts\repair-self-test.mjs  # 等等 9 套离线自检，合计 242 断言（清单见 docs/项目/04-范例与检查点.md §6）
npm run dist                      # electron-builder 打 NSIS 安装包（**需项目所有者同意**）
& "dist\win-unpacked\DSH Desktop.exe" --diag   # 一键取证（路径 / 环境变量 / preflight / 日志尾部）
```

## 打包与产物

- 产物在 `desktop-electron/dist/`：`DSHDesktop-Setup-<版本>.exe`（NSIS）+ `.blockmap` + `win-unpacked/`。
- **产物不入库**（见 `.gitignore`）：安装包走 **GitHub Releases** 分发。
- 当前 0.4.6 安装包约 **127.4 MB**，**未签名** —— 首次运行出现 SmartScreen 提示属预期（沙箱环境无网络，签名时间戳服务器不可达，见坑 8）。
- 打包含**跨版本运行时**：`vendor/profile` 由 `build-host.mjs` 生成，版本锁在 `vendor/vendor.lock.json`。

## 文档导航

| 文书 | 内容 |
|---|---|
| **`docs/通用/`** | **与项目无关的通用规范，可整目录拷进任何新项目** |
| ├ `01-代码规范.md` | 命名、目录、风格、错误处理、状态可逆、配置与密钥、日志、依赖、安全 |
| ├ `02-提交与门禁.md` | 提交信息规范、门禁分层、检查点协议、版本与发布纪律、公开仓库前体检清单 |
| ├ `03-AI协作与文档义务.md` | 单一事实源、开工清单模板、交接便条模板、文档同步矩阵、AI 协作铁律 |
| └ `04-排障方法与通用坑.md` | 六步排障法、坑清单模板、Windows/Node/文件系统/Electron 通用坑、验证技法、判据表 |
| **`docs/项目/`** | **本项目专属** |
| ├ `00-文档导航.md` | 入口与旧→新文书对照表 |
| ├ `01-新会话开工清单.md` | ★ 接手先读：状态锚点、交接便条、下一步、挂起事项 |
| ├ `02-架构与铁律.md` | 项目铁律、工程地图、DSH 侧规则、命名落点 |
| ├ `03-坑清单.md` | ★ 60 条编号坑（现象/根因/修法/验证/通用教训） |
| ├ `04-范例与检查点.md` | 端到端代码范例、检查点命令清单、提交规范 |
| └ `计划/` | 四份计划与进度文书（`Electron施工计划与进度.md` 是**唯一进度事实源**） |
| `desktop-electron/README.md` | 代码侧说明：结构、构建、排障（含"别人机器起不来"的两类判据表） |
| `desktop-electron/CHANGELOG.md` | 按版本倒序的变更与事故复盘 |

## 仓库结构

```
.
├─ desktop-electron/        # 当前主路线：Electron 壳
│  ├─ src/                  #   主进程与壳能力（main/host/admin/dsh-apply/vendor-build/…）
│  ├─ packages/             #   两个自带 DSH 插件（客户端 UI + 权限审批）
│  ├─ scripts/              #   构建与门禁（smoke、各 *-self-test、build-host、gen-icon…）
│  ├─ build/                #   打包资源（icon.ico）
│  ├─ vendor/               #   vendor.lock.json（vendor/profile 由构建生成，不入库）
│  └─ dist/                 #   产物（不入库）
├─ docs/通用/ · docs/项目/  # 文书（见上）
├─ dsh.jpeg                 # 图标源图（scripts/gen-icon.mjs → build/icon.ico）
├─ LICENSE                  # MIT
└─ .gitattributes/.gitignore
```

## 已知限制

1. **未签名安装包**：SmartScreen 会拦一次；证书与正式发布通道未启用。
2. **壳自更新未启用**：`HAS_UPDATE_SOURCE` 门控关闭，目前只支持 **DSH 本体**的更新按钮（设计见《DSH更新按钮计划书.md》§11）。
3. **vendor 由 DSH 包构建**：需要能访问对应 registry；不同版本的 DSH 可能改变 DOM 结构（皮肤选择器依赖锁定的版本）。
4. **仅 Windows 实测**。
5. 已知问题与排查步骤见 `desktop-electron/README.md` 与 `docs/项目/03-坑清单.md`。

## 仓库与发布

仓库已发布：**https://github.com/cdbge/dshdt**（public，MIT，默认分支 `main`）。
源码与文书入库；**安装包等产物不入库**（`.gitignore` 覆盖 `dist/`），走 **Releases** 分发：

**0.4.6 安装包已发布** → [Releases · v0.4.6](https://github.com/cdbge/dshdt/releases/tag/v0.4.6)：
`DSHDesktop-Setup-0.4.6.exe`（127.4 MB，**未签名**，`SHA256 = 481009BD5710C5258A53EE5B5EDBEA78AF3FA804E3AE3F9A1A3D0EF04EF3F505`）。

下次发版：Releases → Draft a new release → 新建 tag <版本> → 上传 desktop-electron/dist/DSHDesktop-Setup-<版本>.exe。
**不要把 exe 提交进仓库**（Git 历史会永久保留二进制）。

**本机排障（两个坑，都会伪装成"没有网络"）**：

1. **schannel TLS 在受控会话里失效**（`schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`）——
   其实网络是通的，换 OpenSSL 后端即可：`git -c http.sslBackend=openssl <git 命令>`。
2. **git 的 `sh.exe` 起不来**（`couldn't create signal pipe, Win32 error 5`，沙箱拦截命名管道）——
   所以 `!f() { … }` 这类 shell 形式的 credential helper 不可用；凭据由 Git Credential Manager 保管
   （`cmdkey /list` 里可见 `git:https://cdbge@github.com`），需要时用它注入本次操作即可。

日常推送：`git push`。远端已是 `https://github.com/cdbge/dshdt.git`，**配置里不含任何 token**。

## 许可

[MIT](LICENSE)
