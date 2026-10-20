/**
 * Cord для Windows на Electron — главный процесс (ADR 0001).
 *
 * Порядок старта (В-1, §5.1): один экземпляр → `cord-app://` → **заставка обновления** (проверка,
 * загрузка, установка) → только потом главное окно: полноэкранная загрузка (T55) → сервер.
 * Пока Cord открыт, зеркало спрашивается раз в 6 часов; нашлось и встречи нет — окно уступает
 * место заставке. Во встрече — ждём её конца.
 *
 * Версия приложения нигде не показывается, кроме «О программе» в вебе (`invoke('update.status')`).
 */
import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, net, powerSaveBlocker, safeStorage, screen, type WebContents } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FEATURES, IPC, type Bootstrap } from '../shared/bridge';
import type { HotkeyBinding, Validated } from './bridge/messages';
import { BridgeRouter } from './bridge/router';
import { buildConfig } from './config';
import { CaptureSelection, loopbackFor, type AudioMode } from './capture';
import { Catalog, CatalogServer, defaultServer, parseCatalogPayload, verifyCatalog } from './catalog';
import { deepLinkFromArgv, parseDeepLink, type DeepLink } from './deeplink';
import { HotkeyRegistry } from './hotkeys';
import { showNotification } from './notifications';
import { ServerOrigin } from './origins';
import { installShellProtocol, registerShellScheme, SHELL_SCHEME, shellUrl } from './protocol';
import { SettingsStore } from './settings';
import { Taskbar, type CallState } from './tray';
import { publicKey } from './update/manifest';
import { canInterrupt, nextCheckMs, BACKGROUND_BUDGET_MS, type UpdateVerdict } from './update/splash-flow';
import { CordUpdater } from './update/updater';
import { appUserModelId, configureSession, cordSession, MainWindow } from './windows/main';
import { OverlayWindow } from './windows/overlay';
import { SplashWindow } from './windows/splash';
import { ServersWindow } from './windows/servers';

// ---------- пути и один экземпляр ----------

if (process.platform === 'win32' && process.env.LOCALAPPDATA) app.setPath('userData', join(process.env.LOCALAPPDATA, 'Cord', 'desktop'));
const smoke = process.env.CORD_SMOKE === '1';
if (smoke) app.setPath('userData', join(app.getPath('temp'), `cord-smoke-${process.pid}`));

const logFile = join(app.getPath('userData'), 'desktop.log');
function log(message: string): void {
  try {
    mkdirSync(app.getPath('userData'), { recursive: true });
    appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* журнал — не повод падать */
  }
  if (process.env.CORD_DEVTOOLS || smoke) console.log(message);
}

