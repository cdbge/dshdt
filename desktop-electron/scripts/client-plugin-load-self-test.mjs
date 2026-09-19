// 客户端插件**装载期**自检 —— 把每个插件真跑一遍（条目文件 → factory → apply）。
//
// 为什么必须有这一门（2026-09-17 一次"整页 Failed to load plugins"换来的）：
// 我在 `dsh-desktop-ui` 的模块体里写了 `primitives.Switch`，而 `primitives` 只在 `apply()` 里
// `require` 过 —— 模块体是在 **factory 执行时**求值的，那时 `apply()` 还没被调用。
// 结果：`ReferenceError: primitives is not defined` → DSH 报
//   `dsh-desktop-ui: import failed (see console for the import error)`
// → **整个应用卡在 "Failed to load plugins" 页面**，用户以为"应用打不开了"。
//
// 关键是：**`node --check` 永远抓不到它**（只解析、不求值），DSH 的判据也只是
// `fiber === undefined`（见前端 `Xy()`），把真正的原因留在了浏览器 console 里 ——
// 而打包态没有控制台。所以这一门的存在意义就是：**在离线门禁里把 factory 真跑起来**。
//
// 覆盖三类只有"真跑"才能发现的问题：
//   ① 模块体引用未定义标识符（本次事故）
//   ② apply() 抛错（注册插槽/命令时写错）
//   ③ 模块面形状不对（没有 apply / inject 不是数组 → DSH 认为该条目没导出东西）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let passed = 0, failed = 0
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ── 最小 React / DOM 替身 ────────────────────────────────────────────────
// 只求"能把模块体与 factory 跑完"：插件在装载期只会建元素、读样式对象，
// 真正的渲染发生在 React 挂载时（那时才需要真 DOM）。
const makeReact = () => ({
  Fragment: Symbol('Fragment'),
  createElement: (...a) => ({ __el: a }),
  createElementNS: (...a) => ({ __el: a }),
  // `renderComponent()` 用一个"一次性覆盖"喂第一个 useState（= useAdminStatus 的 status），
  // 好让 section 走"有数据"那条分支 —— 加载态分支什么都不渲染，测了等于没测。
  useState: (v) => {
    const override = globalThis.__hookOverride
    if (typeof override === 'function') return [override(v), () => {}]
    return [typeof v === 'function' ? v() : v, () => {}]
  },
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (v) => ({ current: v }),
  useMemo: (f) => (typeof f === 'function' ? f() : f),
  useCallback: (f) => f,
  useContext: () => ({}),
  memo: (f) => f,
  forwardRef: (f) => f,
})
const makeEl = (tag) => ({
  tagName: String(tag).toUpperCase(),
  style: new Proxy({}, { get: () => '', set: () => true }),
  dataset: {}, children: [], attrs: {}, textContent: '', className: '', id: '',
  setAttribute(k, v) { this.attrs[k] = v },
  getAttribute(k) { return this.attrs[k] },
  removeAttribute(k) { delete this.attrs[k] },
  appendChild(c) { this.children.push(c); return c },
  append(...c) { this.children.push(...c) },
  prepend(...c) { this.children.unshift(...c) },
  insertBefore(c) { this.children.push(c); return c },
  removeChild(c) { return c },
  remove() {},
  addEventListener() {}, removeEventListener() {},
  querySelector: () => null, querySelectorAll: () => [],
  getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }),
  focus() {}, blur() {}, click() {},
  contains: () => false,
  closest: () => null,
  matches: () => false,
})
const makeDocument = () => ({
  documentElement: makeEl('html'),
  head: makeEl('head'),
  body: makeEl('body'),
  createElement: makeEl,
  createElementNS: (_ns, tag) => makeEl(tag),
  createTextNode: (t) => ({ nodeValue: t }),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
  hidden: false, visibilityState: 'visible',
})
const makeWindow = () => ({
  addEventListener() {}, removeEventListener() {},
  location: { href: 'http://127.0.0.1:6944/', origin: 'http://127.0.0.1:6944', search: '', pathname: '/' },
  navigator: { userAgent: 'node', clipboard: { writeText: async () => {} } },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  getComputedStyle: () => new Proxy({}, { get: () => '' }),
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: (f) => setTimeout(f, 0),
  cancelAnimationFrame: (h) => clearTimeout(h),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
})

