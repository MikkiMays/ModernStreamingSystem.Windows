/**
 * Preload страницы сервера: единственное, что видит веб, — `window.cordDesktop` (ADR 0001 §3).
 * Только функции с данными: ни `ipcRenderer`, ни путей, ни `shell`. Прокладки
 * `window.chrome.webview` нет (§3.2, решение В-2).
 *
 * `bootstrap` берётся синхронно один раз на документ и пишется в те же ключи, что и WinUI:
 * `cord:profile:v1`, `cord:theme`, `cord:preferences:v1` (слияние), `cord:servers:v1`,
 * `dataset.desktop`. Так веб читает их здесь так же, как читал в WebView2.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { FEATURES, HOST_MESSAGES, IPC, PAGE_CALLS, PAGE_MESSAGES, PROTOCOL, type Bootstrap, type CordDesktopApi, type Feature, type HostMessage } from '../shared/bridge';

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
ipcRenderer.on(IPC.host, (_, type: unknown, data: unknown) => {
  if (typeof type !== 'string') return;
  const set = listeners.get(type);
  if (!set) return;
  const payload = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  for (const listener of set) {
    try {
      listener(payload);
    } catch {
      /* слушатель страницы — её дело */
    }
  }
});

const api: CordDesktopApi = {
  protocol: PROTOCOL,
  features,
  app: { version: handed?.version ?? '', arch: process.arch as 'x64' },
  bootstrap: bootstrap ?? { profile: '', theme: 'system', showPing: false, notificationSounds: true, autoConnect: true },
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
    return () => void set?.delete(listener);
  },
};

contextBridge.exposeInMainWorld('cordDesktop', Object.freeze(api));
export type { HostMessage };
