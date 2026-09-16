# CHANGELOG — DSH Desktop（Electron 主路线）

> **位置：仓库根**（2026-09-13 由 `desktop-electron/` 移出）。它是项目级文书，放在代码目录里会让每次
> 文书提交都刷新该目录在 GitHub 文件列表的「最后提交」列，显示成与代码无关的消息。

版本策略：壳版本独立 semver（v1 Node+Chrome 壳止步 0.3.0）；DSH 依赖经 `vendor/profile` 锁定
`@deepseek-ai/dsh@0.1.5-rc.2`（2026-09-12 由 rc.8 升上来，仓库与已装应用同树），升级走独立流程（build-host + 双冒烟门禁）。

## 跨平台改造第十七步：一个坏安装包的事故与根治（2026-09-16，**未发新版：版本仍为 0.4.6**）

> **事故**：朋友机器上双击安装包就弹 `A JavaScript error occurred in the main process /
> Uncaught Exception: SyntaxError: Unexpected identifier 'lockDir'`。
> 根因是我在第十六轮改 `vendor-build.mjs` 时写坏的一处语法，**它被包进了安装包**。

**① 病因与传播链（证据链）**

我在加"版本锁"功能时，把 `const lockDir = null` 误写进了解构形参
（`buildVendorTree({ …, keepPlatforms = [], const lockDir = null })`）。
离线门禁**当场抓到并报错**，我随即修好——但**那一瞬间恰好有一次 `electron-builder --win nsis` 在跑**。
`main.mjs:25` 在**模块加载期**就 `import { buildStaging, findNpm } from './vendor-build.mjs'`，
所以那个文件一有语法错，**整个应用在加载阶段就崩**，连窗口都出不来——正是截图里的样子。

证据（逐条可复核）：

| 检查 | 结果 |
|---|---|
| 从坏安装包里抽出 `app.asar`，再取出 `vendor-build.mjs`，`node --check` | **`SyntaxError: Unexpected identifier 'lockDir'` @ 第 1006 行**（与截图逐字一致） |
| 同一 asar 里的 `main.mjs` | 语法正常（所以崩点在 import 的那个模块） |
| 仓库 `src/vendor-build.mjs` | `node --check` 通过（第 1006 行已是修好的 `lockDir = null,`） |
| 该坏代码是否进过 git | **没有**（`git status` 显示 `M`，最近提交都是文书）⇒ 不是从 GitHub 流出的 |
| `dist/win-unpacked/resources/app.asar` 时间 | 09-15 19:15:57（坏），安装包 19:16:44 由它打出 |

**② 为什么原有门禁全部没拦住**

所有门禁查的都是**仓库 `src/`**，而用户加载的是 **asar 里那一份**。两者之间隔着一个"**打包时刻**"：
源在那一刻是好是坏决定产物好坏，而**产物打出来之后再没有任何检查看过它**。
更隐蔽的是 `dist/win-unpacked` 会跨次复用——即使源已修好，不删旧目录就仍然打出旧代码。

**③ 根治：把检查挂到打包器上（`afterPack`），并让它拒绝产出**

新增 `scripts/check-packaged-asar.mjs`：取出 asar 里**每一个** `.mjs`/`.js`，逐个做语法检查
（等价于模块加载期的解析）。挂法两种，互为兜底：

- `electron-builder.yml` 的 **`afterPack`** 钩子——**每产出一个包就立刻查它自己**（本机实测钩子确实被调用）；
- CI 三个打包 job 各加一步显式检查（Windows / Linux / **macOS 两个架构各一次**）。

**④ 这道门禁自己也踩了三次坑，都修了（记下来，因为每一次都会导致"假绿"或"假红"）**

