/**
 * Что сказать, когда во встрече впереди оказалась игра (R104, R63; n11 — всплывашка Discord «Go Live»).
 *
 * Раз на игру за сеанс Cord и только во встрече (`golive`) — одна всплывашка в двух местах:
 * - уведомление Windows «Cord работает поверх <игра>: оверлей — Shift+`» с кнопкой «Показать игру» —
 *   нажимается сразу, без разблокировки оверлея, и остаётся в центре уведомлений;
 * - карточка в самом оверлее, в углу виджета (DESIGN.md → Оверлей): «Cord поверх игры · Нажмите
 *   Shift+`, чтобы открыть · [Показать игру]» — её видно, даже когда Windows прячет уведомления во
 *   время игры (режим «Не беспокоить» в играх включён по умолчанию); кнопка нажимается, когда
 *   оверлей разблокирован той же клавишей, как у Discord. Нажали одно — второе закрывается.
 * Эксклюзивный полноэкранный режим (`exclusive`) — оверлея не будет вовсе: одно уведомление «<игра>
 * в полноэкранном режиме — оверлей не виден. Включите в игре режим «без рамки»». Кнопки показа нет:
 * захват окна в эксклюзивном режиме отдаёт чёрный кадр.
 *
 * Игры с выключенным переключателем и выключенный оверлей молчат: «Cord поверх игры» было бы неправдой.
 * Всплывашку выключает переключатель «Всплывашка при старте игры» (`settings.overlay.toast`), а
 * предупреждение об эксклюзивном режиме — нет: без него оверлей «просто не работает». Здесь нет
 * Electron: правило проверяется `notify-policy.test.ts`.
 */
import type { ActiveGame } from './games';

export type GameNotice = 'golive' | 'exclusive' | null;

export interface GameNoticeInput {
  inCall: boolean;
  overlayEnabled: boolean;
  /** «Всплывашка при старте игры». */
  toastEnabled: boolean;
  /** Игра сейчас — и она впереди (а не «была впереди до Cord»). */
  game: ActiveGame | null;
  front: boolean;
  /** Каким играм уже говорили «Показать игру» и каким — про эксклюзивный режим в этом сеансе. */
  announced: ReadonlySet<string>;
  warned: ReadonlySet<string>;
}

export function decideGameNotice(input: GameNoticeInput): GameNotice {
  const { game } = input;
  if (!game || !input.front || !input.inCall || !input.overlayEnabled || !game.enabled) return null;
  if (game.exclusive) return input.warned.has(game.exe) ? null : 'exclusive';
  if (!input.toastEnabled || input.announced.has(game.exe)) return null;
  return 'golive';
}

/** Сколько держится карточка в оверлее, пока оверлей заблокирован (DESIGN.md → Оверлей). */
export const CARD_MS = 8000;

/**
 * Подпись сочетания для всплывашки: «Shift+`». Сочетания нет (веб до R63 его не присылает) — `null`,
 * и всплывашка говорит без клавиши.
 */
export function hotkeyLabel(key: { code: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean } | null | undefined): string | null {
  if (!key) return null;
  const name = key.code === 'Backquote' ? '`' : key.code === 'Space' ? 'Space' : key.code.replace(/^(Key|Digit)/, '');
  return [key.ctrl && 'Ctrl', key.alt && 'Alt', key.shift && 'Shift', key.meta && 'Win', name].filter(Boolean).join('+');
}
