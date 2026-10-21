/**
 * Каталог серверов (T05, П4, ADR 0001 §8): JWS в JSON-сериализации (RFC 7515), `alg: EdDSA`
 * (Ed25519). Подписываются точные байты `payload`, так что канонизация не нужна. Ключи —
 * вшитый список `[текущий, следующий]`; `seq` только растёт; срок — `expiresAt` плюс 30 дней
 * льготы. Неверный или просроченный каталог не принимается: остаётся последний хороший.
 *
 * Ручного добавления сервера нет нигде: только выбор из этого списка.
 */
import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import { ServerOrigin } from './origins';

export interface CatalogServer {
  id: string;
  name: Record<string, string> & { ru: string };
  country: string;
  url: string;
  order: number;
  default: boolean;
}

export interface Catalog {
  format: 'cord.servers/1';
  seq: number;
  issuedAt: string;
  expiresAt: string;
  servers: CatalogServer[];
}

export const GRACE_MS = 30 * 24 * 60 * 60 * 1000;

export class CatalogError extends Error {
  constructor(message: string, public readonly reason: string) {
    super(message);
    this.name = 'CatalogError';
  }
}

function base64url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new CatalogError('Каталог не читается.', 'encoding');
  return Buffer.from(value, 'base64url');
}

/** Разбор полезной нагрузки без доверия: каждое поле по схеме `contracts/server-catalog.v1.schema.json`. */
export function parseCatalogPayload(json: string): Catalog {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new CatalogError('Каталог не читается.', 'json');
  }
  if (!raw || typeof raw !== 'object') throw new CatalogError('Каталог не читается.', 'json');
  const data = raw as Record<string, unknown>;
  if (data.format !== 'cord.servers/1') throw new CatalogError('Неизвестный формат каталога.', 'format');
  if (typeof data.seq !== 'number' || !Number.isInteger(data.seq) || data.seq < 0) throw new CatalogError('Неверный номер каталога.', 'seq');
  for (const field of ['issuedAt', 'expiresAt']) {
    if (typeof data[field] !== 'string' || Number.isNaN(Date.parse(data[field] as string))) throw new CatalogError('Неверная дата каталога.', field);
  }
  if (!Array.isArray(data.servers) || data.servers.length === 0 || data.servers.length > 50) throw new CatalogError('В каталоге нет серверов.', 'servers');
  const ids = new Set<string>();
  const servers: CatalogServer[] = data.servers.map((item) => {
    const server = (item ?? {}) as Record<string, unknown>;
    if (typeof server.id !== 'string' || !/^[a-z0-9-]{1,32}$/.test(server.id) || ids.has(server.id)) throw new CatalogError('Неверный идентификатор сервера.', 'id');
    ids.add(server.id);
    const name = server.name as Record<string, unknown> | undefined;
    if (!name || typeof name !== 'object' || typeof name.ru !== 'string' || !name.ru.trim() || name.ru.length > 40) throw new CatalogError('У сервера нет имени.', 'name');
    for (const value of Object.values(name)) if (typeof value !== 'string' || value.length > 40) throw new CatalogError('У сервера нет имени.', 'name');
    if (typeof server.country !== 'string' || !/^[A-Z]{2}$/.test(server.country)) throw new CatalogError('Неверная страна сервера.', 'country');
    const origin = ServerOrigin.tryParse(server.url);
    if (!origin || !origin.origin.startsWith('https://') || server.url !== origin.url) throw new CatalogError('Неверный адрес сервера.', 'url');
    if (typeof server.order !== 'number' || !Number.isFinite(server.order)) throw new CatalogError('Неверный порядок серверов.', 'order');
    return { id: server.id, name: name as CatalogServer['name'], country: server.country, url: origin.url, order: server.order, default: server.default === true };
  });
  if (servers.filter((server) => server.default).length !== 1) throw new CatalogError('В каталоге нет сервера по умолчанию.', 'default');
  servers.sort((a, b) => a.order - b.order);
  return { format: 'cord.servers/1', seq: data.seq, issuedAt: data.issuedAt as string, expiresAt: data.expiresAt as string, servers };
}

/**
 * Проверить JWS и вернуть каталог. `lastSeq` — последний принятый номер: меньший — откат, отказ.
 */
