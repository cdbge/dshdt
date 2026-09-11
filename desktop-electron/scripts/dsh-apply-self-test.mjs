// dsh-apply-self-test.mjs — 换树与待应用标记的离线单测（纯 Node，不联网、不碰仓库、不用 Electron）
//
// 为什么这些分支必须能脱网复现：换树是本功能里**唯一不可逆**的动作，而 Q4 已取消回滚备份——
// 真出错只能靠用户重装。所以"半途中断的残树""版本对不上""交换失败要把旧树放回"这些分支，
// 必须在没有真实 vendor 树的情况下逐条测到。
import {
  OLD_PREFIX,
  applyPending,
  cleanupOldTrees,
  clearPending,
  listOldLocks,
  listOldProfiles,
  readPending,
  restoreOldTree,
  swapVendorTree,
  validateStaging,
  writePending,
} from '../src/dsh-apply.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let fail = 0
const ok = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!cond) fail++ }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-apply-test-'))
const write = (p, content = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content) }

/** 造一棵"看起来完整"的暂存树：bin.js + vendor.lock.json 两件套是 validateStaging 的判据。 */
function makeStaging(root, version) {
  write(path.join(root, 'profile', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '// bin')
  write(path.join(root, 'profile', 'node_modules', 'dsh-desktop-ui', 'package.json'), '{"name":"dsh-desktop-ui"}')
  fs.writeFileSync(path.join(root, 'vendor.lock.json'), JSON.stringify({ dshVersions: { '@deepseek-ai/dsh': version } }))
  return root
}
/** 造一个现网 vendor 目录（含旧 profile 与旧 lock）。 */
function makeVendor(dir, marker) {
  write(path.join(dir, 'profile', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), marker)
  fs.writeFileSync(path.join(dir, 'vendor.lock.json'), JSON.stringify({ dshVersions: { '@deepseek-ai/dsh': 'old' } }))
  return dir
}

// ---------- 1) 标记读写 ----------
console.log('[pending marker]')
const appData = path.join(tmp, 'appdata')
ok('无标记时返回 null', readPending(appData) === null)
writePending(appData, { stagingRoot: 'X', target: '1.0.0' })
const p1 = readPending(appData)
ok('写入后可读回', p1?.stagingRoot === 'X' && p1?.target === '1.0.0')
ok('自动补 createdAt', typeof p1?.createdAt === 'string')
clearPending(appData)
ok('清除后返回 null', readPending(appData) === null)

write(path.join(appData, 'pending-vendor.json'), '{ 这不是 JSON')
ok('标记损坏时返回 null（不阻断启动）', readPending(appData) === null)
fs.writeFileSync(path.join(appData, 'pending-vendor.json'), JSON.stringify({ stagingRoot: 'X' }))
ok('缺 target 字段时返回 null', readPending(appData) === null)
clearPending(appData)

// ---------- 2) 暂存树校验 ----------
console.log('[validateStaging]')
ok('stagingRoot 为空 → 拒绝', validateStaging('').ok === false)
const incomplete = path.join(tmp, 'incomplete')
fs.mkdirSync(path.join(incomplete, 'profile'), { recursive: true })
ok('缺 bin.js → 拒绝（半途中断的残树）', validateStaging(incomplete).ok === false && validateStaging(incomplete).error.includes('bin.js'))

const noLock = path.join(tmp, 'no-lock')
write(path.join(noLock, 'profile', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '// bin')
ok('缺 vendor.lock.json → 拒绝', validateStaging(noLock).ok === false)

const badLock = path.join(tmp, 'bad-lock')
write(path.join(badLock, 'profile', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '// bin')
write(path.join(badLock, 'vendor.lock.json'), 'not json')
ok('lock 不可解析 → 拒绝', validateStaging(badLock).ok === false && validateStaging(badLock).error.includes('不可解析'))

const goodStage = makeStaging(path.join(tmp, 'stage-1.0.0'), '1.0.0')
const vGood = validateStaging(goodStage)
ok('完整树 → 通过', vGood.ok === true && typeof vGood.profileDir === 'string')
ok('版本一致时通过', validateStaging(goodStage, { target: '1.0.0' }).ok === true)
const vMismatch = validateStaging(goodStage, { target: '2.0.0' })
ok('版本不一致 → 拒绝（防构建后被改过）', vMismatch.ok === false && vMismatch.error.includes('不一致'), vMismatch.error)

// ---------- 3) 换树 ----------
console.log('[swapVendorTree]')
const vdir = makeVendor(path.join(tmp, 'vendor'), '// OLD')
const swapped = swapVendorTree({ vendorDir: vdir, stagingRoot: goodStage })
ok('换树成功', swapped.ok === true, swapped.error)
ok('新树已就位', fs.readFileSync(path.join(vdir, 'profile', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'utf8') === '// bin')
ok('旧树被改名保留（不是删除）', swapped.oldProfileDir !== null && fs.existsSync(swapped.oldProfileDir))
ok('旧树内容仍在（可人工救回）', fs.readFileSync(path.join(swapped.oldProfileDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'utf8') === '// OLD')
ok('lock 跟随更新', JSON.parse(fs.readFileSync(path.join(vdir, 'vendor.lock.json'), 'utf8')).dshVersions['@deepseek-ai/dsh'] === '1.0.0')
ok('旧 lock 也保留了', swapped.oldLockPath !== null && fs.existsSync(swapped.oldLockPath))
ok('暂存区 profile 已被移走', !fs.existsSync(path.join(goodStage, 'profile')))

// 交换失败必须把旧树放回——这是"应用还能启动"的底线
const vdir2 = makeVendor(path.join(tmp, 'vendor2'), '// KEEP')
const missingStage = path.join(tmp, 'stage-missing')   // 没有 profile/，rename 会抛
fs.mkdirSync(missingStage, { recursive: true })
write(path.join(missingStage, 'vendor.lock.json'), '{}')
const failedSwap = swapVendorTree({ vendorDir: vdir2, stagingRoot: missingStage })
ok('交换失败被捕获（不抛）', failedSwap.ok === false && typeof failedSwap.error === 'string')
ok('失败后旧树被放回原位', fs.existsSync(path.join(vdir2, 'profile')))
ok('放回的是原来那棵（内容未变）', fs.readFileSync(path.join(vdir2, 'profile', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'utf8') === '// KEEP')

// ---------- 4) applyPending 编排 ----------
console.log('[applyPending]')
const ad2 = path.join(tmp, 'appdata2')
ok('无标记 → skipped', applyPending({ appData: ad2, vendorDir: vdir }).skipped === true)

// 坏标记：必须清掉，否则每次启动都白试一遍
writePending(ad2, { stagingRoot: path.join(tmp, 'nope'), target: '9.9.9' })
const badApply = applyPending({ appData: ad2, vendorDir: vdir })
ok('暂存树不可用 → 不应用且有 error', badApply.applied === false && typeof badApply.error === 'string')
ok('坏标记被清除（不会反复重试）', readPending(ad2) === null)

// 正常路径
const vdir3 = makeVendor(path.join(tmp, 'vendor3'), '// BEFORE')
const stage3 = makeStaging(path.join(tmp, 'stage-9.9.9'), '9.9.9')
writePending(ad2, { stagingRoot: stage3, target: '9.9.9' })
const applied = applyPending({ appData: ad2, vendorDir: vdir3 })
ok('正常路径 applied=true', applied.applied === true, applied.error)
ok('标记已清除', readPending(ad2) === null)
ok('新树生效', JSON.parse(fs.readFileSync(path.join(vdir3, 'vendor.lock.json'), 'utf8')).dshVersions['@deepseek-ai/dsh'] === '9.9.9')
ok('旧树路径被回报（供日志指引）', typeof applied.oldProfileDir === 'string' && fs.existsSync(applied.oldProfileDir))
ok('暂存空壳已清理', !fs.existsSync(stage3))

// ---------- 5) 兜底回滚（0.4.6 事故的修正：失败发生在换树之后） ----------
console.log('[restoreOldTree]')
const vdirR = makeVendor(path.join(tmp, 'vendorR'), '// NEW-BROKEN')
// 造一棵"被换走的旧树"
const oldTree = path.join(vdirR, `${OLD_PREFIX}123`)
fs.mkdirSync(path.join(oldTree, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
fs.writeFileSync(path.join(oldTree, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '// OLD-GOOD')
const oldLock = path.join(vdirR, 'vendor.lock.json.old-123')
fs.writeFileSync(oldLock, JSON.stringify({ dshVersions: { '@deepseek-ai/dsh': '0.1.0-rc.8' } }))

const rb = restoreOldTree({ vendorDir: vdirR, oldProfileDir: oldTree, oldLockPath: oldLock })
ok('回滚成功', rb.ok === true, rb.error)
const binAfter = fs.readFileSync(path.join(vdirR, 'profile', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'utf8')
ok('profile 已是旧树内容', binAfter === '// OLD-GOOD')
ok('起不来的新树被改名保留（可事后诊断）', typeof rb.failedDir === 'string' && fs.existsSync(rb.failedDir))
ok('回滚后 lock 也回到旧值', JSON.parse(fs.readFileSync(path.join(vdirR, 'vendor.lock.json'), 'utf8')).dshVersions['@deepseek-ai/dsh'] === '0.1.0-rc.8')

const rbMissing = restoreOldTree({ vendorDir: vdirR, oldProfileDir: path.join(tmp, 'no-such-tree') })
ok('旧树不存在 → 明确拒绝（不抛）', rbMissing.ok === false && rbMissing.error.includes('无法回滚'), rbMissing.error)
ok('拒绝回滚时不动现网 profile', fs.readFileSync(path.join(vdirR, 'profile', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'utf8') === '// OLD-GOOD')

// ---------- 6) 旧树清理 ----------
console.log('[cleanupOldTrees]')
ok('能列出遗留旧树', listOldProfiles(vdir3).length === 1, JSON.stringify(listOldProfiles(vdir3)))
ok('能列出遗留旧 lock', listOldLocks(vdir3).length === 1)
cleanupOldTrees(vdir3)
ok('清理后旧树消失', listOldProfiles(vdir3).length === 0 && listOldLocks(vdir3).length === 0)
ok('清理不影响现网树', fs.existsSync(path.join(vdir3, 'profile', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')))
ok('无遗留时清理返回 0 且不抛', cleanupOldTrees(vdir3) === 0)
ok('目录不存在时也返回 0', cleanupOldTrees(path.join(tmp, 'no-such-dir')) === 0)
ok('OLD_PREFIX 命名约定', OLD_PREFIX === 'profile.old-')

fs.rmSync(tmp, { recursive: true, force: true })
console.log(fail === 0 ? '\nDSH APPLY SELF TEST: ALL PASS' : `\nDSH APPLY SELF TEST: ${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
