/**
 * Трей и панель задач (T53, ADR 0001 §4.4): значок в трее с меню как у Телемоста (R103,
 * `tray-menu.ts`) и подсказкой-состоянием; кнопки на миниатюре (микрофон, камера, выйти); значок
 * поверх иконки («во встрече», «микрофон выключен»); список переходов; прогресс файла; мигание при
 * упоминании. Тексты — на языке Cord (`shell-text.ts`, X1). Номера версии нигде нет (T58).
 *
 * Картинка значка — `dist/shell/tray.ico` (R58, `tray-icon.ts`); не прочиталась — трей не создаётся,
 * и крестик закрывает Cord по-настоящему (`close-policy.ts`), а не прячет его «в никуда».
 */
import { app, BrowserWindow, Menu, nativeImage, Tray, type NativeImage } from 'electron';
import { existsSync } from 'node:fs';
import { overlayIconFor, showThumbar, type AppSettings } from './app-settings';
import type { ShellText } from './shell-text';
import { pickTrayImage, trayIconCandidates } from './tray-icon';
import { trayMenu, trayTooltip, type TrayItemId } from './tray-menu';

/** Что делают пункты меню трея (R103). */
export interface TrayHost {
  /** Показать окно (щелчок, двойной щелчок, «Вернуться во встречу»). */
  open(): void;
  newMeeting(): void;
  openChat(): void;
  openSettings(): void;
  toggleMicrophone(): void;
  toggleNotifications(): void;
  quit(): void;
}

export interface CallState {
  inCall: boolean;
  mic: boolean;
  camera: boolean;
  screen: boolean;
}

/** Картинка для трея из `dist/shell`; null — ни один файл не прочитался. */
export function trayImage(appPath: string): NativeImage | null {
  return pickTrayImage(trayIconCandidates(appPath), {
    exists: existsSync,
    load: (path) => nativeImage.createFromPath(path),
  }) as NativeImage | null;
}

