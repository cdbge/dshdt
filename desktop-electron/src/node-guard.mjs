// node-guard.mjs — 必须在 main.mjs 最先导入：拦截 ELECTRON_RUN_AS_NODE 泄漏，非 Electron 运行时直接报错退出。
if (!process.versions.electron) {
  console.error('[DSH Desktop] 检测到 ELECTRON_RUN_AS_NODE=1 泄漏：主进程必须以 Electron 运行时启动。')
  console.error('请移除该环境变量后重新启动（set ELECTRON_RUN_AS_NODE= / Remove-Item Env:ELECTRON_RUN_AS_NODE）。')
  process.exit(2)
}
