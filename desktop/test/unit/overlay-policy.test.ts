import { describe, expect, it } from 'vitest';
import { decideOverlay } from '../../src/main/overlay-policy';

const monitor = { x: 2560, y: 0, width: 1920, height: 1080 };

describe('decideOverlay — когда и где оверлей', () => {
  it('без звонка или выключенный — не виден', () => {
    expect(decideOverlay(false, true, null)).toEqual({ visible: false, anchor: null });
    expect(decideOverlay(true, false, { fullscreen: true, cord: false, monitor })).toEqual({ visible: false, anchor: null });
  });

  it('без сведений о переднем окне (нет cord-native) — не виден: иначе лёг бы поверх самого Cord (R61)', () => {
    expect(decideOverlay(true, true, null)).toEqual({ visible: false, anchor: null });
  });

  it('впереди игра во весь монитор — виден в углу её монитора; впереди Cord или окно поменьше — нет', () => {
    expect(decideOverlay(true, true, { fullscreen: true, cord: false, monitor })).toEqual({ visible: true, anchor: { x: 2560, y: 0 } });
    expect(decideOverlay(true, true, { fullscreen: true, cord: true, monitor })).toEqual({ visible: false, anchor: null });
    expect(decideOverlay(true, true, { fullscreen: false, cord: false, monitor })).toEqual({ visible: false, anchor: null });
  });
});
