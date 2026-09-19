// dsh-auto-approval — AI 自检权限申请（Codex 式自动审批，Host 侧）
//
// 要解决的问题：DSH 的审批是"要么全问、要么全不问"（会话策略只有 ask / never）。
// 模型每次要越出沙箱（例如需要 danger-full-access、或写工作区外的路径）都会弹一次确认，
// 其中大部分是**可预期的低风险操作**（读一个外部文件、在临时目录里跑一条命令），
// 少数才是真正危险的（提权、改注册表、删系统盘、装全局软件）。人工逐条确认既慢又容易"手滑点允许"。
//
// 本插件在 harness 的审批瀑布里插一层**风险分级**：
//   · 低风险 → 直接返回 'allowed-once' 放行（模型看不到弹窗，用户也不需要点）
//   · 高风险 → 原样 next()，落到既有 answerer（也就是用户的确认弹窗）
// 关键设计取舍：
//   1) 只做"加法"：任何无法明确判为低风险的请求都走 next()，**失败方向永远是"问用户"**而不是放行。
//   2) 配置走 DSH 本体的 settings 命名空间 `auto-approval`（settings.yaml 可手改；带 schema 的命名空间
//      会被 harness 的设置面板渲染成表单项），因此"开关审批"是本体能力而不是本插件私有的配置面。
//   3) 每条决策都落 JSONL 日志（$DSH_HOME/logs/auto-approval.log），便于事后审计与用真实数据校准规则。
//   4) 生效范围是"一次授权"（allowed-once）——与 DSH 的语义一致，不做长期白名单。
//
// 与 DSH 原生机制的关系：不替换 approval/permissionPresets，只在 approval/request 瀑布上做前置裁决；
// 会话策略为 'never' 时 harness 自己就会拒（见 dsh-user-approval 的 NEVER_SENTENCE），本插件不介入。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ── schema 库：必须是 schemastery，不是 zod ─────────────────────────────────
// 踩过的坑（0.4.6 实测）：初版这里导入的是 **zod**，并把它建出来的对象交给
// settings.register。而 dsh-settings 的 resolve() 是**把 schema 当函数调用**：
//     resolve(schema, base, section) { const value = schema(mergeLayers(base, section)); ... }
// zod 的 schema 对象不可调用 → 注册当场抛 "schema is not a function" → 命名空间从未注册 →
// `/approval on|off` 永久报错、规则表改不了、设置面板里根本不出现，只能吃默认值。
// 官方插件一律 `import z from '@deepseek-ai/schemastery'`，本文件对齐它。
//
// 为什么用**动态导入 + 一个注入口**而不是官方那种静态 import：自检在**仓库包目录**里跑，
// 那里上面没有 node_modules、解析不到 schemastery（实测 NOT RESOLVABLE），静态 import 会让
// 整个自检跑不起来——而"注册能不能成功"恰恰是本插件最该被自检的一环。
// 生产态永远走下面的动态导入（宿主 vendor 树提供 schemastery，实测可解析）。
let injectedSchemaLib = null
/** 仅供 test/ 注入 schema 库（仓库里解析不到 schemastery）；生产代码不要调用。 */
export function __injectSchemaLib(lib) { injectedSchemaLib = lib }
async function loadSchemaLib() {
  if (injectedSchemaLib !== null) return injectedSchemaLib
  try { return (await import('@deepseek-ai/schemastery')).default } catch { return null }
}

export const name = 'dsh-auto-approval'
// 硬依赖：approval（本插件的挂载点）与 settings（配置走本体）。
// 用 inject 声明而不是 ctx.get()：Cordis 会等这些服务就绪后再 apply，
// 否则 apply 可能早于 settings 注册（实测过：settings=unavailable，配置就落不到 settings.yaml）。
export const inject = ['approval', 'settings']

/** 默认高风险关键词：命中即"必问用户"。可用 settings 覆盖（整体替换）。 */
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

