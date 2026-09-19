// repair-self-test.mjs — 构造三种坏日志 + 一种好日志，验证 src/repair.mjs 的修复动作与读取器兼容性
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { repairSessionLogs, scanZstdFrames } from '../src/repair.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-repair-test-'))
const home = path.join(root, 'home')
const sess = (name) => path.join(home, 'sessions', name, 'session-a1', 'session.jsonl.zstd')
const frame = (s) => zlib.zstdCompressSync(Buffer.from(s, 'utf8'))
const header = (id) => JSON.stringify({ type: 'session', version: 1, id, createdAt: 1787202000000, delegationDepth: 0 })
const event = (t, i) => JSON.stringify({ type: t, seq: i, time: i })

let fail = 0
const ok = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) fail++ }

function writeCase(name, buf) { fs.mkdirSync(path.dirname(sess(name)), { recursive: true }); fs.writeFileSync(sess(name), buf) }

const torn = Buffer.concat([frame(header('torn') + '\n'), frame(event('user', 1) + '\n'), frame(event('user', 2) + '\n').subarray(0, 25)])
writeCase('torn', torn)
writeCase('multi', Buffer.concat([frame(header('multi') + '\n' + event('user', 1) + '\n'), frame(event('user', 2) + '\n')]))
writeCase('junk', Buffer.from('not a zstd file at all'))
const good = Buffer.concat([frame(header('good') + '\n'), frame(event('user', 1) + '\n')])
writeCase('good', good)

const logs = []
const r = repairSessionLogs(home, (m) => logs.push(m))
ok('统计: 截断1/重编码1/隔离1', r.truncated === 1 && r.reencoded === 1 && r.quarantined === 1, JSON.stringify(r))

// 验证 1：截断后的文件结构完整、首帧 = 一行 header
const t = fs.readFileSync(sess('torn'))
const ts = scanZstdFrames(t)
ok('torn: 无半个尾帧', ts.tornStart === undefined)
ok('torn: 剩 2 个完整帧', ts.frames.length === 2)
ok('torn: 首帧恰好一行 header', zlib.zstdDecompressSync(t.subarray(0, ts.frames[0].end)).toString('utf8') === header('torn') + '\n')

// 验证 2：重编码后首帧恰好一行 header，全帧可解
const m = fs.readFileSync(sess('multi'))
const ms = scanZstdFrames(m)
ok('multi: 无半个尾帧', ms.tornStart === undefined)
ok('multi: 首帧恰好一行 header', zlib.zstdDecompressSync(m.subarray(0, ms.frames[0].end)).toString('utf8') === header('multi') + '\n')

// 验证 3：垃圾文件被隔离改名
ok('junk: 已隔离', !fs.existsSync(sess('junk')) && fs.readdirSync(path.dirname(sess('junk'))).some((f) => f.startsWith('session.jsonl.zstd.corrupt-')))

// 验证 4：好文件原样未动
ok('good: 未改动', Buffer.compare(fs.readFileSync(sess('good')), good) === 0)

console.log(fail === 0 ? '\nREPAIR UNIT TEST: ALL PASS' : `\nREPAIR UNIT TEST: ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
