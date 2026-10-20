import { describe, expect, it } from 'vitest';
import { appSettingsOf, keepAwake, overlayIconFor, readAppSettingsPatch, settingsPatchOf, showThumbar } from '../../src/main/app-settings';
import { isPageCall } from '../../src/main/bridge/messages';
import { FEATURES, HOST_MESSAGES } from '../../src/shared/bridge';

const call = { inCall: true, mic: true, camera: false, screen: false };
const idle = { inCall: false, mic: false, camera: false, screen: false };
const all = { thumbar: true, badge: true, flash: true, sleepBlocker: true };

describe('app.settings — переключатели раздела «Windows» в настройках веба (E03, T53)', () => {
  it('запрос и событие объявлены, у каждого переключателя свой флаг', () => {
    expect(isPageCall('app.settings')).toBe(true);
    expect(HOST_MESSAGES).toContain('app.settings');
    for (const flag of ['app.settings', 'tray', 'thumbar', 'badge', 'attention', 'sleep', 'overlay', 'autostart']) expect(FEATURES).toContain(flag);
  });

  it('патч: только известные имена и только true/false; пустой — чтение', () => {
    expect(readAppSettingsPatch({})).toEqual({});
    expect(readAppSettingsPatch(undefined)).toEqual({});
    expect(readAppSettingsPatch({ tray: false, overlay: true, autostart: true })).toEqual({ tray: false, overlay: true, autostart: true });
    expect(readAppSettingsPatch({ tray: 'no' })).toBeNull();
    expect(readAppSettingsPatch({ updateChannel: 'https://evil.example/' })).toBeNull();
    expect(readAppSettingsPatch([])).toBeNull();
  });

  it('настройки ↔ значения для веба: overlay — это overlayEnabled', () => {
    const values = appSettingsOf({ tray: true, thumbar: false, badge: true, flash: true, sleepBlocker: false, overlayEnabled: true, autostart: false });
    expect(values).toEqual({ tray: true, thumbar: false, badge: true, flash: true, sleepBlocker: false, overlay: true, autostart: false });
    expect(settingsPatchOf({ overlay: false, badge: false })).toEqual({ overlayEnabled: false, badge: false });
  });
});

describe('что делает панель задач при каждом переключателе', () => {
  it('кнопки на миниатюре — только в звонке и только если включены', () => {
    expect(showThumbar(call, all)).toBe(true);
    expect(showThumbar(idle, all)).toBe(false);
    expect(showThumbar(call, { ...all, thumbar: false })).toBe(false);
  });

  it('значок поверх иконки: в звонке — микрофон, вне — непрочитанное; выключен — ничего', () => {
    expect(overlayIconFor(call, 0, all)).toBe('in-call');
    expect(overlayIconFor({ ...call, mic: false }, 5, all)).toBe('muted');
    expect(overlayIconFor(idle, 3, all)).toBe('unread');
    expect(overlayIconFor(idle, 0, all)).toBeNull();
    expect(overlayIconFor(call, 3, { ...all, badge: false })).toBeNull();
    expect(overlayIconFor(idle, 3, { ...all, badge: false })).toBeNull();
  });

  it('запрет сна — в звонке или при показе экрана, если включён', () => {
    expect(keepAwake(call, all)).toBe(true);
    expect(keepAwake({ ...idle, screen: true }, all)).toBe(true);
    expect(keepAwake(idle, all)).toBe(false);
    expect(keepAwake(call, { ...all, sleepBlocker: false })).toBe(false);
  });
});
