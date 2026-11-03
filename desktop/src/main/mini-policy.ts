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

/**
 * Показ окна, страница которого ещё грузится (R188). Загрузилась — main повторяет ей состояние и ждёт
 * «нарисовано» (`mini.reveal` → размер и `mini.rendered`) не дольше `renderMs`: окно появляется сразу с
 * плитками и нужной высоты, а не пустой карточкой. Не загрузилась за `loadMs` (процесс страницы
 * завис после сна или сброса GPU) — окно сломано и пересоздаётся: `unresponsive` у спрятанного окна
 * не бывает, а сторож кадров смотрит только на видимое.
 */
export const MINI_SHOW = { loadMs: 5000, renderMs: 500 } as const;

/**
 * Заготовка мини-окна (R188): `prepare` — создать спрятанным, если его нет; `wait` — не создавать, но и
 * не убирать; `release` — окна нет вовсе. Окно нужно сейчас или Cord впереди (человек вернулся в
 * Cord — следующий показ скоро и должен быть без задержки) — заготовить. Окно ушло ради игры, окна во
 * весь экран или «—», а Cord не впереди — новое не создаётся: процесс страницы не стартует в момент
 * запуска игры; понадобится — создастся при показе. Вне встречи, без главного окна, с выключенным
 * переключателем и при выходе из Cord окна нет.
 */
export function spareMini(input: { inCall: boolean; enabled: boolean; main: boolean; quitting: boolean; wanted: boolean; cordInFront: boolean }): 'prepare' | 'wait' | 'release' {
  if (!input.inCall || !input.enabled || !input.main || input.quitting) return 'release';
  return input.wanted || input.cordInFront ? 'prepare' : 'wait';
}

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
 * GPU), круг пересозданий хуже, чем мини-окна нет несколько минут. Счёт у сломанного окна (сторож,
 * падение, «не отвечает») и у пересоздания из-за системы (`MINI_RENEW`) — раздельный (R188). Замена
 * спрятанного окна новым (после каждого показа и при пробуждении) — не пересоздание и лимита не тратит.
 */
export const MINI_REBUILDS = { count: 3, windowMs: 5 * 60_000 } as const;

/** Можно ли пересоздать сейчас; `history` — моменты прошлых пересозданий, `retryAt` — когда снова можно. */
export function decideRebuild(history: readonly number[], now: number): { allowed: boolean; history: number[]; retryAt: number } {
  const recent = history.filter((at) => now - at < MINI_REBUILDS.windowMs);
  if (recent.length >= MINI_REBUILDS.count) return { allowed: false, history: recent, retryAt: recent[0]! + MINI_REBUILDS.windowMs };
  return { allowed: true, history: [...recent, now], retryAt: now };
}

/**
 * Пересоздание из-за системы (R188): сон, разблокировка, сброс GPU, смена мониторов приходят пачкой
 * (`resume`, следом `unlock-screen` и подключение монитора) — пересоздаётся один раз через `delayMs`
 * тишины, а пока система спит или экран заблокирован — после разблокировки. Лимит у таких
 * пересозданий свой (`MINI_REBUILDS`): пробуждение не съедает пересоздания сторожа кадров.
 */
export const MINI_RENEW = { delayMs: 1500 } as const;

/**
 * Монитор сменился (`display-metrics-changed`): размер, масштаб и поворот меняют поверхность окна —
 * пересоздать (`renew`); одна рабочая область (панель задач выехала, переехала, стала шире) — окно не
 * пересоздаётся, а снова встаёт целиком в рабочую область (`place`, R188): иначе развёрнутое у нижнего
 * края оказалось бы под панелью задач.
 */
export function displayChange(changed: readonly string[]): 'renew' | 'place' | null {
  if (changed.some((metric) => metric === 'bounds' || metric === 'scaleFactor' || metric === 'rotation')) return 'renew';
  return changed.includes('workArea') ? 'place' : null;
}

/** Прямоугольник в DIP: рабочая область экрана или окно. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Отступ от краёв рабочей области на месте по умолчанию (снизу справа). */
export const MINI_MARGIN = 12;

