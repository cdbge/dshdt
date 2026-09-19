// dsh-auto-approval — 审批瀑布的前置裁决：低风险自动放行（allowed-once），其余交回用户。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// schema 库必须是 schemastery（settings.resolve() 会把 schema 当函数调用）；用动态导入 + 注入口，
// 因为仓库包目录解析不到它（自检注入），生产态由宿主 vendor 树提供。
let injectedSchemaLib = null
/** 仅供 test/ 注入 schema 库。 */
export function __injectSchemaLib(lib) { injectedSchemaLib = lib }
async function loadSchemaLib() {
  if (injectedSchemaLib !== null) return injectedSchemaLib
  try { return (await import('@deepseek-ai/schemastery')).default } catch { return null }
}

export const name = 'dsh-auto-approval'
// 硬依赖：approval 是挂载点，settings 提供配置；用 inject 声明让 Cordis 等服务就绪后再 apply。
export const inject = ['approval', 'settings']

/** 默认高风险关键词：命中即"必问用户"。可用 settings 整体替换。 */
const DEFAULT_HIGH_RISK = [
  'danger-full-access', 'full-access', 'no-sandbox', 'bypass',
  'sudo', 'runas', 'takeown', 'icacls', 'cacls', 'attrib', 'set-executionpolicy',
  'registry', 'reg add', 'reg delete', 'hklm', 'hkcu', 'schtasks', 'sc create', 'sc delete',
  'bcdedit', 'diskpart', 'format ', 'chkdsk', 'shutdown', 'restart-computer', 'stop-computer',
  'net user', 'net localgroup', 'new-localuser', 'add-localgroupmember',
  'taskkill', 'stop-process', 'stop-service', 'remove-item -recurse',
  'c:\\windows', 'c:\\program files', 'appdata\\roaming', 'system32',
  'rm -rf /', 'chmod 777', 'chown', 'mkfs', 'dd if=',
  'curl |', 'curl -s |', 'iwr |', 'invoke-expression', 'iex(', 'powershell -enc',
  'npm i -g', 'npm install -g', 'pnpm add -g', 'winget install', 'choco install', 'pip install --user',
  'git push', 'gh release', 'docker', 'wsl', 'ssh ', 'scp ', 'robocopy',
  '工作区外', '沙箱外', '提权', '管理员'
]
/** 默认低风险工具白名单：这些工具即便需要审批也视为低风险（纯读/信息查询类）。 */
const DEFAULT_LOW_RISK_TOOLS = [
  'read', 'read_image', 'grep', 'glob', 'web_search',
  'todo_write', 'list_agents', 'job_list', 'get_goal', 'skill',
  'ask_user_question', 'check-dsh-env'
]
/** 默认必问工具：命中即跳过自动放行（即便另两条规则说低风险）。 */
const DEFAULT_ALWAYS_ASK_TOOLS = ['cordis_run', 'cordis_define', 'ralph', 'workflow']

/** 默认配置。settings 运行时用同一组默认值。 */
const DEFAULTS = {
  enabled: true,
  autoApproveUpTo: 'medium',
  highRiskPatterns: DEFAULT_HIGH_RISK,
  lowRiskTools: DEFAULT_LOW_RISK_TOOLS,
  alwaysAskTools: DEFAULT_ALWAYS_ASK_TOOLS,
  logFile: '',
  logDecisions: true,
  // 审查走本体配置（agent-default-model + 统一 Key），插件不接触 provider/model/apiKey。
  reviewerEnabled: true,
  reviewTimeoutMs: 12000,
  // 必须大于推理阶段的长度：额度被推理吃满时 content 是空串。
  reviewMaxTokens: 1200,
}

