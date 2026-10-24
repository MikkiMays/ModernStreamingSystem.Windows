import { describe, expect, it } from 'vitest';
import { PCM_CHUNK_MS, PcmQueue } from '../../src/preload/pcm-queue';

/*
  Звук захвата (§4.1, R01–R03): порции по 10 мс приходят из utility-процесса пачками. Генератор
  отдаёт записанное сразу, поэтому очередь в preload держит запас и выдаёт порции по часам.
*/
const chunk = (value: number) => new Float32Array(960).fill(value);
const silence = () => new Float32Array(960);
const values = (list: Float32Array[]) => list.map((item) => item[0] ?? Number.NaN);

describe('PcmQueue — запас 2 порции, выдача по часам', () => {
  it('пока запаса нет — молчит; набрался — по одной порции на 10 мс', () => {
    const queue = new PcmQueue();
    queue.push(chunk(1));
    expect(queue.take(0)).toEqual([]);
    queue.push(chunk(2));
    expect(values(queue.take(1))).toEqual([1]);
    expect(values(queue.take(5))).toEqual([]);
    queue.push(chunk(3));
    expect(values(queue.take(11))).toEqual([2]);
    expect(queue.length).toBe(1);
  });

  it('провал потока захвата короче запаса не слышен: выдача идёт ровно, пока пачка не догонит', () => {
    const queue = new PcmQueue();
    queue.push(chunk(1));
    queue.push(chunk(2));
    queue.push(chunk(3));
    const out: number[] = [];
    out.push(...values(queue.take(0)));
    // 20 мс поток захвата спал — запас закрывает 10 и 20 мс.
    out.push(...values(queue.take(10)));
    out.push(...values(queue.take(20)));
    // Пачка из трёх порций; часы просят одну.
    queue.push(chunk(4));
    queue.push(chunk(5));
    queue.push(chunk(6));
    out.push(...values(queue.take(30)));
    expect(out).toEqual([1, 2, 3, 4]);
    expect(queue.length).toBe(2);
  });

  it('главный поток страницы был занят — опоздавший тик отдаёт всё, что задолжали часы', () => {
    const queue = new PcmQueue();
    for (let i = 1; i <= 7; i++) queue.push(chunk(i));
    expect(values(queue.take(0))).toEqual([1]);
    expect(values(queue.take(40))).toEqual([2, 3, 4, 5]);
  });

  it('запас кончился — копит его заново, а не выдаёт порции по одной вразнобой', () => {
    const queue = new PcmQueue();
    queue.push(chunk(1));
    queue.push(chunk(2));
    expect(values(queue.take(0))).toEqual([1]);
    expect(values(queue.take(10))).toEqual([2]);
    expect(values(queue.take(20))).toEqual([]);
    queue.push(chunk(3));
    expect(values(queue.take(30))).toEqual([]);
    queue.push(chunk(4));
    expect(values(queue.take(31))).toEqual([3]);
  });

  it('очередь разрослась — сначала выбрасывается тишина, задержка возвращается к запасу', () => {
    const queue = new PcmQueue();
    queue.push(chunk(1));
    queue.push(chunk(2));
    expect(values(queue.take(0))).toEqual([1]);
    // cord-native подложил тишину, пока поток спал, а потом пришла пачка настоящего звука.
    for (let i = 0; i < 4; i++) queue.push(silence());
    for (let i = 3; i <= 6; i++) queue.push(chunk(i));
    expect(queue.length).toBe(9);
    expect(values(queue.take(10))).toEqual([2]);
    expect(queue.length).toBe(4);
    expect(values(queue.take(20))).toEqual([3]);
  });

  it('разрослась без тишины — лишнее уходит сразу, по порядку, ничего не теряется', () => {
    const queue = new PcmQueue();
    for (let i = 1; i <= 10; i++) queue.push(chunk(i));
    expect(values(queue.take(0))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(queue.length).toBe(2);
    expect(values(queue.take(10))).toEqual([9]);
  });

  it('порция — 10 мс', () => {
    expect(PCM_CHUNK_MS).toBe(10);
  });

  it('clear — заново с пустым запасом', () => {
    const queue = new PcmQueue();
    queue.push(chunk(1));
    queue.push(chunk(2));
    queue.take(0);
    queue.clear();
    expect(queue.length).toBe(0);
    queue.push(chunk(3));
    expect(queue.take(100)).toEqual([]);
  });
});
