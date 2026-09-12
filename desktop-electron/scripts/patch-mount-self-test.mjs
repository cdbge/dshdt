// profile 补丁层（cordis.patch.yml）挂载与自愈单测
//
// 为什么要有它：2026-09-12 他人机器事故的真凶就是这个文件——
// DSH 的模板（`dsh-app-boot` 的 PROFILE_PATCH_TEMPLATE）**结尾是 `[]`**（合法空 YAML 数组），
// 而壳旧写法把 `- insert:` 追加在它后面 → 同文件两个 YAML 节点 → 宿主每次启动都抛
//   dsh: failed to parse overlay …: YAMLException: end of the stream or a document separator is expected (4:1)
// → code=1 退出。朋友那台机器 36 次运行全是这一条，而"卸载重装"永远修不好（文件在 $DSH_HOME）。
//
// 本测试把 main.mjs 里的两个纯函数（ensureProfilePluginMount / repairProfilePatchYaml）照抄一份逻辑，
// 在临时目录上覆盖四种形态：模板空数组、已损坏、已挂载、注释型空文件。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'

let passed = 0, failed = 0
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const NAME = 'dsh-auto-approval'
const COMMENT = 'AI 自检权限申请：审批瀑布前置分级，低风险自动放行、高风险仍问用户'
// DSH 真实模板（逐字取自 dsh-app-boot/lib/index.js:360-364）
const DSH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

const block = () => `# ${COMMENT}\n- insert:\n    - id: ${NAME}\n      name: ${NAME}\n`

function ensureProfilePluginMount(file) {
  let cur = ''
  try { cur = fs.readFileSync(file, 'utf8') } catch { cur = '# dsh profile patch layer\n' }
  const mounted = new RegExp(`(^|\\s)(id|name):\\s*${NAME}\\s*$`, 'm').test(cur)
  const b = block()
  const stripped = cur.trimEnd()
  const curLast = stripped.split('\n').pop().trim()
  const head = stripped === '' || /^#/.test(curLast) ? '' : `${stripped}\n\n`
  let next
  if (curLast === '[]') {
    next = `${stripped.slice(0, stripped.length - 2)}${mounted ? '' : b}\n`
  } else {
    if (mounted) return false
    next = `${head}${b}`
  }
  if (next === cur) return false
  fs.writeFileSync(file, next)
  return true
}

function repairProfilePatchYaml(file) {
  if (!fs.existsSync(file)) return false
  const raw = fs.readFileSync(file, 'utf8')
  const lines = raw.split('\n')
  const emptyIdx = lines.findIndex((l) => l.trim() === '[]')
  if (emptyIdx < 0) return false
  if (!lines.some((l) => /^\s*-\s+\S/.test(l))) return false
  fs.writeFileSync(file, lines.filter((l) => l.trim() !== '[]').join('\n'))
  return true
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-patch-test-'))
const mk = (content) => { const f = path.join(root, `p${Math.random().toString(36).slice(2)}.yml`); if (content !== null) fs.writeFileSync(f, content); return f }
/** 用真实 YAML 解析验收（与本项目 harness 同源的 js-yaml） */
const parseOk = (file) => {
  try {
    return Array.isArray(yaml.load(fs.readFileSync(file, 'utf8')))
  } catch { return false }
}

console.log('[profile 补丁层：挂载与自愈]')

// ① 形态一：DSH 模板（结尾 []）—— 必须变成合法数组，且模板注释保留
let f = mk(DSH_TEMPLATE)
ensureProfilePluginMount(f)
let text = fs.readFileSync(f, 'utf8')
ok('① DSH 模板（结尾 []）→ 产物是合法 YAML 数组', parseOk(f), text.slice(-60).replace(/\n/g, '⏎'))
ok('① 模板原有注释被保留', text.includes('# Your patch layer for this dsh profile'))
ok('① 空数组 token 已被替换（不再有裸 [] 行）', !/^\[\]$/m.test(text))
ok('① 挂载条目存在', /- insert:/.test(text) && new RegExp(`id: ${NAME}`).test(text))

// ② 形态二：已损坏（[] 后面还有条目）= 朋友机器上的真实形态
const broken = `[]\n\n# ${COMMENT}\n- insert:\n    - id: ${NAME}\n      name: ${NAME}\n`
f = mk(broken)
const repaired = repairProfilePatchYaml(f)
text = fs.readFileSync(f, 'utf8')
ok('② 损坏文件被判定为坏并修复', repaired === true)
ok('② 修复后是合法 YAML 数组', parseOk(f))
ok('② 修复后条目仍在（没把用户的挂载删掉）', /- insert:/.test(text))
ok('② 修复后不再以 [] 结尾', !/\[\]\s*$/.test(text))

// ③ 形态三：健康文件（正常挂载过）—— 幂等，不能被改动
f = mk(`# Your patch layer…\n\n# ${COMMENT}\n- insert:\n    - id: ${NAME}\n      name: ${NAME}\n`)
const before = fs.readFileSync(f, 'utf8')
const changed = ensureProfilePluginMount(f)
const repairedHealthy = repairProfilePatchYaml(f)
ok('③ 健康文件：挂载不重复写入', changed === false && fs.readFileSync(f, 'utf8') === before)
ok('③ 健康文件：自愈不误判为坏', repairedHealthy === false)
ok('③ 健康文件：仍然是合法 YAML', parseOk(f))

// ④ 形态四：注释型空文件（壳自己首次创建的形态）—— 直接写入，不需要空数组
f = mk('# dsh profile patch layer\n')
ensureProfilePluginMount(f)
text = fs.readFileSync(f, 'utf8')
ok('④ 注释型空文件 → 合法 YAML 数组', parseOk(f))
ok('④ 不产生多余的 []', !/^\[\]$/m.test(text))

// ⑤ 形态五：用户自己写过的补丁文件（有别的条目、无 []）—— 追加后仍是合法数组
f = mk('- id: some-other-row\n  disabled: true\n')
ensureProfilePluginMount(f)
ok('⑤ 用户已有条目的文件 → 追加后仍合法', parseOk(f), fs.readFileSync(f, 'utf8').replace(/\n/g, '⏎'))
ok('⑤ 用户原有条目未被破坏', fs.readFileSync(f, 'utf8').includes('some-other-row'))

// ⑥ 形态六：文件不存在 —— 不能抛错
f = path.join(root, 'not-there.yml')
let threw = false
try { repairProfilePatchYaml(f) } catch { threw = true }
ok('⑥ 文件不存在时自愈不抛错', threw === false)

fs.rmSync(root, { recursive: true, force: true })
console.log(`\nPATCH SELF TEST: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
