import { describe, expect, it } from 'vitest';
import { decideMini, type MiniInput } from '../../src/main/mini-policy';

const away: MiniInput = {
  inCall: true,
  enabled: true,
  dismissed: false,
  main: { exists: true, visible: true, focused: false },
  foreground: { cord: false, fullscreen: false },
  overlayVisible: false,
  sameDisplay: true,
};

describe('decideMini — когда видно мини-окно звонка (R93)', () => {
  it('во встрече, Cord закрыт другим окном на том же мониторе — видно', () => {
    expect(decideMini(away)).toBe(true);
  });

  it('Cord спрятан в трей или свёрнут — видно, на каком бы мониторе ни было окно впереди', () => {
    expect(decideMini({ ...away, main: { exists: true, visible: false, focused: false }, sameDisplay: false })).toBe(true);
  });

  it('Cord впереди — не видно; впереди своё окно Cord — тоже', () => {
    expect(decideMini({ ...away, main: { exists: true, visible: true, focused: true } })).toBe(false);
    expect(decideMini({ ...away, foreground: { cord: true, fullscreen: false } })).toBe(false);
  });

  it('вне встречи, выключено, свёрнуто «—», нет главного окна — не видно', () => {
    expect(decideMini({ ...away, inCall: false })).toBe(false);
    expect(decideMini({ ...away, enabled: false })).toBe(false);
    expect(decideMini({ ...away, dismissed: true })).toBe(false);
    expect(decideMini({ ...away, main: null })).toBe(false);
  });

  it('над игрой с оверлеем и над окном во весь экран — не видно', () => {
    expect(decideMini({ ...away, overlayVisible: true })).toBe(false);
    expect(decideMini({ ...away, foreground: { cord: false, fullscreen: true } })).toBe(false);
  });

  it('главное окно видно на другом мониторе — не нужно', () => {
    expect(decideMini({ ...away, sameDisplay: false })).toBe(false);
  });

  it('без cord-native (о переднем окне неизвестно) — по главному окну: не в фокусе — видно', () => {
    expect(decideMini({ ...away, foreground: null, sameDisplay: null })).toBe(true);
    expect(decideMini({ ...away, foreground: null, sameDisplay: null, main: { exists: true, visible: true, focused: true } })).toBe(false);
  });
});
