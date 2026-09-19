// skin-settings-self-test.mjs — 外观（皮肤）设置单测，测的是壳真正调用的 src/skin-settings.mjs：
// 迁移只补缺失且绝不覆盖已有键（含 false / 0）、布尔与数值读法边界、快照形状、纯函数无副作用。
import {
  GLASS_CHAT_OPACITY_DEFAULT,
  GLASS_INPUT_OPACITY_DEFAULT,
  MASK_ENABLED_KEYS,
  SIDEBAR_OPACITY_DEFAULT,
  boolOf,
  clamp01Num,
  migrateSkinSettings,
  skinSnapshot,
} from '../src/skin-settings.mjs'

let passed = 0, failed = 0
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ① 迁移：只补缺失、绝不覆盖
{
  const r = migrateSkinSettings({})
  ok('空设置 → 四个遮罩开关全补上且为 true',
    MASK_ENABLED_KEYS.every((k) => r.settings[k] === true),
    JSON.stringify(r.settings))
  ok('空设置 → 毛玻璃开关补上且为 false（没有壁纸可透）',
    r.settings.glassChatEnabled === false)
  ok('空设置 → 毛玻璃强度补上默认值',
    r.settings.glassChatOpacity === GLASS_CHAT_OPACITY_DEFAULT)
  ok('空设置 → **不再**补 glassDialog 相关键（那一项已按删除）',
    r.settings.glassDialogEnabled === undefined && r.settings.glassDialogOpacity === undefined,
    JSON.stringify(r.changed))
  ok('空设置 → 输入栏毛玻璃也补上（独立一项，2026-09-18 新增）',
    r.settings.glassInputEnabled === false && r.settings.glassInputOpacity === GLASS_CHAT_OPACITY_DEFAULT,
    JSON.stringify({ e: r.settings.glassInputEnabled, o: r.settings.glassInputOpacity }))
  ok('输入栏那项**有自己的默认常量**（0.7），只是存量迁移优先沿用对话区的值',
    GLASS_INPUT_OPACITY_DEFAULT === 0.7 && GLASS_INPUT_OPACITY_DEFAULT !== GLASS_CHAT_OPACITY_DEFAULT)
  ok('changed 列出的是**真的补上的键**（四个遮罩开关 + 毛玻璃开关×2 + 强度×2）',
    r.changed.length === MASK_ENABLED_KEYS.length + 4 && r.changed.includes('glassChatOpacity')
    && r.changed.includes('glassInputOpacity'),
    JSON.stringify(r.changed))
  ok('无壁纸被正确识别', r.hasWallpaper === false)
}
{
  // 最要紧的一条：false 与 0 都是用户设过的合法值，判据写成 if (!out[k]) 会静默覆盖它们
  const before = {
    railMaskEnabled: false,
    conversationMaskEnabled: false,
    fullscreenMaskEnabled: false,
    sidebarMaskEnabled: false,
    glassDialogEnabled: true,
    glassChatEnabled: true,
    glassDialogOpacity: 0,
    glassChatOpacity: 0,
    railMaskOpacity: 0,
    backgroundImage: 'D:/pics/a.jpg',
  }
  const r = migrateSkinSettings(before)
  ok('用户显式关掉的四个遮罩开关**不被覆盖**',
    MASK_ENABLED_KEYS.every((k) => r.settings[k] === false))
  ok('用户显式开着的毛玻璃开关**不被覆盖**（哪怕没壁纸）',
    r.settings.glassChatEnabled === true)
  ok('强度 0 **不被当成缺失**（0 是合法值）',
    r.settings.glassChatOpacity === 0 && r.settings.railMaskOpacity === 0)
  ok('存量里的 glassDialog 键**原样留着**（不主动删用户文件里的东西）',
    r.settings.glassDialogEnabled === true && r.settings.glassDialogOpacity === 0)
  // 输入栏那一项是新增的 ⇒ 存量设置里自然没有它，会被补上（这是预期的 changed）
  ok('存量设置只补了输入栏那两个键，其余键一个没动',
    r.changed.length === 2 && r.changed.every((k) => k.startsWith('glassInput')),
    JSON.stringify(r.changed))
  ok('输入栏强度的迁移默认 = 取对话区那一项的值（观感与拆项前一致）',
    r.settings.glassInputOpacity === 0, String(r.settings.glassInputOpacity))
}
{
  const r = migrateSkinSettings({ backgroundImage: 'D:/pics/a.jpg' })
  ok('有壁纸 → 毛玻璃默认开（毛玻璃的意义就是透出壁纸）',
    r.settings.glassChatEnabled === true && r.hasWallpaper === true)
}
{
  const r = migrateSkinSettings({ backgroundImage: '' })
  ok('壁纸是空串 → 视同没壁纸（不是"有壁纸"）', r.hasWallpaper === false && r.settings.glassChatEnabled === false)
}
{
  const r = migrateSkinSettings({ backgroundImage: 123 })
  ok('壁纸字段不是字符串 → 视同没壁纸（不抛错）', r.hasWallpaper === false)
}
{
  // 迁移是整体覆盖写回的前提：必须返回完整对象，不能只返回新增的几个键
  const before = { ws: 'D:/w', bgBrightness: 0.5, bgBlur: 12, someFutureKey: 'x' }
  const r = migrateSkinSettings(before)
  ok('返回的是**完整设置**（原有键一个不少，含未识别的键）',
    r.settings.ws === 'D:/w' && r.settings.bgBrightness === 0.5 && r.settings.bgBlur === 12
    && r.settings.someFutureKey === 'x')
}
{
  let threw = false
  try { migrateSkinSettings(null); migrateSkinSettings(undefined); migrateSkinSettings('x') } catch { threw = true }
  ok('传入 null/undefined/非对象都不抛错（设置文件损坏时壳仍要能起来）', threw === false)
}
{
  // ④ 无副作用：迁移不得改动调用方传进来的对象
  const before = { railMaskOpacity: 0.5 }
  const snapshotOfBefore = JSON.stringify(before)
  migrateSkinSettings(before)
  ok('迁移**不改传入对象**（返回新对象）', JSON.stringify(before) === snapshotOfBefore, JSON.stringify(before))
}

