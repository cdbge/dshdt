#!/bin/sh
# prepare-build-tree.sh — 把仓库拷进 ext4 并装好依赖、建好 linux vendor 树
#
# 为什么必须拷到 ext4 而不是直接在 /mnt/d 上打：drvfs（9p）上 POSIX 权限位不可靠，
# 而 `chrome-sandbox` 要 4755、`spawn-helper` 要 0755 —— 权限位丢了 AppImage/deb 打出来也是坏的；
# 另外 9p 的 IO 比 ext4 慢一个量级，npm ci 与 electron-builder 都会明显变慢。
#
# 用法（Windows 侧）：
#   wsl -d Debian -u root -e sh /mnt/d/.../scripts/linux/prepare-build-tree.sh
# 之后：build-installers.sh 打包 → packaged-smoke.sh 验真。
set -e

SRC="${DSH_SRC:-/mnt/d/Desktop/deepseek/desktop-electron}"
WORK="${DSH_BUILD_DIR:-/root/dshbuild}"

echo "=== 1) 拷源码到 ext4：$WORK ==="
# 只拷打包要用的：node_modules（electron-builder）在 Linux 里**重装**，不拷 Windows 那份
# （`.bin/` 里是 .cmd 垫片、依赖里有 win32 预编译，跨过去只会得到难懂的错）。
rm -rf "$WORK"
mkdir -p "$WORK/packages"
for f in package.json package-lock.json electron-builder.yml VERSION; do
  [ -e "$SRC/$f" ] && cp -a "$SRC/$f" "$WORK/" || true
done
for d in src build scripts; do
  [ -e "$SRC/$d" ] && cp -a "$SRC/$d" "$WORK/" || true
done
# ⚠️ 这份名单必须与 `src/vendor-build.mjs` 的 `DEFAULT_PLUGIN_NAMES` 一致（2026-09-17 修）：
#   以前这里只有 dsh-desktop-ui / dsh-auto-approval，后来加了 dsh-market 却没同步过来 ⇒
#   build-host 的"插件包缺失就拒绝产出"门禁（本身是对的）把整条 Linux 构建挡在门外，
#   而日志里只有一行 `插件包缺失，拒绝产出缺插件的树：dsh-market`，很容易被当成别的问题。
for p in dsh-desktop-ui dsh-auto-approval dsh-market; do
  [ -e "$SRC/packages/$p" ] && cp -a "$SRC/packages/$p" "$WORK/packages/" || true
done
# 缺任何一个插件都当场说清楚是"这里漏拷"，而不是让下游报一句难懂的拒绝。
for p in dsh-desktop-ui dsh-auto-approval dsh-market; do
  if [ ! -d "$WORK/packages/$p" ]; then
    echo "  ✗ 插件目录没拷过来：packages/$p（SRC=$SRC）—— 请检查本脚本的拷贝名单" >&2
    exit 1
  fi
done
echo "  插件已拷：$(ls "$WORK/packages" | tr '\n' ' ')"

# ⚠️ 平台中立的**传递依赖版本锁**也必须跟着源码一起拷进来（2026-09-19 实测踩到）。
# 少了它，`npm install` 就按各包自己的 `^0.1.6-alpha.1` 范围**各自解析最新**，于是树里出现
# "@deepseek-ai/dsh 是 alpha.1、它的依赖 dsh-app-boot 却是更新的 alpha" 这种自相矛盾，
# 启动门禁当场报：
#   SyntaxError: The requested module '@deepseek-ai/dsh-app-boot' does not provide an export
#   named 'watchUserPatches'
# （dsh 的 profile-boot 在 import 期就崩 ⇒ 宿主秒退）。三平台产物内容一致也正靠这份锁。
if [ -f "$SRC/vendor/package-lock.json" ]; then
  mkdir -p "$WORK/vendor"
  cp -a "$SRC/vendor/package-lock.json" "$WORK/vendor/package-lock.json"
  echo "  版本锁已拷：vendor/package-lock.json（$(grep -c '"resolved"' "$WORK/vendor/package-lock.json" || true) 条 resolved）"
else
  echo "  ✗ 缺 $SRC/vendor/package-lock.json —— 没有它各平台会各自解析传递依赖版本，树会自相矛盾（宿主起不来）" >&2
  exit 1
fi
cd "$WORK"
echo "  就位：$(du -sh . | cut -f1)"

echo "=== 2) npm ci ==="
export npm_config_registry="${npm_config_registry:-https://registry.npmjs.org}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
npm ci --no-audit --no-fund 2>&1 | tail -4
echo "  electron=$(node -e "console.log(require('electron/package.json').version)" 2>/dev/null || echo '?')"
echo "  builder =$(node -e "console.log(require('electron-builder/package.json').version)" 2>/dev/null || echo '?')"

echo "=== 3) 建 linux vendor 树（本机原生装）==="
# 注意：这里**不要**传 --runtime。build-host 在命令行下会自动用当前 node；
# 若显式指向 Electron 二进制，在缺 GUI 库的环境里会以 `npm install 退出码 127` 失败（实测踩过）。
node scripts/build-host.mjs
echo "  vendor=$(du -sh vendor | cut -f1)  文件数=$(find vendor -type f | wc -l)"
echo "=== 完成 $(date -Is) ==="