/** Круглый значок состояния — рисуется из SVG, чтобы не держать PNG на каждый случай. */
function dot(color: string): NativeImage {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7" fill="${color}" stroke="white" stroke-width="1.5"/></svg>`;
  return nativeImage.createFromDataURL('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
}

export type TaskbarOptions = Pick<AppSettings, 'thumbar' | 'badge' | 'flash' | 'sleepBlocker' | 'notifications'>;

export class Taskbar {
  private tray: Tray | null = null;
  private state: CallState = { inCall: false, mic: false, camera: false, screen: false };
  /** Название встречи — в строке состояния меню и в подсказке. */
  private title = '';
  private unread = 0;
  /** Что сейчас нарисовано в меню: то же состояние и язык — меню не пересобирается. */
  private drawn = '';
  private actions: { mic(): void; camera(): void; leave(): void } = { mic() {}, camera() {}, leave() {} };

  constructor(
    private readonly appPath: string,
    private readonly host: TrayHost,
    /** Переключатели раздела «Windows» (E03) — читаются при каждом обновлении, а не запоминаются. */
    private readonly options: () => TaskbarOptions,
    /** Тексты на языке Cord — тоже при каждом обновлении: язык мог смениться. */
    private readonly text: () => ShellText,
  ) {}

  /** Значок в трее на месте — есть куда спрятать окно по крестику (R57). */
  get hasTray(): boolean {
    return this.tray !== null && !this.tray.isDestroyed();
  }

  /** Создать значок; без картинки — ошибка, трей остаётся выключенным. */
  installTray(): void {
    if (this.hasTray) return;
    const image = trayImage(this.appPath);
    if (!image) throw new Error('картинка значка не найдена (dist/shell/tray.ico, icon-256.png)');
    this.tray = new Tray(image);
    this.drawn = '';
    this.tray.on('click', () => this.host.open());
    this.tray.on('double-click', () => this.host.open());
    this.refreshTray();
  }

  /** Подсказка у значка (Windows): «Cord работает в трее» при первом прятании окна (R57). */
  hint(title: string, content: string): void {
    if (!this.tray || process.platform !== 'win32') return;
    try {
      this.tray.displayBalloon({ title, content, iconType: 'info' });
    } catch {
      /* баллон — не повод падать */
    }
  }

  /** Меню и подсказка по состоянию: встреча, микрофон, непрочитанные, «Уведомления», язык. */
  refreshTray(): void {
    if (!this.tray || this.tray.isDestroyed()) return;
    const text = this.text();
    const state = { inCall: this.state.inCall, mic: this.state.mic, title: this.title, unread: this.unread, notifications: this.options().notifications };
    // badge и call.state приходят часто — открытое меню не подменяется без причины.
    const drawn = JSON.stringify([state, text.statusIdle]);
    if (drawn === this.drawn) return;
    this.drawn = drawn;
    const actions: Record<TrayItemId, () => void> = {
      status: () => {},
      return: () => this.host.open(),
      new: () => this.host.newMeeting(),
      chat: () => this.host.openChat(),
      mic: () => this.host.toggleMicrophone(),
      notifications: () => this.host.toggleNotifications(),
      settings: () => this.host.openSettings(),
      quit: () => this.host.quit(),
    };
    this.tray.setToolTip(trayTooltip(state, text));
    this.tray.setContextMenu(
      Menu.buildFromTemplate(
        trayMenu(state, text).map((item) =>
          item.type === 'separator'
            ? { type: 'separator' as const }
            : {
                label: item.label,
                ...(item.enabled === false ? { enabled: false } : {}),
                ...(item.checked !== undefined ? { type: 'checkbox' as const, checked: item.checked } : {}),
                click: actions[item.id],
              },
        ),
      ),
    );
  }

  /** Убрать значок из трея — переключатель «Значок в трее» выключили. */
  removeTray(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  /** Кнопки на миниатюре, значок поверх иконки и меню трея — по состоянию звонка. */
  applyCall(window: BrowserWindow | null, state: CallState, actions: { mic(): void; camera(): void; leave(): void }, title = ''): void {
    this.state = state;
    this.title = state.inCall ? title : '';
    this.actions = actions;
    this.refreshTray();
    this.render(window);
  }

  setBadge(window: BrowserWindow | null, count: number): void {
    this.unread = count;
    this.refreshTray();
    this.render(window);
  }

  /** Перерисовать после смены переключателей или языка. */
  refresh(window: BrowserWindow | null): void {
    this.refreshTray();
    this.render(window);
  }

  private render(window: BrowserWindow | null): void {
    if (!window || window.isDestroyed() || process.platform !== 'win32') return;
    const options = this.options();
    const text = this.text();
    const state = this.state;
    window.setThumbarButtons(
      showThumbar(state, options)
        ? [
            { tooltip: state.mic ? text.micMute : text.micUnmute, icon: dot(state.mic ? '#3ddc84' : '#8a93a6'), click: () => this.actions.mic() },
            { tooltip: state.camera ? text.cameraOff : text.cameraOn, icon: dot(state.camera ? '#3564f3' : '#8a93a6'), click: () => this.actions.camera() },
            { tooltip: text.leave, icon: dot('#e5484d'), click: () => this.actions.leave() },
          ]
        : [],
    );
    switch (overlayIconFor(state, this.unread, options)) {
      case 'in-call':
        window.setOverlayIcon(dot('#3ddc84'), text.statusInCall);
        return;
      case 'muted':
        window.setOverlayIcon(dot('#e5484d'), text.muted);
        return;
      case 'unread':
        window.setOverlayIcon(dot('#3564f3'), text.unread.replace('{count}', String(this.unread)));
        return;
      case null:
        window.setOverlayIcon(null, '');
    }
  }

  setProgress(window: BrowserWindow | null, value: number): void {
    if (!window || window.isDestroyed()) return;
    window.setProgressBar(value < 0 ? -1 : value);
  }

  attention(window: BrowserWindow | null): void {
    if (!this.options().flash || !window || window.isDestroyed() || window.isFocused()) return;
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
