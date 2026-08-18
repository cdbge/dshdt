# DSH Desktop 系统托盘（Windows PowerShell 5.1，WinForms NotifyIcon）
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File tray.ps1 -State <state.json> -AdminPort <port> [-Name DSH Desktop] [-Icon icon.ico] [-Test]
param(
  [string]$State = '',
  [int]$AdminPort = 0,
  [string]$Name = 'DSH Desktop',
  [string]$Icon = '',
  [switch]$Test
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if ($Test) { Write-Output 'tray OK'; exit 0 }

function Post([string]$path) {
  if ($AdminPort -le 0) { return }
  try { Invoke-RestMethod -Method Post -Uri ("http://127.0.0.1:{0}{1}" -f $AdminPort, $path) -TimeoutSec 3 | Out-Null } catch { }
}
function OpenUrl([string]$url) { try { Start-Process $url | Out-Null } catch { } }

$icon = $null
try {
  if ($Icon -and (Test-Path $Icon)) { $icon = New-Object System.Drawing.Icon($Icon) }
} catch { $icon = $null }
if (-not $icon) { $icon = [System.Drawing.SystemIcons]::Application }

$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = $icon
$ni.Text = $Name
$ni.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
function Add-Item([string]$text, [scriptblock]$action) {
  $it = New-Object System.Windows.Forms.ToolStripMenuItem
  $it.Text = $text
  $handler = { param($s, $e) & $action }
  $it.add_Click($handler)
  [void]$menu.Items.Add($it)
}
Add-Item '打开主窗口' { Post '/api/focus' }
Add-Item '设置' { OpenUrl ("http://127.0.0.1:{0}/" -f $AdminPort) }
Add-Item '打开数据目录' { Post '/api/open-data-dir' }
Add-Item '打开工作区' { Post '/api/open-workspace' }
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
Add-Item '退出' { Post '/api/quit' }
$ni.ContextMenuStrip = $menu

$ni.add_MouseDoubleClick({
  if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Post '/api/focus' }
})

try { $ni.ShowBalloonTip(3000, $Name, '正在后台运行，点击托盘图标打开窗口', [System.Windows.Forms.ToolTipIcon]::Info) } catch { }

# 轮询：宿主退出(状态文件被删)后自动结束
while ($true) {
  Start-Sleep -Seconds 2
  if ($State -and -not (Test-Path $State)) { break }
}
$ni.Visible = $false
$ni.Dispose()
