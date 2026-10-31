import { describe, expect, it } from 'vitest';
import { ServerOrigin } from '../../src/main/origins';
import { loadBars, median, readLoad, serverStatus, type Fetcher } from '../../src/main/server-status';
import { INSTALLER_LANGUAGES } from '../../src/main/language';
import { shellText } from '../../src/main/shell-text';

/*
  Окно «Серверы» (T05, R143): пинг — медиана трёх HEAD /api/v1/ping, загрузка — GET /api/v1/load
  (Р-37: ступень 1–4 и состояние); палочки и слова — как LoadBars веба; чужой адрес не опрашивается;
  тексты окна — на восьми языках Cord.
*/
const ru = shellText('ru');
const cord = ServerOrigin.parse('https://cord.nikg.tech');
const cam = ServerOrigin.parse('https://cordcam.ru');

function fake(load: unknown, status = 200, pings: boolean[] = [true, true, true]): { fetcher: Fetcher; urls: string[] } {
  const urls: string[] = [];
  let ping = 0;
  return {
    urls,
    fetcher: async (url, init) => {
      urls.push(`${init.method} ${url}`);
      if (url.endsWith('/api/v1/ping')) {
        if (!pings[ping++]) throw new Error('timeout');
        return { ok: true, json: async () => ({}) };
      }
      return { ok: status === 200, json: async () => load };
    },
  };
}

describe('пинг и загрузка сервера (R143)', () => {
  it('медиана в целых мс; пусто — null', () => {
    expect(median([120.4, 30.2, 34.6])).toBe(35);
    expect(median([80])).toBe(80);
    expect(median([])).toBeNull();
  });

  it('ответ /load — ступень 1–4 и знакомое состояние; иначе (старое ядро, мусор) — null', () => {
    expect(readLoad({ level: 2, state: 'ok', updatedAt: 1 })).toEqual({ level: 2, state: 'ok' });
    expect(readLoad({ level: 4, state: 'full' })).toEqual({ level: 4, state: 'full' });
    for (const bad of [null, 'ok', { level: 0, state: 'ok' }, { level: 5, state: 'ok' }, { level: 2.5, state: 'ok' }, { level: 2, state: 'jammed' }, { state: 'ok' }])
      expect(readLoad(bad), JSON.stringify(bad)).toBeNull();
  });

  it('палочки как у LoadBars веба: 1–2 — success, 3 — warning, 4 — danger; «обновляется» и нет данных — пустые', () => {
    expect(loadBars({ level: 1, state: 'ok' }, ru)).toEqual({ filled: 1, tone: 'success', label: 'Загрузка сервера: низкая' });
    expect(loadBars({ level: 2, state: 'ok' }, ru)).toEqual({ filled: 2, tone: 'success', label: 'Загрузка сервера: средняя' });
    expect(loadBars({ level: 3, state: 'busy' }, ru)).toEqual({ filled: 3, tone: 'warning', label: 'Загрузка сервера: высокая' });
    expect(loadBars({ level: 4, state: 'busy' }, ru)).toEqual({ filled: 4, tone: 'danger', label: 'Загрузка сервера: очень высокая' });
    expect(loadBars({ level: 4, state: 'full' }, ru)).toEqual({ filled: 4, tone: 'danger', label: 'Загрузка сервера: мест нет' });
    expect(loadBars({ level: 1, state: 'maintenance' }, ru)).toEqual({ filled: 0, tone: null, label: 'Загрузка сервера: обновляется' });
    expect(loadBars({ level: 2, state: 'closed' }, ru)).toMatchObject({ filled: 2, label: 'Загрузка сервера: закрыт для новых встреч' });
    expect(loadBars(null, ru)).toEqual({ filled: 0, tone: null, label: 'Загрузка сервера: неизвестна' });
  });

  it('servers.status: три HEAD /ping и один GET /load сервера каталога', async () => {
    const { fetcher, urls } = fake({ level: 3, state: 'busy' });
    const status = await serverStatus(cam, [cord, cam], fetcher, ru);
    expect(status).toMatchObject({ load: { level: 3, state: 'busy' }, bars: { filled: 3, tone: 'warning' } });
    expect(typeof status!.ping).toBe('number');
    expect(urls.sort()).toEqual(['GET https://cordcam.ru/api/v1/load', 'HEAD https://cordcam.ru/api/v1/ping', 'HEAD https://cordcam.ru/api/v1/ping', 'HEAD https://cordcam.ru/api/v1/ping']);
  });

  it('старое ядро без /load (404) — палочки пустые, пинг есть; не ответил на пинг — null', async () => {
    const old = await serverStatus(cord, [cord], fake({ status: 404 }, 404).fetcher, ru);
    expect(old).toMatchObject({ load: null, bars: { filled: 0, tone: null } });
    expect(old!.ping).not.toBeNull();
    const silent = await serverStatus(cord, [cord], fake(null, 500, [false, false, false]).fetcher, ru);
    expect(silent).toMatchObject({ ping: null, load: null });
  });

  it('сервер не из каталога и не адрес — null, в сеть не ходим', async () => {
    const { fetcher, urls } = fake({ level: 1, state: 'ok' });
    expect(await serverStatus(ServerOrigin.parse('https://evil.example'), [cord, cam], fetcher, ru)).toBeNull();
    expect(await serverStatus(null, [cord, cam], fetcher, ru)).toBeNull();
    expect(urls).toEqual([]);
  });
});

describe('окно «Серверы» — восемь языков Cord (X1, R143)', () => {
  it('у каждого языка — заголовок, подвал про общие настройки, единица пинга и слова загрузки', () => {
    for (const language of Object.values(INSTALLER_LANGUAGES)) {
      const text = shellText(language);
      expect(text.ping, language).toContain('{n}');
      expect(text.loadLabel, language).toContain('{value}');
      for (const key of ['serversTitle', 'serversList', 'serversNote', 'loadLow', 'loadMedium', 'loadHigh', 'loadVeryHigh', 'loadFull', 'loadMaintenance', 'loadClosed', 'loadUnknown', 'switchTitle'] as const)
        expect(text[key].trim().length, `${language}.${key}`).toBeGreaterThan(0);
    }
    expect(shellText('ru').serversNote).toBe('Настройки общие для всех серверов. Комнаты, избранное и недавние у каждого сервера свои.');
    expect(loadBars({ level: 2, state: 'ok' }, shellText('en')).label).toBe('Server load: medium');
    expect(loadBars({ level: 4, state: 'full' }, shellText('zh-Hans')).label).toBe('服务器负载：已满');
  });
});
