@echo off
setlocal
REM model-stove launcher.
REM
REM 两点说明:
REM 1) 用 %CD% 拼绝对路径,而不是 "." —— 这个目录名里有空格,
REM    未加引号会被截断,相对路径也会在"工作目录没被尊重"时失效。
REM 2) --no-sandbox:这台机器上 Chromium 自己的沙箱初始化会失败,electron 会
REM    在几百毫秒内秒退(退出码 0x80000003)且不给任何提示。加上它才能启动。
REM    诊断记录见 logs\launcher.log。
cd /d "%~dp0"
set ELECTRON="%CD%\node_modules\electron\dist\electron.exe"
if not exist %ELECTRON% (
  echo.
  echo [ERROR] electron.exe 不在 %CD%\node_modules\electron\dist\
  echo   修复: 在 %CD% 下执行  npm install
  echo.
  pause
  exit /b 1
)
if not exist "%CD%\src\main.js" (
  echo [ERROR] 源码缺失: %CD%\src\main.js
  pause
  exit /b 1
)
%ELECTRON% --no-sandbox "%CD%"
if errorlevel 1 (
  echo.
  echo [model-stove exited with code %errorlevel%]
  pause
)