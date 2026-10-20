/**
 * Главное окно — одно `BrowserWindow` на сессию `persist:cord` (ADR 0001 §2.1): шапка своя
 * (`titleBarStyle: hidden` + `titleBarOverlay`), Mica на Windows 11, таймеры не замедляются в
 * свёрнутом окне, автовоспроизведение без жеста. Интерфейс встречи — с сервера Cord; локальные
 * страницы оболочки — загрузка и офлайн.
 *
 * Безопасность (§2.3): `sandbox`, `contextIsolation`, без Node; навигация только внутри origin
 * серверов человека; новые окна запрещены, внешняя https-ссылка — в системный браузер;
 * разрешения — только origin сервера и только media/display-capture/notifications/fullscreen/
 * clipboard; загрузки — только с origin сервера или blob:; `certificate-error` не переопределяется.
 */
import { app, BrowserWindow, nativeTheme, session, shell, type Session, type WebContents } from 'electron';
import { join } from 'node:path';
import { installContextMenu } from '../menu';
import { decideNavigation, isExternalWebLink, ServerOrigin } from '../origins';
import { OVERLAY_ORIGIN, SHELL_ORIGIN, shellUrl } from '../protocol';
import type { Settings } from '../settings';

export const SESSION_PARTITION = 'persist:cord';

const ALLOWED_PERMISSIONS = new Set(['media', 'display-capture', 'notifications', 'fullscreen', 'clipboard-sanitized-write', 'clipboard-read', 'pointerLock']);

/** Базовый CSP, если сервер вдруг не прислал свой (Caddy присылает). */
const FALLBACK_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data:; connect-src 'self' wss: https:; worker-src 'self' blob:; frame-ancestors 'none'";

export interface MainWindowHost {
  allowedOrigins(): readonly ServerOrigin[];
  saveWindow(state: Settings['window']): void;
  onClosed(): void;
  /** Закрытие окна в звонке: ждать `close.ready` ≤ 2,5 с. */
  requestClose(): Promise<void>;
  log(message: string): void;
}

export function configureSession(partition: Session, host: MainWindowHost): void {
  partition.setPermissionRequestHandler((contents, permission, callback, details) => {
    const origin = contents.getURL();
    const allowed = host.allowedOrigins().some((server) => server.owns(origin)) && ALLOWED_PERMISSIONS.has(permission);
    if (!allowed) host.log(`разрешение ${permission} для ${details.requestingUrl ?? origin}: отказ`);
    callback(allowed);
  });
  partition.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
    const origin = contents?.getURL() ?? requestingOrigin;
    return host.allowedOrigins().some((server) => server.owns(origin)) && ALLOWED_PERMISSIONS.has(permission);
  });
  partition.setDevicePermissionHandler(() => false);
  partition.on('will-download', (event, item) => {
    const url = item.getURL();
    const ours = url.startsWith('blob:') || host.allowedOrigins().some((server) => server.owns(url));
    if (!ours) {
      host.log(`загрузка ${url}: отказ`);
      event.preventDefault();
    }
  });
  partition.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'mainFrame') {
      callback({});
      return;
    }
    const headers = details.responseHeaders ?? {};
    const has = Object.keys(headers).some((name) => name.toLowerCase() === 'content-security-policy');
    callback(has ? {} : { responseHeaders: { ...headers, 'Content-Security-Policy': [FALLBACK_CSP] } });
  });
}

