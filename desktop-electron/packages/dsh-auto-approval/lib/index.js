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
// zod 由 harness 提供（profile / vendor 的 node_modules 里有）。用**动态导入 + 兜底**：
// 万一某个部署没有 zod，插件仍以默认配置正常工作（只跳过设置命名空间注册），
// 而不是整个插件装载失败——审批这种安全相关的能力不该因为一个可选依赖而消失。
let z = null
try { z = (await import('zod')).z } catch { z = null }

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
}

/** settings 命名空间 schema（zod 缺失时为 null → 跳过注册，退化成默认配置）。 */
const Settings = z === null ? null : z.object({
  /** 总开关：关掉后本插件完全不介入，一切照 DSH 原生流程问用户。 */
  enabled: z.boolean().default(true),
  /**
   * 自动放行的等级上限：
   *  low    —— 只有明确白名单里的低风险工具自动放行（最保守）
   *  medium —— 另外放行"带明确 reason、且不含高风险关键词"的请求（≈ Codex 的 auto：放行有界的越界操作）
   *  high 永远问用户（不存在可设的 high 档）。
   */
  autoApproveUpTo: z.enum(['low', 'medium']).default('medium'),
  /** 命中任一关键词即判高风险（大小写不敏感）。整体替换默认表。 */
  highRiskPatterns: z.array(z.string()).default(DEFAULT_HIGH_RISK),
  lowRiskTools: z.array(z.string()).default(DEFAULT_LOW_RISK_TOOLS),
  alwaysAskTools: z.array(z.string()).default(DEFAULT_ALWAYS_ASK_TOOLS),
  /** 决策日志路径（默认 $DSH_HOME/logs/auto-approval.log）。 */
  logFile: z.string().default(''),
  logDecisions: z.boolean().default(true),
})

function homeDir() {
  const env = process.env.DSH_HOME
  return env && env.trim() !== '' ? env : path.join(os.homedir(), '.dsh')
}

/** 纯函数：给一次审批请求分级。导出以便单测（scripts 自检）。 */
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

export function apply(ctx) {
  const log = (...a) => { try { process.stderr.write(`[dsh-auto-approval] ${a.join(' ')}\n`) } catch { /* 忽略 */ } }
  const settings = ctx.get('settings')
  let scope = null
  if (settings !== undefined && Settings !== null) {
    try { scope = settings.register('auto-approval', Settings) } catch (e) { log(`settings 注册失败，改用默认配置：${e && e.message}`) }
  } else if (Settings === null) {
    log('zod 不可用：跳过 settings 命名空间注册（用默认配置；开关仍可改 settings.yaml 但不会校验）')
  }
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
  const record = (entry) => {
    decisions.unshift(entry)
    if (decisions.length > 50) decisions.pop()
    if (!cfgNow().logDecisions) return
    try {
      const p = logPath()
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.appendFileSync(p, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`)
    } catch { /* 日志失败不影响审批 */ }
  }

  // ── 核心：审批瀑布前置裁决 ─────────────────────────────────────────────
  // 返回 'allowed-once' = 自动放行；return next() = 落到既有 answerer（用户弹窗）
  ctx.on('approval/request', async (req, next) => {
    const cfg = cfgNow()
    if (!cfg.enabled) {
      record({ tool: req && req.toolName, action: 'pass-through', why: '插件已关闭（enabled=false）' })
      return next()
    }
    const { grade, why } = gradeRequest(req, cfg)
    const allow = grade === 'low' || (grade === 'medium' && cfg.autoApproveUpTo === 'medium')
    record({ tool: req && req.toolName, callId: req && req.callId, reason: req && req.reason, grade, why, action: allow ? 'auto-allowed' : 'asked-user' })
    if (!allow) return next()
    log(`自动放行 ${req && req.toolName}（${grade}）：${why}`)
    return 'allowed-once'
  })

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
          if (scope === null) return { kind: 'error', text: 'settings 服务不可用，无法持久化开关' }
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
  record({ action: 'plugin-loaded', why: `settings=${scope ? 'ok' : 'unavailable'} commands=${commands ? 'ok' : 'unavailable'}` })
}

export default { name, inject, apply }
