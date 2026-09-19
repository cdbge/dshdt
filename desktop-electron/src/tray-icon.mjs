// tray-icon.mjs — 托盘/窗口图标该取哪个文件（纯函数，可离线测）
//
// 为什么单独成模块（2026-09-19，用户："未适应 Linux 的 waybar 托盘，是不是 dshdt 源码出现了问题"）：
//   壳里 `ICON_FILE` 三平台都指 `icon.ico`，而 **Linux 上 .ico 解出来是空图**。实测（WSL 里那份
//   Electron 43.4.0，与壳钉的版本一致）：
//       nativeImage.createFromPath('<res>/icon.ico') → empty=true  size=0×0
//       nativeImage.createFromPath('<res>/icon.png') → empty=false size=512×512
//   后果不是"图标不好看"，而是：① 注册给 StatusNotifierItem 的是一个**没有像素**的托盘 ⇒ Waybar
//   （以及任何面板）没东西可画；② 壳自己的 `trayUsable = !icon.isEmpty()` 判 false ⇒「关闭到托盘」
//   自动关闭。而 `electron-builder.yml` 的注释本来就写着「.ico 给 Windows、.png 给 Linux 与**两平台的
//   托盘**（.ico 在 macOS/Linux 上解不出图）」——配置知道、代码没照做，属于典型的"声明与实现漂移"。
//
//   判据抽在这里还有一个理由：它是**平台分支**，而平台分支在集成测试里跑不到（本机一次只跑一个平台），
//   只能靠纯函数 + 单测钉住。见 scripts/tray-icon-self-test.mjs。
import path from 'node:path'

/**
 * 各平台该用的图标文件名。
 * - Windows：`.ico`（Electron 文档明确"推荐用 ICO 以获得最佳视觉效果"，且任务栏/托盘都吃它）
 * - Linux：`.png`（Chromium 的图标解码在 Linux 上不认 .ico，实测得到空图）
 * - macOS：`.png`（同样不认 .ico；真正决定 Dock 图标的是包内 .icns，这里只兜托盘）
 */
export const ICON_BY_PLATFORM = {
  win32: 'icon.ico',
  linux: 'icon.png',
  darwin: 'icon.png',
}

/** 未知平台一律按 png 处理：它是三平台都能解码的那个。 */
export const ICON_FALLBACK = 'icon.png'

/**
 * 该平台的图标文件名。
 * @param {string} [platform] 平台（默认当前）
 * @returns {string} 文件名
 */
export function iconFileName(platform = process.platform) {
  return ICON_BY_PLATFORM[platform] ?? ICON_FALLBACK
}

/**
 * 该平台的图标**绝对路径**：打包态在 `resources/` 下，开发态在仓库 `build/` 下。
 * 两个目录里都同时有 .ico 与 .png（`electron-builder.yml` 的 extraResources 两份都拷），
 * 所以按平台选名永远不会指到不存在的文件。
 * @param {{platform?:string, packaged:boolean, res:string, rootDir:string}} o 选项
 * @returns {string} 绝对路径
 */
export function iconFilePath({ platform = process.platform, packaged, res, rootDir }) {
  const name = iconFileName(platform)
  return packaged ? path.join(res, name) : path.join(rootDir, 'build', name)
}
