/**
 * Мини-окно звонка (R93; n06/n07 — Телемост; DESIGN.md → Мини-оверлей звонка): маленькое окно
 * поверх остальных, когда идёт звонок, а главного окна Cord не видно (`mini-policy.ts`). Компактное —
 * плитки тех, кто говорит, микрофон, показ и «ещё»; развёрнутое — своя плитка и всё управление
 * звонком, внизу красная «Выйти из встречи».
 *
 * Окно без рамки и без кнопки на панели задач, поверх обычных окон (`floating`), не берёт фокус
 * (`focusable: false`): нажатие в нём не уводит ввод из того окна, где человек работает. Место помнится
 * (`settings.mini`) — куда окно поставил человек; стоит оно там, но всегда целиком в рабочей области
 * своего экрана (`placeMini`, R188): развёрнутое у нижнего края не уходит под панель задач, монитор с
 * запомненным местом могли отключить. В показ экрана и запись не попадает (`setContentProtection`).
 * Размер — по содержимому: страница сообщает его (`mini.size`).
 *
 * Непрозрачное и без тени (R137, владелец 29.10): прозрачное окно на Windows — это поле 12 px вокруг
 * карточки под тень, которое ловит мышь, «съедает» настоящие щелчки (проверка попадания по альфе) и
 * после сна, сброса GPU или смены DPI замирает. Теперь окно — это сама карточка: фон окна — её цвет,
 * без `WS_THICKFRAME` нет ни тени, ни анимации появления Windows; углы на Windows 11 скругляет сама
 * система (`roundedCorners`), на Windows 10 — прямые.
 *
 * Перетаскивание — своим кодом, а не `app-region: drag` (R137): полоса заголовка Windows съедала
 * щелчки и двойной щелчок, а по правой кнопке открывала системное меню. Страница говорит «взяли за эту
 * точку», «тащат», «отпустили» (`mini.drag`), а main ставит окно так, чтобы эта точка была под настоящим
 * курсором (`dragPosition`, R188) — не по сумме сдвигов `screenX` страницы: те отставали, терялись и на
 * мониторах с разным масштабом считались в разных единицах.
 *
 * Каждый показ — новое окно (R188, владелец 03.11.2026: «подвигал, расширил, потом вернулся в корд и
 * снова скрыл — перестаёт двигаться и никакого взаимодействия»). Окно, которое уже показывалось, при
 * прятании уничтожается, а новое хозяин сразу заготавливает спрятанным, пока впереди Cord: к следующему
 * показу оно загружено, с портом уровней и снимком состояния, и появляется без мигания. Так ничто из
 * прежнего показа — захват мыши, недоделанное перетаскивание, место в порядке окон, поверхность после
 * смены размера, масштаба или монитора — не переживает прятания. Сторож кадров видит только окно, которое
 * не рисует; окно, которое рисует, но не получает мышь, он не видит — его и не остаётся. Порядок поверх
 * окон утверждается заново при каждом показе.
 *
 * Самовосстановление (R137): упавшее, зависшее или переставшее рисовать окно (сторож кадров,
 * `MINI_WATCH`) пересоздаётся — состояние повторяет `did-finish-load`. Не чаще `MINI_REBUILDS`; сверх
 * лимита сломанное окно убирается до срока, а целое остаётся как есть. После сна, разблокировки, сброса
 * GPU и смены мониторов (`renew`, R188) спрятанное окно просто заменяется, а видимое пересоздаётся один
 * раз на пачку событий и со своим лимитом — пробуждение не тратит пересоздания сторожа. При каждом показе
 * странице уходит полный снимок: настройки, состав, состояние.
 */
import { BrowserWindow, screen, type WebContents } from 'electron';
import { join } from 'node:path';
import { IPC } from '../../shared/bridge';
import { decideRebuild, dragPosition, MINI_RENEW, MINI_WATCH, placeMini, readGrab, watchStep } from '../mini-policy';
import { shellUrl } from '../protocol';