1. **路径分隔符假失败**：`asar.extractFile` 要 asar 内记录的原样路径（Windows 上是反斜杠）。
   我先按正斜杠归一 ⇒ 187 个文件全部"取不出"；改成原样传 ⇒ 仍因**前导 `\`** 失败。现在两种写法都试。
2. **管道 stdio 拿不到 stderr**：想抓 `node --check` 的错误详情，用了 `stdio: 'pipe'`——
   而受限会话**禁止匿名管道**，子进程直接 `EPERM` 起不来（`status=null`）。改成**重定向到文件再读**
   （本项目反复记录过这个坑，我这次没照做）。
3. **假绿（最严重）**：上面那条 `spawnSync` 我**忘了 import**，于是每个文件都抛 `spawnSync is not defined`，
   被归成"环境问题"，最终**报 ALL PASS——恰好放过了本来要拦的那个坏包**。
   现在不仅 import 修了，还加了一条**硬底线断言**："一个文件都没真正检查过时必须判失败"。

**⑤ 已修复并验证**

- 删除并隔离了坏安装包（`dist/win-unpacked` 也删掉重建，避免跨次复用）；
- 用修好的源**重打** `dist/DSHDesktop-Setup-0.4.6.exe`：`afterPack` 钩子在打包过程中执行并通过
  （**187 个源码文件全部可解析**）；
- 对重打后的 `win-unpacked` 跑**打包态冒烟**：**`SMOKE OK`、`cleanup: code=0`、宿主 5 秒就绪**；
- Linux 侧 `linux-unpacked/resources/app.asar` 同样 187 个文件全过。

**门禁口径**：`node scripts/test-suite.mjs` → **18 套 pass=552 fail=0 exit=0**（新增 7 条相关断言）。

**尚未验证 / 后续**

- **已经发到别人机器上的那个坏包无法自动修复**：装了的机器需要**换用重打后的安装包**（或先卸载）。
  卸载重装即可，`$DSH_HOME` 下的用户数据不受影响。
- 这道门禁只覆盖 **asar 内的代码**。`vendor` 树里的 JS 不在 asar 里（走 `extraResources`），
  它的正确性由 ABI/启动门禁与 `compare-packaged-vendor` 负责。

## 跨平台改造第十六步：Linux 三个产物全部"真跑"验真 + 四方内容一致性（2026-09-15，**未发新版：版本仍为 0.4.6**）

> 承接上一轮：macOS 那格需要 macOS（打包器硬边界），所以本轮把**Linux 侧的证据链补到完整**，
> 并把"功能与 Windows 包一致"这句话从"结构核验"升级为**逐包内容比对**。

**① 四方内容一致性：四棵树逐包版本一致**

`scripts/compare-packaged-vendor.mjs` 同时比对四棵**打包产物内**的 vendor 树：

| 树 | 来源 | 平台 | 包数 / 文件数 |
|---|---|---|---|
| `win-unpacked` | Windows NSIS 的载荷 | win32-x64 | 489 / 11168 |
| `linux-unpacked` | AppImage 与 deb 的**同一份**来源 | linux-x64 | 491 / 11151 |
| `extracted-deb` | `dpkg -i` **装完之后**的那棵 | linux-x64 | 491 / 11151 |
| `extracted-appimage` | AppImage **解包之后**的那棵 | linux-x64 | 491 / 11151 |

结果：**485 个非平台专属包逐包版本全部一致**（`PACKAGED VENDOR PARITY: ALL PASS`）。
两边"独有包"逐个点清，**全是平台专属件**：Windows 独有 4 个（`sharp-win32-x64` / `koffi-win32-x64` /
`ripgrep-win32-x64` / `node-addon-require-builtin-win32-x64-msvc`），Linux 独有 6 个
（多一个 `sharp-libvips-linux-x64`）。非平台专属包数量**两边都是 485**。

**② AppImage 的"双击路径"（FUSE 挂载）验过了——与 extract 是两条不同的路**

用户双击走 **FUSE 挂载**，而此前只验过 `--appimage-extract`。两条路的故障点不同（缺 fuse、libfuse 版本、
`/tmp` noexec…）。新增 `scripts/linux/appimage-direct-run.sh`，实测：

| 路径 | `/tmp/.mount_*` 证据 | `appimage_extracted` 证据 | 结果 |
|---|---|---|---|
| ① 直跑（FUSE 挂载） | 0 次 | **0 次** | **PASS**（`SMOKE OK`、`ready:`、种子迁移 11144 文件 / 103.1 MB） |
| ② `--appimage-extract-and-run` | 0 次 | 13694 次 | PASS（`SMOKE OK`） |

①里两个路径标记**都是 0 次**却跑起来了 ⇒ 它**真从 squashfs 挂载读**，一次都没解包。

- 前置：WSL 里要 `apt install fuse3 libfuse2t64`（装上后 `/dev/fuse` 才出现）。
- **踩到一次并已修**：两条路最初共用一个日志文件名，后一次覆盖前一次，于是差点拿"解包"的日志去充当
  "挂载成功"的证据。现在每次运行**单独落日志**，并把"走的是哪条路"的计算结果直接打在结论行上；
  没有 FUSE 时**明确跳过并标注未测**，不拿"挂载失败"冒充"应用有问题"。

**③ Linux 三个产物现在各有独立证据**

- **deb**：`dpkg -i` 真装 → 落盘/权限/依赖逐项核对 → **冒烟 PASS**
- **AppImage（extract）**：`--appimage-extract` rc=0 → **冒烟 PASS**
- **AppImage（FUSE 直跑）**：**冒烟 PASS**
- 三者用**同一套**与 Windows 同源的判据（按输出里的 `PASS` 计数，不以退出码为唯一判据），
  每次都顺带验一遍 **D8** 首启种子迁移。

**门禁口径**：`node scripts/test-suite.mjs` → **18 套 pass=545 fail=0 exit=0**（新增两条 AppImage 直跑相关断言）。

**尚未验证**

- macOS 产物仍未产出（打包器硬边界；准备与执行顺序都在 README 里）。
- FUSE 直跑是在 WSL 的 Debian 里验的：真实桌面发行版上的桌面环境集成（`.desktop` 注册、
  双击启动、托盘）仍属未验证——那需要一台带图形界面的 Linux。



## 跨平台改造第十五步：给 macOS 首跑降风险——反向断言 + 双架构树离线审计（2026-09-15，**未发新版：版本仍为 0.4.6**）

> macOS 产物需要 macOS（打包器硬边界），本机做不了。所以本轮做的是**能在本机做的那部分**：
> 把"macOS 首跑最可能失败的地方"提前查掉。结果**抓到了一条我自己上一轮写错的判据**。

**① 双架构树的离线审计（8 类平台专属件 × 2 个架构）**

macOS 会出两个 `.app`（arm64 + x64），而它们**共用同一棵 vendor 树**。任何一类平台专属件只要缺了
某一架构，那个架构的包就是"装上也起不来"，而且**打包阶段完全不报错**（`extraResources` 是整目录照拷）。
这是 macOS 首跑最可能失败的地方，且能离线查。审计结果：`koffi` / `node-pty(pty.node)` /
`node-pty(spawn-helper)` / `sharp` / `sharp-libvips` / `ripgrep` / `node-addon-system` /
`node-addon-require-builtin` —— **两套齐全，且无 win32/linux 残留**，`node-pty/prebuilds` 下恰好只有
`darwin-arm64` 与 `darwin-x64` 两个目录。

**② 抓到我上一轮写错的一条判据：反向断言太窄**

体检脚本原本只查"该有的在"，不查"不该有的不在"。我补了反向断言，但第一版只探**目标架构**：

```js
for (const [label, rel] of [['koffi', `@koromix/koffi-${otherOs}-${target.arch}`], ...])
```

于是 `koffi-win32-arm64` 这种"**别的平台 + 别的架构**"的污染它**看不见**。这是写探针时暴露的
（探针报"没抓到"，我先怀疑是自己的判定辅助函数命中多行——上一轮就栽过——查下去才发现判据本身太窄）。
现在两头都探：

- **逐类 × 逐架构**：`foreignOS × {目标架构, 另一个架构}` × 5 类包；
- **目录扫描**：`node-pty/prebuilds/` 下**任何**非目标平台族的目录都算残留（不依赖命名模板）。

**③ 顺手消掉一处断言重复**

我新加的聚合断言（"并入架构的平台专属件逐项齐全"）与原来的逐项断言是**同一件事报两条**。
这不只是噪声：它让"按名字取某条结论"的测试辅助函数命中多行，于是 `cross-tree-self-test` 里
两条断言莫名变红（`verdict` 命中 2 行时返回 null，null 被判为失败）。现在每个关注点只留**一条**断言，
逐项缺失仍会全列出来（信息量没减）。

**④ 新增/加强的断言**

`cross-tree-self-test` 42 → 45：并入架构齐全、并入架构缺件必红、`mergedPlatforms` 两种写法都认、
**"别的平台 + 别的架构"的污染必须被抓到**。四棵树复检全过：`win32-x64` 20 条、`linux-x64` 19 条、
`darwin-arm64` 19 条、**双架构 `darwin-arm64 + darwin-x64` 20 条**。

**⑤ README 补了"到 Mac 上按什么顺序跑"**（见"构建与打包"一节）：生成 icns（含 `.icns`）→
`build:mac-universal` → 体检 → 开发态冒烟 → `electron-builder --mac dmg zip --arm64 --x64` →
对 `dist/mac*/*.app` 跑打包态冒烟。这样那台机器上不需要再想顺序。

**门禁口径**：`node scripts/test-suite.mjs` → **18 套 pass=543 fail=0 exit=0**。

**尚未验证（与本轮边界一致）**

- macOS 产物仍未产出（打包器硬边界）；本轮只是把它的**前置条件**在本机能验的范围内验干净了。
- `.icns` 与双架构树都只做了**结构/内容**核验，"在真 macOS 上显示与运行"仍待那台机器。



## 跨平台改造第十四步：补上"锁与 manifest 一致性"门禁（2026-09-15，**未发新版：版本仍为 0.4.6**）

> 上一轮结尾如实留了一个口子：版本锁**需要人工重新生成**，而"忘了重新生成"不会报错。
> 本轮把它补成门禁。

**做法：同一份判据，两种强度**（因为离线自检套件不许联网，而完整判据需要 npm 联网）

- **脱网模式**（`node scripts/check-vendor-lock.mjs`，进离线套件）：纯 JSON/字节判据——
  锁存在且 `lockfileVersion=3`；锁覆盖 manifest 声明的**每一个直接依赖**（包名 + 版本）；
  锁定版本确实**满足** manifest 的范围（自带一份够用的 semver 判定：`^`/`~`/精确/`x` 范围/`||`）。
- **strict 模式**（`--strict`，联网）：把 manifest + 锁拷到临时目录跑 **`npm ci --dry-run`** ——
  让 npm 自己校验两者是不是同一套。**这是完整判据**，发布前必须跑。
- 两种模式都实现为同一个脚本，避免两份判据漂移。

**为什么选 `npm ci --dry-run` 而不是自己写全量校验**：它要的正是"校验锁与清单是否配套"这件事，
而且**零副作用**（不写 node_modules、不联网抓包，实测 655ms / 584 个包）。自己重写等价逻辑
（解析整棵依赖树 + 比对每个 transitive 的 resolved URL 与 integrity）既复杂又容易漏，不如直接用 npm 的。

**先验证了工具本身的能力，再拿它当门禁**（负向四连，全部被拦住）：

| 场景 | 结果 |
|---|---|
| 一致的 manifest + 锁 | 通过（`added 584 packages in 655ms`） |
| ① DSH 版本变了（清单 rc.2 → 0.1.4，锁还是 rc.2） | 拒绝（`npm error code ETARGET`） |
| ② 清单多了一个锁里没有的依赖 | 拒绝（`npm error code EUSAGE`） |
| ③ 锁文件缺失 | 拒绝 |
| ④ 锁文件损坏 | 拒绝 |

**踩到一处**：strict 模式最初用 `process.env.npm_execpath ?? 'npm'` 调 npm——而 `npm_execpath`
**只在"由 npm 脚本调起"时才存在**（`npm run xxx`），直接 `node scripts/check-vendor-lock.mjs` 时是空的，
于是它去 spawn 一个名为 `npm` 的可执行文件并在 Windows 上失败。改为用项目自己的 `findNpm()` 探测
（它已处理三平台布局与 `DSH_NODE_DIR` 兜底），探测不到就**明确报失败**而不是静默跳过。

**门禁挂在 CI 的 `self-test` job 上、且在三个打包 job 之前**：锁不对，三平台产物就不该被生产出来。
顺带把 workflow 里写死的"15 套离线自检（415 断言）"改成不写数字的名称——那种数字每加一条断言就陈旧一次。

**新增套件**：`scripts/check-vendor-lock-self-test.mjs`（9 断言）——正向一遍 + 四种负向
（缺直接依赖 / 版本不满足范围 / lockfileVersion 不对 / 锁损坏），手法是临时改写真实锁再逐字节还原。

**门禁口径**：`node scripts/test-suite.mjs` → **18 套 pass=542 fail=0 exit=0**。

**尚未验证**

- strict 模式**在 CI 上还没跑过**（本地跑通，且负向能力已验证）；它依赖联网与 registry 可用。
- 锁仍**需要在改 DSH 版本时重新生成**——门禁只能**发现**不一致，不能代替那次生成。
  生成命令写在脚本注释与 README 里：`npm install --package-lock-only`。



## 跨平台改造第十三步：版本锁根治"跨平台内容漂移" + 本轮就到 Linux 为止（2026-09-15，**未发新版：版本仍为 0.4.6**）

> 用户决定：**本轮就到 Linux 为止**（macOS 已确认为 electron-builder 的硬边界，见第十二步）。版本号继续不动。

**① 抓到一个真问题：同一个 DSH 版本，两个平台的包内容不一样**

起因是我给"功能与 Windows 包一致"这句话补一条**机器判据**（新增 `scripts/compare-packaged-vendor.mjs`：
逐包比对各平台**打包产物内**的 vendor 树），第一次跑就红了：

```
[② 版本一致性]
  FAIL  「linux-unpacked」与基准的同名包版本一致 — 5 处不同：
        @types/node: 22.20.2 vs 26.5.1 | node-addon-native-custom-loader: 0.1.5 vs 0.1.6 |
        node-addon-require-builtin: 0.1.5 vs 0.1.6 | undici-types: 6.21.0 vs 8.9.0 | zod: 4.6.2 vs 4.6.5
```

根因是**时间性漂移**，不是谁写错了代码：manifest 只钉死三个 DSH 包的**精确**版本，而**传递依赖是范围声明**
（`zod: ^4.4.3`、`node-addon-require-builtin: ^0.1.4`、`@types/node` 由 `protobufjs` 的 `>=13.7.0` 拉进来），
于是**不同日期装的树内容不同** —— Windows 树装于 09-12、Linux 树装于 09-14。
两边分别重建之后又变成 6 处不同，连 **`koffi`（COM/目录选择的核心原生依赖）3.2.1 vs 3.3.0** 都在漂。
**这就是"功能一致"最容易悄悄失守的形态**：没有任何报错，两个安装包就是不一样。

**② 修法：一份平台中立的版本锁，三平台共用**

- 新增 `vendor/package-lock.json`（lockfileVersion 3、587 个包、含全部 62 个平台专属条目 ⇒ **平台中立**），
  随仓库一起提交。
- `installDependencies` 在装之前把锁**拷进 profile**（npm 只认 cwd 下的锁），
  用 **`npm install` 消费而不是 `npm ci`**：锁是从某一个平台生成的，其 `optionalDependencies` 带着平台专属包
  （koffi/sharp 等按 `os`/`cpu` 解析），`npm ci` 会做全量一致性校验、在别的平台**必然**失败 —— 那会让 CI 首跑就红。
  `npm install` 的语义恰好是我们要的：**尽量遵守锁里已钉死的版本，同时按当前平台补上缺失的可选依赖**。
- 新增 `findVendorLockfile()`（`src/vendor-build.mjs`）+ `lockDir` 参数。
  **踩到一处**：真实构建走暂存布局 `<out>/.staging-build/profile`，只靠 `path.dirname()` 往上推会落到
  `.staging-build` 而不是 `<out>`，于是仓库里那份锁**永远找不到**（第一次带锁重建就打了那条"未找到版本锁"的提示）。
  现在候选里显式补上"上两级"，并由 `build-host.mjs` 显式传 `lockDir: OUT_DIR` 兜底。
  缺锁**不硬失败**（退回"各装各的"并打提示），有断言钉住这个降级行为。

**③ A/B 验证：锁确实把漂移根治了**

| 树 | 重建前 | 用同一份锁重建后 |
|---|---|---|
| Windows（`zod` / `node-addon-require-builtin` / `@types/node` / `koffi`） | 4.6.2 / 0.1.5 / 22.20.2 / 3.2.1 | **4.6.5 / 0.1.6 / 26.5.1 / 3.3.0** |
| Linux（同上） | 4.6.5 / 0.1.6 / 26.5.1 / 3.2.1 | **4.6.5 / 0.1.6 / 26.5.1 / 3.3.0** |

Windows 与 Linux 两侧都用同一份锁重建后，`compare-packaged-vendor` 三棵完整的树（win-unpacked、
linux-unpacked、**deb 装出来的那棵**）**逐包版本全部一致**：

```
[① 包集合] PASS ×2   [② 版本一致性] PASS ×2   [③ 关键件存在性] PASS ×21
PACKAGED VENDOR PARITY: ALL PASS
```

四个产物（Windows NSIS / AppImage / deb / tar.gz）已全部用对齐后的树重打。
重建过程本身也照常过门禁：Linux 侧 **ABI 门禁 OK=5 SKIP=2 FAIL=0 + 启动门禁通过**。

**④ 门禁**

- 新增断言：仓库里有版本锁且为 lockfileVersion 3、条目充足（587）、覆盖三个 DSH 包；
  `build-host` 显式传 `lockDir`；`findVendorLockfile` 考虑了暂存布局；有内容比对脚本。
- 修 bug 时**门禁当场抓到我自己写的语法错**（`const lockDir = null` 混进了解构形参，`vendor-build.mjs` 语法坏掉，
  两套依赖它的自检立刻报 `SyntaxError`）——顺带证明这套门禁不是摆设。
- 口径：`node scripts/test-suite.mjs` → **17 套 pass=533 fail=0 exit=0**。

**尚未验证（如实列出，不计入上面的结论）**

- **macOS 产物仍未产出**（打包器硬边界，见第十二步）；macOS 树**不在**本次一致性比对范围内
  （它只能在实际产出后才能进比对）。
- AppImage 解出来那棵树的本地副本**同步时被超时打断**（10,754 文件 vs 完整 11,151），因此
  **未进本次比对**；它与 `linux-unpacked` 同源（AppImage 就是它的 squashfs 镜像），且结构核验与冒烟都过了。
- 锁**需要在改 DSH 版本时重新生成**（`npm install --package-lock-only`）。这一步目前是人工的，
  没有门禁检查"锁与 manifest 是否同一套版本"（现有断言只核对锁里有没有那三个包名）。



## 跨平台改造第十二步：Linux 安装包"各自装一遍"验真 + `.icns` 跨平台化 + macOS 硬边界实测（2026-09-15，**未发新版：版本仍为 0.4.6**）

> 上一轮把 Linux 产物**打出来并在 unpacked 目录上跑通**了，但如实记了一条"未验证：
> AppImage/deb 没有各自装一遍"。本轮把那一条补掉，顺手把 macOS 那格的边界试清楚。

**① Linux 两个安装包各自真装/真跑一遍 → `VERIFY-INSTALLERS: ALL PASS`**

脚本入库 `scripts/linux/verify-installers.sh`（三种验证逐层加严）：

- **deb**：`dpkg -i` 真装成功 → 落盘与权限逐项核对通过：`/opt/DSH Desktop/dsh-desktop`（可执行位 OK）、
  `/usr/bin/dsh-desktop`（update-alternatives 自动建的）、`/usr/share/applications/dsh-desktop.desktop`、
  `/usr/share/icons/hicolor/512x512/apps/dsh-desktop.png`；`resources/vendor` 平台为 **linux-x64**；
  改包依赖记录为 `Architecture: amd64 / Version: 0.4.6 / Depends: libgtk-3-0, libnotify4, libnss3, …`。
  **冒烟 PASS**（`SMOKE OK`、rc=0、6 秒就绪）。
- **AppImage**：`--appimage-extract` **rc=0** —— 这同时是对**我们自己产出的 squashfs 镜像**的端到端验证
  （`mksquashfs` 打得对不对、镜像能不能被读）；`AppRun` 可执行、`resources/vendor` 平台 **linux-x64**；
  **冒烟 PASS**（`SMOKE OK`、rc=0）。
- 两者跑的是**同一套冒烟判据**，与 Windows 同源：按输出里的 `PASS` 计数，**不以退出码为唯一判据**。

**② `.icns` 改成纯 Node 生成（macOS 打包的最后一块跨平台拼图）**

原实现只能在 macOS 上跑：`sips -z` 逐尺寸生成 iconset，再 `iconutil -c icns`。这是**与打包本身无关的依赖**，
却足以卡住整个 macOS 打包（本机 `--mac dir` 直接报 `icon.icns not found`）。
而 `.icns` 本来就是"容器 + 若干 PNG"（现代 macOS 接受 PNG 成员），仓库里**已经有** PNG 编码器与区域平均缩放 ——
所以只需要拼容器：header(`icns` + 总长) + 每个成员(类型码 + 长度 + PNG)。

- 成员按 Apple 类型码写全 11 个：`icp4`/`icp5`/`icp6`/`ic07`/`ic08`/`ic09`/`ic10`/`ic11`/`ic12`/`ic13`/`ic14`，
  产出 2,134,371 字节，0.6 秒。
- **独立核验**（`scripts/verify-icns.mjs`，不复用生成器任何代码，纯读字节）：头 4 字节是 `icns`、
  头部声明总长 == 文件实际长度、成员表**正好走到文件末尾**（无缝无越界）、11 个成员**全是合法 PNG**、
  每个成员的宽高与类型码约定**一一对应**、16/32/64/128/256/512/1024 七档齐全。
- 退出码语义一并收紧：ico/png/icns 现在是**三平台各用一种、缺一即红**（原来非 macOS 上 icns 缺失只留 warn）。

**③ macOS 产物的硬边界：electron-builder 自己不让，不是缺工具链**

带着补好的 `.icns` 再试，拿到的是明确拒绝：

```
⨯ Build for macOS is supported only on macOS, please see https://electron.build/multi-platform-build
```

所以 macOS 那一格**在 Windows 上没有任何变通空间**（`dir` 目标也一样被拒，与签名无关）。
已把这条写进 README 与门禁注释——**别再去试**，我试过了。唯一出路是 CI 的 macos runner 或一台真 Mac。

**④ 新增/收紧的门禁**

- `.icns` 不许退回 macOS-only：判据看**是否真的去执行** `sips`/`iconutil`（`execFileSync(...'sips'...)` 形态），
  不看文件里有没有这两个词 —— 第一版断言被自己的注释绊倒了（注释里提到工具名是正常的历史记录）。
  并做了**反向验证**：往生成器里注入一次 `execFileSync("iconutil", …)`，门禁当场报红，恢复后文件逐字节一致。
- 新增断言：有 `verify-installers.sh`（"装一遍再跑"而非只看格式）、CI 的 macOS job 确实在 `macos` runner 上。

**门禁口径**：`node scripts/test-suite.mjs` → **17 套 pass=522 fail=0 exit=0**（`ci-self-test` 89→93）。

**尚未验证（如实列出，不计入上面的结论）**

- **macOS 产物仍未产出**，且已确认为**打包器层面的硬边界**（见 ③）。双架构 vendor 树已备好
  （两架构必需包各 8 项齐备、体检 pass=22），`.icns` 也已就绪，**只差在 macOS 上打一次**。
- 我手写的 `.icns` **没有在真实 macOS 上看过**：结构核验（容器/成员/PNG/尺寸档位）是充分的，
  但"Finder 与 Dock 里显示是否正常"属于观感，只能在 Mac 上确认。若 CI 上那条 `test -s build/icon.icns`
  之后能补一次打开验证会更好。
- AppImage 的**直接执行**（FUSE 挂载运行）未测：WSL 无 FUSE，走的是 `--appimage-extract`。
  真机上双击运行属未验证路径（内容与 extract 出来的一致，风险低）。

## 跨平台改造第十一步：Linux 打包产物在真 Linux 上跑通了（2026-09-15，**未发新版：版本仍为 0.4.6**）

> 上一轮（第十步）留了一条结论：**"AppImage / deb 只能靠 CI"**。本轮证明它在**本机**不成立——
> 前提是拿掉受限沙箱：那种模式下 `wsl.exe` 报 `Wsl/EnumerateDistros/Service/E_ACCESSDENIED`，
> 看起来像"主机没装 WSL"，实际只是沙箱拒绝。给完整权限后本机的 Debian 发行版一切正常
> （`wsl --install -d Debian` 即可装上）。本轮把 Linux 侧**原生**跑通：AppImage 与 deb 都在本机产出了，
> 并且在真 Linux 内核上验了真。macOS 那一格不受影响——`hdiutil`/`codesign` 是 macOS 独有的，仍需 CI 或真 Mac。

**最关键的一条证据：Linux 打包产物冒烟通过**

```
[2026-09-15T10:35:18.763Z] [vendor-home] 已把随包 vendor 拷为种子 → /root/smoke-appdata/vendor（11142 文件 / 103.1 MB）
[2026-09-15T10:35:18.764Z] vendor: 使用用户数据目录里的树（/root/smoke-appdata/vendor）
[2026-09-15T10:35:24.599Z] ready: http://127.0.0.1:41441/?token=…
[2026-09-15T10:35:24.599Z] SMOKE OK
[2026-09-15T10:35:24.599Z] cleanup: code=0
```

- **顺带验证了决策 D8**（此前只在离线单测里验过）：首启把包内 vendor 拷成用户数据目录里的种子
  （11,142 文件 / 103.1 MB），然后"使用用户数据目录里的树"——macOS/AppImage 靠的正是这条链路
  （包内不可写）。这是 D8 第一次在**真实打包产物**上跑通。
- 两个环境要求都踩过：`xvfb-run` 需要 **`xauth`**（漏了报 `xauth command not found`、退出码 3）；
  **root 身份**跑 Chromium 必须 `--no-sandbox`（否则 `FATAL: Running as root without --no-sandbox`）。
  后者只是测试环境的限制，用户装的包不需要这个参数。

**四个产物（`desktop-electron/dist/`，均已独立核验格式）**

| 产物 | 大小 | 产出环境 | 证据 |
|---|---|---|---|
| `DSHDesktop-Setup-0.4.6.exe` | 123.6 MB | Windows | 打包态冒烟 `SMOKE OK`、`cleanup: code=0` |
| `DSHDesktop-0.4.6-x86_64.AppImage` | 154.1 MB | WSL Debian 13 | ELF 头 `7f 45 4c 46`；`PACK-RC=0` |
| `DSHDesktop-0.4.6-amd64.deb` | 118.5 MB | WSL Debian 13 | `ar` 归档，含 `debian-binary`/`control.tar`/`data.tar` |
| `DSHDesktop-0.4.6-x64.tar.gz` | 143 MB | Windows 交叉 | gzip 头 `1f 8b` |

**Linux 侧原生产出的完整链路**（每一步都实跑过）：
`npm ci` → `node scripts/build-host.mjs`（**ABI 门禁 OK=5 SKIP=2 FAIL=0 + 启动门禁通过**，
宿主真起来在 `http://127.0.0.1:36303/`）→ `check-assets` → `electron-builder --linux AppImage deb` → 打包态冒烟。

**本轮修掉的三个真缺陷**（全是"在真 Linux 上跑"才暴露的，Windows 上永远看不到）

1. **命令行构建把 Electron 二进制当运行时** → 缺 GUI 依赖的环境里 Electron 根本起不来
   （本机 Debian 缺 **24 个**共享库，首个是 `libglib-2.0.so.0`），症状是 **`npm install 退出码 127`**，
   而 npm 本身完全正常（单独跑 `npm install` 秒过）——排查要绕一大圈。
   已改：命令行下（`process.versions.electron === undefined`）用 `process.execPath`，
   只有从 Electron 里调用（打包态的更新路径）才用 Electron 二进制。`build-host.mjs` 与
   `build-mac-universal.mjs` 同步改。
2. **ABI 门禁不认识 C 库变体** → Linux 平台包**同时**带 glibc 与 musl 两套二进制，而它们是
   **同名包里的子目录**：`@koromix/koffi-linux-x64/musl_x64/koffi.node`、
   `@deepseek-ai/node-addon-system-linux-x64/bin/{glibc,musl}/system.node`。
   路径里带着本平台标记（`linux-x64`），于是"别平台"判据看不见它们 ⇒ glibc 系统上 dlopen musl 那份
   必然失败 ⇒ **一棵完全健康的树被报成坏的**（koffi 与 flock 各一条 FAIL）。
   新增 `isForeignLibcPath()`（认 `musl*` / `glibc*` / `gnu` / koffi 的 `linux_x64` 五种写法），
   并把它接进 ABI 门禁的 SKIP 分支。配 4 条断言，含**反向断言**："musl 目标上同一批文件仍判 FAIL"、
   "同包内 glibc 那份坏掉仍判 FAIL"——判据不许一味放水。
3. **`ci-self-test` 的"调用位置体检"有两类假阳性**：① 块注释的纯文字续行（JSDoc 中间行）不被当作注释；
   ② 正则字面量（`/^musl(_|-|$)/` 被读成 `musl(`）。前者用**注释状态机**修掉，后者**跳过含正则字面量的行**。
   并且验证过"判据没被改瞎"：故意插一个未声明调用，门禁**必须**报出来（实测报出来了）。

**入库的 Linux 侧脚本（`scripts/linux/`，本机出 AppImage/deb 的唯一路径）**

- `install-deps.sh`：系统依赖。**镜像必须换**——`deb.debian.org` 在本机这条链路上只有 **10 kB/s** 级
  （85 个包卡 20 分钟），换阿里云后 **727 kB/s**；另外 **IPv6 不可达**，必须 `Acquire::ForceIPv4=true`，
  否则 apt 去连 AAAA 记录卡住。`ar` 来自 `binutils`（漏了 fpm 报 `Need executable 'ar' to convert dir to deb`）。
- `prepare-build-tree.sh`：把仓库拷进 **ext4**（drvfs 上 `chrome-sandbox` 的 4755、`spawn-helper` 的 0755
  保不住，打出来也是坏的），然后 `npm ci` + 建 linux vendor 树。
- `build-installers.sh`：`check-assets` → AppImage + deb → 拷回 Windows `dist/`。
- `packaged-smoke.sh`：真 Linux 内核 + xvfb 上跑打包产物，判据与 Windows 同源（按输出里的 `PASS` 计数，
  **不以退出码为唯一判据**）。
- `build-linux.ps1`：Windows 侧**唯一入口**（`pwsh -File scripts\linux\build-linux.ps1`）。
  存在理由记在文件头：从 PowerShell 一条条拼 WSL 命令会把引号/`$`/反斜杠三层嵌套搞乱（实测反复翻车），
  长任务还会被编排超时砍断并留下**持锁的僵尸 apt**，让下一次也卡住。

**新增门禁：`.sh` 不许是 CRLF 行尾（这条是白折腾好几轮换来的）**

`.sh` 在 Windows 上写出来是 CRLF，`sh -n` 会放行，但真跑起来每条命令都带尾随 `\r` —— 命令找不到、
参数变形；而外面通常套着 `> log 2>&1`，错误全被吞掉，**表现成"脚本卡住、零输出"**，
一度让人怀疑是 WSL 坏了。`ci-self-test` 新增：扫描 `scripts/**/*.sh`，CRLF 或 UTF-8 BOM 即判失败。
**验证过它会红**：故意放一个 CRLF 脚本，门禁当场报出文件名。

**门禁口径**：`node scripts/test-suite.mjs` → **17 套 pass=518 fail=0 exit=0**
（`ci-self-test` 82→89、`vendor-build-self-test` 102→105）。
**尚未验证（如实列出，不计入上面的结论）**

- **macOS `dmg`/`zip` 仍未产出**：要 macOS 工具链（`hdiutil`/`codesign`/`iconutil`），本机没有；
  WSL 也帮不上。仍需 CI 的 macos runner 或一台真 Mac。双架构 vendor 树已备好（`build:mac-universal`，
  实测两架构必需包各 8 项齐备、体检 pass=22），**只差在 macOS 上打一次**。
- AppImage 与 deb **只做了结构核验与 unpacked 目录的冒烟**，没有各自装一遍（deb 未 `dpkg -i`、
  AppImage 未挂载运行）；两者内容与 `linux-unpacked` 同源，风险低但没验就是没验。
- deb 声明的运行依赖（`libgtk-3-0` 等）在 Debian 13 上装成功，但**未在更老的发行版上验证**
  （t64 改名后 `libasound2t64`/`libgtk-3-0t64` 这类包名在不同版本上不一样）。



> 目标：让 dshdt 能在 Linux 与 macOS 上构建并发行，功能与 Windows 包一致。
> 计划与取证见 `docs/项目/计划/dshdt跨平台发行计划书.md`（本地文书，不入库）。
> 本节只记**已完成并可复核**的部分；尚未验证的部分单独列在末尾，不混进结论。

**壳侧（`src/`）**

- **新增 `src/platform-paths.mjs`**：三平台的数据/日志/home/工作区解析与 electron 可执行文件解析。
  修掉一处**阻塞级**缺陷 —— `main.mjs` 原先在模块顶层写 `path.join(process.env.LOCALAPPDATA, 'DSHDesktop')`，
  在 Linux/macOS 上 `LOCALAPPDATA` 恒为 undefined，于是**模块求值阶段就抛 `ERR_INVALID_ARG_TYPE`**，
  连 `early-errors.mjs` 都来不及落盘（症状：双击没反应、无窗口、无日志）。`early-errors.mjs` 同源问题
  一并修掉（它保持零依赖，就地实现平台分支）。
  - Windows：`%LOCALAPPDATA%\DSHDesktop`（**路径与既有排障文档完全一致**）；macOS：`~/Library/Application Support/DSHDesktop`；
    Linux：`$XDG_DATA_HOME/dsh-desktop`（缺省 `~/.local/share`）。
  - 日志目录分平台：macOS `~/Library/Logs/DSHDesktop`、Linux `$XDG_STATE_HOME/dsh-desktop/log`；
    一旦设了 `DSH_APP_DATA`，日志跟着它走（冒烟隔离要能断言位置）。
- **`host.mjs`**：`findDshBin` 补三平台全局 npm 布局（`/usr/local|/usr|/opt/homebrew/lib/node_modules`、
  Debian 的 `/usr/share/nodejs`、`~/.npm-global`、nvm 版本目录、volta）与 POSIX npx 缓存（`~/.npm/_npx`）；
  `killTree` 分平台（Windows `taskkill /T /F`，POSIX 对进程组 `-pid` 先 SIGTERM 后 SIGKILL），
  并**判 spawnSync 的返回值**——被策略拒绝时它是 `{error: EPERM}` 而非抛错，旧写法会把"没杀掉"当"杀掉了"
  （本机沙箱实测就是这个形态）；宿主在 POSIX 上以 `detached: true` 启动，成为进程组组长，整树可一次收掉。
- **`main.mjs`**：端口探测分平台（Windows `netstat -ano`；Linux `ss -ltnp` 优先、`lsof` 兜底；macOS `lsof`）——
  旧实现只有 `netstat.exe`，非 Windows 上恒返回空集，会让多窗口复用宿主退化并重复起宿主；
  shell 体检项分平台（Windows 问 pwsh、POSIX 问 bash，旧实现恒报"PowerShell 7 缺失"）；
  preflight 的系统版本判据分平台（旧实现把 Linux 内核版本当 Windows build 解析 → 恒告警）；
  非 Windows 上 `DSH_HOME` 非 ASCII 从 critical 降为 warn（macOS 中文用户名是常态）；
  Linux 开机自启改为写 XDG `~/.config/autostart/dsh-desktop.desktop`（`setLoginItemSettings` 在 Linux 是纯 no-op，
  旧实现是**静默失效**）；补 `SIGHUP` 处理（POSIX 关终端/注销会留孤儿宿主）；macOS 保留最小应用菜单
  （整体置空会连 ⌘Q/⌘C/⌘V/⌘A 一起拿掉）、`window-all-closed` 不退出 + `activate` 唤回窗口；
  打开配置文件的兜底编辑器分平台并**监听 `'error'`**（旧写法只有 `notepad.exe`，POSIX 上未处理的
  ChildProcess error 会带走主进程）。
- **`vendor-build.mjs`（构建原语，含平台门禁）**：
  - 剪枝改为**按目标平台**保留 node-pty 预编译（旧实现写死"删非 win32-x64"，在 Linux/macOS 上删掉的
    正是本平台唯一可用的那份）。
  - ABI 门禁语义修正：**本平台必需**的 `.node` 加载失败判 FAIL（旧写法会因为路径里带 `linux/arm64` 就判 SKIP，
    产出"门禁全绿但终端/附件不可用"的树）；其它平台的制品失败才 SKIP；判据由宽泛子串改为**平台三元组标记**。
  - **新增平台包门禁** `verifyTargetPackages()`：逐个核 `koffi` / `node-pty` / `sharp` / `@vscode/ripgrep` /
    `@deepseek-ai/node-addon-system-<plat>`（POSIX flock）是否真的在树里 —— ABI 门禁对"包根本没装进来"完全无感，
    而 koffi/node-pty 缺件会让宿主在 `import` 期就崩。
    **判据用直接查文件系统**：实测 `require.resolve` 会缓存已解析路径，同一进程内"先解析再删目录"仍返回旧路径，
    会让负向断言（缺件要报错）永远绿。
  - 安装支持 `--os/--cpu/--libc`（交叉构建）与可选的 `--ignore-scripts` 关闭；安装后新增
    `ensureSpawnHelpers()` 补 `spawn-helper` 的 `0755`（postinstall 被 `--ignore-scripts` 吃掉，
    POSIX 上少了它 pty 起不来）。`npmCandidates` 补 POSIX 布局（Debian/Homebrew/nvm），
    否则装好的应用报"未找到系统 npm"，DSH 更新按钮永久不可用。
  - `vendor.lock.json` 新增 `platform`（`{os, arch, libc, tag}`）与 `platformPackages` 段。
- **`scripts/`**：8 处写死的 `dist/electron.exe` 统一改为从 electron 包解析（三平台可用）；
  `build-host.mjs` 支持 `--os/--cpu/--libc`；`abi-scan.mjs` 支持目标平台；
  两个 bootgate 脚本的 `D:\Desktop\DSH Desktop` 绝对路径改为 `DSH_INSTALL_DIR`（原先只有作者本机能跑）。

**打包与图标**

- `electron-builder.yml` 补 `linux:`（AppImage+deb、`category`、png 图标目录、`MimeType`、deb `Recommends: bubblewrap`）
  与 `mac:`（dmg+zip、arm64/x64、icns、hardenedRuntime、entitlements），顶层补 `protocols:`（`dsh://` 深链）
  与 `artifactName`；新增 `build/entitlements.mac.plist`。
