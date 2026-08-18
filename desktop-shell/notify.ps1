# DSH Desktop 一次性气泡通知（Windows PowerShell 5.1）
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File notify.ps1 -Title <t> -Message <m> [-Icon icon.ico]
param(
  [string]$Title = 'DSH Desktop',
  [string]$Message = '',
  [string]$Icon = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ni = New-Object System.Windows.Forms.NotifyIcon
try {
  if ($Icon -and (Test-Path $Icon)) { $ni.Icon = New-Object System.Drawing.Icon($Icon) }
  else { $ni.Icon = [System.Drawing.SystemIcons]::Information }
} catch { $ni.Icon = [System.Drawing.SystemIcons]::Information }
$ni.Visible = $true
$ni.Text = if ($Title.Length -gt 63) { $Title.Substring(0, 63) } else { $Title }
try { $ni.ShowBalloonTip(6000, $Title, $Message, [System.Windows.Forms.ToolTipIcon]::Warning) } catch { }
Start-Sleep -Seconds 7
$ni.Visible = $false
$ni.Dispose()
