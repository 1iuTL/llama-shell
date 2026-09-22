@echo off
REM llama-shell launcher.
REM Uses an absolute path to electron.exe: a relative "." breaks when the
REM working directory is not honoured, and the space in "deepseek harness"
REM truncates an unquoted path.

set ELECTRON="C:\deepseek harness\dsh-desktop\node_modules\electron\dist\electron.exe"
set APP="C:\deepseek harness\llama-shell"

if not exist %ELECTRON% (
  echo.
  echo [ERROR] electron.exe not found at:
  echo   C:\deepseek harness\dsh-desktop\node_modules\electron\dist\electron.exe
  echo.
  echo Fix: run  npm install  inside llama-shell  ^(needs an electron 43.x^),
  echo      or point ELECTRON above at another Electron install.
  echo.
  pause
  exit /b 1
)

if not exist %APP%\src\main.js (
  echo [ERROR] llama-shell sources missing at %APP%
  pause
  exit /b 1
)

%ELECTRON% %APP%
if errorlevel 1 (
  echo.
  echo [llama-shell exited with code %errorlevel%]
  pause
)