/** 默认配置（不依赖 zod；zod 不可用时也用这一份）。settings 运行时用同一组默认值。 */
const DEFAULTS = {
  enabled: true,
  autoApproveUpTo: 'medium',
  highRiskPatterns: DEFAULT_HIGH_RISK,
  lowRiskTools: DEFAULT_LOW_RISK_TOOLS,
  alwaysAskTools: DEFAULT_ALWAYS_ASK_TOOLS,
  logFile: '',
  logDecisions: true,
  // ↓ 决策层 v2：独立模型审查。**没有 provider/model/apiKey** —— 走本体配置与统一 Key。
  reviewerEnabled: true,
  // reviewTimeoutMs 要覆盖"推理 + 出结论"两个字阶段：实测本机 200/800/1200 三档都在 130ms 内返回，
  // 12s 是留给"换到更慢的模型/网络抖动"的余量（超时只意味着问用户一次，不会误放行）。
  reviewTimeoutMs: 12000,
  // reviewMaxTokens 必须**大于推理阶段的长度** —— 见 parseVerdict 上方那段注释（2026-09-17 的实证原因）。
  reviewMaxTokens: 1200,
}

/**
 * settings 命名空间 schema。**必须是 schemastery**（由 apply() 在运行时用加载到的 z 构造，
 * 不能放模块顶层——schema 库是动态导入的）。
 * 注意两处 API 与 zod **不同**（初版照 zod 写的，都是坑）：
 *   · 枚举：schemastery 是 `z.union([...])`，没有 `z.enum()`；
 *   · 默认值：`.default(x)` 两边一致，但 schemastery 的解析入口是 `schema(值)`。
 */
function buildSettingsSchema(z) {
  return z.object({
    /** 总开关：关掉后本插件完全不介入，一切照 DSH 原生流程问用户。 */
    enabled: z.boolean().default(true),
    /**
     * 自动放行的等级上限：
     *  low    —— 只有明确白名单里的低风险工具自动放行（最保守）
     *  medium —— 另外放行"带明确 reason、且不含高风险关键词"的请求（≈ Codex 的 auto：放行有界的越界操作）
     *  high 永远问用户（不存在可设的 high 档）。
     */
    autoApproveUpTo: z.union(['low', 'medium']).default('medium'),
    /** 命中任一关键词即判高风险（大小写不敏感）。整体替换默认表。 */
    highRiskPatterns: z.array(z.string()).default([...DEFAULT_HIGH_RISK]),
    lowRiskTools: z.array(z.string()).default([...DEFAULT_LOW_RISK_TOOLS]),
    alwaysAskTools: z.array(z.string()).default([...DEFAULT_ALWAYS_ASK_TOOLS]),
    /** 决策日志路径（默认 $DSH_HOME/logs/auto-approval.log）。 */
    logFile: z.string().default(''),
    logDecisions: z.boolean().default(true),
    /**
     * 独立模型审查开关。关掉后，除低风险白名单快路外一律问用户（不发起模型调用）。
     * **注意这里没有 provider/model/apiKey**：审查走本体配置（agent-default-model）与统一 Key。
     */
    reviewerEnabled: z.boolean().default(true),
    /** 单次审查的超时（毫秒）。超时即按 ask 处理（fail-closed）。 */
    reviewTimeoutMs: z.number().default(12000),
    /**
     * 审查调用的 maxTokens。**必须大于模型推理阶段的长度**：
     * 官方 `deepseek-flash` 是**推理模型**，同一个上限同时装着"思考"和"结论"，
     * 思考吃满额度时 `content` 直接是空串、`finish_reason=length`（2026-09-17 实测：
     * 上限 200 时 reasoning_tokens 正好 200、content 空 ⇒ 每次审查都回落成"问用户"）。
     * 1200 实测可在同一个响应里给出完整 JSON（reasoning ≈655 + content ≈60）。
     */
    reviewMaxTokens: z.number().default(1200),
  })
}

function homeDir() {
  const env = process.env.DSH_HOME
  return env && env.trim() !== '' ? env : path.join(os.homedir(), '.dsh')
}

/**
 * v1 的规则分级器（纯函数）。
 * **它已经不再参与裁决** —— 裁决在 `prefilter`（硬拦 + 快路）+ 独立模型审查。
 * 保留它的两个理由：① 它的 `grade` 仍作为**审计信号**记进决策日志，方便事后对比
 * "规则怎么想 / 模型怎么判"；② `grade-self-test.mjs` 覆盖它。
 */
