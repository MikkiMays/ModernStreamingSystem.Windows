import { describe, expect, it } from 'vitest';
import known from '../../src/main/games-known.json';
import {
  addGame,
  findGame,
  forgetGame,
  gameKey,
  gameName,
  GAMES_LIMIT,
  looksLikeGame,
  nextActive,
  noteForeground,
  noteLeft,
  NOT_GAMES,
  readGames,
  setGameEnabled,
  type GamesState,
} from '../../src/main/games';

const empty: GamesState = { games: [], ignored: [] };
const window = (exe: string, extra: Partial<{ cord: boolean; title: string; borderless: boolean; exclusive: boolean }> = {}) => ({ cord: false, exe, title: '', borderless: false, exclusive: false, ...extra });

describe('games-known.json — известные игры', () => {
  it('около двухсот exe строчными, у каждого имя', () => {
    const entries = Object.entries(known as Record<string, string>);
    expect(entries.length).toBeGreaterThanOrEqual(150);
    for (const [exe, name] of entries) {
      expect(exe).toBe(exe.toLowerCase());
      expect(exe).toMatch(/\.exe$/);
      expect(name.trim().length).toBeGreaterThan(0);
      expect(NOT_GAMES.has(exe)).toBe(false);
    }
  });
});

describe('правило регистрации (R62)', () => {
  it('известная игра — даже в окне; неизвестная — если «без рамки» или в эксклюзивном режиме', () => {
    expect(looksLikeGame(window('cs2.exe'))).toBe(true);
    expect(looksLikeGame(window('MyIndieGame.exe', { borderless: true }))).toBe(true);
    expect(looksLikeGame(window('old.exe', { exclusive: true }))).toBe(true);
    expect(looksLikeGame(window('notes.exe'))).toBe(false);
  });

  it('не Cord, не стоп-лист, не забытая, только exe', () => {
    expect(looksLikeGame(window('cs2.exe', { cord: true }))).toBe(false);
    expect(looksLikeGame(window('chrome.exe', { borderless: true })), 'видео в браузере на весь экран').toBe(false);
    expect(looksLikeGame(window('vlc.exe', { borderless: true }))).toBe(false);
    expect(looksLikeGame(window('POWERPNT.EXE', { borderless: true })), 'показ слайдов').toBe(false);
    expect(looksLikeGame(window('explorer.exe', { borderless: true }))).toBe(false);
    expect(looksLikeGame(window('cs2.exe'), ['cs2.exe']), 'забытая сама не возвращается').toBe(false);
    expect(looksLikeGame(window('', { borderless: true })), 'процесса нет в снимке').toBe(false);
    expect(looksLikeGame({ cord: false }), 'модуль до R62 — не игра').toBe(false);
  });

  it('ключ — exe строчными без пути; имя — известное, иначе заголовок, иначе exe', () => {
    expect(gameKey('C:\\Games\\CS2.EXE')).toBe('cs2.exe');
    expect(gameName('cs2.exe', 'Counter-Strike 2 — DX11')).toBe('Counter-Strike 2');
    expect(gameName('indie.exe', '  Indie   Quest  ')).toBe('Indie Quest');
    expect(gameName('indie.exe')).toBe('indie');
  });
});

