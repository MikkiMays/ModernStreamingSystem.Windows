/**
 * Свои тексты оболочки на восьми языках Cord (X1): меню трея и его диалоги (R103), подсказка «Cord
 * работает в трее» (R57), кнопки на миниатюре и подписи значка поверх иконки (T53). Как и тексты
 * установщика (`build/installer.nsh`, `LangString` на язык), — свой маленький каталог: эти строки
 * нужны, когда страницы ещё нет или окно спрятано. Общие слова — те же, что в каталоге веба
 * (`web/src/i18n/locales`, `GLOSSARY.md`): «Новая встреча», «Настройки», «Чат», «Микрофон».
 * Язык — `shellLanguage` (`language.ts`).
 */
import type { Language } from './language';

export interface ShellText {
  /** Состояние: во встрече — с названием через «·». */
  statusInCall: string;
  statusIdle: string;
  /** Хвост подсказки значка, со строчной. */
  micOffNote: string;
  returnToMeeting: string;
  newMeeting: string;
  chat: string;
  microphone: string;
  notifications: string;
  settings: string;
  quit: string;
  /** «Выйти из Cord» во встрече — спросить. */
  quitTitle: string;
  quitDetail: string;
  quitConfirm: string;
  /** «Новая встреча» во встрече — спросить: веб выйдет из текущей. */
  newTitle: string;
  newDetail: string;
  newConfirm: string;
  stay: string;
  /** Первое прятание окна в трей (R57). */
  hintTitle: string;
  hintBody: string;
  /** Кнопки на миниатюре. */
  micMute: string;
  micUnmute: string;
  cameraOff: string;
  cameraOn: string;
  leave: string;
  /** Подписи значка поверх иконки; `{count}` — число. */
  muted: string;
  unread: string;
}

const NBSP = ' ';

