import { describe, expect, it } from 'vitest';
import { decideNavigation, isExternalWebLink, knownServers, pickOrigin, ServerOrigin } from '../../src/main/origins';

describe('pickOrigin', () => {
  const own = ServerOrigin.parse('https://meet.example.com/');
  const other = ServerOrigin.parse('https://other.example.org/');
  const third = ServerOrigin.parse('https://third.example.net/');
  it('сохранённый сервер остаётся, пока его знает сборка — переключение между серверами каталога', () => {
    expect(pickOrigin(other, [own, other], own.url, own.url)).toBe(other);
    expect(pickOrigin(own, [own, other], other.url, other.url)).toBe(own);
  });
  it('сервер от прежней установки или убранный из каталога — сервер сборки', () => {
    expect(pickOrigin(third, [own, other], own.url, other.url).url).toBe(own.url);
  });
  it('первый запуск — сервер, под который собран клиент, а не умолчание каталога', () => {
    expect(pickOrigin(null, [own, other], other.url, own.url).url).toBe(other.url);
  });
  it('сервера сборки нет в каталоге — умолчание каталога', () => {
    expect(pickOrigin(null, [own, other], third.url, own.url).url).toBe(own.url);
  });
  it('без каталога — сервер сборки', () => {
    expect(pickOrigin(third, [own], own.url, null).url).toBe(own.url);
  });
  it('сборка без сервера (разработка) сохранённое не трогает', () => {
    expect(pickOrigin(other, [], '', null)).toBe(other);
  });
});

describe('knownServers — сервер окружения известен и без каталога (R200 §8.6)', () => {
  const product = 'https://cordcam.ru/';
  const stand = 'https://cord.nikg.tech/';
  it('без каталога — только сервер сборки', () => {
    expect(knownServers(null, product, false).map((o) => o.url)).toEqual([product]);
    expect(knownServers(null, '', false)).toEqual([]);
  });
  it('с каталогом сборка знает ровно каталог: сервер прежней сборки, убранный из каталога, не известен', () => {
    expect(knownServers([product], stand, false).map((o) => o.url)).toEqual([product]);
  });
  it('стенд из CORD_DEFAULT_SERVER (дымовой прогон CI, разработка) известен рядом с каталогом продукта', () => {
    const known = knownServers([product], stand, true);
    expect(known.map((o) => o.url)).toEqual([product, stand]);
    // Клиент открывает стенд, а не умолчание каталога: pickOrigin видит сервер сборки среди известных.
    expect(pickOrigin(null, known, stand, product).url).toBe(stand);
    // А сборка продукта с тем же каталогом открывает продукт — без повторов в списке.
    expect(knownServers([product], product, true).map((o) => o.url)).toEqual([product]);
  });
  it('старый клиент стенда с каталогом продукта уходит на продукт (сохранённый и сборочный серверы не известны)', () => {
    const known = knownServers([product], stand, false);
    expect(pickOrigin(ServerOrigin.parse(stand), known, stand, product).url).toBe(product);
  });
  it('мусор в каталоге отбрасывается', () => {
    expect(knownServers(['not a url', product], '', false).map((o) => o.url)).toEqual([product]);
  });
});

describe('ServerOrigin', () => {
  it('нормализует https-адрес до origin с завершающим /', () => {
    expect(ServerOrigin.parse(' https://Cord.nikg.tech ').url).toBe('https://cord.nikg.tech/');
    expect(ServerOrigin.parse('https://cord.nikg.tech:8443/').origin).toBe('https://cord.nikg.tech:8443');
  });
  it('http — только loopback', () => {
    expect(ServerOrigin.parse('http://localhost:5173').url).toBe('http://localhost:5173/');
    expect(() => ServerOrigin.parse('http://cord.nikg.tech')).toThrow();
  });
  it('отвергает путь, запрос, фрагмент и учётные данные', () => {
    for (const bad of ['https://cord.nikg.tech/room', 'https://cord.nikg.tech/?x=1', 'https://cord.nikg.tech/#x', 'https://u:p@cord.nikg.tech/', 'not a url', 'cord://room/1'])
      expect(ServerOrigin.tryParse(bad), bad).toBeNull();
  });
  it('owns — та же схема, хост и порт', () => {
    const origin = ServerOrigin.parse('https://cord.nikg.tech');
    expect(origin.owns('https://cord.nikg.tech/room/abc?x=1')).toBe(true);
    expect(origin.owns('https://cord.nikg.tech:443/')).toBe(true);
    expect(origin.owns('http://cord.nikg.tech/')).toBe(false);
    expect(origin.owns('https://evil.cord.nikg.tech/')).toBe(false);
    expect(origin.owns('https://u@cord.nikg.tech/')).toBe(false);
    expect(origin.owns(null)).toBe(false);
  });
  it('storageKey — первые 24 hex SHA-256 от url, как в WinUI', async () => {
    const key = await ServerOrigin.parse('https://cord.nikg.tech').storageKey();
    expect(key).toMatch(/^[0-9a-f]{24}$/);
  });
});

describe('decideNavigation', () => {
  const allowed = [ServerOrigin.parse('https://cord.nikg.tech'), ServerOrigin.parse('https://meet.nikg.tech')];
  it('внутри серверов человека — разрешено', () => {
    expect(decideNavigation('https://cord.nikg.tech/download', allowed)).toBe('allow');
    expect(decideNavigation('https://meet.nikg.tech/', allowed)).toBe('allow');
    expect(decideNavigation('about:blank', allowed)).toBe('allow');
  });
  it('чужая https-ссылка — во внешний браузер', () => {
    expect(decideNavigation('https://t.me/nikgers', allowed)).toBe('external');
  });
  it('остальное — отказ', () => {
    expect(decideNavigation('file:///C:/Windows/system.ini', allowed)).toBe('deny');
    expect(decideNavigation('javascript:alert(1)', allowed)).toBe('deny');
    expect(decideNavigation('cord-app://shell/splash', allowed)).toBe('deny');
    expect(decideNavigation('https://u:p@t.me/', allowed)).toBe('deny');
    expect(decideNavigation('garbage', allowed)).toBe('deny');
  });
  it('isExternalWebLink', () => {
    expect(isExternalWebLink('https://t.me/x')).toBe(true);
    expect(isExternalWebLink('mailto:a@b')).toBe(false);
  });
});
