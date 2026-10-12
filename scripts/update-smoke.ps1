param(
  [string]$Executable,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
  [string]$ExpectedExecutable,
  [switch]$Worker,
  [string]$Request
)
$ErrorActionPreference = 'Stop'
$repository = Split-Path $PSScriptRoot -Parent
. (Join-Path $PSScriptRoot 'physical-path.ps1')

if ($Worker) {
  $job = Get-Content -LiteralPath $Request -Raw | ConvertFrom-Json
  $report = [ordered]@{ success = $false; error = $null; expectedVersion = $job.version; output = $job.directory }
  $isolated = @()
  $oldArguments = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
  $oldUserData = $env:WEBVIEW2_USER_DATA_FOLDER
  $testProcess = $null
  try {
    if ([ZgisInstallNative]::IsPackaged()) { throw 'Update smoke worker is still inside a packaged process.' }
    if (Get-Process zgis -ErrorAction SilentlyContinue) { throw '请保存工作并正常退出 zGIS，再测试覆盖更新。' }
    if (-not $job.executable) {
      $installation = Get-ItemProperty 'HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/zGIS' -ErrorAction SilentlyContinue
      $target = if ($installation.InstallLocation) { $installation.InstallLocation.Trim('"') } else { Join-Path $env:LOCALAPPDATA 'zGIS' }
      $job.executable = Join-Path $target 'zgis.exe'
    }
    $job.executable = (Resolve-Path -LiteralPath $job.executable).Path
    $physical = [ZgisInstallNative]::FinalPath($job.executable)
    if ($physical -ne "\\?\$($job.executable)") { throw "测试程序路径发生重定向：$physical" }
    $report.executable = $job.executable
    $report.beforeHash = [ZgisInstallNative]::NormalizedHash($job.executable)
    if ($job.expectedExecutable) {
      $report.expectedHash = [ZgisInstallNative]::NormalizedHash($job.expectedExecutable)
      if ($report.beforeHash -eq $report.expectedHash) { throw '测试必须从不同于目标发行版的旧版程序开始。' }
    }
    foreach ($name in @('recovery.json', 'basemaps.dat', 'postgis-sources.json', 'mysql-sources.json', 'database-passwords.dat')) {
      $path = Join-Path $env:LOCALAPPDATA "com.personal.zgis\$name"
      $entry = @{ Path = $path; Backup = "$path.update-smoke-$($job.id)"; Exists = (Test-Path -LiteralPath $path); Hash = $null }
      if ($entry.Exists) {
        $entry.Hash = (Get-FileHash -LiteralPath $path).Hash
        Move-Item -LiteralPath $path -Destination $entry.Backup
      }
      $isolated += $entry
    }
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9227'
    $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $job.directory 'webview'
    $testProcess = Start-Process -FilePath $job.executable -WindowStyle Hidden -PassThru
    $report.oldPid = $testProcess.Id
    & node (Join-Path $PSScriptRoot 'update-smoke.mjs') install $testProcess.Id $job.version $job.directory
    if ($LASTEXITCODE -ne 0) { throw '更新下载或覆盖安装 UI 验证失败。' }
    if (-not $testProcess.WaitForExit(30000)) { throw '旧版程序没有正常退出。' }
    $beforeUi = Get-Content -LiteralPath (Join-Path $job.directory 'before.json') -Raw | ConvertFrom-Json
    $helperResultPath = Join-Path $beforeUi.cacheDirectory 'updates/install-result.json'
    $deadline = [DateTime]::UtcNow.AddMinutes(5)
    $restarted = $null
    while (-not $restarted -and [DateTime]::UtcNow -lt $deadline) {
      if (Test-Path -LiteralPath $helperResultPath) {
        $helperFile = Get-Item -LiteralPath $helperResultPath
        if ($helperFile.LastWriteTimeUtc -ge [DateTimeOffset]::FromUnixTimeMilliseconds([long]$beforeUi.installRequestedAt).UtcDateTime) {
          try { $helper = Get-Content -LiteralPath $helperResultPath -Raw | ConvertFrom-Json } catch { $helper = $null }
          if ($helper -and -not $helper.success) {
            $report.helper = $helper
            Copy-Item -LiteralPath $helperResultPath -Destination (Join-Path $job.directory 'install-result.json')
            throw "覆盖安装 helper 失败：$($helper.error)"
          }
        }
      }
      $restarted = Get-Process zgis -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $report.oldPid -and $_.Path -eq $job.executable } | Select-Object -First 1
      if (-not $restarted) { Start-Sleep -Milliseconds 250 }
    }
    if (-not $restarted) { throw '更新 helper 没有重新启动物理安装目录中的 zGIS。' }
    $testProcess = $restarted
    if ((Get-Item -LiteralPath $helperResultPath).LastWriteTimeUtc -lt [DateTimeOffset]::FromUnixTimeMilliseconds([long]$beforeUi.installRequestedAt).UtcDateTime) { throw '覆盖安装 helper 没有写入本次结果。' }
    $helper = Get-Content -LiteralPath $helperResultPath -Raw | ConvertFrom-Json
    $report.helper = $helper
    if (-not $helper.success -or $helper.version -ne $job.version) { throw '覆盖安装 helper 结果与目标版本不一致。' }
    Copy-Item -LiteralPath $helperResultPath -Destination (Join-Path $job.directory 'install-result.json')
    $report.newPid = $testProcess.Id
    $report.finalPath = [ZgisInstallNative]::FinalPath($testProcess.Path)
    if ($report.finalPath -ne $physical) { throw '新版启动路径与原安装路径不同。' }
    $report.installedHash = [ZgisInstallNative]::NormalizedHash($job.executable)
    if ($report.installedHash -eq $report.beforeHash) { throw '覆盖安装没有改变物理程序。' }
    if ($job.expectedExecutable -and $report.installedHash -ne $report.expectedHash) { throw '覆盖安装后的物理程序与目标发行版不一致。' }
    $report.installedFileVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($job.executable).FileVersion
    $expectedFileVersion = [version]$job.version
    $installedFileVersion = [version]$report.installedFileVersion
    if ($installedFileVersion.Major -ne $expectedFileVersion.Major -or $installedFileVersion.Minor -ne $expectedFileVersion.Minor -or $installedFileVersion.Build -ne $expectedFileVersion.Build -or $installedFileVersion.Revision -gt 0) { throw '物理程序 PE FileVersion 与目标版本不一致。' }
    & node (Join-Path $PSScriptRoot 'update-smoke.mjs') verify $testProcess.Id $job.version $job.directory
    if ($LASTEXITCODE -ne 0) { throw '更新后版本或恢复数据验证失败。' }
    if (-not $testProcess.WaitForExit(10000)) { throw '新版测试程序没有正常退出。' }
    $recovery = Get-Content -LiteralPath (Join-Path $env:LOCALAPPDATA 'com.personal.zgis\recovery.json') -Raw
    if (-not $recovery.Contains('更新覆盖恢复测试')) { throw '测试图层属性未保存在恢复副本中。' }
    $report.ui = Get-Content -LiteralPath (Join-Path $job.directory 'ui-report.json') -Raw | ConvertFrom-Json
    $report.success = $true
  } catch { $report.error = $_.Exception.Message }
  finally {
    try {
      if ($testProcess -and -not $testProcess.HasExited) {
        & taskkill.exe /PID $testProcess.Id /T /F | Out-Null
        $null = $testProcess.WaitForExit(10000)
      }
      # 更新失败时 helper 仍可能刚启动新版；仅清理同一隔离测试安装路径。
      if ($report.oldPid) {
        foreach ($process in @(Get-Process zgis -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $job.executable })) {
          & taskkill.exe /PID $process.Id /T /F | Out-Null
          $null = $process.WaitForExit(10000)
        }
      }
    } catch { $report.success = $false; $report.restoreError = $_.Exception.Message }
    $restoreErrors = @()
    foreach ($entry in $isolated) {
      try {
        if (Test-Path -LiteralPath $entry.Path) { Remove-Item -LiteralPath $entry.Path }
        if ($entry.Exists) {
          Move-Item -LiteralPath $entry.Backup -Destination $entry.Path
          if ((Get-FileHash -LiteralPath $entry.Path).Hash -ne $entry.Hash) { throw "原文件恢复后的哈希不一致：$($entry.Path)" }
        }
      } catch { $restoreErrors += $_.Exception.Message }
    }
    $report.userFilesRestored = ($restoreErrors.Count -eq 0)
    if ($restoreErrors.Count) { $report.success = $false; $report.restoreError = ($restoreErrors -join '; ') }
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $oldArguments
    $env:WEBVIEW2_USER_DATA_FOLDER = $oldUserData
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath "$($job.report).tmp" -Encoding utf8
    Move-Item -LiteralPath "$($job.report).tmp" -Destination $job.report
  }
  if (-not $report.success) { exit 1 }
  exit 0
}

