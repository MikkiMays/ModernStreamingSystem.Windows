/**
 * Когда и где показывать оверлей (T23, ADR 0001 §4.3). Оверлей виден только во встрече, если
 * включён, и только когда впереди не Cord, а окно, занимающее весь монитор (игра в borderless или
 * полноэкранном оконном режиме): в левом верхнем углу именно того монитора. Без сведений о
 * переднем окне (нет `cord-native`, модуль упал) оверлей не показывается вовсе: иначе он лёг бы
 * поверх самого Cord и рабочего стола (R61). Никаких инъекций: решение — по `GetForegroundWindow`
 * и `MonitorFromWindow` из utility-процесса.
 */
import type { NativeForegroundEvent } from '../native/protocol';

export type Foreground = Pick<NativeForegroundEvent, 'fullscreen' | 'cord' | 'monitor'>;

export interface OverlayDecision {
  visible: boolean;
  /** Физическая точка монитора, где рисовать (левый верхний угол). */
  anchor: { x: number; y: number } | null;
}

const HIDDEN: OverlayDecision = { visible: false, anchor: null };

export function decideOverlay(inCall: boolean, enabled: boolean, foreground: Foreground | null): OverlayDecision {
  if (!inCall || !enabled || !foreground) return HIDDEN;
  if (foreground.cord || !foreground.fullscreen) return HIDDEN;
  return { visible: true, anchor: { x: foreground.monitor.x, y: foreground.monitor.y } };
}
