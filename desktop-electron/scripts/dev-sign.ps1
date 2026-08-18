# 本地开发版代码签名：生成/复用自签证书 → 导出 PFX → 提示信任步骤
# 用法：pwsh -File scripts/dev-sign.ps1
# 正式发布的 EV/OV 证书：购买后替换 dev.pfx，并把 CSC_LINK/CSC_KEY_PASSWORD 放到 CI Secrets。
param([string]$Password = 'dshdev')
$ErrorActionPreference = 'Stop'
$dir = Join-Path $PSScriptRoot 'certs'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue | Where-Object { $_.Subject -eq 'CN=DSH Desktop Dev' } | Select-Object -First 1
if (-not $cert) {
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=DSH Desktop Dev' -KeyUsage DigitalSignature -CertStoreLocation 'Cert:\CurrentUser\My'
  Write-Host "新生成证书 thumbprint=$($cert.Thumbprint)"
} else {
  Write-Host "复用已有证书 thumbprint=$($cert.Thumbprint)"
}
$cert | Export-PfxCertificate -FilePath (Join-Path $dir 'dev.pfx') -Password (ConvertTo-SecureString $Password -AsPlainText -Force)
Export-Certificate -Cert $cert -FilePath (Join-Path $dir 'dev.cer') -Force | Out-Null

Write-Host @"

已导出:
  $dir\dev.pfx   （私钥，已 gitignore，勿入库）
  $dir\dev.cer   （公钥证书）

本机信任（消除 SmartScreen 警告，一次性）:
  右键 dev.cer → 安装证书 → 当前用户 → 受信任的根证书颁发机构
  或（需交互会话）: Import-Certificate -FilePath "$dir\dev.cer" -CertStoreLocation 'Cert:\CurrentUser\Root'

签名打包（本仓库根 desktop-electron/ 下执行）:
  `$env:CSC_LINK = [Convert]::ToBase64String([IO.File]::ReadAllBytes('$dir\dev.pfx'))
  `$env:CSC_KEY_PASSWORD = '$Password'
  node node_modules\electron-builder\out\cli\cli.js --win nsis

验证:
  Get-AuthenticodeSignature dist\DSHDesktop-Setup-*.exe | Select Status,StatusMessage,SignerCertificate
"@
