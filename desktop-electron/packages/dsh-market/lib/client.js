// dsh-market 的 browser 半身（手写，与官方 dsh-client-ui-* 相同的 ModuleLoader 自加载格式）。
//
// 两件事：
//   ① 在**左侧栏底部**挂一个入口（插槽 `sidebar.footer.action`，`kind:"list"` —— 与官方的
//      cordis 面板并列，互不覆盖）。按钮形态照抄官方那个底部按钮（同样的设计令牌与 hover 规则），
//      所以风格天然一致，不需要覆写任何 vendor 样式。
//   ② 打开市场弹窗：**插件**与**美化包**两页，每张卡片给出图标、名称、说明、作者/版本、
//      源地址（新窗口打开）与下载按钮。
//
// 为什么目录数据走壳的 admin API 而不是在渲染进程直接 fetch GitHub：
//   · 壳已经有**出站 HTTPS 的成熟路径**（DSH 更新按钮查 npm registry 就是它），
//     渲染进程直连外网则要自己处理 CORS；
//   · 将来"下载 + 校验 sha256 + 落到 profile 插件位"本来就必须在 Node 侧做（渲染进程写不了盘），
//     目录与安装走同一条通道，改动面最小。
//   当前壳提供只读的 `GET /api/market/catalog`（内置样例 + 用户目录覆盖），安装端点随后接。
//
// ⚠️ 依赖的 harness 形状（升级后若入口消失，先看这两处）：
//   1. 插槽名 `sidebar.footer.action`（`dsh-client-ui-sidebar` 声明，`kind:"list"`）；
//   2. `Modal` 组件支持 `headless` —— 此时 `className` 落在 `[role="dialog"]` 卡片上，
//      标题/正文/页脚全部由调用方自绘（选目录弹窗用的就是这个形态）。
//      为稳妥起见，下面的样式**不依赖** `headless`：`className` 无论落在哪一层，
//      我们自绘的头部/正文/页脚都成立。
window.__ModuleLoader__.load({
  id: "dsh-market",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const react = require("react");
    // 图标仍取官方 primitives（与 DSH 同一份、同一实例）；
    // **但弹窗不再用 `primitives.Modal`** —— 理由见下面 overlay/dialog 的注释（返工三次的教训）。
    const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    const { useState, useEffect, useCallback } = react;

    const ADMIN = "http://127.0.0.1:25439"; // 壳 admin API（单实例固定端口；被占用时回退，届时显示"壳未响应"）

    /** 两页的静态描述：口径不同，所以文案里就把差别讲清楚（审核强度不同是产品语义，不只是实现细节）。 */
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

    /** 读一次目录。失败时把原因带回来，界面据此区分"壳没响应"与"目录为空"。 */
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

    /**
     * 请求壳把下载地址**交给系统**（默认浏览器 / 下载器）。
     *
     * 壳不下载、不解包、不写 $DSH_HOME —— 装什么、装不装，决定权在用户手里；壳只负责把地址递出去，
     * 并把地址回给界面显示出来。
     */
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

    /**
     * 请求壳**安装**该条目（走官方机制：`dsh plugin --profile web add <坐标>`）。
     *
     * 这条路会：解析依赖、锁版本、并把声明了 `dsh.bundle` 的包自动写进 profile 的 bundles
     * —— 所以它比"手抄进 node_modules"可靠得多。代价是可能有构建脚本需要授权（由壳回报原因）。
     * 不设超时：装包是分钟级（首次要下载），壳会等它真跑完再回结果。
     */
    async function installEntry(entry) {
      const r = await fetch(ADMIN + "/api/market/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: entry.id }),
      }).catch(() => null);
      if (!r) return { ok: false, error: "桌面壳未响应" };
      return await r.json().catch(() => ({ ok: false, error: "返回内容不是 JSON" }));
    }

    // ── 样式：全部用官方 CSS 变量（与设置面板、选目录弹窗同一套令牌），主题自适应 ──
    // 底部入口按钮照抄官方 cordis 面板那颗（同尺寸/同圆角/同 hover 令牌），
    // 这样"市场"看起来就是侧栏原有的一部分，而不是塞进去的异物。
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

      // ── 自绘遮罩 + 面板：**逐条照抄官方设置面板**（`dsh-client-ui-settings-general` 的 CSS module）──
      //
      // 尺寸这块我返工了四次（1240px 上限 → 70vw → 100%+!important → 自绘遮罩），
      // 最后一条教训是：**别再自己设计尺寸，照官方抄**。下面每个值都标了官方出处，改时对着抄。
      overlay: {
        // 官方 `.VOzbGW_overlay`：position:fixed; inset:0; z-index:1000; flex 居中（**无 padding**）
        position: "fixed", inset: "0", zIndex: "1000",
        display: "flex", alignItems: "center", justifyContent: "center",
      },
      mask: {
        // 官方 `.VOzbGW_mask`
        position: "absolute", inset: "0",
        background: "var(--dsw-alias-bg-mask-1)",
        backdropFilter: "var(--dsw-mask-blur)",
      },
      dialog: {
        // 官方 `.VOzbGW_panel`：**固定 800×min(800, 100vh-48)**，不是铺满 —— 这是官方观感的关键
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
      // ── 左栏导航（官方 `.nav` / `navTitle` / `navList` / `navCell`）──
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
      // 官方选中态用 `--dsw-specific-sidebar-nav-item-active`，照抄
      navCellOn: { background: "var(--dsw-specific-sidebar-nav-item-active, var(--dsw-alias-interactive-bg-hover))" },
      navLabel: { whiteSpace: "nowrap", textOverflow: "ellipsis", minWidth: "0", overflow: "hidden", display: "inline-flex", alignItems: "baseline", gap: "6px" },
      navCount: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px" },
      navSpacer: { flex: "1" },
      navWarn: { display: "flex", flexDirection: "column", gap: "4px", padding: "0 12px 20px" },
      navWarnText: {
        color: "var(--dsw-alias-label-tertiary)", fontFamily: "ui-monospace, Consolas, monospace",
        fontSize: "11px", lineHeight: "16px", whiteSpace: "pre-wrap", wordBreak: "break-word",
      },
      // ── 右栏（官方 `.content` 是纵向 flex；这里行距用 grid，见下）──
      content: {
        boxSizing: "border-box", flex: "1", minWidth: "0",
        // 官方 `.VOzbGW_content` 是 `display:flex; flex-direction:column`，滚动区用 `.options{flex:1}`。
        // **但那有个毛病：内容短时把脚注留在中间**。
        // 这里改成 grid 三行（auto / 1fr / auto）：`1fr` 那行无论内容多少都撑满 ⇒ **脚注永远贴底**。
        // 视觉与官方一致，只在"短内容"这一种情形上比官方更合理。
        display: "grid", gridTemplateRows: "auto 1fr auto", minHeight: "0",
      },
      // 官方 `.VOzbGW_header`：flex:none; height:54px; padding:20px 14px 8px 10px; space-between; align-items:flex-start
      contentHeader: {
        boxSizing: "border-box", flex: "none", height: "54px",
        padding: "20px 14px 8px 10px",
        display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "8px",
      },
      // 官方 `.VOzbGW_actions`：justify-content:flex-end; align-items:center; margin-left:auto
      contentActions: { display: "flex", alignItems: "center", gap: "8px", minWidth: "0", marginLeft: "auto" },
      // 官方 `.VOzbGW_close`：28×28 圆形、无边框、hover 用 interactive-bg-hover
      close: {
        cursor: "pointer", width: "28px", height: "28px",
        color: "var(--dsw-alias-label-primary)", background: "0 0", border: "none",
        borderRadius: "28px", padding: "0", display: "inline-flex",
        alignItems: "center", justifyContent: "center", flex: "none",
      },
      closeLabel: { clip: "rect(0 0 0 0)", whiteSpace: "nowrap", width: "1px", height: "1px", position: "absolute", overflow: "hidden" },
      // 官方 `.VOzbGW_options`：flex:1; min-height:0; padding:0 24px 24px; overflow-y:auto
      options: {
        flex: "1", minHeight: "0", padding: "0 24px 24px", overflowY: "auto",
      },
      // "已审核"标记：用 success 令牌，和 DSH 自己的成功色同系
      tagOk: {
        color: "var(--dsw-alias-state-success-primary, #3fa66a)",
        border: "1px solid var(--dsw-alias-state-success-primary, #3fa66a)",
      },
      blurb: { color: "var(--dsw-alias-label-tertiary)", margin: "0", fontSize: "12.5px", lineHeight: "19px" },
      // 前置体检告警（缺 pnpm）：用 state-warn 令牌，和 DSH 自己的告警同色系。
      // 现在它显示在**左栏底部**（`navWarn`），所以只需要标题那一条。
      warnTitle: { color: "var(--dsw-alias-state-warn-label, #b8860b)", fontSize: "12px", fontWeight: "500", lineHeight: "18px" },

      // 卡片网格（在右栏内容里）：自适应多列，窄了自然退成一列。
      // 不设 `flex:1`——**滚动交给右栏 `.content`**（与官方设置面板一致：内容列自己滚，
      // 两层都滚会出现双重滚动条与错位的滚动位置）。
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
      // 安装确认面板：**跨满整行**。body 是 grid，不指定就会被当成一格，
      // 那样"来源 / 校验值 / 披露项"这些长文本会被挤在一个 360px 列里。
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
      // 披露块：中性底（"值得你知道"），与下面的告警块区分开 —— 前者是事实陈述，后者是要留意的
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
      // 脚注：grid 第三行（`1fr` 那行撑满中间）⇒ **永远贴底**。
      // 分隔线与左右内边距**对齐官方 `.options` 的 24px**，这样它不是"贴在面板边缘的一条"，
      // 而是与内容同宽、看起来像内容区的一部分。
      footerBar: {
        flex: "none", display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap",
        padding: "10px 24px 18px", borderTop: "0.5px solid var(--dsw-alias-border-l3)",
      },
      // 「安装方法」子页：在市场面板内切换右栏（不另开弹窗），与官方设置"导航切内容"同一交互
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
     * 一个 URL 是否**与另一个实质不同**（用来决定"主页"按钮该不该出现）。
     *
     * 为什么需要：上架条目里 `source` 与 `homepage` 经常是同一个仓库地址（作者就是仓库地址），
     * 并排显示两个按钮点开同一页 = 纯噪音。判据做**规范化**后比较，避免这些假不同：
     *   `.../repo` vs `.../repo/`（尾斜杠）、`http://` vs `https://`、
     *   `.../repo#readme` / `.../repo/tree/main/...`（同仓库的子路径）都算同一个。
     * @param {string} a
     * @param {string} b
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
      // 同仓库的子路径也算"同一个"：`github.com/o/r` 与 `github.com/o/r/tree/main/x`
      return !(na === nb || na.startsWith(nb + "/") || nb.startsWith(na + "/"));
    }

    /** 一条目卡片。`note` 是这一条的操作结果（成功/失败/为什么现在不能下），就地显示。 */
    function EntryCard({ entry, note, onDownload, onInstall, onShowHow }) {
      const dl = entry.download && typeof entry.download === "object" ? entry.download : {};
      const hasUrl = typeof dl.url === "string" && dl.url !== "";
      // 有 sha256 才认为"这一条是正式上架的"：只有地址没有校验值 = 还没准备好的条目。
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
            // 审核标记：让"这条是审过的"在列表里一眼可见（不是靠详情页才知道）
            entry.reviewed && entry.reviewed.at
              ? react.createElement("span", { style: Object.assign({}, css.tag, css.tagOk) }, `已审核 ${entry.reviewed.at}`)
              : react.createElement("span", { style: css.tag }, "未审核"),
            // 地址锁在 tag/commit 上时明确标出来：这是"审的是 A、下到的也是 A"的判据。
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
          // 安装方式**不在卡片上展开**—— 卡片回到"一句话 + 几个按钮"的密度，
          // 想要细节的人自己点进去看。这与官方设置面板的交互一致：列表只给入口，细节在子页。
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
          // ⚠️ **不再单列「主页」按钮**：绝大多数条目的 homepage 与 source 是**同一个仓库地址**
          // （上架时两者都填 repo），并排两个按钮点开同一个页面 —— 用户一眼就看出是多余的。
          // 判据：homepage 与 source **规范化后不同**时才有意义；相同就不给按钮。
          // 想找主页的人在「安装方法」页里能看到完整来源信息（那里有位置，卡片上没有）。
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
          // 「安装」= 壳内一键装（会写 $DSH_HOME）。它旁边那个「下载」是给想自己动手的人用的，
          // 两者并存：安装走校验过的链路，下载只是把地址交给系统。
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

    /**
     * 「安装方法」子页（在市场面板内切换，不另开弹窗 —— 与官方设置面板"导航切换右栏"同一交互）。
     *
     * 为什么要有这一页：卡片上平铺说明会让每条都占掉半屏，
     * 目录就没法"逛"；而"怎么装"只有真要装的人关心。所以：**列表只给入口，细节在子页**。
     * 这一页同时承担"装之前该知道的事"：坐标（钉在哪个版本）、来源、审核结论、披露项。
     */
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
     * 安装确认面板。
     *
     * 为什么必须有这一步（不是走形式）：安装会**下载第三方代码并写进用户的数据目录**，
     * 之后重启宿主就会执行它。用户此刻要看到的是"我即将把什么装进去、它从哪来、校验值是什么"，
     * 而不是一个直接开跑的按钮。
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
        // **必须披露项就放在决策点上**：用户按"确认安装"之前要看到的不是列表页角标，
        // 而是"这东西会做什么、有什么值得知道的"。审核记录里写了什么，这里就显示什么。
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

    /** 市场弹窗：两个页面共用一套卡片渲染，只有数据源与口径说明不同。 */
    function MarketDialog({ open, onClose }) {
      // Esc 关闭：与官方弹窗一致（自绘遮罩后要自己接这个键；否则用户按 Esc 没反应）
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
          // 体检与目录分开读：目录失败也要能看到"为什么装不了"（体检结果决定安装按钮的可用性）
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
          // 成功时把**地址**也显示出来：用户可能想复制、或用自己的下载器。
          // 壳只把地址交给系统默认处理程序，界面这里不做任何"已安装"的暗示——
          // 装没装是用户自己的事。
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
            // 成功必须说清"下一步做什么"：挂载行已写、包已落盘，但**插件源码不热加载**，
            // 不重启宿主它不会生效——这里不替用户重启（会打断他的会话）。
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

      // 自绘遮罩：**不使用官方 Modal**（理由见上面 overlay/dialog 的注释 —— 三次返工的教训）。
      // 结构**模仿官方设置面板**（`dsh-client-ui-settings-general` 的 `.panel/.nav/.content`）：
      //   左栏固定 188px 放导航（插件 / 美化包 + 底部信息），右栏自适应放内容。
      //   尺寸/圆角/内边距也照它抄，这样两个弹窗看起来是同一套东西。
      // 关闭方式三种都保留：点遮罩、按 Esc、点「关闭」。
      if (!open) return null;
      return react.createElement(
        "div",
        { style: css.overlay, className: "dsh-market-overlay", role: "presentation" },
        react.createElement("div", { style: css.mask, onClick: onClose, "aria-hidden": "true" }),
        react.createElement(
          "div",
          { style: css.dialog, className: "dsh-market-dialog", role: "dialog", "aria-modal": "true", "aria-label": "市场", onClick: (e) => e.stopPropagation() },
          // ── 左栏：导航（官方设置面板的 nav 列）──
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
                      setHowTo(null);   // 切页时退出子页，避免"看着插件页却停在美化包的安装方法上"
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
            // pnpm 缺失：放在左栏底部（与官方设置一样把"环境提示"放在导航栏），不占内容区
            pre && pre.pnpm === false
              ? react.createElement(
                  "div",
                  { style: css.navWarn },
                  react.createElement("span", { style: css.warnTitle }, "缺 pnpm"),
                  react.createElement("span", { style: css.navWarnText }, pre.hint || "需要先安装 pnpm。")
                )
              : null
          ),
          // ── 右栏：内容（官方设置面板的 content 列）──
          react.createElement(
            "div",
            { style: css.content },
            // ① 顶部条（官方 `.VOzbGW_header`）：左空、右**只有 × 按钮**。
            //    官方设置没有"关闭"文字按钮 —— 我原来在底部放一个，是自作主张，已去掉。
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
            // ② 主体：子页（安装方法）或列表页。**自己滚动**（官方 `.options` 的角色）
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
            // ③ 脚注：grid 的第三行（`1fr` 撑满中间）⇒ **永远贴底**，内容再少也不会浮在中间
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

    /**
     * 侧栏底部入口。
     *
     * 形态照抄官方底部按钮（同一个 42px 行高、同一个圆角与 hover 令牌）；折叠成窄栏时
     * 只留图标（`wide` 由插槽传入），与官方按钮的行为一致。
     */
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
      // 底部入口：`sidebar.footer.action` 是 `list` 型（官方 cordis 面板也在这一格），
      // 所以这里只**追加**自己的那一项，不覆盖任何人的东西。
      ctx.slots.inject(
        "sidebar.footer.action",
        () =>
          ctx.slots.register(
            { name: "sidebar.footer.action", id: "market", locale: undefined, label: () => "市场" },
            MarketEntry
          )
      );

      // 按钮的 hover/active 必须用注入样式表（行内样式压不住伪类），令牌与官方按钮一致。
      //
      // ⚠️ **这里曾经有一条 `.dsh-market-dialog > * { width:100% !important; … }` 的"兜底"，
      //    它把整个右栏从弹窗里挤了出去。教训要记**：
      //    那条规则是弹窗还是**纵向 flex**（头/体/脚三段骨架）时写的，目的是防止塌成窄柱；
      //    后来弹窗改成**横向两栏**（左导航 188px + 右内容 flex:1），这条规则就变成毒药 ——
      //    `width:100% !important` 把左栏的 188px 顶掉、也把右栏顶成 100%，两栏一起溢出，
      //    而弹窗是 `overflow:hidden`，于是右栏被直接裁掉。
      //    **通用教训：给"某一层结构"写的兜底样式，必须在结构改变时一起复查**；
      //    带 `!important` 的宽度/布局兜底层尤其危险，它会让新布局静默失效而不是报错。
      //    现在这条已删除，尺寸完全由 JSX 里的行内样式决定（单一来源，没有第二处能覆盖它）。
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
