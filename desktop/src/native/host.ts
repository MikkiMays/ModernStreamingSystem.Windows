/**
 * Utility-процесс `native` (ADR 0001 §2.1): единственное место, где грузится `cord-native.node`.
 * Main говорит с ним через `process.parentPort` (запрос → ответ, события), а PCM захвата идёт по
 * отдельному порту прямо в рендерер, минуя main. Упал модуль — упал только этот процесс: main
 * выключает возможности и перезапускает его.
 *
 * `CORD_NATIVE_MODULE` — путь к `.node`; нет файла или не Windows — `ready {available: false}`.
 * `CORD_NATIVE_FAKE=1` — подмена для разработки и дымового прогона без Windows: тон 440 Гц вместо
 * звука приложения, переднее окно «не Cord, не во весь экран» (дымовой прогон потом подставляет своё —
 * `cordSmoke.foreground` в main). В выпуске не включается.
 */
import { existsSync } from 'node:fs';
import type { MessagePortMain } from 'electron';
import { PCM_CHANNELS, PCM_CHUNK_FRAMES, PCM_SAMPLE_RATE, type BoostResult, type HostCall, type HostEvent, type HostReply, type NativeAudioEvent, type NativeForegroundEvent, type NativeHotkeyEvent, type NativeModule } from './protocol';

interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown; ports: MessagePortMain[] }) => void): unknown;
  postMessage(message: unknown): void;
  start?(): void;
}

const port = (process as unknown as { parentPort: ParentPort }).parentPort;

function send(message: HostReply | HostEvent): void {
  port.postMessage(message);
}

/** Подмена модуля для машин без Windows (только разработка и дымовой прогон). */
function fakeModule(): NativeModule {
  let audioTimer: ReturnType<typeof setInterval> | null = null;
  let frames = 0;
  return {
    version: () => 'fake',
    platformSupported: () => true,
    startInput: () => {},
    setBindings: (bindings) => bindings.filter((binding) => !/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Mouse[3-5])$/.test(binding.code)).map((binding) => binding.id),
    stopInput: () => {},
    watchForeground: (_root, _interval, callback) => {
      setTimeout(() => callback({ hwnd: 1, pid: 4242, fullscreen: false, cord: false, monitor: { x: 0, y: 0, width: 1920, height: 1080 }, exe: 'explorer.exe', title: '', borderless: false, exclusive: false }), 0);
    },
    stopForeground: () => {},
    startAudio: (_options, callback) => {
      if (audioTimer) clearInterval(audioTimer);
      frames = 0;
      audioTimer = setInterval(() => {
        const pcm = new Float32Array(PCM_CHUNK_FRAMES * PCM_CHANNELS);
        for (let i = 0; i < PCM_CHUNK_FRAMES; i++) {
          const value = Math.sin(((frames + i) / PCM_SAMPLE_RATE) * 2 * Math.PI * 440) * 0.2;
          pcm[i * 2] = value;
          pcm[i * 2 + 1] = value;
        }
        frames += PCM_CHUNK_FRAMES;
        callback({ state: 'pcm', pcm });
      }, 10);
      return 1;
    },
    stopAudio: () => {
      if (audioTimer) clearInterval(audioTimer);
      audioTimer = null;
    },
    windowProcess: () => 4242,
    processAlive: () => true,
    currentProcess: () => process.pid,
    boostProcess: () => {},
  };
}

function loadModule(): { module: NativeModule | null; version: string; fake: boolean; reason?: string } {
  if (process.env.CORD_NATIVE_FAKE === '1') return { module: fakeModule(), version: 'fake', fake: true };
  const path = process.env.CORD_NATIVE_MODULE ?? '';
  if (!path || !existsSync(path)) return { module: null, version: '', fake: false, reason: path ? `нет файла ${path}` : 'путь к модулю не задан' };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require(path) as NativeModule;
    if (!loaded.platformSupported()) return { module: null, version: loaded.version(), fake: false, reason: 'не Windows' };
    return { module: loaded, version: loaded.version(), fake: false };
  } catch (error) {
    return { module: null, version: '', fake: false, reason: (error as Error).message };
  }
}

