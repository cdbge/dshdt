// 壁纸注入 CSS 的**纯逻辑**：调参钳制 + 那张注入样式表的字符串拼装。
//
// 为什么单独一个模块：这张样式表是"壁纸能不能看见""毛玻璃有没有东西可糊"的**唯一决定处**，
// 但它原来内联在 main.mjs 里 —— main.mjs 一 import 就拉 Electron、起 admin 服务、抢单实例锁，
// 测试进程碰不到它，于是这段"改一个字符就整片界面变样"的字符串成了没有门禁的地方。
// 与 skin-settings.mjs 同一招：抽出来，让 `scripts/bg-css-self-test.mjs` 能测**真实现**。
//
// 本模块**无副作用、不碰磁盘、不读设置**：设置由调用方读好后传进来，端口与时间戳同理。

/** 壁纸上的轻微暗化遮罩：保证浅色文字在亮图上也读得清。 */
export const BG_SCRIM = 'rgba(10, 12, 16, 0.35)'

/** 壁纸调参的合法区间：亮度倍数 / 模糊半径 px。 */
export const BG_BRIGHTNESS_RANGE = [0.2, 2]
export const BG_BLUR_RANGE = [0, 40]

/**
 * 数值读法：`null` / 空串 / 非数字**都当缺失**走默认值，其余钳制到区间内。
 *
 * ⚠️ 必须先把 `null` 与空串当"缺失"：`Number(null)` 与 `Number('')` 都是 **0**，
 * 而 0 在亮度上是"全黑"这个合法值 —— 于是一个 `null` 会把壁纸静默变成纯黑，
 * 用户看到的是"图没了"，代码里却查不出错。同一个坑在 skin-settings.mjs 的 clamp01Num 里出现过。
 */
export function clampTuning(v, lo, hi, dflt) {
  if (v === null || v === undefined || v === '') return dflt
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}

/**
 * 把设置里的壁纸调参读成 {brightness, blur}（已钳制）。
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
 *
 * 结构（三段，各自都有"为什么"）：
 *   ① 壁纸放在 **position:fixed 的 body::before** 上并 `z-index:-1` 压到内容之下 ——
 *      放 body 自身的话，body 盒子之外会露出 html 底色（那就是"对话框底下那条黑条"）。
 *   ② **把实打实的不透明层置透明**，壁纸才透得出来（见下面那段长注释 —— 这里踩过两次）。
 *   ③ 把主题变量 `--dsw-alias-bg-base` 在 :root/body/dark/light 四处一起置 transparent：
 *      主题插件把深色别名定义在 `body[data-ds-dark-theme]`（更靠近元素 ⇒ 优先），
 *      只写 `:root` 会被 body 顶掉，于是所有拿它当底色的元素仍然不透明。
 *
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
    /* 实打实的不透明层 → 透明，让壁纸透出（单类名后缀定位，随锁定版本稳定）
       ⚠️ 2026-09-18 撤回：这里一度改成"子选择器 + 后代选择器并列"（想连带放开 _frame/_root/_centerCol），
       理由是"弹窗背后要有壁纸，毛玻璃才看得见"。**已按整条撤回** ——
       那会把整个对话列（正文 + 输入区）的底色一起拿掉，壁纸铺满整页，
       属于"改了用户没要求改的东西"。现在恢复成**只匹配 #root 直接子元素**的原状；
       scripts/bg-css-self-test.mjs 里"能命中第三层框架元素"那几条断言也一并删除
       （否则它们会反过来强推那个被否掉的改法）。：**为了修 A 的效果去动 B 的观感，必须先问**。 */
    #root > div,
    #root [class$="_frame"],
    #root [class$="_root"],
    #root [class$="_centerCol"] {
      background-color: transparent !important;
    }
    /* 主题变量：必须覆盖在**最近的定义处**。主题插件把深色别名定义在 body[data-ds-dark-theme]
       （--dsw-alias-bg-base = --dsw-static-neutral-bluish-950 = #151517），只写 :root 会被 body 顶掉，
       于是所有用 var(--dsw-alias-bg-base) 做背景的元素仍然不透明——这就是"对话框底下那条黑条"的根因。 */
    :root,
    body,
    body[data-ds-dark-theme],
    body[data-ds-light-theme] { --dsw-alias-bg-base: transparent !important; }
  `
}
