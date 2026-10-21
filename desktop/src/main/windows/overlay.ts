/**
 * Оверлей в играх (T23, ADR 0001 §4.3): прозрачное окно поверх всех, клики проходят сквозь
 * него, из захвата исключено (`setContentProtection` → `WDA_EXCLUDEFROMCAPTURE`). Никаких
 * инъекций в игру. Список участников — в левом верхнем углу монитора переднего окна
 * (`cord-native` отдаёт его точку, `placeAt`); без модуля — дисплей главного окна или основной.
 * По умолчанию выключен; виден только в звонке (`overlay-policy.ts`).
 */
import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { IPC } from '../../shared/bridge';
import { shellUrl } from '../protocol';

export class OverlayWindow {
  private window: BrowserWindow | null = null;

  constructor(private readonly preloadDir: string) {}

  private create(): BrowserWindow {
    const display = screen.getPrimaryDisplay();
    const window = new BrowserWindow({
      x: display.workArea.x + 12,
      y: display.workArea.y + 12,
      width: 320,
      height: 360,
      transparent: true,
      frame: false,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      hasShadow: false,
      show: false,
      alwaysOnTop: true,
      webPreferences: {
        preload: join(this.preloadDir, 'shell.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
      },
    });
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setIgnoreMouseEvents(true);
    window.setContentProtection(true);
    window.setMenuBarVisibility(false);
    void window.loadURL(shellUrl('overlay', 'overlay'));
    window.on('closed', () => {
      this.window = null;
    });
    return window;
  }

  setVisible(visible: boolean): void {
    if (visible) {
      this.window ??= this.create();
      this.window.showInactive();
    } else this.window?.hide();
  }

  private anchored: { x: number; y: number } | null = null;

  /**
   * Поставить в левый верхний угол дисплея с этой точкой (физические пиксели монитора переднего
   * окна); `null` — дисплей главного окна или основной. Положение меняется только при смене точки.
   */
  placeAt(anchor: { x: number; y: number } | null, fallback: Electron.Rectangle | null): void {
    if (!this.window || this.window.isDestroyed()) return;
    if (anchor && this.anchored && anchor.x === this.anchored.x && anchor.y === this.anchored.y) return;
    this.anchored = anchor;
    let display: Electron.Display;
    if (anchor) {
      const dip = typeof screen.screenToDipPoint === 'function' ? screen.screenToDipPoint(anchor) : anchor;
      display = screen.getDisplayNearestPoint(dip);
    } else display = fallback ? screen.getDisplayMatching(fallback) : screen.getPrimaryDisplay();
    this.window.setPosition(display.workArea.x + 12, display.workArea.y + 12);
  }

  get visible(): boolean {
    return !!this.window && this.window.isVisible();
  }

  update(participants: { name: string; tier: number; speaking: boolean }[]): void {
    if (!this.window || this.window.isDestroyed() || !this.window.isVisible()) return;
    this.window.webContents.send(IPC.shellEvent, 'overlay.state', { participants });
  }

  destroy(): void {
    this.window?.destroy();
    this.window = null;
  }
}
