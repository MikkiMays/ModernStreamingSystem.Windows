/**
 * Окно-держатель на время установки обновления (R203, владелец: «держать эту плашку… крутить анимацию корда до
 * момента его открытия»). Установщику нужно, чтобы Cord закрылся, — а с ним и заставка, и до перезапуска на экране
 * было пусто. Перед установкой заставка запускает маленький отдельный процесс (PowerShell, WinForms — есть в любой
 * Windows 10/11, ничего не ставим) с той же картинкой на том же месте; новый Cord, показав свою заставку, кладёт
 * файл `ready`, и держатель закрывается — подмены не видно.
 *
 * Не вышло (нет PowerShell, политика, антивирус) — установка идёт как раньше, тихо: держатель — украшение, а не
 * условие. Скрипт и картинка копируются в папку данных: папку программы установщик перезаписывает.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HolderBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HolderDeps {
  /** Папка страниц оболочки (`dist/shell`, внутри asar — читается обычным fs Electron). */
  shellDir: string;
  /** Папка данных Cord: копии скрипта и картинки и файл `ready`. */
  dataDir: string;
  platform?: NodeJS.Platform;
  spawn?: typeof nodeSpawn;
  log?: (line: string) => void;
}

const DIR = 'update-holder';
const SCRIPT = 'update-holder.ps1';
const GIF = 'update-holder.gif';
const READY = 'ready';

export function holderDir(dataDir: string): string {
  return join(dataDir, DIR);
}

/** Аргументы PowerShell: без профиля и политики, окно консоли скрыто. */
export function holderArgs(dir: string, bounds: HolderBounds, text: string): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    join(dir, SCRIPT),
    '-Gif',
    join(dir, GIF),
    '-Ready',
    join(dir, READY),
    '-X',
    String(Math.round(bounds.x)),
    '-Y',
    String(Math.round(bounds.y)),
    '-Width',
    String(Math.round(bounds.width)),
    '-Height',
    String(Math.round(bounds.height)),
    '-Text',
    text,
  ];
}

/** Поставить держатель на место заставки. @returns запущен ли он. */
export function startHolder(bounds: HolderBounds, text: string, deps: HolderDeps): boolean {
  const { platform = process.platform, spawn = nodeSpawn, log = () => {} } = deps;
  if (platform !== 'win32') return false;
  try {
    const dir = holderDir(deps.dataDir);
    mkdirSync(dir, { recursive: true });
    rmSync(join(dir, READY), { force: true });
    for (const name of [SCRIPT, GIF]) writeFileSync(join(dir, name), readFileSync(join(deps.shellDir, name)));
    const child = spawn('powershell.exe', holderArgs(dir, bounds, text), { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (error) => log(`держатель обновления не запустился: ${error.message}`));
    child.unref();
    return true;
  } catch (error) {
    log(`держатель обновления не запустился: ${(error as Error).message}`);
    return false;
  }
}

/** Новый Cord показал заставку: держатель может уходить. Без держателя — ничего не делает. */
export function releaseHolder(dataDir: string): void {
  const dir = holderDir(dataDir);
  if (!existsSync(join(dir, SCRIPT))) return;
  try {
    writeFileSync(join(dir, READY), '');
  } catch {
    // Не смогли — держатель уйдёт сам по сроку.
  }
}
