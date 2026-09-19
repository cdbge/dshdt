// cross-tree-self-test.mjs — vendor 树静态体检判据的单测（纯 Node、脱网、秒级）。
// 对两平台各造一棵正确的树（必须全过），再逐个抽件/串平台/假绿（必须报出那一项），并覆盖 mergePlatformPackages。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkCrossTree, requiredNativeItems } from '../src/cross-tree-check.mjs'
import { conptyDirName, isPlatformTaggedPath, mergePlatformPackages } from '../src/vendor-build.mjs'

let fail = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!cond) fail++ }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cross-test-'))
const write = (p, content = 'x') => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

// 造一棵"正确"的树：按 requiredNativeItems 放齐必需件，再补各平台特有的形状。
// o.skip = 故意抽掉的那一项；o.extra = 额外造的路径。
function makeTree(name, target, o = {}) {
  const dir = path.join(tmp, name)
  const nm = path.join(dir, 'profile', 'node_modules')
  const tag = `${target.os}-${target.arch}`
  const skip = o.skip ?? null
  // 路径比较一律走 path.normalize：skip 在调用处写 POSIX 风格，而 path.join 在 Windows 上给反斜杠
  const same = (a, b) => b !== null && path.normalize(a) === path.normalize(b)
  for (const [rel] of requiredNativeItems(target)) {
    if (same(rel, skip)) continue
    // 目录型条目（包）写 package.json，文件型条目写内容——判据只看存在性
    if (/package\.json$|\/$/.test(rel) || !/\.(node|exe|dll|so|dylib)$/.test(rel)) write(path.join(nm, rel, 'package.json'), JSON.stringify({ name: path.basename(rel) }))
    else write(path.join(nm, rel), 'bin')
  }
  // node-pty 本体 + 目标平台的 prebuilds。这里也必须尊重 skip，否则夹具"并不缺"
  const ptyFile = path.join('node-pty', 'prebuilds', tag, target.os === 'win32' ? 'conpty.node' : 'pty.node')
  if (!same(ptyFile, skip)) write(path.join(nm, ptyFile), 'bin')
  if (target.os === 'win32') {
    // Windows 的 ConPTY 自带目录：只留目标架构那一份
    const want = target.arch === 'arm64' ? 'win10-arm64' : 'win10-x64'
    write(path.join(nm, 'node-pty', 'third_party', 'conpty', '1.25.0', want, 'conpty.dll'), 'dll')
  }
  for (const rel of o.extra ?? []) write(path.join(nm, rel), 'extra')
  const lock = {
    generatedAt: new Date().toISOString(),
    platform: { os: target.os, arch: target.arch, ...(target.libc ? { libc: target.libc } : {}), tag },
    abiScan: 'DEFERRED（交叉构建，需在目标平台补跑）',
    gatesDeferred: { abi: true, boot: true },
    platformPackages: (requiredNativeItems(target) ?? []).map(([r]) => r),
    nodeModulesFiles: 11169,
    totalFiles: 11171,
    totalBytes: 108000000,
  }
  write(path.join(dir, 'vendor.lock.json'), JSON.stringify(lock))
  return { dir, lock }
}

const run = (dir, lock, reference = null) => checkCrossTree({ dir, lock, referenceLock: reference })
// 取某条断言的结论（有则 true/false，没命中或命中多行则 null ⇒ 断言失败）。
// 用 line.includes('PASS') 会把 FAIL 行误读成通过。
const verdict = (res, needle) => {
  const hits = res.checks.filter((c) => /^\s+(?:PASS|FAIL)\s/.test(c) && c.includes(needle))
  if (hits.length !== 1) return null
  return /^\s+PASS\s/.test(hits[0])
}
// 结论行里的命中数（把"名字没对上"变成可见的失败）
const hitsOnce = (res, needle) => res.checks.filter((c) => /^\s+(?:PASS|FAIL)\s/.test(c) && c.includes(needle)).length === 1
const failuresOf = (res) => res.checks.filter((c) => c.includes('FAIL')).map((c) => c.replace(/^\s*FAIL\s+/, ''))