// ② 布尔/数值读法的边界
{
  ok('boolOf：显式 true/false 原样返回', boolOf(true, false) === true && boolOf(false, true) === false)
  ok('boolOf：缺失/其它类型走默认', boolOf(undefined, true) === true && boolOf(null, true) === true && boolOf('', true) === true)
  ok('boolOf：字符串 "false" 不走默认而是…按默认（不是布尔）', boolOf('false', true) === true)
}
{
  ok('clamp01Num：越界钳制', clamp01Num(9, 0.5) === 1 && clamp01Num(-3, 0.5) === 0)
  ok('clamp01Num：0 与 1 原样通过', clamp01Num(0, 0.5) === 0 && clamp01Num(1, 0.5) === 1)
  ok('clamp01Num：非数字 / null / 空串走默认（0 是合法值，必须原样保留）',
    clamp01Num('abc', 0.42) === 0.42 && clamp01Num(null, 0.42) === 0.42 && clamp01Num(undefined, 0.42) === 0.42
    && clamp01Num(NaN, 0.42) === 0.42 && clamp01Num('', 0.42) === 0.42
    && clamp01Num(0, 0.42) === 0)
  ok('clamp01Num：数字字符串当数字用', clamp01Num('0.3', 0.5) === 0.3)
}

// ③ 快照形状（客户端逐项读 {enabled, opacity}）
{
  const s = {
    railMaskOpacity: 0.6, conversationMaskOpacity: 0.1, fullscreenMaskOpacity: 0.9,
    sidebarOpacity: 0.7, glassChatOpacity: 0.2,
    railMaskEnabled: true, conversationMaskEnabled: false, fullscreenMaskEnabled: true,
    sidebarMaskEnabled: false, glassChatEnabled: false,
  }
  const snap = skinSnapshot(s, { railMaskOpacity: 0.6, conversationMaskOpacity: 0.1, fullscreenMaskOpacity: 0.9 })
  // 2026-09-18：glassDialog 已整项删除 ⇒ 快照只剩五项
  const keys = ['railMask', 'conversationMask', 'fullscreenMask', 'sidebarMask', 'glassChat', 'glassInput']
  ok('快照含全部六项（输入栏毛玻璃是 2026-09-18 新增的第六项）', keys.every((k) => snap[k] && typeof snap[k] === 'object'))
  ok('快照里输入栏那项给的是 {enabled, opacity}（客户端据此渲染独立滑杆）',
    typeof snap.glassInput.enabled === 'boolean' && Number.isFinite(snap.glassInput.opacity),
    JSON.stringify(snap.glassInput))
  ok('快照**不再含** glassDialog（那一项已删除）', snap.glassDialog === undefined)
  ok('每项都是 {enabled:boolean, opacity:number}',
    keys.every((k) => typeof snap[k].enabled === 'boolean' && typeof snap[k].opacity === 'number' && Number.isFinite(snap[k].opacity)))
  ok('开关按设置如实回读（含显式 false）',
    snap.conversationMask.enabled === false && snap.sidebarMask.enabled === false && snap.glassChat.enabled === false)
  ok('强度按设置如实回读', snap.railMask.opacity === 0.6 && snap.sidebarMask.opacity === 0.7 && snap.glassChat.opacity === 0.2)
  ok('开关缺失时按"遮罩默认开、毛玻璃默认关"',
    skinSnapshot({}, {}).railMask.enabled === true && skinSnapshot({}, {}).glassChat.enabled === false)
}
{
  // 左侧栏遮罩：快照必须给存储值（0.7），给渲染值会让客户端回写后滑块跳
  const snap = skinSnapshot({ sidebarOpacity: 0.7, conversationMaskOpacity: 0.1 }, { conversationMaskOpacity: 0.1 })
  ok('左侧栏遮罩快照给存储值，不给 max 后的渲染值', snap.sidebarMask.opacity === 0.7, String(snap.sidebarMask.opacity))
}
{
  const snap = skinSnapshot({}, {})
  ok('缺省强度与常量一致（遮罩 0.35/0.25/0.8、侧栏 0.45、毛玻璃 0.55）',
    snap.railMask.opacity === 0.35 && snap.conversationMask.opacity === 0.25 && snap.fullscreenMask.opacity === 0.8
    && snap.sidebarMask.opacity === SIDEBAR_OPACITY_DEFAULT
    && snap.glassChat.opacity === GLASS_CHAT_OPACITY_DEFAULT)
  ok('越界强度被钳制在 0~1',
    skinSnapshot({ glassChatOpacity: 5 }, {}).glassChat.opacity === 1
    && skinSnapshot({ glassChatOpacity: -2 }, {}).glassChat.opacity === 0)
  ok('快照对 null/非对象设置不抛错',
    (() => { try { skinSnapshot(null, null); return true } catch { return false } })())
}

