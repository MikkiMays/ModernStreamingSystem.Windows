/**
 * Когда показывать мини-окно звонка (R93, DESIGN.md → Мини-оверлей звонка; n06/n07 — Телемост).
 *
 * Мини-окно — вся встреча в окошке 220 px поверх остальных: кто говорит, микрофон, показ, выход.
 * Оно нужно ровно тогда, когда идёт звонок, а главного окна Cord не видно: оно спрятано в трей,
 * свёрнуто или его закрыло другое окно. Вернулся в Cord — мини-окно уходит. Не показывается:
 * - над игрой, где уже виден оверлей (два окна поверх игры — лишнее), и над любым окном во весь
 *   экран (видео, презентация, игра без оверлея) — там оно мешает больше, чем помогает;
 * - когда впереди своё окно Cord (список серверов, диалог), даже если главное не в фокусе;
 * - когда главное окно видно на другом мониторе, чем окно впереди: его и так видно;
 * - после «—» в самом мини-окне — до следующего возврата в Cord.
 *
 * Без `cord-native` (о переднем окне ничего не известно) — по одному главному окну: не в фокусе —
 * считаем его закрытым. Задержка появления (400 мс, чтобы окно не мигало при Alt+Tab) — у `index.ts`.
 * Здесь нет Electron: правило проверяется `mini-policy.test.ts`.
 */
export interface MiniInput {
  inCall: boolean;
  /** Переключатель «Мини-окно звонка» в «Windows». */
  enabled: boolean;
  /** Человек свернул мини-окно «—»; сбрасывается, когда главное окно снова впереди. */
  dismissed: boolean;
  main: { exists: boolean; visible: boolean; focused: boolean } | null;
  foreground: { cord: boolean; fullscreen: boolean } | null;
  overlayVisible: boolean;
  /** Главное окно и окно впереди — на одном мониторе; `null` — неизвестно. */
  sameDisplay: boolean | null;
}

/** Задержка появления после того, как главное окно ушло с глаз. */
export const MINI_DELAY_MS = 400;

export function decideMini(input: MiniInput): boolean {
  const { main, foreground } = input;
  if (!input.inCall || !input.enabled || input.dismissed || !main?.exists) return false;
  if (input.overlayVisible || main.focused) return false;
  if (foreground?.cord || foreground?.fullscreen) return false;
  if (!main.visible) return true;
  return input.sameDisplay !== false;
}

/**
 * Сторож мини-окна (R137). Пока окно видно, main раз в `intervalMs` спрашивает у его страницы кадр
 * (`mini.ping` → ответ из `requestAnimationFrame`). Нет ответа за `timeoutMs` — пропуск; `misses`
 * пропусков подряд — окно пересоздаётся. Так ловится то, чего не видит `unresponsive`: страница жива,
 * а окно не рисует (сон, сброс GPU, RDP, смена DPI — Electron #37361, #40578) — висит «замёрзшим»
 * прямоугольником поверх всех, и помогало только закрыть его.
 *
 * Пока человек не трогает мышь и клавиатуру `idleSeconds` (экран мог погаснуть — кадров тогда нет у
 * всех окон) или экран заблокирован, пропуски не считаются: проверка продолжится, когда он вернётся.
 */
export const MINI_WATCH = { intervalMs: 2000, timeoutMs: 1500, misses: 2, idleSeconds: 60 } as const;

/** Очередной ответ сторожу: ответило ли окно, смотрит ли человек; пересоздавать ли. */
export function watchStep(misses: number, answered: boolean, active = true): { misses: number; rebuild: boolean } {
  if (answered || !active) return { misses: 0, rebuild: false };
  const next = misses + 1;
  return next >= MINI_WATCH.misses ? { misses: 0, rebuild: true } : { misses: next, rebuild: false };
}

/**
 * Пересоздание — не чаще `count` раз за `windowMs` (R137): если окно ломается снова и снова (драйвер,
 * GPU), круг пересозданий хуже, чем мини-окна нет несколько минут.
 */
export const MINI_REBUILDS = { count: 3, windowMs: 5 * 60_000 } as const;

/** Можно ли пересоздать сейчас; `history` — моменты прошлых пересозданий, `retryAt` — когда снова можно. */
export function decideRebuild(history: readonly number[], now: number): { allowed: boolean; history: number[]; retryAt: number } {
  const recent = history.filter((at) => now - at < MINI_REBUILDS.windowMs);
  if (recent.length >= MINI_REBUILDS.count) return { allowed: false, history: recent, retryAt: recent[0]! + MINI_REBUILDS.windowMs };
  return { allowed: true, history: [...recent, now], retryAt: now };
}

/**
 * Монитор сменился (`display-metrics-changed`): размер, масштаб и поворот меняют поверхность окна —
 * пересоздать; одна рабочая область (выехала панель задач) — нет, окно просто остаётся на экране.
 */
export function displayNeedsRebuild(changed: readonly string[]): boolean {
  return changed.some((metric) => metric === 'bounds' || metric === 'scaleFactor' || metric === 'rotation');
}
