// harness-compat-self-test.mjs — 离线自检："这个 DSH 版本能不能在当前 Electron 上跑"
//
// 为什么必须有它：
//   壳内点「DSH 更新」→ 装完 121 MB 的树 → ABI 门禁全绿 → **启动门禁**报「宿主提前退出（code=1）」
//   而宿主日志只剩一行 `--- run … ---`。真因是 0.1.6-alpha.2 起 harness 默认改用 runtime 解析，
//   必须给 Node 内部 loader 打补丁，而那套补丁按**精确 V8 指纹**放行：
//   白名单里是 43.0.0 / 44.0.0 / 45.0.0-alpha.6，而壳里钉的 `^43.4.0` 装出来是 43.4.0
//   （V8 15.0.245.**28**，白名单是 …**13**）⇒ 起不来。
//
//   本套件钉三件事：① 白名单**能从二进制里解析出来**（它是唯一副本，没有 JS/JSON 版）；
//   ② 三态判定（确定拦 / 只警告 / 放行）与"读不到白名单时不得把用户卡死"；
//   ③ 这些判据**真的接在更新链路上**（构建前拦，不是构建后才发现）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ADDON_PACKAGE_PREFIX,
  RUNTIME_RESOLUTION_FROM,
  assessHarnessCompat,
  needsRuntimeResolution,
  parseAddonFingerprints,
  readAddonFingerprints,
} from '../src/harness-compat.mjs'

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ---------- 1) 白名单解析 ----------
//
// 夹具是**真二进制的原字节**，不是手写的近似物：从已装 vendor 树的
//   node-addon-require-builtin-win32-x64-msvc/prebuilt/win32-x64-msvc-napi-v9.node
// 里截取白名单字符串表那 260 字节（`43.0.0` 起 260 字节），转成 hex 内联在这里。
// 为什么必须用真字节：这套解析的坑全在**字节布局**上——① V8 串是四段数字；
// ② 字段间的 NUL 不止一个（实测 `43.0.0` 后 6 个、`44.0.0` 后 2 个，编译器按对齐补零）。
// 第一版两处都写错，而"解析不出来"在调用方那里等于"读不到白名单 ⇒ 放行"，是**静默失效**：
// 守卫看起来在跑，其实永远不会拦——手写夹具当时恰好两边都"看起来很合理"，抓不到它。
// 重新取夹具：
//   node -e "const b=require('fs').readFileSync(process.argv[1]);const i=b.indexOf('43.0.0');console.log(b.subarray(i,i+260).toString('hex'))" <那个 .node 的路径>
console.log('[parseAddonFingerprints]')
const REAL_TABLE_HEX = '34332e302e3000000000000031352e302e3234352e31332d656c656374726f6e2e300000656c656374726f6e2d3433207461676765642064656661756c743d300000000034342e302e30000031352e322e3132342e31332d656c656374726f6e2e300000656c656374726f6e2d3434207461676765642064656661756c743d300000000034352e302e302d616c7068612e36000031352e342e38302d656c656374726f6e2e30000000000000656c656374726f6e2d34352d616c706861207461676765642064656661756c743d300000000000002d656c656374726f6e2e000000000000746167676564206b506572436f6e74657874446174613d320000000000000000'
const REAL_TABLE = Buffer.from(REAL_TABLE_HEX, 'hex')
const parsed = parseAddonFingerprints(REAL_TABLE)
ok('夹具取自真二进制（260 字节，含对齐补零）', REAL_TABLE.length === 260 && REAL_TABLE.includes('43.0.0'), String(REAL_TABLE.length))
ok('解析出三对 标签↔V8 指纹', parsed.pairs.length === 3, JSON.stringify(parsed.pairs))
ok('标签是 Electron 版本', parsed.labels.join(',') === '43.0.0,44.0.0,45.0.0-alpha.6', parsed.labels.join(','))
ok('指纹是 V8 串（含 -electron.N 后缀）',
  parsed.fingerprints.join(',') === '15.0.245.13-electron.0,15.2.124.13-electron.0,15.4.80-electron.0',
  parsed.fingerprints.join(','))
// 反例：只有"运行时自己报的指纹"（没有标签\0 在前）时不得抓出假的受支持项——
// 否则当前机器的 15.0.245.28 会被当成"在白名单里"，守卫直接失效。
const onlyRuntime = Buffer.from('unsupported Electron runtime fingerprint: Node 24.18.1, V8 15.0.245.28-electron.0 (supported …)', 'latin1')
ok('只有报错文本时解析为空（不得把当前指纹误判成受支持）',
  parseAddonFingerprints(onlyRuntime).fingerprints.length === 0,
  JSON.stringify(parseAddonFingerprints(onlyRuntime)))

