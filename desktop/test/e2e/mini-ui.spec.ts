/**
 * Мини-окно звонка целиком (R93): всё, что в нём видно и нажимается, — с подменой `cord-native`
 * (`CORD_NATIVE_FAKE=1`), встречу изображает страница сообщениями моста. На Windows нажатия — настоящей
 * мышью (`os-click.ts`). Встреч на сервере не создаётся.
 *
 * Проверяется: плитки (до трёх, «+N», без себя, аватар, значок выключенного микрофона), кольцо и
 * порядок говорящих, кольца гаснут без уровней; пульт и развёрнутый вид — каждое нажатие доходит до
 * страницы своим `id`; «Участники» / «Чат» / «Настройки» / «⧉» поднимают Cord; «—» прячет окно до
 * возврата в Cord; двойной щелчок по полосе; плитка показа с «Завершить»; связь восстанавливается —
 * полоса с секундами, кнопки погашены и не шлют ничего, секунды не перерисовывают плитки; размер окна
 * по содержимому; упало мини-окно — новое с тем же состоянием; упала страница встречи — мини-окна
 * нет, страница загружена заново; 25 человек и уровни 30 раз в секунду — без лишних перерисовок.
 * Снимки — в `test-results/shots/mini-ui-*.png`.
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { osClick } from './os-click';

const root = join(__dirname, '..', '..');
const shots = join(root, 'test-results', 'shots');
const server = process.env.CORD_SMOKE_SERVER ?? '';
const room = { roomId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', title: 'Пятничный созвон команды', code: '123456789' };
// Аватар — настоящая PNG 1×1, чтобы картинка действительно рисовалась.
const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const people = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p-${i}`, name: i === 0 ? 'ki' : `Человек ${i}`, avatar: i === 2 ? avatar : '', muted: i === 1 }));
const monitor = { x: 0, y: 0, width: 1280, height: 720 };
const other = { hwnd: 7, pid: 4243, fullscreen: false, cord: false, monitor, exe: 'notepad.exe', title: 'Заметки', borderless: false, exclusive: false };
const MINI = 'cord-app://mini/mini.html';

type Api = { send(type: string, payload?: object): void; on(type: string, listener: (data: Record<string, unknown>) => void): void };

/** Открытая страница окна с этим адресом (после падения — новая, а не закрытая прежняя). */
async function windowWithUrl(app: ElectronApplication, prefix: string, timeout = 60_000, not?: Page): Promise<Page> {
  const deadline = Date.now() + timeout;
  for (;;) {
    for (const page of app.windows()) if (page !== not && !page.isClosed() && page.url().startsWith(prefix)) return page;
    if (Date.now() > deadline) throw new Error(`окно ${prefix} не появилось`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
const shown = (app: ElectronApplication, prefix: string) =>
  app.evaluate(({ BrowserWindow }, prefix) => BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.webContents.getURL().startsWith(prefix) && w.isVisible()), prefix);
const front = (app: ElectronApplication, value: unknown) =>
  app.evaluate((_, value) => (globalThis as unknown as { cordSmoke: { foreground(v: unknown): void } }).cordSmoke.foreground(value), value);
const mainDo = (app: ElectronApplication, what: 'hide' | 'focus' | 'crash') =>
  app.evaluate(({ BrowserWindow }, { server, what }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().startsWith(server));
    if (what === 'hide') w?.hide();
    if (what === 'focus') { w?.show(); w?.focus(); }
    if (what === 'crash') w?.webContents.forcefullyCrashRenderer();
  }, { server, what });
const mainVisible = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }, server) => !!BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().startsWith(server))?.isVisible(), server);

/**
 * Скрипт в странице главного окна — через само окно, а не `Page` Playwright: после падения процесса
 * страницы прежняя `Page` мертва навсегда, а окно перезагружает страницу.
 */
const page = <T>(app: ElectronApplication, script: string) =>
  app.evaluate(async ({ BrowserWindow }, { server, script }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && x.webContents.getURL().startsWith(server));
    if (!w || w.webContents.isCrashed() || w.webContents.isLoading()) return undefined;
    return w.webContents.executeJavaScript(script);
  }, { server, script }) as Promise<T | undefined>;

