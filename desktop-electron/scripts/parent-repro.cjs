// parent-repro.cjs — 模拟真实宿主：父进程 = DSH Desktop.exe（RUN_AS_NODE），
// 以与 directory-picker-native 驱动完全相同的参数 spawn worker.cjs（stdio 'ipc'）。
const { spawn } = require('node:child_process')
const workerPath = process.env.WORKER_PATH
  || 'D:\\Desktop\\DSH Desktop\\resources\\vendor\\profile\\node_modules\\@deepseek-ai\\dsh-host-directory-picker-native\\lib\\worker.cjs'
console.log('parent pid=', process.pid, ' execPath=', process.execPath)
console.log('parent has send:', typeof process.send)
const w = spawn(process.execPath, [workerPath], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_DIALOG_TITLE: 'TEST2' },
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  windowsHide: true,
})
w.on('message', (m) => console.log('MSG', JSON.stringify(m)))
w.on('error', (e) => console.log('ERR', e.message))
w.on('spawn', () => console.log('spawned pid=', w.pid))
w.on('exit', (code, signal) => { console.log('EXIT', code, signal); process.exit(0) })
setTimeout(() => { console.log('TIMEOUT 6s → kill'); w.kill() }, 6000)
setTimeout(() => { console.log('FORCE EXIT'); process.exit(0) }, 9000)
