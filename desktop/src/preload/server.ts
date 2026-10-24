/**
 * Preload страницы сервера: единственное, что видит веб, — `window.cordDesktop` (ADR 0001 §3).
 * Только функции с данными: ни `ipcRenderer`, ни путей, ни `shell`. Прокладки
 * `window.chrome.webview` нет (§3.2, решение В-2).
 *
 * `bootstrap` берётся синхронно один раз на документ и пишется в те же ключи, что и WinUI:
 * `cord:profile:v1`, `cord:theme`, `cord:preferences:v1` (слияние), `cord:servers:v1`,
 * `dataset.desktop`. Так веб читает их здесь так же, как читал в WebView2.
 *
 * Звук захвата (§4.1, `capture.app-audio`): main присылает порт PCM из utility-процесса
 * (`cord:capture-audio`); preload собирает из порций `MediaStreamTrackGenerator` и кладёт
 * дорожку в скрытый `<audio id="cord-desktop-capture-audio">` — страница читает `srcObject`
 * того же элемента (DOM один на оба мира, объект потока общий) и публикует дорожку как
 * ScreenShareAudio. О состоянии — событие `capture.audio`; новый слушатель получает текущее сразу.
 * Порции идут в генератор не по приходу, а по часам из запаса в две порции (`PcmQueue`, R01–R03):
 * пачка от потока захвата не уходит в сеть пачкой.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { CAPTURE_AUDIO_ELEMENT, FEATURES, HOST_MESSAGES, IPC, PAGE_CALLS, PAGE_MESSAGES, PROTOCOL, type Bootstrap, type CordDesktopApi, type Feature, type HostMessage } from '../shared/bridge';
import { PCM_CHUNK_MS, PcmQueue } from './pcm-queue';

const handed = ipcRenderer.sendSync(IPC.bootstrap) as { bootstrap: Bootstrap; version: string; features?: unknown } | null;
const bootstrap = handed?.bootstrap ?? null;
// Флаги этой машины от main (`featuresFor`): на Windows — все, иначе без API панели задач. Только известные имена.
const features: readonly Feature[] = Object.freeze(
  Array.isArray(handed?.features) ? FEATURES.filter((feature) => (handed.features as unknown[]).includes(feature)) : [...FEATURES],
);

if (bootstrap && window === window.top) {
  try {
    localStorage.setItem('cord:profile:v1', bootstrap.profile);
    localStorage.setItem('cord:theme', bootstrap.theme);
    let saved: Record<string, unknown> = {};
    try {
      saved = (JSON.parse(localStorage.getItem('cord:preferences:v1') ?? 'null') as Record<string, unknown>) ?? {};
    } catch {
      saved = {};
    }
    if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) saved = {};
    saved.showPing = bootstrap.showPing;
    saved.notificationSounds = bootstrap.notificationSounds;
    // Язык из установщика (R64) — один раз на origin: дальше человек выбирает язык в настройках Cord,
    // и даже возврат к «языку системы» (null) оболочка не перебивает.
    const handed = 'cord:installer-language';
    if (bootstrap.language && localStorage.getItem(handed) !== bootstrap.language) {
      if (typeof saved.language !== 'string') saved.language = bootstrap.language;
      localStorage.setItem(handed, bootstrap.language);
    }
    localStorage.setItem('cord:preferences:v1', JSON.stringify(saved));
    let server: Record<string, unknown> = {};
    try {
      server = (JSON.parse(localStorage.getItem('cord:servers:v1') ?? 'null') as Record<string, unknown>) ?? {};
    } catch {
      server = {};
    }
    if (typeof server !== 'object' || server === null || Array.isArray(server)) server = {};
    server.url = location.origin + '/';
    server.autoConnect = bootstrap.autoConnect;
    localStorage.setItem('cord:servers:v1', JSON.stringify(server));
    document.documentElement.dataset.desktop = 'true';
  } catch {
    // Хранилище недоступно — страница спросит имя заново; мост всё равно работает.
  }
}

const listeners = new Map<string, Set<(data: Record<string, unknown>) => void>>();
function emit(type: string, payload: Record<string, unknown>): void {
  for (const listener of listeners.get(type) ?? []) {
    try {
      listener(payload);
    } catch {
      /* слушатель страницы — её дело */
    }
  }
}
ipcRenderer.on(IPC.host, (_, type: unknown, data: unknown) => {
  if (typeof type !== 'string') return;
  emit(type, data && typeof data === 'object' ? (data as Record<string, unknown>) : {});
});

// ---------- звук захвата: порт PCM → MediaStreamTrackGenerator → элемент на странице ----------

interface AudioTrackGenerator extends MediaStreamTrack {
  readonly writable: WritableStream<AudioData>;
}
declare const MediaStreamTrackGenerator: (new (init: { kind: 'audio' | 'video' }) => AudioTrackGenerator) | undefined;

type CaptureAudioState = { state: 'ready' | 'failed' | 'ended'; mode: string; reason?: string };
let captureAudio: CaptureAudioState | null = null;
let captureSession: { port: MessagePort; writer: WritableStreamDefaultWriter<AudioData>; element: HTMLAudioElement; track: AudioTrackGenerator; timer: ReturnType<typeof setInterval>; done: boolean } | null = null;

