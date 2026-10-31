/**
 * Проверка сообщений страницы — те же границы, что `BridgeProtocol.Read` в WinUI: размер ≤ 16 КиБ,
 * известный тип, UUID комнаты, код из 9 цифр, аватар `data:image/` ≤ 4 КиБ, имя ≤ 40,
 * заголовок ≤ 80, сочетание — из модели E03.
 *
 * Общие настройки (`preferences.changed {shared}`, R146) проверяются строго, по белому списку ключей:
 * чужой ключ, не тот тип или лишний размер — отказ всему сообщению (как у `app.settings`).
 *
 * Состав для виджета и мини-окна (`overlay.roster`) проверяется мягко (R137): запись не по схеме
 * пропускается, чужой аватар становится пустым. Прежде одна такая запись отправляла в корзину весь
 * состав, а страница тот же состав второй раз не шлёт — мини-окно показывало старый навсегда.
 *
 * Здесь нет Electron: модуль чистый и проверяется тестами. Origin отправителя сверяет
 * маршрутизатор (`router.ts`) до того, как сюда попадёт JSON.
 */
import {
  AVATAR_LIMIT,
  MESSAGE_LIMIT,
  PAGE_CALLS,
  PAGE_MESSAGES,
  ROSTER_LIMIT,
  SECRET_PREFERENCES,
  SHARED_PREFERENCES,
  type PageCall,
  type PageMessage,
  type SecretPreference,
  type SharedPreference,
} from '../../shared/bridge';
import { readCaptureSelect } from '../capture';
import { isLanguage, type Language } from '../language';

export interface Hotkey {
  code: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

/** `overlay.lock` (R63) — разблокировать виджет в игре (по умолчанию `Shift+\``); его, как и `overlay.toggle`, исполняет сама оболочка. */
export type HotkeyAction = 'mic.toggle' | 'ptt' | 'deafen' | 'overlay.toggle' | 'overlay.lock';
export interface HotkeyBinding {
  action: HotkeyAction;
  mode: 'toggle' | 'hold';
  key: Hotkey;
}

/** Участник для виджета в игре и мини-окна (R63, R93): аватар — `data:image/` ≤ 4 КиБ или пусто. */
export interface RosterEntry {
  id: string;
  name: string;
  avatar: string;
  muted: boolean;
}

/** Что показывает мини-окно звонка (R93); кто говорит — по порту уровней, состав — `overlay.roster`. */
export interface MiniState {
  room: string;
  /** id своей записи в составе: своя плитка в развёрнутом виде. */
  self: string;
  mic: boolean;
  camera: boolean;
  screen: boolean;
  /** Непрочитанные в чате (R87). */
  unread: number;
  /** Сколько людей во встрече. */
  count: number;
  /**
   * Связь со звуком: пока `recovering`, встреча не исполняет микрофон, камеру и показ — мини-окно их
   * гасит и пишет, что связь восстанавливается. Веб до этого поля его не шлёт — тогда `connected`.
   */
  status: 'connecting' | 'connected' | 'recovering';
  /** Секунд до конца ожидания связи (пока `recovering`). */
  remaining: number;
  /**
   * Номер состояния (R137): растёт, когда состояние меняется; страница повторяет последнее раз в 5 с
   * и по `mini.resync` с тем же номером. Веб до R137 его не шлёт.
   */
  seq?: number;
}

/** Ответ встречи на нажатие в мини-окне (R137): `seq` — номер нажатия, `reason` — код (`link`, `busy`…). */
export interface MiniAck {
  seq: number;
  result: 'ok' | 'ignored';
  reason?: string;
}

/** Ключ общей настройки или секрета (R146). */
export type SharedKey = SharedPreference | SecretPreference;
/** Запись общей настройки: значение и когда его записали (мс эпохи) — «последний пишущий» по ключу. */
export interface SharedEntry {
  value: unknown;
  at: number;
}
export type SharedEntries = Partial<Record<SharedKey, SharedEntry>>;

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
  | { type: 'preferences.changed'; showPing?: boolean; notificationSounds?: boolean; shared?: SharedEntries; seed?: true }
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
  | { type: 'capture.select'; id: string; audio: 'none' | 'system' | 'app' | 'system-except-cord' }
  /** `skipped` — сколько записей не прошло проверку и пропущено (R137); остальные приходят. */
  | { type: 'overlay.roster'; participants: RosterEntry[]; skipped: number }
  | { type: 'mini.state'; state: MiniState }
  | ({ type: 'mini.ack' } & MiniAck);

const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Кнопки мыши Mouse3 (средняя), Mouse4 и Mouse5 (боковые) — только через cord-native (Raw Input); без него — «в окне встречи».
// `Backquote` — клавиша «`» слева от единицы: `Shift+\`` разблокирует оверлей, как у Discord (R63).
const HOTKEY_CODE = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Backquote|Mouse[3-5])$/;
const ACTIONS: readonly HotkeyAction[] = ['mic.toggle', 'ptt', 'deafen', 'overlay.toggle', 'overlay.lock'];
/** id участника встречи (идентичность LiveKit). */
const PARTICIPANT_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
/** Больше людей виджет не рисует — дальше «+N». */
export const ROSTER_SIZE = 25;
/** Аватар — только картинка `data:` в base64: аватар пришёл от другого участника, адреса окно оболочки не грузит. */
const AVATAR = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
/** Номер нажатия и состояния (R137) — неотрицательное целое. */
function sequence(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined;
}

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