/** 跑一个插件包，返回 { stages, face, sections, renderErrors, error, registrations, required } */
function loadPlugin(pkgDir) {
  const file = path.join(pkgDir, 'lib', 'client.js')
  // ⚠️ `sections` / `renderErrors` 必须**在这里就初始化**：第一版忘了，于是
  // `out.sections[d.id] = comp` 抛 `Cannot set properties of undefined`，
  // 而那个异常被 apply 的 try/catch 吞成"apply 阶段失败" —— 探针自己把问题掩盖了。
  const out = { file, stages: [], error: null, face: null, registrations: [], required: [], sections: {}, renderErrors: [], renderCount: 0, topChildCounts: {} }
  if (!fs.existsSync(file)) { out.error = new Error('没有 lib/client.js: ' + file); return out }
  const src = fs.readFileSync(file, 'utf8')

  const react = makeReact()
  const document_ = makeDocument()
  const window_ = makeWindow()
  let def = null
  window_.__ModuleLoader__ = { load: (d) => { def = d } }

  const req = (spec) => {
    out.required.push(spec)
    if (spec === 'react') return react
    if (spec === 'react-dom') return { createPortal: (c) => c, flushSync: (f) => f() }
    if (spec === 'react/jsx-runtime') return { jsx: (...a) => ({ __el: a }), jsxs: (...a) => ({ __el: a }), Fragment: react.Fragment }
    if (spec === 'react/jsx-dev-runtime') return { jsxDEV: (...a) => ({ __el: a }), Fragment: react.Fragment }
    // 其余一律给"取任何键都得到一个组件/函数"的替身（官方 UI 包就是这么用的）
    return new Proxy({}, {
      get: (_t, k) => {
        if (typeof k !== 'string') return undefined
        const stub = function Stub() { return null }
        stub.displayName = 'Stub:' + k
        return stub
      },
      has: () => true,
    })
  }
  req.resolve = (s) => s

  // ① 条目文件（等价于浏览器 import 该 bundle）
  try {
    new Function('window', 'document', 'require', 'fetch', 'AbortSignal', 'setTimeout', 'clearTimeout', src)(
      window_, document_, req, async () => { throw new Error('（自检不发网络请求）') }, AbortSignal, setTimeout, clearTimeout
    )
    out.stages.push('file')
  } catch (e) { out.error = e; out.stage = 'file'; return out }

  if (def === null) { out.error = new Error('文件没有调用 window.__ModuleLoader__.load()'); out.stage = 'file'; return out }
  if (typeof def.factory !== 'function') { out.error = new Error('load() 里没有 factory 函数'); out.stage = 'file'; return out }
  out.id = def.id

  // ② factory —— **本次事故就发生在这一步**
  try {
    out.face = def.factory(req)
    out.stages.push('factory')
  } catch (e) { out.error = e; out.stage = 'factory'; return out }

  // ③ apply(ctx)
  //    ⚠️ 这里把**注册到的组件**留下来（out.sections）：光跑 apply 只能证明"注册动作没抛错"，
  //    而组件**渲染期**的错（2026-09-17：`fmt is not a function` 让整个「个性化」栏空白）
  //    只有真渲染才看得见 —— 见下面第 ④ 阶段。
  const ctx = {
    effect: (f, name) => { out.registrations.push('effect: ' + name); try { const d = f(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } },
    slots: {
      inject: (slot, f) => { out.registrations.push('slots.inject:' + slot); try { f() } catch (e) { out.error = e; out.stage = 'apply'; } },
      register: (d, comp) => {
        out.registrations.push('slots.register:' + d.name + '/' + d.id)
        if (typeof comp === 'function') out.sections[d.id] = comp
        return () => {}
      },
      get: () => undefined,
    },
    commandUi: { register: (d) => { out.registrations.push('commandUi.register:' + d.name); return () => {} } },
    inputTriggers: { live: { sources: [] }, registerSource: () => () => {} },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get: () => undefined,
  }
  try {
    if (out.error === null && out.face && typeof out.face.apply === 'function') out.face.apply(ctx)
    if (out.error === null) out.stages.push('apply')
  } catch (e) { out.error = e; out.stage = 'apply' }

  // ④ **真渲染**每个注册到的组件（含其内部的函数子组件，递归展开）
  //
  // ⚠️ 第一版这里写错了（假判据）：访问器只对 `el.__el[0]` 是函数的元素**再调一次**，
  // 但没有**递归进它的返回值** —— 于是 `ToggleSliderRows` 内部的 `SwitchRow` / `input`
  // 根本没被渲染到，`fmt is not a function` 这种错照样漏过去。
  // 正确做法：元素的孩子里凡是**函数组件**，就渲染它并把结果塞回树里，然后继续往下走。
  if (out.error === null) {
    out.renderErrors = []
    out.renderCount = 0
    out.topChildCounts = {}
    const fakeStatus = makeStatusFixture()
    for (const [id, Comp] of Object.entries(out.sections)) {
      try {
        // ① **先渲染一次"壳状态还没到手"**（st === null）。
        //    真实页面第一次渲染就是这一帧（/api/status 还没回来）。把读 st 字段的代码写在
        //    null 守卫之前，会在这一帧抛 `Cannot read properties of null`，
        //    React 于是把**整个 section** 卸载 —— 用户看到的是"这一栏点开什么都没有"
        //    （2026-09-17 实测：`slot entry crashed in 'settings.section'`）。
        //    这个形状以前测不到：夹具永远给 st 一个对象，首帧那一帧从来没被测过。
        out.loadingErrors = out.loadingErrors || []
        out.loadingTopChildCounts = out.loadingTopChildCounts || {}
        try {
          const t0 = renderComponent(Comp, { id, fakeStatus: null })
          const k0 = Array.isArray(t0?.__el) ? t0.__el.slice(2).flat().filter(Boolean) : []
          out.loadingTopChildCounts[id] = k0.length
          for (const k of k0) renderDeep(k, `section ${id}（加载态）`, out.loadingErrors, 0)
        } catch (e) {
          out.loadingErrors.push(`section ${id}（加载态）：${e.constructor.name}: ${e.message}`)
        }
        // ② 再渲染"真实状态"那一帧
        const tree = renderComponent(Comp, { id, fakeStatus })
        out.renderCount++
        const kids = Array.isArray(tree?.__el) ? tree.__el.slice(2).flat().filter(Boolean) : []
        out.topChildCounts[id] = kids.length
        for (const k of kids) renderDeep(k, `section ${id}`, out.renderErrors, 0)
      } catch (e) {
        out.renderErrors.push(`section ${id}：${e.constructor.name}: ${e.message}`)
      }
    }
    if (out.renderErrors.length === 0) out.stages.push('render')
  }

  return out
}

/**
 * `/api/status` 的**夹具**：形状照 `src/main.mjs` 的 `statusPayload()`，且**必须带 `skin`**
 * （新客户端读它；缺了就走"旧壳降级"分支，测不到新代码）。
 * 值刻意取非默认值：这样"把夹具值当默认值写死"这类错也能暴露。
 */
function makeStatusFixture() {
  return {
    ok: true, name: 'DSH Desktop', version: '0.4.6', pid: 4242, mode: 'window',
    adminPort: 25439, webPort: 1234, webUrl: 'http://127.0.0.1:1234/?token=x', ready: true,
    home: 'C:/Users/x/.dsh', ws: 'D:/ws', autostart: false, minimizeToTray: true,
    backgroundImage: 'D:/pic/a.jpg', bgBrightness: 1.2, bgBlur: 6,
    railMaskOpacity: 0.5, conversationMaskOpacity: 0.3, fullscreenMaskOpacity: 0.85,
    sidebarBgMode: 'own', sidebarBgImage: 'D:/pic/b.jpg', sidebarOpacity: 0.3,
    sidebarBgImageVersion: 123456, dshBin: 'C:/dsh/bin.js',
    engine: 'node', electron: '43.4.0', node: '22.21.0', pwsh: 'pwsh',
    restarts: 0, trayUsable: true, uptimeSec: 61,
    skin: {
      railMask: { enabled: true, opacity: 0.5 },
      conversationMask: { enabled: true, opacity: 0.3 },
      fullscreenMask: { enabled: true, opacity: 0.85 },
      sidebarMask: { enabled: true, opacity: 0.3 },
      glassDialog: { enabled: true, opacity: 0.72 },
      glassChat: { enabled: false, opacity: 0.55 },
    },
    dshUpdate: { current: '0.1.6-alpha.1', target: '', canCheck: true, canUpdate: false, canApply: false, showProgress: false, percent: 0, stepLabel: '', elapsed: '', hint: '已是最新', needsConfirm: false, jump: null },
  }
}

/** 走一遍元素树（React 替身产出的形状是 { __el: [type, props, ...children] }）。 */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const n of node) walk(n, visit); return }
  if (!Array.isArray(node.__el)) return
  visit(node)
  for (const child of node.__el.slice(2)) walk(child, visit)
}

