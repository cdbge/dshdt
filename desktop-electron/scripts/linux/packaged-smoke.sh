#!/bin/sh
# packaged-smoke.sh — 对 **Linux 打包产物**跑冒烟（真 Linux 内核 + xvfb 虚拟显示）
#
# 为什么这一步不可省：产物能在 Linux 上"打出来"不等于能"跑起来"——那正是本项目的核心口径
# （不许口头通过）。打包态冒烟是证明"这个包在目标平台上真能用"的唯一证据，判据与 Windows 侧同源。
#
# 2026-09-15 实测（WSL Debian 13）：`SMOKE OK`、`cleanup: code=0`，宿主 6 秒就绪
# （`ready: http://127.0.0.1:41441/?token=…`）。**并顺带验证了决策 D8**：
# 首启把包内 vendor 拷成用户数据目录里的种子（11,142 文件 / 103.1 MB）——这条链路此前只在单测里验过。
#
# 两个环境要求（都踩过）：
#   ① 无显示环境 → `xvfb-run` 提供虚拟 X（`apt install xvfb xauth`，**xauth 别漏**，
#      漏了报的是 `xvfb-run: error: xauth command not found`、退出码 3）；
#   ② **root 身份**跑 Chromium 必须 `--no-sandbox`，否则直接
#      `FATAL: Running as root without --no-sandbox is not supported`。
#      这只是测试环境的限制：普通用户装的包不需要这个参数。
set -e

APP="${DSH_APP:-/root/dshbuild/dist/linux-unpacked/dsh-desktop}"
OUT="${DSH_SMOKE_OUT:-/mnt/d/Desktop/deepseek/desktop-electron/.tmp-cross}"
LOG="$OUT/linux-smoke.log"

echo "=== 产物 ==="
ls -la "$APP"

echo "=== 隔离的 appdata/home（绝不碰真实环境）==="
export DSH_APP_DATA="${DSH_APP_DATA:-/root/smoke-appdata}"
export DSH_HOME="${DSH_HOME:-/root/smoke-home}"
export DSH_SMOKE=1
rm -rf "$DSH_APP_DATA" "$DSH_HOME"
mkdir -p "$DSH_APP_DATA" "$DSH_HOME"
echo "appdata=$DSH_APP_DATA home=$DSH_HOME"

echo "=== 跑打包态冒烟（xvfb + no-sandbox，上限 300s）==="
set +e
timeout 300 xvfb-run -a "$APP" --smoke --disable-gpu --no-sandbox > "$LOG" 2>&1
RC=$?
set -e
echo "SMOKE-RC=$RC"
echo "=== 输出尾部 ==="
tail -30 "$LOG"

echo "=== 判定（同 Windows 口径：按输出里的 PASS 计数，不以退出码为唯一判据）==="
if grep -Eq '([0-9]+)/\1 PASS' "$LOG" || grep -q 'SMOKE OK' "$LOG"; then
  echo "LINUX-PACKAGED-SMOKE: PASS"
  grep -Eo '[0-9]+/[0-9]+ PASS|SMOKE OK' "$LOG" | tail -2
  exit 0
fi
echo "LINUX-PACKAGED-SMOKE: FAIL"
exit 1
