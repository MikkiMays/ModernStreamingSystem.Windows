/**
 * Всё, что связывает сборку Cord с конкретным местом. Адрес обновлений вшит при сборке и
 * НЕ следует за выбранным сервером встреч (правило `CordDefaults.cs`): вход в чужую комнату
 * не должен решать, какой исполняемый файл поставится на эту машину.
 *
 * Сервер по умолчанию — продукт `https://cord.online/` из `build/update-keys.json` (R200, Р-110: продукт
 * один); канал обновлений — `<сервер>downloads/windows/desktop/` или `CORD_UPDATE_CHANNEL`
 * (`scripts/copy-shell.mjs` пишет оба в `dist/update-keys.json`). При запуске из исходников и в дымовом
 * прогоне CI переменные окружения `CORD_DEFAULT_SERVER` и `CORD_UPDATE_CHANNEL` перекрывают файл: так
 * клиент ходит на стенд разработки, которого в каталоге продукта нет (`devServer`).
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
  /**
   * `defaultServer` задан окружением (`CORD_DEFAULT_SERVER`: запуск из исходников, дымовой прогон CI), а не
   * сборкой. Такой сервер клиент считает известным и без каталога: разработчик, направивший клиент на стенд,
   * хочет открыть стенд, а не сервер по умолчанию из каталога продукта.
   */
  devServer: boolean;
  /**
   * Включать ли аппаратный AV1 для WebRTC (`WebRtcAV1HWEncode`, R152) на видеокартах из белого списка
   * (`gpu.ts`). По умолчанию — да; `"av1HwEncode": false` в `update-keys.json` выключает в сборке,
   * `CORD_AV1_HW=0` — у человека.
   */
  av1HwEncode: boolean;
}

const DEFAULTS: BuildConfig = {
  updateChannel: '',
  updateKeys: [],
  defaultServer: '',
  devServer: false,
  av1HwEncode: true,
};

let cached: BuildConfig | null = null;

export function buildConfig(appPath: string): BuildConfig {
  if (cached) return cached;
  const config = { ...DEFAULTS };
  const keys = join(appPath, 'dist', 'update-keys.json');
  if (existsSync(keys)) {
    const parsed = JSON.parse(readFileSync(keys, 'utf8')) as { keys?: string[]; channel?: string; defaultServer?: string; av1HwEncode?: unknown };
    if (Array.isArray(parsed.keys)) config.updateKeys = parsed.keys.filter((key) => typeof key === 'string');
    if (typeof parsed.channel === 'string' && parsed.channel.startsWith('https://')) config.updateChannel = parsed.channel;
    if (typeof parsed.defaultServer === 'string') config.defaultServer = parsed.defaultServer;
    if (parsed.av1HwEncode === false) config.av1HwEncode = false;
  }
  if (process.env.CORD_UPDATE_CHANNEL) config.updateChannel = process.env.CORD_UPDATE_CHANNEL;
  if (process.env.CORD_DEFAULT_SERVER) {
    config.defaultServer = process.env.CORD_DEFAULT_SERVER;
    config.devServer = true;
  }
  if (!config.updateChannel && config.defaultServer) config.updateChannel = channelFor(config.defaultServer);
  cached = config;
  return config;
}

/** Сбросить кэш — для тестов, где меняются окружение и файл сборки. */
export function resetBuildConfigForTests(): void {
  cached = null;
}

/** Канал обновлений сервера Cord: зеркало клиента на нём же (`/downloads/windows/desktop/`). */
export function channelFor(server: string): string {
  return new URL('downloads/windows/desktop/', server.endsWith('/') ? server : `${server}/`).toString();
}
