/**
 * Настоящая мышь Windows (user32 `SetCursorPos` + `mouse_event`), а не события CDP: CDP кладёт нажатие
 * прямо в страницу и не заметит окно, которое перестало получать мышь от системы. Перетаскивание —
 * тоже настоящее (R188): курсор двигается по шагам с зажатой кнопкой, и main мини-окна ставит окно по
 * настоящему курсору (`screen.getCursorScreenPoint()`), которого CDP не двигает. Вне Windows нажатие —
 * обычное нажатие Playwright, а перетаскивания нет (`osMouse` бросает ошибку).
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';

export type ScreenPoint = { x: number; y: number };
/** Шаг мыши: курсор в точку экрана (физические пиксели), кнопка вниз или вверх, пауза в мс. */
export type MouseStep = { to: ScreenPoint } | 'down' | 'up' | { wait: number };

const USER32 = `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, System.UIntPtr e);'`;

/** Шаги мыши одним вызовом PowerShell: между шагами — 16 мс, как кадр. */
export function osMouse(steps: MouseStep[]): void {
  if (process.platform !== 'win32') throw new Error('настоящая мышь — только на Windows');
  const lines = steps.map((step) => {
    if (step === 'down') return '[W.U]::mouse_event(2, 0, 0, 0, [System.UIntPtr]::Zero); Start-Sleep -Milliseconds 40';
    if (step === 'up') return '[W.U]::mouse_event(4, 0, 0, 0, [System.UIntPtr]::Zero); Start-Sleep -Milliseconds 40';
    if ('wait' in step) return `Start-Sleep -Milliseconds ${Math.round(step.wait)}`;
    // Курсор переставлен — и ещё сдвиг на 0: Windows точно пошлёт окну под курсором (или с захватом) движение мыши.
    return `[W.U]::SetCursorPos(${Math.round(step.to.x)}, ${Math.round(step.to.y)}) | Out-Null; [W.U]::mouse_event(1, 0, 0, 0, [System.UIntPtr]::Zero); Start-Sleep -Milliseconds 16`;
  });
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', [USER32, ...lines].join('\n')], { timeout: 30_000 });
}

/**
 * Точка экрана (физические пиксели) для элемента страницы: середина или `offset` от его левого верхнего
 * угла (CSS-пиксели), плюс сдвиг `shift` в DIP экрана — куда дотащить.
 */
export async function osPoint(app: ElectronApplication, page: Page, selector: string, offset?: { x?: number; y?: number }, shift = { x: 0, y: 0 }): Promise<ScreenPoint> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`нет элемента ${selector}`);
  const url = page.url();
  const x = box.x + (offset?.x ?? box.width / 2);
  const y = box.y + (offset?.y ?? box.height / 2);
  const point = await app.evaluate(({ BrowserWindow, screen }, { url, x, y, shift }) => {
    const w = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && win.webContents.getURL() === url);
    if (!w) return null;
    const bounds = w.getContentBounds();
    const zoom = w.webContents.getZoomFactor();
    return screen.dipToScreenPoint({ x: Math.round(bounds.x + x * zoom + shift.x), y: Math.round(bounds.y + y * zoom + shift.y) });
  }, { url, x, y, shift });
  if (!point) throw new Error(`нет окна ${url}`);
  return point;
}

/** Нажатие (или двойное нажатие) настоящей мышью; вне Windows — нажатие Playwright. */
export async function osClick(app: ElectronApplication, page: Page, selector: string, options: { count?: 1 | 2; offset?: { x?: number; y?: number } } = {}): Promise<void> {
  const count = options.count ?? 1;
  if (process.platform !== 'win32') {
    const locator = page.locator(selector).first();
    const position = options.offset ? { x: options.offset.x ?? 0, y: options.offset.y ?? 0 } : undefined;
    return count === 2 ? locator.dblclick({ position }) : locator.click({ position });
  }
  const point = await osPoint(app, page, selector, options.offset);
  const click: MouseStep[] = ['down', 'up'];
  osMouse([{ to: point }, { wait: 60 }, ...click, ...(count === 2 ? [{ wait: 60 }, ...click] : [])]);
}

/** Путь курсора от `from` до `to` за `steps` шагов. */
export function path(from: ScreenPoint, to: ScreenPoint, steps = 10): MouseStep[] {
  return Array.from({ length: steps }, (_, i) => ({ to: { x: from.x + ((to.x - from.x) * (i + 1)) / steps, y: from.y + ((to.y - from.y) * (i + 1)) / steps } }));
}

/**
 * Перетащить настоящей мышью: нажать на элементе (`offset` от его угла), провести курсор на `dx`, `dy`
 * (DIP) и отпустить.
 */
export async function osDrag(app: ElectronApplication, page: Page, selector: string, dx: number, dy: number, offset?: { x?: number; y?: number }): Promise<void> {
  const from = await osPoint(app, page, selector, offset);
  const to = await osPoint(app, page, selector, offset, { x: dx, y: dy });
  osMouse([{ to: from }, { wait: 60 }, 'down', ...path(from, to), { wait: 80 }, 'up']);
}
