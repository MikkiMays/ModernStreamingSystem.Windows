/**
 * Переключатели «мягкого взаимодействия с Windows» (T53, ADR 0001 §4.4) — раздел «Windows» в
 * настройках веба (E03). Веб читает и меняет их запросом `invoke('app.settings', патч)`; оболочка
 * сама меняет `overlay` клавишей `overlay.toggle` и рассказывает об этом событием `app.settings`.
 *
 * По умолчанию (ADR §4.4): трей, кнопки на миниатюре, значок поверх иконки, мигание, запрет сна,
 * оверлей (R61) и уведомления — включены; автозапуск — выключен. Уведомления переключаются и из меню
 * трея (R103) — тогда оболочка рассказывает вебу событием `app.settings`, как с клавишей оверлея. Здесь нет Electron: решения проверяются тестами,
 * `tray.ts` и `index.ts` только исполняют их.
 */
import type { Settings } from './settings';

export interface AppSettings {
  /** Значок в трее: открыть, микрофон, выйти. */
  tray: boolean;
  /** Кнопки на миниатюре в панели задач во время встречи: микрофон, камера, завершить. */
  thumbar: boolean;
  /** Значок поверх иконки: микрофон во встрече, непрочитанное вне её. */
  badge: boolean;
  /** Мигание кнопки окна при упоминании, если окно не в фокусе. */
  flash: boolean;
  /** Не давать компьютеру засыпать во время встречи и показа экрана. */
  sleepBlocker: boolean;
  /** Оверлей в играх во время встречи. */
  overlay: boolean;
  /** Запуск вместе с Windows (свёрнутым). */
  autostart: boolean;
  /** Уведомления Windows о том, что во встрече (R59); выключены — `notify` не показывается. */
  notifications: boolean;
}

export const APP_SETTING_KEYS = ['tray', 'thumbar', 'badge', 'flash', 'sleepBlocker', 'overlay', 'autostart', 'notifications'] as const satisfies readonly (keyof AppSettings)[];

type Stored = Pick<Settings, 'tray' | 'thumbar' | 'badge' | 'flash' | 'sleepBlocker' | 'overlayEnabled' | 'autostart' | 'notifications'>;

/** Значения для веба из настроек оболочки. */
export function appSettingsOf(settings: Stored): AppSettings {
  return {
    tray: settings.tray,
    thumbar: settings.thumbar,
    badge: settings.badge,
    flash: settings.flash,
    sleepBlocker: settings.sleepBlocker,
    overlay: settings.overlayEnabled,
    autostart: settings.autostart,
    notifications: settings.notifications,
  };
}

/** Патч от веба → патч настроек оболочки. */
export function settingsPatchOf(patch: Partial<AppSettings>): Partial<Stored> {
  const { overlay, ...rest } = patch;
  return { ...rest, ...(overlay !== undefined ? { overlayEnabled: overlay } : {}) };
}

/**
 * Патч из `invoke('app.settings', …)`: только известные имена и только `true`/`false`. Пустой —
 * просто чтение. Чужое имя или не то значение — отказ целиком, а не частичное применение.
 */
export function readAppSettingsPatch(payload: unknown): Partial<AppSettings> | null {
  if (payload === undefined || payload === null) return {};
  if (typeof payload !== 'object' || Array.isArray(payload)) return null;
  const patch: Partial<AppSettings> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!(APP_SETTING_KEYS as readonly string[]).includes(key) || typeof value !== 'boolean') return null;
    patch[key as keyof AppSettings] = value;
  }
  return patch;
}

export interface CallFlags {
  inCall: boolean;
  mic: boolean;
  camera: boolean;
  screen: boolean;
}

type TaskbarOptions = Pick<AppSettings, 'thumbar' | 'badge' | 'flash' | 'sleepBlocker'>;

/** Кнопки на миниатюре — только во встрече и только если человек их не выключил. */
export function showThumbar(call: CallFlags, options: TaskbarOptions): boolean {
  return call.inCall && options.thumbar;
}

/** Что рисовать поверх иконки: во встрече — состояние микрофона, вне её — непрочитанное. */
export function overlayIconFor(call: CallFlags, unread: number, options: TaskbarOptions): 'in-call' | 'muted' | 'unread' | null {
  if (!options.badge) return null;
  if (call.inCall) return call.mic ? 'in-call' : 'muted';
  return unread > 0 ? 'unread' : null;
}

/** Запрет сна — во встрече и при показе экрана, если он включён. */
export function keepAwake(call: CallFlags, options: TaskbarOptions): boolean {
  return options.sleepBlocker && (call.inCall || call.screen);
}
