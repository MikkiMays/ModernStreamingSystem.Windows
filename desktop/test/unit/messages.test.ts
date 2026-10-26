import { describe, expect, it } from 'vitest';
import { isPageCall, readGameCall, readPageMessage, ROSTER_SIZE, validHotkey } from '../../src/main/bridge/messages';
import { ROSTER_LIMIT } from '../../src/shared/bridge';

const room = { roomId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', title: 'Пятница', code: '123456789' };

describe('readPageMessage — границы, как BridgeProtocol.Read', () => {
  it('state со всеми полями', () => {
    expect(readPageMessage('state', { page: 'room', inCall: true, name: 'Ник', avatar: 'data:image/png;base64,AAAA', theme: 'dark', room })).toEqual({
      type: 'state', page: 'room', inCall: true, name: 'Ник', avatar: 'data:image/png;base64,AAAA', theme: 'dark', room,
    });
  });
  it('state с языком интерфейса (R103): один из восьми — передаётся, чужой — пропускается, но сообщение принято', () => {
    expect(readPageMessage('state', { page: 'home', language: 'pt-BR' })).toMatchObject({ type: 'state', language: 'pt-BR' });
    const unknown = readPageMessage('state', { page: 'home', language: 'xx' });
    expect(unknown).toMatchObject({ type: 'state', page: 'home' });
    expect(unknown).not.toHaveProperty('language');
  });
  it('state без комнаты и без аватара', () => {
    expect(readPageMessage('state', { page: 'home', room: null })).toMatchObject({ type: 'state', page: 'home', inCall: false, name: '', avatar: '', room: null });
  });
  it('отвергает неизвестный тип, не ту страницу, длинное имя, не картинку, плохую комнату', () => {
    expect(readPageMessage('eval', {})).toBeNull();
    expect(readPageMessage('state', { page: 'admin' })).toBeNull();
    expect(readPageMessage('state', { page: 'home', name: 'x'.repeat(41) })).toBeNull();
    expect(readPageMessage('state', { page: 'home', avatar: 'https://evil/a.png' })).toBeNull();
    expect(readPageMessage('state', { page: 'home', avatar: 'data:image/png;base64,' + 'A'.repeat(4100) })).toBeNull();
    expect(readPageMessage('state', { page: 'home', room: { ...room, roomId: 'nope' } })).toBeNull();
    expect(readPageMessage('state', { page: 'home', room: { ...room, code: '12345678' } })).toBeNull();
    expect(readPageMessage('state', { page: 'home', room: { ...room, title: 'x'.repeat(81) } })).toBeNull();
  });
  it('размер сообщения ограничен 16 КиБ', () => {
    expect(readPageMessage('notify', { title: 'a', body: 'x'.repeat(20000) })).toBeNull();
  });
  it('массив вместо объекта — отказ', () => {
    expect(readPageMessage('state', [])).toBeNull();
    expect(readPageMessage('favorites.changed', 'x')).toBeNull();
  });
  it('hotkeys.configure — модель E03, до 8 действий', () => {
    const key = { code: 'KeyM', ctrl: true, alt: false, shift: true, meta: false };
    expect(readPageMessage('hotkeys.configure', { bindings: [{ action: 'mic.toggle', mode: 'toggle', key }] })).toEqual({
      type: 'hotkeys.configure', bindings: [{ action: 'mic.toggle', mode: 'toggle', key }],
    });
    expect(readPageMessage('hotkeys.configure', { bindings: [] })).toEqual({ type: 'hotkeys.configure', bindings: [] });
    expect(readPageMessage('hotkeys.configure', {})).toEqual({ type: 'hotkeys.configure', bindings: [] });
    expect(readPageMessage('hotkeys.configure', { bindings: [{ action: 'format-disk', mode: 'toggle', key }] })).toBeNull();
    expect(readPageMessage('hotkeys.configure', { bindings: [{ action: 'ptt', mode: 'hold', key: { ...key, code: 'Escape' } }] })).toBeNull();
    expect(readPageMessage('hotkeys.configure', { bindings: Array(9).fill({ action: 'ptt', mode: 'hold', key }) })).toBeNull();
  });
  it('call.state, preferences, autoconnect, badge, progress, capture.select', () => {
    expect(readPageMessage('call.state', { inCall: true, mic: false, camera: true, screen: false, room })).toEqual({ type: 'call.state', inCall: true, mic: false, camera: true, screen: false, room });
    expect(readPageMessage('preferences.changed', { showPing: true })).toEqual({ type: 'preferences.changed', showPing: true });
    expect(readPageMessage('server.autoconnect', { autoConnect: 'yes' })).toBeNull();
    expect(readPageMessage('badge', { count: 5000 })).toEqual({ type: 'badge', count: 999 });
    expect(readPageMessage('badge', { count: -1 })).toBeNull();
    expect(readPageMessage('progress', { value: 2 })).toEqual({ type: 'progress', value: 1 });
    expect(readPageMessage('capture.select', { id: 'window:1234:0', audio: 'system' })).toEqual({ type: 'capture.select', id: 'window:1234:0', audio: 'system' });
    expect(readPageMessage('capture.select', { id: 'file:///x', audio: 'none' })).toBeNull();
  });
  it('overlay.state — до 20 участников, градация 0–4', () => {
    expect(readPageMessage('overlay.state', { participants: [{ name: 'А', tier: 3.7, speaking: true }] })).toEqual({ type: 'overlay.state', participants: [{ name: 'А', tier: 3, speaking: true }] });
    expect(readPageMessage('overlay.state', { participants: [{ name: 'А', tier: 9 }] })).toBeNull();
  });
  it('notify — заголовок обязателен, до двух действий', () => {
    expect(readPageMessage('notify', { title: 'Упоминание', body: 'Привет', actions: [{ id: 'reply', text: 'Ответить' }] })).toEqual({
      type: 'notify', title: 'Упоминание', body: 'Привет', actions: [{ id: 'reply', text: 'Ответить' }],
    });
    expect(readPageMessage('notify', { body: 'x' })).toBeNull();
    expect(readPageMessage('notify', { title: 'x', body: 'y', actions: [{ id: 'a' }, { id: 'b' }, { id: 'c' }].map((a) => ({ ...a, text: 't' })) })).toBeNull();
  });
  it('hotkeys.configure — разблокировка оверлея (R63): действие overlay.lock и клавиша Backquote', () => {
    const lock = { code: 'Backquote', ctrl: false, alt: false, shift: true, meta: false };
    expect(readPageMessage('hotkeys.configure', { bindings: [{ action: 'overlay.lock', mode: 'toggle', key: lock }] })).toEqual({
      type: 'hotkeys.configure', bindings: [{ action: 'overlay.lock', mode: 'toggle', key: lock }],
    });
    expect(validHotkey(lock)).toBe(true);
  });
  it('overlay.roster (R63) — до 25 человек, аватар только data:image ≤ 4 КиБ, свой предел 128 КиБ', () => {
    const avatar = 'data:image/png;base64,' + 'A'.repeat(4000);
    const person = (i: number) => ({ id: `p-${i}`, name: `Участник ${i}`, avatar, muted: i % 2 === 0 });
    const full = readPageMessage('overlay.roster', { participants: Array.from({ length: ROSTER_SIZE }, (_, i) => person(i)) });
    expect(full).toMatchObject({ type: 'overlay.roster' });
    expect((full as { participants: unknown[] }).participants).toHaveLength(ROSTER_SIZE);
    expect(JSON.stringify(Array.from({ length: ROSTER_SIZE }, (_, i) => person(i))).length).toBeLessThan(ROSTER_LIMIT);
    expect(readPageMessage('overlay.roster', { participants: Array.from({ length: ROSTER_SIZE + 1 }, (_, i) => person(i)) })).toBeNull();
    expect(readPageMessage('overlay.roster', { participants: [{ id: 'a', name: 'А' }] })).toEqual({ type: 'overlay.roster', participants: [{ id: 'a', name: 'А', avatar: '', muted: false }] });
    expect(readPageMessage('overlay.roster', { participants: [{ ...person(1), avatar: 'https://evil/a.png' }] }), 'адрес вместо картинки').toBeNull();
    expect(readPageMessage('overlay.roster', { participants: [{ ...person(1), avatar: 'data:image/svg+xml;base64,AAAA' }] }), 'SVG — нет').toBeNull();
    expect(readPageMessage('overlay.roster', { participants: [{ ...person(1), avatar: 'data:image/png;base64,' + 'A'.repeat(4100) }] })).toBeNull();
    expect(readPageMessage('overlay.roster', { participants: [person(1), person(1)] }), 'повтор id').toBeNull();
    expect(readPageMessage('overlay.roster', { participants: [{ ...person(1), id: '../x y' }] })).toBeNull();
    expect(readPageMessage('overlay.roster', { participants: [{ ...person(1), name: 'x'.repeat(41) }] })).toBeNull();
    expect(readPageMessage('overlay.roster', { participants: 'все' })).toBeNull();
  });
  it('mini.state (R93) — форма мини-окна звонка', () => {
    expect(readPageMessage('mini.state', { room: 'Пятница', self: 'p-1', mic: true, camera: false, screen: true, unread: 3, count: 4 })).toEqual({
      type: 'mini.state', state: { room: 'Пятница', self: 'p-1', mic: true, camera: false, screen: true, unread: 3, count: 4, status: 'connected', remaining: 0 },
    });
    expect(readPageMessage('mini.state', {})).toEqual({ type: 'mini.state', state: { room: '', self: '', mic: false, camera: false, screen: false, unread: 0, count: 0, status: 'connected', remaining: 0 } });
    expect(readPageMessage('mini.state', { unread: 5000, count: -2 })).toMatchObject({ state: { unread: 999, count: 0 } });
    expect(readPageMessage('mini.state', { room: 'x'.repeat(81) })).toBeNull();
    expect(readPageMessage('mini.state', { self: 'не id' })).toBeNull();
    expect(readPageMessage('mini.state', { status: 'recovering', remaining: 17 }), 'связь восстанавливается').toMatchObject({ state: { status: 'recovering', remaining: 17 } });
    expect(readPageMessage('mini.state', { status: 'connecting', remaining: 17 }), 'секунды — только при восстановлении').toMatchObject({ state: { status: 'connecting', remaining: 0 } });
    expect(readPageMessage('mini.state', { status: 'ended' }), 'чужое значение — как веб до status').toMatchObject({ state: { status: 'connected' } });
  });
  it('games.set / games.forget (R62) — только имя exe', () => {
    expect(readGameCall('games.set', { exe: 'CS2.exe', enabled: false })).toEqual({ exe: 'cs2.exe', enabled: false });
    expect(readGameCall('games.forget', { exe: 'Hollow Knight.exe' })).toEqual({ exe: 'hollow knight.exe', enabled: false });
    expect(readGameCall('games.set', { exe: 'cs2.exe' }), 'без переключателя').toBeNull();
    expect(readGameCall('games.forget', { exe: 'C:\\Windows\\cmd.exe' }), 'путь — нет').toBeNull();
    expect(readGameCall('games.forget', { exe: 'readme.txt' })).toBeNull();
    expect(readGameCall('games.forget', null)).toBeNull();
    for (const method of ['games.list', 'games.set', 'games.forget', 'games.pick']) expect(isPageCall(method)).toBe(true);
  });
  it('validHotkey и isPageCall', () => {
    expect(validHotkey({ code: 'F24', ctrl: false, alt: true, shift: false, meta: false })).toBe(true);
    expect(validHotkey({ code: 'F25', ctrl: false, alt: true, shift: false, meta: false })).toBe(false);
    expect(isPageCall('session.renew')).toBe(true);
    expect(isPageCall('fs.read')).toBe(false);
  });
});
