/**
 * Оверлей в игре, «Показать игру» и мини-окно звонка (R62, R63, R93, R104) — дымовой прогон Electron с
 * подменой `cord-native` (`CORD_NATIVE_FAKE=1`) на любой платформе: переднее окно задаёт сам тест
 * (`globalThis.cordSmoke.foreground` в main), а встречу изображает страница — сообщения моста
 * (`call.state`, `overlay.roster`, `mini.state`, `overlay.levels`) шлёт `window.cordDesktop`. Встреч на
 * сервере не создаётся.
 *
 * Проверяется: впереди игра без рамки (`game.exe`) — реестр её запомнил, окно `cord-app://overlay` видно
 * и карточки людей в DOM; уровень со страницы доходит до кольца по порту мимо main; карточка «Показать
 * игру»; замок; впереди Cord — оверлей прячется; Cord спрятан, впереди другое окно — мини-окно
 * `cord-app://mini` видно, нажатие в нём доходит до страницы; Cord снова впереди — мини-окна нет.
 * Снимки — в `test-results/shots/` (артефакт CI).
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const shots = join(root, 'test-results', 'shots');
const server = process.env.CORD_SMOKE_SERVER ?? process.env.CORD_DEFAULT_SERVER ?? '';
if (!server) throw new Error('Дымовой прогон: задайте CORD_SMOKE_SERVER — адрес сервера Cord, например https://meet.example.com/');

const room = { roomId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', title: 'Пятница', code: '123456789' };
const roster = [
  { id: 'p-1', name: 'Аня', avatar: '', muted: false },
  { id: 'p-2', name: 'Миша', avatar: '', muted: true },
  { id: 'p-3', name: 'ki', avatar: '', muted: false },
];
const monitor = { x: 0, y: 0, width: 1280, height: 720 };
const game = { hwnd: 99, pid: 7777, fullscreen: true, cord: false, monitor, exe: 'game.exe', title: 'Test Game', borderless: true, exclusive: false };

async function windowWithUrl(app: ElectronApplication, prefix: string, timeout = 60_000): Promise<Page> {
  const deadline = Date.now() + timeout;
  for (;;) {
    for (const page of app.windows()) if (page.url().startsWith(prefix)) return page;
    if (Date.now() > deadline) throw new Error(`окно ${prefix} не появилось; есть: ${app.windows().map((w) => w.url()).join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Видно ли окно оболочки с этим адресом. */
function shown(app: ElectronApplication, prefix: string): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }, prefix) => BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.webContents.getURL().startsWith(prefix) && w.isVisible()), prefix);
}

/** Встреча «понарошку»: страница говорит оболочке то же, что сказала бы во встрече. */
async function inCall(main: Page): Promise<void> {
  await main.evaluate(
    ({ room, roster }) => {
      const api = (window as unknown as { cordDesktop: { send(type: string, payload?: object): void } }).cordDesktop;
      api.send('call.state', { inCall: true, mic: true, camera: false, screen: false, room });
      api.send('overlay.roster', { participants: roster });
      api.send('mini.state', { room: room.title, self: 'p-3', mic: true, camera: false, screen: false, unread: 2, count: roster.length });
    },
    { room, roster },
  );
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(shots, { recursive: true });
  // Окна оболочки прозрачные: для снимка — фон «игры», как на макете.
  await page.evaluate(() => {
    document.documentElement.style.background = 'linear-gradient(180deg, #1d2430, #0e1116)';
  });
  await page.screenshot({ path: join(shots, `${name}.png`) });
  await page.evaluate(() => {
    document.documentElement.style.background = '';
  });
}

