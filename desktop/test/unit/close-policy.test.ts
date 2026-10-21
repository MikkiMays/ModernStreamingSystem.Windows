import { describe, expect, it } from 'vitest';
import { decideClose, startMode } from '../../src/main/close-policy';

describe('decideClose — что делает крестик главного окна (R57)', () => {
  it('значок в трее есть — окно прячется, Cord живёт в трее', () => {
    expect(decideClose({ tray: true, quitting: false, sessionEnding: false })).toBe('hide');
  });

  it('трея нет (выключен или не создался) — закрытие окна завершает Cord, как раньше', () => {
    expect(decideClose({ tray: false, quitting: false, sessionEnding: false })).toBe('close');
  });

  it('«Выйти» из трея, before-quit, обновление — закрыть по-настоящему, даже с треем', () => {
    expect(decideClose({ tray: true, quitting: true, sessionEnding: false })).toBe('close');
  });

  it('Windows выключается или сеанс завершается — не прятаться, а закрыться', () => {
    expect(decideClose({ tray: true, quitting: false, sessionEnding: true })).toBe('close');
  });
});

describe('startMode — как показать главное окно при запуске', () => {
  it('обычный запуск — показать', () => {
    expect(startMode({ hiddenFlag: false, tray: true })).toBe('show');
  });

  it('запуск вместе с Windows (--hidden): с треем — спрятать в трей, без него — свернуть в панель задач', () => {
    expect(startMode({ hiddenFlag: true, tray: true })).toBe('hide');
    expect(startMode({ hiddenFlag: true, tray: false })).toBe('minimize');
  });
});
