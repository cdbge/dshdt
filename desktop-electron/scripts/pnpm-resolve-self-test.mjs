// pnpm-resolve-self-test.mjs — 离线自检"pnpm 在哪、能不能跑"的判定逻辑：
// 先按绝对路径候选找（找到就用 node 直调，不依赖 PATH），再退回 PATH；spawnSync/exists 均为注入。
import {
  pnpmCandidates, resolvePnpm, envWithPnpmOnPath,
} from '../src/pnpm-resolve.mjs'
import { npmCandidates } from '../src/vendor-build.mjs'

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

// 造一个假的 spawnSync：works 里的路径会被当成"能跑起来"，其余按失败返回
function fakeSpawn({ works = [], versionOf = () => '11.22.0', enoentFor = () => false } = {}) {
  const calls = []
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], shell: opts && opts.shell === true })
    // 候选路径直调：args[0] 是 pnpm.cjs
    if (Array.isArray(args) && works.includes(args[0])) return { status: 0, stdout: `${versionOf(args[0])}\n`, stderr: '' }
    // PATH 探测：cmd === 'pnpm'
    if (cmd === 'pnpm' && works.includes('pnpm')) return { status: 0, stdout: `${versionOf('pnpm')}\n`, stderr: '' }
    if (enoentFor(cmd)) return { status: null, error: Object.assign(new Error('not found'), { code: 'ENOENT' }) }
    return { status: 1, stdout: '', stderr: 'boom' }
  }
  impl.calls = calls
  return impl
}

console.log('[候选路径]')
{
  const cands = pnpmCandidates({
    npmCandidates: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'],
    env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local', ProgramFiles: 'C:\\Program Files' },
  })
  ok('从 npm 候选派生出同级的 pnpm.cjs（锚点与 npm 同源）',
    cands.includes('C:\\Program Files\\nodejs\\node_modules/pnpm/bin/pnpm.cjs'), cands[0] || '(空)')
  ok('覆盖 %APPDATA%\\npm（npm i -g 的默认全局目录）',
    cands.includes('C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs'))
  ok('覆盖 <Node>\\node_global（本机实测 pnpm 就在这儿）',
    cands.includes('C:\\Program Files\\nodejs\\node_global\\node_modules\\pnpm\\bin\\pnpm.cjs'))
  ok('覆盖 POSIX 常见前缀（/usr/local、Homebrew）',
    cands.includes('/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs')
    && cands.includes('/opt/homebrew/lib/node_modules/pnpm/bin/pnpm.cjs'))
  ok('候选里没有重复项', new Set(cands).size === cands.length, `${cands.length} 项`)
}
console.log('[从真实 npmCandidates 派生]')
{
  const cands = pnpmCandidates({ npmCandidates: npmCandidates({ env: {}, execPath: 'C:\\node\\node.exe' }) })
  ok('真实 npmCandidates 能派生出 pnpm 候选', cands.length > 0, `${cands.length} 项`)
}

