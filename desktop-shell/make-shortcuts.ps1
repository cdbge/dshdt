# DSH Desktop 快捷方式创建（Windows PowerShell 5.1）
param(
  [string]$InstallDir,
  [string]$Version = '0.3.0'
)
$ErrorActionPreference = 'Stop'
$ws = New-Object -ComObject WScript.Shell
$target = "$env:WINDIR\System32\wscript.exe"
$lnkArgs = "`"$InstallDir\launch-hidden.vbs`""
$icon = "$InstallDir\icon.ico"

function New-Link([string]$path) {
  $s = $ws.CreateShortcut($path)
  $s.TargetPath = $target
  $s.Arguments = $lnkArgs
  $s.WorkingDirectory = $InstallDir
  $s.IconLocation = $icon
  $s.Description = 'DSH Desktop'
  $s.Save()
}

New-Link (Join-Path ([Environment]::GetFolderPath('Desktop')) 'DSH Desktop.lnk')
$smDir = Join-Path ([Environment]::GetFolderPath('Programs')) 'DSH Desktop'
New-Item -ItemType Directory -Force -Path $smDir | Out-Null
New-Link (Join-Path $smDir 'DSH Desktop.lnk')

$u = $ws.CreateShortcut((Join-Path $smDir '卸载 DSH Desktop.lnk'))
$u.TargetPath = "$InstallDir\uninstall.cmd"
$u.IconLocation = $icon
$u.Description = '卸载 DSH Desktop'
$u.Save()
Write-Output 'shortcuts OK'
