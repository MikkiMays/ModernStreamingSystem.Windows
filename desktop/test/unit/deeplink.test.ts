import { describe, expect, it } from 'vitest';
import { deepLinkFromArgv, parseDeepLink } from '../../src/main/deeplink';

describe('parseDeepLink', () => {
  it('комната по коду, с дефисами и без', () => {
    expect(parseDeepLink('cord://room/123456789')).toEqual({ kind: 'room', code: '123456789' });
    expect(parseDeepLink('cord://room/123-456-789')).toEqual({ kind: 'room', code: '123456789' });
    expect(parseDeepLink('CORD://ROOM/123456789')).toEqual({ kind: 'room', code: '123456789' });
  });
  it('приглашение по идентификатору', () => {
    expect(parseDeepLink('cord://invite/3F2504E0-4F89-11D3-9A0C-0305E82C3301')).toEqual({ kind: 'invite', roomId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' });
  });
  it('новая встреча, настройки, просто открыть', () => {
    expect(parseDeepLink('cord://create')).toEqual({ kind: 'create' });
    expect(parseDeepLink('cord://settings')).toEqual({ kind: 'settings' });
    expect(parseDeepLink('cord://settings/audio')).toEqual({ kind: 'settings', tab: 'audio' });
    expect(parseDeepLink('cord://')).toEqual({ kind: 'open' });
  });
  it('отвергает всё остальное', () => {
    for (const bad of [
      'cord://room/12345678',
      'cord://room/12345678a',
      'cord://room/123456789/extra',
      'cord://invite/not-a-uuid',
      'cord://server/https%3A%2F%2Fevil',
      'cord://add-server?url=https://evil',
      'cord://settings/Audio Tab',
      'https://cord.nikg.tech/',
      'cord://u:p@room/123456789',
      'cord://room:8080/123456789',
      'x'.repeat(201),
    ])
      expect(parseDeepLink(bad), bad).toBeNull();
  });
  it('из argv берётся последняя ссылка', () => {
    expect(deepLinkFromArgv(['Cord.exe', '--allow-file-access', 'cord://room/111111111', 'cord://create'])).toEqual({ kind: 'create' });
    expect(deepLinkFromArgv(['Cord.exe'])).toBeNull();
  });
});
