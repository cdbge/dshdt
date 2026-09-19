// bg-css-self-test.mjs — 测壳真正注入的壁纸 CSS 字符串（src/bg-css.mjs 的 bgCssText）：
// 把生成物解析成选择器→声明后断言命中关系，而不是在源码里找字符串。
import {
  BG_BLUR_RANGE,
  BG_BRIGHTNESS_RANGE,
  BG_SCRIM,
  bgCssText,
  bgTuningOf,
  clampTuning,
} from '../src/bg-css.mjs'

let passed = 0, failed = 0
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const css = bgCssText({ adminPort: 25439, brightness: 1.3, blur: 0, mtime: 1761487975581 })

// 把 CSS 拆成 [{selectors:[...], body:'...'}]，只保留规则块
function parseRules(text) {
  const noComments = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const out = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(noComments))) {
    out.push({ selectors: m[1].split(',').map((s) => s.trim()).filter(Boolean), body: m[2].trim() })
  }
  return out
}
const rules = parseRules(css)

// 选择器与元素路径从右往左配对：`>` 必须紧邻父级，空格只需在更左边找到。
// 路径元素形如 'DIV#root'、'DIV.pI_x6G_frame'。
function matchesPath(selector, path) {
  const parts = selector.trim().split(/\s+/).filter(Boolean)
  let pi = path.length - 1
  for (let si = parts.length - 1; si >= 0; si--) {
    if (parts[si] === '>') {
      si--
      if (pi < 0 || !matchSimple(parts[si], path[pi])) return false
      pi--
      continue
    }
    let found = -1
    for (let j = pi; j >= 0; j--) {
      if (matchSimple(parts[si], path[j])) { found = j; break }
    }
    if (found < 0) return false
    pi = found - 1
  }
  return true
}
function matchSimple(sel, el) {
  const idM = sel.match(/#([A-Za-z0-9_-]+)/)
  if (idM && !el.includes('#' + idM[1])) return false
  const classSuffix = sel.match(/\[class\$="([^"]+)"\]/)
  if (classSuffix) {
    const cls = (el.match(/\.([^\s.]+)/g) || []).map((c) => c.slice(1))
    if (!cls.some((c) => c.endsWith(classSuffix[1]))) return false
  }
  const tagM = sel.match(/^[A-Za-z]+/)
  if (tagM && !el.toUpperCase().startsWith(tagM[0].toUpperCase())) return false
  return true
}

// ① 壁纸层本身
{
  const before = rules.find((r) => r.selectors.includes('body::before'))
  ok('body::before 存在（壁纸画在固定层上，不是 body 自身）', !!before)
  ok('固定层：position:fixed + z-index:-1（压到内容之下）',
    /position:\s*fixed/.test(before.body) && /z-index:\s*-1/.test(before.body))
  ok('带破缓存参数 ?t=<mtime>（URL 不变时浏览器不会重新取图）',
    css.includes('/bg-image?t=1761487975581'), css.match(/bg-image\?t=\d+/)?.[0] || '没找到')
  ok('暗化遮罩用同一个常量（浅色文字在亮图上也读得清）', css.includes(BG_SCRIM))
  const blurred = bgCssText({ adminPort: 1, brightness: 1, blur: 10, mtime: 0 })
  ok('有模糊时固定层外扩 2×半径（否则四周露边）', /top:\s*-20px/.test(blurred), blurred.match(/top:[^;]+;/)?.[0] || '')
  ok('亮度=1 且模糊=0 时不写 filter（省一层合成）',
    !/filter:\s*brightness/.test(bgCssText({ adminPort: 1, brightness: 1, blur: 0, mtime: 0 })))
  ok('只调亮度也写 filter（brightness 单独生效）',
    /filter:\s*brightness\(1\.3\);/.test(css.match(/filter:[^;]*;/)?.[0] || ''), css.match(/filter:[^;]*;/)?.[0] || '')
  const tuned = bgCssText({ adminPort: 1, brightness: 1.3, blur: 4, mtime: 0 })
  ok('有调参时才写 filter，且亮度/模糊都在', /filter:\s*brightness\(1\.3\)\s*blur\(4px\)/.test(tuned))
  ok('无 filter 时不留空行/空声明（模板里的空插值会留下裸分号）',
    /background-repeat: no-repeat;\s*\n\s*\}/.test(bgCssText({ adminPort: 1, brightness: 1, blur: 0, mtime: 0 })))
}

