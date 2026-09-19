// browser 半身：给 Host 侧注册的 /approval 命令补上指令菜单里的图标。
// Host 命令描述符白名单冻结（写 icon 会被丢掉），而注册同名 contribution 会让 ui-commands
// 抛错、整个「指令」分组消失 ⇒ 只能在候选行返回后给 /approval 那一行补一个 icon 字段。
// 依赖形状：ctx.inputTriggers.live.sources 与 ctx.slots.register(...) 的 src.candidates。
window.__ModuleLoader__.load({
  id: "dsh-auto-approval",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    /** 要补图标的 Host 命令名 → 图标组件（盾牌）。 */
    const ICON_BY_COMMAND = {
      approval: primitives.IconShieldOutline16,
    };
    const WRAPPED = "__dshApprovalIconWrapped";

    /** 给一个 slash 源包一层：候选行里匹配到的命令补 icon；返回是否真的包上了。 */
    function wrapSource(src) {
      if (!src || src.trigger !== "/" || src.name !== "command") return false
      if (src.__dshIconWrapped === true) return false
      const original = src.candidates
      // 只有"确实是个函数"才动它：harness 换形状时直接放弃，绝不把异常抛给菜单
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
      // 非枚举标记：只读已知字段的逻辑不会受影响
      Object.defineProperty(src, "__dshIconWrapped", { value: true, enumerable: false, configurable: true })
      return true
    }

    exports.inject = ["inputTriggers"];
    exports.apply = function apply(ctx) {
      // 图标是纯装饰：任何一步不成立都只是"没有图标"，绝不能让宿主插件失效。
      try {
        const svc = ctx.inputTriggers
        const live = svc && svc.live
        if (live && Array.isArray(live.sources)) {
          for (const src of live.sources) wrapSource(src)
          // 之后才注册的源：包一层 registerSource（带标记防重复挂载）
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
