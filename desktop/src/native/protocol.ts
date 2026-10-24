/**
 * Протокол между main и utility-процессом `native` (ADR 0001 §2.1, §4.6): main шлёт запросы с
 * номером и получает ответы и события; порт PCM для рендерера передаётся вместе с запросом
 * `audio.start`. Здесь же — поверхность самого модуля `cord-native.node` (Rust, napi-rs), как её
 * видит JS. Ничего из Electron: типы общие для main, хоста и тестов.
 */

/** Имя файла модуля в `dist/native/` (asarUnpack); другие платформы его не собирают. */
export const NATIVE_MODULE_FILE = 'cord-native.win32-x64-msvc.node';

export const PCM_SAMPLE_RATE = 48_000;
export const PCM_CHANNELS = 2;
/** Порция — 10 мс: 480 кадров × 2 канала float32. */
export const PCM_CHUNK_FRAMES = 480;

export interface NativeBinding {
  id: string;
  code: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface NativeHotkeyEvent {
  id: string;
  phase: 'down' | 'up';
}

export interface NativeMonitor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeForegroundEvent {
  hwnd: number;
  pid: number;
  fullscreen: boolean;
  cord: boolean;
  /** Физические пиксели монитора переднего окна. */
  monitor: NativeMonitor;
}

export type NativeAudioMode = 'include' | 'exclude';

export interface NativeAudioEvent {
  state: 'pcm' | 'ended' | 'error';
  pcm?: Float32Array | null;
  reason?: string | null;
}

/** Что экспортирует `cord-native.node` (имена — camelCase от napi-rs). */
export interface NativeModule {
  version(): string;
  platformSupported(): boolean;
  startInput(callback: (event: NativeHotkeyEvent) => void): void;
  /** Возвращает id сочетаний, которые зарегистрировать нельзя. */
  setBindings(bindings: NativeBinding[]): string[];
  stopInput(): void;
  watchForeground(rootPid: number, intervalMs: number, callback: (event: NativeForegroundEvent) => void): void;
  stopForeground(): void;
  startAudio(options: { pid: number; mode: NativeAudioMode }, callback: (event: NativeAudioEvent) => void): number;
  stopAudio(session: number): void;
  windowProcess(hwnd: number): number | null;
  currentProcess(): number;
  /** Приоритет своего процесса, пока Cord запущен: EcoQoS выкл., `HIGH` (R01–R03); ошибка — исключением. */
  boostProcess(pid: number, on: boolean): void;
}

// ---------- main → хост ----------

export type HostRequest =
  | { type: 'hotkeys.set'; bindings: NativeBinding[] }
  | { type: 'hotkeys.stop' }
  | { type: 'foreground.watch'; rootPid: number; intervalMs: number }
  | { type: 'foreground.stop' }
  /** Порт для PCM передаётся вместе с сообщением (`transfer`). */
  | { type: 'audio.start'; pid: number; mode: NativeAudioMode }
  | { type: 'audio.stop' }
  | { type: 'window.pid'; hwnd: number }
  /** Поднять (`on`) или вернуть приоритет своих процессов (`boost-plan.ts`); ответ — `BoostResult[]`. */
  | { type: 'process.boost'; pids: number[]; on: boolean };

export interface BoostResult {
  pid: number;
  ok: boolean;
  error?: string;
}

export interface HostCall {
  id: number;
  request: HostRequest;
}

// ---------- хост → main ----------

export type HostReply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

export type HostEvent =
  | { event: 'ready'; available: boolean; version: string; fake: boolean; reason?: string }
  | { event: 'hotkey'; id: string; phase: 'down' | 'up' }
  | { event: 'foreground'; foreground: NativeForegroundEvent }
  | { event: 'audio'; state: 'ended' | 'error'; reason?: string };

export type HostMessage = HostReply | HostEvent;

export function isHostReply(message: unknown): message is HostReply {
  return !!message && typeof message === 'object' && typeof (message as HostReply).id === 'number' && 'ok' in (message as object);
}

export function isHostEvent(message: unknown): message is HostEvent {
  return !!message && typeof message === 'object' && typeof (message as HostEvent).event === 'string';
}

/** Что хост сообщает рендереру по порту PCM: сначала формат, затем порции, в конце — конец. */
export type PcmPortMessage = { type: 'format'; sampleRate: number; channels: number } | { type: 'end'; reason?: string } | ArrayBuffer;
