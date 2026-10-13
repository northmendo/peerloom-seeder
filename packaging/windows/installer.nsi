; PeerLoom Seeder installer for Windows (x64). Built on Linux with makensis by
; scripts/dist-windows.js from a staged payload in payload/. Adapted from
; PearCircle's seeder launcher.
;
; Installs to Program Files, runs the seeder as a Windows service through NSSM
; (as LocalSystem, data in %ProgramData%\PeerLoom Seeder) and adds a Start menu
; link to the dashboard on http://127.0.0.1:8761. Running a newer installer over
; it (also silently, /S) stops the service, replaces the files and starts it
; again with the same data.

Unicode true
ManifestDPIAware true
!include "MUI2.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!define APP_NAME   "PeerLoom Seeder"
!define SVC_NAME   "PeerLoomSeeder"
!define PUBLISHER  "PeerLoom LLC"
!define PORT       "8761"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SVC_NAME}"

Name "${APP_NAME}"
OutFile "PeerLoomSeeder-Setup-${VERSION}.exe"
InstallDir "$PROGRAMFILES64\${APP_NAME}"
InstallDirRegKey HKLM "${UNINST_KEY}" "InstallLocation"
RequestExecutionLevel admin
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName"     "${APP_NAME}"
VIAddVersionKey "FileVersion"     "${VERSION}"
VIAddVersionKey "ProductVersion"  "${VERSION}"
VIAddVersionKey "CompanyName"     "${PUBLISHER}"
VIAddVersionKey "LegalCopyright"  "${PUBLISHER}"
VIAddVersionKey "FileDescription" "${APP_NAME} Setup"

!define MUI_ICON   "payload/AppIcon.ico"
!define MUI_UNICON "payload/AppIcon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TEXT "PeerLoom Seeder keeps your PeerLoom apps in sync while your phones sleep.$\r$\n$\r$\nIt runs in the background on this computer and stores only scrambled data it cannot read. A new phone still needs someone in the household online to join.$\r$\n$\r$\nWhen setup finishes, open the dashboard to pair a phone."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "payload/LICENSE.txt"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
Function OpenDashboard
  ExecShell "open" "http://127.0.0.1:${PORT}/"
FunctionEnd
!define MUI_FINISHPAGE_RUN ""
!define MUI_FINISHPAGE_RUN_TEXT "Open the PeerLoom Seeder dashboard"
!define MUI_FINISHPAGE_RUN_FUNCTION "OpenDashboard"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

!macro StopService
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" stop ${SVC_NAME}'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" remove ${SVC_NAME} confirm'
  nsExec::ExecToLog 'sc.exe stop ${SVC_NAME}'
  nsExec::ExecToLog 'sc.exe delete ${SVC_NAME}'
  Sleep 2000
!macroend

Section "PeerLoom Seeder" SecMain
  SetRegView 64
  SetShellVarContext all
  DetailPrint "Stopping any running ${APP_NAME} service..."
  !insertmacro StopService

  SetOutPath "$INSTDIR"
  ; Old program files go first so nothing from an earlier version lingers.
  RMDir /r "$INSTDIR\seeder"
  RMDir /r "$INSTDIR\host"
  File /r "payload/*"
  CreateDirectory "$APPDATA\${APP_NAME}"

  DetailPrint "Registering the ${APP_NAME} service..."
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" install ${SVC_NAME} "$INSTDIR\node.exe" "\"$INSTDIR\host\server.js\""'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SVC_NAME} AppDirectory "$INSTDIR"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SVC_NAME} AppEnvironmentExtra "SEEDER_DATA=$APPDATA\${APP_NAME}"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SVC_NAME} DisplayName "${APP_NAME}"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SVC_NAME} Description "Keeps your PeerLoom apps in sync while your phones sleep. Dashboard: http://127.0.0.1:${PORT}"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SVC_NAME} Start SERVICE_AUTO_START'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SVC_NAME} ObjectName LocalSystem'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SVC_NAME} AppStdout "$APPDATA\${APP_NAME}\seeder.log"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SVC_NAME} AppStderr "$APPDATA\${APP_NAME}\seeder.log"'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SVC_NAME} AppRotateFiles 1'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SVC_NAME} AppRotateOnline 1'
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SVC_NAME} AppRotateBytes 1048576'
  ; Ctrl+C first, so the seeder closes its stores cleanly.
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" set ${SVC_NAME} AppStopMethodConsole 10000'
  nsExec::ExecToLog 'sc.exe failure ${SVC_NAME} reset= 86400 actions= restart/60000/restart/60000/restart/60000'

  ; Phones connect to the seeder directly. A service never gets Windows' "allow
  ; access" prompt, so without this rule the firewall drops them. Only the
  ; seeder's own program; the dashboard stays on 127.0.0.1.
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${APP_NAME}"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${APP_NAME}" dir=in action=allow program="$INSTDIR\bare.exe" enable=yes profile=any'

  WriteINIStr "$SMPROGRAMS\${APP_NAME}.url" "InternetShortcut" "URL" "http://127.0.0.1:${PORT}/"
  WriteINIStr "$SMPROGRAMS\${APP_NAME}.url" "InternetShortcut" "IconFile" "$INSTDIR\AppIcon.ico"
  WriteINIStr "$SMPROGRAMS\${APP_NAME}.url" "InternetShortcut" "IconIndex" "0"

  WriteRegStr   HKLM "${UNINST_KEY}" "DisplayName"     "${APP_NAME}"
  WriteRegStr   HKLM "${UNINST_KEY}" "DisplayVersion"  "${VERSION}"
  WriteRegStr   HKLM "${UNINST_KEY}" "Publisher"       "${PUBLISHER}"
  WriteRegStr   HKLM "${UNINST_KEY}" "DisplayIcon"     "$INSTDIR\AppIcon.ico"
  WriteRegStr   HKLM "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr   HKLM "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegStr   HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  DetailPrint "Starting the ${APP_NAME} service..."
  nsExec::ExecToLog '"$INSTDIR\nssm.exe" start ${SVC_NAME}'
SectionEnd

Section "Uninstall"
  SetRegView 64
  SetShellVarContext all
  !insertmacro StopService
  Delete "$SMPROGRAMS\${APP_NAME}.url"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${APP_NAME}"'
  DeleteRegKey HKLM "${UNINST_KEY}"
  RMDir /r "$INSTDIR"
  ; Data stays unless the person says otherwise (a silent uninstall keeps it):
  ; reinstalling brings back the same seeder, devices and backups.
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete the seeder's data (its key, paired devices and backups)?$\r$\n$\r$\nKeep it to reinstall later as the same seeder." /SD IDNO IDNO keep
    RMDir /r "$APPDATA\${APP_NAME}"
  keep:
SectionEnd
