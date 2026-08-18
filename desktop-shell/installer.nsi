; DSH Desktop — NSIS 安装脚本（makensis 可用时由 build-installer.ps1 调用）
!define APP_NAME "DSH Desktop"
!define APP_VERSION "${VERSION}"
!define APP_DIR "$LOCALAPPDATA\Programs\DSH Desktop"

Name "${APP_NAME}"
OutFile "${OUTFILE}"
InstallDir "${APP_DIR}"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "安装" SecMain
  SetOutPath "${APP_DIR}"
  File "${ROOT}\launcher.mjs"
  File "${ROOT}\run.cmd"
  File "${ROOT}\tray.ps1"
  File "${ROOT}\notify.ps1"
  File "${ROOT}\settings.html"
  File "${ROOT}\icon.ico"
  File "${ROOT}\diag-session.mjs"
  File "${ROOT}\setup.cmd"
  File "${ROOT}\uninstall.cmd"
  File "${ROOT}\make-shortcuts.ps1"
  File "${ROOT}\launch-hidden.vbs"
  File "${ROOT}\CHANGELOG.md"
  File "${ROOT}\README.md"
  File "${ROOT}\VERSION"

  ; 快捷方式（隐藏控制台启动）
  SetOutPath "${APP_DIR}"
  CreateShortCut "$DESKTOP\DSH Desktop.lnk" "$WINDIR\System32\wscript.exe" '"${APP_DIR}\launch-hidden.vbs"' "${APP_DIR}\icon.ico"
  CreateDirectory "$SMPROGRAMS\DSH Desktop"
  CreateShortCut "$SMPROGRAMS\DSH Desktop\DSH Desktop.lnk" "$WINDIR\System32\wscript.exe" '"${APP_DIR}\launch-hidden.vbs"' "${APP_DIR}\icon.ico"
  CreateShortCut "$SMPROGRAMS\DSH Desktop\卸载 DSH Desktop.lnk" "${APP_DIR}\uninstall.cmd" "" "${APP_DIR}\icon.ico"

  ; dsh:// 协议 + 卸载信息
  WriteRegStr HKCU "Software\Classes\dsh" "" "URL:DSH Desktop"
  WriteRegStr HKCU "Software\Classes\dsh" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\dsh\shell\open\command" "" '"${APP_DIR}\run.cmd" "%1"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop" "Publisher" "DeepSeek Harness"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop" "InstallLocation" "${APP_DIR}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop" "DisplayIcon" "${APP_DIR}\icon.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop" "UninstallString" '"${APP_DIR}\uninstall.cmd"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop" "NoRepair" 1

  ; PowerShell 7 前置检查（agent shell 工具需要）
  nsExec::ExecToStack 'where pwsh'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_ICONINFORMATION|MB_OK "警告：未检测到 PowerShell 7。`nagent 的 shell 工具需要 PowerShell 7+，请运行: winget install Microsoft.PowerShell"
  ${EndIf}
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\DSH Desktop.lnk"
  RMDir /r "$SMPROGRAMS\DSH Desktop"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "DSHDesktop"
  DeleteRegKey HKCU "Software\Classes\dsh"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\DSHDesktop"
  RMDir /r "${APP_DIR}"
SectionEnd
