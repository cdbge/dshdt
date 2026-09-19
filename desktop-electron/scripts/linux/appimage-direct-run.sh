#!/bin/sh
# appimage-direct-run.sh — 直接执行 AppImage（走 FUSE 挂载，而不是 --appimage-extract）
#
# 为什么单列这一步：`--appimage-extract` 只证明 squashfs **内容**可读；而用户双击运行时走的是
# 运行时**挂载**那条路（FUSE + AppRun + 内部路径解析）。两条路不同的地方正是 AppImage 的经典故障点
# （缺 fuse、libfuse 版本、/tmp 不可执行、挂载点 noexec 等）。
#
# WSL 里默认没有 FUSE，所以先探；探不到就退到 `--appimage-extract-and-run`
# （它同样走运行时逻辑、但不挂载），并把用的是哪条路**明确打出来**——不许含糊成"跑过了"。
set -e
AI="${DSH_APPIMAGE:-/mnt/d/Desktop/deepseek/desktop-electron/dist/DSHDesktop-0.4.6-x86_64.AppImage}"
SRC=/mnt/d/Desktop/deepseek/desktop-electron
OUT=$SRC/.tmp-cross

echo "=== 0) FUSE 可用性 ==="
echo "  /dev/fuse: $([ -e /dev/fuse ] && echo 存在 || echo 不存在)"
echo "  fusermount: $(command -v fusermount || command -v fusermount3 || echo 缺失)"
echo "  libfuse:    $(ls /usr/lib/x86_64-linux-gnu/libfuse* 2>/dev/null | head -2 | tr '\n' ' ' || echo 缺失)"

export DSH_SMOKE=1
export DSH_APP_DATA=/root/ai-appdata
export DSH_HOME=/root/ai-home
rm -rf "$DSH_APP_DATA" "$DSH_HOME"; mkdir -p "$DSH_APP_DATA" "$DSH_HOME"

# 每次运行**单独一个日志文件**：两条路要在各自的日志里留证，
# 共用一个文件名会让后一次覆盖前一次（实测踩到：拿"extract 的路径"去充当"挂载成功"的证据）。
run_it() {
  label="$1"; log="$2"; shift 2
  echo
  echo "=== $label ==="
  set +e
  timeout 300 xvfb-run -a "$@" --smoke --disable-gpu --no-sandbox > "$log" 2>&1
  rc=$?
  set -e
  echo "  rc=$rc  日志：$log"
  # 走的是哪条路：挂载点 /tmp/.mount_* 还是解包 /tmp/appimage_extracted_*
  mounted=$(grep -c '/tmp/\.mount' "$log" 2>/dev/null || true)
  extracted=$(grep -c 'appimage_extracted' "$log" 2>/dev/null || true)
  echo "  路径证据：挂载点出现 ${mounted:-0} 次 / 解包目录出现 ${extracted:-0} 次"
  if grep -Eq '([0-9]+)/\1 PASS' "$log" || grep -q 'SMOKE OK' "$log"; then
    echo "  RESULT: PASS"
    grep -Eo '[0-9]+/[0-9]+ PASS|SMOKE OK' "$log" | tail -1 | sed 's/^/    /'
    grep -E 'ready:|vendor-home' "$log" | tail -2 | sed 's/^/    /'
    [ "${mounted:-0}" -gt 0 ] && echo "    ✓ 确认走的是 FUSE 挂载"
    return 0
  fi
  echo "  RESULT: FAIL"
  tail -12 "$log" | sed 's/^/    /'
  return 1
}

# ① 真·直接执行（FUSE 挂载）。没有 FUSE 时不硬试，避免用"挂载失败"冒充"应用有问题"。
if [ -e /dev/fuse ] && { command -v fusermount >/dev/null 2>&1 || command -v fusermount3 >/dev/null 2>&1; }; then
  DIRECT_OK=0; run_it "① 直接执行（FUSE 挂载）" "$OUT/appimage-fuse.log" "$AI" || DIRECT_OK=1
else
  echo
  echo "=== ① 直接执行（FUSE 挂载）：跳过 ==="
  echo "  这台 WSL 没有可用的 FUSE —— 跳过，并在结论里如实标注（不拿它当通过）"
  DIRECT_OK=2
fi

# ② 运行时逻辑但不用 FUSE 挂载
EXTRACT_RUN_OK=0; run_it "② --appimage-extract-and-run（不挂载）" "$OUT/appimage-extractrun.log" "$AI" --appimage-extract-and-run || EXTRACT_RUN_OK=1

echo
echo "=== 汇总 ==="
case "$DIRECT_OK" in
  0) echo "  直接执行（FUSE）: PASS" ;;
  1) echo "  直接执行（FUSE）: FAIL" ;;
  2) echo "  直接执行（FUSE）: 未测（本机无 FUSE）" ;;
esac
echo "  extract-and-run : $([ "$EXTRACT_RUN_OK" = 0 ] && echo PASS || echo FAIL)"
# 退出码：只要 extract-and-run 过就算这一步有结论；FUSE 的未测状态如实保留在日志里
[ "$EXTRACT_RUN_OK" = 0 ] || exit 1
