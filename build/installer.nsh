; Picked up by electron-builder as `<buildResources>/installer.nsh` (the NSIS `include` option).

; A silent update of a per-machine install (`/S`, see installsSilently in electron/auto-updater.ts)
; asks for UAC in the install section, by which time the app has already quit. Declining it
; (error 1223) makes electron-builder's installer.nsi just Quit, so OpenScreen stays closed (#1461).
; Elevate here instead, as the stock section would, and bring the app back if that fails. The
; downloaded update stays cached, so the user can retry it.
!macro customInit
  ${if} ${Silent}
  ${andIf} $hasPerMachineInstallation == "1"
  ${andIfNot} ${UAC_IsAdmin}
    !insertmacro UAC_RunElevated
    ${if} $0 != 0
    ${andIf} ${isForceRun}
      ExecShell "open" "$perMachineInstallationFolder\${APP_EXECUTABLE_FILENAME}"
    ${endIf}
    Quit
  ${endIf}
!macroend
