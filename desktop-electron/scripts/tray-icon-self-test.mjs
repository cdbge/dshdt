// tray-icon-self-test.mjs — 离线自检：托盘/窗口图标该取哪个文件（平台分支），以及托盘的三条"打开主窗"路径。
// Linux 不认 .ico（解出来空图，Tray 不抛错但没像素），double-click 在 Linux 上不存在 ⇒ 只能靠单测钉住。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ICON_BY_PLATFORM, ICON_FALLBACK, iconFileName, iconFilePath } from '../src/tray-icon.mjs'

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

console.log('[iconFileName]')
ok('Windows 用 .ico（Electron 文档推荐，任务栏/托盘都吃它）', iconFileName('win32') === 'icon.ico', iconFileName('win32'))
ok('Linux 用 .png（.ico 在 Linux 上解出来是空图）', iconFileName('linux') === 'icon.png', iconFileName('linux'))
ok('未知平台回退到 .png（不会在非 Windows 上解出空图）',
  iconFileName('freebsd') === ICON_FALLBACK && ICON_FALLBACK === 'icon.png', iconFileName('freebsd'))
ok('映射表本身不含 linux→ico 这种错配',
  ICON_BY_PLATFORM.linux === 'icon.png' && ICON_BY_PLATFORM.win32 === 'icon.ico',
  JSON.stringify(ICON_BY_PLATFORM))

console.log('[iconFilePath]')
const res = path.join('R', 'resources')
const rootDir = path.join('R', 'repo')
ok('打包态 Linux → resources/icon.png',
  iconFilePath({ platform: 'linux', packaged: true, res, rootDir }) === path.join(res, 'icon.png'),
  iconFilePath({ platform: 'linux', packaged: true, res, rootDir }))
ok('打包态 Windows → resources/icon.ico',
  iconFilePath({ platform: 'win32', packaged: true, res, rootDir }) === path.join(res, 'icon.ico'),
  iconFilePath({ platform: 'win32', packaged: true, res, rootDir }))
ok('开发态 Linux → build/icon.png（仓库里两个文件都在）',
  iconFilePath({ platform: 'linux', packaged: false, res, rootDir }) === path.join(rootDir, 'build', 'icon.png'),
  iconFilePath({ platform: 'linux', packaged: false, res, rootDir }))

console.log('[图标文件自身]')
const icoBytes = fs.readFileSync(path.join(ROOT, 'build', 'icon.ico'))
ok('build/icon.ico 是真 ICO（魔数 00 00 01 00）',
  icoBytes[0] === 0x00 && icoBytes[1] === 0x00 && icoBytes[2] === 0x01 && icoBytes[3] === 0x00,
  `${icoBytes.length} B`)
const pngPath = path.join(ROOT, 'build', 'icon.png')
if (fs.existsSync(pngPath)) {
  const pngBytes = fs.readFileSync(pngPath)
  ok('build/icon.png 是真 PNG（魔数 89 50 4E 47）',
    pngBytes[0] === 0x89 && pngBytes[1] === 0x50 && pngBytes[2] === 0x4e && pngBytes[3] === 0x47,
    `${pngBytes.length} B`)
  ok('PNG 至少 512×512（托盘/面板缩放后仍清晰；读 IHDR）',
    pngBytes.readUInt32BE(16) >= 512 && pngBytes.readUInt32BE(20) >= 512,
    `${pngBytes.readUInt32BE(16)}×${pngBytes.readUInt32BE(20)}`)
} else {
  console.log('  NOTE  build/icon.png 不在（未跑 npm run icons，CI 的干净 checkout 就是这样）——改验生成器契约')
  const genIcon = read('scripts/gen-icon.mjs')
  ok('图标生成器会产出 512 档 PNG（干净 checkout 下能验的等价契约）',
    /\b512\b/.test(genIcon) && /icon\.png/.test(genIcon), 'gen-icon.mjs 里应有 512 与 icon.png')
}
const builderYml = read('electron-builder.yml')
ok('打包配置把两份图标都放进 resources（按平台选名不会指空）',
  /from: build\/icon\.ico\s*\n\s*to: icon\.ico/.test(builderYml) && /from: build\/icon\.png\s*\n\s*to: icon\.png/.test(builderYml))

console.log('[main.mjs 接线]')
const mainSrc = read('src/main.mjs')
ok('托盘图标走 TRAY_ICON_FILE（不再是所有平台都 .ico）',
  /const icon = fs\.existsSync\(TRAY_ICON_FILE\) \? nativeImage\.createFromPath\(TRAY_ICON_FILE\)/.test(mainSrc)
  && !/nativeImage\.createFromPath\(ICON_FILE\)/.test(mainSrc))
ok('TRAY_ICON_FILE 由 iconFilePath 按平台选',
  /const TRAY_ICON_FILE = iconFilePath\(\{ packaged: app\.isPackaged, res: RES, rootDir: ROOT_DIR \}\)/.test(mainSrc))
ok('两个窗口（主窗 + 日志窗）也用平台图标',
  (mainSrc.match(/icon: fs\.existsSync\(TRAY_ICON_FILE\) \? TRAY_ICON_FILE : undefined,/g) ?? []).length === 2)
ok('admin 的 favicon 仍取 .ico（路由固定 /icon.ico + image/x-icon）',
  /staticFiles: \{[^}]*icon: fs\.existsSync\(ICON_FILE\)/.test(mainSrc))
// 开发态的 favicon 路径必须跟着"图标生成到 build/"走，否则只有开发态冒烟会红
ok('开发态 favicon 指 build/icon.ico（生成物所在处），打包态才指 resources/',
  /const ICON_FILE = app\.isPackaged \? path\.join\(RES, 'icon\.ico'\) : path\.join\(ROOT_DIR, 'build', 'icon\.ico'\)/.test(mainSrc))
ok('favicon 在开发态确实存在（生成器产物与壳的假设同源）', fs.existsSync(path.join(ROOT, 'build', 'icon.ico')))

console.log('[打开主窗的入口]')
ok('click 覆盖 Linux（非双击语义的平台都得挂 click，否则点了没反应）',
  /tray\.on\('click', \(\) => \{ if \(process\.platform !== 'win32'\) focusAction\(\) \}\)/.test(mainSrc))
ok('double-click 仍挂着（Windows 习惯；Linux 上不触发也无害）',
  /tray\.on\('double-click', \(\) => focusAction\(\)\)/.test(mainSrc))
const menuBlock = mainSrc.slice(mainSrc.indexOf('tray.setContextMenu(Menu.buildFromTemplate(['), mainSrc.indexOf("label: '退出'"))
ok('菜单第一项是「打开主窗口」且接到 focusAction',
  /setContextMenu\(Menu\.buildFromTemplate\(\[\s*\n(?:\s*\/\/[^\n]*\n)+\s*\{ label: '打开主窗口', click: \(\) => \{ void focusAction\(\) \} \}/.test(menuBlock),
  menuBlock.split('\n').filter((l) => l.trim().startsWith('{ label')).slice(0, 2).join(' / ').trim())
ok('「打开主窗口」排在任何其它菜单项之前（它必须是第一个能被按到的入口）',
  menuBlock.indexOf("label: '打开主窗口'") < menuBlock.indexOf("label: '设置'"))

console.log(`\nTRAY ICON SELF TEST: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
