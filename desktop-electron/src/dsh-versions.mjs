// dsh-versions.mjs — bundles 锁定的 DSH 版本（**唯一一份**，构建脚本共用）
//
// 为什么抽成模块：`build-host.mjs` 与 `build-mac-universal.mjs` 都要写 manifest / lock 的
// `dshVersions`，而这三者（dsh / dsh-base / dsh-web-app）**同进同退**——只升一个会让 vendor 树
// 不自洽。两份手写常量一定会漂移，漂移的后果是"同一个应用、两棵版本不同的树"。
//
// 2026-09-12 由 0.1.0-rc.8 升到 **0.1.5-rc.2**。为什么必须升：
// 用户机器上的已装应用**早就**通过「DSH 更新按钮」跑在 0.1.5-rc.2 上了，
// 而仓库这边还锁着 rc.8 —— 于是「打出来的安装包」和「大家在用的应用」是两棵不同的树。
// 后果不是崩溃而是**静默失配**：本轮的桌面皮肤（滚动条 / 跳转轨 / 中央遮罩 / 左右侧栏）
// 全部按 0.1.5 的 CSS-modules 类名书写（`_marks` / `eGxaPq_*` / `wSkVaW_*`），
// 这些在 rc.8 里**根本不存在** → 新装的机器上皮肤不报错、就是没效果。
//
// 2026-09-17 再升到 **0.1.6-alpha.1**（同一类问题的第二次）：
// 用户在 09-16 通过壳内「DSH 更新」把**已装应用**升到了 0.1.6-alpha.1，仓库这边停在 rc.2 ⇒
// 又是"包里的树 ≠ 用户在用的树"。当时核对 registry：`alpha` 与发布的最后一个版本都是 0.1.6-alpha.1。
// ⚠️ 改这里之后**必须重建 vendor 树**（`npm run build:host`），否则常量与树仍然对不上 ——
// 这正是"声明 ≠ 产物"的形状：改了"声明"不等于改了"产物"。
export const VERSIONS = {
  '@deepseek-ai/dsh': '0.1.6-alpha.1',
  '@deepseek-ai/dsh-base': '0.1.6-alpha.1',
  '@deepseek-ai/dsh-web-app': '0.1.6-alpha.1',
}