/**
 * 展开一棵 React 元素树：元素的孩子里凡是**函数组件**就渲染它（结果替换回树里），
 * 然后继续往下。错误收集到 `errors`（带路径，便于定位）。
 *
 * 为什么必须"递归进返回值"：`ToggleSliderRows` 这类**自定义组件**内部还有 `SwitchRow` 与
 * `input`；只调用外层、不看返回值，等于什么都没测（第一版就是这么漏掉 `fmt` 那个错的）。
 */
function renderDeep(node, where, errors, depth) {
  if (depth > 8 || node === null || node === undefined) return
  if (Array.isArray(node)) { for (const n of node) renderDeep(n, where, errors, depth); return }
  if (typeof node !== 'object' || !Array.isArray(node.__el)) return
  const [type, props, ...children] = node.__el
  // 函数组件：渲染它（它的输出再往下走）
  if (typeof type === 'function' && !type.__isDom) {
    let rendered
    try { rendered = type(props || {}) } catch (e) {
      errors.push(`${where} 的组件 ${type.name || 'anon'}：${e.constructor.name}: ${e.message}`)
      return
    }
    renderDeep(rendered, `${where}>${type.name || 'anon'}`, errors, depth + 1)
    return
  }
  for (const c of children) renderDeep(c, where, errors, depth + 1)
}
/**
 * 渲染一个函数组件：`useState` 的**第一个调用**喂真实形状的 status
 * （`useAdminStatus()` 就是第一个），其余按初值返回，避免"永远停在加载态"。
 */
