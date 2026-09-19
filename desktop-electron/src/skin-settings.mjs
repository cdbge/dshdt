// skin-settings.mjs — 外观（皮肤）设置的纯逻辑：开关默认值、旧设置迁移、给客户端的快照形状。
// 无副作用、不碰磁盘；读写由调用方负责。

/** 四个遮罩项的开关键。顺序即界面顺序。 */
export const MASK_ENABLED_KEYS = ['railMaskEnabled', 'conversationMaskEnabled', 'fullscreenMaskEnabled', 'sidebarMaskEnabled']

/** 对话区毛玻璃强度默认值。 */
export const GLASS_CHAT_OPACITY_DEFAULT = 0.55

/** 输入栏毛玻璃强度默认值（独立一项，比对话区略高）。 */
export const GLASS_INPUT_OPACITY_DEFAULT = 0.7

/** 左侧栏遮罩默认强度（与 main.mjs 的 SIDEBAR_OPACITY_DEFAULT 同值）。 */
export const SIDEBAR_OPACITY_DEFAULT = 0.45

/** 布尔读法：显式 false 才是关；缺失/其它值按默认。 */
export function boolOf(v, dflt) {
  if (v === true) return true
  if (v === false) return false
  return dflt
}

/**
 * 0~1 钳制。
 * `null` / `undefined` / 空串视同缺失走默认值：`Number(null)` 与 `Number('')` 都是 0，而 0 是合法值。
 * 显式 `0` 是用户设定，必须原样保留。
 */
export function clamp01Num(v, dflt) {
  if (v === null || v === undefined || v === '') return dflt
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : dflt
}

/**
 * 把旧设置补齐到新模型（布尔开关 + 强度分开）。不改传入对象，返回新对象。
 * 只推断 `=== undefined` 的键，用户设过的值一律不动（false / 0 都是合法值）。
 * 四个遮罩开关默认 true（与旧行为一致）；毛玻璃默认只在已有自定义壁纸时为 true。
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
  put('glassChatEnabled', hasWallpaper)
  put('glassChatOpacity', GLASS_CHAT_OPACITY_DEFAULT)
  // 存量迁移取对话区那一项的值，避免拆项后观感突变
  put('glassInputEnabled', hasWallpaper)
  put('glassInputOpacity', clamp01Num(out.glassChatOpacity, GLASS_CHAT_OPACITY_DEFAULT))
  return { settings: out, changed, hasWallpaper }
}

/**
 * 皮肤/外观完整快照：每个可调项 = 开关 + 强度。
 * `opacity` 一律是存储值而非渲染值（左侧栏的渲染值取 max，由客户端拼 CSS 变量时做）。
 * @param {object} s 设置（已读好的）
 * @param {{railMaskOpacity:number, conversationMaskOpacity:number, fullscreenMaskOpacity:number}} k 已钳制的遮罩强度
 * @returns {{railMask:object, conversationMask:object, fullscreenMask:object, sidebarMask:object, glassChat:object, glassInput:object}}
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
    // 存量 settings.json 里的 glassDialog* 键保留不动，只是被忽略
    glassChat: {
      enabled: boolOf(src.glassChatEnabled, false),
      opacity: clamp01Num(src.glassChatOpacity, GLASS_CHAT_OPACITY_DEFAULT),
    },
    glassInput: {
      enabled: boolOf(src.glassInputEnabled, false),
      opacity: clamp01Num(src.glassInputOpacity, GLASS_INPUT_OPACITY_DEFAULT),
    },
  }
}