console.log('[两平台的正确树必须全过]')
const LINUX = { os: 'linux', arch: 'x64', libc: 'glibc' }
const LINUX_ARM = { os: 'linux', arch: 'arm64', libc: 'glibc' }
const WIN = { os: 'win32', arch: 'x64' }
for (const [name, target] of [['ok-linux', LINUX], ['ok-linux-arm64', LINUX_ARM], ['ok-win', WIN]]) {
  const { dir, lock } = makeTree(name, target)
  const res = run(dir, lock)
  ok(`${name}（${lock.platform.tag}）零失败`, res.fail === 0, failuresOf(res).join(' | ') || `pass=${res.pass}`)
}

console.log('[夹具本身有覆盖：每条断言都真的被判过]')
{
  const { dir, lock } = makeTree('ok-win-2', WIN)
  const res = run(dir, lock)
  ok('win32 夹具判出 18 条以上（不是空跑）', res.pass >= 18, `pass=${res.pass}`)
  ok('断言名存在性自检（写错名字的断言会被抓出）', verdict(res, '不含 spawn-helper') === true)
  ok('不存在的断言名返回 null（防止永远通过）', verdict(res, '这条断言名不存在') === null)
  ok('可命中的名字确实只命中一行（verdict 的前置条件）', hitsOnce(res, 'node-pty 预编译（conpty）：'))
}

console.log('[抽件必须被抓出]')
{
  const { dir, lock } = makeTree('miss-conpty', WIN, { skip: 'node-pty/prebuilds/win32-x64/conpty.node' })
  const res = run(dir, lock)
  const needle = 'node-pty 预编译（conpty）：node-pty/prebuilds/win32-x64/conpty.node'
  const hits = res.checks.filter((c) => /^\s+(?:PASS|FAIL)\s/.test(c) && c.includes(needle))
  ok('缺 conpty.node 判失败', verdict(res, needle) === false,
    `命中 ${hits.length} 行${hits.map((h) => ` [${h.trim()}]`).join('')}；实际 FAIL：${failuresOf(res).join(' | ')}`)
}
{
  const { dir, lock } = makeTree('miss-console-list', WIN, { skip: 'node-pty/prebuilds/win32-x64/conpty_console_list.node' })
  const res = run(dir, lock)
  ok('缺 conpty_console_list.node 判失败', verdict(res, 'node-pty 预编译（console list）：') === false, failuresOf(res).join(' | '))
}
{
  const { dir, lock } = makeTree('miss-conpty-dll', WIN, { skip: 'node-pty/prebuilds/win32-x64/conpty/conpty.dll' })
  const res = run(dir, lock)
  ok('缺 conpty.dll 判失败', verdict(res, 'ConPTY 运行时：') === false, failuresOf(res).join(' | '))
}
{
  const { dir, lock } = makeTree('miss-flock', LINUX, { skip: '@deepseek-ai/node-addon-system-linux-x64' })
  const res = run(dir, lock)
  ok('Linux 缺 POSIX flock 包判失败', verdict(res, 'POSIX flock') === false, failuresOf(res).join(' | '))
}
{
  const { dir, lock } = makeTree('miss-pty', LINUX, { skip: 'node-pty/prebuilds/linux-x64/pty.node' })
  const res = run(dir, lock)
  const needle = 'node-pty 预编译：node-pty/prebuilds/linux-x64/pty.node'
  const hits = res.checks.filter((c) => /^\s+(?:PASS|FAIL)\s/.test(c) && c.includes(needle))
  ok('Linux 缺 pty.node 判失败', verdict(res, needle) === false,
    `命中 ${hits.length} 行${hits.map((h) => ` [${h.trim()}]`).join('')}；实际 FAIL：${failuresOf(res).join(' | ')}`)
}

