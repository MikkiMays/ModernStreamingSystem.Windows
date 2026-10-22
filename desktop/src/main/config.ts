/**
 * Всё, что связывает сборку Cord с конкретным местом. Адрес обновлений вшит при сборке и
 * НЕ следует за выбранным сервером встреч (правило `CordDefaults.cs`): вход в чужую комнату
 * не должен решать, какой исполняемый файл поставится на эту машину.
 *
 * Адресов в коде нет: сервер по умолчанию и канал обновлений задаёт сборка — переменные
 * `CORD_DEFAULT_SERVER` и `CORD_UPDATE_CHANNEL` (`scripts/copy-shell.mjs` пишет их в
 * `dist/update-keys.json`); канал по умолчанию — `<сервер>downloads/windows/desktop/`. При запуске из
 * исходников те же переменные окружения перекрывают файл.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * AppUserModelID приложения (R59). Тот же, что `appId` в `electron-builder.yml`: установщик пишет
 * его в ярлыки меню «Пуск» и рабочего стола (`WinShell::SetLnkAUMI`), а процесс объявляет его через
 * `app.setAppUserModelId`. Расходятся — Windows не показывает уведомления и не группирует окна
 * на панели задач. Совпадение сверяет `test/unit/config.test.ts`.
 */
export const APP_ID = 'tech.cord.desktop';

export interface BuildConfig {
  /** Канал обновлений: каталог с `latest.yml`, `latest.yml.sig` и установщиком. */
  updateChannel: string;
  /** Публичные ключи Ed25519 `[текущий, следующий]` для подписи манифеста (SPKI PEM). */
  updateKeys: string[];
  /** Сервер для первого запуска, пока каталог не подписан ядром. */
  defaultServer: string;
}

const DEFAULTS: BuildConfig = {
  updateChannel: '',
  updateKeys: [],
  defaultServer: '',
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
  if (!config.updateChannel && config.defaultServer) config.updateChannel = channelFor(config.defaultServer);
  cached = config;
  return config;
}

/** Канал обновлений сервера Cord: зеркало клиента на нём же (`/downloads/windows/desktop/`). */
export function channelFor(server: string): string {
  return new URL('downloads/windows/desktop/', server.endsWith('/') ? server : `${server}/`).toString();
}