// ---------- общие настройки (R146) ----------

/** Аватар — `data:` картинка не длиннее, чем веб кладёт в настройки (`preferences.ts`). */
export const SHARED_AVATAR_LIMIT = 3500;
/** Токен Яндекс Музыки — печатные ASCII не длиннее этого. */
export const TOKEN_LIMIT = 1000;
const SHARED_KEYS: readonly string[] = [...SHARED_PREFERENCES, ...SECRET_PREFERENCES];
const LANGUAGES_OR_NULL = (value: unknown) => value === null || isLanguage(value);
/** Имя значения перечисления, которое веб может расширить (раскладка, режим показа): незнакомое веб сам сведёт к умолчанию. */
const IDENT = /^[a-z][a-z0-9-]{0,23}$/;
const SHARED_AVATAR = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;

function integerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Объект только с этими ключами (лишний — отказ) и значениями по `check`. */
function record(value: unknown, keys: readonly string[] | RegExp, check: (key: string, item: unknown) => boolean, max = 16): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > max) return false;
  return entries.every(([key, item]) => (Array.isArray(keys) ? keys.includes(key) : (keys as RegExp).test(key)) && check(key, item));
}

function level(value: unknown, extra: readonly string[] = []): boolean {
  return record(
    value,
    ['resolution', 'fps', ...extra],
    (key, item) =>
      key === 'resolution' ? integerIn(item, 1, 4320) : key === 'fps' ? integerIn(item, 1, 240) : key === 'preview' ? typeof item === 'boolean' : typeof item === 'string' && IDENT.test(item),
    8,
  );
}

/**
 * Проверить значение общей настройки по её ключу. Значение проходит как есть (оболочка его не
 * правит): веб читает его своим `readPreferences` и сам сводит к допустимому на этом сервере.
 */
export function validSharedValue(key: string, value: unknown): boolean {
  switch (key as SharedKey) {
    case 'language':
      return LANGUAGES_OR_NULL(value);
    case 'name':
      return typeof value === 'string' && value.length <= 40;
    case 'avatar':
      return value === '' || (typeof value === 'string' && value.length <= SHARED_AVATAR_LIMIT && SHARED_AVATAR.test(value));
    case 'audio':
      return record(
        value,
        ['suppression', 'suppressionChosen', 'echoCancellation', 'autoGainControl', 'gain'],
        (name, item) =>
          name === 'suppression' ? typeof item === 'string' && IDENT.test(item) : name === 'gain' ? typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 2 : typeof item === 'boolean',
        5,
      );
    case 'outputVolume':
    case 'soundVolume':
    case 'watchVolume':
      return integerIn(value, 0, 100);
    case 'notificationSounds':
    case 'deafened':
    case 'pokerHints':
    case 'pokerFeed':
    case 'showPing':
      return typeof value === 'boolean';
    case 'gameSounds':
      return record(value, IDENT, (_, item) => typeof item === 'boolean');
    case 'micHotkey':
    case 'overlayHotkey':
    case 'overlayLockHotkey':
    case 'deafenHotkey':
      return value === null || (validHotkey(value) && Object.keys(value).length === 5);
    case 'micHotkeyMode':
      return value === 'toggle' || value === 'hold';
    case 'layout':
      return typeof value === 'string' && IDENT.test(value);
    case 'watchAudio':
      return typeof value === 'string' && value.length <= 24;
    case 'watchSubtitles':
      return typeof value === 'string' && value.length <= 32;
    case 'screen':
      return level(value, ['mode', 'preview', 'audio']);
    case 'camera':
      return level(value);
    case 'cinemaLinks':
      return Array.isArray(value) && value.length <= 10 && value.every((url) => typeof url === 'string' && url.length <= 2000 && /^https?:\/\//i.test(url));
    case 'lastPlatform':
      return record(value, IDENT, (_, item) => typeof item === 'string' && /^[a-z][a-z-]{0,31}$/.test(item), 8);
    case 'devices':
      // Устройства — по названию (`deviceId` у каждого origin свой): {camera?, microphone?, speaker?}.
      return record(value, ['camera', 'microphone', 'speaker'], (_, item) => typeof item === 'string' && item.length > 0 && item.length <= 200, 3);
    case 'yandexMusicToken':
      return typeof value === 'string' && value.length <= TOKEN_LIMIT && /^[\x21-\x7e]*$/.test(value);
  }
  return false;
}

/** `{ключ: {value, at}}` по белому списку; любой чужой ключ, тип или время — `null` (отказ всему). */
export function readSharedEntries(raw: unknown): SharedEntries | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > SHARED_KEYS.length) return null;
  const result: SharedEntries = {};
  for (const [key, item] of entries) {
    if (!SHARED_KEYS.includes(key) || !item || typeof item !== 'object' || Array.isArray(item)) return null;
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).some((name) => name !== 'value' && name !== 'at')) return null;
    if (!integerIn(entry.at, 0, Number.MAX_SAFE_INTEGER) || !('value' in entry) || !validSharedValue(key, entry.value)) return null;
    result[key as SharedKey] = { value: entry.value, at: entry.at };
  }
  return result;
}

