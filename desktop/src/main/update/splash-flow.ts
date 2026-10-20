/**
 * Заставка обновления при запуске (T58, решение В-1), как у Discord и как `ForcedUpdate` в WinUI:
 * сначала маленькое окно — проверка, загрузка, установка, — и только потом Cord. Кнопки «позже»
 * нет: новая версия ставится каждому при открытии.
 *
 * Обязательное не значит хрупкое. Зеркало, которое молчит (5 с), отвечает ошибкой, 404 или
 * неподписанным описанием, не мешает открыть приложение: Cord откроется и переспросит через
 * 10 минут. Загрузка, которая сломалась или встала (минута тишины), и установка, которая не
 * запустилась, останавливаются на заставке с причиной, «Повторить» и «Открыть Cord». Отказ
 * установщика (после перезапуска версия старее ожидаемой) заставка показывает и сама не
 * повторяет — иначе вечный круг.
 *
 * Здесь — только то, что проверяется без окна и без Electron: вердикт, сроки, сторож,
 * порядок шагов. Шаги даёт `updater.ts`, окно — `windows/splash.ts`.
 */

export type UpdateVerdict = 'none' | 'forced' | 'unavailable';
export interface UpdateCheck {
  verdict: UpdateVerdict;
  version?: string;
}

export type SplashStage = 'checking' | 'downloading' | 'installing' | 'failed';
export interface SplashState {
  stage: SplashStage;
  /** Доля скачанного, от 0 до 1. */
  progress: number;
  problem: string;
}

export type SplashOutcome = 'open' | 'restarting' | 'failed';
export interface SplashResult {
  outcome: SplashOutcome;
  verdict: UpdateVerdict;
  problem: string;
}

export interface UpdateSteps {
  /** Почему не встала прошлая установка — один раз; null, если встала или её не было. */
  takeInstallFailure(): string | null;
  check(budgetMs: number, signal: AbortSignal): Promise<UpdateCheck>;
  download(progress: (value: number) => void, signal: AbortSignal): Promise<{ ok: true } | { ok: false; problem: string }>;
  /** Запустить установку. После этого Cord обязан закрыться. */
  apply(): Promise<void>;
  /** Забыть скачанный пакет, чтобы «Повторить» скачал его заново. */
  discardPackage(): void;
}

/** Сколько ждать зеркало на заставке. Медленная сеть не должна держать Cord закрытым. */
export const STARTUP_BUDGET_MS = 5_000;
/** Сколько ждать зеркало, пока Cord открыт: тут никто не стоит перед заставкой. */
export const BACKGROUND_BUDGET_MS = 15_000;
/** Как часто спрашивать, пока Cord открыт. */
export const PERIOD_MS = 6 * 60 * 60 * 1000;
/** Когда переспросить зеркало, которое не ответило. */
export const RETRY_SOON_MS = 10 * 60 * 1000;
/** Сколько загрузка может молчать, прежде чем её признают вставшей. */
export const STALL_LIMIT_MS = 60_000;

/** Целые проценты, с округлением вниз: 100 — только когда пришёл последний байт. */
export function percent(progress: number): number {
  return Math.min(100, Math.max(0, Math.floor(progress * 100)));
}

/** Одна строка заставки. Номера версии здесь нет: его показывает только «О программе». */
export function splashText(state: SplashState): string {
  switch (state.stage) {
    case 'checking':
      return 'Проверяем обновления…';
    case 'downloading':
      return `Загружаем обновление… ${percent(state.progress)}%`;
    case 'installing':
      return 'Устанавливаем…';
    default:
      return state.problem;
  }
}

export function nextCheckMs(verdict: UpdateVerdict): number {
  return verdict === 'unavailable' ? RETRY_SOON_MS : PERIOD_MS;
}

/**
 * Можно ли прямо сейчас закрыть главное окно ради заставки обновления. Разговор — нет, и экран
 * перед входом во встречу — тоже: человек туда уже идёт. Пока страница ничего не сказала,
 * встречи нет.
 */
export function canInterrupt(inCall: boolean, page: string | null | undefined): boolean {
  return !inCall && page !== 'prejoin';
}

/**
 * Загрузка со сторожем. Сторож следит за тишиной, а не за длительностью: каждая порция байтов
 * продлевает срок, поэтому медленная, но живая загрузка доходит до конца, а вставшая
 * заканчивается причиной, а не вечной заставкой.
 */
