import { describe, expect, it } from 'vitest';
import { NativeClient, type HostProcess } from '../../src/main/native/client';
import { isHostEvent, isHostReply, type HostEvent } from '../../src/native/protocol';

/** Поддельный utility-процесс: что ему послали — видно, ответы и события — руками. */
function fakeHost() {
  const sent: { message: unknown; transfer: unknown[] }[] = [];
  let onMessage: (data: unknown) => void = () => {};
  let onExit: (code: number) => void = () => {};
  let killed = false;
  const process: HostProcess = {
    postMessage: (message, transfer = []) => void sent.push({ message, transfer }),
    onMessage: (listener) => (onMessage = listener),
    onExit: (listener) => (onExit = listener),
    kill: () => void (killed = true),
  };
  return {
    process,
    sent,
    emit: (data: unknown) => onMessage(data),
    exit: (code: number) => onExit(code),
    ready: (available = true, reason?: string) => onMessage({ event: 'ready', available, version: available ? '1.0.2' : '', fake: false, ...(reason ? { reason } : {}) }),
    get killed() {
      return killed;
    },
  };
}

function setup(options: { timeoutMs?: number; spawnFails?: boolean } = {}) {
  const hosts: ReturnType<typeof fakeHost>[] = [];
  const events: HostEvent[] = [];
  const log: string[] = [];
  const timers: { callback: () => void; ms: number }[] = [];
  let now = 1_000_000;
  const client = new NativeClient({
    spawn: () => {
      if (options.spawnFails) throw new Error('fork не удался');
      const host = fakeHost();
      hosts.push(host);
      return host.process;
    },
    onEvent: (event) => events.push(event),
    log: (message) => log.push(message),
    timeoutMs: options.timeoutMs ?? 5000,
    restartDelayMs: 2000,
    restartBudget: 2,
    now: () => now,
    setTimeout: (callback, ms) => {
      timers.push({ callback, ms });
      return setTimeout(() => {}, 0);
    },
  });
  return { client, hosts, events, log, timers, advance: (ms: number) => (now += ms) };
}

describe('NativeClient — utility-процесс native', () => {
  it('ready → доступен; запрос с номером получает ответ, ошибка хоста — отказ', async () => {
    const { client, hosts, events, log } = setup();
    client.start();
    const waiting = client.whenReady(3000);
    expect(client.available).toBe(false);
    hosts[0]!.ready();
    expect((await waiting).available).toBe(true);
    expect(log.at(-1)).toContain('native: загружен 1.0.2');
    expect(events).toEqual([{ event: 'ready', available: true, version: '1.0.2', fake: false }]);

    const pending = client.request<number | null>({ type: 'window.pid', hwnd: 42 });
    const call = hosts[0]!.sent[0]!.message as { id: number; request: unknown };
    expect(call.request).toEqual({ type: 'window.pid', hwnd: 42 });
    hosts[0]!.emit({ id: call.id, ok: true, result: 777 });
    expect(await pending).toBe(777);

    const failing = client.request({ type: 'audio.stop' });
    const second = hosts[0]!.sent[1]!.message as { id: number };
    hosts[0]!.emit({ id: second.id, ok: false, error: 'сеанса нет' });
    await expect(failing).rejects.toThrow('сеанса нет');

    // Порт передаётся вместе с запросом.
    const port = { fake: 'port' };
    void client.request({ type: 'audio.start', pid: 5, mode: 'exclude' }, [port]).catch(() => {});
    expect(hosts[0]!.sent[2]!.transfer).toEqual([port]);
  });

  it('недоступен без модуля: запросы отказывают, whenReady не висит', async () => {
    const { client, hosts } = setup();
    client.start();
    hosts[0]!.ready(false, 'нет файла');
    expect((await client.whenReady(3000)).reason).toBe('нет файла');
    await expect(client.request({ type: 'audio.stop' })).rejects.toThrow('недоступен');
  });

  it('whenReady истекает по таймеру, если хост молчит; fork не удался — сразу недоступен', async () => {
    const { client, timers } = setup();
    client.start();
    const waiting = client.whenReady(3000);
    expect(timers.at(-1)?.ms).toBe(3000);
    timers.at(-1)!.callback();
    expect((await waiting).available).toBe(false);

    const failed = setup({ spawnFails: true });
    failed.client.start();
    expect((await failed.client.whenReady(10)).reason).toBe('fork не удался');
  });

  it('нет ответа в срок — отказ по таймеру', async () => {
    const { client, hosts, timers } = setup({ timeoutMs: 100 });
    client.start();
    hosts[0]!.ready();
    const pending = client.request({ type: 'foreground.stop' });
    const timer = timers.find((item) => item.ms === 100)!;
    timer.callback();
    await expect(pending).rejects.toThrow('нет ответа на foreground.stop');
  });

  it('процесс упал: событие ready {available: false}, ожидания отказаны, перезапуск через 2 с, не больше бюджета', async () => {
    const { client, hosts, events, timers, advance } = setup();
    client.start();
    hosts[0]!.ready();
    const pending = client.request({ type: 'audio.stop' });
    hosts[0]!.exit(3);
    await expect(pending).rejects.toThrow('вышел с кодом 3');
    expect(client.available).toBe(false);
    expect(events.at(-1)).toMatchObject({ event: 'ready', available: false, reason: 'процесс вышел с кодом 3' });
    const restart = timers.find((item) => item.ms === 2000)!;
    restart.callback();
    expect(hosts).toHaveLength(2);
    hosts[1]!.ready();
    expect(client.available).toBe(true);

    // Второе падение — последний перезапуск; третье — больше не поднимается.
    advance(1000);
    hosts[1]!.exit(1);
    timers.filter((item) => item.ms === 2000).at(-1)!.callback();
    expect(hosts).toHaveLength(3);
    hosts[2]!.ready();
    advance(1000);
    hosts[2]!.exit(1);
    const restarts = timers.filter((item) => item.ms === 2000);
    expect(restarts).toHaveLength(2);
    expect(hosts).toHaveLength(3);
  });

  it('stop() убивает хост и не перезапускает', () => {
    const { client, hosts, timers } = setup();
    client.start();
    hosts[0]!.ready();
    client.stop();
    expect(hosts[0]!.killed).toBe(true);
    hosts[0]!.exit(0);
    expect(timers.some((item) => item.ms === 2000)).toBe(false);
  });
});

describe('протокол хоста', () => {
  it('ответ — по номеру и ok; событие — по имени', () => {
    expect(isHostReply({ id: 1, ok: true, result: null })).toBe(true);
    expect(isHostReply({ event: 'hotkey', id: 'ptt', phase: 'down' })).toBe(false);
    expect(isHostEvent({ event: 'hotkey', id: 'ptt', phase: 'down' })).toBe(true);
    expect(isHostEvent(null)).toBe(false);
    expect(isHostEvent('ready')).toBe(false);
  });
});
