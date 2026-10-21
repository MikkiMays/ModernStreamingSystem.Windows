/**
 * Клиент utility-процесса `native` в main (ADR 0001 §2.1): запускает хост, ждёт `ready`, шлёт
 * запросы с номерами и отдаёт события наверх. Процесс упал — возможности выключаются (`ready`
 * с `available: false`), и через 2 секунды хост поднимается снова, не чаще трёх раз за 10 минут.
 *
 * Запуск процесса и порт абстрагированы (`spawn`), поэтому класс проверяется тестами без Electron.
 */
import { isHostEvent, isHostReply, type HostEvent, type HostRequest } from '../../native/protocol';

export interface HostProcess {
  postMessage(message: unknown, transfer?: unknown[]): void;
  onMessage(listener: (data: unknown) => void): void;
  onExit(listener: (code: number) => void): void;
  kill(): void;
}

export interface NativeClientOptions {
  spawn(): HostProcess;
  onEvent(event: HostEvent): void;
  log(message: string): void;
  /** Ответ хоста ждём не дольше (мс). */
  timeoutMs?: number;
  restartDelayMs?: number;
  /** Сколько перезапусков допустимо за 10 минут. */
  restartBudget?: number;
  now?: () => number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
}

export interface NativeStatus {
  available: boolean;
  version: string;
  fake: boolean;
  reason?: string;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: unknown };

export class NativeClient {
  private process: HostProcess | null = null;
  private status: NativeStatus = { available: false, version: '', fake: false, reason: 'не запущен' };
  private readonly pending = new Map<number, Pending>();
  private next = 1;
  private readyWaiters: ((status: NativeStatus) => void)[] = [];
  private readyKnown = false;
  private stopped = false;
  private restarts: number[] = [];

  constructor(private readonly options: NativeClientOptions) {}

  get available(): boolean {
    return this.status.available;
  }

  get current(): NativeStatus {
    return { ...this.status };
  }

  start(): void {
    if (this.process || this.stopped) return;
    let host: HostProcess;
    try {
      host = this.options.spawn();
    } catch (error) {
      this.status = { available: false, version: '', fake: false, reason: (error as Error).message };
      this.options.log(`native: не запущен — ${this.status.reason}`);
      this.settleReady();
      return;
    }
    this.process = host;
    host.onMessage((data) => this.onMessage(host, data));
    host.onExit((code) => this.onExit(host, code));
  }

  /** Дождаться `ready` (или сбоя запуска), но не дольше `ms`. */
  whenReady(ms: number): Promise<NativeStatus> {
    if (this.readyKnown) return Promise.resolve(this.current);
    return new Promise((resolve) => {
      const timer = (this.options.setTimeout ?? setTimeout)(() => {
        this.readyWaiters = this.readyWaiters.filter((waiter) => waiter !== done);
        resolve(this.current);
      }, ms);
      const done = (status: NativeStatus) => {
        clearTimeout(timer as ReturnType<typeof setTimeout>);
        resolve(status);
      };
      this.readyWaiters.push(done);
    });
  }

  request<T = unknown>(request: HostRequest, transfer: unknown[] = []): Promise<T> {
    const host = this.process;
    if (!host || !this.status.available) return Promise.reject(new Error('native: недоступен'));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = (this.options.setTimeout ?? setTimeout)(() => {
        this.pending.delete(id);
        reject(new Error(`native: нет ответа на ${request.type}`));
      }, this.options.timeoutMs ?? 5000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try {
        host.postMessage({ id, request }, transfer);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer as ReturnType<typeof setTimeout>);
        reject(error as Error);
      }
    });
  }

  stop(): void {
    this.stopped = true;
    const host = this.process;
    this.process = null;
    this.failPending('native: остановлен');
    host?.kill();
  }

  private onMessage(host: HostProcess, data: unknown): void {
    if (host !== this.process) return;
    if (isHostReply(data)) {
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      clearTimeout(pending.timer as ReturnType<typeof setTimeout>);
      if (data.ok) pending.resolve(data.result);
      else pending.reject(new Error(data.error));
      return;
    }
    if (!isHostEvent(data)) return;
    if (data.event === 'ready') {
      this.status = { available: data.available, version: data.version, fake: data.fake, ...(data.reason ? { reason: data.reason } : {}) };
      this.options.log(data.available ? `native: загружен ${data.version}${data.fake ? ' (подмена)' : ''}` : `native: недоступен — ${data.reason ?? 'без причины'}`);
      this.settleReady();
    }
    this.options.onEvent(data);
  }

  private onExit(host: HostProcess, code: number): void {
    if (host !== this.process) return;
    this.process = null;
    const wasAvailable = this.status.available;
    this.status = { available: false, version: '', fake: false, reason: `процесс вышел с кодом ${code}` };
    this.failPending(`native: ${this.status.reason}`);
    this.options.log(`native: ${this.status.reason}`);
    this.settleReady();
    if (wasAvailable) this.options.onEvent({ event: 'ready', available: false, version: '', fake: false, reason: this.status.reason });
    if (this.stopped) return;
    const now = (this.options.now ?? Date.now)();
    this.restarts = this.restarts.filter((at) => now - at < 600_000);
    if (this.restarts.length >= (this.options.restartBudget ?? 3)) {
      this.options.log('native: слишком много падений — больше не перезапускается');
      return;
    }
    this.restarts.push(now);
    (this.options.setTimeout ?? setTimeout)(() => {
      if (!this.stopped) this.start();
    }, this.options.restartDelayMs ?? 2000);
  }

  private settleReady(): void {
    this.readyKnown = true;
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) waiter(this.current);
  }

  private failPending(message: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer as ReturnType<typeof setTimeout>);
      pending.reject(new Error(message));
      this.pending.delete(id);
    }
  }
}