test('оверлей над игрой, «Показать игру» и мини-окно звонка (подмена cord-native)', async () => {
  const app = await electron.launch({
    args: [root],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SANDBOX: '1',
      CORD_SMOKE: '1',
      CORD_NATIVE_FAKE: '1',
      CORD_DEFAULT_SERVER: server,
      CORD_UPDATE_CHANNEL: 'https://127.0.0.1:9/downloads/windows/desktop/',
    },
    timeout: 60_000,
  });
  try {
    const main = await windowWithUrl(app, server, 90_000);
    await main.waitForLoadState('domcontentloaded');
    const features = await main.evaluate(() => [...(window as unknown as { cordDesktop: { features: string[] } }).cordDesktop.features]);
    for (const flag of ['games', 'overlay.widget', 'mini', 'golive']) expect(features).toContain(flag);
    // Страница успевает сказать своё `state` — дальше «встреча» не перебивается им.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await main.evaluate(() => {
      const api = (window as unknown as { cordDesktop: { on(type: string, listener: (data: Record<string, unknown>) => void): () => void } }).cordDesktop;
      const seen: Record<string, unknown>[] = [];
      (window as unknown as { seen: Record<string, unknown>[] }).seen = seen;
      for (const type of ['mini.action', 'game.active', 'games.changed']) api.on(type, (data) => seen.push({ type, ...data }));
    });
    await inCall(main);

    // ----- игра впереди: реестр и оверлей (R62, R63) -----
    await app.evaluate((_, game) => (globalThis as unknown as { cordSmoke: { foreground(value: unknown): void } }).cordSmoke.foreground(game), game);
    const overlay = await windowWithUrl(app, 'cord-app://overlay/overlay.html', 30_000);
    await expect.poll(() => shown(app, 'cord-app://overlay'), { timeout: 15_000 }).toBe(true);
    await expect(overlay.locator('.person')).toHaveCount(roster.length, { timeout: 15_000 });
    await expect(overlay.locator('.person[data-id="p-2"]')).toHaveAttribute('data-muted', 'true');
    const games = await main.evaluate(() => (window as unknown as { cordDesktop: { invoke(method: string): Promise<unknown> } }).cordDesktop.invoke('games.list'));
    expect(games).toMatchObject({ games: [{ exe: 'game.exe', name: 'Test Game', enabled: true }], active: { exe: 'game.exe', exclusive: false } });

    // Уровень голоса со страницы — по порту мимо main — зажигает кольцо.
    await main.evaluate(() => (window as unknown as { cordDesktop: { send(type: string, payload?: object): void } }).cordDesktop.send('overlay.levels', { levels: [['p-1', 3, 0.7]] }));
    await expect(overlay.locator('.person[data-id="p-1"]')).toHaveAttribute('data-tier', '3', { timeout: 5_000 });

    // «Показать игру» — карточка в оверлее (R104).
    await expect(overlay.locator('#card')).toBeVisible({ timeout: 5_000 });
    await shot(overlay, 'r63-overlay-widget');
    await shot(overlay, 'r104-golive-card');

    // Замок: разблокирован — подпись и рамка.
    await app.evaluate(() => (globalThis as unknown as { cordSmoke: { lock(): void } }).cordSmoke.lock());
    await expect(overlay.locator('body')).toHaveAttribute('data-locked', 'false');
    await expect(overlay.locator('#unlocked')).toBeVisible();
    await shot(overlay, 'r63-overlay-unlocked');
    await app.evaluate(() => (globalThis as unknown as { cordSmoke: { lock(): void } }).cordSmoke.lock());

    // Впереди Cord — оверлея нет; игра «сейчас» остаётся (человек ушёл в настройки посреди игры).
    await app.evaluate((_, game) => (globalThis as unknown as { cordSmoke: { foreground(value: unknown): void } }).cordSmoke.foreground({ ...game, hwnd: 5, pid: 1, cord: true, exe: 'Cord.exe', title: 'Cord', fullscreen: false, borderless: false }), game);
    await expect.poll(() => shown(app, 'cord-app://overlay'), { timeout: 10_000 }).toBe(false);

    // ----- мини-окно звонка (R93): Cord спрятан, впереди другое окно -----
    await app.evaluate((_, game) => (globalThis as unknown as { cordSmoke: { foreground(value: unknown): void } }).cordSmoke.foreground({ ...game, hwnd: 7, pid: 4243, exe: 'notepad.exe', title: 'Заметки', fullscreen: false, borderless: false }), game);
    await app.evaluate(({ BrowserWindow }, server) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(server))?.hide(), server);
    const mini = await windowWithUrl(app, 'cord-app://mini/mini.html', 30_000);
    await expect.poll(() => shown(app, 'cord-app://mini'), { timeout: 10_000 }).toBe(true);
    await expect(mini.locator('#mini')).toHaveAttribute('data-mode', 'compact');
    await expect(mini.locator('#tiles .tile')).toHaveCount(2);
    await shot(mini, 'r93-mini-compact');
    await mini.locator('#dock-more').click();
    await expect(mini.locator('#mini')).toHaveAttribute('data-mode', 'expanded', { timeout: 5_000 });
    // «Звук встречи» (R156) есть в разметке всегда, но виден, только когда веб назвал его состояние.
    await expect(mini.locator('.action:visible')).toHaveCount(6);
    await shot(mini, 'r93-mini-expanded');
    await mini.locator('.action').first().click();
    await expect.poll(() => main.evaluate(() => (window as unknown as { seen: { type: string; id?: string }[] }).seen.some((event) => event.type === 'mini.action' && event.id === 'mic')), { timeout: 5_000 }).toBe(true);
    await mini.locator('#compact').click();
    await expect(mini.locator('#mini')).toHaveAttribute('data-mode', 'compact', { timeout: 5_000 });

    // Cord снова впереди — мини-окна нет.
    await app.evaluate(({ BrowserWindow }, server) => {
      const window = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith(server));
      window?.show();
      window?.focus();
    }, server);
    await app.evaluate((_, game) => (globalThis as unknown as { cordSmoke: { foreground(value: unknown): void } }).cordSmoke.foreground({ ...game, hwnd: 5, pid: 1, cord: true, exe: 'Cord.exe', title: 'Cord', fullscreen: false, borderless: false }), game);
    await expect.poll(() => shown(app, 'cord-app://mini'), { timeout: 10_000 }).toBe(false);
  } finally {
    const exited = new Promise<number | null>((resolve) => app.process().once('exit', (code) => resolve(code)));
    const killer = setTimeout(() => app.process().kill('SIGKILL'), 30_000);
    void app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => {});
    await exited;
    clearTimeout(killer);
    if (process.platform !== 'win32') {
      try {
        process.kill(-app.process().pid!, 'SIGKILL');
      } catch {
        /* группы уже нет */
      }
    }
    await Promise.race([app.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
});
