import { describe, expect, it } from 'vitest';
import { decideMini, decideRebuild, displayNeedsRebuild, MINI_REBUILDS, MINI_WATCH, watchStep, type MiniInput } from '../../src/main/mini-policy';

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

describe('сторож мини-окна (R137): окно, переставшее рисовать кадры, пересоздаётся', () => {
  it('кадр раз в 2 с, ответ ждём 1,5 с, два пропуска подряд — пересоздать', () => {
    expect(MINI_WATCH).toMatchObject({ intervalMs: 2000, timeoutMs: 1500, misses: 2 });
    const first = watchStep(0, false);
    expect(first).toEqual({ misses: 1, rebuild: false });
    expect(watchStep(first.misses, false), 'второй пропуск подряд').toEqual({ misses: 0, rebuild: true });
  });

  it('ответ между пропусками обнуляет счёт: два пропуска не подряд — не повод', () => {
    const missed = watchStep(0, false);
    const answered = watchStep(missed.misses, true);
    expect(answered).toEqual({ misses: 0, rebuild: false });
    expect(watchStep(answered.misses, false)).toEqual({ misses: 1, rebuild: false });
  });

  it('человек не трогает мышь и клавиатуру (экран мог погаснуть) — пропуски не считаются', () => {
    expect(watchStep(1, false, false)).toEqual({ misses: 0, rebuild: false });
  });
});

describe('лимит пересозданий (R137): не больше 3 за 5 минут', () => {
  const minute = 60_000;
  it('три подряд — можно, четвёртое в те же 5 минут — нет, и известно, когда снова можно', () => {
    expect(MINI_REBUILDS).toEqual({ count: 3, windowMs: 5 * minute });
    let history: number[] = [];
    for (const at of [0, minute, 2 * minute]) {
      const decision = decideRebuild(history, at);
      expect(decision.allowed).toBe(true);
      history = decision.history;
    }
    const fourth = decideRebuild(history, 3 * minute);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAt).toBe(5 * minute);
    expect(fourth.history, 'отказ ничего не записывает').toEqual([0, minute, 2 * minute]);
  });

  it('старше 5 минут — забыто', () => {
    const decision = decideRebuild([0, minute, 2 * minute], 5 * minute + 1);
    expect(decision.allowed).toBe(true);
    expect(decision.history).toEqual([minute, 2 * minute, 5 * minute + 1]);
  });
});

describe('смена мониторов (R137): что пересоздаёт окно', () => {
  it('размер, масштаб и поворот — пересоздать; только рабочая область (панель задач) — нет', () => {
    expect(displayNeedsRebuild(['scaleFactor'])).toBe(true);
    expect(displayNeedsRebuild(['bounds', 'workArea'])).toBe(true);
    expect(displayNeedsRebuild(['rotation'])).toBe(true);
    expect(displayNeedsRebuild(['workArea'])).toBe(false);
    expect(displayNeedsRebuild([])).toBe(false);
  });
});