// ② 置透明规则：只锚 #root 的直接子元素
{
  const translucent = rules.filter((r) => /background-color:\s*transparent\s*!important/.test(r.body))
    .flatMap((r) => r.selectors)
  ok('存在"把不透明层置透明"的规则', translucent.length > 0, JSON.stringify(translucent))

  // 原先断言"规则要能命中第三层框架元素"的一组用例已随被否掉的改动一并删除，不要恢复。
  ok('没有把这条规则写成内联样式串（必须走 bgCssText 生成）', !/style=/.test(css))
  ok('置透明规则仍只锚 #root 直接子元素（回到用户认可的原状）',
    translucent.some((sel) => sel.replace(/\s+/g, '') === '#root>div'), JSON.stringify(translucent))
}

// ③ 主题变量覆盖点
{
  const varRule = rules.find((r) => /--dsw-alias-bg-base:\s*transparent/.test(r.body))
  ok('有 --dsw-alias-bg-base → transparent 的覆盖规则', !!varRule)
  for (const need of [':root', 'body', 'body[data-ds-dark-theme]', 'body[data-ds-light-theme]']) {
    ok(`覆盖点含 ${need}（只写 :root 会被 body[data-ds-dark-theme] 顶掉）`,
      varRule.selectors.includes(need), JSON.stringify(varRule.selectors))
  }
  ok('覆盖带 !important（主题插件的定义在更近的元素上）', /!important/.test(varRule.body))
}

// ④ 调参钳制
{
  ok('clampTuning：越界钳制', clampTuning(9, 0.2, 2, 1) === 2 && clampTuning(-5, 0, 40, 0) === 0)
  ok('clampTuning：null / undefined / 空串走默认（Number(null) 是 0，会把亮度压成全黑）',
    clampTuning(null, 0.2, 2, 1) === 1 && clampTuning(undefined, 0.2, 2, 1) === 1 && clampTuning('', 0.2, 2, 1) === 1)
  ok('clampTuning：非数字走默认', clampTuning('abc', 0.2, 2, 1) === 1 && clampTuning(NaN, 0, 40, 0) === 0)
  ok('clampTuning：0 是合法值（原样保留）', clampTuning(0, 0, 40, 7) === 0)
  const t = bgTuningOf({ bgBrightness: 5, bgBlur: -3 })
  ok('bgTuningOf：越界钳到区间端点', t.brightness === BG_BRIGHTNESS_RANGE[1] && t.blur === BG_BLUR_RANGE[0])
  const d = bgTuningOf(null)
  ok('bgTuningOf：空设置给 1 / 0（不能把壁纸变全黑或全糊）', d.brightness === 1 && d.blur === 0)
  ok('bgTuningOf：null 字段不被当成 0', bgTuningOf({ bgBrightness: null, bgBlur: null }).brightness === 1)
}

// 反向自检：后缀选择器不该命中输入框容器/弹窗卡片。注意 `#root > div > div` 按层级命中第三层元素是正常的。
{
  const suffixed = rules.filter((r) => /background-color:\s*transparent/.test(r.body))
    .flatMap((r) => r.selectors).filter((s) => s.includes('[class$='))
  ok('后缀选择器不命中没有该后缀的元素（输入框容器/弹窗卡片）',
    !suffixed.some((sel) => matchesPath(sel, ['BODY', 'DIV#root', 'DIV', 'DIV.uV2eYG_input']))
    && !suffixed.some((sel) => matchesPath(sel, ['BODY', 'DIV#root', 'DIV', 'DIV.dsh-market-dialog'])),
    JSON.stringify(suffixed))
  ok('后缀选择器命中带该后缀的元素（_frame / _root / _centerCol 各测一条）',
    suffixed.some((sel) => matchesPath(sel, ['BODY', 'DIV#root', 'DIV', 'DIV.pI_x6G_frame']))
    && suffixed.some((sel) => matchesPath(sel, ['BODY', 'DIV#root', 'DIV', 'DIV.wSkVaW_root']))
    && suffixed.some((sel) => matchesPath(sel, ['BODY', 'DIV#root', 'DIV', 'DIV.pI_x6G_centerCol'])),
    JSON.stringify(suffixed))
}

console.log(`\nBG CSS SELF TEST: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
