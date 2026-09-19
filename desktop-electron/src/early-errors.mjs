// early-errors.mjs — 模块级异常/未处理拒绝落盘 early-crash.log（打包态唯一现场）。
// 必须作为 main.mjs 第一个 import；本文件不得 import 项目内其它模块。
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 与 src/platform-paths.mjs 的 appDataDir() 同口径（就地实现以保持零依赖）。 */
function fallbackLogDir() {
  if (process.env.DSH_APP_DATA) return process.env.DSH_APP_DATA
  const home = os.homedir()
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'DSHDesktop')
  const base = process.env.XDG_DATA_HOME && path.isAbsolute(process.env.XDG_DATA_HOME) ? process.env.XDG_DATA_HOME : path.join(home, '.local', 'share')
  return path.join(base, 'DSHDesktop')
}

function target() {
  // 优先级：显式 env > main 设置的 DSH_APP_DATA > 平台惯例；app.getPath 只作最后兜底。
  try {
    const fromElectron = app.getPath('userData')
    if (fromElectron) return path.join(path.dirname(fromElectron), 'early-crash.log')
  } catch { /* app 未就绪 */ }
  return path.join(fallbackLogDir(), 'early-crash.log')
}

function dump(kind, err) {
  try {
    const p = target()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.appendFileSync(p, `[${new Date().toISOString()}] ${kind}: ${err && err.stack ? err.stack : String(err)}\n`)
  } catch { /* 尽力而为 */ }
}

process.on('uncaughtException', (e) => dump('uncaughtException', e))
process.on('unhandledRejection', (e) => dump('unhandledRejection', e))
try {
  dump('boot', `early-errors loaded; isPackaged=${app.isPackaged}; resources=${process.resourcesPath}`)
} catch (e) { /* app 未就绪也不影响注册 */ }
