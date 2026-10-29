/**
 * Трей и панель задач (T53, ADR 0001 §4.4): значок в трее с меню как у Телемоста (R103,
 * `tray-menu.ts`) и подсказкой-состоянием; прогресс файла; мигание при упоминании (`attention.ts`).
 * Кнопок на миниатюре и значка поверх иконки с 1.0.11 нет (R138): окно один раз очищается от них
 * (`clear`), больше они не ставятся. Тексты — на языке Cord (`shell-text.ts`, X1). Номера версии
 * нигде нет (T58).
 *
 * Картинка значка — `dist/shell/tray.ico` (R58, `tray-icon.ts`); не прочиталась — трей не создаётся,
 * и крестик закрывает Cord по-настоящему (`close-policy.ts`), а не прячет его «в никуда».
 */
import { app, BrowserWindow, Menu, nativeImage, Tray, type NativeImage } from 'electron';
import { existsSync } from 'node:fs';
import type { AppSettings } from './app-settings';
import { flashUntilFocus } from './attention';
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

export type TaskbarOptions = Pick<AppSettings, 'flash' | 'sleepBlocker' | 'notifications'>;

export class Taskbar {
  private tray: Tray | null = null;
  private state: CallState = { inCall: false, mic: false, camera: false, screen: false };
  /** Название встречи — в строке состояния меню и в подсказке. */
  private title = '';
  /** Непрочитанные в чате встречи — для «Чат · N» (из `mini.state`, у прежнего веба — из `badge`). */
  private unread = 0;
  /** Что сейчас нарисовано в меню: то же состояние и язык — меню не пересобирается. */
  private drawn = '';

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
    // mini.state и call.state приходят часто — открытое меню не подменяется без причины.
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

  /** Меню трея — по состоянию звонка. */
  applyCall(state: CallState, title = ''): void {
    this.state = state;
    this.title = state.inCall ? title : '';
    this.refreshTray();
  }

  /** Непрочитанные в чате встречи — «Чат · N» в меню трея. */
  setUnread(count: number): void {
    this.unread = count;
    this.refreshTray();
  }

  /** Перерисовать после смены переключателей или языка. */
  refresh(): void {
    this.refreshTray();
  }

  /**
   * Кнопки на миниатюре и значок поверх иконки убраны (R138): у окна их не должно быть, даже если
   * Windows что-то запомнила. Зовётся один раз на окно; дальше эти API не трогаются.
   */
  clear(window: BrowserWindow | null): void {
    if (!window || window.isDestroyed() || process.platform !== 'win32') return;
    window.setThumbarButtons([]);
    window.setOverlayIcon(null, '');
  }

  setProgress(window: BrowserWindow | null, value: number): void {
    if (!window || window.isDestroyed()) return;
    window.setProgressBar(value < 0 ? -1 : value);
  }

  attention(window: BrowserWindow | null): void {
    flashUntilFocus(window, this.options().flash);
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
