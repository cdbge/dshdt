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
      checkbox: { width: "18px", height: "18px", cursor: "pointer", flex: "none" },
      // 不可用态：与可点按钮同尺寸，只降透明度——换尺寸会让整行在状态切换时跳动。
      buttonOff: { cursor: "not-allowed", color: "var(--dsw-alias-label-primary)", background: "transparent", border, borderRadius: "8px", padding: "6px 12px", fontSize: "13px", whiteSpace: "nowrap", opacity: "0.45" },
      mono: { fontFamily: "ui-monospace, Consolas, monospace", fontSize: "12px", color: "color-mix(in srgb, var(--dsw-alias-label-primary) 55%, transparent)", wordBreak: "break-all" },
      actions: { display: "flex", gap: "8px", paddingTop: "4px" },
      msg: { fontSize: "12px", color: "color-mix(in srgb, var(--dsw-alias-label-primary) 70%, transparent)" },
    };

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
      if (!u) return { hint: "—", canCheck: false, canUpdate: false, canApply: false, busy: false };
      const busy = u.phase === "building" || u.phase === "checking" || u.phase === "applying";
      const npmOk = u.npmOk !== false;
      return {
        hint: u.hint || "—",
        busy: busy,
        canCheck: !busy && npmOk,
        canUpdate: !busy && npmOk && u.hasUpdate === true && u.pending !== true,
        canApply: !busy && (u.pending === true || u.phase === "ready"),
      };
    }

    function StatusRow({ k, v }) {
      return react.createElement(
        "div",
        { style: css.row },
        react.createElement("span", { style: css.label }, k),
        react.createElement("span", { style: css.mono }, v)
      );
    }

    function DesktopSection() {
      const st = useAdminStatus();
      const [ws, setWs] = useState("");
      const [msg, setMsg] = useState("");
      useEffect(() => {
        if (st && st.ws && ws === "") setWs(st.ws);
      }, [st]);
      const setMsgOk = (r) => setMsg(r && r.ok ? "已生效" : "操作失败（壳未响应？）");
      // 更新行的可用性在渲染前一次算好（st 为 null 时 dshInfo 返回全不可用，天然安全）。
      const di = dshInfo(st);

      if (!st) {
        return react.createElement(
          "div",
          { style: css.section },
          react.createElement("span", { style: css.hint }, "正在连接桌面壳…（若持续显示，请从托盘重新启动应用）")
        );
      }
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
            react.createElement("span", { style: css.hint }, "登录 Windows 后自动启动本应用")
          ),
          react.createElement("input", {
            type: "checkbox",
            style: css.checkbox,
            checked: !!st.autostart,
            onChange: async (e) => setMsgOk(await post("/api/autostart", { on: e.target.checked })),
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
          react.createElement("input", {
            type: "checkbox",
            style: css.checkbox,
            checked: st.minimizeToTray !== false,
            onChange: async (e) => setMsgOk(await post("/api/settings", { minimizeToTray: e.target.checked })),
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
                const r = await post("/api/dsh/update", {}, 15000);
                setMsg(r && r.ok ? "已开始构建（分钟级，请勿关闭应用）" : (r && r.error) || "无法开始更新");
              },
            },
            "更新"
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
    };
    return module.exports;
  },
});
