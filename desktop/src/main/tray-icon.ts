/**
 * Картинка значка в трее (R58). До 1.0.3 трей искал `build/icon.ico`, которого в `app.asar` нет
 * (`files: dist/**`), и у установленного Cord значок был прозрачным: `nativeImage.createEmpty()`.
 * Теперь значок — `dist/shell/tray.ico` (16/20/24/32/48 BMP + 256 PNG, `scripts/make-icons.mjs`),
 * запасной путь — `icon-256.png` из той же папки, и если ничего не прочиталось — трей не создаётся.
 * Здесь нет Electron: выбор проверяется тестами, `tray.ts` только грузит файл.
 */
import { join } from 'node:path';

export const TRAY_ICON = 'tray.ico';
/** Размеры, которые Windows берёт для трея при 100–300 %: без них значок мылится. */
export const TRAY_SIZES = [16, 20, 24, 32, 48] as const;

export interface IcoEntry {
  width: number;
  height: number;
  bitsPerPixel: number;
  format: 'png' | 'bmp';
  size: number;
  offset: number;
}

/** Записи каталога ICO; не ICO — пустой список. */
export function icoEntries(bytes: Uint8Array): IcoEntry[] {
  if (bytes.length < 6) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) return [];
  const count = view.getUint16(4, true);
  const entries: IcoEntry[] = [];
  for (let index = 0; index < count; index++) {
    const at = 6 + index * 16;
    if (at + 16 > bytes.length) break;
    const width = bytes[at] || 256;
    const height = bytes[at + 1] || 256;
    const bitsPerPixel = view.getUint16(at + 6, true);
    const size = view.getUint32(at + 8, true);
    const offset = view.getUint32(at + 12, true);
    const png = offset + 4 <= bytes.length && bytes[offset] === 0x89 && bytes[offset + 1] === 0x50 && bytes[offset + 2] === 0x4e && bytes[offset + 3] === 0x47;
    entries.push({ width, height, bitsPerPixel, format: png ? 'png' : 'bmp', size, offset });
  }
  return entries;
}

export interface TrayCandidate {
  path: string;
  kind: 'ico' | 'png';
}

/** Где искать значок: оба файла едут в `dist/shell` (`scripts/copy-shell.mjs`) и в dev, и в asar. */
export function trayIconCandidates(appPath: string): TrayCandidate[] {
  return [
    { path: join(appPath, 'dist', 'shell', TRAY_ICON), kind: 'ico' },
    { path: join(appPath, 'dist', 'shell', 'icon-256.png'), kind: 'png' },
  ];
}

/** Минимум от `NativeImage`, нужный для выбора. */
export interface TrayImage {
  isEmpty(): boolean;
  resize?(options: { width: number; height: number }): { isEmpty(): boolean };
}

export interface TrayImageLoader {
  exists(path: string): boolean;
  load(path: string): TrayImage | null;
}

/**
 * Первый кандидат, который прочитался не пустым. PNG 256 px уменьшается до 16 px — Windows сама
 * масштабирует значок трея по DPI, а крупную картинку рисует мыльной.
 */
export function pickTrayImage<T extends TrayImage>(candidates: TrayCandidate[], loader: { exists(path: string): boolean; load(path: string): T | null }): T | { isEmpty(): boolean } | null {
  for (const candidate of candidates) {
    if (!loader.exists(candidate.path)) continue;
    const image = loader.load(candidate.path);
    if (!image || image.isEmpty()) continue;
    if (candidate.kind === 'png' && image.resize) {
      const small = image.resize({ width: 16, height: 16 });
      if (!small.isEmpty()) return small;
      continue;
    }
    return image;
  }
  return null;
}
