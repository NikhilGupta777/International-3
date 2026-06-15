@echo off
setlocal EnableDelayedExpansion
title Narayan Bhakt Studio - Local Dev
color 0A

echo ============================================
echo   Narayan Bhakt Studio - Local Dev Server
echo ============================================
echo.

cd /d "%~dp0"

:: Kill any existing process on port 8080 and 5000
echo Checking for stale processes...
netstat -ano | findstr ":8080.*LISTENING" >nul 2>&1
if !ERRORLEVEL! EQU 0 (
    echo Killing process on port 8080...
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8080.*LISTENING"') do taskkill /PID %%p /F >nul 2>&1
)
netstat -ano | findstr ":5000.*LISTENING" >nul 2>&1
if !ERRORLEVEL! EQU 0 (
    echo Killing process on port 5000...
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":5000.*LISTENING"') do taskkill /PID %%p /F >nul 2>&1
)

echo.
echo [1/2] Building API server...
call pnpm --filter @workspace/api-server run build
if !ERRORLEVEL! NEQ 0 (
    color 0C
    echo.
    echo BUILD FAILED! Fix errors above.
    pause
    exit /b 1
)

echo.
echo [2/2] Starting servers...
echo.
echo   API + Static  :  http://localhost:8080
echo   Vite Dev      :  http://localhost:5000  (hot-reload)
echo.
echo   Open http://localhost:5000 in your browser.
echo   Press Ctrl+C in this window to stop Vite.
echo   Close the "API Server" window to stop the API.
echo ============================================
echo.

:: Start API server in a separate minimized window
start "API Server" /D "%~dp0" /min cmd /k "node artifacts\api-server\dist\index.mjs"

:: Wait for API to be ready
timeout /t 3 /nobreak >nul

:: Start Vite dev server (foreground, hot-reload, proxies /api to 8080)
set PORT=5000
call pnpm --filter @workspace/yt-downloader run dev

endlocal
