#!/usr/bin/env node
// Подписывает latest.yml зеркала Cord (ADR 0001 §5, слой 1) ключом Ed25519 и дописывает в него
// sha256 каждого файла — так клиент сверяет скачанный установщик и по sha512 electron-updater, и по
// sha256 из подписанного описания. Подпись — над точными байтами итогового latest.yml, в latest.yml.sig
// (base64). Ключ — секрет CI `CORD_UPDATE_SIGN_KEY` (PKCS#8 PEM) или путь в `--key`.
//
//   node scripts/sign-manifest.mjs release [--key path.pem]
//
// Без ключа — выход 2: неподписанное описание клиент не примет (fail-closed), и выкладка не должна
// молча пройти.
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const directory = args.find((argument) => !argument.startsWith('--')) ?? 'release';
const keyIndex = args.indexOf('--key');
const keyPem = keyIndex >= 0 ? readFileSync(args[keyIndex + 1], 'utf8') : (process.env.CORD_UPDATE_SIGN_KEY ?? '');
if (!keyPem.trim()) {
  console.error('sign-manifest: нет ключа (CORD_UPDATE_SIGN_KEY или --key)');
  process.exit(2);
}
const key = createPrivateKey(keyPem);
if (key.asymmetricKeyType !== 'ed25519') {
  console.error('sign-manifest: ключ — не Ed25519');
  process.exit(2);
}
const manifestPath = join(directory, 'latest.yml');
if (!existsSync(manifestPath)) {
  console.error(`sign-manifest: нет ${manifestPath}`);
  process.exit(2);
}
let text = readFileSync(manifestPath, 'utf8');
// Дописываем sha256 после size у каждого файла (формат electron-builder: отступ в четыре пробела).
const names = [...text.matchAll(/^  - url: (.+)$/gm)].map((match) => match[1].trim());
for (const name of names) {
  const file = join(directory, name);
  if (!existsSync(file)) {
    console.error(`sign-manifest: нет файла ${name}`);
    process.exit(2);
  }
  const digest = createHash('sha256').update(readFileSync(file)).digest('hex');
  const size = statSync(file).size;
  const block = new RegExp(`(^  - url: ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n(?:    .+\\n)*?    size: )(\\d+)\\n`, 'm');
  const match = text.match(block);
  if (!match) {
    console.error(`sign-manifest: не нашёл size у ${name}`);
    process.exit(2);
  }
  if (Number(match[2]) !== size) {
    console.error(`sign-manifest: размер ${name} в описании ${match[2]} ≠ ${size}`);
    process.exit(2);
  }
  text = text.replace(block, `$1$2\n    sha256: ${digest}\n`);
}
writeFileSync(manifestPath, text);
const signature = sign(null, Buffer.from(text, 'utf8'), key).toString('base64');
writeFileSync(manifestPath + '.sig', signature + '\n');
console.log(`sign-manifest: подписан ${manifestPath} (${names.length} файлов: ${names.join(', ')}); прочее в каталоге: ${readdirSync(directory).filter((entry) => !entry.startsWith('latest')).join(', ')}`);