const loaded = loadModule();
const native = loaded.module;
let audio: { session: number; port: MessagePortMain } | null = null;
let inputStarted = false;

function stopAudio(reason?: string): void {
  if (!audio) return;
  const current = audio;
  audio = null;
  try {
    native?.stopAudio(current.session);
  } catch {
    /* сеанса уже нет */
  }
  try {
    current.port.postMessage({ type: 'end', ...(reason ? { reason } : {}) });
    current.port.close();
  } catch {
    /* порт уже закрыт рендерером */
  }
}

function onHotkey(event: NativeHotkeyEvent): void {
  send({ event: 'hotkey', id: event.id, phase: event.phase === 'up' ? 'up' : 'down' });
}

function onForeground(event: NativeForegroundEvent): void {
  send({ event: 'foreground', foreground: event });
}

function handle(call: HostCall, ports: MessagePortMain[]): unknown {
  if (!native) throw new Error('модуль недоступен');
  const request = call.request;
  switch (request.type) {
    case 'hotkeys.set': {
      if (!inputStarted) {
        native.startInput(onHotkey);
        inputStarted = true;
      }
      return native.setBindings(request.bindings);
    }
    case 'hotkeys.stop':
      native.stopInput();
      inputStarted = false;
      return true;
    case 'foreground.watch':
      native.watchForeground(request.rootPid, request.intervalMs, onForeground);
      return true;
    case 'foreground.stop':
      native.stopForeground();
      return true;
    case 'audio.start': {
      const pcmPort = ports[0];
      if (!pcmPort) throw new Error('нет порта для PCM');
      stopAudio();
      pcmPort.start();
      pcmPort.postMessage({ type: 'format', sampleRate: PCM_SAMPLE_RATE, channels: PCM_CHANNELS });
      const session = native.startAudio({ pid: request.pid, mode: request.mode }, (event: NativeAudioEvent) => {
        if (!audio || audio.session !== session) return;
        if (event.state === 'pcm' && event.pcm) {
          // Копия в свой ArrayBuffer: буфер модуля может переиспользоваться, а порт сериализует позже.
          const copy = new Float32Array(event.pcm);
          audio.port.postMessage(copy.buffer);
          return;
        }
        const reason = event.state === 'error' ? (event.reason ?? 'ошибка захвата') : undefined;
        stopAudio(reason);
        send({ event: 'audio', state: event.state === 'error' ? 'error' : 'ended', ...(reason ? { reason } : {}) });
      });
      audio = { session, port: pcmPort };
      return session;
    }
    case 'audio.stop':
      stopAudio();
      return true;
    case 'window.pid':
      return native.windowProcess(request.hwnd);
    case 'process.alive':
      // Модуль до R62 этого не умеет — тогда игра считается живой, пока впереди не окажется другая.
      return typeof native.processAlive === 'function' ? native.processAlive(request.pid, String(request.exe ?? '')) : true;
    case 'process.boost':
      return request.pids
        .filter((pid) => Number.isInteger(pid) && pid > 0)
        .map((pid): BoostResult => {
          try {
            native.boostProcess(pid, request.on === true);
            return { pid, ok: true };
          } catch (error) {
            return { pid, ok: false, error: (error as Error).message };
          }
        });
    default:
      throw new Error(`неизвестный запрос ${(request as { type: string }).type}`);
  }
}

port.on('message', ({ data, ports }) => {
  const call = data as HostCall;
  if (!call || typeof call !== 'object' || typeof call.id !== 'number' || !call.request) return;
  try {
    send({ id: call.id, ok: true, result: handle(call, ports) });
  } catch (error) {
    send({ id: call.id, ok: false, error: (error as Error).message });
  }
});
port.start?.();
send({ event: 'ready', available: !!native, version: loaded.version, fake: loaded.fake, ...(loaded.reason ? { reason: loaded.reason } : {}) });
