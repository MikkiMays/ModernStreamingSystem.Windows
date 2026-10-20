import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CatalogError, defaultServer, fetchCatalog, GRACE_MS, parseCatalogKeys, parseCatalogPayload, pickCatalog, verifyCatalog } from '../../src/main/catalog';
import { publicKey } from '../../src/main/update/manifest';
import { CaptureSelection, loopbackFor, SELECTION_TTL_MS } from '../../src/main/capture';

const pair = generateKeyPairSync('ed25519');
const stranger = generateKeyPairSync('ed25519');
const keys = [publicKey(pair.publicKey.export({ type: 'spki', format: 'pem' }) as string)];

const payload = {
  format: 'cord.servers/1',
  seq: 42,
  issuedAt: '2026-10-19T12:00:00Z',
  expiresAt: '2026-12-19T12:00:00Z',
  servers: [
    { id: 'nl-1', name: { ru: 'Нидерланды', en: 'Netherlands' }, country: 'NL', url: 'https://cord.nikg.tech/', order: 10, default: true },
    { id: 'de-1', name: { ru: 'Германия' }, country: 'DE', url: 'https://meet.nikg.tech/', order: 5 },
  ],
};

function jws(body: object, signer = pair) {
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'test' })).toString('base64url');
  const signature = sign(null, Buffer.from(`${header}.${encoded}`, 'ascii'), signer.privateKey).toString('base64url');
  return JSON.stringify({ payload: encoded, signatures: [{ protected: header, signature }] });
}

const now = Date.parse('2026-10-20T00:00:00Z');

describe('verifyCatalog', () => {
  it('принимает подписанный каталог и сортирует по order', () => {
    const catalog = verifyCatalog(jws(payload), keys, 0, now);
    expect(catalog.servers.map((server) => server.id)).toEqual(['de-1', 'nl-1']);
    expect(defaultServer(catalog).id).toBe('nl-1');
  });
  it('чужой ключ, изменённая нагрузка, откат seq, просрочка — отказ', () => {
    const reason = (text: string, lastSeq = 0, at = now) => {
      try {
        verifyCatalog(text, keys, lastSeq, at);
      } catch (error) {
        return (error as CatalogError).reason;
      }
      return 'ok';
    };
    expect(reason(jws(payload, stranger))).toBe('signature');
    const tampered = JSON.parse(jws(payload)) as { payload: string };
    tampered.payload = Buffer.from(JSON.stringify({ ...payload, seq: 43 })).toString('base64url');
    expect(reason(JSON.stringify(tampered))).toBe('signature');
    expect(reason(jws(payload), 43)).toBe('rollback');
    expect(reason(jws(payload), 42)).toBe('ok');
    expect(reason(jws(payload), 0, Date.parse(payload.expiresAt) + GRACE_MS + 1)).toBe('expired');
    expect(reason(jws(payload), 0, Date.parse(payload.expiresAt) + GRACE_MS - 1)).toBe('ok');
    expect(reason('{}')).toBe('signature');
  });
  it('схема полезной нагрузки', () => {
    const reason = (body: object) => {
      try {
        parseCatalogPayload(JSON.stringify(body));
      } catch (error) {
        return (error as CatalogError).reason;
      }
      return 'ok';
    };
    const one = payload.servers[0]!;
    expect(reason({ ...payload, format: 'x' })).toBe('format');
    expect(reason({ ...payload, servers: [{ ...one, url: 'http://cord.nikg.tech/' }] })).toBe('url');
    expect(reason({ ...payload, servers: [{ ...one, url: 'https://cord.nikg.tech' }] })).toBe('url');
    expect(reason({ ...payload, servers: [{ ...one, country: 'nl' }] })).toBe('country');
    expect(reason({ ...payload, servers: [{ ...one, name: { en: 'x' } }] })).toBe('name');
    expect(reason({ ...payload, servers: [{ ...one, id: 'NL_1' }] })).toBe('id');
    expect(reason({ ...payload, servers: [{ ...one, default: false }] })).toBe('default');
    expect(reason({ ...payload, servers: [one, { ...one, id: 'nl-2' }] })).toBe('default');
    expect(reason({ ...payload, servers: [] })).toBe('servers');
  });
});

const file = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const jwks = (...pairs: { publicKey: import('node:crypto').KeyObject }[]) =>
  JSON.stringify({ keys: pairs.map((item) => ({ ...item.publicKey.export({ format: 'jwk' }), alg: 'EdDSA', kid: 'test' })) });