- `package.json` 新增 `dist:linux` / `dist:mac` / `dist:current`，并补 `license`（deb 打包必需）。
- `scripts/gen-icon.mjs` 扩展为三平台产物：`icon.ico`（Windows）、`icon.png` 1024（Linux/macOS 托盘与窗口）、
  `build/icons/{16..1024}.png`（electron-builder 的 linux 图标只认 png）、`icon.icns`（**仅 macOS 可生成**，
  用系统 `iconutil`/`sips`）；源图 <512 时明确报错（electron-builder 的转换要求 ≥512）。

**门禁与 CI**

- 新增 `scripts/test-suite.mjs`：**离线自检总入口**（本地与 CI 共用同一份清单，`npm run test:suite`）。
  此前门禁散在多个脚本里、README 声称"改动后必跑"而 **CI 里一条都没跑** —— 清单收敛成一份才能根治这种漂移。
  它自己踩过一次坑并已修：受限会话下 `spawnSync` 的管道 stdio 会被拒（返回 `EPERM`、`status=null`、`stdout` 为空），
  所以子进程输出改为**重定向到临时文件再读**，沙箱与 CI 行为一致。
- 新增 `scripts/ci-self-test.mjs`（31 断言）：CI 配置与门禁清单自查 —— 三平台 runner、产物 glob、
  打包态 smoke 的判据（不依赖不可信的退出码）、自检清单与磁盘上的套件一一对应、打包配置与图标路径一致。
  写这个自检时当场抓出两处真问题：Windows job 仍用退出码判定冒烟；`artifactName` 的断言口径写错
  （三平台各自声明即可）。
- `release.yml` 重写为**四 job 三平台矩阵**：`self-test`（windows/ubuntu/macos 三平台 matrix 各跑一遍离线自检）、
  `windows`（NSIS）、`linux`（AppImage+deb，装 `libarchive-tools`/`fakeroot`/`rpm`/`libfuse2`，冒烟走 `xvfb-run`）、
  `macos`（dmg+zip，arm64 与 x64 都出，打包前先生成并校验 `icon.icns`）；触发方式加 `workflow_dispatch`
  （不推 tag 也能验证 Linux/macOS 能否构建）；打包产物 smoke 判据统一为输出里的 `N/N PASS`。

**图标生成改为纯 Node（不再依赖 Electron）**

- 起因：`gen-icon.mjs` 原先用 Electron 的 `nativeImage` 缩放与编码，而"把一张 jpeg 缩成图标"是纯资源处理。
  在本机受限会话里 Electron **起不来**（mojo 命名管道被拒：`FATAL: platform_channel.cc: Check failed: 拒绝访问`），
  图标生不出来 ⇒ 打包前置检查永远过不去。
- 现在：新增 `scripts/lib/jpeg-decode.mjs`（自写 JPEG 解码，baseline + progressive、灰度与 YCbCr 子采样）
  与 zlib 编码的 PNG 写出；`gen-icon.mjs` 纯 Node、秒级完成，产物为 `icon.ico` / `icon.png` /
  `build/icons/*.png`（9 档）/ `icon.icns`（仅 macOS）。
- **解码器写过两次才对，教训已写进代码注释**：第一版把扫描数据里的 `FF 00` 当成段头，于是**只解析出第一个扫描**
  ⇒ 只有 DC 系数、整幅插画塌成 8×8 色块，而脚本照样退出码 0。修法是"表段跳长度、扫描段逐个字节找下一个真标记"
  的状态机。配套新增 `scripts/jpeg-decode-self-test.mjs`（非纯色 / 彩色保留 / **无块状伪影** / 多扫描 / 异常路径）
  与 `scripts/jpeg-info.mjs`（结构诊断：帧类型、扫描表、块边界与块内差分比值）。
- 新增 `scripts/check-assets.mjs`（打包前置资源检查，按平台判据）+ `predist*` 钩子：缺图标时给出
  "先跑 `npm run icons`"的可执行提示，不必等 electron-builder 在打包中途报一句难懂的错。
- `.gitignore` 增补：`build/icon.png`、`build/icon.icns`、`build/icons/` 为生成物不入库（`icon.ico` 仍入库）。

**同批次的收口修复（D2 / D3，均为"假绿门禁"类缺陷）**

- **D3：依赖完整性检查从上线起就没拦过任何东西**。两个缺陷叠加：
  ① 基线读取在模块求值时撞 **TDZ**（读了一个后面才声明的 `const`，`ReferenceError` 被 `catch` 吞掉）⇒ 基线恒为 0；
  ② 判据写成 `files < 0 || expect <= 0 || files >= expect * 0.98` ⇒ **基线缺失也被算作通过**。
  修法：基线读取与判据抽到 `src/vendor-baseline.mjs`（纯 Node，可离线单测），三态语义分开
  （`ok` / `missing-baseline` / `unreadable` / `short`，只有 `short` 是 critical，但都不再伪装成通过）；
  新增 `scripts/vendor-baseline-self-test.mjs`，含"**基线缺失不得判为 ok**"的回归断言。
- **D2：统一删除入口**。`src/` 下 7 处整树级递归 `fs.rmSync` 全部改走 `safeRemoveTree`
  （`main.mjs` 2 处：插件位替换与暂存清理；`vendor-build.mjs` 3 处：`resetDir`、剪枝、插件同步；
  `dsh-apply.mjs` 2 处：暂存清理与 `cleanupOldTrees`），`scripts/` 的 `build-host` 与 `vendor-equivalence`
  同样处理；`cpSync` 一律显式 `dereference:false, verbatimSymlinks:true`（默认会**解引用**，把链接展开成实体副本）。
  这些目标里有 junction/symlink 场（`$DSH_HOME/profiles/**/node_modules`、`profile.old-*`、`vendor/staging/**`），
  递归删除"当前恰好不跟随链接"是实现细节、不是契约。**并把规则做成门禁**：`ci-self-test` 新增
  "`src/` 下不得出现递归 `rmSync`"断言，下次绕过会当场红。

**同批次的架构决策落地（D8 / D9，用户 2026-09-14 拍板）**

- **D8：可变 vendor 树移到用户数据目录，包内那份降级为种子**。原先打包态直接在 `resources/vendor`
  上换树，这在两个平台上根本走不通：macOS 的 vendor 在 `.app` 包内（改包内容**破坏代码签名**）、
  Linux AppImage 的 `resources` 是**只读 squashfs**（rename EROFS）、deb 的 `/opt` 属 root。
  新增 `src/vendor-home.mjs`（纯 Node 可单测）：
  - `resolveVendorHome` —— Windows 保持包内（不动既有用户），Linux/macOS 用 `<APP_DATA>/vendor`；
  - `seedVendorHome` —— 首启把包内那份拷为种子，**全或全无**（先写 `.seeding` 再 rename，失败不留半棵树），
    且**已有目标绝不覆盖**（否则会把用户已经换过的版本回退）；
  - `inspectVendorHome` —— 用户目录里的树不可用时**回退用包内种子**并留痕（宁可这次不换树，也要能起来）。
  `main.mjs` 在启动早期调 `prepareVendorHome()`，`VENDOR_DIR`/staging/基线跟着这次决定走（惰性求值），
  `--diag` 会打印当前实际使用的是哪棵。新增 `scripts/vendor-home-self-test.mjs`。
- **D9：启用单实例锁 + 补齐 `dsh://` 的送达**。此前 `setAsDefaultProtocolClient` 注册了协议但**没人消费**：
  没有任何 `open-url` / `second-instance` 处理。现在四路齐全 —— macOS 的 `open-url`、
  Windows/Linux 的 `second-instance`、以及**冷启动 argv**（进程被 `dsh://…` 直接拉起，前两者覆盖不到）；
  `handleProtocolUrl` 把 URL 记进 `app.state.json` 的 `lastDeepLink` 并聚焦窗口（壳**不解释** URL 语义，
  DSH 本体零改动）。多窗口能力保留（窗口在单进程内开），顺带消除多进程并发写同一 `userData` 的 profile 损坏风险。
  **诊断类命令不抢锁**：`--doctor` / `--diag` 在应用正跑时必须能起，否则等于把工具废掉。
- `ci-self-test` 增加"D8/D9 落地痕迹"断言（8 条）：这两条是用户拍板的架构决策，最怕被后来的改动无意识回退。

**同批次的启动顺序修复与静态契约检查（2026-09-14 第四轮）**

- **修掉一个会让 CI 首跑必红的顺序缺陷**：`prepareVendorHome()`（D8 的种子迁移）原先放在 preflight 之后，
  而**冒烟模式跳过 preflight** ⇒ 打包态在新机器上跑 `--smoke` 时种子永远不会落地、`dshBin()` 判空
  （Linux/macOS job 第一次跑就会红）。现在提到 **preflight 之前、CLI 分发之前**：
  `--version`/`--doctor`/`--diag` 也都要基于"当前实际使用的那棵树"给结论。
  **修的过程中误删过 CLI 分发块**（两次编辑各去掉一份），已补回；这段如实记录，因为"调顺序"这类操作
  的风险正是这样暴露的。
- **新增跨模块导入/导出契约静态检查**（`ci-self-test`，纯文本解析）：核对 13 个 `src/` 模块的 export 名单
  与彼此的本地 import 需求，防的是 `SyntaxError: does not provide an export named …` 这类**加载期**致命错——
  它让应用直接起不来，且报错指向 import 行而不是真正的改动处。本轮拆出 3 个新模块正是它的用武之地。
- **新增 `main()` 启动顺序断言**：六个关键步骤（`prepareVendorHome` → CLI 分发 → preflight →
  遗留门禁清理 → `applyPending` → `dshBin` 检查 → `SMOKE OK`）顺序正确、各出现一次，且 CLI 六个子命令齐全。
  把这次踩到的坑变成门禁，比写在注释里可靠。
- README 增「**vendor 树的位置**（决策 D8，用户可见）」一节：三平台分别在哪个目录、为什么 macOS/Linux
  要拷一份、首启会慢一点、种子不会覆盖用户换过的树、想重置删哪个目录、`--diag` 怎么看当前用的是哪棵。

**同批次的诊断补齐与仓库卫生（2026-09-14 第五轮）**

- `--doctor` / `--diag` 增补 **D8 现场**：`preflightChecks` 新增"vendor 归属"与"vendor 种子"两行
  （用的是用户数据目录那棵还是包内种子、各自可不可用、不可用时为什么），`--diag` 的路径段也把
  **实际使用的树 / 包内种子 / staging 暂存区**三者并列打印。这一条专治"用户问这 124 MB 是什么 /
  换树怎么没生效"——先看清用的是哪棵，能省掉一整轮来回。
- `inspectorVendorHome` 的文档写明**判据只查存在性**（内容校验归 `vendor-baseline.mjs` 与构建期 ABI 门禁），
  并在单测里加了一条边界断言：lock 内容损坏仍判"存在"——防止以后有人往这里塞内容校验，
  让"能不能用"出现多个互相矛盾的定义。
- `.gitignore` 增补 `.tmp-*/`：一次性**行为探针**的落地目录（如 `.tmp-plat-probe/`）不入库。
  这类目录以点开头，`git add -A` 会照收（与坑 60 同源），必须显式覆盖。

**同批次的托盘可用性修复（2026-09-14 第六轮）**

- **修掉一条会让 Linux 用户"丢失窗口"的路径**（计划书 §3.1b 发现 ③ 的原形）：`spawnTray()` 里的
  `new Tray(icon)` 原先没有 try/catch，而 close-to-tray 的判据是 `minimizeToTray !== false && tray`。
  在 Linux 上托盘可能"创建成功却不可见"（缺 libappindicator/ayatana、GNOME 未装 AppIndicator 扩展），
  此时关窗会 `win.hide()`，而用户**没有任何恢复入口**——应用看起来死了。现在：
  - 托盘创建包 try/catch，失败则明确降级（`trayUsable = false`）并记日志；
  - 判据改用 `trayUsable`（**图标可用 + 创建成功**，`icon.isEmpty()` 也算不可用 —— `.ico` 在 Linux/macOS 上常常解不出图）；
  - 启动顺序改为**先起托盘再建窗口**：否则关窗判据可能读到初始的 `false`，用户点了关闭却什么都没发生；
  - macOS 的**单击**也唤回窗口（状态栏是单击语义，原先只挂了 `double-click`）；
  - `trayUsable` 进 `/api/status`，设置页可据此提示或置灰"关闭到托盘"开关（客户端插件的 UI 改动留待下次）。
- `ci-self-test` 增加 6 条托盘断言（try/catch、判据用 `trayUsable`、空图标算不可用、暴露给客户端、
  先托盘后窗口、macOS 单击），把这条语义钉住。

**同批次的平台排障文档与诊断补强（2026-09-14 第七轮）**

- README 新增 **「⑤ Linux / macOS 专属故障」** 一节（8 行判据表）：把跨平台实现里出现过的、
  **Windows 上不会遇到**的故障形态一次写清 —— 沙箱后端缺失（fail-closed，不是壳坏了）、托盘不可见导致
  窗口找不回来、pty 的 `spawn-helper` 权限位、`sharp` 退化到 wasm32、`dsh://` 没人接、多开导致两个宿主、
  以及"日志不在应用数据目录"。每行都给出真因与可执行处置，并明确提示：**别拿 Windows 的排障记忆去猜 Linux 的路径**。
- `--diag` 增两行现场：**托盘可用性**（Linux 上缺托盘服务时第一个要看的事实）与**最后深链**
  （`dsh://` 点了没反应时，先确认"最后一次收到"是什么时候）。

**同批次：门禁实跑与图标解码器的已知缺陷（2026-09-14 第八轮，用户解除命令行限制后）**

> 这一轮是**门禁第一次真正跑起来**（此前五轮改动都没执行过）。结果：**15 套 411 断言通过、1 条断言失败**，
> 失败项是我自己写的 JPEG 解码器，且**已定位并改走更可靠的路径**。下面是实情，不掩饰。

- **修掉一个真缺陷（门禁抓出来的）**：`seedVendorHome` 的"全或全无"没生效 ——
  `fs.cpSync(文件, 目标, {recursive:true})` 在 Node 上**不抛错**、而是静默产出**空目录**，
  于是原先只判"cpSync 没抛"的写法会把一个空 vendor 落地，连带把后续"目标已存在 ⇒ 不迁移"的判断带偏。
  现在拷贝后**必须校验结果可用**（`inspectVendorHome`），不合格就删掉并报 `seed-incomplete`。
  自检补了两条逼出失败的用例（种子是文件 / 种子目录不完整）。
- **图标生成改为"权威解码器优先"**：`gen-icon.mjs` 支持 `--rgba <文件>`，
  由新增的 `scripts/decode-icon-source.mjs`（在 Electron 里跑 `nativeImage`）先把源图解成 RGBA 交过来；
  自带解码器降为**受限环境兜底**。已在 Electron 里实跑并**目视确认图标正确**（插画与文字均正常）。
  这条路径顺带解决了两个环境坑：提权/沙箱两种上下文里 `TEMP` 解析到**不同目录**导致"解出来的文件生成器找不到"，
  所以中转文件改落到 `build/icon-source.rgba`（已被 gitignore 覆盖）。
- **自带 JPEG 解码器的"缺陷"查到真因：源图本身有损坏段**（本轮，用参考解码器逐步定位）。
  先前记录为"渐进式色度有缺陷"，实测取证后改判：
  - 失败的三个扫描（`ss=1,se=5,al=2` / `ss=6,se=63,al=2` / `ss=1,se=63,ah=2,al=1`）**全是 Y 的 AC 扫描**；
    Cb/Cr 的 AC 扫描与全部 DC 扫描都能解完；
  - `scan[4]` 的熵数据是 `ff 00 f4 3e 8b 45 ab ac 5d 62 eb 0a eb 0a eb 0a …` —— 后半段是**周期性重复的 `eb 0a`**，
    而后面还有 9.7 KB 数据；
  - 用它自己的表（49 符号、码长 2..14）逐层核对：该段开头 16 位 `1111111111110100`
    **不是表里任何合法码的前缀**（13 位码是 `1111111111110`、14 位码是 `11111111111110`）；
  - 文件里**没有 DRI、也没有任何 RSTn** ⇒ 不是"重启间隔没处理"；且只解 DC 时块平均亮度与
    sharp/libvips 的相关系数 **r = 0.9999**（均值 168.3 vs 168.0）⇒ 亮度路径正确。
  ⇒ **这段比特流按 JPEG 规范无法解码**；Chromium/libvips 能出图是走了局部损坏容错。
  **源图 `dsh.jpeg` 需要更换**（建议重新导出一份，或直接换更高分辨率的图）；在那之前图标生成
  必须走 Electron `nativeImage` 主路径（已如此）。
