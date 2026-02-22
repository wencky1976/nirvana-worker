@echo off
echo ========================================
echo   NirvanaTraffic Worker - Auto Update
echo ========================================
echo.
echo Downloading latest worker.js from GitHub...
echo.

powershell -Command "Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/wencky1976/nirvana-worker/main/worker.js' -OutFile 'worker.js'"

if errorlevel 1 (
    echo [ERROR] Failed to download update. Check internet connection.
    pause
    exit /b 1
)

echo [OK] worker.js updated to latest version!
echo.
echo ========================================
echo   Now run START.bat to launch the worker
echo ========================================
echo.
pause
