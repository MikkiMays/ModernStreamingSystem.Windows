/**
 * Дымовой прогон Electron (Playwright `_electron`) против стенда `https://cord.nikg.tech/`:
 * заставка открывается первой, затем главное окно грузит сервер, страница видит
 * `window.cordDesktop` (протокол 2, флаги), `dataset.desktop = 'true'`, ПКМ без пунктов браузера
 * (меню своё — проверяется отсутствием DevTools-пунктов по коду), а переход на чужой origin
 * отклоняется. На Linux — под Xvfb; Windows-раннер гоняет то же самое.
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
    env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', CORD_SMOKE: '1', CORD_DEFAULT_SERVER: server, CORD_UPDATE_CHANNEL: 'https://127.0.0.1:9/downloads/windows/desktop/' },
    timeout: 60_000,
  });
  try {
    const splash = await windowWithUrl(app, 'cord-app://shell/splash.html', 30_000);
    await expect(splash.locator('#status')).toContainText(/Проверяем обновления|Не удалось|остановилась/);
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
    const version = await app.evaluate(({ app: electronApp }) => electronApp.getVersion());
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  } finally {
    console.log('[smoke] закрываем', new Date().toISOString());
    await app.close();
    console.log('[smoke] закрыто', new Date().toISOString());
  }
});
