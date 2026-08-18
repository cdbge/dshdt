# DSH Desktop 安装包构建脚本（Windows PowerShell 5.1）
# 打包器优先级：makensis (NSIS) > iscc (Inno) > csc 自解压 .exe > base64 自解压 .cmd（保底）
# 产出: dist\DSHDesktop-Setup-<VERSION>.exe（无 csc 时回退 .cmd）
param([string]$Version)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Version) { $Version = (Get-Content (Join-Path $root 'VERSION') -Raw).Trim() }

# ---- 打包前语法校验（整合原 check-ps 职责） ----
Write-Output '校验源文件语法...'
foreach ($js in @('launcher.mjs', 'smoke.mjs')) {
  & node --check (Join-Path $root $js)
  if ($LASTEXITCODE -ne 0) { throw "$js 语法错误" }
}
foreach ($ps in @('tray.ps1', 'notify.ps1', 'make-shortcuts.ps1')) {
  $errs = $null
  [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root $ps), [ref]$null, [ref]$errs) | Out-Null
  if ($errs.Count -gt 0) { throw "$ps 语法错误: $($errs[0].Message)" }
}
Write-Output '语法校验通过'

$dist = Join-Path $root 'dist'
$pkg = Join-Path $dist 'pkg'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path $pkg) { Remove-Item $pkg -Recurse -Force }
New-Item -ItemType Directory -Force -Path $pkg | Out-Null

# 打包文件清单（diag-session.mjs 等开发诊断工具不随包分发）
$files = @(
  'launcher.mjs', 'run.cmd', 'tray.ps1', 'notify.ps1', 'settings.html',
  'icon.ico', 'setup.cmd', 'uninstall.cmd',
  'make-shortcuts.ps1', 'launch-hidden.vbs', 'CHANGELOG.md', 'README.md', 'VERSION'
)
foreach ($f in $files) {
  $src = Join-Path $root $f
  if (-not (Test-Path $src)) { throw "缺少文件: $f" }
  Copy-Item $src $pkg
}
Write-Output ("pkg: {0} 个文件 -> {1}" -f $files.Count, $pkg)

$target = Join-Path $dist ("DSHDesktop-Setup-{0}.exe" -f $Version)

