# build-linux.sh — Windows 侧入口：**一条命令**在 WSL Debian 里出 Linux 安装包并验真
#
# 为什么要有这个入口（2026-09-14 复盘）：appimage 与 deb 的目标在 Windows 上**产不出来**
# （mksquashfs / fpm / ar 都不存在），必须在 Linux 里打。而"从 PowerShell 一条条拼 WSL 命令"
# 会把引号、`$`、反斜杠三层嵌套搞乱（实测反复翻车），长任务还会被编排超时砍断并留下持锁僵尸。
# 所以固定成：**编排在这个 PowerShell 脚本里，重活写在 scripts/linux/*.sh 里用文件传，日志落到文件**。
#
# 用法：
#   pwsh -File scripts\linux\build-linux.ps1              # 全流程（依赖→准备→打包→冒烟→托盘）
#   pwsh -File scripts\linux\build-linux.ps1 -Stage smoke # 只跑冒烟
#   pwsh -File scripts\linux\build-linux.ps1 -Stage tray  # 只跑托盘检查（smoke 不覆盖托盘，见下）
#
# ⚠️ 需要完整权限：受限沙箱下 `wsl.exe` 打不开 WSL 服务
#    （报 `Wsl/EnumerateDistros/Service/E_ACCESSDENIED`）——那是**沙箱**拒绝，不是主机没装 WSL。
#    这一点早期判断错过一次：本机其实有可用的 WSL Debian（`wsl --install -d Debian` 即可）。
param(
  [ValidateSet('deps', 'prepare', 'pack', 'smoke', 'tray', 'all')]
  [string]$Stage = 'all',
  [string]$Distro = 'Debian',
  [string]$BuildDir = '/root/dshbuild'
)
$ErrorActionPreference = 'Stop'
$linuxDir = '/mnt/d/Desktop/deepseek/desktop-electron/scripts/linux'
$logs = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) '.tmp-cross'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

# WSL 里的 sh 读不了 CRLF：Windows 写出来的 .sh 每条命令会带尾随 \r，
# `sh -n` 放行但执行全错，外面再套重定向就把错误全吞了（表现成"卡住零输出"）。所以先洗再跑。
function Invoke-LinuxStage([string]$script, [string]$logName, [int]$TimeoutSec = 540) {
  $logWin = Join-Path $logs $logName
  Write-Host "[linux] $script → $logName"
  # ⚠️ 不再在 Windows 侧拼**长命令串**（2026-09-17 实测）：`wsl.exe … -e sh -c "<长串>"` 经
  #   PowerShell 的 `-ArgumentList` 后内层引号会错位，被调用的 sed 收到坏参数
  #   ⇒ 打印 usage、stdout 全空、退出码 1（与脚本头部警告的"多层引号翻车"同形）。
  #   现在命令行上只有**无引号、无重定向、无分号**的短参数：脚本路径 / 构建目录 / 日志路径，
  #   真正的"要跑什么"写在 WSL 侧可见的 run-stage.sh 里（它自己负责洗 CRLF 与重定向）。
  $runner = "$linuxDir/run-stage.sh"
  $stageSh = "$linuxDir/$script"
  $logWsl = "/root/$logName"
  $p = Start-Process -FilePath 'wsl.exe' `
    -ArgumentList @('-d', $Distro, '-u', 'root', '-e', 'sh', $runner, $stageSh, $BuildDir, $logWsl) `
    -NoNewWindow -Wait -PassThru -RedirectStandardOutput $logWin -RedirectStandardError "$logWin.err"
  # ⚠️ 日志尾巴一律走 Write-Host（2026-09-19 修）：`Get-Content` 直接留在管道里会**污染本函数的返回值**，
  #   于是调用方拿到的 `-not (Invoke-LinuxStage …)` 是 `-not @(日志行…, $false)` ≡ $false ⇒
  #   **失败被当成成功继续往下跑**，最后还打印"全部完成"（实测：prepare/pack/smoke 三段全 exit 1，
  #   脚本却报成功，产物一个都没出）。日志是给人看的，不许混进返回值。
  Get-Content $logWin -Tail 25 -ErrorAction SilentlyContinue | Write-Host
  if ($p.ExitCode -ne 0) {
    Write-Host "[linux] $script 退出码 $($p.ExitCode)；stderr："
    Get-Content "$logWin.err" -Tail 15 -ErrorAction SilentlyContinue | Write-Host
    return $false
  }
  return $true
}

# ⚠️ 这里刻意用**扁平字符串列表**，不要嵌套数组（2026-09-17 踩两次）：
#   PowerShell 的 `switch` / 数组字面量会把嵌套集合**摊平**，于是
#     · 第一版 `@(@('a.sh','a.log'), @('b.sh','b.log'))` 被摊成 4 个字符串 ⇒ `$s[0]` 是**单个字符**
#       （日志里出现 `p → r`、`l → i` 这种"脚本名被逐字符切开"的怪象，四阶段全 exit 1）；
#     · 第二版用逗号数组又变成"两个阶段名拼成一行"。
#   扁平列表 + 名字→脚本名的固定映射，没有嵌套就没有摊平，读起来也不再靠 `$s[0]/$s[1]` 猜。
$stageNames = @(switch ($Stage) {
  'all' { 'deps', 'prepare', 'pack', 'smoke', 'tray' }
  'deps' { 'deps' }
  'prepare' { 'prepare' }
  'pack' { 'pack' }
  'smoke' { 'smoke' }
  'tray' { 'tray' }
})
$stageScript = @{
  deps    = 'install-deps.sh'
  prepare = 'prepare-build-tree.sh'
  pack    = 'build-installers.sh'
  smoke   = 'packaged-smoke.sh'
  # 托盘那一段**不在 smoke 的覆盖里**（壳里 `--smoke` 一开头就把 spawnTray 跳过了）——
  # 2026-09-19 的"Linux 上托盘图标是空图"就是这么活到用户手里的。所以单独一阶段。
  tray    = 'tray-check.sh'
}
$stageLog = @{
  deps    = 'linux-deps.log'
  prepare = 'linux-prepare.log'
  pack    = 'linux-pack.log'
  smoke   = 'linux-smoke-out.log'
  tray    = 'linux-tray.log'
}
foreach ($name in $stageNames) {
  # 用 `-ne $true` 而不是 `-not`：即便将来又有东西混进管道，判据也不会被数组的真值语义吃掉。
  $ok = Invoke-LinuxStage $stageScript[$name] $stageLog[$name]
  if ($ok -ne $true) { Write-Host "[linux] 在 $($stageScript[$name]) 停下"; exit 1 }
}
Write-Host "[linux] 全部完成。产物在 desktop-electron\dist\，冒烟日志在 .tmp-cross\linux-smoke-out.log"