- **自检改成"不依赖失败数"的形态**：源图那段损坏的边界会飘（同一脚本两次运行分别失败 3 个与 6 个扫描），
  钉死数字只会得到一条随机红的门禁。现在断言只钉两件真正要保证的事：
  ① **全部 DC 扫描必须解出来**（否则整图不可用）；② **失败的扫描必须被如实报出**（不许假装成功）。
- 门禁最终口径：**15 套，412 通过 / 0 失败**（`test-suite exit=0`）。`smoke` 72 断言仍未跑（需完整权限的 GUI 会话）。

**同批次：smoke 端到端跑通 + 一个会让应用起不来的模块级错（2026-09-14 第九轮）**

- **`smoke` 第一次真正跑起来并全绿**：`72/72 PASS`、`smoke exit=0`，
  宿主 7 秒就绪（`ready: http://127.0.0.1:12921/?token=…`）、`cleanup: code=0`、优雅退出。
  这条覆盖的是**结构性不可替代**的东西：多轮改动 `main.mjs` 之后，"应用还能不能正常启动"只有端到端能验。
- **smoke 当场抓到一个会让应用完全起不来的错**（离线单测**结构上抓不到**，它们不加载 `main.mjs`）：

  ```
  App threw an error during load
  ReferenceError: argv is not defined
      at src/main.mjs:351
  ```

  成因：D9 那段"冷启动深链"我写了 `pickProtocolUrl(argv)`，而那个作用域里的变量叫 **`args`**
  （`const args = process.argv.slice(…)`）。这是**模块加载期**错误 ⇒ 打包应用双击即崩且无窗口无日志，
  正是 README 排障章节里最难查的形态。已修（`pickProtocolUrl(args)`），并在注释里写明变量名。
- **补了一道"调用位置体检"**（`ci-self-test`，秒级）：找出"被调用但从未声明"的标识符。
  定位是**低误报子集**而非完备分析 —— 正则区分不了"解构默认值"与"函数调用"（试了两版，`{ log = () => {} }`、
  模板串里的 CSS 都会被误判，而一条总在红的门禁等于没有门禁）。最终形态：只看调用形态 `name(`、
  跳过解构行、放行语言内建与**显式列出的解构形参白名单**。**已知不覆盖**：解构行、属性简写、
  模板串内的代码 —— 这类仍由 `smoke` 兜底。另加一条硬断言钉住本次的具体写法（`pickProtocolUrl(args)`）。
- 门禁最终口径：**17 套 510 断言全绿**（`test-suite exit=0`）+ **`smoke` 72/72 全绿**。

**本次尚未验证（重要，别当成已完成）**

- 上面这批改动（CI 矩阵、总入口、CI 自检、JPEG 解码器重写、图标生成、D2/D3、D8 种子迁移、D9 单实例与深链）
  **尚未在本机复跑门禁**：用户明确要求停止命令行调用，所以 `npm run test:suite`、`npm run icons`、
  `npm run check:assets` **没有在改完之后执行过**。已做的人工核对：`src/` 下已无递归 `rmSync`；
  无残留 `VENDOR_PROFILE` / `VENDOR_EXPECT_FILES` 引用；`VENDOR_DIR` 改为 `let` 且由 `prepareVendorHome()` 决定。
  下次开工第一件事：`node scripts/test-suite.mjs` → `npm run icons` → `npm run check:assets`。
- **D8 的首启迁移只做过离线单测**（`vendor-home-self-test`），**没有在真实打包产物上跑过**：
  macOS/Linux 上"首启拷 124 MB + 之后换树"这条链路必须真机验证一次（这也是 N1/N2 验收清单的第一项）。
  > **2026-09-15 已消除（Linux 侧）**：见本文件顶部「跨平台改造第十一步」——首启种子迁移在真 Linux 上
  > 跑通（拷 11,142 文件 / 103.1 MB 到用户数据目录，随后"使用用户数据目录里的树"）。
  > **macOS 侧仍未验**（本机没有 macOS）。
- `build/` 下的图标文件仍是**修复前生成的方块版**（生成物已 gitignore，重新生成即可）。
- 因此 README 里"分项断言数"以 `npm run test:suite` 的输出为权威数字。

**跨平台改造主体**（同一批次前半段，已验证）

**跨平台改造第八步：交叉构建 + vendor 树静态体检（2026-09-14，已完成并实跑验证）**

- **交叉构建真正跑通**：`scripts/build-host.mjs` 新增 `--out <目录>`——交叉产物属于**另一个平台**，
  顶替现网 `vendor/` 等于把本机应用换成起不来的树，所以交叉构建必须写到别处（默认仍是 `vendor/`）。
  交叉时 ABI 门禁与启动门禁**显式延后**：两者都要把目标平台的 `.node` 加载进当前进程、要 spawn 目标平台的宿主，
  在宿主上必然判 FAIL，而失败原因与树无关。
- **延后必须留痕（本轮最重要的一条口径）**：交叉产物的 `vendor.lock.json` 写
  `abiScan: "DEFERRED（交叉构建，需在目标平台补跑）"` 与 `gatesDeferred: {abi:true, boot:true}`。
  **"PASS" 只会出现在真跑过门禁的平台上**——lock 里一个假 PASS 会被后来的人当成"已经验过了"，
  这种假绿比不写更坏。`build-host` 也会把门禁状态打进日志。
- **实测产出（Windows 主机，2026-09-14，最终数字）**：
  - `win32-x64` 现网树（`--prune-only` 对齐后）：**11,168 文件 / 104.4 MB**，含 `conpty.node` /
    `conpty_console_list.node` 与 ConPTY 运行时（`conpty.dll` + `OpenConsole.exe`）；
  - `linux-x64`（glibc，交叉）：**11,171 文件 / 103.1 MB**，平台包 `koffi:linux-x64` / `node-pty:linux-x64` /
    `sharp:linux-x64` / `ripgrep:linux-x64` / `node-addon-system(flock)` 五项齐备，别平台残留为零，
    `prebuilds` 只剩 `linux-x64`；
  - `darwin-arm64`（交叉）：**11,169 文件 / 100.3 MB**，五项齐备，`prebuilds/darwin-arm64` 含
    `pty.node` + `spawn-helper`（已补 `0755`）。
  三棵树均由 `verify-cross-tree.mjs` 体检通过（`pass=21 / 18 / 18, fail=0`），且**体量对齐**（100–104 MB）。
- **新增 `scripts/verify-cross-tree.mjs`**：对一棵 vendor 树做平台向静态体检 —— lock 与门禁自洽、必需原生包、
  别平台残留、`node-pty` prebuilds、`spawn-helper`、与现网树的体量对比。目标平台**默认取 lock 的 `platform` 段**，
  所以同一条命令在交叉产物（`--dir .tmp-cross/linux-x64`）与 CI 的原生 runner（`--dir vendor`）上通用；
  已接入 CI 三个打包 job 作为原生平台的补充证据。
- **lock 字段集收敛为唯一一份 `buildVendorLock()`**：`buildStaging`（换树/全量构建）与 `--prune-only`（现网维护）共用。
  两个写入方各写一份字段集一定会漂移，漂移的后果是"同一个应用、两个 lock 形状"，读的人得先猜是哪一代。
- **`--prune-only` 修好**：它原先把**暂存区**当目标（报错"需要已有 node_modules `<暂存路径>`"，
  把用户指向一个他根本没打算用的目录），现改为在现网树上原地做剪枝/插件/门禁/lock；
  `buildStaging` 同时当场拒绝 `install=false`（暂存区是空的，没有树可剪）。

**同一轮由门禁当场抓出的两个真缺陷**（都不是重构引入，而是早就在、只是没人跑到）

- **① Windows 平台包门禁索要一个 Windows 上不存在的文件**：`REQUIRED_PACKAGES.win32` 的 `node-pty` 项写的是
  `prebuilds/win32-x64/pty.node` —— 而 `pty.node` 是 **Unix** 的实现。Windows 的 node-pty 加载的是另外几个：
  `conpty.node`（`lib/windowsPtyAgent.js:42`）、`conpty_console_list.node`（`lib/conpty_console_list_agent.js:11`），
  外加 `conpty/conpty.dll` + `conpty/OpenConsole.exe`（ConPTY 运行时）。
  后果不是"少查一项"：Windows 树上**永远没有** `pty.node`，于是这道门禁在 Windows 上**必然判"缺件"**，
  把一棵完好的树说成坏的（`--prune-only` 因此 100% 失败）。**一条总在喊狼来了的门禁，真缺件那次就没人信了。**
  门禁的 `kind` 判据同时由"看标签名"改为"看路径后缀"（旧写法 `label === 'node-pty'` 认这一项，
  标签一改成 `node-pty(conpty)` 就会退化成"当包查"）。
- **② 剪枝漏掉两处平台专属目录**：`node-pty/third_party/conpty/<版本>/win10-arm64`
  （Windows-ARM64 那份躺在 x64 树里，~1.2 MB）与 `@img/sharp-wasm32`（sharp 的 wasm 兜底，~9 MB）。
  两条通用规则都看不见它们：目录名既不叫 `win32-*`（是 `win10-arm64`），也不是 `pty.node`，
  更不在 `prebuilds/` 下。顺带把 **`.pdb`**（Windows 调试符号，node-pty 的 `conpty.pdb` + `conpty_console_list.pdb`
  合计 **10.6 MB**）纳入剪枝 ⇒ **Windows 树 104.4 MB，与 Linux/macOS 树体量对齐**（此前大 11 MB，差额几乎全在这里）。
  `isForeignPlatformPath` 的平台标记表也补上了 `win10-x64` / `win10-arm64` / `win10-ia32`。

**同一轮修正的一处文档级错误认知**

- **`spawn-helper` 只有 macOS 有**。原先 README 把它写成"POSIX 上 pty 的可执行依赖"，
  但 `node-pty@1.2.0-beta.15` 的 `prebuilds/linux-x64` 里**只有 `pty.node`**，`prebuilds/darwin-arm64` 才有
  `pty.node` + `spawn-helper`；源码依据是 `src/unix/pty.cc` 的 helper 分支被 `#if defined(__APPLE__)` 包着，
  Linux 走 `forkpty()`（forkpty 自己就把子进程挂成 pty 的控制终端），压根不读 helperPath。
  按旧文档去 Linux 上"修一个不存在的缺件"是白费功夫 —— 已在 `vendor-build.mjs` 与 README 排障表里改过来，
  并且体检脚本对 Linux **显式断言"不该有"**。

**跨平台改造第九步：macOS 双架构（发现一处会让 x64 产物装上也起不来的缺口）**

- **缺口**：CI 的 macOS job 跑的是 `electron-builder --mac dmg zip --arm64 --x64`，而它会把**同一棵
  vendor 树**打进两个架构的 `.app`。npm install 一次只能按一个 `--cpu` 解析可选依赖（这是 `--os/--cpu`
  的全部语义），**CLI 传了 `--arm64 --x64` 时 electron-builder 也不允许 target 再指定 arch 把两个架构分开**。
  于是 arm64 那棵树被打进 x64 的 `.app` ⇒ 那个包**装上也起不来**（`koffi` / `node-pty` 在 import 期崩）。
  这不是"某天会有的风险"：本机交叉产出 `darwin-arm64` 与 `darwin-x64` 两棵树一对比就看得出来，
  两边装的平台包互不相同。
- **顺带确认 electron-builder 不会替我们修**：`Packager.installAppDependencies(platform, arch)` 确实按
  架构调用，但（a）我们的原生件在 `vendor/profile/node_modules` 里，而 `files` 只含 `src/**`+`VERSION`+`package.json`，
  electron-builder 的重建只作用于应用自身的 `dependencies`（这里只有纯 JS 的 `electron-updater`），
  碰不到那棵树；（b）vendored 树不会进 asar（`extraResources`）。所以"每个架构的包里得有对应架构的二进制"
  这件事只能由我们自己保证。
- **解法**：新增 `scripts/build-mac-universal.mjs`（`npm run build:mac-universal`）。先建宿主架构那棵
  （macOS runner 上就是 arm64，ABI / 启动门禁**照常跑、不延后**），再单独建另一架构那棵当 donor，
  最后只把 donor 里**平台专属**的条目并进主树 —— 脚本与 JS 代码在两棵树里是同一份，整树拷贝只会引入
  "两份可能漂移的代码"这个新问题。合并后**对两个架构各跑一遍平台包门禁**，缺一个就退出（这是该脚本存在的全部理由）。
  - `src/vendor-build.mjs` 新增 `mergePlatformPackages`（含"donor 平台与目标不符就拒绝"的核对）、
    `isPlatformTaggedPath`（按 `<os>-<arch>` 标记判平台专属，**不写包名白名单**——白名单会随依赖升级静默失效）、
    `conptyDirName`；`pruneVendorTree` 新增 `keepPlatforms`（剪枝必须**同时**保住两个架构，否则主架构建完
    就把 donor 那个剪掉了——合并发生在剪枝之后，删掉的就回不来了）。
  - `vendor.lock.json` 新增 `mergedPlatforms` 段；体检脚本据此**对并入的架构也逐项验必需包**。
  - `scripts/verify-cross-tree.mjs` / `src/cross-tree-check.mjs` 认双架构树：并入架构的 `prebuilds` 算必需项、
    不算"别平台残留"。
  - CI 的 macOS job 改走 `node scripts/build-mac-universal.mjs --host arm64 --add x64`；Linux/Windows 两个 job
    仍用单平台 `build-host.mjs`（有断言钉住"别顺手改成双架构"）。
- **体积代价（如实记录）**：macOS 树 **125.9 MB / 11,192 文件**（单架构 99.9 MB / 11,167）。
  多出来的 26 MB 几乎全是 `@img/sharp-libvips-darwin-{arm64,x64}` 的两个 `libvips-cpp.8.18.6.dylib`
  （arm64 17.3 MB + x64 19.4 MB）—— **两个架构的图片处理都要能用，这份代价是必要的**。
- **顺手消掉一处重复**：`build-host.mjs` 与 `build-mac-universal.mjs` 原本各写一份 DSH 版本常量，
  已抽成 `src/dsh-versions.mjs`（三者同进同退，两份手写一定会漂移）。
- **修掉自己刚引入的一个统计缺陷**：双架构 lock 最初拿的是**合并前**的 `built.stats`，
  于是写出"100.3 MB / 11,171 文件"——少算了整个另一架构。lock 的体积与文件数正是事后判断
  "这棵树全不全"的依据，**报小了比不报更坏**；现在合并后重算 `vendorStats` 与必需包清单。

**本轮实跑证据**

- `node scripts/test-suite.mjs` → **16 套 pass=498 fail=0 exit=0**
  （`cross-tree-self-test` 24→42、`ci-self-test` 74→81）。
- 双架构树实测（Windows 主机交叉）：合并 7 个平台专属条目（6 个包 + `node-pty/prebuilds/darwin-x64`，
  含 `spawn-helper`），**darwin-arm64 与 darwin-x64 的必需包各 8 项齐备**；
  `verify-cross-tree --dir .tmp-cross/darwin-universal2` → **pass=22 fail=0**。
- 单平台三棵树仍全过：现网 `win32-x64` 18 条、`linux-x64` 17 条、`darwin-arm64` 17 条。

**跨平台改造第十步：本地交叉打包实测（能打什么、打不了什么，以及踩到的"能打包、装不上"陷阱）**

用户要求"打包成安装包，我自己找人测试去"。于是把"三平台产物"从 CI 拉到本机实测，
结果分成两半：**能打出来的**与**本机根本打不出来的**，都如实记下来。

- **Windows 上能打 Linux 包**（意外收获）：`electron-builder --linux dir|tar.gz --x64` 在这台机器上
  **成功**——它下载 linux-x64 的 Electron 发行版、按 `--linux` 打包，`extraResources` 照拷。
  产出的 `dist/DSHDesktop-0.4.6-x64.tar.gz`（143 MB）拆开核过：`resources/vendor/vendor.lock.json`
  的 `platform.tag` 是 **linux-x64**，`@koromix/koffi-linux-x64`、`node-pty/prebuilds/linux-x64/pty.node`、
  `@vscode/ripgrep-linux-x64`、`@deepseek-ai/node-addon-system-linux-x64`、`@img/sharp-linux-x64`
  与两个自带插件**全在**，win32 那几套**一个都没有**。
  前置条件两条：`--publish never`（否则它去试发布并失败），以及 **`vendor/` 里必须是 linux 树**。
- **本机打不出来的**（均为工具链硬限制，非配置问题）：
  - Linux **AppImage**：要跑 `mksquashfs`，而 electron-builder 的 `appimage-12.0.1` 缓存里只有
    `darwin/mksquashfs` 与 `linux/mksquashfs`（实测报 `spawn …\darwin\mksquashfs ENOENT`）；
  - Linux **deb**：要调系统 `fpm`（`spawn fpm ENOENT`；旧版 electron-builder 曾自带一份，26.x 不再附带）；
  - macOS **dmg/zip**：要 macOS 工具链（`hdiutil`/`codesign`/`iconutil`）。
  所以 AppImage / deb / dmg **只能在 Linux / macOS 上出**，也就是 CI 的三个 runner 或真机。
- **踩到的陷阱（本轮最有价值的一条）**：在 Windows 上产 Linux 包时，第一次忘了把 `vendor/` 换成
  linux 树 —— electron-builder **照样报"打包成功"**，而 `dist/linux-unpacked/resources/vendor` 里
  全是 **win32-x64** 的 `koffi` / `node-pty` / `sharp`。那个包在 Linux 上**装上也起不来**（import 期崩），
  打包日志里**没有任何异常迹象**。原因是 `extraResources` 是 `from: vendor` 的**整目录照拷**，
  electron-builder 完全不看里面装的是哪个平台的二进制。
  **修法（已落地）**：`scripts/check-assets.mjs`（三个 `predist*` 钩子）新增**打包前 vendor 平台核对**——
  比对 `vendor.lock.json` 的 `platform.os` 与本次打包目标，不符**直接拒绝打包**并说清是给哪个平台的；
  交叉打包用 `DSH_PACK_PLATFORM=<os>` 声明目标即可放行（有断言保证"交叉打包不被误挡"）。
  配套新增 `scripts/check-assets-self-test.mjs`（9 断言）——顺带补上了这个脚本此前**零覆盖**的空白；
  它的手法是临时改写真实 lock 的 `platform` 段再还原，因此测的是**真判据**而不是复刻品。
- **顺带修掉两处会挡住 CI 的配置缺口**：`package.json` 缺 `homepage`（deb 目标的第一道坎：
  `Please specify project homepage`）与 `author`（electron-builder 每次都警告），两个都已补上。
- **重打了 Windows 安装包**：`dist/DSHDesktop-Setup-0.4.6.exe` 由 127.4 MB 降到 **123.6 MB**
  （这轮剪枝去掉 10.6 MB 的 `.pdb` 调试符号与 9 MB 的 wasm32 兜底），拆包核对：win32 平台包齐备、
  无 linux 残留、无 `.pdb` 残留。

**本轮实跑证据**

- `node scripts/test-suite.mjs` → **17 套 pass=510 fail=0 exit=0**（新增 `check-assets-self-test` 9 断言；
  `cross-tree-self-test` 24→42、`ci-self-test` 74→82）。
- 四棵树静态体检全过：现网 `win32-x64`（18 条）、`linux-x64`（17 条）、`darwin-arm64`（17 条）、
  **双架构 `darwin-arm64 + darwin-x64`（22 条）**。
- 双架构树合并 7 个平台专属条目、两架构必需包各 8 项齐备、体积 **125.9 MB**（单架构 99.9 MB）。
- 两个交付物已拆包核对：`DSHDesktop-Setup-0.4.6.exe`（win32 树）与 `DSHDesktop-0.4.6-x64.tar.gz`（linux 树）。
- **打包产物冒烟通过**：对重打后的 `dist/win-unpacked` 跑 `--smoke`（隔离的 `DSH_APP_DATA`/`DSH_HOME`）→
  `SMOKE OK`、`cleanup: code=0`、宿主 8 秒就绪（`ready: http://127.0.0.1:14647/?token=…`）——
  证明这个安装包**真的能起来**，而不只是"打出来了"。
  （过程中的一个坑记在这里：PowerShell 里如果 `ELECTRON_RUN_AS_NODE=1` 还留在环境里，
  打包产物会**变成 Node CLI**并以 `bad option: --smoke` 退出——那是环境变量泄漏，应用本身没问题。）

