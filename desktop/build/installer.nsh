; Cord — свои страницы мастера NSIS (electron-builder `include`; ADR 0001 §6, T54, T15, П15, R59, R64).
; Ярлык на рабочем столе (T15): галочка видна и включена по умолчанию; выбор запоминается в HKCU
; и учитывается при тихом обновлении. Ни одной ссылки — ни в тексте, ни в карточке Windows.
; Язык мастера (R64): окно выбора при запуске (не в тихом режиме), выбор запоминается в
; HKCU\Software\Cord\InstallerLanguage, LCID уходит приложению в HKCU\Software\Cord\Language —
; оболочка читает его при первом запуске и отдаёт вебу (`Bootstrap.language`).
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
; electron-builder подключает MUI2 позже этого файла, а функция страницы ярлыка ниже уже зовёт
; MUI_HEADER_TEXT: без раннего подключения makensis не знает макроса. MUI2 защищён от повторного
; подключения, а его настройки читаются при вставке страниц, так что порядок им не мешает.
!include "MUI2.nsh"

Var CordDesktopShortcut
Var CordDesktopCheckbox

; Тексты своих страниц на языках Cord (T03, T54, E14-B, R64). LangString — здесь, а не на верхнем
; уровне файла: electron-builder вставляет customHeader после MUI_LANGUAGE, и только тогда известны
; ${LANG_*}. Кавычки — по правилам каждого языка («» / “ ” / „“ / « »), без прямых "…": последняя
; строка приветствия называет кнопку так, как её зовёт сам мастер на этом языке.
!macro customHeader
  ; Мастер знает свой DPI: на 125–200 % диалог и картинки не мылятся (картинки — в двойном размере,
  ; scripts/make-icons.mjs: боковая 328×628, шапка 300×114; MUI2 растягивает их под масштаб).
  ManifestDPIAware true

  ; Окно выбора языка: запомненный выбор — по умолчанию, показывается всегда (кроме тихого режима,
  ; см. customInit); деинсталлятор берёт тот же язык из реестра (customUnInit).
  !define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
  !define MUI_LANGDLL_REGISTRY_KEY "Software\Cord"
  !define MUI_LANGDLL_REGISTRY_VALUENAME "InstallerLanguage"
  !define MUI_LANGDLL_ALWAYSSHOW
  !define MUI_LANGDLL_WINDOWTITLE "Cord"
  !define MUI_LANGDLL_INFO "Выберите язык установки · Choose the installer language"

  LangString CordWelcomeTitle ${LANG_RUSSIAN} "Установка Cord"
  LangString CordWelcomeTitle ${LANG_ENGLISH} "Set up Cord"
  LangString CordWelcomeTitle ${LANG_SPANISHINTERNATIONAL} "Instalación de Cord"
  LangString CordWelcomeTitle ${LANG_FRENCH} "Installation de Cord"
  LangString CordWelcomeTitle ${LANG_ITALIAN} "Installazione di Cord"
  LangString CordWelcomeTitle ${LANG_SIMPCHINESE} "安装 Cord"
  LangString CordWelcomeTitle ${LANG_GERMAN} "Cord installieren"
  LangString CordWelcomeTitle ${LANG_PORTUGUESEBR} "Instalação do Cord"

  LangString CordWelcomeText ${LANG_RUSSIAN} "Видеовстречи, демонстрация экрана и совместный просмотр.$\r$\n$\r$\nCord устанавливается для текущего пользователя Windows — права администратора не нужны. Обновления приходят сами при запуске приложения.$\r$\n$\r$\nЧтобы продолжить, нажмите «Далее»."
  LangString CordWelcomeText ${LANG_ENGLISH} "Video meetings, screen sharing and watching together.$\r$\n$\r$\nCord installs for the current Windows user — no administrator rights needed. Updates arrive on their own when the app starts.$\r$\n$\r$\nClick Next to continue."
  LangString CordWelcomeText ${LANG_SPANISHINTERNATIONAL} "Videorreuniones, pantalla compartida y contenido para ver juntos.$\r$\n$\r$\nCord se instala para el usuario actual de Windows: no hacen falta permisos de administrador. Las actualizaciones llegan solas al iniciar la aplicación.$\r$\n$\r$\nPulse «Siguiente» para continuar."
  LangString CordWelcomeText ${LANG_FRENCH} "Réunions vidéo, partage d'écran et visionnage ensemble.$\r$\n$\r$\nCord s'installe pour l'utilisateur Windows actuel, sans droits d'administrateur. Les mises à jour arrivent d'elles-mêmes au lancement de l'application.$\r$\n$\r$\nCliquez sur « Suivant » pour continuer."
  LangString CordWelcomeText ${LANG_ITALIAN} "Videoriunioni, condivisione dello schermo e visione insieme.$\r$\n$\r$\nCord si installa per l'utente Windows corrente, senza diritti di amministratore. Gli aggiornamenti arrivano da soli all'avvio dell'app.$\r$\n$\r$\nFai clic su “Avanti” per continuare."
  LangString CordWelcomeText ${LANG_SIMPCHINESE} "视频会议、屏幕共享和一起观看。$\r$\n$\r$\nCord 将为当前 Windows 用户安装，无需管理员权限。更新会在应用启动时自动完成。$\r$\n$\r$\n点击“下一步”继续。"
  LangString CordWelcomeText ${LANG_GERMAN} "Videomeetings, Bildschirmfreigabe und gemeinsames Anschauen.$\r$\n$\r$\nCord wird für den aktuellen Windows-Benutzer installiert – ohne Administratorrechte. Updates kommen von selbst beim Start der App.$\r$\n$\r$\nKlicken Sie auf „Weiter“, um fortzufahren."
  LangString CordWelcomeText ${LANG_PORTUGUESEBR} "Videochamadas, compartilhamento de tela e sessões para assistir juntos.$\r$\n$\r$\nO Cord é instalado para o usuário atual do Windows, sem permissão de administrador. As atualizações chegam sozinhas ao abrir o aplicativo.$\r$\n$\r$\nClique em “Avançar” para continuar."

  LangString CordShortcutsTitle ${LANG_RUSSIAN} "Ярлыки"
  LangString CordShortcutsTitle ${LANG_ENGLISH} "Shortcuts"
  LangString CordShortcutsTitle ${LANG_SPANISHINTERNATIONAL} "Accesos directos"
  LangString CordShortcutsTitle ${LANG_FRENCH} "Raccourcis"
  LangString CordShortcutsTitle ${LANG_ITALIAN} "Collegamenti"
  LangString CordShortcutsTitle ${LANG_SIMPCHINESE} "快捷方式"
  LangString CordShortcutsTitle ${LANG_GERMAN} "Verknüpfungen"
  LangString CordShortcutsTitle ${LANG_PORTUGUESEBR} "Atalhos"

  LangString CordShortcutsSubtitle ${LANG_RUSSIAN} "Где показывать Cord"
  LangString CordShortcutsSubtitle ${LANG_ENGLISH} "Where to show Cord"
  LangString CordShortcutsSubtitle ${LANG_SPANISHINTERNATIONAL} "Dónde mostrar Cord"
  LangString CordShortcutsSubtitle ${LANG_FRENCH} "Où afficher Cord"
  LangString CordShortcutsSubtitle ${LANG_ITALIAN} "Dove mostrare Cord"
  LangString CordShortcutsSubtitle ${LANG_SIMPCHINESE} "在哪里显示 Cord"
  LangString CordShortcutsSubtitle ${LANG_GERMAN} "Wo Cord angezeigt wird"
  LangString CordShortcutsSubtitle ${LANG_PORTUGUESEBR} "Onde mostrar o Cord"

  LangString CordDesktopShortcutLabel ${LANG_RUSSIAN} "Создать ярлык на рабочем столе"
  LangString CordDesktopShortcutLabel ${LANG_ENGLISH} "Create a desktop shortcut"
  LangString CordDesktopShortcutLabel ${LANG_SPANISHINTERNATIONAL} "Crear un acceso directo en el escritorio"
  LangString CordDesktopShortcutLabel ${LANG_FRENCH} "Créer un raccourci sur le Bureau"
  LangString CordDesktopShortcutLabel ${LANG_ITALIAN} "Crea un collegamento sul desktop"
  LangString CordDesktopShortcutLabel ${LANG_SIMPCHINESE} "创建桌面快捷方式"
  LangString CordDesktopShortcutLabel ${LANG_GERMAN} "Verknüpfung auf dem Desktop erstellen"
  LangString CordDesktopShortcutLabel ${LANG_PORTUGUESEBR} "Criar um atalho na área de trabalho"

  LangString CordFinishTitle ${LANG_RUSSIAN} "Cord установлен"
  LangString CordFinishTitle ${LANG_ENGLISH} "Cord is installed"
  LangString CordFinishTitle ${LANG_SPANISHINTERNATIONAL} "Cord está instalado"
  LangString CordFinishTitle ${LANG_FRENCH} "Cord est installé"
  LangString CordFinishTitle ${LANG_ITALIAN} "Cord è installato"
  LangString CordFinishTitle ${LANG_SIMPCHINESE} "Cord 已安装"
  LangString CordFinishTitle ${LANG_GERMAN} "Cord ist installiert"
  LangString CordFinishTitle ${LANG_PORTUGUESEBR} "O Cord está instalado"

  LangString CordFinishText ${LANG_RUSSIAN} "Всё готово. Cord можно открыть прямо сейчас — обновления он проверит сам при запуске."
  LangString CordFinishText ${LANG_ENGLISH} "All set. You can open Cord right away — it checks for updates on every start."
  LangString CordFinishText ${LANG_SPANISHINTERNATIONAL} "Todo listo. Puede abrir Cord ahora mismo: comprobará las actualizaciones en cada inicio."
  LangString CordFinishText ${LANG_FRENCH} "Tout est prêt. Vous pouvez ouvrir Cord dès maintenant : il vérifie les mises à jour à chaque démarrage."
  LangString CordFinishText ${LANG_ITALIAN} "Tutto pronto. Puoi aprire Cord subito: controlla gli aggiornamenti a ogni avvio."
  LangString CordFinishText ${LANG_SIMPCHINESE} "一切就绪。现在就可以打开 Cord，每次启动时它会自动检查更新。"
  LangString CordFinishText ${LANG_GERMAN} "Alles bereit. Sie können Cord sofort öffnen – es prüft bei jedem Start auf Updates."
  LangString CordFinishText ${LANG_PORTUGUESEBR} "Tudo pronto. Você já pode abrir o Cord: ele verifica atualizações a cada inicialização."

  LangString CordRunLabel ${LANG_RUSSIAN} "Запустить Cord"
  LangString CordRunLabel ${LANG_ENGLISH} "Launch Cord"
  LangString CordRunLabel ${LANG_SPANISHINTERNATIONAL} "Abrir Cord"
  LangString CordRunLabel ${LANG_FRENCH} "Lancer Cord"
  LangString CordRunLabel ${LANG_ITALIAN} "Avvia Cord"
  LangString CordRunLabel ${LANG_SIMPCHINESE} "启动 Cord"
  LangString CordRunLabel ${LANG_GERMAN} "Cord starten"
  LangString CordRunLabel ${LANG_PORTUGUESEBR} "Abrir o Cord"

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

