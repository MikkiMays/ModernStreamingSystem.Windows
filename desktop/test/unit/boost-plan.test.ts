import { describe, expect, it } from 'vitest';
import { boostTargets, planBoost } from '../../src/main/boost-plan';

/*
  R01–R03 (Electron-часть): во встрече Windows не должна переводить звук Cord в «режим эффективности»
  (EcoQoS) и опускать его под нагрузкой игры. Поднимаются только свои процессы: главный, рендерер
  главного окна и аудиосервис Chromium; вне встречи — ничего (не греть ноутбук).
*/
const metrics = [
  { pid: 100, type: 'Browser' },
  { pid: 200, type: 'Tab' },
  { pid: 201, type: 'Tab' },
  { pid: 300, type: 'GPU' },
  { pid: 400, type: 'Utility', name: 'Audio Service', serviceName: 'audio.mojom.AudioService' },
  { pid: 401, type: 'Utility', name: 'Network Service', serviceName: 'network.mojom.NetworkService' },
  { pid: 402, type: 'Utility', name: 'Cord native', serviceName: 'Cord native' },
] as const;

describe('boostTargets — кого поднимать', () => {
  it('свой процесс, рендерер главного окна и аудиосервис; GPU, сеть, другие вкладки и cord-native — нет', () => {
    expect(boostTargets(metrics, 100, 201)).toEqual([100, 201, 400]);
  });

  it('аудиосервис узнаётся и по одному имени службы; рендерера нет — без него', () => {
    expect(boostTargets([{ pid: 100, type: 'Browser' }, { pid: 9, type: 'Utility', serviceName: 'audio.mojom.AudioService' }], 100, null)).toEqual([100, 9]);
  });

  it('без повторов и без чужих PID: рендерер, которого нет в метриках, не поднимается', () => {
    expect(boostTargets([{ pid: 100, type: 'Browser' }], 100, 100)).toEqual([100]);
    expect(boostTargets([{ pid: 100, type: 'Browser' }], 100, 777)).toEqual([100]);
  });
});

describe('planBoost — разница с тем, что уже поднято', () => {
  it('поднять всех; повторный пересчёт без перемен — ничего не делать', () => {
    expect(planBoost(true, [100, 201, 400], new Set(), [100, 201, 400])).toEqual({ on: [100, 201, 400], off: [] });
    expect(planBoost(true, [100, 201, 400], new Set([100, 201, 400]), [100, 201, 400])).toEqual({ on: [], off: [] });
  });

  it('аудиосервис перезапустился — новый поднять, старого уже нет — не трогать', () => {
    expect(planBoost(true, [100, 201, 410], new Set([100, 201, 400]), [100, 201, 410])).toEqual({ on: [410], off: [] });
  });

  it('не нужно — вернуть всех живых; умершие PID не трогать (номер мог достаться чужому процессу)', () => {
    expect(planBoost(false, [100, 201, 400], new Set([100, 201, 400]), [100, 201])).toEqual({ on: [], off: [100, 201] });
    expect(planBoost(false, [], new Set(), [100])).toEqual({ on: [], off: [] });
  });

  it('рендерер сменился — прежний вернуть, новый поднять', () => {
    expect(planBoost(true, [100, 202, 400], new Set([100, 201, 400]), [100, 201, 202, 400])).toEqual({ on: [202], off: [201] });
  });
});
