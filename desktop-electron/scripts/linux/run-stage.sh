# 在 WSL 里跑一个 stage .sh。用法（从 Windows 侧）：
#   wsl.exe -d Debian -u root -e sh /root/run-stage.sh <stage.sh 的 WSL 路径> <BUILD_DIR> <日志文件>
#
# 为什么要有这一层（2026-09-17 实测）：
#   Windows 侧拼一条长命令串交给 `wsl.exe … -e sh -c "<串>"` 是**不可靠**的 —— 经
#   PowerShell 的 `-ArgumentList` 后，内层引号会被吃掉/错位，被调用的程序（sed）会收到坏参数
#   （症状：`sed` 打印 usage、stdout 全空、退出码 1）。脚本头部早就警告过这类多层引号翻车。
#   这里把"要跑什么"落成文件，命令行上只留**无引号、无重定向、无分号**的短参数。
#
# ⚠️ 不要用 `set -e`：它会让"哪一步失败"变成静默退出（本轮就因此白查了两轮）。
#    判据要落到"每一步都看得见"上，最后用显式 exit 传回退出码。
set -u

STAGE="$1"
BUILD="$2"
LOG="$3"

echo "[stage] $STAGE"
echo "[stage] build=$BUILD"
echo "[stage] 源文件可读 = $([ -r "$STAGE" ] && echo yes || echo NO)"
echo "[stage] 日志目录可写 = $([ -w "$(dirname "$LOG")" ] && echo yes || echo NO)"

: > "$LOG" || { echo "[stage] 打不开日志 $LOG"; exit 3; }

# 洗 CRLF（幂等）。用 tr 而不是 sed：`tr` 不解析"脚本"，参数就是纯字符，少一层转义陷阱。
tr -d '\r' < "$STAGE" > /root/stage.sh || { echo "[stage] 洗 CRLF 失败（tr 退出码 $?）"; exit 4; }
echo "[stage] stage.sh = $(wc -l < /root/stage.sh) 行"

export DSH_BUILD_DIR="$BUILD"
echo "[stage] 开始执行…（日志 → $LOG）"
sh /root/stage.sh >> "$LOG" 2>&1
rc=$?

echo "[stage] 退出码 $rc"
echo "----- 日志尾部 -----"
tail -40 "$LOG" 2>/dev/null || true
exit "$rc"
