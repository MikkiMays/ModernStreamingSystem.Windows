/**
 * Меню трея как у Телемоста (R103, референс n10, DESIGN.md → Трей): сверху — состояние
 * (неактивный пункт), во встрече — «Вернуться во встречу» первым, «Новая встреча» всегда, во встрече —
 * «Чат · N» с непрочитанными (R87), «Микрофон» и «Звук встречи» (R156) галочками, «Уведомления»
 * галочкой, «Настройки», внизу — «Выйти из Cord». Подсказка значка — то же состояние, с микрофоном и
 * выключенным звуком встречи.
 *
 * Чистая часть: состав и тексты по состоянию — проверяются тестами; `tray.ts` превращает пункты в
 * `Menu` Electron и вешает действия по `id`.
 */
import type { ShellText } from './shell-text';

export interface TrayState {
  inCall: boolean;
  mic: boolean;
  /** Название встречи (`call.state`/`state` → `room.title`); пустое — без него. */
  title: string;
  /** Непрочитанные в чате встречи (`badge` веба). */
  unread: number;
  /** Переключатель «Уведомления» (`settings.notifications`). */
  notifications: boolean;
  /**
   * «Звук встречи» выключен (R156, `mini.state.deafened`); null — веб о нём не знает (до R156), и
   * пункта нет. Галочка — «звук встречи включён», как у «Микрофона».
   */
  deafened?: boolean | null;
}

export type TrayItemId = 'status' | 'return' | 'new' | 'chat' | 'mic' | 'deafen' | 'notifications' | 'settings' | 'quit';
export type TrayItem = { type: 'separator' } | { type?: undefined; id: TrayItemId; label: string; enabled?: false; checked?: boolean };

/** Сколько названия встречи помещается в строку состояния. */
export const TITLE_MAX = 40;
/** Предел подсказки значка в Windows (`NOTIFYICONDATA.szTip` — 128 с нулём). */
export const TOOLTIP_MAX = 127;

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** В меню Windows «&» — подчёркнутая буква; своё «&» удваивается. */
function menuText(text: string): string {
  return text.replace(/&/g, '&&');
}

function status(state: TrayState, text: ShellText): string {
  const title = clip(state.title, TITLE_MAX);
  return state.inCall ? [text.statusInCall, title].filter(Boolean).join(' · ') : text.statusIdle;
}

const separator: TrayItem = { type: 'separator' };

export function trayMenu(state: TrayState, text: ShellText): TrayItem[] {
  const items: TrayItem[] = [{ id: 'status', label: `${state.inCall ? '●' : '○'} ${menuText(status(state, text))}`, enabled: false }, separator];
  if (state.inCall) items.push({ id: 'return', label: text.returnToMeeting });
  items.push({ id: 'new', label: text.newMeeting }, separator);
  if (state.inCall) {
    items.push({ id: 'chat', label: state.unread > 0 ? `${text.chat} · ${Math.min(state.unread, 999)}` : text.chat });
    items.push({ id: 'mic', label: text.microphone, checked: state.mic });
    if (typeof state.deafened === 'boolean') items.push({ id: 'deafen', label: text.sound, checked: !state.deafened });
    items.push(separator);
  }
  items.push({ id: 'notifications', label: text.notifications, checked: state.notifications }, { id: 'settings', label: text.settings }, separator, { id: 'quit', label: text.quit });
  return items;
}

export function trayTooltip(state: TrayState, text: ShellText): string {
  const parts = ['Cord', status(state, text)];
  if (state.inCall && !state.mic) parts.push(text.micOffNote);
  if (state.inCall && state.deafened === true) parts.push(text.deafenedNote);
  return clip(parts.join(' · '), TOOLTIP_MAX);
}
