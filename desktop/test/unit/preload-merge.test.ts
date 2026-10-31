import { describe, expect, it } from 'vitest';
import { mergeBootstrap, type KeyValueStorage } from '../../src/preload/merge';
import { TITLEBAR_HEIGHT, type Bootstrap } from '../../src/shared/bridge';

/*
  Preload страницы сервера (ADR 0001 §3.1, R146): до первого скрипта страницы кладёт bootstrap в её
  хранилище — общие настройки поверх своих у origin, токен Яндекс Музыки (R157), а устройства —
  нет: у каждого origin свои `deviceId`, общее хранит названия.
*/
class Memory implements KeyValueStorage {
  readonly map = new Map<string, string>();
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  json(key: string) {
    return JSON.parse(this.getItem(key) ?? 'null') as Record<string, unknown>;
  }
}

const base: Bootstrap = {
  profile: 'p'.repeat(43),
  theme: 'dark',
  language: null,
  showPing: false,
  notificationSounds: true,
  autoConnect: true,
  titlebarHeight: TITLEBAR_HEIGHT,
  shared: {},
  yandexMusicToken: null,
};

describe('mergeBootstrap — preload страницы сервера', () => {
  it('прежние ключи: профиль, тема, PING и сигналы, адрес сервера', () => {
    const storage = new Memory();
    mergeBootstrap(storage, { ...base, showPing: true }, 'https://cord.nikg.tech');
    expect(storage.getItem('cord:profile:v1')).toBe('p'.repeat(43));
    expect(storage.getItem('cord:theme')).toBe('dark');
    expect(storage.json('cord:preferences:v1')).toEqual({ showPing: true, notificationSounds: true });
    expect(storage.json('cord:servers:v1')).toEqual({ url: 'https://cord.nikg.tech/', autoConnect: true });
  });

  it('общие настройки (R146) — поверх своих у origin; своё, чего нет в общем, остаётся', () => {
    const storage = new Memory();
    storage.setItem('cord:preferences:v1', JSON.stringify({ outputVolume: 20, layout: 'grid', watchVolume: 33, devices: { microphone: 'local-id' } }));
    storage.setItem('cord:name', 'Старое имя');
    mergeBootstrap(storage, { ...base, shared: { outputVolume: 80, layout: 'speaker', name: 'Ника', deafened: true, language: 'de' } }, 'https://cordcam.ru');
    expect(storage.json('cord:preferences:v1')).toEqual({
      outputVolume: 80,
      layout: 'speaker',
      watchVolume: 33,
      name: 'Ника',
      deafened: true,
      language: 'de',
      devices: { microphone: 'local-id' },
      showPing: false,
      notificationSounds: true,
    });
    expect(storage.getItem('cord:name')).toBe('Ника');
  });

  it('устройства не переносятся: названия в общем, свой deviceId у origin не трогается и чужой не появляется', () => {
    const storage = new Memory();
    storage.setItem('cord:preferences:v1', JSON.stringify({ devices: { camera: 'cam-id-of-this-origin' } }));
    mergeBootstrap(storage, { ...base, shared: { devices: { camera: 'HD Webcam', microphone: 'USB Mic' } } }, 'https://cordcam.ru');
    expect(storage.json('cord:preferences:v1').devices).toEqual({ camera: 'cam-id-of-this-origin' });
  });

  it('токен Яндекс Музыки (R157): строка — кладётся (и пустая — «отключён»), null — свой у origin остаётся', () => {
    const storage = new Memory();
    storage.setItem('cord:preferences:v1', JSON.stringify({ yandexMusicToken: 'local' }));
    mergeBootstrap(storage, base, 'https://cordcam.ru');
    expect(storage.json('cord:preferences:v1').yandexMusicToken).toBe('local');
    mergeBootstrap(storage, { ...base, yandexMusicToken: 'y0_shared' }, 'https://cordcam.ru');
    expect(storage.json('cord:preferences:v1').yandexMusicToken).toBe('y0_shared');
    mergeBootstrap(storage, { ...base, yandexMusicToken: '' }, 'https://cordcam.ru');
    expect(storage.json('cord:preferences:v1').yandexMusicToken).toBe('');
  });

  it('язык установщика (R64) — один раз на origin и не поверх языка из общих настроек', () => {
    const fresh = new Memory();
    mergeBootstrap(fresh, { ...base, language: 'fr' }, 'https://cord.nikg.tech');
    expect(fresh.json('cord:preferences:v1').language).toBe('fr');
    // Человек на другом сервере выбрал «как в системе» (null) — это выбор, установщик его не перебивает.
    const chosen = new Memory();
    mergeBootstrap(chosen, { ...base, language: 'fr', shared: { language: null } }, 'https://cordcam.ru');
    expect(chosen.json('cord:preferences:v1').language).toBeNull();
    expect(chosen.getItem('cord:installer-language')).toBe('fr');
  });

  it('испорченная запись страницы — не повод падать: собирается заново', () => {
    const storage = new Memory();
    storage.setItem('cord:preferences:v1', '{не json');
    storage.setItem('cord:servers:v1', '[1,2]');
    mergeBootstrap(storage, { ...base, shared: { showPing: true } }, 'https://cord.nikg.tech');
    // Общее — новее прежнего флага оболочки: PING из общих настроек.
    expect(storage.json('cord:preferences:v1')).toEqual({ showPing: true, notificationSounds: true });
    expect(storage.json('cord:servers:v1')).toEqual({ url: 'https://cord.nikg.tech/', autoConnect: true });
  });
});