export function gradeRequest(req, cfg) {
  const tool = String(req && req.toolName ? req.toolName : '')
  const reason = String(req && req.reason ? req.reason : '')
  const lowReason = reason.toLowerCase()
  const patterns = Array.isArray(cfg.highRiskPatterns) && cfg.highRiskPatterns.length ? cfg.highRiskPatterns : DEFAULT_HIGH_RISK
  const alwaysAsk = new Set(cfg.alwaysAskTools || [])
  const lowTools = new Set(cfg.lowRiskTools || [])
  if (alwaysAsk.has(tool)) return { grade: 'high', why: `工具 ${tool} 在 alwaysAskTools` }
  if (reason === '') {
    // 没有 reason = 不知道要做什么 → 不猜，直接交给用户（失败方向永远是"问用户"）
    return { grade: 'high', why: '请求未带 reason，无法判定动作，按高风险处理' }
  }
  const hit = patterns.find((p) => p && lowReason.includes(String(p).toLowerCase()))
  if (hit) return { grade: 'high', why: `reason 命中高风险关键词「${hit}」` }
  if (lowTools.has(tool)) return { grade: 'low', why: `工具 ${tool} 在 lowRiskTools` }
  return { grade: 'medium', why: 'reason 明确且未命中高风险关键词（有界操作）' }
}

// ── 决策层 v2：**独立模型审查**取代关键词裁决 ────────────────────────────────
// 为什么必须改：v1 是 17 行字符串匹配，它分不出这两种情况的区别 ——
//   Remove-Item -Recurse -Force   在 workspace 内 → 正常开发，该放
//   Remove-Item -Recurse -Force   在 C:\Windows 下 → 灾难，该拦
// 两者命中的是**同一个词**。所以关键词表**降级为"证据"**（命中了什么，原样喂给审查模型），
// 最终裁决交给一次**独立的模型调用**：全新上下文、只做一件事 —— 判该不该放。
//
// 模型从哪来：**走本体配置**。路由取自 `agentDefaultModel.currentSelection()`（也就是
// settings.yaml 的 `agent-default-model` 段），凭据由 `ctx.llm` 用**本体的统一 Key**。
// 插件**不配置、也不接触** provider / model / apiKey —— 换句话说，本体换模型换 Key，
// 这里自动跟着换。

/** 审查器系统提示。判据写死在这里，改它就是改这个功能的"人格"。 */
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

/**
 * 纯函数：规则**前置**。只产出「硬拦」与「证据」，**不再由它做最终裁决**。
 * @returns {{route:'allow'|'ask'|'review', hits:string[], why:string}}
 */
export function prefilter(req, cfg) {
  const tool = String(req && req.toolName ? req.toolName : '')
  const reason = String(req && req.reason ? req.reason : '')
  const lowReason = reason.toLowerCase()
  const patterns = Array.isArray(cfg.highRiskPatterns) && cfg.highRiskPatterns.length ? cfg.highRiskPatterns : DEFAULT_HIGH_RISK
  const alwaysAsk = new Set(cfg.alwaysAskTools || [])
  const lowTools = new Set(cfg.lowRiskTools || [])
  const hits = patterns.filter((p) => p && lowReason.includes(String(p).toLowerCase())).map(String)
  // ① 硬拦（这两类永远不给模型放行权）
  if (alwaysAsk.has(tool)) return { route: 'ask', hits, why: `工具 ${tool} 在 alwaysAskTools（不交模型）` }
  if (reason === '') return { route: 'ask', hits, why: '请求未带 reason，无法判定动作' }
  // ② 快路：白名单工具且没有任何风险词 → 直接放行，不花一次模型调用
  if (lowTools.has(tool) && hits.length === 0) return { route: 'allow', hits, why: `工具 ${tool} 在 lowRiskTools 且未命中风险词` }
  // ③ 其余交模型审查 —— 命中词只作为**证据**，不再直接判死
  return {
    route: 'review', hits,
    why: hits.length ? `预筛命中「${hits.slice(0, 3).join(' / ')}」，交模型审查` : '预筛无命中，交模型审查',
  }
}

// ── callId → 工具调用参数：让审查器看到"实际命令"，而不是只看理由 ──────────────
// 审批请求里只有 `{toolName, reason, callId}`，**没有 args** —— 于是审查器此前只能"读理由"，
// 而实测证明那正是最容易被误导的地方（模型自己抱怨过"理由与动作不匹配"）。
// 好在 `tools/pre-execute` 的 exec 带着 `arguments`（见 ToolExecutionInput 声明），
// 而它在沙箱提权**之前**触发 —— 所以在那里记一张小表，审批时按 callId 取回来即可。
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

