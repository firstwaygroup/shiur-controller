@echo off
setlocal
title Install Shiur
cd /d "%~dp0"
set "DEST=%LOCALAPPDATA%\Shiur"
echo.
echo   Installing Shiur on this laptop...
echo.

rem 1. Node.js must be installed.
where node >nul 2>nul
if errorlevel 1 if not exist "%ProgramFiles%\nodejs\node.exe" (
  echo   Node.js is missing. The Node.js website will open now.
  echo   Install the LTS version, then double-click "Install Shiur" again.
  start "" "https://nodejs.org"
  echo.
  pause
  exit /b 1
)

rem 2. If a shiur is running, end it (this also closes OBS), and close the Shiur app so it can be replaced.
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -Method Post -Uri http://127.0.0.1:8080/api/end -Body '{}' -ContentType application/json -TimeoutSec 3 | Out-Null; Start-Sleep -Seconds 3 } catch { }"
taskkill /IM Shiur.exe >nul 2>nul
timeout /t 1 /nobreak >nul

rem 3. Copy the program. Your list and settings (the "data" folder) are kept.
if not exist "%DEST%" mkdir "%DEST%"
robocopy "%~dp0." "%DEST%" /E /XD data node_modules test .github .git /XF "Install Shiur.bat" /NFL /NDL /NJH /NJS /NP >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%DEST%\app\carry-settings.ps1" -Dest "%DEST%" -Src "%~dp0."

rem 4. The Shiur app. A release from GitHub already has it ready; from the source code, build it here.
if exist "%~dp0Shiur.exe" goto built
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
set "REFS=/r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll"
del "%DEST%\Shiur.exe" >nul 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%DEST%\app\get-webview.ps1" -Dest "%DEST%"
if exist "%CSC%" if exist "%DEST%\Microsoft.Web.WebView2.WinForms.dll" "%CSC%" /nologo /target:winexe /optimize+ /define:WEBVIEW2 /out:"%DEST%\Shiur.exe" /win32icon:"%DEST%\app\shiur.ico" %REFS% /r:"%DEST%\Microsoft.Web.WebView2.Core.dll" /r:"%DEST%\Microsoft.Web.WebView2.WinForms.dll" "%DEST%\app\Shiur.cs" > "%DEST%\app\build-log.txt" 2>&1
if exist "%CSC%" if not exist "%DEST%\Shiur.exe" "%CSC%" /nologo /target:winexe /optimize+ /out:"%DEST%\Shiur.exe" /win32icon:"%DEST%\app\shiur.ico" %REFS% "%DEST%\app\Shiur.cs" >> "%DEST%\app\build-log.txt" 2>&1
:built

rem 5. Put the Shiur icon on the desktop and in the Start menu.
powershell -NoProfile -ExecutionPolicy Bypass -File "%DEST%\app\make-shortcuts.ps1" -Dest "%DEST%"

echo.
if exist "%DEST%\Shiur.exe" (
  echo   Done. The Shiur icon is on your desktop.
) else (
  echo   Done ^(using the backup way to start^). The Shiur icon is on your desktop.
)
echo.
pause
