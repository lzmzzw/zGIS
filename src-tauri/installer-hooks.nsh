; 拒绝覆盖仍在运行的应用，避免 NSIS 静默安装强杀其他编辑会话。
!macro ZGIS_REFUSE_RUNNING
  nsis_tauri_utils::FindProcessCurrentUser "zgis.exe"
  Pop $R0
  ${If} $R0 = 0
    SetErrorLevel 2
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro ZGIS_REFUSE_RUNNING
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro ZGIS_REFUSE_RUNNING
!macroend
