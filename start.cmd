@echo off
rem Electron enforces one running instance and focuses the existing window.
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22+ is required. Please install Node.js first.
  pause
  exit /b 1
)
if not exist node_modules\electron (
  echo Installing dependencies for first launch...
  call npm install
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)
call npm start
if errorlevel 1 pause
