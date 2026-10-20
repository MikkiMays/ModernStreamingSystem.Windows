/**
 * Deep links `cord://` (ADR 0001 §4.4): открыть комнату по коду или по идентификатору,
 * новую встречу, настройки. Приходят через `second-instance` и `open-url`; Windows пишет
 * схему в HKCU установщиком (`setAsDefaultProtocolClient`).
 *
 * Ничего, кроме этих форм, не принимается: адреса серверов, пути и учётные данные в ссылке
 * — отказ. «Добавить сервер» по ссылке нет (П4).
 */
export type DeepLink =
  | { kind: 'room'; code: string }
  | { kind: 'invite'; roomId: string }
  | { kind: 'create' }
  | { kind: 'settings'; tab?: string }
  | { kind: 'open' };

const CODE = /^\d{9}$/;
const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TAB = /^[a-z]{1,20}$/;

export function parseDeepLink(value: string): DeepLink | null {
  if (typeof value !== 'string' || value.length > 200) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'cord:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  if (host === '' && parts.length === 0) return { kind: 'open' };
  if (host === 'room' && parts.length === 1) {
    const code = parts[0]!.replace(/-/g, '');
    return CODE.test(code) ? { kind: 'room', code } : null;
  }
  if (host === 'invite' && parts.length === 1) {
    const roomId = parts[0]!.toLowerCase();
    return ROOM_ID.test(roomId) ? { kind: 'invite', roomId } : null;
  }
  if (host === 'create' && parts.length === 0) return { kind: 'create' };
  if (host === 'settings' && parts.length <= 1) {
    const tab = parts[0];
    if (tab !== undefined && !TAB.test(tab)) return null;
    return tab ? { kind: 'settings', tab } : { kind: 'settings' };
  }
  return null;
}

/** Ссылка в аргументах командной строки второго экземпляра — последняя, если их несколько. */
export function deepLinkFromArgv(argv: readonly string[]): DeepLink | null {
  for (let index = argv.length - 1; index >= 0; index--) {
    const argument = argv[index]!;
    if (argument.toLowerCase().startsWith('cord://')) return parseDeepLink(argument);
  }
  return null;
}
