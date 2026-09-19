// browser 半身（手写，与官方 dsh-client-ui-* 相同的 ModuleLoader 自加载格式）：
// 把"桌面"section 注册进 DSH 设置面板的 settings.section 插槽，
// 经壳 admin API（固定回环端口 + CORS）读写：开机自启 / 关闭到托盘 / 工作区 / 状态。
window.__ModuleLoader__.load({
  id: "dsh-desktop-ui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const { useState, useEffect } = react;
    // 官方原语（种子模块，前端已内建；与官方 dsh-client-ui-* 用的是同一份）。
    // ⚠️ 必须在 **factory 顶部**就取好，不能挪到后面、更不能只在 apply() 里 require ——
    //    模块体里用到却只在 apply() 里声明过，就是"整页 Failed to load plugins"那类
    //    装载期 ReferenceError 的根因；门禁也按"顶部 require"守这一条。
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    const ADMIN = "http://127.0.0.1:25439"; // 壳 admin API（单实例固定端口；headless 回退时不可达会显示"壳未响应"）

    // timeoutMs=0 表示不设超时（用于会弹系统对话框、等待时间不可控的请求）
    async function post(path, body, timeoutMs = 4000) {
      try {
        const r = await fetch(ADMIN + path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body || {}),
          signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
        });
        return r.ok ? await r.json() : null;
      } catch {
        return null;
      }
    }

    function useAdminStatus() {
      const [st, setSt] = useState(null);
      useEffect(() => {
        let alive = true;
        const tick = async () => {
          try {
            const r = await fetch(ADMIN + "/api/status", { signal: AbortSignal.timeout(3000) });
            if (alive && r.ok) setSt(await r.json());
            else if (alive) setSt(null);
          } catch {
            if (alive) setSt(null);
          }
        };
        tick();
        const timer = setInterval(tick, 5000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, []);
      return st;
    }

    // 主题中立样式：只用官方 CSS 变量（label-primary / interactive-bg-hover / bg-layer-2），
    // 边框用 color-mix 从主文字色派生，深浅色主题自适应。
    const border = "1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent)";
    const css = {
      section: { display: "flex", flexDirection: "column", gap: "14px", width: "100%" },
      row: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", minHeight: "40px" },
      kv: { display: "flex", flexDirection: "column", gap: "2px", minWidth: "0" },
      label: { color: "var(--dsw-alias-label-primary)", fontSize: "14px", lineHeight: "20px" },
      hint: { color: "color-mix(in srgb, var(--dsw-alias-label-primary) 55%, transparent)", fontSize: "12px", lineHeight: "18px" },
      input: { flex: "1", minWidth: "0", color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-layer-2)", border, borderRadius: "8px", padding: "6px 10px", fontSize: "13px" },
      // 按钮基底 = 透明（ghost 风，与设置面板其他按钮一致）；悬停/按下高亮由
      // apply() 注入的 .dsh-desktop-btn 样式表完成（--dsw-alias-interactive-bg-hover/-active）
      button: { cursor: "pointer", color: "var(--dsw-alias-label-primary)", background: "transparent", border, borderRadius: "8px", padding: "6px 12px", fontSize: "13px", whiteSpace: "nowrap" },
      // （原 checkbox 样式已随「开/关」按钮化一并删除——两处勾选框都改成左右按钮后它没有使用者了。
      //   留着它只会让下一个人以为这里还有勾选框，见"无使用者的样式就是误导"。）
      // 选中态按钮：与 button 同尺寸，只把底色换成悬停色——二选一的模式按钮靠它表示"当前用的是哪个"。
      buttonOn: { cursor: "pointer", color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-interactive-bg-hover)", border, borderRadius: "8px", padding: "6px 12px", fontSize: "13px", whiteSpace: "nowrap" },
      // 不可用态：与可点按钮同尺寸，只降透明度——换尺寸会让整行在状态切换时跳动。
      buttonOff: { cursor: "not-allowed", color: "var(--dsw-alias-label-primary)", background: "transparent", border, borderRadius: "8px", padding: "6px 12px", fontSize: "13px", whiteSpace: "nowrap", opacity: "0.45" },
      mono: { fontFamily: "ui-monospace, Consolas, monospace", fontSize: "12px", color: "color-mix(in srgb, var(--dsw-alias-label-primary) 55%, transparent)", wordBreak: "break-all" },
      actions: { display: "flex", gap: "8px", paddingTop: "4px" },
      msg: { fontSize: "12px", color: "color-mix(in srgb, var(--dsw-alias-label-primary) 70%, transparent)" },
      // 构建进度条：构建约 8 分钟，没有它用户只能干等
      progressRow: { display: "flex", alignItems: "center", gap: "10px", width: "100%", paddingTop: "2px" },
      progressTrack: { flex: "1", minWidth: "80px", height: "6px", borderRadius: "999px", background: "color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent)", overflow: "hidden" },
      progressFill: { height: "100%", borderRadius: "999px", background: "var(--dsw-alias-brand-primary, #3964fe)", transition: "width 0.4s ease" },
      progressLabel: { fontSize: "12px", color: "color-mix(in srgb, var(--dsw-alias-label-primary) 70%, transparent)", whiteSpace: "nowrap", flex: "none" },
    };

    // 构建已用时间。构建是分钟级，用户真正想知道的是"等了多久"——这个数字比百分比更实在，
    // 因为 npm 不吐精确进度，百分比只是按包数估算的刻度。
    function fmtElapsed(ms) {
      if (typeof ms !== "number" || ms < 0) return "";
      const s = Math.floor(ms / 1000);
      if (s < 60) return `${s} 秒`;
      return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
    }

    function fmtUptime(sec) {
      if (!sec) return "-";
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      return h > 0 ? `${h} 小时 ${m} 分钟` : `${m} 分钟`;
    }

    // DSH 更新行的可用性与文案**全部由 /api/status 的快照推导**，客户端不自建状态机：
    // 构建是壳里的分钟级后台任务，壳可能中途重启，两边各存一份状态必然不一致。
    // 快照字段来自 main.mjs 的 dshUpdateSnapshot()，其中 hint 已是可直接显示的中文。
    function dshInfo(st) {
      const u = st && st.dshUpdate ? st.dshUpdate : null;
      if (!u) return { hint: "—", canCheck: false, canUpdate: false, canApply: false, busy: false, needsConfirm: false, blocked: false };
      const busy = u.phase === "building" || u.phase === "checking" || u.phase === "applying";
      const npmOk = u.npmOk !== false;
      const needsConfirm = u.needsConfirm === true;
      // 兼容性守卫：壳算出"这个目标版本在本机 Electron 上确定跑不起来"时置 blocked。
      // 它必须**禁掉按钮**而不是只提示一句——否则用户点下去就是一次 255 MB 安装 + 90 秒等待，
      // 最后只换来一句"宿主提前退出（code=1）"。原因由壳写进 hint（含该怎么解决）。
      const blocked = !!(u.compat && u.compat.blocked === true);
      const p = u.progress || null;
      const showProgress = u.phase === "building" && p !== null && typeof p.percent === "number";
      return {
        hint: u.hint || "—",
        busy: busy,
        needsConfirm: needsConfirm,
        blocked: blocked,
        // 进度：label 说明"现在在做什么"（安装依赖 N/M 个包 / 剪枝 / ABI 门禁 / 启动门禁），
        // percent 只是按包数估算的刻度，elapsed 才是用户真正等的那个数。
        showProgress: showProgress,
        percent: p !== null && typeof p.percent === "number" ? p.percent : 0,
        stepLabel: p !== null && p.label ? p.label : "",
        elapsed: fmtElapsed(u.elapsedMs),
        // 跨版本升级**不能**因为 needsConfirm 就把按钮禁掉：那样等于没有确认入口
        // （守卫要的 allowUnsafeJump 只能由这个按钮在确认后代传）。按钮改标签、点击后弹确认。
        // 但"本机 Electron 跑不起来"（blocked）不在此列：那是**确定失败**，不是"要不要冒险"，
        // 所以照旧禁掉（理由已在 hint 里写全）。
        canCheck: !busy && npmOk,
        canUpdate: !busy && npmOk && !blocked && u.hasUpdate === true && u.pending !== true,
        canApply: !busy && (u.pending === true || u.phase === "ready"),
      };
    }

    // 左侧栏遮罩默认值。注意「左侧栏永远比主页面更不透明」是**硬约束**，靠下面的 max 保证——
    // 默认值本身挡不住用户把对话区遮罩拖到 0.9，那时侧栏反而会比主页面更透。
    const SIDEBAR_OPACITY_DEFAULT = 0.45;
    const clamp01 = (raw, dflt) => {
      const n = Number(raw);
      return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : dflt;
    };

    // 把壳设置里的遮罩透明度写进 CSS 变量。样式表只读变量、不关心来源，于是
    // "改设置 → 立刻看到效果"这条链路不需要重建样式表，只要 setProperty。
    function applySkinVars(st) {
      if (!st || typeof document === "undefined") return;
      const root = document.documentElement;
      const put = (name, raw, dflt) => root.style.setProperty(name, String(clamp01(raw, dflt)));
      put("--dsh-rail-mask-opacity", st.railMaskOpacity, 0.35);
      const conv = clamp01(st.conversationMaskOpacity, 0.25);
      root.style.setProperty("--dsh-conversation-mask-opacity", String(conv));
      // 右侧栏**全屏态**的独立遮罩：全屏时面板铺满视口、正文直接压在壁纸上，
      // 沿用对话区那档（默认 0.25）读起来太费劲，所以它自己一个值（默认 0.8）。
      put("--dsh-fullscreen-mask-opacity", st.fullscreenMaskOpacity, 0.8);
      // 左侧栏遮罩：取 max，保证它不会比主页面（即对话区那一层）更透。
      root.style.setProperty("--dsh-sidebar-opacity", String(Math.max(clamp01(st.sidebarOpacity, SIDEBAR_OPACITY_DEFAULT), conv)));
      // 只有「独立图片」模式才把图铺给左侧栏；「延伸主背景」留 none，让 body::before 的壁纸透出来。
      // URL **必须**带版本串。初版这里刻意不带，理由是"壳侧是 Cache-Control: no-store，够用了"
      // ——那个理由是错的，实测踩了：**URL 不变时浏览器认为 background-image 没有变化，
      // 压根不会重新发请求**，no-store 也就永远没机会起作用。症状是"已经有图片时换一张，
      // 界面毫无反应"。
      //   ?p= 图片路径：路径一变 URL 就变，**不依赖新壳**也能立刻生效；
      //   ?t= 图片 mtime：连"同一个路径的文件被换掉内容"也认得出（需新壳提供该字段）。
      // 两个参数壳端都不解析，纯粹用来破缓存；每 5 秒轮询时值不变则 URL 不变，不会反复重取。
      const own = String(st.sidebarBgMode || "extend") === "own" && !!st.sidebarBgImage;
      const cacheKey = own
        ? `?p=${encodeURIComponent(st.sidebarBgImage)}&t=${Number(st.sidebarBgImageVersion) || 0}`
        : "";
      root.style.setProperty("--dsh-sidebar-bg-image", own ? `url("${ADMIN}/sidebar-image${cacheKey}")` : "none");
    }

    function StatusRow({ k, v }) {
      return react.createElement(
        "div",
        { style: css.row },
        react.createElement("span", { style: css.label }, k),
        react.createElement("span", { style: css.mono }, v)
      );
    }

    // 「开机自启 / 最小化到托盘」用的开关：**官方 `primitives.Switch`**（苹果那种圆角胶囊 + 白色圆点），
    // 不自造 —— 观感、键盘可达性（它是 `role="switch"` 的 button）、深浅色主题都跟官方设置面板一致。
    // 为什么这里要包一层：点下去要**立刻显形**，而壳的真实状态要等 5 秒轮询才回来，
    // 所以先本地乐观一次，轮询回来用壳的值（`checked` 是受控的，本地值到那时被覆盖）。
    // label 不能省：官方的 `label` 是 `aria-label`，省了开关就没有可读名（无障碍 + 自动化取证都要它）。
    function ToggleSwitch({ on, label, post }) {
      const [local, setLocal] = useState(null);
      const checked = local === null ? on : local;
      return react.createElement(primitives.Switch, {
        checked,
        label,
        onChange: async (next) => {
          setLocal(next);
          await post(next);
        },
      });
    }

    // 把一行控件折成「▾ 标题」收纳项：分组只借官方的 DisclosureRow（不自己画箭头/折叠），
    // 保证展开态、键盘可达性与官方设置面板一致。
    function DisclosureGroup({ title, open, onToggle, children }) {
      const rows = (Array.isArray(children) ? children : [children]).filter(Boolean);
      return react.createElement(
        primitives.DisclosureRow,
        { title, open, onToggle, expandable: true },
        ...rows
      );
    }

    // 「个性化」栏：外观类设置（背景与各处遮罩）。从「桌面」拆出来是因为那一栏现在混着
    // 功能开关（自启/托盘/工作区）与外观两类东西；拆开后各自内聚，名字也更直白。
    function PersonalizeSection() {
      const st = useAdminStatus();
      const [msg, setMsg] = useState("");
      // 「▾ 遮罩」收纳栏的展开态。
      const [maskOpen, setMaskOpen] = useState(false);
      // 左侧栏模式/图片的本地快照，见下面 sideMode/sideImg 的说明
      const [sideLocal, setSideLocal] = useState(null);
      const setMsgOk = (r) => setMsg(r && r.ok ? "已生效" : "操作失败（壳未响应？）");
      if (!st) {
        return react.createElement(
          "div",
          { style: css.section },
          react.createElement("span", { style: css.hint }, "正在连接桌面壳…（若持续显示，请从托盘重新启动应用）")
        );
      }
      // 左侧栏那两个值的"本地快照"：改完立刻重取一次 /api/status 并存在这里，
      // 显示就不必等满 5 秒轮询（点一下要马上看见，这是外观设置的基本手感）。
      // 只影子化侧栏自己的字段，其余字段照旧读 st，避免盖掉别处刚改的值。
      // 生效值 = max(设置值, 对话区遮罩)，与 applySkinVars 同一套算法——
      // 面板上显示的数字必须就是屏幕上渲染的那个，否则用户会以为滑块坏了。
      const sideMode = sideLocal ? sideLocal.mode : String(st.sidebarBgMode || "extend");
      const sideImg = sideLocal ? sideLocal.image : String(st.sidebarBgImage || "");
      const sideOwn = sideMode === "own";
      const sideEff = Math.max(clamp01(st.sidebarOpacity, SIDEBAR_OPACITY_DEFAULT), clamp01(st.conversationMaskOpacity, 0.25));
      // 改完立刻重取快照并重写 CSS 变量：壳已经把新值落盘了，这里只是不等那 5 秒。
      const refreshSkin = async () => {
        try {
          const r = await fetch(ADMIN + "/api/status", { signal: AbortSignal.timeout(3000) });
          if (r.ok) applySkinVars(await r.json());
        } catch { /* 壳未响应：保持现状 */ }
      };
      const chooseSideMode = async (mode) => {
        setSideLocal({ mode, image: sideImg });
        const r = await post("/api/settings", { sidebarBgMode: mode });
        setMsgOk(r);
        if (r && r.ok) await refreshSkin();
      };
      return react.createElement(
        "div",
        { style: css.section },
        react.createElement(
          "div",
          { style: css.row },
          react.createElement(
            "div",
            { style: css.kv },
            react.createElement("span", { style: css.label }, "背景图片"),
            react.createElement("span", { style: css.hint }, st.backgroundImage || "未设置（建议选深色图片，文字更清晰）")
          ),
          react.createElement(
            "button",
            {
              style: css.button,
              className: "dsh-desktop-btn",
              onClick: async () => {
                // 文件选择是模态交互，等待时间不可控——不设超时
                const r = await post("/api/pick-background", {}, 0);
                setMsg(r && r.ok ? (r.path ? "背景已更换" : "未选择图片") : "操作失败（壳未响应？）");
              },
            },
            "浏览…"
          ),
          react.createElement(
            "button",
            { style: css.button, className: "dsh-desktop-btn", onClick: async () => setMsgOk(await post("/api/background", { path: "" })) },
            "清除"
          )
        ),
        react.createElement(
          "div",
          { style: css.row },
          react.createElement(
            "div",
            { style: css.kv },
            react.createElement("span", { style: css.label }, "背景亮度"),
            react.createElement("span", { style: css.hint, id: "dsh-bg-brightness-val" }, `${Number(st.bgBrightness ?? 1).toFixed(2)}×（0.20 更暗 ~ 2.00 更亮）`)
          ),
          react.createElement("input", {
            type: "range", min: "0.2", max: "2", step: "0.05",
            defaultValue: String(st.bgBrightness ?? 1),
            "aria-label": "背景亮度",
            style: { width: "180px", accentColor: "var(--dsw-alias-brand-primary, #3964fe)" },
            onInput: (e) => {
              const v = Number(e.target.value)
              const el = document.getElementById("dsh-bg-brightness-val")
              if (el) el.textContent = `${v.toFixed(2)}×（0.20 更暗 ~ 2.00 更亮）`
              post("/api/settings", { bgBrightness: v })
            },
          })
        ),
        react.createElement(
          "div",
          { style: css.row },
          react.createElement(
            "div",
            { style: css.kv },
            react.createElement("span", { style: css.label }, "背景模糊"),
            react.createElement("span", { style: css.hint, id: "dsh-bg-blur-val" }, `${st.bgBlur ?? 0} px（0 清晰 ~ 40 最糊）`)
          ),
          react.createElement("input", {
            type: "range", min: "0", max: "40", step: "1",
            defaultValue: String(st.bgBlur ?? 0),
            "aria-label": "背景模糊",
            style: { width: "180px", accentColor: "var(--dsw-alias-brand-primary, #3964fe)" },
            onInput: (e) => {
              const v = Number(e.target.value)
              const el = document.getElementById("dsh-bg-blur-val")
              if (el) el.textContent = `${v} px（0 清晰 ~ 40 最糊）`
              post("/api/settings", { bgBlur: v })
            },
          })
        ),
        // 「▾ 遮罩」：把三处遮罩收进一个向下展开栏位。
        // 只改分组与呈现，滑杆的取值/写盘/CSS 变量一律不动 —— 那几件是"用户的选择"，不许顺手改。
        react.createElement(
          DisclosureGroup,
          { title: "遮罩", open: maskOpen, onToggle: () => setMaskOpen(!maskOpen) },
          // 右侧轮次标记轨（"多条状跳转小组件"）的竖状椭圆遮罩透明度：0 = 完全隐藏。
          react.createElement(
            "div",
            { style: css.row },
            react.createElement(
              "div",
              { style: css.kv },
              react.createElement("span", { style: css.label }, "跳转轨道遮罩"),
              react.createElement("span", { style: css.hint, id: "dsh-rail-mask-val" }, `${Number(st.railMaskOpacity ?? 0.35).toFixed(2)}（0 隐藏 ~ 1 全黑）`)
            ),
            react.createElement("input", {
              type: "range", min: "0", max: "1", step: "0.05",
              defaultValue: String(st.railMaskOpacity ?? 0.35),
              "aria-label": "右侧跳转轨道遮罩透明度",
              style: { width: "180px", accentColor: "var(--dsw-alias-brand-primary, #3964fe)" },
              onInput: (e) => {
                const v = Number(e.target.value)
                const el = document.getElementById("dsh-rail-mask-val")
                if (el) el.textContent = `${v.toFixed(2)}（0 隐藏 ~ 1 全黑）`
                // 乐观生效：不等轮询回读，先把变量写下去，拖动手感才是即时的
                document.documentElement.style.setProperty("--dsh-rail-mask-opacity", String(v))
                post("/api/settings", { railMaskOpacity: v })
              },
            })
          ),
          // 正文两侧拖动条的底层黑遮罩透明度：0 = 完全隐藏（回到改动前那种"看不见但能拖"）。
          react.createElement(
            "div",
            { style: css.row },
            react.createElement(
              "div",
              { style: css.kv },
              react.createElement("span", { style: css.label }, "对话区遮罩"),
              react.createElement("span", { style: css.hint, id: "dsh-conv-mask-val" }, `${Number(st.conversationMaskOpacity ?? 0.25).toFixed(2)}（0 隐藏 ~ 1 全黑）`)
            ),
            react.createElement("input", {
              type: "range", min: "0", max: "1", step: "0.05",
              defaultValue: String(st.conversationMaskOpacity ?? 0.25),
              "aria-label": "对话区底层遮罩透明度",
              style: { width: "180px", accentColor: "var(--dsw-alias-brand-primary, #3964fe)" },
              onInput: (e) => {
                const v = Number(e.target.value)
                const el = document.getElementById("dsh-conv-mask-val")
                if (el) el.textContent = `${v.toFixed(2)}（0 隐藏 ~ 1 全黑）`
                document.documentElement.style.setProperty("--dsh-conversation-mask-opacity", String(v))
                post("/api/settings", { conversationMaskOpacity: v })
              },
            })
          ),
          // 右侧栏**全屏态**的遮罩：单独一档、默认明显更重（0.8）。
          // 全屏时面板铺满整个视口，正文直接压在壁纸上，沿用对话区那档会透得读不清。
          react.createElement(
            "div",
            { style: css.row },
            react.createElement(
              "div",
              { style: css.kv },
              react.createElement("span", { style: css.label }, "右侧栏全屏遮罩"),
              react.createElement("span", { style: css.hint, id: "dsh-fullscreen-mask-val" }, `${Number(st.fullscreenMaskOpacity ?? 0.8).toFixed(2)}（0 隐藏 ~ 1 全黑；仅右侧栏全屏时用）`)
            ),
            react.createElement("input", {
              type: "range", min: "0", max: "1", step: "0.05",
              defaultValue: String(clamp01(st.fullscreenMaskOpacity, 0.8)),
              "aria-label": "右侧栏全屏遮罩透明度",
              style: { width: "180px", accentColor: "var(--dsw-alias-brand-primary, #3964fe)" },
              onInput: (e) => {
                const v = Number(e.target.value)
                const el = document.getElementById("dsh-fullscreen-mask-val")
                if (el) el.textContent = `${v.toFixed(2)}（0 隐藏 ~ 1 全黑；仅右侧栏全屏时用）`
                document.documentElement.style.setProperty("--dsh-fullscreen-mask-opacity", String(v))
                post("/api/settings", { fullscreenMaskOpacity: v })
              },
            })
          ),
          // 左侧栏遮罩：渲染值恒为 **max(本值, 对话区遮罩)**，所以它永远不会比主页面更透。
          // 拖动时就地按 max 显示并生效——屏幕上渲染的是 max，数字也必须是 max。
          // 
          react.createElement(
            "div",
            { style: css.row },
            react.createElement(
              "div",
              { style: css.kv },
              react.createElement("span", { style: css.label }, "左侧栏遮罩"),
              react.createElement("span", { style: css.hint, id: "dsh-sidebar-mask-val" }, `${sideEff.toFixed(2)}（0 隐藏 ~ 1 全黑；不会低于对话区遮罩）`)
            ),
            react.createElement("input", {
              type: "range", min: "0", max: "1", step: "0.05",
              defaultValue: String(clamp01(st.sidebarOpacity, SIDEBAR_OPACITY_DEFAULT)),
              "aria-label": "左侧栏遮罩透明度",
              style: { width: "180px", accentColor: "var(--dsw-alias-brand-primary, #3964fe)" },
              onInput: (e) => {
                const v = Number(e.target.value)
                const eff = Math.max(v, clamp01(st.conversationMaskOpacity, 0.25))
                const el = document.getElementById("dsh-sidebar-mask-val")
                if (el) el.textContent = `${eff.toFixed(2)}（0 隐藏 ~ 1 全黑；不会低于对话区遮罩）`
                // 乐观生效：写下去的就是 max 后的值，和样式表读到的是同一个数
                document.documentElement.style.setProperty("--dsh-sidebar-opacity", String(eff))
                post("/api/settings", { sidebarOpacity: v })
              },
            })
          )
        ),
        // 左侧栏背景：模式二选一。两种模式共用同一条 CSS（侧栏铺一层黑纱，
        // 「独立图片」时纱下再叠自己的图）——所以切换只是换一个 CSS 变量，不重建样式表。
        react.createElement(
          "div",
          { style: css.row },
          react.createElement(
            "div",
            { style: css.kv },
            react.createElement("span", { style: css.label }, "左侧栏背景"),
            react.createElement("span", { style: css.hint }, sideOwn ? "独立图片（用下面选的那张）" : "延伸主页面壁纸")
          ),
          react.createElement("button", { style: sideOwn ? css.button : css.buttonOn, className: "dsh-desktop-btn", onClick: () => chooseSideMode("extend") }, "延伸主背景"),
          react.createElement("button", { style: sideOwn ? css.buttonOn : css.button, className: "dsh-desktop-btn", onClick: () => chooseSideMode("own") }, "独立图片")
        ),
        react.createElement(
          "div",
          { style: css.row },
          react.createElement(
            "div",
            { style: css.kv },
            react.createElement("span", { style: css.label }, "左侧栏图片"),
            react.createElement("span", { style: css.hint }, sideImg || "未设置（仅「独立图片」模式使用）")
          ),
          react.createElement(
            "button",
            {
              style: css.button,
              className: "dsh-desktop-btn",
              onClick: async () => {
                // 文件选择是模态交互，等待时间不可控——不设超时
                const r = await post("/api/pick-sidebar-background", {}, 0);
                if (r && r.ok && r.path) {
                  setSideLocal({ mode: "own", image: r.path });
                  await refreshSkin();
                  setMsg("左侧栏图片已更换");
                } else setMsg(r && r.ok ? "未选择图片" : "操作失败（壳未响应？）");
              },
            },
            "浏览…"
          ),
          react.createElement(
            "button",
            {
              style: css.button,
              className: "dsh-desktop-btn",
              onClick: async () => {
                const r = await post("/api/sidebar-background", { path: "" });
                setSideLocal({ mode: sideMode, image: "" });
                setMsgOk(r);
                if (r && r.ok) await refreshSkin();
              },
            },
            "清除"
          )
        ),
        // 左侧栏遮罩已移入上面的「▾ 遮罩」分组（它同样是遮罩；这里只留侧栏背景相关三行）
        react.createElement("span", { style: css.msg }, msg)
      );
    }

    function DesktopSection() {
      const st = useAdminStatus();
      const [ws, setWs] = useState("");
      const [msg, setMsg] = useState("");
      useEffect(() => {
        if (st && st.ws && ws === "") setWs(st.ws);
      }, [st]);
      // 把轮询到的两个遮罩透明度同步进 CSS 变量：改滑块后下一个 5 秒轮询就会回读确认，
      // 所以滑块只管乐观地本地生效 + POST，不需要在客户端自存一份状态。
      useEffect(() => { applySkinVars(st); }, [st]);
      const setMsgOk = (r) => setMsg(r && r.ok ? "已生效" : "操作失败（壳未响应？）");
      // 更新行的可用性在渲染前一次算好（st 为 null 时 dshInfo 返回全不可用，天然安全）。
      const di = dshInfo(st);
      // 平面 C 的本地状态：**刻意不进 /api/status**（那是 5 秒轮询的只读快照，塞联网结果进去
      // 等于每 5 秒打一次 GitHub）。这里只记"上次点的结果"，需要新信息就再点一次。
      const [repoBusy, setRepoBusy] = useState(false);
      const [repoInfo, setRepoInfo] = useState("按仓库 components.json 补/换功能文件（自带插件、补丁层、市场目录）");
      const repoCheck = async () => {
        setRepoBusy(true);
        setRepoInfo("正在比对仓库清单…");
        try {
          const r = await post("/api/repo-update/check", {}, 30000);
          setRepoInfo(r && r.ok ? `${r.message}（${r.coords}）` : `检查失败：${(r && r.error) || "壳未响应"}`);
        } catch (e) {
          setRepoInfo(`检查失败：${(e && e.message) || "网络不可达"}`);
        } finally {
          setRepoBusy(false);
        }
      };
      const repoApply = async () => {
        setRepoBusy(true);
        setRepoInfo("正在从仓库更新…（只下缺的/变了的文件）");
        try {
          // 超时给足：这一调用包含下载 + 校验 + 落盘 + **重启宿主**（宿主冷启动 ~16s）
          const r = await post("/api/repo-update/apply", {}, 120000);
          if (r && r.ok) setRepoInfo(r.message || "已更新");
          else if (r && Array.isArray(r.failed) && r.failed.length > 0) setRepoInfo(`部分失败：${r.failed.map((f) => `${f.id}：${f.error}`).join("；")}`);
          else setRepoInfo(`更新失败：${(r && r.error) || "壳未响应"}`);
        } catch (e) {
          setRepoInfo(`更新失败：${(e && e.message) || "网络不可达"}`);
        } finally {
          setRepoBusy(false);
        }
      };

      if (!st) {
        return react.createElement(
          "div",
          { style: css.section },
          react.createElement("span", { style: css.hint }, "正在连接桌面壳…（若持续显示，请从托盘重新启动应用）")
        );
      }
      // ⚠️ `st.xxx` 一律只能在**这道 null 守卫之后**读：首帧 st 是 null，
      //    读早了就是 `Cannot read properties of null (reading 'autostart')`，
      //    整个「桌面」栏会被 React 卸载（2026-09-17 实测：控制台 `slot entry crashed in 'settings.section'`）。
      return react.createElement(
        "div",
        { style: css.section },
        react.createElement(
          "div",
          { style: css.row },
          react.createElement(
            "div",
            { style: css.kv },
            react.createElement("span", { style: css.label }, "开机自启"),
            react.createElement("span", { style: css.hint }, "登录后自动启动本应用")
          ),
          react.createElement(ToggleSwitch, {
            on: !!st.autostart,
            label: "开机自启",
            post: async (v) => setMsgOk(await post("/api/autostart", { on: v })),
          })
        ),
        react.createElement(
          "div",
          { style: css.row },
          react.createElement(
            "div",
            { style: css.kv },
            react.createElement("span", { style: css.label }, "关闭窗口时最小化到托盘"),
            react.createElement("span", { style: css.hint }, "关闭后应用保持后台运行，托盘图标可重新打开")
          ),
          react.createElement(ToggleSwitch, {
            on: st.minimizeToTray !== false,
            label: "关闭窗口时最小化到托盘",
            post: async (v) => setMsgOk(await post("/api/settings", { minimizeToTray: v })),
          })
        ),
        react.createElement(
          "div",
          { style: css.row },
          react.createElement(
            "div",
            { style: css.kv },
            react.createElement("span", { style: css.label }, "Agent 工作区"),
            react.createElement("span", { style: css.hint }, "工具读写文件的默认目录")
          ),
          react.createElement("input", {
            style: css.input,
            value: ws,
            onChange: (e) => setWs(e.target.value),
          }),
          react.createElement(
            "button",
            {
              style: css.button,
              className: "dsh-desktop-btn",
              onClick: async () => {
                // 目录选择是模态交互，等待时间不可控——不设超时；
                // 服务端选完即落地工作区（applied），客户端只回显。
                const r = await post("/api/pick-directory", {}, 0);
                if (r && r.path) {
                  setWs(r.path);
                  setMsg(r.applied ? "已生效" : "已选择，点“应用”确认");
                } else setMsg("未选择目录");
              },
            },
            "浏览…"
          ),
          react.createElement(
            "button",
            { style: css.button, className: "dsh-desktop-btn", onClick: async () => setMsgOk(await post("/api/workspace", { path: ws.trim() })) },
            "应用"
          )
        ),
        // DSH（harness）更新：与下面的「壳版本」状态行成对——两个更新平面措辞不同、互不混淆。
        // 「更新」点击后壳**立即返回**并转后台构建（分钟级），进度靠已有的 5 秒 status 轮询回显，
        // 所以这里绝不能 await 到构建结束（会撞 4 秒超时并挂住整行）。
        react.createElement(
          "div",
          { style: css.row },
          react.createElement(
            "div",
            { style: css.kv },
            react.createElement("span", { style: css.label }, "DSH 版本"),
            react.createElement("span", { style: css.hint }, di.hint)
          ),
          react.createElement(
            "button",
            {
              style: di.canCheck ? css.button : css.buttonOff,
              className: "dsh-desktop-btn",
              disabled: !di.canCheck,
              onClick: async () => {
                setMsg("正在检查更新…");
                const r = await post("/api/dsh/check", {}, 15000);
                setMsg(r && r.ok ? "检查完成" : (r && r.error) || "检查失败（网络不可达？）");
              },
            },
            "检查更新"
          ),
          react.createElement(
            "button",
            {
              style: di.canUpdate ? css.button : css.buttonOff,
              className: "dsh-desktop-btn",
              disabled: !di.canUpdate,
              onClick: async () => {
                // 跨版本升级：守卫要求人显式确认，而"带 allowUnsafeJump"这件事**只能由这里做**
                // ——原实现只说参数名，界面又不传，等于把用户永久卡死。
                const risk = di.needsConfirm;
                if (risk) {
                  const u = st.dshUpdate || {};
                  const reason = (u.jump && u.jump.reason) || "版本号位变更";
                  const okGo = window.confirm(
                    "这一步属于跨版本升级：\n\n  " + (u.current || "?") + "  →  " + (u.target || "?") +
                    "\n\n" + reason +
                    "\n\n这类升级可能改变壳与 DSH 的交互合同（历史上出过应用起不来的事故，需要手工恢复）。\n" +
                    "更新会先构建到暂存区，不会立刻替换正在运行的版本。\n\n确定要继续吗？"
                  );
                  if (!okGo) { setMsg("已取消跨版本更新"); return; }
                }
                const r = await post("/api/dsh/update", { allowUnsafeJump: risk === true }, 15000);
                setMsg(r && r.ok ? "已开始构建（分钟级，请勿关闭应用）" : (r && r.error) || "无法开始更新");
              },
            },
            di.blocked ? "当前壳不支持" : (di.needsConfirm ? "更新（跨版本）" : "更新")
          ),
          react.createElement(
            "button",
            {
              style: di.canApply ? css.button : css.buttonOff,
              className: "dsh-desktop-btn",
              disabled: !di.canApply,
              onClick: async () => {
                // 壳会在响应之后重启，fetch 多半以失败告终——那是预期而非错误，故刻意不报错。
                setMsg("正在重启应用以应用更新…");
                await post("/api/dsh/apply");
              },
            },
            "重启并应用"
          )
        ),
        // 平面 C：「从仓库更新功能」——与上面那条（DSH 依赖树）、下面那条（壳安装包）刻意分成三行，
        // 措辞互不混淆。它不换安装包、不换 DSH，只把仓库里**新增/变化的功能文件**补到本地：
        // 自带插件（桌面 UI / 自动审批 / 市场）、宿主补丁层、市场目录。点「更新」会顺带重启宿主让
        // 插件半身重新加载（宿主重启期间界面会自己重连，不会把设置面板关掉）。
        react.createElement(
          "div",
          { style: css.row },
          react.createElement(
            "div",
            { style: css.kv },
            react.createElement("span", { style: css.label }, "仓库功能更新"),
            react.createElement("span", { style: css.hint }, repoInfo)
          ),
          react.createElement(
            "button",
            {
              style: repoBusy ? css.buttonOff : css.button,
              className: "dsh-desktop-btn",
              disabled: repoBusy,
              onClick: repoCheck,
            },
            "检查"
          ),
          react.createElement(
            "button",
            {
              style: repoBusy ? css.buttonOff : css.button,
              className: "dsh-desktop-btn",
              disabled: repoBusy,
              onClick: repoApply,
            },
            repoBusy ? "处理中…" : "更新"
          )
        ),
        di.showProgress && react.createElement(
          "div",
          { style: css.progressRow },
          react.createElement(
            "div",
            { style: css.progressTrack },
            react.createElement("div", { style: Object.assign({}, css.progressFill, { width: di.percent + "%" }) })
          ),
          react.createElement(
            "span",
            { style: css.progressLabel },
            di.percent + "%  " + di.stepLabel + (di.elapsed ? "（已用 " + di.elapsed + "）" : "")
          )
        ),
        StatusRow({ k: "壳版本", v: `${st.version}（Electron ${st.electron} / Node ${st.node}）` }),
        StatusRow({ k: "DSH 数据目录", v: st.home || "-" }),
        StatusRow({ k: "工作区", v: st.ws || "-" }),
        StatusRow({ k: "运行时长", v: fmtUptime(st.uptimeSec) }),
        StatusRow({ k: "宿主重启次数", v: String(st.restarts ?? 0) }),
        react.createElement(
          "div",
          { style: css.actions },
          react.createElement("button", { style: css.button, className: "dsh-desktop-btn", onClick: async () => setMsgOk(await post("/api/open-data-dir")) }, "打开数据目录"),
          react.createElement("button", { style: css.button, className: "dsh-desktop-btn", onClick: async () => setMsgOk(await post("/api/focus")) }, "回到会话"),
          react.createElement("button", { style: css.button, className: "dsh-desktop-btn", onClick: async () => { await post("/api/quit"); } }, "退出应用")
        ),
        react.createElement("span", { style: css.msg }, msg)
      );
    }

    exports.inject = ["slots"];
    exports.apply = function apply(ctx) {
      ctx.slots.inject(
        "settings.section",
        () =>
          ctx.slots.register(
            {
              name: "settings.section",
              id: "desktop",
              order: 100,
              label: () => "桌面",
            },
            DesktopSection
          )
      );
      // 外观类设置独立成栏：order 排在「桌面」之前，符合"先调外观、后调功能"的使用顺序。
      ctx.slots.inject(
        "settings.section",
        () =>
          ctx.slots.register(
            {
              name: "settings.section",
              id: "personalize",
              order: 90,
              label: () => "个性化",
            },
            PersonalizeSection
          )
      );
      // 接管官方"打开配置文件"按钮（settings.action 插槽禁止同 id 注册，
      // 官方实现依赖 powershell Invoke-Item 与文件关联，失败即无响应）：
      // 捕获阶段拦截点击，改为经壳 admin API 的确定性打开（shell.openPath + 记事本兜底）。
      const openDocument = async () => {
        try {
          const r = await fetch(ADMIN + "/api/open-settings-document", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
            signal: AbortSignal.timeout(5000),
          });
          if (!r.ok) throw new Error("HTTP " + r.status);
        } catch (e) {
          if (typeof window !== "undefined" && window.alert) window.alert("桌面壳未响应，无法打开配置文件");
        }
      };
      const onDocClick = (event) => {
        const target = event.target;
        const btn = target && target.closest ? target.closest("button") : null;
        if (!btn) return;
        const label = btn.textContent || "";
        if (!(label.includes("打开配置文件") || label.includes("Open configuration file"))) return;
        event.preventDefault();
        event.stopPropagation();
        void openDocument();
      };
      document.addEventListener("click", onDocClick, true);
      ctx.effect(() => () => document.removeEventListener("click", onDocClick, true), "dsh-desktop-ui: open-document intercept");
      // 按钮人机交互样式：与设置面板其他按钮一致（ghost 基底 + 悬停/按下高亮）。
      // hover/active 用 !important 覆盖行内 base 背景；focus-visible 保键盘可用性。
      const styleEl = document.createElement("style");
      styleEl.textContent = `
        .dsh-desktop-btn { transition: background-color 0.15s ease, border-color 0.15s ease; }
        .dsh-desktop-btn:hover { background: var(--dsw-alias-interactive-bg-hover) !important; }
        .dsh-desktop-btn:active { background: var(--dsw-alias-interactive-bg-active) !important; }
        .dsh-desktop-btn:focus-visible { outline: 1px solid var(--dsw-alias-brand-primary, #3964fe); outline-offset: 1px; }
      `;
      document.head.appendChild(styleEl);
      ctx.effect(() => () => styleEl.remove(), "dsh-desktop-ui: button styles");

      // ── 桌面皮肤（DSH 零改动，纯注入 CSS）────────────────────────────────
      // 选择器为什么用"后缀 + :has"而不是全名：CSS-modules 的哈希前缀每次构建都会变
      // （如 eGxaPq_ / wSkVaW_），**局部名后缀才是稳定的**——项目原本的注入就是靠这个。
      //   · `_marks` 唯一（右侧轮次标记轨的容器；yAWgPa_marker 是 `_marker`，不同）。
      //     而 `_frame` 与布局插件重名，所以用 `:has([class$="_marks"])` 限定到标记轨那一个。
      //   · `_widthHandle` 唯一（正文两侧对称的宽度拖动条；本轮只用于定位，不再挂遮罩）。
      const skinEl = document.createElement("style");
      skinEl.textContent = `
        :root {
          --dsh-rail-mask-opacity: .35;
          --dsh-conversation-mask-opacity: .25;
          --dsh-fullscreen-mask-opacity: .8;
          --dsh-sidebar-opacity: .45;
          --dsh-sidebar-bg-image: none;
        }

        /* ① 滚动条自动隐藏：滑块默认透明（视觉上"收起"），鼠标移进滚动容器才显形。
              刻意保留 8px 槽宽（theme 插件的 --dsh-scrollbar-width）：若把宽度收到 0，
              正文会在悬停瞬间横向重排——那种抖动比"看不见滚动条"更难受。 */
        ::-webkit-scrollbar-thumb { background: transparent !important; }
        :hover::-webkit-scrollbar-thumb { background: var(--dsh-scrollbar-thumb, rgba(255,255,255,.22)) !important; }
        ::-webkit-scrollbar-thumb:hover { background: var(--dsh-scrollbar-thumb-hover, rgba(255,255,255,.4)) !important; }

        /* ② 右侧轮次标记轨：默认隐藏并向右退开，鼠标进入（或键盘聚焦）才浮现。
              【务必保留这个 :not(...)】has() 匹配的是**任意后代**，而标记轨位于布局根框架内部，
              所以 [class$="_frame"]:has([class$="_marks"]) 会**同时命中两个元素**：
              pI_x6G_frame（布局根三栏框架 = 整个对话页面）与 eGxaPq_frame（标记轨）。
              实测后果：整页 opacity:0（页面被隐藏）且被 translateY(-50%) 上移半屏。
              布局根框架内含 _centerCol、标记轨没有，故用 :not() 精确排除。
              transform 必须连本体自带的 translateY(-50%) 一起写，否则轨道失去垂直居中。
              另：本段是反引号模板字符串，注释里**不能出现反引号**（会终止字符串）。 */
        [class$="_frame"]:has([class$="_marks"]):not(:has([class$="_centerCol"])) {
          opacity: 0;
          transform: translateY(-50%) translateX(8px);
          transition: height .22s cubic-bezier(.2,.8,.2,1), opacity .18s ease, transform .18s ease;
        }
        [class$="_frame"]:has([class$="_marks"]):not(:has([class$="_centerCol"])):hover,
        [class$="_frame"]:has([class$="_marks"]):not(:has([class$="_centerCol"])):focus-within {
          opacity: 1;
          transform: translateY(-50%) translateX(0);
        }
        /* ③ 遮罩：比轨道外扩一圈的**圆角矩形**（方形圆角，不是椭圆）。
              放在 ::before 上即天然落在标记条之下（同为定位元素、先绘制）。 */
        [class$="_frame"]:has([class$="_marks"]):not(:has([class$="_centerCol"]))::before {
          content: "";
          position: absolute;
          inset: -10px -4px;
          border-radius: 8px;
          background: rgba(0, 0, 0, var(--dsh-rail-mask-opacity));
          pointer-events: none;
        }

        /* ④ 对话区底层黑遮罩：覆盖**能拖动的那条对话栏中间的内容列**——也就是左右拖动条所夹的
              那一段宽度。前两版分别错在"挂在两条拖动条上"和"盖住整个会话面板"，都不是这里。
              锚点与尺寸都来自拖动条自己的定位规则：
                .wSkVaW_body{position:relative}                        ← 拖动条的定位上下文（已自带，无需再加）
                .wSkVaW_widthHandle[data-side=left]{right:calc(50% + contentWidth/2 + 24px)}
                .wSkVaW_widthHandle[data-side=right]{left: calc(50% + contentWidth/2 + 24px)}
              ⇒ 内容列 = 居中、宽 var(--dsh-chat-content-width)。照这个尺寸取即可与拖动条对齐。
              选择器用 :has(> _scrollBody) 精确锁定：_scrollBody 是它的**直接子元素**，
              而 _body 这个后缀在多个插件里都有（必须限定）。用直接子选择器也顺带避开了
              "匹配到祖先"的陷阱。
              "底层"靠 z-index:-1：负层级画在内容之下、页面底色之上，正文照常可读。 */
        [class$="_body"]:has(> [class$="_scrollBody"])::before {
          content: "";
          position: absolute;
          top: 0;
          bottom: 0;
          left: 50%;
          /* 宽度 = 内容列 + 128px：把两侧拖动滑块也一并罩住。算术来自拖动条自己的定位规则——
             滑块内缘在 50% ± (contentWidth/2 + 24px)，滑块宽度上限 40px，故外缘在
             50% ± (contentWidth/2 + 64px)，即总宽 = contentWidth + 128px。
             再套 min(…, 100%) 兜住窄窗口（那时 _body 本身也没这么宽）。 */
          width: min(calc(var(--dsh-chat-content-width, 680px) + 128px), 100%);
          transform: translateX(-50%);
          background: rgba(0, 0, 0, var(--dsh-conversation-mask-opacity));
          pointer-events: none;
          z-index: -1;
        }

        /* ⑤ 右侧栏面板遮罩：与对话主页**共用同一个变量**，所以两边永远同步，不需要额外联动代码。
              面板自带 background:var(--dsw-alias-bg-base)（有壁纸时壳已把它置透明），这里再显式
              置透明一次，好让没配壁纸时这层遮罩也看得见。
              面板自己有 z-index:10（独立层叠上下文），因此 ::before 的 z-index:-1 落在
              面板内容之下、面板底色之上——正文照常清晰，只是底色暗了一档。 */
        [data-sidebar-right-panel] { background-color: transparent !important; }
        [data-sidebar-right-panel]::before {
          content: "";
          position: absolute;
          inset: 0;
          z-index: -1;
          background: rgba(0, 0, 0, var(--dsh-conversation-mask-opacity));
          pointer-events: none;
        }
        /* ⑤b 全屏态：面板改为 position:fixed + inset:0，铺满整个视口——此时它不再是"旁边一栏"，
              而是**整个工作面**，正文直接压在壁纸上，对话区那档（默认 0.25）太透、读着费劲。
              故全屏态单独走一档更重的值（默认 0.8），退出全屏立刻回到与对话区同步的那档。
              两条规则特异性相同，靠**书写顺序**后者胜出；这里不动 background-size 等其它属性。 */
        [data-sidebar-right-panel=fullscreen]::before {
          background: rgba(0, 0, 0, var(--dsh-fullscreen-mask-opacity));
        }

        /* ⑥ 右侧栏按钮的固定黑底。
              用 button[data-...] 而不是裸 [data-...]：元素+属性 = (0,1,1)，
              压得下插件自己的类选择器（.P3OORG_iconButton = (0,1,0)），
              又低于它的悬停规则（.P3OORG_iconButton:hover = (0,2,0)）——
              于是悬停高亮照常，不会被这块黑底吃掉。
              两个面板顶部按钮 + 折叠态那个「展开」按钮一起加，两种状态视觉一致。 */
        button[data-sidebar-right-mode],
        button[data-sidebar-right-toggle],
        button[data-sidebar-right-expand] {
          background-color: rgba(0, 0, 0, .5);
          border-radius: 8px;
        }

        /* ⑦ 左侧栏背景：两种模式共用一条规则——
              · 延伸主背景：只铺那层黑纱，壁纸由 body::before 从透明的侧栏里透出来；
              · 独立图片：黑纱之下再叠 --dsh-sidebar-bg-image 那张图。
              把 --dsw-specific-sidebar-fill 就地置透明即可：侧栏列与它内部的 _root
              都用这个变量做底色，改一处两个都变透，不必和它们各自的 background 抢 !important。
              遮罩值由插件按 max(设置值, 对话区遮罩) 写入，保证"左侧栏比主页面更不透明"。
              背景画在元素自身上（不是 ::before + z-index:-1）：没有壁纸时 _frame 底色不透明，
              负层级会被它盖住，画在自身则始终可见。 */
        #root [class$="_sidebarCol"] {
          --dsw-specific-sidebar-fill: transparent;
          background-image:
            linear-gradient(rgba(0, 0, 0, var(--dsh-sidebar-opacity)), rgba(0, 0, 0, var(--dsh-sidebar-opacity))),
            var(--dsh-sidebar-bg-image, none) !important;
          background-size: cover, cover !important;
          background-position: center, center !important;
          background-repeat: no-repeat, no-repeat !important;
        }
      `;
      document.head.appendChild(skinEl);
      ctx.effect(() => () => skinEl.remove(), "dsh-desktop-ui: skin styles");

      // 初始取一次壳设置写进 CSS 变量。**不新增轮询**：设置面板挂载后由它随既有的 5 秒
      // /api/status 轮询持续同步（见 DesktopSection 的 useEffect）；没开过面板时这份初值就够。
      const rootEl = document.documentElement;
      void (async () => {
        try {
          const r = await fetch(ADMIN + "/api/status", { signal: AbortSignal.timeout(3000) });
          if (r.ok) applySkinVars(await r.json());
        } catch { /* 壳未响应：留在样式表里的默认值 */ }
      })();
      ctx.effect(() => () => {
        rootEl.style.removeProperty("--dsh-rail-mask-opacity");
        rootEl.style.removeProperty("--dsh-conversation-mask-opacity");
        rootEl.style.removeProperty("--dsh-fullscreen-mask-opacity");
        rootEl.style.removeProperty("--dsh-sidebar-opacity");
        rootEl.style.removeProperty("--dsh-sidebar-bg-image");
      }, "dsh-desktop-ui: skin vars");
    };
    return module.exports;
  },
});