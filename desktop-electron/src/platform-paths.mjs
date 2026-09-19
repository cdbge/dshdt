// platform-paths.mjs — 平台相关的**路径与可执行文件解析**（纯 Node，零依赖，可被构建脚本与壳共用）
//
// 为什么单独一个文件：平台判定与路径拼接必须只有一处实现，
// 否则每个调用点都会长出自己的 Windows 假设（旧代码里 `electron.exe` 被写死在 8 个脚本里，
// `%LOCALAPPDATA%` 被写死在壳的模块顶层——后者在 Linux/macOS 上直接抛错，连日志都来不及写）。
//
// 本文件**不 import electron**：scripts/ 下的构建脚本要在纯 Node 下用它（`npx electron` 也能用）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 应用数据目录名（三平台同名，便于用户在三平台间辨认）。 */
export const APP_DIR_NAME = 'DSHDesktop'

/**
 * 应用数据目录（日志 / 设置 / Electron profile 都在它下面）。
 *
 * 顺序：显式覆盖 > 平台惯例。平台惯例分别对应 Windows 的 `%LOCALAPPDATA%`、
 * macOS 的 `~/Library/Application Support`、Linux 的 `$XDG_DATA_HOME`（缺省 `~/.local/share`）。
 * `process.env.LOCALAPPDATA` 在 Linux/macOS 上恒为 undefined，**绝不能**直接进 path.join。
 * @param {{env?:Record<string,string|undefined>, platform?:string, homedir?:string}} [o] 选项（可注入以便单测）
 * @returns {string} 绝对路径
 */
export function appDataDir({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  if (env.DSH_APP_DATA) return env.DSH_APP_DATA
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA ?? path.join(homedir, 'AppData', 'Local')
    return path.join(base, APP_DIR_NAME)
  }
  if (platform === 'darwin') return path.join(homedir, 'Library', 'Application Support', APP_DIR_NAME)
  const base = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(homedir, '.local', 'share')
  return path.join(base, APP_DIR_NAME)
}

/**
 * 日志目录。Windows 沿用应用数据目录（保持既有排障路径 `%LOCALAPPDATA%\DSHDesktop\logs` 不变），
 * macOS/Linux 走各自的惯例位置，避免被备份工具当数据、被用户当缓存清掉。
 */
export function logDir(opts = {}) {
  const { env = process.env, platform = process.platform, homedir = os.homedir() } = opts
  const data = appDataDir(opts)
  // 显式指定了数据目录就跟着它走：冒烟隔离与便携部署都要求"日志落在被测目录里"，
  // 这时再按平台惯例分散到 ~/Library/Logs 会让排障找不到现场（也拿不到可断言的位置）。
  if (platform === 'win32' || env.DSH_APP_DATA) return path.join(data, 'logs')
  if (platform === 'darwin') return path.join(homedir, 'Library', 'Logs', APP_DIR_NAME)
  const base = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(homedir, '.local', 'state')
  return path.join(base, 'dsh-desktop', 'log')
}

/** 默认工作区（三平台都用家目录下的同名目录，便于跨平台对照排障）。 */
export function defaultWorkspace({ env = process.env, homedir = os.homedir() } = {}) {
  return env.DSH_WS ?? path.join(homedir, 'DSH-Workspace')
}

/**
 * DSH 用户数据目录（`$DSH_HOME`）。解析顺序与壳保持一致：
 * 显式环境变量 > 家目录下已存在的 `~/.dsh`（沿用用户既有数据） > 应用数据目录下的 `dsh-home`。
 */
export function dshHomeDir({ env = process.env, homedir = os.homedir() } = {}) {
  if (env.DSH_HOME) return env.DSH_HOME
  const legacy = path.join(homedir, '.dsh')
  try { if (fs.existsSync(legacy)) return legacy } catch { /* 读不到就按不存在处理 */ }
  return path.join(appDataDir({ env, homedir }), 'dsh-home')
}

/**
 * 从 electron 包的导出解析**当前平台**的可执行文件路径。
 *
 * electron 的 `index.js` 在 require 时按平台返回：
 *   Windows `dist/electron.exe`、Linux `dist/electron`、macOS `dist/Electron.app/Contents/MacOS/Electron`。
 * 旧写法在每个脚本里各自拼 `dist/electron.exe`（8 处），Linux/macOS 上必然指向不存在的文件。
 * @param {NodeRequire} req 由 `createRequire(import.meta.url)` 得到的 require
 * @returns {string} 可执行文件绝对路径
 * @throws 找不到 electron 包时抛出（调用方据此给出"先 npm install"的提示）
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

/** 平台三元组的可读标签（与 vendor-build 的 platformTag 同口径）。 */
export function platformLabel({ platform = process.platform, arch = process.arch } = {}) {
  return `${platform}-${arch}`
}
