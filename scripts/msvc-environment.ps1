$ErrorActionPreference = 'Stop'
$cargoBin = Join-Path $env:USERPROFILE '.cargo/bin'
$env:PATH = "$cargoBin;$env:PATH"
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($installation) { $vcvars = Join-Path $installation 'VC/Auxiliary/Build/vcvars64.bat' }
else {
  $buildTools = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/2022/BuildTools/VC/Auxiliary/Build/vcvars64.bat'
  if (-not (Test-Path -LiteralPath $buildTools)) { throw 'Visual Studio C++ build tools not found' }
  $vcvars = $buildTools
}
$vcEnvironment = & cmd.exe /d /s /c "call `"$vcvars`" >nul && set"
foreach ($line in $vcEnvironment) {
  if ($line -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process') }
}
$link = & where.exe link
if ($link[0] -notmatch 'Microsoft Visual Studio') { throw 'MSVC linker must be first in PATH' }
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc'
