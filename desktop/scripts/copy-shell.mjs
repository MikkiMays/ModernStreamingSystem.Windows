// Копирует локальные страницы оболочки (`cord-app://shell/…`) в dist рядом с main и preload.
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
mkdirSync(join(root, 'dist', 'shell'), { recursive: true });
cpSync(join(root, 'src', 'shell'), join(root, 'dist', 'shell'), { recursive: true });
cpSync(join(root, 'build', 'update-keys.json'), join(root, 'dist', 'update-keys.json'));
// Ключи каталога серверов — копия contracts/catalog-keys.json ядра; снимок каталога едет в shell/catalog.jws.
cpSync(join(root, 'build', 'catalog-keys.json'), join(root, 'dist', 'catalog-keys.json'));
console.log('shell pages copied');
