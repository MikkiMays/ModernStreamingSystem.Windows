/**
 * Preload локальных страниц оболочки (`cord-app://`): заставка, загрузка, офлайн, серверы,
 * оверлей. Наружу — `window.cordShell`: `call(method, payload)`, `emit(method)` (для кнопок
 * заставки) и `on(event, listener)`. Ничего больше.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/bridge';

const listeners = new Map<string, Set<(data: unknown) => void>>();
ipcRenderer.on(IPC.shellEvent, (_, event: unknown, data: unknown) => {
  if (typeof event !== 'string') return;
  for (const listener of listeners.get(event) ?? []) listener(data);
});

contextBridge.exposeInMainWorld(
  'cordShell',
  Object.freeze({
    call(method: string, payload?: object): Promise<unknown> {
      return ipcRenderer.invoke(IPC.shellCall, method, payload ?? {});
    },
    emit(method: string): void {
      ipcRenderer.send(IPC.shellCall, method);
    },
    on(event: string, listener: (data: unknown) => void): () => void {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(listener);
      return () => void set?.delete(listener);
    },
  }),
);
