# First install only: bring over your settings and list from the folder you tested with,
# so the OBS password, camera, screens and tonight's list carry on.
param([string]$Dest, [string]$Src)
$target = Join-Path $Dest 'data'
if (Test-Path (Join-Path $target 'config.json')) { exit 0 }
$found = $null
if ($Src -and (Test-Path (Join-Path $Src 'data\config.json'))) { $found = Join-Path $Src 'data' }
if (-not $found) {
  $places = @("$env:USERPROFILE\Downloads", "$env:USERPROFILE\Desktop", "$env:USERPROFILE\Documents") | Where-Object { Test-Path $_ }
  $hit = Get-ChildItem -Path $places -Filter 'config.json' -Recurse -Depth 4 -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like '*Shiur*\data\config.json' } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($hit) { $found = $hit.DirectoryName }
}
if (-not $found) { exit 0 }
New-Item -ItemType Directory -Force -Path $target | Out-Null
Get-ChildItem -Path $found -Force | Where-Object { $_.Name -ne 'bar-browser' } | ForEach-Object { Copy-Item -Path $_.FullName -Destination $target -Recurse -Force }
Write-Host "   Your settings and list were brought over from: $found"
