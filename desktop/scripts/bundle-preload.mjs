// Preload в песочнице не умеет require() соседних файлов — он обязан быть одним файлом.
// esbuild собирает server.ts и shell.ts вместе с shared/bridge.ts в dist/preload/*.js.
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await build({
  entryPoints: [join(root, 'src/preload/server.ts'), join(root, 'src/preload/shell.ts')],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'chrome132',
  external: ['electron'],
  outdir: join(root, 'dist/preload'),
  logLevel: 'warning',
});
console.log('preload bundled');
