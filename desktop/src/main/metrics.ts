/**
 * Цифры прототипа для CI (ADR 0001 §10, `metrics.json`): холодный старт — от создания процесса до
 * показа заставки, главного окна и главной веба (`state: home`), и память в покое — сумма по всем
 * процессам Cord через `app.getAppMetrics()`. Включается только переменной `CORD_METRICS_FILE`:
 * у человека ничего не меряется и никуда не пишется.
 *
 * Здесь нет Electron: отметки и сумма проверяются тестами, `index.ts` только зовёт их.
 */
export type Mark = 'splash' | 'main' | 'home';

export class StartupMetrics {
  private readonly at: Partial<Record<Mark, number>> = {};

  /** `origin` — `process.getCreationTime()`, мс эпохи. */
  constructor(private readonly origin: number) {}

  /** Запомнить первую отметку каждого вида; повторные не меняют её. */
  mark(name: Mark, now: number = Date.now()): void {
    if (this.at[name] === undefined) this.at[name] = Math.max(0, Math.round(now - this.origin));
  }

  get marks(): Partial<Record<Mark, number>> {
    return { ...this.at };
  }

  /** Все три отметки есть — можно мерить память в покое. */
  get done(): boolean {
    return this.at.splash !== undefined && this.at.main !== undefined && this.at.home !== undefined;
  }

  summary(memory: MemorySummary | null, platform: string, version: string) {
    return {
      version,
      platform,
      coldStartMs: { splash: this.at.splash ?? null, main: this.at.main ?? null, home: this.at.home ?? null },
      memoryIdle: memory,
    };
  }
}

/** Чья это отметка — по адресу страницы окна, которое стало готово к показу. */
export function markFor(url: string): Mark | null {
  if (url.startsWith('cord-app://shell/splash')) return 'splash';
  if (url.startsWith('cord-app://shell/loading') || url.startsWith('https://')) return 'main';
  return null;
}

export interface MemorySummary {
  processes: number;
  workingSetMB: number;
  /** Только Windows (`privateBytes`); на других — null. */
  privateMB: number | null;
}

/** Сумма `app.getAppMetrics()` в МБ (у Electron память — в КБ). */
export function sumMemory(processes: readonly { memory: { workingSetSize: number; privateBytes?: number } }[]): MemorySummary {
  const round = (kb: number) => Math.round((kb / 1024) * 10) / 10;
  const working = processes.reduce((sum, item) => sum + item.memory.workingSetSize, 0);
  const privates = processes.filter((item) => typeof item.memory.privateBytes === 'number');
  return {
    processes: processes.length,
    workingSetMB: round(working),
    privateMB: privates.length ? round(privates.reduce((sum, item) => sum + (item.memory.privateBytes ?? 0), 0)) : null,
  };
}
