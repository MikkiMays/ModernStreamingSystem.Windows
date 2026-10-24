import { describe, expect, it } from 'vitest';
import { decideGameNotice, hotkeyLabel, type GameNoticeInput } from '../../src/main/game-notice';

const game = { exe: 'cs2.exe', name: 'Counter-Strike 2', enabled: true, exclusive: false };
const base: GameNoticeInput = { inCall: true, overlayEnabled: true, toastEnabled: true, game, front: true, announced: new Set(), warned: new Set() };

describe('decideGameNotice — «Показать игру» при старте игры (R104)', () => {
  it('во встрече, игра впереди — «Показать игру» (уведомление Windows и карточка в оверлее)', () => {
    expect(decideGameNotice(base)).toBe('golive');
  });

  it('один раз на игру за сеанс', () => {
    expect(decideGameNotice({ ...base, announced: new Set(['cs2.exe']) })).toBeNull();
    expect(decideGameNotice({ ...base, announced: new Set(['dota2.exe']) })).toBe('golive');
  });

  it('вне встречи, игра не впереди, оверлей или игра выключены, всплывашка выключена — молчит', () => {
    expect(decideGameNotice({ ...base, inCall: false })).toBeNull();
    expect(decideGameNotice({ ...base, front: false }), 'впереди Cord, игра — «была»').toBeNull();
    expect(decideGameNotice({ ...base, game: null })).toBeNull();
    expect(decideGameNotice({ ...base, overlayEnabled: false })).toBeNull();
    expect(decideGameNotice({ ...base, game: { ...game, enabled: false } })).toBeNull();
    expect(decideGameNotice({ ...base, toastEnabled: false })).toBeNull();
  });

  it('эксклюзивный полноэкранный — одно предупреждение «включите без рамки», даже без всплывашки; повторно — нет', () => {
    const exclusive = { ...base, game: { ...game, exclusive: true } };
    expect(decideGameNotice(exclusive)).toBe('exclusive');
    expect(decideGameNotice({ ...exclusive, toastEnabled: false })).toBe('exclusive');
    expect(decideGameNotice({ ...exclusive, warned: new Set(['cs2.exe']) })).toBeNull();
    expect(decideGameNotice({ ...exclusive, inCall: false })).toBeNull();
  });

  it('подпись сочетания: Shift+` и прочие; без сочетания — null', () => {
    expect(hotkeyLabel({ code: 'Backquote', ctrl: false, alt: false, shift: true, meta: false })).toBe('Shift+`');
    expect(hotkeyLabel({ code: 'KeyO', ctrl: true, alt: false, shift: true, meta: false })).toBe('Ctrl+Shift+O');
    expect(hotkeyLabel(null)).toBeNull();
  });
});