/** 纯函数：把请求打包成一次干净的审查输入（用 JSON 包住，免得用户内容伪造结构）。 */
export function buildReviewPrompt(req, hits, command) {
  return '请审查这次权限请求：\n' + JSON.stringify({
    tool: String(req && req.toolName ? req.toolName : ''),
    reason: String(req && req.reason ? req.reason : ''),
    matchedRiskKeywords: hits,
    // command 是**真实参数**；拿不到时显式写明，免得模型把它当成"命令为空"而误判
    command: typeof command === 'string' && command !== '' ? command : '(未取到该次调用的参数)',
  })
}

/**
 * 纯函数：从模型输出里挑出"裁决 JSON 那一段"。
 *
 * 做法是**扫平衡花括号**（不是 `\{[\s\S]*\}` 那种贪婪匹配）：贪婪匹配在
 * "推理里出现过 `{...}` 示例、末尾才是结论"这种输出上会跨段拼接，整段变成非法 JSON。
 * 剥掉 ``` 围栏后再扫；候选里优先取**最后一个含 `verdict` 字段且能解析**的对象
 * （模型习惯把结论放在最后）。
 */
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
    // 花括号之外出现换行不算错：模型可能把 JSON 折行输出
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
  // ① 空输出：不说"没输出可解析的 JSON"，直接说长度 —— 这是"额度被推理吃满"的现场特征。
  //    （模型的 reasoning 不计入 content；上限不够时 content 就是空串、finish_reason=length。）
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

// dsh-llm 的辅助函数（BlockAssembler / createUserMessage）。与 schemastery 同理：
// 仓库包目录解析不到（它在 vendor 树里），所以动态导入 + 兜底，并留一个测试注入口。
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

// 审查器的**注入点**：仅供 test/ 注入一个假模型（自检要脱网、且仓库里没有 dsh-llm）。
// 生产路径永远走下面的真实调用。
let reviewerOverride = null
/** 仅供 test/ 注入审查器；生产代码不要调用。 */
export function __injectReviewer(fn) { reviewerOverride = fn }