function renderComponent(Comp, { fakeStatus }) {
  let n = 0
  const prev = globalThis.__hookOverride
  globalThis.__hookOverride = (v) => { n++; return n === 1 ? fakeStatus : (typeof v === 'function' ? v() : v) }
  try { return Comp({}) } finally { globalThis.__hookOverride = prev }
}

// ── 被测插件：**取自真实源码目录**（不是副本）────────────────────────────
const PACKAGES = ['dsh-desktop-ui', 'dsh-auto-approval', 'dsh-market']
// ⚠️ 必须用 `fileURLToPath`（2026-09-19 CI 首跑抓到）：旧写法是
//   `new URL('../packages/', import.meta.url).pathname.replace(/^\//, '')`
// —— 在 Windows 上 `.pathname` 是 `/D:/…`，去掉前导斜杠正好得到可用的 `D:/…`；但在 Linux/macOS 上
// 它是 `/home/runner/…`，去掉前导斜杠就变成**相对路径** `home/runner/…` ⇒ 三个插件全部 ENOENT、
// 本套件 0 通过。它是"只在 Windows 成立"的写法，而 CI 三平台都跑（Windows 绿、Linux/macOS 红）。
const root = fileURLToPath(new URL('../packages/', import.meta.url))

console.log('客户端插件装载期自检（真跑 factory，等价于 DSH 的 import 阶段）\n')

