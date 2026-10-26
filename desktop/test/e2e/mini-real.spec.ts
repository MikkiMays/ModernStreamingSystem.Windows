/**
 * Мини-окно на настоящей встрече: клиент создаёт встречу, заходят N участников из Chrome без аватаров.
 * Создаёт встречи на сервере и зависит от его связи — только по просьбе (`CORD_MINI_REAL=1`); всё, что
 * в мини-окне нажимается, без сервера проверяет `mini-ui.spec.ts`.
 */
import { _electron as electron, chromium, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { osClick } from './os-click';

const root = join(__dirname, '..', '..');
const server = process.env.CORD_SMOKE_SERVER ?? '';
const guests = Number(process.env.GUESTS ?? 6);
const monitor = { x: 0, y: 0, width: 1280, height: 720 };
const other = { hwnd: 7, pid: 4243, fullscreen: false, cord: false, monitor, exe: 'notepad.exe', title: 'Заметки', borderless: false, exclusive: false };

async function windowWithUrl(app: ElectronApplication, prefix: string, timeout = 60_000): Promise<Page> {
  const deadline = Date.now() + timeout;
  for (;;) {
    for (const page of app.windows()) if (page.url().startsWith(prefix)) return page;
    if (Date.now() > deadline) throw new Error(`окно ${prefix} не появилось`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
const shown = (app: ElectronApplication, prefix: string) =>
  app.evaluate(({ BrowserWindow }, prefix) => BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.webContents.getURL().startsWith(prefix) && w.isVisible()), prefix);
const front = (app: ElectronApplication, value: unknown) =>
  app.evaluate((_, value) => (globalThis as unknown as { cordSmoke: { foreground(v: unknown): void } }).cordSmoke.foreground(value), value);
const mainDo = (app: ElectronApplication, what: string) =>
  app.evaluate(({ BrowserWindow }, { server, what }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith(server));
    if (what === 'hide') w?.hide();
    if (what === 'focus') { w?.show(); w?.focus(); }
  }, { server, what });

test('мини-окно на настоящей встрече', async () => {
  test.skip(process.env.CORD_MINI_REAL !== '1', 'встречи на сервере — только с CORD_MINI_REAL=1');
  test.setTimeout(300_000);
  const app = await electron.launch({
    args: [root, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    env: { ...process.env, ELECTRON_DISABLE_SANDBOX: '1', CORD_SMOKE: '1', CORD_NATIVE_FAKE: '1', CORD_DEFAULT_SERVER: server, CORD_UPDATE_CHANNEL: 'https://127.0.0.1:9/downloads/windows/desktop/' },
    timeout: 60_000,
  });
  const browser = await chromium.launch({ channel: 'chrome', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox'] });
  try {
    const main = await windowWithUrl(app, server, 90_000);
    const errors: string[] = [];
    main.on('pageerror', (e) => errors.push(e.message));
    await main.waitForLoadState('networkidle').catch(() => {});
    await main.getByRole('button', { name: 'Skip' }).click({ timeout: 3000 }).catch(() => {});
    await main.getByRole('button', { name: /New meeting/i }).first().click();
    await main.getByPlaceholder('What should we call you?').fill('host');
    await main.getByRole('button', { name: 'Start meeting' }).click();
    await main.waitForTimeout(6000);
    // Встреча на медленном раннере грузится дольше: код ждём до 30 с.
    let code: string | undefined;
    for (let t = 0; t < 60 && !code; t++) {
      code = (await main.evaluate(() => document.body.innerText)).match(/\d{3}-\d{3}-\d{3}/)?.[0];
      if (!code) await main.waitForTimeout(500);
    }
    if (!code) {
      mkdirSync(join(root, 'test-results', 'shots'), { recursive: true });
      await main.screenshot({ path: join(root, 'test-results', 'shots', 'mini-real-no-code.png') }).catch(() => {});
      console.log('url', main.url(), 'errors', errors.join(' / '), '\ntext', (await main.evaluate(() => document.body.innerText)).slice(0, 800));
      throw new Error('код встречи не появился');
    }
    console.log('code', code, 'url', main.url());
    for (let i = 0; i < guests; i++) {
      const ctx = await browser.newContext({ locale: 'en-US', permissions: ['microphone'] });
      const g = await ctx.newPage();
      await g.goto(server, { waitUntil: 'networkidle' });
      await g.getByRole('button', { name: 'Skip' }).click({ timeout: 2000 }).catch(() => {});
      await g.getByPlaceholder('123-456-789').fill(code);
      await g.getByRole('button', { name: 'Join', exact: true }).click();
      await g.waitForTimeout(2500);
      await g.getByPlaceholder('What should we call you?').fill(`guest-${i}`).catch(() => {});
      await g.getByRole('button', { name: 'Unmute microphone' }).click().catch(() => {});
      for (const n of [/^Join/i, /Ask to join/i]) { const x = g.getByRole('button', { name: n }).first(); if (await x.isVisible().catch(() => false)) { await x.click(); break; } }
    }
    await main.waitForTimeout(8000);
    await front(app, other);
    await mainDo(app, 'hide');
    const mini = await windowWithUrl(app, 'cord-app://mini/mini.html', 30_000);
    await expect.poll(() => shown(app, 'cord-app://mini'), { timeout: 10_000 }).toBe(true);
    await mini.waitForTimeout(3000);
    const tiles = await mini.locator('#tiles .tile').evaluateAll((els) => els.map((e) => `${(e as HTMLElement).dataset.id || ''}:${e.textContent?.trim().slice(0, 12)}:tier${(e as HTMLElement).dataset.tier}`));
    console.log('mini tiles', tiles.join(' | '));
    // Цепочка нажатия: мини-окно (click) → main → страница (mini.action) → mini.state обратно.
    await mini.evaluate(() => { const w = window as unknown as { clicks: string[] }; w.clicks = []; document.addEventListener('click', (e) => w.clicks.push((e.target as Element).closest('[id]')?.id ?? '?'), true); });
    await main.evaluate(() => {
      const w = window as unknown as { seen: unknown[]; sent: unknown[]; cordDesktop: { on(t: string, l: (d: unknown) => void): void; send(t: string, p?: unknown): void } };
      w.seen = []; w.sent = [];
      w.cordDesktop.on('mini.action', (d) => w.seen.push(d));
      const send = w.cordDesktop.send.bind(w.cordDesktop);
      w.cordDesktop.send = (t, p) => { if (t === 'mini.state') w.sent.push(p); send(t, p); };
    }).catch((e) => console.log('hook main', String(e)));
    const consoleLines: string[] = [];
    main.on('console', (m) => { if (m.type() !== 'debug') consoleLines.push(`${m.type()}: ${m.text().slice(0, 200)}`); });
    const before = await mini.locator('#dock-mic').getAttribute('aria-pressed');
    await osClick(app, mini, '#dock-mic');
    try {
      await expect.poll(() => mini.locator('#dock-mic').getAttribute('aria-pressed'), { timeout: 8000 }).not.toBe(before);
    } catch (error) {
      const diag = async (label: string) => console.log(label,
        '\n  mini clicks', JSON.stringify(await mini.evaluate(() => (window as unknown as { clicks: string[] }).clicks)),
        '\n  page mini.action', JSON.stringify(await main.evaluate(() => (window as unknown as { seen: unknown[] }).seen).catch(String)),
        '\n  page mini.state', JSON.stringify(await main.evaluate(() => (window as unknown as { sent: unknown[] }).sent.slice(-2)).catch(String)),
        '\n  page mic buttons', JSON.stringify(await main.locator('button[aria-label*="icrophone" i]').evaluateAll((els) => els.map((e) => `${e.getAttribute('aria-label')}|${e.getAttribute('aria-pressed')}|${(e as HTMLButtonElement).disabled}`)).catch(String)),
        '\n  page text', (await main.evaluate(() => document.body.innerText).catch(String)).replace(/\s+/g, ' ').slice(0, 400),
        '\n  console', consoleLines.slice(-12).join('\n    '));
      await diag('mic не переключился (мышь Windows)');
      await mini.locator('#dock-mic').click();
      await mini.waitForTimeout(3000);
      await diag(`после нажатия CDP: aria-pressed ${await mini.locator('#dock-mic').getAttribute('aria-pressed')}`);
      throw error;
    }
    console.log('mic', before, '→', await mini.locator('#dock-mic').getAttribute('aria-pressed'));
    for (let i = 0; i < 15; i++) { await mainDo(app, i % 2 ? 'hide' : 'focus'); await front(app, i % 2 ? other : { ...other, cord: true, exe: 'Cord.exe' }); await mini.waitForTimeout(300); }
    await front(app, other); await mainDo(app, 'hide');
    await expect.poll(() => shown(app, 'cord-app://mini'), { timeout: 10_000 }).toBe(true);
    const b2 = await mini.locator('#dock-mic').getAttribute('aria-pressed');
    await osClick(app, mini, '#dock-mic');
    await expect.poll(() => mini.locator('#dock-mic').getAttribute('aria-pressed'), { timeout: 8000 }).not.toBe(b2);
    console.log('after toggles mic', b2, '→', await mini.locator('#dock-mic').getAttribute('aria-pressed'));
    console.log('page errors', errors.length, errors.slice(0, 3).join(' / '));
    expect(errors).toEqual([]);
  } finally {
    await browser.close().catch(() => {});
    await app.close().catch(() => {});
  }
});
