/**
 * Шаги обновления для заставки (`splash-flow.ts`) поверх electron-updater: `NsisUpdater` с
 * подписанным провайдером, `autoDownload: false`, `allowDowngrade: false`, тихая установка с
 * перезапуском. Отказ установщика виден на следующем запуске: перед `quitAndInstall`
 * запоминается ожидаемая версия, и если на диске стоит старее — заставка говорит почему и
 * сама не повторяет.
 */
import { CancellationToken, type UpdateInfo } from 'builder-util-runtime';
import { NsisUpdater } from 'electron-updater';
import type { KeyObject } from 'node:crypto';
import { statSync } from 'node:fs';
import { publicKey, verifyPackage } from './manifest';
import { currentSignedProvider, SignedGenericProvider } from './provider';
import {
  checkWithBudget,
  downloadWithStall,
  installFailure,
  STALL_LIMIT_MS,
  type UpdateCheck,
  type UpdateSteps,
} from './splash-flow';

export interface UpdaterHost {
  currentVersion: string;
  channel: string;
  keys: string[];
  expectedVersion(): string | null;
  rememberExpected(version: string | null): void;
  log(message: string): void;
}

export class CordUpdater implements UpdateSteps {
  private readonly updater: NsisUpdater;
  private readonly keys: KeyObject[];
  private available: UpdateInfo | null = null;
  private downloaded: string | null = null;
  /** Что сказать «О программе»: состояние словами и есть ли что ставить. */
  public status = { status: '', available: false };

  constructor(private readonly host: UpdaterHost) {
    this.keys = host.keys.map(publicKey);
    this.updater = new NsisUpdater({ provider: 'custom', url: host.channel, keys: this.keys, updateProvider: SignedGenericProvider } as never);
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.allowDowngrade = false;
    this.updater.allowPrerelease = false;
    this.updater.disableWebInstaller = true;
    this.updater.forceDevUpdateConfig = false;
    this.updater.logger = { info: (m) => host.log(String(m)), warn: (m) => host.log('warn ' + String(m)), error: (m) => host.log('error ' + String(m)), debug: () => {} };
    this.updater.on('update-downloaded', (event) => {
      this.downloaded = event.downloadedFile ?? null;
    });
  }

  takeInstallFailure(): string | null {
    const expected = this.host.expectedVersion();
    const failure = installFailure(expected, this.host.currentVersion);
    if (expected) this.host.rememberExpected(null);
    return failure;
  }

  async check(budgetMs: number, signal: AbortSignal): Promise<UpdateCheck> {
    this.available = null;
    const result = await checkWithBudget(
      async () => {
        const answer = await this.updater.checkForUpdates();
        if (!answer || !answer.updateInfo) return { verdict: 'none' };
        const info = answer.updateInfo;
        // electron-updater сам сравнил версии (allowDowngrade: false): isUpdateAvailable — новее.
        if (!answer.isUpdateAvailable) return { verdict: 'none' };
        this.available = info;
        return { verdict: 'forced', version: info.version };
      },
      budgetMs,
      signal,
    );
    this.status = result.verdict === 'forced' ? { status: 'Доступно обновление приложения.', available: true } : result.verdict === 'none' ? { status: 'Установлена последняя версия.', available: false } : { status: 'Сервер обновлений недоступен.', available: false };
    return result;
  }

  async download(progress: (value: number) => void, signal: AbortSignal): Promise<{ ok: true } | { ok: false; problem: string }> {
    if (!this.available) return { ok: false, problem: 'Нечего загружать.' };
    const result = await downloadWithStall(
      async (report, inner) => {
        const token = new CancellationToken();
        inner.addEventListener('abort', () => token.cancel(), { once: true });
        const onProgress = (info: { percent: number }) => report(Math.min(1, Math.max(0, info.percent / 100)));
        this.updater.on('download-progress', onProgress);
        try {
          const files = await this.updater.downloadUpdate(token);
          const file = Array.isArray(files) ? files[0] : files;
          if (typeof file !== 'string') throw new Error('Загрузка не вернула файл.');
          this.downloaded = file;
          report(1);
          return file;
        } finally {
          this.updater.off('download-progress', onProgress);
        }
      },
      progress,
      STALL_LIMIT_MS,
      signal,
    );
    if (!result.ok) return result;
    // Слой 3: sha256 из подписанного описания против файла на диске (размер и sha512 уже сверил electron-updater).
    const manifest = currentSignedProvider()?.lastManifest ?? null;
    if (manifest) {
      const problem = await verifyPackage(manifest, result.value, statSync(result.value).size);
      if (problem) {
        this.discardPackage();
        return { ok: false, problem };
      }
    }
    return { ok: true };
  }

  async apply(): Promise<void> {
    if (!this.downloaded || !this.available) throw new Error('Пакет не загружен.');
    this.host.rememberExpected(this.available.version);
    // Тихо и с перезапуском. Если установщик не запустился, electron-updater бросает — заставка покажет причину.
    this.updater.quitAndInstall(true, true);
  }

  discardPackage(): void {
    this.downloaded = null;
    this.available = null;
  }
}
