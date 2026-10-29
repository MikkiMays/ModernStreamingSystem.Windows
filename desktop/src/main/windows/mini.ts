/**
 * Мини-окно звонка (R93; n06/n07 — Телемост; DESIGN.md → Мини-оверлей звонка): маленькое окно
 * поверх остальных, когда идёт звонок, а главного окна Cord не видно (`mini-policy.ts`). Компактное —
 * плитки тех, кто говорит, микрофон, показ и «ещё»; развёрнутое — своя плитка и всё управление
 * звонком, внизу красная «Выйти из встречи».
 *
 * Окно без рамки и без кнопки на панели задач, поверх обычных окон (`floating`), не берёт фокус
 * (`focusable: false`): нажатие в нём не уводит ввод из того окна, где человек работает. Место помнится
 * (`settings.mini`) и проверяется на видимость — монитор могли отключить. В показ экрана и запись не
 * попадает (`setContentProtection`). Размер — по содержимому: страница сообщает его (`mini.size`).
 *
 * Непрозрачное и без тени (R137, владелец 29.10): прозрачное окно на Windows — это поле 12 px вокруг
 * карточки под тень, которое ловит мышь, «съедает» настоящие щелчки (проверка попадания по альфе) и
 * после сна, сброса GPU или смены DPI замирает. Теперь окно — это сама карточка: фон окна — её цвет,
 * без `WS_THICKFRAME` нет ни тени, ни анимации появления Windows; углы на Windows 11 скругляет сама
 * система (`roundedCorners`), на Windows 10 — прямые.
 *
 * Перетаскивание — своим кодом, а не `app-region: drag` (R137): страница шлёт сдвиг мыши
 * (`mini.drag`), окно едет за ней. Полоса заголовка Windows съедала щелчки и двойной щелчок, а по
 * правой кнопке открывала системное меню.
 *
 * Самовосстановление (R137): упавшее, зависшее или переставшее рисовать окно (сторож кадров,
 * `MINI_WATCH`), а также окно после сна, разблокировки, сброса GPU и смены мониторов пересоздаётся —
 * состояние повторяет `did-finish-load`. Не чаще `MINI_REBUILDS`; сверх лимита сломанное окно убирается
 * до срока, а целое остаётся как есть. При каждом показе странице уходит полный снимок: настройки,
 * состав, состояние.
 */
import { BrowserWindow, screen, type WebContents } from 'electron';
import { join } from 'node:path';
import { IPC } from '../../shared/bridge';
import { decideRebuild, MINI_WATCH, watchStep } from '../mini-policy';
import { shellUrl } from '../protocol';

/** Ширина окна: 220 (компактное) или 260 (развёрнутое) — карточка во всё окно, поля под тень нет. */
export const MINI_WIDTH = { compact: 220, expanded: 260 } as const;
/** Цвет карточки (`--stage-bg` в mini.css) — он же фон окна: без белой вспышки и без прозрачности. */
export const MINI_BACKGROUND = '#0a0c11';
const MAX_HEIGHT = 640;
/** Перетаскивание: сдвиг не дальше этого за раз — защита от мусорных чисел. */
const DRAG_LIMIT = 20_000;

export interface MiniHost {
  /** Окно сдвинули — запомнить левый верхний угол (DIP). */
  moved(x: number, y: number): void;
  /** Страница мини-окна загрузилась заново: ей нужен новый порт уровней. */
  loaded(contents: WebContents): void;
  /** Окно убрано (упало, зависло, пересоздаётся или лимит прошёл): если оно нужно, его создаст `setVisible`. */
  gone(reason: string): void;
  /** Смотрит ли человек на экран: двигал мышь или клавиатуру недавно и экран не заблокирован. */
  active(): boolean;
  log(message: string): void;
}

export class MiniWindow {
  private window: BrowserWindow | null = null;
  private state: Record<string, unknown> = {};
  /** Моменты пересозданий за последние 5 минут (`MINI_REBUILDS`). */
  private rebuilds: number[] = [];
  /** Сломанное окно убрано сверх лимита — до этого момента новое не создаётся. */
  private blockedUntil = 0;
  private blockTimer: ReturnType<typeof setTimeout> | null = null;
  /** Сторож кадров: таймер вопросов, номер последнего вопроса, пропуски подряд. */
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private answerTimer: ReturnType<typeof setTimeout> | null = null;
  private asked = 0;
  private waiting = 0;
  private misses = 0;
  /** Экран заблокирован или система спит: кадров нет ни у кого, сторож молчит. */
  private paused = false;
  /** Перетаскивание: откуда поехало окно. */
  private drag: { x: number; y: number } | null = null;

  constructor(
    private readonly preloadDir: string,
    private readonly host: MiniHost,
  ) {}

