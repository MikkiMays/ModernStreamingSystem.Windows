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
import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, MessageChannelMain, net, powerSaveBlocker, safeStorage, screen, utilityProcess, type WebContents } from 'electron';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, type PathLike } from 'node:fs';
import type { KeyObject } from 'node:crypto';
import { join } from 'node:path';
import { featuresFor, IPC, type Bootstrap } from '../shared/bridge';
import type { HotkeyBinding, Validated } from './bridge/messages';
import { BridgeRouter } from './bridge/router';
import { appSettingsOf, keepAwake, readAppSettingsPatch, settingsPatchOf, type AppSettings } from './app-settings';
import { boostTargets, planBoost } from './boost-plan';
import { buildConfig } from './config';
import { CaptureSelection, captureSourceViews, loopbackFor, nativeAudioFor, readCaptureSelect, type AudioMode, type CaptureSourceView, type NativeAudioPlan } from './capture';
import { Catalog, CatalogServer, defaultServer, fetchCatalog, parseCatalogKeys, pickCatalog } from './catalog';
import { decideClose, startMode } from './close-policy';
import { deepLinkFromArgv, parseDeepLink, type DeepLink } from './deeplink';
import { HotkeyRegistry } from './hotkeys';
import { readInstallerLanguage, shellLanguage } from './language';
import { markFor, StartupMetrics, sumMemory } from './metrics';
import { NativeClient } from './native/client';
import { NATIVE_MODULE_FILE, type BoostResult, type HostEvent, type NativeBinding, type NativeForegroundEvent } from '../native/protocol';
import { decideOverlay } from './overlay-policy';
import { showNotification } from './notifications';
import { pickOrigin, ServerOrigin } from './origins';
import { installShellProtocol, registerShellScheme, SHELL_SCHEME } from './protocol';
import { SettingsStore } from './settings';
import { shellText, type ShellText } from './shell-text';
import { Taskbar, type CallState } from './tray';
import { canInterrupt, nextCheckMs, BACKGROUND_BUDGET_MS, type UpdateVerdict } from './update/splash-flow';
import { CordUpdater } from './update/updater';
import { appUserModelId, configureSession, cordSession, MainWindow, type WindowState } from './windows/main';
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

// Цифры для CI (ADR §10): только если задан CORD_METRICS_FILE — у человека ничего не меряется.
const metricsFile = process.env.CORD_METRICS_FILE ?? '';
const metrics = metricsFile ? new StartupMetrics(process.getCreationTime() ?? Date.now()) : null;
// Как часто пересчитывать приоритет своих процессов (R01–R03, `boost-plan.ts`): `getAppMetrics()` дёшев,
// а поднимается только новый процесс — повторный пересчёт без перемен ничего не просит у `cord-native`.
const BOOST_RECHECK_MS = 10_000;

