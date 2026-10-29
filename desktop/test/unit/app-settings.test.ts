import { describe, expect, it } from 'vitest';
import { appSettingsOf, keepAwake, OVERLAY_WIDGET_DEFAULTS, readAppSettingsPatch, readOverlayWidget, settingsPatchOf } from '../../src/main/app-settings';
import { isPageCall } from '../../src/main/bridge/messages';
import { FEATURES, HOST_MESSAGES } from '../../src/shared/bridge';

const call = { inCall: true, mic: true, camera: false, screen: false };
const idle = { inCall: false, mic: false, camera: false, screen: false };
const all = { flash: true, sleepBlocker: true };

describe('app.settings — переключатели раздела «Windows» в настройках веба (E03, T53)', () => {
  it('запрос и событие объявлены, у каждого переключателя свой флаг', () => {
    expect(isPageCall('app.settings')).toBe(true);
    expect(HOST_MESSAGES).toContain('app.settings');
    for (const flag of ['app.settings', 'tray', 'attention', 'sleep', 'overlay', 'autostart']) expect(FEATURES).toContain(flag);
  });

  it('патч: только известные имена и только true/false; пустой — чтение', () => {
    expect(readAppSettingsPatch({})).toEqual({});
    expect(readAppSettingsPatch(undefined)).toEqual({});
    expect(readAppSettingsPatch({ tray: false, overlay: true, autostart: true })).toEqual({ tray: false, overlay: true, autostart: true });
    // «Уведомления» из меню трея (R103) — тот же переключатель и для веба.
    expect(readAppSettingsPatch({ notifications: false })).toEqual({ notifications: false });
    expect(readAppSettingsPatch({ tray: 'no' })).toBeNull();
    expect(readAppSettingsPatch({ updateChannel: 'https://evil.example/' })).toBeNull();
    expect(readAppSettingsPatch([])).toBeNull();
  });

  const widget = { ...OVERLAY_WIDGET_DEFAULTS, offset: { x: 40, y: 12 } };
  const mini = { enabled: true, expanded: false, x: 100, y: 200 };

  it('настройки ↔ значения для веба: overlay — это overlayEnabled, виджет и мини-окно — свои имена', () => {
    const values = appSettingsOf({ tray: true, flash: true, sleepBlocker: false, overlayEnabled: true, autostart: false, notifications: false, overlay: widget, mini });
    expect(values).toEqual({
      tray: true, thumbar: false, badge: false, flash: true, sleepBlocker: false, overlay: true, autostart: false, notifications: false,
      mini: true, overlayCorner: 'tl', overlaySize: 'm', overlayNames: 'always', overlayOpacity: 100, overlayToast: true,
    });
    expect(settingsPatchOf({ overlay: false, flash: false }, { overlay: widget, mini })).toEqual({ overlayEnabled: false, flash: false });
  });

  it('виджет говорящих (R63): значения не булевы, но только из своих списков; прозрачность — целое 30–100', () => {
    expect(readAppSettingsPatch({ overlayCorner: 'br', overlaySize: 'l', overlayNames: 'speaking', overlayOpacity: 30, overlayToast: false, mini: false })).toEqual({
      overlayCorner: 'br', overlaySize: 'l', overlayNames: 'speaking', overlayOpacity: 30, overlayToast: false, mini: false,
    });
    for (const bad of [{ overlayCorner: 'center' }, { overlaySize: 'xl' }, { overlayNames: true }, { overlayOpacity: 29 }, { overlayOpacity: 101 }, { overlayOpacity: 55.5 }, { overlayOpacity: '80' }, { mini: 'yes' }])
      expect(readAppSettingsPatch(bad), JSON.stringify(bad)).toBeNull();
  });

  it('смена угла сбрасывает смещение перетаскивания; тот же угол — нет; мини-окно помнит место', () => {
    expect(settingsPatchOf({ overlayCorner: 'br' }, { overlay: widget, mini }).overlay).toEqual({ ...widget, corner: 'br', offset: { x: 0, y: 0 } });
    expect(settingsPatchOf({ overlayCorner: 'tl', overlayOpacity: 60 }, { overlay: widget, mini }).overlay).toEqual({ ...widget, opacity: 60 });
    expect(settingsPatchOf({ mini: false }, { overlay: widget, mini })).toEqual({ mini: { ...mini, enabled: false } });
  });

  it('settings.overlay из файла — без доверия', () => {
    expect(readOverlayWidget({ corner: 'x', size: 's', names: 'never', opacity: 5, toast: false, offset: { x: 1e9, y: -3.4 } })).toEqual({
      corner: 'tl', size: 's', names: 'never', opacity: 30, toast: false, offset: { x: 8000, y: -3 },
    });
    expect(readOverlayWidget(null)).toEqual(OVERLAY_WIDGET_DEFAULTS);
  });
});

describe('что делает панель задач при каждом переключателе', () => {
  it('кнопок на миниатюре и значка поверх иконки нет (R138): флагов нет, в ответе — false, патч к ним принимается и ничего не меняет', () => {
    const widget = { ...OVERLAY_WIDGET_DEFAULTS };
    const mini = { enabled: true, expanded: false };
    expect(FEATURES).not.toContain('thumbar');
    expect(FEATURES).not.toContain('badge');
    expect(HOST_MESSAGES, 'кнопки на миниатюре странице больше ничего не шлют').not.toContain('thumbar');
    // Веб до R138 ждёт в ответе все булевы ключи — они остаются, но всегда «выключено».
    expect(appSettingsOf({ tray: true, flash: true, sleepBlocker: true, overlayEnabled: true, autostart: false, notifications: true, overlay: widget, mini })).toMatchObject({ thumbar: false, badge: false });
    expect(readAppSettingsPatch({ thumbar: true, badge: true })).toEqual({ thumbar: true, badge: true });
    expect(readAppSettingsPatch({ thumbar: 'да' }), 'не булево — отказ, как раньше').toBeNull();
    expect(settingsPatchOf({ thumbar: true, badge: true, tray: false }, { overlay: widget, mini })).toEqual({ tray: false });
  });

  it('запрет сна — в звонке или при показе экрана, если включён', () => {
    expect(keepAwake(call, all)).toBe(true);
    expect(keepAwake({ ...idle, screen: true }, all)).toBe(true);
    expect(keepAwake(idle, all)).toBe(false);
    expect(keepAwake(call, { ...all, sleepBlocker: false })).toBe(false);
  });
});
