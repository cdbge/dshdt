// apply-self-test.mjs — 接线级自检：用 mock ctx 驱动 apply()，验证审批瀑布的分支行为
// 用法：node test/apply-self-test.mjs
import { apply, gradeRequest } from '../lib/index.js'

let pass = 0, fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

/** 造一个 mock 上下文：记录事件监听、命令注册、并可注入配置 */
function makeCtx(cfgOverride = {}) {
  const state = { handlers: {}, commands: [], settingUpdates: [], cfg: null }
  const base = {
    enabled: true,
    autoApproveUpTo: 'medium',
    highRiskPatterns: ['danger-full-access', 'sudo', '工作区外'],
    lowRiskTools: ['read', 'grep'],
    alwaysAskTools: ['cordis_run'],
    logDecisions: false,          // 自检不写日志文件
    logFile: '',
    ...cfgOverride,
  }
  state.cfg = base
  const ctx = {
    on(ev, fn) { state.handlers[ev] = fn },
    get(name) {
      if (name === 'settings') return {
        register: () => ({
          get value() { return state.cfg },
          update: async (patch) => { state.settingUpdates.push(patch); Object.assign(state.cfg, patch) },
        }),
      }
      if (name === 'commands') return { register: (def) => { state.commands.push(def); return () => {} } }
      return undefined
    },
  }
  apply(ctx)
  return state
}

const NEXT = Symbol('next')
const next = () => Promise.resolve(NEXT)

// 1) 低风险白名单工具 → 自动放行
{
  const s = makeCtx()
  const r = await s.handlers['approval/request']({ toolName: 'read', reason: '读外部文件' }, next)
  ok('低风险工具 → 自动放行 allowed-once', r === 'allowed-once', String(r))
}
// 2) 高风险关键词 → 转问用户（调用 next）
{
  const s = makeCtx()
  const r = await s.handlers['approval/request']({ toolName: 'pwsh', reason: 'sandbox_permissions: danger-full-access' }, next)
  ok('高风险 → 转问用户（next）', r === NEXT, String(r))
}
// 3) 必问工具优先于白名单
{
  const s = makeCtx({ lowRiskTools: ['cordis_run'] })
  const r = await s.handlers['approval/request']({ toolName: 'cordis_run', reason: '看起来无害' }, next)
  ok('alwaysAskTools 优先 → 转问用户', r === NEXT, String(r))
}
// 4) medium + 上限 medium → 自动放行
{
  const s = makeCtx({ autoApproveUpTo: 'medium' })
  const r = await s.handlers['approval/request']({ toolName: 'write', reason: '写入项目内文件' }, next)
  ok('medium + 上限 medium → 自动放行', r === 'allowed-once', String(r))
}
// 5) medium + 上限 low → 转问用户
{
  const s = makeCtx({ autoApproveUpTo: 'low' })
  const r = await s.handlers['approval/request']({ toolName: 'write', reason: '写入项目内文件' }, next)
  ok('medium + 上限 low → 转问用户', r === NEXT, String(r))
}
// 6) 无 reason → 转问用户（判不准就不猜）
{
  const s = makeCtx()
  const r = await s.handlers['approval/request']({ toolName: 'mystery' }, next)
  ok('无 reason → 转问用户', r === NEXT, String(r))
}
// 7) 总开关关闭 → 一律转问（完全不介入）
{
  const s = makeCtx({ enabled: false })
  const r1 = await s.handlers['approval/request']({ toolName: 'read', reason: 'x' }, next)
  const r2 = await s.handlers['approval/request']({ toolName: 'pwsh', reason: 'danger-full-access' }, next)
  ok('enabled=false → 低风险也不放行', r1 === NEXT && r2 === NEXT, `${String(r1)} / ${String(r2)}`)
}
// 8) /approval 命令注册 + on/off 写设置
{
  const s = makeCtx()
  ok('注册了 approval 命令', s.commands.length === 1 && s.commands[0].name === 'approval', s.commands.map((c) => c.name).join(','))
  const off = await s.commands[0].handler({ rawInput: 'off' })
  ok('/approval off 写入 settings', off.kind === 'success' && s.settingUpdates.some((u) => u.enabled === false), JSON.stringify(s.settingUpdates))
  const on = await s.commands[0].handler({ rawInput: 'on' })
  ok('/approval on 写入 settings', on.kind === 'success' && s.settingUpdates.some((u) => u.enabled === true), JSON.stringify(on.text))
  const rules = await s.commands[0].handler({ rawInput: 'rules' })
  ok('/approval rules 有输出', rules.kind === 'success' && rules.text.includes('自动放行上限'), rules.text.split('\n')[0])
}
// 9) 审批事件被监听
{
  const s = makeCtx()
  ok('监听了 approval/request', typeof s.handlers['approval/request'] === 'function')
}

console.log(`\nAPPLY SELF TEST: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
