@echo off
rem DSH Desktop installer (called by SFX package or double-click)
rem Installs to: %LOCALAPPDATA%\Programs\DSH Desktop (no admin required)
setlocal
set "INSTALL_DIR=%LOCALAPPDATA%\Programs\DSH Desktop"
echo.
echo ============================================
echo   DSH Desktop installer
echo ============================================
echo.
echo Install dir: %INSTALL_DIR%
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
if errorlevel 1 goto fail

rem Copy all files from this script's folder
xcopy /y /e /i /q "%~dp0*" "%INSTALL_DIR%\" >nul
if errorlevel 1 goto fail

rem Shortcuts (Desktop + Start Menu + Uninstall)
powershell -NoProfile -ExecutionPolicy Bypass -File "%INSTALL_DIR%\make-shortcuts.ps1" -InstallDir "%INSTALL_DIR%" -Version "0.3.0"
if errorlevel 1 echo [WARN] shortcut creation failed

rem Register dsh:// protocol + autostart (idempotent)
call "%INSTALL_DIR%\run.cmd" --register

rem Uninstall entry (Control Panel - Apps)
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop" /v DisplayName /t REG_SZ /d "DSH Desktop" /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop" /v DisplayVersion /t REG_SZ /d "0.3.0" /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop" /v Publisher /t REG_SZ /d "DeepSeek Harness" /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop" /v InstallLocation /t REG_SZ /d "%INSTALL_DIR%" /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop" /v DisplayIcon /t REG_SZ /d "%INSTALL_DIR%\icon.ico" /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop" /v UninstallString /t REG_SZ /d "\"%INSTALL_DIR%\uninstall.cmd\"" /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop" /v NoModify /t REG_DWORD /d 1 /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop" /v NoRepair /t REG_DWORD /d 1 /f >nul

rem PowerShell 7 prerequisite check (agent shell tools need it)
where pwsh >nul 2>nul
if errorlevel 1 (
  echo.
  echo [WARN] PowerShell 7 not found.
  echo        Agent shell tools require PowerShell 7+.
  echo        Install it with:  winget install Microsoft.PowerShell
) else (
  echo [OK] PowerShell 7 detected
)

echo.
echo Install finished! Launch via Desktop icon or Start Menu "DSH Desktop".
echo Data dir: %LOCALAPPDATA%\DSHDesktop
echo.
pause
exit /b 0

:fail
echo.
echo [ERROR] install failed
pause
exit /b 1
