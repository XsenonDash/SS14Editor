@echo off
setlocal

:: -----------------------------------------------------------------------
:: launch-electron.bat — Build the .NET backend, install Electron deps
::                        (once), then start the desktop app.
:: Requires: Node.js on PATH  (https://nodejs.org)
:: -----------------------------------------------------------------------

where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js not found on PATH.
    echo         Download it from https://nodejs.org and re-run this script.
    pause
    exit /b 1
)

:: Always publish the .NET backend before launching
echo [launch] Building .NET backend...
call build.bat publish
if %ERRORLEVEL% neq 0 ( echo [launch] Build failed. & pause & exit /b 1 )

:: Install Electron once
if not exist "electron\node_modules" (
    echo [launch] Installing Electron dependencies...
    cd electron
    npm install
    if %ERRORLEVEL% neq 0 ( echo [launch] npm install failed. & pause & exit /b 1 )
    cd ..
)

echo [launch] Starting SS14 Editor desktop app...
cd electron
npm start
if %ERRORLEVEL% neq 0 ( echo [launch] npm start failed with error %ERRORLEVEL%. )
pause
