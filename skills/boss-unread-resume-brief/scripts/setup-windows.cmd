@echo off
setlocal
title BOSS Resume Brief Setup

echo ============================================
echo   BOSS Resume Brief - Windows Setup
echo ============================================
echo.
echo This script uses only system Node.js.
echo It does not use WorkBuddy's bundled Node.js.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found in PATH.
  echo.
  echo Opening Node.js 20.18.0 MSI download page...
  start https://npmmirror.com/mirrors/node/v20.18.0/node-v20.18.0-x64.msi
  echo.
  echo Please install Node.js with default settings:
  echo   Next, Next, Install, Finish
  echo.
  echo After installation, close this window and open a NEW CMD window.
  echo Then run this setup script again.
  echo.
  pause
  exit /b 1
)

echo Node.js detected:
node --version
echo.

echo Installing BOSS CLI and Lark CLI...
call npm install -g @joohw/boss-cli @larksuite/cli --registry=https://registry.npmmirror.com
if errorlevel 1 (
  echo.
  echo npm install failed. Try opening a NEW CMD window and run this script again.
  pause
  exit /b 1
)

echo.
echo ============================================
echo Setup complete.
echo.
echo Next login commands:
echo   boss login
echo   lark-cli config init --new
echo   lark-cli auth login
echo.
echo Run these commands in this CMD window.
echo ============================================
echo.
pause