export const SHELL_TEXT: Readonly<Record<Language, ShellText>> = {
  ru: {
    statusInCall: 'Во встрече',
    statusIdle: 'Не во встрече',
    micOffNote: 'микрофон выключен',
    returnToMeeting: 'Вернуться во встречу',
    newMeeting: 'Новая встреча',
    chat: 'Чат',
    microphone: 'Микрофон',
    notifications: 'Уведомления',
    settings: 'Настройки',
    quit: 'Выйти из Cord',
    quitTitle: 'Выйти из Cord?',
    quitDetail: 'Вы выйдете из встречи.',
    quitConfirm: 'Выйти',
    newTitle: 'Начать новую встречу?',
    newDetail: 'Вы выйдете из текущей встречи.',
    newConfirm: 'Начать',
    stay: 'Остаться',
    hintTitle: 'Cord работает в трее',
    hintBody: 'Встреча продолжается. Открыть — щелчком по значку, выйти — в его меню.',
    micMute: 'Выключить микрофон',
    micUnmute: 'Включить микрофон',
    cameraOff: 'Выключить камеру',
    cameraOn: 'Включить камеру',
    leave: 'Выйти из встречи',
    muted: 'Микрофон выключен',
    unread: 'Непрочитанные: {count}',
  },
  en: {
    statusInCall: 'In a meeting',
    statusIdle: 'Not in a meeting',
    micOffNote: 'microphone off',
    returnToMeeting: 'Return to meeting',
    newMeeting: 'New meeting',
    chat: 'Chat',
    microphone: 'Microphone',
    notifications: 'Notifications',
    settings: 'Settings',
    quit: 'Quit Cord',
    quitTitle: 'Quit Cord?',
    quitDetail: "You'll leave the meeting.",
    quitConfirm: 'Quit',
    newTitle: 'Start a new meeting?',
    newDetail: "You'll leave the current meeting.",
    newConfirm: 'Start',
    stay: 'Stay',
    hintTitle: 'Cord is still running in the tray',
    hintBody: 'Your meeting goes on. Click the icon to open Cord; quit from its menu.',
    micMute: 'Mute microphone',
    micUnmute: 'Unmute microphone',
    cameraOff: 'Turn off camera',
    cameraOn: 'Turn on camera',
    leave: 'Leave meeting',
    muted: 'Microphone off',
    unread: 'Unread: {count}',
  },
  de: {
    statusInCall: 'Im Meeting',
    statusIdle: 'Nicht im Meeting',
    micOffNote: 'Mikrofon aus',
    returnToMeeting: 'Zum Meeting zurückkehren',
    newMeeting: 'Neues Meeting',
    chat: 'Chat',
    microphone: 'Mikrofon',
    notifications: 'Benachrichtigungen',
    settings: 'Einstellungen',
    quit: 'Cord beenden',
    quitTitle: 'Cord beenden?',
    quitDetail: 'Du verlässt das Meeting.',
    quitConfirm: 'Beenden',
    newTitle: 'Neues Meeting starten?',
    newDetail: 'Du verlässt das aktuelle Meeting.',
    newConfirm: 'Starten',
    stay: 'Bleiben',
    hintTitle: 'Cord läuft im Infobereich weiter',
    hintBody: 'Das Meeting geht weiter. Ein Klick auf das Symbol öffnet Cord, beenden kannst du es über sein Menü.',
    micMute: 'Mikrofon stummschalten',
    micUnmute: 'Mikrofon einschalten',
    cameraOff: 'Kamera ausschalten',
    cameraOn: 'Kamera einschalten',
    leave: 'Meeting verlassen',
    muted: 'Mikrofon aus',
    unread: 'Ungelesen: {count}',
  },
  es: {
    statusInCall: 'En una reunión',
    statusIdle: 'Sin reunión',
    micOffNote: 'micrófono desactivado',
    returnToMeeting: 'Volver a la reunión',
    newMeeting: 'Nueva reunión',
    chat: 'Chat',
    microphone: 'Micrófono',
    notifications: 'Notificaciones',
    settings: 'Ajustes',
    quit: 'Salir de Cord',
    quitTitle: '¿Salir de Cord?',
    quitDetail: 'Saldrás de la reunión.',
    quitConfirm: 'Salir',
    newTitle: '¿Empezar una reunión nueva?',
    newDetail: 'Saldrás de la reunión actual.',
    newConfirm: 'Empezar',
    stay: 'Quedarme',
    hintTitle: 'Cord sigue en la bandeja del sistema',
    hintBody: 'La reunión continúa. Haz clic en el icono para abrir Cord; para salir, usa su menú.',
    micMute: 'Silenciar el micrófono',
    micUnmute: 'Activar el micrófono',
    cameraOff: 'Apagar la cámara',
    cameraOn: 'Encender la cámara',
    leave: 'Salir de la reunión',
    muted: 'Micrófono desactivado',
    unread: 'Sin leer: {count}',
  },
  fr: {
    statusInCall: 'En réunion',
    statusIdle: 'Pas en réunion',
    micOffNote: 'micro coupé',
    returnToMeeting: 'Revenir à la réunion',
    newMeeting: 'Nouvelle réunion',
    chat: 'Chat',
    microphone: 'Micro',
    notifications: 'Notifications',
    settings: 'Paramètres',
    quit: 'Quitter Cord',
    quitTitle: `Quitter Cord${NBSP}?`,
    quitDetail: 'Vous quitterez la réunion.',
    quitConfirm: 'Quitter',
    newTitle: `Démarrer une nouvelle réunion${NBSP}?`,
    newDetail: 'Vous quitterez la réunion en cours.',
    newConfirm: 'Démarrer',
    stay: 'Rester',
    hintTitle: 'Cord reste dans la zone de notification',
    hintBody: `La réunion continue. Cliquez sur l'icône pour ouvrir Cord${NBSP}; pour quitter, utilisez son menu.`,
    micMute: 'Couper le micro',
    micUnmute: 'Activer le micro',
    cameraOff: 'Désactiver la caméra',
    cameraOn: 'Activer la caméra',
    leave: 'Quitter la réunion',
    muted: 'Micro coupé',
    unread: `Non lus${NBSP}: {count}`,
  },
  it: {
    statusInCall: 'In riunione',
    statusIdle: 'Non in riunione',
    micOffNote: 'microfono disattivato',
    returnToMeeting: 'Torna alla riunione',
    newMeeting: 'Nuova riunione',
    chat: 'Chat',
    microphone: 'Microfono',
    notifications: 'Notifiche',
    settings: 'Impostazioni',
    quit: 'Esci da Cord',
    quitTitle: 'Uscire da Cord?',
    quitDetail: 'Uscirai dalla riunione.',
    quitConfirm: 'Esci',
    newTitle: 'Avviare una nuova riunione?',
    newDetail: 'Uscirai dalla riunione in corso.',
    newConfirm: 'Avvia',
    stay: 'Resta qui',
    hintTitle: "Cord resta nell'area di notifica",
    hintBody: "La riunione continua. Fai clic sull'icona per aprire Cord; per uscire usa il suo menu.",
    micMute: 'Disattiva il microfono',
    micUnmute: 'Attiva il microfono',
    cameraOff: 'Disattiva la videocamera',
    cameraOn: 'Attiva la videocamera',
    leave: 'Esci dalla riunione',
    muted: 'Microfono disattivato',
    unread: 'Non letti: {count}',
  },
  'pt-BR': {
    statusInCall: 'Em uma reunião',
    statusIdle: 'Fora de reunião',
    micOffNote: 'microfone desligado',
    returnToMeeting: 'Voltar para a reunião',
    newMeeting: 'Nova reunião',
    chat: 'Chat',
    microphone: 'Microfone',
    notifications: 'Notificações',
    settings: 'Configurações',
    quit: 'Sair do Cord',
    quitTitle: 'Sair do Cord?',
    quitDetail: 'Você vai sair da reunião.',
    quitConfirm: 'Sair',
    newTitle: 'Começar uma nova reunião?',
    newDetail: 'Você vai sair da reunião atual.',
    newConfirm: 'Começar',
    stay: 'Ficar',
    hintTitle: 'O Cord continua na bandeja do sistema',
    hintBody: 'A reunião continua. Clique no ícone para abrir o Cord; para sair, use o menu dele.',
    micMute: 'Desligar o microfone',
    micUnmute: 'Ligar o microfone',
    cameraOff: 'Desligar a câmera',
    cameraOn: 'Ligar a câmera',
    leave: 'Sair da reunião',
    muted: 'Microfone desligado',
    unread: 'Não lidas: {count}',
  },
  'zh-Hans': {
    statusInCall: '会议中',
    statusIdle: '未在会议中',
    micOffNote: '麦克风已关闭',
    returnToMeeting: '返回会议',
    newMeeting: '新建会议',
    chat: '聊天',
    microphone: '麦克风',
    notifications: '通知',
    settings: '设置',
    quit: '退出 Cord',
    quitTitle: '退出 Cord？',
    quitDetail: '你将离开会议。',
    quitConfirm: '退出',
    newTitle: '开始新会议？',
    newDetail: '你将离开当前会议。',
    newConfirm: '开始',
    stay: '留在这里',
    hintTitle: 'Cord 仍在托盘中运行',
    hintBody: '会议仍在进行。点击图标打开 Cord，从图标菜单退出。',
    micMute: '关闭麦克风',
    micUnmute: '开启麦克风',
    cameraOff: '关闭摄像头',
    cameraOn: '开启摄像头',
    leave: '离开会议',
    muted: '麦克风已关闭',
    unread: '未读：{count}',
  },
};

export function shellText(language: Language): ShellText {
  return SHELL_TEXT[language] ?? SHELL_TEXT.ru;
}