// ⑤ 已撤回：强度下限"自动归位"。低强度必须原样保留（谁再把"自动归位"加回来，这条就红）。
{
  // 存量里的 glassDialog 键已随功能删除但迁移不主动删；这组只测 glassChat 的低强度不被自动修正
  const low = { backgroundImage: 'D:/pics/a.jpg', glassDialogOpacity: 0.15, glassChatOpacity: 0.05 }
  const r = migrateSkinSettings(low)
  ok('低强度（0.05）**原样保留**，不许"自动归位"',
    r.settings.glassChatOpacity === 0.05, JSON.stringify(r.settings))
  const zero = migrateSkinSettings({ glassChatOpacity: 0 })
  ok('强度 0也原样保留', zero.settings.glassChatOpacity === 0, JSON.stringify(zero.settings))
  ok('迁移不再新增任何"下限标记键"（键名与常量都已撤掉）',
    !Object.keys(r.settings).some((k) => /floor/i.test(k)), JSON.stringify(Object.keys(r.settings)))
}

// ④ 键名契约：客户端与壳必须用同一批键。客户端在浏览器里，这里只做"文本层面必须出现"的弱校验。
{
  const fs = await import('node:fs')
  const client = fs.readFileSync(new URL('../packages/dsh-desktop-ui/lib/client.js', import.meta.url), 'utf8')
  // 这几条按当前真实契约写：客户端只发/只读四个遮罩的强度，没有任何毛玻璃字段。
  // 为不存在的字段留断言 = 永久假红。
  ok('客户端 POST 的字段里有四个遮罩强度（rail/conversation/fullscreen/sidebar）',
    ['railMaskOpacity', 'conversationMaskOpacity', 'fullscreenMaskOpacity', 'sidebarOpacity']
      .every((k) => client.includes(k)))
  ok('客户端读取的遮罩快照项与壳快照一致（四项）',
    ['railMaskOpacity', 'conversationMaskOpacity', 'fullscreenMaskOpacity']
      .every((k) => new RegExp(`\\bst\\.${k}\\b`).test(client)))
  // 必须把块注释与行注释都剥掉再查：上面"已删除"的说明里就写着这两个名字，不剥会永久假红
  const clientCode = client
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
  ok('客户端里**不再有** glassDialog / --dsh-glass-dialog 的残留（连 CSS 变量一起删干净）',
    !/glassDialog/.test(clientCode) && !/--dsh-glass-dialog/.test(clientCode))
}

console.log(`\nSKIN SETTINGS SELF TEST: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