// ---------- 2) 从已装 vendor 树读白名单（fs 注入，不碰真磁盘） ----------
console.log('[readAddonFingerprints]')
const PLATFORM_DIR = 'node-addon-require-builtin-win32-x64-msvc'
const NODE_FILE = path.join(PLATFORM_DIR, 'prebuilt', 'win32-x64-msvc-napi-v9.node')
/** 假 fs：给出"目录 → 条目"映射，其余一律当作不存在（不碰真磁盘）。 */
const fakeFs = ({ map = {}, exists = true } = {}) => ({
  exists: () => exists,
  readdir: (p) => {
    const key = String(p)
    if (!(key in map)) throw new Error(`ENOENT: ${key}`)
    return map[key]
  },
  readFile: () => REAL_TABLE,
})
const addonDir = path.join('X', 'node_modules')
const found = readAddonFingerprints({
  addonDir,
  ...fakeFs({
    map: {
      [addonDir]: [PLATFORM_DIR],
      [path.join(addonDir, PLATFORM_DIR, 'prebuilt')]: ['win32-x64-msvc-napi-v9.node'],
    },
  }),
})
ok('从平台包的 prebuilt/*.node 里读到白名单', found.known === true && found.labels.length === 3, found.file ?? found.error)
ok('读到的指纹与标签成对（43.0.0 ↔ 15.0.245.13）',
  found.fingerprints[0] === '15.0.245.13-electron.0' && found.labels[0] === '43.0.0')
const noPrebuilt = readAddonFingerprints({
  addonDir,
  ...fakeFs({ map: { [addonDir]: [PLATFORM_DIR] } }),
})
ok('平台包没有 prebuilt/ 时 known=false（而不是抛）', noPrebuilt.known === false && /prebuilt/.test(noPrebuilt.error), noPrebuilt.error)
ok('目录不存在时 known=false 且说明路径',
  (() => { const m = readAddonFingerprints({ addonDir, ...fakeFs({ exists: false }) }); return m.known === false && m.error.includes('node_modules') })())
ok('addon 平台包名前缀与真实包名一致', ADDON_PACKAGE_PREFIX === 'node-addon-require-builtin-' && NODE_FILE.endsWith('.node'))

// ---------- 3) 哪些版本需要运行时补丁 ----------
//
// 判据来源是**两个产物的源码原文**（不是猜）：
//   alpha.1 `options.resolutionMode ?? "link"`；alpha.2 `?? "runtime"`。
console.log('[needsRuntimeResolution]')
ok('常量指向 0.1.6-alpha.2（证据锚点）', RUNTIME_RESOLUTION_FROM === '0.1.6-alpha.2')
ok('0.1.6-alpha.1（link 解析）不需要', needsRuntimeResolution('0.1.6-alpha.1').needed === false)
ok('0.1.6-alpha.2（首次改 runtime）需要', needsRuntimeResolution('0.1.6-alpha.2').needed === true)
ok('更早的 0.1.5-rc.2 不需要', needsRuntimeResolution('0.1.5-rc.2').needed === false)
ok('更高的 0.2.0 需要', needsRuntimeResolution('0.2.0').needed === true)
ok('版本串无法解析时按"需要"处置且标记 assumed', (() => {
  const n = needsRuntimeResolution('weird-version')
  return n.needed === true && n.assumed === true
})())

// ---------- 4) 三态判定 ----------
console.log('[assessHarnessCompat]')
const addon = { known: true, fingerprints: parsed.fingerprints, labels: parsed.labels }
const V8_43_4 = '15.0.245.28-electron.0'   // 本机壳（electron ^43.4.0）的真实指纹
const V8_44_0 = '15.2.124.13-electron.0'   // 白名单里的 44.0.0

const blocked = assessHarnessCompat({ version: '0.1.6-alpha.2', addon, v8: V8_43_4, electron: '43.4.0' })
ok('要补丁 + 指纹不在白名单 → 拦（blocked）', blocked.ok === false && blocked.blocked === true)
ok('拦截理由里有当前指纹、白名单与"先更新桌面端"',
  blocked.reason.includes(V8_43_4) && blocked.reason.includes('44.0.0') && blocked.reason.includes('桌面端'), blocked.reason)
ok('拦截理由说清是哪个版本引入的要求', blocked.reason.includes('0.1.6-alpha.2'), blocked.reason)

