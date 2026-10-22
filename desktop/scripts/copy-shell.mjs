// Копирует локальные страницы оболочки (`cord-app://shell/…`) в dist рядом с main и preload и пишет то,
// что связывает сборку с конкретной установкой Cord. Адресов в репозитории нет: сервер по умолчанию —
// переменная сборки CORD_DEFAULT_SERVER (в CI — переменная репозитория), канал обновлений —
// CORD_UPDATE_CHANNEL или `<сервер>downloads/windows/desktop/`. Снимок каталога серверов для первого
// запуска берётся с того же сервера (`/api/v1/catalog`); нет его — клиент обойдётся сервером из сборки.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const server = (process.env.CORD_DEFAULT_SERVER ?? '').trim();
if (server) {
  keys.defaultServer = origin(server, 'CORD_DEFAULT_SERVER');
  const channel = (process.env.CORD_UPDATE_CHANNEL ?? '').trim();
  keys.channel = channel || new URL('downloads/windows/desktop/', keys.defaultServer).toString();
  if (!keys.channel.startsWith('https://')) throw new Error(`CORD_UPDATE_CHANNEL: нужен https — ${keys.channel}`);
} else if (process.env.GITHUB_ACTIONS === 'true') {
  console.error('copy-shell: не задан CORD_DEFAULT_SERVER — переменная репозитория (Settings → Variables), например https://meet.example.com/');
  process.exit(1);
} else {
  console.warn('copy-shell: CORD_DEFAULT_SERVER не задан — сборка без сервера по умолчанию (годится только для разработки)');
}
writeFileSync(join(root, 'dist', 'update-keys.json'), `${JSON.stringify(keys, null, 2)}\n`);

if (keys.defaultServer) {
  try {
    const response = await fetch(new URL('api/v1/catalog', keys.defaultServer), { signal: AbortSignal.timeout(10_000) });
    if (response.ok) {
      writeFileSync(join(root, 'dist', 'shell', 'catalog.jws'), await response.text());
      console.log('copy-shell: снимок каталога серверов взят с', keys.defaultServer);
    } else console.warn(`copy-shell: каталога на ${keys.defaultServer} нет (${response.status}) — без снимка`);
  } catch (error) {
    console.warn(`copy-shell: каталог с ${keys.defaultServer} не получен (${error.message}) — без снимка`);
  }
}
console.log('shell pages copied');
