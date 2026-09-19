#!/usr/bin/env bash
# ci-run.sh — 跑一条 CI 判据，失败时把可诊断信息打成**注解**
#
# 为什么需要它（2026-09-19 实测）：job 日志下载要仓库 admin 权限（GitHub API 对非 admin 返回
# 403 "Must have admin rights"），于是"在别的机器上看不到到底是哪条判据红了"。check-run 的
# **注解**是公开可读的（GET /repos/{owner}/{repo}/check-runs/{id}/annotations），所以把
# FAIL/Error 行抬成 `::error::` 注解。
#
# 用法：bash scripts/ci-run.sh "<这步在做什么>" <命令...>
# 例：  bash scripts/ci-run.sh "开发态 smoke" node scripts/smoke.mjs
set -u
label="${1:-step}"
shift
log="${RUNNER_TEMP:-/tmp}/ci-$(printf '%s' "$label" | tr -c 'A-Za-z0-9' '_').log"

set +e
"$@" 2>&1 | tee "$log"
rc=${PIPESTATUS[0]}
set -e

if [ "$rc" -ne 0 ]; then
  echo "::error::$label 失败（exit=$rc）"
  # 只抬有限行：注解太多会被 UI 折叠，反而看不见关键那条
  grep -aE 'FAIL|✗|Error|error:|错误|失败|Timed out|timeout' "$log" | head -25 | while IFS= read -r line; do
    echo "::error::$line"
  done
  echo "----- $label 输出尾部（最后 30 行）-----"
  tail -30 "$log" || true
  exit "$rc"
fi
