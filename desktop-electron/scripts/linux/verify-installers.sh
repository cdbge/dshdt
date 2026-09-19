#!/bin/sh
# verify-installers.sh — 把 AppImage 与 deb **各自真装/真跑一遍**（不是只看文件格式）
#
# 为什么需要：上一轮只做了"结构核验 + linux-unpacked 目录冒烟"。按本项目的口径，
# 没验就是没验：`linux-unpacked` 能跑，不等于 **deb 装出来的那棵**能跑，也不等于
# **AppImage 解出来的那棵**能跑——它们各自带一套 vendor 树与权限位，任何一环出错都只在装的那一刻暴露。
#
# 三种验证，逐层加严：
#   ① deb：`dpkg -i` 真装 → 检查落盘路径与权限 → 跑冒烟 → 记录版本
#   ② AppImage：`--appimage-extract` 解出 squashfs（WSL 无 FUSE，跑不了直接执行）
#      → 这条同时是对**我们自己产出的 squashfs 镜像**的端到端验证（mksquashfs 打的对不对）
#      → 跑冒烟
#   ③ 两者跑的是**同一个冒烟判据**（与 Windows 同源：按输出里的 PASS 计数，不看退出码）
set -e

DIST="${DSH_DIST:-/mnt/d/Desktop/deepseek/desktop-electron/dist}"
OUT="${DSH_OUT:-/mnt/d/Desktop/deepseek/desktop-electron/.tmp-cross}"
DEB=$(ls "$DIST"/DSHDesktop-*-amd64.deb 2>/dev/null | head -1)
APPIMAGE=$(ls "$DIST"/DSHDesktop-*-x86_64.AppImage 2>/dev/null | head -1)
echo "deb      = $DEB"
echo "appimage = $APPIMAGE"
[ -n "$DEB" ] || { echo "没有 deb 产物"; exit 2; }
[ -n "$APPIMAGE" ] || { echo "没有 AppImage 产物"; exit 2; }

# 与 packaged-smoke.sh 同一套判据与隔离策略
smoke() {
  name="$1"; bin="$2"; log="$OUT/verify-$1.log"
  rm -rf /root/vi-appdata /root/vi-home
  mkdir -p /root/vi-appdata /root/vi-home
  echo "--- 冒烟：$name ---"
  set +e
  DSH_SMOKE=1 DSH_APP_DATA=/root/vi-appdata DSH_HOME=/root/vi-home \
    timeout 300 xvfb-run -a "$bin" --smoke --disable-gpu --no-sandbox > "$log" 2>&1
  rc=$?
  set -e
  if grep -Eq '([0-9]+)/\1 PASS' "$log" || grep -q 'SMOKE OK' "$log"; then
    echo "  RESULT: PASS（rc=$rc）"
    grep -Eo '[0-9]+/[0-9]+ PASS|SMOKE OK' "$log" | tail -1
    grep -E 'ready:|vendor-home' "$log" | tail -3 | sed 's/^/    /'
    return 0
  fi
  echo "  RESULT: FAIL（rc=$rc）"
  tail -20 "$log" | sed 's/^/    /'
  return 1
}

echo
echo "================ ① deb：真装一遍 ================"
dpkg -r dsh-desktop >/dev/null 2>&1 || true
dpkg -i "$DEB" 2>&1 | tail -8
echo "--- 落盘检查 ---"
ls -la "/opt/DSH Desktop/dsh-desktop" 2>&1 | head -2
echo "  可执行位: $([ -x '/opt/DSH Desktop/dsh-desktop' ] && echo OK || echo MISSING)"
echo "  桌面入口: $(ls /usr/share/applications/dsh-desktop.desktop 2>/dev/null || echo MISSING)"
echo "  图标: $(ls /usr/share/icons/hicolor/512x512/apps/dsh-desktop.png 2>/dev/null || echo MISSING)"
echo "  vendor 树: $(ls -d '/opt/DSH Desktop/resources/vendor/profile' 2>/dev/null || echo MISSING)"
echo "  vendor 平台: $(grep -o '\"tag\": *\"[^\"]*\"' '/opt/DSH Desktop/resources/vendor/vendor.lock.json' 2>/dev/null | head -1)"
smoke deb "/opt/DSH Desktop/dsh-desktop" || DEB_SMOKE=1
echo "  dpkg 版本记录: $(dpkg -s dsh-desktop 2>/dev/null | grep -E '^(Version|Architecture|Depends)' | tr '\n' ' ')"

echo
echo "================ ② AppImage：解出 squashfs 再跑 ================"
# WSL 默认没有 FUSE，AppImage 不能直接执行；`--appimage-extract` 走的是同一条 squashfs 读取路径，
# 因此这同时也是"我们产出的镜像文件本身可用"的端到端验证。
cd /root
rm -rf squashfs-root
set +e
"$APPIMAGE" --appimage-extract > "$OUT/verify-appimage-extract.log" 2>&1
ex=$?
set -e
echo "  解包 rc=$ex"
if [ -x /root/squashfs-root/AppRun ]; then
  echo "  AppRun: OK"
  echo "  vendor 平台: $(grep -o '\"tag\": *\"[^\"]*\"' /root/squashfs-root/resources/vendor/vendor.lock.json 2>/dev/null | head -1)"
  ls -la /root/squashfs-root/usr/bin/ 2>/dev/null | head -4
  APP_BIN=$(ls /root/squashfs-root/dsh-desktop /root/squashfs-root/usr/bin/dsh-desktop 2>/dev/null | head -1)
  if [ -n "$APP_BIN" ]; then
    smoke appimage "$APP_BIN" || APPIMAGE_SMOKE=1
  else
    echo "  找不到可执行主程序；squashfs-root 顶层："; ls /root/squashfs-root | head -20
  fi
else
  echo "  解包失败或不完整；日志尾部："; tail -10 "$OUT/verify-appimage-extract.log"
fi

echo
echo "================ ③ 汇总 ================"
echo "  deb 冒烟     : $([ -z "${DEB_SMOKE:-}" ] && echo PASS || echo FAIL)"
echo "  AppImage 冒烟: $([ -z "${APPIMAGE_SMOKE:-}" ] && echo PASS || echo FAIL)"
[ -z "${DEB_SMOKE:-}" ] && [ -z "${APPIMAGE_SMOKE:-}" ] && echo "VERIFY-INSTALLERS: ALL PASS" || { echo "VERIFY-INSTALLERS: FAIL"; exit 1; }
