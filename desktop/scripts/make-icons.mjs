// Значок трея и картинки установщика — из марки Cord (`src/shell/mark.svg`), без внешних
// зависимостей: свой растеризатор рисует синий скруглённый квадрат и три белые полосы (R58, R64).
//
//   node scripts/make-icons.mjs            → src/shell/tray.ico, build/installerSidebar.bmp, build/installerHeader.bmp
//
// tray.ico: 16, 20, 24, 32, 48 — BMP 32 бит (так Windows рисует маленькие значки без артефактов
// альфы), 256 — PNG. Картинки мастера NSIS — в двойном размере (328×628 и 300×114): с
// `ManifestDPIAware` MUI2 растягивает их под масштаб экрана, и на 150 % они не мылятся.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Цвета бренда: акцент и белый — как в `src/shell/shell.css` и `tray.ts`. */
const BLUE = [53, 100, 243];
const WHITE = [255, 255, 255];

/** Полосы марки из `mark.svg` (viewBox 30×30): x, y, w, h, радиус; все повёрнуты на −15° вокруг центра. */
const BARS = [
  { x: 2, y: 6, w: 6, h: 18, r: 3 },
  { x: 12, y: 0.5, w: 6, h: 29, r: 3 },
  { x: 22, y: 4, w: 6, h: 22, r: 3 },
];
const ANGLE = (-15 * Math.PI) / 180;

/** Расстояние до скруглённого прямоугольника (0 на границе, отрицательное внутри). */
function roundedBox(px, py, cx, cy, hw, hh, r) {
  const dx = Math.abs(px - cx) - (hw - r);
  const dy = Math.abs(py - cy) - (hh - r);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - r;
}

/** Марка на холсте `size`×`size`: подложка занимает весь холст, полосы — `scale` его стороны. */
function markCoverage(size, scale, px, py) {
  const half = size / 2;
  const radius = size * 0.22;
  const plate = roundedBox(px, py, half, half, half, half, radius) <= 0 ? 1 : 0;
  if (!plate) return { plate: 0, bars: 0 };
  // Полосы: координаты SVG → холст.
  const unit = (size * scale) / 30;
  const offset = half - 15 * unit;
  let bars = 0;
  for (const bar of BARS) {
    const cx = offset + (bar.x + bar.w / 2) * unit;
    const cy = offset + (bar.y + bar.h / 2) * unit;
    // Повернуть точку в систему полосы (обратное вращение).
    const dx = px - cx;
    const dy = py - cy;
    const cos = Math.cos(-ANGLE);
    const sin = Math.sin(-ANGLE);
    const lx = cx + dx * cos - dy * sin;
    const ly = cy + dx * sin + dy * cos;
    if (roundedBox(lx, ly, cx, cy, (bar.w / 2) * unit, (bar.h / 2) * unit, bar.r * unit) <= 0) {
      bars = 1;
      break;
    }
  }
  return { plate, bars };
}

/** RGBA-растр марки с суперсэмплингом; `margin` — прозрачное поле в пикселях. */
function renderMark(size, { scale = 0.62, margin = 0, samples = 4 } = {}) {
  const pixels = new Uint8ClampedArray(size * size * 4);
  const inner = size - margin * 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let plate = 0;
      let bars = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = x - margin + (sx + 0.5) / samples;
          const py = y - margin + (sy + 0.5) / samples;
          const hit = markCoverage(inner, scale, px, py);
          plate += hit.plate;
          bars += hit.bars;
        }
      }
      const total = samples * samples;
      const alpha = plate / total;
      const white = bars / Math.max(plate, 1);
      const i = (y * size + x) * 4;
      // Цвет — смесь синего и белого внутри подложки; альфа — покрытие подложки.
      pixels[i] = Math.round(BLUE[0] + (WHITE[0] - BLUE[0]) * white);
      pixels[i + 1] = Math.round(BLUE[1] + (WHITE[1] - BLUE[1]) * white);
      pixels[i + 2] = Math.round(BLUE[2] + (WHITE[2] - BLUE[2]) * white);
      pixels[i + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}

// ---------- PNG ----------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // глубина
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- ICO ----------

