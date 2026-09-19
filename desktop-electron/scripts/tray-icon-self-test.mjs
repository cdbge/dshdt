// tray-icon-self-test.mjs — 离线自检：托盘/窗口图标该取哪个文件，以及托盘的三条"打开主窗"路径
//
// 为什么必须有它（2026-09-19，用户："未适应 Linux 的 waybar 托盘，是不是 dshdt 源码出现了问题"）：
//   壳里 `ICON_FILE` 三平台都指 `.ico`，而 Linux/macOS 的图标解码**不认 .ico**——实测
//   `nativeImage.createFromPath('<res>/icon.ico')` → `empty=true size=0×0`（Electron 43.4.0，
//   与壳钉的版本一致）。空图传给 `new Tray()` **不抛错**，所以症状是"托盘建了但没有任何像素"：
//   Waybar 等面板什么都画不出来，同时 `trayUsable` 判 false 把「关闭到托盘」一起关掉。
//   同一时期还有第二个洞：Linux 上 `double-click` 事件根本不存在（Electron 文档标注
//   _macOS_ _Windows_），而 `click` 里又排除了非 darwin ⇒ **点了完全没反应**；菜单里也没有
//   "打开主窗口" ⇒ 窗口一旦关到托盘就再也叫不回来。
//
//   这两条都是**平台分支**，在集成测试里跑不到（本机一次只跑一个平台），所以只能靠纯函数 + 单测钉住。
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

// ---------- 1) 平台 → 文件名 ----------
console.log('[iconFileName]')
ok('Windows 用 .ico（Electron 文档推荐，任务栏/托盘都吃它）', iconFileName('win32') === 'icon.ico', iconFileName('win32'))
ok('Linux 用 .png（.ico 在 Linux 上解出来是空图）', iconFileName('linux') === 'icon.png', iconFileName('linux'))
ok('macOS 用 .png（同上）', iconFileName('darwin') === 'icon.png', iconFileName('darwin'))
ok('未知平台回退到 .png（三平台都能解码的那个）',
  iconFileName('freebsd') === ICON_FALLBACK && ICON_FALLBACK === 'icon.png', iconFileName('freebsd'))
ok('映射表本身不含 linux→ico 这种错配',
  ICON_BY_PLATFORM.linux === 'icon.png' && ICON_BY_PLATFORM.darwin === 'icon.png' && ICON_BY_PLATFORM.win32 === 'icon.ico',
  JSON.stringify(ICON_BY_PLATFORM))

// ---------- 2) 路径拼装（打包态 / 开发态） ----------
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

// ---------- 3) 真实文件与"选出来的那个名字确实被装进包" ----------
console.log('[图标文件自身]')
const icoBytes = fs.readFileSync(path.join(ROOT, 'build', 'icon.ico'))
const pngBytes = fs.readFileSync(path.join(ROOT, 'build', 'icon.png'))
ok('build/icon.ico 是真 ICO（魔数 00 00 01 00）',
  icoBytes[0] === 0x00 && icoBytes[1] === 0x00 && icoBytes[2] === 0x01 && icoBytes[3] === 0x00,
  `${icoBytes.length} B`)
ok('build/icon.png 是真 PNG（魔数 89 50 4E 47）',
  pngBytes[0] === 0x89 && pngBytes[1] === 0x50 && pngBytes[2] === 0x4e && pngBytes[3] === 0x47,
  `${pngBytes.length} B`)
ok('PNG 至少 512×512（托盘/面板缩放后仍清晰；读 IHDR）',
  pngBytes.readUInt32BE(16) >= 512 && pngBytes.readUInt32BE(20) >= 512,
  `${pngBytes.readUInt32BE(16)}×${pngBytes.readUInt32BE(20)}`)
const builderYml = read('electron-builder.yml')
ok('打包配置把两份图标都放进 resources（按平台选名不会指空）',
  /from: build\/icon\.ico\s*\n\s*to: icon\.ico/.test(builderYml) && /from: build\/icon\.png\s*\n\s*to: icon\.png/.test(builderYml))

// ---------- 4) main.mjs 的接线：托盘/窗口用平台图标，favicon 保持 .ico ----------
console.log('[main.mjs 接线]')
const mainSrc = read('src/main.mjs')
ok('托盘图标走 TRAY_ICON_FILE（不再是三平台都 .ico）',
  /const icon = fs\.existsSync\(TRAY_ICON_FILE\) \? nativeImage\.createFromPath\(TRAY_ICON_FILE\)/.test(mainSrc)
  && !/nativeImage\.createFromPath\(ICON_FILE\)/.test(mainSrc))
ok('TRAY_ICON_FILE 由 iconFilePath 按平台选',
  /const TRAY_ICON_FILE = iconFilePath\(\{ packaged: app\.isPackaged, res: RES, rootDir: ROOT_DIR \}\)/.test(mainSrc))
ok('两个窗口（主窗 + 日志窗）也用平台图标',
  (mainSrc.match(/icon: fs\.existsSync\(TRAY_ICON_FILE\) \? TRAY_ICON_FILE : undefined,/g) ?? []).length === 2)
ok('admin 的 favicon 仍取 .ico（路由固定 /icon.ico + image/x-icon）',
  /staticFiles: \{[^}]*icon: fs\.existsSync\(ICON_FILE\)/.test(mainSrc))

// ---------- 5) 托盘的三条"打开主窗"路径 ----------
console.log('[打开主窗的入口]')
ok('click 覆盖 Linux（原先只给 darwin，等于 Linux 点了没反应）',
  /tray\.on\('click', \(\) => \{ if \(process\.platform !== 'win32'\) focusAction\(\) \}\)/.test(mainSrc))
ok('double-click 仍挂着（Windows 习惯；macOS/Linux 上不触发也无害）',
  /tray\.on\('double-click', \(\) => focusAction\(\)\)/.test(mainSrc))
const menuBlock = mainSrc.slice(mainSrc.indexOf('tray.setContextMenu(Menu.buildFromTemplate(['), mainSrc.indexOf("label: '退出'"))
ok('菜单第一项是「打开主窗口」且接到 focusAction',
  /setContextMenu\(Menu\.buildFromTemplate\(\[\s*\n(?:\s*\/\/[^\n]*\n)+\s*\{ label: '打开主窗口', click: \(\) => \{ void focusAction\(\) \} \}/.test(menuBlock),
  menuBlock.split('\n').filter((l) => l.trim().startsWith('{ label')).slice(0, 2).join(' / ').trim())
ok('「打开主窗口」排在任何其它菜单项之前（它必须是第一个能被按到的入口）',
  menuBlock.indexOf("label: '打开主窗口'") < menuBlock.indexOf("label: '设置'"))

console.log(`\nTRAY ICON SELF TEST: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
