; Cord — дополнения к установщику NSIS (electron-builder `include`; ADR 0001 §6, T54, T15, П15, R59, R64, R105).
; Установщик «одним окном», как у Телемоста (R105, n04): выбор языка, затем маленькое окно с полосой —
; и Cord запускается сам. Ни приветствия, ни папки, ни ярлыков, ни финиша: папка — всегда
; %LOCALAPPDATA%\Programs\Cord, ярлыки на рабочем столе и в «Пуск» — всегда (electron-builder,
; createDesktopShortcut, с AUMID). Ни одной ссылки — ни в тексте, ни в карточке Windows.
; Язык мастера (R64): окно выбора при запуске (не в тихом режиме), выбор запоминается в
; HKCU\Software\Cord\InstallerLanguage, LCID уходит приложению в HKCU\Software\Cord\Language —
; оболочка читает его при первом запуске и отдаёт вебу (`Bootstrap.language`).
!include "LogicLib.nsh"

; Только для установщика: деинсталлятор собирается тем же скриптом с BUILD_UNINSTALLER.
!ifndef BUILD_UNINSTALLER
  Var CordLegacyShortcut
!endif

; LangString — здесь, а не на верхнем уровне файла: electron-builder вставляет customHeader после
; MUI_LANGUAGE, и только тогда известны ${LANG_*}. Своих страниц больше нет — свой текст один:
; описание в карточке «Установленные приложения». Надпись над полосой — `installing` electron-builder.
!macro customHeader
  ; Окно выбора языка и окно с полосой знают свой DPI: на 125–200 % не мылятся.
  ManifestDPIAware true

  ; Окно выбора языка: запомненный выбор — по умолчанию, показывается всегда (кроме тихого режима,
  ; см. customInit); деинсталлятор берёт тот же язык из реестра (customUnInit).
  !define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
  !define MUI_LANGDLL_REGISTRY_KEY "Software\Cord"
  !define MUI_LANGDLL_REGISTRY_VALUENAME "InstallerLanguage"
  !define MUI_LANGDLL_ALWAYSSHOW
  !define MUI_LANGDLL_WINDOWTITLE "Cord"
  !define MUI_LANGDLL_INFO "Выберите язык установки · Choose the installer language"

  ; Описание в карточке «Установленные приложения» — на языке, на котором ставили.
  LangString CordComments ${LANG_RUSSIAN} "Видеовстречи, демонстрация экрана и совместный просмотр"
  LangString CordComments ${LANG_ENGLISH} "Video meetings, screen sharing and watching together"
  LangString CordComments ${LANG_SPANISHINTERNATIONAL} "Videorreuniones, pantalla compartida y contenido para ver juntos"
  LangString CordComments ${LANG_FRENCH} "Réunions vidéo, partage d'écran et visionnage ensemble"
  LangString CordComments ${LANG_ITALIAN} "Videoriunioni, condivisione dello schermo e visione insieme"
  LangString CordComments ${LANG_SIMPCHINESE} "视频会议、屏幕共享和一起观看"
  LangString CordComments ${LANG_GERMAN} "Videomeetings, Bildschirmfreigabe und gemeinsames Anschauen"
  LangString CordComments ${LANG_PORTUGUESEBR} "Videochamadas, compartilhamento de tela e sessões para assistir juntos"
!macroend

; .onInit после проверки «один экземпляр» и выбора режима «для пользователя».
!macro customInit
  ; Свежая установка — в %LOCALAPPDATA%\Programs\Cord, как у прежних выпусков: в режиме «одним окном»
  ; electron-builder назвал бы папку по имени пакета (cord-desktop). Обновление ставится туда, где стоит.
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 == ""
    ${GetParent} $INSTDIR $0
    StrCpy $INSTDIR "$0\${PRODUCT_FILENAME}"
  ${EndIf}
  ; Окно выбора языка — не в тихом режиме (обновление `/S --updated` и CI) и не при сборке
  ; деинсталлятора: electron-builder вставляет customInit только в обычную ветку .onInit, поэтому
  ; displayLanguageSelector в electron-builder.yml выключен.
  ; В тихом режиме окна нет — язык берётся запомненный, иначе $LANGUAGE стал бы языком Windows и
  ; customInstall перезаписал бы им выбор человека.
  ${If} ${Silent}
    ReadRegStr $0 HKCU "Software\Cord" "InstallerLanguage"
    ${If} $0 != ""
      StrCpy $LANGUAGE $0
    ${EndIf}
  ${Else}
    !insertmacro MUI_LANGDLL_DISPLAY
  ${EndIf}
!macroend

; Деинсталлятор говорит на языке, выбранном при установке.
!macro customUnInit
  !insertmacro MUI_UNGETLANGUAGE
!macroend

!macro customInstall
  ; До 1.0.6 ярлык на рабочем столе ставила своя галочка (HKCU\Software\Cord\DesktopShortcut), а прежний
  ; деинсталлятор при обновлении его удаляет; electron-builder при обновлении ярлыки не пересоздаёт.
  ; Кто ярлык хотел, получает его обратно один раз — дальше им ведает electron-builder.
  ReadRegDWORD $CordLegacyShortcut HKCU "Software\Cord" "DesktopShortcut"
  ${If} $CordLegacyShortcut == 1
  ${AndIfNot} ${FileExists} "$newDesktopLink"
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    ; AUMID ярлыка = appId (R59): без него Windows не показывает уведомления Cord и не группирует окна.
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${EndIf}
  DeleteRegValue HKCU "Software\Cord" "DesktopShortcut"
  ; Язык мастера (R64): для следующего запуска установщика и для приложения (LCID → язык веба).
  !insertmacro MUI_LANGDLL_SAVELANGUAGE
  WriteRegStr HKCU "Software\Cord" "Language" "$LANGUAGE"
  ; Карточка «Установленные приложения»: издатель Cord, без ссылок. electron-builder пишет
  ; HelpLink/URLInfoAbout только из homepage/uninstallUrl*, которых нет; на всякий случай — убираем.
  DeleteRegValue SHCTX "${UNINSTALL_REGISTRY_KEY}" "HelpLink"
  DeleteRegValue SHCTX "${UNINSTALL_REGISTRY_KEY}" "URLInfoAbout"
  DeleteRegValue SHCTX "${UNINSTALL_REGISTRY_KEY}" "URLUpdateInfo"
  DeleteRegValue SHCTX "${UNINSTALL_REGISTRY_KEY}" "Readme"
  WriteRegStr SHCTX "${UNINSTALL_REGISTRY_KEY}" "Publisher" "Cord"
  WriteRegStr SHCTX "${UNINSTALL_REGISTRY_KEY}" "Comments" "$(CordComments)"
  ; Deep links cord:// для текущего пользователя.
  WriteRegStr HKCU "Software\Classes\cord" "" "URL:Cord"
  WriteRegStr HKCU "Software\Classes\cord" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\cord\DefaultIcon" "" "$INSTDIR\Cord.exe,0"
  WriteRegStr HKCU "Software\Classes\cord\shell\open\command" "" '"$INSTDIR\Cord.exe" "%1"'
!macroend

; Ярлыки удаляет сам electron-builder — и не трогает их при обновлении (`--keep-shortcuts`).
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\cord"
  ; Настройки (%LOCALAPPDATA%\Cord) остаются: deleteAppDataOnUninstall: false.
!macroend
