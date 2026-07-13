@echo off
rem Double-click this file to relaunch TradingView with the Claude debug port.
rem Safe to run any time; it closes TradingView and reopens it with port 9222.
setlocal
set PORT=9222

set APP=
if exist "%LOCALAPPDATA%\TradingView\TradingView.exe" set "APP=%LOCALAPPDATA%\TradingView\TradingView.exe"
if not defined APP if exist "%PROGRAMFILES%\TradingView\TradingView.exe" set "APP=%PROGRAMFILES%\TradingView\TradingView.exe"
if not defined APP if exist "%PROGRAMFILES(X86)%\TradingView\TradingView.exe" set "APP=%PROGRAMFILES(X86)%\TradingView\TradingView.exe"

if not defined APP (
  echo TradingView.exe was not found in the usual locations.
  echo If you installed it somewhere else, edit this file and set APP to that path.
  echo If you installed from the Microsoft Store, install the version from
  echo https://www.tradingview.com/desktop/ instead - the Store version cannot
  echo be launched with the debug flag.
  pause
  exit /b 1
)

echo Closing any running TradingView...
taskkill /IM TradingView.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul

echo Launching TradingView with debug port %PORT% ...
start "" "%APP%" --remote-debugging-port=%PORT%

echo Waiting for the debug port to come up...
for /l %%i in (1,1,20) do (
  curl -s http://localhost:%PORT%/json/version >nul 2>&1 && goto ready
  timeout /t 1 /nobreak >nul
)
echo.
echo Port %PORT% is not answering yet - TradingView may still be loading.
echo Wait for it to open fully, then ask Claude to run tv_health_check.
pause
exit /b 0

:ready
echo.
echo Connected! CDP is ready at http://localhost:%PORT%
echo You can now ask Claude to run tv_health_check.
timeout /t 6 >nul
