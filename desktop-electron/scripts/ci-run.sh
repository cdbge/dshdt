#!/usr/bin/env bash
# ci-run.sh — 跑一条 CI 判据，失败时把可诊断信息打成**注解 + 步骤摘要**
#
# 为什么需要它（2026-09-19 实测）：job 日志下载要仓库 admin 权限（GitHub API 对非 admin 返回
# 403 "Must have admin rights"），于是"在别的机器上看不到到底是哪条判据红了"。check-run 的
# **注解**是公开可读的（GET /repos/{owner}/{repo}/check-runs/{id}/annotations），所以把
# FAIL/Error 行抬成 `::error::` 注解。
#
# ⚠️ 但注解**不是唯一通道、也不总是可用**：实测 macOS job（唯一带 `continue-on-error: true` 的 job）
# 里失败步骤的 `::error::` 一条都读不到，只剩运行器自己那句 "Process completed with exit code 1"。
# 所以这里同时往 `$GITHUB_STEP_SUMMARY` 写一份尾部——步骤摘要在运行页上永远看得见（仓库 owner 直接
# 就能读，不必下载 job 日志），属于"注解被吞掉时的兜底"。
#
# 用法：bash scripts/ci-run.sh "<这步在做什么>" <命令...>
# 例：  bash scripts/ci-run.sh "开发态 smoke" node scripts/smoke.mjs
# 环境变量：
#   CI_LOG_FILE  指定日志落点（调用方想在失败分支之外再读一次时用；默认 $RUNNER_TEMP/ci-<label>.log）
set -u
label="${1:-step}"
shift
log="${CI_LOG_FILE:-${RUNNER_TEMP:-/tmp}/ci-$(printf '%s' "$label" | tr -c 'A-Za-z0-9' '_').log}"

set +e
"$@" 2>&1 | tee "$log"
rc=${PIPESTATUS[0]}
set -e

if [ "$rc" -ne 0 ]; then
  echo "::error::$label 失败（exit=$rc）"
  # 只抬有限行：注解太多会被 UI 折叠，反而看不见关键那条
  pat='FAIL|✗|Error|error:|错误|失败|Timed out|timeout|not found|No such|cannot|Cannot'
  hits="$(grep -acE "$pat" "$log" 2>/dev/null || true)"
  if [ "${hits:-0}" -gt 0 ]; then
    grep -aE "$pat" "$log" | head -20 | while IFS= read -r line; do
      echo "::error::$line"
    done
  else
    # 一行可识别的失败行都没有 = 崩了/被杀了/超时了。实测（macOS 的开发态 smoke，run #7）：
    # 这种情况远端只剩一个 `exit=1`，什么线索都没有。所以改抬**尾部**。
    echo "::error::$label：输出里没有任何 FAIL/错误行（崩溃、被信号杀掉、或超时？），尾部如下"
    tail -10 "$log" | while IFS= read -r line; do
      echo "::error::$line"
    done
  fi
  echo "----- $label 输出尾部（最后 30 行）-----"
  tail -30 "$log" || true
  # 兜底通道：步骤摘要（continue-on-error 的 job 里注解读不到时，这里是唯一还能看的地方）
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### ❌ $label 失败（exit=$rc）"
      echo ''
      echo "命令：\`$*\`"
      echo ''
      echo '```'
      tail -30 "$log" 2>/dev/null || echo '(日志不可读)'
      echo '```'
    } >> "$GITHUB_STEP_SUMMARY" 2>/dev/null || true
  fi
  exit "$rc"
fi
