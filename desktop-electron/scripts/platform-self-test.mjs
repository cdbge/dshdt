// platform-self-test.mjs — 平台适配层离线单测（纯 Node、脱网、不碰仓库文件）：
// 把三平台的路径解析与可执行文件解析钉成断言，改坏了在 Windows 上立刻红。
import {
  APP_DIR_NAME,
  appDataDir,
  defaultWorkspace,
  dshHomeDir,
  electronBinaryPath,
  logDir,
  platformLabel,
} from '../src/platform-paths.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

let fail = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!cond) fail++ }

const HOME = path.join(path.sep, 'home', 'u')

console.log('[appDataDir]')
ok('DSH_APP_DATA 优先于一切平台惯例',
  appDataDir({ env: { DSH_APP_DATA: path.join(path.sep, 'tmp', 'x') }, platform: 'linux', homedir: HOME }) === path.join(path.sep, 'tmp', 'x'))
ok('Windows 走 LOCALAPPDATA',
  appDataDir({ env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, platform: 'win32', homedir: HOME }) === path.join('C:\\Users\\u\\AppData\\Local', APP_DIR_NAME))
ok('Windows 缺 LOCALAPPDATA 也不抛（退到家目录）',
  appDataDir({ env: {}, platform: 'win32', homedir: 'C:\\Users\\u' }) === path.join('C:\\Users\\u', 'AppData', 'Local', APP_DIR_NAME))
ok('macOS 走 ~/Library/Application Support',
  appDataDir({ env: {}, platform: 'darwin', homedir: HOME }) === path.join(HOME, 'Library', 'Application Support', APP_DIR_NAME))
ok('Linux 走 XDG_DATA_HOME',
  appDataDir({ env: { XDG_DATA_HOME: path.join(path.sep, 'xdg') }, platform: 'linux', homedir: HOME }) === path.join(path.sep, 'xdg', APP_DIR_NAME))
ok('Linux 缺 XDG_DATA_HOME 时退到 ~/.local/share',
  appDataDir({ env: {}, platform: 'linux', homedir: HOME }) === path.join(HOME, '.local', 'share', APP_DIR_NAME))
ok('Linux 收到相对 XDG_DATA_HOME 时按规范忽略它',
  appDataDir({ env: { XDG_DATA_HOME: 'relative/dir' }, platform: 'linux', homedir: HOME }) === path.join(HOME, '.local', 'share', APP_DIR_NAME))
// 旧实现在这里就是那条模块顶层崩溃：LOCALAPPDATA 缺失 + 非 win32 平台
ok('非 Windows 平台**不会**因为缺 LOCALAPPDATA 抛错',
  (() => { try { appDataDir({ env: {}, platform: 'linux', homedir: HOME }); return true } catch { return false } })())

console.log('[logDir]')
ok('Windows 日志仍在 APP_DATA/logs（排障文档口径不变）',
  logDir({ env: { LOCALAPPDATA: 'C:\\L' }, platform: 'win32', homedir: 'C:\\Users\\u' }) === path.join('C:\\L', APP_DIR_NAME, 'logs'))
ok('macOS 日志走 ~/Library/Logs',
  logDir({ env: {}, platform: 'darwin', homedir: HOME }) === path.join(HOME, 'Library', 'Logs', APP_DIR_NAME))
ok('Linux 日志走 XDG_STATE_HOME',
  logDir({ env: { XDG_STATE_HOME: path.join(path.sep, 'state') }, platform: 'linux', homedir: HOME }) === path.join(path.sep, 'state', 'dsh-desktop', 'log'))
ok('Linux 缺 XDG_STATE_HOME 时退到 ~/.local/state',
  logDir({ env: {}, platform: 'linux', homedir: HOME }) === path.join(HOME, '.local', 'state', 'dsh-desktop', 'log'))
ok('DSH_APP_DATA 覆盖时日志落回该目录（冒烟要能断言日志位置）',
  logDir({ env: { DSH_APP_DATA: path.join(path.sep, 'tmp', 'x') }, platform: 'linux', homedir: HOME }) === path.join(path.sep, 'tmp', 'x', 'logs'))

console.log('[dshHomeDir]')
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plat-home-'))
ok('DSH_HOME 优先', dshHomeDir({ env: { DSH_HOME: path.join(path.sep, 'custom') }, homedir: tmpHome }) === path.join(path.sep, 'custom'))
ok('家目录已有 ~/.dsh 时沿用它', (() => {
  fs.mkdirSync(path.join(tmpHome, '.dsh'), { recursive: true })
  return dshHomeDir({ env: {}, homedir: tmpHome }) === path.join(tmpHome, '.dsh')
})())
ok('两者都没有时落在 APP_DATA/dsh-home', (() => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plat-empty-'))
  const got = dshHomeDir({ env: { DSH_APP_DATA: path.join(path.sep, 'data') }, homedir: empty })
  return got === path.join(path.sep, 'data', 'dsh-home')
})())

console.log('[workspace / label]')
ok('DSH_WS 优先', defaultWorkspace({ env: { DSH_WS: path.join(path.sep, 'ws') }, homedir: HOME }) === path.join(path.sep, 'ws'))
ok('默认工作区在家目录下', defaultWorkspace({ env: {}, homedir: HOME }) === path.join(HOME, 'DSH-Workspace'))
ok('platformLabel 形状', platformLabel({ platform: 'linux', arch: 'arm64' }) === 'linux-arm64')

console.log('[electronBinaryPath]')
const req = createRequire(import.meta.url)
const bin = electronBinaryPath(req)
ok('能解析出当前平台的 electron 可执行文件', typeof bin === 'string' && bin !== '', bin)
ok('解析出的路径真实存在', fs.existsSync(bin), bin)
if (process.platform === 'darwin') ok('macOS 上是 .app 内的可执行文件', bin.includes('Electron.app/Contents/MacOS/'))
else if (process.platform === 'linux') ok('Linux 上不以 .exe 结尾', bin.endsWith('electron'))
else ok('Windows 上是 electron.exe', bin.toLowerCase().endsWith('electron.exe'))
ok('解析失败时给出可执行的提示', (() => {
  try { electronBinaryPath(() => { throw new Error('boom') }); return false } catch (e) { return e.message.includes('npm install') }
})())

fs.rmSync(tmpHome, { recursive: true, force: true })

console.log(fail === 0 ? '\nPLATFORM SELF TEST: ALL PASS' : `\nPLATFORM SELF TEST: ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