registerShellScheme();
appUserModelId();
process.on('unhandledRejection', (reason) => log(`необработанное: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`));
process.on('uncaughtException', (error) => log(`исключение: ${error.stack ?? error.message}`));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_, argv) => {
    const link = deepLinkFromArgv(argv);
    shell.focus();
    if (link) shell.handleDeepLink(link);
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    const link = parseDeepLink(url);
    if (link) shell.handleDeepLink(link);
  });
  if (!app.isDefaultProtocolClient('cord') && !smoke) app.setAsDefaultProtocolClient('cord');
  app.on('certificate-error', (event, _contents, url, error, _certificate, callback) => {
    // Никогда не переопределяется: ошибка сертификата — это ошибка.
    log(`сертификат ${url}: ${error}`);
    callback(false);
  });
  app.on('web-contents-created', (_, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
  void app.whenReady().then(() => shell.start());
}

// ---------- приложение ----------

class Shell {
  private readonly preloadDir = join(app.getAppPath(), 'dist', 'preload');
  private readonly config = buildConfig(app.getAppPath());
  private readonly settings = new SettingsStore(app.getPath('userData'), safeStorage);
  private readonly router = new BridgeRouter({
    bootstrap: (origin) => this.bootstrap(origin),
    message: (message, sender) => this.onMessage(message, sender),
    call: (method, payload) => this.onCall(method, payload),
    version: () => app.getVersion(),
    log,
  });
  private readonly updater = new CordUpdater({
    currentVersion: app.getVersion(),
    channel: this.config.updateChannel,
    keys: this.config.updateKeys,
    expectedVersion: () => this.settings.get().expectedVersion,
    rememberExpected: (version) => void this.settings.update({ expectedVersion: version }),
    log,
  });
  private readonly taskbar = new Taskbar(app.getAppPath(), {
    open: () => this.focus(),
    toggleMicrophone: () => this.router.post('thumbar', { action: 'mic' }),
    quit: () => this.quit(),
  });
  private readonly hotkeys = new HotkeyRegistry(
    {
      register: (accelerator, callback) => {
        try {
          return globalShortcut.register(accelerator, callback);
        } catch {
          return false;
        }
      },
      unregister: (accelerator) => globalShortcut.unregister(accelerator),
    },
    (action) => this.router.post('hotkey', { action, phase: 'down' }),
  );
  private readonly capture = new CaptureSelection();
  private readonly overlay = new OverlayWindow(this.preloadDir);
  private main: MainWindow | null = null;
  private splash: SplashWindow | null = null;
  private servers: ServersWindow | null = null;
  private catalog: Catalog | null = null;
  private page: string | null = null;
  private call: CallState = { inCall: false, mic: false, camera: false, screen: false };
  private sleepBlocker: number | null = null;
  private pendingLink: DeepLink | null = null;
  private checkTimer: ReturnType<typeof setTimeout> | null = null;
  private quitting = false;

  // ----- старт -----

  async start(): Promise<void> {
    installShellProtocol();
    installShellProtocol(cordSession());
    configureSession(cordSession(), this.windowHost);
    this.router.install();
    this.installShellCalls();
    this.installDisplayMedia();
    this.pendingLink = deepLinkFromArgv(process.argv);
    await this.loadCatalog();
    await this.splashThenMain();
  }

  /**
   * Сначала заставка (В-1), как у Discord. Главное окно и страница сервера создаются только
   * после неё — когда ставить нечего, спросить не удалось или человек выбрал «Открыть Cord».
   */
  private async splashThenMain(display?: Electron.Display): Promise<void> {
    const splash = new SplashWindow(this.preloadDir, display);
    this.splash = splash;
    const result = await splash.run(this.updater);
    this.splash = null;
    if (result === null || result.outcome === 'restarting') {
      if (result === null) this.quit();
      return;
    }
    this.scheduleCheck(result.verdict);
    await this.openMain();
    splash.close();
  }

  private async openMain(): Promise<void> {
    const saved = this.settings.get();
    const main = new MainWindow(this.preloadDir, this.windowHost, saved.window, saved.theme);
    this.main = main;
    try {
      this.taskbar.installTray();
    } catch (error) {
      log(`трей: ${(error as Error).message}`);
    }
    await main.showLoading();
    const origin = this.currentOrigin();
    await this.router.prepareBootstrap(origin);
    this.router.attach(main.window.webContents, origin);
    await main.open(origin);
    if (this.pendingLink) {
      const link = this.pendingLink;
      this.pendingLink = null;
      this.handleDeepLink(link);
    }
  }

  private readonly windowHost = {
    allowedOrigins: () => this.allowedOrigins(),
    saveWindow: (state: ReturnType<SettingsStore['get']>['window']) => void this.settings.update({ window: state }),
    onClosed: () => {
      this.main = null;
      this.hotkeys.clear();
      this.overlay.setVisible(false);
      if (!this.quitting) this.quit();
    },
    requestClose: () => this.requestClose(),
    log,
  };

  /** Закрытие в звонке: страница отвечает `close.ready`, ждём ≤ 2,5 с (как сейчас). */
  private requestClose(): Promise<void> {
    if (!this.call.inCall) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        ipcMain.off(IPC.send, onReady);
        resolve();
      }, 2500);
      const onReady = (_: unknown, type: unknown) => {
        if (type !== 'close.ready') return;
        clearTimeout(timer);
        ipcMain.off(IPC.send, onReady);
        resolve();
      };
      ipcMain.on(IPC.send, onReady);
      this.router.post('close-request');
    });
  }

  private quit(): void {
    this.quitting = true;
    this.hotkeys.clear();
    this.taskbar.destroy();
    this.overlay.destroy();
    app.quit();
  }

  focus(): void {
    if (this.main) this.main.focus();
    else if (this.splash) this.splash.window.focus();
  }

  // ----- серверы и каталог -----

  private currentOrigin(): ServerOrigin {
    const saved = ServerOrigin.tryParse(this.settings.get().serverUrl);
    if (saved) return saved;
    const chosen = this.catalog ? defaultServer(this.catalog).url : this.config.defaultServer;
    const origin = ServerOrigin.parse(chosen);
    this.settings.update({ serverUrl: origin.url });
    return origin;
  }

  private allowedOrigins(): ServerOrigin[] {
    const list = [this.currentOrigin()];
    for (const server of this.catalog?.servers ?? []) {
      const origin = ServerOrigin.tryParse(server.url);
      if (origin && !list.some((known) => known.equals(origin))) list.push(origin);
    }
    for (const entry of this.settings.get().servers) {
      const origin = ServerOrigin.tryParse(entry.url);
      if (origin && !list.some((known) => known.equals(origin))) list.push(origin);
    }
    return list;
  }

  /** Каталог: подписанный JWS с главного сервера, иначе снимок из сборки. Неверный — остаётся прежний. */
  private async loadCatalog(): Promise<void> {
    const snapshot = join(app.getAppPath(), 'dist', 'shell', 'catalog.json');
    try {
      const { readFileSync, existsSync } = await import('node:fs');
      if (existsSync(snapshot)) this.catalog = parseCatalogPayload(readFileSync(snapshot, 'utf8'));
    } catch (error) {
      log(`снимок каталога: ${(error as Error).message}`);
    }
    const keys = (this.config as { catalogKeys?: string[] }).catalogKeys ?? [];
    if (keys.length === 0 || smoke) return;
    try {
      const response = await net.fetch(new URL('/api/v1/catalog', this.config.defaultServer).toString(), { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return;
      const catalog = verifyCatalog(await response.text(), keys.map(publicKey), this.settings.get().catalogSeq);
      this.catalog = catalog;
      this.settings.update({ catalogSeq: catalog.seq });
    } catch (error) {
      log(`каталог: ${(error as Error).message}`);
    }
  }

  private catalogServers(): (CatalogServer & { current: boolean })[] {
    const current = this.currentOrigin();
    const list = this.catalog?.servers ?? [{ id: 'default', name: { ru: new URL(this.config.defaultServer).host }, country: 'NL', url: this.config.defaultServer, order: 0, default: true }];
    return list.map((server) => ({ ...server, current: current.owns(server.url) }));
  }

  async chooseServer(url: string): Promise<void> {
    const origin = ServerOrigin.tryParse(url);
    if (!origin || !this.allowedOrigins().some((known) => known.equals(origin)) || !this.main) return;
    if (this.call.inCall) {
      const { response } = await dialog.showMessageBox(this.main.window, { type: 'question', buttons: ['Выйти из встречи', 'Остаться'], defaultId: 1, cancelId: 1, message: 'Сменить сервер?', detail: 'Текущая встреча закончится.' });
      if (response !== 0) return;
      await this.requestClose();
    }
    this.settings.update({ serverUrl: origin.url });
    await this.main.showLoading();
    await this.router.prepareBootstrap(origin);
    this.router.attach(this.main.window.webContents, origin);
    await this.main.open(origin);
  }

  // ----- мост -----

  private async bootstrap(origin: ServerOrigin): Promise<Bootstrap> {
    const saved = this.settings.get();
    const entry = saved.servers.find((server) => server.url === origin.url);
    return {
      profile: await this.settings.profileFor(origin),
      theme: saved.theme,
      showPing: saved.showPing,
      notificationSounds: saved.notificationSounds,
      autoConnect: entry?.autoConnect ?? saved.autoConnect,
    };
  }

  private onMessage(message: Validated, sender: WebContents): void {
    const window = this.main?.window ?? null;
    switch (message.type) {
      case 'state':
        this.page = message.page;
        this.updateCall({ ...this.call, inCall: message.inCall });
        if (message.theme !== this.settings.get().theme && (message.theme === 'light' || message.theme === 'dark' || message.theme === 'system')) {
          this.settings.update({ theme: message.theme });
          this.main?.applyTheme(message.theme);
        }
        return;
      case 'call.state':
        this.updateCall({ inCall: message.inCall, mic: message.mic, camera: message.camera, screen: message.screen });
        return;
      case 'hotkeys.configure': {
        this.settings.update({ hotkeys: message.bindings });
        const status = this.hotkeys.apply(message.bindings);
        this.router.post('hotkeys.status', { status });
        return;
      }
      case 'favorites.changed':
        return;
      case 'preferences.changed':
        this.settings.update({ ...(message.showPing !== undefined ? { showPing: message.showPing } : {}), ...(message.notificationSounds !== undefined ? { notificationSounds: message.notificationSounds } : {}) });
        return;
      case 'server.autoconnect': {
        const origin = this.router.origin;
        if (!origin) return;
        const servers = this.settings.get().servers.filter((server) => server.url !== origin.url);
        servers.unshift({ url: origin.url, name: '', autoConnect: message.autoConnect });
        this.settings.update({ servers, autoConnect: message.autoConnect });
        return;
      }
      case 'servers.open':
        this.openServers();
        return;
      case 'close.ready':
        return; // обрабатывается в requestClose
      case 'update.check':
        void this.backgroundCheck(true);
        return;
      case 'update.apply':
        void this.restartIntoSplash();
        return;
      case 'overlay.state':
        this.overlay.update(message.participants);
        return;
      case 'notify':
        showNotification(message, (id, tag) => {
          this.focus();
          this.router.post('notification.action', { id, ...(tag ? { tag } : {}) });
        });
        return;
      case 'attention':
        this.taskbar.attention(window);
        return;
      case 'progress':
        this.taskbar.setProgress(window, message.value);
        return;
      case 'badge':
        this.taskbar.setBadge(window, message.count);
        return;
      case 'capture.select':
        if (sender.id === this.main?.window.webContents.id) this.capture.select(message.id, message.audio);
        return;
    }
  }

  private async onCall(method: string, payload: unknown): Promise<unknown> {
    switch (method) {
      case 'update.status':
        return { ...this.updater.status };
      case 'session.renew':
        // Пароль сервера оболочка не хранит (В-2): рукопожатие делает сама страница.
        return { token: null };
      case 'capture.sources': {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true });
        return sources
          .filter((source) => !source.name.startsWith('Cord'))
          .map((source) => ({
            id: source.id,
            name: source.name.slice(0, 80),
            kind: source.id.startsWith('screen') ? 'screen' : 'window',
            thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
            icon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.resize({ width: 24 }).toDataURL() : '',
          }));
      }
      default:
        void payload;
        throw new Error('Недоступно.');
    }
  }

  private updateCall(next: CallState): void {
    const was = this.call;
    this.call = next;
    const window = this.main?.window ?? null;
    this.taskbar.applyCall(window, next, {
      mic: () => this.router.post('thumbar', { action: 'mic' }),
      camera: () => this.router.post('thumbar', { action: 'camera' }),
      leave: () => this.router.post('thumbar', { action: 'leave' }),
    });
    const keepAwake = next.inCall || next.screen;
    if (keepAwake && this.sleepBlocker === null) this.sleepBlocker = powerSaveBlocker.start('prevent-display-sleep');
    if (!keepAwake && this.sleepBlocker !== null) {
      powerSaveBlocker.stop(this.sleepBlocker);
      this.sleepBlocker = null;
    }
    if (next.inCall && this.settings.get().hotkeys.length && !this.hotkeys.active.length) this.hotkeys.apply(this.settings.get().hotkeys);
    this.overlay.setVisible(next.inCall && this.settings.get().overlayEnabled);
    if (was.inCall && !next.inCall && this.pendingSplash) void this.restartIntoSplash();
  }

  // ----- deep links -----

  handleDeepLink(link: DeepLink): void {
    if (!this.main) {
      this.pendingLink = link;
      return;
    }
    this.focus();
    switch (link.kind) {
      case 'room':
        this.router.post('deeplink', { room: { code: link.code } });
        return;
      case 'invite':
        this.router.post('deeplink', { room: { roomId: link.roomId } });
        return;
      case 'create':
        this.router.post('navigate', { page: 'create' });
        return;
      case 'settings':
        this.router.post('settings.open', { tab: link.tab ?? 'profile' });
        return;
      case 'open':
        return;
    }
  }

  // ----- обновление в фоне (§5.1) -----

  private pendingSplash = false;

  private scheduleCheck(verdict: UpdateVerdict): void {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    if (smoke) return;
    this.checkTimer = setTimeout(() => void this.backgroundCheck(false), nextCheckMs(verdict));
  }

  private async backgroundCheck(byHand: boolean): Promise<void> {
    const check = await this.updater.check(BACKGROUND_BUDGET_MS, new AbortController().signal);
    this.router.post('update.status', { ...this.updater.status });
    if (check.verdict !== 'forced') {
      this.scheduleCheck(check.verdict);
      return;
    }
    if (canInterrupt(this.call.inCall, this.page) || byHand) await this.restartIntoSplash();
    else this.pendingSplash = true;
  }

  /** Нашлось обновление, пока Cord открыт: главное окно уступает место заставке, дальше как при запуске. */
  private async restartIntoSplash(): Promise<void> {
    this.pendingSplash = false;
    const main = this.main;
    if (!main) return;
    const display = screen.getDisplayMatching(main.window.getBounds());
    this.quitting = true; // закрытие окна не должно завершить приложение
    main.destroyForUpdate();
    this.main = null;
    this.quitting = false;
    await this.splashThenMain(display);
  }

  // ----- захват -----

  private picker: BrowserWindow | null = null;
  private pickerResolve: ((selection: { id: string; audio: AudioMode } | null) => void) | null = null;

  /**
   * Веб зовёт `getDisplayMedia`. Если страница уже прислала `capture.select` (своё окно выбора по
   * E16) — отдаём его; иначе показываем окно выбора оболочки. Без выбора человека экрана не будет.
   */
  private installDisplayMedia(): void {
    cordSession().setDisplayMediaRequestHandler(
      (request, callback) => {
        const owner = this.router.origin;
        if (!owner || !owner.owns(request.frame?.url ?? '') || !this.main) {
          log('захват: запрос не со страницы сервера — отказ');
          callback({});
          return;
        }
        const resolve = (selection: { id: string; audio: AudioMode } | null) => {
          if (!selection) {
            callback({});
            return;
          }
          void desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } }).then((sources) => {
            const source = sources.find((candidate) => candidate.id === selection.id);
            if (!source) {
              callback({});
              return;
            }
            const audio = loopbackFor(selection.audio, process.platform);
            callback({ video: source, ...(audio ? { audio } : {}) });
          });
        };
        const fresh = this.capture.take();
        if (fresh) {
          resolve(fresh);
          return;
        }
        this.openPicker(resolve);
      },
      { useSystemPicker: false },
    );
  }

  private openPicker(resolve: (selection: { id: string; audio: AudioMode } | null) => void): void {
    if (!this.main) {
      resolve(null);
      return;
    }
    this.pickerResolve?.(null);
    this.pickerResolve = resolve;
    const picker = new BrowserWindow({
      parent: this.main.window,
      modal: true,
      width: 760,
      height: 560,
      resizable: false,
      minimizable: false,
      maximizable: false,
      frame: false,
      roundedCorners: true,
      show: false,
      backgroundColor: '#15181f',
      title: 'Что показать',
      webPreferences: { preload: join(this.preloadDir, 'shell.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: !!process.env.CORD_DEVTOOLS },
    });
    picker.setMenuBarVisibility(false);
    picker.once('ready-to-show', () => picker.show());
    picker.on('closed', () => {
      if (this.picker === picker) this.picker = null;
      const pending = this.pickerResolve;
      this.pickerResolve = null;
      pending?.(null);
    });
    this.picker = picker;
    void picker.loadURL(shellUrl('picker'));
  }

  private finishPicker(selection: { id: string; audio: AudioMode } | null): void {
    const pending = this.pickerResolve;
    this.pickerResolve = null;
    pending?.(selection);
    this.picker?.close();
    this.picker = null;
  }

  // ----- окно серверов и вызовы оболочки -----

  private openServers(): void {
    if (!this.main) return;
    this.servers ??= new ServersWindow(this.preloadDir, this.main.window, () => {
      this.servers = null;
    });
    this.servers.focus();
  }

  private installShellCalls(): void {
    ipcMain.handle(IPC.shellCall, async (event, method: unknown, payload: unknown) => {
      if (!event.senderFrame?.url.startsWith(`${SHELL_SCHEME}://`)) throw new Error('Недоступно.');
      const data = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
      switch (method) {
        case 'servers.list':
          return this.catalogServers();
        case 'servers.ping': {
          const origin = ServerOrigin.tryParse(data.url);
          if (!origin || !this.allowedOrigins().some((known) => known.equals(origin))) return null;
          return ping(origin);
        }
        case 'servers.choose':
          this.servers?.close();
          await this.chooseServer(String(data.url ?? ''));
          return true;
        case 'servers.close':
          this.servers?.close();
          return true;
        case 'offline.retry': {
          if (!this.main) return false;
          const origin = this.currentOrigin();
          await this.router.prepareBootstrap(origin);
          this.router.attach(this.main.window.webContents, origin);
          return this.main.open(origin);
        }
        case 'capture.sources': {
          const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true });
          return {
            systemAudio: process.platform === 'win32',
            sources: sources
              .filter((source) => !source.name.startsWith('Cord'))
              .map((source) => ({
                id: source.id,
                name: source.name.slice(0, 80),
                kind: source.id.startsWith('screen') ? 'screen' : 'window',
                thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
                icon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.resize({ width: 24 }).toDataURL() : '',
              })),
          };
        }
        case 'capture.pick': {
          const id = typeof data.id === 'string' && /^(screen|window):\d+:\d+$/.test(data.id) ? data.id : null;
          const audio: AudioMode = data.audio === 'system' ? 'system' : 'none';
          this.finishPicker(id ? { id, audio } : null);
          return true;
        }
        case 'capture.cancel':
          this.finishPicker(null);
          return true;
        case 'shell.features':
          return { features: FEATURES, version: app.getVersion() };
        default:
          return null;
      }
    });
    // Заставка: «Повторить»/«Открыть Cord» идут событием, а не запросом — их ждёт SplashWindow.choice().
    ipcMain.on(IPC.shellCall, (event) => {
      if (!event.senderFrame?.url.startsWith(`${SHELL_SCHEME}://`)) event.returnValue = null;
    });
  }
}

/** Медиана трёх `HEAD /api/v1/health`, в миллисекундах; null — не ответил. */
async function ping(origin: ServerOrigin): Promise<number | null> {
  const samples: number[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = performance.now();
    try {
      const response = await net.fetch(new URL('/api/v1/health', origin.url).toString(), { method: 'HEAD', signal: AbortSignal.timeout(3000) });
      if (response.ok || response.status === 405) samples.push(performance.now() - started);
    } catch {
      /* не ответил */
    }
  }
  if (samples.length === 0) return null;
  samples.sort((a, b) => a - b);
  return Math.round(samples[Math.floor(samples.length / 2)]!);
}

const shell = new Shell();
