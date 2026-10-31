/**
 * Видеокарта и аппаратный AV1 для WebRTC (R152, решение Р-47 п. 4 в главном репозитории).
 *
 * ЗАЧЕМ. Chromium на Windows держит `WebRtcAV1HWEncode` выключенным по умолчанию
 * (`media/webrtc/webrtc_features.cc`, `FEATURE_DISABLED_BY_DEFAULT` под `IS_WIN`): без него
 * `RTCVideoEncoderFactory` вычёркивает профили AV1 из аппаратных, и даже RTX 40 кодирует AV1
 * процессором. В Chrome ключ раскатывает Finch, в Electron Finch нет — включаем сами, но только там,
 * где AV1 в железе есть и драйверы знакомые: NVIDIA RTX 40+ (Ada, Blackwell), AMD RDNA3+ (RX 7000,
 * RX 9000, Radeon 7x0M/8x0M), Intel Arc и Meteor Lake+.
 *
 * ПОРЯДОК. Ключ Chromium читается до `ready`, а `app.getGPUInfo` отвечает только после — поэтому
 * решение по видеокарте прошлого запуска (`gpu.json` в `userData`). Первый запуск на новой машине и
 * запуск после смены видеокарты идут без ключа, следующий — с ним. Без ключа веб всё равно выбирает
 * лучший аппаратный кодек сам (H.265/VP9/H.264 по `encodingInfo`), а с ключом проверяет по
 * `encoderImplementation`, что AV1 действительно в железе, и отступает, если нет.
 *
 * ВЫКЛЮЧАТЕЛЬ. `CORD_AV1_HW=0` в окружении или `"av1HwEncode": false` в `dist/update-keys.json`
 * сборки (`config.ts`) — ключ не ставится вовсе.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Имя фичи Chromium (`kWebRtcAV1HWEncode`). */
export const AV1_FEATURE = 'WebRtcAV1HWEncode';

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'other';
export type EncodeCodec = 'h264' | 'h265' | 'vp8' | 'vp9' | 'av1';

export interface GpuDevice {
  vendorId: number;
  deviceId: number;
  vendor: GpuVendor;
  /** Имя устройства (`deviceString`), если Chromium его дал. */
  name: string;
  driver: string;
  active: boolean;
}

export interface GpuInfo {
  devices: GpuDevice[];
  /** Кодеки с аппаратными профилями кодирования; `null` — Chromium их в сведениях не перечислил. */
  encoders: EncodeCodec[] | null;
}

const VENDORS: Record<number, GpuVendor> = { 0x10de: 'nvidia', 0x1002: 'amd', 0x1022: 'amd', 0x8086: 'intel' };

const int = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0);
const text = (value: unknown, limit: number): string => (typeof value === 'string' ? value.slice(0, limit) : '');

/**
 * Профиль `media::VideoCodecProfile` → кодек: H.264 0–10, VP8 11, VP9 12–15, HEVC 16–18 и 29–36,
 * AV1 24–26 (`media/base/video_codecs.h`). Остальное (Dolby Vision, Theora, VVC) кодированию не нужно.
 */
export function codecOfProfile(profile: number): EncodeCodec | null {
  if (profile >= 0 && profile <= 10) return 'h264';
  if (profile === 11) return 'vp8';
  if (profile >= 12 && profile <= 15) return 'vp9';
  if ((profile >= 16 && profile <= 18) || (profile >= 29 && profile <= 36)) return 'h265';
  if (profile >= 24 && profile <= 26) return 'av1';
  return null;
}

/** Ответ `app.getGPUInfo('complete' | 'basic')` → устройства и кодеки кодирования; чужое — пусто. */
export function readGpuInfo(raw: unknown): GpuInfo {
  const info: GpuInfo = { devices: [], encoders: null };
  if (!raw || typeof raw !== 'object') return info;
  const record = raw as Record<string, unknown>;
  const devices = Array.isArray(record.gpuDevice) ? record.gpuDevice : [];
  for (const item of devices.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue;
    const device = item as Record<string, unknown>;
    const vendorId = int(device.vendorId);
    const deviceId = int(device.deviceId);
    if (!vendorId && !deviceId) continue;
    info.devices.push({
      vendorId,
      deviceId,
      vendor: VENDORS[vendorId] ?? 'other',
      name: text(device.deviceString, 80),
      driver: text(device.driverVersion, 32),
      active: device.active === true,
    });
  }
  // Профили кодирования — только списком. Electron (по 44 включительно) кладёт их под один ключ
  // `videoEncodeAcceleratorSupportedProfile` через `Set`, а не `Append` (`gpu_info_enumerator.cc`,
  // electron#41829): остаётся последний профиль одним объектом, и «нет AV1» из этого не следует.
  const profiles = record.videoEncodeAcceleratorSupportedProfile;
  if (Array.isArray(profiles)) {
    const codecs = new Set<EncodeCodec>();
    for (const profile of profiles) {
      const codec = codecOfProfile(int((profile as { profile?: unknown } | null)?.profile ?? -1));
      if (codec) codecs.add(codec);
    }
    // Пустой список — «не перечислил», а не «ничего не умеет».
    if (codecs.size) info.encoders = [...codecs].sort();
  }
  return info;
}

