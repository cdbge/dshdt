// profile-mount.mjs — profile 用户补丁层（cordis.patch.yml）的写入与自愈（纯 Node，可单测）。
// 口径是最小改动：能替换一个 token 就不重写整份内容，用户自己写的条目原样保留。
import fs from 'node:fs'
import path from 'node:path'

/**
 * 确保补丁层里有该插件的 insert 行（幂等）。
 * DSH 的模板结尾就是个 `[]`，此时必须替换该 token 而不是追加，否则同一文件出现两个 YAML 节点，
 * 宿主启动即抛 YAMLException。
 * @param {{profileDir:string, name:string, comment?:string, log?:(m:string)=>void}} o
 *        comment 作为 `# 注释` 写在 insert 行之前。
 * @returns {boolean} 是否真的改了文件
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
      // 只替换最后一个 `[]` token，其余内容原样保留
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
 * 启动自愈：把坏形态的补丁层改回合法 YAML（即同时存在单独一行的 `[]` 与顶层条目）。
 * 干净模板（注释 + `[]`）与用户手写内容一律不动。
 * @param {{profileDir:string, log?:(m:string)=>void}} o
 * @returns {boolean} 是否修了
 */
export function repairProfilePatchYaml({ profileDir, log = () => {} }) {
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  try {
    if (!fs.existsSync(patchFile)) return false
    const raw = fs.readFileSync(patchFile, 'utf8')
    const lines = raw.split('\n')
    // 判据是"[] 与顶层条目同时存在"，坏样本里 `[]` 可能在条目之前，只判末尾会漏
    const emptyIdx = lines.findIndex((l) => l.trim() === '[]')
    if (emptyIdx < 0) return false
    const hasEntryAnywhere = lines.some((l) => /^\s*-\s+\S/.test(l))
    if (!hasEntryAnywhere) return false // 干净的 DSH 模板，合法，不许动
    // 只删掉那个 `[]` 行，其余逐行保留
    const kept = lines.filter((l) => l.trim() !== '[]')
    fs.writeFileSync(patchFile, kept.join('\n'))
    log(`已修复损坏的 profile 补丁层（第 ${emptyIdx + 1} 行是空数组 [] 却同时含顶层条目：YAML 双节点，宿主必然解析失败）: ${patchFile}`)
    return true
  } catch (e) {
    log(`补丁层自愈失败: ${e.message}`)
    return false
  }
}
