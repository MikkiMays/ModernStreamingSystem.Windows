/**
 * Проверка сообщений страницы — те же границы, что `BridgeProtocol.Read` в WinUI: размер ≤ 16 КиБ,
 * известный тип, UUID комнаты, код из 9 цифр, аватар `data:image/` ≤ 4 КиБ, имя ≤ 40,
 * заголовок ≤ 80, сочетание — из модели E03.
 *
 * Здесь нет Electron: модуль чистый и проверяется тестами. Origin отправителя сверяет
 * маршрутизатор (`router.ts`) до того, как сюда попадёт JSON.
 */
import { AVATAR_LIMIT, MESSAGE_LIMIT, PAGE_CALLS, PAGE_MESSAGES, type PageCall, type PageMessage } from '../../shared/bridge';
import { readCaptureSelect } from '../capture';
import { isLanguage, type Language } from '../language';

export interface Hotkey {
  code: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export type HotkeyAction = 'mic.toggle' | 'ptt' | 'deafen' | 'overlay.toggle';
export interface HotkeyBinding {
  action: HotkeyAction;
  mode: 'toggle' | 'hold';
  key: Hotkey;
}

export interface RoomRef {
  roomId: string;
  title: string;
  code: string;
}

export type Validated =
  | { type: 'state'; page: 'home' | 'prejoin' | 'room'; inCall: boolean; name: string; avatar: string; theme: string; room: RoomRef | null; language?: Language }
  | { type: 'call.state'; inCall: boolean; mic: boolean; camera: boolean; screen: boolean; room: RoomRef | null }
  | { type: 'hotkeys.configure'; bindings: HotkeyBinding[] }
  | { type: 'favorites.changed' }
  | { type: 'preferences.changed'; showPing?: boolean; notificationSounds?: boolean }
  | { type: 'server.autoconnect'; autoConnect: boolean }
  | { type: 'servers.open' }
  | { type: 'close.ready' }
  | { type: 'update.check' }
  | { type: 'update.apply' }
  | { type: 'overlay.state'; participants: { name: string; tier: number; speaking: boolean }[] }
  | { type: 'notify'; title: string; body: string; tag?: string; silent?: boolean; actions?: { id: string; text: string }[] }
  | { type: 'attention' }
  | { type: 'progress'; value: number }
  | { type: 'badge'; count: number }
  | { type: 'capture.select'; id: string; audio: 'none' | 'system' | 'app' | 'system-except-cord' };

const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Кнопки мыши Mouse3 (средняя), Mouse4 и Mouse5 (боковые) — только через cord-native (Raw Input); без него — «в окне встречи».
const HOTKEY_CODE = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Mouse[3-5])$/;
const ACTIONS: readonly HotkeyAction[] = ['mic.toggle', 'ptt', 'deafen', 'overlay.toggle'];

export function validHotkey(value: unknown): value is Hotkey {
  if (!value || typeof value !== 'object') return false;
  const key = value as Record<string, unknown>;
  return (
    typeof key.code === 'string' &&
    HOTKEY_CODE.test(key.code) &&
    ['ctrl', 'alt', 'shift', 'meta'].every((name) => typeof key[name] === 'boolean')
  );
}

function room(value: unknown): RoomRef | null | undefined {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object') return undefined;
  const ref = value as Record<string, unknown>;
  if (typeof ref.roomId !== 'string' || !ROOM_ID.test(ref.roomId)) return undefined;
  if (typeof ref.title !== 'string' || !ref.title.trim() || ref.title.length > 80) return undefined;
  if (typeof ref.code !== 'string' || !/^\d{9}$/.test(ref.code)) return undefined;
  return { roomId: ref.roomId.toLowerCase(), title: ref.title, code: ref.code };
}

function text(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) return undefined;
  return value;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Разобрать сообщение страницы. `null` — отказ: неизвестный тип, лишний размер, поле не по
 * схеме. Отказ пишется в журнал, но странице не сообщается — как и сейчас.
 */
