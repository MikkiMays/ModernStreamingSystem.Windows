import { describe, expect, it } from 'vitest';
import {
  accelerator,
  HotkeyRegistry,
  planHotkeys,
  signature,
  STATUS_DUPLICATE,
  STATUS_GLOBAL,
  STATUS_GLOBAL_RAW,
  STATUS_TAKEN,
  STATUS_WINDOW_ONLY,
  type RawInputApi,
} from '../../src/main/hotkeys';
import type { HotkeyBinding } from '../../src/main/bridge/messages';
import type { NativeBinding } from '../../src/native/protocol';

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
    expect(accelerator(key('Mouse4', { ctrl: true }))).toBeNull();
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

  it('Raw Input: любая клавиша и кнопки мыши, модификаторы — точно', () => {
    const plan = planHotkeys(
      [
        { action: 'ptt', mode: 'hold', key: key('Mouse4') },
        { action: 'mic.toggle', mode: 'toggle', key: key('KeyM', { ctrl: true }) },
        { action: 'deafen', mode: 'toggle', key: key('KeyM', { ctrl: true, shift: true }) },
        { action: 'overlay.toggle', mode: 'toggle', key: key('Mouse4') },
      ],
      true,
    );
    expect(plan.registrations.map((r) => r.accelerator)).toEqual(['Mouse4', 'ctrl+KeyM', 'ctrl+shift+KeyM']);
    expect(plan.notes).toEqual({ 'overlay.toggle': STATUS_DUPLICATE });
    expect(signature(key('F12', { meta: true }))).toBe('meta+F12');
  });
});

describe('HotkeyRegistry — запасной путь globalShortcut', () => {
  it('регистрирует набор целиком, отпускает прежний, сообщает занятые', async () => {
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
      (action, _mode, phase) => fired.push(`${action}:${phase}`),
    );
    const status = await registry.apply([
      { action: 'mic.toggle', mode: 'toggle', key: key('KeyM', { ctrl: true, shift: true }) },
      { action: 'deafen', mode: 'toggle', key: key('KeyD', { ctrl: true, shift: true }) },
    ]);
    expect(status).toEqual({ 'mic.toggle': STATUS_GLOBAL, deafen: STATUS_TAKEN });
    expect([...registered.keys()]).toEqual(['Control+Shift+M']);
    registered.get('Control+Shift+M')!();
    expect(fired).toEqual(['mic.toggle:down']);

    // Запись нового сочетания: веб присылает пустой набор, прежнее отпущено.
    expect(await registry.apply([])).toEqual({});
    expect(registered.size).toBe(0);

    const again = await registry.apply([{ action: 'mic.toggle', mode: 'toggle', key: key('KeyM', { ctrl: true }) }]);
    expect(again['mic.toggle']).toBe(STATUS_GLOBAL);
    expect([...registered.keys()]).toEqual(['Control+M']);
  });
});

describe('HotkeyRegistry — Raw Input из cord-native', () => {
  function fakeRaw(reject: string[] = []): RawInputApi & { sets: NativeBinding[][] } {
    const sets: NativeBinding[][] = [];
    return {
      sets,
      set: async (bindings) => {
        sets.push(bindings);
        return bindings.filter((binding) => reject.includes(binding.id)).map((binding) => binding.id);
      },
    };
  }

  it('push-to-talk с отпусканием и кнопкой мыши; globalShortcut не трогается', async () => {
    const registered = new Map<string, () => void>();
    const fired: string[] = [];
    const registry = new HotkeyRegistry(
      { register: (combo, callback) => (registered.set(combo, callback), true), unregister: (combo) => void registered.delete(combo) },
      (action, mode, phase) => fired.push(`${action}/${mode}:${phase}`),
    );
    const raw = fakeRaw();
    expect(await registry.setRaw(raw)).toBeNull();
    const status = await registry.apply([
      { action: 'ptt', mode: 'hold', key: key('Mouse4') },
      { action: 'mic.toggle', mode: 'toggle', key: key('KeyM', { shift: true }) },
    ]);
    expect(status).toEqual({ ptt: STATUS_GLOBAL_RAW, 'mic.toggle': STATUS_GLOBAL_RAW });
    expect(registered.size).toBe(0);
    expect(raw.sets).toEqual([[
      { id: 'ptt', code: 'Mouse4', ctrl: false, alt: false, shift: false, meta: false },
      { id: 'mic.toggle', code: 'KeyM', ctrl: false, alt: false, shift: true, meta: false },
    ]]);
    registry.onRawEvent('ptt', 'down');
    registry.onRawEvent('ptt', 'up');
    registry.onRawEvent('unknown', 'down');
    expect(fired).toEqual(['ptt/hold:down', 'ptt/hold:up']);
  });

  it('модуль отверг сочетание — «в окне встречи»; модуль упал — набор переезжает на globalShortcut и обратно', async () => {
    const registered = new Map<string, () => void>();
    const fired: string[] = [];
    const registry = new HotkeyRegistry(
      { register: (combo, callback) => (registered.set(combo, callback), true), unregister: (combo) => void registered.delete(combo) },
      (action, _mode, phase) => fired.push(`${action}:${phase}`),
    );
    await registry.setRaw(fakeRaw(['deafen']));
    const bindings: HotkeyBinding[] = [
      { action: 'deafen', mode: 'toggle', key: key('Mouse5') },
      { action: 'mic.toggle', mode: 'toggle', key: key('KeyM', { ctrl: true }) },
    ];
    expect(await registry.apply(bindings)).toEqual({ deafen: STATUS_WINDOW_ONLY, 'mic.toggle': STATUS_GLOBAL_RAW });

    // Хост упал: тот же набор — через globalShortcut; кнопка мыши там невозможна.
    const fallback = await registry.setRaw(null);
    expect(fallback).toEqual({ deafen: STATUS_WINDOW_ONLY, 'mic.toggle': STATUS_GLOBAL });
    expect([...registered.keys()]).toEqual(['Control+M']);
    registry.onRawEvent('mic.toggle', 'down');
    expect(fired).toEqual([]);

    // Хост вернулся: снова Raw Input, регистрации globalShortcut сняты.
    const back = await registry.setRaw(fakeRaw());
    expect(back).toEqual({ deafen: STATUS_GLOBAL_RAW, 'mic.toggle': STATUS_GLOBAL_RAW });
    expect(registered.size).toBe(0);
  });

  it('хост не ответил — этот набор ставится запасным путём', async () => {
    const registered = new Map<string, () => void>();
    const registry = new HotkeyRegistry(
      { register: (combo, callback) => (registered.set(combo, callback), true), unregister: (combo) => void registered.delete(combo) },
      () => {},
    );
    await registry.setRaw({ set: () => Promise.reject(new Error('нет ответа')) });
    const status = await registry.apply([{ action: 'mic.toggle', mode: 'toggle', key: key('KeyM', { alt: true }) }]);
    expect(status).toEqual({ 'mic.toggle': STATUS_GLOBAL });
    expect([...registered.keys()]).toEqual(['Alt+M']);
  });
});
