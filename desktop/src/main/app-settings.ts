/**
 * Переключатели «мягкого взаимодействия с Windows» (T53, ADR 0001 §4.4) — раздел «Windows» в
 * настройках веба (E03). Веб читает и меняет их запросом `invoke('app.settings', патч)`; оболочка
 * сама меняет `overlay` клавишей `overlay.toggle` и рассказывает об этом событием `app.settings`.
 *
 * По умолчанию (ADR §4.4): трей, мигание, запрет сна, оверлей (R61) и уведомления — включены; автозапуск
 * — выключен. Кнопок на миниатюре и значка поверх иконки с 1.0.11 нет (R138): их ключи `thumbar` и
 * `badge` остаются в ответе (веб до R138 ждёт все булевы ключи) — всегда `false`, а патч к ним
 * принимается и ничего не меняет. Уведомления переключаются и из меню
 * трея (R103) — тогда оболочка рассказывает вебу событием `app.settings`, как с клавишей оверлея.
 *
 * Не только переключатели (R63, R93): виджет говорящих в игре — угол (`overlayCorner`), размер аватара
 * (`overlaySize`), имена (`overlayNames`), прозрачность 30–100 % (`overlayOpacity`), всплывашка при
 * старте игры (`overlayToast`) — и мини-окно звонка (`mini`). Веб без этих имён (до R63) их не шлёт и
 * не читает; оболочка до R63 отказала бы патчу с ними целиком — поэтому веб шлёт их только при флаге
 * `overlay.widget` / `mini`. Здесь нет Electron: решения проверяются тестами, `tray.ts` и `index.ts`
 * только исполняют их.
 */
import type { Settings } from './settings';

export type OverlayCorner = 'tl' | 'tr' | 'bl' | 'br';
export type OverlaySize = 's' | 'm' | 'l';
export type OverlayNames = 'always' | 'speaking' | 'never';

/** Виджет говорящих в игре (DESIGN.md → Оверлей): что хранится в `settings.overlay`. */
export interface OverlayWidget {
  corner: OverlayCorner;
  size: OverlaySize;
  names: OverlayNames;
  /** Непрозрачность виджета, 30–100 %. */
  opacity: number;
  /** Всплывашка «Cord поверх игры · Показать игру» при старте игры (R104). */
  toast: boolean;
  /** Смещение от угла в DIP после перетаскивания разблокированного виджета; смена угла его сбрасывает. */
  offset: { x: number; y: number };
}

export const OVERLAY_CORNERS: readonly OverlayCorner[] = ['tl', 'tr', 'bl', 'br'];
export const OVERLAY_SIZES: readonly OverlaySize[] = ['s', 'm', 'l'];
export const OVERLAY_NAMES: readonly OverlayNames[] = ['always', 'speaking', 'never'];
export const OVERLAY_OPACITY = { min: 30, max: 100 } as const;
/** Смещение не дальше этого от угла: виджет не уезжает за монитор 8K. */
const OFFSET_LIMIT = 8000;

/** Как у Discord: слева сверху, средний аватар, имена всегда, без прозрачности, всплывашка включена. */
export const OVERLAY_WIDGET_DEFAULTS: Readonly<OverlayWidget> = { corner: 'tl', size: 'm', names: 'always', opacity: 100, toast: true, offset: { x: 0, y: 0 } };

function clampOpacity(value: number): number {
  return Math.min(OVERLAY_OPACITY.max, Math.max(OVERLAY_OPACITY.min, Math.round(value)));
}

/** Смещение виджета от угла — только конечные числа в разумных пределах. */
export function readOffset(value: unknown): { x: number; y: number } | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  const axis = (raw: unknown) => (typeof raw === 'number' && Number.isFinite(raw) ? Math.max(-OFFSET_LIMIT, Math.min(OFFSET_LIMIT, Math.round(raw))) : null);
  const x = axis(data.x);
  const y = axis(data.y);
  return x === null || y === null ? null : { x, y };
}

/** `settings.overlay` из файла — без доверия: незнакомое значение — умолчание. */
export function readOverlayWidget(raw: unknown): OverlayWidget {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    corner: OVERLAY_CORNERS.includes(data.corner as OverlayCorner) ? (data.corner as OverlayCorner) : OVERLAY_WIDGET_DEFAULTS.corner,
    size: OVERLAY_SIZES.includes(data.size as OverlaySize) ? (data.size as OverlaySize) : OVERLAY_WIDGET_DEFAULTS.size,
    names: OVERLAY_NAMES.includes(data.names as OverlayNames) ? (data.names as OverlayNames) : OVERLAY_WIDGET_DEFAULTS.names,
    opacity: typeof data.opacity === 'number' && Number.isFinite(data.opacity) ? clampOpacity(data.opacity) : OVERLAY_WIDGET_DEFAULTS.opacity,
    toast: typeof data.toast === 'boolean' ? data.toast : OVERLAY_WIDGET_DEFAULTS.toast,
    offset: readOffset(data.offset) ?? { ...OVERLAY_WIDGET_DEFAULTS.offset },
  };
}

