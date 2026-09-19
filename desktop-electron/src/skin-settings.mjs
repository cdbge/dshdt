// 外观（皮肤）设置的**纯逻辑**：开关默认值、旧设置迁移、给客户端的快照形状。
//
// 为什么单独一个模块：这些判断原来内联在 main.mjs 里，而 main.mjs 一 import 就会
// 拉 Electron、起 admin 服务、抢单实例锁 —— 测试根本碰不到它，于是"迁移规则"这种
// **只在存量用户机器上跑一次、跑错就永久写坏**的逻辑成了唯一没有门禁的地方。
// 抽到这里后 `scripts/skin-settings-self-test.mjs` 能直接测真实代码（与 profile-mount.mjs 同一招）。
//
// 本模块**没有任何副作用、不碰磁盘**：读写在调用方，函数只做判断与拼装。

/** 四个遮罩项（各自一个"开关"键）。顺序即界面顺序，测试按它遍历。 */
export const MASK_ENABLED_KEYS = ['railMaskEnabled', 'conversationMaskEnabled', 'fullscreenMaskEnabled', 'sidebarMaskEnabled']

/** 对话区毛玻璃的强度默认值（0.55）。2026-09-18：模态弹窗那一项已删除，只剩这一项。 */
export const GLASS_CHAT_OPACITY_DEFAULT = 0.55

/**
 * **输入栏**毛玻璃的强度默认值（2026-09-18 新增；用户："你为什么不单独做一个调节输入框毛玻璃效果的栏位"）。
 *
 * 为什么单独一项、不跟对话区共用：两者的目标物完全不同 ——
 * 对话区那一项糊的是"正文区那条带子"，输入栏这一项糊的是
 * **底部输入卡片 + 它上面的按钮 + 按钮唤起的浮层**（指令清单 / 模型选择 / 访问模式）。
 * 用户明确要求各调各的。
 * 默认取得比对话区略高（0.7）：输入栏是手上一直在用的那块，磨砂实一点更像实体面板；
 * 对话区糊的是正文背景，透一点读起来更舒服。
 */
export const GLASS_INPUT_OPACITY_DEFAULT = 0.7

// ⚠️ 2026-09-18 撤回：这里曾加过一条「强度 < 0.5 就归位到默认值」的迁移（GLASS_OPACITY_MIN_VISIBLE
//    + 标记键 glassOpacityFloorApplied）。动机是"用户拖到 0.15，模糊半径只有 3.3px，等于没效果"。
//    **已按整条撤销**：用户明确把「对话框毛玻璃」拖到 0 就是他的选择，
//    迁移会在下次启动把它改回 0.72 —— 那是**替用户做决定**，与"开关点不动"同类。
//    ⇒ 强度怎么调是用户的自由；要解释"为什么看不出效果"，去改文档与默认值，不要改他的设置。

/** 左侧栏遮罩的默认强度（与 main.mjs 的 SIDEBAR_OPACITY_DEFAULT 同值，见那边的说明）。 */
export const SIDEBAR_OPACITY_DEFAULT = 0.45

/** 布尔读法：显式 false 才是关；缺失/其它值按默认。 */
export function boolOf(v, dflt) {
  if (v === true) return true
  if (v === false) return false
  return dflt
}

/**
 * 0~1 钳制。
 *
 * ⚠️ **`null` / `undefined` / 空串要视同"缺失"走默认值**，不能交给 `Number()`：
 * `Number(null)` 与 `Number('')` 都是 **0**，而 0 在强度语义里是**合法值**（"完全隐藏"）。
 * 于是手改过、或写坏过的 settings.json 里一个 `null` 会把强度静默变成 0，
 * 之后谁也分不清"用户就是想隐藏"还是"读坏了"——静默错值比报错难查得多。
 * 判据只放这三种：显式 `0` 是用户设定，必须原样保留。
 */
export function clamp01Num(v, dflt) {
  if (v === null || v === undefined || v === '') return dflt
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : dflt
}

/**
 * 把旧设置补齐到新模型（布尔开关 + 强度分开）。
 *
 * **三条原则**（存量的用户机器不能被这次改动搞坏）：
 *   ① **只推断一次、结果落盘** —— 推断完调用方就写回 `settings.json`，之后 `settings.json`
 *      就是完整事实，排障时不必在代码里推算"这个键缺失时算开还是算关"。
 *   ② **已有键绝不覆盖** —— 用户调过的值一个都不动（判据是 `=== undefined`，不是 falsy：
 *      `false` 和 `0` 都是**用户设过的合法值**，被覆盖掉就等于把开关偷偷打开）。
 *   ③ 推断要有**理由**，不是"填个默认值"：
 *      · 四个遮罩开关 → `true`：它们是功能性提示（能看见才知道那里能拖/能点），旧版本一直显示，
 *        默认开 = 与旧行为一致；
 *      · 毛玻璃开关 → **有自定义壁纸才 `true`**：毛玻璃的意义是"让壁纸透过来"，
 *        没设壁纸时开它只会把界面变半透明却没有东西可透，视觉上只是变脏
 *        ⇒ **不擅自改变观感**，所以按"用户是否已经在用壁纸"来决定。
 *
 * **本函数不改传入对象**（返回新对象）：调用方拿到的是"该写成什么样"，写不写、写去哪由它决定。
 * 这样测试可以直接喂各种存量形状，不必伪造磁盘。
 *
 * @param {object} s 现有设置（可为空对象）
 * @returns {{settings: object, changed: string[], hasWallpaper: boolean}}
 */
