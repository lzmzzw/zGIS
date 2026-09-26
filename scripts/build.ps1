$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'msvc-environment.ps1')
Push-Location (Join-Path $PSScriptRoot '..')
try {
  & pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
  & pnpm test
  if ($LASTEXITCODE -ne 0) { throw 'Frontend tests failed' }
  & cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
  if ($LASTEXITCODE -ne 0) { throw 'Backend tests failed' }
  & pnpm tauri build --bundles nsis
  if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed' }
} finally { Pop-Location }
