/**
 * `cord-app://shell/…` — упакованные страницы оболочки: заставка обновления, загрузка, офлайн,
 * серверы, оверлей. Схема зарегистрирована как `standard, secure`; ответ несёт строгий CSP
 * (`default-src 'self'; script-src 'self'; connect-src 'none'`), а файлы отдаются только из
 * `dist/shell` — путь нормализуется, `..` не проходит.
 */
import { app, net, protocol, type Session } from 'electron';
import { existsSync, statSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SHELL_SCHEME = 'cord-app';
export const SHELL_ORIGIN = `${SHELL_SCHEME}://shell`;
export const OVERLAY_ORIGIN = `${SHELL_SCHEME}://overlay`;

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export function registerShellScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: SHELL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, allowServiceWorkers: false } },
  ]);
}

export function shellRoot(): string {
  return join(app.getAppPath(), 'dist', 'shell');
}

export function shellUrl(page: string, host: 'shell' | 'overlay' = 'shell'): string {
  return `${SHELL_SCHEME}://${host}/${page}.html`;
}

/** Регистрируется на каждой сессии: у главного окна своя (`persist:cord`), у заставки — общая. */
export function installShellProtocol(session?: Session): void {
  const root = resolve(shellRoot());
  (session?.protocol ?? protocol).handle(SHELL_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'shell' && url.host !== 'overlay') return new Response('', { status: 404 });
    const relative = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
    const file = resolve(root, relative);
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) return new Response('', { status: 404 });
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', CSP);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Cache-Control', 'no-store');
    return new Response(response.body, { status: response.status, headers });
  });
}