describe('реестр', () => {
  it('новая игра впереди — запоминается включённой, с первым и последним запуском', () => {
    const { state, game, changed } = noteForeground(empty, window('Indie.exe', { borderless: true, title: 'Indie Quest' }), 1000);
    expect(changed).toBe(true);
    expect(game).toEqual({ exe: 'indie.exe', name: 'Indie Quest', enabled: true, firstSeen: 1000, lastSeen: 1000 });
    expect(state.games).toEqual([game]);
  });

  it('знакомая — обновляется последний запуск, выключенная остаётся выключенной', () => {
    let state = noteForeground(empty, window('cs2.exe'), 1000).state;
    state = setGameEnabled(state, 'CS2.exe', false);
    const again = noteForeground(state, window('cs2.exe', { borderless: true }), 5000);
    expect(again.game).toMatchObject({ exe: 'cs2.exe', enabled: false, firstSeen: 1000, lastSeen: 5000 });
    expect(noteLeft(again.state, 'cs2.exe', 9000).games[0]!.lastSeen).toBe(9000);
  });

  it('не игра и Cord — реестр не меняется', () => {
    expect(noteForeground(empty, window('winword.exe'), 1)).toEqual({ state: empty, game: null, changed: false });
    const state = noteForeground(empty, window('cs2.exe'), 1).state;
    expect(noteForeground(state, window('cs2.exe', { cord: true }), 2)).toEqual({ state, game: null, changed: false });
  });

  it('список — по последнему запуску, не длиннее предела', () => {
    let state = empty;
    for (let i = 0; i < GAMES_LIMIT + 5; i++) state = noteForeground(state, window(`game${i}.exe`, { borderless: true }), i).state;
    expect(state.games).toHaveLength(GAMES_LIMIT);
    expect(state.games[0]!.exe).toBe(`game${GAMES_LIMIT + 4}.exe`);
    expect(findGame(state, 'game0.exe')).toBeNull();
  });

  it('«Забыть» — убирает и не даёт вернуться самой; «Добавить игру» — возвращает', () => {
    const state = forgetGame(noteForeground(empty, window('cs2.exe'), 1).state, 'cs2.exe');
    expect(state).toEqual({ games: [], ignored: ['cs2.exe'] });
    expect(noteForeground(state, window('cs2.exe', { borderless: true }), 2).changed).toBe(false);
    const added = addGame(state, 'D:\\Steam\\cs2.exe', 3)!;
    expect(added.game).toMatchObject({ exe: 'cs2.exe', name: 'Counter-Strike 2', enabled: true });
    expect(added.state.ignored).toEqual([]);
  });

  it('«Добавить игру» — только exe и не сам Cord', () => {
    expect(addGame(empty, 'C:\\readme.txt', 1)).toBeNull();
    expect(addGame(empty, 'C:\\Program Files\\Cord\\Cord.exe', 1)).toBeNull();
  });

  it('из settings.json — только по схеме, без повторов', () => {
    const state = readGames(
      [
        { exe: 'CS2.exe', name: 'CS', enabled: false, firstSeen: 5, lastSeen: 7 },
        { exe: 'cs2.exe', name: 'дубль' },
        { exe: 'evil', name: 'не exe' },
        null,
        { exe: 'indie.exe', firstSeen: -1, lastSeen: 'x' },
      ],
      ['A.EXE', 3, 'b.txt'],
    );
    expect(state.games).toEqual([
      { exe: 'cs2.exe', name: 'CS', enabled: false, firstSeen: 5, lastSeen: 7 },
      { exe: 'indie.exe', name: 'indie', enabled: true, firstSeen: 0, lastSeen: 0 },
    ]);
    expect(state.ignored).toEqual(['a.exe']);
    expect(readGames('nope', null)).toEqual(empty);
  });
});

describe('игра «сейчас» (game.active)', () => {
  const cs2 = { exe: 'cs2.exe', name: 'Counter-Strike 2', enabled: true, firstSeen: 1, lastSeen: 1 };
  it('впереди игра — она; ушли в Cord — та же; ушли в другое окно — никакой', () => {
    const playing = nextActive(null, { ...window('cs2.exe', { exclusive: true }), pid: 7 }, cs2);
    expect(playing).toEqual({ game: { exe: 'cs2.exe', name: 'Counter-Strike 2', enabled: true, exclusive: true }, pid: 7 });
    expect(nextActive(playing, { ...window('cord.exe', { cord: true }), pid: 1 }, null)).toBe(playing);
    expect(nextActive(playing, { ...window('notepad.exe'), pid: 2 }, null)).toBeNull();
    expect(nextActive(playing, null, null), 'модуль упал').toBeNull();
  });
});
