/**
 * Когда и где показывать оверлей (T23, ADR 0001 §4.3, R62). Оверлей виден ⇔ идёт звонок, оверлей
 * включён, о переднем окне известно, впереди не Cord, а игра из реестра (`games.ts`) с включённым
 * переключателем — и не в эксклюзивном полноэкранном режиме: поверх него Windows окно не покажет,
 * вместо этого — одно уведомление «включите режим без рамки» (`game-notice.ts`).
 *
 * Без сведений о переднем окне (нет `cord-native`, модуль упал) оверлей не показывается вовсе: иначе
 * он лёг бы поверх самого Cord и рабочего стола (R61). Никаких инъекций: решение — по
 * `GetForegroundWindow` и снимку процессов из utility-процесса.
 *
 * Окно оверлея — во весь монитор игры (`monitor`, физические пиксели): виджет говорящих стоит в
 * выбранном углу и перетаскивается, а окно не мешает игре — клики проходят сквозь.
 */
import type { NativeForegroundEvent, NativeMonitor } from '../native/protocol';
import type { GameEntry } from './games';

export type Foreground = Pick<NativeForegroundEvent, 'cord' | 'monitor' | 'exclusive'>;

export interface OverlayDecision {
  visible: boolean;
  /** Физические пиксели монитора игры. */
  monitor: NativeMonitor | null;
}

const HIDDEN: OverlayDecision = { visible: false, monitor: null };

/** `game` — запись реестра для exe переднего окна (`findGame`), `null` — не игра. */
export function decideOverlay(inCall: boolean, enabled: boolean, foreground: Foreground | null, game: Pick<GameEntry, 'enabled'> | null): OverlayDecision {
  if (!inCall || !enabled || !foreground || foreground.cord) return HIDDEN;
  if (!game || !game.enabled || foreground.exclusive) return HIDDEN;
  return { visible: true, monitor: { ...foreground.monitor } };
}
