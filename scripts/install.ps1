param(
  [string]$Installer,
  [switch]$Smoke,
  [switch]$FullSmoke,
  [switch]$Launch,
  [switch]$Worker,
  [string]$Request
)
$ErrorActionPreference = 'Stop'
$repository = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'physical-path.ps1')

if ($Worker) {
  $job = Get-Content -LiteralPath $Request -Raw | ConvertFrom-Json
  $report = [ordered]@{ success = $false; error = $null }
  try {
    if ([ZgisInstallNative]::IsPackaged()) { throw 'Installer worker is still inside a packaged process.' }
    if (Get-Process zgis -ErrorAction SilentlyContinue) { throw '请保存工作并正常退出 zGIS，再执行覆盖安装。' }
    $entry = Get-ItemProperty 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/zGIS' -ErrorAction SilentlyContinue
    $target = if ($entry.InstallLocation) { $entry.InstallLocation.Trim('"') } else { Join-Path $env:LOCALAPPDATA 'zGIS' }
    $target = [IO.Path]::GetFullPath($target)
    $executable = Join-Path $target 'zgis.exe'
    $report.target = $executable
    $report.beforeHash = if (Test-Path -LiteralPath $executable) { (Get-FileHash -LiteralPath $executable).Hash } else { $null }
    $process = Start-Process -FilePath $job.installer -ArgumentList "/S /D=$target" -WindowStyle Hidden -Wait -PassThru
    $report.installerExitCode = $process.ExitCode
    if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
    $finalPath = [ZgisInstallNative]::FinalPath($executable)
    $report.finalPath = $finalPath
    if ($finalPath -ne "\\?\$executable") { throw "Install target was redirected: $finalPath" }
    $report.afterHash = (Get-FileHash -LiteralPath $executable).Hash
    $report.releaseHash = [ZgisInstallNative]::NormalizedHash($job.release)
    $report.installedHash = [ZgisInstallNative]::NormalizedHash($executable)
    if ($report.releaseHash -ne $report.installedHash) { throw 'Physical installed executable differs from the requested release.' }
    $shell = New-Object -ComObject WScript.Shell
    $links = @(Get-ChildItem ([Environment]::GetFolderPath('Desktop')),([Environment]::GetFolderPath('Programs')) -Filter 'zGIS.lnk' -File -Recurse -ErrorAction SilentlyContinue)
    if (-not $links.Count) { throw 'No zGIS launch shortcut found.' }
    $report.shortcuts = @($links | ForEach-Object {
      $shortcut = $shell.CreateShortcut($_.FullName)
      if ($shortcut.TargetPath -ne $executable) { throw "Shortcut points to another installation: $($_.FullName)" }
      if ([ZgisInstallNative]::FinalPath($shortcut.TargetPath) -ne $finalPath) { throw 'Shortcut resolves to another physical executable.' }
      [pscustomobject]@{path=$_.FullName; target=$shortcut.TargetPath}
    })
    if ($job.smoke) {
      $report.smokeLog = $job.log
      $smokeOptions = @{ Executable = $executable; InstallationOnly = (-not $job.fullSmoke) }
      & (Join-Path $PSScriptRoot 'installed-smoke.ps1') @smokeOptions *>&1 | Tee-Object -FilePath $job.log | Out-Null
      $report.smoke = 'passed'
    }
    if ($job.launch) {
      $started = Start-Process -FilePath $executable -WindowStyle Hidden -PassThru
      $launchDeadline = [DateTime]::UtcNow.AddSeconds(5)
      $startedPath = $null
      while (-not $startedPath -and [DateTime]::UtcNow -lt $launchDeadline) {
        $started.Refresh()
        if ($started.HasExited) { throw 'Installed zGIS exited during launch.' }
        $startedPath = $started.Path
        if (-not $startedPath) { Start-Sleep -Milliseconds 100 }
      }
      if (-not $startedPath) { throw 'Installed zGIS process path was unavailable after launch.' }
      if ([ZgisInstallNative]::FinalPath($startedPath) -ne $finalPath) { throw 'Launch resolved to another physical executable.' }
      $report.launchedPid = $started.Id
    }
    $report.success = $true
  } catch { $report.error = $_.Exception.Message }
  $temporaryReport = "$($job.report).tmp"
  $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $temporaryReport -Encoding utf8
  Move-Item -LiteralPath $temporaryReport -Destination $job.report
  if (-not $report.success) { exit 1 }
  exit 0
}

$configuration = Get-Content -LiteralPath (Join-Path $repository 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
if (-not $Installer) { $Installer = Join-Path $repository "src-tauri/target/release/bundle/nsis/zGIS_$($configuration.version)_x64-setup.exe" }
$Installer = (Resolve-Path -LiteralPath $Installer).Path
$release = (Resolve-Path -LiteralPath (Join-Path $repository 'src-tauri/target/release/zgis.exe')).Path
$id = [Guid]::NewGuid().ToString('N')
$directory = Join-Path $repository 'output/install'
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$requestPath = Join-Path $directory "$id-request.json"
$reportPath = Join-Path $directory "$id-report.json"
@{installer=$Installer; release=$release; smoke=[bool]($Smoke -or $FullSmoke); fullSmoke=[bool]$FullSmoke; launch=[bool]$Launch; report=$reportPath; log=(Join-Path $directory "$id-smoke.log")} | ConvertTo-Json | Set-Content -LiteralPath $requestPath -Encoding utf8

# Task Scheduler starts an interactive-user process outside Codex's MSIX identity.
# No elevation, persistent trigger, credential or background automation is created.
$service = New-Object -ComObject Schedule.Service
$service.Connect()
$folder = $service.GetFolder('\')
$taskName = "zGIS-install-$id"
$registered = $false
try {
  $definition = $service.NewTask(0)
  $definition.RegistrationInfo.Description = 'Temporary zGIS installation and physical-path verification'
  $definition.Principal.LogonType = 3
  $definition.Principal.RunLevel = 0
  # Never hard-kill a worker while it is restoring an isolated user's data.
  $definition.Settings.ExecutionTimeLimit = 'PT0S'
  $definition.Settings.DisallowStartIfOnBatteries = $false
  $definition.Settings.StopIfGoingOnBatteries = $false
  $action = $definition.Actions.Create(0)
  $action.Path = (Get-Command pwsh -ErrorAction Stop).Source
  $action.Arguments = "-NoProfile -WindowStyle Hidden -File `"$PSCommandPath`" -Worker -Request `"$requestPath`""
  $action.WorkingDirectory = $repository
  $scheduled = $folder.RegisterTaskDefinition($taskName, $definition, 6, $null, $null, 3, $null)
  $registered = $true
  $running = $scheduled.Run($null)
  $deadline = [DateTime]::UtcNow.AddMinutes(10)
  while (-not (Test-Path -LiteralPath $reportPath)) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Installation verification timed out.' }
    Start-Sleep -Milliseconds 250
    try { $running.Refresh() } catch {
      if (Test-Path -LiteralPath $reportPath) { break }
      throw "Worker ended without a report (task result $($scheduled.LastTaskResult))."
    }
  }
  $result = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
  if (-not $result.success) { throw $result.error }
  $result | ConvertTo-Json -Depth 6
  Write-Output "PASS: physical installation and launch shortcuts verified. Report: $reportPath"
} finally {
  if ($registered) { $folder.DeleteTask($taskName, 0) }
  if (Test-Path -LiteralPath $requestPath) { Remove-Item -LiteralPath $requestPath }
}
