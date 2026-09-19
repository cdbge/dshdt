// apply-self-test.mjs — 接线级自检：用 mock ctx 驱动 apply()，验证审批瀑布的分支行为
// 用法：node test/apply-self-test.mjs
import { apply, __injectSchemaLib, __injectReviewer, prefilter, buildReviewPrompt, parseVerdict, pickVerdictText, summarizeArgs } from '../lib/index.js'
import { readFileSync } from 'node:fs'

// 仓库包目录上面没有 node_modules，解析不到 schemastery（生产态由宿主 vendor 树提供）。
// 自检所需的这一份从**仓库自带的 vendor 树**取，并注入给被测插件——否则注册那一环根本
// 走不到，"把 zod 对象当 schemastery 传"这类故障就永远测不出来（初版的教训）。
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
  // **这条才是真正让插件活过来的那个**：审批瀑布按注册顺序执行（waterfall() 里是 cbs.shift()），
  // 而 DSH 自己的桥（dsh-api-remotes）注册得早、且拿到答复就**终止整条链**（它不调 next()）——
  // 所以注册在桥之后的监听永远不会被执行：插件静默失效、用户照旧手点。
  // prepend 把本监听插到表头，抢在桥之前拿到请求。两个维度不同：prepend 管顺序，global 管作用域。
  ok('监听声明了 { prepend: true }（抢在 DSH 审批桥之前）',
    state.onOptions['approval/request'] !== undefined && state.onOptions['approval/request'].prepend === true,
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
// ↓ 2026-09-17 实机事故（日志里连着 9 次 `verdictWhy=审查模型未输出可解析的 JSON`）：
//   默认 maxTokens=200 被推理阶段吃满 ⇒ content 是空串。这两条把"病因"钉在断言里。
{
  const p = parseVerdict('')
  ok('解析：空内容 → ask，且理由点明"maxTokens 被推理用满"',
    p.verdict === 'ask' && p.why.includes('maxTokens'), p.why)
}
{
  const p = parseVerdict('```json\n{"verdict":"allow","why":"工作区内的有界操作"}\n```')
  ok('解析：``` 围栏里的 JSON 也要能取出来', p.verdict === 'allow', p.why)
}
{
  const p = parseVerdict('推理里出现过 {"verdict":"ask"} 这样的示例，最终结论：{"verdict":"allow","why":"有界"}')
  ok('解析：多段花括号时取"最后一段完整 JSON"', p.verdict === 'allow', p.why)
}
{
  const t = pickVerdictText('```json\n{"verdict":"ask","why":"x"}\n```')
  ok('剥围栏：返回纯 JSON 文本', t === '{"verdict":"ask","why":"x"}', t)
}
{
  // 默认额度必须**大于推理阶段**：200 会被推理吃满（实机证据见上面两条）
  const cfg = await makeCtx().then((s) => s.cfg)
  ok('默认 reviewMaxTokens ≥ 800（推理模型要有出结论的余量）', Number(cfg.reviewMaxTokens) >= 800, String(cfg.reviewMaxTokens))
}
{
  const b = buildReviewPrompt({ toolName: 'pwsh', reason: 'r' }, ['sudo'])
  ok('打包：请求被 JSON 包住', b.includes('"matchedRiskKeywords":["sudo"]'), b.slice(0, 32))
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

// ── 读命令：把工具调用的**真实参数**喂给审查器（审批请求里本身没有 args）────────
{
  const s = summarizeArgs({ command: 'Remove-Item -Recurse C:\\Windows' })
  ok('summarizeArgs：对象被序列化成命令文本', s.includes('Remove-Item -Recurse'), s.slice(0, 44))
}
{
  ok('summarizeArgs：undefined → 空串', summarizeArgs(undefined) === '', `"${summarizeArgs(undefined)}"`)
}
{
  const long = summarizeArgs({ command: 'x'.repeat(2000) }, 100)
  ok('summarizeArgs：超长被截断且标注长度', long.includes('已截断') && long.length < 200, String(long.length))
}
{
  const b = buildReviewPrompt({ toolName: 'pwsh', reason: 'r' }, [], 'echo hi')
  ok('打包：含真实命令字段', b.includes('"command":"echo hi"'), b.slice(0, 70))
}
{
  const b = buildReviewPrompt({ toolName: 'pwsh', reason: 'r' }, [], '')
  ok('打包：取不到命令时显式写明（不让模型误以为命令为空）', b.includes('未取到该次调用的参数'), '')
}
// 端到端：pre-execute 记下参数 → 审批时按 callId 取回 → 审查器收到真实命令
{
  let got = null
  __injectReviewer(async (req, hits, signal, command) => { got = command; return { verdict: 'ask', why: 'x' } })
  const s = await makeCtx()
  await s.handlers['tools/pre-execute']({ callId: 'call-1', name: 'pwsh', arguments: { command: 'echo hello' } }, next)
  await s.handlers['approval/request']({ toolName: 'pwsh', callId: 'call-1', reason: 'escalate sandbox to danger-full-access: x' }, next)
  ok('端到端：审查器拿到真实命令（不再只有理由）', typeof got === 'string' && got.includes('echo hello'), String(got))
  __injectReviewer(null)
}
// 端到端：没有对应的 pre-execute 记录 → 空串（不崩、不误报）
{
  let got = 'unset'
  __injectReviewer(async (req, hits, signal, command) => { got = command; return { verdict: 'ask', why: 'x' } })
  const s = await makeCtx()
  await s.handlers['approval/request']({ toolName: 'pwsh', callId: 'no-such-call', reason: 'escalate sandbox to danger-full-access: x' }, next)
  ok('端到端：无记录时命令为空串（fail-safe 不误报）', got === '', JSON.stringify(got))
  __injectReviewer(null)
}
// pre-execute 监听同样要 global（作用域过滤），但**不**该 prepend（我们只观察）
{
  const s = await makeCtx()
  const o = s.onOptions['tools/pre-execute']
  ok('tools/pre-execute 监听声明了 { global: true } 且未 prepend',
    o !== undefined && o.global === true && o.prepend !== true, JSON.stringify(o))
}

// ── 客户端半身（指令菜单图标）的打包契约 ──────────────────────────────────────
// 为什么值得在这里查：这一半**根本不经过 apply()**，所以上面所有 mock 驱动的断言都看不见它；
// 而它一旦配错（少 exports["./client"]、缺 dsh.client、bundle id 写错），表现是
// **静默无图标**——没有任何报错，只能靠肉眼发现。四类硬要求逐条钉住：
//   ① `exports["./client"]` 存在（客户端扫描器的判据之一，缺了整包不会被当客户端插件）；
//   ② `dsh.client.platform === "web"`（另一个判据）；
//   ③ `exports["."]` 仍在（**改了 exports 很容易顺手删掉它**，那会让 Host 半身解析断掉）；
//   ④ bundle 用包名自注册 + 只 require seed 模块（primitives 是 seed，其它 specifier 会抛
//      "missed the module table"）。
{
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const clientSrc = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  ok('客户端半身：exports["./client"] 指向 lib/client.js',
    pkg.exports !== undefined && pkg.exports['./client'] === './lib/client.js', String(pkg.exports && pkg.exports['./client']))
  ok('客户端半身：仍保留 exports["."]（否则 Host 半身解析断掉）',
    pkg.exports !== undefined && pkg.exports['.'] === './lib/index.js', String(pkg.exports && pkg.exports['.']))
  ok('客户端半身：dsh.client.platform === "web"',
    pkg.dsh !== undefined && pkg.dsh.client !== undefined && pkg.dsh.client.platform === 'web',
    JSON.stringify(pkg.dsh))
  ok('客户端半身：bundle 用包名自注册（id 必须与包名一致）',
    /__ModuleLoader__\.load\(\{[\s\S]{0,80}?id:\s*["']dsh-auto-approval["']/.test(clientSrc))
  ok('客户端半身：只 require seed 模块（primitives）',
    /require\(["']@deepseek-ai\/dsh-client-ui-primitives["']\)/.test(clientSrc)
    && !/require\(["'](?!@deepseek-ai\/dsh-client-ui-primitives|react)/.test(clientSrc))
}

console.log(`\nAPPLY SELF TEST: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
