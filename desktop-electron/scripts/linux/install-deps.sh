#!/bin/sh
# install-deps.sh — 装 Linux 打包与冒烟所需的系统依赖（Debian/Ubuntu 系，需要 root）
#
# 分两类，**来源不同**：
#   · 打包工具：mksquashfs（AppImage）、fakeroot/rpm（deb）、ar（fpm 打 deb 要它，包名 binutils）
#   · 冒烟运行库：Electron 的 GUI 依赖 + xvfb/xauth（无显示环境下跑 Electron）
# 缺哪一个的症状：
#   mksquashfs → `spawn .../linux/mksquashfs ENOENT`（AppImage 打不出来）
#   fpm/ar     → `Need executable 'ar' to convert dir to deb` / `spawn fpm ENOENT`
#   GUI 库     → 冒烟时报 `error while loading shared libraries: libglib-2.0.so.0`（本机实测缺 24 个）
#   xauth      → `xvfb-run: error: xauth command not found`（退出码 3）
#
# 镜像：**别用 deb.debian.org**——本机实测它在这条链路上只有 10 kB/s 级（85 个包卡 20 分钟）；
# 换阿里云后 727 kB/s。IPv4 必须强制：本机 IPv6 不可达，apt 会去连 AAAA 记录并卡住。
set -e
export DEBIAN_FRONTEND=noninteractive

MIRROR="${DSH_APT_MIRROR:-https://mirrors.aliyun.com}"
if [ -f /etc/apt/sources.list.d/debian.sources ]; then
  sed -i "s|https\?://deb.debian.org/debian|$MIRROR/debian|g; s|https\?://security.debian.org/debian-security|$MIRROR/debian-security|g" \
    /etc/apt/sources.list.d/debian.sources
  echo "已把源指到 $MIRROR"
fi

APT="apt-get -o DPkg::Lock::Timeout=600 -o Acquire::ForceIPv4=true -o Acquire::Retries=3 -o Acquire::http::Timeout=30"
$APT update

$APT install -y --no-install-recommends \
  ca-certificates curl gnupg xz-utils zstd file binutils \
  libarchive-tools fakeroot rpm squashfs-tools \
  libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils \
  libatspi2.0-0 libuuid1 libsecret-1-0 libglib2.0-0 libasound2t64 libgbm1 \
  xvfb xauth

echo "--- 工具自查 ---"
for t in node npm mksquashfs fakeroot rpm ar xvfb-run xauth; do
  echo "  $t=$(command -v $t || echo MISSING)"
done
echo "--- Electron 缺库数（0 = 能起来）---"
EL="${DSH_ELECTRON:-/root/dshbuild/node_modules/electron/dist/electron}"
# ⚠️ 末尾的 `|| true` 不能省（2026-09-17 修）：`grep -c` 在**匹配到 0 条**时退出码是 1，
#    而在 `set -e` 下这会把整个脚本带崩 —— 症状是"依赖全装好了、工具全在、最后却 exit 1"，
#    且因为退出前那句 DONE 没打出来，看上去像中途失败（本轮为此白查两轮）。
if [ -x "$EL" ]; then ldd "$EL" 2>/dev/null | grep -c "not found" || true; else echo "  (还没有 electron，跳过)"; fi
echo "INSTALL-DEPS-DONE"
