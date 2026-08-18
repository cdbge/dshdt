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

    async function post(path, body) {
      try {
        const r = await fetch(ADMIN + path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body || {}),
          signal: AbortSignal.timeout(4000),
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
      button: { cursor: "pointer", color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-interactive-bg-hover)", border, borderRadius: "8px", padding: "6px 12px", fontSize: "13px", whiteSpace: "nowrap" },
      checkbox: { width: "18px", height: "18px", cursor: "pointer", flex: "none" },
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
              onClick: async () => {
                const r = await post("/api/pick-directory");
                if (r && r.path) {
                  setWs(r.path);
                  setMsgOk(await post("/api/workspace", { path: r.path }));
                } else setMsg("未选择目录");
              },
            },
            "浏览…"
          ),
          react.createElement(
            "button",
            { style: css.button, onClick: async () => setMsgOk(await post("/api/workspace", { path: ws.trim() })) },
            "应用"
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
          react.createElement("button", { style: css.button, onClick: async () => setMsgOk(await post("/api/open-data-dir")) }, "打开数据目录"),
          react.createElement("button", { style: css.button, onClick: async () => setMsgOk(await post("/api/focus")) }, "回到会话"),
          react.createElement("button", { style: css.button, onClick: async () => { await post("/api/quit"); } }, "退出应用")
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
    };
    return module.exports;
  },
});
