# Sonic Transfer PowerShell Launcher
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "            SONIC TRANSFER LOCAL LAUNCHER" -ForegroundColor Cyan
Write-Host "     Direct file transfer through sound (No Server)" -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] Node.js is required to run Sonic Transfer locally." -ForegroundColor Red
    Write-Host "Please install Node.js from https://nodejs.org/" -ForegroundColor Red
    Read-Host "Press Enter to exit..."
    exit 1
}

if (-not (Test-Path ".output\public\index.html")) {
    Write-Host "[INFO] Production build not found. Generating static assets..." -ForegroundColor Yellow
    npx pnpm generate
}

Write-Host "[INFO] Starting local static server at http://localhost:3000" -ForegroundColor Green
Start-Process "http://localhost:3000"
npx serve .output/public -l 3000
