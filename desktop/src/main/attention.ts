/**
 * Мигание кнопки окна на панели задач (`attention`, переключатель «Мигание» в «Windows»): страница
 * просит внимания, когда в зал ожидания стучатся и человек может впустить или когда его упомянули в
 * чате, — если окно не в фокусе. Кнопка мигает, пока окно не получит фокус.
 *
 * Слушатель фокуса — один на окно, сколько бы просьб ни пришло до фокуса: прежде каждая добавляла свой
 * `once('focus')`, и они копились. Здесь нет Electron: правило проверяется `attention.test.ts`.
 */

/** То, что нужно миганию от `BrowserWindow`. */
export interface FlashWindow {
  isDestroyed(): boolean;
  isFocused(): boolean;
  flashFrame(flag: boolean): void;
  once(event: 'focus', listener: () => void): unknown;
}

/** Окна, которые сейчас мигают и уже ждут фокуса. */
const flashing = new WeakSet<FlashWindow>();

export function flashUntilFocus(window: FlashWindow | null, enabled: boolean): void {
  if (!enabled || !window || window.isDestroyed() || window.isFocused()) return;
  window.flashFrame(true);
  if (flashing.has(window)) return;
  flashing.add(window);
  window.once('focus', () => {
    flashing.delete(window);
    if (!window.isDestroyed()) window.flashFrame(false);
  });
}
