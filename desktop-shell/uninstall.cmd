@echo off
rem DSH Desktop uninstaller
setlocal
set "INSTALL_DIR=%~dp0"
set "INSTALL_DIR=%INSTALL_DIR:~0,-1%"
set "APP_DATA=%LOCALAPPDATA%\DSHDesktop"

echo.
echo ============================================
echo   Uninstall DSH Desktop
echo ============================================
echo.

rem Remove shortcuts (Desktop may be redirected; resolve real path via PowerShell)
for /f "delims=" %%D in ('powershell -NoProfile -Command "[Environment]::GetFolderPath('Desktop')"') do del /q "%%D\DSH Desktop.lnk" 2>nul
del /q "%USERPROFILE%\Desktop\DSH Desktop.lnk" 2>nul
rmdir /s /q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\DSH Desktop" 2>nul

rem Remove registry entries
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v DSHDesktop /f 2>nul
reg delete "HKCU\Software\Classes\dsh" /f 2>nul
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop" /f 2>nul

rem User data (kept by default; silent/EOF input -> keep)
set "DELDATA="
set /p "DELDATA=Delete data dir (sessions, settings, logs)? [Y=delete, else keep]: "
if /i "%DELDATA%"=="Y" (
  rmdir /s /q "%APP_DATA%" 2>nul
  echo [deleted] %APP_DATA%
) else (
  echo [kept] %APP_DATA%
)

rem Self-delete (detached PowerShell, survives console close, 2s delay)
cd /d "%TEMP%"
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 2; Remove-Item -LiteralPath '%INSTALL_DIR%' -Recurse -Force"
echo.
echo Uninstall finished.
exit /b 0
