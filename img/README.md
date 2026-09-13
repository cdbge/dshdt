# 图片资源

| 文件 | 用途 | 说明 |
|---|---|---|
| `dsh.jpeg` | **应用图标源图** | 512×512。`desktop-electron/scripts/gen-icon.mjs` 用它生成 `desktop-electron/build/icon.ico`（窗口 / 托盘 / 安装包共用）；README 页脚也引用它。换图标时替换本文件后重跑该脚本。 |
| `standby.jpeg` | **吉祥物立绘** | 1254×1254。用于 README 头部的「英雄区」；与图标是同一形象。 |

两张图是同一个角色「肥鱼」，为项目所有者自用形象，随仓库一并提供。

> 与代码的关系：只有图标会进产物（`build/icon.ico` → `electron-builder` 打包）；吉祥物仅用于 README，不参与构建。