export function migrateSkinSettings(s) {
  const src = s && typeof s === 'object' ? s : {}
  const out = { ...src }
  const changed = []
  const put = (k, v) => { if (out[k] === undefined) { out[k] = v; changed.push(k) } }
  const hasWallpaper = typeof out.backgroundImage === 'string' && out.backgroundImage !== ''
  for (const k of MASK_ENABLED_KEYS) put(k, true)
  // 2026-09-18：不再补 glassDialogEnabled / glassDialogOpacity —— 那一项（模态弹窗毛玻璃）
  // 已按删除，新用户的设置里不该再出现一个没有入口的键。
  put('glassChatEnabled', hasWallpaper)
  put('glassChatOpacity', GLASS_CHAT_OPACITY_DEFAULT)
  // 输入栏毛玻璃（2026-09-18 新增，独立一项）：
  // **存量迁移取"对话区那一项的值"当默认** —— 用户看到的效果与改动前一致（输入框当时就是跟着
  // 对话区那一项走的），不会因为拆项而突然变样；他随后自己调即可。
  // 兜底常量也用**对话区那个默认**（0.55），而不是输入栏自己的 0.7：
  // 这条 `put` 紧跟在 glassChatOpacity 的 put 之后，走到这里它一定已有值，
  // 兜底只在"调用方传了带 undefined 的怪对象"时才用得上 —— 那种情况下跟对话区对齐更不容易出意外。
  // ⚠️ 判据不能写成 `out.glassChatOpacity || 默认`：**0 是合法值**，
  //    写成 || 会把 0 当缺失（本项目在 clamp01Num 那里为同一形态写过注释）。
  put('glassInputEnabled', hasWallpaper)
  put('glassInputOpacity', clamp01Num(out.glassChatOpacity, GLASS_CHAT_OPACITY_DEFAULT))
  // ⚠️ 2026-09-18 撤回：这里曾有一段"强度 < 0.5 就归位到默认值"（含只做一次的标记键）。
  //    **整段删除**：用户把滑块拖到 0（关掉观感）是他的明确选择，
  //    迁移替他改回 0.72 就是"替用户做决定"。要解释"为什么看不出效果"，
  //    改文档与默认值，别改用户的设置。
  return { settings: out, changed, hasWallpaper }
}

/**
 * 皮肤/外观的完整快照：每个可调项 = **开关 + 强度**，外加毛玻璃两项。
 *
 * `opacity` 一律是**存储值**，不是渲染值：
 * 左侧栏遮罩的渲染值 = max(它, 对话区遮罩)，那个 max 由客户端在写 CSS 变量时做
 * （见 main.mjs 里 SIDEBAR_OPACITY_DEFAULT 那段说明）。快照必须给存储值，
 * 否则客户端读回来的"当前值"会被 max 顶上去，用户一拖就被回写成一个更大的数 —— 滑块会跳。
 *
 * @param {object} s 设置（已读好的，省一次读盘）
 * @param {{railMaskOpacity:number, conversationMaskOpacity:number, fullscreenMaskOpacity:number}} k 已钳制的遮罩强度
 * @returns {{railMask:object, conversationMask:object, fullscreenMask:object, sidebarMask:object, glassDialog:object, glassChat:object}}
 */
export function skinSnapshot(s, k) {
  const src = s && typeof s === 'object' ? s : {}
  const t = k && typeof k === 'object' ? k : {}
  const sbRaw = Number(src.sidebarOpacity)
  const sbOpacity = Number.isFinite(sbRaw) ? Math.min(1, Math.max(0, sbRaw)) : SIDEBAR_OPACITY_DEFAULT
  return {
    railMask: {
      enabled: boolOf(src.railMaskEnabled, true),
      opacity: clamp01Num(t.railMaskOpacity, 0.35),
    },
    conversationMask: {
      enabled: boolOf(src.conversationMaskEnabled, true),
      opacity: clamp01Num(t.conversationMaskOpacity, 0.25),
    },
    fullscreenMask: {
      enabled: boolOf(src.fullscreenMaskEnabled, true),
      opacity: clamp01Num(t.fullscreenMaskOpacity, 0.8),
    },
    sidebarMask: { enabled: boolOf(src.sidebarMaskEnabled, true), opacity: sbOpacity },
    // 2026-09-18：glassDialog（模态弹窗毛玻璃）已按**整项删除** ——
    // 设置面板里没有它的入口了，快照也不再给这一项，避免留一条没人用的死通道。
    // 存量 settings.json 里的 glassDialogEnabled / glassDialogOpacity 两个键**保留不动**
    // （不主动去删用户文件里的东西，它们只是被忽略）。
    glassChat: {
      enabled: boolOf(src.glassChatEnabled, false),
      opacity: clamp01Num(src.glassChatOpacity, GLASS_CHAT_OPACITY_DEFAULT),
    },
    // 输入栏毛玻璃（独立一项，2026-09-18 新增）：目标物是输入卡片 + 它的按钮 + 按钮唤起的浮层。
    glassInput: {
      enabled: boolOf(src.glassInputEnabled, false),
      opacity: clamp01Num(src.glassInputOpacity, GLASS_INPUT_OPACITY_DEFAULT),
    },
  }
}
