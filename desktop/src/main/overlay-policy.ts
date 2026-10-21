/**
 * Когда и где показывать оверлей (T23, ADR 0001 §4.3). Без `cord-native` переднее окно неизвестно:
 * оверлей виден во встрече, если включён, на дисплее главного окна. С монитором переднего окна —
 * только когда впереди не Cord и окно занимает весь монитор (игра в borderless или полноэкранном
 * оконном режиме): в левом верхнем углу именно того монитора. Никаких инъекций: решение — по
 * `GetForegroundWindow` и `MonitorFromWindow` из utility-процесса.
 */
import type { NativeForegroundEvent } from '../native/protocol';

export type Foreground = Pick<NativeForegroundEvent, 'fullscreen' | 'cord' | 'monitor'>;

export interface OverlayDecision {
  visible: boolean;
  /** Физическая точка монитора, где рисовать (левый верхний угол); null — дисплей главного окна. */
  anchor: { x: number; y: number } | null;
}

export function decideOverlay(inCall: boolean, enabled: boolean, foreground: Foreground | null): OverlayDecision {
  if (!inCall || !enabled) return { visible: false, anchor: null };
  if (!foreground) return { visible: true, anchor: null };
  if (foreground.cord || !foreground.fullscreen) return { visible: false, anchor: null };
  return { visible: true, anchor: { x: foreground.monitor.x, y: foreground.monitor.y } };
}