$nsis = (Get-Command makensis -ErrorAction SilentlyContinue).Source
$iscc = (Get-Command iscc -ErrorAction SilentlyContinue).Source
if (-not $iscc -and (Test-Path 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe')) { $iscc = 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe' }

$built = $false

if ($nsis) {
  Write-Output '打包器: NSIS (makensis)'
  & $nsis /DVERSION=$Version /DROOT=$root "/DOUTFILE=$target" (Join-Path $root 'installer.nsi')
  $built = ($LASTEXITCODE -eq 0) -and (Test-Path $target)
  if (-not $built) { Write-Output 'NSIS 失败，尝试下一路径' }
}

if (-not $built -and $iscc -and (Test-Path (Join-Path $root 'installer.iss'))) {
  Write-Output '打包器: Inno Setup (ISCC)'
  & $iscc "/dMyAppVersion=$Version" "/dMyAppRoot=$root" "/dMyAppOutput=$dist" (Join-Path $root 'installer.iss')
  $built = ($LASTEXITCODE -eq 0) -and (Test-Path $target)
  if (-not $built) { Write-Output 'Inno 失败，尝试下一路径' }
}

if (-not $built) {
  # ---- csc 自解压 .exe（内嵌 zip 载荷 + setup-bootstrap.cs，零外部依赖） ----
  $csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  $ref = 'C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.8'
  if ((Test-Path $csc) -and (Test-Path (Join-Path $ref 'System.IO.Compression.dll'))) {
    Write-Output "打包器: csc 自解压 .exe -> $target"
    $zip = Join-Path $dist 'payload.zip'
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Compress-Archive -Path (Join-Path $pkg '*') -DestinationPath $zip -CompressionLevel Optimal
    & $csc @(
      '/nologo', '/optimize+', '/target:winexe',
      "/out:$target",
      "/win32icon:$(Join-Path $root 'icon.ico')",
      "/resource:$zip,payload",
      (Join-Path $root 'setup-bootstrap.cs'),
      "/r:$(Join-Path $ref 'System.IO.Compression.dll')",
      "/r:$(Join-Path $ref 'System.IO.Compression.FileSystem.dll')"
    )
    $built = ($LASTEXITCODE -eq 0) -and (Test-Path $target)
    if (-not $built) { Write-Output 'csc 编译失败，回退 base64 自解压 .cmd' }
  } else {
    Write-Output 'csc 不可用，回退 base64 自解压 .cmd'
  }
}

if (-not $built) {
  # ---- 保底：base64 自解压 .cmd（zip 载荷 + certutil 解码，纯文本无二进制风险） ----
  $target = Join-Path $dist ("DSHDesktop-Setup-{0}.cmd" -f $Version)
  Write-Output "打包器: base64 自解压 .cmd -> $target"
  $zip = Join-Path $dist 'payload.zip'
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path (Join-Path $pkg '*') -DestinationPath $zip -CompressionLevel Optimal
  $b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($zip))
  # cmd 行长度上限 8191，按 7000 字符分块
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.AppendLine('@echo off')
  [void]$sb.AppendLine('rem DSH Desktop 自解压安装包（zip 载荷，certutil 解码）')
  [void]$sb.AppendLine('setlocal')
  [void]$sb.AppendLine('chcp 65001 >nul')
  [void]$sb.AppendLine("set `"WORK=%TEMP%\dsh-setup-$Version`"")
  [void]$sb.AppendLine('if exist "%WORK%" rmdir /s /q "%WORK%"')
  [void]$sb.AppendLine('mkdir "%WORK%"')
  [void]$sb.AppendLine('certutil -decode -f "%~f0" "%WORK%\payload.zip" >nul')
  [void]$sb.AppendLine('if errorlevel 1 ( echo [错误] 载荷解码失败 & pause & exit /b 1 )')
  [void]$sb.AppendLine('powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath ''%WORK%\payload.zip'' -DestinationPath ''%WORK%\pkg'' -Force"')
  [void]$sb.AppendLine('if errorlevel 1 ( echo [错误] 解压失败 & pause & exit /b 1 )')
  [void]$sb.AppendLine('call "%WORK%\pkg\setup.cmd"')
  [void]$sb.AppendLine('set "RC=%ERRORLEVEL%"')
  [void]$sb.AppendLine('cd /d "%TEMP%"')
  [void]$sb.AppendLine('start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 3; Remove-Item -LiteralPath ''%WORK%'' -Recurse -Force"')
  [void]$sb.AppendLine('exit /b %RC%')
  [void]$sb.AppendLine('-----BEGIN CERTIFICATE-----')
  for ($i = 0; $i -lt $b64.Length; $i += 7000) {
    $len = [Math]::Min(7000, $b64.Length - $i)
    [void]$sb.AppendLine($b64.Substring($i, $len))
  }
  [void]$sb.AppendLine('-----END CERTIFICATE-----')
  [System.IO.File]::WriteAllText($target, $sb.ToString(), [System.Text.Encoding]::ASCII)
  $built = Test-Path $target
}

if (-not $built) { throw '未产出安装包' }
# 清理中间产物，dist 只保留安装包
Remove-Item $pkg -Recurse -Force -ErrorAction SilentlyContinue
foreach ($junk in @((Join-Path $dist 'payload.zip'), (Join-Path $dist 'setup.sed'))) {
  if (Test-Path $junk) { Remove-Item $junk -Force }
}
Get-ChildItem $dist -Filter '~*.DDF' -ErrorAction SilentlyContinue | Remove-Item -Force
$size = [Math]::Round((Get-Item $target).Length / 1KB)
Write-Output ("OK: {0} ({1} KB)" -f $target, $size)
