/**
 * Дымовой прогон Electron (Playwright `_electron`) против стенда `https://cord.nikg.tech/`:
 * заставка открывается первой, затем главное окно грузит сервер, страница видит
 * `window.cordDesktop` (протокол 2, флаги), `dataset.desktop = 'true'`, ПКМ без пунктов браузера
 * (меню своё — проверяется отсутствием DevTools-пунктов по коду), а переход на чужой origin
 * отклоняется. На Linux — под Xvfb; Windows-раннер гоняет то же самое.
 *
 * cord-native: на Windows utility-процесс грузит настоящий модуль, и мост обязан объявить `ptt` и
 * `capture.app-audio`. На других платформах хост получает подмену (`CORD_NATIVE_FAKE=1`), и тест
 * проходит всю дорогу звука: выбор → getDisplayMedia → порт PCM → MediaStreamTrackGenerator в
 * preload → дорожка в элементе страницы → слышимый тон в AnalyserNode.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const server = process.env.CORD_SMOKE_SERVER ?? 'https://cord.nikg.tech/';

async function windowWithUrl(app: ElectronApplication, prefix: string, timeout = 60_000): Promise<Page> {
  const deadline = Date.now() + timeout;
  for (;;) {
    for (const page of app.windows()) if (page.url().startsWith(prefix)) return page;
    if (Date.now() > deadline) throw new Error(`окно ${prefix} не появилось; есть: ${app.windows().map((w) => w.url()).join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

test('заставка, затем главное окно с сервером и мостом v2', async () => {
  const app = await electron.launch({
    args: [root],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SANDBOX: '1',
      CORD_SMOKE: '1',
      CORD_DEFAULT_SERVER: server,
      CORD_UPDATE_CHANNEL: 'https://127.0.0.1:9/downloads/windows/desktop/',
      ...(process.platform === 'win32' ? {} : { CORD_NATIVE_FAKE: '1' }),
    },
    timeout: 60_000,
  });
  try {
    const splash = await windowWithUrl(app, 'cord-app://shell/splash.html', 30_000);
    // В сборке разработчика зеркало не спрашивается, и заставка уступает место окну за доли секунды.
    if (!splash.isClosed()) {
      const status = await splash.locator('#status').textContent().catch(() => null);
      if (status !== null) expect(status).toMatch(/Проверяем обновления|Не удалось|остановилась|Загружаем|Устанавливаем/);
    }
    // Зеркало недоступно (порт 9): через ≤ 5 с заставка уступает место главному окну.
    const main = await windowWithUrl(app, server, 60_000);
    console.log('[smoke] главное окно на сервере', new Date().toISOString());
    await main.waitForLoadState('domcontentloaded');
    console.log('[smoke] domcontentloaded', new Date().toISOString());
    const bridge = await main.evaluate(() => {
      const api = (window as unknown as { cordDesktop?: { protocol: { major: number }; features: string[]; app: { version: string }; bootstrap: { profile: string } } }).cordDesktop;
      return api
        ? { major: api.protocol.major, features: [...api.features], profile: api.bootstrap.profile, stored: localStorage.getItem('cord:profile:v1'), hasChrome: !!(window as unknown as { chrome?: { webview?: unknown } }).chrome?.webview, version: api.app.version }
        : null;
    });
    console.log('[smoke] мост', JSON.stringify(bridge), new Date().toISOString());
    expect(bridge).not.toBeNull();
    expect(bridge!.major).toBe(2);
    expect(bridge!.features).toContain('hotkeys');
    // cord-native загружен (Windows — настоящий модуль, иначе подмена): флаги объявлены.
    expect(bridge!.features).toContain('ptt');
    expect(bridge!.features).toContain('capture.app-audio');
    if (process.platform !== 'win32') expect(bridge!.features).not.toContain('thumbar');
    // Секрет профиля — 43 символа base64url, как писал WinUI, и уже в localStorage страницы.
    expect(bridge!.profile).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(bridge!.stored).toBe(bridge!.profile);
    expect(bridge!.hasChrome).toBe(false);
    // Версия доступна только через мост — для «О программе».
    expect(bridge!.version).toMatch(/^\d+\.\d+\.\d+$/);
    // Главное окно открыто — заставки больше нет.
    await expect.poll(() => app.windows().some((w) => w.url().startsWith('cord-app://shell/splash')), { timeout: 15_000 }).toBe(false);
    // Навигация на чужой origin отклоняется: окно остаётся на сервере.
    await main.evaluate(() => {
      location.assign('https://example.com/');
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    console.log('[smoke] после навигации', main.url(), new Date().toISOString());
    expect(main.url().startsWith(server)).toBe(true);
    // Версии нигде, кроме «О программе»: заголовок окна — просто Cord.
    expect(await main.title()).not.toMatch(/\d+\.\d+\.\d+/);
    if (process.platform !== 'win32') await checkCaptureAudioBridge(main);
    const version = await app.evaluate(({ app: electronApp }) => electronApp.getVersion());
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  } finally {
    // Выход как у человека: окно закрывается крестиком, звонка нет — приложение выходит само.
    // `app.close()` Playwright под Xvfb на этом стенде зависал при живом сервере, поэтому выход
    // проверяется напрямую: процесс обязан завершиться с кодом 0 за 30 с (под нагрузкой стенда 15 с не хватало), иначе SIGKILL и сбой.
    console.log('[smoke] закрываем', new Date().toISOString());
    const exited = new Promise<number | null>((resolve) => app.process().once('exit', (code) => resolve(code)));
    const killer = setTimeout(() => app.process().kill('SIGKILL'), 30_000);
    void app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((w) => w.close())).catch(() => {});
    // R57: со значком в трее крестик прячет окно, а Cord живёт — тогда выход «Выйти» (app.quit).
    // Без трея (Linux без лотка) приложение выходит само, как раньше.
    const hidden = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(resolve, 3_000)).then(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && !w.isVisible())).catch(() => false),
      ),
    ]);
    if (hidden) {
      console.log('[smoke] окно спрятано в трей, Cord жив — выходим через app.quit()', new Date().toISOString());
      void app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => {});
    }
    const code = await exited;
    clearTimeout(killer);
    console.log('[smoke] процесс вышел', code, new Date().toISOString());
    // Playwright ждёт закрытия stdout/stderr Electron, а не выхода процесса: всё, что унаследовало их
    // (раньше — Firefox из xdg-open на «внешнюю» ссылку), держало воркер до таймаута разбора, 3 минуты.
    // Внешние ссылки в дымовом прогоне больше не открываются; остатки группы процессов — добиваются.
    if (process.platform !== 'win32') {
      try {
        process.kill(-app.process().pid!, 'SIGKILL');
      } catch {
        /* группы уже нет — так и должно быть */
      }
    }
    // Соединение Playwright с уже вышедшим процессом закрывается не всегда — не ждать его дольше 5 с.
    await Promise.race([app.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    expect(code).toBe(0);
  }
});

