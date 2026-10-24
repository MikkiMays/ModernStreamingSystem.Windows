import { describe, expect, it } from 'vitest';
import { decideOverlay } from '../../src/main/overlay-policy';

const monitor = { x: 2560, y: 0, width: 1920, height: 1080 };
const game = { enabled: true };
const front = { cord: false, monitor, exclusive: false };
const hidden = { visible: false, monitor: null };

describe('decideOverlay — когда и где оверлей (R62)', () => {
  it('без звонка или выключенный — не виден', () => {
    expect(decideOverlay(false, true, front, game)).toEqual(hidden);
    expect(decideOverlay(true, false, front, game)).toEqual(hidden);
  });

  it('без сведений о переднем окне (нет cord-native) — не виден: иначе лёг бы поверх самого Cord (R61)', () => {
    expect(decideOverlay(true, true, null, game)).toEqual(hidden);
  });

  it('впереди игра из реестра с включённым переключателем — виден во весь её монитор', () => {
    expect(decideOverlay(true, true, front, game)).toEqual({ visible: true, monitor });
  });

  it('впереди Cord, не игра или игра с выключенным переключателем — не виден', () => {
    expect(decideOverlay(true, true, { ...front, cord: true }, game)).toEqual(hidden);
    expect(decideOverlay(true, true, front, null)).toEqual(hidden);
    expect(decideOverlay(true, true, front, { enabled: false })).toEqual(hidden);
  });

  it('эксклюзивный полноэкранный режим — не виден (Windows не покажет окно поверх)', () => {
    expect(decideOverlay(true, true, { ...front, exclusive: true }, game)).toEqual(hidden);
  });

  it('модуль до R62 без поля exclusive — как не эксклюзивный', () => {
    expect(decideOverlay(true, true, { cord: false, monitor }, game)).toEqual({ visible: true, monitor });
  });

  it('полная матрица: виден ровно при звонке ∧ включён ∧ окно ∧ не Cord ∧ игра включена ∧ не эксклюзивный', () => {
    for (const inCall of [false, true])
      for (const enabled of [false, true])
        for (const known of [false, true])
          for (const cord of [false, true])
            for (const on of [false, true])
              for (const exclusive of [false, true]) {
                const decision = decideOverlay(inCall, enabled, known ? { cord, monitor, exclusive } : null, { enabled: on });
                expect(decision.visible).toBe(inCall && enabled && known && !cord && on && !exclusive);
              }
  });
});
