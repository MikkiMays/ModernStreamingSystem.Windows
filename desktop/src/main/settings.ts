/**
 * Настройки приложения — `settings.json` в `userData` (`%LOCALAPPDATA%\Cord\desktop`) — и секрет
 * профиля на каждый сервер (`profile-<key>.dat`, зашифрован `safeStorage`, то есть DPAPI
 * этого пользователя Windows). Совместимости с файлами WinUI нет (решение В-2).
 *
 * `settingsRev` — ревизия умолчаний: файл старше — проходит `migrateSettings` при чтении
 * (ревизия 2 — оверлей включён по умолчанию, R61).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HotkeyBinding } from './bridge/messages';
import { INSTALLER_LANGUAGES, type Language } from './language';
import { ServerOrigin } from './origins';

export interface ServerEntry {
  url: string;
  name: string;
  autoConnect: boolean;
}

export interface Settings {
  /** Ревизия умолчаний, с которой файл согласован (`SETTINGS_REV`). */
  settingsRev: number;
  serverUrl: string;
  theme: 'light' | 'dark' | 'system';
  /** Язык из установщика (R64); веб получает его один раз через `Bootstrap.language`. */
  language: Language | null;
  showPing: boolean;
  notificationSounds: boolean;
  autoConnect: boolean;
  servers: ServerEntry[];
  catalogSeq: number;
  hotkeys: HotkeyBinding[];
  /** Переключатели раздела «Windows» в настройках веба (`app-settings.ts`, ADR §4.4). */
  tray: boolean;
  thumbar: boolean;
  badge: boolean;
  flash: boolean;
  sleepBlocker: boolean;
  overlayEnabled: boolean;
  autostart: boolean;
  /** Подсказка «Cord работает в трее» уже показывалась (R57). */
  trayHintShown: boolean;
  sidebarWidth: number;
  window: { width: number; height: number; x?: number; y?: number; maximized: boolean } | null;
  /** Версия, которую ждём после `quitAndInstall`; стоит старее — установщик отказал. */
  expectedVersion: string | null;
}

/** Ревизия 2 (1.0.4): оверлей в играх включён по умолчанию (R61). */
export const SETTINGS_REV = 2;

const DEFAULTS: Settings = {
  settingsRev: SETTINGS_REV,
  serverUrl: '',
  theme: 'system',
  language: null,
  showPing: false,
  notificationSounds: true,
  autoConnect: true,
  servers: [],
  catalogSeq: 0,
  hotkeys: [],
  tray: true,
  thumbar: true,
  badge: true,
  flash: true,
  sleepBlocker: true,
  overlayEnabled: true,
  autostart: false,
  trayHintShown: false,
  sidebarWidth: 280,
  window: null,
  expectedVersion: null,
};

export interface SecretStore {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export class SettingsStore {
  private state: Settings;
  private readonly file: string;
  /** Файла настроек не было: первый запуск после установки. */
  readonly fresh: boolean;

  constructor(
    private readonly root: string,
    private readonly secrets: SecretStore,
  ) {
    mkdirSync(root, { recursive: true });
    this.file = join(root, 'settings.json');
    this.state = { ...DEFAULTS };
    let fresh = true;
    try {
      if (existsSync(this.file)) {
        fresh = false;
        this.state = { ...DEFAULTS, ...migrateSettings(sanitize(JSON.parse(readFileSync(this.file, 'utf8')))) };
      }
    } catch {
      // Нечитаемый файл — значения по умолчанию; файл перепишется при первом изменении.
    }
    this.fresh = fresh;
  }

  get(): Settings {
    return this.state;
  }

  update(patch: Partial<Settings>): Settings {
    this.state = { ...this.state, ...patch };
    const temporary = this.file + '.tmp';
    writeFileSync(temporary, JSON.stringify(this.state, null, 2) + '\n', 'utf8');
    renameSync(temporary, this.file);
    return this.state;
  }

  /** Секрет профиля для origin: 43 символа base64url (32 байта), как писал WinUI. Создаётся при первом запросе. */
  async profileFor(origin: ServerOrigin): Promise<string> {
    const path = join(this.root, `profile-${await origin.storageKey()}.dat`);
    if (existsSync(path)) {
      try {
        const value = this.secrets.isEncryptionAvailable() ? this.secrets.decryptString(readFileSync(path)) : readFileSync(path, 'utf8');
        if (/^[A-Za-z0-9_-]{43}$/.test(value)) return value;
      } catch {
        // Не расшифровался (другой пользователь Windows) — создаём новый: избранное на сервере останется за старым секретом.
      }
    }
    const fresh = randomBytes(32).toString('base64url');
    writeFileSync(path, this.secrets.isEncryptionAvailable() ? this.secrets.encryptString(fresh) : fresh);
    return fresh;
  }

