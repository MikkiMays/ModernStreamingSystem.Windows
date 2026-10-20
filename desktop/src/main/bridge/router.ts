/**
 * Маршрутизатор моста v2 в main. Каждый вызов проверяет отправителя: верхний кадр главного
 * окна и origin — выбранный сервер. Потом JSON проходит `readPageMessage` (≤ 16 КиБ, схема).
 * Только после этого сообщение попадает в приложение. Чужие кадры и чужие origin ничего не
 * получают и ничего не могут вызвать.
 */
import { ipcMain, type WebContents, type WebFrameMain } from 'electron';
import { IPC, type Bootstrap, type HostMessage } from '../../shared/bridge';
import type { ServerOrigin } from '../origins';
import { isPageCall, readPageMessage, type Validated } from './messages';

export interface BridgeHandlers {
  bootstrap(origin: ServerOrigin): Promise<Bootstrap>;
  message(message: Validated, sender: WebContents): void;
  call(method: string, payload: unknown, sender: WebContents): Promise<unknown>;
  /** Версия приложения — только для «О программы» в вебе. */
  version(): string;
  log(message: string): void;
}

export class BridgeRouter {
  private current: ServerOrigin | null = null;
  private contents: WebContents | null = null;

  constructor(private readonly handlers: BridgeHandlers) {}

  /** Какой origin и какое окно сейчас считаются «страницей сервера». */
  attach(contents: WebContents, origin: ServerOrigin): void {
    this.contents = contents;
    this.current = origin;
  }

  get origin(): ServerOrigin | null {
    return this.current;
  }

  private trusted(frame: WebFrameMain | null, sender: WebContents): boolean {
    if (!frame || !this.current || !this.contents || sender.id !== this.contents.id) return false;
    // Только верхний кадр документа сервера: iframe с того же origin тоже не считается.
    if (frame.parent !== null) return false;
    return this.current.owns(frame.url);
  }

  install(): void {
    ipcMain.on(IPC.bootstrap, (event) => {
      // Синхронный ответ: preload пишет localStorage до первого скрипта страницы.
      if (!this.trusted(event.senderFrame, event.sender) || !this.current) {
        this.handlers.log(`мост: bootstrap отклонён для ${event.senderFrame?.url ?? '?'} (origin ${this.current?.origin ?? 'нет'}, окно ${event.sender.id}/${this.contents?.id ?? '?'}, parent ${event.senderFrame?.parent === null ? 'нет' : 'есть'})`);
        event.returnValue = null;
        return;
      }
      const origin = this.current;
      // sendSync не умеет ждать — bootstrap готовится заранее (`prepareBootstrap`), здесь только отдаётся.
      const bootstrap = this.prepared.get(origin.origin);
      event.returnValue = bootstrap ? { bootstrap, version: this.handlers.version() } : null;
    });
    ipcMain.on(IPC.send, (event, type: unknown, payload: unknown) => {
      if (!this.trusted(event.senderFrame, event.sender)) return;
      const message = readPageMessage(type, payload);
      if (!message) {
        this.handlers.log(`мост: отброшено сообщение ${String(type)}`);
        return;
      }
      this.handlers.message(message, event.sender);
    });
    ipcMain.handle(IPC.invoke, async (event, method: unknown, payload: unknown) => {
      if (!this.trusted(event.senderFrame, event.sender) || !isPageCall(method)) throw new Error('Недоступно.');
      if (JSON.stringify(payload ?? null).length > 16384) throw new Error('Слишком большой запрос.');
      return this.handlers.call(method, payload, event.sender);
    });
  }

  private readonly prepared = new Map<string, Bootstrap>();

  /** Подготовить bootstrap для origin до загрузки документа — preload заберёт его синхронно. */
  async prepareBootstrap(origin: ServerOrigin): Promise<void> {
    this.prepared.set(origin.origin, await this.handlers.bootstrap(origin));
  }

  /** Сообщение оболочки странице; уходит только в документ выбранного сервера. */
  post(type: HostMessage, data: Record<string, unknown> = {}): void {
    const contents = this.contents;
    if (!contents || contents.isDestroyed() || !this.current) return;
    const frame = contents.mainFrame;
    if (!this.current.owns(frame.url)) return;
    contents.send(IPC.host, type, data);
  }
}
