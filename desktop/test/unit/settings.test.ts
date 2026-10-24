import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateSettings, SETTINGS_REV, SettingsStore } from '../../src/main/settings';

const secrets = { isEncryptionAvailable: () => false, encryptString: (plain: string) => Buffer.from(plain), decryptString: (data: Buffer) => data.toString() };
const dirs: string[] = [];
const dir = () => {
  const path = mkdtempSync(join(tmpdir(), 'cord-settings-'));
  dirs.push(path);
  return path;
};
afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('migrateSettings — ревизии умолчаний', () => {
  it('файл без ревизии (1.0.x) — оверлей включается, ревизия становится текущей (R61)', () => {
    expect(migrateSettings({ overlayEnabled: false, tray: false })).toEqual({ overlayEnabled: true, tray: false, settingsRev: SETTINGS_REV });
  });

  it('файл текущей ревизии — выбор человека не трогается', () => {
    expect(migrateSettings({ settingsRev: SETTINGS_REV, overlayEnabled: false })).toEqual({ settingsRev: SETTINGS_REV, overlayEnabled: false });
  });
});

describe('SettingsStore', () => {
  it('нет файла — умолчания: оверлей и трей включены, язык не задан, первый запуск', () => {
    const store = new SettingsStore(dir(), secrets);
    expect(store.fresh).toBe(true);
    expect(store.get().overlayEnabled).toBe(true);
    expect(store.get().tray).toBe(true);
    expect(store.get().language).toBeNull();
    expect(store.get().uiLanguage).toBeNull();
    expect(store.get().notifications).toBe(true);
    expect(store.get().trayHintShown).toBe(false);
    expect(store.get().settingsRev).toBe(SETTINGS_REV);
  });

  it('старый файл с overlayEnabled: false без ревизии — после чтения оверлей включён и ревизия записывается при первом изменении', () => {
    const root = dir();
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ overlayEnabled: false, tray: true, theme: 'dark' }));
    const store = new SettingsStore(root, secrets);
    expect(store.fresh).toBe(false);
    expect(store.get().overlayEnabled).toBe(true);
    expect(store.get().theme).toBe('dark');
    store.update({ trayHintShown: true });
    const written = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')) as Record<string, unknown>;
    expect(written.settingsRev).toBe(SETTINGS_REV);
    expect(written.overlayEnabled).toBe(true);
  });

  it('файл текущей ревизии: выключенный человеком оверлей остаётся выключенным', () => {
    const root = dir();
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ settingsRev: SETTINGS_REV, overlayEnabled: false }));
    expect(new SettingsStore(root, secrets).get().overlayEnabled).toBe(false);
  });

  it('язык — только из восьми кодов веба; чужое значение отбрасывается', () => {
    const root = dir();
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ settingsRev: SETTINGS_REV, language: 'de' }));
    expect(new SettingsStore(root, secrets).get().language).toBe('de');
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ settingsRev: SETTINGS_REV, language: 'xx' }));
    expect(new SettingsStore(root, secrets).get().language).toBeNull();
  });

  it('язык страницы для трея и «Уведомления» (R103) читаются из файла; чужое — отбрасывается', () => {
    const root = dir();
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ settingsRev: SETTINGS_REV, uiLanguage: 'zh-Hans', notifications: false }));
    expect(new SettingsStore(root, secrets).get()).toMatchObject({ uiLanguage: 'zh-Hans', notifications: false });
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ settingsRev: SETTINGS_REV, uiLanguage: 'klingon', notifications: 'no' }));
    expect(new SettingsStore(root, secrets).get()).toMatchObject({ uiLanguage: null, notifications: true });
  });
});
