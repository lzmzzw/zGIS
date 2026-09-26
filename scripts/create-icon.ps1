$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$iconDir = Join-Path $PSScriptRoot '../src-tauri/icons'
New-Item -ItemType Directory -Path $iconDir -Force | Out-Null
$bitmap = [System.Drawing.Bitmap]::new(256, 256)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::FromArgb(22, 133, 107))
$white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
$mint = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(171, 228, 209))
foreach ($offset in @(70, 35, 0)) {
  $points = [System.Drawing.PointF[]]@([System.Drawing.PointF]::new(128,45+$offset),[System.Drawing.PointF]::new(211,85+$offset),[System.Drawing.PointF]::new(128,125+$offset),[System.Drawing.PointF]::new(45,85+$offset))
  $graphics.FillPolygon($(if ($offset -eq 0) { $white } else { $mint }), $points)
}
$png = Join-Path $iconDir 'icon.png'
$bitmap.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose(); $bitmap.Dispose(); $white.Dispose(); $mint.Dispose()
& pnpm tauri icon $png -o $iconDir
if ($LASTEXITCODE -ne 0) { throw 'Icon generation failed' }
