# DSH Desktop 图标生成器（Windows PowerShell 5.1 兼容）
# 产出：icon.ico（16/24/32/48/64/128/256 多尺寸，PNG 内嵌）+ icon-256.png
param([string]$OutDir = (Split-Path -Parent $MyInvocation.MyCommand.Path))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function New-IconBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
  $r = [Math]::Max(1, [int]($size * 0.22))
  $rect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc(0, 0, $d, $d, 180, 90)
  $path.AddArc($size - $d, 0, $d, $d, 270, 90)
  $path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
  $path.AddArc(0, $size - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  $c1 = [System.Drawing.Color]::FromArgb(255, 91, 124, 255)
  $c2 = [System.Drawing.Color]::FromArgb(255, 40, 74, 210)
  $mode = [System.Drawing.Drawing2D.LinearGradientMode]::Vertical
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush -ArgumentList @($rect, $c1, $c2, $mode)
  $g.FillPath($brush, $path)
  # 顶部高光
  $hiRect = New-Object System.Drawing.RectangleF(0, 0, $size, [Single]($size * 0.45))
  $hiC1 = [System.Drawing.Color]::FromArgb(70, 255, 255, 255)
  $hiC2 = [System.Drawing.Color]::FromArgb(0, 255, 255, 255)
  $hi = New-Object System.Drawing.Drawing2D.LinearGradientBrush -ArgumentList @($hiRect, $hiC1, $hiC2, $mode)
  $g.FillPath($hi, $path)
  # 白色 D
  $font = New-Object System.Drawing.Font('Segoe UI', [Single]($size * 0.62), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
  $textRect = New-Object System.Drawing.RectangleF(0, [Single](-$size * 0.03), $size, $size)
  $g.DrawString('D', $font, $white, $textRect, $sf)
  $g.Dispose()
  return $bmp
}

function Save-Ico([string]$outPath, [int[]]$sizes) {
  $blobs = @()
  foreach ($s in $sizes) {
    $bmp = New-IconBitmap $s
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $blobs += , $ms.ToArray()
    $ms.Dispose()
  }
  $fs = [System.IO.File]::Create($outPath)
  $bw = New-Object System.IO.BinaryWriter($fs)
  $count = $sizes.Count
  $bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$count)
  $offset = 6 + 16 * $count
  for ($i = 0; $i -lt $count; $i++) {
    $w = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
    $bw.Write([Byte]$w); $bw.Write([Byte]$w)
    $bw.Write([Byte]0); $bw.Write([Byte]0)
    $bw.Write([UInt16]1); $bw.Write([UInt16]32)
    $bw.Write([UInt32]$blobs[$i].Length); $bw.Write([UInt32]$offset)
    $offset += $blobs[$i].Length
  }
  for ($i = 0; $i -lt $count; $i++) { $bw.Write($blobs[$i]) }
  $bw.Close(); $fs.Close()
}

Save-Ico (Join-Path $OutDir 'icon.ico') @(16, 24, 32, 48, 64, 128, 256)
$png = New-IconBitmap 256
$png.Save((Join-Path $OutDir 'icon-256.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$png.Dispose()
Write-Output "OK: icon.ico + icon-256.png -> $OutDir"
