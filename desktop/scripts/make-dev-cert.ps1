# Самоподписанный сертификат подписи кода для Blackbox Studio — для СВОИХ компьютеров.
# Подробности и платные варианты (чтобы не ругалась Windows у всех) — docs/SIGNING.md.
#
# Что делает:
#   1. создаёт сертификат подписи кода в хранилище текущего пользователя (Cert:\CurrentUser\My);
#   2. сохраняет desktop\certs\blackbox-studio-dev.pfx (ключ, под паролем) и .cer (только открытая часть);
#   3. с ключом -Trust — добавляет .cer в «Доверенные корневые» и «Доверенные издатели» ТЕКУЩЕГО
#      пользователя: на этом компьютере подписанный им exe перестанет быть «неизвестным издателем».
#      Windows покажет предупреждение об установке корневого сертификата — это ожидаемо.
#
# Запуск (PowerShell, из папки desktop):
#   powershell -ExecutionPolicy Bypass -File scripts\make-dev-cert.ps1 -Trust
# Потом сборка с подписью:
#   $env:CSC_LINK = "$PWD\certs\blackbox-studio-dev.pfx"; $env:CSC_KEY_PASSWORD = "<пароль>"; npm run dist
#
# На других компьютерах — тот же .cer установить так же (или -Trust с копией скрипта и .cer).
# Удалить: certmgr.msc → Личные / Доверенные корневые / Доверенные издатели → «Blackbox Studio (dev)».
param(
  [switch]$Trust,
  [string]$Subject = 'CN=Blackbox Studio (dev), O=mjsvyat',
  [int]$Years = 5
)
$ErrorActionPreference = 'Stop'
$dir = Join-Path $PSScriptRoot '..\certs'
New-Item -ItemType Directory -Force $dir | Out-Null
$pfx = Join-Path $dir 'blackbox-studio-dev.pfx'
$cer = Join-Path $dir 'blackbox-studio-dev.cer'

$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $Subject `
  -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
  -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears($Years)

$pwd1 = Read-Host 'Пароль для .pfx (понадобится для CSC_KEY_PASSWORD)' -AsSecureString
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $pwd1 | Out-Null
Export-Certificate -Cert $cert -FilePath $cer | Out-Null
Write-Host "Готово: $pfx (ключ, не публиковать) и $cer (открытая часть)"
Write-Host "Отпечаток: $($cert.Thumbprint)"

if ($Trust) {
  Import-Certificate -FilePath $cer -CertStoreLocation Cert:\CurrentUser\Root | Out-Null
  Import-Certificate -FilePath $cer -CertStoreLocation Cert:\CurrentUser\TrustedPublisher | Out-Null
  Write-Host 'Сертификат добавлен в доверенные для текущего пользователя.'
} else {
  Write-Host 'Чтобы этот компьютер доверял подписи — запустите ещё раз с -Trust или установите .cer вручную.'
}