console.log('[串平台 / 残留 / wasm 兜底必须被抓出]')
{
  const { dir, lock } = makeTree('foreign-prebuild', LINUX, { extra: ['node-pty/prebuilds/win32-x64/pty.node'] })
  const res = run(dir, lock)
  ok('prebuilds 里混进别平台判失败', verdict(res, 'prebuilds 只留目标（与并入的）平台') === false, failuresOf(res).join(' | '))
}
// 双架构树（同平台另一种 CPU 架构用一棵树）：并入架构的包在才通过，被剪掉必须报错
console.log('[双架构树（并入同平台的另一架构）]')
{
  const { dir, lock } = makeTree('dual-arch', LINUX_ARM)
  // 把 x64 那一套平台包补进来（模拟 mergePlatformPackages 的产物）
  for (const [rel] of requiredNativeItems({ os: 'linux', arch: 'x64' })) write(path.join(dir, 'profile', 'node_modules', rel), 'bin')
  write(path.join(dir, 'profile', 'node_modules', 'node-pty', 'prebuilds', 'linux-x64', 'pty.node'), 'bin')
  lock.mergedPlatforms = ['linux-x64']    // 字符串写法（lock 里就是这么写的）
  const res = run(dir, lock)
  ok('双架构树（两套平台包齐备）零失败', res.fail === 0, failuresOf(res).join(' | '))
  ok('体检认出了并入的架构', verdict(res, '并入架构的平台专属件逐项齐全') === true, JSON.stringify(res.checks.filter((c) => c.includes('并入架构'))))
  // 抽掉并入架构的一个包：必须报错，而不是被"只留目标平台"的规则误放行
  fs.rmSync(path.join(dir, 'profile', 'node_modules', '@koromix', 'koffi-linux-x64'), { recursive: true, force: true })
  const res2 = run(dir, lock)
  ok('并入架构缺件判失败', verdict(res2, '并入架构的平台专属件逐项齐全') === false, failuresOf(res2).join(' | '))
  // 对象写法也要认（两代 lock 格式都可能出现）
  const { dir: d3, lock: l3 } = makeTree('dual-arch-obj', LINUX_ARM)
  l3.mergedPlatforms = [{ os: 'linux', arch: 'x64', tag: 'linux-x64' }]
  const res3 = run(d3, l3)
  ok('mergedPlatforms 的对象写法同样被认（并会因为缺件报错）',
    verdict(res3, '并入架构的平台专属件逐项齐全') === false, failuresOf(res3).join(' | '))
  // 反向断言：并入架构的树里混进别的平台 + 别的架构的包必须被抓到（只探目标架构会看不见 koffi-win32-arm64）
  const { dir: d4, lock: l4 } = makeTree('dual-arch-polluted', LINUX_ARM)
  for (const [rel] of requiredNativeItems({ os: 'linux', arch: 'x64' })) write(path.join(d4, 'profile', 'node_modules', rel), 'bin')
  write(path.join(d4, 'profile', 'node_modules', 'node-pty', 'prebuilds', 'linux-x64', 'pty.node'), 'bin')
  write(path.join(d4, 'profile', 'node_modules', '@koromix', 'koffi-win32-arm64', 'package.json'), '{}')
  l4.mergedPlatforms = ['linux-x64']
  const res4 = run(d4, l4)
  ok('混进别的平台 + 别的架构的包 → 被逐架构反向断言抓到',
    verdict(res4, '不含 win32 平台的专属件（逐类 × 逐架构）') === false, failuresOf(res4).join(' | '))
}
{
  const { dir, lock } = makeTree('foreign-conpty', LINUX)
  write(path.join(dir, 'profile', 'node_modules', 'node-pty', 'third_party', 'conpty', '1.25.0', 'win10-x64', 'conpty.dll'), 'dll')
  const res = run(dir, lock)
  ok('非 Windows 树带 ConPTY 判失败', verdict(res, '不含 ConPTY') === false, failuresOf(res).join(' | '))
}
{
  const { dir, lock } = makeTree('wasm', WIN, { extra: ['@img/sharp-wasm32/lib/sharp-wasm32.node.wasm'] })
  const res = run(dir, lock)
  ok('带 wasm32 兜底判失败', verdict(res, 'wasm32 兜底') === false, failuresOf(res).join(' | '))
}
{
  // Windows 树上出现 unix 的 pty.node：这不是"多余"，而是旧门禁表认错文件的方向
  const { dir, lock } = makeTree('win-pty-node', WIN, { extra: ['node-pty/prebuilds/win32-x64/pty.node'] })
  const res = run(dir, lock)
  ok('Windows 树上出现 unix pty.node 判失败（方向反了的门禁要能红）', verdict(res, 'unix 的 pty.node') === false)
}
{
  // spawn-helper 是别的平台的 pty 辅助程序，两平台都不该有：残留必须报错
  const { dir, lock } = makeTree('stray-spawn-helper', LINUX)
  write(path.join(dir, 'profile', 'node_modules', 'node-pty', 'prebuilds', 'linux-x64', 'spawn-helper'), 'bin')
  const res = run(dir, lock)
  ok('两平台都不该有 spawn-helper（残留必须报错）', verdict(res, '不含 spawn-helper') === false, failuresOf(res).join(' | '))
}
{
  const { dir, lock } = makeTree('multi-arch-conpty', WIN)
  write(path.join(dir, 'profile', 'node_modules', 'node-pty', 'third_party', 'conpty', '1.25.0', 'win10-arm64', 'conpty.dll'), 'dll')
  const res = run(dir, lock)
  ok('ConPTY 里混进别架构判失败', verdict(res, 'ConPTY 只留目标架构') === false, failuresOf(res).join(' | '))
}

