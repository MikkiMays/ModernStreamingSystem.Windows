import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { holderArgs, holderDir, releaseHolder, startHolder } from '../../src/main/update/holder';

/* Окно-держатель на время установки (R203): заставка не пропадает, пока установщик меняет файлы Cord. */

const shellDir = join(__dirname, '..', '..', 'src', 'shell');
const bounds = { x: 810, y: 360, width: 450, height: 540 };

describe('держатель обновления', () => {
  it('PowerShell без профиля и политики, скрыт; рамка — целые пиксели; текст — строкой', () => {
    const args = holderArgs('C:\\data\\update-holder', { ...bounds, x: 810.4 }, 'Устанавливаем…');
    expect(args.slice(0, 7)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File']);
    expect(args).toContain('-Text');
    expect(args[args.indexOf('-X') + 1]).toBe('810');
    expect(args[args.indexOf('-Width') + 1]).toBe('450');
    expect(args[args.indexOf('-Text') + 1]).toBe('Устанавливаем…');
  });

  it('копирует скрипт и картинку в папку данных и запускает отдельный процесс, не дожидаясь его', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cord-holder-'));
    const child = { on: vi.fn(), unref: vi.fn() };
    const fake = vi.fn(() => child) as unknown as typeof spawn;
    expect(startHolder(bounds, 'Устанавливаем…', { shellDir, dataDir, platform: 'win32', spawn: fake })).toBe(true);
    const dir = holderDir(dataDir);
    expect(readFileSync(join(dir, 'update-holder.gif')).subarray(0, 6).toString()).toBe('GIF89a');
    expect(readFileSync(join(dir, 'update-holder.ps1'), 'utf8')).toContain('SetProcessDPIAware');
    expect(fake).toHaveBeenCalledWith('powershell.exe', expect.any(Array), expect.objectContaining({ detached: true, windowsHide: true }));
    expect(child.unref).toHaveBeenCalled();
  });

  it('не Windows или сбой копирования — установка идёт как раньше, без держателя', () => {
    const fake = vi.fn() as unknown as typeof spawn;
    expect(startHolder(bounds, 'x', { shellDir, dataDir: tmpdir(), platform: 'linux', spawn: fake })).toBe(false);
    expect(startHolder(bounds, 'x', { shellDir: '/нет/такой', dataDir: mkdtempSync(join(tmpdir(), 'cord-holder-')), platform: 'win32', spawn: fake })).toBe(false);
    expect(fake).not.toHaveBeenCalled();
  });

  it('новый Cord кладёт ready только если держатель ставили', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cord-holder-'));
    releaseHolder(dataDir);
    expect(existsSync(join(holderDir(dataDir), 'ready'))).toBe(false);
    startHolder(bounds, 'x', { shellDir, dataDir, platform: 'win32', spawn: (() => ({ on() {}, unref() {} })) as unknown as typeof spawn });
    releaseHolder(dataDir);
    expect(existsSync(join(holderDir(dataDir), 'ready'))).toBe(true);
  });

  // Настоящий PowerShell — только на Windows (CI windows-2022): окно встаёт и уходит по файлу ready.
  it.runIf(process.platform === 'win32')('на Windows держатель живёт до ready и закрывается сам', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cord-holder-'));
    let exited: number | null = null;
    const real = ((cmd: string, args: string[], options: object) => {
      const child = spawn(cmd, args, { ...options, detached: false });
      child.on('exit', (code) => (exited = code ?? -1));
      return child;
    }) as unknown as typeof spawn;
    expect(startHolder({ x: 40, y: 40, width: 300, height: 360 }, 'Устанавливаем…', { shellDir, dataDir, platform: 'win32', spawn: real })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 4000));
    expect(exited).toBeNull();
    writeFileSync(join(holderDir(dataDir), 'ready'), '');
    for (let i = 0; i < 40 && exited === null; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(exited).toBe(0);
  }, 20000);
});