export function verifyCatalog(jws: string, keys: readonly KeyObject[], lastSeq: number, now: number = Date.now()): Catalog {
  let envelope: unknown;
  try {
    envelope = JSON.parse(jws);
  } catch {
    throw new CatalogError('Каталог не читается.', 'json');
  }
  const data = (envelope ?? {}) as Record<string, unknown>;
  if (typeof data.payload !== 'string' || !Array.isArray(data.signatures) || data.signatures.length === 0) throw new CatalogError('Каталог не подписан.', 'signature');
  const payload = base64url(data.payload);
  const signed = data.signatures.some((item) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    if (typeof entry.protected !== 'string' || typeof entry.signature !== 'string') return false;
    let header: Record<string, unknown>;
    try {
      header = JSON.parse(base64url(entry.protected).toString('utf8')) as Record<string, unknown>;
    } catch {
      return false;
    }
    if (header.alg !== 'EdDSA') return false;
    const signature = base64url(entry.signature);
    if (signature.length !== 64) return false;
    const input = Buffer.from(`${entry.protected}.${data.payload}`, 'ascii');
    return keys.some((key) => {
      try {
        return verifySignature(null, input, key, signature);
      } catch {
        return false;
      }
    });
  });
  if (!signed) throw new CatalogError('Подпись каталога не подтверждена.', 'signature');
  const catalog = parseCatalogPayload(payload.toString('utf8'));
  if (catalog.seq < lastSeq) throw new CatalogError('Каталог старее уже принятого.', 'rollback');
  if (Date.parse(catalog.expiresAt) + GRACE_MS < now) throw new CatalogError('Срок каталога истёк.', 'expired');
  return catalog;
}

/**
 * Ключи из `build/catalog-keys.json` — копии `contracts/catalog-keys.json` ядра: JWKS (RFC 8037),
 * только Ed25519, порядок `[текущий, следующий]`. Пустой или чужой список — ошибка сборки, а не
 * «принимать что угодно».
 */
export function parseCatalogKeys(json: string): KeyObject[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new CatalogError('Ключи каталога не читаются.', 'keys');
  }
  const list = (data as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(list)) throw new CatalogError('Ключи каталога не читаются.', 'keys');
  const keys: KeyObject[] = [];
  for (const item of list) {
    const jwk = (item ?? {}) as Record<string, unknown>;
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') throw new CatalogError('Ключ каталога — не Ed25519.', 'keys');
    keys.push(createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' }));
  }
  if (keys.length === 0) throw new CatalogError('Нет ключей каталога.', 'keys');
  return keys;
}

export interface CatalogCandidate {
  source: 'cache' | 'snapshot' | 'network';
  jws: string | null;
}

export interface AcceptedCatalog {
  source: CatalogCandidate['source'];
  jws: string;
  catalog: Catalog;
}

/**
 * Последний хороший каталог при запуске: из сохранённого с прошлого раза (`catalog.jws` в
 * `userData`) и снимка из установщика — самый новый из тех, что проходят проверку. Ни одного —
 * `null`, и оболочка берёт сервер из сборки.
 */
export function pickCatalog(candidates: readonly CatalogCandidate[], keys: readonly KeyObject[], lastSeq: number, now: number = Date.now()): AcceptedCatalog | null {
  let best: AcceptedCatalog | null = null;
  for (const candidate of candidates) {
    if (!candidate.jws) continue;
    try {
      const catalog = verifyCatalog(candidate.jws, keys, lastSeq, now);
      if (!best || catalog.seq > best.catalog.seq) best = { source: candidate.source, jws: candidate.jws, catalog };
    } catch {
      /* битый, чужой, старый или просроченный — следующий */
    }
  }
  return best;
}

export interface CatalogResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/**
 * Свежий каталог из ядра: `GET /api/v1/catalog` у серверов по очереди (текущий, затем главный из
 * сборки). Подпись офлайн, поэтому годится ответ любого сервера Cord — подменить его сервер не
 * может. Первый прошедший проверку — ответ; никто — `null`, остаётся прежний.
 */
export async function fetchCatalog(
  origins: readonly string[],
  fetcher: (url: string) => Promise<CatalogResponse>,
  keys: readonly KeyObject[],
  lastSeq: number,
  now: number = Date.now(),
  log: (line: string) => void = () => {},
): Promise<AcceptedCatalog | null> {
  for (const origin of origins) {
    const url = new URL('/api/v1/catalog', origin).toString();
    try {
      const response = await fetcher(url);
      if (!response.ok) {
        log(`каталог ${url}: ответ ${response.status}`);
        continue;
      }
      const jws = await response.text();
      if (jws.length > 256 * 1024) {
        log(`каталог ${url}: слишком большой`);
        continue;
      }
      return { source: 'network', jws, catalog: verifyCatalog(jws, keys, lastSeq, now) };
    } catch (error) {
      log(`каталог ${url}: ${(error as Error).message}`);
    }
  }
  return null;
}

/** Сервер первого запуска: `default`, пока нет замера пинга (ADR §8 — по наименьшему пингу среди соседей). */
export function defaultServer(catalog: Catalog): CatalogServer {
  return catalog.servers.find((server) => server.default) ?? catalog.servers[0]!;
}