/** settings 命名空间 schema（枚举用 z.union —— schemastery 没有 z.enum）。 */
function buildSettingsSchema(z) {
  return z.object({
    enabled: z.boolean().default(true),
    /** 自动放行上限：low 只放白名单；medium 另放"有明确 reason 且未命中高风险词"的请求；没有 high 档。 */
    autoApproveUpTo: z.union(['low', 'medium']).default('medium'),
    /** 命中任一关键词即判高风险（大小写不敏感）。整体替换默认表。 */
    highRiskPatterns: z.array(z.string()).default([...DEFAULT_HIGH_RISK]),
    lowRiskTools: z.array(z.string()).default([...DEFAULT_LOW_RISK_TOOLS]),
    alwaysAskTools: z.array(z.string()).default([...DEFAULT_ALWAYS_ASK_TOOLS]),
    /** 决策日志路径（默认 $DSH_HOME/logs/auto-approval.log）。 */
    logFile: z.string().default(''),
    logDecisions: z.boolean().default(true),
    /** 独立模型审查开关：关掉后除低风险白名单快路外一律问用户（不发起模型调用）。 */
    reviewerEnabled: z.boolean().default(true),
    reviewTimeoutMs: z.number().default(12000),
    reviewMaxTokens: z.number().default(1200),
  })
}

function homeDir() {
  const env = process.env.DSH_HOME
  return env && env.trim() !== '' ? env : path.join(os.homedir(), '.dsh')
}

/** v1 规则分级器（纯函数）：**已不参与裁决**，只作审计信号写入决策日志。 */
export function gradeRequest(req, cfg) {
  const tool = String(req && req.toolName ? req.toolName : '')
  const reason = String(req && req.reason ? req.reason : '')
  const lowReason = reason.toLowerCase()
  const patterns = Array.isArray(cfg.highRiskPatterns) && cfg.highRiskPatterns.length ? cfg.highRiskPatterns : DEFAULT_HIGH_RISK
  const alwaysAsk = new Set(cfg.alwaysAskTools || [])
  const lowTools = new Set(cfg.lowRiskTools || [])
  if (alwaysAsk.has(tool)) return { grade: 'high', why: `工具 ${tool} 在 alwaysAskTools` }
  if (reason === '') {
    return { grade: 'high', why: '请求未带 reason，无法判定动作，按高风险处理' }
  }
  const hit = patterns.find((p) => p && lowReason.includes(String(p).toLowerCase()))
  if (hit) return { grade: 'high', why: `reason 命中高风险关键词「${hit}」` }
  if (lowTools.has(tool)) return { grade: 'low', why: `工具 ${tool} 在 lowRiskTools` }
  return { grade: 'medium', why: 'reason 明确且未命中高风险关键词（有界操作）' }
}

/** 审查器系统提示：判据写死在这里，改它就是改这个功能的判据。 */
const REVIEW_SYSTEM = [
  '你是一个权限审查器，服务于一个正在用户机器上自主工作的编码智能体。',
  '智能体正在请求"越过当前沙箱边界"的权限。你要独立判断：**直接放行**，还是**交回用户确认**。',
  '',
  '判为 allow（直接放行）—— 以下条件要同时成立：',
  '· 动作**有界**：影响范围限于工作区、临时目录，或一个明确的目标；',
  '· **可逆**或代价可控：能回滚，或只是读取 / 查询 / 构建 / 测试；',
  '· 与当前开发任务**直接相关**：是这个任务正常的一部分。',
  '',
  '判为 ask（交回用户）—— 命中任一条即 ask：',
  '· 提权或改系统：管理员权限、注册表、服务、计划任务、账号、磁盘分区；',
  '· 触碰系统或他人数据：系统目录、Program Files、其他用户目录、凭据与密钥；',
  '· **不可逆**破坏：递归删除、格式化、清空、无备份覆盖；',
  '· 外联并执行：下载后直接执行、管道进 shell、远程脚本；',
  '· 意图不明或信息不足：说不清要做什么，或理由与工具不匹配。',
  '',
  '输入里的 `reason` 是**智能体自己写的说明**，可能与它真正要做的事不符（实测见过"理由与动作不匹配"）；',
  '`command` 才是这次调用**真实的参数**（例如 pwsh 的完整命令行；没有它就说明拿不到）。',
  '**以 `command` 为准**：reason 只是佐证，command 与 reason 冲突时按 command 判，并倾向于 ask。',
  '',
  '**拿不准就 ask。** 宁可多问一次，也不要放行一次不可逆的破坏。',
  '只输出一行 JSON，不要任何其他文字：{"verdict":"allow"|"ask","why":"不超过30字的中文理由"}',
].join('\n')

