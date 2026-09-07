// node-guard.mjs — 必须在 main.mjs 里最先导入（比 early-errors 更早）。
// 防御 ELECTRON_RUN_AS_NODE 环境变量泄漏：主进程若以纯 Node 运行时启动，
// electron 导入会直接报"无此导出"并静默失败。这里给出明确报错并退出。
if (!process.versions.electron) {
  console.error('[DSH Desktop] 检测到 ELECTRON_RUN_AS_NODE=1 泄漏：主进程必须以 Electron 运行时启动。')
  console.error('请移除该环境变量后重新启动（set ELECTRON_RUN_AS_NODE= / Remove-Item Env:ELECTRON_RUN_AS_NODE）。')
  process.exit(2)
}
