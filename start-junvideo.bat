@echo off
setlocal EnableExtensions

cd /d "%~dp0"
set "ROOT=%CD%"
title JunVideo Launcher

echo.
echo ========================================
echo          JunVideo one-click launcher
echo ========================================
echo.

where node >nul 2>&1
if errorlevel 1 goto :missing_node
where npm >nul 2>&1
if errorlevel 1 goto :missing_npm

if not exist "%ROOT%\.env" (
  echo [setup] Creating .env from .env.example...
  copy /Y "%ROOT%\.env.example" "%ROOT%\.env" >nul
)

if not exist "%ROOT%\node_modules" (
  echo [setup] Installing npm dependencies...
  call npm install
  if errorlevel 1 goto :failed
)

if not exist "%ROOT%\bin\yt-dlp.exe" (
  echo [setup] Installing the official yt-dlp binary...
  call npm run setup:ytdlp
  if errorlevel 1 echo [warning] yt-dlp setup failed. The UI can still start, but real parsing may be unavailable.
)

set "XHS_SIDECAR_EXE=%ROOT%\.runtime\xhs-downloader\main.exe"
if not exist "%XHS_SIDECAR_EXE%" (
  echo [setup] Installing the official XHS-Downloader Windows package...
  call npm run setup:xhs
  if errorlevel 1 echo [warning] XHS-Downloader setup failed. XHS links may require manual sidecar installation.
)
if exist "%XHS_SIDECAR_EXE%" (
  set "XHS_DOWNLOADER_API_URL=http://127.0.0.1:5556/xhs/detail"
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$busy=Get-NetTCPConnection -LocalPort 5556 -State Listen -ErrorAction SilentlyContinue; if (-not $busy) { exit 0 }; exit 2"
  if errorlevel 1 (
    echo [start] XHS-Downloader sidecar is already listening on http://127.0.0.1:5556.
  ) else (
    echo [start] Opening the local XHS-Downloader sidecar on http://127.0.0.1:5556...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "$exe='%XHS_SIDECAR_EXE%'; $dir=Split-Path -Parent $exe; $out=Join-Path '%ROOT%' '.runtime\xhs-sidecar.out.log'; $err=Join-Path '%ROOT%' '.runtime\xhs-sidecar.err.log'; Start-Process -FilePath $exe -ArgumentList 'api' -WorkingDirectory $dir -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err | Out-Null"
  )
  echo [start] Waiting for the XHS-Downloader sidecar...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$deadline=(Get-Date).AddSeconds(20); while ((Get-Date) -lt $deadline) { try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:5556/docs' -TimeoutSec 2; if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { exit 0 } } catch {} Start-Sleep -Milliseconds 500 }; exit 1"
  if errorlevel 1 echo [warning] XHS-Downloader sidecar did not become ready. XHS links may require a fresh authorized session.
) else (
  echo [info] Optional XHS-Downloader sidecar not installed. Douyin, Bilibili and other configured parsers remain available.
)

echo [setup] Applying PostgreSQL schema...
call npm run db:init
if errorlevel 1 (
  echo.
  echo [error] PostgreSQL initialization failed.
  echo         Confirm PostgreSQL is running and database "junvideo" exists.
  goto :failed
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ports=4000,5173; $busy=Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort }; if ($busy) { $busy | Format-Table -AutoSize; exit 2 }"
if errorlevel 1 (
  echo.
  echo [error] Port 4000 or 5173 is already in use. Close the existing JunVideo process and retry.
  goto :failed
)

echo [start] Opening API window on http://localhost:4000...
start "JunVideo API" "%ComSpec%" /k "cd /d ""%ROOT%"" && call npm run dev:api"

echo [start] Waiting for the API health check...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$deadline=(Get-Date).AddSeconds(45); while ((Get-Date) -lt $deadline) { try { $r=Invoke-RestMethod -Uri 'http://localhost:4000/api/health' -TimeoutSec 2 -ErrorAction Stop; if ($r.service -eq 'junvideo-api') { exit 0 } } catch {} Start-Sleep -Milliseconds 500 }; exit 1"
if errorlevel 1 (
  echo.
  echo [error] API did not become ready within 45 seconds. Check the JunVideo API window for details.
  goto :failed
)

echo [start] Opening web window on http://localhost:5173...
start "JunVideo Web" "%ComSpec%" /k "cd /d ""%ROOT%"" && call npm run dev:web -- --host 127.0.0.1"

echo [start] Waiting for the web server...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$deadline=(Get-Date).AddSeconds(30); while ((Get-Date) -lt $deadline) { try { $r=Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:5173' -TimeoutSec 2; if ($r.StatusCode -ge 200) { exit 0 } } catch {} Start-Sleep -Milliseconds 500 }; exit 1"
if errorlevel 1 echo [warning] Web server is still starting. Open http://localhost:5173 manually if needed.

start "" "http://localhost:5173"
echo.
echo JunVideo has been started. Keep the API and Web windows open.
exit /b 0

:missing_node
echo [error] Node.js is not installed or not available in PATH.
goto :failed

:missing_npm
echo [error] npm is not installed or not available in PATH.
goto :failed

:failed
echo.
echo JunVideo launcher stopped with an error.
pause
exit /b 1
