/**
 * Провайдер electron-updater для зеркала Cord (ADR 0001 §5): наследник generic, который
 * перед тем, как поверить `latest.yml`, проверяет его Ed25519-подпись в `latest.yml.sig`
 * ключом из вшитого списка, а адреса файлов пускает только внутрь канала. Пока подписанные
 * манифесты electron-builder 27 в alpha, это и есть слой 1; sha512 и размер — слой 2 —
 * сверяет сам electron-updater при загрузке, sha256 — `updater.ts` после неё.
 */
import type { CustomPublishOptions, UpdateInfo } from 'builder-util-runtime';
import { newError } from 'builder-util-runtime';
import type { AppUpdater, ResolvedUpdateFileInfo } from 'electron-updater';
import { GenericProvider } from 'electron-updater/out/providers/GenericProvider';
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider';
import type { KeyObject } from 'node:crypto';
import { allowedFileUrl, parseManifest, verifyManifestSignature } from './manifest';

export interface SignedChannelOptions extends CustomPublishOptions {
  url: string;
  keys: KeyObject[];
}

let latest: SignedGenericProvider | null = null;
/** Провайдер, который electron-updater создал последним, — чтобы после загрузки сверить sha256 с его манифестом. */
export function currentSignedProvider(): SignedGenericProvider | null {
  return latest;
}

export class SignedGenericProvider extends GenericProvider {
  private readonly channel_: string;
  private readonly keys: readonly KeyObject[];
  /** Последний принятый манифест — для sha256 после загрузки. */
  public lastManifest: ReturnType<typeof parseManifest> | null = null;

  constructor(options: SignedChannelOptions, updater: AppUpdater, runtimeOptions: ProviderRuntimeOptions) {
    super({ provider: 'generic', url: options.url, useMultipleRangeRequest: false }, updater, runtimeOptions);
    this.channel_ = options.url.endsWith('/') ? options.url : options.url + '/';
    this.keys = options.keys;
    latest = this;
  }

  override async getLatestVersion(): Promise<UpdateInfo> {
    if (this.keys.length === 0) throw newError('В сборке нет ключа проверки обновлений.', 'ERR_UPDATER_NO_KEY');
    const manifestUrl = new URL('latest.yml', this.channel_);
    const signatureUrl = new URL('latest.yml.sig', this.channel_);
    const [manifestText, signatureText] = await Promise.all([this.httpRequest(manifestUrl), this.httpRequest(signatureUrl)]);
    if (manifestText == null || signatureText == null) throw newError('Зеркало не отдало описание выпуска.', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND');
    if (!verifyManifestSignature(manifestText, signatureText, this.keys))
      throw newError('Подпись описания выпуска не подтверждена.', 'ERR_UPDATER_INVALID_SIGNATURE');
    const manifest = parseManifest(manifestText);
    for (const file of manifest.files)
      if (!allowedFileUrl(this.channel_, file.url)) throw newError('Недопустимый адрес загрузки.', 'ERR_UPDATER_INVALID_URL');
    this.lastManifest = manifest;
    return {
      version: manifest.version,
      files: manifest.files.map((file) => ({ url: file.url, sha512: file.sha512, size: file.size })),
      path: manifest.path,
      sha512: manifest.sha512,
      releaseDate: manifest.releaseDate ?? new Date(0).toISOString(),
    };
  }

  override resolveFiles(updateInfo: UpdateInfo): ResolvedUpdateFileInfo[] {
    const resolved = super.resolveFiles(updateInfo);
    for (const file of resolved)
      if (!allowedFileUrl(this.channel_, file.url.toString())) throw newError('Недопустимый адрес загрузки.', 'ERR_UPDATER_INVALID_URL');
    return resolved;
  }
}
