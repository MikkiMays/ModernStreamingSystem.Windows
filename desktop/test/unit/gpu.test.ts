import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AV1_FEATURE,
  av1Allowed,
  av1Capable,
  av1Enabled,
  codecOfProfile,
  gpuView,
  mergeFeatures,
  readGpuCache,
  readGpuInfo,
  sameGpu,
  writeGpuCache,
  type GpuDevice,
} from '../../src/main/gpu';

const device = (vendorId: number, deviceId: number, name = ''): GpuDevice => ({
  vendorId,
  deviceId,
  vendor: vendorId === 0x10de ? 'nvidia' : vendorId === 0x1002 ? 'amd' : vendorId === 0x8086 ? 'intel' : 'other',
  name,
  driver: '32.0.15.6094',
  active: true,
});

describe('белый список аппаратного AV1 (R152)', () => {
  it('NVIDIA: RTX 40 (Ada) и 50 (Blackwell) — да; RTX 30, 20 и Hopper — нет', () => {
    expect(av1Capable(device(0x10de, 0x2684, 'NVIDIA GeForce RTX 4090'))).toBe(true);
    expect(av1Capable(device(0x10de, 0x2786))).toBe(true); // 4070
    expect(av1Capable(device(0x10de, 0x28a1))).toBe(true); // 4050 Laptop
    expect(av1Capable(device(0x10de, 0x2b85))).toBe(true); // 5090
    expect(av1Capable(device(0x10de, 0x2c02))).toBe(true); // 5080
    expect(av1Capable(device(0x10de, 0x2484, 'NVIDIA GeForce RTX 3070'))).toBe(false);
    expect(av1Capable(device(0x10de, 0x1e84, 'NVIDIA GeForce RTX 2070 SUPER'))).toBe(false);
    expect(av1Capable(device(0x10de, 0x2330))).toBe(false); // H100
    expect(av1Capable(device(0x10de, 0x2901))).toBe(false); // B200
    // Код незнаком, но имя — RTX 40: берём по имени.
    expect(av1Capable(device(0x10de, 0x1, 'NVIDIA GeForce RTX 4060 Ti'))).toBe(true);
  });

  it('AMD: RDNA3+ и APU Phoenix/Strix — да; RDNA2 (RX 6000, Navi 24, Rembrandt) — нет', () => {
    expect(av1Capable(device(0x1002, 0x744c, 'AMD Radeon RX 7900 XTX'))).toBe(true);
    expect(av1Capable(device(0x1002, 0x747e))).toBe(true); // 7800 XT
    expect(av1Capable(device(0x1002, 0x7480))).toBe(true); // 7600
    expect(av1Capable(device(0x1002, 0x7550))).toBe(true); // 9070 XT
    expect(av1Capable(device(0x1002, 0x15bf, 'AMD Radeon 780M Graphics'))).toBe(true);
    expect(av1Capable(device(0x1002, 0x150e))).toBe(true); // 890M
    expect(av1Capable(device(0x1002, 0x73bf, 'AMD Radeon RX 6900 XT'))).toBe(false);
    expect(av1Capable(device(0x1002, 0x743f, 'AMD Radeon RX 6500 XT'))).toBe(false);
    expect(av1Capable(device(0x1002, 0x1681, 'AMD Radeon 680M'))).toBe(false);
  });

  it('Intel: Arc, Battlemage, Meteor/Arrow/Lunar Lake — да; Iris Xe и UHD — нет', () => {
    expect(av1Capable(device(0x8086, 0x56a0, 'Intel(R) Arc(TM) A770 Graphics'))).toBe(true);
    expect(av1Capable(device(0x8086, 0xe20b))).toBe(true); // B580
    expect(av1Capable(device(0x8086, 0x7d55, 'Intel(R) Arc(TM) Graphics'))).toBe(true); // Meteor Lake
    expect(av1Capable(device(0x8086, 0x64a0))).toBe(true); // Lunar Lake
    expect(av1Capable(device(0x8086, 0x9a49, 'Intel(R) Iris(R) Xe Graphics'))).toBe(false);
    expect(av1Capable(device(0x8086, 0xa780, 'Intel(R) UHD Graphics 770'))).toBe(false);
    expect(av1Capable(device(0x1414, 0x8c, 'Microsoft Basic Render Driver'))).toBe(false);
  });

  it('разрешено, если хоть одно устройство из списка и Chromium не сказал «AV1 не кодирую»', () => {
    const laptop = { devices: [device(0x8086, 0x9a49), device(0x10de, 0x28a0)], encoders: null };
    expect(av1Allowed(laptop)).toBe(true);
    expect(av1Allowed({ ...laptop, encoders: ['h264', 'h265'] })).toBe(false);
    expect(av1Allowed({ ...laptop, encoders: ['av1', 'h264'] })).toBe(true);
    expect(av1Allowed({ devices: [device(0x10de, 0x2484)], encoders: null })).toBe(false);
    expect(av1Allowed(null)).toBe(false);
  });
});

