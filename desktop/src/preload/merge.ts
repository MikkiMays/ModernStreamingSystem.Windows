/**
 * Что preload кладёт в хранилище страницы сервера до её первого скрипта (ADR 0001 §3.1): секрет
 * профиля, тема, PING и сигналы, язык установщика (один раз на origin), адрес сервера — и с 1.1.0
 * общие настройки (R146, Р-39): значения последней записи с любого сервера поверх своих у этого
 * origin, в `cord:preferences:v1` и `cord:name`. Токен Яндекс Музыки (R157) — тоже, если оболочка
 * его отдала (сервер из каталога).
 *
 * Не переносится: `devices` — у каждого origin свои `deviceId` (Chromium солит их), а общее хранит
 * названия; страницу по названию сверяет сам веб (`enumerateDevices`). Чужой `deviceId` в запись не
 * попадает никогда. Свои у сервера ключи (`cord:favorites:v1`, `cord:recent:v1`, `cord:session:v1`,
 * `cord:volumes:v1`, …) preload не трогает.
 *
 * Модуль без Electron: хранилище — любое с `getItem`/`setItem`, проверяется тестами.
 */
import type { Bootstrap } from '../shared/bridge';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const PREFERENCES_KEY = 'cord:preferences:v1';
export const NAME_KEY = 'cord:name';
export const INSTALLER_LANGUAGE_KEY = 'cord:installer-language';

function readObject(storage: KeyValueStorage, key: string): Record<string, unknown> {
  try {
    const value = JSON.parse(storage.getItem(key) ?? 'null') as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Записать bootstrap в хранилище страницы `origin` (`location.origin`). */
export function mergeBootstrap(storage: KeyValueStorage, bootstrap: Bootstrap, origin: string): void {
  storage.setItem('cord:profile:v1', bootstrap.profile);
  storage.setItem('cord:theme', bootstrap.theme);
  const saved = readObject(storage, PREFERENCES_KEY);
  saved.showPing = bootstrap.showPing;
  saved.notificationSounds = bootstrap.notificationSounds;
  // Общие настройки (R146) — поверх своих у origin; устройства — нет (у origin свои id).
  const shared = bootstrap.shared && typeof bootstrap.shared === 'object' ? bootstrap.shared : {};
  for (const [key, value] of Object.entries(shared)) {
    if (key === 'devices' || value === undefined) continue;
    saved[key] = value;
  }
  if (typeof shared.name === 'string') storage.setItem(NAME_KEY, shared.name.trim().slice(0, 40));
  if (typeof bootstrap.yandexMusicToken === 'string') saved.yandexMusicToken = bootstrap.yandexMusicToken;
  // Язык из установщика (R64) — один раз на origin: дальше человек выбирает язык в настройках Cord,
  // и даже возврат к «языку системы» (null) оболочка не перебивает. Язык в общих — уже выбор человека.
  if (bootstrap.language && storage.getItem(INSTALLER_LANGUAGE_KEY) !== bootstrap.language) {
    if (typeof saved.language !== 'string' && !('language' in shared)) saved.language = bootstrap.language;
    storage.setItem(INSTALLER_LANGUAGE_KEY, bootstrap.language);
  }
  storage.setItem(PREFERENCES_KEY, JSON.stringify(saved));
  const server = readObject(storage, 'cord:servers:v1');
  server.url = origin + '/';
  server.autoConnect = bootstrap.autoConnect;
  storage.setItem('cord:servers:v1', JSON.stringify(server));
}
