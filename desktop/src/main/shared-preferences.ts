/**
 * Общие для всех серверов настройки (R146, Р-39): у клиента Windows своё у сервера — только комнаты
 * (избранное, недавние, сессия, пароль сервера, громкости участников), а всё, что принадлежит
 * устройству и человеку, — одно на все серверы каталога. Владелец: «при переключении серверов
 * сохранять текущие настройки… на каждый серв свои только комнаты, настройки общие».
 *
 * Хранилище — `shared-preferences.json` в `userData`: `{values: {ключ: {value, at}}}`. Слияние —
 * «последний пишущий» по ключу (`at`, мс эпохи; из будущего не принимается — время срезается до
 * «сейчас»). Запись синхронная, через временный файл, — две правки подряд не теряют друг друга.
 *
 * Токен Яндекс Музыки (R157) — секрет: отдельный `yandex-music.dat`, зашифрован `safeStorage` (DPAPI
 * этого пользователя Windows), как `.dat` профиля. Без шифрования на диск не пишется — живёт в памяти
 * до выхода. Читается при первом обращении: `safeStorage` на Windows готов только после `ready`. Отдаётся только серверам подписанного каталога (`bootstrapShared`).
 *
 * Перенос со старых версий: пустое хранилище заполняет первая страница новой версии (`seed: true`) —
 * только ключами, которых ещё нет, и никогда пустым токеном.
 *
 * Модуль чистый (без Electron): шифрование приходит снаружи (`SecretStore`), проверяется тестами.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHARED_PREFERENCES, type SharedPreference, type SharedValues } from '../shared/bridge';
import { validSharedValue, type SharedEntries, type SharedEntry, type SharedKey } from './bridge/messages';
import type { ServerOrigin } from './origins';
import type { SecretStore } from './settings';

export const SHARED_FILE = 'shared-preferences.json';
export const TOKEN_FILE = 'yandex-music.dat';
const TOKEN: SharedKey = 'yandexMusicToken';

export interface ApplyResult {
  /** Ключи, которые записались. */
  applied: SharedKey[];
  /**
   * Ключи, где у хранилища значение новее присланного (или уже было при `seed`): странице — что
   * победило, чтобы она показывала правду, а не своё проигравшее.
   */
  kept: SharedEntries;
}

export class SharedPreferences {
  private values: Partial<Record<SharedPreference, SharedEntry>> = {};
  /** Токен: `undefined` — ещё не читали. `safeStorage` на Windows работает только после `ready`, поэтому файл читается при первом обращении, а не в конструкторе. */
  private secretEntry: SharedEntry | null | undefined = undefined;
  private readonly file: string;
  private readonly tokenFile: string;

  constructor(
    root: string,
    private readonly secrets: SecretStore,
    private readonly now: () => number = Date.now,
    private readonly log: (message: string) => void = () => {},
  ) {
    mkdirSync(root, { recursive: true });
    this.file = join(root, SHARED_FILE);
    this.tokenFile = join(root, TOKEN_FILE);
    this.values = readValues(this.file);
  }

  private get secret(): SharedEntry | null {
    if (this.secretEntry === undefined) this.secretEntry = this.readSecret();
    return this.secretEntry;
  }

  private set secret(entry: SharedEntry | null) {
    this.secretEntry = entry;
  }

  /** Общее (без секрета) ещё пусто — первая страница новой версии пришлёт своё (`seed`). */
  get empty(): boolean {
    return Object.keys(this.values).length === 0;
  }

  /** Значения без секрета — для `Bootstrap.shared`. */
  shared(): SharedValues {
    const result: SharedValues = {};
    for (const [key, entry] of Object.entries(this.values)) result[key as SharedPreference] = entry.value;
    return result;
  }

  /** Записи с временем — ключ к ключу (тесты и рассылка победившего). */
  entry(key: SharedKey): SharedEntry | undefined {
    if (key === TOKEN) return this.secret ?? undefined;
    return this.values[key as SharedPreference];
  }

  /** Токен Яндекс Музыки: null — записи нет; '' — отключён. */
  token(): string | null {
    return this.secret ? (this.secret.value as string) : null;
  }