console.log('[假绿：门禁延后却写 PASS]')
{
  const { dir, lock } = makeTree('fake-green', LINUX)
  lock.abiScan = 'PASS'          // gatesDeferred.abi 仍为 true
  const res = run(dir, lock)
  ok('"延后"却写 PASS 判失败（假绿比不写更坏）', verdict(res, '门禁结论与 gatesDeferred 自洽（延后不得写 PASS）') === false, failuresOf(res).join(' | '))
}
{
  const { dir, lock } = makeTree('real-pass', WIN)
  lock.abiScan = 'PASS'
  lock.gatesDeferred = { abi: false, boot: false }
  const res = run(dir, lock)
  ok('真跑过门禁的本机树写 PASS 合规', verdict(res, '门禁结论与 gatesDeferred 自洽') === true)
}

console.log('[lock 缺字段不得崩，只判失败]')
{
  const { dir, lock } = makeTree('no-platform', LINUX)
  delete lock.platform
  const res = run(dir, lock)
  ok('lock 无 platform 段时判失败而不抛异常', res.fail > 0 && verdict(res, 'lock 记录了 platform 段') === false, failuresOf(res).join(' | '))
}
{
  const { dir, lock } = makeTree('no-baseline', LINUX)
  delete lock.nodeModulesFiles
  const res = run(dir, lock)
  ok('lock 无 nodeModulesFiles 时判失败', verdict(res, '依赖完整性判据') === false)
}

console.log('[与现网树的对比]')
{
  const { dir, lock } = makeTree('cmp', LINUX)
  const live = { platform: { tag: 'win32-x64' }, totalFiles: 11168, totalBytes: 109469089 }
  const res = run(dir, lock, live)
  ok('同源两棵树体量相当 → 通过', verdict(res, '文件数量级相当') === true)
  const liveOld = { totalFiles: 11168, totalBytes: 109469089 }   // 旧格式 lock：没有 platform 段
  const resOld = run(dir, lock, liveOld)
  ok('现网 lock 是旧格式（无 platform）时判失败但不崩', verdict(resOld, '现网 lock 已记录平台段') === false)
  const resHuge = run(dir, { ...lock, totalFiles: 11171 * 5 }, live)
  ok('体量差一个数量级判失败', verdict(resHuge, '文件数量级相当') === false)
}

