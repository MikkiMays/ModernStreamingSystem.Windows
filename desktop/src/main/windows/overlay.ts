/**
 * Оверлей в играх (T23, ADR 0001 §4.3; виджет говорящих — R63): прозрачное окно во весь монитор
 * игры поверх всех, клики проходят сквозь него, из захвата исключено (`setContentProtection` →
 * `WDA_EXCLUDEFROMCAPTURE`: в показ экрана, запись и скриншоты оно не попадает). Никаких инъекций
 * в игру. Виджет говорящих рисует страница `cord-app://overlay/overlay.html` в выбранном углу.
 *
 * Ввод игры оверлей не забирает: окно без фокуса (`focusable: false` — клавиатура всегда у игры) и
 * прозрачное для мыши (`setIgnoreMouseEvents(true)`). Пересылку движения мыши (`forward: true`) не
 * включаем вовсе: в Windows Electron делает её глобальным хуком мыши (`WH_MOUSE_LL`) — лишняя
 * задержка каждому движению в игре и повод для античита. Мышь окно получает только разблокированным
 * своей клавишей (`overlay.lock`, `Shift+\``): тогда виджет перетаскивается, а карточка «Показать
 * игру» нажимается, — и до повторного нажатия той же клавиши; спрятался оверлей — снова заблокирован.
 *
 * Данные: состав (`overlay.roster`, аватары — `data:`) идёт через main, уровни голоса — по порту
 * прямо со страницы встречи (`LevelsLink` в `index.ts`), ≤ 30 раз в секунду, без main посередине.
 * Окно не усыпляется (`backgroundThrottling: false`) и рисуется ещё скрытым
 * (`paintWhenInitiallyHidden`): виден сразу, как только впереди игра. Виден только в звонке над
 * игрой из реестра (`overlay-policy.ts`).
 */
import { BrowserWindow, screen, type WebContents } from 'electron';
import { join } from 'node:path';
import type { NativeMonitor } from '../../native/protocol';
import { IPC } from '../../shared/bridge';
import { shellUrl } from '../protocol';

/** То, что знает страница оверлея о себе: угол, размер, имена, прозрачность, замок и тексты. */
export interface OverlayConfig {
  corner: string;
  size: string;
  names: string;
  opacity: number;
  offset: { x: number; y: number };
  locked: boolean;
  /** Сочетание разблокировки подписью («Shift+`») или `null`. */
  lockHotkey: string | null;
  language: string;
  text: Record<string, string>;
}

export class OverlayWindow {
  private window: BrowserWindow | null = null;
  private monitor: NativeMonitor | null = null;
  private locked = true;
  private config: OverlayConfig | null = null;
  private lastRoster: unknown = null;
  private lastCard: unknown = null;

  /** `onLoad` — страница оверлея загрузилась заново: ей нужен новый порт уровней. */
  constructor(
    private readonly preloadDir: string,
    private readonly onLoad: (contents: WebContents) => void,
  ) {}

  private create(): BrowserWindow {
    const display = screen.getPrimaryDisplay();
    const window = new BrowserWindow({
      ...display.bounds,
      transparent: true,
      frame: false,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      hasShadow: false,
      show: false,
      alwaysOnTop: true,
      paintWhenInitiallyHidden: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(this.preloadDir, 'shell.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
        backgroundThrottling: false,
      },
    });
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setIgnoreMouseEvents(true);
    window.setContentProtection(true);
    window.setMenuBarVisibility(false);
    window.webContents.on('did-finish-load', () => {
      if (window.isDestroyed()) return;
      this.onLoad(window.webContents);
      // Страница загрузилась заново — всё, что она знала, присылается ещё раз.
      if (this.config) this.send('overlay.config', { ...this.config, locked: this.locked });
      if (this.lastRoster) this.send('overlay.roster', this.lastRoster);
      if (this.lastCard) this.send('overlay.card', this.lastCard);
    });
    void window.loadURL(shellUrl('overlay', 'overlay'));
    window.on('closed', () => {
      this.window = null;
      this.monitor = null;
    });
    return window;
  }

  /** Создать окно заранее (без показа): страница прогреется, порт уровней будет готов к первой игре. */
  prepare(): void {
    this.window ??= this.create();
  }

  get contents(): WebContents | null {
    return this.window && !this.window.isDestroyed() ? this.window.webContents : null;
  }

  /** Показать во весь монитор игры (физические пиксели) или спрятать (`null`). */
  show(monitor: NativeMonitor | null): void {
    if (!monitor) {
      if (this.window && !this.window.isDestroyed() && this.window.isVisible()) this.window.hide();
      this.setLocked(true);
      return;
    }
    this.window ??= this.create();
    if (!this.monitor || monitor.x !== this.monitor.x || monitor.y !== this.monitor.y || monitor.width !== this.monitor.width || monitor.height !== this.monitor.height) {
      this.monitor = { ...monitor };
      this.window.setBounds(displayFor(monitor).bounds);
    }
    if (!this.window.isVisible()) this.window.showInactive();
  }

  get visible(): boolean {
    return !!this.window && !this.window.isDestroyed() && this.window.isVisible();
  }

  get isLocked(): boolean {
    return this.locked;
  }

  /** Замок (`overlay.lock`): разблокированный оверлей берёт мышь (но не клавиатуру), заблокированный — нет. */
  setLocked(locked: boolean): void {
    if (this.locked === locked) return;
    this.locked = locked;
    if (this.window && !this.window.isDestroyed()) this.window.setIgnoreMouseEvents(locked);
    this.send('overlay.lock', { locked });
  }

  configure(config: OverlayConfig): void {
    this.config = config;
    this.send('overlay.config', { ...config, locked: this.locked });
  }

  /** Состав встречи — новым порядком и аватарами; последний помнится для перезагрузки страницы. */
  roster(payload: unknown): void {
    this.lastRoster = payload;
    this.send('overlay.roster', payload);
  }

  /** Карточка «Показать игру» (R104) или `null` — убрать. */
  card(payload: unknown): void {
    this.lastCard = payload;
    this.send('overlay.card', payload ?? { game: null });
  }

  private send(event: string, payload: unknown): void {
    const contents = this.contents;
    if (contents && !contents.isLoading()) contents.send(IPC.shellEvent, event, payload);
  }

  destroy(): void {
    this.window?.destroy();
    this.window = null;
  }
}

/** Дисплей Electron по физическому прямоугольнику монитора из `cord-native`. */
export function displayFor(monitor: NativeMonitor): Electron.Display {
  const center = { x: monitor.x + Math.round(monitor.width / 2), y: monitor.y + Math.round(monitor.height / 2) };
  const dip = typeof screen.screenToDipPoint === 'function' ? screen.screenToDipPoint(center) : center;
  return screen.getDisplayNearestPoint(dip);
}
