import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { icoEntries, pickTrayImage, TRAY_ICON, TRAY_SIZES, trayIconCandidates } from '../../src/main/tray-icon';

const root = join(__dirname, '..', '..');

describe('tray.ico — значок трея в сборке (R58)', () => {
  const entries = icoEntries(readFileSync(join(root, 'src', 'shell', TRAY_ICON)));

  it('содержит маленькие размеры в BMP (16, 20, 24, 32, 48) и 256 в PNG', () => {
    const sizes = entries.map((entry) => entry.width);
    for (const size of TRAY_SIZES) expect(sizes).toContain(size);
    for (const entry of entries) expect(entry.format).toBe(entry.width === 256 ? 'png' : 'bmp');
    for (const entry of entries) expect(entry.bitsPerPixel).toBe(32);
  });

  it('разбор ICO: отказ на чужом файле', () => {
    expect(icoEntries(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toEqual([]);
    expect(icoEntries(new Uint8Array(0))).toEqual([]);
  });
});

describe('выбор картинки для трея', () => {
  it('сначала tray.ico из dist/shell, затем icon-256.png — оба внутри asar', () => {
    expect(trayIconCandidates('/app')).toEqual([
      { path: join('/app', 'dist', 'shell', 'tray.ico'), kind: 'ico' },
      { path: join('/app', 'dist', 'shell', 'icon-256.png'), kind: 'png' },
    ]);
  });

  it('ICO на месте и не пустой — берётся он', () => {
    const loaded: string[] = [];
    const image = pickTrayImage(trayIconCandidates('/app'), {
      exists: () => true,
      load: (path) => {
        loaded.push(path);
        return { isEmpty: () => false, resize: () => ({ isEmpty: () => false }) };
      },
    });
    expect(image).not.toBeNull();
    expect(loaded).toEqual([join('/app', 'dist', 'shell', 'tray.ico')]);
  });

  it('ICO не прочитался (пустая картинка) — запасной PNG, уменьшенный до 16 px', () => {
    const resized: number[] = [];
    const image = pickTrayImage(trayIconCandidates('/app'), {
      exists: () => true,
      load: (path) => ({
        isEmpty: () => path.endsWith('.ico'),
        resize: ({ width }) => {
          resized.push(width);
          return { isEmpty: () => false };
        },
      }),
    });
    expect(image).not.toBeNull();
    expect(resized).toEqual([16]);
  });

  it('ни одного файла — null: трей без картинки не создаётся (пустой значок хуже отсутствия)', () => {
    expect(pickTrayImage(trayIconCandidates('/app'), { exists: () => false, load: () => null })).toBeNull();
  });
});
