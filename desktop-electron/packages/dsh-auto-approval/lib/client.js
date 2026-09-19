// browser 半身（手写，与官方 dsh-client-ui-* 相同的 ModuleLoader 自加载格式）。
//
// 它只做一件事：给 Host 侧注册的 `/approval` 命令补上**指令菜单里的小图标**。
//
// 为什么必须用"包一层候选行函数"这种偏方（2026-09-16 调研结论，勿轻易改写）：
//   · Host 侧的命令描述符是**白名单冻结**的（`dsh-commands` 只保留 definitionId/name/
//     description/input），所以插件在 `commands.register()` 里写 `icon` 会被直接丢掉；
//   · 客户端也从不读 Host 描述符的 icon —— 菜单行的图标只有两个来路：内置六条走
//     `HOST_FACES`（按 definitionId 命中官方包名），其余的走**客户端 contribution** 的
//     `row.icon`。我们的 `/approval` 两样都不占，所以天然没有图标。
//   · 而**绝不能**为了让 `/approval` 有图标去注册一个同名的客户端 contribution：
//     `ui-commands` 在拼候选行时会对重名直接抛错，异常被 input-trigger 归为
//     `source-failed`，后果是**整个「指令」分组从菜单里消失**（不是少一个图标）。
//   ⇒ 唯一不碰 harness、又不触发重名冲突的做法：在候选行返回后，给 `/approval` 那一行
//     补一个 icon 字段。菜单渲染处的判据就是 `item.icon`（组件引用，不是 element）。
//
// 图标组件从 **seed 共享模块** `@deepseek-ai/dsh-client-ui-primitives` 取（与官方客户端插件
// 同一份、同一实例），所以颜色/尺寸/主题自适应都跟内置图标完全一致（16px，
// 颜色由 `.itemIcon` 的 `--dsw-alias-label-tertiary` 决定）。
//
// ⚠️ 依赖的 harness 内部形状（升级时若菜单没图标，先看这两处）：
//   1. `ctx.inputTriggers.live.sources` —— 注册源清单（`input-trigger` 的服务实例属性）；
//   2. `ctx.slots.register(...)`（名 `command`）的 `src.candidates` 属性被取值后调用。
// 两处都失效时本文件**只是没有图标**，不会影响 /approval 命令本身（下面每个分支都兜住）。
window.__ModuleLoader__.load({
  id: "dsh-auto-approval",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    /** 要补图标的 Host 命令名 → 图标组件（盾牌：与"审批/权限"语义一致）。 */
    const ICON_BY_COMMAND = {
      approval: primitives.IconShieldOutline16,
    };
    /** 包裹标记挂在服务上（而不是模块级变量）：窗口重载后同一服务不会重复包一层。 */
    const WRAPPED = "__dshApprovalIconWrapped";

    /**
     * 给一个 slash 源包一层：候选行里匹配到的命令补 icon。
     * @param {object} src - 注册在 input-trigger 上的源（形如 `{trigger:"/", name:"command", candidates}`）
     * @returns {boolean} 是否真的包上了（没包上不影响任何既有行为）
     */
    function wrapSource(src) {
      if (!src || src.trigger !== "/" || src.name !== "command") return false
      if (src.__dshIconWrapped === true) return false
      const original = src.candidates
      // 只有"确实是个函数"才动它：harness 换形状时这里直接放弃，绝不把异常抛给菜单
      if (typeof original !== "function") return false
      const wrapped = async function (session, req) {
        const rows = await original.call(this, session, req)
        if (!Array.isArray(rows)) return rows
        let touched = false
        const next = rows.map((row) => {
          if (!row || row.icon !== undefined) return row
          const icon = ICON_BY_COMMAND[row.name]
          if (icon === undefined) return row
          touched = true
          return Object.assign({}, row, { icon })
        })
        return touched ? next : rows
      }
      src.candidates = wrapped
      // 非枚举标记：`rankByName` 之类只读已知字段的逻辑不会受影响
      Object.defineProperty(src, "__dshIconWrapped", { value: true, enumerable: false, configurable: true })
      return true
    }

    exports.inject = ["inputTriggers"];
    exports.apply = function apply(ctx) {
      // 图标是**纯装饰**：任何一步不成立都只是"没有图标"，绝不能让宿主插件失效。
      try {
        const svc = ctx.inputTriggers
        const live = svc && svc.live
        if (live && Array.isArray(live.sources)) {
          // ① 已经注册的源（本插件挂载时 ui-commands 通常已经注册好 slash 源）
          for (const src of live.sources) wrapSource(src)
          // ② 之后才注册的源：包一层 registerSource（只包一次，用标记防重复挂载）
          if (svc[WRAPPED] !== true && typeof svc.registerSource === "function") {
            const originalRegister = svc.registerSource.bind(svc)
            svc.registerSource = function (src) {
              const off = originalRegister(src)
              wrapSource(src)
              return off
            }
            Object.defineProperty(svc, WRAPPED, { value: true, enumerable: false, configurable: true })
            ctx.effect(
              () => () => { svc.registerSource = originalRegister },
              "dsh-auto-approval: palette icon wrapper"
            )
          }
        }
      } catch (e) {
        try {
          console.warn("[dsh-auto-approval] 指令菜单图标接线失败（仅影响图标）：", e)
        } catch { /* 控制台不可用 */ }
      }
    };
    return module.exports;
  },
});
