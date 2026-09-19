#!/bin/sh
# tray-check.sh — 对 **Linux 打包产物**验一次托盘（真实 Electron + xvfb），补上 smoke 的盲区
#
# 为什么必须有它：
#   打包态冒烟（packaged-smoke.sh）用 `--smoke` 起壳，而壳里 `spawnTray()` 开头就是
#   `if (SMOKE || HEADLESS) return` —— **托盘那一段从来没被跑过**。于是"Linux 上托盘图标是空图"
#   这种缺陷一路活到用户手里：`nativeImage.createFromPath('<res>/icon.ico')` 在 Linux 上解成
#   0×0（实测），`new Tray(空图)` 不抛错 ⇒ 壳自认"托盘就绪"，Waybar 里什么都没有。
#
# 判据取壳自己写的日志（`tray: ready（可用=…）`）：它逐字反映 `trayUsable`，也就是
# "图标解出来了吗 + 创建抛错了吗"。**它不证明面板一定画得出来**（那取决于 SNI 宿主/上游 Electron
# 版本 的 C 段），但它正好钉住我们这一侧能修的东西。
#
# ⚠️ 收尾**必须杀进程组 + 点名清宿主**（2026-09-19 实测踩到，两个坑叠在一起）：
#   ① `timeout 40 xvfb-run …` 只杀得掉 xvfb-run 那一层，应用还在；
#   ② 而壳在 POSIX 上是用 `detached: true` 起宿主的 ⇒ **宿主自成进程组**，杀壳的组也带不走它。
#   结果：宿主占着继承来的 stdout 管道不放，Windows 侧 `Start-Process -Wait` 就永远不返回——
#   表现为"构建脚本跑完了但这一步挂着不结束"。所以现在：setsid 拿一个进程组用于收尾，
#   再按"隔离 vendor 路径"点名 pkill 掉宿主（它的命令行里有 `/root/tray-appdata/vendor/...`）。
set -e

APP="${DSH_APP:-/root/dshbuild/dist/linux-unpacked/dsh-desktop}"
OUT="${DSH_SMOKE_OUT:-/mnt/d/Desktop/deepseek/desktop-electron/.tmp-cross}"
LOG="$OUT/linux-tray.log"
APPDATA_DIR="${DSH_TRAY_APP_DATA:-/root/tray-appdata}"
HOME_DIR="${DSH_TRAY_HOME:-/root/tray-home}"
APP_LOG="$APPDATA_DIR/logs/app.log"

echo "=== 隔离的 appdata/home（绝不碰真实环境）==="
# DSH_SMOKE=1：跳过注册表/登录项/协议写入；**刻意不加 --smoke**——那会让 spawnTray() 直接 return，
# 正好把要验的那段跳过去（这就是本脚本存在的理由）。
export DSH_APP_DATA="$APPDATA_DIR" DSH_HOME="$HOME_DIR" DSH_SMOKE=1
rm -rf "$DSH_APP_DATA" "$DSH_HOME"; mkdir -p "$DSH_APP_DATA" "$DSH_HOME"

echo "=== 起壳（xvfb + no-sandbox，等到它写出 tray: 行为止）==="
setsid sh -c "exec xvfb-run -a '$APP' --disable-gpu --no-sandbox" > "$LOG" 2>&1 &
PGID=$!
# 轮询而不是干等固定秒数：托盘那行在启动 1 秒内就写出来了（实测 0.6s），早拿到就早收工。
i=0
while [ "$i" -lt 30 ]; do
  if grep -q 'tray:' "$APP_LOG" 2>/dev/null; then break; fi
  i=$((i + 1)); sleep 1
done

echo "=== 收尾：杀进程组 + 点名清宿主（宿主是 detached 的，杀壳带不走它）==="
kill -TERM -"$PGID" 2>/dev/null || true
pkill -f "$APPDATA_DIR/vendor" 2>/dev/null || true
sleep 2
kill -KILL -"$PGID" 2>/dev/null || true
pkill -KILL -f "$APPDATA_DIR/vendor" 2>/dev/null || true
sleep 1
LEFT="$(pgrep -f "$APPDATA_DIR/vendor" 2>/dev/null | tr '\n' ' ' || true)"
if [ -n "$LEFT" ]; then
  echo "  ⚠ 仍有残留进程：$LEFT（会占着管道，必须清掉）"
else
  echo "  残留宿主：无"
fi

echo "=== 托盘相关日志 ==="
grep -E 'tray:' "$APP_LOG" || true

echo "=== 判定 ==="
if grep -q 'tray: 图标解不出来' "$APP_LOG"; then
  echo "LINUX-TRAY-CHECK: FAIL（图标解成空图——Linux/macOS 该取 .png，见 src/tray-icon.mjs）"
  exit 1
fi
if grep -q 'tray: ready（可用=true）' "$APP_LOG"; then
  # 残留进程本身也算失败：它会占着父进程的管道，让调用方（build-linux.ps1 / CI）永远等下去。
  if [ -n "$LEFT" ]; then echo "LINUX-TRAY-CHECK: FAIL（判定通过但有残留进程）"; exit 1; fi
  echo "LINUX-TRAY-CHECK: PASS"
  exit 0
fi
echo "LINUX-TRAY-CHECK: FAIL（没看到「tray: ready（可用=true）」）"
tail -20 "$APP_LOG" 2>/dev/null || true
exit 1
