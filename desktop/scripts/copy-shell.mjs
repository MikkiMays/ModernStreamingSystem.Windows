// Копирует локальные страницы оболочки (`cord-app://shell/…`) в dist рядом с main и preload и пишет то,
// что связывает сборку с конкретной установкой Cord. Сервер по умолчанию — продукт из
// `build/update-keys.json` (`defaultServer`, https://cord.online/ — R200, Р-110: продукт один, стенд
// разработки людям не отдаётся); переменная сборки CORD_DEFAULT_SERVER перекрывает его (другая установка,
// ветка deploy/<имя>, — через workflow из build/installations/<имя>.json). Канал обновлений —
// CORD_UPDATE_CHANNEL или `<сервер>downloads/windows/desktop/`. Снимок каталога серверов для первого
// запуска — с того же сервера (`/api/v1/catalog`) или, у сборки продукта, `build/catalog.jws` (ниже).
import { createPublicKey, verify } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
mkdirSync(join(root, 'dist', 'shell'), { recursive: true });
cpSync(join(root, 'src', 'shell'), join(root, 'dist', 'shell'), { recursive: true });
// Ключи каталога серверов — копия contracts/catalog-keys.json ядра.
cpSync(join(root, 'build', 'catalog-keys.json'), join(root, 'dist', 'catalog-keys.json'));

function origin(raw, name) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name}: не адрес — ${raw}`);
  }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username)
    throw new Error(`${name}: нужен https-адрес сервера без пути, например https://meet.example.com/ — получено ${raw}`);
  return `${url.origin}/`;
}

const keys = JSON.parse(readFileSync(join(root, 'build', 'update-keys.json'), 'utf8'));
const product = typeof keys.defaultServer === 'string' && keys.defaultServer.trim() ? origin(keys.defaultServer.trim(), 'build/update-keys.json defaultServer') : '';
const override = (process.env.CORD_DEFAULT_SERVER ?? '').trim();
const server = override || product;
if (server) {
  keys.defaultServer = origin(server, override ? 'CORD_DEFAULT_SERVER' : 'build/update-keys.json defaultServer');
  const channel = (process.env.CORD_UPDATE_CHANNEL ?? '').trim();
  keys.channel = channel || new URL('downloads/windows/desktop/', keys.defaultServer).toString();
  if (!keys.channel.startsWith('https://')) throw new Error(`CORD_UPDATE_CHANNEL: нужен https — ${keys.channel}`);
  console.log(`copy-shell: сервер ${keys.defaultServer} (${override ? 'CORD_DEFAULT_SERVER' : 'build/update-keys.json'}), канал ${keys.channel}`);
} else if (process.env.GITHUB_ACTIONS === 'true') {
  console.error('copy-shell: нет сервера — ни defaultServer в build/update-keys.json, ни CORD_DEFAULT_SERVER');
  process.exit(1);
} else {
  delete keys.defaultServer;
  console.warn('copy-shell: сервера нет — сборка без сервера по умолчанию (годится только для разработки)');
}
writeFileSync(join(root, 'dist', 'update-keys.json'), `${JSON.stringify(keys, null, 2)}\n`);

// Снимок каталога — с сервера сборки, а у сборки продукта ещё и `build/catalog.jws` (подписанный каталог
// продукта в репе): из годных — с бо́льшим seq. Годный — тот, что примет клиент (`verifyCatalog`): подпись EdDSA
// ключом из `build/catalog-keys.json` над `protected.payload` и срок `expiresAt` не прошёл. Без снимка клиент,
// обновлённый с прошлой сборки, верит её сохранённому каталогу и открывает её сервер — так 1.2.3 открывал убранный
// cord.nikg.tech (CI тогда не достучался до cord.online). Поэтому сборка продукта в CI без годного снимка не выходит.
const catalogKeys = JSON.parse(readFileSync(join(root, 'build', 'catalog-keys.json'), 'utf8')).keys.map((jwk) => createPublicKey({ key: jwk, format: 'jwk' }));
/** seq снимка, который примет клиент; иначе −1. */
const seqOf = (jws) => {
  try {
    const data = JSON.parse(jws);
    const signed = data.signatures.some((entry) => {
      if (JSON.parse(Buffer.from(entry.protected, 'base64url').toString('utf8')).alg !== 'EdDSA') return false;
      const input = Buffer.from(`${entry.protected}.${data.payload}`, 'ascii');
      return catalogKeys.some((key) => verify(null, input, key, Buffer.from(entry.signature, 'base64url')));
    });
    const payload = JSON.parse(Buffer.from(data.payload, 'base64url').toString('utf8'));
    return signed && Number.isInteger(payload.seq) && Date.parse(payload.expiresAt) > Date.now() ? payload.seq : -1;
  } catch {
    return -1;
  }
};
if (keys.defaultServer) {
  const snapshots = [];
  try {
    const response = await fetch(new URL('api/v1/catalog', keys.defaultServer), { signal: AbortSignal.timeout(10_000) });
    if (response.ok) snapshots.push({ source: keys.defaultServer, jws: await response.text() });
    else console.warn(`copy-shell: каталога на ${keys.defaultServer} нет (${response.status})`);
  } catch (error) {
    console.warn(`copy-shell: каталог с ${keys.defaultServer} не получен (${error.message})`);
  }
  const committed = join(root, 'build', 'catalog.jws');
  if (keys.defaultServer === product && existsSync(committed)) snapshots.push({ source: 'build/catalog.jws', jws: readFileSync(committed, 'utf8') });
  const best = snapshots.filter((item) => seqOf(item.jws) >= 0).sort((a, b) => seqOf(b.jws) - seqOf(a.jws))[0];
  if (best) {
    writeFileSync(join(root, 'dist', 'shell', 'catalog.jws'), best.jws);
    console.log(`copy-shell: снимок каталога серверов seq ${seqOf(best.jws)} — ${best.source}`);
  } else if (process.env.GITHUB_ACTIONS === 'true' && keys.defaultServer === product) {
    console.error('copy-shell: нет годного снимка каталога продукта — ни с сервера, ни build/catalog.jws');
    process.exit(1);
  } else console.warn('copy-shell: без снимка каталога');
}
console.log('shell pages copied');
