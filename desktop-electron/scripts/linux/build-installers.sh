#!/bin/sh
# build-installers.sh — 在 Linux 上产出 AppImage + deb（本机用 WSL Debian，CI 用 ubuntu runner）
#
# 为什么必须有 Linux 侧脚本：AppImage 要 `mksquashfs`、deb 要 `fakeroot`/`rpm`/`ar`，
# 这几样在 Windows 上**都不存在**（electron-builder 的 appimage 包只有 darwin/linux 两个目录；
# 26.x 也不再自带 fpm）。所以这两个目标只能在 Linux 里打——本机走 WSL，CI 走 ubuntu runner。
#
# 用法（Windows 侧）：
#   wsl -d Debian -u root -e sh /mnt/d/.../scripts/linux/install-deps.sh          # 一次性装依赖
#   wsl -d Debian -u root -e sh -c 'cd /root/dshbuild && sh /mnt/d/.../scripts/linux/build-installers.sh'
# 前置：仓库拷到 ext4（drvfs 上权限位不可靠：chrome-sandbox 要 4755、spawn-helper 要 0755），
#       并已 npm ci + 建好 linux vendor 树（`node scripts/build-host.mjs`）。
#
# 2026-09-15 实测：AppImage 154.1 MB、deb 118.5 MB，产物拷回 Windows dist/；
#                  随后 `packaged-smoke.sh` 在真 Linux 内核上跑通（SMOKE OK）。
set -e

cd "${DSH_BUILD_DIR:-/root/dshbuild}" || { echo "没有构建目录 $DSH_BUILD_DIR（先按上面注释准备）"; exit 1; }
SRC="${DSH_SRC:-/mnt/d/Desktop/deepseek/desktop-electron}"

echo "=== 0) 环境 ==="
. /etc/os-release; echo "$PRETTY_NAME  arch=$(uname -m)  cpus=$(nproc)"
node -v; npm -v

echo "=== 1) 打包前置检查（含 vendor 平台核对）==="
# check-assets 会比对 vendor.lock.json 的 platform.os 与打包目标，不符直接拒绝。
# 这条挡的是"能打包、装不上"：在 Windows 上产 Linux 包时忘了换 vendor，electron-builder 照样报成功，
# 而产物里全是 win32 的 koffi/node-pty（实测踩过）。
node scripts/check-assets.mjs

echo "=== 2) 打包 AppImage + deb ==="
export ELECTRON_BUILDER_BINARIES_MIRROR=${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}
export ELECTRON_MIRROR=${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}
node node_modules/electron-builder/out/cli/cli.js --linux AppImage deb --x64 --publish never
echo "PACK-RC=0"

echo "=== 3) 产物 ==="
ls -la dist/ | grep -E 'AppImage|\.deb' || true

echo "=== 4) 拷回仓库 dist/（供人工分发）==="
if [ -d "$SRC/dist" ]; then
  for f in dist/*.AppImage dist/*.deb; do
    [ -e "$f" ] && cp -a "$f" "$SRC/dist/" && echo "  拷回 $(basename "$f") ($(du -h "$f" | cut -f1))"
  done
  # `linux-unpacked` 是上面两个安装包的**同一份内容**（AppImage/deb 都从它生成）。
  # 拷回来是为了在本机做"跨平台包内容一致性"比对（scripts/compare-packaged-vendor.mjs）——
  # 各平台树分散在两台机器/两个文件系统上，不拿回来就没法逐包对比。
  if [ -d dist/linux-unpacked ]; then
    rm -rf "$SRC/dist/linux-unpacked"
    cp -a dist/linux-unpacked "$SRC/dist/" && echo "  拷回 linux-unpacked（供跨平台内容比对）"
  fi
fi
echo "=== 完成 $(date -Is) ==="
