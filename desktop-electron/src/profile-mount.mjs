// profile-mount.mjs — profile 用户补丁层（cordis.patch.yml）的**写入与自愈**（纯 Node，可单测）
//
// 为什么抽成模块（2026-09-17）：
//   ① `patch-mount-self-test.mjs` 原先**把 main.mjs 里这两个函数照抄一份**再测——那是**假门禁**：
//      main.mjs 里真实现改坏了，测试照样绿（它测的是副本）。抽出来之后测试 import 的就是真实现。
//   ② 市场安装要用同一段逻辑给第三方插件写挂载行，不能在自己的文件里再抄第二遍。
//
// 这两个函数动的是**用户与 DSH 共同持有**的文件，所以口径是"最小改动"：
//   能替换一个 token 就绝不重写整份内容（注释、用户自己写的补丁条目都必须原样留下）。
import fs from 'node:fs'
import path from 'node:path'

/**
 * 确保补丁层里有该插件的 insert 行（幂等）。
 *
 * ⚠️ **不能无脑"追加"**（2026-09-12 他人机器事故的真凶）：DSH 给这个文件落的模板
 * （`dsh-app-boot` 的 `PROFILE_PATCH_TEMPLATE`）**结尾就是一个 `[]`**（合法的空 YAML 数组）。
 * 旧写法 `cur.trimEnd() + '\n' + block` 会把 `- insert:` 追加在 `[]` 之后 →
 * **同一文件里两个 YAML 节点** → 宿主每次启动都在 `loadOverlayPatches` 抛
 * `YAMLException: end of the stream or a document separator is expected` → `code=1` 退出
 * （朋友那台机器 36 次运行全是这一条，卸载重装也修不好——文件在 `$DSH_HOME`）。
 * 判据：末行是 `[]` 时必须**替换**那个 token，而不是追加。
 *
 * @param {{profileDir:string, name:string, comment?:string, log?:(m:string)=>void}} o
 *        comment 会作为 `# 注释` 写在 insert 行之前，便于事后在文件里认出这是谁加的。
 * @returns {boolean} 是否真的改了文件（未改 = 已挂载或空操作）
 */
export function ensureProfilePluginMount({ profileDir, name, comment = name, log = () => {} }) {
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  try {
    fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true })
    let cur = ''
    try { cur = fs.readFileSync(patchFile, 'utf8') } catch { cur = '# dsh profile patch layer\n' }
    const mounted = new RegExp(`(^|\\s)(id|name):\\s*${name}\\s*$`, 'm').test(cur)
    const block = `# ${comment}\n- insert:\n    - id: ${name}\n      name: ${name}\n`
    const stripped = cur.trimEnd()
    const curLast = stripped.split('\n').pop().trim()
    const head = stripped === '' || /^#/.test(curLast) ? '' : `${stripped}\n\n`
    let next
    if (curLast === '[]') {
      // 只把最后一个 `[]` token 换成条目：文件里原有的模板注释、用户条目全部原样保留
      next = `${stripped.slice(0, stripped.length - 2)}${mounted ? '' : block}\n`
    } else {
      if (mounted) return false
      next = `${head}${block}`
    }
    if (next === cur) return false
    fs.writeFileSync(patchFile, next)
    log(`已把 ${name} 写入 profile 补丁层（${curLast === '[]' ? '替换空数组' : '追加'}）: ${patchFile}`)
    return true
  } catch (e) {
    log(`补丁层写入失败(${name}): ${e.message}`)
    return false
  }
}

/**
 * 每次启动都跑一次的自愈：把"能证明是坏的"补丁层改回合法 YAML。
 *
 * 为什么必做：已经中招的机器（`.dsh` 是老版本留下的）里，`cordis.patch.yml` 会**永久**停在
 * `[]` + `- insert:` 的坏形态上——而 `ensureProfilePluginMount` 因为"名字已经在文件里出现过"
 * （那句注释里就带着名字）会直接跳过，坏文件于是永远修不好。
 * 判据是**形态**而不是文本匹配：只在"存在单独一行的 `[]`、且文件里还有顶层条目"时才判定为坏，
 * 其余情况一律不动（干净模板 = 注释 + []，那是合法的；用户手写的内容我们无权改写）。
 * @param {{profileDir:string, log?:(m:string)=>void}} o
 * @returns {boolean} 是否修了
 */
export function repairProfilePatchYaml({ profileDir, log = () => {} }) {
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  try {
    if (!fs.existsSync(patchFile)) return false
    const raw = fs.readFileSync(patchFile, 'utf8')
    const lines = raw.split('\n')
    // 判据必须是"[] 与顶层条目**同时**存在"，而不是"[] 在最后一行"：
    // 实测坏形态是 `[]` 在第 1 行、条目在它**下面**（追加方向决定）。只判末尾会漏掉真实样本。
    const emptyIdx = lines.findIndex((l) => l.trim() === '[]')
    if (emptyIdx < 0) return false
    const hasEntryAnywhere = lines.some((l) => /^\s*-\s+\S/.test(l))
    if (!hasEntryAnywhere) return false // 干净的 DSH 模板 = 只有注释 + []，这是合法的，不许动
    // 最小改动：只删掉那个 `[]` 行，其余（注释、用户条目、空行）逐行保留
    const kept = lines.filter((l) => l.trim() !== '[]')
    fs.writeFileSync(patchFile, kept.join('\n'))
    log(`已修复损坏的 profile 补丁层（第 ${emptyIdx + 1} 行是空数组 [] 却同时含顶层条目：YAML 双节点，宿主必然解析失败）: ${patchFile}`)
    return true
  } catch (e) {
    log(`补丁层自愈失败: ${e.message}`)
    return false
  }
}
