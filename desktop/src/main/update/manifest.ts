/**
 * Описание выпуска на зеркале Cord (`/downloads/windows/desktop/latest.yml`) и его проверка
 * по слоям ADR 0001 §5: Ed25519-подпись точных байтов манифеста ключом из вшитого списка
 * `[текущий, следующий]`, затем размер и sha512 (их сверяет electron-updater при загрузке), затем
 * sha256 скачанного файла (`verifyPackage`). Адреса файлов обязаны лежать внутри канала —
 * описание не может увести загрузку куда-то ещё.
 *
 * Чистый модуль: ни Electron, ни сети — только разбор и криптография, проверяемые тестами.
 */
import { createHash, createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { load as parseYaml } from 'js-yaml';

export interface ManifestFile {
  url: string;
  sha512: string;
  size: number;
  /** Дополнительно к sha512 electron-builder: пишет `scripts/sign-manifest.mjs`. */
  sha256?: string;
}

export interface Manifest {
  version: string;
  files: ManifestFile[];
  path: string;
  sha512: string;
  releaseDate?: string;
}

export class ManifestError extends Error {
  constructor(message: string, public readonly reason: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^[0-9a-f]{64}$/i;
/** Больше установщик Cord не бывает; всё крупнее — не он. */
export const SIZE_LIMIT = 1024 * 1024 * 1024;

/** Ключ из PEM (`-----BEGIN PUBLIC KEY-----`) или голого base64 SPKI. */
export function publicKey(encoded: string): KeyObject {
  const pem = encoded.includes('BEGIN PUBLIC KEY')
    ? encoded
    : `-----BEGIN PUBLIC KEY-----\n${encoded.replace(/\s+/g, '')}\n-----END PUBLIC KEY-----\n`;
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new ManifestError('Ключ манифеста — не Ed25519.', 'key');
  return key;
}

/** Подпись над точными байтами манифеста любым из вшитых ключей. */
export function verifyManifestSignature(manifest: Buffer | string, signatureBase64: string, keys: readonly KeyObject[]): boolean {
  if (keys.length === 0) return false;
  let signature: Buffer;
  try {
    signature = Buffer.from(signatureBase64.trim(), 'base64');
  } catch {
    return false;
  }
  if (signature.length !== 64) return false;
  const data = typeof manifest === 'string' ? Buffer.from(manifest, 'utf8') : manifest;
  return keys.some((key) => {
    try {
      return verifySignature(null, data, key, signature);
    } catch {
      return false;
    }
  });
}

/** Разбор `latest.yml` без доверия: каждое поле — по схеме, иначе `ManifestError`. */
export function parseManifest(text: string): Manifest {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    throw new ManifestError('Описание выпуска не читается.', 'yaml');
  }
  if (!raw || typeof raw !== 'object') throw new ManifestError('Описание выпуска не читается.', 'yaml');
  const data = raw as Record<string, unknown>;
  if (typeof data.version !== 'string' || !STABLE.test(data.version)) throw new ManifestError('Неверный номер версии в описании выпуска.', 'version');
  if (!Array.isArray(data.files) || data.files.length === 0) throw new ManifestError('В выпуске нет установщика.', 'files');
  const files: ManifestFile[] = data.files.map((item) => {
    const file = (item ?? {}) as Record<string, unknown>;
    if (typeof file.url !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(file.url))
      throw new ManifestError('Неверное имя установщика.', 'url');
    if (typeof file.sha512 !== 'string' || Buffer.from(file.sha512, 'base64').length !== 64)
      throw new ManifestError('Выпуск не содержит проверяемый SHA-512 установщика.', 'sha512');
    if (typeof file.size !== 'number' || !Number.isInteger(file.size) || file.size <= 0 || file.size > SIZE_LIMIT)
      throw new ManifestError('Неверный размер пакета.', 'size');
    if (file.sha256 !== undefined && (typeof file.sha256 !== 'string' || !SHA256.test(file.sha256)))
      throw new ManifestError('Выпуск не содержит проверяемый SHA-256 установщика.', 'sha256');
    return { url: file.url, sha512: file.sha512, size: file.size, ...(file.sha256 ? { sha256: file.sha256.toLowerCase() } : {}) };
  });
  if (typeof data.path !== 'string' || !files.some((file) => file.url === data.path))
    throw new ManifestError('Описание выпуска не согласовано.', 'path');
  if (typeof data.sha512 !== 'string') throw new ManifestError('Выпуск не содержит проверяемый SHA-512 установщика.', 'sha512');
  const releaseDate = typeof data.releaseDate === 'string' ? data.releaseDate : undefined;
  return { version: data.version, files, path: data.path, sha512: data.sha512, ...(releaseDate ? { releaseDate } : {}) };
}

export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Новее ли кандидат установленной. Ревизия сборки не считается: версии Cord — X.Y.Z. */
export function isUpgrade(candidate: string, current: string): boolean {
  if (!STABLE.test(candidate) || !STABLE.test(current)) return false;
  return compareVersions(candidate, current) > 0;
}

/**
 * Адрес файла внутри канала: тот же origin, что у зеркала, и путь в каталоге канала. Так
 * описание, даже подписанное, не может отправить за установщиком на другой хост.
 */
export function allowedFileUrl(channel: string, file: string): boolean {
  let base: URL;
  let target: URL;
  try {
    base = new URL(channel);
    target = new URL(file, base);
  } catch {
    return false;
  }
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) return false;
  if (target.origin !== base.origin || target.username || target.password || target.search || target.hash) return false;
  const directory = base.pathname.endsWith('/') ? base.pathname : base.pathname + '/';
  if (!target.pathname.startsWith(directory)) return false;
  // Один сегмент: файл лежит прямо в канале, без `..` и подкаталогов.
  const rest = target.pathname.slice(directory.length);
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(rest) && !rest.includes('..');
}

/** Имя установщика выпуска — ровно то, что публикует сборка. */
export function installerName(version: string): string {
  return `Cord-Setup-${version}.exe`;
}

/** sha256 файла — потоком, чтобы 100 МБ не держать в памяти. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('end', resolve).on('error', reject);
  });
  return hash.digest('hex');
}

/**
 * Скачанный пакет против подписанного описания: имя, размер и sha256 (если описание его
 * несёт — выкладка Cord пишет его всегда; описание без него принимается только ради
 * чужих зеркал в тестах и помечается в журнале).
 */
export async function verifyPackage(manifest: Manifest, path: string, size: number, digest: () => Promise<string> = () => sha256File(path)): Promise<string | null> {
  const file = manifest.files.find((entry) => entry.url === manifest.path) ?? manifest.files[0]!;
  if (size !== file.size) return 'Размер пакета изменился.';
  if (file.sha256) {
    const actual = await digest();
    if (actual.toLowerCase() !== file.sha256) return 'Пакет повреждён: SHA-256 не совпадает. Повторите загрузку.';
  }
  return null;
}
