import { describe, expect, it } from 'vitest';
import { flashUntilFocus, type FlashWindow } from '../../src/main/attention';

/** Окно с тем, что нужно миганию: фокус, мигание и слушатели «focus». */
function fakeWindow(focused = false) {
  const listeners: (() => void)[] = [];
  const window = {
    focused,
    flashing: false,
    isDestroyed: () => false,
    isFocused: () => window.focused,
    flashFrame: (flag: boolean) => void (window.flashing = flag),
    once: (event: 'focus', listener: () => void) => {
      if (event === 'focus') listeners.push(listener);
    },
    focus() {
      window.focused = true;
      listeners.splice(0).forEach((listener) => listener());
    },
    listeners,
  };
  return window satisfies FlashWindow;
}

describe('мигание кнопки окна на панели задач (attention)', () => {
  it('окно не в фокусе — мигает до фокуса; фокус — мигание снято', () => {
    const window = fakeWindow();
    flashUntilFocus(window, true);
    expect(window.flashing).toBe(true);
    window.focus();
    expect(window.flashing).toBe(false);
  });

  it('повторные «внимание» до фокуса не копят слушателей (была утечка once("focus"))', () => {
    const window = fakeWindow();
    for (let i = 0; i < 20; i++) flashUntilFocus(window, true);
    expect(window.listeners).toHaveLength(1);
  });

  it('после фокуса новое «внимание» снова мигает и снова ставит одного слушателя', () => {
    const window = fakeWindow();
    flashUntilFocus(window, true);
    window.focus();
    window.focused = false;
    flashUntilFocus(window, true);
    expect(window.flashing).toBe(true);
    expect(window.listeners).toHaveLength(1);
  });

  it('окно в фокусе или переключатель «Мигание» выключен — не мигает', () => {
    const focused = fakeWindow(true);
    flashUntilFocus(focused, true);
    expect(focused.flashing).toBe(false);
    const off = fakeWindow();
    flashUntilFocus(off, false);
    expect(off.flashing).toBe(false);
    expect(off.listeners).toHaveLength(0);
  });
});
