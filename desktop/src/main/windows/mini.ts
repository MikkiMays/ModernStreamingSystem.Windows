/**
 * Мини-окно звонка (R93; n06/n07 — Телемост; DESIGN.md → Мини-оверлей звонка): маленькое окно
 * поверх остальных, когда идёт звонок, а главного окна Cord не видно (`mini-policy.ts`). Компактное —
 * плитки тех, кто говорит, микрофон, показ и «ещё»; развёрнутое — своя плитка и всё управление
 * звонком, внизу красная «Выйти из встречи».
 *
 * Окно без рамки и без кнопки на панели задач, поверх обычных окон (`floating`), не берёт фокус
 * (`focusable: false`): нажатие в нём не уводит ввод из того окна, где человек работает. Таскается за
 * верхнюю полосу (`-webkit-app-region: drag`), место помнится (`settings.mini`) и проверяется на
 * видимость — монитор могли отключить. В показ экрана и запись не попадает (`setContentProtection`).
 * Размер — по содержимому: страница сообщает высоту (`mini.size`), окно подстраивается.
 */
import { BrowserWindow, screen, type WebContents } from 'electron';
import { join } from 'node:path';
import { IPC } from '../../shared/bridge';
import { shellUrl } from '../protocol';

/** Ширина окна: 220 (компактное) или 260 (развёрнутое) плюс поле 12 px на тень вокруг. */
export const MINI_SHADOW = 12;
export const MINI_WIDTH = { compact: 220, expanded: 260 } as const;
const MAX_HEIGHT = 640;

export interface MiniHost {
  /** Окно сдвинули — запомнить левый верхний угол (DIP). */
  moved(x: number, y: number): void;
  /** Страница мини-окна загрузилась заново: ей нужен новый порт уровней. */
  loaded(contents: WebContents): void;
  /** Процесс мини-окна упал или завис — окно убрано; если оно нужно, его создаст `setVisible`. */
  gone(reason: string): void;
}

export class MiniWindow {
  private window: BrowserWindow | null = null;
  private state: Record<string, unknown> = {};

  constructor(
    private readonly preloadDir: string,
    private readonly host: MiniHost,
  ) {}

  private create(position: { x?: number; y?: number }, expanded: boolean): BrowserWindow {
    const width = (expanded ? MINI_WIDTH.expanded : MINI_WIDTH.compact) + MINI_SHADOW * 2;
    const height = 320;
    const place = placeOnScreen(position, width, height);
    const window = new BrowserWindow({
      ...place,
      width,
      height,
      transparent: true,
      frame: false,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
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
    window.setAlwaysOnTop(true, 'floating');
    window.setContentProtection(true);
    window.setMenuBarVisibility(false);
    window.on('moved', () => {
      if (window.isDestroyed()) return;
      const [x = 0, y = 0] = window.getPosition();
      this.host.moved(x, y);
    });
    window.webContents.on('did-finish-load', () => {
      if (window.isDestroyed()) return;
      this.host.loaded(window.webContents);
      for (const [event, payload] of Object.entries(this.state)) window.webContents.send(IPC.shellEvent, event, payload);
    });
    // Упавшее или зависшее окно поверх всех — прозрачный прямоугольник, который ловит мышь и ни на что
    // не отвечает: убрать его и создать новое (состояние повторит `did-finish-load`).
    const drop = (reason: string) => {
      if (window.isDestroyed()) return;
      if (this.window === window) this.window = null;
      window.destroy();
      this.host.gone(reason);
    };
    window.webContents.on('render-process-gone', (_, details) => drop(`упало: ${details.reason}`));
    window.on('unresponsive', () => drop('не отвечает'));
    void window.loadURL(shellUrl('mini', 'mini'));
    window.on('closed', () => {
      if (this.window === window) this.window = null;
    });
    return window;
  }

  /** Создать заранее (без показа), чтобы появиться без мигания белым и с готовым портом уровней. */
  prepare(position: { x?: number; y?: number }, expanded: boolean): void {
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
    if (this.window?.isDestroyed()) this.window = null;
    this.window ??= this.create(position, expanded);
    if (!this.window.isVisible()) {
      // Монитор с запомненным местом могли отключить — окно возвращается на видимый экран.
      const [width = 0, height = 0] = this.window.getSize();
      const place = placeOnScreen(position, width, height);
      this.window.setPosition(place.x, place.y);
      this.window.showInactive();
    }
  }

  /** Страница сообщила свой размер (CSS-пиксели содержимого с полем под тень). */
  resize(width: number, height: number): void {
    if (!this.window || this.window.isDestroyed()) return;
    const w = Math.round(Math.min(MINI_WIDTH.expanded + MINI_SHADOW * 2, Math.max(MINI_WIDTH.compact + MINI_SHADOW * 2, width)));
    const h = Math.round(Math.min(MAX_HEIGHT, Math.max(120, height)));
    const [currentW, currentH] = this.window.getContentSize();
    if (currentW === w && currentH === h) return;
    // Растёт вниз от верхней полосы, но не за низ экрана: тогда — вверх.
    const [x = 0, y = 0] = this.window.getPosition();
    const area = screen.getDisplayMatching({ x, y, width: w, height: h }).workArea;
    const top = Math.max(area.y, Math.min(y, area.y + area.height - h));
    this.window.setBounds({ x, y: top, width: w, height: h });
  }

  /** Событие странице мини-окна; последнее каждого рода помнится для перезагрузки страницы. */
  send(event: string, payload: unknown): void {
    this.state[event] = payload;
    // Пока страница грузится, сообщение может пропасть — его повторит `did-finish-load`.
    this.contents?.send(IPC.shellEvent, event, payload);
  }

  destroy(): void {
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