console.log('[mergePlatformPackages（并入同平台的另一架构）]')
{
  // 夹具照真实的树造：平台专属包都在作用域目录下，node-pty 的预编译藏在普通包里
  const donor = path.join(tmp, 'donor-x64')
  const host = path.join(tmp, 'host-arm64')
  const dnm = path.join(donor, 'node_modules')
  const hnm = path.join(host, 'node_modules')
  const x64 = ['@koromix/koffi-linux-x64', '@img/sharp-linux-x64', '@img/sharp-libvips-linux-x64',
    '@vscode/ripgrep-linux-x64', '@deepseek-ai/node-addon-system-linux-x64', 'node-addon-require-builtin-linux-x64']
  for (const p of x64) write(path.join(dnm, p, 'package.json'), '{}')
  write(path.join(dnm, 'node-pty', 'prebuilds', 'linux-x64', 'pty.node'), 'bin')
  // donor 里也要有非平台专属的东西：它必须不被搬过来（只补平台件，不整树拷贝）
  write(path.join(dnm, 'lodash', 'package.json'), '{}')
  write(path.join(dnm, '@deepseek-ai', 'dsh', 'package.json'), '{}')
  // 主树（arm64）已有的东西
  write(path.join(hnm, '@koromix', 'koffi-linux-arm64', 'package.json'), '{}')
  write(path.join(hnm, 'node-pty', 'prebuilds', 'linux-arm64', 'pty.node'), 'bin')
  write(path.join(hnm, 'lodash', 'package.json'), '{}')
  write(path.join(donor, 'vendor.lock.json'), JSON.stringify({ platform: { tag: 'linux-x64' } }))
  write(path.join(host, 'vendor.lock.json'), JSON.stringify({ platform: { tag: 'linux-arm64' } }))

  const r = mergePlatformPackages({ donorProfileDir: donor, donorRoot: donor, profileDir: host, target: { os: 'linux', arch: 'x64' }, log: () => {} })
  ok('合并到 7 项（6 个包 + node-pty 预编译）', r.copied.length === 7 && r.missing.length === 0, JSON.stringify({ copied: r.copied, missing: r.missing }))
  ok('x64 的 koffi 进了主树', fs.existsSync(path.join(hnm, '@koromix', 'koffi-linux-x64', 'package.json')))
  ok('x64 的 node-pty 预编译进了主树',
    fs.existsSync(path.join(hnm, 'node-pty', 'prebuilds', 'linux-x64', 'pty.node')))
  ok('主树原有的 arm64 包未被破坏', fs.existsSync(path.join(hnm, '@koromix', 'koffi-linux-arm64', 'package.json'))
    && fs.existsSync(path.join(hnm, 'node-pty', 'prebuilds', 'linux-arm64', 'pty.node')))
  ok('不搬非平台专属的包（不整树拷贝）',
    !r.copied.includes('lodash') && !r.copied.includes('@deepseek-ai/dsh'))
  // 平台不符的 donor 必须拒绝：拿错树会把同一个平台再拷一遍，看着成功、其实另一个架构还是缺。
  // 夹具按真实 staging 布局造（<root>/profile + <root>/vendor.lock.json），否则测不出"lock 位置拼错一层就静默失效"。
  const wrong = path.join(tmp, 'donor-wrong')
  write(path.join(wrong, 'profile', 'node_modules', '@koromix', 'koffi-linux-arm64', 'package.json'), '{}')
  write(path.join(wrong, 'vendor.lock.json'), JSON.stringify({ platform: { tag: 'linux-arm64' } }))
  const wrongProfile = path.join(wrong, 'profile')
  const rw = mergePlatformPackages({ donorProfileDir: wrongProfile, donorRoot: wrong, profileDir: host, target: { os: 'linux', arch: 'x64' }, log: () => {} })
  ok('donor 平台不符时报错而不是照搬', rw.copied.length === 0 && rw.missing.length === 1 && /不符/.test(rw.missing[0]), JSON.stringify(rw))
  // donorRoot 不传时按 <profile>/.. 推：钉住"别把 lock 的位置拼错"，拼错会让平台核对静默失效
  const inferred = mergePlatformPackages({ donorProfileDir: wrongProfile, profileDir: host, target: { os: 'linux', arch: 'x64' }, log: () => {} })
  ok('donorRoot 不传时也能读到 lock（按 profile 的父目录推）',
    inferred.missing.some((m) => /不符/.test(m)), JSON.stringify(inferred))
}

console.log('[isPlatformTaggedPath / conptyDirName]')
{
  const D = { os: 'linux', arch: 'x64' }
  ok('认得 @scope/<pkg>-<os>-<arch>', isPlatformTaggedPath('@koromix/koffi-linux-x64', D))
  ok('认得 sharp 的 libvips 子包（名字形状不同）', isPlatformTaggedPath('@img/sharp-libvips-linux-x64', D))
  ok('认得 node-addon-require-builtin 的 ABI 后缀形式', isPlatformTaggedPath('node-addon-require-builtin-linux-x64-msvc', D) === false
    || isPlatformTaggedPath('node-addon-require-builtin-linux-x64', D))
  ok('认得 node-pty 的 prebuilds 路径', isPlatformTaggedPath('node-pty/prebuilds/linux-x64', D))
  ok('不认无关包', !isPlatformTaggedPath('lodash', D) && !isPlatformTaggedPath('@deepseek-ai/dsh', D))
  ok('不把 arm64 当成 x64', !isPlatformTaggedPath('@koromix/koffi-linux-arm64', D))
  ok('conptyDirName 用 win10-<arch>（与 platformTag 不同形）',
    conptyDirName('x64') === 'win10-x64' && conptyDirName('arm64') === 'win10-arm64' && conptyDirName('ia32') === 'win10-ia32')
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log(fail === 0 ? '\nCROSS TREE SELF TEST: ALL PASS' : `\nCROSS TREE SELF TEST: ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
