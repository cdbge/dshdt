// bg-css.mjs — 壁纸注入 CSS 的纯逻辑：调参钳制 + 注入样式表拼装。
// 无副作用、不碰磁盘、不读设置，参数由调用方传入。

/** 壁纸暗化遮罩：保证浅色文字在亮图上也读得清。 */
export const BG_SCRIM = 'rgba(10, 12, 16, 0.35)'

/** 壁纸调参区间：亮度倍数 / 模糊半径 px。 */
export const BG_BRIGHTNESS_RANGE = [0.2, 2]
export const BG_BLUR_RANGE = [0, 40]

/**
 * 数值读法：`null` / 空串 / 非数字都当缺失走默认值，其余钳制到区间内。
 * 必须先把 null 与空串当缺失：`Number(null)` 与 `Number('')` 都是 0，0 是亮度的合法值，
 * 否则一个 null 会把壁纸静默变成纯黑。
 */
export function clampTuning(v, lo, hi, dflt) {
  if (v === null || v === undefined || v === '') return dflt
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}

/**
 * 把设置里的壁纸调参读成已钳制的 {brightness, blur}。
 * @param {object} s 设置对象（可为空）
 */
export function bgTuningOf(s) {
  const src = s && typeof s === 'object' ? s : {}
  return {
    brightness: clampTuning(src.bgBrightness, BG_BRIGHTNESS_RANGE[0], BG_BRIGHTNESS_RANGE[1], 1),
    blur: clampTuning(src.bgBlur, BG_BLUR_RANGE[0], BG_BLUR_RANGE[1], 0),
  }
}

/**
 * 生成注入到页面的壁纸样式表。
 * 壁纸放在 position:fixed 的 body::before 并压到内容之下，body 自身之外才不会露出 html 底色。
 * @param {{adminPort:number, brightness:number, blur:number, mtime:number}} p
 *   `mtime` 由调用方读文件给出（本模块不碰磁盘，测试才能直接喂值）。
 * @returns {string} CSS 文本
 */
export function bgCssText({ adminPort, brightness = 1, blur = 0, mtime = 0 }) {
  const bleed = Math.ceil(blur * 2) // 模糊会让图层边缘发虚：固定层外扩 2×半径，避免四周露边
  const filter = (brightness !== 1 || blur > 0)
    ? `filter: brightness(${brightness})${blur > 0 ? ` blur(${blur}px)` : ''};`
    : ''
  return `
    html { background-color: #101216 !important; }
    body { background-color: transparent !important; background-image: none !important; }
    body::before {
      content: ''; position: fixed; pointer-events: none; z-index: -1;
      top: -${bleed}px; right: -${bleed}px; bottom: -${bleed}px; left: -${bleed}px;
      background-image: linear-gradient(${BG_SCRIM}, ${BG_SCRIM}), url("http://127.0.0.1:${adminPort}/bg-image?t=${mtime}");
      background-size: cover; background-position: center; background-repeat: no-repeat;
${filter ? '      ' + filter + '\n' : ''}    }
    /* 实打实的不透明层 → 透明，让壁纸透出（单类名后缀定位，随锁定版本稳定）。
       只匹配 #root 直接子元素：放开到后代选择器会把整个对话列底色一起拿掉。 */
    #root > div,
    #root [class$="_frame"],
    #root [class$="_root"],
    #root [class$="_centerCol"] {
      background-color: transparent !important;
    }
    /* 主题变量必须覆盖在最近的定义处：深色别名定义在 body[data-ds-dark-theme]，只写 :root 会被 body 顶掉。 */
    :root,
    body,
    body[data-ds-dark-theme],
    body[data-ds-light-theme] { --dsw-alias-bg-base: transparent !important; }
  `
}
