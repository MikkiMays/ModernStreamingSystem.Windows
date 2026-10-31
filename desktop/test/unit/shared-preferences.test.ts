import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ServerOrigin } from '../../src/main/origins';
import { bootstrapShared, SHARED_FILE, SharedPreferences, TOKEN_FILE } from '../../src/main/shared-preferences';

/*
  R146, Р-39: у клиента Windows общее для всех серверов — всё, что принадлежит устройству и человеку;
  слияние — «последний пишущий» по ключу; токен Яндекс Музыки (R157) — отдельно и зашифрован, только
  серверам каталога; пустое хранилище заполняет первая страница новой версии (`seed`).
*/

/** «Шифрование» для тестов: обратимое и заметное — открытый текст в файле не встречается. */
const encrypting = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from('enc:' + Buffer.from(plain, 'utf8').toString('base64')),
  decryptString: (data: Buffer) => {
    const text = data.toString();
    if (!text.startsWith('enc:')) throw new Error('не наш');
    return Buffer.from(text.slice(4), 'base64').toString('utf8');
  },
};
const plain = { isEncryptionAvailable: () => false, encryptString: (text: string) => Buffer.from(text), decryptString: (data: Buffer) => data.toString() };

const dirs: string[] = [];
const dir = () => {
  const path = mkdtempSync(join(tmpdir(), 'cord-shared-'));
  dirs.push(path);
  return path;
};
afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

const TOKEN = 'y0_AgAAAAB1secret-token';
const cord = ServerOrigin.parse('https://cord.nikg.tech');
const cam = ServerOrigin.parse('https://cordcam.ru');
const stranger = ServerOrigin.parse('https://evil.example');

describe('SharedPreferences — общее хранилище (R146)', () => {
  it('пустое — пусто; запись ложится в shared-preferences.json как {values: {ключ: {value, at}}}', () => {
    const root = dir();
    const store = new SharedPreferences(root, encrypting, () => 5_000);
    expect(store.empty).toBe(true);
    expect(store.shared()).toEqual({});
    const result = store.apply({ name: { value: 'Ника', at: 1000 }, outputVolume: { value: 40, at: 1000 } });
    expect(result).toEqual({ applied: ['name', 'outputVolume'], kept: {} });
    expect(store.empty).toBe(false);
    expect(JSON.parse(readFileSync(join(root, SHARED_FILE), 'utf8'))).toEqual({
      values: { name: { value: 'Ника', at: 1000 }, outputVolume: { value: 40, at: 1000 } },
    });
    // Новый запуск читает то же.
    expect(new SharedPreferences(root, encrypting).shared()).toEqual({ name: 'Ника', outputVolume: 40 });
  });

  it('«последний пишущий» по ключу: старое время не перебивает новое, равное — перебивает, ключи независимы', () => {
    const store = new SharedPreferences(dir(), encrypting, () => 10_000);
    store.apply({ name: { value: 'Ника', at: 2000 }, layout: { value: 'grid', at: 2000 } });
    const late = store.apply({ name: { value: 'Старое имя', at: 1500 }, layout: { value: 'speaker', at: 2500 } });
    expect(late.applied).toEqual(['layout']);
    expect(late.kept).toEqual({ name: { value: 'Ника', at: 2000 } });
    expect(store.shared()).toEqual({ name: 'Ника', layout: 'speaker' });
    expect(store.apply({ name: { value: 'Ника К.', at: 2000 } }).applied).toEqual(['name']);
    expect(store.shared().name).toBe('Ника К.');
  });

  it('время из будущего срезается до «сейчас»: одна запись не запирает ключ навсегда', () => {
    let now = 1000;
    const store = new SharedPreferences(dir(), encrypting, () => now);
    store.apply({ showPing: { value: true, at: 9_999_999 } });
    expect(store.entry('showPing')).toEqual({ value: true, at: 1000 });
    now = 1001;
    expect(store.apply({ showPing: { value: false, at: 1001 } }).applied).toEqual(['showPing']);
  });

  it('перенос (seed): заполняет только недостающие ключи, существующее не перебивает и называет его', () => {
    const store = new SharedPreferences(dir(), encrypting, () => 10_000);
    store.apply({ name: { value: 'Ника', at: 1000 } });
    const result = store.apply({ name: { value: 'С другого сервера', at: 9000 }, language: { value: 'de', at: 9000 } }, true);
    expect(result.applied).toEqual(['language']);
    expect(result.kept).toEqual({ name: { value: 'Ника', at: 1000 } });
    expect(store.shared()).toEqual({ name: 'Ника', language: 'de' });
  });

  it('перенос не кладёт пустой токен: «не знаю» — не то же, что «отключил»', () => {
    const store = new SharedPreferences(dir(), encrypting, () => 10_000);
    expect(store.apply({ yandexMusicToken: { value: '', at: 1 } }, true).applied).toEqual([]);
    expect(store.token()).toBeNull();
    // Обычная правка с пустым — это «Отключить»: записывается.
    store.apply({ yandexMusicToken: { value: TOKEN, at: 2 } });
    store.apply({ yandexMusicToken: { value: '', at: 3 } });
    expect(store.token()).toBe('');
  });

  it('файл с чужим ключом, не тем типом или битым временем — остальное читается', () => {
    const root = dir();
    writeFileSync(
      join(root, SHARED_FILE),
      JSON.stringify({
        values: {
          name: { value: 'Ника', at: 1 },
          favorites: { value: ['room'], at: 1 },
          outputVolume: { value: 'громко', at: 1 },
          layout: { value: 'grid', at: -5 },
          showPing: { value: true, at: 3 },
        },
      }),
    );
    expect(new SharedPreferences(root, encrypting).shared()).toEqual({ name: 'Ника', showPing: true });
    writeFileSync(join(root, SHARED_FILE), '{не json');
    expect(new SharedPreferences(root, encrypting).empty).toBe(true);
  });
});

