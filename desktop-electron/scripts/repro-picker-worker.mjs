// repro-picker-worker.mjs — 复现"目录选择 worker 静默退出"：以与 dsh host 完全相同的
// 方式 spawn worker.cjs（stdio 'ipc' + 继承 env），打印 worker 消息/退出码/错误。
// 若弹出 TEST 标题的选目录对话框，6 秒后自动杀掉（正常行为=worker 先发 {kind:'showing'}）。
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'

const workerPath = process.env.WORKER_PATH
  || 'D:\\Desktop\\DSH Desktop\\resources\\vendor\\profile\\node_modules\\@deepseek-ai\\dsh-host-directory-picker-native\\lib\\worker.cjs'
const runtime = process.env.WORKER_RUNTIME || process.execPath
if (!fs.existsSync(workerPath)) { console.error('worker.cjs 不存在:', workerPath); process.exit(2) }

console.log('runtime:', runtime)
console.log('worker:', workerPath)
const w = spawn(runtime, [workerPath], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_DIALOG_TITLE: 'TEST' },
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  windowsHide: true,
})
w.on('message', (m) => console.log('MSG', JSON.stringify(m)))
w.on('error', (e) => console.log('ERR', e.message))
w.on('spawn', () => console.log('spawned, pid=', w.pid))
w.on('exit', (code, signal) => { console.log('EXIT', code, signal); process.exit(0) })
setTimeout(() => { console.log('TIMEOUT 6s → kill'); w.kill(); }, 6000)
setTimeout(() => { console.log('FORCE EXIT (worker 仍活着)'); process.exit(0) }, 9000)