**尚未验证（如实列出，不计入上面的结论）**

- Linux 的 `tar.gz` **没有在 Linux 上真跑过**（本机没有 Linux）：里面装的是 linux-x64 的 Electron 与
  对应 vendor 树，但"解压后能起来"仍需在真机/CI 上确认。同理 macOS 双架构打包只能在 macOS runner 上验。
- AppImage / deb / dmg **本机打不出来**，要等 CI 的三个 runner（或真机）。

**跨平台改造第八步的实跑证据（续）**

- `node scripts/verify-cross-tree.mjs` 对**三棵树**各跑一遍，全部 `fail=0`：
  现网 `win32-x64`（18 条）、`.tmp-cross/linux-x64`（17 条）、`.tmp-cross/darwin-arm64`（17 条）。
- `node scripts/build-host.mjs --prune-only`（现网 win32-x64 树）→ 平台包门禁 10 项全过、
  **ABI 门禁 OK=5 FAIL=0**、**启动门禁 PASS**（`http://127.0.0.1:13713/?token=…`）；
  剪掉 10.2 MB / 5 个文件后 `vendor.lock.json` 刷新为含 `platform` + `gatesDeferred` + `platformPackages`
  + `nodeModulesFiles` 的新格式。
- `node scripts/smoke.mjs`（本机，改完 vendor 树之后）→ **72/72 PASS、exit=0**
  （宿主 8 秒就绪、`cleanup: code=0`）—— 证明这轮对 vendor 树与构建脚本的改动没有影响应用启动。

**判据与 CLI 分开（顺手做对的一件事）**

`verify-cross-tree.mjs` 原先把判据写在 CLI 里，等于**没有单测**——而它偏偏是交叉产物**唯一**可用的证据。
现在判据抽到 `src/cross-tree-check.mjs`（纯函数），CLI 只负责取目录、打印、定退出码；
新增 `scripts/cross-tree-self-test.mjs` 对三平台各造一棵**正确**的树（必须全过）再逐个抽件（必须报出那一项）。
写这套单测的过程本身又抓到三个"测试自己的坑"，都写进了注释：判据行与 detail 行混在一起数（子串撞车）、
用 `line.includes('PASS')` 判结论（假绿那条断言的 detail 里正写着 `abiScan=PASS`，于是 `FAIL` 被读成通过）、
以及夹具里用 POSIX 风格路径与 `path.join()` 的 Windows 反斜杠做 `!==` 比较（skip 永远不生效，夹具"并不缺"）。

**尚未验证（如实列出，不计入上面的结论）**

- Linux / macOS 上的**真机门禁与产物**仍未验证：交叉产物的 `abiScan` 是 `DEFERRED`，**必须在 CI 的
  ubuntu/macos runner 上补跑** ABI 与启动门禁。CI 矩阵已写好（`workflow_dispatch` 可手动触发），
  但本轮**未推送、未触发**——按铁律 1.1/1.3，推送与发布需要用户点头。
- 交叉产物的 `spawn-helper` 权限位在 Windows 宿主上**读不出**（NTFS 不保存 x 位），
  只能由 macOS runner 用 `verify-cross-tree.mjs --dir vendor` 实测判定。
- D8 的首启种子迁移（拷 100 MB 上下 + 之后换树）**仍未在真实打包产物上跑过**。
- 源图 `dsh.jpeg` 含损坏扫描段（自写 JPEG 解码器的 Y-AC 路径因此失败；图标生成走 Electron `nativeImage` 兜底）。
- `host-platform-self-test` 里"通过 PATH 发现 node 目录 → 定位 npx 缓存"一条断言暂未验证通过（夹具问题，
  已在脚本内标注 SKIP 并说明影响面）。
- Linux/macOS 的安装包形态依赖（AppImage 的 libfuse2、deb 的 bubblewrap）只在文档与配置层面声明，未实机安装验证。

## 仓库整理与文书重构（2026-09-13，**未发新版：版本仍为 0.4.6**）

> 本节记录的是**仓库卫生与文书结构**的变化，**应用代码逐字节未变**（`src/**`、`packages/**` 无改动），
> 因此不产生新版本号（版本号由项目所有者指定，见 `docs/项目/02-架构与铁律.md` 铁律 1.7）。

- **清理工作区（释放 1,122 MB）**：删除 `dist/` 内 0.4.5 旧包（exe+zip+blockmap，129.4 MB 那个内含 9/8 时代
  vendor，"装了会把 harness 退回旧版"，坑 12 的风险源就此消失）、0.4.6 的两份 `.bak` 备份与重复的 `.zip`、
  `dist/.cache`、根 `.npm-cache`、`.dsh-inspect/`（**内含 `preupdate-*/.credentials.yaml` 凭证明文快照**，属卫生隐患）、
  `testing/`。**刻意保留**：`desktop-electron/.npm-cache`（`build-host.mjs` 的离线依赖缓存，本机无网时重建 vendor 的唯一依靠）、
  `.electron-cache`/`.electron-builder-cache`（离线打包工具链）、`dist/DSHDesktop-Setup-0.4.6.exe` + blockmap + `win-unpacked`、
  `scripts/certs`（本机自签证书，已 gitignore）。
- **删除 14 个一次性排障脚本**（`git rm`）：`bg-probe1~5`、`hover-probe1~4`、`rail-probe`、`dsh15-probe`、
  `dsh15-cookie-probe`、`parent-repro`、`repro-picker-worker`，以及 `src/`、`scripts/` 下已无意义的 `.gitkeep`。
  **技法不随之丢失**：像素级验证（`elementsFromPoint` + `capturePage`）、CDP 悬停实测、真实坏样本端到端复现
  已提炼进 `docs/通用/04-排障方法与通用坑.md` §8；脚本本体可 `git log --diff-filter=D -- <路径>` 追溯。
- **文书重构为「通用 / 项目」两层**：原根目录《代码规范与范例.md》（904 行单文件）与《开发注意事项与命名规则.md》
  拆分为 `docs/通用/`（4 份，与项目无关、可整目录复用到任何项目）与 `docs/项目/`（导航 / 开工清单 / 架构与铁律 /
  坑清单 / 范例与检查点），四份计划书移入 `docs/项目/计划/`。**坑编号 1~59 未变**（全仓库 `见坑 N` 继续有效），
  旧→新对照表见 `docs/项目/00-文档导航.md` §3。
- **新增坑 60**：`.gitignore` 的**行尾注释不是注释**——`.dsh/   # 说明` 整行会变成失配模式，导致 `git add -A`
  把 `.dsh/skills/**` 与 `vendor/profile/{package.json,package-lock.json}` 误入库（已用 `git rm --cached` +
  `commit --amend` 收拾，并用 `git check-ignore -v` 逐条回验）。
- **开源准备**：新增 MIT `LICENSE`、`.gitattributes`（库内 LF / Windows 脚本 CRLF / 二进制声明）、
  `.gitignore` 重写为分区白名单式；README 重写为对外入口（是什么 / 能力 / 快速开始 / 文档导航 / 已知限制 / 上传步骤）。
  敏感信息已核（无密钥、无 token）；`dist/` 等产物一律不入库，发布走 GitHub Releases。
  **已推送**：**https://github.com/cdbge/dshdt**（public，MIT，`main`，74 提交，远端与本地一致）。当天的障碍其实是**本机 schannel TLS 后端**在受控会话里失效（`SEC_E_NO_CREDENTIALS`）——GitHub 本身可达，`git -c http.sslBackend=openssl` 即通；另沙箱下 **git 的 `sh.exe` 起不来**（命名管道被拦），shell 形式的 credential helper 不可用，改用 GCM 取凭据一次性注入（`origin` 配置不含 token）。安装包走 Releases：**v0.4.6 已发布** → https://github.com/cdbge/dshdt/releases/tag/v0.4.6 ，附件 `DSHDesktop-Setup-0.4.6.exe`（133,633,708 字节，未签名，`SHA256 = 481009BD…`）。**代码自打包提交 `d11e4f9` 起零改动**（此后只动文书与开发期脚本），该附件即当前源码构建的产物。
- **README 对外化重写**（按项目所有者提供的参考风格）：右对齐**吉祥物头图** + 徽章行（Electron / 平台 / 版本 / DSH 版本 / 许可）+ 居中标题与题记 + emoji 分节（项目简介 / 核心功能 / 快速开始 / 使用说明 / 自带插件 / 架构 mermaid 图 / 项目结构 / 构建与发布 / FAQ / 文档导航 / Star）。**新增 `img/standby.jpeg`**（吉祥物立绘，由工作区 `dsh2.jpeg` 移入），与应用图标 `dsh.jpeg` 一并在 README 中引用；FAQ 五问由坑清单提炼（含 `exit code=1` 的两类判据）。
- **提交说明全量重写（80 条）并定文风为「克制专业」**：只改 message，**树对象与作者/提交者身份、时间戳逐一保留**
  （重写后 `git diff backup/pre-msg-rewrite main` 为空，HEAD 树哈希不变 `309e5a02`）。**历史哈希全部改变**，
  因此轻量 tag `v0.4.6` 一并移动到新提交（移动后已核验：Release 仍绑定、附件 133,633,708 字节状态 uploaded、
  下载链接可用）。旧链保留在**本地**分支 `backup/pre-msg-rewrite`（未推送）。文风规范写入
  `docs/通用/03-AI协作与文档义务.md` §7（四条硬规则 + 提交说明三段式 + 正反例对照）。
- **补目录说明文件**：新增 `docs/README.md`（文档两层结构与维护义务）与 `img/README.md`（图片用途与构建关系）；
  `desktop-electron/README.md` 补记变更日志的新位置并订正坑计数（60 → 63）。GitHub 打开目录时会渲染该目录的
  `README.md` 作为目录说明，文件列表行的「最后提交」列也随之变成描述性消息。
- **开发文书移出公开仓库**：`docs/`（通用规范 4 份 + 项目文书 5 份 + 计划书 4 份）自本日起**仅在本地维护**，
  已写入 `.gitignore`（`docs/`）；根 README 的文档导航收缩为代码侧 README 与 CHANGELOG，并改掉项目结构树、
  构建说明、Star 段里会失效的引用；`desktop-electron/README.md` 与 `dsh-auto-approval/README.md` 的 6 处
  `docs/...` 引用改为「本地开发文书」表述。**历史条目里的 `docs/...` 路径保留原样**（记录当时事实，不回改）。
- **提交标题统一缩短到 45 字符内**：GitHub 文件列表那一列显示的是「最后一个改动该路径的提交」的标题首行，
  超过一行宽度就会被截成「…」，读起来像变更日志的残句。本轮把 **91 条提交的标题全部压缩**（最长 43 字符，
  细节移入正文）；**其中 38 条提交的括号细节原本不在正文里**，已由脚本的安全网补进正文，避免丢信息。
  **树内容逐字节未变**（新旧链 `git diff` 为空、HEAD 树哈希相同），轻量 tag `v0.4.6` 随之移动
  （移动后已核验：Release 仍绑定、附件 133,633,708 字节状态 uploaded）。规则写入 `docs/通用/03-AI协作与文档义务.md`
  §7：标题 ≤ 45 字符、细节一律入正文。
- **提交正文整体移除（同日）**：正文记录的是开发期推理、内部编号与本机现象，不适合公开仓库。
  **92 条提交只保留标题**，树内容仍逐字节未变（新旧链 `git diff` 为空、HEAD 树哈希相同），
  tag `v0.4.6` 随之移动（Release 与附件已再次核验）。**带正文的版本保存在本地备份分支**：
  `backup/pre-body-strip`（带正文的上一版）与 `backup/pre-msg-rewrite`（更早的原始链），两者均未推送。
- **`desktop-electron/README.md` 重写为项目 README**：原文是内部笔记体（`M2` 里程碑、`v1` 迁移、「分享给朋友」等表述，
  且事实过期：vendor 写成 rc.6 / 207 MB、自动更新标成待办、仍在警告已删除的 0.4.5 旧包）。新版按对外口径组织：
  版本锚点（壳 0.4.6 / DSH `0.1.5-rc.2` / Node 24.18.1 / Electron 43.4.0 / 运行时 11,177 文件 124 MB）、
  目录结构（标注哪些进安装包）、开发运行与命令行旗标、环境变量、门禁（9 套 242 断言 + smoke 72）、
  构建与打包（含自签流程与「包体为什么大」）、更新通道（DSH 本体 ✅ / 壳自更新 ⏸）、自带插件、
  排障（`exit code=1` 两类判据、退出码语义、日志特征表）。

## 0.4.6 (2026-09-12)

> 打包与门禁口径见本地开发文书（`docs/项目/01-新会话开工清单.md` 状态锚点、`docs/项目/04-范例与检查点.md` §6）。
> **本节按"事故 / 结论"倒序记录**：09-12 的
> 他人机器故障定位在最前，其后是 09-11~09-12 同一版本内的功能与修复条目（皮肤三件套、
> 审批插件 v2、DSH 更新按钮、harness 升 0.1.5-rc.2 等）。

- **【事故/现场·他人机器】全新机器装 0.4.6 后"应用直接打不开"，通知报 `DSH 宿主意外退出 exit code=1`**。
  现象：朋友机器（装过更早的 dshdt）安装 0.4.6 后启动即弹
  「DSH 宿主意外退出：exit code=1，正在自动重启宿主」，三次后整个应用退出。
  **先纠正口径**：这条通知不是 DSH 本体发的，是壳在 `src/main.mjs:505` 发的；`code` 是宿主子进程
  （`dsh web`）的退出码，**真因不在通知里**。DSH 侧 `code=1` 只有一条来路 ——
  `@deepseek-ai/dsh-app-boot` 的 `installFailLoud()`（`lib/index.js:1401-1421`）在
  启动期 **unhandledRejection / 插件树装载失败**时写一行
  `fatal load failure: <stack>` 到 **stderr** 再 `exit(1)`；而壳把宿主 stdout/stderr 全量重定向到
  `%LOCALAPPDATA%\DSHDesktop\logs\host.log`（`src/host.mjs` 的 `startHost`）——**那行才是真因**。
  **本机取证（用于排除"包坏了"）**：拿安装包内的运行树
  （`dist\win-unpacked\resources\vendor`，11175 个文件、`bin.js` 在位）在隔离 `DSH_APP_DATA`/`DSH_HOME`
  下跑 `--smoke` → **宿主 5 秒就绪、`SMOKE OK`、`cleanup: code=0`**；空 `DSH_HOME` 同样能起。
  ⇒ **0.4.6 这个包本身是好的**，故障在对方机器的**环境或残留数据**。
  **【09-12 后续更正】该机是重装过 Windows 的全新环境** ⇒ 上一轮"旧版 dshdt 留下的 `DSH_HOME`"
  这个头号嫌疑**不成立**（重装后 `%USERPROFILE%` 是新的，没有旧数据可留）。仍成立的是**第 1 类**机器
  （留着旧数据，或恢复出厂但保留了用户目录）：卸载程序不删用户数据
  （`deleteAppDataOnUninstall: false`），而新版**必然优先读它**（`main.mjs:38`：`DSH_HOME` 环境变量 →
  `%USERPROFILE%\.dsh` 存在即用 → `%LOCALAPPDATA%\DSHDesktop\dsh-home`）；旧目录里有一处读不动，
  宿主就启动即退出 —— 这正是"重装永远修不好"的那一类。**处置**：先读 `host.log` 定位，
  再对 `%USERPROFILE%\.dsh` 与 `%LOCALAPPDATA%\DSHDesktop\dsh-home` **改名（不删）**后重启应用。
  **全新环境（重装过）改看第 2 类**：方向换成"环境是否允许它跑"（杀软/组策略拦截、
  `%USERPROFILE%` 含中文导致原生模块加载失败、`NODE_OPTIONS`/`DSH_BIN` 等全局变量注入、
  解压不完整、N/KN 版或缺 Media Feature Pack）。
  **两类判据表与完整步骤已写进** `desktop-electron/README.md`「对方机器报『DSH 宿主意外退出 exit code=1』时怎么办」。
  **顺手核实掉一条曾经的死因**：`dsh-credentials-local` 现在**会自动迁移**旧版扁平凭证
  （`lib/index.js:656` → `migrateFlatDocument`，`171` 行的识别器范围精确），所以"旧版留下的
  `.credentials.yaml`"不再必然致命；仍会致命的是**被手工改坏/写坏**的凭证文件
  （docblock 640-646 的原则：存在的凭证文件绝不能被当成"没有凭证"）与语法坏掉的 `settings.yaml`
  （`dsh-settings-file/lib/index.js:143` 启动读盘硬抛，只有热重载才降级为 warn）。
- **★【事故·真凶】插件挂载被追加在 DSH 补丁层模板的 `[]` 之后 → `cordis.patch.yml` 成"YAML 双节点" → 宿主每次启动即 `code=1`**
  （已修复；他人机器故障的最终根因，规范坑 59）。症状：某台机器**36 次运行全部失败**、每次都是同一条
  `dsh: failed to parse overlay …\cordis.patch.yml: YAMLException: end of the stream or a document separator is expected (4:1)`，
  文件内容 = `[]` + 注释 + `- insert:`。机制：`dsh-app-boot` 的 `PROFILE_PATCH_TEMPLATE`（`lib/index.js:360-364`）
  **本身就以 `[]` 结尾**、且只在文件不存在时才写，而壳旧写法把挂载 `- insert:` 直接追加在其后 →
  同一文件两个 YAML 文档；**谁先创建该文件决定成败**（壳先建 → 合法；DSH 模板先落盘 → 必然非法），
  因此**只发生在"`$DSH_HOME` 已有 profile"的机器上**——本机冒烟全绿、别人机器一次都起不来。
  更糟的是它**自愈不了**：旧幂等判据是"正则查包名是否出现"，而那句注释里就带着包名 → 直接跳过写入 →
  坏文件永久留在 `$DSH_HOME`，**卸载重装也没用**。修法：① `ensureProfilePluginMount` 改为
  "**末行是 `[]` 就替换该 token、否则追加**"（保留模板注释与用户条目）；② 新增 `repairProfilePatchYaml()`
  **每次启动都跑**（判据：存在单独一行的 `[]` 且文件中还有顶层条目 → 只删该行），把已中招的机器救回来。
  **验收**：新增 `scripts/patch-mount-self-test.mjs`（**16 断言**，含 DSH 真实模板与那台机器的真实坏文件，
  用真 `js-yaml` 解析验收）；**端到端**把坏文件逐字喂给**安装包载荷** → 壳日志"已修复损坏的 profile 补丁层" →
  宿主 `stdio=pipe` 就绪 → **`SMOKE OK` / `exit=0` / 9.3 秒**。
- **顺带修掉一处自己引入的性能问题**：stdio 探针原拿**真 argv** 跑 `spawnSync`，在"能建管道"的机器上
  会把宿主完整启动一遍并等它退出 → 冷启动白等约 2 分钟（实测 `error=ETIMEDOUT`）；改跑 `-e ''`
  这种立刻退出的等价进程（同 runtime、同 stdio 形状）后 **128s → 8.8s**。
- **本轮为"能不能定位"补的判别口径**（都出自源码，别再靠猜）：宿主退出码 `1` = 启动即退出（见上）；
  `2` = 壳自己没找到 dsh CLI（`main.mjs:1250`）或 `ELECTRON_RUN_AS_NODE` 泄漏（`node-guard.mjs`）；
  `3` = 同一 `DSH_HOME` 已有实例（走复用，不是故障）。**用户可见的"意外退出"通知只在非 0/3 时才有意义**
  ——通知里那个数字本身永远不是结论。
