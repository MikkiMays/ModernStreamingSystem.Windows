import { describe, expect, it } from 'vitest';
import { isPageCall, readGameCall, readPageMessage, ROSTER_SIZE, validHotkey } from '../../src/main/bridge/messages';
import { HOST_MESSAGES, PAGE_MESSAGES, ROSTER_LIMIT } from '../../src/shared/bridge';

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
    expect(full).toMatchObject({ type: 'overlay.roster', skipped: 0 });
    expect((full as { participants: unknown[] }).participants).toHaveLength(ROSTER_SIZE);
    expect(JSON.stringify(Array.from({ length: ROSTER_SIZE }, (_, i) => person(i))).length).toBeLessThan(ROSTER_LIMIT);
    expect(readPageMessage('overlay.roster', { participants: [{ id: 'a', name: 'А' }] })).toEqual({ type: 'overlay.roster', participants: [{ id: 'a', name: 'А', avatar: '', muted: false }], skipped: 0 });
    expect(readPageMessage('overlay.roster', { participants: 'все' })).toBeNull();
  });
  it('overlay.roster (R137) — мягкая проверка: плохая запись пропускается, плохой аватар — пустой, а не весь состав в корзину', () => {
    const avatar = 'data:image/png;base64,AAAA';
    const person = (i: number, extra: Record<string, unknown> = {}) => ({ id: `p-${i}`, name: `Участник ${i}`, avatar, muted: false, ...extra });
    const read = (participants: unknown[]) => readPageMessage('overlay.roster', { participants }) as { participants: { id: string; avatar: string }[]; skipped: number } | null;
    const ids = (participants: unknown[]) => read(participants)?.participants.map((entry) => entry.id);
    // Аватар не по образцу — человек остаётся, без картинки: адрес, SVG, длиннее 4 КиБ.
    for (const bad of ['https://evil/a.png', 'data:image/svg+xml;base64,AAAA', 'data:image/png;base64,' + 'A'.repeat(4100), 42]) {
      const roster = read([person(1, { avatar: bad }), person(2)]);
      expect(roster?.participants, String(bad).slice(0, 30)).toEqual([{ id: 'p-1', name: 'Участник 1', avatar: '', muted: false }, { id: 'p-2', name: 'Участник 2', avatar, muted: false }]);
      expect(roster?.skipped).toBe(0);
    }
    // Запись без id, с чужим id, повтором или длинным именем — пропускается, остальные приходят.
    expect(ids([person(1), person(1)]), 'повтор id').toEqual(['p-1']);
    expect(ids([{ ...person(1), id: '../x y' }, person(2)])).toEqual(['p-2']);
    expect(ids([{ ...person(1), name: 'x'.repeat(41) }, person(2)])).toEqual(['p-2']);
    expect(ids([null, 'Аня', person(3)])).toEqual(['p-3']);
    expect(read([person(1), null, { id: 7 }])?.skipped).toBe(2);
    // Больше 25 — первые 25, а не отказ: веб режет так же.
    const many = read(Array.from({ length: ROSTER_SIZE + 5 }, (_, i) => person(i)));
    expect(many?.participants).toHaveLength(ROSTER_SIZE);
    expect(many?.skipped).toBe(5);
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
  it('mini.state с номером (R137): seq — целое ≥ 0, чужое значение пропускается, сообщение принято', () => {
    expect(readPageMessage('mini.state', { room: 'Пятница', seq: 12 })).toMatchObject({ state: { room: 'Пятница', seq: 12 } });
    for (const bad of [-1, 1.5, '3', null]) expect((readPageMessage('mini.state', { seq: bad }) as unknown as { state: Record<string, unknown> }).state, String(bad)).not.toHaveProperty('seq');
  });
  it('mini.ack (R137) — ответ встречи на нажатие в мини-окне: номер, итог, причина', () => {
    expect(PAGE_MESSAGES).toContain('mini.ack');
    expect(HOST_MESSAGES).toContain('mini.resync');
    expect(readPageMessage('mini.ack', { seq: 3, result: 'ok' })).toEqual({ type: 'mini.ack', seq: 3, result: 'ok' });
    expect(readPageMessage('mini.ack', { seq: 4, result: 'ignored', reason: 'link' })).toEqual({ type: 'mini.ack', seq: 4, result: 'ignored', reason: 'link' });
    expect(readPageMessage('mini.ack', { seq: 4, result: 'ignored', reason: 'Связь!' }), 'причина — код, а не фраза').toEqual({ type: 'mini.ack', seq: 4, result: 'ignored' });
    for (const bad of [{ result: 'ok' }, { seq: -1, result: 'ok' }, { seq: 1.5, result: 'ok' }, { seq: 1, result: 'maybe' }, { seq: 1 }]) expect(readPageMessage('mini.ack', bad), JSON.stringify(bad)).toBeNull();
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

/*
  Общие настройки (R146, Р-39): preferences.changed {shared: {ключ: {value, at}}, seed?} — строго по
  белому списку: чужой ключ, не тот тип, лишний размер — отказ всему сообщению; прежняя форма
  {showPing, notificationSounds} принимается как раньше.
*/
describe('preferences.changed — общие настройки (R146)', () => {
  const at = 1_793_451_200_000;
  const entry = (value: unknown) => ({ value, at });
  const full = {
    language: entry('de'),
    name: entry('Ника'),
    avatar: entry('data:image/webp;base64,UklGRg=='),
    audio: entry({ suppression: 'rnnoise', suppressionChosen: true, echoCancellation: true, autoGainControl: false, gain: 1.4 }),
    outputVolume: entry(80),
    soundVolume: entry(0),
    notificationSounds: entry(false),
    gameSounds: entry({ poker: true, durak: false, chess: true, gartic: true }),
    micHotkey: entry({ code: 'KeyM', ctrl: true, alt: false, shift: true, meta: false }),
    micHotkeyMode: entry('hold'),
    overlayHotkey: entry(null),
    overlayLockHotkey: entry({ code: 'Backquote', ctrl: false, alt: false, shift: true, meta: false }),
    deafened: entry(true),
    deafenHotkey: entry({ code: 'KeyD', ctrl: true, alt: false, shift: true, meta: false }),
    layout: entry('speaker'),
    watchVolume: entry(70),
    watchAudio: entry('ru'),
    watchSubtitles: entry(''),
    screen: entry({ resolution: 1440, fps: 60, mode: 'sharp', preview: true, audio: 'system-except-cord' }),
    camera: entry({ resolution: 720, fps: 30 }),
    pokerHints: entry(false),
    pokerFeed: entry(true),
    showPing: entry(true),
    cinemaLinks: entry(['https://www.youtube.com/watch?v=1', 'https://rutube.ru/video/2/']),
    lastPlatform: entry({ music: 'yandex', cinema: 'youtube' }),
    background: entry({ kind: 'blur', strength: 'light' }),
    devices: entry({ microphone: 'Микрофон (Realtek(R) Audio)', camera: 'HD Webcam' }),
    yandexMusicToken: entry('y0_AgAAAAB1token'),
  };

  it('все общие ключи и токен — проходят; seed — признак переноса', () => {
    expect(readPageMessage('preferences.changed', { shared: full })).toEqual({ type: 'preferences.changed', shared: full });
    expect(readPageMessage('preferences.changed', { shared: { name: entry('Ника') }, seed: true })).toEqual({ type: 'preferences.changed', shared: { name: entry('Ника') }, seed: true });
    // Прежняя форма — как раньше.
    expect(readPageMessage('preferences.changed', { showPing: true, notificationSounds: false })).toEqual({ type: 'preferences.changed', showPing: true, notificationSounds: false });
  });

  it('свои у сервера ключи и всё незнакомое — отказ всему сообщению', () => {
    for (const key of ['favorites', 'autojoin', 'recent', 'session', 'password', 'volumes', 'quality', 'admin', 'showIntegrationPanel', '__proto__x'])
      expect(readPageMessage('preferences.changed', { shared: { name: entry('Ника'), [key]: entry(true) } }), key).toBeNull();
  });

  it('не тот тип или форма записи — отказ', () => {
    const bad: Record<string, unknown>[] = [
      { name: entry(42) },
      { name: { value: 'Ника' } },
      { name: { value: 'Ника', at: -1 } },
      { name: { value: 'Ника', at: 1.5 } },
      { name: { value: 'Ника', at, extra: 1 } },
      { name: 'Ника' },
      { language: entry('xx') },
      { outputVolume: entry(101) },
      { outputVolume: entry(50.5) },
      { deafened: entry('yes') },
      { micHotkeyMode: entry('push') },
      { micHotkey: entry({ code: 'KeyM', ctrl: true }) },
      { micHotkey: entry({ code: 'F25', ctrl: false, alt: false, shift: false, meta: false }) },
      { audio: entry({ suppression: 'rnnoise', gain: 3 }) },
      { audio: entry({ suppression: 'rnnoise', evil: true }) },
      { screen: entry({ resolution: 99999, fps: 60 }) },
      { camera: entry({ resolution: 720, fps: 30, mode: 'sharp' }) },
      { cinemaLinks: entry(['javascript:alert(1)']) },
      { cinemaLinks: entry(Array.from({ length: 11 }, (_, i) => `https://x.ru/${i}`)) },
      { lastPlatform: entry({ music: 'Yandex Music!' }) },
      { devices: entry({ microphone: 'default-id', webcam: 'x' }) },
      { background: entry({ kind: 'video' }) },
      { background: entry({ strength: 'light' }) },
      { background: entry({ kind: 'image', url: 'https://evil.example/a.png' }) },
      { devices: entry({ microphone: '' }) },
      { avatar: entry('https://evil.example/a.png') },
      { yandexMusicToken: entry('токен с пробелом') },
    ];
    for (const shared of bad) expect(readPageMessage('preferences.changed', { shared }), JSON.stringify(shared)).toBeNull();
    expect(readPageMessage('preferences.changed', { shared: full, seed: 'yes' })).toBeNull();
    expect(readPageMessage('preferences.changed', { shared: [entry(1)] })).toBeNull();
  });

  it('пределы: имя ≤ 40, аватар ≤ 3500, токен ≤ 1000, ссылка ≤ 2000, всё сообщение ≤ 16 КиБ', () => {
    const picture = (length: number) => 'data:image/png;base64,' + 'A'.repeat(length - 'data:image/png;base64,'.length);
    expect(readPageMessage('preferences.changed', { shared: { name: entry('я'.repeat(40)) } })).not.toBeNull();
    expect(readPageMessage('preferences.changed', { shared: { name: entry('я'.repeat(41)) } })).toBeNull();
    expect(readPageMessage('preferences.changed', { shared: { avatar: entry(picture(3500)) } })).not.toBeNull();
    expect(readPageMessage('preferences.changed', { shared: { avatar: entry(picture(3501)) } })).toBeNull();
    expect(readPageMessage('preferences.changed', { shared: { yandexMusicToken: entry('t'.repeat(1000)) } })).not.toBeNull();
    expect(readPageMessage('preferences.changed', { shared: { yandexMusicToken: entry('t'.repeat(1001)) } })).toBeNull();
    expect(readPageMessage('preferences.changed', { shared: { cinemaLinks: entry(['https://x.ru/' + 'a'.repeat(1990)]) } })).toBeNull();
    // Десять ссылок по 1990 знаков — каждая в пределе, но всё сообщение больше 16 КиБ.
    const links = Array.from({ length: 10 }, (_, i) => `https://x.ru/${i}/` + 'a'.repeat(1970));
    expect(readPageMessage('preferences.changed', { shared: { cinemaLinks: entry(links) } })).toBeNull();
  });
});

describe('mini.state — «звук встречи» (R156)', () => {
  it('deafened — только логическое и только если веб его прислал: иначе кнопки и пункта трея нет', () => {
    expect(readPageMessage('mini.state', { room: 'Пятница', deafened: true })).toMatchObject({ state: { deafened: true } });
    expect(readPageMessage('mini.state', { room: 'Пятница', deafened: false })).toMatchObject({ state: { deafened: false } });
    for (const bad of [undefined, 'yes', 1, null]) expect((readPageMessage('mini.state', { deafened: bad }) as unknown as { state: Record<string, unknown> }).state, String(bad)).not.toHaveProperty('deafened');
  });
});
