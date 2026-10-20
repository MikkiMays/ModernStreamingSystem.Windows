/**
 * Окно «Серверы» (T05, П4): список из каталога Cord — флаг страны в круге слева, имя, пинг
 * справа; выбранный — подсвечен. Ручного добавления и поля адреса нет. Страница —
 * `cord-app://shell/servers.html`, данные приходят через `cordShell.call('servers.list')`.
 */
import { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { shellUrl } from '../protocol';

export class ServersWindow {
  readonly window: BrowserWindow;

  constructor(preloadDir: string, parent: BrowserWindow, onClosed: () => void) {
    this.window = new BrowserWindow({
      parent,
      modal: true,
      width: 440,
      height: 520,
      resizable: false,
      minimizable: false,
      maximizable: false,
      frame: false,
      roundedCorners: true,
      show: false,
      backgroundColor: '#15181f',
      title: 'Серверы',
      webPreferences: {
        preload: join(preloadDir, 'shell.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: !!process.env.CORD_DEVTOOLS,
      },
    });
    this.window.setMenuBarVisibility(false);
    this.window.once('ready-to-show', () => this.window.show());
    this.window.on('closed', onClosed);
    void this.window.loadURL(shellUrl('servers'));
  }

  focus(): void {
    if (!this.window.isDestroyed()) this.window.focus();
  }

  close(): void {
    if (!this.window.isDestroyed()) this.window.close();
  }
}
