// 诊断钩子（打包态排查用）：模块级异常/未处理拒绝落盘 early-crash.log——
// 打包应用对未捕获异常弹原生对话框并挂起，无控制台可看，此文件是唯一现场。
// 必须作为 main.mjs 的第一个 import（ESM 按声明序执行，先注册再加载后续模块）。
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

function target() {
  return path.join(process.env.DSH_APP_DATA || process.env.LOCALAPPDATA || '.', 'early-crash.log')
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
