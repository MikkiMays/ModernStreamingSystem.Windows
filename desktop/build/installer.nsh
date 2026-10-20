; Cord — свои страницы мастера NSIS (electron-builder `include`).
; Ярлык на рабочем столе (T15): галочка видна и включена по умолчанию; выбор запоминается в HKCU
; и учитывается при тихом обновлении. Ни одной ссылки — ни в тексте, ни в карточке Windows.
!include "nsDialogs.nsh"
!include "LogicLib.nsh"

Var CordDesktopShortcut
Var CordDesktopCheckbox

!macro customHeader
  !system "echo Cord installer pages"
!macroend

; Человеческое описание Cord как продукта на странице приветствия.
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Cord"
  !define MUI_WELCOMEPAGE_TEXT "Видеовстречи, демонстрация экрана и совместный просмотр.$\r$\n$\r$\nМастер установит Cord для текущего пользователя Windows — без прав администратора. Приложение проверяет обновления само при каждом запуске и ставит их тихо.$\r$\n$\r$\nНажмите «Далее», чтобы продолжить."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customPageAfterChangeDir
  Page custom CordShortcutPageCreate CordShortcutPageLeave
!macroend

Function CordShortcutPageCreate
  ${If} ${Silent}
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Ярлыки" "Где показывать Cord"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ; Запомненный выбор; по умолчанию — включено.
  ReadRegDWORD $CordDesktopShortcut HKCU "Software\Cord" "DesktopShortcut"
  ${If} $CordDesktopShortcut == ""
    StrCpy $CordDesktopShortcut 1
  ${EndIf}
  ${NSD_CreateCheckbox} 0 20u 100% 12u "Создать ярлык на рабочем столе"
  Pop $CordDesktopCheckbox
  ${If} $CordDesktopShortcut == 1
    ${NSD_Check} $CordDesktopCheckbox
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function CordShortcutPageLeave
  ${NSD_GetState} $CordDesktopCheckbox $CordDesktopShortcut
  ${If} $CordDesktopShortcut == ${BST_CHECKED}
    StrCpy $CordDesktopShortcut 1
  ${Else}
    StrCpy $CordDesktopShortcut 0
  ${EndIf}
FunctionEnd

!macro customInstall
  ${If} ${Silent}
    ; Тихое обновление: выбор берётся из прошлой установки, по умолчанию — да.
    ReadRegDWORD $CordDesktopShortcut HKCU "Software\Cord" "DesktopShortcut"
    ${If} $CordDesktopShortcut == ""
      StrCpy $CordDesktopShortcut 1
    ${EndIf}
  ${EndIf}
  WriteRegDWORD HKCU "Software\Cord" "DesktopShortcut" $CordDesktopShortcut
  ${If} $CordDesktopShortcut == 1
    CreateShortCut "$DESKTOP\Cord.lnk" "$INSTDIR\Cord.exe" "" "$INSTDIR\Cord.exe" 0
  ${Else}
    Delete "$DESKTOP\Cord.lnk"
  ${EndIf}
  ; Карточка «Установленные приложения»: издатель Cord, без ссылок. electron-builder пишет
  ; HelpLink/URLInfoAbout только из homepage/uninstallUrl*, которых нет; на всякий случай — убираем.
  DeleteRegValue SHCTX "${UNINSTALL_REGISTRY_KEY}" "HelpLink"
  DeleteRegValue SHCTX "${UNINSTALL_REGISTRY_KEY}" "URLInfoAbout"
  DeleteRegValue SHCTX "${UNINSTALL_REGISTRY_KEY}" "URLUpdateInfo"
  DeleteRegValue SHCTX "${UNINSTALL_REGISTRY_KEY}" "Readme"
  WriteRegStr SHCTX "${UNINSTALL_REGISTRY_KEY}" "Publisher" "Cord"
  WriteRegStr SHCTX "${UNINSTALL_REGISTRY_KEY}" "Comments" "Видеовстречи, демонстрация экрана и совместный просмотр"
  ; Deep links cord:// для текущего пользователя.
  WriteRegStr HKCU "Software\Classes\cord" "" "URL:Cord"
  WriteRegStr HKCU "Software\Classes\cord" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\cord\DefaultIcon" "" "$INSTDIR\Cord.exe,0"
  WriteRegStr HKCU "Software\Classes\cord\shell\open\command" "" '"$INSTDIR\Cord.exe" "%1"'
!macroend

!macro customUnInstall
  Delete "$DESKTOP\Cord.lnk"
  DeleteRegKey HKCU "Software\Classes\cord"
  ; Настройки (%LOCALAPPDATA%\Cord) остаются: deleteAppDataOnUninstall: false.
!macroend
