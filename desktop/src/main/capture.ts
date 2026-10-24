/**
 * Захват экрана и окна (T10, T43, ADR 0001 §4.1). Веб рисует своё окно выбора: просит
 * `capture.sources` (миниатюры ≤ 320 px), присылает `capture.select {id, audio}` и зовёт
 * `getDisplayMedia`; `setDisplayMediaRequestHandler` в main отдаёт именно выбранный источник.
 *
 * Выбор живёт 10 секунд и только для одного запроса: без него обработчик отвечает отказом,
 * чтобы страница не могла получить экран, не показав человеку выбор.
 *
 * Звук: Electron умеет только loopback всего звука системы (`audio: 'loopback'`, режим `system`,
 * только Windows, флаг `capture.system-audio`), куда попадают и голоса комнаты. Режимы `app` и
 * `system-except-cord` — process loopback в `cord-native` (`nativeAudioFor`, флаг `capture.app-audio`):
 * PCM идёт по порту в preload, тот собирает дорожку и отдаёт её вебу через элемент на странице.
 */
export type AudioMode = 'none' | 'system' | 'app' | 'system-except-cord';

export interface Selection {
  id: string;
  audio: AudioMode;
  at: number;
}

export const SELECTION_TTL_MS = 10_000;

export class CaptureSelection {
  private pending: Selection | null = null;

  select(id: string, audio: AudioMode, now: number = Date.now()): void {
    this.pending = { id, audio, at: now };
  }

  /** Забрать выбор — один раз и только пока он свеж. */
  take(now: number = Date.now()): Selection | null {
    const selection = this.pending;
    this.pending = null;
    if (!selection || now - selection.at > SELECTION_TTL_MS || now < selection.at) return null;
    return selection;
  }

  clear(): void {
    this.pending = null;
  }
}

/**
 * Что отдать Chromium за звук по выбранному режиму. `system` — весь звук системы (только Windows;
 * веб предупреждает, что участники услышат и себя). `app` и `system-except-cord` без
 * `cord-native` невозможны: честнее показать без звука, чем с эхом.
 */
export function loopbackFor(audio: AudioMode, platform: NodeJS.Platform): 'loopback' | null {
  return audio === 'system' && platform === 'win32' ? 'loopback' : null;
}

/** Источник показа так, как его видит окно выбора веба (`invoke('capture.sources')`). */
export interface CaptureSourceView {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  /** `data:image/png` ≤ 320×180 или пустая строка. */
  thumbnail: string;
  /** Значок приложения 24 px или пустая строка. */
  icon: string;
}

interface Picture {
  isEmpty(): boolean;
  toDataURL(): string;
}
export interface RawSource {
  id: string;
  name: string;
  thumbnail: Picture;
  appIcon?: (Picture & { resize(options: { width: number }): { toDataURL(): string } }) | null;
}

/**
 * Источники из `desktopCapturer.getSources` → строки окна выбора. Свои окна Cord (главное, выбор,
 * оверлей) убираются по id источника (`BrowserWindow.getMediaSourceId()`), а не по заголовку: чужое
 * окно с «Cord» в имени — например, заметки о встрече — показывать можно.
 */
export function captureSourceViews(sources: readonly RawSource[], own: ReadonlySet<string>): CaptureSourceView[] {
  return sources
    .filter((source) => !own.has(source.id))
    .map((source) => ({
      id: source.id,
      name: source.name.slice(0, 80),
      kind: source.id.startsWith('screen:') ? ('screen' as const) : ('window' as const),
      thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
      icon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.resize({ width: 24 }).toDataURL() : '',
    }));
}

const SOURCE_ID = /^(screen|window):\d+:\d+$/;
const AUDIO_MODES: readonly AudioMode[] = ['none', 'system', 'app', 'system-except-cord'];

/** `capture.select {id, audio}` — одна проверка и для `invoke`, и для прежнего `send`. */
export function readCaptureSelect(payload: unknown): { id: string; audio: AudioMode } | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const data = payload as Record<string, unknown>;
  if (typeof data.id !== 'string' || !SOURCE_ID.test(data.id)) return null;
  if (!AUDIO_MODES.includes(data.audio as AudioMode)) return null;
  return { id: data.id, audio: data.audio as AudioMode };
}

/**
 * Звук через `cord-native` (process loopback). `app` — дерево процессов окна источника
 * (`window:<hwnd>:0` → HWND → PID в utility-процессе); `system-except-cord` — всё, кроме дерева
 * процессов Cord. Без модуля или для «звука приложения» у экрана — отказ с причиной: показ идёт
 * без звука, веб получает `capture.audio {state: 'failed', reason}` и показывает подсказку.
 */
export type NativeAudioPlan = { mode: 'include'; hwnd: number } | { mode: 'exclude' };
export type NativeAudioDecision = { kind: 'none' } | { kind: 'native'; plan: NativeAudioPlan } | { kind: 'failed'; reason: 'unavailable' | 'not-a-window' };

export function nativeAudioFor(selection: { id: string; audio: AudioMode }, nativeAvailable: boolean): NativeAudioDecision {
  if (selection.audio !== 'app' && selection.audio !== 'system-except-cord') return { kind: 'none' };
  if (!nativeAvailable) return { kind: 'failed', reason: 'unavailable' };
  if (selection.audio === 'system-except-cord') return { kind: 'native', plan: { mode: 'exclude' } };
  const match = /^window:(\d+):\d+$/.exec(selection.id);
  if (!match) return { kind: 'failed', reason: 'not-a-window' };
  return { kind: 'native', plan: { mode: 'include', hwnd: Number(match[1]) } };
}