/**
 * 真实审查：**一次独立的模型调用**。
 * 路由走本体配置（agentDefaultModel），凭据走 ctx.llm 的统一 Key。
 * **任何失败都返回 ask**：没有 llm 服务 / 本体没配默认模型 / 超时 / 抛错 / 输出不可解析。
 * @returns {Promise<{verdict:'allow'|'ask', why:string, model?:string}>}
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
  // 只取 text 块：推理块（如果有）不计入裁决文本，正是"额度不够时 content 为空"的成因。
  const text = assembler.blocks().filter((b) => b.type === 'text').map((b) => b.text).join('')
  const parsed = parseVerdict(text)
  return { ...parsed, model: `${route.provider}/${route.model}` }
}

export async function apply(ctx) {
  const log = (...a) => { try { process.stderr.write(`[dsh-auto-approval] ${a.join(' ')}\n`) } catch { /* 忽略 */ } }
  const settings = ctx.get('settings')
  // 注册结果**分四种情况分别记**，不能笼统写成一个 scope 真假值。
  // 初版就是这么写的：实机明明是 schema 用错（把 zod 当 schemastery），日志却报成
  // `settings=unavailable`，看着像"服务没装"，把排查带偏了一整轮。
  // 这类"一个标志位兼表多种失败原因"的写法，（null 兼表未初始化与无约束）同源。
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
  // 日志写入失败**只报一次**：写不进去不该影响审批（这是主次），
  // 但绝不能一声不吭——否则"决策可审计"这件事会静默失效。
  // 本轮实测踩到：受限沙箱下 append 被拒（Access denied），而初版的 catch 是空的，
  // 一连 77 条日志里都看不出这个失败。
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

  // ── 核心：审批瀑布前置裁决 ─────────────────────────────────────────────
  // 返回 'allowed-once' = 自动放行；return next() = 落到既有 answerer
  //
  // 【为什么这段必须在**任何 await 之前**】
  // 本插件曾把设置注册放在前面（`await loadSchemaLib()`），监听挂在 await 之后。
  // 那是个真问题（注册时机决定 effect 落在哪个 fiber/作用域），所以要保持在同步段。
  //
  // 【但只有同步段还不够——必须显式 { global: true }】
  // 实测：同步段注册之后，审批请求**依然收不到**（提权成功、插件零记录）。
  // 把 Cordis 的派发读透才看清机制：
  //   dispatch():  (this._hooks[name] || [])
  //                  .filter((hook) => hook.global || !filter || filter.call(thisArg, hook.ctx))
  // 监听是**先全局收集、再按作用域过滤**；而审批瀑布按 **agent 作用域**派发
  // （`waterfall(scopeTarget(req.agent, req.agent), …)`）。`dsh-scope` 的 scopeTarget 写着：
  //   未打标签的监听器 → 全局接受；打了标签的 → 只有标签等于派发键**或其祖先**才接受，
  //   **标签落在派发键之下的被排除**（"事件只向上流，不向下"）。
  // 我们的注册落不进那条链，于是显式声明 global —— 它**短路整个过滤**，
  // 正是"一个常驻组合要观察它下面每个 agent"该用的开关（Cordis 自己在 internal/update 上就用它）。
  ctx.on('approval/request', async (req, next) => {
    const cfg = cfgNow()
    if (!cfg.enabled) {
      record({ tool: req && req.toolName, action: 'pass-through', why: '插件已关闭（enabled=false）' })
      return next()
    }
    const pre = prefilter(req, cfg)
    const tool = req && req.toolName
    // 取这次调用的**真实参数**（tools/pre-execute 时记下的）。取不到就是空串，
    // buildReviewPrompt 会显式写"(未取到该次调用的参数)"，免得模型误以为命令为空。
    const callIdKey = req && req.callId !== undefined && req.callId !== null ? String(req.callId) : ''
    const called = callIdKey !== '' ? recentCalls.get(callIdKey) : undefined
    const command = summarizeArgs(called && called.args, 1200)
    const common = {
      tool, callId: req && req.callId, reason: req && req.reason, hits: pre.hits,
      pre: pre.route, preWhy: pre.why, ruleGrade: gradeRequest(req, cfg).grade,
      // 审计里也留一段命令预览：事后能直接看出"规则看到的理由"与"实际要跑的命令"是否一致
      cmd: summarizeArgs(called && called.args, 300),
    }

    // ① 快路：白名单工具直接放行（不花模型调用）
    if (pre.route === 'allow') {
      record({ ...common, action: 'auto-allowed', source: 'rule' })
      log(`自动放行 ${tool}（规则快路）：${pre.why}`)
      return 'allowed-once'
    }
    // ② 硬拦：alwaysAskTools / 无 reason —— 永远不给模型放行权
    if (pre.route === 'ask') {
      record({ ...common, action: 'asked-user', source: 'rule' })
      return next()
    }
    // ③ 交独立模型审查。审查器被关掉、或审查失败 → 一律问用户（fail-closed）。
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
    // ── 两个选项都是必需的，缺一不可（0.4.6 实测）────────────────
    // · prepend：**这条才是关键**。审批瀑布按**注册顺序**执行（`waterfall()` 里是 `cbs.shift()`），
    //   而 DSH 自己的桥（`dsh-api-remotes`）注册得早、而且**它不调 `next()`** ——
    //   它把请求转发给浏览器、拿回用户的点击结果就**终止整条链**。
    //   所以注册在桥之后的监听**永远不会被执行**：插件静默失效，用户照旧看到卡片、照旧手点。
    //   prepend 把本监听插到表头，抢在桥之前拿到请求。
    // · global：绕过 `dsh-scope` 的**作用域过滤**（`dispatch` 里的 hook.global 短路）。
    //   两个维度不同：prepend 管**顺序**，global 管**作用域**。
  }, { global: true, prepend: true })

  // 记下每次调用的**真实参数**，供审批时按 callId 取回（见 recentCalls 的注释）。
  // 事件契约：`tools/pre-execute(exec: ToolExecution, next)`，exec 带 `callId` / `name` / `arguments`，
  // 且它在沙箱提权**之前**触发 —— 所以审批请求到达时这张表里已经有了。
  // 同样要 `global`（作用域过滤）；**不需要 prepend** —— 本监听只观察、不裁决，
  // 排在谁后面都行（一旦有人在更前面 deny，我们多记一条也无害）。
  ctx.on('tools/pre-execute', (exec, next) => {
    rememberCall(exec)
    return next()
  }, { global: true })

  // ── 设置命名空间：可以放在 await 之后（与监听不同） ────────────────────────
  // `settings.register` 内部把 effect 挂在 **settings 服务自己的 ctx** 上，不依赖本插件
  // fiber 的作用域时机，所以晚注册不影响。——这也是它当初"看起来没坏"的原因。
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