export async function downloadWithStall<T>(
  download: (progress: (value: number) => void, signal: AbortSignal) => Promise<T>,
  progress: ((value: number) => void) | undefined,
  stallMs: number,
  outer: AbortSignal,
): Promise<{ ok: true; value: T } | { ok: false; problem: string }> {
  const watchdog = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stalled = false;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      watchdog.abort();
    }, stallMs);
  };
  const forward = () => watchdog.abort();
  outer.addEventListener('abort', forward, { once: true });
  arm();
  try {
    const value = await download((fraction) => {
      arm();
      progress?.(fraction);
    }, watchdog.signal);
    return { ok: true, value };
  } catch (error) {
    if (outer.aborted) throw error;
    if (stalled) return { ok: false, problem: 'Загрузка остановилась: сервер обновлений не отвечает.' };
    const message = error instanceof Error ? error.message : '';
    // Причины, написанные для человека (подмена адреса, другой размер, не тот SHA), приходят
    // по-русски; всё остальное — одно короткое объяснение.
    return { ok: false, problem: /[А-Яа-яЁё]/.test(message) ? message : 'Не удалось скачать обновление. Проверьте соединение.' };
  } finally {
    if (timer) clearTimeout(timer);
    outer.removeEventListener('abort', forward);
  }
}

/** Вопрос к зеркалу за отведённое время. Всё, что может случиться с зеркалом, — `unavailable`. */
export async function checkWithBudget(
  check: (signal: AbortSignal) => Promise<UpdateCheck>,
  budgetMs: number,
  outer: AbortSignal,
): Promise<UpdateCheck> {
  const controller = new AbortController();
  const forward = () => controller.abort();
  outer.addEventListener('abort', forward, { once: true });
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    return await Promise.race([
      check(controller.signal),
      new Promise<UpdateCheck>((resolve) => controller.signal.addEventListener('abort', () => resolve({ verdict: 'unavailable' }), { once: true })),
    ]);
  } catch (error) {
    if (outer.aborted) throw error;
    return { verdict: 'unavailable' };
  } finally {
    clearTimeout(timer);
    outer.removeEventListener('abort', forward);
  }
}

/**
 * Шаги заставки по порядку: итог прошлой установки, вопрос к зеркалу, загрузка, установка.
 * Возвращает, открыть ли Cord, закрыть ли его ради установки или показать сбой. Отмена
 * (заставку закрыли) остаётся отменой — исключением.
 */
export async function runSplash(steps: UpdateSteps, show: (state: SplashState) => void, signal: AbortSignal): Promise<SplashResult> {
  const failure = steps.takeInstallFailure();
  if (failure) return { outcome: 'failed', verdict: 'forced', problem: failure };
  show({ stage: 'checking', progress: 0, problem: '' });
  const check = await steps.check(STARTUP_BUDGET_MS, signal);
  if (check.verdict !== 'forced') return { outcome: 'open', verdict: check.verdict, problem: '' };
  show({ stage: 'downloading', progress: 0, problem: '' });
  const download = await steps.download((value) => show({ stage: 'downloading', progress: value, problem: '' }), signal);
  if (!download.ok) return { outcome: 'failed', verdict: 'forced', problem: download.problem };
  show({ stage: 'installing', progress: 1, problem: '' });
  try {
    await steps.apply();
    return { outcome: 'restarting', verdict: 'forced', problem: '' };
  } catch (error) {
    if (signal.aborted) throw error;
    // Пакет мог испортиться на диске (его держал или забрал антивирус): «Повторить» скачает
    // его заново, а не споткнётся о тот же файл.
    steps.discardPackage();
    return { outcome: 'failed', verdict: 'forced', problem: 'Не удалось запустить установку.' };
  }
}

/**
 * Итог прошлой установки по версии на диске: перед `quitAndInstall` записывается ожидаемая
 * версия; если после перезапуска стоит старее — установщик отказал.
 */
export function installFailure(expected: string | null, current: string): string | null {
  if (!expected) return null;
  const parts = (value: string) => value.split('.').map(Number);
  const [a, b] = [parts(expected), parts(current)];
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference > 0) return 'Обновление не установилось: на диске осталась прежняя версия.';
    if (difference < 0) return null;
  }
  return null;
}
