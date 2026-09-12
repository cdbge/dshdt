// apply-self-test.mjs — 接线级自检：用 mock ctx 驱动 apply()，验证审批瀑布的分支行为
// 用法：node test/apply-self-test.mjs
import { apply, __injectSchemaLib, __injectReviewer, prefilter, buildReviewPrompt, parseVerdict } from '../lib/index.js'

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
  const state = { handlers: {}, onOptions: {}, commands: [], settingUpdates: [], cfg: null, registered: false }
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
    on(ev, fn, opts) { state.handlers[ev] = fn; state.onOptions[ev] = opts },
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
// 2) 命中高风险词 → 交模型审查；模型判 ask → 转问用户
//    （v2 里词表**不再直接判死**，所以这条断言的是"模型说 ask 就 ask"）
{
  __injectReviewer(async () => ({ verdict: 'ask', why: '提权到完全访问' }))
  const s = await makeCtx()
  const r = await s.handlers['approval/request']({ toolName: 'pwsh', reason: 'sandbox_permissions: danger-full-access' }, next)
  ok('命中风险词 + 模型判 ask → 转问用户（next）', r === NEXT, String(r))
  __injectReviewer(null)
}
// 3) 必问工具优先于白名单
{
  const s = await makeCtx({ lowRiskTools: ['cordis_run'] })
  const r = await s.handlers['approval/request']({ toolName: 'cordis_run', reason: '看起来无害' }, next)
  ok('alwaysAskTools 优先 → 转问用户', r === NEXT, String(r))
}
// 4) v2：非白名单工具 + 干净 reason → 交模型审查；**模型判 allow 才放行**
{
  __injectReviewer(async () => ({ verdict: 'allow', why: '写入项目内文件，有界可回滚' }))
  const s = await makeCtx({ autoApproveUpTo: 'medium' })
  const r = await s.handlers['approval/request']({ toolName: 'write', reason: '写入项目内文件' }, next)
  ok('v2：常规请求 → 模型判 allow → 自动放行', r === 'allowed-once', String(r))
  __injectReviewer(null)
}
// 4b) 审查器不可用（这里 mock 没有 agentDefaultModel）→ **fail-closed 转问用户**
{
  const s = await makeCtx({ autoApproveUpTo: 'medium' })
  const r = await s.handlers['approval/request']({ toolName: 'write', reason: '写入项目内文件' }, next)
  ok('v2：审查器不可用 → fail-closed 转问用户（绝不默认放行）', r === NEXT, String(r))
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
// 10) 监听必须挂在 apply 的**同步段**（不能排在 await 之后）
//     这是对一次真实故障的回归：把设置注册（含 await）排在监听之前，ctx.on 就落到了
//     错误的作用域——请求再也不进来，而"已装载"照打、settings 照注册，日志上完全看不出来。
//     根因：Cordis 的 dispatch() 只读**派发目标 ctx 自己**的 _hooks、不向上遍历作用域链，
//     而审批瀑布是按 agent 作用域派发的；ctx.on 挂到哪个作用域取决于注册时机。
{
  const state = { handlers: {}, onOptions: {}, commands: [], settingUpdates: [], cfg: null, registered: false }
  const ctx = {
    on(ev, fn, opts) { state.handlers[ev] = fn; state.onOptions[ev] = opts },
    get(name) {
      if (name === 'settings') return {
        register(_ns, schema) {
          if (typeof schema !== 'function') throw new Error('schema is not a function')
          state.registered = true
          state.cfg = schema({})
          return { get value() { return state.cfg }, update: async () => {} }
        },
      }
      if (name === 'commands') return { register: (d) => { state.commands.push(d); return () => {} } }
      return undefined
    },
  }
  const pending = apply(ctx)   // 故意**不 await**：同步段就该已经挂好
  ok('监听在 apply 的同步段就已挂上（不依赖 await）',
    typeof state.handlers['approval/request'] === 'function',
    typeof state.handlers['approval/request'])
  // 只同步段还不够：Cordis 的 dispatch 会按作用域过滤，而审批瀑布按 agent 作用域派发。
  // 必须显式 global 才能短路那个过滤（否则实测收不到请求）。
  ok('监听声明了 { global: true }（跨作用域投递）',
    state.onOptions['approval/request'] !== undefined && state.onOptions['approval/request'].global === true,
    JSON.stringify(state.onOptions['approval/request']))
  await pending
}

// ── 决策层 v2：预筛（硬拦 + 快路 + 证据） + 独立模型审查 ─────────────────────
const CFG2 = {
  highRiskPatterns: ['danger-full-access', 'sudo'],
  lowRiskTools: ['read', 'grep'],
  alwaysAskTools: ['cordis_run'],
  reviewerEnabled: true,
  autoApproveUpTo: 'medium',
}
{
  const r = prefilter({ toolName: 'cordis_run', reason: '看起来无害' }, CFG2)
  ok('预筛：alwaysAskTools → 硬拦（不交模型）', r.route === 'ask', r.why)
}
{
  const r = prefilter({ toolName: 'pwsh' }, CFG2)
  ok('预筛：无 reason → 硬拦', r.route === 'ask', r.why)
}
{
  const r = prefilter({ toolName: 'read', reason: '读一个文件' }, CFG2)
  ok('预筛：低风险工具且无风险词 → 直接放行快路（不花模型调用）', r.route === 'allow', r.why)
}
{
  const r = prefilter({ toolName: 'pwsh', reason: 'escalate sandbox to danger-full-access: 部署配置' }, CFG2)
  ok('预筛：命中风险词 → 交模型审查（**不再直接判死**）', r.route === 'review' && r.hits.includes('danger-full-access'), r.why)
}
{
  const p = parseVerdict('好的，结论如下：{"verdict":"allow","why":"工作区内的有界操作"}')
  ok('解析：夹带文字也能取出 JSON', p.verdict === 'allow', p.why)
}
{
  const p = parseVerdict('我无法判断')
  ok('解析：无 JSON → fail-closed 为 ask', p.verdict === 'ask', p.why)
}
{
  const p = parseVerdict('{"verdict":"maybe"}')
  ok('解析：未知裁决 → ask', p.verdict === 'ask', p.why)
}
{
  const b = buildReviewPrompt({ toolName: 'pwsh', reason: 'r' }, ['sudo'])
  ok('打包：请求被 JSON 包住（用户内容无法伪造结构）', b.includes('"matchedRiskKeywords":["sudo"]'), b.slice(0, 32))
}
// 端到端：模型判 allow → **即使命中高风险词也放行**（证明词表已降级为证据）
{
  __injectReviewer(async () => ({ verdict: 'allow', why: '工作区内的有界操作', model: 'fake/1' }))
  const s = await makeCtx()
  const r = await s.handlers['approval/request']({ toolName: 'pwsh', reason: 'escalate sandbox to danger-full-access: 部署配置' }, next)
  ok('端到端：模型判 allow → 自动放行（词表只作证据）', r === 'allowed-once', String(r))
  __injectReviewer(null)
}
// 端到端：模型判 ask → 转问用户
{
  __injectReviewer(async () => ({ verdict: 'ask', why: '不可逆删除' }))
  const s = await makeCtx()
  const r = await s.handlers['approval/request']({ toolName: 'pwsh', reason: 'escalate sandbox to danger-full-access: 清空系统目录' }, next)
  ok('端到端：模型判 ask → 转问用户', r === NEXT, String(r))
  __injectReviewer(null)
}
// 端到端：审查器抛错 → fail-closed
{
  __injectReviewer(async () => { throw new Error('模型超时') })
  const s = await makeCtx()
  const r = await s.handlers['approval/request']({ toolName: 'pwsh', reason: 'escalate sandbox to danger-full-access: x' }, next)
  ok('端到端：审查器抛错 → fail-closed 转问用户', r === NEXT, String(r))
  __injectReviewer(null)
}
// 端到端：审查器被关掉 → 除快路外一律问用户，且**不该发起模型调用**
{
  let called = false
  __injectReviewer(async () => { called = true; return { verdict: 'allow', why: 'x' } })
  const s = await makeCtx({ reviewerEnabled: false })
  const r = await s.handlers['approval/request']({ toolName: 'pwsh', reason: 'escalate sandbox to danger-full-access: x' }, next)
  ok('端到端：reviewerEnabled=false → 不问模型、直接问用户', r === NEXT && called === false, `r=${String(r)} called=${called}`)
  __injectReviewer(null)
}

console.log(`\nAPPLY SELF TEST: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