- **【加固·可诊断性】宿主崩溃不再"死无对证"：stdio 两级化 + 真因进通知**（同日修复并验证）。
  老问题：`startHost` 用 `stdio:['ignore', fdOut, fdOut]` 把 fd 交给子进程、父进程从不读，**宿主崩溃时
  它 stderr 里的真因随进程消失**——`host.log` 反复退化成只剩一行 `--- run … ---`，这正是"别人机器起不来"
  排查三轮拿不到真因的原因。**改法**：`spawnSync` 先探一次管道可用性 → 可用走 `['ignore','pipe','pipe']`，
  父进程**实时落盘 + 环形缓冲最近 60 行**（`child.dshRingLines()`），宿主异常退出时把最后几行
  **直接写进托盘通知**与 `app.log`；管道被系统拒绝（受限会话 `spawn EPERM`）则**自动退化为 fd 直通**保功能，
  并在 `--diag`/壳日志留痕。stderr 另存 `logs\host.stderr.log`（与 stdout 分开，便于直接看真因）。
  **踩坑记录（已入规范坑 57）**：探测不能用 `try { spawn(pipe) } catch {}` —— Windows 上 `spawn` 失败是
  **异步 `'error'` 事件**，catch 接不到，结果是"假成功"（child 已死却照常返回给调用方，宿主一个字节不输出）。
- **【新增】`--diag` 一键取证**：壳版本/Electron/系统与用户名、四条路径（含**非 ASCII 标记**）、
  可疑环境变量（`NODE_OPTIONS`/`ELECTRON_RUN_AS_NODE`/`DSH_BIN`/`DSH_HOME`/代理…）、preflight 全项结果、
  宿主锁与 **stdio 模式**、依赖文件数（对比 lock 基线）、`host.stderr.log`/`host.log`/`app.log` 尾部
  → 打印并落 `logs\diag-report.txt`。**用途：他人机器报"装完打不开"时，让对方跑一条命令即可收口**。
- **【新增】启动前 preflight（环境不允许就明说，而不是退化成退出码）**：`DSH_HOME` 含非 ASCII（critical）、
  工作区含非 ASCII（自动回退到 ASCII 目录并记日志）、`NODE_OPTIONS` 已设置（critical，会注入宿主使其启动即崩）、
  `DSH_BIN` 指向不存在的文件、应用数据目录不可写（critical）、磁盘余量、**依赖完整性**
  （数 `node_modules` 文件数与 `vendor.lock.json` 的基线比对，低于 98% 判"缺件：杀软隔离/解压不全"）。
  critical 时弹**带修法的说明框**并中止启动；`--doctor` 改为**复用同一套判据**（不再各写一份，避免口径漂移）。
  配套：`vendor-build` 的 lock 新增 `nodeModulesFiles` 字段作为基线（`totalFiles` 含 profile 其余文件，不适用）。
- **验证**：语法 + **8 套离线自检全绿**（219 断言 + admin-bg 7；审批插件 10/37）；
  **（09-12 追加）本轮再加 `patch-mount-self-test` 16 断言 → 共 9 套 / 242 断言，全绿**；
  **打包态冒烟（完整权限）** `exit=0`、`stdio=pipe`、`ready: …`、`SMOKE OK`、`cleanup: code=0`，
  宿主 spawn→就绪约 5.5s，`host.stderr.log` 确认收到插件装载行。
  **自省（入规范坑 58）**：本轮一度在**受限沙箱**里连跑打包产物冒烟，把规范坑 1（pipe EPERM）与
  坑 14（沙箱里退出码 `-2147483645` 是收尾伪影、以日志 `SMOKE OK` 为准）两条**早已写明**的事实
  误判成"壳自杀"，白耗十几轮——**打包态冒烟必须完整权限**。

## 0.4.6 (2026-09-11 ~ 09-12)

- **`dsh-auto-approval` 决策层 v2：关键词表降级为"证据"，裁决权交给一次独立模型审查**
  （用户澄清需求："是**你（AI）** 审批，不是弹一个窗口让我审"，且"独立模型配置走本体配置、走统一 Key"）。

  **v1 的问题**：裁决就是 `gradeRequest()` —— **17 行纯字符串匹配**（alwaysAskTools → 无 reason →
  66 条高风险词子串命中 → 12 个低风险工具 → 其余 medium）。插件里 `llm`/`model`/`prompt`
  引用数为 **0**，**没有任何模型参与**。它分不出这两种情况的区别：
  ```
  Remove-Item -Recurse -Force   在 workspace 内 → 正常开发，该放
  Remove-Item -Recurse -Force   在 C:\Windows 下 → 灾难，该拦
  ```
  两者命中的是**同一个词**，所以"看字符串"永远代替不了"看意图"。

  **v2 改法**：① `prefilter()` 只产出**硬拦**（`alwaysAskTools` / 无 `reason`，**永远不给模型放行权**）
  与**快路**（白名单工具且无风险词命中 → 直接放行，**不花一次模型调用**），关键词命中**降级为证据**；
  ② 其余全部交 `reviewWithLlm()` —— 一次**独立模型调用**，全新上下文、只问一件事：该不该放；
  ③ **模型完全走本体配置**：路由取 `agentDefaultModel.currentSelection()`（即 `settings.yaml` 的
  `agent-default-model` 段），凭据由 `ctx.llm` 用**统一 Key** —— 插件**不配置、也不接触**
  provider / model / apiKey，本体换模型换 Key 这里自动跟着换；④ **fail-closed**：无 llm 服务 /
  本体没配默认模型 / 超时（`reviewTimeoutMs` 默认 8s，`AbortSignal.any` 合并请求信号）/ 抛错 /
  输出不可解析 / 未知裁决 → **一律 ask**；⑤ 审计增强：日志新增 `pre`（走哪条路）、`hits`、
  `ruleGrade`（v1 规则怎么看）、`verdict` / `model` / `verdictWhy`（模型怎么判）——
  可事后对比"规则怎么想 / 模型怎么判"。

  **接口是从源码核实的，不是猜的**：`ctx.llm.stream({provider, model, system, messages, maxTokens,
  purpose, signal})` 返回异步 chunk 流，用 `BlockAssembler` 收集、`blocks()` 过滤 `type==='text'`
  （范式取自 `dsh-session-title-llm`）；`createUserMessage` 来自 `dsh-llm`。

  v1 的 `gradeRequest()` 保留：不再参与裁决，但它的 `grade` 仍作为审计信号写进日志，
  且 `grade-self-test` 覆盖它。

  smoke **71/71**；离线 **195 → 209 断言**（`apply-self-test` 14 → 27：预筛四条路径、
  `parseVerdict` 三种失败收敛、四个端到端分支 —— 其中"**模型判 allow 时即使命中高风险词也放行**"
  正是不再让词表当死刑的证明）。已部署双副本（`1E762B1B…`）。
  **遗留**：① 插件源码不热加载，需重启宿主；② 审查器目前只能看到 `toolName + reason + 命中词`，
  **看不到实际命令**（审批请求里没有 args）——后续可从 `callId` 关联会话里的工具调用参数。

- **修复自带插件 `dsh-auto-approval`：它的配置面从落地起就是坏的，等于没在按配置工作**。
  用户问"自动审批有没有生效"，查证结果是**没生效**，两处硬伤：

  **① 用了 zod，而 `settings.register` 要的是 schemastery。** `dsh-settings` 的 `resolve()` 是
  **把 schema 当函数调用**——`const value = schema(mergeLayers(base, section))`。schemastery 的
  schema 是可调用对象，zod 的不是，于是注册当场抛 **`schema is not a function`**，命名空间
  `auto-approval` 从未注册：`/approval on|off` 永久报错、规则表改不了、设置面板里根本不出现，
  只能一直吃内置默认值。而插件把"注册失败"降级成"用默认配置继续跑"，所以**从外面完全看不出坏了**。
  修法：换 `@deepseek-ai/schemastery`（官方插件同款；注意枚举是 `z.union([...])`，**没有 `z.enum()`**）。
  另外把"settings 服务缺失 / schemastery 解析不到 / register 抛错 / ok"**四种情况分开记**——
  初版把它们混进同一个 `scope` 真假值，实机日志因此写成 `settings=unavailable`，
  看着像"服务没装"，把排查方向带偏了一整轮。

  **② 自带自检 `apply-self-test` 8 通过 4 失败，而且从未纳入过门禁。** 那 4 条红的正好全是配置面，
  本该在落地当天就拦住这个 bug。根因是 test 的 mock 写成了 `register: () => ({...})`——
  **把 schema 参数整个忽略**，于是"传了个不可调用的 schema"这种真实故障在自检里永远看不见。
  修法：mock 照真实服务的契约来（`if (typeof schema !== 'function') throw`，并真的调用它解析默认值）；
  `apply` 因动态导入 schema 库转为 async，自检相应 await。**4 红 → 13 全绿**，
  两套自检（分级 10 + 接线 13）一起纳入离线门禁：**离线 172 → 195 断言**。

  **③ 顺手修掉一处静默失败**：`record()` 的 `catch {}` 是空的，本轮实测受限沙箱下
  append 被拒（EPERM）而 77 条日志里一条都看不出。改成"只报一次"——不影响审批主流程，但绝不无声。

  **验收（生产路径，不注入 schema 库、让插件自己解析）**：注册成功、`/approval on` 返回成功、
  低风险 `read` → `allowed-once`、高风险提权 → `NEXT`。三份副本哈希一致。
  ⚠️ **插件源码不热加载**（补丁层才热加载），需托盘「重启宿主（重载插件）」才生效。
  **✅ 已生效并核实**：宿主于 `03:00:25` 重启，插件于 `03:00:39` 以 `settings=ok` 装载——
  `auto-approval.log` 的装载记录由 `settings=unavailable` 变为 `ok`，
  且 `host.log` 里最后一次装载**不再有** `settings 注册失败：schema is not a function`
  （前两次都有）。这两条只有新代码能产生，属端到端确证。

  **附带查清一件架构事实（入规范坑 49）：本体没有"自动审批"功能。**
  `APPROVAL_POLICIES = ['ask','never']`，`never` 在 `decide()` 里**直接返回 `rejected` 且不进瀑布**；
  本体唯一的"准予"结果是 `allowed-once`（源码原话 `allowed-once is the only grant`），
  能产出它的只有**弹窗里的人**（客户端只有"拒绝 / 允许一次"）和**挂在 `approval/request` 瀑布上的插件**。
  权限预设「完全权限」不弹窗是因为**沙箱开到最大、让请求根本不再产生**（绕开审批），不是自动审批；
  且它与本插件**互斥**（`never` 在瀑布之前就短路了）。要"AI 自己判断该不该放行"，只有插件能给。

- **修掉"左侧栏已经有图片时，换一张图完全不生效"**（用户实测反馈）。
  **先排除服务端**：`GET /sidebar-image` 返回的字节与磁盘文件**逐字节比对完全一致**
  （1776001 字节）——壳侧无辜。真因在客户端：侧栏图片的 CSS 变量里写的是**常量 URL**
  `http://127.0.0.1:25439/sidebar-image`，换图后这个字符串没变，于是
  **浏览器认定 `background-image` 没有变化、根本不重新发请求**；请求都发不出去，
  壳端的 `Cache-Control: no-store` 自然永远没机会生效——这正是初版注释里那句
  "壳侧是 no-store，够用了"的推理错在哪。
  修法：URL 带 `?p=<图片路径>&t=<mtime>`；壳侧 `statusPayload` 新增
  `sidebarBgImageVersion`（图片 mtime，配 `fileMtimeMs()` 小工具），同时把
  `sidebarTuning(s = readSettings())` 改成可复用已读好的 settings——statusPayload 每 5 秒被调一次，
  能少读一次盘是一次。
  **`?p=` 是刻意设计的**：路径一变 URL 就变，所以**这次修复不依赖新壳**，插件一重载就生效、
  不必等重启；`t=` 只在"同一路径的文件被换掉内容"时才需要，是更严的那一档。
  smoke **69 → 71**（"图片版本号存在且为正"、"换图后版本号改变"——后者用 `fs.utimesSync`
  把 mtime 显式拉开 5 秒，避免同一毫秒写两个文件导致断言随机红）。教训入规范坑 47。
  已热更新（插件重载即生效；asar 备份 `app.asar.bak-0.4.6-imgver`）。

- **右侧栏遮罩 + 按钮固定黑底 + 左侧栏背景（用户一次性提的四项诉求）**：
  ① **右侧栏面板遮罩**与对话主页**共用** `--dsh-conversation-mask-opacity`，所以两边天然同步、
  不需要任何联动代码。面板自带 `background:var(--dsw-alias-bg-base)`（配壁纸时壳已把它置透明），
  这里再显式置透明一次，保证没配壁纸时遮罩也看得见；面板自己有 `z-index:10`（独立层叠上下文），
  故 `::before{z-index:-1}` 正好落在面板内容之下、底色之上——正文清晰，只是底色暗一档。
  ② **右侧栏按钮固定黑底** `rgba(0,0,0,.5)`，覆盖面板顶部两颗图标按钮（全屏切换 / 收起）与
  折叠态那个「展开」按钮，**刻意不做成可调项**（用户明确要求）。选择器写成
  `button[data-sidebar-right-toggle]` 这种"元素+属性"形式（特异性 (0,1,1)）：**压得过**插件自己的
  类选择器 (0,1,0)，又**压不过**它的 `:hover` (0,2,0)——于是黑底生效而**悬停高亮照旧**，
  不像 `!important` 会把悬停反馈一起吃掉。
  ③ **左侧栏背景**：新增 `sidebarBgMode`（`extend` 延伸主页面壁纸 / `own` 独立图片）
  + `sidebarOpacity`。**渲染值恒为 `max(设置值, 对话区遮罩)`**——"左侧栏比主页面更不透明"是用户的
  硬要求，而且必须挡得住"用户把对话区遮罩拖到 0.9"这种情况，所以由客户端在写 CSS 变量时取 max
  （壳侧只存用户拖出来的原始值，否则滑块回读会凭空跳一格）。两种模式**共用一条 CSS**：侧栏铺一层
  黑纱，`own` 时纱下再叠 `--dsh-sidebar-bg-image`；`extend` 留 `none`，壁纸由 `body::before`
  从透明侧栏里透出来。把 `--dsw-specific-sidebar-fill` 就地置透明，侧栏列与它内部的 `_root`
  一起变透（不必和各自的 background 抢 `!important`）。背景**画在元素自身上**而非 `::before`：
  没配壁纸时 `_frame` 底色不透明，负层级会被它整个盖住。
  ④ 新增壳路由 `GET /sidebar-image`、`POST /api/pick-sidebar-background`、
  `POST /api/sidebar-background`，与 `/bg-image` 同一种回环 HTTP 供给（`file://` 会被 Chromium 拒）。
  「个性化」面板新增三行：左侧栏背景（模式）/ 左侧栏图片（浏览·清除）/ 左侧栏遮罩（滑块）。
  smoke **55 → 66**（新增 11 条：模式/遮挡写入与回读、越界钳制、模式非法值忽略、
  sidebar-image 未设→404 / 供给字节一致 / 清除后→404、非图片拒绝、headless 选图端点）。

- **右侧栏「全屏」态遮罩单独一档**（用户实测反馈："侧边全屏模式下透明度过低了"）。
  全屏时面板改成 `position:fixed; inset:0` 铺满整个视口，**它不再是"旁边一栏"而是整个工作面**，
  正文直接压在壁纸上，沿用对话区那档（默认 0.25）读着费劲。故新增 `fullscreenMaskOpacity`
  （默认 **0.8**）与「右侧栏全屏遮罩」滑块，`[data-sidebar-right-panel=fullscreen]` 单独走这一档；
  两条规则特异性相同，靠书写顺序后者胜出，**退出全屏立刻回到与对话区同步的那档**。
  smoke **66 → 69**（新增 3 条：写入 / status 回读 / 越界钳制）。

- **【重要事实纠正】已装应用跑的是 DSH `0.1.5-rc.2`，不是仓库 vendor 的 `rc.8`。**
  本轮为取右侧栏选择器去**仓库** vendor 搜类名，`_marks` / `eGxaPq` / `yAWgPa` **一个都搜不到**，
  差点据此误判"这些选择器早就失效了"。真相是两棵树版本不同：`dsh-client-ui-chat`、
  `dsh-client-ui-sidebar-right` 是 0.1.5 才有的包（rc.8 里没有），CSS-modules 哈希也整套不同。
  证据两条：已装 `resources\vendor\vendor.lock.json` 的三个包全写 `0.1.5-rc.2`（生成于那次成功
  换树的时刻）；运行中的应用自己在 `/api/status` 的 `dshUpdate.installed` 里也是这么报的。
  ⇒ **为"运行中的界面"取选择器，只读已装树**
  （`D:\Desktop\DSH Desktop\resources\vendor\profile\node_modules\@deepseek-ai\...`）。
  教训入规范坑 45。**同时提醒**：将来一打安装包，装出来的应用跑的是 rc.8 那棵树，
  **本轮所有皮肤选择器都要重取一遍**。

- **已热更新本机已装应用**（坑 13 流程）：插件三份副本（仓库 + 已装 vendor + `$DSH_HOME\profiles\web`）
  哈希一致并已 `POST /api/reload-window` 重载；asar 重建后与已装树 **268 文件逐字节比对 0 差异**，
  备份 `app.asar.bak-0.4.6-sidebar`、`app.asar.bak-0.4.6-fullscreen`。
  ⚠️ **asar 需整体重启应用才生效（坑 26）**——重启之前，新加的三条壳路由一律 404，
  点「左侧栏图片 → 浏览…」会提示"操作失败（壳未响应？）"，**属预期而非故障**。

- **对话区中央遮罩延伸到覆盖两侧拖动滑块**（用户反馈"延伸一下覆盖滑块"）。原宽度
  `min(calc(var(--dsh-chat-content-width, 680px)), 100%)` 只盖住内容列本体，左右两条拖动滑块
  仍露在遮罩之外。改为 `min(calc(var(--dsh-chat-content-width, 680px) + 128px), 100%)`——
  内容列左右各 24px 内缩 + 40px 手柄宽，正好把两条滑块包进来。
  只改客户端插件，`POST /api/reload-window` 重载即生效，**不需要重启应用**。

- **`/api/diag/ui` 首次调用即失败——是诊断脚本自己写错了（已修）**。现象：稳定返回
  `{"ok":false,"error":"Script failed to execute, this normally means an error was thrown. Check the
  renderer console for the error."}`。**这句话只是 Electron 的外壳**，真因在渲染进程控制台里，
  壳侧看不到——排查因此空转一轮。真因是脚本里底部按钮那段写了 `rect: R(r)`：辅助函数
  `R = (el) => el.getBoundingClientRect()` 收的是**元素**，而 `r` 已经是算好的 **`DOMRect`**
  （`DOMRect` 没有 `getBoundingClientRect` 方法）→ `TypeError`。修为 `R(el)`。
  教训入规范坑 44：① **凡 `executeJavaScript` 的诊断脚本，函数体一律自带 try/catch 并把
  `e.stack` 返回给 Node 侧**，别依赖那句不透明的壳错误；② **诊断工具本身也要被验证**——
  它是"看真相的眼睛"，眼睛报错时最容易被误读成"被测对象坏了"；③ 同一段脚本里"元素"和"rect"
  别用 `el`/`r` 这种相似单字母名，把结果喂回取矩形辅助函数的行要逐个核对入参类型。