/** 纯函数：规则前置。只产出「硬拦」与「证据」，最终裁决不在这里。 */
export function prefilter(req, cfg) {
  const tool = String(req && req.toolName ? req.toolName : '')
  const reason = String(req && req.reason ? req.reason : '')
  const lowReason = reason.toLowerCase()
  const patterns = Array.isArray(cfg.highRiskPatterns) && cfg.highRiskPatterns.length ? cfg.highRiskPatterns : DEFAULT_HIGH_RISK
  const alwaysAsk = new Set(cfg.alwaysAskTools || [])
  const lowTools = new Set(cfg.lowRiskTools || [])
  const hits = patterns.filter((p) => p && lowReason.includes(String(p).toLowerCase())).map(String)
  if (alwaysAsk.has(tool)) return { route: 'ask', hits, why: `工具 ${tool} 在 alwaysAskTools（不交模型）` }
  if (reason === '') return { route: 'ask', hits, why: '请求未带 reason，无法判定动作' }
  if (lowTools.has(tool) && hits.length === 0) return { route: 'allow', hits, why: `工具 ${tool} 在 lowRiskTools 且未命中风险词` }
  return {
    route: 'review', hits,
    why: hits.length ? `预筛命中「${hits.slice(0, 3).join(' / ')}」，交模型审查` : '预筛无命中，交模型审查',
  }
}

// callId → 工具调用参数：审批请求里没有 args，由 tools/pre-execute 记下、审批时按 callId 取回。
const RECENT_CALL_LIMIT = 20
const recentCalls = new Map()   // callId(string) -> { name, args }

/** 记住一次待执行的调用；只保留最近 N 条，避免无界增长。 */
function rememberCall(exec) {
  try {
    const id = exec && exec.callId
    if (id === undefined || id === null) return
    recentCalls.set(String(id), { name: String(exec.name || ''), args: exec.arguments })
    while (recentCalls.size > RECENT_CALL_LIMIT) {
      const oldest = recentCalls.keys().next().value
      recentCalls.delete(oldest)
    }
  } catch { /* 记不下来不影响审批本身 */ }
}

/** 纯函数：把参数压成一段有上限的可读文本（喂给审查器/审计日志）。 */
export function summarizeArgs(args, limit = 1200) {
  if (args === undefined) return ''
  let text
  try { text = typeof args === 'string' ? args : JSON.stringify(args) } catch { return '(参数无法序列化)' }
  if (text === undefined || text === null) return ''
  return text.length > limit ? `${text.slice(0, limit)}…（已截断，共 ${text.length} 字）` : text
}

/** 纯函数：把请求打包成审查输入（用 JSON 包住，免得用户内容伪造结构）。 */
export function buildReviewPrompt(req, hits, command) {
  return '请审查这次权限请求：\n' + JSON.stringify({
    tool: String(req && req.toolName ? req.toolName : ''),
    reason: String(req && req.reason ? req.reason : ''),
    matchedRiskKeywords: hits,
    // 取不到命令时显式写明，免得模型把它当成"命令为空"而误判
    command: typeof command === 'string' && command !== '' ? command : '(未取到该次调用的参数)',
  })
}

