# Gets Microsoft's WebView2 files (once), so the Shiur controls show inside the app instead of a browser window.
param([string]$Dest)
$need = @('Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll')
if (@($need | Where-Object { -not (Test-Path (Join-Path $Dest $_)) }).Count -eq 0) { exit 0 }
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
$tmp = Join-Path $env:TEMP 'shiur-webview2'
$zip = "$tmp.zip"
foreach ($url in @('https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.2849.39', 'https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2')) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip -TimeoutSec 90
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $core = Get-ChildItem -Path (Join-Path $tmp 'lib') -Recurse -Filter 'Microsoft.Web.WebView2.Core.dll' | Where-Object { $_.FullName -match '\\net4' } | Select-Object -First 1
    $forms = Get-ChildItem -Path (Join-Path $tmp 'lib') -Recurse -Filter 'Microsoft.Web.WebView2.WinForms.dll' | Where-Object { $_.FullName -match '\\net4' } | Select-Object -First 1
    $loader = Join-Path $tmp 'runtimes\win-x64\native\WebView2Loader.dll'
    if ($core -and $forms -and (Test-Path $loader)) {
      Copy-Item $core.FullName $Dest -Force
      Copy-Item $forms.FullName $Dest -Force
      Copy-Item $loader $Dest -Force
      Write-Host '   Got the built-in web view.'
      exit 0
    }
  } catch { }
}
Write-Host '   (No built-in web view: the controls will open in a small browser window instead.)'
