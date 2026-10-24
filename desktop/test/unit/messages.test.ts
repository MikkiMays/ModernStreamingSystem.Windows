import { describe, expect, it } from 'vitest';
import { isPageCall, readPageMessage, validHotkey } from '../../src/main/bridge/messages';

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
  it('validHotkey и isPageCall', () => {
    expect(validHotkey({ code: 'F24', ctrl: false, alt: true, shift: false, meta: false })).toBe(true);
    expect(validHotkey({ code: 'F25', ctrl: false, alt: true, shift: false, meta: false })).toBe(false);
    expect(isPageCall('session.renew')).toBe(true);
    expect(isPageCall('fs.read')).toBe(false);
  });
});