/** Страница говорит оболочке то же, что сказала бы во встрече. */
async function send(app: ElectronApplication, type: string, payload: object): Promise<void> {
  await page(app, `window.cordDesktop.send(${JSON.stringify(type)}, ${JSON.stringify(payload)})`);
}
const base = { room: room.title, self: 'p-0', mic: true, camera: false, screen: false, unread: 0, count: 4, status: 'connected', remaining: 0 };
async function inCall(app: ElectronApplication, roster = people(4), state: object = {}): Promise<void> {
  await page(app, `window.seen = []; window.cordDesktop.on('mini.action', (data) => window.seen.push(data)); 0`);
  await send(app, 'call.state', { inCall: true, mic: true, camera: false, screen: false, room });
  await send(app, 'overlay.roster', { participants: roster });
  await send(app, 'mini.state', { ...base, count: roster.length, ...state });
}
const seen = async (app: ElectronApplication) => (await page<string[]>(app, 'window.seen.map((e) => e.id)')) ?? [];
const forget = (app: ElectronApplication) => page(app, 'window.seen = []; 0');
async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(shots, { recursive: true });
  await page.evaluate(() => (document.documentElement.style.background = 'linear-gradient(180deg, #1d2430, #0e1116)'));
  await page.screenshot({ path: join(shots, `mini-ui-${name}.png`) });
  await page.evaluate(() => (document.documentElement.style.background = ''));
}

/** Cord спрятан, впереди другое окно — мини-окно должно появиться. */
async function away(app: ElectronApplication, not?: Page): Promise<Page> {
  await front(app, other);
  await mainDo(app, 'hide');
  const mini = await windowWithUrl(app, MINI, 30_000, not);
  await expect.poll(() => shown(app, 'cord-app://mini'), { timeout: 10_000 }).toBe(true);
  await mini.waitForLoadState('domcontentloaded');
  return mini;
}