describe('ключ Chromium', () => {
  it('одной строкой с уже заданными фичами и без повторов', () => {
    expect(mergeFeatures('', AV1_FEATURE)).toBe('WebRtcAV1HWEncode');
    expect(mergeFeatures('Foo, Bar', AV1_FEATURE)).toBe('Foo,Bar,WebRtcAV1HWEncode');
    expect(mergeFeatures('WebRtcAV1HWEncode,Foo', AV1_FEATURE)).toBe('WebRtcAV1HWEncode,Foo');
  });

  it('выключатель: по умолчанию включено, сборка может выключить, окружение сильнее сборки', () => {
    expect(av1Enabled(undefined, undefined)).toBe(true);
    expect(av1Enabled(true, undefined)).toBe(true);
    expect(av1Enabled(false, undefined)).toBe(false);
    expect(av1Enabled(true, '0')).toBe(false);
    expect(av1Enabled(false, '1')).toBe(true);
    expect(av1Enabled(undefined, 'false')).toBe(false);
  });
});

describe('сведения о видеокарте', () => {
  it('читает устройства и профили кодирования списком', () => {
    const info = readGpuInfo({
      gpuDevice: [
        { active: true, vendorId: 4318, deviceId: 10118, deviceString: 'NVIDIA GeForce RTX 4070', driverVersion: '32.0.15.6094' },
        { active: false, vendorId: 32902, deviceId: 18080 },
        'мусор',
      ],
      videoEncodeAcceleratorSupportedProfile: [{ profile: 3 }, { profile: 16 }, { profile: 24 }, { profile: 99 }],
    });
    expect(info.devices).toEqual([
      { vendorId: 0x10de, deviceId: 0x2786, vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4070', driver: '32.0.15.6094', active: true },
      { vendorId: 0x8086, deviceId: 0x46a0, vendor: 'intel', name: '', driver: '', active: false },
    ]);
    expect(info.encoders).toEqual(['av1', 'h264', 'h265']);
  });

  it('один профиль объектом (electron#41829) — это «не перечислено», а не «умеет только это»', () => {
    const info = readGpuInfo({ gpuDevice: [{ vendorId: 4318, deviceId: 10118 }], videoEncodeAcceleratorSupportedProfile: { profile: 3 } });
    expect(info.encoders).toBeNull();
    expect(av1Allowed(info)).toBe(true);
    expect(readGpuInfo(null)).toEqual({ devices: [], encoders: null });
  });

  it('профили Chromium по номерам: H.264, VP8, VP9, HEVC, AV1', () => {
    expect([0, 10, 11, 12, 15, 16, 18, 24, 26, 29, 36, 19, 23].map(codecOfProfile)).toEqual([
      'h264',
      'h264',
      'vp8',
      'vp9',
      'vp9',
      'h265',
      'h265',
      'av1',
      'av1',
      'h265',
      'h265',
      null,
      null,
    ]);
  });

  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('кэш прошлого запуска: записали — прочитали то же; битый файл — нет кэша', () => {
    dir = mkdtempSync(join(tmpdir(), 'cord-gpu-'));
    expect(readGpuCache(dir)).toBeNull();
    const info = { devices: [device(0x10de, 0x2786, 'RTX 4070')], encoders: null };
    writeGpuCache(dir, info);
    const read = readGpuCache(dir);
    expect(read).toEqual(info);
    expect(sameGpu(read, info)).toBe(true);
    expect(sameGpu(read, { ...info, encoders: ['av1'] })).toBe(false);
  });

  it('ответ странице: устройства, кодирование и состояние ключа', () => {
    const info = { devices: [device(0x10de, 0x2786, 'RTX 4070')], encoders: null };
    expect(gpuView(info, true)).toEqual({
      devices: [{ vendorId: 0x10de, deviceId: 0x2786, name: 'RTX 4070', driver: '32.0.15.6094', active: true }],
      encoders: null,
      av1hw: { enabled: true, allowed: true },
    });
    expect(gpuView(null, false)).toEqual({ devices: [], encoders: null, av1hw: { enabled: false, allowed: false } });
  });
});
