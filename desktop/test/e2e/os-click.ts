/**
 * Нажатие настоящей мышью Windows (user32 `SetCursorPos` + `mouse_event`), а не событием CDP: CDP кладёт
 * нажатие прямо в страницу и не заметит окно, которое перестало получать мышь от системы. Вне Windows —
 * обычное нажатие Playwright.
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';

export async function osClick(app: ElectronApplication, page: Page, selector: string): Promise<void> {
  if (process.platform !== 'win32') return page.locator(selector).first().click();
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`нет элемента ${selector}`);
  const url = page.url();
  const point = await app.evaluate(({ BrowserWindow, screen }, { url, x, y }) => {
    const w = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && win.webContents.getURL() === url);
    if (!w) return null;
    const bounds = w.getContentBounds();
    const zoom = w.webContents.getZoomFactor();
    return screen.dipToScreenPoint({ x: Math.round(bounds.x + x * zoom), y: Math.round(bounds.y + y * zoom) });
  }, { url, x: box.x + box.width / 2, y: box.y + box.height / 2 });
  if (!point) throw new Error(`нет окна ${url}`);
  const script = `
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, System.UIntPtr e);'
[W.U]::SetCursorPos(${point.x}, ${point.y}) | Out-Null
Start-Sleep -Milliseconds 60
[W.U]::mouse_event(2, 0, 0, 0, [System.UIntPtr]::Zero)
[W.U]::mouse_event(4, 0, 0, 0, [System.UIntPtr]::Zero)`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 20_000 });
}
