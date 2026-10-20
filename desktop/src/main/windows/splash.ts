/**
 * Заставка обновления (T58, В-1): окно 300×360 без рамки, тёмное, по центру экрана, со знаком
 * Cord и одной строкой. Создаётся первым в `app.whenReady()`; главное окно — только после неё.
 * Страница — `cord-app://shell/splash.html`, preload `shell.js`: наружу только `state` и две
 * кнопки, «Повторить» и «Открыть Cord».
 */
import { BrowserWindow, ipcMain, type Display, type IpcMainEvent } from 'electron';
import { join } from 'node:path';
import { IPC } from '../../shared/bridge';
import { shellUrl } from '../protocol';
import { runSplash, type SplashResult, type SplashState, type UpdateSteps } from '../update/splash-flow';

export type SplashChoice = 'retry' | 'open';

export class SplashWindow {
  readonly window: BrowserWindow;
  private closedByUs = false;

  constructor(preloadDir: string, display?: Display) {
    const bounds = display?.workArea;
    this.window = new BrowserWindow({
      width: 300,
      height: 360,
      ...(bounds ? { x: Math.round(bounds.x + (bounds.width - 300) / 2), y: Math.round(bounds.y + (bounds.height - 360) / 2) } : {}),
      center: !bounds,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      roundedCorners: true,
      show: false,
      backgroundColor: '#111419',
      title: 'Cord',
      webPreferences: {
        preload: join(preloadDir, 'shell.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webviewTag: false,
        devTools: !!process.env.CORD_DEVTOOLS,
        spellcheck: false,
      },
    });
    this.window.setMenuBarVisibility(false);
    this.window.once('ready-to-show', () => this.window.show());
    void this.window.loadURL(shellUrl('splash'));
  }

  show(state: SplashState): void {
    if (this.window.isDestroyed()) return;
    this.window.webContents.send(IPC.shellEvent, 'splash.state', state);
  }

  /** Дождаться выбора человека после сбоя: «Повторить» или «Открыть Cord». null — окно закрыли. */
  choice(): Promise<SplashChoice | null> {
    return new Promise((resolve) => {
      const onCall = (event: IpcMainEvent, method: unknown) => {
        if (event.sender.id !== this.window.webContents.id) return;
        if (method === 'splash.retry' || method === 'splash.open') {
          cleanup();
          resolve(method === 'splash.retry' ? 'retry' : 'open');
        }
      };
      const onClosed = () => {
        cleanup();
        resolve(null);
      };
      const cleanup = () => {
        ipcMain.off(IPC.shellCall, onCall);
        this.window.off('closed', onClosed);
      };
      ipcMain.on(IPC.shellCall, onCall);
      this.window.once('closed', onClosed);
    });
  }

  /**
   * Весь путь заставки: шаги обновления, при сбое — вопрос человеку, «Повторить» идёт по кругу.
   * Возвращает итог; null — заставку закрыли, приложению пора выйти.
   */
  async run(steps: UpdateSteps): Promise<SplashResult | null> {
    const controller = new AbortController();
    const onClosed = () => controller.abort();
    this.window.once('closed', onClosed);
    try {
      for (;;) {
        const result = await runSplash(steps, (state) => this.show(state), controller.signal);
        if (result.outcome !== 'failed') return result;
        this.show({ stage: 'failed', progress: 0, problem: result.problem });
        const choice = await this.choice();
        if (choice === null) return null;
        if (choice === 'open') return { ...result, outcome: 'open' };
      }
    } catch (error) {
      if (controller.signal.aborted) return null;
      throw error;
    } finally {
      this.window.off('closed', onClosed);
    }
  }

  close(): void {
    this.closedByUs = true;
    if (!this.window.isDestroyed()) this.window.close();
  }

  get wasClosedByUs(): boolean {
    return this.closedByUs;
  }
}