const allowed = assessHarnessCompat({ version: '0.1.6-alpha.2', addon, v8: V8_44_0, electron: '44.0.0' })
ok('要补丁 + 指纹在白名单 → 放行', allowed.ok === true && allowed.blocked === false && allowed.supported === true)
ok('放行理由列出白名单', allowed.reason.includes('45.0.0-alpha.6'), allowed.reason)

const linkMode = assessHarnessCompat({ version: '0.1.6-alpha.1', addon, v8: V8_43_4, electron: '43.4.0' })
ok('不需要补丁（link 解析）→ 即使指纹不在白名单也放行',
  linkMode.ok === true && linkMode.blocked === false && linkMode.needed === false)
ok('放行理由点明"不需要运行时补丁"（免得下次又被误拦）', linkMode.reason.includes('link'), linkMode.reason)

const unknownTable = assessHarnessCompat({
  version: '0.1.6-alpha.2', addon: { known: false, fingerprints: [], labels: [], error: '没装 addon' }, v8: V8_43_4, electron: '43.4.0',
})
ok('读不到白名单 → 放行（宁可交给启动门禁，也不能把用户卡死）',
  unknownTable.ok === true && unknownTable.blocked === false && unknownTable.unknown === true)
ok('读不到白名单时理由里带上原因与兜底路径',
  unknownTable.reason.includes('没装 addon') && unknownTable.reason.includes('启动门禁'), unknownTable.reason)

const assumed = assessHarnessCompat({ version: 'not-a-version', addon, v8: V8_43_4, electron: '43.4.0' })
ok('版本串判不准 + 指纹不在白名单 → 只警告不拦（warn）',
  assumed.blocked === false && assumed.warn === true && assumed.ok === true)
ok('警告文案说明"失败不会动现有树"', assumed.reason.includes('不会动'), assumed.reason)

// 逃生口：白名单读的是**本机已装**那棵树，将来新 harness 换了更宽的 addon 时本机这份会过期——
// 硬拦且无出口就是把用户永久卡死，所以必须有一条显式、可审计的放行路径。
const overridden = assessHarnessCompat({ version: '0.1.6-alpha.2', addon, v8: V8_43_4, electron: '43.4.0', allowUnsupported: true })
ok('显式放行时不再拦（blocked=false）但降级为警告', overridden.ok === true && overridden.blocked === false && overridden.warn === true)
ok('放行时标记 overridden 并在理由里说明是谁放行的',
  overridden.overridden === true && overridden.reason.includes('DSH_UPDATE_ALLOW_INCOMPATIBLE'), overridden.reason)
ok('默认（不显式放行）必须拦——口子不能变成默认行为',
  assessHarnessCompat({ version: '0.1.6-alpha.2', addon, v8: V8_43_4, electron: '43.4.0', allowUnsupported: false }).blocked === true)

// ---------- 5) 判据真的接在更新链路上（源码级契约） ----------
//
// 只测模块是不够的：事故的形态就是"判据存在、但没人在**下载之前**调用它"。
console.log('[wiring]')
const mainSrc = read('src/main.mjs')
const clientSrc = read('packages/dsh-desktop-ui/lib/client.js')
const toIdx = mainSrc.indexOf('function dshUpdateTo(')
const busyIdx = mainSrc.indexOf('dshUpdateBusy = true', toIdx)
const guardIdx = mainSrc.indexOf('if (compat.blocked)', toIdx)
ok('dshUpdateTo 在把任务置为 building 之前做兼容判据', guardIdx > toIdx && guardIdx < busyIdx,
  `guard@${guardIdx} busy@${busyIdx}`)
ok('守卫拦下时不进入构建（直接返回失败与理由）',
  /if \(compat\.blocked\) \{[\s\S]{0,400}?return \{ ok: false, error: compat\.reason/.test(mainSrc.slice(toIdx)))
ok('快照把 compat 透给客户端（否则界面无从禁用按钮）', /^\s*compat,$/m.test(mainSrc))
ok('快照在 blocked 时改写 hint',
  /dshUpdate\.hasUpdate && compat !== null && compat\.blocked/.test(mainSrc))
ok('客户端读到 blocked', /const blocked = !!\(u\.compat && u\.compat\.blocked === true\)/.test(clientSrc))
ok('客户端在 blocked 时禁掉"更新"按钮', /canUpdate: [^\n]*!blocked/.test(clientSrc))
ok('客户端按钮文案区分三种情形', /di\.blocked \? "当前壳不支持"/.test(clientSrc))
ok('壳用环境变量提供逃生口（且默认不放行）',
  /allowUnsupported: process\.env\.DSH_UPDATE_ALLOW_INCOMPATIBLE === '1'/.test(mainSrc))

console.log(`\nHARNESS COMPAT SELF TEST: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
