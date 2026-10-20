import { describe, expect, it } from 'vitest';
import { captureSourceViews, readCaptureSelect } from '../../src/main/capture';
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

describe('флаги возможностей по платформе', () => {
  it('Windows — всё; на остальных нет системного звука, кнопок миниатюры, значка и автозапуска', () => {
    expect(featuresFor('win32')).toEqual([...FEATURES]);
    const linux = featuresFor('linux');
    for (const flag of ['capture.system-audio', 'thumbar', 'badge']) expect(linux).not.toContain(flag);
    expect(linux).toContain('capture');
    expect(linux).toContain('overlay');
  });
});