if ($Executable) { $Executable = (Resolve-Path -LiteralPath $Executable).Path }
if ($ExpectedExecutable) { $ExpectedExecutable = (Resolve-Path -LiteralPath $ExpectedExecutable).Path }
$id = [Guid]::NewGuid().ToString('N')
$directory = Join-Path $repository "output/update-smoke/$id"
New-Item -ItemType Directory -Path $directory -Force | Out-Null
$requestPath = Join-Path $directory 'request.json'
$reportPath = Join-Path $directory 'report.json'
@{ id = $id; executable = $Executable; expectedExecutable = $ExpectedExecutable; version = $ExpectedVersion; directory = $directory; report = $reportPath } | ConvertTo-Json | Set-Content -LiteralPath $requestPath -Encoding utf8
$service = New-Object -ComObject Schedule.Service
$service.Connect()
$folder = $service.GetFolder('\')
$taskName = "zGIS-update-smoke-$id"
$registered = $false
try {
  $definition = $service.NewTask(0)
  $definition.RegistrationInfo.Description = 'Temporary zGIS native update and recovery verification'
  $definition.Principal.LogonType = 3
  $definition.Principal.RunLevel = 0
  $definition.Settings.ExecutionTimeLimit = 'PT0S'
  $definition.Settings.DisallowStartIfOnBatteries = $false
  $definition.Settings.StopIfGoingOnBatteries = $false
  $action = $definition.Actions.Create(0)
  $action.Path = (Get-Command pwsh -ErrorAction Stop).Source
  $action.Arguments = "-NoProfile -WindowStyle Hidden -File `"$PSCommandPath`" -Worker -Request `"$requestPath`" -ExpectedVersion `"$ExpectedVersion`""
  $action.WorkingDirectory = $repository
  $scheduled = $folder.RegisterTaskDefinition($taskName, $definition, 6, $null, $null, 3, $null)
  $registered = $true
  $running = $scheduled.Run($null)
  $deadline = [DateTime]::UtcNow.AddMinutes(12)
  while (-not (Test-Path -LiteralPath $reportPath)) {
    if ([DateTime]::UtcNow -gt $deadline) { throw "更新验收超时；worker 未被强制终止，以保证用户文件恢复。输出：$directory" }
    Start-Sleep -Milliseconds 250
    try { $running.Refresh() } catch {
      if (Test-Path -LiteralPath $reportPath) { break }
      throw "Worker ended without report (task result $($scheduled.LastTaskResult)); output: $directory"
    }
  }
  $result = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
  $result | ConvertTo-Json -Depth 8
  if (-not $result.success) { throw "更新验收失败：$($result.error) $($result.restoreError)。报告：$reportPath" }
  Write-Output "PASS: native download, physical overwrite, restart, recovery and user-file restoration. Report: $reportPath"
} finally {
  if ($registered) { $folder.DeleteTask($taskName, 0) }
  if (Test-Path -LiteralPath $requestPath) { Remove-Item -LiteralPath $requestPath }
}
