import { describe, expect, it } from 'vitest';
import { markFor, StartupMetrics, sumMemory } from '../../src/main/metrics';

describe('метрики запуска для CI (ADR §10, metrics.json)', () => {
  it('отметки — от создания процесса, только первая каждого вида', () => {
    const metrics = new StartupMetrics(1_000);
    metrics.mark('splash', 1_420);
    metrics.mark('main', 2_100);
    metrics.mark('splash', 9_999);
    metrics.mark('home', 3_250);
    expect(metrics.marks).toEqual({ splash: 420, main: 1100, home: 2250 });
    expect(metrics.done).toBe(true);
  });

  it('какое окно показалось — по адресу его страницы', () => {
    expect(markFor('cord-app://shell/splash.html')).toBe('splash');
    expect(markFor('cord-app://shell/loading.html')).toBe('main');
    expect(markFor('https://cord.nikg.tech/')).toBe('main');
    expect(markFor('cord-app://shell/servers.html')).toBeNull();
    expect(markFor('cord-app://overlay/overlay.html')).toBeNull();
  });

  it('память — сумма по процессам в МБ: privateBytes в Windows, иначе рабочий набор', () => {
    const processes = [
      { type: 'Browser', memory: { workingSetSize: 100_000, privateBytes: 60_000 } },
      { type: 'GPU', memory: { workingSetSize: 50_000, privateBytes: 30_000 } },
      { type: 'Tab', memory: { workingSetSize: 154_800 } },
    ];
    expect(sumMemory(processes)).toEqual({ processes: 3, workingSetMB: 297.7, privateMB: 87.9 });
  });

  it('итог — JSON с отметками, памятью и платформой', () => {
    const metrics = new StartupMetrics(0);
    metrics.mark('splash', 300);
    const summary = metrics.summary({ processes: 4, workingSetMB: 210, privateMB: 150 }, 'win32', '1.0.0');
    expect(summary).toEqual({
      version: '1.0.0',
      platform: 'win32',
      coldStartMs: { splash: 300, main: null, home: null },
      memoryIdle: { processes: 4, workingSetMB: 210, privateMB: 150 },
    });
  });
});
