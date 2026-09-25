@echo off
setlocal
REM 用法: build.cmd <应用根目录> [输出exe路径]
REM   缺省输出 = <应用根目录>\Model Stove.exe
if "%~1"=="" (
  echo 用法: build.cmd ^<应用根目录^> [输出exe路径]
  exit /b 1
)
set "APPDIR=%~1"
if "%~2"=="" ( set "OUT=%APPDIR%\Model Stove.exe" ) else ( set "OUT=%~2" )
set "CSC=%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" ( echo [ERROR] 找不到 csc.exe; pause; exit /b 1 )
set "SRC=%~dp0ModelStoveLauncher.cs"
set "TMP=%TEMP%\ModelStoveLauncher.%RANDOM%.cs"
powershell -NoProfile -Command "(Get-Content -Raw '%SRC%') -replace '__APP_DIR__', '%APPDIR%' | Set-Content -Encoding UTF8 '%TMP%'"
"%CSC%" /nologo /target:exe /r:System.Windows.Forms.dll "/win32icon:%APPDIR%\model-stove.ico" "/out:%OUT%" "%TMP%"
set "RC=%ERRORLEVEL%"
del "%TMP%" >nul 2>&1
if not "%RC%"=="0" ( echo [ERROR] 编译失败; pause; exit /b %RC% )
echo 已生成: "%OUT%"