export function readPageMessage(type: unknown, payload: unknown): Validated | null {
  if (typeof type !== 'string' || !(PAGE_MESSAGES as readonly string[]).includes(type)) return null;
  const data: Record<string, unknown> = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  if (payload !== undefined && payload !== null && data !== payload) return null;
  if (JSON.stringify(data).length > MESSAGE_LIMIT) return null;
  const kind = type as PageMessage;
  switch (kind) {
    case 'state': {
      if (data.page !== 'home' && data.page !== 'prejoin' && data.page !== 'room') return null;
      const name = text(data.name, 40);
      const avatar = text(data.avatar, AVATAR_LIMIT);
      if (name === undefined || avatar === undefined) return null;
      if (avatar.length > 0 && !avatar.startsWith('data:image/')) return null;
      const ref = room(data.room);
      if (ref === undefined) return null;
      const theme = data.theme === 'light' || data.theme === 'dark' ? data.theme : 'system';
      // Язык интерфейса (необязательный, R103): на нём трей; незнакомый — как если бы его не было.
      const language = isLanguage(data.language) ? data.language : undefined;
      return { type: kind, page: data.page, inCall: data.inCall === true, name, avatar, theme, room: ref, ...(language ? { language } : {}) };
    }
    case 'call.state': {
      const ref = room(data.room);
      if (ref === undefined) return null;
      return { type: kind, inCall: data.inCall === true, mic: data.mic === true, camera: data.camera === true, screen: data.screen === true, room: ref };
    }
    case 'hotkeys.configure': {
      const list = Array.isArray(data.bindings) ? data.bindings : data.bindings === undefined || data.bindings === null ? [] : null;
      if (list === null || list.length > 8) return null;
      const bindings: HotkeyBinding[] = [];
      for (const item of list) {
        if (!item || typeof item !== 'object') return null;
        const binding = item as Record<string, unknown>;
        if (!ACTIONS.includes(binding.action as HotkeyAction)) return null;
        if (binding.mode !== 'toggle' && binding.mode !== 'hold') return null;
        if (!validHotkey(binding.key)) return null;
        bindings.push({ action: binding.action as HotkeyAction, mode: binding.mode, key: { ...binding.key } });
      }
      return { type: kind, bindings };
    }
    case 'favorites.changed':
    case 'servers.open':
    case 'close.ready':
    case 'update.check':
    case 'update.apply':
    case 'attention':
      return { type: kind };
    case 'preferences.changed': {
      const showPing = bool(data.showPing);
      const notificationSounds = bool(data.notificationSounds);
      return { type: kind, ...(showPing !== undefined ? { showPing } : {}), ...(notificationSounds !== undefined ? { notificationSounds } : {}) };
    }
    case 'server.autoconnect': {
      const autoConnect = bool(data.autoConnect);
      return autoConnect === undefined ? null : { type: kind, autoConnect };
    }
    case 'overlay.state': {
      if (!Array.isArray(data.participants) || data.participants.length > 20) return null;
      const participants = [];
      for (const item of data.participants) {
        if (!item || typeof item !== 'object') return null;
        const entry = item as Record<string, unknown>;
        const name = text(entry.name, 40);
        if (name === undefined || typeof entry.tier !== 'number' || entry.tier < 0 || entry.tier > 4) return null;
        participants.push({ name, tier: Math.floor(entry.tier), speaking: entry.speaking === true });
      }
      return { type: kind, participants };
    }
    case 'notify': {
      const title = text(data.title, 80);
      const body = text(data.body, 300);
      const tag = data.tag === undefined ? '' : text(data.tag, 60);
      if (!title || body === undefined || tag === undefined) return null;
      let actions: { id: string; text: string }[] | undefined;
      if (data.actions !== undefined) {
        if (!Array.isArray(data.actions) || data.actions.length > 2) return null;
        actions = [];
        for (const item of data.actions) {
          const action = item as Record<string, unknown>;
          if (!action || typeof action.id !== 'string' || !/^[a-z.-]{1,30}$/.test(action.id)) return null;
          const label = text(action.text, 30);
          if (!label) return null;
          actions.push({ id: action.id, text: label });
        }
      }
      // `silent` — без системного звука: веб озвучивает событие сам (R59).
      return { type: kind, title, body, ...(tag ? { tag } : {}), ...(data.silent === true ? { silent: true } : {}), ...(actions ? { actions } : {}) };
    }
    case 'progress': {
      if (typeof data.value !== 'number' || !Number.isFinite(data.value)) return null;
      return { type: kind, value: Math.min(1, Math.max(-1, data.value)) };
    }
    case 'badge': {
      if (typeof data.count !== 'number' || !Number.isInteger(data.count) || data.count < 0) return null;
      return { type: kind, count: Math.min(data.count, 999) };
    }
    case 'capture.select': {
      const selection = readCaptureSelect(data);
      return selection ? { type: kind, ...selection } : null;
    }
  }
  return null;
}

export function isPageCall(value: unknown): value is PageCall {
  return typeof value === 'string' && (PAGE_CALLS as readonly string[]).includes(value);
}
