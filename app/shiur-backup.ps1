# Backup way to start Shiur, used only if the app could not be built: runs the same code through PowerShell.
$dest = Split-Path -Parent $PSScriptRoot
Add-Type -TypeDefinition (Get-Content -Raw -Path (Join-Path $PSScriptRoot 'Shiur.cs')) -ReferencedAssemblies System.Windows.Forms, System.Drawing, System.IO.Compression, System.IO.Compression.FileSystem
[ShiurApp.Program]::Main(@($dest))
