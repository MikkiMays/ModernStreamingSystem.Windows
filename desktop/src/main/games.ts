/**
 * Игры (R62): Cord сам различает игру впереди и помнит её — как «Зарегистрированные игры» Discord,
 * но без IGDB и без конфиденциальности активности (X2: аккаунтов в Cord нет).
 *
 * Откуда знаем, что впереди игра. `cord-native` раз в 300 мс снимает переднее окно: имя exe процесса
 * (снимок Toolhelp, процесс игры не открывается), заголовок, «без рамки» (нет заголовка и рамки,
 * окно ровно по монитору) и эксклюзивный полноэкранный Direct3D. Игрой окно становится, если это не
 * Cord, не системное окно и не программа из стоп-листа (браузер, плеер, офис, мессенджер) и если
 * оно «без рамки», в эксклюзивном режиме или его exe есть в `games-known.json` (~200 exe популярных
 * игр). Просто «во весь экран» — не повод: так выглядит любое развёрнутое окно при скрытой панели
 * задач, и Word стал бы игрой.
 *
 * Что помним (`settings.games`): `{exe, name, enabled, firstSeen, lastSeen}` — exe строчными, имя из
 * списка известных, иначе из заголовка окна, иначе exe без `.exe`. «Забыть» убирает игру и кладёт
 * exe в `ignoredGames`, чтобы она не вернулась сама при следующем запуске; «Добавить игру» (выбор exe)
 * возвращает её. Переключатель игры решает, виден ли над ней оверлей (`overlay-policy.ts`).
 *
 * Здесь нет Electron: правило проверяется тестами (`games.test.ts`), `index.ts` только исполняет.
 */
import knownGames from './games-known.json';

export interface GameEntry {
  /** Имя exe строчными — ключ игры. */
  exe: string;
  name: string;
  /** Оверлей над этой игрой. */
  enabled: boolean;
  /** Мс эпохи: первый и последний раз впереди. */
  firstSeen: number;
  lastSeen: number;
}

export interface GamesState {
  games: GameEntry[];
  /** Забытые: сами больше не регистрируются. */
  ignored: string[];
}

/** Переднее окно так, как его видит реестр (поля события `foreground` модуля). */
export interface GameWindow {
  cord: boolean;
  exe?: string;
  title?: string;
  borderless?: boolean;
  exclusive?: boolean;
}

/** Сколько игр помнить: самые давние по последнему запуску уходят первыми. */
export const GAMES_LIMIT = 100;
const NAME_LIMIT = 80;

const KNOWN: ReadonlyMap<string, string> = new Map(Object.entries(knownGames as Record<string, string>));

/**
 * Не игры, даже во весь экран без рамки: оболочка Windows, браузеры (видео на весь экран), плееры,
 * офис и презентации, мессенджеры и звонилки, удалённый рабочий стол, лаунчеры, запись и сам Cord.
 */