describe('ключи каталога и вшитый снимок', () => {
  it('снимок в сборке подписан ключом из build/catalog-keys.json — копии из ядра совпадают', () => {
    const keys = parseCatalogKeys(file('build/catalog-keys.json'));
    expect(keys.length).toBeGreaterThan(0);
    const catalog = verifyCatalog(file('src/shell/catalog.jws'), keys, 0, Date.parse('2026-10-21T00:00:00Z'));
    expect(defaultServer(catalog).url).toBe('https://cord.nikg.tech/');
  });
  it('JWKS: только Ed25519; пустой или чужой список — отказ', () => {
    expect(parseCatalogKeys(jwks(pair, stranger))).toHaveLength(2);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'jwk' });
    expect(() => parseCatalogKeys(JSON.stringify({ keys: [rsa] }))).toThrow(CatalogError);
    expect(() => parseCatalogKeys('{"keys":[]}')).toThrow(CatalogError);
    expect(() => parseCatalogKeys('не json')).toThrow(CatalogError);
  });
});

describe('pickCatalog', () => {
  const older = jws({ ...payload, seq: 3 });
  const newer = jws({ ...payload, seq: 7 });
  it('из кэша и снимка — самый новый подписанный', () => {
    expect(pickCatalog([{ source: 'cache', jws: newer }, { source: 'snapshot', jws: older }], keys, 0, now)).toMatchObject({ source: 'cache', jws: newer, catalog: { seq: 7 } });
    expect(pickCatalog([{ source: 'cache', jws: older }, { source: 'snapshot', jws: newer }], keys, 0, now)).toMatchObject({ source: 'snapshot', catalog: { seq: 7 } });
  });
  it('битый или чужой кэш — снимок; всё плохое — null', () => {
    expect(pickCatalog([{ source: 'cache', jws: '{' }, { source: 'snapshot', jws: older }], keys, 0, now)?.source).toBe('snapshot');
    expect(pickCatalog([{ source: 'cache', jws: jws(payload, stranger) }, { source: 'snapshot', jws: null }], keys, 0, now)).toBeNull();
  });
  it('откат: каталог старее принятого не берётся', () => {
    expect(pickCatalog([{ source: 'snapshot', jws: older }], keys, 4, now)).toBeNull();
    expect(pickCatalog([{ source: 'cache', jws: newer }, { source: 'snapshot', jws: older }], keys, 7, now)?.catalog.seq).toBe(7);
  });
});

describe('fetchCatalog', () => {
  it('спрашивает серверы по очереди и берёт первый подписанный', async () => {
    const calls: string[] = [];
    const result = await fetchCatalog(
      ['https://offline.example/', 'https://cord.nikg.tech/'],
      async (url) => {
        calls.push(url);
        if (url.startsWith('https://offline')) throw new Error('нет сети');
        return { ok: true, status: 200, text: async () => jws(payload) };
      },
      keys,
      0,
      now,
    );
    expect(calls).toEqual(['https://offline.example/api/v1/catalog', 'https://cord.nikg.tech/api/v1/catalog']);
    expect(result?.catalog.seq).toBe(42);
  });
  it('404, чужая подпись, откат — null и запись в журнал', async () => {
    const notes: string[] = [];
    const answers = [
      { ok: false, status: 404, text: async () => '' },
      { ok: true, status: 200, text: async () => jws(payload, stranger) },
    ];
    const result = await fetchCatalog(['https://a.example/', 'https://b.example/'], async () => answers.shift()!, keys, 0, now, (line) => notes.push(line));
    expect(result).toBeNull();
    expect(notes.join('\n')).toMatch(/404/);
    expect(notes.join('\n')).toMatch(/Подпись/);
    expect(await fetchCatalog(['https://a.example/'], async () => ({ ok: true, status: 200, text: async () => jws(payload) }), keys, 43, now)).toBeNull();
  });
});

describe('CaptureSelection', () => {
  it('выбор живёт 10 секунд и забирается один раз', () => {
    const selection = new CaptureSelection();
    selection.select('screen:0:0', 'system', 1000);
    expect(selection.take(1000 + SELECTION_TTL_MS)).toEqual({ id: 'screen:0:0', audio: 'system', at: 1000 });
    expect(selection.take(2000)).toBeNull();
    selection.select('screen:0:0', 'none', 1000);
    expect(selection.take(1000 + SELECTION_TTL_MS + 1)).toBeNull();
  });
  it('системный звук — только на Windows и только для режима system', () => {
    expect(loopbackFor('system', 'win32')).toBe('loopback');
    expect(loopbackFor('system', 'linux')).toBeNull();
    expect(loopbackFor('system-except-cord', 'win32')).toBeNull();
    expect(loopbackFor('none', 'win32')).toBeNull();
  });
});
