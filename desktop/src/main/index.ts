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
import { app, BrowserWindow, desktopCapturer, dialog, globalShortcut, ipcMain, MessageChannelMain, net, powerMonitor, powerSaveBlocker, safeStorage, screen, utilityProcess, type WebContents } from 'electron';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, type PathLike } from 'node:fs';
import type { KeyObject } from 'node:crypto';
import { join } from 'node:path';
import { featuresFor, IPC, TITLEBAR_HEIGHT, type Bootstrap } from '../shared/bridge';
import { readGameCall, type MiniState, type Validated } from './bridge/messages';
import { AV1_FEATURE, av1Allowed, av1Enabled, gpuView, mergeFeatures, readGpuCache, readGpuInfo, sameGpu, writeGpuCache, type GpuInfo } from './gpu';
import { BridgeRouter } from './bridge/router';
import { appSettingsOf, keepAwake, readAppSettingsPatch, readOffset, settingsPatchOf, type AppSettings } from './app-settings';
import { boostTargets, planBoost } from './boost-plan';
import { buildConfig } from './config';
import { CaptureSelection, captureSourceViews, loopbackFor, nativeAudioFor, readCaptureSelect, type AudioMode, type CaptureSourceView, type NativeAudioPlan } from './capture';
import { Catalog, CatalogServer, defaultServer, fetchCatalog, parseCatalogKeys, pickCatalog } from './catalog';
import { decideClose, startMode } from './close-policy';
import { deepLinkFromArgv, parseDeepLink, type DeepLink } from './deeplink';
import { CARD_MS, decideGameNotice, hotkeyLabel } from './game-notice';
import { addGame, findGame, forgetGame, gameKey, nextActive, noteForeground, noteLeft, setGameEnabled, type ActiveGame, type GamesState } from './games';
import { HotkeyRegistry } from './hotkeys';
import { readInstallerLanguage, shellLanguage, type Language } from './language';
import { markFor, StartupMetrics, sumMemory } from './metrics';
import { NativeClient } from './native/client';
import { NATIVE_MODULE_FILE, type BoostResult, type HostEvent, type NativeBinding, type NativeForegroundEvent } from '../native/protocol';
import { decideMini, displayNeedsRebuild, MINI_DELAY_MS, MINI_WATCH } from './mini-policy';
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
import { MiniWindow } from './windows/mini';
import { displayFor, OverlayWindow, type OverlayConfig } from './windows/overlay';
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
// Аппаратный AV1 для WebRTC (R152, `gpu.ts`): Chromium на Windows держит `WebRtcAV1HWEncode` выключенным,
// а в Electron нет Finch, который включает его в Chrome. Ключ читается до `ready`, а сведения о видеокарте
// есть только после — поэтому решает видеокарта прошлого запуска (`gpu.json`). Фичи, уже заданные в
// командной строке, сохраняются: второй `enable-features` перебил бы первый.
const av1Hw =
  av1Enabled(buildConfig(app.getAppPath()).av1HwEncode, process.env.CORD_AV1_HW) && av1Allowed(readGpuCache(app.getPath('userData')));
if (av1Hw) app.commandLine.appendSwitch('enable-features', mergeFeatures(app.commandLine.getSwitchValue('enable-features'), AV1_FEATURE));

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

