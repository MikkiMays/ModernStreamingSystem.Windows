/**
 * Стресс мини-окна: 25 человек с аватарами, уровни 30 раз в секунду, состав меняется 5 раз в секунду,
 * десятки циклов «спрятать / показать / свернуть / вернуть / другое окно впереди / перезагрузка страницы».
 * В конце мини-окно должно появиться и отвечать: «ещё» (только main) и микрофон (до страницы).
 */
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { osClick } from './os-click';

const root = join(__dirname, '..', '..');
const server = process.env.CORD_SMOKE_SERVER ?? '';
const room = { roomId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', title: 'Пятница', code: '123456789' };
const avatar = 'data:image/png;base64,' + 'A'.repeat(4000);
const roster = Array.from({ length: 25 }, (_, i) => ({ id: `p-${i}`, name: `Человек ${i}`, avatar: i % 2 ? avatar : '', muted: i % 3 === 0 }));
const monitor = { x: 0, y: 0, width: 1280, height: 720 };
const other = { hwnd: 7, pid: 4243, fullscreen: false, cord: false, monitor, exe: 'notepad.exe', title: 'Заметки', borderless: false, exclusive: false };
const cordFront = { ...other, hwnd: 5, pid: 1, cord: true, exe: 'Cord.exe', title: 'Cord' };

async function windowWithUrl(app: ElectronApplication, prefix: string, timeout = 60_000): Promise<Page> {
  const deadline = Date.now() + timeout;
  for (;;) {
    for (const page of app.windows()) if (page.url().startsWith(prefix)) return page;
    if (Date.now() > deadline) throw new Error(`окно ${prefix} не появилось`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
const shown = (app: ElectronApplication, prefix: string) =>
  app.evaluate(({ BrowserWindow }, prefix) => BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.webContents.getURL().startsWith(prefix) && w.isVisible()), prefix);
const front = (app: ElectronApplication, value: unknown) =>
  app.evaluate((_, value) => (globalThis as unknown as { cordSmoke: { foreground(v: unknown): void } }).cordSmoke.foreground(value), value);
const mainDo = (app: ElectronApplication, what: string) =>
  app.evaluate(({ BrowserWindow }, { server, what }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().startsWith(server));
    if (!w) return 'нет окна';
    if (what === 'hide') w.hide();
    if (what === 'show') w.show();
    if (what === 'minimize') w.minimize();
    if (what === 'restore') w.restore();
    if (what === 'focus') { w.show(); w.focus(); }
    if (what === 'close') w.close();
    return 'ok';
  }, { server, what });

/** Встреча «понарошку» с потоком уровней и изменений состава. */
async function inCall(main: Page): Promise<void> {
  await main.evaluate(({ room, roster }) => {
    const api = (window as unknown as { cordDesktop: { send(type: string, payload?: object): void; on(t: string, l: (d: Record<string, unknown>) => void): void } }).cordDesktop;
    const w = window as unknown as { seen: unknown[]; flood?: number[] };
    w.seen = [];
    api.on('mini.action', (data) => w.seen.push(data));
    api.send('call.state', { inCall: true, mic: true, camera: false, screen: false, room });
    api.send('overlay.roster', { participants: roster });
    api.send('mini.state', { room: room.title, self: 'p-3', mic: true, camera: false, screen: false, unread: 0, count: roster.length });
    let n = 0;
    w.flood = [
      window.setInterval(() => api.send('overlay.levels', { levels: roster.map((p, i) => [p.id, (n + i) % 5, ((n + i) % 10) / 10]) }), 33),
      window.setInterval(() => {
        n += 1;
        api.send('overlay.roster', { participants: roster.map((p, i) => ({ ...p, muted: (n + i) % 4 === 0 })) });
        api.send('mini.state', { room: room.title, self: 'p-3', mic: n % 2 === 0, camera: false, screen: false, unread: n % 7, count: roster.length });
      }, 200),
    ];
  }, { room, roster });
}

test('мини-окно отвечает после стресса', async () => {
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
    await new Promise((r) => setTimeout(r, 2000));
    await inCall(main);
    const steps = ['hide', 'show', 'minimize', 'restore', 'hide', 'focus', 'other', 'cord', 'reload'];
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 80; i++) {
      const step = steps[Math.floor(rnd() * steps.length)] ?? 'hide';
      if (step === 'other') await front(app, other);
      else if (step === 'cord') await front(app, cordFront);
      else if (step === 'reload') {
        if (i % 3 === 0) {
          await main.reload();
          await main.waitForLoadState('domcontentloaded');
          await new Promise((r) => setTimeout(r, 1500));
          await inCall(main);
        }
      } else await mainDo(app, step);
      await new Promise((r) => setTimeout(r, 30 + rnd() * 450));
    }
    // Финал: Cord спрятан, впереди другое окно — мини-окно должно появиться и отвечать.
    await front(app, other);
    await mainDo(app, 'hide');
    const mini = await windowWithUrl(app, 'cord-app://mini/mini.html', 30_000);
    await expect.poll(() => shown(app, 'cord-app://mini'), { timeout: 10_000 }).toBe(true);
    const lag = await mini.evaluate(() => new Promise<number>((resolve) => { const t = performance.now(); setTimeout(() => resolve(performance.now() - t), 0); }));
    console.log('mini event-loop lag ms', lag.toFixed(1), 'tiles', await mini.locator('#tiles .tile').count());
    await expect(mini.locator('#tiles .tile')).toHaveCount(3);
    await osClick(app, mini, '#dock-more');
    await expect(mini.locator('#mini')).toHaveAttribute('data-mode', 'expanded', { timeout: 5_000 });
    await osClick(app, mini, '.action');
    await expect.poll(() => main.evaluate(() => (window as unknown as { seen: { id?: string }[] }).seen.some((e) => e.id === 'mic')), { timeout: 5_000 }).toBe(true);
    await osClick(app, mini, '#compact');
    const metrics = await app.evaluate(({ app }) => app.getAppMetrics().map((m) => `${m.type}:${m.cpu.percentCPUUsage.toFixed(1)}%/${Math.round(m.memory.workingSetSize / 1024)}MB`));
    console.log('metrics', metrics.join(' '));
    // Закрыть главное окно (в трей или выход) и снова показать: мини-окно не должно зависнуть.
    console.log('close →', await mainDo(app, 'close'));
    await new Promise((r) => setTimeout(r, 1500));
    console.log('mini visible after close', await shown(app, 'cord-app://mini'));
  } finally {
    console.log(log.join('').split('\n').filter((l) => /ошибк|error|мини|mini/i.test(l)).slice(-15).join('\n'));
    await app.close().catch(() => {});
  }
});
