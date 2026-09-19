// 诊断钩子（打包态排查用）：模块级异常/未处理拒绝落盘 early-crash.log——
// 打包应用对未捕获异常弹原生对话框并挂起，无控制台可看，此文件是唯一现场。
// 必须作为 main.mjs 的第一个 import（ESM 按声明序执行，先注册再加载后续模块）。
//
// 本文件**不得 import 项目内其它模块**（它是"其它模块炸了也能留下现场"的兜底，自己不能有加载依赖），
// 所以平台判定在这里就地写：LOCALAPPDATA 在 Linux/macOS 上恒为 undefined，旧写法会退化成把日志
// 写进当前工作目录（cwd 为 / 时静默失败，现场丢失）。
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 与 src/platform-paths.mjs 的 appDataDir() 同口径（此处就地实现以保持零依赖）。 */
function fallbackLogDir() {
  if (process.env.DSH_APP_DATA) return process.env.DSH_APP_DATA
  const home = os.homedir()
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'DSHDesktop')
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'DSHDesktop')
  const base = process.env.XDG_DATA_HOME && path.isAbsolute(process.env.XDG_DATA_HOME) ? process.env.XDG_DATA_HOME : path.join(home, '.local', 'share')
  return path.join(base, 'DSHDesktop')
}
function target() {
  // app.getPath 在 ready 之前也拿得到 userData，但打包态/开发态的 userData 可能被 main 覆盖，
  // 所以只用它作**最后**兜底；优先级：显式 env > main 设置的 DSH_APP_DATA > 平台惯例。
  try {
    const fromElectron = app.getPath('userData')
    if (fromElectron) return path.join(path.dirname(fromElectron), 'early-crash.log')
  } catch { /* app 未就绪：落到下面的平台惯例 */ }
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
