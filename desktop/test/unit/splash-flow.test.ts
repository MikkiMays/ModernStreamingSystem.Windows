import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canInterrupt,
  checkWithBudget,
  downloadWithStall,
  installFailure,
  nextCheckMs,
  PERIOD_MS,
  RETRY_SOON_MS,
  runSplash,
  splashText,
  type SplashState,
  type UpdateSteps,
} from '../../src/main/update/splash-flow';

function steps(overrides: Partial<UpdateSteps> = {}): UpdateSteps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    takeInstallFailure: () => null,
    check: async () => ({ verdict: 'none' }),
    download: async () => ({ ok: true }),
    apply: async () => {
      calls.push('apply');
    },
    discardPackage: () => {
      calls.push('discard');
    },
    ...overrides,
  };
}

describe('runSplash — порядок шагов заставки', () => {
  it('новее нет — открыть Cord', async () => {
    const shown: SplashState[] = [];
    const result = await runSplash(steps(), (state) => shown.push(state), new AbortController().signal);
    expect(result).toEqual({ outcome: 'open', verdict: 'none', problem: '' });
    expect(shown.map((state) => state.stage)).toEqual(['checking']);
  });
  it('зеркало недоступно — открыть Cord и спросить через 10 минут', async () => {
    const result = await runSplash(steps({ check: async () => ({ verdict: 'unavailable' }) }), () => {}, new AbortController().signal);
    expect(result.outcome).toBe('open');
    expect(nextCheckMs(result.verdict)).toBe(RETRY_SOON_MS);
    expect(nextCheckMs('none')).toBe(PERIOD_MS);
  });
  it('есть новее — загрузка с процентами, установка, перезапуск', async () => {
    const shown: SplashState[] = [];
    const fake = steps({
      check: async () => ({ verdict: 'forced', version: '1.0.1' }),
      download: async (progress) => {
        progress(0.42);
        progress(1);
        return { ok: true };
      },
    });
    const result = await runSplash(fake, (state) => shown.push(state), new AbortController().signal);
    expect(result.outcome).toBe('restarting');
    expect(shown.map(splashText)).toEqual(['Проверяем обновления…', 'Загружаем обновление… 0%', 'Загружаем обновление… 42%', 'Загружаем обновление… 100%', 'Устанавливаем…']);
    expect(fake.calls).toEqual(['apply']);
  });
  it('загрузка не удалась — причина, без установки', async () => {
    const fake = steps({ check: async () => ({ verdict: 'forced' }), download: async () => ({ ok: false, problem: 'Пакет повреждён.' }) });
    const result = await runSplash(fake, () => {}, new AbortController().signal);
    expect(result).toEqual({ outcome: 'failed', verdict: 'forced', problem: 'Пакет повреждён.' });
    expect(fake.calls).toEqual([]);
  });
  it('установка не запустилась — пакет забыт, причина на заставке', async () => {
    const fake = steps({
      check: async () => ({ verdict: 'forced' }),
      apply: async () => {
        throw new Error('spawn failed');
      },
    });
    const result = await runSplash(fake, () => {}, new AbortController().signal);
    expect(result.outcome).toBe('failed');
    expect(result.problem).toBe('Не удалось запустить установку.');
    expect(fake.calls).toEqual(['discard']);
  });
  it('прошлая установка не встала — заставка показывает причину и сама не повторяет', async () => {
    const fake = steps({ takeInstallFailure: () => 'Обновление не установилось: на диске осталась прежняя версия.', check: async () => ({ verdict: 'forced' }) });
    const result = await runSplash(fake, () => {}, new AbortController().signal);
    expect(result.outcome).toBe('failed');
    expect(fake.calls).toEqual([]);
  });
  it('текст заставки без номера версии', () => {
    expect(splashText({ stage: 'downloading', progress: 0.999, problem: '' })).toBe('Загружаем обновление… 99%');
    expect(splashText({ stage: 'failed', progress: 0, problem: 'Причина' })).toBe('Причина');
  });
});

describe('сроки', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('checkWithBudget — молчание 5 с считается «недоступно», а не держит Cord закрытым', async () => {
    const pending = checkWithBudget(() => new Promise(() => {}), 5000, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(5001);
    expect(await pending).toEqual({ verdict: 'unavailable' });
  });
  it('checkWithBudget — ошибка зеркала тоже «недоступно»', async () => {
    expect(await checkWithBudget(async () => { throw new Error('503'); }, 5000, new AbortController().signal)).toEqual({ verdict: 'unavailable' });
  });
  it('downloadWithStall — тишина дольше минуты останавливает загрузку, а живая медленная — нет', async () => {
    const slow = downloadWithStall(
      async (progress, signal) => {
        for (let step = 1; step <= 3; step++) {
          await new Promise((resolve) => setTimeout(resolve, 50_000));
          if (signal.aborted) throw new Error('aborted');
          progress(step / 3);
        }
        return 'ok';
      },
      undefined,
      60_000,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(160_000);
    expect(await slow).toEqual({ ok: true, value: 'ok' });

    const stalled = downloadWithStall(
      (_, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
      undefined,
      60_000,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await stalled).toEqual({ ok: false, problem: 'Загрузка остановилась: сервер обновлений не отвечает.' });
  });
  it('downloadWithStall — причины по-русски проходят как есть, прочее — одной строкой', async () => {
    expect(await downloadWithStall(async () => { throw new Error('Размер пакета изменился.'); }, undefined, 1000, new AbortController().signal)).toEqual({ ok: false, problem: 'Размер пакета изменился.' });
    expect(await downloadWithStall(async () => { throw new Error('ECONNRESET'); }, undefined, 1000, new AbortController().signal)).toEqual({ ok: false, problem: 'Не удалось скачать обновление. Проверьте соединение.' });
  });
});

describe('правила', () => {
  it('во встрече и на экране перед входом заставку не показываем', () => {
    expect(canInterrupt(false, 'home')).toBe(true);
    expect(canInterrupt(true, 'room')).toBe(false);
    expect(canInterrupt(false, 'prejoin')).toBe(false);
    expect(canInterrupt(false, null)).toBe(true);
  });
  it('отказ установщика виден по версии на диске', () => {
    expect(installFailure('1.0.1', '1.0.0')).toMatch(/прежняя версия/);
    expect(installFailure('1.0.1', '1.0.1')).toBeNull();
    expect(installFailure('1.0.1', '1.0.2')).toBeNull();
    expect(installFailure(null, '1.0.0')).toBeNull();
  });
});
