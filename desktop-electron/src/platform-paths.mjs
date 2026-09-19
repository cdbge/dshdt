// platform-paths.mjs — 平台相关的路径与可执行文件解析（纯 Node，零依赖，构建脚本与壳共用）。
// 不 import electron。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 应用数据目录名。 */
export const APP_DIR_NAME = 'DSHDesktop'

/**
 * 应用数据目录（日志 / 设置 / Electron profile 都在其下）。
 * 顺序：显式覆盖 > 平台惯例；`LOCALAPPDATA` 在 Linux 上恒为 undefined，不能直接进 path.join。
 * @param {{env?:Record<string,string|undefined>, platform?:string, homedir?:string}} [o] 可注入以便单测
 * @returns {string} 绝对路径
 */
export function appDataDir({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  if (env.DSH_APP_DATA) return env.DSH_APP_DATA
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA ?? path.join(homedir, 'AppData', 'Local')
    return path.join(base, APP_DIR_NAME)
  }
  const base = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(homedir, '.local', 'share')
  return path.join(base, APP_DIR_NAME)
}

/** 日志目录：Windows 沿用应用数据目录，Linux 走 XDG 状态目录。 */
export function logDir(opts = {}) {
  const { env = process.env, platform = process.platform, homedir = os.homedir() } = opts
  const data = appDataDir(opts)
  // 显式指定了数据目录就跟着它走（冒烟隔离要求日志落在被测目录里）
  if (platform === 'win32' || env.DSH_APP_DATA) return path.join(data, 'logs')
  const base = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(homedir, '.local', 'state')
  return path.join(base, 'dsh-desktop', 'log')
}

/** 默认工作区：家目录下的同名目录。 */
export function defaultWorkspace({ env = process.env, homedir = os.homedir() } = {}) {
  return env.DSH_WS ?? path.join(homedir, 'DSH-Workspace')
}

/**
 * DSH 用户数据目录（`$DSH_HOME`）。
 * 顺序：显式环境变量 > 已存在的 `~/.dsh` > 应用数据目录下的 `dsh-home`。
 */
export function dshHomeDir({ env = process.env, homedir = os.homedir() } = {}) {
  if (env.DSH_HOME) return env.DSH_HOME
  const legacy = path.join(homedir, '.dsh')
  try { if (fs.existsSync(legacy)) return legacy } catch { /* 按不存在处理 */ }
  return path.join(appDataDir({ env, homedir }), 'dsh-home')
}

/**
 * 从 electron 包导出解析当前平台的可执行文件路径（Windows .exe / Linux 二进制）。
 * @param {NodeRequire} req 由 `createRequire(import.meta.url)` 得到
 * @returns {string} 绝对路径
 * @throws 找不到 electron 包时抛出
 */
export function electronBinaryPath(req) {
  try {
    const p = req('electron')
    if (typeof p === 'string' && p !== '') return p
    throw new Error(`electron 包返回了非字符串路径：${String(p)}`)
  } catch (e) {
    throw new Error(`无法解析 electron 可执行文件（先跑 npm install）：${e.message}`)
  }
}

/** 平台三元组标签，与 vendor-build 的 platformTag 同口径。 */
export function platformLabel({ platform = process.platform, arch = process.arch } = {}) {
  return `${platform}-${arch}`
}
