@echo off
title Sonic Transfer - One-Click Launcher
echo ===================================================
echo             SONIC TRANSFER LOCAL LAUNCHER
echo     Direct file transfer through sound (No Server)
echo ===================================================
echo.

REM Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is required to run Sonic Transfer locally.
    echo Please install Node.js from https://nodejs.org/ and try again.
    pause
    exit /b 1
)

REM Check if production build exists
if not exist ".output\public\index.html" (
    echo [INFO] Production build not found. Generating static assets...
    call npx pnpm generate
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to build static assets.
        pause
        exit /b 1
    )
)

echo [INFO] Starting lightweight local server on http://localhost:3000 ...
echo [INFO] Opening default browser...
echo.

start "" "http://localhost:3000"
call npx serve .output/public -l 3000

pause
