// browser 半身：把「桌面」「个性化」注册进 settings.section 插槽，并注入桌面皮肤 CSS。
// 读写都经壳的 admin API（固定回环端口 + CORS）。
window.__ModuleLoader__.load({
  id: "dsh-desktop-ui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const { useState, useEffect } = react;
    // ⚠️ 必须在 factory 顶部 require：模块体用到却只在 apply() 里声明，就是装载期
    // ReferenceError（"整页 Failed to load plugins"）。官方原语走种子模块，与官方插件同一份。
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

    const ADMIN = "http://127.0.0.1:25439"; // 壳 admin API（单实例固定端口）

    // timeoutMs=0 表示不设超时（会弹系统对话框、等待时间不可控的请求）
    async function post(path, body, timeoutMs = 4000) {
      try {
        const r = await fetch(ADMIN + path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body || {}),
          signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
        });
        return r.ok ? await r.json() : { ok: false, error: r.status === 404 ? "当前壳版本没有这个接口（旧壳，需要先换一次壳）" : `壳返回 HTTP ${r.status}` };
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

    const border = "1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent)";
    const css = {
      section: { display: "flex", flexDirection: "column", gap: "14px", width: "100%" },
      row: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", minHeight: "40px" },
      kv: { display: "flex", flexDirection: "column", gap: "2px", minWidth: "0" },
      label: { color: "var(--dsw-alias-label-primary)", fontSize: "14px", lineHeight: "20px" },
      hint: { color: "color-mix(in srgb, var(--dsw-alias-label-primary) 55%, transparent)", fontSize: "12px", lineHeight: "18px" },
      input: { flex: "1", minWidth: "0", color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-layer-2)", border, borderRadius: "8px", padding: "6px 10px", fontSize: "13px" },
      button: { cursor: "pointer", color: "var(--dsw-alias-label-primary)", background: "transparent", border, borderRadius: "8px", padding: "6px 12px", fontSize: "13px", whiteSpace: "nowrap" },
      buttonOn: { cursor: "pointer", color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-interactive-bg-hover)", border, borderRadius: "8px", padding: "6px 12px", fontSize: "13px", whiteSpace: "nowrap" },
      buttonOff: { cursor: "not-allowed", color: "var(--dsw-alias-label-primary)", background: "transparent", border, borderRadius: "8px", padding: "6px 12px", fontSize: "13px", whiteSpace: "nowrap", opacity: "0.45" },
      mono: { fontFamily: "ui-monospace, Consolas, monospace", fontSize: "12px", color: "color-mix(in srgb, var(--dsw-alias-label-primary) 55%, transparent)", wordBreak: "break-all" },
      actions: { display: "flex", gap: "8px", paddingTop: "4px" },
      msg: { fontSize: "12px", color: "color-mix(in srgb, var(--dsw-alias-label-primary) 70%, transparent)" },
      progressRow: { display: "flex", alignItems: "center", gap: "10px", width: "100%", paddingTop: "2px" },
      progressTrack: { flex: "1", minWidth: "80px", height: "6px", borderRadius: "999px", background: "color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent)", overflow: "hidden" },
      progressFill: { height: "100%", borderRadius: "999px", background: "var(--dsw-alias-brand-primary, #3964fe)", transition: "width 0.4s ease" },
      progressLabel: { fontSize: "12px", color: "color-mix(in srgb, var(--dsw-alias-label-primary) 70%, transparent)", whiteSpace: "nowrap", flex: "none" },
    };

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

    // DSH 更新行的可用性与文案全部由 /api/status 快照推导（壳可能中途重启，两边各存一份必然不一致）。
    function dshInfo(st) {
      const u = st && st.dshUpdate ? st.dshUpdate : null;
      if (!u) return { hint: "—", canCheck: false, canUpdate: false, canApply: false, busy: false, needsConfirm: false, blocked: false };
      const busy = u.phase === "building" || u.phase === "checking" || u.phase === "applying";
      const npmOk = u.npmOk !== false;
      const needsConfirm = u.needsConfirm === true;
      // blocked = 壳判定"目标版本在本机 Electron 上确定跑不起来"，必须禁掉按钮。
      const blocked = !!(u.compat && u.compat.blocked === true);
      const p = u.progress || null;
      const showProgress = u.phase === "building" && p !== null && typeof p.percent === "number";
      return {
        hint: u.hint || "—",
        busy: busy,
        needsConfirm: needsConfirm,
        blocked: blocked,
        showProgress: showProgress,
        percent: p !== null && typeof p.percent === "number" ? p.percent : 0,
        stepLabel: p !== null && p.label ? p.label : "",
        elapsed: fmtElapsed(u.elapsedMs),
        // 跨版本升级不能因为 needsConfirm 就禁掉按钮（那样等于没有确认入口）；blocked 才是真禁。
        canCheck: !busy && npmOk,
        canUpdate: !busy && npmOk && !blocked && u.hasUpdate === true && u.pending !== true,
        canApply: !busy && (u.pending === true || u.phase === "ready"),
      };
    }

    // 「左侧栏遮罩永不比主页面更透」是硬约束，靠下面的 max 保证（默认值本身挡不住）。
    const SIDEBAR_OPACITY_DEFAULT = 0.45;
    const clamp01 = (raw, dflt) => {
      const n = Number(raw);
      return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : dflt;
    };

    function applySkinVars(st) {
      if (!st || typeof document === "undefined") return;
      const root = document.documentElement;
      const put = (name, raw, dflt) => root.style.setProperty(name, String(clamp01(raw, dflt)));
      put("--dsh-rail-mask-opacity", st.railMaskOpacity, 0.35);
      const conv = clamp01(st.conversationMaskOpacity, 0.25);
      root.style.setProperty("--dsh-conversation-mask-opacity", String(conv));
      put("--dsh-fullscreen-mask-opacity", st.fullscreenMaskOpacity, 0.8);
      root.style.setProperty("--dsh-sidebar-opacity", String(Math.max(clamp01(st.sidebarOpacity, SIDEBAR_OPACITY_DEFAULT), conv)));
      // 只有「独立图片」模式才把图铺给左侧栏。URL 必须带版本参数（?p= 路径、?t= mtime），
      // 否则 URL 不变时浏览器认为 background-image 没变、压根不重新请求。
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

    // 「开机自启 / 最小化到托盘」用官方 primitives.Switch；label 不能省（它是 aria-label）。
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

    function DisclosureGroup({ title, open, onToggle, children }) {
      const rows = (Array.isArray(children) ? children : [children]).filter(Boolean);
      return react.createElement(
        primitives.DisclosureRow,
        { title, open, onToggle, expandable: true },
        ...rows
      );
    }

    function PersonalizeSection() {
      const st = useAdminStatus();
      const [msg, setMsg] = useState("");
      const [maskOpen, setMaskOpen] = useState(false);
      const [sideLocal, setSideLocal] = useState(null);
      const setMsgOk = (r) => setMsg(r && r.ok ? "已生效" : "操作失败（壳未响应？）");
      if (!st) {
        return react.createElement(
          "div",
          { style: css.section },
          react.createElement("span", { style: css.hint }, "正在连接桌面壳…（若持续显示，请从托盘重新启动应用）")
        );
      }
      // 左侧栏两个值的本地快照（改完立刻重取一次）；生效值 = max(设置值, 对话区遮罩)。
      const sideMode = sideLocal ? sideLocal.mode : String(st.sidebarBgMode || "extend");
      const sideImg = sideLocal ? sideLocal.image : String(st.sidebarBgImage || "");
      const sideOwn = sideMode === "own";
      const sideEff = Math.max(clamp01(st.sidebarOpacity, SIDEBAR_OPACITY_DEFAULT), clamp01(st.conversationMaskOpacity, 0.25));
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
        react.createElement(
          DisclosureGroup,
          { title: "遮罩", open: maskOpen, onToggle: () => setMaskOpen(!maskOpen) },
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
                document.documentElement.style.setProperty("--dsh-rail-mask-opacity", String(v))
                post("/api/settings", { railMaskOpacity: v })
              },
            })
          ),
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
                document.documentElement.style.setProperty("--dsh-sidebar-opacity", String(eff))
                post("/api/settings", { sidebarOpacity: v })
              },
            })
          )
        ),
        // 左侧栏背景：模式二选一，切换只换一个 CSS 变量（两种模式共用同一条规则）。
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
      useEffect(() => { applySkinVars(st); }, [st]);
      const setMsgOk = (r) => setMsg(r && r.ok ? "已生效" : "操作失败（壳未响应？）");
      const di = dshInfo(st);
      const [repoBusy, setRepoBusy] = useState(false);
      const [repoInfo, setRepoInfo] = useState("按仓库 components.json 补/换功能文件（自带插件、补丁层、市场目录）");
      // 换壳：暂存区里有没有壳源码、本机能不能换。初值从不联网的 /api/repo-update/state 读。
      const [shellPending, setShellPending] = useState(false);
      const [shellCanSwap, setShellCanSwap] = useState(false);
      const [shellReason, setShellReason] = useState("");
      useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const r = await fetch(ADMIN + "/api/repo-update/state", { signal: AbortSignal.timeout(3000) });
            if (alive && r.status === 404) {
              // 旧壳（1.0.0 之前）没有仓库更新接口：如实说清楚，别让用户以为"壳没响应"
              setRepoInfo("当前壳版本不支持仓库更新（旧壳）。请先用 1.0.0 安装包覆盖安装，或让壳自动完成一次换壳");
              return;
            }
            const j = await r.json();
            if (!alive || !j || !j.shell) return;
            setShellPending(!!j.shell.pending);
            setShellCanSwap(!!j.shell.canSwap);
            setShellReason(j.shell.reason || "");
          } catch { /* 壳没起来：保持默认（按钮不可用） */ }
        })();
        return () => { alive = false; };
      }, []);
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
          const r = await post("/api/repo-update/apply", {}, 120000);
          if (r && r.ok) {
            setRepoInfo(r.message || "已更新");
            setShellPending(!!r.shellPending);
            setShellCanSwap(!!r.shellCanSwap);
            setShellReason(r.shellReason || "");
          } else if (r && Array.isArray(r.failed) && r.failed.length > 0) setRepoInfo(`部分失败：${r.failed.map((f) => `${f.id}：${f.error}`).join("；")}`);
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
      // ⚠️ st 字段只能在 `if (!st)` 守卫之后读：首帧 st 为 null，读早了整个「桌面」栏会被 React 卸载。
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
                setMsg("正在重启应用以应用更新…");
                await post("/api/dsh/apply");
              },
            },
            "重启并应用"
          )
        ),
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
          ),
          // 换壳必须重启整个应用（壳是主进程代码），且只在"暂存区有壳源码 + 安装目录可写"时可点。
          react.createElement(
            "button",
            {
              style: repoBusy || !shellPending || !shellCanSwap ? css.buttonOff : css.button,
              className: "dsh-desktop-btn",
              disabled: repoBusy || !shellPending || !shellCanSwap,
              title: !shellPending ? "先在仓库里更新过壳源码后可用" : (shellCanSwap ? "" : shellReason),
              onClick: async () => {
                const okGo = window.confirm(
                  "换壳会把仓库里下好的壳源码写进当前安装目录，然后**重启整个应用**。\n\n" +
                  "应用退出后由一个助手进程替换 app.asar，并先用 --smoke 校验新壳：\n" +
                  "校验不通过会自动回滚到旧壳再启动（旧壳备份会保留在安装目录里）。\n\n确定继续吗？"
                );
                if (!okGo) return;
                setRepoBusy(true);
                setRepoInfo("正在准备换壳，应用马上会退出并自动重启…");
                try {
                  const r = await post("/api/repo-update/shell", {}, 15000);
                  if (r && r.ok === false) setRepoInfo(`无法换壳：${r.error || "未知原因"}`);
                } catch { /* 预期：应用已经退出 */ }
              },
            },
            "换壳并重启"
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
      // 接管官方"打开配置文件"按钮（settings.action 插槽禁止同 id 注册）：捕获阶段拦截点击，改走壳 API。
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
      // 选择器用"后缀 + :has"：CSS-modules 的哈希前缀每次构建都变，局部名后缀才稳定。
      // `_marks` / `_widthHandle` 唯一；`_frame` 与布局插件重名，故用 :has 限定。
      const skinEl = document.createElement("style");
      skinEl.textContent = `
        :root {
          --dsh-rail-mask-opacity: .35;
          --dsh-conversation-mask-opacity: .25;
          --dsh-fullscreen-mask-opacity: .8;
          --dsh-sidebar-opacity: .45;
          --dsh-sidebar-bg-image: none;
        }

        /* ① 滚动条自动隐藏：滑块默认透明，鼠标移进滚动容器才显形。
              刻意保留 8px 槽宽：收到 0 会让正文在悬停瞬间横向重排。 */
        ::-webkit-scrollbar-thumb { background: transparent !important; }
        :hover::-webkit-scrollbar-thumb { background: var(--dsh-scrollbar-thumb, rgba(255,255,255,.22)) !important; }
        ::-webkit-scrollbar-thumb:hover { background: var(--dsh-scrollbar-thumb-hover, rgba(255,255,255,.4)) !important; }

        /* ② 右侧轮次标记轨：默认隐藏并向右退开，鼠标进入（或键盘聚焦）才浮现。
              【务必保留后面三重 :not(...)】has() 匹配任意后代：_frame 与 :has 的组合会把"包着标记轨的
              任何祖先"一起命中，一旦命中对话区就是整块不可见。三重排除各有来历：
                · _centerCol —— 布局根框架（最早那一重）
                · _scroll / _column —— 对话内容外框（实测 harness 0.1.7-rc.1：外框 EvIC1a_frame
                  含 _marks 又不含 _centerCol，只靠第一重会整块命中 ⇒ 对话全空并被上移半个高度）
              轨道自身只有 _scroller（后缀 _scroller 不等于 _scroll）与 _marks，不受这三重影响。
              transform 要连本体自带的 translateY(-50%) 一起写，否则轨道失去垂直居中。
              本段是反引号模板字符串，注释里不能出现反引号。 */
        [class$="_frame"]:has([class$="_marks"]):not(:has([class$="_centerCol"])):not(:has([class$="_scroll"])):not(:has([class$="_column"])) {
          opacity: 0;
          transform: translateY(-50%) translateX(8px);
          transition: height .22s cubic-bezier(.2,.8,.2,1), opacity .18s ease, transform .18s ease;
        }
        [class$="_frame"]:has([class$="_marks"]):not(:has([class$="_centerCol"])):not(:has([class$="_scroll"])):not(:has([class$="_column"])):hover,
        [class$="_frame"]:has([class$="_marks"]):not(:has([class$="_centerCol"])):not(:has([class$="_scroll"])):not(:has([class$="_column"])):focus-within {
          opacity: 1;
          transform: translateY(-50%) translateX(0);
        }
        /* ③ 遮罩：比轨道外扩一圈的圆角矩形，放在 ::before 上即落在标记条之下。 */
        [class$="_frame"]:has([class$="_marks"]):not(:has([class$="_centerCol"])):not(:has([class$="_scroll"])):not(:has([class$="_column"]))::before {
          content: "";
          position: absolute;
          inset: -10px -4px;
          border-radius: 8px;
          background: rgba(0, 0, 0, var(--dsh-rail-mask-opacity));
          pointer-events: none;
        }

        /* ④ 对话区底层黑遮罩：覆盖左右拖动条所夹的内容列宽度（尺寸取自拖动条自己的定位规则）。
              选择器用 :has(> _scrollBody) 锁定（_body 后缀在多个插件里都有，必须限定）；
              "底层"靠 z-index:-1：负层级画在内容之下、页面底色之上，正文照常可读。 */
        [class$="_body"]:has(> [class$="_scrollBody"])::before {
          content: "";
          position: absolute;
          top: 0;
          bottom: 0;
          left: 50%;
          /* 宽度 = 内容列 + 128px：滑块内缘在 50% ± (contentWidth/2 + 24px)、宽度上限 40px，
             故外缘在 50% ± (contentWidth/2 + 64px)；min(…, 100%) 兜住窄窗口。 */
          width: min(calc(var(--dsh-chat-content-width, 680px) + 128px), 100%);
          transform: translateX(-50%);
          background: rgba(0, 0, 0, var(--dsh-conversation-mask-opacity));
          pointer-events: none;
          z-index: -1;
        }

        /* ⑤ 右侧栏面板遮罩：与对话主页共用同一个变量，故两边永远同步。
              面板自带底色（有壁纸时壳已置透明），这里再显式置透明一次；
              ::before 的 z-index:-1 落在面板内容之下、面板底色之上。 */
        [data-sidebar-right-panel] { background-color: transparent !important; }
        [data-sidebar-right-panel]::before {
          content: "";
          position: absolute;
          inset: 0;
          z-index: -1;
          background: rgba(0, 0, 0, var(--dsh-conversation-mask-opacity));
          pointer-events: none;
        }
        /* ⑤b 全屏态单独走更重的一档（默认 0.8）：面板铺满整个视口，正文直接压在壁纸上，
              沿用对话区那档太透。两条规则特异性相同，靠书写顺序后者胜出。 */
        [data-sidebar-right-panel=fullscreen]::before {
          background: rgba(0, 0, 0, var(--dsh-fullscreen-mask-opacity));
        }

        /* ⑥ 右侧栏按钮的固定黑底。用 button[data-...]（0,1,1）压得下插件自己的类选择器
              （0,1,0），又低于它的悬停规则（0,2,0）⇒ 悬停高亮照常被保留。 */
        button[data-sidebar-right-mode],
        button[data-sidebar-right-toggle],
        button[data-sidebar-right-expand] {
          background-color: rgba(0, 0, 0, .5);
          border-radius: 8px;
        }

        /* ⑦ 左侧栏背景：两种模式共用一条规则（延伸主背景只铺黑纱；独立图片在黑纱下再叠图）。
              把 --dsw-specific-sidebar-fill 就地置透明即可：侧栏列与它内部的 _root 都用这个变量。
              遮罩值按 max(设置值, 对话区遮罩) 写入。背景画在元素自身上而非 ::before + z-index:-1：
              没有壁纸时 _frame 底色不透明，负层级会被它盖住。 */
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