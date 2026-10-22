// Проверка состава `dist` перед упаковкой (R58): всё, что main ищет по пути в asar, должно быть на
// месте — иначе ошибка всплывёт только у человека (как прозрачный значок трея в 1.0.3).
//   node scripts/check-dist.mjs
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const required = [
  'main/index.js',
  'preload/server.js',
  'preload/shell.js',
  'native/host.js',
  'shell/tray.ico',
  'shell/icon-256.png',
  'shell/splash.html',
  'shell/loading.html',
  'shell/offline.html',
  'shell/overlay.html',
  'shell/servers.html',
  'catalog-keys.json',
  'update-keys.json',
];

const missing = required.filter((file) => !existsSync(join(dist, file)));
if (missing.length) {
  console.error(`dist: нет файлов — ${missing.join(', ')}`);
  process.exit(1);
}

// tray.ico: каталог ICO с маленькими размерами в BMP и 256 в PNG.
const ico = readFileSync(join(dist, 'shell', 'tray.ico'));
const count = ico.readUInt16LE(4);
const sizes = [];
for (let index = 0; index < count; index++) {
  const at = 6 + index * 16;
  const width = ico[at] || 256;
  const offset = ico.readUInt32LE(at + 12);
  const png = ico[offset] === 0x89 && ico[offset + 1] === 0x50;
  sizes.push(`${width}${png ? 'png' : 'bmp'}`);
}
for (const size of [16, 24, 32, 48]) {
  if (!sizes.includes(`${size}bmp`)) {
    console.error(`dist/shell/tray.ico: нет записи ${size}×${size} BMP (есть: ${sizes.join(', ')})`);
    process.exit(1);
  }
}
console.log(`dist: ${required.length} файлов на месте; tray.ico — ${sizes.join(', ')}`);
