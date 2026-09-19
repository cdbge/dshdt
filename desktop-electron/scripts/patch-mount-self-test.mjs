// patch-mount-self-test.mjs — profile 补丁层（cordis.patch.yml）挂载与自愈单测。
// 直接 import 真实现（src/profile-mount.mjs），覆盖 DSH 模板结尾 [] / 已损坏 / 健康 / 空文件 / 已有条目 / 不存在等形态。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { ensureProfilePluginMount, repairProfilePatchYaml } from '../src/profile-mount.mjs'

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-patch-test-'))
let seq = 0
// 造一个临时 profile 目录并按需写入补丁层。夹具要给目录（补丁层路径由实现自己拼），
// 返回 {dir, patch}：dir 传给被测函数，patch 供断言读内容。
const mk = (content) => {
  const dir = path.join(root, `p${seq++}`)
  fs.mkdirSync(dir, { recursive: true })
  const patch = path.join(dir, 'cordis.patch.yml')
  if (content !== null) fs.writeFileSync(patch, content)
  return { dir, patch }
}
const mount = (dir) => ensureProfilePluginMount({ profileDir: dir, name: NAME, comment: COMMENT })
const heal = (dir) => repairProfilePatchYaml({ profileDir: dir })
// 用真实 YAML 解析验收（与本项目 harness 同源的 js-yaml）
const parseOk = (file) => {
  try {
    return Array.isArray(yaml.load(fs.readFileSync(file, 'utf8')))
  } catch { return false }
}

console.log('[profile 补丁层：挂载与自愈]（测的是 src/profile-mount.mjs 的真实现）')

// ① 形态一：DSH 模板（结尾 []）—— 必须变成合法数组，且模板注释保留
let { dir, patch } = mk(DSH_TEMPLATE)
mount(dir)
let text = fs.readFileSync(patch, 'utf8')
ok('① DSH 模板（结尾 []）→ 产物是合法 YAML 数组', parseOk(patch), text.slice(-60).replace(/\n/g, '⏎'))
ok('① 模板原有注释被保留', text.includes('# Your patch layer for this dsh profile'))
ok('① 空数组 token 已被替换（不再有裸 [] 行）', !/^\[\]$/m.test(text))
ok('① 挂载条目存在', /- insert:/.test(text) && new RegExp(`id: ${NAME}`).test(text))

// ② 形态二：已损坏（[] 后面还有条目）= 朋友机器上的真实形态
const broken = `[]\n\n# ${COMMENT}\n- insert:\n    - id: ${NAME}\n      name: ${NAME}\n`
;({ dir, patch } = mk(broken))
const repaired = heal(dir)
text = fs.readFileSync(patch, 'utf8')
ok('② 损坏文件被判定为坏并修复', repaired === true)
ok('② 修复后是合法 YAML 数组', parseOk(patch))
ok('② 修复后条目仍在（没把用户的挂载删掉）', /- insert:/.test(text))
ok('② 修复后不再以 [] 结尾', !/\[\]\s*$/.test(text))

// ③ 形态三：健康文件（正常挂载过）—— 幂等，不能被改动
;({ dir, patch } = mk(`# Your patch layer…\n\n# ${COMMENT}\n- insert:\n    - id: ${NAME}\n      name: ${NAME}\n`))
const before = fs.readFileSync(patch, 'utf8')
const changed = mount(dir)
const repairedHealthy = heal(dir)
ok('③ 健康文件：挂载不重复写入', changed === false && fs.readFileSync(patch, 'utf8') === before)
ok('③ 健康文件：自愈不误判为坏', repairedHealthy === false)
ok('③ 健康文件：仍然是合法 YAML', parseOk(patch))

// ④ 形态四：注释型空文件（壳自己首次创建的形态）—— 直接写入，不需要空数组
;({ dir, patch } = mk('# dsh profile patch layer\n'))
mount(dir)
text = fs.readFileSync(patch, 'utf8')
ok('④ 注释型空文件 → 合法 YAML 数组', parseOk(patch))
ok('④ 不产生多余的 []', !/^\[\]$/m.test(text))

// ⑤ 形态五：用户自己写过的补丁文件（有别的条目、无 []）—— 追加后仍是合法数组
;({ dir, patch } = mk('- id: some-other-row\n  disabled: true\n'))
mount(dir)
ok('⑤ 用户已有条目的文件 → 追加后仍合法', parseOk(patch), fs.readFileSync(patch, 'utf8').replace(/\n/g, '⏎'))
ok('⑤ 用户原有条目未被破坏', fs.readFileSync(patch, 'utf8').includes('some-other-row'))

// ⑥ 形态六：文件不存在 —— 不能抛错
;({ dir, patch } = mk(null))
let threw = false
try { heal(dir) } catch { threw = true }
ok('⑥ 文件不存在时自愈不抛错', threw === false)

// ⑦ 形态七（市场要用到的）：注释里的名字不算已挂载（只做文本匹配会误判而跳过写入）
;({ dir, patch } = mk(`# 关于 ${NAME} 的说明（只是注释，不是挂载）\n`))
const wrote = mount(dir)
ok('⑦ 只有注释提到名字时仍然写入（注释不算已挂载）', wrote === true && /- insert:/.test(fs.readFileSync(patch, 'utf8')))

fs.rmSync(root, { recursive: true, force: true })
console.log(`\nPATCH SELF TEST: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
