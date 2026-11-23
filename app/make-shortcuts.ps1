# Puts the Shiur icon on the desktop and in the Start menu.
param([string]$Dest)
$ws = New-Object -ComObject WScript.Shell
$exe = Join-Path $Dest 'Shiur.exe'
$icon = Join-Path $Dest 'app\shiur.ico'
$places = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))
foreach ($dir in $places) {
  if (-not $dir) { continue }
  $lnk = $ws.CreateShortcut((Join-Path $dir 'Shiur.lnk'))
  if (Test-Path $exe) {
    $lnk.TargetPath = $exe
    $lnk.Arguments = ''
    $lnk.WindowStyle = 1
  } else {
    # Backup way: the same app, run through PowerShell.
    $lnk.TargetPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $lnk.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $Dest 'app\shiur-backup.ps1') + '"'
    $lnk.WindowStyle = 7
  }
  $lnk.IconLocation = "$icon,0"
  $lnk.WorkingDirectory = $Dest
  $lnk.Description = 'Start the shiur: wall screen, Zoom and the button panel'
  $lnk.Save()
}
