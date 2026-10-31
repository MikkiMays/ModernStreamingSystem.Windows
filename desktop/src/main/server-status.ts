/**
 * Окно «Серверы» (T05, R143): пинг и загрузка каждого сервера каталога — `servers.status` → `{ping,
 * load, bars}`. Пинг — медиана трёх `HEAD /api/v1/ping`, загрузка — `GET /api/v1/load` ядра (Р-37:
 * только ступень 1–4 и состояние, без чисел). Запросы — из main (`net.fetch`): CSP страницы на них не
 * распространяется, а страница окна оболочки в сеть не ходит вовсе. Окно спрашивает раз в 10 с, пока
 * открыто. Сервер вне каталога — `null`: оболочка не опрашивает чужие адреса.
 *
 * Палочки — как `LoadBars` веба (`web/src/ui/kit/LoadBars.tsx`): четыре одной высоты, залито по
 * ступени; 1–2 — success, 3 — warning, 4 — danger; нет данных и «обновляется» — пустые. Для диктора —
 * словами (`loadLabel`), на языке Cord (`shell-text.ts`).
 *
 * Модуль без Electron: сеть приходит снаружи (`Fetcher`), проверяется `servers-status.test.ts`.
 */
import type { ServerOrigin } from './origins';
import type { ShellText } from './shell-text';

export type LoadState = 'ok' | 'busy' | 'full' | 'maintenance' | 'closed';
export const LOAD_STATES: readonly LoadState[] = ['ok', 'busy', 'full', 'maintenance', 'closed'];

export interface ServerLoad {
  level: 1 | 2 | 3 | 4;
  state: LoadState;
}

export interface LoadBarsView {
  /** Сколько палочек залито, 0–4. */
  filled: number;
  /** Цвет залитых (токены веба); null — залитых нет. */
  tone: 'success' | 'warning' | 'danger' | null;
  /** «Загрузка сервера: низкая» — `aria-label` и `title`. */
  label: string;
}

export interface ServerStatus {
  ping: number | null;
  load: ServerLoad | null;
  bars: LoadBarsView;
}

export type Fetcher = (url: string, init: { method: 'GET' | 'HEAD'; signal: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const TIMEOUT_MS = 3000;

/** Медиана в целых мс; пусто — null. */
export function median(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)]!);
}

/** Ответ `/api/v1/load` — ступень 1–4 и известное состояние; иначе (старое ядро, 404, мусор) — null. */
export function readLoad(raw: unknown): ServerLoad | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.level !== 'number' || !Number.isInteger(data.level) || data.level < 1 || data.level > 4) return null;
  if (!LOAD_STATES.includes(data.state as LoadState)) return null;
  return { level: data.level as ServerLoad['level'], state: data.state as LoadState };
}

/** Палочки и слова — как `LoadBars` веба. */
export function loadBars(load: ServerLoad | null, text: ShellText): LoadBarsView {
  const known = !!load && load.state !== 'maintenance';
  const filled = known ? load!.level : 0;
  const tone = !known ? null : filled >= 4 ? 'danger' : filled === 3 ? 'warning' : 'success';
  const levels = [text.loadLow, text.loadMedium, text.loadHigh, text.loadVeryHigh];
  const words = !load
    ? text.loadUnknown
    : load.state === 'full'
      ? text.loadFull
      : load.state === 'maintenance'
        ? text.loadMaintenance
        : load.state === 'closed'
          ? text.loadClosed
          : levels[filled - 1]!;
  return { filled, tone, label: text.loadLabel.replace('{value}', words) };
}

export async function serverPing(origin: ServerOrigin, fetcher: Fetcher, clock: () => number = () => performance.now()): Promise<number | null> {
  const samples: number[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = clock();
    try {
      const response = await fetcher(new URL('/api/v1/ping', origin.url).toString(), { method: 'HEAD', signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (response.ok) samples.push(clock() - started);
    } catch {
      /* не ответил */
    }
  }
  return median(samples);
}

export async function serverLoad(origin: ServerOrigin, fetcher: Fetcher): Promise<ServerLoad | null> {
  try {
    const response = await fetcher(new URL('/api/v1/load', origin.url).toString(), { method: 'GET', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json' } });
    return response.ok ? readLoad(await response.json()) : null;
  } catch {
    return null;
  }
}

/** Пинг и загрузка сервера каталога; чужой адрес — null (ничего не спрашиваем). */
export async function serverStatus(origin: ServerOrigin | null, allowed: readonly ServerOrigin[], fetcher: Fetcher, text: ShellText): Promise<ServerStatus | null> {
  if (!origin || !allowed.some((known) => known.equals(origin))) return null;
  const [ping, load] = await Promise.all([serverPing(origin, fetcher), serverLoad(origin, fetcher)]);
  return { ping, load, bars: loadBars(load, text) };
}
