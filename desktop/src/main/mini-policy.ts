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
