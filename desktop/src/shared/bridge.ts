/**
 * Мост v2 `window.cordDesktop` (ADR 0001 §3): типы, общие для main, preload и тестов.
 *
 * Веб проверяет флаги возможностей (`features`), а не номера версий; мажор протокола меняется
 * только при несовместимости. Копия контракта в ядре — `contracts/desktop-bridge.v2.schema.json`.
 */

export const PROTOCOL = { major: 2, minor: 0 } as const;

/** Что умеет эта сборка оболочки. Веб показывает понятный отказ там, где флага нет. */
export const FEATURES = [
  'hotkeys', // глобальные сочетания через globalShortcut (только нажатие, без фазы «отпустил»)
  'ptt', // cord-native, Raw Input: фаза «отпустил», любые клавиши без Ctrl/Alt, кнопки мыши Mouse3–Mouse5; событие hotkey {action, phase}
  'capture', // своё окно выбора источника в вебе: invoke('capture.sources'), invoke('capture.select') — до getDisplayMedia
  'capture.system-audio', // loopback всего звука системы (Windows), режим audio: 'system'
  'capture.app-audio', // cord-native, process loopback: audio: 'app' (звук приложения) и 'system-except-cord'; дорожка — элемент #cord-desktop-capture-audio, событие capture.audio
  'overlay', // окно поверх игр без инъекций
  'notify',
  // 'thumbar' и 'badge' (кнопки на миниатюре, значок поверх иконки) убраны в 1.0.11 (R138): без флагов
  // веб прячет их переключатели, а в ответе app.settings они остаются — всегда false.
  'progress',
  'attention',
  'deeplink',
  'servers',
  'update',
  'power',
  'app.settings', // переключатели раздела «Windows» в настройках веба: invoke('app.settings', патч), событие app.settings
  'tray', // значок в трее
  'sleep', // запрет сна во время встречи (powerSaveBlocker)
  'autostart', // запуск вместе с Windows
  'games', // cord-native: реестр игр (R62) — invoke('games.list' | 'games.set' | 'games.forget' | 'games.pick'), события games.changed, game.active
  'overlay.widget', // виджет говорящих в игре (R63): send('overlay.roster'), send('overlay.levels') — по порту мимо main, app.settings overlayCorner/Size/Names/Opacity/Toast, действие overlay.lock (Backquote)
  'mini', // мини-окно звонка (R93): send('mini.state'), событие mini.action {id}, app.settings mini
  'golive', // cord-native: «Показать игру» (R104) — событие golive {id, name}: начать показ окна игры
] as const;
export type Feature = (typeof FEATURES)[number];

/** Только в Windows: loopback-звук и автозапуск. */
const WINDOWS_ONLY: ReadonlySet<Feature> = new Set<Feature>(['capture.system-audio', 'autostart']);
/** Только с загруженным `cord-native` (utility-процесс жив и модуль на месте). */
const NATIVE_ONLY: ReadonlySet<Feature> = new Set<Feature>(['ptt', 'capture.app-audio', 'games', 'golive']);

/** Флаги этой машины: веб не показывает переключатель того, чего здесь нет. */
export function featuresFor(platform: NodeJS.Platform, native = false): Feature[] {
  return FEATURES.filter((feature) => (platform === 'win32' || !WINDOWS_ONLY.has(feature)) && (native || !NATIVE_ONLY.has(feature)));
}

/** Элемент на странице сервера, через который preload отдаёт вебу дорожку звука захвата (`srcObject`). */
export const CAPTURE_AUDIO_ELEMENT = 'cord-desktop-capture-audio';

/** Сообщения страницы оболочке (`send`). */
export const PAGE_MESSAGES = [
  'state',
  'call.state',
  'hotkeys.configure',
  'favorites.changed',
  'preferences.changed',
  'server.autoconnect',
  'servers.open',
  'close.ready',
  'update.check',
  'update.apply',
  'overlay.state',
  'notify',
  'attention',
  'progress',
  'badge', // с 1.0.11 (R138) значка поверх иконки нет и флага нет: число идёт только в «Чат · N» меню трея
  'capture.select',
  'overlay.roster', // {participants: [{id, name, avatar, muted}]} — кто в звонке для виджета в игре и мини-окна (R63, R93), ≤ 128 КиБ
  'mini.state', // {room, mic, camera, screen, unread, count, self} — что показывать в мини-окне звонка (R93)
] as const;
export type PageMessage = (typeof PAGE_MESSAGES)[number];

/** Запросы страницы с ответом (`invoke`). */
export const PAGE_CALLS = ['session.renew', 'update.status', 'capture.sources', 'capture.select', 'app.settings', 'games.list', 'games.set', 'games.forget', 'games.pick'] as const;

