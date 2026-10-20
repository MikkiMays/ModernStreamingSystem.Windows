/**
 * Трей и панель задач (T53, ADR 0001 §4.4): значок в трее с пунктами «Микрофон», «Открыть»,
 * «Выйти»; кнопки на миниатюре (микрофон, камера, завершить); значок поверх иконки («во
 * встрече», «микрофон выключен»); список переходов; прогресс файла; мигание при упоминании.
 * Номера версии нигде нет (T58).
 */
import { app, BrowserWindow, Menu, nativeImage, Tray, type NativeImage } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface TrayHost {
  open(): void;
  toggleMicrophone(): void;
  quit(): void;
}

export interface CallState {
  inCall: boolean;
  mic: boolean;
  camera: boolean;
  screen: boolean;
}

function icon(appPath: string, name: string): NativeImage {
  for (const candidate of [join(appPath, 'build', name), join(appPath, 'dist', 'shell', name)])
    if (existsSync(candidate)) return nativeImage.createFromPath(candidate);
  return nativeImage.createEmpty();
}

/** Круглый значок состояния — рисуется из SVG, чтобы не держать PNG на каждый случай. */
function dot(color: string): NativeImage {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7" fill="${color}" stroke="white" stroke-width="1.5"/></svg>`;
  return nativeImage.createFromDataURL('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
}

export class Taskbar {
  private tray: Tray | null = null;
  private state: CallState = { inCall: false, mic: false, camera: false, screen: false };

  constructor(
    private readonly appPath: string,
    private readonly host: TrayHost,
  ) {}

  installTray(): void {
    if (this.tray) return;
    this.tray = new Tray(icon(this.appPath, 'icon.ico'));
    this.tray.setToolTip('Cord');
    this.tray.on('click', () => this.host.open());
    this.refreshTray();
  }

  private refreshTray(): void {
    if (!this.tray) return;
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Открыть Cord', click: () => this.host.open() },
        { label: this.state.mic ? 'Выключить микрофон' : 'Включить микрофон', enabled: this.state.inCall, click: () => this.host.toggleMicrophone() },
        { type: 'separator' },
        { label: 'Выйти', click: () => this.host.quit() },
      ]),
    );
  }

  /** Кнопки на миниатюре и значок поверх иконки — по состоянию звонка. */
  applyCall(window: BrowserWindow | null, state: CallState, actions: { mic(): void; camera(): void; leave(): void }): void {
    this.state = state;
    this.refreshTray();
    if (!window || window.isDestroyed()) return;
    if (process.platform !== 'win32') return;
    if (!state.inCall) {
      window.setThumbarButtons([]);
      window.setOverlayIcon(null, '');
      return;
    }
    window.setThumbarButtons([
      { tooltip: state.mic ? 'Выключить микрофон' : 'Включить микрофон', icon: dot(state.mic ? '#3ddc84' : '#8a93a6'), click: actions.mic },
      { tooltip: state.camera ? 'Выключить камеру' : 'Включить камеру', icon: dot(state.camera ? '#3564f3' : '#8a93a6'), click: actions.camera },
      { tooltip: 'Завершить', icon: dot('#e5484d'), click: actions.leave },
    ]);
    window.setOverlayIcon(dot(state.mic ? '#3ddc84' : '#e5484d'), state.mic ? 'Во встрече' : 'Микрофон выключен');
  }

  setBadge(window: BrowserWindow | null, count: number): void {
    if (!window || window.isDestroyed() || process.platform !== 'win32' || this.state.inCall) return;
    if (count <= 0) window.setOverlayIcon(null, '');
    else window.setOverlayIcon(dot('#3564f3'), `${count} непрочитанных`);
  }

  setProgress(window: BrowserWindow | null, value: number): void {
    if (!window || window.isDestroyed()) return;
    window.setProgressBar(value < 0 ? -1 : value);
  }

  attention(window: BrowserWindow | null): void {
    if (!window || window.isDestroyed() || window.isFocused()) return;
    window.flashFrame(true);
    window.once('focus', () => window.flashFrame(false));
  }

  /** Список переходов: «Новая встреча» и закреплённые комнаты (`cord://room/<код>`). */
  setJumpList(favorites: { title: string; code: string }[]): void {
    if (process.platform !== 'win32') return;
    app.setJumpList([
      {
        type: 'custom',
        name: 'Cord',
        items: [{ type: 'task', title: 'Новая встреча', description: 'Создать встречу', program: process.execPath, args: 'cord://create', iconPath: process.execPath, iconIndex: 0 }],
      },
      ...(favorites.length
        ? [
            {
              type: 'custom' as const,
              name: 'Избранное',
              items: favorites.slice(0, 8).map((room) => ({
                type: 'task' as const,
                title: room.title,
                description: `Войти: ${room.code.slice(0, 3)}-${room.code.slice(3, 6)}-${room.code.slice(6)}`,
                program: process.execPath,
                args: `cord://room/${room.code}`,
                iconPath: process.execPath,
                iconIndex: 0,
              })),
            },
          ]
        : []),
    ]);
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