  /**
   * Правка страницы. Обычная — «последний пишущий» по `at` (равное время — у пришедшего позже);
   * `seed` — только ключи, которых ещё нет, и не пустой токен (пустой — «не знаю», а не «отключил»).
   */
  apply(entries: SharedEntries, seed = false): ApplyResult {
    const now = this.now();
    const applied: SharedKey[] = [];
    const kept: SharedEntries = {};
    let valuesChanged = false;
    for (const [name, entry] of Object.entries(entries) as [SharedKey, SharedEntry][]) {
      if (!entry || !validSharedValue(name, entry.value)) continue;
      const at = Math.min(entry.at, now);
      const current = this.entry(name);
      if (name === TOKEN && seed && entry.value === '') continue;
      if (current && (seed || current.at > at)) {
        kept[name] = { ...current };
        continue;
      }
      if (name === TOKEN) {
        this.secret = { value: entry.value, at };
        this.writeSecret();
      } else {
        this.values[name as SharedPreference] = { value: entry.value, at };
        valuesChanged = true;
      }
      applied.push(name);
    }
    if (valuesChanged) this.writeValues();
    return { applied, kept };
  }

  private writeValues(): void {
    const temporary = this.file + '.tmp';
    try {
      writeFileSync(temporary, JSON.stringify({ values: this.values }, null, 2) + '\n', 'utf8');
      renameSync(temporary, this.file);
    } catch (error) {
      this.log(`общие настройки: не записаны — ${(error as Error).message}`);
    }
  }

  private readSecret(): SharedEntry | null {
    if (!existsSync(this.tokenFile)) return null;
    try {
      if (!this.secrets.isEncryptionAvailable()) return null;
      const parsed = JSON.parse(this.secrets.decryptString(readFileSync(this.tokenFile))) as Record<string, unknown>;
      if (typeof parsed.at === 'number' && Number.isInteger(parsed.at) && parsed.at >= 0 && validSharedValue(TOKEN, parsed.value))
        return { value: parsed.value, at: parsed.at };
    } catch {
      // Не расшифровался (другой пользователь Windows) или испорчен — как будто токена нет.
    }
    return null;
  }

  private writeSecret(): void {
    try {
      // Без шифрования секрет на диск не идёт: до выхода он в памяти, прежний файл не трогается.
      if (!this.secrets.isEncryptionAvailable()) return;
      const temporary = this.tokenFile + '.tmp';
      writeFileSync(temporary, this.secrets.encryptString(JSON.stringify(this.secret)));
      renameSync(temporary, this.tokenFile);
    } catch (error) {
      this.log(`общие настройки: токен не записан — ${(error as Error).message}`);
    }
  }
}

/** Файл → записи по белому списку; чужое и испорченное отбрасывается по одной записи. */
function readValues(file: string): Partial<Record<SharedPreference, SharedEntry>> {
  const result: Partial<Record<SharedPreference, SharedEntry>> = {};
  try {
    if (!existsSync(file)) return result;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { values?: unknown };
    const values = raw && typeof raw === 'object' && raw.values && typeof raw.values === 'object' ? (raw.values as Record<string, unknown>) : {};
    for (const key of SHARED_PREFERENCES) {
      const item = values[key] as Record<string, unknown> | undefined;
      if (!item || typeof item !== 'object') continue;
      if (typeof item.at !== 'number' || !Number.isInteger(item.at) || item.at < 0 || !validSharedValue(key, item.value)) continue;
      result[key] = { value: item.value, at: item.at };
    }
  } catch {
    // Нечитаемый файл — общее как пустое; перепишется при первой правке.
  }
  return result;
}

/**
 * Общее для `Bootstrap`: значения без секрета — любому серверу, которому оболочка вообще даёт
 * bootstrap; токен — только origin из подписанного каталога (`allowed`, `allowedOrigins()`). Он и
 * так уходит службам того сервера, когда включают музыку, — все они серверы одного владельца.
 */
export function bootstrapShared(store: SharedPreferences, origin: ServerOrigin, allowed: readonly ServerOrigin[]): { shared: SharedValues; yandexMusicToken: string | null } {
  const known = allowed.some((server) => server.equals(origin));
  return { shared: store.shared(), yandexMusicToken: known ? store.token() : null };
}
