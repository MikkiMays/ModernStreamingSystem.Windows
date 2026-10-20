import { describe, expect, it } from 'vitest';
import {
  accelerator,
  HotkeyRegistry,
  planHotkeys,
  STATUS_DUPLICATE,
  STATUS_GLOBAL,
  STATUS_TAKEN,
  STATUS_WINDOW_ONLY,
} from '../../src/main/hotkeys';
import type { HotkeyBinding } from '../../src/main/bridge/messages';

const key = (code: string, mods: Partial<HotkeyBinding['key']> = {}) => ({ code, ctrl: false, alt: false, shift: false, meta: false, ...mods });

describe('accelerator — правила MicrophoneHotkey.TryNative', () => {
  it('Ctrl или Alt обязательны, Windows и F12 — нет', () => {
    expect(accelerator(key('KeyM', { ctrl: true, shift: true }))).toBe('Control+Shift+M');
    expect(accelerator(key('Digit1', { alt: true }))).toBe('Alt+1');
    expect(accelerator(key('Space', { ctrl: true }))).toBe('Control+Space');
    expect(accelerator(key('F5', { alt: true }))).toBe('Alt+F5');
    expect(accelerator(key('KeyM', { shift: true }))).toBeNull();
    expect(accelerator(key('KeyM', { ctrl: true, meta: true }))).toBeNull();
    expect(accelerator(key('F12', { ctrl: true }))).toBeNull();
  });
});

describe('planHotkeys — конфликты', () => {
  it('одно сочетание на два действия — второе отклонено', () => {
    const plan = planHotkeys([
      { action: 'mic.toggle', mode: 'toggle', key: key('KeyM', { ctrl: true }) },
      { action: 'deafen', mode: 'toggle', key: key('KeyM', { ctrl: true }) },
      { action: 'ptt', mode: 'hold', key: key('KeyP') },
    ]);
    expect(plan.registrations.map((r) => r.action)).toEqual(['mic.toggle']);
    expect(plan.notes).toEqual({ deafen: STATUS_DUPLICATE, ptt: STATUS_WINDOW_ONLY });
  });
});

describe('HotkeyRegistry', () => {
  it('регистрирует набор целиком, отпускает прежний, сообщает занятые', () => {
    const registered = new Map<string, () => void>();
    const taken = new Set(['Control+Shift+D']);
    const fired: string[] = [];
    const registry = new HotkeyRegistry(
      {
        register: (combo, callback) => {
          if (taken.has(combo)) return false;
          registered.set(combo, callback);
          return true;
        },
        unregister: (combo) => void registered.delete(combo),
      },
      (action) => fired.push(action),
    );
    const status = registry.apply([
      { action: 'mic.toggle', mode: 'toggle', key: key('KeyM', { ctrl: true, shift: true }) },
      { action: 'deafen', mode: 'toggle', key: key('KeyD', { ctrl: true, shift: true }) },
    ]);
    expect(status).toEqual({ 'mic.toggle': STATUS_GLOBAL, deafen: STATUS_TAKEN });
    expect([...registered.keys()]).toEqual(['Control+Shift+M']);
    registered.get('Control+Shift+M')!();
    expect(fired).toEqual(['mic.toggle']);

    // Запись нового сочетания: веб присылает пустой набор, прежнее отпущено.
    expect(registry.apply([])).toEqual({});
    expect(registered.size).toBe(0);

    const again = registry.apply([{ action: 'mic.toggle', mode: 'toggle', key: key('KeyM', { ctrl: true }) }]);
    expect(again['mic.toggle']).toBe(STATUS_GLOBAL);
    expect([...registered.keys()]).toEqual(['Control+M']);
  });
});
