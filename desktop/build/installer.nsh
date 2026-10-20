; Cord — свои страницы мастера NSIS (electron-builder `include`).
; Ярлык на рабочем столе (T15): галочка видна и включена по умолчанию; выбор запоминается в HKCU
; и учитывается при тихом обновлении. Ни одной ссылки — ни в тексте, ни в карточке Windows.
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
; electron-builder подключает MUI2 позже этого файла, а функция страницы ярлыка ниже уже зовёт
; MUI_HEADER_TEXT: без раннего подключения makensis не знает макроса. MUI2 защищён от повторного
; подключения, а его настройки читаются при вставке страниц, так что порядок им не мешает.
!include "MUI2.nsh"

Var CordDesktopShortcut
Var CordDesktopCheckbox

; Тексты своих страниц на языках Cord (T03, T54, E14-B). Язык мастера выбирает NSIS сам — по языку
; Windows из `installerLanguages` (electron-builder.yml), иначе первый в списке, английский; тот же язык
; Windows возьмёт и приложение. LangString — здесь, а не на верхнем уровне файла: electron-builder вставляет
; customHeader после MUI_LANGUAGE, и только тогда известны ${LANG_*}. $_CLICK — «Нажмите „Далее“…» языка
; мастера, с точным именем его кнопки.
!macro customHeader
  LangString CordWelcomeText ${LANG_RUSSIAN} "Видеовстречи, демонстрация экрана и совместный просмотр.$\r$\n$\r$\nМастер установит Cord для текущего пользователя Windows — без прав администратора. Приложение проверяет обновления само при каждом запуске и ставит их тихо.$\r$\n$\r$\n$_CLICK"
  LangString CordWelcomeText ${LANG_ENGLISH} "Video meetings, screen sharing, and watching together.$\r$\n$\r$\nThis wizard installs Cord for the current Windows user — no administrator rights needed. The app checks for updates every time it starts and installs them quietly.$\r$\n$\r$\n$_CLICK"
  LangString CordWelcomeText ${LANG_SPANISHINTERNATIONAL} "Videorreuniones, pantalla compartida y contenido para ver juntos.$\r$\n$\r$\nEl asistente instalará Cord para el usuario actual de Windows, sin permisos de administrador. La aplicación busca actualizaciones cada vez que se inicia y las instala en segundo plano.$\r$\n$\r$\n$_CLICK"
  LangString CordWelcomeText ${LANG_FRENCH} "Réunions vidéo, partage d'écran et visionnage ensemble.$\r$\n$\r$\nCet assistant installe Cord pour l'utilisateur Windows actuel, sans droits d'administrateur. L'application recherche les mises à jour à chaque démarrage et les installe en arrière-plan.$\r$\n$\r$\n$_CLICK"
  LangString CordWelcomeText ${LANG_ITALIAN} "Videoriunioni, condivisione dello schermo e visione insieme.$\r$\n$\r$\nLa procedura installa Cord per l'utente Windows corrente, senza diritti di amministratore. L'app controlla gli aggiornamenti a ogni avvio e li installa in background.$\r$\n$\r$\n$_CLICK"
  LangString CordWelcomeText ${LANG_SIMPCHINESE} "视频会议、屏幕共享和一起看。$\r$\n$\r$\n此向导将为当前 Windows 用户安装 Cord，无需管理员权限。应用每次启动时都会检查更新，并在后台静默安装。$\r$\n$\r$\n$_CLICK"
  LangString CordWelcomeText ${LANG_GERMAN} "Videomeetings, Bildschirmfreigabe und gemeinsames Anschauen.$\r$\n$\r$\nDer Assistent installiert Cord für den aktuellen Windows-Benutzer – ohne Administratorrechte. Die App sucht bei jedem Start nach Updates und installiert sie im Hintergrund.$\r$\n$\r$\n$_CLICK"
  LangString CordWelcomeText ${LANG_PORTUGUESEBR} "Videochamadas, compartilhamento de tela e sessões para assistir juntos.$\r$\n$\r$\nO assistente instala o Cord para o usuário atual do Windows, sem permissão de administrador. O app procura atualizações sempre que é aberto e as instala em segundo plano.$\r$\n$\r$\n$_CLICK"

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

  ; Описание в карточке «Установленные приложения» — на языке, на котором ставили.
  LangString CordComments ${LANG_RUSSIAN} "Видеовстречи, демонстрация экрана и совместный просмотр"
  LangString CordComments ${LANG_ENGLISH} "Video meetings, screen sharing, and watching together"
  LangString CordComments ${LANG_SPANISHINTERNATIONAL} "Videorreuniones, pantalla compartida y contenido para ver juntos"
  LangString CordComments ${LANG_FRENCH} "Réunions vidéo, partage d'écran et visionnage ensemble"
  LangString CordComments ${LANG_ITALIAN} "Videoriunioni, condivisione dello schermo e visione insieme"
  LangString CordComments ${LANG_SIMPCHINESE} "视频会议、屏幕共享和一起看"
  LangString CordComments ${LANG_GERMAN} "Videomeetings, Bildschirmfreigabe und gemeinsames Anschauen"
  LangString CordComments ${LANG_PORTUGUESEBR} "Videochamadas, compartilhamento de tela e sessões para assistir juntos"
!macroend

; Человеческое описание Cord как продукта на странице приветствия.
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Cord"
  !define MUI_WELCOMEPAGE_TEXT "$(CordWelcomeText)"
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customPageAfterChangeDir
  Page custom CordShortcutPageCreate CordShortcutPageLeave
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