function setCaptureAudio(next: CaptureAudioState): void {
  captureAudio = next;
  emit('capture.audio', { ...next });
}

function endCaptureAudio(state: 'failed' | 'ended', reason?: string, tellMain = true): void {
  const session = captureSession;
  captureSession = null;
  if (session && !session.done) {
    session.done = true;
    clearInterval(session.timer);
    void session.writer.close().catch(() => {});
    session.track.stop();
    session.element.remove();
    try {
      session.port.close();
    } catch {
      /* порт уже закрыт */
    }
  }
  if (tellMain) ipcRenderer.send(IPC.captureAudio, { type: 'stopped' });
  if (session || state === 'failed') setCaptureAudio({ state, mode: captureAudio?.mode ?? '', ...(reason ? { reason } : {}) });
}

ipcRenderer.on(IPC.captureAudio, (event, info: unknown) => {
  const port = event.ports[0];
  const data = info && typeof info === 'object' ? (info as Record<string, unknown>) : {};
  const mode = typeof data.mode === 'string' ? data.mode : '';
  if (!port) return;
  endCaptureAudio('ended', undefined, false);
  if (typeof MediaStreamTrackGenerator !== 'function' || typeof AudioData !== 'function') {
    port.close();
    captureAudio = { state: 'failed', mode };
    endCaptureAudio('failed', 'generator');
    return;
  }
  let track: AudioTrackGenerator;
  try {
    track = new MediaStreamTrackGenerator({ kind: 'audio' });
  } catch (error) {
    port.close();
    captureAudio = { state: 'failed', mode };
    endCaptureAudio('failed', (error as Error).message);
    return;
  }
  const writer = track.writable.getWriter();
  const element = document.createElement('audio');
  element.id = CAPTURE_AUDIO_ELEMENT;
  element.hidden = true;
  element.muted = true;
  element.dataset.mode = mode;
  element.srcObject = new MediaStream([track]);
  (document.body ?? document.documentElement).append(element);
  let sampleRate = Number(data.sampleRate) || 48_000;
  let channels = Number(data.channels) || 2;
  let frames = 0;
  const queue = new PcmQueue();
  // Метка времени — по счётчику кадров: монотонна, сколько бы порций ни ушло за один тик.
  const flush = () => {
    if (captureSession !== session) return;
    for (const samples of queue.take(performance.now())) {
      const count = Math.floor(samples.length / channels);
      if (count === 0) continue;
      const chunk = new AudioData({ format: 'f32', sampleRate, numberOfFrames: count, numberOfChannels: channels, timestamp: Math.round((frames / sampleRate) * 1e6), data: samples });
      frames += count;
      writer.write(chunk).catch(() => endCaptureAudio('ended'));
    }
  };
  const session = { port, writer, element, track, timer: setInterval(flush, PCM_CHUNK_MS), done: false };
  captureSession = session;
  track.addEventListener('ended', () => {
    // Страница остановила дорожку (показ закончен) — захват в utility-процессе больше не нужен.
    if (captureSession === session) endCaptureAudio('ended');
  });
  port.onmessage = ({ data: message }) => {
    if (captureSession !== session) return;
    if (message instanceof ArrayBuffer) {
      queue.push(new Float32Array(message));
      flush();
      return;
    }
    const control = message && typeof message === 'object' ? (message as Record<string, unknown>) : {};
    if (control.type === 'format') {
      sampleRate = Number(control.sampleRate) || sampleRate;
      channels = Number(control.channels) || channels;
    } else if (control.type === 'end') {
      const reason = typeof control.reason === 'string' ? control.reason : undefined;
      endCaptureAudio(reason ? 'failed' : 'ended', reason, false);
    }
  };
  port.start();
  setCaptureAudio({ state: 'ready', mode });
});

const api: CordDesktopApi = {
  protocol: PROTOCOL,
  features,
  app: { version: handed?.version ?? '', arch: process.arch as 'x64' },
  bootstrap: bootstrap ?? { profile: '', theme: 'system', language: null, showPing: false, notificationSounds: true, autoConnect: true },
  send(type, payload) {
    if (!(PAGE_MESSAGES as readonly string[]).includes(type)) return;
    ipcRenderer.send(IPC.send, type, payload ?? {});
  },
  invoke(method, payload) {
    if (!(PAGE_CALLS as readonly string[]).includes(method)) return Promise.reject(new Error('Недоступно.'));
    return ipcRenderer.invoke(IPC.invoke, method, payload ?? {});
  },
  on(type, listener) {
    if (!(HOST_MESSAGES as readonly string[]).includes(type) || typeof listener !== 'function') return () => {};
    let set = listeners.get(type);
    if (!set) listeners.set(type, (set = new Set()));
    set.add(listener);
    // Состояние звука захвата новый слушатель получает сразу: событие могло уйти до подписки.
    if (type === 'capture.audio' && captureAudio) {
      const current = { ...captureAudio };
      queueMicrotask(() => {
        if (set?.has(listener)) listener(current);
      });
    }
    return () => void set?.delete(listener);
  },
};

contextBridge.exposeInMainWorld('cordDesktop', Object.freeze(api));
export type { HostMessage };