describe('токен Яндекс Музыки — секрет (R157)', () => {
  it('лежит отдельно и зашифрованным: ни в общем файле, ни открытым текстом на диске', () => {
    const root = dir();
    const store = new SharedPreferences(root, encrypting, () => 10_000);
    store.apply({ yandexMusicToken: { value: TOKEN, at: 100 }, name: { value: 'Ника', at: 100 } });
    expect(store.shared()).not.toHaveProperty('yandexMusicToken');
    expect(readFileSync(join(root, SHARED_FILE), 'utf8')).not.toContain(TOKEN);
    const secret = readFileSync(join(root, TOKEN_FILE));
    expect(secret.toString()).not.toContain(TOKEN);
    expect(JSON.parse(encrypting.decryptString(secret))).toEqual({ value: TOKEN, at: 100 });
    // Переживает перезапуск: новый экземпляр читает тот же токен.
    expect(new SharedPreferences(root, encrypting).token()).toBe(TOKEN);
  });

  it('без шифрования на диск не пишется — живёт до выхода; чужой файл (другой пользователь Windows) — как нет токена', () => {
    const root = dir();
    const store = new SharedPreferences(root, plain, () => 10_000);
    store.apply({ yandexMusicToken: { value: TOKEN, at: 1 } });
    expect(store.token()).toBe(TOKEN);
    expect(() => readFileSync(join(root, TOKEN_FILE))).toThrow();
    writeFileSync(join(root, TOKEN_FILE), 'не расшифровать');
    expect(new SharedPreferences(root, encrypting).token()).toBeNull();
  });

  it('файл токена читается не в конструкторе, а при первом обращении — safeStorage готов только после ready', () => {
    const root = dir();
    new SharedPreferences(root, encrypting).apply({ yandexMusicToken: { value: TOKEN, at: 1 } });
    let ready = false;
    const late = { ...encrypting, isEncryptionAvailable: () => ready };
    const store = new SharedPreferences(root, late);
    ready = true;
    expect(store.token()).toBe(TOKEN);
  });

  it('bootstrap: значения — без токена; токен — только серверу каталога', () => {
    const store = new SharedPreferences(dir(), encrypting, () => 10_000);
    store.apply({ yandexMusicToken: { value: TOKEN, at: 1 }, language: { value: 'en', at: 1 } });
    expect(bootstrapShared(store, cam, [cord, cam])).toEqual({ shared: { language: 'en' }, yandexMusicToken: TOKEN });
    expect(bootstrapShared(store, stranger, [cord, cam])).toEqual({ shared: { language: 'en' }, yandexMusicToken: null });
    expect(bootstrapShared(new SharedPreferences(dir(), encrypting), cord, [cord]).yandexMusicToken).toBeNull();
  });
});