// Звук и таймеры в фоне (R01–R03, ADR §2.1): `backgroundThrottling: false` держит страницу главного
// окна «видимой», а эти ключи страхуют остальное — окна оболочки и воркеры, когда Cord спрятан в
// трей (R57) или целиком накрыт игрой (Chromium считает такое окно occluded и иначе усыпил бы его).
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// RED для Opus с двумя копиями, а не одной (R107): одна копия не чинит пачки потерь. Замер голоса в
// ядре (`backlog/review-1.0.3/MEDIA-DIAGNOSIS.md` §10): на пачках потерь заглушка NetEq меньше примерно
// на 45 % ценой ~1,5× полосы речи. Браузер выбрать число копий не даёт — только клиент Windows.
// Полевые опыты — одной строкой через «/»: второй `force-fieldtrials` перебил бы первый.
app.commandLine.appendSwitch('force-fieldtrials', 'WebRTC-Audio-Red-For-Opus/Enabled-2/');

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
    features: () => this.features(),
    log,
  });
  /**
   * Utility-процесс `native` (ADR §2.1): один на приложение, грузит `cord-native.node` из
   * `dist/native` (вне asar). Нет модуля или не Windows — возможности `ptt` и `capture.app-audio`
   * не объявляются, клавиши идут через globalShortcut, оверлей — на дисплее главного окна.
   */
  private readonly native = new NativeClient({
    spawn: () => {
      const appPath = app.getAppPath();
      const unpacked = appPath.replace(/app\.asar$/, 'app.asar.unpacked');
      const child = utilityProcess.fork(join(appPath, 'dist', 'native', 'host.js'), [], {
        serviceName: 'Cord native',
        env: { ...process.env, CORD_NATIVE_MODULE: join(unpacked, 'dist', 'native', NATIVE_MODULE_FILE) },
      });
      return {
        postMessage: (message, transfer) => child.postMessage(message, transfer as Electron.MessagePortMain[]),
        onMessage: (listener) => child.on('message', listener),
        onExit: (listener) => child.on('exit', listener),
        kill: () => void child.kill(),
      };
    },
    onEvent: (event) => this.onNativeEvent(event),
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
  /** Трей (R103, `tray-menu.ts`): что делают пункты его меню. */
  private readonly taskbar = new Taskbar(
    app.getAppPath(),
    {
      open: () => this.focus(),
      newMeeting: () => void this.trayNewMeeting(),
      // Веб 1.0.6+ открывает чат по `chat.open`; прежний молча пропускает — окно встречи всё равно впереди.
      openChat: () => {
        this.focus();
        this.router.post('chat.open');
      },
      openSettings: () => this.handleDeepLink({ kind: 'settings' }),
      toggleMicrophone: () => this.router.post('thumbar', { action: 'mic' }),
      toggleNotifications: () => this.applyAppSettings({ notifications: !this.settings.get().notifications }, true),
      quit: () => void this.trayQuit(),
    },
    () => this.settings.get(),
    () => this.text(),
  );
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
    (action, _mode, phase) => {
      // Оверлей — окно оболочки: клавиша переключает его здесь же, веб узнаёт событием app.settings.
      if (action === 'overlay.toggle') {
        if (phase === 'down') this.applyAppSettings({ overlay: !this.settings.get().overlayEnabled }, true);
      } else this.router.post('hotkey', { action, phase });
    },
  );
  private readonly capture = new CaptureSelection();
  private readonly overlay = new OverlayWindow(this.preloadDir);
  private main: MainWindow | null = null;
  private splash: SplashWindow | null = null;
  private servers: ServersWindow | null = null;
  private catalog: Catalog | null = null;
  private page: string | null = null;
  private call: CallState = { inCall: false, mic: false, camera: false, screen: false };
  /** Название текущей встречи (`state.room`) — для строки состояния трея. */
  private roomTitle = '';
  private sleepBlocker: number | null = null;
  /** Процессы, которым `cord-native` поднял приоритет (R01–R03, `boost-plan.ts`). */
  private boosted = new Set<number>();
  /** Пересчёт приоритета: рендерер и аудиосервис Chromium появляются и сменяются и вне встречи. */
  private boostTimer: ReturnType<typeof setInterval> | null = null;
  /** Переднее окно от `cord-native` (монитор, полноэкранность, своё ли); null — модуля нет. */
  private foreground: NativeForegroundEvent | null = null;
  private pendingLink: DeepLink | null = null;
  /** Запуск вместе с Windows (`--hidden`): первое главное окно — в трей или свёрнутым (`startMode`). */
  private hiddenFlag = process.argv.includes('--hidden');
  private checkTimer: ReturnType<typeof setTimeout> | null = null;
  private quitting = false;
  /** Windows выключается или сеанс завершается: крестик больше не прячет окно (R57). */
  private sessionEnding = false;

  // ----- старт -----

  async start(): Promise<void> {
    // «Выйти» из трея, Cmd/Alt+F4 в заставке, завершение сеанса: дальше окно закрывается, а не прячется.
    app.on('before-quit', () => {
      this.quitting = true;
    });
    this.adoptInstallerLanguage();
    this.installMetrics();
    installShellProtocol();
    installShellProtocol(cordSession());
    configureSession(cordSession(), this.windowHost);
    this.router.install();
    this.installShellCalls();
    this.installDisplayMedia();
    this.installCaptureAudio();
    this.native.start();
    this.pendingLink = deepLinkFromArgv(process.argv);
    // Автозапуск — выключен по умолчанию (ADR §4.4); переключатель в настройках (E03) — app.settings.
    this.applyAutostart();
    this.loadCatalog();
    // Свежий каталог — в фоне, параллельно с заставкой: ожидание сети не должно держать запуск.
    void this.refreshCatalog();
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

  /**
   * Первый запуск после установки (файла настроек ещё нет): язык мастера NSIS из
   * `HKCU\Software\Cord\Language` (R64) — веб получит его через `Bootstrap.language`.
   */
  private adoptInstallerLanguage(): void {
    if (!this.settings.fresh || smoke) return;
    const language = readInstallerLanguage(process.platform, (key, name) => execFileSync('reg.exe', ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true, timeout: 3000 }));
    if (language) {
      this.settings.update({ language });
      log(`язык установщика: ${language}`);
    }
  }

  private async openMain(): Promise<void> {
    const saved = this.settings.get();
    // Трей — до окна: от него зависит, куда уходит окно при `--hidden` и по крестику (R57).
    if (saved.tray) this.installTray();
    const main = new MainWindow(this.preloadDir, this.windowHost, saved.window, saved.theme, startMode({ hiddenFlag: this.hiddenFlag, tray: this.taskbar.hasTray }));
    this.hiddenFlag = false;
    this.main = main;
    main.window.webContents.on('did-start-navigation', (details) => {
      // Новый документ — прежняя дорожка звука захвата ему не принадлежит.
      if (details.isMainFrame) this.stopCaptureAudio(false);
    });
    await main.showLoading();
    const origin = this.currentOrigin();
    // Флаги моста зависят от модуля: ждём его ответ, но не дольше 3 с — старт важнее.
    await this.native.whenReady(3000);
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
      this.stopCaptureAudio(false);
      this.overlay.setVisible(false);
      if (!this.quitting) this.quit();
    },
    closeAction: () => decideClose({ tray: this.taskbar.hasTray, quitting: this.quitting, sessionEnding: this.sessionEnding }),
    onHidden: () => this.onMainHidden(),
    onSessionEnd: () => {
      this.sessionEnding = true;
    },
    onWindowState: (state: WindowState) => this.router.post('window.state', { ...state }),
    requestClose: () => this.requestClose(),
    log,
  };

  /** Окно спрятано по крестику (R57): один раз сказать, что Cord живёт в трее; встреча продолжается. */
  private onMainHidden(): void {
    log('окно спрятано в трей');
    if (this.settings.get().trayHintShown) return;
    this.settings.update({ trayHintShown: true });
    const text = this.text();
    this.taskbar.hint(text.hintTitle, text.hintBody);
  }

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

  private installTray(): void {
    try {
      this.taskbar.installTray();
    } catch (error) {
      log(`трей: ${(error as Error).message}`);
    }
  }

  private applyAutostart(): void {
    if (process.platform !== 'win32' || !app.isPackaged) return;
    try {
      app.setLoginItemSettings({ openAtLogin: this.settings.get().autostart, args: ['--hidden'] });
    } catch (error) {
      log(`автозапуск: ${(error as Error).message}`);
    }
  }

  /**
   * Переключатели раздела «Windows» (E03, T53): записать и сразу применить. `announce` — изменение
   * пришло не от веба (клавиша оверлея), и открытые настройки должны его увидеть.
   */
  private applyAppSettings(patch: Partial<AppSettings>, announce = false): AppSettings {
    const next = Object.keys(patch).length ? this.settings.update(settingsPatchOf(patch)) : this.settings.get();
    const window = this.main?.window ?? null;
    if (patch.tray !== undefined) {
      if (!next.tray) {
        this.taskbar.removeTray();
        // Без значка спрятанному окну неоткуда вернуться — показать его.
        if (this.main && !this.main.window.isVisible()) this.main.focus();
      } else if (this.main) this.installTray();
    }
    if (patch.autostart !== undefined) this.applyAutostart();
    if (patch.overlay !== undefined) this.updateOverlay();
    if (patch.thumbar !== undefined || patch.badge !== undefined || patch.notifications !== undefined) this.taskbar.refresh(window);
    if (patch.sleepBlocker !== undefined) this.applySleepBlocker();
    const values = appSettingsOf(next);
    if (announce) this.router.post('app.settings', { ...values });
    return values;
  }

  private applySleepBlocker(): void {
    const awake = keepAwake(this.call, this.settings.get());
    if (awake && this.sleepBlocker === null) this.sleepBlocker = powerSaveBlocker.start('prevent-display-sleep');
    if (!awake && this.sleepBlocker !== null) {
      powerSaveBlocker.stop(this.sleepBlocker);
      this.sleepBlocker = null;
    }
  }

  /** Тексты оболочки на языке Cord: язык страницы, выбор в установщике, язык Windows (`shellLanguage`). */
  private text(): ShellText {
    const saved = this.settings.get();
    return shellText(shellLanguage(saved.uiLanguage, saved.language, app.getPreferredSystemLanguages()));
  }

  /** Вопрос оболочки во встрече: «да» — `true`. Окно спрятано в трей — диалог без родителя, иначе его не видно. */
  private async confirm(title: string, detail: string, yes: string): Promise<boolean> {
    const text = this.text();
    const options = { type: 'question' as const, buttons: [yes, text.stay], defaultId: 1, cancelId: 1, message: title, detail, noLink: true };
    const parent = this.main && !this.main.window.isDestroyed() && this.main.window.isVisible() ? this.main.window : null;
    const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
    return response === 0;
  }

  /** «Новая встреча» из трея: во встрече веб выйдет из текущей — сначала спросить (R103). */
  private async trayNewMeeting(): Promise<void> {
    const text = this.text();
    if (this.call.inCall && !(await this.confirm(text.newTitle, text.newDetail, text.newConfirm))) return;
    this.handleDeepLink({ kind: 'create' });
  }

  /** «Выйти из Cord» из трея: во встрече — спросить, затем дать странице выйти из встречи (≤ 2,5 с). */
  private async trayQuit(): Promise<void> {
    if (this.call.inCall) {
      const text = this.text();
      if (!(await this.confirm(text.quitTitle, text.quitDetail, text.quitConfirm))) return;
      await this.requestClose();
    }
    this.quit();
  }

  private quit(): void {
    this.quitting = true;
    this.hotkeys.clear();
    this.stopCaptureAudio(false);
    this.native.stop();
    this.taskbar.destroy();
    this.overlay.destroy();
    app.quit();
  }

  // ----- cord-native: флаги, клавиши, переднее окно -----

  private features(): string[] {
    return featuresFor(process.platform, this.native.available);
  }

  private onNativeEvent(event: HostEvent): void {
    switch (event.event) {
      case 'ready': {
        const raw = event.available ? { set: (bindings: NativeBinding[]) => this.native.request<string[]>({ type: 'hotkeys.set', bindings }) } : null;
        void this.hotkeys.setRaw(raw).then((status) => {
          if (status) this.router.post('hotkeys.status', { status });
        });
        if (event.available) {
          void this.native.request({ type: 'foreground.watch', rootPid: process.pid, intervalMs: 300 }).catch((error: Error) => log(`native: переднее окно — ${error.message}`));
          // Приоритет — сразу, как поднялся модуль, и дальше раз в BOOST_RECHECK_MS: аудиосервис Chromium
          // запускается лениво, при первом звуке, а рендерер сменяется при перезагрузке страницы.
          this.updateBoost();
          this.boostTimer ??= setInterval(() => this.updateBoost(), BOOST_RECHECK_MS);
        } else {
          this.foreground = null;
          if (this.boostTimer) clearInterval(this.boostTimer);
          this.boostTimer = null;
          if (this.captureAudio) this.stopCaptureAudio(true, 'native');
          this.updateOverlay();
        }
        return;
      }
      case 'hotkey':
        this.hotkeys.onRawEvent(event.id, event.phase);
        return;
      case 'foreground':
        this.foreground = event.foreground;
        this.updateOverlay();
        return;
      case 'audio':
        if (this.captureAudio) this.stopCaptureAudio(true, event.state === 'error' ? (event.reason ?? 'error') : undefined);
        return;
    }
  }

  /** Видимость и монитор оверлея — по звонку, переключателю и переднему окну (`overlay-policy.ts`). */
  private updateOverlay(): void {
    const decision = decideOverlay(this.call.inCall, this.settings.get().overlayEnabled, this.foreground);
    this.overlay.setVisible(decision.visible);
    if (decision.visible) this.overlay.placeAt(decision.anchor, this.main && !this.main.window.isDestroyed() ? this.main.window.getBounds() : null);
  }

  // ----- звук захвата через cord-native (ADR §4.1) -----

  private captureAudio: { mode: AudioMode } | null = null;

  private installCaptureAudio(): void {
    // Preload главного окна сообщает, что страница остановила дорожку, — захват больше не нужен.
    ipcMain.on(IPC.captureAudio, (event, data: unknown) => {
      if (event.sender.id !== this.main?.window.webContents.id) return;
      if ((data as { type?: unknown } | null)?.type === 'stopped') this.stopCaptureAudio(false);
    });
  }

  /**
   * Запустить process loopback в utility-процессе и отдать порт PCM preload'у главного окна.
   * Отказ — `capture.audio {state: 'failed', reason}`: показ идёт без звука, веб показывает подсказку.
   */
  private async startCaptureAudio(plan: NativeAudioPlan, mode: AudioMode): Promise<void> {
    this.stopCaptureAudio(false);
    const main = this.main;
    if (!main) return;
    try {
      let pid = process.pid;
      if (plan.mode === 'include') {
        const found = await this.native.request<number | null>({ type: 'window.pid', hwnd: plan.hwnd });
        if (!found) throw new Error('окно источника уже закрыто');
        pid = found;
      }
      const { port1, port2 } = new MessageChannelMain();
      this.captureAudio = { mode };
      await this.native.request({ type: 'audio.start', pid, mode: plan.mode }, [port1]);
      if (this.captureAudio?.mode !== mode || main.window.isDestroyed()) {
        port2.close();
        return;
      }
      main.window.webContents.postMessage(IPC.captureAudio, { mode, sampleRate: 48_000, channels: 2 }, [port2]);
      log(`захват: звук ${mode} (${plan.mode}, pid ${pid})`);
    } catch (error) {
      log(`захват: звук ${mode} не запустился — ${(error as Error).message}`);
      this.captureAudio = null;
      this.router.post('capture.audio', { state: 'failed', mode, reason: (error as Error).message });
    }
  }

  /** Остановить захват; `announce` — сказать странице (`ended`, либо `failed` с причиной). */
  private stopCaptureAudio(announce: boolean, reason?: string): void {
    const current = this.captureAudio;
    this.captureAudio = null;
    if (!current) return;
    if (this.native.available) void this.native.request({ type: 'audio.stop' }).catch(() => {});
    if (announce) this.router.post('capture.audio', { state: reason ? 'failed' : 'ended', mode: current.mode, ...(reason ? { reason } : {}) });
  }

  focus(): void {
    if (this.main) this.main.focus();
    else if (this.splash) this.splash.window.focus();
  }

  // ----- серверы и каталог -----

  /** Серверы, которые знает эта сборка: подписанный каталог, а без него — сервер из сборки. */
  private knownOrigins(): ServerOrigin[] {
    const urls = this.catalog ? this.catalog.servers.map((server) => server.url) : [this.config.defaultServer];
    return urls.map((url) => ServerOrigin.tryParse(url)).filter((origin): origin is ServerOrigin => origin !== null);
  }

  /** Сервер встреч (`pickOrigin`); записи о серверах, которых сборка не знает, при смене убираются. */
  private currentOrigin(): ServerOrigin {
    const known = this.knownOrigins();
    const saved = ServerOrigin.tryParse(this.settings.get().serverUrl);
    const origin = pickOrigin(saved, known, this.config.defaultServer, this.catalog ? defaultServer(this.catalog).url : null);
    if (origin === saved) return origin;
    if (saved) log(`сервер ${saved.url} этой сборке не известен — выбран ${origin.url}`);
    const servers = this.settings.get().servers.filter((entry) => known.some((item) => item.equals(ServerOrigin.tryParse(entry.url))));
    this.settings.update({ serverUrl: origin.url, servers });
    return origin;
  }

  private allowedOrigins(): ServerOrigin[] {
    const list = [this.currentOrigin()];
    for (const origin of this.knownOrigins()) if (!list.some((known) => known.equals(origin))) list.push(origin);
    return list;
  }

  private catalogKeys: KeyObject[] = [];
  private readonly catalogCache = join(app.getPath('userData'), 'catalog.jws');

  /**
   * Каталог при запуске (ADR §8): последний хороший — сохранённый с прошлого раза или снимок из
   * установщика, самый новый из проверенных. Ключи — `dist/catalog-keys.json` (копия
   * `contracts/catalog-keys.json` ядра). Ни одного — сервер из сборки.
   */
  private loadCatalog(): void {
    const read = (path: PathLike) => {
      try {
        return existsSync(path) ? readFileSync(path, 'utf8') : null;
      } catch {
        return null;
      }
    };
    try {
      this.catalogKeys = parseCatalogKeys(read(join(app.getAppPath(), 'dist', 'catalog-keys.json')) ?? '');
    } catch (error) {
      log(`ключи каталога: ${(error as Error).message}`);
      return;
    }
    const picked = pickCatalog(
      [
        { source: 'cache', jws: read(this.catalogCache) },
        { source: 'snapshot', jws: read(join(app.getAppPath(), 'dist', 'shell', 'catalog.jws')) },
      ],
      this.catalogKeys,
      this.settings.get().catalogSeq,
    );
    if (!picked) {
      log('каталог: ни сохранённый, ни снимок не прошли проверку — сервер из сборки');
      return;
    }
    this.catalog = picked.catalog;
    if (picked.catalog.seq > this.settings.get().catalogSeq) this.settings.update({ catalogSeq: picked.catalog.seq });
    log(`каталог: ${picked.source}, seq ${picked.catalog.seq}`);
  }

  /**
   * Свежий подписанный каталог из ядра (`GET /api/v1/catalog`): текущий сервер, затем главный.
   * Неверный — остаётся прежний. Не вышло при запуске (сеть ещё не поднялась, машина занята) —
   * ещё одна попытка через минуту, уже в покое.
   */
  private async refreshCatalog(retry = true): Promise<void> {
    if (this.catalogKeys.length === 0) return;
    const origins = [ServerOrigin.tryParse(this.settings.get().serverUrl)?.url, this.config.defaultServer].filter(
      (url, index, list): url is string => !!url && list.indexOf(url) === index,
    );
    const fresh = await fetchCatalog(
      origins,
      (url) => net.fetch(url, { signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/jose+json, application/json' } }),
      this.catalogKeys,
      this.settings.get().catalogSeq,
      Date.now(),
      log,
    );
    if (!fresh) {
      if (retry && !this.quitting) setTimeout(() => void this.refreshCatalog(false), 60_000).unref();
      return;
    }
    this.catalog = fresh.catalog;
    this.settings.update({ catalogSeq: fresh.catalog.seq });
    try {
      writeFileSync(this.catalogCache + '.tmp', fresh.jws, 'utf8');
      renameSync(this.catalogCache + '.tmp', this.catalogCache);
    } catch (error) {
      log(`каталог: не сохранён — ${(error as Error).message}`);
    }
    log(`каталог: из сети, seq ${fresh.catalog.seq}`);
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
      language: saved.language,
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
        this.roomTitle = message.room?.title ?? '';
        // Язык интерфейса страницы (если назвала) — для трея и диалогов оболочки; пишется только при смене.
        if (message.language && message.language !== this.settings.get().uiLanguage) {
          this.settings.update({ uiLanguage: message.language });
          this.taskbar.refresh(window);
        }
        if (message.page === 'home' && metrics && !metrics.marks.home) {
          metrics.mark('home');
          this.scheduleMetrics(Number(process.env.CORD_METRICS_IDLE_MS ?? 60_000));
        }
        this.updateCall({ ...this.call, inCall: message.inCall });
        if (message.theme !== this.settings.get().theme && (message.theme === 'light' || message.theme === 'dark' || message.theme === 'system')) {
          this.settings.update({ theme: message.theme });
          this.main?.applyTheme(message.theme);
        }
        return;
      case 'call.state':
        if (message.room) this.roomTitle = message.room.title;
        this.updateCall({ inCall: message.inCall, mic: message.mic, camera: message.camera, screen: message.screen });
        return;
      case 'hotkeys.configure': {
        this.settings.update({ hotkeys: message.bindings });
        void this.hotkeys.apply(message.bindings).then((status) => this.router.post('hotkeys.status', { status }));
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
        // «Уведомления» выключены в меню трея (R103) — Windows их не показывает.
        if (!this.settings.get().notifications) return;
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
      case 'capture.sources':
        return this.captureSources();
      case 'app.settings': {
        // Пустой патч — чтение; чужое имя или не true/false — отказ целиком.
        const patch = readAppSettingsPatch(payload);
        if (!patch) throw new Error('Недоступно.');
        return this.applyAppSettings(patch);
      }
      case 'capture.select': {
        // Запрос с ответом, а не сообщение: веб ждёт ответа и только потом зовёт getDisplayMedia —
        // иначе запрос захвата мог бы обогнать выбор, и человек увидел бы второе окно выбора.
        const selection = readCaptureSelect(payload);
        if (!selection) throw new Error('Недоступно.');
        this.capture.select(selection.id, selection.audio);
        return { ok: true };
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
    this.taskbar.applyCall(
      window,
      next,
      {
        mic: () => this.router.post('thumbar', { action: 'mic' }),
        camera: () => this.router.post('thumbar', { action: 'camera' }),
        leave: () => this.router.post('thumbar', { action: 'leave' }),
      },
      this.roomTitle,
    );
    this.applySleepBlocker();
    this.updateBoost();
    if (next.inCall && this.settings.get().hotkeys.length && !this.hotkeys.active.length) void this.hotkeys.apply(this.settings.get().hotkeys);
    this.updateOverlay();
    if (was.inCall && !next.inCall && this.pendingSplash) void this.restartIntoSplash();
  }

  /**
   * EcoQoS выкл. и `HIGH` своему процессу, рендереру главного окна и аудиосервису Chromium — всё время,
   * пока Cord запущен (R01–R03, ADR §2.1). Зовётся при каждом состоянии звонка и раз в
   * `BOOST_RECHECK_MS`: рендерер или аудиосервис могли смениться. Без `cord-native` — ничего.
   */
  private updateBoost(): void {
    if (!this.native.available) return;
    const metrics = app.getAppMetrics();
    const window = this.main && !this.main.window.isDestroyed() ? this.main.window : null;
    const alive = metrics.map((metric) => metric.pid);
    const plan = planBoost(true, boostTargets(metrics, process.pid, window ? window.webContents.getOSProcessId() : null), this.boosted, alive);
    // Умершие забываются: их номер мог достаться чужому процессу.
    for (const pid of this.boosted) if (!alive.includes(pid)) this.boosted.delete(pid);
    if (plan.on.length) this.requestBoost(plan.on, true);
    if (plan.off.length) this.requestBoost(plan.off, false);
  }

  private requestBoost(pids: number[], on: boolean): void {
    for (const pid of pids) {
      if (on) this.boosted.add(pid);
      else this.boosted.delete(pid);
    }
    void this.native
      .request<BoostResult[]>({ type: 'process.boost', pids, on })
      .then((results) => {
        const failed = results.filter((result) => !result.ok).map((result) => `${result.pid} (${result.error ?? 'ошибка'})`);
        log(`приоритет: ${on ? 'поднят' : 'возвращён'} — ${pids.join(', ')}${failed.length ? `; не вышло: ${failed.join(', ')}` : ''}`);
      })
      .catch((error: Error) => log(`приоритет: ${error.message}`));
  }

  // ----- метрики CI (ADR §10) -----

  private metricsTimer: ReturnType<typeof setTimeout> | null = null;

  private installMetrics(): void {
    if (!metrics) return;
    app.on('browser-window-created', (_, window) =>
      window.once('ready-to-show', () => {
        const mark = markFor(window.webContents.getURL());
        if (mark) metrics.mark(mark);
      }),
    );
    // Главная так и не пришла (стенд недоступен) — записать, что есть, через две с половиной минуты.
    this.scheduleMetrics(150_000);
  }

  /** Память в покое — через `idleMs` после главной; файл пишется один раз. */
  private scheduleMetrics(idleMs: number): void {
    if (this.metricsTimer) clearTimeout(this.metricsTimer);
    this.metricsTimer = setTimeout(() => {
      if (!metrics) return;
      const summary = metrics.summary(sumMemory(app.getAppMetrics()), process.platform, app.getVersion());
      try {
        writeFileSync(metricsFile, JSON.stringify(summary, null, 2) + '\n', 'utf8');
        log(`метрики: ${JSON.stringify(summary)}`);
      } catch (error) {
        log(`метрики: не записаны — ${(error as Error).message}`);
      }
    }, Math.max(0, idleMs));
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

  /** Экраны и окна для окна выбора веба: миниатюры ≤ 320 px, без своих окон Cord. */
  private async captureSources(): Promise<{ systemAudio: boolean; appAudio: boolean; sources: CaptureSourceView[] }> {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: true });
    const own = new Set(BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).map((window) => window.getMediaSourceId()));
    return { systemAudio: process.platform === 'win32', appAudio: this.native.available, sources: captureSourceViews(sources, own) };
  }

  /**
   * Веб зовёт `getDisplayMedia` только после своего окна выбора (`capture.select`, R60) — его выбор
   * и отдаём. Выбора нет (страница без флага `capture` или он устарел) — отказ `callback({})`:
   * второго окна выбора у оболочки нет, а экрана без выбора человека не будет.
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
        const selection = this.capture.take();
        if (!selection) {
          log('захват: окно выбора веба не прислало capture.select — отказ');
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
          // Звук приложения / системы кроме Cord — отдельной дорожкой через cord-native.
          this.stopCaptureAudio(false);
          const decision = nativeAudioFor(selection, this.native.available);
          if (decision.kind === 'native') void this.startCaptureAudio(decision.plan, selection.audio);
          else if (decision.kind === 'failed') {
            log(`захват: звук ${selection.audio} — ${decision.reason}`);
            this.router.post('capture.audio', { state: 'failed', mode: selection.audio, reason: decision.reason });
          }
        });
      },
      { useSystemPicker: false },
    );
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
        case 'shell.features':
          return { features: this.features(), version: app.getVersion() };
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

/** Медиана трёх `HEAD /api/v1/ping` (открытый маршрут ядра), в миллисекундах; null — не ответил. */
async function ping(origin: ServerOrigin): Promise<number | null> {
  const samples: number[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = performance.now();
    try {
      const response = await net.fetch(new URL('/api/v1/ping', origin.url).toString(), { method: 'HEAD', signal: AbortSignal.timeout(3000) });
      if (response.ok) samples.push(performance.now() - started);
    } catch {
      /* не ответил */
    }
  }
  if (samples.length === 0) return null;
  samples.sort((a, b) => a - b);
  return Math.round(samples[Math.floor(samples.length / 2)]!);
}

const shell = new Shell();
