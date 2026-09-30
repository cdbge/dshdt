// dsh-market 的 browser 半身：左侧栏底部入口 + 市场弹窗（插件 / 美化包两页）。
// 目录数据走壳的 admin API（/api/market/catalog）——下载 + 校验 + 落到插件位必须在 Node 侧做；
// 安装走官方机制（dsh plugin --profile web add <坐标>）。弹窗是自绘遮罩，不用 primitives.Modal。
window.__ModuleLoader__.load({
  id: "dsh-market",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const { useState, useEffect, useCallback } = react;

    const ADMIN = "http://127.0.0.1:25439"; // 壳 admin API（单实例固定端口；被占用时回退，届时显示"壳未响应"）

    /** 两页的静态描述（审核强度不同是产品语义，故文案里就讲清差别）。 */
    const PAGES = [
      {
        key: "plugins",
        label: "插件",
        blurb: "可执行代码。装进 profile 插件位并挂载为 DSH 插件，安装后需重启宿主生效。",
        empty: "还没有上架的插件。",
        caution: "插件等同于可执行代码：上架前由维护者逐份读代码。安装前请确认来源。",
      },
      {
        key: "themes",
        label: "美化包",
        blurb: "只允许 CSS / JSON / 图片的样式包，不含任何脚本；装上只改外观。",
        empty: "还没有上架的美化包。",
        caution: "美化包不含脚本，审核口径比插件轻；一旦夹带 .js 会被目录校验拒绝。",
      },
    ];

    /** 读一次目录；失败时把原因带回来，界面据此区分"壳没响应"与"目录为空"。 */
    async function fetchCatalog() {
      try {
        const r = await fetch(ADMIN + "/api/market/catalog", { signal: AbortSignal.timeout(6000) });
        if (!r.ok) return { ok: false, error: `壳返回 HTTP ${r.status}` };
        const j = await r.json();
        return j && j.ok ? j : { ok: false, error: (j && j.error) || "目录格式不正确" };
      } catch (e) {
        return { ok: false, error: "桌面壳未响应（市场目录由壳供给）" };
      }
    }

    /** 请求壳把下载地址交给系统（默认浏览器/下载器）；壳不下载、不解包、不写盘。 */
    async function openDownload(entry) {
      const r = await fetch(ADMIN + "/api/market/open-download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id }),
        signal: AbortSignal.timeout(10000),
      }).catch(() => null);
      if (!r) return { ok: false, error: "桌面壳未响应" };
      return await r.json().catch(() => ({ ok: false, error: "返回内容不是 JSON" }));
    }

    /** 安装前置体检：pnpm 在不在（官方 `dsh plugin add` 硬依赖它）。 */
    async function fetchPreflight() {
      try {
        const r = await fetch(ADMIN + "/api/market/preflight", { signal: AbortSignal.timeout(6000) });
        if (!r.ok) return null;
        return await r.json();
      } catch {
        return null;
      }
    }

    /** 请求壳安装该条目（走官方机制 `dsh plugin --profile web add <坐标>`）；不设超时，装包是分钟级。 */
    async function installEntry(entry) {
      const r = await fetch(ADMIN + "/api/market/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id }),
      }).catch(() => null);
      if (!r) return { ok: false, error: "桌面壳未响应" };
      return await r.json().catch(() => ({ ok: false, error: "返回内容不是 JSON" }));
    }

    // ── 样式：全部用官方 CSS 变量；尺寸/圆角/间距照抄官方设置面板的 CSS module ──
    const border = "1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent)";
    const css = {
      entryLayer: { flex: "none", alignItems: "center", width: "100%", height: "42px", margin: "8px 0 0", display: "flex" },
      entryButtons: { alignItems: "center", width: "100%", display: "flex" },
      entryBtn: {
        width: "calc(100% + 4px)", height: "42px", color: "var(--dsw-alias-label-primary)",
        cursor: "pointer", background: "0 0", border: "none", borderRadius: "12px",
        alignItems: "center", gap: "8px", margin: "0 -2px", padding: "0 10px 0 8px",
        fontFamily: "inherit", fontSize: "14px", display: "inline-flex", overflow: "hidden",
      },
      entryBtnRail: { cornerShape: "round", borderRadius: "50%", justifyContent: "center", gap: "0", width: "36px", height: "36px", padding: "0" },
      entryLabel: { textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: "0", overflow: "hidden" },

      overlay: {
        position: "fixed", inset: "0", zIndex: "1000",
        display: "flex", alignItems: "center", justifyContent: "center",
      },
      mask: {
        position: "absolute", inset: "0",
        background: "var(--dsw-alias-bg-mask-1)",
        backdropFilter: "var(--dsw-mask-blur)",
      },
      dialog: {
        width: "800px",
        maxWidth: "calc(100vw - 48px)",
        height: "min(800px, 100vh - 48px)",
        zIndex: "1",
        background: "var(--dsw-alias-bg-layer-2)",
        boxShadow: "var(--dsw-elevation-prominent)",
        borderRadius: "32px",
        display: "flex", flexDirection: "row",
        position: "relative", overflow: "hidden",
      },
      nav: {
        boxSizing: "border-box", flex: "none", width: "188px",
        display: "flex", flexDirection: "column", gap: "18px", padding: "22px 12px 0",
      },
      navTitle: {
        color: "var(--dsw-alias-label-primary)", padding: "0 12px",
        fontSize: "16px", fontWeight: "500", lineHeight: "24px", margin: "0",
      },
      navList: { display: "flex", flexDirection: "column", gap: "4px" },
      navCell: {
        boxSizing: "border-box", cursor: "pointer", height: "40px",
        color: "var(--dsw-alias-label-primary)", textAlign: "left",
        background: "0 0", border: "none", borderRadius: "12px",
        alignItems: "center", gap: "8px", padding: "9px 16px 9px 12px",
        fontFamily: "inherit", fontSize: "14px", fontWeight: "400", lineHeight: "22px",
        display: "flex",
      },
      navCellOn: { background: "var(--dsw-specific-sidebar-nav-item-active, var(--dsw-alias-interactive-bg-hover))" },
      navLabel: { whiteSpace: "nowrap", textOverflow: "ellipsis", minWidth: "0", overflow: "hidden", display: "inline-flex", alignItems: "baseline", gap: "6px" },
      navCount: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px" },
      navSpacer: { flex: "1" },
      navWarn: { display: "flex", flexDirection: "column", gap: "4px", padding: "0 12px 20px" },
      navWarnText: {
        color: "var(--dsw-alias-label-tertiary)", fontFamily: "ui-monospace, Consolas, monospace",
        fontSize: "11px", lineHeight: "16px", whiteSpace: "pre-wrap", wordBreak: "break-word",
      },
      content: {
        boxSizing: "border-box", flex: "1", minWidth: "0",
        // 用 grid 三行（auto/1fr/auto）而非官方纵向 flex：1fr 撑满 ⇒ 脚注永远贴底。
        display: "grid", gridTemplateRows: "auto 1fr auto", minHeight: "0",
      },
      contentHeader: {
        boxSizing: "border-box", flex: "none", height: "54px",
        padding: "20px 14px 8px 10px",
        display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "8px",
      },
      contentActions: { display: "flex", alignItems: "center", gap: "8px", minWidth: "0", marginLeft: "auto" },
      close: {
        cursor: "pointer", width: "28px", height: "28px",
        color: "var(--dsw-alias-label-primary)", background: "0 0", border: "none",
        borderRadius: "28px", padding: "0", display: "inline-flex",
        alignItems: "center", justifyContent: "center", flex: "none",
      },
      closeLabel: { clip: "rect(0 0 0 0)", whiteSpace: "nowrap", width: "1px", height: "1px", position: "absolute", overflow: "hidden" },
      options: {
        flex: "1", minHeight: "0", padding: "0 24px 24px", overflowY: "auto",
      },
      tagOk: {
        color: "var(--dsw-alias-state-success-primary, #3fa66a)",
        border: "1px solid var(--dsw-alias-state-success-primary, #3fa66a)",
      },
      blurb: { color: "var(--dsw-alias-label-tertiary)", margin: "0", fontSize: "12.5px", lineHeight: "19px" },
      warnTitle: { color: "var(--dsw-alias-state-warn-label, #b8860b)", fontSize: "12px", fontWeight: "500", lineHeight: "18px" },

      // 卡片网格：自适应多列。不设 flex:1——滚动交给右栏（两层都滚会出现双重滚动条）。
      body: {
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
        gap: "12px", alignContent: "start",
        width: "100%", minWidth: "0", marginTop: "14px",
      },
      card: {
        border, borderRadius: "12px", padding: "14px 16px", gap: "12px",
        display: "flex", alignItems: "flex-start",
        minWidth: "0", boxSizing: "border-box",
        background: "var(--dsw-alias-bg-layer-2, transparent)",
      },
      icon: {
        flex: "none", width: "36px", height: "36px", borderRadius: "10px",
        alignItems: "center", justifyContent: "center", display: "inline-flex",
        fontSize: "20px", lineHeight: "1", border,
        background: "color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent)",
      },
      cardMain: { flex: "1", minWidth: "0", flexDirection: "column", gap: "4px", display: "flex" },
      nameRow: { alignItems: "center", gap: "8px", display: "flex", flexWrap: "wrap" },
      name: { color: "var(--dsw-alias-label-primary)", fontSize: "14px", fontWeight: "500", lineHeight: "22px" },
      tag: { border, borderRadius: "4px", color: "var(--dsw-alias-label-secondary)", flex: "none", padding: "1px 6px", fontSize: "11px", lineHeight: "16px" },
      summary: { color: "var(--dsw-alias-label-secondary)", margin: "0", fontSize: "12px", lineHeight: "18px" },
      meta: { color: "var(--dsw-alias-label-tertiary)", fontSize: "11px", lineHeight: "16px", wordBreak: "break-all" },
      installLabel: { color: "var(--dsw-alias-label-tertiary)", fontSize: "11px", lineHeight: "16px", fontWeight: "500" },
      cardSide: { flex: "none", flexDirection: "column", gap: "6px", alignItems: "stretch", display: "flex", minWidth: "96px" },
      btn: {
        cursor: "pointer", color: "var(--dsw-alias-label-primary)", background: "0 0", border,
        borderRadius: "8px", padding: "6px 12px", fontSize: "13px", fontFamily: "inherit",
        whiteSpace: "nowrap", textAlign: "center", textDecoration: "none",
      },
      btnPrimary: { cursor: "pointer", color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-interactive-bg-hover)", border, borderRadius: "8px", padding: "6px 12px", fontSize: "13px", fontFamily: "inherit", whiteSpace: "nowrap" },
      btnOff: { cursor: "not-allowed", color: "var(--dsw-alias-label-primary)", background: "0 0", border, borderRadius: "8px", padding: "6px 12px", fontSize: "13px", fontFamily: "inherit", whiteSpace: "nowrap", opacity: "0.5" },
      note: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: "18px", margin: "0" },
      // 确认面板跨满整行（body 是 grid，不指定就会被挤进一个 360px 列）
      confirmBox: {
        gridColumn: "1 / -1",
        border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35))", borderRadius: "12px",
        padding: "16px 18px", gap: "8px", display: "flex", flexDirection: "column",
        width: "100%", minWidth: "0", boxSizing: "border-box",
        background: "color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent)",
      },
      confirmTitle: { margin: "0", color: "var(--dsw-alias-label-primary)", fontSize: "14px", fontWeight: "500", lineHeight: "22px" },
      confirmRow: { display: "flex", gap: "10px", alignItems: "baseline" },
      confirmKey: { flex: "none", width: "82px", color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: "18px" },
      confirmVal: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px", lineHeight: "18px", wordBreak: "break-all" },
      confirmWarn: { margin: "2px 0 0", color: "var(--dsw-alias-state-warn-label, var(--dsw-alias-label-secondary))", fontSize: "12px", lineHeight: "18px" },
      discBox: {
        marginTop: "4px", border, borderRadius: "8px", padding: "8px 10px", gap: "3px",
        background: "color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent)",
        display: "flex", flexDirection: "column",
      },
      discWarnBox: {
        marginTop: "4px", border: "1px solid var(--dsw-alias-state-warn-label, #b8860b)", borderRadius: "8px",
        padding: "8px 10px", gap: "3px",
        background: "color-mix(in srgb, var(--dsw-alias-state-warn-label, #b8860b) 10%, transparent)",
        display: "flex", flexDirection: "column",
      },
      discLabel: { color: "var(--dsw-alias-label-tertiary)", fontSize: "11px", lineHeight: "16px", fontWeight: "500" },
      discItem: { margin: "0", color: "var(--dsw-alias-label-secondary)", fontSize: "12px", lineHeight: "18px" },
      confirmActions: { display: "flex", gap: "8px", justifyContent: "flex-end", paddingTop: "4px" },
      err: { color: "var(--dsw-alias-state-error-primary)", fontSize: "12px", lineHeight: "18px", margin: "0" },
      // 脚注：grid 第三行 ⇒ 永远贴底；左右内边距对齐官方 .options 的 24px
      footerBar: {
        flex: "none", display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap",
        padding: "10px 24px 18px", borderTop: "0.5px solid var(--dsw-alias-border-l3)",
      },
      howPage: { display: "flex", flexDirection: "column", gap: "12px", width: "100%", minWidth: "0" },
      howHead: { display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" },
      howTitle: { margin: "0", color: "var(--dsw-alias-label-primary)", fontSize: "16px", fontWeight: "510", lineHeight: "24px" },
      howRow: { display: "flex", gap: "12px", alignItems: "baseline" },
      howKey: { flex: "none", width: "96px", color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: "20px" },
      howVal: { color: "var(--dsw-alias-label-secondary)", fontSize: "13px", lineHeight: "20px", wordBreak: "break-all", minWidth: "0" },
      howBlock: {
        border, borderRadius: "10px", padding: "12px 14px", gap: "6px",
        background: "color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent)",
        display: "flex", flexDirection: "column",
      },
      howPre: {
        margin: "0", color: "var(--dsw-alias-label-secondary)", fontFamily: "ui-monospace, Consolas, monospace",
        fontSize: "12px", lineHeight: "19px", whiteSpace: "pre-wrap", wordBreak: "break-word",
      },
      footerGap: { flex: "1" },
    };

    /**
     * 纯函数：两个 URL 规范化后是否实质不同（决定卡片上要不要给「主页」按钮——
     * source 与 homepage 常常是同一个仓库地址，并排两个按钮点开同一页是纯噪音）。
     * @returns {boolean} 两者都有值且规范化后仍不同 ⇒ true
     */
    function isDistinctUrl(a, b) {
      const norm = (u) => {
        let s = String(u || "").trim().toLowerCase();
        if (s === "") return "";
        s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
        s = s.replace(/[#?].*$/, "");            // 去掉锚点与查询串
        s = s.replace(/\/+$/, "");               // 去掉尾斜杠
        s = s.replace(/\.git$/, "");
        return s;
      };
      const na = norm(a);
      const nb = norm(b);
      if (na === "" || nb === "") return false;   // 任一为空 ⇒ 不显示（没得比）
      // 同仓库的子路径也算"同一个"
      return !(na === nb || na.startsWith(nb + "/") || nb.startsWith(na + "/"));
    }

    /** 一条目卡片。`note` 是这一条的操作结果（成功/失败/为什么现在不能下），就地显示。 */
    function EntryCard({ entry, note, onDownload, onInstall, onShowHow }) {
      const dl = entry.download && typeof entry.download === "object" ? entry.download : {};
      const hasUrl = typeof dl.url === "string" && dl.url !== "";
      // 有 sha256 才算正式上架（只有地址 = 还没准备好）。
      const pinned = hasUrl && typeof dl.sha256 === "string" && dl.sha256 !== "";
      return react.createElement(
        "div",
        { style: css.card },
        react.createElement("span", { style: css.icon, "aria-hidden": "true" }, entry.icon || "📦"),
        react.createElement(
          "div",
          { style: css.cardMain },
          react.createElement(
            "div",
            { style: css.nameRow },
            react.createElement("span", { style: css.name }, entry.name || entry.id),
            entry.version ? react.createElement("span", { style: css.tag }, "v" + entry.version) : null,
            // 审核标记：让"这条是审过的"在列表里一眼可见
            entry.reviewed && entry.reviewed.at
              ? react.createElement("span", { style: Object.assign({}, css.tag, css.tagOk) }, `已审核 ${entry.reviewed.at}`)
              : react.createElement("span", { style: css.tag }, "未审核"),
            dl.immutable === true ? react.createElement("span", { style: css.tag }, "固定版本") : null,
            pinned ? null : react.createElement("span", { style: css.tag }, "无下载包")
          ),
          react.createElement("p", { style: css.summary }, entry.summary || ""),
          react.createElement(
            "div",
            { style: css.meta },
            `${entry.author || "未知作者"}`,
            entry.tags && entry.tags.length ? ` · ${entry.tags.join(" / ")}` : "",
            " · ",
            react.createElement(
              "a",
              { href: entry.source || "#", target: "_blank", rel: "noreferrer noopener", style: { color: "inherit", textDecoration: "underline" } },
              entry.source || "（无源地址）"
            )
          ),
          note ? react.createElement("p", { style: note.ok ? css.note : css.err }, note.text) : null
        ),
        react.createElement(
          "div",
          { style: css.cardSide },
          react.createElement(
            "a",
            { href: entry.source || "#", target: "_blank", rel: "noreferrer noopener", className: "dsh-market-btn", style: css.btn },
            "源地址"
          ),
          // homepage 与 source 规范化后不同时才给「主页」按钮（完整来源信息在「安装方法」页）
          isDistinctUrl(entry.homepage, entry.source)
            ? react.createElement(
                "a",
                { href: entry.homepage, target: "_blank", rel: "noreferrer noopener", className: "dsh-market-btn", style: css.btn },
                "主页"
              )
            : null,
          react.createElement(
            "button",
            {
              type: "button",
              className: "dsh-market-btn",
              style: pinned ? css.btnPrimary : css.btnOff,
              disabled: note && note.busy === true,
              onClick: () => onDownload(entry),
            },
            note && note.busy === true ? "打开中…" : "下载"
          ),
          react.createElement(
            "button",
            {
              type: "button",
              className: "dsh-market-btn",
              style: css.btn,
              onClick: () => onShowHow(entry),
            },
            "安装方法"
          ),
          react.createElement(
            "button",
            {
              type: "button",
              className: "dsh-market-btn",
              style: pinned ? css.btn : css.btnOff,
              disabled: !pinned || (note && note.busy === true),
              onClick: () => onInstall(entry),
            },
            "安装"
          )
        )
      );
    }

    /** 「安装方法」子页（面板内切换右栏）：坐标、来源、审核结论、披露项。 */
    function InstallHowTo({ entry, onBack }) {
      const spec = entry.install && entry.install.spec ? entry.install.spec : "";
      const steps = entry.install && entry.install.steps ? entry.install.steps : "";
      const notes = (entry.disclosure && entry.disclosure.notes) || [];
      const warns = (entry.disclosure && entry.disclosure.warnings) || [];
      const row = (k, v) => react.createElement(
        "div",
        { style: css.howRow },
        react.createElement("span", { style: css.howKey }, k),
        react.createElement("span", { style: css.howVal }, v)
      );
      return react.createElement(
        "div",
        { style: css.howPage },
        react.createElement(
          "div",
          { style: css.howHead },
          react.createElement(
            "button",
            { type: "button", className: "dsh-market-btn", style: css.btn, onClick: onBack },
            "← 返回"
          ),
          react.createElement("h3", { style: css.howTitle }, `${entry.name || entry.id} · 安装方法`)
        ),
        row("安装坐标", spec || "（条目没给 install.spec，无法走一键安装）"),
        row("来源", entry.source || "（无）"),
        row("作者 / 版本", `${entry.author || "未知"} / ${entry.version || "—"}`),
        row("审核", entry.reviewed && entry.reviewed.at
          ? `${entry.reviewed.at}　判定 ${entry.reviewed.verdict || "—"}　坐标 ${entry.reviewed.spec || "—"}`
          : "这条没有审核记录"),
        steps
          ? react.createElement(
              "div",
              { style: css.howBlock },
              react.createElement("span", { style: css.installLabel }, "安装步骤（维护者提供）"),
              react.createElement("pre", { style: css.howPre }, steps)
            )
          : null,
        notes.length
          ? react.createElement(
              "div",
              { style: css.howBlock },
              react.createElement("span", { style: css.installLabel }, "值得你知道"),
              ...notes.map((n, i) => react.createElement("p", { key: "n" + i, style: css.discItem }, "· " + n))
            )
          : null,
        warns.length
          ? react.createElement(
              "div",
              { style: css.discWarnBox },
              react.createElement("span", { style: css.warnTitle }, "注意"),
              ...warns.map((w, i) => react.createElement("p", { key: "w" + i, style: css.discItem }, "· " + w))
            )
          : null,
        react.createElement(
          "p",
          { style: css.note },
          "装法由 DSH 官方机制执行：会解析依赖并锁版本；源码包若需要构建脚本，pnpm 会要求你显式授权，那一步不会替你点。"
        )
      );
    }

    /**
     * 安装确认面板：装之前必须让用户看到"我即将把什么装进去、它从哪来、校验值是什么"
     * （安装会下载第三方代码并写进用户数据目录，重启宿主后就会执行）。
     */
    function InstallConfirm({ entry, onConfirm, onCancel }) {
      const dl = entry.download || {};
      return react.createElement(
        "div",
        { style: css.confirmBox },
        react.createElement("p", { style: css.confirmTitle }, `确认安装「${entry.name || entry.id}」？`),
        react.createElement(
          "div",
          { style: css.confirmRow },
          react.createElement("span", { style: css.confirmKey }, "来源"),
          react.createElement("span", { style: css.confirmVal }, entry.source || "（无）")
        ),
        react.createElement(
          "div",
          { style: css.confirmRow },
          react.createElement("span", { style: css.confirmKey }, "作者 / 版本"),
          react.createElement("span", { style: css.confirmVal }, `${entry.author || "未知"} / ${entry.version || "—"}`)
        ),
        react.createElement(
          "div",
          { style: css.confirmRow },
          react.createElement("span", { style: css.confirmKey }, "校验值"),
          react.createElement("span", { style: css.confirmVal }, dl.sha256 ? `sha256 ${dl.sha256.slice(0, 16)}…` : "（缺失，无法安装）")
        ),
        react.createElement(
          "p",
          { style: css.confirmWarn },
          "安装会把该包写入 DSH 的 profile 插件位并挂载为插件；**重启宿主后它会开始运行**。" +
            "插件等同于可执行代码，请只安装你信任来源的条目。"
        ),
        react.createElement(
          "p",
          { style: css.note },
          "安装走 DSH 官方机制（会解析依赖并锁版本）。若该包是源码包、需要运行构建脚本，pnpm 会要求你显式授权 —— 那一步不会替你点。"
        ),
        entry.disclosure && entry.disclosure.notes && entry.disclosure.notes.length
          ? react.createElement(
              "div",
              { style: css.discBox },
              react.createElement("span", { style: css.discLabel }, "值得你知道"),
              ...entry.disclosure.notes.map((n, i) => react.createElement("p", { key: "n" + i, style: css.discItem }, "· " + n))
            )
          : null,
        entry.disclosure && entry.disclosure.warnings && entry.disclosure.warnings.length
          ? react.createElement(
              "div",
              { style: css.discWarnBox },
              react.createElement("span", { style: css.warnTitle }, "注意"),
              ...entry.disclosure.warnings.map((w, i) => react.createElement("p", { key: "w" + i, style: css.discItem }, "· " + w))
            )
          : null,
        entry.reviewed && entry.reviewed.at
          ? react.createElement(
              "p",
              { style: css.note },
              `审核：${entry.reviewed.at}；判定 ${entry.reviewed.verdict || "—"}；坐标 ${entry.reviewed.spec || "—"}（审核不是安全审查，详见审核记录）`
            )
          : react.createElement("p", { style: css.err }, "⚠️ 这条没有审核记录：装之前请自行核对来源与代码。"),
        react.createElement(
          "div",
          { style: css.confirmActions },
          react.createElement("button", { type: "button", className: "dsh-market-btn", style: css.btn, onClick: onCancel }, "取消"),
          react.createElement("button", { type: "button", className: "dsh-market-btn", style: css.btnPrimary, onClick: onConfirm }, "确认安装")
        )
      );
    }

    /** 市场弹窗：两页共用一套卡片渲染，只有数据源与口径说明不同。 */
    function MarketDialog({ open, onClose }) {
      // Esc 关闭（自绘遮罩后要自己接这个键）
      useEffect(() => {
        if (!open) return;
        const onKey = (e) => { if (e.key === "Escape") onClose(); };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
      }, [open, onClose]);
      const [page, setPage] = useState("plugins");
      const [catalog, setCatalog] = useState(null);
      const [error, setError] = useState(null);
      const [notes, setNotes] = useState({});
      /** 正在等用户确认安装的条目（null = 没有确认面板）。 */
      const [confirming, setConfirming] = useState(null);
      /** 正在看「安装方法」子页的条目（null = 停在列表页）。 */
      const [howTo, setHowTo] = useState(null);
      /** 安装前置体检结果（pnpm 在不在）。null = 还没读到。 */
      const [pre, setPre] = useState(null);

      useEffect(() => {
        if (!open) return;
        let alive = true;
        void (async () => {
          const r = await fetchCatalog();
          if (!alive) return;
          if (r.ok) {
            setCatalog(r);
            setError(null);
          } else {
            setError(r.error);
            setCatalog(null);
          }
          const p = await fetchPreflight();
          if (alive) setPre(p);
        })();
        return () => {
          alive = false;
        };
      }, [open]);

      const setNote = useCallback((id, note) => {
        setNotes((prev) => Object.assign({}, prev, { [id]: note }));
      }, []);

      const onDownload = useCallback(
        async (entry) => {
          setNote(entry.id, { busy: true, ok: true, text: "正在交给系统…" });
          const r = await openDownload(entry);
          const ok = r && r.ok === true;
          setNote(entry.id, {
            ok,
            busy: false,
            text: ok
              ? `已交给系统默认方式${r.url ? `：${r.url}` : ""}${r.note ? `（${r.note}）` : ""}`
              : (r && r.error) || "失败",
          });
        },
        [setNote]
      );

      const onInstall = useCallback((entry) => setConfirming(entry), []);

      /** 用户点了"确认安装"：这才是真正写盘的那一步。 */
      const doInstall = useCallback(
        async (entry) => {
          setConfirming(null);
          setNote(entry.id, { busy: true, ok: true, text: "正在下载并校验…（装完前请不要关窗口）" });
          const r = await installEntry(entry);
          if (r && r.ok === true) {
            // 插件源码不热加载：不重启宿主不会生效，这里不替用户重启（会打断会话）。
            const extra = r.notes && r.notes.length ? `（${r.notes.join("；")}）` : "";
            setNote(entry.id, { ok: true, busy: false, text: `安装完成${extra}。请重启 dshdt（或托盘「重启宿主」）后生效` });
          } else {
            setNote(entry.id, {
              ok: false,
              busy: false,
              text: `${(r && r.error) || "安装失败"}${r && r.stage ? `（失败于：${r.stage}）` : ""}`,
            });
          }
        },
        [setNote]
      );

      const spec = PAGES.find((p) => p.key === page) || PAGES[0];
      const list = catalog && Array.isArray(catalog[spec.key]) ? catalog[spec.key] : [];

      const body = (() => {
        if (error) return react.createElement("p", { style: css.err }, `目录读取失败：${error}`);
        if (catalog === null) return react.createElement("p", { style: css.note }, "正在读取目录…");
        if (list.length === 0) return react.createElement("p", { style: css.note }, spec.empty);
        return list.map((entry) =>
          react.createElement(EntryCard, {
            key: entry.id || entry.name,
            entry,
            note: notes[entry.id],
            onDownload,
            onInstall,
            onShowHow: setHowTo,
          })
        );
      })();

      // 自绘遮罩（不用官方 Modal）：左栏 188px 导航 + 右栏内容；点遮罩 / Esc / × 三种关闭方式。
      if (!open) return null;
      return react.createElement(
        "div",
        { style: css.overlay, className: "dsh-market-overlay", role: "presentation" },
        react.createElement("div", { style: css.mask, onClick: onClose, "aria-hidden": "true" }),
        react.createElement(
          "div",
          { style: css.dialog, className: "dsh-market-dialog", role: "dialog", "aria-modal": "true", "aria-label": "市场", onClick: (e) => e.stopPropagation() },
          react.createElement(
            "div",
            { style: css.nav },
            react.createElement("span", { style: css.navTitle }, "市场"),
            react.createElement(
              "div",
              { style: css.navList, role: "tablist" },
              PAGES.map((p) =>
                react.createElement(
                  "button",
                  {
                    key: p.key,
                    type: "button",
                    role: "tab",
                    "aria-selected": p.key === page,
                    className: "dsh-market-btn",
                    style: p.key === page && howTo === null
                      ? Object.assign({}, css.navCell, css.navCellOn)
                      : css.navCell,
                    onClick: () => {
                      setPage(p.key);
                      setHowTo(null);   // 切页时退出子页，避免停在另一页的安装方法上
                    },
                  },
                  react.createElement(
                    "span",
                    { style: css.navLabel },
                    p.label,
                    react.createElement("span", { style: css.navCount }, ` ${(catalog && Array.isArray(catalog[p.key]) ? catalog[p.key].length : 0)}`)
                  )
                )
              )
            ),
            react.createElement("span", { style: css.navSpacer }),
            pre && pre.pnpm === false
              ? react.createElement(
                  "div",
                  { style: css.navWarn },
                  react.createElement("span", { style: css.warnTitle }, "缺 pnpm"),
                  react.createElement("span", { style: css.navWarnText }, pre.hint || "需要先安装 pnpm。")
                )
              : null
          ),
          react.createElement(
            "div",
            { style: css.content },
            react.createElement(
              "div",
              { style: css.contentHeader },
              react.createElement(
                "div",
                { style: css.contentActions },
                react.createElement(
                  "button",
                  {
                    type: "button",
                    className: "dsh-market-btn",
                    style: css.close,
                    "aria-label": "关闭",
                    title: "关闭",
                    onClick: onClose,
                  },
                  react.createElement(primitives.IconCloseOutline16, { size: 14 }),
                  react.createElement("span", { style: css.closeLabel }, "关闭")
                )
              )
            ),
            react.createElement(
              "div",
              { style: css.options },
              howTo
                ? react.createElement(InstallHowTo, { entry: howTo, onBack: () => setHowTo(null) })
                : react.createElement(
                    react.Fragment,
                    null,
                    react.createElement(
                      "div",
                      null,
                      react.createElement("h3", { style: css.contentTitle }, spec.label),
                      react.createElement("p", { style: css.blurb }, spec.blurb)
                    ),
                    // 确认面板置顶：它挡在"会执行第三方代码"的动作前面，不该被卡片淹没
                    confirming
                      ? react.createElement(InstallConfirm, {
                          entry: confirming,
                          onConfirm: () => doInstall(confirming),
                          onCancel: () => setConfirming(null),
                        })
                      : null,
                    react.createElement("div", { style: css.body }, body)
                  )
            ),
            // 脚注永远贴底（grid 第三行）
            react.createElement(
              "div",
              { style: css.footerBar },
              react.createElement(
                "p",
                { style: css.note },
                catalog && catalog.source === "user" ? "目录来源：用户目录覆盖" : "目录来源：随包内置样例",
                catalog && catalog.updatedAt ? ` · 更新于 ${String(catalog.updatedAt).slice(0, 10)}` : ""
              ),
              react.createElement("span", { style: css.footerGap }),
              react.createElement("p", { style: css.note }, spec.caution)
            )
          )
        )
      );
    }

    /** 侧栏底部入口：形态照抄官方底部按钮，折叠成窄栏时只留图标（wide 由插槽传入）。 */
    function MarketEntry(props) {
      const [open, setOpen] = useState(false);
      const wide = props.wide !== false;
      return react.createElement(
        react.Fragment,
        null,
        react.createElement(
          "div",
          { style: css.entryLayer, className: "dsh-market-entry" },
          react.createElement(
            "div",
            { style: css.entryButtons },
            react.createElement(
              "button",
              {
                type: "button",
                className: "dsh-market-btn dsh-market-entry-btn",
                style: wide ? css.entryBtn : Object.assign({}, css.entryBtn, css.entryBtnRail),
                "aria-label": "市场",
                "aria-expanded": open,
                title: "市场",
                onClick: () => setOpen((v) => !v),
              },
              react.createElement(primitives.IconArchiveOutline20, { size: wide ? 16 : 18 }),
              wide ? react.createElement("span", { style: css.entryLabel }, "市场") : null
            )
          )
        ),
        react.createElement(MarketDialog, { open, onClose: () => setOpen(false) })
      );
    }

    exports.inject = ["slots"];
    exports.apply = function apply(ctx) {
      // `sidebar.footer.action` 是 list 型（官方 cordis 面板也在这一格），故只追加自己那一项。
      ctx.slots.inject(
        "sidebar.footer.action",
        () =>
          ctx.slots.register(
            { name: "sidebar.footer.action", id: "market", locale: undefined, label: () => "市场" },
            MarketEntry
          )
      );

      // 按钮 hover/active 必须用注入样式表（行内样式压不住伪类）。尺寸/布局一律由 JSX 行内样式
      // 决定：禁止再给 `.dsh-market-* > *` 这类"某一层结构"写带 !important 的通用子元素兜底。
      const styleEl = document.createElement("style");
      styleEl.dataset.plugin = "dsh-market";
      styleEl.textContent = `
        .dsh-market-btn { transition: background-color 0.15s ease, border-color 0.15s ease; }
        .dsh-market-btn:hover { background: var(--dsw-alias-interactive-bg-hover) !important; }
        .dsh-market-btn:active { background: var(--dsw-alias-interactive-bg-active) !important; }
        .dsh-market-btn:focus-visible { outline: 1px solid var(--dsw-alias-brand-primary, #3964fe); outline-offset: 1px; }
        .dsh-market-entry-btn:hover { background: var(--dsw-alias-interactive-bg-hover) !important; }
      `;
      document.head.appendChild(styleEl);
      ctx.effect(() => () => styleEl.remove(), "dsh-market: styles");
    };
    return module.exports;
  },
});
