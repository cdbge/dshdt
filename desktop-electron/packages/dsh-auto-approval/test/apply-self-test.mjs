// apply-self-test.mjs — 接线级自检：用 mock ctx 驱动 apply()，验证审批瀑布的分支行为
// 用法：node test/apply-self-test.mjs
import { apply, __injectSchemaLib } from '../lib/index.js'

// 仓库包目录上面没有 node_modules，解析不到 schemastery（生产态由宿主 vendor 树提供）。
// 自检所需的这一份从**仓库自带的 vendor 树**取，并注入给被测插件——否则注册那一环根本
// 走不到，"把 zod 对象当 schemastery 传"这类故障就永远测不出来（初版的教训，见规范坑 48）。
async function loadSchemastery() {
  const tries = [
    '@deepseek-ai/schemastery',
    '../../../vendor/profile/node_modules/@deepseek-ai/schemastery/lib/index.mjs',
  ]
  for (const spec of tries) {
    try {
      const m = spec.startsWith('.') ? await import(new URL(spec, import.meta.url).href) : await import(spec)
      return m.default ?? m
    } catch { /* 试下一个 */ }
  }
  throw new Error('自检需要 schemastery：仓库 vendor 树里没找到 '
    + 'desktop-electron/vendor/profile/node_modules/@deepseek-ai/schemastery')
}
__injectSchemaLib(await loadSchemastery())

let pass = 0, fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}

/** 造一个 mock 上下文：记录事件监听、命令注册，并可注入配置。apply 是 async，故本函数也 async。 */
async function makeCtx(cfgOverride = {}) {
  const state = { handlers: {}, commands: [], settingUpdates: [], cfg: null, registered: false }
  const cfgBase = {
    enabled: true,
    autoApproveUpTo: 'medium',
    highRiskPatterns: ['danger-full-access', 'sudo', '工作区外'],
    lowRiskTools: ['read', 'grep'],
    alwaysAskTools: ['cordis_run'],
    logDecisions: false,          // 自检不写日志文件
    logFile: '',
    ...cfgOverride,
  }
  state.cfg = cfgBase
  const ctx = {
    on(ev, fn) { state.handlers[ev] = fn },
    get(name) {
      if (name === 'settings') return {
        // **照真实服务的行为来**：dsh-settings 的 resolve() 是
        //     const value = schema(mergeLayers(base, section))
        // ——schema 会被**当函数调用**。初版 mock 把 schema 参数整个忽略，
        // 于是"传了个不可调用的 schema"这个真实故障在自检里永远看不见
        // （当时 8 通过 4 失败、且这 4 条没人管，本可当场拦住）。
        register: (_ns, schema) => {
          if (typeof schema !== 'function') throw new Error('schema is not a function')
          state.registered = true
          state.cfg = { ...schema({}), ...cfgOverride }   // 真解析一次：既验 schema 可用，也取默认值
          return {
            get value() { return state.cfg },
            update: async (patch) => { state.settingUpdates.push(patch); Object.assign(state.cfg, patch) },
          }
        },
      }
      if (name === 'commands') return { register: (def) => { state.commands.push(def); return () => {} } }
      return undefined
    },
  }
  await apply(ctx)
  return state
}

const NEXT = Symbol('next')
const next = () => Promise.resolve(NEXT)

// 0) 设置命名空间注册成功 —— 初版缺的就是这一条
{
  const s = await makeCtx()
  ok('settings 命名空间注册成功（schema 被当函数调用）', s.registered === true, String(s.registered))
}
// 1) 低风险白名单工具 → 自动放行
{
  const s = await makeCtx()
  const r = await s.handlers['approval/request']({ toolName: 'read', reason: '读外部文件' }, next)
  ok('低风险工具 → 自动放行 allowed-once', r === 'allowed-once', String(r))
}
// 2) 高风险关键词 → 转问用户（调用 next）
{
  const s = await makeCtx()
  const r = await s.handlers['approval/request']({ toolName: 'pwsh', reason: 'sandbox_permissions: danger-full-access' }, next)
  ok('高风险 → 转问用户（next）', r === NEXT, String(r))
}
// 3) 必问工具优先于白名单
{
  const s = await makeCtx({ lowRiskTools: ['cordis_run'] })
  const r = await s.handlers['approval/request']({ toolName: 'cordis_run', reason: '看起来无害' }, next)
  ok('alwaysAskTools 优先 → 转问用户', r === NEXT, String(r))
}
// 4) medium + 上限 medium → 自动放行
{
  const s = await makeCtx({ autoApproveUpTo: 'medium' })
  const r = await s.handlers['approval/request']({ toolName: 'write', reason: '写入项目内文件' }, next)
  ok('medium + 上限 medium → 自动放行', r === 'allowed-once', String(r))
}
// 5) medium + 上限 low → 转问用户
{
  const s = await makeCtx({ autoApproveUpTo: 'low' })
  const r = await s.handlers['approval/request']({ toolName: 'write', reason: '写入项目内文件' }, next)
  ok('medium + 上限 low → 转问用户', r === NEXT, String(r))
}
// 6) 无 reason → 转问用户（判不准就不猜）
{
  const s = await makeCtx()
  const r = await s.handlers['approval/request']({ toolName: 'mystery' }, next)
  ok('无 reason → 转问用户', r === NEXT, String(r))
}
// 7) 总开关关闭 → 一律转问（完全不介入）
{
  const s = await makeCtx({ enabled: false })
  const r1 = await s.handlers['approval/request']({ toolName: 'read', reason: 'x' }, next)
  const r2 = await s.handlers['approval/request']({ toolName: 'pwsh', reason: 'danger-full-access' }, next)
  ok('enabled=false → 低风险也不放行', r1 === NEXT && r2 === NEXT, `${String(r1)} / ${String(r2)}`)
}
// 8) /approval 命令注册 + on/off 写设置
{
  const s = await makeCtx()
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
  const s = await makeCtx()
  ok('监听了 approval/request', typeof s.handlers['approval/request'] === 'function')
}

console.log(`\nAPPLY SELF TEST: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