; Окно выбора языка — в .onInit после проверки «один экземпляр». Не в тихом режиме (обновление
; `/S --updated` и CI) и не при сборке деинсталлятора: electron-builder вставляет customInit только в
; обычную ветку .onInit, поэтому displayLanguageSelector в electron-builder.yml выключен.
!macro customInit
  ${IfNot} ${Silent}
    !insertmacro MUI_LANGDLL_DISPLAY
  ${EndIf}
!macroend

; Деинсталлятор говорит на языке, выбранном при установке.
!macro customUnInit
  !insertmacro MUI_UNGETLANGUAGE
!macroend

; Человеческое описание Cord как продукта на странице приветствия.
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "$(CordWelcomeTitle)"
  !define MUI_WELCOMEPAGE_TITLE_3LINES
  !define MUI_WELCOMEPAGE_TEXT "$(CordWelcomeText)"
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customPageAfterChangeDir
  Page custom CordShortcutPageCreate CordShortcutPageLeave
!macroend

; Финиш: свой заголовок и текст; галочка «Запустить Cord» — тот же StartApp, что у electron-builder
; (ExecShellAsUser ярлыка, `--updated` при обновлении).
!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
    !define MUI_FINISHPAGE_RUN_TEXT "$(CordRunLabel)"
  !endif
  !define MUI_FINISHPAGE_TITLE "$(CordFinishTitle)"
  !define MUI_FINISHPAGE_TITLE_3LINES
  !define MUI_FINISHPAGE_TEXT "$(CordFinishText)"
  !insertmacro MUI_PAGE_FINISH
!macroend

Function CordShortcutPageCreate
  ${If} ${Silent}
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "$(CordShortcutsTitle)" "$(CordShortcutsSubtitle)"
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
  ${NSD_CreateCheckbox} 0 20u 100% 12u "$(CordDesktopShortcutLabel)"
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
    ; AUMID ярлыка = appId (R59): без него Windows не показывает уведомления Cord и не группирует окна.
    WinShell::SetLnkAUMI "$DESKTOP\Cord.lnk" "${APP_ID}"
  ${Else}
    Delete "$DESKTOP\Cord.lnk"
  ${EndIf}
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

!macro customUnInstall
  Delete "$DESKTOP\Cord.lnk"
  DeleteRegKey HKCU "Software\Classes\cord"
  ; Настройки (%LOCALAPPDATA%\Cord) остаются: deleteAppDataOnUninstall: false.
!macroend