export const NOT_GAMES: ReadonlySet<string> = new Set([
  'explorer.exe', 'applicationframehost.exe', 'shellexperiencehost.exe', 'startmenuexperiencehost.exe', 'searchhost.exe', 'searchapp.exe',
  'lockapp.exe', 'textinputhost.exe', 'systemsettings.exe', 'taskmgr.exe', 'logonui.exe', 'dwm.exe', 'snippingtool.exe', 'screenclippinghost.exe',
  'mstsc.exe', 'msrdc.exe', 'vmconnect.exe', 'vmware.exe', 'virtualboxvm.exe', 'anydesk.exe', 'teamviewer.exe', 'rustdesk.exe',
  'chrome.exe', 'msedge.exe', 'firefox.exe', 'opera.exe', 'opera_gx.exe', 'brave.exe', 'vivaldi.exe', 'browser.exe', 'iexplore.exe', 'arc.exe', 'yandex.exe',
  'vlc.exe', 'mpv.exe', 'mpc-hc.exe', 'mpc-hc64.exe', 'mpc-be.exe', 'mpc-be64.exe', 'potplayer.exe', 'potplayermini.exe', 'potplayermini64.exe', 'kmplayer.exe',
  'wmplayer.exe', 'video.ui.exe', 'microsoft.media.player.exe', 'photos.exe', 'microsoft.photos.exe', 'stremio.exe', 'kodi.exe', 'plex.exe', 'netflix.exe',
  'powerpnt.exe', 'winword.exe', 'excel.exe', 'onenote.exe', 'outlook.exe', 'acrord32.exe', 'acrobat.exe', 'sumatrapdf.exe', 'notepad.exe',
  'code.exe', 'devenv.exe', 'idea64.exe', 'rider64.exe', 'pycharm64.exe', 'windowsterminal.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'conhost.exe',
  'discord.exe', 'telegram.exe', 'slack.exe', 'teams.exe', 'ms-teams.exe', 'zoom.exe', 'skype.exe', 'whatsapp.exe', 'viber.exe', 'telemost.exe',
  'obs64.exe', 'obs32.exe', 'streamlabs obs.exe', 'nvidia share.exe', 'nvidia overlay.exe', 'gamebar.exe', 'gamebarftserver.exe', 'xboxpcapp.exe',
  'steam.exe', 'steamwebhelper.exe', 'epicgameslauncher.exe', 'battle.net.exe', 'galaxyclient.exe', 'eadesktop.exe', 'origin.exe', 'upc.exe',
  'ubisoftconnect.exe', 'riotclientux.exe', 'riotclientservices.exe', 'leagueclientux.exe', 'vkplay.exe', 'gamecenter.exe', 'spotify.exe', 'cord.exe',
]);

/** Ключ игры: имя exe строчными, без пути. */
export function gameKey(exe: string): string {
  return (exe.split(/[\\/]/).pop() ?? '').trim().toLowerCase();
}

/** Имя игры: из списка известных, иначе из заголовка окна, иначе exe без `.exe`. */
export function gameName(exe: string, title = ''): string {
  const key = gameKey(exe);
  const known = KNOWN.get(key);
  if (known) return known;
  const clean = title.replace(/\s+/g, ' ').trim();
  if (clean) return clean.slice(0, NAME_LIMIT);
  return key.replace(/\.exe$/, '') || key;
}

export function isKnownGame(exe: string): boolean {
  return KNOWN.has(gameKey(exe));
}

/** Стоит ли окно впереди того, чтобы запомнить его как игру. */
export function looksLikeGame(window: GameWindow, ignored: readonly string[] = []): boolean {
  const key = gameKey(window.exe ?? '');
  if (window.cord || !key.endsWith('.exe') || NOT_GAMES.has(key) || ignored.includes(key)) return false;
  return KNOWN.has(key) || window.borderless === true || window.exclusive === true;
}

export function findGame(state: GamesState, exe: string | undefined): GameEntry | null {
  const key = gameKey(exe ?? '');
  return key ? (state.games.find((game) => game.exe === key) ?? null) : null;
}

function withGame(state: GamesState, entry: GameEntry): GamesState {
  const games = [entry, ...state.games.filter((game) => game.exe !== entry.exe)].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, GAMES_LIMIT);
  return { games, ignored: state.ignored.filter((exe) => exe !== entry.exe) };
}

/**
 * Окно стало передним: известная игра — отметить запуск, новая — запомнить (оверлей над ней включён).
 * `changed` — реестр поменялся и его надо записать и разослать (`games.changed`).
 */