- **本次收尾的门禁与部署**：离线 **172 断言全绿**（dsh-apply 44 / update 36 / junction-safe 18 /
  vendor-build 66 / repair 8）+ smoke **55/55**；asar 重建后与已装树 **268 文件逐字节比对 0 差异**；
  `dsh-desktop-ui` 三份副本（仓库 + `resources\vendor` + `$DSH_HOME\profiles\web`）哈希一致。
  **已热更新本机已装应用**（坑 13 流程，备份 `app.asar.bak-0.4.6-diagui`）。
  **⚠️ 本次 asar 已换入，但运行中的进程仍是旧的（坑 26）——需整体重启应用，`/api/diag/ui` 的修复
  才会生效**（用户当次直接关机，次日重开应用即自动完成）。
  中央遮罩那项改的是客户端插件，已 `/api/reload-window` 重载生效，但用户未及目视确认。

- **设置面板拆栏：外观类设置独立成「个性化」**。原先「桌面」一栏混着两类东西——功能开关
  （开机自启 / 关闭到托盘 / Agent 工作区）与外观（背景图片 / 亮度 / 模糊 / 两处遮罩）。
  现把外观五项整体挪到新栏位 **「个性化」**（`settings.section` 的第二个注册项，`id: "personalize"`，
  `order: 90` 排在「桌面」之前，符合"先调外观、后调功能"）。「桌面」只留功能开关 + DSH 更新 + 状态行。
  实现方式：**用按索引拼接的脚本整块剪切 121 行 JSX，不手抄**（规范坑 25①）——脚本自带结构自检
  （块首必须是 `createElement(`、块末必须是自带逗号的 `),`、块内必须含预期首尾设置项），
  并报出行数变化（603 → 637）供交叉验证。

- **桌面皮肤（三项界面改造 + 一处修正，纯注入 CSS，DSH 零改动）**：
  ① **滚动条自动隐藏**：滑块默认透明（视觉上"收起"），鼠标移进滚动容器才显形。
  **刻意保留 8px 槽宽**（theme 插件的 `--dsh-scrollbar-width`）——若把宽度收到 0，正文会在悬停
  瞬间横向重排，那种抖动比"看不见滚动条"更难受。
  ② **右侧"多条状跳转小组件"（轮次标记轨）自动隐藏** + **圆角矩形黑遮罩**：默认 `opacity:0`
  并向右退开 8px，鼠标进入（或键盘聚焦）才浮现；遮罩是 `inset` 外扩后的 `border-radius:8px`
  圆角矩形（初版误做成 `50%` 椭圆，用户纠正为"方形圆角"），放在 `::before` 上（同为定位元素、
  先绘制，天然落在标记条之下）。
  ③ **对话区底层黑遮罩**：覆盖**能拖动的那条对话栏中间的内容列**——也就是左右拖动条所夹的那段宽度
  （居中、宽 `var(--dsh-chat-content-width)`），`z-index:-1` 让它落在内容之下、页面底色之上，
  正文照常可读。锚点取自拖动条自己的定位规则：拖动条是 `wSkVaW_body`（`position:relative`）的
  子元素，其 `left/right: calc(50% ± contentWidth/2 + 24px)` 正好界定这条内容列。
  **这一项改了三版才对**：第一版挂在两条拖动条上（用户："不是两个滑动栏"）、第二版盖住整个会话
  面板 `_root`（用户："不是整个页面，是中间那条"）、第三版落到内容列。
  选择器 `[class$="_body"]:has(> [class$="_scrollBody"])`：`_scrollBody` 是**直接子元素**
  （`_body` 这个后缀在多个插件里都有，必须限定；用直接子选择器也顺带避开坑 42 的祖先陷阱）。
  两项遮罩透明度**各自可调**（0 = 完全隐藏），设置面板「桌面」新增两个滑块，落 `settings.json` 的
  `railMaskOpacity` / `conversationMaskOpacity`（0~1，越界钳制）。
- **`[class$="_frame"]:has(...)` 一度把整个对话页面隐藏并上移半屏（严重，已修）**：
  `:has()` 匹配的是**任意后代**，而标记轨位于布局根框架内部，所以
  `[class$="_frame"]:has([class$="_marks"])` **同时命中两个元素**——`pI_x6G_frame`（布局根三栏框架
  = 整个对话页面）与 `eGxaPq_frame`（标记轨）。后果：整页 `opacity:0`（页面消失）且被
  `translateY(-50%)` 上移半屏（用户描述"对话页面飞到上半段"）。修法：
  `:not(:has([class$="_centerCol"]))` 精确排除（布局根含 `_centerCol`、标记轨没有）。
  教训入规范坑 42。
- **一次自己的低级失误（已修）**：把修复注释写进模板字符串时用了反引号（`:has()`），
  **反引号会终止模板字符串** → 语法错误，而我的部署脚本没按 `node --check` 的退出码中止，
  坏文件被写进了已装应用。已改为注释内不用反引号，并在部署脚本里加"语法不过就不部署"的硬门。
- **选择器怎么选的（关键，勿改成全名）**：CSS-modules 的**哈希前缀每次构建都会变**
  （实测 `eGxaPq_` / `wSkVaW_` / `pI_x6G_`），**局部名后缀才是稳定的**——项目原有的皮肤注入就是靠
  这个。本次定位：轮次标记轨 `[class$="_frame"]:has([class$="_marks"])`（`_frame` 与布局插件重名，
  故用 `:has(_marks)` 限定；`_marks` 唯一）、会话根 `_root`:has(`_scrollBody`)、拖动条 `_widthHandle`（唯一）。
- **新增只读诊断 `/api/diag/ui`**：报回"皮肤类改动"要改的四处 UI 锚点（可滚动容器 + 滚动条沟槽宽、
  resize 拖动手柄、右侧竖长条轨、底部按钮）。**固定用途的只读脚本，不是通用 eval**——与既有的
  `diag/opaque-layers` 同等风险画像（回环 admin、只读取）。
- **新增 `POST /api/reload-window` —— 客户端插件的热加载手段**：宿主插件有托盘「重启宿主（重载插件）」，
  而客户端插件改完只受 ESM 缓存影响，不重载页面就看不到新版；打包态 `Menu.setApplicationMenu(null)`
  又把 Ctrl+R 一起去掉了，于是"改一行 CSS 也要重启整个应用"。用 `reloadIgnoringCache()`
  （插件按 URL 取模块，忽略缓存才拿得到新文件）。
  **刻意不加 smoke 断言**：它会在测试中途重载壳窗口，把测试自己打乱。
- smoke **51 → 55**（新增皮肤遮罩 4 条：写入 / status 回读 / 越界钳制 / 非法值忽略）。

- **【鉴权页修复】0.1.5 就绪探测把"未鉴权"当成"就绪"，窗口加载了无 token 地址**。
  症状：应用起得来、窗口也开了，但页面停在 `dsh web authentication required; reopen the URL
  printed by dsh web`。根因在 `waitReady` 的判据：轮询**早期**宿主还没把带 token 的 URL 行写进
  `host.log`，此时 `extractHostUrl` 返回 null，只能退而探裸端口 URL——而裸 URL 对未鉴权请求回
  **401**，`if (res.status > 0) return url` 把 401 也当成了"它答了话"并**当场定稿**，于是
  `readyUrl` 是裸 URL，窗口自然过不了鉴权。
  修法（保留原有设计意图——"只要它答了话就说明在服务，换票交给窗口的 cookie jar"）：
  ① **宿主一旦宣告了本端口的 URL，就只认它**（不再并列裸 URL 兜底）；
  ② 尚未宣告时只能探裸 URL，但**只接受 2xx**——401/403 的语义是"服务在、但这次请求没通过鉴权"，
  不是就绪。实测：`ready: http://127.0.0.1:9712/?token=…`（带票），窗口可正常换票进入。
- **纠正一处记录**：`probeHostReady`（走完换票、会消费一次性 token）**只给启动门禁用**是对的——
  门禁的宿主是一次性的，消费无妨；壳的就绪探测绝不能消费它，否则窗口拿不到票。

- **【新增】构建进度显示（用户实测反馈："我怎么知道更新进度，你不能加一个吗"）**：原来构建约 8 分钟，
  界面只给一句"分钟级，请勿关闭应用"——等于没有进度。现在：
  ① `buildVendorTree` 新增 `onProgress` 回调，按阶段上报 `{ step, percent, label, detail }`；
  ② 阶段权重 install 0→68 / prune 72→78 / plugins 80 / ABI 84→88 / boot 90 / done 100；
  ③ **npm install 的子进度用"包目录数"当代理**（`countPackages()`，`@scope/x` 记 1、跳过点开头目录）
  ——npm 不吐精确进度，但它边解包边建目录，这个信号实时且不撒谎，label 里写的是真实已就位数
  （`正在安装依赖（312/520 个包）`）；
  ④ 快照新增 `progress` 与 `elapsedMs`（**已用时间比百分比更实在**，因为百分比只是按包数估算的刻度）；
  ⑤ 客户端在 `phase === 'building'` 时渲染进度条 + `百分比 + 阶段文案 + 已用时间`。
  容错：进度回调抛异常**不影响构建**（有断言覆盖）。已热更新（asar + 客户端插件双副本，备份
  `app.asar.bak-0.4.6-progress`）。smoke 49 → **51**（新增 progress/elapsedMs 与 jump/needsConfirm 字段断言）。

- **【修复】跨版本守卫把 GUI 用户永久卡死 → 已加确认流程（用户实测反馈："什么叫拒绝更新"）**：
  `assessJump` 拒绝时返回 `拒绝升级：…确认要跨版本升级请带 allowUnsafeJump: true`——**那是写给程序员的**。
  界面那个「更新」按钮只发 `{}`，永远不会带这个参数，于是**0.1.5 的更新在 GUI 里被彻底卡死**。
  修法：`dshUpdateSnapshot()` 增加 `jump`/`needsConfirm` 两个字段（评估结果进快照，客户端才能渲染）；
  `dshUpdateTo` 的拒绝文案改成"你该做什么"；**客户端在 `needsConfirm` 时不禁用按钮**，改标签为
  **「更新（跨版本）」**，点击后 `window.confirm` 展示 `当前 → 目标` 与不兼容原因，用户确认后**代传
  `allowUnsafeJump: true`**。已热更新（asar + 客户端插件双副本，备份 `app.asar.bak-0.4.6-jumpconfirm`）。
  教训入规范坑 40：**守卫必须给用户一个"能完成的动作"，否则它不是守卫，是死锁**。

- **【更新复测：门禁正确挡住，但探针有假阴性】0.1.5 的根 URL 是 303 换 cookie，实测流程为**
  裸 URL → `401 dsh web authentication required`；带 token 但**默认跟随重定向** → `401`（**Node 的
  `fetch`(undici) 没有 cookie jar，303 跳转时丢掉 `Set-Cookie`**）；带 token + `redirect:'manual'`
  → `303 + Set-Cookie: dsh-auth-…`；**带上该 cookie 请求 `/` → `200`（28029 字节完整 SPA HTML）**。
  而 `runBootGate`（vendor-build）与壳的 `waitReady`（host）都只认 `if (res.ok)`，**因此对任何
  0.1.5+ 的树都会永远探不到就绪**——症状与原始事故完全一致。第一轮只加了「token 感知的 URL 提取」，
  拿得到 URL 但没人能验证它，**换票这一跳没解决**。
  **已修复并热更新**：新增 `probeHostReady()`（host.mjs）走上完整的 303→接 cookie→200 握手，
  `runBootGate` 改用它（门禁起的是用完即杀的宿主，可以消费 token）；**壳的 `waitReady` 改成
  「服务器回了任何 HTTP 响应即就绪」**，把带 token 的 URL 原样交给窗口（窗口有真正的 cookie jar 会
  自己走完换票），**避免探测先把一次性 token 消费掉**。`redirect:'manual'` 也一并加上——默认跟随
  重定向正是丢 `Set-Cookie` 的那一步。
  **实测回归**：拿真实的 0.1.5-rc.2 事故树跑修好的门禁，**从「90 秒超时失败」变为「5.8 秒 PASS」**
  （`ok=true`，返回带 token 的 URL）。
- **【新增】`src/junction-safe.mjs` — junction 场安全删除**。`$DSH_HOME\profiles\node_modules` 有
  **199 个 junction** 指向 `resources\vendor\profile\node_modules\*`（含整个 `@deepseek-ai`）。实测
  **Node 的 `fs.rmSync(recursive)` 不跟随 junction**（最小复现：目标 3 文件，删后仍 3），但 **Windows
  的 `rmdir /s /q` 与 `del /s /q` 会跟随**。观测到的损坏形态极具辨识度：暂存树里 **240 个
  `@deepseek-ai/*` 包被掏空成空目录、`package.json` 全没**（11000 → 4000 文件）——**「目录还在、
  文件全没」正是 `del /s /q` 的特征**，一次经 `@deepseek-ai` 那条 junction 的删除就能一次性掏空全部
  **breach 已拆**：门禁 `finally` 与壳启动都改走 `safeRemoveTree()`（逐个 unlink 链接本身，绝不递归进
  目标）；新增 `cleanStaleBootGateHomes()` 在壳启动时收掉上次没走完 `finally` 的隔离目录，判年龄用
  **birthtime 而非 mtime**（内容一变 mtime 就刷新，会把正在跑的门禁误判成遗留）。
  **实测印证**：修好后跑一次真门禁，收尾报告 `解开 482 个 junction（未进入其目标）`
  ——**那个临时 HOME 里确实有 482 个指向被测树的 junction**，规模比原先估计的还大。
  **已热更新**（备份 `app.asar.bak-0.4.6-junction`）。
- **【核查】0.4.5 安装其实是完整的**：顶层每个文件与 `dist\win-unpacked` **逐字节同尺寸**
  （`DSH Desktop.exe` = 225,663,488）。安装程序拒绝运行是正确的——`DSH Desktop.exe` 有 6 个进程在跑。
  用户按 "dsh" 搜不到进程，是因为**壳的宿主子进程用 `ELECTRON_RUN_AS_NODE` 跑的就是 `DSH Desktop.exe`**，
  不叫 `dsh`。**重跑 0.4.5 安装包会把 `app.asar` 覆盖回 0.4.5（2,229,316 字节），丢掉更新按钮与事故修复**
  ——除非确实要退回干净基线，否则不要重装。
- **【方法论】三个假设全部被实验证伪，好过直接断言**：`fs.rmSync` 不跟随 junction；门禁不破坏被测树
  （拿现网拷贝跑真门禁，`15210 → 15210`，且返回 `ok=true`）；0.1.5 宿主不破坏自己的树（`11173 → 11173`）。
  **未证实但极强的线索**是上面那条 junction 形态。坏树被排查过程自己的探针脚本 `rmSync(staging)` 删掉，
  **无法再取证**——排查类脚本不得随意删现场，这条要记。
- 门禁：**167 离线断言 0 失败**（update 36 / vendor-build 54 / dsh-apply 44 / junction-safe 18 /
  repair 8 / admin-bg 7）。

- **【事故第二轮·真正的持久根因】`$DSH_HOME\.credentials.yaml` 被 0.1.5 改写成不兼容格式 → 已修复**。
  第一轮只把 vendor 换回 rc.8，前端仍然起不来。真因：**0.1.5-rc.2 运行期间把 `.credentials.yaml`
  改写成了它自己的带版本嵌套文档**（`version: 1` / `refs` / `records`），而 rc.8 的
  `credentials-local` 要求该文件是「凭证名 → 非空字符串」的**严格扁平映射**
  （见 `dsh-credentials-local/lib/index.js:110-137`）——读到顶层 `version: 1` 是**数字**就抛
  `TypeError` → 插件树加载失败 → 宿主 `code=1` 退出 → 前端永远拉不起来。
  **这就是"重装也解决不了"的答案**：该文件在 `$DSH_HOME`，而卸载程序不删 `$DSH_HOME`
  （`deleteAppDataOnUninstall: false`），重装根本碰不到它。
  修复：把它还原成扁平格式（备份 `.credentials.yaml.bak-<时间戳>-0.1.5-format`），
  用真实 `DSH_HOME` 复验 —— `boot` → **1 秒就绪** → `SMOKE OK`。
- **两处可诊断性修复（这才是本轮真正的价值）**：
  ① **`bootHost()` 在拿不到 URL 时改为抛错**。原先 `if (url === null) return` 是**静默返回**：
  `main()` 接着拿 `null` 去 `loadURL`，Electron 抛的是一句与真因毫无关系的
  `Error processing argument at index 0, conversion failure from null`；**更严重的是它让换树兜底
  回滚彻底失效**——回滚只在 `bootHost` 抛错时触发，返回 null 不触发。所以第一轮加的
  `restoreOldTree` 在这个场景里根本没跑。0.4.6 事故的持久化阶段正是栽在这里。
  ② **宿主非零退出时把它的日志尾巴写进壳日志**（`hostLogTail()`）。宿主"启动即退出"的真因
  （插件树加载失败、凭证文件格式不兼容）只在宿主日志里，只报一个 `code=1` 会把排查引向完全
  错误的方向——本轮因此多绕了一整轮。
  另：`log()` 现在兜住 `console.log` 的 `EPIPE`（stdout 是已关闭管道时，一条日志失败不该
  通过 uncaughtException 把整个启动流程带走）。
- **启动门禁有一个已记录的盲区**：`runBootGate` 用**隔离 DSH_HOME**（否则会污染用户真实状态），
  因此**测不出"新树与用户 `$DSH_HOME` 现有状态不兼容"**——本轮凭证文件事故正是这一类。
  这类问题只能靠**换树后的兜底回滚**接住（见修复①，它必须真的能触发）。
  备份：`app.asar.bak-0.4.6-dshfix2`。门禁：离线 149 断言 + smoke 49/49 + 已装 exe `--smoke` SMOKE OK。
- **安全提醒**：本轮排查中一条 PowerShell 打码正则漏了缩进行，把用户真实的
  `DEEPSEEK_API_KEY` 打印进了会话记录（该 key 需吊销重发）。教训：**打码要按"值形态"匹配，
  不能按"键位置"匹配**——缩进层级会让行首锚点全部落空。

- **【事故修复】DSH 更新按钮把应用更新到起不来——已修复并热更新**。用户在界面里点「更新 → 重启并应用」
  后，harness 被从 `0.1.0-rc.8` 跨到 `0.1.5-rc.2`，此后再也无法拉起前端（只剩进程）。根因两条：
  **① DSH 0.1.5 起根 URL 带进程级启动令牌**（`http://127.0.0.1:PORT/?token=…`，首次访问换签名 cookie），
  而 `host.mjs` 的 `waitReady()` 探的是**不带 token 的** `/`，永远拿不到 200 → 30 秒超时 → 判定启动失败
  → `cleanup(1)`，窗口根本没机会创建。这正是 rc.8 源码注释里写的 "until a real authentication layer
  exists"——0.1.5 把它实现了，而壳的编排代码还是 rc.8 时代的契约。
  **② 更新流程漏了计划书 §8 明写的「启动门禁」**：只实现了 ABI 门禁，而 ABI 门禁只看 `.node` 能否
  dlopen，**完全不关心宿主能不能对外服务**——所以它对这棵起不来的树给出 OK=5 FAIL=0 全绿。
  恢复：旧树因宿主从未就绪而未被清理，完整留在 `profile.old-*`，rename 回去即为 rc.8，已用已装运行时
  验证启动 PASS。
