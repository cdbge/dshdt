# 工作区导航 — DeepSeek Harness 桌面化项目

> 本仓库 = DSH 桌面化全项目。三份计划/施工文档是事实源，代码在两个 shell 目录。

## 目录速查

| 路径 | 内容 |
|---|---|
| `DeepSeek-Harness桌面应用封装计划书.md` | 主计划书：DSH 架构拆解 + 方案选型 + 里程碑 + 验收标准 |
| `Electron构建安装包计划书.md` | Electron 路线细化：模式 B、构建流水线、签名、实战坑清单 |
| `Electron施工计划与进度.md` | **唯一进度事实源**：前置核对、阶段快照、恢复协议、检查点 |
| `开发注意事项与命名规则.md` | 本项目实战沉淀：沙箱/Windows/Node/electron-builder 坑与命名约定 |
| `代码规范与范例.md` | **AI 会话参考**：项目铁律、工程地图、坑清单、端到端代码范例、门禁与提交规范（每次开工先读） |
| `dsh.jpeg` | 应用图标源图（512×512）→ `desktop-electron/scripts/gen-icon.mjs` 生成 `build/icon.ico` |
| `desktop-electron/` | **当前主路线**：Electron 壳源码 + 构建脚本 + 安装包产物（`dist/`） |
| `desktop-shell/` | v1（Node+Chrome 壳）归档：已由 Electron 版取代，保留为轻量回退分支与行为契约母本 |

## 常用命令（desktop-electron/ 下）

```powershell
npm start / npm run dev     # 窗口模式（dev 保留 DevTools）
npm run smoke               # 端到端全量冒烟（31 断言，含背景图防回归）
node scripts\admin-bg-test.mjs      # admin 背景图单测（7 断言）
node scripts\repair-self-test.mjs   # 会话日志自愈单测（8 断言）
electron.exe scripts\gen-icon.mjs   # dsh.jpeg → build/icon.ico（换图标后跑）
npm run build:host          # 生成 vendor/profile（含剪枝与 ABI 门禁；--prune-only 增量剪枝）
npm run dist                # electron-builder 打 NSIS 安装包（dist\DSHDesktop-Setup-<ver>.exe；无网络不带 CSC 变量出未签名包）
npx electron . --doctor      # 环境体检
```

## 产物

- **安装包**：`desktop-electron/dist/DSHDesktop-Setup-0.4.3.exe`（**当前唯一发布包**，未签名，SmartScreen 首次提示属预期）+ blockmap；旧版已清理，发人不会再拿错文件
- **版本链**：v1（Node+Chrome）0.3.0 → Electron 0.4.0 → 0.4.1（多窗口复用/自愈/优雅退出/背景图）→ 0.4.2（背景图回环 HTTP 修复 + 新图标）→ **0.4.3（背景图穿透 rc.6 硬编码不透明层，像素级验证）**；DSH 依赖锁定 0.1.0-rc.6
- **发布状态**：暂不发布（个人使用与分享）；证书（EV）与 GitHub Releases 差分更新通道按需激活，步骤见 desktop-electron/README.md
