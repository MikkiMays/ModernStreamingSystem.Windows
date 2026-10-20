import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  allowedFileUrl,
  installerName,
  isUpgrade,
  ManifestError,
  parseManifest,
  publicKey,
  verifyManifestSignature,
  verifyPackage,
} from '../../src/main/update/manifest';

const SHA512 = Buffer.alloc(64, 1).toString('base64');
const SHA256 = 'a'.repeat(64);
const yaml = `version: 1.0.1
files:
  - url: Cord-Setup-1.0.1.exe
    sha512: ${SHA512}
    size: 104857600
    sha256: ${SHA256}
path: Cord-Setup-1.0.1.exe
sha512: ${SHA512}
releaseDate: '2026-10-20T10:00:00.000Z'
`;

describe('parseManifest', () => {
  it('читает latest.yml electron-builder с нашим sha256', () => {
    const manifest = parseManifest(yaml);
    expect(manifest.version).toBe('1.0.1');
    expect(manifest.files[0]).toEqual({ url: 'Cord-Setup-1.0.1.exe', sha512: SHA512, size: 104857600, sha256: SHA256 });
    expect(manifest.path).toBe('Cord-Setup-1.0.1.exe');
  });
  it('отвергает нестабильную версию, чужое имя, плохой размер, несогласованный path', () => {
    const reason = (text: string) => {
      try {
        parseManifest(text);
      } catch (error) {
        return (error as ManifestError).reason;
      }
      return 'ok';
    };
    expect(reason(yaml.replace('version: 1.0.1', 'version: 1.0.1-beta'))).toBe('version');
    expect(reason(yaml.replace('url: Cord-Setup-1.0.1.exe', 'url: ../../evil.exe'))).toBe('url');
    expect(reason(yaml.replace('size: 104857600', 'size: 0'))).toBe('size');
    expect(reason(yaml.replace('size: 104857600', 'size: 9999999999'))).toBe('size');
    expect(reason(yaml.replace('path: Cord-Setup-1.0.1.exe', 'path: other.exe'))).toBe('path');
    expect(reason(yaml.replace(`sha256: ${SHA256}`, 'sha256: zz'))).toBe('sha256');
    expect(reason('not: [yaml')).toBe('yaml');
    expect(reason('42')).toBe('yaml');
  });
});

describe('isUpgrade', () => {
  it('только новее установленной, только X.Y.Z', () => {
    expect(isUpgrade('1.0.1', '1.0.0')).toBe(true);
    expect(isUpgrade('1.0.0', '1.0.0')).toBe(false);
    expect(isUpgrade('0.9.9', '1.0.0')).toBe(false);
    expect(isUpgrade('1.10.0', '1.9.0')).toBe(true);
    expect(isUpgrade('1.0.1-rc1', '1.0.0')).toBe(false);
  });
});

describe('allowedFileUrl — файл только внутри канала', () => {
  const channel = 'https://cord.nikg.tech/downloads/windows/desktop/';
  it('принимает имя файла рядом с описанием', () => {
    expect(allowedFileUrl(channel, 'Cord-Setup-1.0.1.exe')).toBe(true);
    expect(allowedFileUrl(channel, 'https://cord.nikg.tech/downloads/windows/desktop/Cord-Setup-1.0.1.exe.blockmap')).toBe(true);
  });
  it('отвергает другой хост, другой путь, подкаталоги, запрос, http', () => {
    expect(allowedFileUrl(channel, 'https://evil.example/Cord-Setup-1.0.1.exe')).toBe(false);
    expect(allowedFileUrl(channel, '/downloads/windows/Cord-Setup-1.0.1.exe')).toBe(false);
    expect(allowedFileUrl(channel, '../Cord-Setup-1.0.1.exe')).toBe(false);
    expect(allowedFileUrl(channel, 'sub/Cord-Setup-1.0.1.exe')).toBe(false);
    expect(allowedFileUrl(channel, 'Cord-Setup-1.0.1.exe?x=1')).toBe(false);
    expect(allowedFileUrl('http://cord.nikg.tech/downloads/windows/desktop/', 'a.exe')).toBe(false);
    expect(allowedFileUrl('http://localhost:8091/downloads/windows/desktop/', 'a.exe')).toBe(true);
  });
});

describe('подпись манифеста Ed25519', () => {
  const current = generateKeyPairSync('ed25519');
  const next = generateKeyPairSync('ed25519');
  const stranger = generateKeyPairSync('ed25519');
  const keys = [current, next].map((pair) => publicKey(pair.publicKey.export({ type: 'spki', format: 'pem' }) as string));
  const signWith = (pair: typeof current, data: string) => sign(null, Buffer.from(data, 'utf8'), pair.privateKey).toString('base64');

  it('принимает подпись текущим и следующим ключом, отвергает чужой', () => {
    expect(verifyManifestSignature(yaml, signWith(current, yaml), keys)).toBe(true);
    expect(verifyManifestSignature(yaml, signWith(next, yaml), keys)).toBe(true);
    expect(verifyManifestSignature(yaml, signWith(stranger, yaml), keys)).toBe(false);
  });
  it('любое изменение байтов манифеста ломает подпись', () => {
    const signature = signWith(current, yaml);
    expect(verifyManifestSignature(yaml.replace('1.0.1', '1.0.2'), signature, keys)).toBe(false);
    expect(verifyManifestSignature(yaml, 'not base64 at all', keys)).toBe(false);
    expect(verifyManifestSignature(yaml, signature, [])).toBe(false);
  });
  it('ключ не Ed25519 — отказ', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => publicKey(rsa.publicKey.export({ type: 'spki', format: 'pem' }) as string)).toThrow(ManifestError);
    const bare = (current.publicKey.export({ type: 'spki', format: 'pem' }) as string).replace(/-----[A-Z ]+-----/g, '').trim();
    expect(publicKey(bare).asymmetricKeyType).toBe('ed25519');
  });
});

describe('verifyPackage', () => {
  const manifest = parseManifest(yaml);
  it('размер и sha256 против подписанного описания', async () => {
    expect(await verifyPackage(manifest, '/tmp/x', 104857600, async () => SHA256)).toBeNull();
    expect(await verifyPackage(manifest, '/tmp/x', 1, async () => SHA256)).toMatch(/Размер/);
    expect(await verifyPackage(manifest, '/tmp/x', 104857600, async () => 'b'.repeat(64))).toMatch(/SHA-256/);
  });
  it('имя установщика — ровно как публикует сборка', () => {
    expect(installerName('1.0.1')).toBe('Cord-Setup-1.0.1.exe');
  });
});
