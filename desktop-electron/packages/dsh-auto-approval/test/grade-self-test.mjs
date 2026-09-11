// grade-self-test.mjs — 分级器纯函数自检（不依赖 harness，可直接 node 跑）
// 用法：node test/grade-self-test.mjs   （需在插件所在目录运行，以便解析 zod）
import { gradeRequest } from '../lib/index.js'

let pass = 0, fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`) }
}
const base = {
  highRiskPatterns: ['danger-full-access', 'sudo', 'registry', 'taskkill', '工作区外'],
  lowRiskTools: ['read', 'grep', 'web_search'],
  alwaysAskTools: ['cordis_run'],
  autoApproveUpTo: 'low',
}

// 1) 低风险工具 → low（自动放行）
let g = gradeRequest({ toolName: 'read', reason: '读一个外部文件' }, base)
ok('read + 无风险词 → low', g.grade === 'low', g.why)

// 2) 提权到 danger-full-access → high（必问用户）
g = gradeRequest({ toolName: 'pwsh', reason: 'sandbox_permissions: danger-full-access' }, base)
ok('pwsh + danger-full-access → high', g.grade === 'high', g.why)

// 3) 命中 alwaysAskTools → high
g = gradeRequest({ toolName: 'cordis_run', reason: '低风险描述' }, base)
ok('cordis_run → high（必问工具优先）', g.grade === 'high', g.why)

// 4) 无风险词的写操作 → medium（默认上限 low ⇒ 仍会问用户）
g = gradeRequest({ toolName: 'write', reason: '写入工作区内文件' }, base)
ok('write + 无风险词 → medium', g.grade === 'medium', g.why)

// 5) 缺失 reason → medium（不猜，失败方向是问用户）
g = gradeRequest({ toolName: 'mystery_tool' }, base)
ok('无 reason → high（不猜，交给用户）', g.grade === 'high', g.why)

// 6) 大小写不敏感
g = gradeRequest({ toolName: 'pwsh', reason: 'SUDO something' }, base)
ok('关键词大小写不敏感 → high', g.grade === 'high', g.why)

// 7) 中文关键词
g = gradeRequest({ toolName: 'pwsh', reason: '需要写入工作区外路径' }, base)
ok('中文关键词 → high', g.grade === 'high', g.why)

// 8) 上限设为 medium 时，medium 才允许自动放行（分级本身不变）
g = gradeRequest({ toolName: 'write', reason: '写入工作区内文件' }, { ...base, autoApproveUpTo: 'medium' })
ok('分级不受上限影响（仍为 medium）', g.grade === 'medium', g.why)

// 9) 空/异常入参不抛
try { g = gradeRequest({}, base); ok('空请求不抛异常', g.grade === 'high', g.why) } catch (e) { ok('空请求不抛异常', false, String(e && e.message)) }
try { g = gradeRequest(null, base); ok('null 请求不抛异常', g.grade === 'high', g.why) } catch (e) { ok('null 请求不抛异常', false, String(e && e.message)) }

console.log(`\nGRADE SELF TEST: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
