$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'msvc-environment.ps1')
Push-Location (Join-Path $PSScriptRoot '..')
try {
  & pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
  & pnpm version:check
  if ($LASTEXITCODE -ne 0) { throw 'Version validation failed' }
  & pnpm exec tsc --noEmit --noUnusedLocals --noUnusedParameters
  if ($LASTEXITCODE -ne 0) { throw 'Type and unused-code validation failed' }
  & pnpm test
  if ($LASTEXITCODE -ne 0) { throw 'Frontend tests failed' }
  & cargo test --manifest-path src-tauri/Cargo.toml --lib --locked
  if ($LASTEXITCODE -ne 0) { throw 'Backend tests failed' }
  & cargo clippy --manifest-path src-tauri/Cargo.toml --lib --locked -- -D warnings
  if ($LASTEXITCODE -ne 0) { throw 'Backend static checks failed' }
  # pnpm 8 consumes the separator; call the installed CLI to pass Cargo's locked flag.
  & node node_modules/@tauri-apps/cli/tauri.js build --bundles nsis -- --locked
  if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed' }
} finally { Pop-Location }
