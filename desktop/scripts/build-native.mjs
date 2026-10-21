// Сборка cord-native (Rust, napi-rs) без @napi-rs/cli: `cargo build --release` и копия
// `cord_native.dll` в dist/native/cord-native.win32-x64-msvc.node (ADR 0001 §4.6, §9).
// Не Windows — модуль не собирается и не нужен: оболочка работает без него (запасные пути).
// `--skip-build` — только копия (артефакт уже собран), `--check` — проверить, что модуль на месте.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const crate = join(root, 'native');
const output = join(root, 'dist', 'native', 'cord-native.win32-x64-msvc.node');
const args = new Set(process.argv.slice(2));

if (args.has('--check')) {
  if (!existsSync(output)) {
    console.error(`cord-native: нет ${output}`);
    process.exit(1);
  }
  console.log(`cord-native: ${output} (${Math.round(statSync(output).size / 1024)} КиБ)`);
  process.exit(0);
}

if (process.platform !== 'win32') {
  console.log('cord-native: собирается только на Windows — пропуск (оболочка работает без модуля)');
  process.exit(0);
}

if (!args.has('--skip-build')) {
  const cargo = spawnSync('cargo', ['build', '--release', '--manifest-path', join(crate, 'Cargo.toml')], { stdio: 'inherit', shell: true });
  if (cargo.status !== 0) {
    console.error(`cord-native: cargo build вернул ${cargo.status}`);
    process.exit(cargo.status ?? 1);
  }
}

const built = join(crate, 'target', 'release', 'cord_native.dll');
if (!existsSync(built)) {
  console.error(`cord-native: нет ${built}`);
  process.exit(1);
}
mkdirSync(dirname(output), { recursive: true });
copyFileSync(built, output);
console.log(`cord-native: ${output} (${Math.round(statSync(output).size / 1024)} КиБ)`);