/** Ширина окна: 220 (компактное) или 260 (развёрнутое) — карточка во всё окно, поля под тень нет. */
export const MINI_WIDTH = { compact: 220, expanded: 260 } as const;
/** Цвет карточки (`--stage-bg` в mini.css) — он же фон окна: без белой вспышки и без прозрачности. */
export const MINI_BACKGROUND = '#0a0c11';
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 640;
/** Высота нового окна, пока страница не назвала свою. */
const FIRST_HEIGHT = 320;

type Position = { x?: number; y?: number };

export interface MiniHost {
  /** Человек дотащил окно до нового места — запомнить левый верхний угол (DIP). */
  moved(x: number, y: number): void;
  /** Страница мини-окна загрузилась заново: ей нужен новый порт уровней. */
  loaded(contents: WebContents): void;
  /** Окно убрано (упало, зависло, пересоздаётся или лимит прошёл): если оно нужно, его создаст `prepare` / `setVisible`. */
  gone(reason: string): void;
  /** Тексты и вид (`mini.config`) — каждому новому окну. */
  config(): Record<string, unknown>;
  /** Смотрит ли человек на экран: двигал мышь или клавиатуру недавно и экран не заблокирован. */
  active(): boolean;
  log(message: string): void;
}

export class MiniWindow {
  private window: BrowserWindow | null = null;
  private state: Record<string, unknown> = {};
  /** Моменты пересозданий за последние 5 минут (`MINI_REBUILDS`): сломанного окна и из-за системы — порознь. */
  private rebuilds: { broken: number[]; renew: number[] } = { broken: [], renew: [] };
  /** Сломанное окно убрано сверх лимита — до этого момента новое не создаётся. */
  private blockedUntil = 0;
  private blockTimer: ReturnType<typeof setTimeout> | null = null;
  /** Сторож кадров: таймер вопросов, номер последнего вопроса, пропуски подряд. */
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private answerTimer: ReturnType<typeof setTimeout> | null = null;
  private asked = 0;
  private waiting = 0;
  private misses = 0;
  /** Экран заблокирован или система спит: кадров нет ни у кого, сторож молчит, пересоздание ждёт. */
  private paused = false;
  /** Пересоздание из-за системы ждёт тишины (`MINI_RENEW`): причины пачки событий. */
  private renewTimer: ReturnType<typeof setTimeout> | null = null;
  private renewReasons: string[] = [];
  /** Перетаскивание: за какую точку окна его взяли (DIP от левого верхнего угла). */
  private drag: { x: number; y: number } | null = null;
  /** Окно уже показывалось: спрятать — значит убрать совсем (R188). */
  private used = false;
  /** Страница окна загрузилась: окно показывается уже с содержимым. */
  private ready = false;
  /** Показ ждёт загрузки страницы. */
  private pending = false;
  /** Куда окно поставил человек (DIP); стоит оно там, но целиком в рабочей области (`placeMini`). */
  private anchor: Position = {};
  /** Высота по содержимому для каждой ширины (компактное, развёрнутое): новое окно — сразу нужного размера. */
  private readonly heights = new Map<number, number>();
  /** Номер окна в адресе (`?n=`): окна разных показов различимы в журнале и в проверках. */
  private serial = 0;

  constructor(
    private readonly preloadDir: string,
    private readonly host: MiniHost,
  ) {}

  /** Окно, если оно есть и не уничтожено. */
  private get live(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }

