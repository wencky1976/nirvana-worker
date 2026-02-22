@echo off
echo ========================================
echo   NirvanaTraffic Worker - Setup
echo ========================================
echo.

:: Check if Node.js is installed
node --version >nul 2>&1
if errorlevel 1 (
    echo [!] Node.js not found. Installing...
    echo [!] Please download and install Node.js from:
    echo     https://nodejs.org/dist/v20.11.0/node-v20.11.0-x64.msi
    echo.
    echo After installing Node.js, run this script again.
    pause
    exit /b 1
)
echo [OK] Node.js found: 
node --version

:: Install npm packages
echo.
echo [1/3] Installing dependencies...
call npm install

:: Install Playwright Chromium browser
echo.
echo [2/3] Installing Chromium browser (this may take a minute)...
call npx playwright install chromium

:: Done
echo.
echo [3/3] Setup complete!
echo.
echo ========================================
echo   To start the worker, run:
echo   node worker.js
echo ========================================
echo.
pause