  forgetProfile(origin: ServerOrigin): void {
    void origin.storageKey().then((key) => {
      const path = join(this.root, `profile-${key}.dat`);
      if (existsSync(path)) unlinkSync(path);
    });
  }
}

/**
 * Файл старой ревизии → нынешние умолчания. До ревизии 2 `update()` писал в файл явное
 * `overlayEnabled: false` каждому, кто переключатель не трогал, — поэтому при переходе оверлей
 * включается всем: решение владельца «по умолчанию включён» (R61), а не «сохранить выбор, которого не было».
 */
export function migrateSettings(saved: Partial<Settings>): Partial<Settings> {
  const rev = saved.settingsRev ?? 1;
  const next = { ...saved };
  if (rev < 2) next.overlayEnabled = true;
  next.settingsRev = SETTINGS_REV;
  return next;
}

const LANGUAGES = new Set<string>(Object.values(INSTALLER_LANGUAGES));

function sanitize(raw: unknown): Partial<Settings> {
  if (!raw || typeof raw !== 'object') return {};
  const data = raw as Record<string, unknown>;
  const result: Partial<Settings> = {};
  if (typeof data.settingsRev === 'number' && Number.isInteger(data.settingsRev) && data.settingsRev >= 1) result.settingsRev = data.settingsRev;
  const origin = ServerOrigin.tryParse(data.serverUrl);
  if (origin) result.serverUrl = origin.url;
  if (data.theme === 'light' || data.theme === 'dark' || data.theme === 'system') result.theme = data.theme;
  if (typeof data.language === 'string' && LANGUAGES.has(data.language)) result.language = data.language as Language;
  for (const flag of ['showPing', 'notificationSounds', 'autoConnect', 'tray', 'thumbar', 'badge', 'flash', 'sleepBlocker', 'overlayEnabled', 'autostart', 'trayHintShown'] as const)
    if (typeof data[flag] === 'boolean') result[flag] = data[flag] as boolean;
  if (typeof data.catalogSeq === 'number' && Number.isInteger(data.catalogSeq) && data.catalogSeq >= 0) result.catalogSeq = data.catalogSeq;
  if (typeof data.sidebarWidth === 'number' && data.sidebarWidth >= 200 && data.sidebarWidth <= 600) result.sidebarWidth = Math.round(data.sidebarWidth);
  if (typeof data.expectedVersion === 'string' && /^\d+\.\d+\.\d+$/.test(data.expectedVersion)) result.expectedVersion = data.expectedVersion;
  if (Array.isArray(data.servers)) {
    const seen = new Set<string>();
    result.servers = [];
    for (const item of data.servers.slice(0, 20)) {
      const entry = (item ?? {}) as Record<string, unknown>;
      const url = ServerOrigin.tryParse(entry.url);
      if (!url || seen.has(url.url)) continue;
      seen.add(url.url);
      result.servers.push({ url: url.url, name: typeof entry.name === 'string' ? entry.name.trim().slice(0, 60) : '', autoConnect: entry.autoConnect !== false });
    }
  }
  if (Array.isArray(data.hotkeys)) result.hotkeys = data.hotkeys.filter(validBinding).slice(0, 8) as HotkeyBinding[];
  if (data.window && typeof data.window === 'object') {
    const window = data.window as Record<string, unknown>;
    if (typeof window.width === 'number' && typeof window.height === 'number' && window.width >= 400 && window.height >= 300)
      result.window = {
        width: Math.round(window.width),
        height: Math.round(window.height),
        ...(typeof window.x === 'number' ? { x: Math.round(window.x) } : {}),
        ...(typeof window.y === 'number' ? { y: Math.round(window.y) } : {}),
        maximized: window.maximized === true,
      };
  }
  return result;
}

function validBinding(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const binding = value as Record<string, unknown>;
  const key = binding.key as Record<string, unknown> | undefined;
  return (
    ['mic.toggle', 'ptt', 'deafen', 'overlay.toggle'].includes(binding.action as string) &&
    (binding.mode === 'toggle' || binding.mode === 'hold') &&
    !!key &&
    typeof key.code === 'string' &&
    ['ctrl', 'alt', 'shift', 'meta'].every((name) => typeof key[name] === 'boolean')
  );
}