/** Запись ICO в виде DIB: BITMAPINFOHEADER, строки BGRA снизу вверх, пустая маска AND. */
function encodeDib(size, rgba) {
  const maskRow = Math.ceil(size / 32) * 4;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      const s = src + x * 4;
      const d = (y * size + x) * 4;
      xor[d] = rgba[s + 2];
      xor[d + 1] = rgba[s + 1];
      xor[d + 2] = rgba[s];
      xor[d + 3] = rgba[s + 3];
    }
  }
  return Buffer.concat([header, xor, Buffer.alloc(maskRow * size)]);
}

function encodeIco(entries) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(entries.length, 4);
  const table = [];
  const blobs = [];
  let offset = 6 + 16 * entries.length;
  for (const { size, data } of entries) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    table.push(entry);
    blobs.push(data);
  }
  return Buffer.concat([dir, ...table, ...blobs]);
}

// ---------- BMP 24 бит для NSIS ----------

function encodeBmp24(width, height, rgb) {
  const rowBytes = Math.ceil((width * 3) / 4) * 4;
  const data = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 3;
    for (let x = 0; x < width; x++) {
      const s = src + x * 3;
      const d = y * rowBytes + x * 3;
      data[d] = rgb[s + 2];
      data[d + 1] = rgb[s + 1];
      data[d + 2] = rgb[s];
    }
  }
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'latin1');
  header.writeUInt32LE(54 + data.length, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(0, 30);
  header.writeUInt32LE(data.length, 34);
  header.writeInt32LE(2835, 38);
  header.writeInt32LE(2835, 42);
  return Buffer.concat([header, data]);
}

/**
 * Картинка мастера: светлый фон в тон диалога Windows с мягким градиентом, марка размером `mark`
 * с центром в (`cx`, `cy`) и тонкая синяя полоса снизу, если `band`.
 */
function renderBanner(width, height, { mark, cx, cy, band = 0 }) {
  const rgb = new Uint8ClampedArray(width * height * 3);
  const top = [247, 248, 251];
  const bottom = [228, 233, 243];
  for (let y = 0; y < height; y++) {
    const t = y / Math.max(height - 1, 1);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) rgb[i + c] = Math.round(top[c] + (bottom[c] - top[c]) * t);
      if (y >= height - band) for (let c = 0; c < 3; c++) rgb[i + c] = BLUE[c];
    }
  }
  const icon = renderMark(mark, { scale: 0.62, samples: 3 });
  const left = Math.round(cx - mark / 2);
  const topY = Math.round(cy - mark / 2);
  for (let y = 0; y < mark; y++) {
    for (let x = 0; x < mark; x++) {
      const tx = left + x;
      const ty = topY + y;
      if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
      const s = (y * mark + x) * 4;
      const a = icon[s + 3] / 255;
      const d = (ty * width + tx) * 3;
      for (let c = 0; c < 3; c++) rgb[d + c] = Math.round(rgb[d + c] * (1 - a) + icon[s + c] * a);
    }
  }
  return rgb;
}

// ---------- запись ----------

const traySizes = [16, 20, 24, 32, 48];
const tray = encodeIco([
  ...traySizes.map((size) => ({ size, data: encodeDib(size, renderMark(size, { scale: 0.66, samples: 6 })) })),
  { size: 256, data: encodePng(256, renderMark(256, { scale: 0.62, samples: 3 })) },
]);
mkdirSync(join(root, 'src', 'shell'), { recursive: true });
writeFileSync(join(root, 'src', 'shell', 'tray.ico'), tray);

const sidebar = renderBanner(328, 628, { mark: 168, cx: 164, cy: 250, band: 12 });
writeFileSync(join(root, 'build', 'installerSidebar.bmp'), encodeBmp24(328, 628, sidebar));
const header = renderBanner(300, 114, { mark: 72, cx: 150, cy: 57 });
writeFileSync(join(root, 'build', 'installerHeader.bmp'), encodeBmp24(300, 114, header));
console.log(`icons: tray.ico (${tray.length} байт, ${traySizes.join('/')} BMP + 256 PNG), installerSidebar.bmp 328×628, installerHeader.bmp 300×114`);