  private create(position: Position, expanded: boolean): BrowserWindow {
    this.setAnchor(position);
    const width = expanded ? MINI_WIDTH.expanded : MINI_WIDTH.compact;
    const height = this.heights.get(width) ?? FIRST_HEIGHT;
    const window = new BrowserWindow({
      ...this.place(width, height),
      width,
      height,
      transparent: false,
      backgroundColor: MINI_BACKGROUND,
      frame: false,
      thickFrame: false,
      roundedCorners: true,
      hasShadow: false,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      alwaysOnTop: true,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        preload: join(this.preloadDir, 'shell.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
        backgroundThrottling: false,
      },
    });
    this.used = false;
    this.ready = false;
    this.pending = false;
    this.drag = null;
    this.state['mini.config'] = this.host.config();
    window.setAlwaysOnTop(true, 'floating');
    window.setContentProtection(true);
    window.setMenuBarVisibility(false);
    const finish = (loaded: boolean) => {
      if (window.isDestroyed() || this.window !== window) return;
      this.ready = true;
      if (loaded) {
        this.host.loaded(window.webContents);
        this.replay(window.webContents);
      }
      if (this.pending) this.reveal();
    };
    window.webContents.on('did-finish-load', () => finish(true));
    // Страница не загрузилась — окно всё равно показывается, когда нужно: сторож кадров увидит, что оно
    // не отвечает, и пересоздаст его.
    window.webContents.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => {
      if (isMainFrame) finish(false);
    });
    // Упавшее или зависшее окно поверх всех — прямоугольник, который ловит мышь и ни на что не
    // отвечает: убрать его и создать новое (состояние повторит `did-finish-load`).
    window.webContents.on('render-process-gone', (_, details) => {
      if (this.window === window) this.rebuild(`упало: ${details.reason}`, true);
    });
    window.on('unresponsive', () => {
      if (this.window === window) this.rebuild('не отвечает', true);
    });
    window.on('show', () => {
      if (this.window === window) this.watch();
    });
    window.on('hide', () => {
      if (this.window === window) this.unwatch();
    });
    void window.loadURL(`${shellUrl('mini', 'mini')}?n=${++this.serial}`);
    window.on('closed', () => {
      if (this.window !== window) return;
      this.window = null;
      this.unwatch();
    });
    return window;
  }

  /** Сломанное окно убрано сверх лимита и срок ещё не прошёл. */
  private get blocked(): boolean {
    return Date.now() < this.blockedUntil;
  }

  /** Создать заранее (без показа), чтобы появиться без мигания и с готовым портом уровней. */
  prepare(position: Position, expanded: boolean): void {
    if (this.blocked || this.live) return;
    this.window = this.create(position, expanded);
  }

  /** Встреча кончилась или мини-окно выключили: окна нет вовсе — ни показанного, ни заготовленного. */
  release(): void {
    const window = this.live;
    if (window) this.drop(window);
  }

  get contents(): WebContents | null {
    return this.live?.webContents ?? null;
  }

  get visible(): boolean {
    return !!this.live?.isVisible();
  }

  setVisible(visible: boolean, position: Position, expanded: boolean): void {
    if (!visible) {
      this.pending = false;
      this.drag = null;
      const window = this.live;
      // Показанное окно не ждёт следующего показа спрятанным, а уходит совсем (R188): новое, чистое,
      // заготовит хозяин (`prepare`).
      if (window && (this.used || window.isVisible())) this.drop(window);
      return;
    }
    if (this.blocked) return;
    this.setAnchor(position);
    const window = this.live ?? (this.window = this.create(position, expanded));
    if (window.isVisible()) return;
    // Страница ещё грузится — окно покажет `did-finish-load`: без пустой карточки и прыжка размера.
    this.pending = true;
    if (this.ready) this.reveal();
  }

  private reveal(): void {
    this.pending = false;
    const window = this.live;
    if (!window || window.isVisible()) return;
    const [width = 0, height = 0] = window.getSize();
    const place = this.place(width, height);
    window.setPosition(place.x, place.y);
    // Полный снимок при каждом показе: пропавшее, пока окно было спрятано, не останется пропавшим.
    this.resync();
    this.used = true;
    window.showInactive();
    // Поверх окон — заново при каждом показе: пока окна не было, наверх могли встать другие окна «поверх всех».
    window.setAlwaysOnTop(true, 'floating');
  }

  /** Страница сообщила свой размер (CSS-пиксели карточки). */
  resize(width: number, height: number): void {
    const window = this.live;
    if (!window) return;
    const w = Math.round(Math.min(MINI_WIDTH.expanded, Math.max(MINI_WIDTH.compact, width)));
    const h = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height)));
    this.heights.set(w, h);
    const [currentW, currentH] = window.getContentSize();
    if (currentW === w && currentH === h) return;
    // Пока окно тащат, оно остаётся под курсором. Иначе — на своём месте, но целиком в рабочей области:
    // развёрнутое у нижнего края поднимается, свёрнутое обратно — опускается на место (R188).
    const [x = 0, y = 0] = window.getPosition();
    const place = this.drag ? { x, y } : this.place(w, h);
    window.setBounds({ x: place.x, y: place.y, width: w, height: h });
  }

  /** Событие странице мини-окна; последнее каждого рода помнится для перезагрузки и показа. */
  send(event: string, payload: unknown): void {
    this.state[event] = payload;
    // Пока страница грузится, сообщение может пропасть — его повторит `did-finish-load`.
    this.contents?.send(IPC.shellEvent, event, payload);
  }

  /** Разовое событие (ответ на нажатие, вопрос сторожа): не помнится и не повторяется. */
  event(event: string, payload: unknown): void {
    this.contents?.send(IPC.shellEvent, event, payload);
  }

  /** Всё, что знает main, — заново: настройки, состав, состояние (показ окна, `mini.resync`). */
  resync(): void {
    const contents = this.contents;
    if (contents && !contents.isLoading()) this.replay(contents);
  }

  private replay(contents: WebContents): void {
    for (const [event, payload] of Object.entries(this.state)) contents.send(IPC.shellEvent, event, payload);
  }

  /** Место окна этого размера: у `anchor`, целиком в рабочей области (`placeMini`). */
  private place(width: number, height: number): { x: number; y: number } {
    const areas = screen.getAllDisplays().map((display) => display.workArea);
    return placeMini(this.anchor, { width, height }, areas, screen.getPrimaryDisplay().workArea);
  }

  private setAnchor(position: Position): void {
    this.anchor = position.x !== undefined && position.y !== undefined ? { x: position.x, y: position.y } : {};
  }

  // ----- сторож кадров (R137) -----

  private watch(): void {
    if (this.watchTimer) return;
    this.misses = 0;
    this.watchTimer = setInterval(() => this.ask(), MINI_WATCH.intervalMs);
  }

  private unwatch(): void {
    if (this.watchTimer) clearInterval(this.watchTimer);
    if (this.answerTimer) clearTimeout(this.answerTimer);
    this.watchTimer = null;
    this.answerTimer = null;
    this.waiting = 0;
    this.misses = 0;
  }

  /** Спросить кадр: страница отвечает `mini.pong` из `requestAnimationFrame` — значит, окно рисует. */
  private ask(): void {
    if (!this.visible || this.waiting) return;
    const seq = ++this.asked;
    this.waiting = seq;
    this.event('mini.ping', { seq });
    this.answerTimer = setTimeout(() => {
      this.answerTimer = null;
      if (this.waiting !== seq) return;
      this.waiting = 0;
      const step = watchStep(this.misses, false, !this.paused && this.host.active());
      this.misses = step.misses;
      if (step.rebuild) this.rebuild(`кадра нет ${MINI_WATCH.misses} раза подряд`, true);
    }, MINI_WATCH.timeoutMs);
  }

  /** Ответ страницы на `mini.ping`. */
  pong(seq: number): void {
    if (!seq || seq !== this.waiting) return;
    this.waiting = 0;
    if (this.answerTimer) clearTimeout(this.answerTimer);
    this.answerTimer = null;
    this.misses = watchStep(this.misses, true).misses;
  }

  /**
   * Экран заблокирован или система уснула (`true`), вернулась (`false`): пропуски кадров не считаются,
   * пересоздание из-за системы ждёт возвращения.
   */
  pause(paused: boolean): void {
    this.paused = paused;
    this.misses = 0;
    if (!paused && this.renewReasons.length && !this.renewTimer) this.renewTimer = setTimeout(() => this.renewNow(), MINI_RENEW.delayMs);
  }

  /**
   * Система могла сломать окно (R137, R188): сон, разблокировка, сброс GPU, смена мониторов. События одной
   * пачки (`resume`, следом `unlock-screen`, подключение монитора) — одно пересоздание через
   * `MINI_RENEW.delayMs` тишины; пока система спит или экран заблокирован — после возвращения.
   */
  renew(reason: string): void {
    if (!this.renewReasons.includes(reason)) this.renewReasons.push(reason);
    if (this.renewTimer) clearTimeout(this.renewTimer);
    this.renewTimer = setTimeout(() => this.renewNow(), MINI_RENEW.delayMs);
  }

  private renewNow(): void {
    this.renewTimer = null;
    if (this.paused) return;
    const reason = this.renewReasons.join(', ');
    this.renewReasons = [];
    const window = this.live;
    if (!reason || !window) return;
    if (!window.isVisible()) {
      // Спрятанное окно никто не видит: заменить новым без лимита.
      this.host.log(`мини-окно: ${reason} — заменено новым`);
      this.drop(window);
      this.host.gone(reason);
      return;
    }
    this.rebuild(reason, false);
  }

  /**
   * Пересоздать окно. `broken` — окно точно не работает (упало, зависло, не рисует): сверх лимита
   * оно убирается до срока. Иначе (сон, GPU, мониторы — окно могло это пережить) сверх лимита — только
   * запись в журнал. Лимиты у этих двух причин раздельные.
   */
  private rebuild(reason: string, broken: boolean): void {
    const window = this.live;
    if (!window) return;
    const now = Date.now();
    const kind = broken ? 'broken' : 'renew';
    const decision = decideRebuild(this.rebuilds[kind], now);
    if (!decision.allowed) {
      const seconds = Math.ceil((decision.retryAt - now) / 1000);
      if (!broken) {
        this.host.log(`мини-окно: ${reason} — не пересоздаём: лимит пересозданий, снова можно через ${seconds} с`);
        return;
      }
      this.host.log(`мини-окно: ${reason} — убрано до конца лимита пересозданий (${seconds} с)`);
      this.blockedUntil = decision.retryAt;
      this.drop(window);
      if (this.blockTimer) clearTimeout(this.blockTimer);
      this.blockTimer = setTimeout(() => {
        this.blockTimer = null;
        this.blockedUntil = 0;
        this.host.gone('лимит пересозданий прошёл');
      }, Math.max(0, decision.retryAt - now));
      return;
    }
    this.rebuilds[kind] = decision.history;
    this.host.log(`мини-окно: ${reason} — пересоздаём`);
    this.drop(window);
    this.host.gone(reason);
  }

  private drop(window: BrowserWindow): void {
    if (this.window === window) this.window = null;
    this.unwatch();
    this.drag = null;
    this.pending = false;
    this.used = false;
    this.ready = false;
    if (!window.isDestroyed()) window.destroy();
  }

  // ----- перетаскивание (R137, R188) -----

  /** Страница: окно взяли за точку `grab` (`{x, y}` страницы) и потащили. */
  dragStart(grab: unknown): void {
    const window = this.live;
    if (!window?.isVisible()) return;
    const [width = 0, height = 0] = window.getSize();
    const [x = 0, y = 0] = window.getPosition();
    const cursor = screen.getCursorScreenPoint();
    this.drag = readGrab(grab, { width, height }) ?? { x: cursor.x - x, y: cursor.y - y };
  }

  /** Страница: мышь сдвинулась — точка, за которую взяли, встаёт под курсор. */
  dragMove(): void {
    const window = this.live;
    if (!this.drag || !window) return;
    const next = dragPosition(screen.getCursorScreenPoint(), this.drag);
    const [x = 0, y = 0] = window.getPosition();
    if (next.x !== x || next.y !== y) window.setPosition(next.x, next.y);
  }

  /** Отпустили: окно целиком в рабочей области своего экрана, место запоминается. */
  dragEnd(): void {
    if (!this.drag) return;
    this.drag = null;
    const window = this.live;
    if (!window) return;
    const [x = 0, y = 0] = window.getPosition();
    const [width = 0, height = 0] = window.getSize();
    this.anchor = { x, y };
    const place = this.place(width, height);
    if (place.x !== x || place.y !== y) window.setPosition(place.x, place.y);
    this.anchor = place;
    this.host.moved(place.x, place.y);
  }

  destroy(): void {
    this.unwatch();
    if (this.blockTimer) clearTimeout(this.blockTimer);
    if (this.renewTimer) clearTimeout(this.renewTimer);
    this.blockTimer = null;
    this.renewTimer = null;
    this.window?.destroy();
    this.window = null;
  }
}