console.log('[resolvePnpm：绝对路径优先]')
{
  const cand = 'C:\\Program Files\\nodejs\\node_global\\node_modules\\pnpm\\bin\\pnpm.cjs'
  const sp = fakeSpawn({ works: [cand], versionOf: () => '11.22.0' })
  const r = resolvePnpm({ spawnSync: sp, nodePath: 'C:\\Program Files\\nodejs\\node.exe', candidates: [cand], exists: () => true })
  ok('候选存在且能跑 ⇒ ok', r.ok === true)
  ok('用 **node 直调** pnpm.cjs（不依赖 PATH）',
    sp.calls[0] && sp.calls[0].cmd === 'C:\\Program Files\\nodejs\\node.exe' && sp.calls[0].args[0] === cand,
    JSON.stringify(sp.calls[0] || {}))
  ok('直调**不加 shell**（受限环境里加 shell 会先起 cmd.exe 而 EPERM，白白判死可用路径）',
    sp.calls[0] && sp.calls[0].shell === false)
  ok('拿得到版本号与来源', r.version === '11.22.0' && /绝对路径/.test(r.how), r.how)
  ok('返回 path 供调用方注入子进程 PATH', r.path === cand)
}
console.log('[resolvePnpm：绝对路径全失败 ⇒ 退回 PATH]')
{
  const cand = 'C:\\Program Files\\nodejs\\node_global\\node_modules\\pnpm\\bin\\pnpm.cjs'
  const sp = fakeSpawn({ works: ['pnpm'], versionOf: () => '10.0.0', enoentFor: () => false })
  const r = resolvePnpm({ spawnSync: sp, nodePath: 'C:\\node\\node.exe', candidates: [cand], exists: () => true })
  ok('PATH 上有 pnpm ⇒ ok', r.ok === true && r.version === '10.0.0', JSON.stringify(r))
  ok('标注来源是 PATH', /PATH/.test(r.how), r.how)
  ok('PATH 兜底时 path 为空（调用方据此不做注入）', r.path === '')
}
console.log('[resolvePnpm：找不到时要说清"找了哪些地方"]')
{
  const sp = fakeSpawn({ works: [], enoentFor: () => true })
  const r = resolvePnpm({
    spawnSync: sp, nodePath: 'C:\\node\\node.exe',
    candidates: ['C:\\a\\pnpm.cjs', 'C:\\b\\pnpm.cjs'], exists: () => true,
  })
  ok('判为不可用', r.ok === false)
  ok('detail 里报出候选数量与 PATH 的失败原因',
    /2 个候选路径/.test(r.detail) && /不在 PATH 上|没找到/.test(r.detail), r.detail)
}
console.log('[resolvePnpm：exists 过滤能省掉无意义的 spawn]')
{
  const sp = fakeSpawn({ works: ['C:\\only\\pnpm.cjs'] })
  const r = resolvePnpm({
    spawnSync: sp, nodePath: 'C:\\node\\node.exe',
    candidates: ['C:\\missing\\pnpm.cjs', 'C:\\only\\pnpm.cjs'],
    exists: (p) => p === 'C:\\only\\pnpm.cjs',
  })
  ok('只对存在的候选发起探测', sp.calls.length === 1 && sp.calls[0].args[0] === 'C:\\only\\pnpm.cjs', `${sp.calls.length} 次`)
  ok('结果正确', r.ok === true && r.path === 'C:\\only\\pnpm.cjs')
}

console.log('[envWithPnpmOnPath：把 pnpm 所在目录注入子进程 PATH]')
{
  const pnpmPath = 'C:\\Program Files\\nodejs\\node_global\\node_modules\\pnpm\\bin\\pnpm.cjs'
  const e = envWithPnpmOnPath({ pnpmPath, nodePath: 'C:\\Program Files\\nodejs\\node.exe', env: { PATH: 'C:\\Windows' }, platform: 'win32' })
  ok('注入了 pnpm 的 bin 目录（官方 CLI 内部 spawn("pnpm") 靠它才找得到）',
    e.prepended.includes('C:\\Program Files\\nodejs\\node_global\\node_modules\\pnpm\\bin'), JSON.stringify(e.prepended))
  ok('注入了 node_modules\\.bin', e.prepended.some((d) => d.endsWith('node_modules/.bin')), JSON.stringify(e.prepended))
  ok('原有 PATH 保留在最后（不覆盖用户环境）', e.env.PATH.endsWith('C:\\Windows'))
  ok('分隔符按平台（Windows 用 ;）', e.env.PATH.includes(';C:\\Windows'))
}
{
  const e = envWithPnpmOnPath({ pnpmPath: '/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs', nodePath: '/usr/bin/node', env: { PATH: '/usr/bin' }, platform: 'linux' })
  ok('POSIX 用 : 分隔', e.env.PATH.includes(':/usr/bin') && !e.env.PATH.includes(';'), e.env.PATH)
}
{
  const e = envWithPnpmOnPath({ pnpmPath: '', nodePath: 'C:\\node\\node.exe', env: { PATH: 'X' }, platform: 'win32' })
  ok('没有 pnpm 路径时只注入 node 目录，不会把 PATH 弄坏', e.env.PATH.startsWith('C:\\node;X'), e.env.PATH)
}

console.log(`\nPNPM RESOLVE SELF TEST: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
