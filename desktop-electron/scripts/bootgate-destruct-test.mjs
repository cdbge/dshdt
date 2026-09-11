// bootgate-destruct-test.mjs — 实验：启动门禁是否会破坏它自己的树？
//
// 动机（0.4.6 事故排查）：暂存树在门禁之后从 ~11000 文件掉到 4000，且 240 个 @deepseek-ai/*
// 包被掏空成空目录（连 package.json 都没了——那不是剪枝规则能做到的）。门禁的 finally 里有一句
// `fs.rmSync(home, {recursive:true})`，而 DSH 启动会在隔离 HOME 的 profiles/node_modules 下建
// **指向被测树**的 junction 场。最小复现证明 rmSync 不跟 junction，但那个复现是我手搓的 junction，
// 未必等同 DSH 自建的那套。
//
// 做法：拿**现网 vendor 树的一份拷贝**跑一次真门禁，前后比对文件数。只动拷贝，不碰现网。
// 用法：node scripts/bootgate-destruct-test.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runBootGate } from '../src/vendor-build.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const LIVE = 'D:\\Desktop\\DSH Desktop\\resources\\vendor\\profile'
const PATCH = 'D:\\Desktop\\DSH Desktop\\resources\\desktop.patch.yml'
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

function walk(dir) {
  let files = 0
  let dirs = 0
  const stack = [dir]
  while (stack.length > 0) {
    const d = stack.pop()
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { dirs += 1; stack.push(p) } else { files += 1 }
    }
  }
  return { files, dirs }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gate-destruct-'))
const copy = path.join(tmp, 'profile')
console.log(`[实验] 拷贝现网树 → ${copy}`)
fs.cpSync(LIVE, copy, { recursive: true })
const before = walk(copy)
console.log(`[实验] 门禁前: ${before.files} 文件 / ${before.dirs} 目录`)

try {
  const r = await runBootGate({
    profileDir: copy,
    runtime: ELECTRON,
    patchFile: PATCH,
    ws: tmp,
    timeoutMs: 20000,   // 只关心文件系统副作用，不需要等满 90s
    log: (m) => console.log('[gate]', m),
  })
  console.log(`[实验] 门禁结果: ok=${r.ok} error=${r.error ?? ''}`)
} catch (e) {
  console.log('[实验] 门禁抛出:', e.message)
}

const after = walk(copy)
console.log(`[实验] 门禁后: ${after.files} 文件 / ${after.dirs} 目录`)
const lost = before.files - after.files
console.log(`[实验] 结论: ${lost === 0 ? '门禁未破坏树（文件数不变）' : `门禁破坏了树！少了 ${lost} 个文件`}`)

console.log('[实验] 清理拷贝...')
fs.rmSync(tmp, { recursive: true, force: true })
console.log('[实验] 完成')
