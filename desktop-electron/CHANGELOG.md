# CHANGELOG — DSH Desktop（Electron 主路线）

版本策略：壳版本独立 semver（v1 Node+Chrome 壳止步 0.3.0）；DSH 依赖经 `vendor/profile` 锁定
`@deepseek-ai/dsh@0.1.0-rc.6`，升级走独立流程（build-host + 双冒烟门禁）。

## 0.4.0 (2026-08-19)

首个 Electron 发行版（对应 v1 0.3.0 的全部能力 + 分发体系升级）。

### 壳能力（迁移自 v1，Electron 原生实现）
- 模式 B 宿主托管：`ELECTRON_RUN_AS_NODE` + `--expose-internals` 子进程跑 dsh web（DSH 零改动）
- 单实例 + 第二实例聚焦；`dsh://` 协议注册；系统托盘；close-to-tray；开机自启
- 通知（host 崩溃自动重启×3 + SPA 通知白名单）；壳内设置页（独立窗口，不走外部浏览器）
- 安全基线：contextIsolation/sandbox、非回环导航拦截、生产禁 DevTools

### 构建与分发（M2）
- 自包含 vendor/profile：530 包 / 207MB / ABI 门禁 0 失败 / 剪枝 11.4MB / vendor.lock.json
- electron-builder NSIS：per-user 一键安装 146.8MB + blockmap 差分；卸载保留用户数据
- 自签代码签名（CN=DSH Desktop Dev，scripts/dev-sign.ps1）；CI（.github/workflows/release.yml）
- electron-updater 接线（打包态自动检查；publish 配置待 GitHub 仓库激活）

### 门禁（全绿）
- dev smoke 21/21；打包产物 smoke exit 0；abi-scan 0 FAIL；vendor 独立 boot 冒烟
- 关键修复：findDshBin Electron 锚点、extraResources 根级 node_modules 被跳过、
  electron-updater CJS 命名导入（打包态挂起元凶）、workspace 状态回写
