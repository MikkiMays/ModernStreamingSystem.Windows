/**
 * Запас звука захвата перед `MediaStreamTrackGenerator` (R01–R03, ADR 0001 §4.1). Порции по 10 мс
 * приходят из utility-процесса неровно: поток захвата под нагрузкой игры просыпается пачками, а порт
 * доставляет их в главный поток страницы. Генератор отдаёт записанное дальше сразу — пачка порций
 * уходила бы в сеть пачкой пакетов, и NetEq у зрителей растягивал бы запас, а то и заглушал провал.
 *
 * Очередь держит запас в две порции и выдаёт их по часам, по одной на 10 мс: провал потока захвата
 * до 20 мс зритель не слышит. Кончился запас — копит его заново. Выше запаса — первой выбрасывается
 * тишина (её подкладывает `pcm::Pacer`, пока поток спал, а настоящий звук потом догоняет пачкой);
 * разрослась сверх предела и без тишины — лишнее уходит сразу, чтобы задержка не росла.
 * Чистый модуль без Electron: проверяется тестами.
 */

export const PCM_CHUNK_MS = 10;

function silent(chunk: Float32Array): boolean {
  for (let index = 0; index < chunk.length; index++) if (chunk[index] !== 0) return false;
  return true;
}

export class PcmQueue {
  private queue: Float32Array<ArrayBuffer>[] = [];
  /** Когда выдача пошла по часам; null — копим запас. */
  private startedAt: number | null = null;
  private emitted = 0;

  /**
   * `reserve` — запас в порциях (2 × 10 мс); `limit` — сколько можно держать, прежде чем отдать
   * лишнее сразу (60 мс).
   */
  constructor(
    private readonly reserve = 2,
    private readonly limit = 6,
  ) {}

  get length(): number {
    return this.queue.length;
  }

  push(chunk: Float32Array<ArrayBuffer>): void {
    this.queue.push(chunk);
  }

  /** Что записать в генератор сейчас (`now` — `performance.now()`, мс). */
  take(now: number): Float32Array<ArrayBuffer>[] {
    if (this.startedAt === null) {
      if (this.queue.length < this.reserve) return [];
      this.startedAt = now;
      this.emitted = 0;
    }
    const due = Math.floor((now - this.startedAt) / PCM_CHUNK_MS) + 1 - this.emitted;
    const out = this.queue.splice(0, Math.max(0, Math.min(due, this.queue.length)));
    this.emitted += out.length;
    // Часы просили больше, чем было: запас кончился — копить заново.
    if (out.length < due) this.startedAt = null;
    if (this.queue.length > this.reserve) {
      for (let index = 0; index < this.queue.length && this.queue.length > this.reserve; ) {
        if (silent(this.queue[index]!)) this.queue.splice(index, 1);
        else index++;
      }
      if (this.queue.length > this.limit) out.push(...this.queue.splice(0, this.queue.length - this.reserve));
    }
    return out;
  }

  clear(): void {
    this.queue = [];
    this.startedAt = null;
    this.emitted = 0;
  }
}