for (const name of PACKAGES) {
  const dir = path.join(root, name)
  const r = loadPlugin(dir)
  const where = r.stage ? `（${r.stage} 阶段）` : ''
  ok(`${name}：文件 → factory → apply 三阶段无异常${where}`,
    r.error === null,
    r.error ? `${r.error.constructor.name}: ${r.error.message}` : '')
  if (r.error) continue
  ok(`${name}：模块面有 apply 函数`, typeof r.face.apply === 'function')
  ok(`${name}：inject 是数组（DSH 用它建依赖边）`, Array.isArray(r.face.inject), JSON.stringify(r.face.inject))
  ok(`${name}：load() 里的 id 与包目录名一致`, r.id === name, `id=${r.id}`)
  ok(`${name}：装载期只 require 白名单里的模块`, r.required.every((s) => ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'].includes(s) || s.startsWith('@deepseek-ai/')), JSON.stringify(r.required))
  // 渲染期：光有 apply 不够 —— 组件一渲染就抛错的话，用户看到的是**空白面板**
  const nSec = Object.keys(r.sections || {}).length
  ok(`${name}：注册到的组件都能真渲染（渲染期不抛错）`,
    (r.renderErrors || []).length === 0 && r.renderCount === nSec,
    (r.renderErrors || []).join(' | ') || `渲染 ${r.renderCount}/${nSec} 个`)
  // ⚠️ **首帧必须单独测**：真实页面第一帧的 `st` 是 null（/api/status 还没回来）。
  // 把 `st.xxx` 写在 `if (!st)` 之前 ⇒ 首帧抛 TypeError ⇒ React 卸载整个 section
  // ⇒ 用户看到"这一栏点开是空的"。夹具永远给对象，所以这一帧以前从来没被测过（2026-09-17 事故）。
  ok(`${name}：壳状态还没到手那一帧（st=null）也必须渲染得出来`,
    (r.loadingErrors || []).length === 0,
    (r.loadingErrors || []).join(' | ') || `加载态顶层子节点 ${JSON.stringify(r.loadingTopChildCounts || {})}`)
  console.log(`      （注册项：${r.registrations.length} 条，组件：${nSec} 个，require：${r.required.join(', ')}）`)
}

// ── 逐条守住本次事故的具体形状 ───────────────────────────────────────────
// 这几条是"事故复现判据"：只要有人再犯同样的错，它们必须红。
{
  const r = loadPlugin(path.join(root, 'dsh-desktop-ui'))
  ok('dsh-desktop-ui：注册了「桌面」与「个性化」两个设置栏',
    r.error === null && r.registrations.includes('slots.register:settings.section/desktop')
    && r.registrations.includes('slots.register:settings.section/personalize'),
    JSON.stringify(r.registrations))
  // 事故判据 ①：模块体里用到 primitives 时，它必须在**顶层**就取好
  const src = fs.readFileSync(path.join(root, 'dsh-desktop-ui', 'lib', 'client.js'), 'utf8')
  const factoryTop = src.slice(0, src.indexOf('const ADMIN'))
  ok('dsh-desktop-ui：primitives 在 factory 顶部 require（这正是本次事故的根因）',
    /const primitives = require\(["']@deepseek-ai\/dsh-client-ui-primitives["']\)/.test(factoryTop))
  // 事故判据 ②：模块体里不许出现"只在 apply() 里声明过"的名字
  //   做法：把 apply 函数体抠掉，剩下的（模块体）里若出现 primitives 的使用，就必须先有声明
  const bodyOnly = src.replace(/exports\.apply = function apply\(ctx\) \{[\s\S]*?\n    \};/, '')
  const usesPrimitives = /primitives\./.test(bodyOnly)
  const declaresPrimitives = /const primitives = require/.test(bodyOnly)
  ok('dsh-desktop-ui：模块体用到 primitives 时必须先在模块体里声明', !usesPrimitives || declaresPrimitives,
    `用到=${usesPrimitives} 声明=${declaresPrimitives}`)
  // 事故判据 ③（`ToggleSliderRows` 的 fmt 默认值）**已删**（2026-09-17）：
  //   那个组件在当前客户端里已经不存在（现版是朴素 range 输入，没有"开关+强度两行式"那套）。
  //   为**不存在的代码**留断言等于让它永远红着 —— 门禁一旦长红，真出问题时没人会看。
  //   "可选参数必须给默认值"这条教训留在实测记录里，不再靠这条断言守。
  // 事故判据 ④（2026-09-17，"你把毛玻璃加在了设置页面上" × 3）——**2026-09-18 起改为反向断言**：
  //   「把对话框毛玻璃这一栏删了」，那一整项（设置项 + CSS 规则 + 变量）已删除
  //   ⇒ 现在要守的是"**别再回来**"：客户端里不许再有裸的 [role="dialog"] 毛玻璃规则。
  //
  // ⚠️ 判据必须**先剥掉注释**再匹配：我们特意在文件里留了"这里曾经是什么"的说明文字，
  //    不剥的话这条断言会被自己的说明绊倒（**永久假红**）—— 这个形态本项目已踩过两次。
  {
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
      .join('\n')
    ok('dsh-desktop-ui：不存在裸的 [role="dialog"] 毛玻璃规则（该项已删，防复活）',
      !/\[role="dialog"\]\s*\{/.test(noComments)
      && !/\[role="dialog"\][^{]*:not\(\[class\*="_panel"\]\)/.test(noComments))
  }
  ok('dsh-desktop-ui：渲染期不引用未做默认的参数（onValue 等由调用方必给）',
    r.renderErrors.length === 0,
    r.renderErrors.join(' | '))
  // 事故判据 ⑤（2026-09-17 第四起，用户原话"关了对话页面的毛玻璃效果直接变透明了"）：
  //   **一个开关一层**。对话区遮罩（黑纱）与毛玻璃是两个独立开关，
  //   起初我图省事把两者塞进同一个 `::before`，于是"关毛玻璃"连黑纱一起抹掉 ——
  //   而壳把 `--dsw-alias-bg-base` 设成 transparent（main.mjs L656，为露出壁纸），
  //   黑纱一没对话区就直接透出壁纸，看起来就是"整个对话页变透明"。
  //   判据：遮罩层**不许**含 backdrop-filter。
  {
    const grab = (sel) => {
      const i = src.indexOf(sel)
      return i < 0 ? '' : src.slice(i, src.indexOf('\n        }', i))
    }
    const maskLayer = grab('[class$="_body"]:has(> [class$="_scrollBody"])::before {')
    ok('dsh-desktop-ui：对话区遮罩层存在且只画黑纱（不含 backdrop-filter）',
      maskLayer !== '' && /background: rgba\(0, 0, 0, var\(--dsh-conversation-mask-opacity\)\)/.test(maskLayer)
      && !/backdrop-filter/.test(maskLayer))
  }
  // 事故判据 ⑥（2026-09-18，**当天加了又撤**）：把列容器底色一并放开（#root [class$="_frame"]
  //   + _root + _centerCol）能让弹窗背后露出壁纸、毛玻璃看得见——但它**同时改了用户没要求改的东西**：
  //   整个对话列（含正文与输入区）的底色一起没了 ⇒ 用户原话"连对话页面都是全覆盖了，给我改回去"。
  //   ⇒ 规则已整条删除。这里留一条**反向断言**：插件里**不许**再出现那条放开整列底色的规则
  //     （谁把它加回来，这条就红）。
  {
    // ⚠️ 判据必须**先剥掉注释**再匹配：撤回说明里也写着那个选择器（说明"曾经有过什么"），
    //    不剥的话这条反向断言会**永久假红** —— 与 ci-self-test 里记过的同一个形态。
    const noComments = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
      .join('\n')
    const m = /#root\s*\[class\$="_frame"\][^{}]*\{[^}]*background-color:\s*transparent/.exec(noComments)
    ok('dsh-desktop-ui：**没有**放开整列底色的规则（那会连带改掉对话页的观感）',
      m === null, m === null ? '' : m[0].replace(/\s+/g, ' ').slice(0, 90))
  }
  // 结构判据：「个性化」栏必须真的有内容（空面板是本轮事故的现象）。
  // 这里**只看节点数、不看 renderErrors** —— 渲染错已有上面那条专门断言，
  // 两条都因同一个原因变红只会让"到底哪儿坏了"变模糊（诊断信号要单一）。
  // ⚠️ 2026-09-17（第二次）：左侧栏遮罩也移进「▾ 遮罩」后，顶层子节点 8 → 7
  //   （壁纸、亮度、模糊、遮罩组、左侧栏背景/图片、模式行、消息行）。门槛随之下调，
  //   但**不许再降**：再少就说明有整组没渲染出来。
  ok('dsh-desktop-ui：「个性化」栏渲染出 ≥7 个顶层子节点（不是空面板）',
    (r.topChildCounts || {})['personalize'] >= 7,
    JSON.stringify(r.topChildCounts))
  // 分组本身也是"渲染出来了吗"的判据：收纳栏标题必须出现在渲染树里。
  // ⚠️ 2026-09-17：按把**四处遮罩**都收进「▾ 遮罩」（玻璃那组要等毛玻璃版本恢复后才在），
  //   所以判据是"遮罩这一组 + 组内四个遮罩滑杆都在"。
  ok('dsh-desktop-ui：遮罩渲染成了可展开分组（用官方 DisclosureRow，且组内有四个遮罩滑杆）',
    /primitives\.DisclosureRow/.test(src)
    && /title:\s*"遮罩"/.test(src)
    && /跳转轨道遮罩/.test(src) && /对话区遮罩/.test(src)
    && /右侧栏全屏遮罩/.test(src) && /左侧栏遮罩/.test(src))
  // 「开机自启 / 最小化到托盘」的形态：用户要的是**苹果那种圆角开关**。
  // 用官方 `primitives.Switch`（`role="switch"` 的按钮 + 圆点），不自造圆角胶囊 ——
  // 观感、键盘可达性、深浅色主题都跟官方设置面板同一份实现。
  // 判据三条：① 两处都走 ToggleSwitch→官方 Switch，且各自的端点与方法名对得上；
  //           ② 官方 Switch 的 `label` 不许省（它是 aria-label，省了开关就没有可读名）；
  //           ③ 勾选框与它的样式已删净（防复活）。
  ok('dsh-desktop-ui：两个开关都用官方 primitives.Switch（苹果式圆角开关）',
    /react\.createElement\(primitives\.Switch, \{/.test(src)
    && /label: "开机自启"/.test(src)
    && /label: "关闭窗口时最小化到托盘"/.test(src))
  ok('dsh-desktop-ui：开关点下去走各自的端点（on/off 两种都发得出去）',
    /post\("\/api\/autostart", \{ on: v \}\)/.test(src)
    && /post\("\/api\/settings", \{ minimizeToTray: v \}\)/.test(src))
  ok('dsh-desktop-ui：勾选框已删净（含 css.checkbox 这个已无使用者的样式）',
    !/type:\s*"checkbox"/.test(src) && !/css\.checkbox/.test(src) && !/checkbox:/.test(src))
  // 【实测】`st.xxx` 必须先过 `if (!st)` 守卫。
  // 首帧 st=null（/api/status 还没回来），读早了就抛 TypeError ⇒ 整个 section 被 React 卸载
  // ⇒ 用户看到"这一栏点开什么都没有"。上面那条"首帧也要渲染得出来"是**运行时**判据，
  // 这条是**源码级**判据：顺序错就直接红，不必等渲染。
  {
    const seg = src.slice(src.indexOf('function DesktopSection()'))
    const guardAt = seg.indexOf('if (!st)')
    const readAt = seg.search(/st\.(autostart|minimizeToTray)/)
    ok('dsh-desktop-ui：DesktopSection 读 st 字段在 `if (!st)` 守卫之后（防整个栏被卸载）',
      guardAt !== -1 && readAt !== -1 && guardAt < readAt,
      `guard@${guardAt} firstFieldRead@${readAt}`)
  }
}

console.log(`\nCLIENT PLUGIN LOAD SELF TEST: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
