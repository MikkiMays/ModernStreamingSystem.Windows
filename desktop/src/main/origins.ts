/**
 * Origin сервера — граница навигации, разрешений и моста (как `ServerEndpoint` в WinUI).
 *
 * Разрешён только `https` без пути, запроса, фрагмента и учётных данных; `http` — только на
 * loopback, для разработки. Навигация главного окна допускается лишь внутри origin выбранного
 * сервера и на `about:blank`; всё остальное — отказ или внешний браузер по жесту.
 */
export class ServerOrigin {
  private constructor(public readonly origin: string) {}

  /** Нормализованный origin с завершающим `/`, например `https://cord.nikg.tech/`. */
  get url(): string {
    return this.origin + '/';
  }

  /** Ключ для файлов этого сервера — первые 24 hex SHA-256 от `url` (как `ServerEndpoint.StorageKey`). */
  async storageKey(): Promise<string> {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(this.url, 'utf8').digest('hex').slice(0, 24);
  }

  static parse(value: string): ServerOrigin {
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      throw new Error('Укажите HTTPS-адрес сервера без пути.');
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password) throw new Error('Адрес сервера не может содержать учётные данные.');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      throw new Error('Укажите HTTPS-адрес сервера без пути. HTTP доступен только для localhost.');
    if ((url.pathname && url.pathname !== '/') || url.search || url.hash)
      throw new Error('Укажите адрес сервера без пути.');
    return new ServerOrigin(url.origin);
  }

  static tryParse(value: unknown): ServerOrigin | null {
    if (typeof value !== 'string') return null;
    try {
      return ServerOrigin.parse(value);
    } catch {
      return null;
    }
  }

  /** Принадлежит ли адрес этому серверу: схема, хост и порт совпадают, учётных данных нет. */
  owns(value: string | null | undefined): boolean {
    if (!value) return false;
    try {
      const url = new URL(value);
      return !url.username && !url.password && url.origin === this.origin;
    } catch {
      return false;
    }
  }

  equals(other: ServerOrigin | null | undefined): boolean {
    return !!other && other.origin === this.origin;
  }
}

/**
 * Куда окну можно перейти. Список — серверы человека (каталог + текущий); `about:blank` нужен
 * Chromium между документами. Внешняя `https`-ссылка — не навигация, а `shell.openExternal`.
 */
export type Navigation = 'allow' | 'external' | 'deny';

export function decideNavigation(target: string, allowed: readonly ServerOrigin[]): Navigation {
  if (target === 'about:blank') return 'allow';
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return 'deny';
  }
  if (allowed.some((origin) => origin.owns(target))) return 'allow';
  if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return 'external';
  return 'deny';
}

/** Внешняя ссылка, которую можно отдать системному браузеру: только `http(s)` без учётных данных. */
export function isExternalWebLink(target: string): boolean {
  try {
    const url = new URL(target);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch {
    return false;
  }
}
