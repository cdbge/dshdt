@echo off
rem 桌面端"页面装载失败"取证：用仓库自带的 Electron 打开给定宿主 URL，把渲染器里的现场落盘。
rem 用法：probe-renderer-diagnostics.cmd "http://127.0.0.1:<port>/?token=..."
rem 结果：desktop-electron\.probe\renderer-diagnostics.log
setlocal
set "HERE=%~dp0"
set "ELECTRON=%HERE%..\node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
  echo [x] 找不到 Electron：%ELECTRON%
  echo     先跑一次 npm install（desktop-electron 目录下）。
  exit /b 2
)
if "%~1"=="" (
  echo 用法：probe-renderer-diagnostics.cmd "http://127.0.0.1:^<port^>/?token=..."
  exit /b 2
)
set "ELECTRON_RUN_AS_NODE="
"%ELECTRON%" "%HERE%probe-renderer-diagnostics.mjs" "%~1" --disable-gpu
echo 探针退出码=%ERRORLEVEL%，日志：%HERE%..\.probe\renderer-diagnostics.log
endlocal