/**
 * Уровни голоса для виджета в игре и мини-окна (R63): страница шлёт их `send('overlay.levels', …)`, а
 * preload кладёт прямо в порты окон оболочки (`MessageChannelMain`), мимо main и без его проверки
 * размера: ≤ 30 раз в секунду, ≤ 25 записей `[id, ступень 0–4, уровень 0–1]`.
 */
export const LEVELS_MESSAGE = 'overlay.levels';
export const LEVELS_LIMIT = 25;
export type PageCall = (typeof PAGE_CALLS)[number];

/** Сообщения оболочки странице (`on`). */
export const HOST_MESSAGES = [
  'hotkey',
  'hotkeys.status',
  'navigate',
  'theme.changed',
  'preferences.changed',
  'settings.open',
  'favorite.settings',
  'favorites.changed',
  'profile.changed',
  'network.changed',
  'close-request',
  'update.status',
  'session.token',
  // 'thumbar' — нажатие кнопки на миниатюре — больше не шлётся (R138): кнопок нет, «Микрофон» трея идёт mini.action.
  'deeplink',
  'notification.action',
  'power',
  'capture.ended',
  'app.settings',
  'capture.audio', // {state: 'ready' | 'failed' | 'ended', mode, reason?} — звук приложения / системы кроме Cord (cord-native)
  'window.state', // {focused, visible} — окно в фокусе / видно (спрятано в трей, свёрнуто): уведомления только когда человек не смотрит (R59)
  'chat.open', // «Чат · N» в меню трея (R103): открыть чат встречи; веб без поддержки пропускает
  'games.changed', // {games, active} — реестр игр сменился (R62)
  'game.active', // {game: {exe, name, enabled, exclusive} | null} — игра, которая сейчас запущена (R62)
  'mini.action', // {id} — нажатие в мини-окне звонка (R93): mic, camera, screen, people, chat, settings, leave
  'golive', // {id, name} — «Показать игру» (R104): начать показ этого окна; оболочка уже дала странице жест
] as const;
export type HostMessage = (typeof HOST_MESSAGES)[number];

/**
 * Высота кнопок окна «— ⧉ ×» поверх страницы, DIP. 56 — высота шапки встречи и предвхода: звезда,
 * ссылка и «Поддержка» стоят с кнопками окна по одной середине (владелец после R122: шапка 56, а не
 * полоса 36). Странице высота уходит в `bootstrap.titlebarHeight` — веб считает по ней поле шапок.
 * Окно — `main/windows/main.ts` (`titleBarOverlay`).
 */
export const TITLEBAR_HEIGHT = 56;

export interface Bootstrap {
  /** Секрет профиля для этого origin — 43 символа base64url, как писал WinUI. */
  profile: string;
  theme: 'light' | 'dark' | 'system';
  /** Язык, выбранный в установщике (R64); null — веб выбирает сам. Применяется один раз на origin. */
  language: string | null;
  showPing: boolean;
  notificationSounds: boolean;
  autoConnect: boolean;
  /** Высота кнопок окна «— ⧉ ×» в DIP (`TITLEBAR_HEIGHT`, с 1.0.10); без неё веб считает 36. */
  titlebarHeight: number;
}

export interface CordDesktopApi {
  readonly protocol: { readonly major: 2; readonly minor: number };
  readonly features: readonly Feature[];
  readonly app: { readonly version: string; readonly arch: 'x64' | 'arm64' | 'ia32' };
  readonly bootstrap: Bootstrap;
  send(type: PageMessage, payload?: object): void;
  invoke(method: PageCall, payload?: object): Promise<unknown>;
  on(type: HostMessage, listener: (data: Record<string, unknown>) => void): () => void;
}

/** Каналы IPC между preload и main. Страница их не видит: наружу торчат только три функции. */
export const IPC = {
  bootstrap: 'cord:bootstrap',
  send: 'cord:send',
  invoke: 'cord:invoke',
  host: 'cord:host',
  shellCall: 'cord:shell:call',
  shellEvent: 'cord:shell:event',
  /** main → preload: порт PCM захвата (`postMessage` с портом); preload → main: `{type: 'stopped'}`. */
  captureAudio: 'cord:capture-audio',
  /** main → preload страницы и окна оболочки: порт уровней голоса (`{target}` и порт), R63. */
  levelsPort: 'cord:levels-port',
} as const;

/** Больше одного сообщения страницы не бывает (как `BridgeProtocol.Read`). */
export const MESSAGE_LIMIT = 16384;
/** `overlay.roster` несёт аватары (≤ 4 КиБ × 25) — у него свой предел. */
export const ROSTER_LIMIT = 131072;
export const AVATAR_LIMIT = 4096;
