import { describe, expect, it } from 'vitest';
import { captureSourceViews, nativeAudioFor, readAudioMode, readCaptureSelect } from '../../src/main/capture';
import { isPageCall, readPageMessage } from '../../src/main/bridge/messages';
import { featuresFor, FEATURES } from '../../src/shared/bridge';

const image = (data: string) => ({ isEmpty: () => data === '', toDataURL: () => data, resize: () => ({ toDataURL: () => `${data}#24` }) });

describe('captureSourceViews — что видит окно выбора веба', () => {
  const sources = [
    { id: 'screen:0:0', name: 'Экран 1', thumbnail: image('data:image/png;base64,S0'), appIcon: null },
    { id: 'window:111:0', name: 'Cord', thumbnail: image('data:image/png;base64,C'), appIcon: image('data:image/png;base64,I') },
    { id: 'window:222:0', name: 'Cord — заметки о встрече', thumbnail: image(''), appIcon: image('') },
    { id: 'window:333:0', name: 'x'.repeat(120), thumbnail: image('data:image/png;base64,W'), appIcon: image('data:image/png;base64,I') },
  ];
  it('свои окна Cord — по id источника, а не по заголовку; чужое окно с «Cord» в имени остаётся', () => {
    const views = captureSourceViews(sources, new Set(['window:111:0']));
    expect(views.map((view) => view.id)).toEqual(['screen:0:0', 'window:222:0', 'window:333:0']);
  });
  it('вид, миниатюра и значок; пустые картинки — пустые строки; имя ≤ 80', () => {
    const [screen, empty, long] = captureSourceViews(sources, new Set(['window:111:0']));
    expect(screen).toEqual({ id: 'screen:0:0', name: 'Экран 1', kind: 'screen', thumbnail: 'data:image/png;base64,S0', icon: '' });
    expect(empty).toMatchObject({ kind: 'window', thumbnail: '', icon: '' });
    expect(long!.name).toHaveLength(80);
    expect(long!.icon).toBe('data:image/png;base64,I#24');
  });
});

describe('capture.select — запрос с ответом и прежнее сообщение', () => {
  it('invoke: проверка id и режима звука', () => {
    expect(isPageCall('capture.select')).toBe(true);
    expect(readCaptureSelect({ id: 'window:1234:0', audio: 'system' })).toEqual({ id: 'window:1234:0', audio: 'system' });
    expect(readCaptureSelect({ id: 'screen:0:0', audio: 'none' })).toEqual({ id: 'screen:0:0', audio: 'none' });
    expect(readCaptureSelect({ id: 'file:///etc/passwd', audio: 'none' })).toBeNull();
    expect(readCaptureSelect({ id: 'screen:0:0', audio: 'loud' })).toBeNull();
    expect(readCaptureSelect(null)).toBeNull();
  });
  it('send по-прежнему понимается', () => {
    expect(readPageMessage('capture.select', { id: 'screen:0:0', audio: 'none' })).toEqual({ type: 'capture.select', id: 'screen:0:0', audio: 'none' });
  });
});

describe('звук через cord-native (process loopback)', () => {
  it('app — дерево процессов окна; system-except-cord — всё, кроме Cord; экран без приложения и без модуля — отказ с причиной', () => {
    expect(nativeAudioFor({ id: 'window:123456:0', audio: 'app' }, true)).toEqual({ kind: 'native', plan: { mode: 'include', hwnd: 123456 } });
    expect(nativeAudioFor({ id: 'screen:0:0', audio: 'system-except-cord' }, true)).toEqual({ kind: 'native', plan: { mode: 'exclude' } });
    expect(nativeAudioFor({ id: 'screen:0:0', audio: 'app' }, true)).toEqual({ kind: 'failed', reason: 'not-a-window' });
    expect(nativeAudioFor({ id: 'window:1:0', audio: 'app' }, false)).toEqual({ kind: 'failed', reason: 'unavailable' });
    expect(nativeAudioFor({ id: 'screen:0:0', audio: 'system' }, true)).toEqual({ kind: 'none' });
    expect(nativeAudioFor({ id: 'screen:0:0', audio: 'none' }, false)).toEqual({ kind: 'none' });
  });
  it('режим из окна выбора оболочки — только известные имена', () => {
    expect(readAudioMode('system-except-cord')).toBe('system-except-cord');
    expect(readAudioMode('app')).toBe('app');
    expect(readAudioMode('loud')).toBe('none');
    expect(readAudioMode(undefined)).toBe('none');
  });
});

describe('флаги возможностей по платформе и модулю', () => {
  it('Windows с cord-native — всё; без модуля нет ptt и звука приложения; на остальных нет и API панели задач', () => {
    expect(featuresFor('win32', true)).toEqual([...FEATURES]);
    const noNative = featuresFor('win32');
    expect(noNative).not.toContain('ptt');
    expect(noNative).not.toContain('capture.app-audio');
    expect(noNative).toContain('capture.system-audio');
    const linux = featuresFor('linux');
    for (const flag of ['capture.system-audio', 'thumbar', 'badge', 'ptt', 'capture.app-audio']) expect(linux).not.toContain(flag);
    expect(linux).toContain('capture');
    expect(linux).toContain('overlay');
    // Подмена модуля на Linux (дымовой прогон) объявляет нативные флаги, но не Windows-only.
    const fake = featuresFor('linux', true);
    expect(fake).toContain('ptt');
    expect(fake).not.toContain('thumbar');
  });
});

describe('сочетания с кнопками мыши', () => {
  it('Mouse3–Mouse5 проходят проверку моста, Mouse1/Mouse2 — нет', () => {
    const binding = (code: string) => ({ action: 'ptt', mode: 'hold', key: { code, ctrl: false, alt: false, shift: false, meta: false } });
    expect(readPageMessage('hotkeys.configure', { bindings: [binding('Mouse4')] })).toMatchObject({ type: 'hotkeys.configure', bindings: [{ action: 'ptt', mode: 'hold' }] });
    expect(readPageMessage('hotkeys.configure', { bindings: [binding('Mouse1')] })).toBeNull();
    expect(readPageMessage('hotkeys.configure', { bindings: [binding('Mouse6')] })).toBeNull();
  });
});