/**
 * Дорога звука захвата с подменой модуля: «система кроме Cord» → отдельная дорожка. Страница видит
 * тот же MediaStream через `srcObject` скрытого элемента (DOM общий для изолированного мира preload
 * и мира страницы), событие `capture.audio` приходит и подписчику, опоздавшему к старту.
 */
async function checkCaptureAudioBridge(main: Page): Promise<void> {
  const result = await main.evaluate(async () => {
    const api = (window as unknown as { cordDesktop: { invoke(method: string, payload?: object): Promise<unknown>; on(type: string, listener: (data: Record<string, unknown>) => void): () => void } }).cordDesktop;
    const sources = (await api.invoke('capture.sources')) as { appAudio: boolean; sources: { id: string; kind: string }[] };
    const screen = sources.sources.find((source) => source.kind === 'screen');
    if (!screen) return { error: 'нет экрана среди источников' };
    await api.invoke('capture.select', { id: screen.id, audio: 'system-except-cord' });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    } catch (error) {
      return { error: `getDisplayMedia: ${(error as Error).message}` };
    }
    const state = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('capture.audio не пришло за 10 с')), 10_000);
      api.on('capture.audio', (data) => {
        clearTimeout(timer);
        resolve(data);
      });
    }).catch((error: Error) => ({ state: 'timeout', reason: error.message }));
    const element = document.getElementById('cord-desktop-capture-audio') as HTMLAudioElement | null;
    const audio = element?.srcObject instanceof MediaStream ? element.srcObject : null;
    const track = audio?.getAudioTracks()[0] ?? null;
    const trackState = track?.readyState ?? null;
    let peak = 0;
    if (audio) {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      context.createMediaStreamSource(audio).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      for (let attempt = 0; attempt < 20 && peak < 0.05; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        analyser.getFloatTimeDomainData(samples);
        for (const value of samples) peak = Math.max(peak, Math.abs(value));
      }
      await context.close();
    }
    // Страница останавливает дорожку — захват в utility-процессе должен закончиться событием `ended`.
    const ended = new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 5_000);
      api.on('capture.audio', (data) => {
        if (data.state === 'ended') {
          clearTimeout(timer);
          resolve('ended');
        }
      });
    });
    track?.stop();
    for (const item of stream.getTracks()) item.stop();
    return { appAudio: sources.appAudio, state, hasTrack: !!track, trackState, peak, ended: await ended, elementLeft: !!document.getElementById('cord-desktop-capture-audio') };
  });
  console.log('[smoke] звук захвата', JSON.stringify(result), new Date().toISOString());
  expect(result).not.toHaveProperty('error');
  const audio = result as { appAudio: boolean; state: Record<string, unknown>; hasTrack: boolean; trackState: string | null; peak: number; ended: string; elementLeft: boolean };
  expect(audio.appAudio).toBe(true);
  expect(audio.state).toMatchObject({ state: 'ready', mode: 'system-except-cord' });
  expect(audio.hasTrack).toBe(true);
  expect(audio.trackState).toBe('live');
  expect(audio.peak).toBeGreaterThan(0.05);
  expect(audio.ended).toBe('ended');
  expect(audio.elementLeft).toBe(false);
}