- **四项修复**：
  ① **启动门禁接入 `buildVendorTree`**（`runBootGate`）：拿暂存树**真起一次宿主**并探到就绪才允许发
  marker；复用 `host.mjs` 的 `startHost`/`extractHostUrl`，保证「门禁测的」与「壳跑的」是同一套逻辑。
  ABI + 启动**双门禁**，缺一不可。
  ② **`waitReady` 兼容 token URL**（`extractHostUrl`）：从宿主 stdout 解析它自己宣告的根 URL（0.1.5+
  带 token），回退裸端口 URL（rc.8 形态）。配套把 `desktop.patch.yml` 的 `printUrl` 改回 **true**——
  壳是独立进程、够不到宿主的 cordis 上下文，**stdout 是唯一能看到该 URL 的通道**，关掉它等于自断生路。
  ③ **版本距离守卫**（`assessJump`）：major/minor/**patch** 任一位变化即拒绝默认放行，需显式
  `allowUnsafeJump`。口径定在「只放行预发布号变化」，是因为本项目 harness 的**修订位才是真正的发布轴**
  （`0.1.0` 后面直接跟 `0.1.5`）。**第一版守卫只比 major/minor，于是把 `0.1.0-rc.8 → 0.1.5-rc.2`
  判成「安全」——等于完全没挡住这次事故，是单测逼出来的修正。**
  ④ **换树兜底回滚**（`restoreOldTree`）：宿主在换树后不就绪 → 自动把旧树换回并重试一次。这是对当初
  Q4「不做回滚」的修正：失败发生在**换树之后**，所以「延迟删旧树」救不了。
- **`desktop.patch.yml` 是双份的**：既在 asar 内（`src/desktop.patch.yml`）又在 `extraResources`
  （`resources/desktop.patch.yml`），而**打包态读的是后者**——热更新只换 asar 会漏掉它。
- 门禁：离线单测 **149 断言**（update 36 / vendor-build 54 / dsh-apply 44 / repair 8 / admin-bg 7）
  + smoke **49/49**；**已装应用 `--smoke` 实测 SMOKE OK**（`ready: http://127.0.0.1:6413/`，1.1s）。
- 备份：`app.asar.bak-0.4.6-dshfix`、`desktop.patch.yml.bak-0.4.6-dshfix`。版本号仍为 0.4.6。

- **DSH（harness）更新按钮（S1~S5，已热更新到本机已装应用）**：设置面板「桌面」section 新增
  「DSH 版本」行（与既有的「壳版本」状态行成对，两个更新平面措辞分明），三个按钮
  **检查更新 / 更新 / 重启并应用**；托盘新增「检查 DSH 更新」。四个 admin 端点：
  `GET /api/dsh/status` + `POST /api/dsh/check|update|apply`；`/api/status` 内嵌 `dshUpdate` 快照
  复用已有的 5 秒轮询。与 **壳自更新（electron-updater / 平面 B）是两个独立平面**，后者本期零改动。
  平台约束（用户决策）：**换树须逐次征得同意**（Q1）；**不内置 npm**，探测不到系统 Node 时按钮置灰（Q2）；
  默认 registry = npmmirror（Q3）；**不做回滚备份**，用户有安装包可重装 → 门禁成为唯一防线（Q4）。
  实现：`src/dsh-update.mjs`（版本发现）+ `src/vendor-build.mjs`（npm 探测/install/剪枝/插件同步/
  ABI 门禁/lock/`buildStaging`）+ `src/dsh-apply.mjs`（marker/校验/rename 换树/清理）；
  `build-host.mjs` 与 `abi-scan.mjs` 退化为 CLI 薄封装，与壳**共用同一份**安装逻辑。
  门禁：离线单测 **131 断言**（update 29 / vendor-build 49 / dsh-apply 38 / repair 8 / admin-bg 7）+
  smoke **40 → 49**。真实端到端：完整 npm install 441s → 剪枝 16580 文件 → ABI `OK=5 FAIL=0` →
  **暂存树真起宿主**（就绪 URL + `GET /` 200 + 优雅关停），全程未触碰现网 vendor。
- **三处关键设计（都有实证依据，勿改）**：
  ① **门禁代码必须落 `src/`**——`electron-builder` 的 `files` 只含 `src/**`，**`scripts/` 不进包**；
  `abi-scan.mjs` 原在 `scripts/`，打包后根本不存在，而无回滚备份时它是唯一防线（规范坑 27）。
  ② **换树必须在 `dshBin()` 首次求值之前**——`DSH_BIN` 是解析结果而非固定路径，换树会把旧树改名走开；
  已把该常量改为惰性 `dshBin()`（6 处调用点全替换），否则表现为「更新成功但应用再也起不来」。
  ③ **暂存区放 `<vendorDir>/staging/<版本>`** 而非 `APP_DATA/staging`——换树是 rename，
  `APP_DATA` 在 C: 而开发态仓库在 D:，跨卷会 EXDEV。配套 `.gitignore` + `build-host` 收尾清理
  （`extraResources` 是 `from: vendor` 整目录拷贝，残留会把上百 MB 打进安装包）。
- **修掉一处真漏洞（写 smoke 断言时发现）**：「只接受检查更新查证过的版本」的守卫原写作
  `if (target !== null && …)`，而 `target === null` 的真实含义是**从未检查过更新**而非「版本随便填」
  ——任意版本串都能绕过守卫并启动构建（把用户输入拼进 npm 依赖 = 供应链面）。已改为先判
  `target === null` 直接拒绝（规范坑 29）。
- **实测修正**：`vendor.lock.json` 的体积基线是 **pnpm** 建的（现网 vendor 含 `node_modules/.pnpm`、
  `pnpm-lock.yaml`、`.modules.yaml`，且无任何 npm 锁文件）。拿 npm 建的新树比它：字节差 3.0%、
  **文件数差 14.4%**（13019 vs 15208）——安装器落盘布局差异，不是缺陷。故「树可用」的判据改为
  **功能性证据**（ABI 门禁 PASS + 拿暂存树真起一次宿主），体积对比降级为诊断（规范坑 28）。
- **文档恢复**：`scripts/` 与 `src/` 的职责边界、四个新门禁脚本、DSH 更新面的 9 条 smoke 断言、
  以及规范坑 27~30（`scripts/` 不进包 / pnpm 基线 / 哨兵值兼义 / 断言打错对象）。

- **自带插件 `dsh-auto-approval`（AI 自检权限申请，Codex 式自动审批）**：源码进仓库
  `packages/dsh-auto-approval/`；`build-host.mjs` 会把它拷进 `vendor/profile/node_modules`，
  壳每次启动幂等同步到 profile 的 out-of-tree 插件位，并**自动补** `$DSH_HOME/profiles/web/cordis.patch.yml`
  的 `insert` 行 —— 装完即用，用户无需手工挂载。机制：挂 harness 的 `approval/request` waterfall，
  低风险/有界操作 → `'allowed-once'`（不弹窗），高风险或判不准 → `next()`（落到用户的确认弹窗）。
  配置走**本体** settings 命名空间 `auto-approval`（`enabled` / `autoApproveUpTo` / 三张规则表 /
  日志开关），另有 `/approval on|off|why|rules` 命令与 `$DSH_HOME/logs/auto-approval.log` 决策日志。
  自检：分级器 10 断言 + 接线级 12 断言全绿；zod 缺失时优雅降级（跳过命名空间注册，仍以默认配置工作）。
- **托盘新增「重启宿主（重载插件）」**：`restartHostManual()` —— 优雅停旧宿主（等会话日志静止，
  不留半个 zstd 帧）→ 清空"崩溃自动重启 ×N"预算 → 重拉 → 重载窗口；同一实现经
  `POST /api/restart-host` 暴露，供冒烟断言。**用途：插件源码改动后重载**（补丁层热加载，
  但**插件代码不热加载**——ESM 模块缓存，实测过）。
- smoke 37 → **40**（新增 restart-host 3 条：端点 ok / 重新就绪 / 换了新宿主端口）。
- **实测记录（写进规范坑 26）**：asar 热替换后**必须重启应用**——Electron 的 asar 目录索引在首次访问时缓存，
  换掉文件而不重启会让运行中的进程按旧索引读新文件，实测把 `/api/status` 的 `version` 读成 `ositio`（错位碎片）。
  仅替换 asar 外的 `resources/vendor/**` 或 profile 插件位不受影响，可用托盘「重启宿主（重载插件）」生效。
- **开发中修掉一处自己的低级错误**：把 `ensureProfilePlugin` 改名 `ensureProfilePlugins` 时漏改调用点，
  smoke 当场以 `ReferenceError` 抓到（否则热更后壳直接起不来）——这就是"改完必须跑全量冒烟"的价值。


- **harness 升级 rc.6 → rc.8**（DSH 零改动，经用户同意换树）：`scripts/build-host.mjs` 的 `VERSIONS`
  锁 `0.1.0-rc.8`；已装应用 `resources\vendor` 原地替换（route B：pnpm hoisted 安装 + `build-host --prune-only`
  剪枝/ABI 门禁；备份 `vendor-20260911-153836`）。实机验证：ABI OK=5 / SKIP=6 / FAIL=0、宿主独立 home 真启动
  200 且 stderr 空、`/plugins/dsh-desktop-ui/client.js` 正常供给、smoke **33/33**（跑的是 rc.8）、repair 8/8。
  注意 rc.8 把 markdown 渲染栈（`micromark*`/`mdast-util-*`/`unist-util-*`/`shiki`/`katex` 等 80 个包）
  从运行期依赖降为构建期依赖 ⇒ junction 场会出现大量悬空链接，属预期（DSH 自身容忍）。
- **修复：壁纸未全覆盖（"对话框底下那条黑条"）**。旧写法把壁纸放在 `body` 的背景上，而 `html` 有不透明
  底色时 **body 的背景不会传播到 canvas**，未被 body 盒子覆盖的区域会露出平铺的 `#101216`。改为
  `body::before` **`position: fixed` 固定层**（覆盖整个视口，与 body 盒子无关；`z-index:-1` 压在内容之下）。
  像素级验收（自写探针 `probe-wallpaper-tune.mjs`，65 个采样点逐点比对"壁纸理论值 = cover 映射 × scrim"）：
  旧写法 **56 点**露出兜底底色、平均 Δ=80；新写法 **0 点**、平均 Δ=5。
- **修复（根因）：底部"黑条" = CSS 变量覆盖写错了层级**。壳从 0.4.3 起把
  `--dsw-alias-bg-base: transparent !important` 写在 `:root` 上，而主题插件把深色别名定义在
  **`body[data-ds-dark-theme]`**（`--dsw-alias-bg-base` → `--dsw-static-neutral-bluish-950` = `#151517`）。
  CSS 自定义属性取"最近的定义"，body 打赢 html ⇒ 该覆盖**一直没生效**，所有用
  `var(--dsw-alias-bg-base)` 做背景的元素（输入框下方那条 footer/seat）仍画出实心 `#151517`。
  现改为 `:root, body, body[data-ds-dark-theme], body[data-ds-light-theme]` 同时覆盖。
  取证手段：截图逐行像素分析（底部两条 11px/15px 实心 `rgb(21,21,23)`）+ 主题插件静态定义比对。
- **新增诊断端点 `POST /api/diag/opaque-layers`**（回环 admin）：在**真实应用窗口**里列出指定视口区域
  （默认底部 25%）所有不透明背景/带渐变背景的元素（class、颜色、矩形），用于"注入成功但看不见"类问题的现场取证。
- **新增：壁纸调参（亮度 + 模糊滑块）**。设置面板"桌面"section 与壳内设置页各两个滑块
  （`bgBrightness` 0.2~2.0 步 0.05、`bgBlur` 0~40px 步 1），经 `POST /api/settings` 写入并持久化在壳 settings，
  `GET /api/status` 回读；越界钳制、非数字忽略、改动即时重绘（`actions.reapplyBackground`）；
  模糊时固定层向外扩 2×半径避免四周露边。smoke **33 → 37**（新增写入 / status 回读 / 越界钳制 / 非法值忽略）。
- **已热更新本机已装应用**（经用户同意，坑 13 流程）：重建 asar（`src/main.mjs`/`src/admin.mjs`/`VERSION`/`package.json`）
  并替换 `dsh-desktop-ui` 的两份副本（`resources\vendor\...` 与 `$DSH_HOME\profiles\web\...`）；
  备份 `app.asar.bak-0.4.5`、`client.js.bak-0.4.5`（可回滚）。
  用户重启后确认：**底部黑条消失、亮度/模糊滑块可用**（自设壁纸 + 亮度 0.85 / 模糊 2px）。
- **诊断端点首次实战**：`POST /api/diag/opaque-layers`（region=bottom）在真实窗口里返回
  "视口底部 25% 内实心 rgb(21,21,23) 的层 = **0**"，其余不透明层均为设计如此
  （侧栏 rgb(27,27,28)、输入卡 rgb(44,44,46)、图标/发送按钮）。
## 0.4.5 (2026-09-08)

- **增强：设置面板"桌面"section 按钮加悬停/按下交互**（与面板其他按钮一致）：按钮基底改
  ghost 透明 + 边框，`:hover` → `--dsw-alias-interactive-bg-hover`、`:active` →
  `--dsw-alias-interactive-bg-active`、`:focus-visible` 品牌色描边、0.15s 过渡——样式由
  dsh-desktop-ui 插件注入的 `.dsh-desktop-btn` 样式表提供（带 disposer）。交互实测（CDP 鼠标
  移动）：静止 `rgba(0,0,0,0)` → 悬停 `rgba(255,255,255,0.08)`（官方同款 token，深色主题）。
  诊断工具：`scripts/hover-probe*.mjs`。已同步已装应用 vendor 副本与 HOME profile
  （备份 client.js.0.4.4.bak），刷新窗口即生效。
- **打包（经用户同意，本阶段最终版）**：`DSHDesktop-Setup-0.4.5.exe`（未签名；时间戳服务器
  不可达）+ blockmap；门禁全绿（语法 / repair 8/8 / admin-bg 7/7 / 全量 smoke 33/33 /
  打包产物 --smoke SMOKE OK + 优雅退出）；dist 仅保留 0.4.5，旧版已清。

## 0.4.4 (2026-09-08)

- **修复：工作区选取报错 "directory picker failed: win32 folder dialog worker exited before
  reporting a result"**。根因（进程级实证）：rc.6 的 native 目录选择器（koffi COM worker 子进程）
  在真实选取目录时硬崩溃——worker 进程启动后数十秒静默消失（无 stderr，host.log 为空），
  驱动侧只能报"exited before reporting"。修复（DSH 零改动）：宿主子进程环境注入
  `SSH_CONNECTION=dsh-desktop-browse`——auto 解析器读到该变量即回退**应用内浏览选择器**
  （纯 Node 后端，vendor 全树仅此一处读取该变量）；GUI 改用应用内目录浏览，选取立即生效。
  冒烟新增 2 条防回归断言：`host.pickDirectory`→`directory-picker-unavailable`（证明已钉住
  browse）、`host.listDirectory`→ok。
- **流程**：自本版起，打包（electron-builder 产安装包）与已装应用热更新均**先经用户同意**。

## 0.4.3 (2026-09-07)

- **修复：背景图"注入成功但看不见"**（0.4.2 遗留 bug，用户实测复现）。根因：vendor 锁定的
  rc.6 SPA 不使用 `--dsw-*` 主题变量，而是用**写死的不透明背景**（rgb(21,21,23)）铺满视口
  （CSS-modules 类 `.*_frame` / `.*_root`）。0.4.2 的"body 铺图 + 变量透明"方案注入成功、
  图片加载成功，但被这些不透明层完全盖住。
  修复：新增把 rc.6 真实不透明层置透明的选择器集合（`#root > div`、`[class$="_frame"]`、
  `[class$="_root"]`、`[class$="_centerCol"]`；侧栏与输入框卡片保持不透明以保可读性）。
  像素级探针实证：注入后角落像素由 #151517 变为壁纸色（#888887 / #030f11），壁纸真实可见；
  诊断工具沉淀为 `scripts/bg-probe2~5.mjs`（结构/像素探针）。

## 0.4.2 (2026-09-07)

- **修复：自定义背景图片不显示**（朋友机器实测复现的 0.4.1 bug）——Chromium 禁止 http 页面加载
  `file://` 本地资源（渲染器 "Not allowed to load local resource"）。图片改由壳 admin 回环 HTTP
  `/bg-image` 供给：按扩展名给 MIME（jpg/jpeg/png/webp/gif/bmp/avif/ico）、`Cache-Control: no-store`、
  `?t=mtime` 破缓存；`/api/background` 增加扩展名白名单（主流 jpg/png/webp 全支持）。
  无头探针实证（file:// 拒绝 / HTTP 供给 512×512 加载成功）+ `scripts/admin-bg-test.mjs`（7 断言）
  + 全量 smoke 31/31（新增 5 条背景图断言防回归）。
- **更换应用图标**：workspace 根 `dsh.jpeg`（512×512）经 `scripts/gen-icon.mjs` 生成
  `build/icon.ico`（PNG-in-ICO，256/128/64/48/32/16，回读校验通过）；窗口/托盘/安装包共用。
- **主进程防 `ELECTRON_RUN_AS_NODE` 泄漏**：`src/node-guard.mjs` 最先导入，主进程被环境变量
  退化成纯 Node 时明确报错退出（不再无窗口无日志静默失败）；smoke 子进程环境同步剔除该变量。
- **文书**：新增 workspace 根《代码规范与范例.md》（供后续 AI 会话参考：铁律/工程地图/坑清单/
  端到端范例/门禁/提交规范）；CHANGELOG、README、两份计划书、施工进度文档同步更新。
- **打包**：`DSHDesktop-Setup-0.4.2.exe`（未签名；时间戳服务器不可达）+ blockmap；打包产物
  `--smoke` 全绿（SMOKE OK + 优雅退出）；dist 旧版安装包已清理，仅留 0.4.2。

## 0.4.1 (2026-08-20)

三项修复/增强（对应清单：完整退出、历史会话可读、自定义背景图片）：

- **完整退出**：托盘"退出"/关机前先等会话日志静止（写批全部落盘、文件停在帧边界），
  再结束宿主进程树——不再"写一半就杀"，从源头消除半个 zstd 尾帧。
- **历史会话可读**：新增 `src/repair.mjs` 启动前自愈——半个尾帧截断到最后一个完整帧、
  首帧异常重编码为逐行帧、无法修复的坏日志隔离改名（`.corrupt-<ts>`），
  旧版 rc.6 会话读取器不再因"corrupt Zstandard session log"崩掉整棵启动树。
- **自定义背景图片**：设置面板"桌面"section 新增"背景图片"行（浏览…/清除）；
  壳级 CSS 注入实现（body 铺图 + 基底背景变量透明 + 暗化遮罩），不碰 DSH 源码，
  深浅色主题均可用；设置持久化于 `settings.json`，经 `/api/background`、`/api/pick-background` 读写。
- 顺带：移除 Electron 单实例锁与 HOME profile 的 dsh-host-single-instance 硬互斥，
  多窗口共享同一 dsh host（锁登记 + netstat 端口探测 + `__DSH_BOOT__` 内容校验）。
  旧实现（Get-CimInstance 扫 node.exe 命令行）在 dev host 上探测失败，
  导致壳在已有 host 运行时拉起第二个宿主或直接打不开。

## 0.4.0 (2026-08-19)

首个 Electron 发行版（对应 v1 0.3.0 的全部能力 + 分发体系升级）。

### 壳能力（迁移自 v1，Electron 原生实现）
- 模式 B 宿主托管：`ELECTRON_RUN_AS_NODE` + `--expose-internals` 子进程跑 dsh web（DSH 零改动）
- 单实例 + 第二实例聚焦；`dsh://` 协议注册；系统托盘；close-to-tray；开机自启
- 通知（host 崩溃自动重启×3 + SPA 通知白名单）；壳内设置页（独立窗口，不走外部浏览器）
- 安全基线：contextIsolation/sandbox、非回环导航拦截、生产禁 DevTools

### 构建与分发（M2）
- 自包含 vendor/profile：530 包 / 207MB / ABI 门禁 0 失败 / 剪枝 11.4MB / vendor.lock.json
- electron-builder NSIS：per-user 一键安装 146.8MB + blockmap 差分；卸载保留用户数据
- 自签代码签名（CN=DSH Desktop Dev，scripts/dev-sign.ps1）；CI（.github/workflows/release.yml）
- electron-updater 接线（打包态自动检查；publish 配置待 GitHub 仓库激活）

### 门禁（全绿）
- dev smoke 21/21；打包产物 smoke exit 0；abi-scan 0 FAIL；vendor 独立 boot 冒烟
- 关键修复：findDshBin Electron 锚点、extraResources 根级 node_modules 被跳过、
  electron-updater CJS 命名导入（打包态挂起元凶）、workspace 状态回写
