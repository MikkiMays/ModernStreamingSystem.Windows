import { describe, expect, it } from 'vitest';
import { decideNavigation, isExternalWebLink, ServerOrigin } from '../../src/main/origins';

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