export function guardNavigation(contents: WebContents, host: MainWindowHost): void {
  const decide = (event: { preventDefault(): void }, url: string, what: string) => {
    const allowed = [...host.allowedOrigins()];
    const verdict = url.startsWith(SHELL_ORIGIN) || url.startsWith(OVERLAY_ORIGIN) ? 'allow' : decideNavigation(url, allowed);
    if (verdict === 'allow') return;
    event.preventDefault();
    if (verdict === 'external') void shell.openExternal(url);
    else host.log(`${what} ${url}: отказ`);
  };
  contents.on('will-navigate', (event, url) => decide(event, url, 'переход'));
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame) {
      // Вложенные кадры: только тот же origin, что и документ.
      const parent = contents.getURL();
      const ok = host.allowedOrigins().some((server) => server.owns(parent) && server.owns(event.url));
      if (!ok) event.preventDefault();
    }
  });
  contents.on('will-redirect', (event, url) => decide(event, url, 'перенаправление'));
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalWebLink(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

export class MainWindow {
  readonly window: BrowserWindow;
  private closing = false;

  constructor(preloadDir: string, private readonly host: MainWindowHost, saved: Settings['window'], theme: Settings['theme'], minimized = false) {
    nativeTheme.themeSource = theme;
    const dark = nativeTheme.shouldUseDarkColors;
    this.window = new BrowserWindow({
      width: saved?.width ?? 1180,
      height: saved?.height ?? 760,
      ...(saved?.x !== undefined && saved?.y !== undefined ? { x: saved.x, y: saved.y } : {}),
      minWidth: 720,
      minHeight: 480,
      show: false,
      title: 'Cord',
      backgroundColor: dark ? '#111419' : '#f4f6fa',
      ...(process.platform === 'win32'
        ? {
            titleBarStyle: 'hidden' as const,
            titleBarOverlay: { color: '#00000000', symbolColor: dark ? '#e9ecf1' : '#1a1d24', height: 36 },
            backgroundMaterial: 'mica' as const,
          }
        : { frame: false }),
      webPreferences: {
        preload: join(preloadDir, 'server.js'),
        partition: SESSION_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webviewTag: false,
        devTools: !!process.env.CORD_DEVTOOLS,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
        spellcheck: true,
      },
    });
    this.window.setMenuBarVisibility(false);
    if (saved?.maximized) this.window.maximize();
    guardNavigation(this.window.webContents, host);
    installContextMenu(this.window.webContents);
    this.window.webContents.on('render-process-gone', (_, details) => host.log(`рендерер упал: ${details.reason}`));
    this.window.on('close', (event) => {
      if (this.closing) return;
      event.preventDefault();
      this.closing = true;
      this.remember();
      void host.requestClose().finally(() => {
        if (!this.window.isDestroyed()) this.window.destroy();
      });
    });
    this.window.on('closed', () => host.onClosed());
    // Запуск вместе с Windows — свёрнутым в панель задач, без фокуса: человек не просил окно прямо сейчас.
    this.window.once('ready-to-show', () => (minimized ? this.window.minimize() : this.window.show()));
  }

  remember(): void {
    if (this.window.isDestroyed()) return;
    const bounds = this.window.getNormalBounds();
    this.host.saveWindow({ width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y, maximized: this.window.isMaximized() });
  }

  /** Полноэкранная загрузка (T55), пока идёт первая загрузка интерфейса. */
  async showLoading(): Promise<void> {
    await this.window.loadURL(shellUrl('loading'));
  }

  async showOffline(origin: ServerOrigin): Promise<void> {
    await this.window.loadURL(shellUrl('offline') + '?server=' + encodeURIComponent(origin.url));
  }

  /** Перейти на сервер. Ошибка загрузки — страница «нет связи». */
  async open(origin: ServerOrigin): Promise<boolean> {
    try {
      await this.window.loadURL(origin.url);
      return true;
    } catch (error) {
      this.host.log(`сервер ${origin.url} не загрузился: ${(error as Error).message}`);
      await this.showOffline(origin);
      return false;
    }
  }

  applyTheme(theme: Settings['theme']): void {
    nativeTheme.themeSource = theme;
    if (process.platform === 'win32' && !this.window.isDestroyed())
      this.window.setTitleBarOverlay({ color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#e9ecf1' : '#1a1d24', height: 36 });
  }

  focus(): void {
    if (this.window.isDestroyed()) return;
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
  }

  destroyForUpdate(): void {
    this.closing = true;
    this.remember();
    if (!this.window.isDestroyed()) this.window.destroy();
  }
}

export function cordSession(): Session {
  return session.fromPartition(SESSION_PARTITION);
}

export function appUserModelId(): void {
  if (process.platform === 'win32') app.setAppUserModelId('Cord');
}