test('мини-окно: вид, каждая кнопка, связь, падения и нагрузка', async () => {
  test.setTimeout(300_000);
  const app = await electron.launch({
    args: [root],
    env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', CORD_SMOKE: '1', CORD_NATIVE_FAKE: '1', CORD_DEFAULT_SERVER: server, CORD_UPDATE_CHANNEL: 'https://127.0.0.1:9/downloads/windows/desktop/' },
    timeout: 60_000,
  });
  const log: string[] = [];
  app.process().stdout?.on('data', (d) => log.push(String(d)));
  try {
    const main = await windowWithUrl(app, server, 90_000);
    await main.waitForLoadState('domcontentloaded');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await inCall(app);
    let mini = await away(app);

    await test.step('плитки: без себя, аватар, выключенный микрофон', async () => {
      await expect(mini.locator('#mini')).toHaveAttribute('data-mode', 'compact');
      await expect(mini.locator('#tiles .tile')).toHaveCount(3);
      await expect(mini.locator('#tiles .tile[data-id="p-0"]'), 'своей плитки в компактном нет').toHaveCount(0);
      await expect(mini.locator('#tiles .tile[data-id="p-1"]')).toHaveAttribute('data-muted', 'true');
      await expect(mini.locator('#tiles .tile[data-id="p-1"] .tile__muted')).toBeVisible();
      await expect(mini.locator('#tiles .tile[data-id="p-2"] img')).toHaveCount(1);
      await expect(mini.locator('#link')).toBeHidden();
      await shot(mini, 'compact');
    });

    await test.step('говорящий: кольцо, первым за секунду, кольцо гаснет без уровней', async () => {
      await send(app, 'overlay.levels', { levels: [['p-3', 3, 0.7]] });
      await expect(mini.locator('#tiles .tile[data-id="p-3"]')).toHaveAttribute('data-tier', '3', { timeout: 3_000 });
      await expect.poll(() => mini.locator('#tiles .tile').first().getAttribute('data-id'), { timeout: 3_000 }).toBe('p-3');
      await shot(mini, 'speaking');
      await expect(mini.locator('#tiles .tile[data-id="p-3"]'), 'уровни перестали приходить — кольца нет').toHaveAttribute('data-tier', '0', { timeout: 4_000 });
    });

    await test.step('много людей: две плитки и «+N»', async () => {
      await send(app, 'overlay.roster', { participants: people(25) });
      await send(app, 'mini.state', { ...base, count: 25 });
      await expect(mini.locator('#tiles .tile')).toHaveCount(3);
      await expect(mini.locator('#tiles .tile--more')).toHaveText('+22');
      await shot(mini, 'many');
    });

    await test.step('пульт: микрофон и показ доходят до страницы, состояние — с неё', async () => {
      await expect(mini.locator('#dock-mic')).toHaveAttribute('aria-pressed', 'true');
      await osClick(app, mini, '#dock-mic');
      await send(app, 'mini.state', { ...base, count: 25, mic: false });
      await expect(mini.locator('#dock-mic')).toHaveAttribute('aria-pressed', 'false');
      // Начать показ — окно выбора в Cord: Cord выходит вперёд, мини-окно уходит.
      await osClick(app, mini, '#dock-screen');
      await expect.poll(() => seen(app), { timeout: 5_000 }).toEqual(['mic', 'screen']);
      await expect.poll(() => mainVisible(app), { timeout: 5_000 }).toBe(true);
      await front(app, { ...other, hwnd: 5, pid: 1, cord: true, exe: 'Cord.exe', title: 'Cord' });
      await expect.poll(() => shown(app, 'cord-app://mini'), { timeout: 5_000 }).toBe(false);
      mini = await away(app);
    });

    await test.step('показ экрана: плитка «Вы показываете» первой, «Завершить»', async () => {
      await send(app, 'call.state', { inCall: true, mic: false, camera: false, screen: true, room });
      await send(app, 'mini.state', { ...base, count: 25, screen: true });
      await expect(mini.locator('#tiles .tile').first()).toHaveClass(/tile--share/);
      await expect(mini.locator('#dock-screen')).toHaveAttribute('data-live', 'true');
      await shot(mini, 'sharing');
      await osClick(app, mini, '.tile__stop');
      await expect.poll(() => seen(app), { timeout: 5_000 }).toEqual(['mic', 'screen', 'screen']);
      expect(await shown(app, 'cord-app://mini'), '«Завершить» показ Cord не поднимает').toBe(true);
      await send(app, 'call.state', { inCall: true, mic: false, camera: false, screen: false, room });
      await send(app, 'mini.state', { ...base, count: 25 });
    });

    await test.step('связь восстанавливается: полоса, секунды, кнопки погашены и молчат', async () => {
      await send(app, 'mini.state', { ...base, count: 25, status: 'recovering', remaining: 18 });
      await expect(mini.locator('#link')).toBeVisible();
      // Язык оболочки — системный: «Связь восстанавливается…», «Reconnecting…» и т. д.
      await expect(mini.locator('.link__text')).toHaveText(/\S…$/);
      await expect(mini.locator('.link__seconds')).toHaveText(/^18\s/);
      await expect(mini.locator('#dock-mic')).toBeDisabled();
      await expect(mini.locator('#dock-screen')).toBeDisabled();
      await expect(mini.locator('#dock-more'), '«ещё» работает: выйти из встречи можно и без связи').toBeEnabled();
      await shot(mini, 'recovering');
      await mini.evaluate(() => ((window as unknown as { tile: Element | null }).tile = document.querySelector('#tiles .tile')));
      for (const remaining of [17, 16, 15]) await send(app, 'mini.state', { ...base, count: 25, status: 'recovering', remaining });
      await expect(mini.locator('.link__seconds')).toHaveText(/^15\s/);
      expect(await mini.evaluate(() => !!(window as unknown as { tile: Element | null }).tile?.isConnected), 'секунды не перерисовывают плитки').toBe(true);
      // Погашенная кнопка не шлёт ничего — даже настоящей мышью.
      await osClick(app, mini, '#dock-more');
      await expect(mini.locator('#mini')).toHaveAttribute('data-mode', 'expanded', { timeout: 5_000 });
      for (const id of ['mic', 'camera', 'screen']) await expect(mini.locator(`.action[data-action="${id}"]`)).toBeDisabled();
      await shot(mini, 'recovering-expanded');
      await mini.locator('.action[data-action="mic"]').dispatchEvent('click');
      await mini.waitForTimeout(500);
      expect(await seen(app)).toEqual(['mic', 'screen', 'screen']);
      await send(app, 'mini.state', { ...base, count: 25, status: 'connected' });
      await expect(mini.locator('#link')).toBeHidden();
      for (const id of ['mic', 'camera', 'screen']) await expect(mini.locator(`.action[data-action="${id}"]`)).toBeEnabled();
    });

    await test.step('развёрнутый: каждое действие своим id, бейджи', async () => {
      await send(app, 'mini.state', { ...base, count: 25, unread: 120 });
      await expect(mini.locator('.action')).toHaveCount(6);
      await expect(mini.locator('.action[data-action="chat"] .badge--alert')).toHaveText('99+');
      await expect(mini.locator('.action[data-action="people"] .badge')).toHaveText('25');
      await expect(mini.locator('#self')).toBeVisible();
      await shot(mini, 'expanded');
      await forget(app);
      await osClick(app, mini, '.action[data-action="mic"]');
      await osClick(app, mini, '.action[data-action="camera"]');
      await osClick(app, mini, '#leave');
      await expect.poll(() => seen(app), { timeout: 5_000 }).toEqual(['mic', 'camera', 'leave']);
      expect(await shown(app, 'cord-app://mini'), 'микрофон, камера и выход Cord не поднимают').toBe(true);
    });

    await test.step('«Участники», «Чат», «Настройки», «⧉» поднимают Cord, мини-окно уходит', async () => {
      for (const target of ['.action[data-action="people"]', '.action[data-action="chat"]', '.action[data-action="settings"]', '#open']) {
        mini = await away(app);
        await osClick(app, mini, target);
        await expect.poll(() => mainVisible(app), { timeout: 5_000 }).toBe(true);
        await front(app, { ...other, hwnd: 5, pid: 1, cord: true, exe: 'Cord.exe', title: 'Cord' });
        await expect.poll(() => shown(app, 'cord-app://mini'), { timeout: 5_000 }).toBe(false);
      }
      expect((await seen(app)).slice(-3)).toEqual(['people', 'chat', 'settings']);
    });

    await test.step('«Компактно» и двойной щелчок по полосе', async () => {
      mini = await away(app);
      await osClick(app, mini, '#compact');
      await expect(mini.locator('#mini')).toHaveAttribute('data-mode', 'compact', { timeout: 5_000 });
      await mini.locator('#bar').dblclick({ position: { x: 60, y: 14 } });
      await expect(mini.locator('#mini')).toHaveAttribute('data-mode', 'expanded', { timeout: 5_000 });
      await mini.locator('#bar').dblclick({ position: { x: 60, y: 14 } });
      await expect(mini.locator('#mini')).toHaveAttribute('data-mode', 'compact', { timeout: 5_000 });
    });

    await test.step('размер окна — по содержимому', async () => {
      const size = () => app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL() === url)?.getContentSize(), MINI);
      const frame = () => mini.evaluate(() => [document.getElementById('frame')!.offsetWidth, document.getElementById('frame')!.offsetHeight]);
      await expect.poll(async () => JSON.stringify(await size()), { timeout: 5_000 }).toBe(JSON.stringify(await frame()));
      await osClick(app, mini, '#dock-more');
      await expect(mini.locator('#mini')).toHaveAttribute('data-mode', 'expanded', { timeout: 5_000 });
      await mini.waitForTimeout(400);
      await expect.poll(async () => JSON.stringify(await size()), { timeout: 5_000 }).toBe(JSON.stringify(await frame()));
      console.log('размер развёрнутого', await size());
      await osClick(app, mini, '#compact');
    });

    await test.step('«—» прячет мини-окно до возврата в Cord', async () => {
      await osClick(app, mini, '#collapse');
      await expect.poll(() => shown(app, 'cord-app://mini'), { timeout: 5_000 }).toBe(false);
      await front(app, { ...other, hwnd: 8, title: 'Другое' });
      await mini.waitForTimeout(800);
      expect(await shown(app, 'cord-app://mini'), 'после «—» не возвращается само').toBe(false);
      await mainDo(app, 'focus');
      await front(app, { ...other, hwnd: 5, pid: 1, cord: true, exe: 'Cord.exe', title: 'Cord' });
      await mini.waitForTimeout(300);
      mini = await away(app);
    });

    await test.step('нагрузка: 25 человек, уровни 30 раз в секунду, состав 5 раз в секунду', async () => {
      await mini.evaluate(() => {
        const w = window as unknown as { mutations: number; longest: number };
        w.mutations = 0;
        w.longest = 0;
        new MutationObserver((list) => (w.mutations += list.filter((m) => m.type === 'childList').length)).observe(document.getElementById('tiles')!, { childList: true });
        let last = performance.now();
        const tick = () => {
          const now = performance.now();
          w.longest = Math.max(w.longest, now - last);
          last = now;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await page(app, `(() => {
        const roster = ${JSON.stringify(people(25))};
        const api = window.cordDesktop;
        let n = 0;
        const levels = setInterval(() => api.send('overlay.levels', { levels: roster.map((p, i) => [p.id, (n + i) % 5, ((n + i) % 10) / 10]) }), 33);
        const changes = setInterval(() => {
          n += 1;
          api.send('overlay.roster', { participants: roster.map((p, i) => ({ ...p, muted: (n + i) % 4 === 0 })) });
        }, 200);
        setTimeout(() => (clearInterval(levels), clearInterval(changes)), 6000);
        return 0;
      })()`);
      await mini.waitForTimeout(6500);
      const load = await mini.evaluate(() => {
        const w = window as unknown as { mutations: number; longest: number };
        return { mutations: w.mutations, longest: w.longest };
      });
      console.log('нагрузка: перестроений плиток за 6 с', load.mutations, 'самый долгий кадр, мс', Math.round(load.longest));
      // Состав меняется 5 раз в секунду (30 за 6 с) плюс перестановки раз в секунду.
      expect(load.mutations).toBeLessThanOrEqual(40);
      expect(load.longest).toBeLessThan(250);
      await osClick(app, mini, '#dock-mic');
      await expect.poll(async () => (await seen(app)).at(-1), { timeout: 5_000 }).toBe('mic');
    });

    await test.step('мини-окно упало — новое с тем же состоянием и отвечает', async () => {
      const before = mini;
      await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL() === url)?.webContents.forcefullyCrashRenderer(), MINI);
      mini = await windowWithUrl(app, MINI, 15_000, before);
      await expect.poll(() => shown(app, 'cord-app://mini'), { timeout: 10_000 }).toBe(true);
      await expect(mini.locator('#tiles .tile')).toHaveCount(3, { timeout: 5_000 });
      await expect(mini.locator('#tiles .tile--more')).toHaveText('+22');
      await forget(app);
      await osClick(app, mini, '#dock-mic');
      await expect.poll(() => seen(app), { timeout: 5_000 }).toEqual(['mic']);
      const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.webContents.getURL().startsWith('cord-app://mini')).length);
      expect(windows, 'одно мини-окно, без висящего прежнего').toBe(1);
    });

    await test.step('страница встречи упала — мини-окна нет, страница загружена заново', async () => {
      await mainDo(app, 'crash');
      await expect.poll(() => shown(app, 'cord-app://mini'), { timeout: 5_000 }).toBe(false);
      await expect.poll(() => page(app, 'typeof window.cordDesktop'), { timeout: 30_000 }).toBe('object');
      // Новая страница сначала сама говорит «не в звонке» — «встречу» шлём после этого, как при запуске.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await inCall(app);
      mini = await away(app);
      await osClick(app, mini, '#dock-mic');
      await expect.poll(() => seen(app), { timeout: 5_000 }).toEqual(['mic']);
    });

    await test.step('впереди встало окно во весь экран раньше 400 мс — мини-окна нет', async () => {
      await mainDo(app, 'focus');
      await front(app, { ...other, hwnd: 5, pid: 1, cord: true, exe: 'Cord.exe', title: 'Cord' });
      await expect.poll(() => shown(app, 'cord-app://mini'), { timeout: 5_000 }).toBe(false);
      await front(app, other);
      await mainDo(app, 'hide');
      await front(app, { ...other, hwnd: 9, fullscreen: true, exe: 'video.exe', title: 'Видео' });
      await mini.waitForTimeout(1000);
      expect(await shown(app, 'cord-app://mini')).toBe(false);
    });
  } catch (error) {
    console.log(log.join('').split('\n').slice(-25).join('\n'));
    throw error;
  } finally {
    await app.close().catch(() => {});
  }
});
