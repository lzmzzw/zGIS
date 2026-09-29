param([string]$Executable = "$env:LOCALAPPDATA\zGIS\zgis.exe")
$ErrorActionPreference = 'Stop'
if (Get-Process zgis -ErrorAction SilentlyContinue) { throw 'Close existing zGIS sessions before running the isolated installed smoke.' }
if (-not (Test-Path -LiteralPath $Executable)) { throw 'Installed executable not found.' }
$recoveryPath = Join-Path $env:LOCALAPPDATA 'com.personal.zgis\recovery.json'
$savedPath = "$recoveryPath.smoke-$([Guid]::NewGuid().ToString('N'))"
$hadRecovery = Test-Path -LiteralPath $recoveryPath
$previousArguments = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$previousUserData = $env:WEBVIEW2_USER_DATA_FOLDER
$testProcess = $null
$recoveryIsolated = $false
Push-Location (Join-Path $PSScriptRoot '..')
try {
  if ($hadRecovery) { Move-Item -LiteralPath $recoveryPath -Destination $savedPath }
  $recoveryIsolated = $true
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9226'
  $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path (Get-Location) 'output\desktop\installed-webview'
  & node scripts/create-fixtures.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Fixture generation failed.' }
  $testProcess = Start-Process -FilePath $Executable -WindowStyle Hidden -PassThru
  & node scripts/desktop-smoke.mjs $testProcess.Id
  if ($LASTEXITCODE -ne 0) { throw 'Native file smoke failed.' }
  if (-not $testProcess.WaitForExit(10000)) { throw 'Test instance did not exit.' }
  $testProcess = Start-Process -FilePath $Executable -WindowStyle Hidden -PassThru
  & node scripts/desktop-smoke.mjs $testProcess.Id --recovery-only
  if ($LASTEXITCODE -ne 0) { throw 'Native restart recovery smoke failed.' }
  if (-not $testProcess.WaitForExit(10000)) { throw 'Recovery test instance did not exit.' }
  if ((Get-Content -LiteralPath $recoveryPath -Raw) -ne '[]') { throw 'Discarded snapshot was not cleared.' }
  Write-Output 'PASS: installed binary, native dialogs and cross-process recovery/exit.'
} finally {
  if ($testProcess -and -not $testProcess.HasExited) { Stop-Process -Id $testProcess.Id }
  if ($recoveryIsolated) {
    if (Test-Path -LiteralPath $recoveryPath) { Remove-Item -LiteralPath $recoveryPath }
    if ($hadRecovery -and (Test-Path -LiteralPath $savedPath)) { Move-Item -LiteralPath $savedPath -Destination $recoveryPath }
  }
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousArguments
  $env:WEBVIEW2_USER_DATA_FOLDER = $previousUserData
  Pop-Location
}
