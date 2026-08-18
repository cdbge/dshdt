# 工作区导航 — DeepSeek Harness 桌面化项目

> 本仓库 = DSH 桌面化全项目。三份计划/施工文档是事实源，代码在两个 shell 目录。

## 目录速查

| 路径 | 内容 |
|---|---|
| `DeepSeek-Harness桌面应用封装计划书.md` | 主计划书：DSH 架构拆解 + 方案选型 + 里程碑 + 验收标准 |
| `Electron构建安装包计划书.md` | Electron 路线细化：模式 B、构建流水线、签名、实战坑清单 |
| `Electron施工计划与进度.md` | **唯一进度事实源**：前置核对、阶段快照、恢复协议、检查点 |
| `开发注意事项与命名规则.md` | 本项目实战沉淀：沙箱/Windows/Node/electron-builder 坑与命名约定 |
| `desktop-electron/` | **当前主路线**：Electron 壳源码 + 构建脚本 + 安装包产物（`dist/`） |
| `desktop-shell/` | v1（Node+Chrome 壳）归档：已由 Electron 版取代，保留为轻量回退分支与行为契约母本 |

## 常用命令（desktop-electron/ 下）

```powershell
npm start / npm run dev     # 窗口模式（dev 保留 DevTools）
npm run smoke               # 端到端全量冒烟（21 断言）
npm run build:host          # 生成 vendor/profile（含剪枝与 ABI 门禁；--prune-only 增量剪枝）
npm run dist                # electron-builder 打 NSIS 安装包（dist\DSHDesktop-Setup-<ver>.exe）
pwsh -File scripts\dev-sign.ps1    # 本地自签证书（签名打包见 README）
npx electron . --doctor      # 环境体检
```

## 产物

- **安装包**：`desktop-electron/dist/DSHDesktop-Setup-0.4.0.exe`（128.8MB，自签）+ blockmap
- **版本链**：v1（Node+Chrome）0.3.0 → Electron 0.4.0；DSH 依赖锁定 0.1.0-rc.6
- **发布状态**：暂不发布（个人使用与分享）；证书（EV）与 GitHub Releases 差分更新通道按需激活，步骤见 desktop-electron/README.md