export function noteForeground(state: GamesState, window: GameWindow, now: number): { state: GamesState; game: GameEntry | null; changed: boolean } {
  const existing = findGame(state, window.exe);
  if (window.cord) return { state, game: null, changed: false };
  if (existing) {
    const game = { ...existing, lastSeen: now };
    return { state: withGame(state, game), game, changed: true };
  }
  if (!looksLikeGame(window, state.ignored)) return { state, game: null, changed: false };
  const game: GameEntry = { exe: gameKey(window.exe!), name: gameName(window.exe!, window.title), enabled: true, firstSeen: now, lastSeen: now };
  return { state: withGame(state, game), game, changed: true };
}

/** Игра ушла с переднего плана: запомнить, когда её видели последней. */
export function noteLeft(state: GamesState, exe: string, now: number): GamesState {
  const game = findGame(state, exe);
  return game ? withGame(state, { ...game, lastSeen: Math.max(game.lastSeen, now) }) : state;
}

/** Переключатель игры в настройках. Незнакомая — без изменений. */
export function setGameEnabled(state: GamesState, exe: string, enabled: boolean): GamesState {
  const key = gameKey(exe);
  return { ...state, games: state.games.map((game) => (game.exe === key ? { ...game, enabled } : game)) };
}

/** «Забыть»: убрать и больше не регистрировать самой. */
export function forgetGame(state: GamesState, exe: string): GamesState {
  const key = gameKey(exe);
  if (!key) return state;
  return { games: state.games.filter((game) => game.exe !== key), ignored: [...state.ignored.filter((item) => item !== key), key].slice(-GAMES_LIMIT) };
}

/** «Добавить игру» — выбранный человеком exe; забытая возвращается. Не exe или Cord — отказ (`null`). */
export function addGame(state: GamesState, path: string, now: number): { state: GamesState; game: GameEntry } | null {
  const key = gameKey(path);
  if (!key.endsWith('.exe') || key === 'cord.exe') return null;
  const existing = findGame(state, key);
  const game: GameEntry = existing ? { ...existing, enabled: true } : { exe: key, name: gameName(key), enabled: true, firstSeen: now, lastSeen: 0 };
  return { state: withGame(state, game), game };
}

/** Записанное в `settings.json` — без доверия: только поля по схеме. */
export function readGames(raw: unknown, ignoredRaw: unknown): GamesState {
  const games: GameEntry[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw) ? raw.slice(0, GAMES_LIMIT) : []) {
    const entry = (item ?? {}) as Record<string, unknown>;
    const exe = typeof entry.exe === 'string' ? gameKey(entry.exe) : '';
    if (!exe.endsWith('.exe') || seen.has(exe)) continue;
    seen.add(exe);
    const time = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0);
    games.push({
      exe,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, NAME_LIMIT) : gameName(exe),
      enabled: entry.enabled !== false,
      firstSeen: time(entry.firstSeen),
      lastSeen: time(entry.lastSeen),
    });
  }
  const ignored = (Array.isArray(ignoredRaw) ? ignoredRaw : []).filter((item): item is string => typeof item === 'string').map(gameKey).filter((exe) => exe.endsWith('.exe'));
  return { games, ignored: [...new Set(ignored)].slice(-GAMES_LIMIT) };
}

/** Игра «сейчас» для веба (`game.active`): что впереди или было впереди до того, как человек ушёл в Cord. */
export interface ActiveGame {
  exe: string;
  name: string;
  enabled: boolean;
  /** Эксклюзивный полноэкранный режим — оверлей не виден. */
  exclusive: boolean;
}

/**
 * Какая игра «сейчас запущена». Впереди игра — она. Впереди Cord — прежняя, пока жив её процесс
 * (человек переключился в настройки посреди игры). Впереди другое окно — игры нет.
 */
export function nextActive(previous: { game: ActiveGame; pid: number } | null, window: (GameWindow & { pid: number }) | null, game: GameEntry | null): { game: ActiveGame; pid: number } | null {
  if (!window) return null;
  if (game) return { game: { exe: game.exe, name: game.name, enabled: game.enabled, exclusive: window.exclusive === true }, pid: window.pid };
  if (window.cord) return previous;
  return null;
}
