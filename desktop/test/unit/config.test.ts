import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_ID, buildConfig, resetBuildConfigForTests } from '../../src/main/config';

describe('APP_ID — один идентификатор приложения для ярлыков и уведомлений (R59)', () => {
  it('совпадает с appId в electron-builder.yml: ярлыки получают его от установщика, процесс — от app.setAppUserModelId', () => {
    const yml = load(readFileSync(join(__dirname, '..', '..', 'electron-builder.yml'), 'utf8')) as { appId?: unknown };
    expect(yml.appId).toBe(APP_ID);
  });

  it('это обратное доменное имя, а не отображаемое имя', () => {
    expect(APP_ID).toMatch(/^[a-z]+(\.[a-z]+)+$/);
    expect(APP_ID).not.toBe('Cord');
  });
});

describe('сервер сборки — продукт cord.online из build/update-keys.json (R200 §8.6, Р-110)', () => {
  const build = JSON.parse(readFileSync(join(__dirname, '..', '..', 'build', 'update-keys.json'), 'utf8')) as { defaultServer?: unknown; keys?: unknown };
  const saved = { server: process.env.CORD_DEFAULT_SERVER, channel: process.env.CORD_UPDATE_CHANNEL };
  const dirs: string[] = [];

  afterEach(() => {
    for (const key of ['CORD_DEFAULT_SERVER', 'CORD_UPDATE_CHANNEL'] as const) delete process.env[key];
    if (saved.server !== undefined) process.env.CORD_DEFAULT_SERVER = saved.server;
    if (saved.channel !== undefined) process.env.CORD_UPDATE_CHANNEL = saved.channel;
    resetBuildConfigForTests();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** `appPath` с `dist/update-keys.json` — таким, каким его пишет copy-shell из файла сборки. */
  function appPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cord-config-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'update-keys.json'), JSON.stringify({ ...build, channel: `${build.defaultServer as string}downloads/windows/desktop/` }));
    return dir;
  }

  it('в репозитории записан продукт, а не стенд разработки', () => {
    expect(build.defaultServer).toBe('https://cord.online/');
    expect(Array.isArray(build.keys) && build.keys.length > 0).toBe(true);
  });

  it('сборка берёт сервер и канал из файла; это сервер сборки, не окружения', () => {
    delete process.env.CORD_DEFAULT_SERVER;
    delete process.env.CORD_UPDATE_CHANNEL;
    resetBuildConfigForTests();
    const config = buildConfig(appPath());
    expect(config.defaultServer).toBe('https://cord.online/');
    expect(config.updateChannel).toBe('https://cord.online/downloads/windows/desktop/');
    expect(config.devServer).toBe(false);
  });

  it('CORD_DEFAULT_SERVER перекрывает файл и помечает сервер как сервер разработки', () => {
    process.env.CORD_DEFAULT_SERVER = 'https://cord.nikg.tech/';
    delete process.env.CORD_UPDATE_CHANNEL;
    resetBuildConfigForTests();
    const config = buildConfig(appPath());
    expect(config.defaultServer).toBe('https://cord.nikg.tech/');
    expect(config.devServer).toBe(true);
    // Канал из файла сборки остаётся: обновления не следуют за сервером встреч (правило CordDefaults.cs).
    expect(config.updateChannel).toBe('https://cord.online/downloads/windows/desktop/');
  });
});