/** Открытое предложение «Показать игру» (R104): окно игры, уведомление Windows, таймер карточки в оверлее. */
interface GoLiveOffer {
  hwnd: number;
  title: string;
  name: string;
  toast: Electron.Notification | null;
  timer: ReturnType<typeof setTimeout> | null;
}

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
      // «Микрофон» трея — нажатие мини-окна с нужным состоянием (R137, R138): кнопок на миниатюре и их
      // сообщения `thumbar` больше нет; веб до R137 исполняет его как «переключить».
      toggleMicrophone: () => void this.router.post('mini.action', { id: 'mic', want: !this.call.mic }),
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
      } else if (action === 'overlay.lock') {
        // Замок виджета в игре (R63): разблокированный берёт мышь — перетащить, нажать «Показать игру».
        if (phase === 'down' && this.overlay.visible) this.overlay.setLocked(!this.overlay.isLocked);
      } else this.router.post('hotkey', { action, phase });
    },
  );
  private readonly capture = new CaptureSelection();
  private readonly overlay = new OverlayWindow(this.preloadDir, (contents) => this.pairLevels('overlay', contents));
  private readonly mini = new MiniWindow(this.preloadDir, {
    moved: (x, y) => void this.settings.update({ mini: { ...this.settings.get().mini, x, y } }),
    loaded: (contents) => this.pairLevels('mini', contents),
    gone: () => {
      // Окно убрано: во встрече — новое заранее (порт уровней, состояние), видно ли — решит правило.
      const mini = this.settings.get().mini;
      if (this.call.inCall && mini.enabled) {
        this.mini.prepare(mini, mini.expanded);
        this.mini.send('mini.config', this.miniConfig());
      }
      this.updateMini();
    },
    // Пропуски кадров не считаются, пока человек не трогает мышь и клавиатуру (экран мог погаснуть).
    // Дымовой прогон мышь не двигает — там человек «всегда смотрит».
    active: () => smoke || powerMonitor.getSystemIdleState(MINI_WATCH.idleSeconds) === 'active',
    log,
  });
  /** Смена мониторов приходит пачкой событий — окно пересоздаётся один раз. */
  private displayTimer: ReturnType<typeof setTimeout> | null = null;
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
  /** Переднее окно от `cord-native` (монитор, полноэкранность, своё ли, exe, «без рамки»); null — модуля нет. */
  private foreground: NativeForegroundEvent | null = null;
  /** Реестр игр (R62, `games.ts`) — копия `settings.games`/`ignoredGames`. */
  private games: GamesState = { games: [], ignored: [] };
  /** exe окна, которое было впереди в прошлый раз: регистрация и «последний запуск» — только при смене. */
  private frontExe = '';
  /** Игра «сейчас запущена» (`game.active`) и PID её процесса — для проверки, жива ли она, пока впереди Cord. */
  private active: { game: ActiveGame; pid: number } | null = null;
  private aliveTimer: ReturnType<typeof setInterval> | null = null;
  /** Каким играм в этом сеансе уже предлагали «Показать игру» и каким — режим без рамки (R104). */
  private readonly announced = new Set<string>();
  private readonly warned = new Set<string>();
  /** Открытое предложение «Показать игру»: окно игры, уведомление Windows, таймер карточки в оверлее. */
  private goLive: GoLiveOffer | null = null;
  /**
   * Страница этого документа шлёт состав (`overlay.roster`) и состояние мини-окна (`mini.state`) — веб
   * знает виджет и мини-окно (R63, R93). Прежний веб их не шлёт: тогда мини-окна и «Показать игру» нет —
   * пустое окно и кнопка, на которую страница не ответит, хуже, чем ничего.
   */
  private rosterSeen = false;
  /** Когда процесс страницы упал в последний раз (`onPageGone`). */
  private pageGoneAt = 0;
  private miniState: MiniState | null = null;
  /** «—» в мини-окне: спрятать до следующего возврата в Cord. */
  private miniDismissed = false;
  private miniTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.games = { games: this.settings.get().games, ignored: this.settings.get().ignoredGames };
    this.installSmokeHooks();
    this.installMetrics();
    installShellProtocol();
    installShellProtocol(cordSession());
    configureSession(cordSession(), this.windowHost);
    this.router.install();
    this.installShellCalls();
    this.installMiniRecovery();
    this.installDisplayMedia();
    this.installCaptureAudio();
    this.native.start();
    this.pendingLink = deepLinkFromArgv(process.argv);
    // Автозапуск — выключен по умолчанию (ADR §4.4); переключатель в настройках (E03) — app.settings.
    this.applyAutostart();
    this.loadCatalog();
    // Свежий каталог — в фоне, параллельно с заставкой: ожидание сети не должно держать запуск.
    void this.refreshCatalog();
    // Видеокарта — тоже в фоне и позже: решение о ключе AV1 для следующего запуска (R152).
    setTimeout(() => void this.gpu(), 5_000);
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
    // Кнопок на миниатюре и значка поверх иконки больше нет (R138) — у окна их не должно остаться.
    this.taskbar.clear(main.window);
    main.window.webContents.on('did-start-navigation', (details) => {
      // Новый документ — прежняя дорожка звука захвата ему не принадлежит.
      if (!details.isMainFrame) return;
      this.stopCaptureAudio(false);
      if (details.isSameDocument) return;
      // Состав и мини-окно новый документ пришлёт сам — если умеет (R63, R93).
      this.rosterSeen = false;
      this.miniState = null;
      this.updateMini();
    });
    // Порты уровней голоса живут в preload документа: новый документ — новые порты оверлею и мини-окну.
    main.window.webContents.on('did-finish-load', () => {
      this.pairLevels('overlay', this.overlay.contents);
      this.pairLevels('mini', this.mini.contents);
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
      this.overlay.show(null);
      this.updateMini();
      if (!this.quitting) this.quit();
    },
    closeAction: () => decideClose({ tray: this.taskbar.hasTray, quitting: this.quitting, sessionEnding: this.sessionEnding }),
    onHidden: () => this.onMainHidden(),
    onSessionEnd: () => {
      this.sessionEnding = true;
    },
    onWindowState: (state: WindowState) => {
      this.router.post('window.state', { ...state });
      this.updateMini();
    },
    onPageGone: (reason: string) => this.onPageGone(reason),
    requestClose: () => this.requestClose(),
    log,
  };

  /**
   * Процесс страницы упал. Звонка в нём больше нет: мини-окно, оверлей, трей и кнопки на панели задач
   * не должны показывать прежнюю встречу с кнопками, которые некому исполнить («окошко не отвечает»).
   * Страница загружается заново; упала снова за 30 с — страница «нет связи» с «Повторить», а не круг
   * падений.
   */
  private onPageGone(reason: string): void {
    this.stopCaptureAudio(false);
    this.rosterSeen = false;
    this.miniState = null;
    this.overlay.roster({ participants: [] });
    this.updateCall({ inCall: false, mic: false, camera: false, screen: false });
    const main = this.main;
    if (!main || main.window.isDestroyed() || reason === 'clean-exit') return;
    const now = Date.now();
    const again = now - this.pageGoneAt < 30_000;
    this.pageGoneAt = now;
    if (again) void main.showOffline(this.currentOrigin());
    else main.reload();
  }

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
    const next = Object.keys(patch).length ? this.settings.update(settingsPatchOf(patch, this.settings.get())) : this.settings.get();
    if (patch.tray !== undefined) {
      if (!next.tray) {
        this.taskbar.removeTray();
        // Без значка спрятанному окну неоткуда вернуться — показать его.
        if (this.main && !this.main.window.isVisible()) this.main.focus();
      } else if (this.main) this.installTray();
    }
    if (patch.autostart !== undefined) this.applyAutostart();
    if (patch.overlay !== undefined) this.updateOverlay();
    if (['overlayCorner', 'overlaySize', 'overlayNames', 'overlayOpacity'].some((key) => key in patch)) this.overlay.configure(this.overlayConfig());
    if (patch.mini !== undefined) this.updateMini();
    if (patch.notifications !== undefined) this.taskbar.refresh();
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
    return shellText(this.language());
  }

  private language(): Language {
    const saved = this.settings.get();
    return shellLanguage(saved.uiLanguage, saved.language, app.getPreferredSystemLanguages());
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
    this.mini.destroy();
    this.closeGoLive();
    if (this.aliveTimer) clearInterval(this.aliveTimer);
    app.quit();
  }

  // ----- cord-native: флаги, клавиши, переднее окно -----

  private features(): string[] {
    return featuresFor(process.platform, this.native.available, av1Hw);
  }

  // ----- видеокарта (R152) -----

  private gpuInfo: GpuInfo | null = readGpuCache(app.getPath('userData'));
  private gpuProbe: Promise<GpuInfo | null> | null = null;

  /**
   * Видеокарта этого запуска: `getGPUInfo('complete')` (не дольше 15 с, иначе `basic`) — в кэш, по нему
   * следующий запуск решит о ключе AV1. Один раз за запуск: сведения о GPU не меняются на ходу.
   */
  private gpu(): Promise<GpuInfo | null> {
    this.gpuProbe ??= (async () => {
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000));
      const raw = (await Promise.race([app.getGPUInfo('complete'), timeout]).catch(() => null)) ?? (await app.getGPUInfo('basic').catch(() => null));
      const info = readGpuInfo(raw);
      if (!info.devices.length) return this.gpuInfo;
      if (!sameGpu(this.gpuInfo, info)) writeGpuCache(app.getPath('userData'), info);
      const allowed = av1Allowed(info);
      const devices = info.devices.map((d) => `${d.vendor} 0x${d.deviceId.toString(16)} ${d.name} ${d.driver}${d.active ? ' (активная)' : ''}`).join('; ');
      log(`видеокарта: ${devices}; кодирование: ${info.encoders?.join(',') ?? 'не перечислено'}; AV1 в железе: ${av1Hw ? 'включён' : allowed ? 'со следующего запуска' : 'нет'}`);
      this.gpuInfo = info;
      return info;
    })();
    return this.gpuProbe;
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
          this.noteGames();
          this.updateOverlay();
          this.updateMini();
        }
        return;
      }
      case 'hotkey':
        this.hotkeys.onRawEvent(event.id, event.phase);
        return;
      case 'foreground':
        this.foreground = event.foreground;
        this.noteGames();
        this.updateOverlay();
        this.updateMini();
        return;
      case 'audio':
        if (this.captureAudio) this.stopCaptureAudio(true, event.state === 'error' ? (event.reason ?? 'error') : undefined);
        return;
    }
  }

  /** Видимость и монитор оверлея — по звонку, переключателю, переднему окну и реестру игр (`overlay-policy.ts`). */
  private updateOverlay(): void {
    const foreground = this.foreground;
    const game = foreground ? findGame(this.games, foreground.exe) : null;
    const decision = decideOverlay(this.call.inCall, this.settings.get().overlayEnabled, foreground, game);
    this.overlay.show(decision.monitor);
    if (!decision.visible) this.clearCard();
    this.noticeGame();
  }

  /** Тексты, угол, размер, имена, прозрачность и подпись замка — для страницы оверлея. */
  private overlayConfig(): OverlayConfig {
    const saved = this.settings.get();
    const text = this.text();
    return {
      corner: saved.overlay.corner,
      size: saved.overlay.size,
      names: saved.overlay.names,
      opacity: saved.overlay.opacity,
      offset: { ...saved.overlay.offset },
      locked: true,
      lockHotkey: this.lockHotkey(),
      language: this.language(),
      text: { label: text.overlayLabel, unlocked: text.overlayUnlocked, muted: text.muted, cardTitle: text.cardTitle, cardHint: text.cardHint, goLive: text.goLive, close: text.close },
    };
  }

  /** Сочетание разблокировки оверлея подписью («Shift+`»); веб до R63 его не присылает — `null`. */
  private lockHotkey(): string | null {
    return hotkeyLabel(this.settings.get().hotkeys.find((binding) => binding.action === 'overlay.lock')?.key);
  }

  // ----- игры (R62): реестр, игра «сейчас», «Показать игру» (R104) -----

  /** Переднее окно сменилось: запомнить новую игру, отметить запуск, обновить игру «сейчас». */
  private noteGames(): void {
    const foreground = this.foreground;
    const now = Date.now();
    const exe = foreground ? gameKey(foreground.exe ?? '') : '';
    let changed = false;
    let game = foreground ? findGame(this.games, exe) : null;
    if (exe !== this.frontExe) {
      if (this.frontExe && findGame(this.games, this.frontExe)) {
        this.games = noteLeft(this.games, this.frontExe, now);
        changed = true;
      }
      this.frontExe = exe;
      if (foreground) {
        const noted = noteForeground(this.games, foreground, now);
        if (noted.changed) {
          this.games = noted.state;
          changed = true;
          if (!game && noted.game) log(`игры: ${noted.game.exe} — «${noted.game.name}»`);
        }
        game = noted.game;
      }
    }
    if (changed) this.saveGames();
    this.setActive(nextActive(this.active, foreground ? { ...foreground } : null, game));
  }

  private saveGames(): void {
    this.settings.update({ games: this.games.games, ignoredGames: this.games.ignored });
    this.router.post('games.changed', this.gamesView());
  }

  /** Реестр для веба: игры по последнему запуску и игра «сейчас». */
  private gamesView(): { games: GamesState['games']; active: ActiveGame | null } {
    return { games: this.games.games.map((game) => ({ ...game })), active: this.active ? { ...this.active.game } : null };
  }

  /**
   * Игра «сейчас» сменилась — сказать вебу (`game.active`). Пока впереди Cord, раз в 5 с проверять,
   * жив ли её процесс (снимок Toolhelp в `cord-native`, процесс игры не открывается): игру закрыли,
   * а Cord вышел вперёд — «Запущена сейчас» больше не правда.
   */
  private setActive(next: { game: ActiveGame; pid: number } | null): void {
    const before = this.active;
    this.active = next;
    const same = before?.pid === next?.pid && JSON.stringify(before?.game ?? null) === JSON.stringify(next?.game ?? null);
    if (!same) this.router.post('game.active', { game: next ? { ...next.game } : null });
    const watch = !!next && !!this.foreground?.cord && this.native.available;
    if (watch && !this.aliveTimer) {
      this.aliveTimer = setInterval(() => {
        const current = this.active;
        if (!current || !this.foreground?.cord) {
          if (this.aliveTimer) clearInterval(this.aliveTimer);
          this.aliveTimer = null;
          return;
        }
        void this.native
          .request<boolean>({ type: 'process.alive', pid: current.pid, exe: current.game.exe })
          .then((alive) => {
            if (!alive && this.active === current) this.setActive(null);
          })
          .catch(() => {});
      }, 5000);
    } else if (!watch && this.aliveTimer) {
      clearInterval(this.aliveTimer);
      this.aliveTimer = null;
    }
  }

  /** Во встрече впереди игра — раз на игру предложить «Показать игру» или предупредить об эксклюзивном режиме. */
  private noticeGame(): void {
    const foreground = this.foreground;
    const game = this.active?.game ?? null;
    const front = !!foreground && !!game && !foreground.cord && gameKey(foreground.exe ?? '') === game.exe;
    const saved = this.settings.get();
    // Прежний веб «Показать игру» не исполнит — предложение только странице, которая шлёт состав (R63).
    const notice = decideGameNotice({ inCall: this.call.inCall, overlayEnabled: saved.overlayEnabled, toastEnabled: saved.overlay.toast && this.rosterSeen, game, front, announced: this.announced, warned: this.warned });
    if (!notice || !game || !foreground) return;
    const text = this.text();
    if (notice === 'exclusive') {
      this.warned.add(game.exe);
      if (saved.notifications) showNotification({ title: text.exclusiveTitle.replace('{game}', game.name), body: text.exclusiveBody }, () => {});
      log(`игры: ${game.exe} в эксклюзивном полноэкранном режиме — оверлей не виден`);
      return;
    }
    this.announced.add(game.exe);
    this.closeGoLive();
    const hotkey = this.lockHotkey();
    const offer: GoLiveOffer = { hwnd: foreground.hwnd, title: foreground.title ?? '', name: game.name, toast: null, timer: null };
    this.goLive = offer;
    if (saved.notifications)
      offer.toast = showNotification(
        { title: text.goLiveTitle.replace('{game}', game.name), body: hotkey ? text.goLiveBody.replace('{hotkey}', hotkey) : text.goLiveBodyNoKey, actions: [{ id: 'go-live', text: text.goLive }] },
        (id) => {
          if (id === 'go-live') void this.startGoLive(offer);
        },
      );
    if (this.overlay.visible) {
      this.overlay.card({ game: game.name, keys: hotkey ? hotkey.split('+') : null });
      this.armCard(offer);
    }
    log(`игры: «Показать игру» — ${game.exe}`);
  }

  /** Карточка в оверлее уходит сама через 8 с — но не пока оверлей разблокирован: человек тянется к кнопке. */
  private armCard(offer: GoLiveOffer): void {
    if (offer.timer) clearTimeout(offer.timer);
    offer.timer = setTimeout(() => {
      offer.timer = null;
      if (this.goLive !== offer) return;
      if (!this.overlay.isLocked) this.armCard(offer);
      else this.clearCard();
    }, CARD_MS);
  }

  private clearCard(): void {
    const offer = this.goLive;
    if (offer?.timer) clearTimeout(offer.timer);
    if (offer) offer.timer = null;
    this.overlay.card(null);
  }

  private closeGoLive(): void {
    const offer = this.goLive;
    this.goLive = null;
    if (!offer) return;
    if (offer.timer) clearTimeout(offer.timer);
    try {
      offer.toast?.close();
    } catch {
      /* уведомление уже закрыто */
    }
    this.overlay.card(null);
  }

  /**
   * «Показать игру» (R104): найти окно игры среди источников показа (по HWND переднего окна, иначе по
   * заголовку) и попросить веб начать показ (`golive {id, name}`). Окно Cord вперёд не выходит —
   * человек остаётся в игре; жест для `getDisplayMedia` странице даёт `executeJavaScript(…, true)`.
   */
  private async startGoLive(offer: GoLiveOffer): Promise<void> {
    this.closeGoLive();
    this.overlay.setLocked(true);
    const main = this.main;
    if (!main || main.window.isDestroyed() || !this.call.inCall) return;
    try {
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find((item) => item.id.startsWith(`window:${offer.hwnd}:`)) ?? sources.find((item) => !!offer.title && item.name === offer.title);
      if (!source) {
        log(`«Показать игру»: окна ${offer.name} нет среди источников показа`);
        return;
      }
      // Пустой скрипт с жестом пользователя: Chromium разрешает getDisplayMedia только после жеста.
      await main.window.webContents.executeJavaScript('0', true);
      this.router.post('golive', { id: source.id, name: offer.name });
      log(`«Показать игру»: ${source.id}`);
    } catch (error) {
      log(`«Показать игру»: ${(error as Error).message}`);
    }
  }

  /** Переключатель игры или «Забыть» — игра «сейчас» берёт новое значение из реестра. */
  private refreshActive(): void {
    const current = this.active;
    if (!current) return;
    const game = findGame(this.games, current.game.exe);
    this.setActive(game ? { pid: current.pid, game: { ...current.game, name: game.name, enabled: game.enabled } } : null);
  }

  /** «Добавить игру»: выбор exe в окне Windows; ответ — реестр после добавления. */
  private async pickGame(): Promise<{ games: GamesState['games']; active: ActiveGame | null }> {
    const parent = this.main && !this.main.window.isDestroyed() ? this.main.window : null;
    const options = { properties: ['openFile' as const], filters: [{ name: 'Windows', extensions: ['exe'] }] };
    const picked = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
    const path = picked.canceled ? '' : (picked.filePaths[0] ?? '');
    const added = path ? addGame(this.games, path, Date.now()) : null;
    if (added) {
      this.games = added.state;
      this.refreshActive();
      this.saveGames();
      this.updateOverlay();
      log(`игры: добавлена вручную ${added.game.exe}`);
    }
    return this.gamesView();
  }

  // ----- мини-окно звонка (R93) -----

  /** Нужно ли сейчас мини-окно (`mini-policy.ts`). */
  private miniWanted(): boolean {
    const main = this.main && !this.main.window.isDestroyed() ? this.main : null;
    const state = main ? main.state() : null;
    if (state?.focused) this.miniDismissed = false;
    const foreground = this.foreground;
    let sameDisplay: boolean | null = null;
    if (main && state?.visible && foreground) sameDisplay = screen.getDisplayMatching(main.window.getBounds()).id === displayFor(foreground.monitor).id;
    return decideMini({
      inCall: this.call.inCall && !!this.miniState,
      enabled: this.settings.get().mini.enabled,
      dismissed: this.miniDismissed,
      main: main && state ? { exists: true, ...state } : null,
      foreground: foreground ? { cord: foreground.cord, fullscreen: foreground.fullscreen } : null,
      overlayVisible: this.overlay.visible,
      sameDisplay,
    });
  }

  /** Видно ли мини-окно; появление — через 400 мс, уход — сразу. */
  private updateMini(): void {
    const saved = this.settings.get();
    if (!this.miniWanted()) {
      if (this.miniTimer) clearTimeout(this.miniTimer);
      this.miniTimer = null;
      this.mini.setVisible(false, saved.mini, saved.mini.expanded);
      return;
    }
    if (this.mini.visible || this.miniTimer) return;
    this.miniTimer = setTimeout(() => {
      this.miniTimer = null;
      // Через 400 мс всё могло вернуться (Alt+Tab туда и обратно) или впереди встало окно во весь
      // экран — решить заново тем же правилом.
      if (!this.miniWanted()) return;
      const still = this.settings.get();
      this.mini.setVisible(true, still.mini, still.mini.expanded);
    }, MINI_DELAY_MS);
  }

  /** Тексты и вид мини-окна. */
  private miniConfig(): Record<string, unknown> {
    const text = this.text();
    return {
      expanded: this.settings.get().mini.expanded,
      language: this.language(),
      text: {
        label: text.miniLabel, collapse: text.miniCollapse, open: text.miniOpen, more: text.miniMore, compact: text.miniCompact, on: text.stateOn, off: text.stateOff,
        microphone: text.microphone, micMute: text.micMute, micUnmute: text.micUnmute, camera: text.camera, screenShare: text.screenShare, screenStop: text.screenStop,
        youShare: text.youShare, stopShare: text.stopShare, people: text.people, chat: text.chat, soundSettings: text.soundSettings, leave: text.leave, you: text.you,
        recovering: text.miniRecovering, connecting: text.miniConnecting, seconds: text.miniSeconds,
      },
    };
  }

  /**
   * Нажатие в мини-окне. Микрофон, камера и выход исполняет веб, не поднимая Cord; участники, чат,
   * настройки и начало показа (окно выбора) — в окне Cord, оно выходит вперёд.
   *
   * С R137 нажатие несёт нужное состояние (`want`: включить или выключить, а не «переключить» — два
   * быстрых нажатия до нового состояния не отменяют друг друга) и номер (`seq`). На номер мини-окну
   * приходит `mini.ack`: от main — сразу, если нажатие исполняет он сам или странице его не доставить;
   * иначе — от страницы. Веб до R137 не отвечает: «ожидание» снимет новое состояние или тайм-аут.
   */
  private onMiniAction(id: string, want: boolean | undefined, seq: number | undefined): void {
    const ack = (result: 'ok' | 'ignored', reason?: string) => {
      if (seq !== undefined) this.mini.event('mini.ack', { seq, result, ...(reason ? { reason } : {}) });
    };
    const toPage = () => {
      const delivered = this.router.post('mini.action', { id, ...(want !== undefined ? { want } : {}), ...(seq !== undefined ? { seq } : {}) });
      if (!delivered) ack('ignored', 'page');
    };
    switch (id) {
      case 'open':
        this.focus();
        ack('ok');
        return;
      case 'collapse':
        this.miniDismissed = true;
        this.updateMini();
        ack('ok');
        return;
      case 'expand':
      case 'compact':
        this.settings.update({ mini: { ...this.settings.get().mini, expanded: id === 'expand' } });
        this.mini.send('mini.config', this.miniConfig());
        ack('ok');
        return;
      case 'mic':
      case 'camera':
      case 'leave':
        toPage();
        return;
      case 'screen':
        // Начать показ — окно выбора в Cord; остановить — без него.
        if (want ?? !this.call.screen) this.focus();
        toPage();
        return;
      case 'people':
      case 'chat':
      case 'settings':
        this.focus();
        toPage();
        return;
      default:
        ack('ignored', 'unknown');
    }
  }

  /**
   * Самовосстановление мини-окна (R137): после сна, разблокировки экрана, сброса процесса GPU и смены
   * мониторов (размер, масштаб, поворот) окно пересоздаётся — его поверхность могла умереть, а страница
   * при этом жива («замёрзшее» окно, Electron #37361, #40578). Пока экран заблокирован или система спит,
   * сторож кадров не считает пропуски. Не чаще `MINI_REBUILDS` — это решает `MiniWindow.rebuild`.
   */
  private installMiniRecovery(): void {
    powerMonitor.on('suspend', () => this.mini.pause(true));
    powerMonitor.on('lock-screen', () => this.mini.pause(true));
    powerMonitor.on('resume', () => {
      this.mini.pause(false);
      this.mini.rebuild('после сна', false);
    });
    powerMonitor.on('unlock-screen', () => {
      this.mini.pause(false);
      this.mini.rebuild('после блокировки экрана', false);
    });
    app.on('child-process-gone', (_, details) => {
      if (details.type === 'GPU') this.mini.rebuild(`процесс GPU: ${details.reason}`, false);
    });
    const displays = (reason: string) => {
      if (this.displayTimer) clearTimeout(this.displayTimer);
      this.displayTimer = setTimeout(() => {
        this.displayTimer = null;
        this.mini.rebuild(reason, false);
      }, 1000);
    };
    screen.on('display-added', () => displays('монитор подключён'));
    screen.on('display-removed', () => displays('монитор отключён'));
    screen.on('display-metrics-changed', (_, _display, changed) => {
      if (displayNeedsRebuild(changed)) displays(`монитор изменился (${changed.join(', ')})`);
    });
  }

  /**
   * Порт уровней голоса между preload страницы встречи и окном оболочки (`target`): страница кладёт
   * уровни прямо в него, main посередине не стоит (R63).
   */
  private pairLevels(target: 'overlay' | 'mini', contents: WebContents | null): void {
    const page = this.main && !this.main.window.isDestroyed() ? this.main.window.webContents : null;
    if (!page || !contents || contents.isDestroyed()) return;
    const { port1, port2 } = new MessageChannelMain();
    page.postMessage(IPC.levelsPort, { target }, [port1]);
    contents.postMessage(IPC.levelsPort, { target }, [port2]);
  }

  /**
   * Дымовой прогон с подменой модуля (`CORD_SMOKE=1`, `CORD_NATIVE_FAKE=1`): переднее окно задаёт
   * сам тест — `globalThis.cordSmoke.foreground({...})` через `app.evaluate`. В выпуске не включается.
   */
  private installSmokeHooks(): void {
    if (!smoke || process.env.CORD_NATIVE_FAKE !== '1') return;
    (globalThis as { cordSmoke?: unknown }).cordSmoke = {
      foreground: (foreground: NativeForegroundEvent) => this.onNativeEvent({ event: 'foreground', foreground }),
      lock: () => this.overlay.visible && this.overlay.setLocked(!this.overlay.isLocked),
    };
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
      titlebarHeight: TITLEBAR_HEIGHT,
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
          this.taskbar.refresh();
          this.overlay.configure(this.overlayConfig());
          this.mini.send('mini.config', this.miniConfig());
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
        // Подпись замка в оверлее и во всплывашке — по новому сочетанию; без сочетания замок закрыт.
        if (!message.bindings.some((binding) => binding.action === 'overlay.lock')) this.overlay.setLocked(true);
        this.overlay.configure(this.overlayConfig());
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
        // Веб до R63: имена и ступени без id и аватаров — виджет рисует их так же, без мини-окна.
        if (!this.rosterSeen) this.overlay.roster({ legacy: true, participants: message.participants });
        return;
      case 'overlay.roster':
        this.rosterSeen = true;
        // Записи не по схеме пропущены, остальные пришли (R137) — в журнал, чтобы было видно, кого нет.
        if (message.skipped) log(`мост: в составе пропущено записей: ${message.skipped}`);
        this.overlay.roster({ participants: message.participants });
        this.mini.send('overlay.roster', { participants: message.participants });
        return;
      case 'mini.state': {
        const first = !this.miniState;
        this.miniState = message.state;
        if (first) this.mini.send('mini.config', this.miniConfig());
        this.mini.send('mini.state', { ...message.state });
        // «Чат · N» в меню трея — по непрочитанным встречи (значка поверх иконки больше нет, R138).
        this.taskbar.setUnread(message.state.unread);
        if (first) this.updateMini();
        return;
      }
      case 'mini.ack':
        // Ответ встречи на нажатие (R137): мини-окно снимает «ожидание» с кнопки.
        this.mini.event('mini.ack', { seq: message.seq, result: message.result, ...(message.reason ? { reason: message.reason } : {}) });
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
        // Веб, которому прежняя оболочка дала флаг `badge`: значка поверх иконки нет (R138), число — в меню трея.
        this.taskbar.setUnread(message.count);
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
      case 'games.list':
        return this.gamesView();
      case 'games.set': {
        const call = readGameCall('games.set', payload);
        if (!call) throw new Error('Недоступно.');
        this.games = setGameEnabled(this.games, call.exe, call.enabled);
        this.refreshActive();
        this.saveGames();
        this.updateOverlay();
        return this.gamesView();
      }
      case 'games.forget': {
        const call = readGameCall('games.forget', payload);
        if (!call) throw new Error('Недоступно.');
        this.games = forgetGame(this.games, call.exe);
        this.refreshActive();
        this.saveGames();
        this.updateOverlay();
        return this.gamesView();
      }
      case 'games.pick':
        return this.pickGame();
      case 'app.gpu':
        return gpuView(await this.gpu(), av1Hw);
      default:
        void payload;
        throw new Error('Недоступно.');
    }
  }

  private updateCall(next: CallState): void {
    const was = this.call;
    this.call = next;
    this.taskbar.applyCall(next, this.roomTitle);
    this.applySleepBlocker();
    this.updateBoost();
    if (next.inCall && this.settings.get().hotkeys.length && !this.hotkeys.active.length) void this.hotkeys.apply(this.settings.get().hotkeys);
    if (next.inCall && !was.inCall) {
      // Окна оверлея и мини-окна — заранее и скрытыми: первая игра и первый Alt+Tab без задержки.
      if (this.settings.get().overlayEnabled && this.native.available) {
        this.overlay.prepare();
        this.overlay.configure(this.overlayConfig());
      }
      if (this.settings.get().mini.enabled) {
        const mini = this.settings.get().mini;
        this.mini.prepare(mini, mini.expanded);
        this.mini.send('mini.config', this.miniConfig());
      }
    }
    if (!next.inCall && was.inCall) {
      this.miniDismissed = false;
      this.closeGoLive();
    }
    this.updateOverlay();
    this.updateMini();
    if (next.screen !== was.screen && this.miniState) this.mini.send('mini.state', { ...this.miniState, screen: next.screen });
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
        // Окно оверлея: смещение перетащенного виджета, «Показать игру» и крестик карточки (R63, R104).
        case 'overlay.offset': {
          if (event.sender.id !== this.overlay.contents?.id) return null;
          const offset = readOffset(data);
          if (offset) this.settings.update({ overlay: { ...this.settings.get().overlay, offset } });
          return true;
        }
        case 'overlay.golive':
          if (event.sender.id !== this.overlay.contents?.id || !this.goLive) return null;
          void this.startGoLive(this.goLive);
          return true;
        case 'overlay.card.close':
          if (event.sender.id !== this.overlay.contents?.id) return null;
          this.closeGoLive();
          return true;
        // Мини-окно звонка: нажатия и размер по содержимому (R93); ответ сторожу, «пришли всё заново»
        // и перетаскивание (R137).
        case 'mini.action': {
          if (event.sender.id !== this.mini.contents?.id || typeof data.id !== 'string') return null;
          const want = typeof data.want === 'boolean' ? data.want : undefined;
          const seq = typeof data.seq === 'number' && Number.isInteger(data.seq) && data.seq >= 0 ? data.seq : undefined;
          this.onMiniAction(data.id, want, seq);
          return true;
        }
        case 'mini.pong':
          if (event.sender.id !== this.mini.contents?.id) return null;
          if (typeof data.seq === 'number') this.mini.pong(data.seq);
          return true;
        case 'mini.resync':
          // Кнопка не дождалась ответа встречи: мини-окну — всё, что знает main, странице — прислать заново.
          if (event.sender.id !== this.mini.contents?.id) return null;
          this.mini.resync();
          this.router.post('mini.resync');
          return true;
        case 'mini.drag':
          if (event.sender.id !== this.mini.contents?.id) return null;
          if (data.phase === 'start') this.mini.dragStart();
          else if (data.phase === 'move' && typeof data.dx === 'number' && typeof data.dy === 'number') this.mini.dragMove(data.dx, data.dy);
          else if (data.phase === 'end') this.mini.dragEnd();
          return true;
        case 'mini.size':
          if (event.sender.id !== this.mini.contents?.id) return null;
          if (typeof data.width === 'number' && typeof data.height === 'number' && Number.isFinite(data.width) && Number.isFinite(data.height)) this.mini.resize(data.width, data.height);
          return true;
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