const between = (value: number, from: number, to: number) => value >= from && value <= to;

/**
 * Есть ли у устройства AV1 в железе — по коду устройства PCI, иначе по имени.
 *
 * NVIDIA: Ada (AD102–AD107, `0x2680`–`0x28FF`) и всё новее `0x2B00` (Blackwell); Hopper и B100/B200
 * (`0x23xx`, `0x29xx`) — без NVENC AV1 в нужном виде, их нет. AMD: Navi 3x/4x (`0x7440`–`0x75FF`,
 * Navi 24 `0x743F` — ещё RDNA2) и APU Phoenix/Hawk Point/Strix/Krackan. Intel: Arc Alchemist
 * (`0x5690`–`0x56CF`), Battlemage (`0xE2xx`), Meteor/Arrow Lake (`0x7D40`–`0x7DFF`), Lunar Lake
 * (`0x64xx`), Panther Lake (`0xB080`–`0xB0FF`); Iris Xe (Tiger/Alder/Raptor Lake) AV1 только декодирует.
 */
export function av1Capable(device: GpuDevice): boolean {
  const id = device.deviceId;
  const name = device.name;
  switch (device.vendor) {
    case 'nvidia':
      return between(id, 0x2680, 0x28ff) || id >= 0x2b00 || /RTX\s*[45]0\d{2}|RTX\s*\d{4}\s*Ada|RTX\s*PRO\s*\d{4}/i.test(name);
    case 'amd':
      return (
        between(id, 0x7440, 0x75ff) ||
        [0x15bf, 0x15c8, 0x150e, 0x1114, 0x1586].includes(id) ||
        /Radeon.*\b(RX\s*[79]\d{3}|PRO\s*W[79]\d{3}|[78][0-9]0M)\b/i.test(name)
      );
    case 'intel':
      return (
        between(id, 0x5690, 0x56cf) ||
        between(id, 0xe200, 0xe2ff) ||
        between(id, 0x7d40, 0x7dff) ||
        between(id, 0x6400, 0x64ff) ||
        between(id, 0xb080, 0xb0ff) ||
        /\bArc\b/i.test(name)
      );
    default:
      return false;
  }
}

/** Включать ли AV1 в железе: устройство из белого списка, и Chromium не сказал, что AV1 он не кодирует. */
export function av1Allowed(info: GpuInfo | null): boolean {
  if (!info?.devices.some(av1Capable)) return false;
  return info.encoders === null || info.encoders.includes('av1');
}

/** Ключ `--enable-features` одной строкой с тем, что там уже есть: второй ключ перебил бы первый. */
export function mergeFeatures(existing: string, feature: string): string {
  const all = existing
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!all.includes(feature)) all.push(feature);
  return all.join(',');
}

/** Выключатель: окружение сильнее сборки, по умолчанию — включено. */
export function av1Enabled(configured: boolean | undefined, env: string | undefined): boolean {
  if (env === '0' || env?.toLowerCase() === 'false') return false;
  if (env === '1' || env?.toLowerCase() === 'true') return true;
  return configured !== false;
}

const CACHE = 'gpu.json';

export function readGpuCache(dir: string): GpuInfo | null {
  try {
    const path = join(dir, CACHE);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { devices?: unknown; encoders?: unknown };
    const devices = Array.isArray(parsed.devices)
      ? parsed.devices
          .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
          .slice(0, 8)
          .map((d) => ({
            vendorId: int(d.vendorId),
            deviceId: int(d.deviceId),
            vendor: VENDORS[int(d.vendorId)] ?? 'other',
            name: text(d.name, 80),
            driver: text(d.driver, 32),
            active: d.active === true,
          }))
      : [];
    const encoders = Array.isArray(parsed.encoders)
      ? parsed.encoders.filter((c): c is EncodeCodec => ['h264', 'h265', 'vp8', 'vp9', 'av1'].includes(c as string))
      : null;
    return { devices, encoders };
  } catch {
    return null;
  }
}

export function writeGpuCache(dir: string, info: GpuInfo): void {
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, CACHE);
    writeFileSync(`${path}.tmp`, JSON.stringify(info));
    renameSync(`${path}.tmp`, path);
  } catch {
    /* не записали — решим по сведениям ещё раз в следующий запуск */
  }
}

/** Изменилась ли видеокарта так, что решение о ключе другое или нужен новый кэш. */
export function sameGpu(a: GpuInfo | null, b: GpuInfo): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b);
}

/** Ответ `invoke('app.gpu')` странице: устройства, кодеки кодирования и состояние ключа AV1. */
export interface GpuView {
  devices: { vendorId: number; deviceId: number; name: string; driver: string; active: boolean }[];
  encoders: EncodeCodec[] | null;
  av1hw: { enabled: boolean; allowed: boolean };
}

export function gpuView(info: GpuInfo | null, enabled: boolean): GpuView {
  return {
    devices: (info?.devices ?? []).map(({ vendorId, deviceId, name, driver, active }) => ({
      vendorId,
      deviceId,
      name,
      driver,
      active,
    })),
    encoders: info?.encoders ?? null,
    av1hw: { enabled, allowed: av1Allowed(info) },
  };
}