  private create(position: { x?: number; y?: number }, expanded: boolean): BrowserWindow {
    const width = expanded ? MINI_WIDTH.expanded : MINI_WIDTH.compact;
    const height = 320;
    const place = placeOnScreen(position, width, height);
    const window = new BrowserWindow({
      ...place,
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
    window.setAlwaysOnTop(true, 'floating');
    window.setContentProtection(true);
    window.setMenuBarVisibility(false);
    window.on('moved', () => {
      // Пока окно тащат, его двигает `dragMove` — место запоминается один раз, в конце.
      if (window.isDestroyed() || this.drag) return;
      const [x = 0, y = 0] = window.getPosition();
      this.host.moved(x, y);
    });
    window.webContents.on('did-finish-load', () => {
      if (window.isDestroyed()) return;
      this.host.loaded(window.webContents);
      this.replay(window.webContents);
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
    void window.loadURL(shellUrl('mini', 'mini'));
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
  prepare(position: { x?: number; y?: number }, expanded: boolean): void {
    if (this.blocked) return;
    if (this.window?.isDestroyed()) this.window = null;
    this.window ??= this.create(position, expanded);
  }

  get contents(): WebContents | null {
    return this.window && !this.window.isDestroyed() ? this.window.webContents : null;
  }

  get visible(): boolean {
    return !!this.window && !this.window.isDestroyed() && this.window.isVisible();
  }

  setVisible(visible: boolean, position: { x?: number; y?: number }, expanded: boolean): void {
    if (!visible) {
      if (this.visible) this.window!.hide();
      return;
    }
    if (this.blocked) return;
    if (this.window?.isDestroyed()) this.window = null;
    this.window ??= this.create(position, expanded);
    if (!this.window.isVisible()) {
      // Монитор с запомненным местом могли отключить — окно возвращается на видимый экран.
      const [width = 0, height = 0] = this.window.getSize();
      const place = placeOnScreen(position, width, height);
      this.window.setPosition(place.x, place.y);
      // Полный снимок при каждом показе: пропавшее, пока окно было спрятано, не останется пропавшим.
      this.resync();
      this.window.showInactive();
    }
  }

  /** Страница сообщила свой размер (CSS-пиксели карточки). */
  resize(width: number, height: number): void {
    if (!this.window || this.window.isDestroyed()) return;
    const w = Math.round(Math.min(MINI_WIDTH.expanded, Math.max(MINI_WIDTH.compact, width)));
    const h = Math.round(Math.min(MAX_HEIGHT, Math.max(120, height)));
    const [currentW, currentH] = this.window.getContentSize();
    if (currentW === w && currentH === h) return;
    // Растёт вниз от верхней полосы, но не за низ экрана: тогда — вверх.
    const [x = 0, y = 0] = this.window.getPosition();
    const area = screen.getDisplayMatching({ x, y, width: w, height: h }).workArea;
    const top = Math.max(area.y, Math.min(y, area.y + area.height - h));
    this.window.setBounds({ x, y: top, width: w, height: h });
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

  /** Экран заблокирован или система уснула (`true`), вернулась (`false`): пропуски кадров не считаются. */
  pause(paused: boolean): void {
    this.paused = paused;
    this.misses = 0;
  }

  /**
   * Пересоздать окно. `broken` — окно точно не работает (упало, зависло, не рисует): сверх лимита
   * оно убирается до срока. Иначе (сон, GPU, мониторы — окно могло это пережить) сверх лимита — только
   * запись в журнал.
   */
  rebuild(reason: string, broken: boolean): void {
    const window = this.window && !this.window.isDestroyed() ? this.window : null;
    if (!window) return;
    const now = Date.now();
    const decision = decideRebuild(this.rebuilds, now);
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
    this.rebuilds = decision.history;
    this.host.log(`мини-окно: ${reason} — пересоздаём`);
    this.drop(window);
    this.host.gone(reason);
  }

  private drop(window: BrowserWindow): void {
    if (this.window === window) this.window = null;
    this.unwatch();
    this.drag = null;
    if (!window.isDestroyed()) window.destroy();
  }

  // ----- перетаскивание (R137) -----

  /** Страница начала тащить окно за полосу. */
  dragStart(): void {
    if (!this.window || this.window.isDestroyed()) return;
    const [x = 0, y = 0] = this.window.getPosition();
    this.drag = { x, y };
  }

  /** Сдвиг мыши от начала перетаскивания (DIP экрана). */
  dragMove(dx: number, dy: number): void {
    const drag = this.drag;
    if (!drag || !this.window || this.window.isDestroyed() || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const clamp = (value: number) => Math.round(Math.max(-DRAG_LIMIT, Math.min(DRAG_LIMIT, value)));
    this.window.setPosition(drag.x + clamp(dx), drag.y + clamp(dy));
  }

  /** Отпустили: окно остаётся на видимом экране, место запоминается. */
  dragEnd(): void {
    if (!this.drag) return;
    this.drag = null;
    if (!this.window || this.window.isDestroyed()) return;
    const [width = 0, height = 0] = this.window.getSize();
    const [x = 0, y = 0] = this.window.getPosition();
    const place = placeOnScreen({ x, y }, width, height);
    if (place.x !== x || place.y !== y) this.window.setPosition(place.x, place.y);
    this.host.moved(place.x, place.y);
  }

  destroy(): void {
    this.unwatch();
    if (this.blockTimer) clearTimeout(this.blockTimer);
    this.blockTimer = null;
    this.window?.destroy();
    this.window = null;
  }
}

/** Запомненное место, если оно на каком-то экране; иначе — снизу справа рабочей области основного. */
export function placeOnScreen(position: { x?: number; y?: number }, width: number, height: number): { x: number; y: number } {
  if (position.x !== undefined && position.y !== undefined) {
    const visible = screen.getAllDisplays().some(({ workArea: a }) => position.x! + width > a.x + 40 && position.x! < a.x + a.width - 40 && position.y! >= a.y - 4 && position.y! < a.y + a.height - 40);
    if (visible) return { x: position.x, y: position.y };
  }
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - width - 12, y: area.y + area.height - height - 12 };
}
