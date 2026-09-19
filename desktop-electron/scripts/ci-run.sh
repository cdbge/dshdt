#!/usr/bin/env bash
# ci-run.sh — 跑一条 CI 判据；失败时把可诊断信息打成注解 + 步骤摘要
#
# job 日志要仓库 admin 才能下载，而 check-run 注解公开可读，所以把 FAIL/Error 行抬成 ::error::。
# 注解不总是可用（带 continue-on-error 的 job 实测读不到），故同时把尾部写进 $GITHUB_STEP_SUMMARY。
#
# 用法：bash scripts/ci-run.sh "<这步在做什么>" <命令...>
# 环境变量：CI_LOG_FILE 指定日志落点（默认 $RUNNER_TEMP/ci-<label>.log）
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
  pat='FAIL|✗|Error|error:|错误|失败|Timed out|timeout|not found|No such|cannot|Cannot'
  hits="$(grep -acE "$pat" "$log" 2>/dev/null || true)"
  if [ "${hits:-0}" -gt 0 ]; then
    # 限流：注解太多会被 UI 折叠，反而看不见关键那条
    grep -aE "$pat" "$log" | head -20 | while IFS= read -r line; do
      echo "::error::$line"
    done
  else
    echo "::error::$label：输出里没有任何 FAIL/错误行（崩溃、被信号杀掉、或超时？），尾部如下"
    tail -10 "$log" | while IFS= read -r line; do
      echo "::error::$line"
    done
  fi
  echo "----- $label 输出尾部（最后 30 行）-----"
  tail -30 "$log" || true
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### $label 失败（exit=$rc）"
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
