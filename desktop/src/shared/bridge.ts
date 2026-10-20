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
  'capture', // своё окно выбора источника в вебе: invoke('capture.sources'), invoke('capture.select') — до getDisplayMedia
  'capture.system-audio', // loopback всего звука системы (Windows); звук приложения — ждёт cord-native
  'overlay', // окно поверх игр без инъекций
  'notify',
  'thumbar',
  'badge',
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
] as const;
export type Feature = (typeof FEATURES)[number];

/** Только в Windows: loopback-звук, кнопки на миниатюре и значок поверх иконки (API панели задач), автозапуск. */
const WINDOWS_ONLY: ReadonlySet<Feature> = new Set<Feature>(['capture.system-audio', 'thumbar', 'badge', 'autostart']);

/** Флаги этой машины: веб не показывает переключатель того, чего здесь нет. */
export function featuresFor(platform: NodeJS.Platform): Feature[] {
  return FEATURES.filter((feature) => platform === 'win32' || !WINDOWS_ONLY.has(feature));
}

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
  'badge',
  'capture.select',
] as const;
export type PageMessage = (typeof PAGE_MESSAGES)[number];

/** Запросы страницы с ответом (`invoke`). */
export const PAGE_CALLS = ['session.renew', 'update.status', 'capture.sources', 'capture.select', 'app.settings'] as const;
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
  'thumbar',
  'deeplink',
  'notification.action',
  'power',
  'capture.ended',
  'app.settings',
] as const;
export type HostMessage = (typeof HOST_MESSAGES)[number];

export interface Bootstrap {
  /** Секрет профиля для этого origin — 43 символа base64url, как писал WinUI. */
  profile: string;
  theme: 'light' | 'dark' | 'system';
  showPing: boolean;
  notificationSounds: boolean;
  autoConnect: boolean;
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
} as const;

/** Больше одного сообщения страницы не бывает (как `BridgeProtocol.Read`). */
export const MESSAGE_LIMIT = 16384;
export const AVATAR_LIMIT = 4096;