/** 纯函数：扫平衡花括号取出裁决 JSON 那一段（取最后一个含 verdict 且能解析的对象）。 */
export function pickVerdictText(raw) {
  const text = String(raw == null ? '' : raw).replace(/```[a-zA-Z]*\n?/g, '')
  const candidates = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') {
      if (depth === 0) start = i
      depth += 1
      continue
    }
    if (ch === '}') {
      if (depth > 0) {
        depth -= 1
        if (depth === 0 && start >= 0) candidates.push(text.slice(start, i + 1))
      }
      continue
    }
  }
  if (candidates.length === 0) return ''
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(candidates[i])
      if (obj !== null && typeof obj === 'object' && !Array.isArray(obj) && typeof obj.verdict === 'string') return candidates[i]
    } catch { /* 试前一段 */ }
  }
  return candidates[candidates.length - 1]
}

/** 纯函数：解析审查模型的输出。**任何不符合预期都归为 ask**（fail-closed）。 */
export function parseVerdict(raw) {
  const text = String(raw == null ? '' : raw)
  if (text.trim() === '') return { verdict: 'ask', why: '审查模型返回空内容（通常是 maxTokens 被推理阶段用满）' }
  const picked = pickVerdictText(text)
  if (picked === '') return { verdict: 'ask', why: `审查模型未输出可解析的 JSON（原文 ${text.length} 字）` }
  try {
    const obj = JSON.parse(picked)
    const v = String(obj && obj.verdict ? obj.verdict : '').toLowerCase()
    const why = String(obj && obj.why ? obj.why : '').slice(0, 60)
    if (v === 'allow') return { verdict: 'allow', why: why || '模型判为放行' }
    if (v === 'ask') return { verdict: 'ask', why: why || '模型判为需用户确认' }
    return { verdict: 'ask', why: `审查模型给出未知裁决「${v}」` }
  } catch (e) {
    return { verdict: 'ask', why: `审查模型输出解析失败：${e && e.message}` }
  }
}

// dsh-llm 的辅助函数（BlockAssembler / createUserMessage）：同样在仓库包目录解析不到，故动态导入 + 兜底。
let llmHelpers = null
async function loadLlmHelpers() {
  if (llmHelpers !== null) return llmHelpers
  try {
    const m = await import('@deepseek-ai/dsh-llm')
    llmHelpers = { BlockAssembler: m.BlockAssembler, createUserMessage: m.createUserMessage }
  } catch {
    llmHelpers = { BlockAssembler: null, createUserMessage: null }
  }
  return llmHelpers
}

/** 审查器注入口：仅供 test/ 注入假模型。 */
let reviewerOverride = null
export function __injectReviewer(fn) { reviewerOverride = fn }

/**
 * 真实审查：一次独立的模型调用（路由走本体配置 agentDefaultModel，凭据走 ctx.llm）。
 * 任何失败都返回 ask：没有 llm 服务 / 未配默认模型 / 超时 / 抛错 / 输出不可解析。
 */
async function reviewWithLlm(ctx, req, cfg, hits, command, signal) {
  let route = null
  try {
    const sel = ctx.get('agentDefaultModel')?.currentSelection()
    if (sel && sel.provider && sel.model) route = { provider: sel.provider, model: sel.model }
  } catch { /* 视为没配 */ }
  if (route === null) return { verdict: 'ask', why: '本体未配置默认模型，无法审查' }
  const llm = ctx.get('llm')
  if (llm === undefined) return { verdict: 'ask', why: 'llm 服务不可用，无法审查' }
  const { BlockAssembler, createUserMessage } = await loadLlmHelpers()
  if (BlockAssembler === null || createUserMessage === null) {
    return { verdict: 'ask', why: 'dsh-llm 辅助模块解析不到' }
  }
  const timeoutMs = Number(cfg.reviewTimeoutMs) > 0 ? Number(cfg.reviewTimeoutMs) : 8000
  const timeout = AbortSignal.timeout(timeoutMs)
  const merged = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const options = {
    provider: route.provider,
    model: route.model,
    system: REVIEW_SYSTEM,
    messages: [createUserMessage({
      content: [{ type: 'text', text: buildReviewPrompt(req, hits, command) }],
      source: { kind: 'plugin', plugin: 'dsh-auto-approval' },
    })],
    maxTokens: Number(cfg.reviewMaxTokens) > 0 ? Number(cfg.reviewMaxTokens) : 200,
    purpose: 'auto-approval-review',
    signal: merged,
  }
  const assembler = new BlockAssembler()
  for await (const chunk of llm.stream(options)) assembler.push(chunk)
  // 只取 text 块：推理块不计入裁决文本（额度不够时 content 为空）。
  const text = assembler.blocks().filter((b) => b.type === 'text').map((b) => b.text).join('')
  const parsed = parseVerdict(text)
  return { ...parsed, model: `${route.provider}/${route.model}` }
}

export async function apply(ctx) {
  const log = (...a) => { try { process.stderr.write(`[dsh-auto-approval] ${a.join(' ')}\n`) } catch { /* 忽略 */ } }
  const settings = ctx.get('settings')
  // 注册结果分「服务未就绪 / schema 库缺失 / register 抛错 / ok」四种情况分别记，便于定位。
  let scope = null
  let scopeWhy = 'settings 服务未就绪'
  const cfgNow = () => {
    const base = { ...DEFAULTS }
    if (scope === undefined || scope === null) return base
    try { return { ...base, ...(scope.value || {}) } } catch { return base }
  }

  const decisions = []   // 最近若干条决策（供 /approval why 查看）
  const logPath = () => {
    const cfg = cfgNow()
    return cfg.logFile && cfg.logFile.trim() !== '' ? cfg.logFile : path.join(homeDir(), 'logs', 'auto-approval.log')
  }
  // 写入失败只报一次：写不进去不该影响审批，也不能静默失效。
  let logFailureReported = false
  const record = (entry) => {
    decisions.unshift(entry)
    if (decisions.length > 50) decisions.pop()
    if (!cfgNow().logDecisions) return
    try {
      const p = logPath()
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.appendFileSync(p, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`)
    } catch (e) {
      if (!logFailureReported) {
        logFailureReported = true
        log(`决策日志写入失败（同类失败不再重复报，仅影响审计不影响审批）：${e && e.message}`)
      }
    }
  }

  // 审批瀑布前置裁决：返回 'allowed-once' = 自动放行；return next() = 落到既有 answerer。
  // 必须在**任何 await 之前**注册（注册时机决定 effect 落在哪个 fiber/作用域），且必须是
  // { global: true, prepend: true }：global 绕过 dsh-scope 的作用域过滤（瀑布按 agent 作用域派发），
  // prepend 抢在 DSH 的审批桥之前——桥注册得更早，且拿到答复就终止整条链（不调 next()）。
  ctx.on('approval/request', async (req, next) => {
    const cfg = cfgNow()
    if (!cfg.enabled) {
      record({ tool: req && req.toolName, action: 'pass-through', why: '插件已关闭（enabled=false）' })
      return next()
    }
    const pre = prefilter(req, cfg)
    const tool = req && req.toolName
    // 取这次调用的真实参数（tools/pre-execute 时按 callId 记下的）；取不到就是空串。
    const callIdKey = req && req.callId !== undefined && req.callId !== null ? String(req.callId) : ''
    const called = callIdKey !== '' ? recentCalls.get(callIdKey) : undefined
    const command = summarizeArgs(called && called.args, 1200)
    const common = {
      tool, callId: req && req.callId, reason: req && req.reason, hits: pre.hits,
      pre: pre.route, preWhy: pre.why, ruleGrade: gradeRequest(req, cfg).grade,
      cmd: summarizeArgs(called && called.args, 300),
    }

    if (pre.route === 'allow') {
      record({ ...common, action: 'auto-allowed', source: 'rule' })
      log(`自动放行 ${tool}（规则快路）：${pre.why}`)
      return 'allowed-once'
    }
    if (pre.route === 'ask') {
      record({ ...common, action: 'asked-user', source: 'rule' })
      return next()
    }
    if (cfg.reviewerEnabled === false || cfg.autoApproveUpTo === 'low') {
      record({ ...common, action: 'asked-user', source: 'reviewer-disabled' })
      return next()
    }
    let verdict
    try {
      verdict = reviewerOverride !== null
        ? await reviewerOverride(req, pre.hits, req && req.signal, command)
        : await reviewWithLlm(ctx, req, cfg, pre.hits, command, req && req.signal)
    } catch (e) {
      // 审查器抛错绝不能影响审批主流程：吞掉，按 ask 处理
      verdict = { verdict: 'ask', why: `审查器异常：${e && e.message}` }
    }
    const v = verdict && verdict.verdict === 'allow' ? 'allow' : 'ask'
    const why = String((verdict && verdict.why) || '')
    record({ ...common, action: v === 'allow' ? 'auto-allowed' : 'asked-user', source: 'model', verdict: v, model: verdict && verdict.model, verdictWhy: why })
    if (v !== 'allow') {
      log(`交回用户 ${tool}（模型审查）：${why}`)
      return next()
    }
    log(`自动放行 ${tool}（模型审查）：${why}`)
    return 'allowed-once'
  }, { global: true, prepend: true })

  // 记下每次调用的真实参数，供审批时按 callId 取回（tools/pre-execute 在沙箱提权之前触发）。
  // 同样要 global；只观察不裁决，故不 prepend。
  ctx.on('tools/pre-execute', (exec, next) => {
    rememberCall(exec)
    return next()
  }, { global: true })

  const z = await loadSchemaLib()
  if (settings === undefined) {
    scopeWhy = 'settings 服务不可用'
    log('settings 服务不可用：跳过命名空间注册（用默认配置）')
  } else if (z === null) {
    scopeWhy = 'schemastery 解析不到'
    log('schemastery 解析不到：设置命名空间无法注册，只能用默认配置。'
      + '这是**故障**而非降级——注册不上就意味着开关与规则表都改不了。')
  } else {
    try {
      scope = settings.register('auto-approval', buildSettingsSchema(z))
      scopeWhy = 'ok'
    } catch (e) {
      scopeWhy = `settings.register 抛错：${e && e.message}`
      log(`settings 注册失败，改用默认配置：${e && e.message}`)
    }
  }

  // ── /approval 命令：开关与审计 ─────────────────────────────────────────
  const commands = ctx.get('commands')
  if (commands !== undefined) {
    commands.register({
      name: 'approval',
      description: '自动审批开关与最近决策（低风险自动放行 / 高风险问用户）',
      input: { hint: '[on|off|status|why|rules]', images: false },
      handler: async (invocation) => {
        const arg = String(invocation && invocation.rawInput ? invocation.rawInput : '').trim().toLowerCase()
        const cfg = cfgNow()
        if (arg === 'on' || arg === 'off') {
          if (scope === null) return { kind: 'error', text: `设置命名空间未注册（${scopeWhy}），无法持久化开关` }
          try {
            await scope.update({ enabled: arg === 'on' })
            return { kind: 'success', text: `自动审批已${arg === 'on' ? '开启' : '关闭'}（auto-approval.enabled=${arg === 'on'}）` }
          } catch (e) { return { kind: 'error', text: `写入设置失败：${e && e.message}` } }
        }
        if (arg === 'rules') {
          return { kind: 'success', text: [
            `自动放行上限：${cfg.autoApproveUpTo}（high 永远问用户）`,
            `高风险关键词（${cfg.highRiskPatterns.length}）：${cfg.highRiskPatterns.slice(0, 12).join(' / ')} …`,
            `低风险工具：${cfg.lowRiskTools.join(', ')}`,
            `必问工具：${cfg.alwaysAskTools.join(', ')}`,
            `决策日志：${logPath()}`,
          ].join('\n') }
        }
        if (arg === 'why') {
          if (!decisions.length) return { kind: 'success', text: '本进程尚无审批决策记录。' }
          return { kind: 'success', text: decisions.slice(0, 8).map((d) => `${d.ts} ${d.action} ${d.tool || '?'} [${d.grade || '-'}] ${d.why || ''}${d.reason ? ` | reason=${String(d.reason).slice(0, 80)}` : ''}`).join('\n') }
        }
        return { kind: 'success', text: [
          `自动审批：${cfg.enabled ? '已开启' : '已关闭'}（/approval on|off）`,
          `自动放行上限：${cfg.autoApproveUpTo}；最近决策 ${decisions.length} 条（/approval why）`,
          `规则详情：/approval rules`,
        ].join('\n') }
      },
    })
  } else {
    log('commands 服务不可用：/approval 命令未注册（开关仍可通过 settings.yaml 的 auto-approval.enabled 修改）')
  }

  log(`已装载：enabled=${cfgNow().enabled} autoApproveUpTo=${cfgNow().autoApproveUpTo} 日志=${logPath()}`)
  record({ action: 'plugin-loaded', why: `settings=${scopeWhy} commands=${commands ? 'ok' : 'unavailable'}` })
}

export default { name, inject, apply }