/**
 * Разобрать сообщение страницы. `null` — отказ: неизвестный тип, лишний размер, поле не по
 * схеме. Отказ пишется в журнал, но странице не сообщается — как и сейчас.
 */
export function readPageMessage(type: unknown, payload: unknown): Validated | null {
  if (typeof type !== 'string' || !(PAGE_MESSAGES as readonly string[]).includes(type)) return null;
  const data: Record<string, unknown> = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  if (payload !== undefined && payload !== null && data !== payload) return null;
  if (JSON.stringify(data).length > (type === 'overlay.roster' ? ROSTER_LIMIT : MESSAGE_LIMIT)) return null;
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
      // Общие настройки (R146): строго по белому списку — не прошла одна запись, не проходит ничего.
      const shared = data.shared === undefined ? undefined : readSharedEntries(data.shared);
      if (shared === null) return null;
      if (data.seed !== undefined && data.seed !== true) return null;
      return {
        type: kind,
        ...(showPing !== undefined ? { showPing } : {}),
        ...(notificationSounds !== undefined ? { notificationSounds } : {}),
        ...(shared ? { shared } : {}),
        ...(shared && data.seed === true ? { seed: true as const } : {}),
      };
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
    case 'overlay.roster': {
      if (!Array.isArray(data.participants)) return null;
      const participants: RosterEntry[] = [];
      const seen = new Set<string>();
      let skipped = 0;
      for (const item of data.participants) {
        const entry = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
        const name = entry ? text(entry.name, 40) : undefined;
        if (!entry || typeof entry.id !== 'string' || !PARTICIPANT_ID.test(entry.id) || seen.has(entry.id) || name === undefined || participants.length >= ROSTER_SIZE) {
          skipped += 1;
          continue;
        }
        const avatar = typeof entry.avatar === 'string' && entry.avatar.length <= AVATAR_LIMIT && AVATAR.test(entry.avatar) ? entry.avatar : '';
        seen.add(entry.id);
        participants.push({ id: entry.id, name, avatar, muted: entry.muted === true });
      }
      return { type: kind, participants, skipped };
    }
    case 'mini.state': {
      const room = text(data.room, 80);
      const self = data.self === undefined || data.self === null ? '' : data.self;
      if (room === undefined || typeof self !== 'string' || (self && !PARTICIPANT_ID.test(self))) return null;
      const count = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? Math.min(value, 999) : 0);
      return {
        type: kind,
        state: {
          room,
          self,
          mic: data.mic === true,
          camera: data.camera === true,
          screen: data.screen === true,
          unread: count(data.unread),
          count: count(data.count),
          status: data.status === 'recovering' || data.status === 'connecting' ? data.status : 'connected',
          remaining: data.status === 'recovering' ? count(data.remaining) : 0,
          ...(sequence(data.seq) !== undefined ? { seq: sequence(data.seq) } : {}),
        },
      };
    }
    case 'mini.ack': {
      const seq = sequence(data.seq);
      if (seq === undefined || (data.result !== 'ok' && data.result !== 'ignored')) return null;
      const reason = typeof data.reason === 'string' && /^[a-z-]{1,30}$/.test(data.reason) ? data.reason : undefined;
      return { type: kind, seq, result: data.result, ...(reason ? { reason } : {}) };
    }
  }
  return null;
}

/** `games.set {exe, enabled}` и `games.forget {exe}` — имя exe и (для set) переключатель. */
export function readGameCall(method: 'games.set' | 'games.forget', payload: unknown): { exe: string; enabled: boolean } | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const data = payload as Record<string, unknown>;
  if (typeof data.exe !== 'string' || !/^[^\\/:*?"<>|]{1,120}\.exe$/i.test(data.exe)) return null;
  if (method === 'games.set' && typeof data.enabled !== 'boolean') return null;
  return { exe: data.exe.toLowerCase(), enabled: data.enabled === true };
}

export function isPageCall(value: unknown): value is PageCall {
  return typeof value === 'string' && (PAGE_CALLS as readonly string[]).includes(value);
}