export interface AppSettings {
  /** Значок в трее: открыть, микрофон, выйти. */
  tray: boolean;
  /** Кнопки на миниатюре — убраны (R138): всегда `false`, патч игнорируется. */
  thumbar: boolean;
  /** Значок поверх иконки — убран (R138): всегда `false`, патч игнорируется. */
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
  /** Мини-окно звонка, когда Cord свёрнут или перекрыт (R93). */
  mini: boolean;
  /** Виджет говорящих в игре (R63). */
  overlayCorner: OverlayCorner;
  overlaySize: OverlaySize;
  overlayNames: OverlayNames;
  overlayOpacity: number;
  /** Всплывашка при старте игры (R104). */
  overlayToast: boolean;
}

const BOOLEAN_KEYS = ['tray', 'thumbar', 'badge', 'flash', 'sleepBlocker', 'overlay', 'autostart', 'notifications', 'mini', 'overlayToast'] as const satisfies readonly (keyof AppSettings)[];
export const APP_SETTING_KEYS = [...BOOLEAN_KEYS, 'overlayCorner', 'overlaySize', 'overlayNames', 'overlayOpacity'] as const satisfies readonly (keyof AppSettings)[];

type Stored = Pick<Settings, 'tray' | 'flash' | 'sleepBlocker' | 'overlayEnabled' | 'autostart' | 'notifications' | 'overlay' | 'mini'>;

/** Значения для веба из настроек оболочки. */
export function appSettingsOf(settings: Stored): AppSettings {
  return {
    tray: settings.tray,
    thumbar: false,
    badge: false,
    flash: settings.flash,
    sleepBlocker: settings.sleepBlocker,
    overlay: settings.overlayEnabled,
    autostart: settings.autostart,
    notifications: settings.notifications,
    mini: settings.mini.enabled,
    overlayCorner: settings.overlay.corner,
    overlaySize: settings.overlay.size,
    overlayNames: settings.overlay.names,
    overlayOpacity: settings.overlay.opacity,
    overlayToast: settings.overlay.toast,
  };
}

/**
 * Патч от веба → патч настроек оболочки. Значения виджета и мини-окна сливаются с тем, что уже
 * записано (`current`); новый угол сбрасывает смещение — иначе виджет уехал бы от нового угла.
 */
export function settingsPatchOf(patch: Partial<AppSettings>, current: Pick<Stored, 'overlay' | 'mini'>): Partial<Stored> {
  // thumbar и badge (R138) — переключатели того, чего больше нет: принимаются и отбрасываются.
  const { overlay, mini, overlayCorner, overlaySize, overlayNames, overlayOpacity, overlayToast, thumbar: _thumbar, badge: _badge, ...rest } = patch;
  const next: Partial<Stored> = { ...rest, ...(overlay !== undefined ? { overlayEnabled: overlay } : {}) };
  if (mini !== undefined) next.mini = { ...current.mini, enabled: mini };
  const widget = {
    ...(overlayCorner !== undefined && overlayCorner !== current.overlay.corner ? { corner: overlayCorner, offset: { x: 0, y: 0 } } : {}),
    ...(overlaySize !== undefined ? { size: overlaySize } : {}),
    ...(overlayNames !== undefined ? { names: overlayNames } : {}),
    ...(overlayOpacity !== undefined ? { opacity: clampOpacity(overlayOpacity) } : {}),
    ...(overlayToast !== undefined ? { toast: overlayToast } : {}),
  };
  if (Object.keys(widget).length) next.overlay = { ...current.overlay, ...widget };
  return next;
}

/**
 * Патч из `invoke('app.settings', …)`: только известные имена; переключатели — только `true`/`false`,
 * угол, размер и имена — из своих списков, прозрачность — целое 30–100. Пустой — просто чтение.
 * Чужое имя или не то значение — отказ целиком, а не частичное применение.
 */
export function readAppSettingsPatch(payload: unknown): Partial<AppSettings> | null {
  if (payload === undefined || payload === null) return {};
  if (typeof payload !== 'object' || Array.isArray(payload)) return null;
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if ((BOOLEAN_KEYS as readonly string[]).includes(key)) {
      if (typeof value !== 'boolean') return null;
    } else if (key === 'overlayCorner') {
      if (!OVERLAY_CORNERS.includes(value as OverlayCorner)) return null;
    } else if (key === 'overlaySize') {
      if (!OVERLAY_SIZES.includes(value as OverlaySize)) return null;
    } else if (key === 'overlayNames') {
      if (!OVERLAY_NAMES.includes(value as OverlayNames)) return null;
    } else if (key === 'overlayOpacity') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < OVERLAY_OPACITY.min || value > OVERLAY_OPACITY.max) return null;
    } else return null;
    patch[key] = value;
  }
  return patch as Partial<AppSettings>;
}

export interface CallFlags {
  inCall: boolean;
  mic: boolean;
  camera: boolean;
  screen: boolean;
}

type TaskbarOptions = Pick<AppSettings, 'flash' | 'sleepBlocker'>;

/** Запрет сна — во встрече и при показе экрана, если он включён. */
export function keepAwake(call: CallFlags, options: TaskbarOptions): boolean {
  return options.sleepBlocker && (call.inCall || call.screen);
}