/**
 * Где стоять мини-окну (R188): там, куда его поставил человек (`anchor`, левый верхний угол в DIP), но
 * целиком в рабочей области экрана, на котором оно больше всего стоит (нигде не стоит — на ближайшем):
 * развёрнутое у нижнего края поднимается, а не уходит под панель задач, свёрнутое обратно — опускается на
 * своё место. Места нет — снизу справа рабочей области основного экрана. Окно больше области — к её левому
 * верхнему углу: полоса, за которую тащат, и кнопки «—» / «⧉» остаются на экране.
 */
export function placeMini(anchor: { x?: number; y?: number }, size: { width: number; height: number }, areas: readonly Box[], primary: Box): { x: number; y: number } {
  const fit = (area: Box, x: number, y: number) => ({
    x: Math.round(Math.max(area.x, Math.min(x, area.x + area.width - size.width))),
    y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - size.height))),
  });
  if (anchor.x === undefined || anchor.y === undefined || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y) || !areas.length)
    return fit(primary, primary.x + primary.width - size.width - MINI_MARGIN, primary.y + primary.height - size.height - MINI_MARGIN);
  const rect = { x: anchor.x, y: anchor.y, width: size.width, height: size.height };
  return fit(nearestArea(rect, areas), anchor.x, anchor.y);
}

/** Область, с которой окно пересекается больше всего; ни с одной — ближайшая к его середине. */
export function nearestArea(rect: Box, areas: readonly Box[]): Box {
  let best = areas[0]!;
  let bestOverlap = -1;
  let bestDistance = Infinity;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  for (const area of areas) {
    const overlap = Math.max(0, Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x)) * Math.max(0, Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y));
    const dx = Math.max(area.x - cx, 0, cx - (area.x + area.width));
    const dy = Math.max(area.y - cy, 0, cy - (area.y + area.height));
    const distance = dx * dx + dy * dy;
    if (overlap > bestOverlap || (overlap === 0 && bestOverlap === 0 && distance < bestDistance)) {
      best = area;
      bestOverlap = overlap;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Перетаскивание (R188): за какую точку окна его взяли — `{x, y}` страницы (CSS-пиксели = DIP окна) в
 * пределах окна. Не число — `null`: тогда main берёт окно там, где сейчас курсор.
 */
export function readGrab(value: unknown, size: { width: number; height: number }): { x: number; y: number } | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (typeof data.x !== 'number' || typeof data.y !== 'number' || !Number.isFinite(data.x) || !Number.isFinite(data.y)) return null;
  return { x: Math.max(0, Math.min(size.width, data.x)), y: Math.max(0, Math.min(size.height, data.y)) };
}

/**
 * Где окно, пока его тащат (R188): точка, за которую взяли, — под настоящим курсором
 * (`screen.getCursorScreenPoint()`). Не сумма сдвигов `screenX` страницы: те приходят с опозданием, теряются
 * и на мониторах с разным масштабом считаются в разных единицах — окно отставало, прыгало и «застревало».
 */
export function dragPosition(cursor: { x: number; y: number }, grab: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.round(cursor.x - grab.x), y: Math.round(cursor.y - grab.y) };
}

/**
 * Что делать с нажатием мини-окна (R93, R137) — и «Микрофона» / «Звука встречи» трея (R138, R156):
 * - `main` — исполняет сама оболочка (развернуть, свернуть, открыть Cord);
 * - `page` — исполняет встреча, не поднимая Cord: микрофон, «звук встречи», камера, выход и
 *   «остановить показ»;
 * - `page-focus` — окно Cord выходит вперёд, встреча открывает своё: участники, чат, настройки,
 *   «начать показ» (окно выбора источника — в Cord);
 * - `unknown` — такого нажатия нет: мини-окну сразу `mini.ack ignored`.
 */
export type MiniRoute = 'main' | 'page' | 'page-focus' | 'unknown';

export function miniActionRoute(id: string, want: boolean | undefined, screen: boolean): MiniRoute {
  switch (id) {
    case 'open':
    case 'collapse':
    case 'expand':
    case 'compact':
      return 'main';
    case 'mic':
    case 'deafen':
    case 'camera':
    case 'leave':
      return 'page';
    case 'screen':
      return (want ?? !screen) ? 'page-focus' : 'page';
    case 'people':
    case 'chat':
    case 'settings':
      return 'page-focus';
    default:
      return 'unknown';
  }
}
