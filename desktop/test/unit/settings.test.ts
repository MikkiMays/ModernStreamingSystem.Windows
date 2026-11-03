import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appSettingsOf } from '../../src/main/app-settings';
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
    const mini = { enabled: true, expanded: true, x: 10, y: 20 };
    expect(migrateSettings({ settingsRev: SETTINGS_REV, overlayEnabled: false, mini })).toEqual({ settingsRev: SETTINGS_REV, overlayEnabled: false, mini });
  });

  it('ревизия 2 и раньше — мини-окно выключается один раз, место и развёрнутость остаются (R188)', () => {
    expect(migrateSettings({ settingsRev: 2, mini: { enabled: true, expanded: true, x: 1500, y: 300 } })).toEqual({ settingsRev: SETTINGS_REV, mini: { enabled: false, expanded: true, x: 1500, y: 300 } });
    expect(migrateSettings({ mini: { enabled: true, expanded: false } }).mini).toEqual({ enabled: false, expanded: false });
    // Без записи о мини-окне — умолчание, а оно и так «выключено».
    expect(migrateSettings({ settingsRev: 2, tray: true })).toEqual({ settingsRev: SETTINGS_REV, tray: true });
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
    expect(store.get().mini, 'мини-окно звонка по умолчанию выключено (R188)').toEqual({ enabled: false, expanded: false });
    expect(appSettingsOf(store.get()).mini, 'веб в «Windows» видит переключатель выключенным').toBe(false);
  });

  it('файл ревизии 2 с «mini.enabled: true» — после чтения мини-окно выключено, место осталось; включённое после этого — остаётся включённым (R188)', () => {
    const root = dir();
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ settingsRev: 2, mini: { enabled: true, expanded: true, x: 1500, y: 300 } }));
    const store = new SettingsStore(root, secrets);
    expect(store.get().mini).toEqual({ enabled: false, expanded: true, x: 1500, y: 300 });
    store.update({ mini: { ...store.get().mini, enabled: true } });
    const written = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8')) as Record<string, unknown>;
    expect(written.settingsRev).toBe(SETTINGS_REV);
    expect(new SettingsStore(root, secrets).get().mini).toEqual({ enabled: true, expanded: true, x: 1500, y: 300 });
  });

  it('мини-окно без «enabled» или с чужим значением — выключено (R188)', () => {
    const root = dir();
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ settingsRev: SETTINGS_REV, mini: { expanded: true } }));
    expect(new SettingsStore(root, secrets).get().mini).toEqual({ enabled: false, expanded: true });
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ settingsRev: SETTINGS_REV, mini: { enabled: 'yes', x: 5, y: 6 } }));
    expect(new SettingsStore(root, secrets).get().mini).toEqual({ enabled: false, expanded: false, x: 5, y: 6 });
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
