// tray-icon.mjs — 托盘/窗口图标该取哪个文件（纯函数，可离线测）
import path from 'node:path'

/** 各平台图标文件名：Windows 用 .ico，Linux 不认 .ico，用 .png。 */
export const ICON_BY_PLATFORM = {
  win32: 'icon.ico',
  linux: 'icon.png',
}

/** 未知平台按 png 处理（png 各平台都能解码）。 */
export const ICON_FALLBACK = 'icon.png'

/**
 * @param {string} [platform] 平台，默认当前平台
 * @returns {string} 图标文件名
 */
export function iconFileName(platform = process.platform) {
  return ICON_BY_PLATFORM[platform] ?? ICON_FALLBACK
}

/**
 * 图标绝对路径：打包态在 `res/`，开发态在 `rootDir/build/`。
 * @param {{platform?:string, packaged:boolean, res:string, rootDir:string}} o
 * @returns {string} 绝对路径
 */
export function iconFilePath({ platform = process.platform, packaged, res, rootDir }) {
  const name = iconFileName(platform)
  return packaged ? path.join(res, name) : path.join(rootDir, 'build', name)
}
