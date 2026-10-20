/**
 * Всё, что связывает сборку Cord с конкретным местом. Адрес обновлений вшит при сборке и
 * НЕ следует за выбранным сервером встреч (правило `CordDefaults.cs`): вход в чужую комнату
 * не должен решать, какой исполняемый файл поставится на эту машину.
 *
 * Канал прототипа — стенд `cord.nikg.tech`; боевой адрес подставляет CI переменной
 * `CORD_UPDATE_CHANNEL` при сборке (пишется в `dist/config.json`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BuildConfig {
  /** Канал обновлений: каталог с `latest.yml`, `latest.yml.sig` и установщиком. */
  updateChannel: string;
  /** Публичные ключи Ed25519 `[текущий, следующий]` для подписи манифеста (SPKI PEM). */
  updateKeys: string[];
  /** Сервер для первого запуска, пока каталог не подписан ядром. */
  defaultServer: string;
}

const DEFAULTS: BuildConfig = {
  updateChannel: 'https://cord.nikg.tech/downloads/windows/desktop/',
  updateKeys: [],
  defaultServer: 'https://cord.nikg.tech/',
};

let cached: BuildConfig | null = null;

export function buildConfig(appPath: string): BuildConfig {
  if (cached) return cached;
  const config = { ...DEFAULTS };
  const keys = join(appPath, 'dist', 'update-keys.json');
  if (existsSync(keys)) {
    const parsed = JSON.parse(readFileSync(keys, 'utf8')) as { keys?: string[]; channel?: string; defaultServer?: string };
    if (Array.isArray(parsed.keys)) config.updateKeys = parsed.keys.filter((key) => typeof key === 'string');
    if (typeof parsed.channel === 'string' && parsed.channel.startsWith('https://')) config.updateChannel = parsed.channel;
    if (typeof parsed.defaultServer === 'string') config.defaultServer = parsed.defaultServer;
  }
  if (process.env.CORD_UPDATE_CHANNEL) config.updateChannel = process.env.CORD_UPDATE_CHANNEL;
  if (process.env.CORD_DEFAULT_SERVER) config.defaultServer = process.env.CORD_DEFAULT_SERVER;
  cached = config;
  return config;
}
